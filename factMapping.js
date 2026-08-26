'use strict';

/**
 * Fact Mapping — bridge between AI-extracted email facts and the existing
 * show / advance / schedule forms.
 *
 * Workflow this module implements:
 *   SOURCE → AI EXTRACTION (emailIntelligence.js)
 *          → NORMALIZATION  (normalizeValue below)
 *          → VALIDATION     (checkApplicable — refuses on conflict or if the
 *                            field is not mapped to any real form)
 *          → PROPOSED CHANGE (preview)
 *          → HUMAN REVIEW   (EmailIntel review UI)
 *          → APPROVAL       (server.js /email-intel/facts/:id/approve)
 *          → DATABASE UPDATE(applyApprovedFact writes into Shows/Advancing/
 *                            Schedule using the existing sheet contracts)
 *          → AUDIT LOG      (AiChangeLog row per applied/blocked change)
 *
 * NEVER auto-fills a field when the fact carries conflicts or when the
 * mapping does not exist. In those cases the caller sees requiresManual=true
 * so the review UI can surface: "Potential value detected — confirmation
 * required." for the PM to handle.
 */

const sheetsReal = require('./sheets');
const config     = require('./config/server-config');
const { randomUUID } = require('crypto');

const SHEETS = config.googleSheets.sheets;

// ── Mapping table ───────────────────────────────────────────────────────────
// Each fact.field lands on exactly one of the existing sheets:
//   target: 'show' | 'advance' | 'schedule'
//   mode:   'assign'         — write value directly to a column
//           'scheduleUpsert' — find-or-create a Schedule row by label
//           'appendNote'     — replace/insert a "Label: value" line in a
//                              free-text advance column (preserves prose)
//           'boolFlag'       — ensure a labeled presence line (pyro etc.)
//   risk:   'low' | 'high'   — only 'low' is eligible for batch approval

const FIELD_MAP = {
  // Direct-assign to Shows / Advancing columns
  show_time:      { target: 'show',    key: 'showTime',        mode: 'assign',         risk: 'high', category: 'schedule',    displayLabel: 'Show time' },
  doors_time:     { target: 'show',    key: 'doorsTime',       mode: 'assign',         risk: 'high', category: 'schedule',    displayLabel: 'Doors time' },
  curfew_time:    { target: 'advance', key: 'curfew',          mode: 'assign',         risk: 'high', category: 'operations',  displayLabel: 'Curfew' },

  // Day-of-show schedule rows (find-or-create by label + showId)
  loadin_time:    { target: 'schedule', label: 'Load-In',      mode: 'scheduleUpsert', risk: 'high', category: 'schedule',    displayLabel: 'Load-in' },
  soundcheck_time:{ target: 'schedule', label: 'Sound Check',  mode: 'scheduleUpsert', risk: 'high', category: 'schedule',    displayLabel: 'Sound check' },
  loadout_time:   { target: 'schedule', label: 'Load-Out',     mode: 'scheduleUpsert', risk: 'high', category: 'schedule',    displayLabel: 'Load-out' },

  // Safety-critical → high risk, land as labeled lines under advance prose
  chain_motor_count:{ target: 'advance', key: 'productionNeeds', mode: 'appendNote', label: 'Chain motors',     risk: 'high', category: 'safety',    displayLabel: 'Chain motors' },
  power_amps:      { target: 'advance', key: 'productionNeeds', mode: 'appendNote', label: 'Power (amps)',     risk: 'high', category: 'safety',    displayLabel: 'Power' },
  rigger_count:    { target: 'advance', key: 'localCrewNeeds',  mode: 'appendNote', label: 'Riggers',          risk: 'high', category: 'safety',    displayLabel: 'Riggers' },
  wireless_channels:{target: 'advance', key: 'productionNeeds', mode: 'appendNote', label: 'Wireless channels',risk: 'high', category: 'technical', displayLabel: 'Wireless channels' },
  pyro_requested:  { target: 'advance', key: 'productionNeeds', mode: 'boolFlag',   label: 'Pyro/flame requested', risk: 'high', category: 'safety', displayLabel: 'Pyro requested' },

  // Logistics — moving trucks materially changes load-in / crew planning
  truck_count:     { target: 'advance', key: 'productionNeeds', mode: 'appendNote', label: 'Trucks',           risk: 'high', category: 'logistics', displayLabel: 'Trucks' },
  bus_count:       { target: 'advance', key: 'productionNeeds', mode: 'appendNote', label: 'Buses',            risk: 'high', category: 'logistics', displayLabel: 'Buses' },
  van_count:       { target: 'advance', key: 'productionNeeds', mode: 'appendNote', label: 'Vans',             risk: 'low',  category: 'logistics', displayLabel: 'Vans' },

  // Technical (non-safety) still high because they change PA config
  line_array_boxes:  { target: 'advance', key: 'productionNeeds', mode: 'appendNote', label: 'Line array boxes', risk: 'high', category: 'technical', displayLabel: 'Line array boxes' },
  subwoofer_count:   { target: 'advance', key: 'productionNeeds', mode: 'appendNote', label: 'Subwoofers',       risk: 'high', category: 'technical', displayLabel: 'Subwoofers' },
  moving_light_count:{ target: 'advance', key: 'productionNeeds', mode: 'appendNote', label: 'Moving lights',    risk: 'high', category: 'technical', displayLabel: 'Moving lights' },
  stage_size:        { target: 'advance', key: 'stagingChanges',  mode: 'appendNote', label: 'Stage / deck',     risk: 'high', category: 'physical',  displayLabel: 'Stage / deck' },

  // Labor (non-safety)
  stagehand_count:   { target: 'advance', key: 'localCrewNeeds',  mode: 'appendNote', label: 'Stagehands',       risk: 'low',  category: 'labor',    displayLabel: 'Stagehands' },
  electrician_count: { target: 'advance', key: 'localCrewNeeds',  mode: 'appendNote', label: 'Electricians',     risk: 'low',  category: 'labor',    displayLabel: 'Electricians' },
  forklift_count:    { target: 'advance', key: 'localCrewNeeds',  mode: 'appendNote', label: 'Forklifts',        risk: 'low',  category: 'labor',    displayLabel: 'Forklifts' },

  // Catering (low risk — reversible ops)
  breakfast_count:   { target: 'advance', key: 'cateringNotes',   mode: 'appendNote', label: 'Breakfast',        risk: 'low',  category: 'catering', displayLabel: 'Breakfast' },
  lunch_count:       { target: 'advance', key: 'cateringNotes',   mode: 'appendNote', label: 'Lunch',            risk: 'low',  category: 'catering', displayLabel: 'Lunch' },
  dinner_count:      { target: 'advance', key: 'cateringNotes',   mode: 'appendNote', label: 'Dinner',           risk: 'low',  category: 'catering', displayLabel: 'Dinner' },
  meal_count:        { target: 'advance', key: 'cateringNotes',   mode: 'appendNote', label: 'Meals',            risk: 'low',  category: 'catering', displayLabel: 'Meals' },

  // Hospitality / access
  parking_spaces:    { target: 'advance', key: 'hospitalityNotes',mode: 'appendNote', label: 'Parking spaces',   risk: 'low',  category: 'hospitality', displayLabel: 'Parking spaces' },
  credential_count:  { target: 'advance', key: 'hospitalityNotes',mode: 'appendNote', label: 'Credentials',      risk: 'low',  category: 'hospitality', displayLabel: 'Credentials' },
  guest_list_count:  { target: 'advance', key: 'hospitalityNotes',mode: 'appendNote', label: 'Guest list',       risk: 'low',  category: 'hospitality', displayLabel: 'Guest list' },
  shower_count:      { target: 'advance', key: 'hospitalityNotes',mode: 'appendNote', label: 'Showers',          risk: 'low',  category: 'hospitality', displayLabel: 'Showers' },
  dressing_room_count:{target: 'advance', key: 'hospitalityNotes',mode: 'appendNote', label: 'Dressing rooms',   risk: 'low',  category: 'hospitality', displayLabel: 'Dressing rooms' },
};

// ── Confidence heuristic ────────────────────────────────────────────────────
// The extractor doesn't emit a number today; we derive one from the fact's
// shape so the review UI has an honest, explainable score.

function confidenceOf(fact) {
  if (!fact) return { level: 'low', because: 'no fact' };
  const conflicts = safeArray(fact.conflicts);
  if (conflicts.length > 0) return { level: 'low', because: 'value conflicts with existing data' };
  if (fact.kind === 'confirmation') return { level: 'high', because: 'sender confirmed the value' };
  if (fact.kind === 'correction' || fact.kind === 'change')
    return { level: 'high', because: 'sender explicitly changed a previous value' };
  if (fact.kind === 'assertion') {
    if (fact.newValue !== '' && fact.newValue != null) return { level: 'high', because: 'clear synonym + value match' };
    return { level: 'medium', because: 'assertion without a clean numeric anchor' };
  }
  if (fact.kind === 'request') return { level: 'medium', because: 'request phrasing — needs PM confirmation' };
  return { level: 'medium', because: 'default' };
}

// ── Value normalization ─────────────────────────────────────────────────────

function normalizeValue(rawValue, mapping) {
  if (rawValue == null || rawValue === '') return { value: null, display: '' };
  const parsed = safeParse(rawValue);
  if (mapping.mode === 'assign' && mapping.target === 'show' && (mapping.key === 'showTime' || mapping.key === 'doorsTime')) {
    // Times stored as strings ("20:00" or "8:00 PM") — leave the sender's format
    return { value: String(parsed), display: String(parsed) };
  }
  if (mapping.mode === 'assign' && mapping.key === 'curfew') {
    return { value: String(parsed), display: String(parsed) };
  }
  if (mapping.mode === 'scheduleUpsert') {
    return { value: String(parsed), display: String(parsed) };
  }
  if (mapping.mode === 'boolFlag') {
    const truthy = parsed === true || parsed === 'true' || parsed === 1 || parsed === '1';
    return { value: truthy, display: truthy ? 'yes' : 'no' };
  }
  if (mapping.mode === 'appendNote') {
    return { value: parsed, display: String(parsed) };
  }
  return { value: parsed, display: String(parsed) };
}

// ── Extract current value from live sheets ──────────────────────────────────

async function readCurrentValue({ showId, mapping }, { sheetsAdapter }) {
  if (mapping.target === 'show') {
    const shows = await sheetsAdapter.getRows(SHEETS.shows);
    const show  = shows.find(s => String(s.id) === String(showId));
    return { row: show || null, value: show ? (show[mapping.key] || '') : '' };
  }
  if (mapping.target === 'advance') {
    const advances = await sheetsAdapter.getRows(SHEETS.advancing);
    const adv = advances.find(a => String(a.showId) === String(showId));
    if (mapping.mode === 'appendNote' || mapping.mode === 'boolFlag') {
      const bucket = adv ? (adv[mapping.key] || '') : '';
      const line = findLabeledLine(bucket, mapping.label);
      return { row: adv || null, bucket, value: line };
    }
    return { row: adv || null, value: adv ? (adv[mapping.key] || '') : '' };
  }
  if (mapping.target === 'schedule') {
    const rows = await sheetsAdapter.getRows(SHEETS.schedule);
    const row = rows.find(r => String(r.showId) === String(showId) && labelMatches(r.label, mapping.label));
    return { row: row || null, value: row ? (row.time || '') : '' };
  }
  return { row: null, value: '' };
}

// ── Public: preview a proposed change against the current form ──────────────

async function preview(fact, { sheetsAdapter = sheetsReal } = {}) {
  const factObj = deepParseFact(fact);
  const mapping = FIELD_MAP[factObj.field];
  const source = {
    from:       factObj.senderName || factObj.senderEmail || 'unknown',
    email:      factObj.senderEmail || '',
    threadId:   factObj.threadId || '',
    messageId:  factObj.sourceMessageId || '',
    excerpt:    factObj.sourceExcerpt || '',
    date:       factObj.sourceDate || '',
    extractor:  factObj.extractor || 'unknown',
    extractedAt:factObj.extractedAt || '',
  };
  const confidence = confidenceOf(factObj);
  const conflicts  = safeArray(factObj.conflicts);
  const uncertain  = confidence.level === 'low' || conflicts.length > 0 || !mapping;

  if (!mapping) {
    return {
      supported: false,
      field: factObj.field,
      displayLabel: humanize(factObj.field),
      currentValue: null,
      proposedValue: factObj.newValue ?? null,
      source, confidence, conflicts,
      risk: 'high',
      status: 'unmapped',
      reason: factObj.reasoningSummary || 'Field extracted but has no direct mapping to an existing form field — PM must handle manually.',
      // Per spec: "Potential value detected — confirmation required."
      message: 'Potential value detected — confirmation required.',
    };
  }

  const { row, value: currentValue, bucket } = await readCurrentValue(
    { showId: factObj.showId, mapping },
    { sheetsAdapter },
  );
  const proposed = normalizeValue(factObj.newValue, mapping);
  const isNoOp = mapping.mode === 'appendNote'
    ? (currentValue && String(currentValue).trim() === String(proposed.display).trim())
    : mapping.mode === 'boolFlag'
      ? (Boolean(currentValue) === Boolean(proposed.value))
      : (String(currentValue || '').trim() === String(proposed.display || '').trim());

  let status = 'ready';
  let message = null;
  if (conflicts.length > 0) {
    status = 'conflict';
    message = 'Conflicting information detected — PM must resolve.';
  } else if (uncertain) {
    status = 'uncertain';
    message = 'Potential value detected — confirmation required.';
  } else if (isNoOp) {
    status = 'no_change';
    message = 'Proposed value already matches current form value.';
  }

  return {
    supported: true,
    field: factObj.field,
    displayLabel: mapping.displayLabel || humanize(factObj.field),
    target:  mapping.target,
    targetKey: mapping.target === 'schedule' ? mapping.label : mapping.key,
    category: mapping.category,
    changeCategory: mapping.category,
    currentValue: currentValue ?? '',
    currentBucket: bucket ?? null,
    proposedValue: proposed.display,
    proposedRaw:   proposed.value,
    source,
    confidence,
    conflicts,
    risk: (conflicts.length > 0) ? 'high' : mapping.risk,
    status,
    reason: factObj.reasoningSummary || null,
    message,
    // Row that would be updated (null = will be created)
    targetRow: row ? { id: row.id } : null,
  };
}

// ── Public: apply an approved fact into the real form ───────────────────────

async function applyApprovedFact(fact, actor, { sheetsAdapter = sheetsReal, note = '' } = {}) {
  const factObj = deepParseFact(fact);
  const mapping = FIELD_MAP[factObj.field];
  const conflicts = safeArray(factObj.conflicts);
  const previewResult = await preview(factObj, { sheetsAdapter });

  const baseAudit = {
    id: randomUUID(),
    at: new Date().toISOString(),
    approvedBy: actor?.email || actor?.username || actor?.id || 'unknown',
    factId: factObj.id,
    showId: factObj.showId || '',
    field: factObj.field,
    changeCategory: mapping?.category || 'unknown',
    target:      mapping?.target || 'unmapped',
    targetField: mapping?.target === 'schedule' ? (mapping?.label || '') : (mapping?.key || ''),
    previousValue: stringify(previewResult.currentValue),
    newValue:      stringify(previewResult.proposedValue),
    sourceFrom:      previewResult.source.from,
    sourceEmail:     previewResult.source.email,
    sourceThreadId:  previewResult.source.threadId,
    sourceMessageId: previewResult.source.messageId,
    sourceExcerpt:   previewResult.source.excerpt,
    sourceDate:      previewResult.source.date,
    reason:      previewResult.reason || '',
    extractedAt: previewResult.source.extractedAt,
    extractor:   previewResult.source.extractor,
    extractionRecord: JSON.stringify({
      kind: factObj.kind, provenance: factObj.provenance || null,
      previousValue: factObj.previousValue, newValue: factObj.newValue,
      synonymMatched: factObj.provenance?.synonymMatched || factObj.synonymMatched,
    }),
    confidence:      previewResult.confidence.level,
    confidenceWhy:   previewResult.confidence.because,
    risk:            previewResult.risk,
    approvalNote:    note || '',
    status: 'applied',
  };

  if (!mapping) {
    baseAudit.status = 'skipped_unmapped';
    await writeAudit(baseAudit, sheetsAdapter);
    return { applied: false, requiresManual: true, reason: 'unmapped', audit: baseAudit };
  }
  if (conflicts.length > 0) {
    baseAudit.status = 'skipped_conflict';
    await writeAudit(baseAudit, sheetsAdapter);
    return { applied: false, requiresManual: true, reason: 'conflict', conflicts, audit: baseAudit };
  }
  if (previewResult.status === 'no_change') {
    baseAudit.status = 'no_change';
    await writeAudit(baseAudit, sheetsAdapter);
    return { applied: true, noChange: true, audit: baseAudit };
  }

  // ── Perform the write against the real sheet. ────────────────────────────
  // Invariant: NO authoritative row is ever mutated without a corresponding
  // AiChangeLog entry. If the apply throws mid-way we still write an audit
  // row with status='failed_apply' before re-throwing so an on-call PM can
  // diagnose exactly what happened.
  const proposed = normalizeValue(factObj.newValue, mapping);
  try {
    if (mapping.target === 'show') {
      if (!previewResult.targetRow) {
        baseAudit.status = 'skipped_missing_row';
        await writeAudit(baseAudit, sheetsAdapter);
        return { applied: false, requiresManual: true, reason: 'show_not_found', audit: baseAudit };
      }
      await sheetsAdapter.updateRowById(SHEETS.shows, previewResult.targetRow.id, { [mapping.key]: proposed.display });
    } else if (mapping.target === 'advance') {
      let advRow = previewResult.targetRow;
      if (!advRow) {
        const newAdvId = randomUUID();
        const shows = await sheetsAdapter.getRows(SHEETS.shows);
        const show = shows.find(s => String(s.id) === String(factObj.showId));
        const initial = mapping.mode === 'appendNote' || mapping.mode === 'boolFlag'
          ? applyLine('', mapping, proposed)
          : proposed.display;
        await sheetsAdapter.appendRow(SHEETS.advancing, {
          id: newAdvId, showId: factObj.showId,
          showName: show?.artist || show?.eventName || '',
          stage: show?.stage || '',
          createdAt: new Date().toISOString(),
          [mapping.key]: initial,
        });
        advRow = { id: newAdvId };
      } else if (mapping.mode === 'appendNote' || mapping.mode === 'boolFlag') {
        const advances = await sheetsAdapter.getRows(SHEETS.advancing);
        const current = advances.find(a => String(a.id) === String(advRow.id));
        const nextBucket = applyLine(current?.[mapping.key] || '', mapping, proposed);
        await sheetsAdapter.updateRowById(SHEETS.advancing, advRow.id, { [mapping.key]: nextBucket });
      } else {
        await sheetsAdapter.updateRowById(SHEETS.advancing, advRow.id, { [mapping.key]: proposed.display });
      }
    } else if (mapping.target === 'schedule') {
      if (previewResult.targetRow) {
        await sheetsAdapter.updateRowById(SHEETS.schedule, previewResult.targetRow.id, { time: proposed.display });
      } else {
        const shows = await sheetsAdapter.getRows(SHEETS.shows);
        const show = shows.find(s => String(s.id) === String(factObj.showId));
        await sheetsAdapter.appendRow(SHEETS.schedule, {
          id: randomUUID(), showId: factObj.showId,
          showName: show?.artist || show?.eventName || '',
          stage: show?.stage || '',
          date: show?.date || '',
          label: mapping.label, time: proposed.display,
          responsible: '', notes: 'Set by AI from email',
          createdAt: new Date().toISOString(),
        });
      }
    }
  } catch (err) {
    baseAudit.status = 'failed_apply';
    baseAudit.reason = (baseAudit.reason ? baseAudit.reason + ' | ' : '') + 'apply_error: ' + err.message;
    // Best-effort audit even on failure; if THIS also throws we surface both.
    try { await writeAudit(baseAudit, sheetsAdapter); }
    catch (auditErr) { err.auditWriteError = auditErr.message; }
    throw err;
  }

  await writeAudit(baseAudit, sheetsAdapter);
  return { applied: true, audit: baseAudit };
}

// ── Batch approval (LOW-RISK only, and never conflicts) ─────────────────────

function eligibleForBatch(previewResult) {
  if (!previewResult.supported) return false;
  if (previewResult.risk !== 'low') return false;
  if ((previewResult.conflicts || []).length > 0) return false;
  if (previewResult.status === 'conflict') return false;
  if (previewResult.status === 'uncertain') return false;
  return true;
}

// ── Line-in-bucket helpers ──────────────────────────────────────────────────
// Free-text advance columns can hold arbitrary PM notes. We ONLY touch lines
// we own — those with a "- Label: value" shape — so we never overwrite prose.

function applyLine(bucket, mapping, proposed) {
  const label = mapping.label;
  if (mapping.mode === 'boolFlag') {
    const lines = String(bucket || '').split(/\r?\n/);
    const idx   = lines.findIndex(l => new RegExp(`^\\s*-\\s*${escapeRegex(label)}\\b`, 'i').test(l));
    if (proposed.value) {
      if (idx === -1) return joinLines([...lines, `- ${label}`]);
      return bucket;
    }
    if (idx === -1) return bucket;
    lines.splice(idx, 1);
    return joinLines(lines);
  }
  const newLine = `- ${label}: ${proposed.display}`;
  const lines = String(bucket || '').split(/\r?\n/);
  const idx   = lines.findIndex(l => new RegExp(`^\\s*-\\s*${escapeRegex(label)}\\s*:`, 'i').test(l));
  if (idx === -1) return joinLines([...lines, newLine]);
  lines[idx] = newLine;
  return joinLines(lines);
}

function findLabeledLine(bucket, label) {
  if (!bucket || !label) return '';
  const lines = String(bucket).split(/\r?\n/);
  const line = lines.find(l => new RegExp(`^\\s*-\\s*${escapeRegex(label)}\\s*:`, 'i').test(l));
  if (!line) return '';
  const m = line.match(new RegExp(`^\\s*-\\s*${escapeRegex(label)}\\s*:\\s*(.*)$`, 'i'));
  return m ? m[1].trim() : '';
}

function labelMatches(a, b) {
  if (!a || !b) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function joinLines(lines) {
  return lines.filter((l, i, arr) => l.trim() !== '' || (i > 0 && arr[i-1].trim() !== '')).join('\n').trim();
}

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ── Audit log ───────────────────────────────────────────────────────────────

async function writeAudit(row, sheetsAdapter) {
  try {
    await sheetsAdapter.appendRow(SHEETS.aiChangeLog, row);
  } catch (err) {
    // A single audit-log failure must never mask the underlying operation.
    console.error('[factMapping] audit-log write failed:', err.message);
  }
}

// ── Misc helpers ────────────────────────────────────────────────────────────

function safeParse(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}
function safeArray(v) {
  const p = safeParse(v);
  return Array.isArray(p) ? p : [];
}
function stringify(v) {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function humanize(field) {
  return String(field || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function deepParseFact(fact) {
  const out = { ...fact };
  if (typeof out.newValue      === 'string') out.newValue      = safeParse(out.newValue);
  if (typeof out.previousValue === 'string') out.previousValue = safeParse(out.previousValue);
  if (typeof out.conflicts     === 'string') out.conflicts     = safeParse(out.conflicts);
  if (typeof out.provenance    === 'string') out.provenance    = safeParse(out.provenance);
  return out;
}

module.exports = {
  FIELD_MAP,
  preview,
  applyApprovedFact,
  eligibleForBatch,
  confidenceOf,
  // Exposed for tests
  _internals: { applyLine, findLabeledLine, normalizeValue, humanize },
};
