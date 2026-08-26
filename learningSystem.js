'use strict';

/**
 * Learning & Correction System.
 *
 * When a PM changes an AI-proposed value, we log the correction. Repeated
 * corrections with the same field + value + scope become *candidate
 * knowledge* — a proposal that requires PM authorization before it becomes
 * an authoritative VenueKnowledge rule.
 *
 * A single correction NEVER becomes a rule. The pattern detector groups by
 * (field, normalizedValue, classification-scope). Only classifications that
 * transcend a single show can generate candidates:
 *
 *   SHOW_SPECIFIC  → never generates a candidate (by design).
 *   ONE_TIME       → never generates a candidate (by design).
 *   VENUE_SPECIFIC → candidate after ≥ minOccurrences corrections across
 *                    ≥ minShows distinct shows with the same value.
 *   PROMOTER_SPECIFIC / TOUR_SPECIFIC / ARTIST_SPECIFIC / VENDOR_SPECIFIC
 *                  → candidate when all supporting corrections share that
 *                    scope key AND appear in ≥ minShows distinct shows.
 *   INDUSTRY_WIDE  → candidate reserved for very-cross-venue evidence and
 *                    left as a manual classification only.
 *
 * Promotion writes to VenueKnowledge via venueKnowledge.createItem, which
 * preserves version history automatically.
 */

const { randomUUID } = require('crypto');
const sheetsLib = require('./sheets');
const config = require('./config/server-config');
const venueKnowledge = require('./venueKnowledge');
const factMapping = require('./factMapping');

const CORRECTIONS_SHEET = config.googleSheets.sheets.aiCorrections;
const CANDIDATES_SHEET  = config.googleSheets.sheets.knowledgeCandidates;

const CORRECTION_TYPES = [
  'SHOW_SPECIFIC',
  'VENUE_SPECIFIC',
  'PROMOTER_SPECIFIC',
  'TOUR_SPECIFIC',
  'ARTIST_SPECIFIC',
  'VENDOR_SPECIFIC',
  'INDUSTRY_WIDE',
  'ONE_TIME',
];

const CANDIDATE_STATUSES = ['proposed', 'accepted', 'rejected', 'edited', 'superseded'];

const CORRECTION_HEADERS = [
  'id','at','actor','showId','showDate','venue','promoter','artist','tourName',
  'factId','field','source',
  'aiValue','correctedValue',
  'correctionType','reason','note','status',
];

const CANDIDATE_HEADERS = [
  'id','at','updatedAt','field','value',
  'suggestedClassification','scopeKey','scopeValue',
  'occurrences','showIds','supportingCorrectionIds',
  'status','reviewedBy','reviewedAt','reviewNote',
  'scope','effectiveFrom','expiresAt','authoritative','temporary',
  'promotedKnowledgeId',
];

// ── Sheet bootstrap ────────────────────────────────────────────────────────

async function ensureSheets({ sheetsAdapter = sheetsLib } = {}) {
  if (!sheetsAdapter.ensureSheet || !sheetsAdapter.ensureHeaders) return;
  await sheetsAdapter.ensureSheet(CORRECTIONS_SHEET);
  await sheetsAdapter.ensureHeaders(CORRECTIONS_SHEET, CORRECTION_HEADERS);
  await sheetsAdapter.ensureSheet(CANDIDATES_SHEET);
  await sheetsAdapter.ensureHeaders(CANDIDATES_SHEET, CANDIDATE_HEADERS);
}

// ── Log a correction ───────────────────────────────────────────────────────

async function logCorrection(input, actor, { sheetsAdapter = sheetsLib } = {}) {
  if (!input || !input.field) throw new Error('field required');
  if (input.aiValue === undefined) throw new Error('aiValue required');
  if (input.correctedValue === undefined) throw new Error('correctedValue required');
  const type = input.correctionType || 'SHOW_SPECIFIC';
  if (!CORRECTION_TYPES.includes(type)) throw new Error('invalid correctionType');

  const row = {
    id: randomUUID(),
    at: new Date().toISOString(),
    actor: actor?.email || actor?.username || 'system',
    showId:    input.showId    || '',
    showDate:  input.showDate  || '',
    venue:     input.venue     || '',
    promoter:  input.promoter  || '',
    artist:    input.artist    || '',
    tourName:  input.tourName  || '',
    factId:    input.factId    || '',
    field:     input.field,
    source:    input.source    || '',
    aiValue:        stringifyValue(input.aiValue),
    correctedValue: stringifyValue(input.correctedValue),
    correctionType: type,
    reason: input.reason || '',
    note:   input.note   || '',
    status: 'active',
  };
  await sheetsAdapter.appendRow(CORRECTIONS_SHEET, row);
  return row;
}

async function listCorrections({ showId, field, correctionType } = {}, { sheetsAdapter = sheetsLib } = {}) {
  const rows = await sheetsAdapter.getRows(CORRECTIONS_SHEET);
  return (rows || []).filter(r =>
    (!showId          || r.showId === showId) &&
    (!field           || r.field  === field) &&
    (!correctionType  || r.correctionType === correctionType) &&
    (r.status === undefined || r.status === '' || r.status === 'active'),
  );
}

// ── Pattern detection ──────────────────────────────────────────────────────

/**
 * Scan the corrections log for repeated corrections that share (field, value)
 * across multiple shows. Emit candidates for classifications that transcend
 * a single show. Idempotent: existing 'proposed' candidates for the same
 * key are updated with fresh counts + supporting IDs rather than duplicated.
 *
 * @returns {{ created: Array, updated: Array, skipped: Array }}
 */
async function scanForPatterns({ minOccurrences = 3, minShows = 2 } = {}, { sheetsAdapter = sheetsLib } = {}) {
  const corrections = await sheetsAdapter.getRows(CORRECTIONS_SHEET);
  const active = (corrections || []).filter(r => !r.status || r.status === 'active');

  // Only these classifications may become candidates.
  const eligible = active.filter(r =>
    r.correctionType && r.correctionType !== 'SHOW_SPECIFIC' && r.correctionType !== 'ONE_TIME',
  );

  const groups = new Map();
  for (const c of eligible) {
    const scopeKey = scopeKeyFor(c.correctionType);
    const scopeValue = String(c[scopeKey] || '').trim();
    if (!scopeValue && scopeKey !== 'venue') continue; // scope-specific rules need a scope value
    const key = [c.field, normalizeForGrouping(c.correctedValue), c.correctionType, scopeKey, scopeValue].join('|');
    let g = groups.get(key);
    if (!g) {
      g = { field: c.field, value: c.correctedValue, correctionType: c.correctionType,
            scopeKey, scopeValue, ids: [], showIds: new Set() };
      groups.set(key, g);
    }
    g.ids.push(c.id);
    if (c.showId) g.showIds.add(c.showId);
  }

  const existingCandidates = await sheetsAdapter.getRows(CANDIDATES_SHEET);
  const created = [], updated = [], skipped = [];

  for (const g of groups.values()) {
    if (g.ids.length < minOccurrences || g.showIds.size < minShows) {
      skipped.push({ ...g, reason: 'below_threshold' });
      continue;
    }
    const existing = (existingCandidates || []).find(row =>
      row.field === g.field &&
      normalizeForGrouping(row.value) === normalizeForGrouping(g.value) &&
      row.suggestedClassification === g.correctionType &&
      String(row.scopeValue || '') === String(g.scopeValue || '') &&
      (row.status === 'proposed' || row.status === 'edited'),
    );
    const showIdsJson = JSON.stringify(Array.from(g.showIds));
    const supportingJson = JSON.stringify(g.ids);
    if (existing) {
      const patch = {
        occurrences: String(g.ids.length),
        showIds: showIdsJson,
        supportingCorrectionIds: supportingJson,
        updatedAt: new Date().toISOString(),
      };
      await sheetsAdapter.updateRowById(CANDIDATES_SHEET, existing.id, patch);
      updated.push({ ...existing, ...patch });
    } else {
      const row = {
        id: randomUUID(),
        at: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        field: g.field,
        value: stringifyValue(g.value),
        suggestedClassification: g.correctionType,
        scopeKey: g.scopeKey,
        scopeValue: g.scopeValue,
        occurrences: String(g.ids.length),
        showIds: showIdsJson,
        supportingCorrectionIds: supportingJson,
        status: 'proposed',
        reviewedBy: '', reviewedAt: '', reviewNote: '',
        scope: g.scopeKey === 'venue' ? 'venue' : g.scopeKey,
        effectiveFrom: '',
        expiresAt: '',
        authoritative: '',
        temporary: '',
        promotedKnowledgeId: '',
      };
      await sheetsAdapter.appendRow(CANDIDATES_SHEET, row);
      created.push(row);
    }
  }

  return { created, updated, skipped };
}

function scopeKeyFor(correctionType) {
  switch (correctionType) {
    case 'VENUE_SPECIFIC':    return 'venue';
    case 'PROMOTER_SPECIFIC': return 'promoter';
    case 'TOUR_SPECIFIC':     return 'tourName';
    case 'ARTIST_SPECIFIC':   return 'artist';
    case 'VENDOR_SPECIFIC':   return 'vendor';
    case 'INDUSTRY_WIDE':     return 'industry';
    default:                  return 'venue';
  }
}

function normalizeForGrouping(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim().toLowerCase();
  try { return JSON.stringify(v); } catch { return String(v); }
}

function stringifyValue(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

// ── Candidate review ───────────────────────────────────────────────────────

async function listCandidates({ status } = {}, { sheetsAdapter = sheetsLib } = {}) {
  const rows = await sheetsAdapter.getRows(CANDIDATES_SHEET);
  return (rows || [])
    .filter(r => !status || r.status === status)
    .sort((a, b) => (b.updatedAt || b.at || '').localeCompare(a.updatedAt || a.at || ''));
}

async function findCandidate(id, { sheetsAdapter = sheetsLib } = {}) {
  const rows = await sheetsAdapter.getRows(CANDIDATES_SHEET);
  return (rows || []).find(r => r.id === id) || null;
}

/**
 * Review action = 'accept' | 'reject' | 'edit'.
 * On 'accept' we promote to VenueKnowledge (kind='rule'), copying scope
 * + effective/expiration + authoritative/temporary markers.
 * VenueKnowledge writes its own history row automatically.
 */
async function reviewCandidate(id, action, patch, actor, { sheetsAdapter = sheetsLib, venue = venueKnowledge } = {}) {
  const existing = await findCandidate(id, { sheetsAdapter });
  if (!existing) { const e = new Error('candidate not found'); e.code = 'not_found'; throw e; }
  if (existing.status !== 'proposed' && existing.status !== 'edited') {
    const e = new Error(`cannot review candidate in status '${existing.status}'`);
    e.code = 'invalid_state';
    throw e;
  }

  const nowIso = new Date().toISOString();
  const actorId = actor?.email || actor?.username || 'system';

  if (action === 'reject') {
    const next = { ...existing, status: 'rejected', reviewedBy: actorId, reviewedAt: nowIso,
                   reviewNote: patch?.reviewNote || '', updatedAt: nowIso };
    await sheetsAdapter.updateRowById(CANDIDATES_SHEET, id, next);
    return next;
  }

  if (action === 'edit') {
    const next = {
      ...existing,
      status: 'edited',
      value:          patch?.value          !== undefined ? stringifyValue(patch.value) : existing.value,
      scope:          patch?.scope          || existing.scope,
      effectiveFrom:  patch?.effectiveFrom  || existing.effectiveFrom || '',
      expiresAt:      patch?.expiresAt      || existing.expiresAt     || '',
      authoritative:  patch?.authoritative  !== undefined ? String(patch.authoritative) : existing.authoritative,
      temporary:      patch?.temporary      !== undefined ? String(patch.temporary)     : existing.temporary,
      reviewNote:     patch?.reviewNote     || existing.reviewNote    || '',
      updatedAt: nowIso,
    };
    await sheetsAdapter.updateRowById(CANDIDATES_SHEET, id, next);
    return next;
  }

  if (action === 'accept') {
    if (!patch) patch = {};
    const value        = patch.value !== undefined ? patch.value : parseMaybeJson(existing.value);
    const scope        = patch.scope || existing.scope || existing.scopeKey || 'venue';
    const effectiveFrom = patch.effectiveFrom || existing.effectiveFrom || '';
    const expiresAt    = patch.expiresAt    || existing.expiresAt     || '';
    const authoritative = patch.authoritative !== undefined
      ? Boolean(patch.authoritative)
      : String(existing.authoritative || '').toLowerCase() === 'true';
    const temporary = patch.temporary !== undefined
      ? Boolean(patch.temporary)
      : String(existing.temporary || '').toLowerCase() === 'true';

    const { category, subcategory, attributePath, dataType } = venueRuleShapeFor(existing.field);
    const promoted = await venue.createItem({
      kind: 'rule',
      category, subcategory, attributePath, dataType,
      value,
      subject: existing.scopeValue || '',
      scope,
      effectiveFrom,
      effectiveTo: expiresAt,
      confidence: authoritative ? 1.0 : 0.8,
      status: 'active',
      source: 'ai_learning',
      sourceRef: { candidateId: existing.id, supportingCorrectionIds: parseMaybeJson(existing.supportingCorrectionIds) },
      notes: patch.reviewNote || `Promoted from AI learning candidate ${existing.id} (${existing.occurrences} corrections)`,
      lastObservedShowId: firstShowId(existing.showIds),
      lastObservedAt: existing.updatedAt || existing.at,
      sampleSize: existing.occurrences,
    }, actorId);

    const next = {
      ...existing,
      status: 'accepted',
      reviewedBy: actorId,
      reviewedAt: nowIso,
      reviewNote: patch.reviewNote || '',
      scope,
      effectiveFrom,
      expiresAt,
      authoritative: String(authoritative),
      temporary: String(temporary),
      promotedKnowledgeId: promoted?.id || '',
      updatedAt: nowIso,
    };
    await sheetsAdapter.updateRowById(CANDIDATES_SHEET, id, next);
    return { candidate: next, promoted };
  }

  const e = new Error(`unknown action '${action}'`);
  e.code = 'invalid_action';
  throw e;
}

function parseMaybeJson(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

function firstShowId(showIdsJson) {
  const parsed = parseMaybeJson(showIdsJson);
  if (Array.isArray(parsed) && parsed.length) return parsed[0];
  return '';
}

// ── Field → venue-knowledge shape mapping ──────────────────────────────────

const CATEGORY_BY_FIELD = {
  // labor
  stagehand_count:   { category: 'labor',       subcategory: 'standard_calls' },
  electrician_count: { category: 'labor',       subcategory: 'standard_calls' },
  rigger_count:      { category: 'labor',       subcategory: 'standard_calls' },
  forklift_count:    { category: 'labor',       subcategory: 'standard_calls' },
  // technical
  chain_motor_count: { category: 'technical',   subcategory: 'motors' },
  power_amps:        { category: 'technical',   subcategory: 'power' },
  wireless_channels: { category: 'technical',   subcategory: 'rf' },
  line_array_boxes:  { category: 'technical',   subcategory: 'audio' },
  subwoofer_count:   { category: 'technical',   subcategory: 'audio' },
  moving_light_count:{ category: 'technical',   subcategory: 'lighting' },
  // operations
  show_time:         { category: 'operations',  subcategory: 'curfew' },
  doors_time:        { category: 'operations',  subcategory: 'curfew' },
  curfew_time:       { category: 'operations',  subcategory: 'curfew' },
  loadin_time:       { category: 'operations',  subcategory: 'loading' },
  loadout_time:      { category: 'operations',  subcategory: 'loading' },
  soundcheck_time:   { category: 'operations',  subcategory: 'loading' },
  parking_spaces:    { category: 'operations',  subcategory: 'parking' },
  credential_count:  { category: 'operations',  subcategory: 'credentials' },
  pyro_requested:    { category: 'operations',  subcategory: 'fire_life_safety' },
  // hospitality
  breakfast_count:   { category: 'hospitality', subcategory: 'catering' },
  lunch_count:       { category: 'hospitality', subcategory: 'catering' },
  dinner_count:      { category: 'hospitality', subcategory: 'catering' },
  meal_count:        { category: 'hospitality', subcategory: 'catering' },
  dressing_room_count:{category: 'hospitality', subcategory: 'dressing_rooms' },
  shower_count:      { category: 'hospitality', subcategory: 'showers' },
  guest_list_count:  { category: 'operations',  subcategory: 'credentials' },
  // physical
  stage_size:        { category: 'physical',    subcategory: 'stage' },
  truck_count:       { category: 'physical',    subcategory: 'dock' },
  bus_count:         { category: 'physical',    subcategory: 'parking' },
  van_count:         { category: 'physical',    subcategory: 'parking' },
};

function venueRuleShapeFor(field) {
  const bucket = CATEGORY_BY_FIELD[field] || { category: 'operations', subcategory: '' };
  const mapped = factMapping?.FIELD_MAP?.[field];
  const attributePath = attributePathFor(field, bucket);
  const dataType = inferDataType(field);
  return { ...bucket, attributePath, dataType, factHint: mapped };
}

function attributePathFor(field, bucket) {
  const cat = bucket.category || 'operations';
  return `${cat}.${field}`;
}

function inferDataType(field) {
  if (/time$/.test(field)) return 'string';
  if (/count$/.test(field) || /amps$/.test(field) || /boxes$/.test(field) || /_spaces$/.test(field)) return 'number';
  if (/^pyro_/.test(field) || /requested$/.test(field)) return 'boolean';
  return 'string';
}

module.exports = {
  CORRECTION_TYPES,
  CANDIDATE_STATUSES,
  CORRECTION_HEADERS,
  CANDIDATE_HEADERS,
  ensureSheets,
  logCorrection,
  listCorrections,
  scanForPatterns,
  listCandidates,
  findCandidate,
  reviewCandidate,
  _internals: { scopeKeyFor, normalizeForGrouping, venueRuleShapeFor, attributePathFor },
};
