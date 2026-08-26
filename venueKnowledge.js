'use strict';

/**
 * Venue Intelligence — persistent structured knowledge about the venue.
 *
 * This module is the venue-knowledge tier of the AI system. It is deliberately
 * separated from Show Knowledge (event-scoped facts) and Communication
 * Knowledge (raw email/document content). The distinction is enforced by:
 *
 *   • PERMANENT RULE       — kind='rule'         (e.g. "north dock is off-limits after 6PM")
 *   • HISTORICAL OBSERVATION — kind='observation' (e.g. "Promoter X typically requests ~75 meals")
 *   • CURRENT SHOW FACT    — NOT stored here     (lives on the Show / Advancing / Schedule rows)
 *
 * Two sheets:
 *   VenueKnowledge         — current-state rows (active + superseded)
 *   VenueKnowledgeHistory  — append-only version history for every mutation
 *
 * The `analyzeCapability` function is the safety-critical entry point the AI
 * calls when comparing a tour's request against what the venue can provide.
 * It will NEVER invent a capability — if the venue has no matching rule the
 * result is `{ known: false, matches: 'unknown', ... }`.
 */

const sheets = require('./sheets');
const config = require('./config/server-config');

const SHEET       = config.googleSheets.sheets.venueKnowledge;
const HIST_SHEET  = config.googleSheets.sheets.venueKnowledgeHistory;

// ── Taxonomy ────────────────────────────────────────────────────────────────
// Kept short + case-sensitive. Additions are safe; deletions require a
// migration because rows carry these values as strings.

const KINDS      = ['rule', 'observation'];
const STATUSES   = ['active', 'draft', 'superseded', 'expired', 'rejected'];
const CATEGORIES = ['physical', 'technical', 'labor', 'operations', 'hospitality', 'vendors'];

const CATEGORY_SUBCATEGORIES = {
  physical:    ['rooms', 'stage', 'audience', 'dock', 'parking', 'access', 'elevators', 'production_office'],
  technical:   ['audio', 'consoles', 'microphones', 'rf', 'lighting', 'video', 'led', 'projection', 'backline', 'rigging', 'motors', 'power'],
  labor:       ['departments', 'union', 'minimum_calls', 'overtime', 'meals', 'standard_calls', 'local_vendors'],
  operations:  ['building_rules', 'production_rules', 'curfew', 'loading', 'access', 'security', 'fire_life_safety', 'credentials', 'parking'],
  hospitality: ['dressing_rooms', 'green_rooms', 'showers', 'laundry', 'catering', 'equipment'],
  vendors:     ['audio', 'lighting', 'video', 'backline', 'transportation', 'catering', 'rigging', 'security', 'other'],
};

// Criticality tiers used by analyzeCapability. Categories/subcategories on
// this list mean a shortfall is safety- or contract-critical (needs Admin/PM
// action, not a routine venue swap).
const CRITICAL_PATHS = [
  'technical.power',
  'technical.rigging',
  'technical.motors',
  'technical.rf',
  'operations.fire_life_safety',
  'operations.curfew',
  'operations.security',
  'physical.stage',
];

// ── Validation ──────────────────────────────────────────────────────────────

function validateKnowledgeItem(item, { requireId = false } = {}) {
  const errors = [];
  if (requireId && !item.id) errors.push('id required');
  if (!KINDS.includes(item.kind)) errors.push(`kind must be one of ${KINDS.join('|')}`);
  if (!CATEGORIES.includes(item.category)) errors.push(`category must be one of ${CATEGORIES.join('|')}`);
  const subs = CATEGORY_SUBCATEGORIES[item.category] || [];
  if (item.subcategory && !subs.includes(item.subcategory))
    errors.push(`subcategory '${item.subcategory}' not valid for category '${item.category}'`);
  if (!item.attributePath || typeof item.attributePath !== 'string')
    errors.push('attributePath required');
  if (item.attributePath && !/^[a-z][a-zA-Z0-9_.]{1,120}$/.test(item.attributePath))
    errors.push('attributePath must be dotted lowercase (a-z, 0-9, _, .) and 2-121 chars');
  if (item.value === undefined || item.value === null || item.value === '')
    errors.push('value required');
  if (item.confidence !== undefined && item.confidence !== '') {
    const c = Number(item.confidence);
    if (!(c >= 0 && c <= 1)) errors.push('confidence must be between 0 and 1');
  }
  if (item.status && !STATUSES.includes(item.status))
    errors.push(`status must be one of ${STATUSES.join('|')}`);
  if (item.kind === 'observation' && !item.subject)
    errors.push('observation requires subject (e.g. "promoter:AC Entertainment")');
  return errors;
}

// Canonicalize value into JSON string for storage.
function normalizeValue(rawValue) {
  if (rawValue === null || rawValue === undefined) return '';
  if (typeof rawValue === 'string') {
    // Store scalar strings unwrapped so they read nicely in the sheet.
    return rawValue;
  }
  return JSON.stringify(rawValue);
}

function parseValue(stored) {
  if (stored === '' || stored === null || stored === undefined) return null;
  // Attempt JSON first; fall back to raw string.
  if (typeof stored === 'string' && /^[\[\{]/.test(stored.trim())) {
    try { return JSON.parse(stored); } catch { /* fall through */ }
  }
  // Numeric coercion for pure numbers.
  if (typeof stored === 'string' && /^-?\d+(\.\d+)?$/.test(stored)) {
    return Number(stored);
  }
  if (stored === 'true')  return true;
  if (stored === 'false') return false;
  return stored;
}

// Convert a stored row into an object with `value` re-hydrated.
function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    value:      parseValue(row.value),
    valueRaw:   row.value,
    confidence: row.confidence === '' || row.confidence == null ? null : Number(row.confidence),
    // These may or may not be present depending on when the row was created —
    // ensureHeaders adds columns on first write.
    sourceRef:  parseValue(row.sourceRef),
    sampleSize: row.sampleSize ? Number(row.sampleSize) : null,
  };
}

// ── History ─────────────────────────────────────────────────────────────────

async function writeHistory(action, item, actorId, note) {
  const entry = {
    id:           `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    knowledgeId:  item.id || '',
    action,               // 'create' | 'update' | 'supersede' | 'archive' | 'reject'
    kind:         item.kind || '',
    category:     item.category || '',
    subcategory:  item.subcategory || '',
    attributePath:item.attributePath || '',
    scope:        item.scope || '',
    snapshot:     JSON.stringify(item),
    changedAt:    new Date().toISOString(),
    changedBy:    actorId || '',
    note:         note || '',
  };
  try {
    await sheets.appendRow(HIST_SHEET, entry);
  } catch (err) {
    // History is best-effort — never block a knowledge write on history failure.
    console.error('[venueKnowledge] history write failed:', err.message);
  }
}

// ── Query ───────────────────────────────────────────────────────────────────

async function listAll(filter = {}) {
  const all = await sheets.getRows(SHEET);
  return all
    .filter(r => {
      if (filter.kind        && r.kind        !== filter.kind)        return false;
      if (filter.category    && r.category    !== filter.category)    return false;
      if (filter.subcategory && r.subcategory !== filter.subcategory) return false;
      if (filter.scope       && r.scope       !== filter.scope)       return false;
      if (filter.status      && r.status      !== filter.status)      return false;
      if (filter.subject     && r.subject     !== filter.subject)     return false;
      if (filter.attributePath && r.attributePath !== filter.attributePath) return false;
      return true;
    })
    .map(hydrate);
}

async function findById(id) {
  const rows = await sheets.getRows(SHEET);
  const found = rows.find(r => r.id === id);
  return hydrate(found);
}

// Return the currently-authoritative rule for an attribute path in a given
// scope. "Authoritative" = status='active', kind='rule', matching scope
// (falls back to scope='venue' when no stage-specific rule exists), and
// within effectiveFrom/effectiveTo window.
async function getActiveRule(attributePath, scope) {
  const now = new Date().toISOString().slice(0, 10);
  const all = await sheets.getRows(SHEET);
  const candidates = all
    .filter(r =>
      r.kind === 'rule' &&
      r.status === 'active' &&
      r.attributePath === attributePath &&
      (!r.effectiveFrom || r.effectiveFrom <= now) &&
      (!r.effectiveTo   || r.effectiveTo   >= now),
    );
  if (candidates.length === 0) return null;
  // Prefer the tightest matching scope; fall back to broader ones.
  const bestScope = scope || 'venue';
  const scoped = candidates.find(r => r.scope === bestScope);
  if (scoped) return hydrate(scoped);
  const venueWide = candidates.find(r => r.scope === 'venue' || !r.scope);
  if (venueWide) return hydrate(venueWide);
  // Multiple scoped rules but none matches the requested scope: return null
  // rather than guess. Callers must treat this as "unknown for this scope".
  return null;
}

// Return matching observations for a subject + attribute path. Sorted by
// most-recent lastObservedAt first.
async function getObservations({ subject, attributePath, category }) {
  const all = await sheets.getRows(SHEET);
  return all
    .filter(r =>
      r.kind === 'observation' &&
      r.status === 'active' &&
      (!subject       || r.subject       === subject) &&
      (!attributePath || r.attributePath === attributePath) &&
      (!category      || r.category      === category),
    )
    .sort((a, b) => (b.lastObservedAt || '').localeCompare(a.lastObservedAt || ''))
    .map(hydrate);
}

// ── Mutations ───────────────────────────────────────────────────────────────

async function createItem(input, actorId) {
  const item = {
    id:              `${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    kind:            input.kind || 'rule',
    category:        input.category || '',
    subcategory:     input.subcategory || '',
    attributePath:   input.attributePath || '',
    scope:           input.scope || 'venue',
    subject:         input.subject || '',
    dataType:        input.dataType || 'string',
    value:           normalizeValue(input.value),
    unit:            input.unit || '',
    confidence:      input.confidence === undefined ? (input.kind === 'observation' ? 0.6 : 1.0) : Number(input.confidence),
    status:          input.status || 'active',
    source:          input.source || 'manual',
    sourceRef:       input.sourceRef ? JSON.stringify(input.sourceRef) : '',
    author:          actorId || '',
    effectiveFrom:   input.effectiveFrom || '',
    effectiveTo:     input.effectiveTo   || '',
    notes:           input.notes || '',
    supersedes:      '',
    supersededBy:    '',
    sampleSize:      input.sampleSize ? String(input.sampleSize) : '',
    lastObservedShowId: input.lastObservedShowId || '',
    lastObservedAt:  input.lastObservedAt || '',
    createdAt:       new Date().toISOString(),
    updatedAt:       new Date().toISOString(),
    updatedBy:       actorId || '',
  };
  const errors = validateKnowledgeItem({ ...item, value: input.value });
  if (errors.length) {
    const e = new Error('validation: ' + errors.join('; '));
    e.code = 'validation';
    throw e;
  }
  await sheets.appendRow(SHEET, item);
  await writeHistory('create', item, actorId, input.note || '');
  return hydrate(item);
}

// Update creates a NEW row (supersedes the prior) so version history is
// preserved without ever mutating past values. The old row moves to
// status='superseded'; the new row references it via `supersedes`.
async function updateItem(id, patch, actorId, note) {
  const existing = await findById(id);
  if (!existing) {
    const e = new Error('not_found');
    e.code = 'not_found';
    throw e;
  }
  if (existing.status !== 'active' && existing.status !== 'draft') {
    const e = new Error(`cannot edit item in status '${existing.status}'`);
    e.code = 'invalid_state';
    throw e;
  }

  const merged = {
    ...existing,
    ...patch,
    // Immutable fields
    id:             existing.id + '',
    kind:           existing.kind,
    category:       existing.category,
    attributePath:  existing.attributePath,
    createdAt:      existing.createdAt,
  };
  // If nothing meaningful changed, no-op.
  const drift = ['value','unit','notes','scope','subcategory','status','effectiveFrom','effectiveTo','confidence','subject','sampleSize','lastObservedShowId','lastObservedAt','source','sourceRef']
    .some(k => normalizeValue(merged[k]) !== normalizeValue(existing[k]));
  if (!drift) return existing;

  // Mark the old row superseded and create a new row.
  const newId = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const newRow = {
    ...merged,
    id:           newId,
    value:        normalizeValue(merged.value),
    sourceRef:    typeof merged.sourceRef === 'object' && merged.sourceRef !== null
                    ? JSON.stringify(merged.sourceRef) : (merged.sourceRef || ''),
    confidence:   merged.confidence === '' || merged.confidence == null ? '' : Number(merged.confidence),
    supersedes:   existing.id,
    supersededBy: '',
    updatedAt:    new Date().toISOString(),
    updatedBy:    actorId || '',
  };
  const errors = validateKnowledgeItem({ ...newRow, value: merged.value });
  if (errors.length) {
    const e = new Error('validation: ' + errors.join('; '));
    e.code = 'validation';
    throw e;
  }
  await sheets.updateRowById(SHEET, existing.id, { status: 'superseded', supersededBy: newId, updatedAt: newRow.updatedAt, updatedBy: actorId || '' });
  await sheets.appendRow(SHEET, newRow);
  await writeHistory('update', newRow, actorId, note || '');
  return hydrate(newRow);
}

async function archiveItem(id, actorId, note) {
  const existing = await findById(id);
  if (!existing) { const e = new Error('not_found'); e.code = 'not_found'; throw e; }
  await sheets.updateRowById(SHEET, existing.id, {
    status:    'expired',
    updatedAt: new Date().toISOString(),
    updatedBy: actorId || '',
  });
  await writeHistory('archive', { ...existing, status: 'expired' }, actorId, note || '');
  return { ...existing, status: 'expired' };
}

async function getHistory(knowledgeId) {
  const rows = await sheets.getRows(HIST_SHEET);
  return rows
    .filter(r => r.knowledgeId === knowledgeId)
    .sort((a, b) => (a.changedAt || '').localeCompare(b.changedAt || ''));
}

// ── Analyze a request against venue capability ──────────────────────────────
// This is the ONE function the AI/pipeline is allowed to consult when it
// wants to know "can the venue do this?". Everything about it is designed
// around the rule: NEVER invent a capability. When the venue has no rule on
// file the response says so explicitly and defers to human input.

async function analyzeCapability(request) {
  const {
    category,
    attributePath,
    requestedValue,
    unit,
    scope       = 'venue',
    criticality,           // 'critical' | 'high' | 'normal' — overrides path-based inference
  } = request || {};

  if (!attributePath) {
    return {
      known: false, matches: 'unknown', capability: null,
      reason: 'no_attribute_path',
      needsAction: true, needsVendor: false, critical: false,
      sources: [],
    };
  }

  const rule = await getActiveRule(attributePath, scope);

  // ── Unknown capability path ────────────────────────────────────────────
  // No rule found = unknown. We surface this loudly so the caller knows it
  // must be resolved by a human. We do NOT infer a value from observations
  // or fabricate anything.
  if (!rule) {
    const observations = await getObservations({ attributePath });
    return {
      known:       false,
      matches:     'unknown',
      capability:  null,
      request:     { attributePath, requestedValue, unit, scope },
      gap:         null,
      critical:    isCriticalPath(attributePath, category, criticality),
      needsVendor: false,
      needsAction: true,
      reason:      'no_venue_knowledge_on_file',
      observations,
      sources:     [],
    };
  }

  const capability = { value: rule.value, unit: rule.unit || null, ruleId: rule.id, confidence: rule.confidence, sources: buildSources(rule) };

  // ── If the request omits a value, we can only report the capability. ─
  if (requestedValue === undefined || requestedValue === null || requestedValue === '') {
    return {
      known: true, matches: 'unknown', capability,
      request: { attributePath, requestedValue, unit, scope },
      gap: null,
      critical: isCriticalPath(attributePath, category, criticality),
      needsVendor: false, needsAction: false,
      reason: 'no_requested_value_supplied',
      sources: buildSources(rule),
    };
  }

  const cmp = compareValues(rule.value, requestedValue, rule.unit, unit);

  const critical    = isCriticalPath(attributePath, category, criticality);
  const matches     = cmp.matches;
  const shortfall   = cmp.matches === 'no' || cmp.matches === 'partial';
  const needsVendor = shortfall && !cmp.venueCanCover;
  const needsAction = matches !== 'yes';

  return {
    known:       true,
    matches,
    capability,
    request:     { attributePath, requestedValue, unit, scope },
    gap:         cmp.gap,
    critical:    critical && shortfall,
    needsVendor,
    needsAction,
    reason:      cmp.reason,
    sources:     buildSources(rule),
  };
}

function buildSources(rule) {
  const out = [];
  if (rule.source) out.push({ type: rule.source, ref: rule.sourceRef, author: rule.author, at: rule.createdAt, ruleId: rule.id });
  return out;
}

function isCriticalPath(attributePath, category, override) {
  if (override === 'critical' || override === 'high') return true;
  if (override === 'normal') return false;
  const withCat = category ? `${category}.` : '';
  return CRITICAL_PATHS.some(p =>
    attributePath === p ||
    attributePath.startsWith(p + '.') ||
    (withCat && (withCat + attributePath).startsWith(p + '.')),
  );
}

// Compare a venue capability value against a request. Handles the shapes we
// actually store: scalar number (amps, meals), scalar string, {min,max},
// {value,unit}, list membership.
function compareValues(capability, requested, capUnit, reqUnit) {
  const c = capability;
  const r = requested;
  const unitMismatch = (capUnit || reqUnit) && capUnit && reqUnit && capUnit !== reqUnit;

  if (unitMismatch) {
    return { matches: 'unknown', gap: null, reason: `unit_mismatch: capability=${capUnit} request=${reqUnit}`, venueCanCover: false };
  }

  // Numeric — capacity comparison.
  if (isNumber(c) && isNumber(r)) {
    if (Number(c) >= Number(r)) return { matches: 'yes', gap: null, reason: 'capacity_meets_request', venueCanCover: true };
    return {
      matches: 'no',
      gap: { shortBy: Number(r) - Number(c), capability: Number(c), requested: Number(r), unit: capUnit || reqUnit || null },
      reason: 'capacity_below_request',
      venueCanCover: false,
    };
  }

  // {min,max} numeric range against a number.
  if (c && typeof c === 'object' && ('min' in c || 'max' in c) && isNumber(r)) {
    const min = c.min ?? -Infinity;
    const max = c.max ?? Infinity;
    if (Number(r) >= min && Number(r) <= max)
      return { matches: 'yes', gap: null, reason: 'request_within_range', venueCanCover: true };
    return {
      matches: 'no',
      gap: { min, max, requested: Number(r), unit: capUnit || reqUnit || null },
      reason: Number(r) < min ? 'request_below_min' : 'request_above_max',
      venueCanCover: false,
    };
  }

  // Boolean capability (can we do X?).
  if (typeof c === 'boolean' && typeof r === 'boolean') {
    if (c === r || (c === true && r === true))
      return { matches: 'yes', gap: null, reason: 'boolean_match', venueCanCover: true };
    if (c === false && r === true)
      return { matches: 'no', gap: { capability: false, requested: true }, reason: 'venue_cannot_provide', venueCanCover: false };
    return { matches: 'yes', gap: null, reason: 'not_requested', venueCanCover: true };
  }

  // Enum / list — capability is a list of allowed items, request is one item
  // or a list of items.
  if (Array.isArray(c)) {
    const reqList = Array.isArray(r) ? r : [r];
    const missing = reqList.filter(item => !c.map(x => String(x).toLowerCase()).includes(String(item).toLowerCase()));
    if (missing.length === 0)
      return { matches: 'yes', gap: null, reason: 'all_items_available', venueCanCover: true };
    return {
      matches: reqList.length === missing.length ? 'no' : 'partial',
      gap: { missing, provided: c },
      reason: 'items_not_provided_by_venue',
      venueCanCover: false,
    };
  }

  // String equality (canonicalized).
  if (typeof c === 'string' && typeof r === 'string') {
    if (c.trim().toLowerCase() === r.trim().toLowerCase())
      return { matches: 'yes', gap: null, reason: 'string_equal', venueCanCover: true };
    return { matches: 'no', gap: { capability: c, requested: r }, reason: 'string_mismatch', venueCanCover: false };
  }

  return { matches: 'unknown', gap: null, reason: 'incomparable_types', venueCanCover: false };
}

function isNumber(x) {
  if (x === null || x === undefined || x === '') return false;
  if (typeof x === 'number') return Number.isFinite(x);
  if (typeof x === 'string') return /^-?\d+(\.\d+)?$/.test(x.trim());
  return false;
}

module.exports = {
  // constants
  KINDS, STATUSES, CATEGORIES, CATEGORY_SUBCATEGORIES, CRITICAL_PATHS,
  // query
  listAll, findById, getActiveRule, getObservations, getHistory,
  // mutate
  createItem, updateItem, archiveItem,
  // analysis
  analyzeCapability,
  // internals exposed for tests
  _internals: { validateKnowledgeItem, normalizeValue, parseValue, compareValues, isCriticalPath },
};
