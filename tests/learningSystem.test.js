'use strict';

/**
 * Learning & Correction System tests.
 *
 * Locks in:
 *   - Single correction is logged but NEVER becomes a rule on its own.
 *   - SHOW_SPECIFIC / ONE_TIME corrections never generate candidates.
 *   - ≥3 corrections across ≥2 distinct shows with same field+value+VENUE
 *     scope generate a VENUE_SPECIFIC candidate.
 *   - PROMOTER_SPECIFIC corrections with same promoter across shows
 *     generate a PROMOTER_SPECIFIC candidate.
 *   - Scan is idempotent — running twice does not create duplicates.
 *   - reject → status 'rejected', never promoted.
 *   - edit → status 'edited', still awaiting acceptance.
 *   - accept → promotes to VenueKnowledge rule, preserves version history.
 *   - Accepted rule carries scope, effective/expiration, authoritative marker.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

// ── In-memory sheets fake ──────────────────────────────────────────────────
const store = new Map();
function resetStore() {
  store.clear();
  store.set('AiCorrections',        []);
  store.set('KnowledgeCandidates',  []);
  store.set('VenueKnowledge',       []);
  store.set('VenueKnowledgeHistory',[]);
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

const learning       = require('../learningSystem');
const venueKnowledge = require('../venueKnowledge');

const actor = { email: 'pm@example.test', username: 'pm' };

function makeCorrection(over = {}) {
  return {
    showId: 'show_1', showDate: '2026-11-01',
    venue: 'Windjammer', promoter: 'Live Nation', artist: 'Fictional Artist', tourName: 'Winter Tour',
    factId: 'fact_1', field: 'stagehand_count', source: 'email',
    aiValue: 4, correctedValue: 6,
    correctionType: 'VENUE_SPECIFIC',
    reason: 'we always run 6 hands for a headliner',
    ...over,
  };
}

// ── Logging ────────────────────────────────────────────────────────────────

test('logCorrection persists a full audit row', async () => {
  resetStore();
  const row = await learning.logCorrection(makeCorrection(), actor);
  assert.ok(row.id);
  assert.equal(row.actor, 'pm@example.test');
  assert.equal(row.field, 'stagehand_count');
  assert.equal(row.aiValue, '4');
  assert.equal(row.correctedValue, '6');
  assert.equal(row.correctionType, 'VENUE_SPECIFIC');
  assert.equal(store.get('AiCorrections').length, 1);
});

test('logCorrection rejects unknown correctionType', async () => {
  resetStore();
  await assert.rejects(
    () => learning.logCorrection(makeCorrection({ correctionType: 'BOGUS' }), actor),
    /invalid correctionType/,
  );
});

test('logCorrection requires field, aiValue, correctedValue', async () => {
  resetStore();
  await assert.rejects(() => learning.logCorrection({}, actor), /field required/);
  await assert.rejects(() => learning.logCorrection({ field: 'x' }, actor), /aiValue required/);
  await assert.rejects(() => learning.logCorrection({ field: 'x', aiValue: 1 }, actor), /correctedValue required/);
});

// ── Single correction is never a rule ──────────────────────────────────────

test('a single correction does NOT create a candidate', async () => {
  resetStore();
  await learning.logCorrection(makeCorrection(), actor);
  const res = await learning.scanForPatterns();
  assert.equal(res.created.length, 0);
  assert.equal(store.get('KnowledgeCandidates').length, 0);
});

test('SHOW_SPECIFIC corrections never generate candidates', async () => {
  resetStore();
  for (let i = 0; i < 5; i++) {
    await learning.logCorrection(makeCorrection({
      showId: 'show_' + i, correctionType: 'SHOW_SPECIFIC',
    }), actor);
  }
  const res = await learning.scanForPatterns();
  assert.equal(res.created.length, 0);
});

test('ONE_TIME corrections never generate candidates', async () => {
  resetStore();
  for (let i = 0; i < 5; i++) {
    await learning.logCorrection(makeCorrection({
      showId: 'show_' + i, correctionType: 'ONE_TIME',
    }), actor);
  }
  const res = await learning.scanForPatterns();
  assert.equal(res.created.length, 0);
});

// ── Repeated pattern → candidate ───────────────────────────────────────────

test('3 VENUE_SPECIFIC corrections across 3 shows create one candidate', async () => {
  resetStore();
  for (let i = 0; i < 3; i++) {
    await learning.logCorrection(makeCorrection({ showId: 'show_' + i }), actor);
  }
  const res = await learning.scanForPatterns();
  assert.equal(res.created.length, 1);
  const c = res.created[0];
  assert.equal(c.field, 'stagehand_count');
  assert.equal(c.value, '6');
  assert.equal(c.suggestedClassification, 'VENUE_SPECIFIC');
  assert.equal(c.status, 'proposed');
  assert.equal(c.occurrences, '3');
  const showIds = JSON.parse(c.showIds);
  assert.equal(showIds.length, 3);
});

test('below threshold: 2 corrections across 2 shows do NOT create a candidate', async () => {
  resetStore();
  await learning.logCorrection(makeCorrection({ showId: 'show_1' }), actor);
  await learning.logCorrection(makeCorrection({ showId: 'show_2' }), actor);
  const res = await learning.scanForPatterns();
  assert.equal(res.created.length, 0);
});

test('3 corrections but same show do not create a candidate (minShows unmet)', async () => {
  resetStore();
  for (let i = 0; i < 3; i++) {
    await learning.logCorrection(makeCorrection({ showId: 'show_1' }), actor);
  }
  const res = await learning.scanForPatterns();
  assert.equal(res.created.length, 0);
});

test('PROMOTER_SPECIFIC candidate requires shared promoter across shows', async () => {
  resetStore();
  for (let i = 0; i < 3; i++) {
    await learning.logCorrection(makeCorrection({
      showId: 'show_' + i,
      promoter: 'AEG',
      correctionType: 'PROMOTER_SPECIFIC',
    }), actor);
  }
  const res = await learning.scanForPatterns();
  assert.equal(res.created.length, 1);
  assert.equal(res.created[0].suggestedClassification, 'PROMOTER_SPECIFIC');
  assert.equal(res.created[0].scopeKey, 'promoter');
  assert.equal(res.created[0].scopeValue, 'AEG');
});

test('scan is idempotent — running twice updates rather than duplicating', async () => {
  resetStore();
  for (let i = 0; i < 3; i++) {
    await learning.logCorrection(makeCorrection({ showId: 'show_' + i }), actor);
  }
  await learning.scanForPatterns();
  const before = store.get('KnowledgeCandidates').length;
  await learning.logCorrection(makeCorrection({ showId: 'show_4' }), actor);
  const res2 = await learning.scanForPatterns();
  const after = store.get('KnowledgeCandidates').length;
  assert.equal(after, before, 'no new candidate rows added');
  assert.equal(res2.created.length, 0);
  assert.equal(res2.updated.length, 1);
  assert.equal(res2.updated[0].occurrences, '4');
});

// ── Review flow ────────────────────────────────────────────────────────────

test('reject marks candidate rejected without promoting', async () => {
  resetStore();
  for (let i = 0; i < 3; i++) {
    await learning.logCorrection(makeCorrection({ showId: 'show_' + i }), actor);
  }
  const { created } = await learning.scanForPatterns();
  const reviewed = await learning.reviewCandidate(created[0].id, 'reject', { reviewNote: 'not a rule' }, actor);
  assert.equal(reviewed.status, 'rejected');
  assert.equal(reviewed.reviewNote, 'not a rule');
  assert.equal(store.get('VenueKnowledge').length, 0, 'no rule promoted');
});

test('edit changes value/scope/dates and keeps status editable', async () => {
  resetStore();
  for (let i = 0; i < 3; i++) {
    await learning.logCorrection(makeCorrection({ showId: 'show_' + i }), actor);
  }
  const { created } = await learning.scanForPatterns();
  const edited = await learning.reviewCandidate(created[0].id, 'edit', {
    value: 8, scope: 'venue', effectiveFrom: '2026-01-01', expiresAt: '2026-12-31',
    authoritative: true, temporary: false, reviewNote: 'raise to 8 for winter shows',
  }, actor);
  assert.equal(edited.status, 'edited');
  assert.equal(edited.value, '8');
  assert.equal(edited.scope, 'venue');
  assert.equal(edited.effectiveFrom, '2026-01-01');
  assert.equal(edited.expiresAt, '2026-12-31');
  assert.equal(edited.authoritative, 'true');
});

test('accept promotes candidate to a VenueKnowledge rule with history', async () => {
  resetStore();
  for (let i = 0; i < 3; i++) {
    await learning.logCorrection(makeCorrection({ showId: 'show_' + i }), actor);
  }
  const { created } = await learning.scanForPatterns();
  const result = await learning.reviewCandidate(created[0].id, 'accept', {
    effectiveFrom: '2026-01-01', authoritative: true, temporary: false,
    reviewNote: 'confirmed venue default',
  }, actor);
  assert.equal(result.candidate.status, 'accepted');
  assert.ok(result.candidate.promotedKnowledgeId);
  assert.ok(result.promoted);
  assert.equal(result.promoted.kind, 'rule');
  assert.equal(result.promoted.category, 'labor');
  assert.equal(result.promoted.attributePath, 'labor.stagehand_count');
  assert.equal(result.promoted.status, 'active');
  assert.equal(String(result.promoted.value), '6');
  assert.equal(result.promoted.effectiveFrom, '2026-01-01');
  assert.equal(result.promoted.source, 'ai_learning');
  // Version history row must exist.
  assert.ok(store.get('VenueKnowledgeHistory').length > 0);
});

test('cannot re-review an already accepted candidate', async () => {
  resetStore();
  for (let i = 0; i < 3; i++) {
    await learning.logCorrection(makeCorrection({ showId: 'show_' + i }), actor);
  }
  const { created } = await learning.scanForPatterns();
  await learning.reviewCandidate(created[0].id, 'accept', { effectiveFrom: '2026-01-01' }, actor);
  await assert.rejects(
    () => learning.reviewCandidate(created[0].id, 'reject', {}, actor),
    /cannot review candidate/,
  );
});

test('listCandidates filters by status', async () => {
  resetStore();
  for (let i = 0; i < 3; i++) {
    await learning.logCorrection(makeCorrection({ showId: 'show_' + i }), actor);
  }
  const { created } = await learning.scanForPatterns();
  await learning.reviewCandidate(created[0].id, 'reject', {}, actor);
  const proposed = await learning.listCandidates({ status: 'proposed' });
  const rejected = await learning.listCandidates({ status: 'rejected' });
  assert.equal(proposed.length, 0);
  assert.equal(rejected.length, 1);
});

// ── Correction listing ────────────────────────────────────────────────────

test('listCorrections filters by showId and field', async () => {
  resetStore();
  await learning.logCorrection(makeCorrection({ showId: 'show_1', field: 'stagehand_count' }), actor);
  await learning.logCorrection(makeCorrection({ showId: 'show_2', field: 'meal_count' }), actor);
  await learning.logCorrection(makeCorrection({ showId: 'show_2', field: 'stagehand_count' }), actor);
  const forShow2 = await learning.listCorrections({ showId: 'show_2' });
  const forField = await learning.listCorrections({ field: 'meal_count' });
  assert.equal(forShow2.length, 2);
  assert.equal(forField.length, 1);
});
