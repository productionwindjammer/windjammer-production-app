'use strict';

/**
 * Fact Mapping tests — proves the AI extraction → normalization → validation
 * → proposed change → approval → database update → audit-log pipeline lands
 * values into the EXISTING Shows / Advancing / Schedule sheets rather than
 * a duplicate structure.
 *
 * Locks in the workflow contract:
 *   • Batch approval works ONLY for low-risk fields and NEVER for conflicts.
 *   • Every applied change writes to AiChangeLog with the mandated columns:
 *     previous value, new value, approving user, timestamp, source, AI
 *     extraction record, reason, change category.
 *   • Conflicts are NOT auto-applied. The engine returns requiresManual=true
 *     and logs 'skipped_conflict'.
 *   • Unmapped fields surface "Potential value detected — confirmation
 *     required." per the spec.
 *   • appendNote mode preserves PM prose in free-text advance buckets.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

// ── In-memory sheets fake ──────────────────────────────────────────────────
const store = new Map();
function resetStore() {
  store.clear();
  store.set('Shows',        []);
  store.set('Advancing',    []);
  store.set('Schedule',     []);
  store.set('AiChangeLog',  []);
}
const fakeSheets = {
  async getRows(name) { return (store.get(name) || []).map(r => ({ ...r })); },
  async appendRow(name, row) { if (!store.has(name)) store.set(name, []); store.get(name).push({ ...row }); },
  async appendRows(name, rows) { for (const r of rows) await fakeSheets.appendRow(name, r); },
  async updateRowById(name, id, patch) {
    const rows = store.get(name) || [];
    const i = rows.findIndex(r => String(r.id) === String(id));
    if (i < 0) throw new Error('missing row ' + id);
    rows[i] = { ...rows[i], ...patch };
  },
  async deleteRowById(name, id) { store.set(name, (store.get(name)||[]).filter(r => String(r.id)!==String(id))); },
  async ensureHeaders() {}, async ensureSheet() {},
};
const sheetsPath = path.resolve(__dirname, '..', 'sheets.js');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

const factMapping = require('../factMapping');

// ── Fixture helpers ────────────────────────────────────────────────────────
function seedShow(over = {}) {
  const show = { id: 'show_1', date: '2026-11-01', artist: 'Fictional Artist', stage: 'inside',
                 showTime: '20:00', doorsTime: '19:00', ...over };
  store.get('Shows').push(show);
  return show;
}
function seedAdvance(over = {}) {
  const adv = { id: 'adv_1', showId: 'show_1',
                riderNotes: '', productionNeeds: '', backlineNotes: '',
                cateringNotes: '', hospitalityNotes: '', localCrewNeeds: '',
                stagingChanges: '', curfew: '', notes: '', ...over };
  store.get('Advancing').push(adv);
  return adv;
}
function makeFact(over = {}) {
  return {
    id: 'fact_1', showId: 'show_1', field: 'truck_count',
    kind: 'assertion', status: 'proposed',
    newValue: 4, previousValue: '', conflicts: [],
    senderName: 'Devon Kim', senderEmail: 'dkim@example-tour.test',
    threadId: 'thread_1', sourceMessageId: 'msg_1',
    sourceExcerpt: 'we\'ll roll in with 4 trucks', sourceDate: '2026-09-01T10:00:00Z',
    extractor: 'rules-v1', extractedAt: '2026-09-01T10:00:05Z',
    reasoningSummary: 'sender explicitly stated 4 trucks',
    ...over,
  };
}
const actor = { email: 'pm@example.test', username: 'pm' };

// ─────────────────────────────────────────────────────────────────────────
// preview() semantics
// ─────────────────────────────────────────────────────────────────────────

test('preview shows current + proposed + source + confidence + reason for a mapped field', async () => {
  resetStore(); seedShow(); seedAdvance();
  const p = await factMapping.preview(makeFact());
  assert.equal(p.supported, true);
  assert.equal(p.field, 'truck_count');
  assert.equal(p.target, 'advance');
  assert.equal(p.targetKey, 'productionNeeds');
  assert.equal(p.currentValue, '');            // no prior line in productionNeeds
  assert.equal(p.proposedValue, '4');
  assert.equal(p.source.from, 'Devon Kim');
  assert.equal(p.source.threadId, 'thread_1');
  assert.equal(p.confidence.level, 'high');    // assertion + clean numeric
  assert.equal(p.risk, 'high');                // trucks classified high-risk
  assert.ok(p.reason);
});

test('preview surfaces "Potential value detected — confirmation required." on unmapped fields', async () => {
  resetStore(); seedShow(); seedAdvance();
  const p = await factMapping.preview(makeFact({ field: 'mystery_ai_field', newValue: 'something' }));
  assert.equal(p.supported, false);
  assert.equal(p.status, 'unmapped');
  assert.equal(p.message, 'Potential value detected — confirmation required.');
});

test('preview marks status=conflict when the fact carries conflicts (does NOT populate)', async () => {
  resetStore(); seedShow(); seedAdvance();
  const p = await factMapping.preview(makeFact({ conflicts: [{ kind: 'venue', reason: 'exceeds capacity', critical: true }] }));
  assert.equal(p.status, 'conflict');
  assert.equal(p.message, 'Conflicting information detected — PM must resolve.');
  assert.equal(p.risk, 'high'); // conflicts force high risk regardless
});

test('preview marks status=no_change when the proposed value already matches', async () => {
  resetStore(); seedShow();
  seedAdvance({ productionNeeds: '- Trucks: 4' });
  const p = await factMapping.preview(makeFact());
  assert.equal(p.status, 'no_change');
});

// ─────────────────────────────────────────────────────────────────────────
// applyApprovedFact() — writes into the REAL sheets
// ─────────────────────────────────────────────────────────────────────────

test('applying a doors_time update writes to the Shows sheet (existing column)', async () => {
  resetStore(); seedShow(); seedAdvance();
  const fact = makeFact({ field: 'doors_time', newValue: '18:30' });
  const result = await factMapping.applyApprovedFact(fact, actor);
  assert.equal(result.applied, true);
  assert.equal(store.get('Shows')[0].doorsTime, '18:30');
});

test('applying a loadin_time update creates or updates the Schedule row for load-in', async () => {
  resetStore(); seedShow(); seedAdvance();
  const fact = makeFact({ field: 'loadin_time', newValue: '08:00' });
  await factMapping.applyApprovedFact(fact, actor);
  const rows = store.get('Schedule');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label.toLowerCase(), 'load-in');
  assert.equal(rows[0].time, '08:00');
  // A follow-up correction updates the same row (no duplicates).
  await factMapping.applyApprovedFact(
    makeFact({ id: 'fact_2', field: 'loadin_time', newValue: '06:00', kind: 'correction' }),
    actor,
  );
  const rows2 = store.get('Schedule');
  assert.equal(rows2.length, 1);
  assert.equal(rows2[0].time, '06:00');
});

test('applying a truck_count adds a labeled line to the advance productionNeeds bucket, preserving PM prose', async () => {
  resetStore(); seedShow();
  seedAdvance({ productionNeeds: 'PM notes: bring extra XLRs.' });
  await factMapping.applyApprovedFact(makeFact(), actor);
  const adv = store.get('Advancing')[0];
  assert.match(adv.productionNeeds, /PM notes: bring extra XLRs\./);
  assert.match(adv.productionNeeds, /- Trucks: 4/);
});

test('a second truck_count fact updates the existing labeled line (no duplicates)', async () => {
  resetStore(); seedShow(); seedAdvance();
  await factMapping.applyApprovedFact(makeFact({ newValue: 3 }), actor);
  await factMapping.applyApprovedFact(makeFact({ id: 'fact_2', newValue: 4, kind: 'correction' }), actor);
  const adv = store.get('Advancing')[0];
  const occurrences = (adv.productionNeeds.match(/- Trucks:/g) || []).length;
  assert.equal(occurrences, 1);
  assert.match(adv.productionNeeds, /- Trucks: 4/);
});

test('pyro_requested bool flag ensures a single labeled presence line', async () => {
  resetStore(); seedShow(); seedAdvance();
  await factMapping.applyApprovedFact(makeFact({ field: 'pyro_requested', newValue: true, kind: 'assertion' }), actor);
  const adv = store.get('Advancing')[0];
  assert.match(adv.productionNeeds, /- Pyro\/flame requested/);
});

test('conflict facts are NEVER auto-applied — status=skipped_conflict, requiresManual=true', async () => {
  resetStore(); seedShow(); seedAdvance();
  const fact = makeFact({ conflicts: [{ kind: 'venue', reason: 'exceeds capacity', critical: true }] });
  const result = await factMapping.applyApprovedFact(fact, actor);
  assert.equal(result.applied, false);
  assert.equal(result.requiresManual, true);
  // Advance is untouched.
  assert.equal(store.get('Advancing')[0].productionNeeds, '');
  // Audit row records the block.
  const audit = store.get('AiChangeLog');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].status, 'skipped_conflict');
});

test('unmapped facts are NEVER silently applied — audit shows skipped_unmapped', async () => {
  resetStore(); seedShow(); seedAdvance();
  const fact = makeFact({ field: 'mystery_ai_field', newValue: 'x' });
  const result = await factMapping.applyApprovedFact(fact, actor);
  assert.equal(result.applied, false);
  assert.equal(result.requiresManual, true);
  const audit = store.get('AiChangeLog');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].status, 'skipped_unmapped');
});

test('auto-creates an advance row if one does not exist yet', async () => {
  resetStore(); seedShow(); // no advance row seeded
  await factMapping.applyApprovedFact(makeFact({ field: 'dinner_count', newValue: 30 }), actor);
  const rows = store.get('Advancing');
  assert.equal(rows.length, 1);
  assert.match(rows[0].cateringNotes, /- Dinner: 30/);
  assert.equal(rows[0].showId, 'show_1');
});

// ─────────────────────────────────────────────────────────────────────────
// Audit log integrity (spec-mandated columns)
// ─────────────────────────────────────────────────────────────────────────

test('audit log records prev/new/actor/timestamp/source/reason/category on every apply', async () => {
  resetStore(); seedShow(); seedAdvance({ doorsTime: '' });
  const fact = makeFact({ field: 'doors_time', newValue: '18:30', kind: 'confirmation' });
  await factMapping.applyApprovedFact(fact, actor, { note: 'checked with promoter' });
  const audit = store.get('AiChangeLog')[0];
  assert.equal(audit.status, 'applied');
  assert.equal(audit.approvedBy, 'pm@example.test');
  assert.ok(audit.at);
  assert.equal(audit.previousValue, '19:00');   // seeded doorsTime
  assert.equal(audit.newValue,      '18:30');
  assert.equal(audit.sourceFrom,    'Devon Kim');
  assert.equal(audit.sourceThreadId,'thread_1');
  assert.equal(audit.sourceMessageId,'msg_1');
  assert.ok(audit.sourceExcerpt);
  assert.ok(audit.extractionRecord); // JSON snapshot of the fact
  assert.ok(audit.reason);
  assert.equal(audit.confidence, 'high');
  assert.equal(audit.risk, 'high');
  assert.equal(audit.changeCategory, 'schedule');
  assert.equal(audit.field, 'doors_time');
  assert.equal(audit.target, 'show');
  assert.equal(audit.targetField, 'doorsTime');
  assert.equal(audit.approvalNote, 'checked with promoter');
});

test('no_change is still audited (traceability even for redundant approvals)', async () => {
  resetStore(); seedShow();
  seedAdvance({ productionNeeds: '- Trucks: 4' });
  await factMapping.applyApprovedFact(makeFact(), actor);
  const audit = store.get('AiChangeLog')[0];
  assert.equal(audit.status, 'no_change');
});

// ─────────────────────────────────────────────────────────────────────────
// Batch approval eligibility
// ─────────────────────────────────────────────────────────────────────────

test('batch approval eligibility: low-risk mapped fact with no conflict is eligible', async () => {
  resetStore(); seedShow(); seedAdvance();
  const preview = await factMapping.preview(makeFact({ field: 'dinner_count', newValue: 30 }));
  assert.equal(factMapping.eligibleForBatch(preview), true);
});

test('batch approval eligibility: HIGH-risk fact is NOT eligible (safety, schedule, etc.)', async () => {
  resetStore(); seedShow(); seedAdvance();
  const highRiskFields = ['show_time', 'doors_time', 'curfew_time', 'loadin_time', 'chain_motor_count', 'pyro_requested', 'wireless_channels', 'power_amps', 'truck_count'];
  for (const field of highRiskFields) {
    const p = await factMapping.preview(makeFact({ field, newValue: field.endsWith('_time') ? '10:00' : 4 }));
    assert.equal(factMapping.eligibleForBatch(p), false, `${field} must NOT be batch-approvable`);
  }
});

test('batch approval eligibility: conflict facts are NEVER eligible even if the field is low-risk', async () => {
  resetStore(); seedShow(); seedAdvance();
  const p = await factMapping.preview(makeFact({
    field: 'dinner_count', newValue: 30,
    conflicts: [{ kind: 'existing_show', reason: 'differs from prior count' }],
  }));
  assert.equal(factMapping.eligibleForBatch(p), false);
});

test('batch approval eligibility: uncertain facts are NOT eligible', async () => {
  resetStore(); seedShow(); seedAdvance();
  // Request-kind facts with an ambiguous value → medium confidence, but preview
  // still marks status=ready. Eligibility requires low risk which they satisfy;
  // low-confidence facts are pushed to uncertain by preview only when the value
  // is empty. We fake that here by asserting the explicit uncertain path.
  const p = { supported: true, risk: 'low', status: 'uncertain', conflicts: [] };
  assert.equal(factMapping.eligibleForBatch(p), false);
});

// ─────────────────────────────────────────────────────────────────────────
// Line-editor helpers
// ─────────────────────────────────────────────────────────────────────────

test('appendLine preserves other PM lines and only touches the labeled slot', () => {
  const { applyLine } = factMapping._internals;
  const start = 'PM header note\n- Meals: 40\n- Trucks: 3\nfooter';
  const next  = applyLine(start, { label: 'Trucks', mode: 'appendNote' }, { value: 4, display: '4' });
  assert.match(next, /PM header note/);
  assert.match(next, /- Meals: 40/);
  assert.match(next, /- Trucks: 4/);
  assert.match(next, /footer/);
});

test('confidence heuristic is honest: conflicts drop to low, confirmations rise to high', () => {
  assert.equal(factMapping.confidenceOf({ kind: 'confirmation', newValue: 4 }).level, 'high');
  assert.equal(factMapping.confidenceOf({ kind: 'correction',   newValue: 4 }).level, 'high');
  assert.equal(factMapping.confidenceOf({ kind: 'assertion',    newValue: 4 }).level, 'high');
  assert.equal(factMapping.confidenceOf({ kind: 'request',      newValue: 4 }).level, 'medium');
  assert.equal(factMapping.confidenceOf({ kind: 'assertion', newValue: 4, conflicts: [{ x: 1 }] }).level, 'low');
});
