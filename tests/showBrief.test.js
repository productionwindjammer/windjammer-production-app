'use strict';

/**
 * Show Brief tests.
 *
 * Locks in the 12 spec sections + source traceability contract:
 *   - Every non-empty section item carries at least one source (except
 *     MISSING INFORMATION, whose whole point is absence-of-source).
 *   - No item text carries chain-of-thought — only concise summary text
 *     and a source array.
 *   - Missing information is derived from industry standard requirements
 *     against the actual form state.
 *   - Conflicts surface both from advancement rules and from EmailFacts
 *     with conflicts arrays populated.
 *   - Proposed form updates carry preview data via factMapping.
 *   - Recommended actions are aggregated + tier-ordered.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

// ── In-memory sheets fake ──────────────────────────────────────────────────
const store = new Map();
function reset() {
  store.clear();
  store.set('Shows',              []);
  store.set('Advancing',          []);
  store.set('Schedule',           []);
  store.set('Labor',              []);
  store.set('VendorBookings',     []);
  store.set('EmailFacts',         []);
  store.set('EmailThreads',       []);
  store.set('EmailIssues',        []);
  store.set('VenueKnowledge',     []);
  store.set('VenueKnowledgeHistory', []);
  store.set('AiChangeLog',        []);
  store.set('AiCorrections',      []);
  store.set('ArtistDocuments',    []);
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

const showBrief = require('../showBrief');

// ── Fixture helpers ────────────────────────────────────────────────────────
function seedShow(over = {}) {
  const s = { id: 'show_1', date: '2026-11-01', artist: 'Fictional Artist', stage: 'inside',
              showTime: '20:00', doorsTime: '19:00', ...over };
  store.get('Shows').push(s);
  return s;
}
function seedAdvance(over = {}) {
  const a = { id: 'adv_1', showId: 'show_1',
              riderNotes: '', productionNeeds: '', backlineNotes: '',
              cateringNotes: '', hospitalityNotes: '', localCrewNeeds: '',
              stagingChanges: '', curfew: '', notes: '', ...over };
  store.get('Advancing').push(a);
  return a;
}
function seedFact(over = {}) {
  const f = { id: 'fact_1', showId: 'show_1', field: 'truck_count',
              kind: 'assertion', status: 'proposed',
              newValue: '4', previousValue: '', conflicts: '[]',
              senderName: 'Devon', senderEmail: 'dkim@tour.test',
              threadId: 'thread_1', sourceMessageId: 'msg_1',
              sourceExcerpt: 'four trucks on the roll',
              sourceDate: '2026-09-01T10:00:00Z',
              extractor: 'rules-v1', extractedAt: '2026-09-01T10:00:05Z',
              reasoningSummary: 'sender stated 4 trucks',
              ...over };
  store.get('EmailFacts').push(f);
  return f;
}
function seedChangeLog(over = {}) {
  const c = { id: 'chg_1', at: '2026-09-01T10:05:00Z', approvedBy: 'pm@example.test',
              factId: 'fact_1', showId: 'show_1', field: 'doors_time',
              previousValue: '19:00', newValue: '19:30',
              changeCategory: 'schedule', status: 'applied',
              sourceFrom: 'tour', sourceThreadId: 'thread_1', sourceExcerpt: 'doors at 7:30',
              reason: 'sender explicit', confidence: 'high',
              ...over };
  store.get('AiChangeLog').push(c);
  return c;
}

const now = '2026-09-02T00:00:00Z';

// ── Section presence & traceability ───────────────────────────────────────

test('buildBrief returns all 12 sections plus the AI show brief and readiness header', async () => {
  reset(); seedShow(); seedAdvance();
  const brief = await showBrief.buildBrief('show_1', { now });
  for (const key of [
    'aiShowBrief','whatChanged','needsAttention','conflicts','missingInformation',
    'waitingOn','recommendedActions','recentEmailIntel','proposedFormUpdates',
    'venueImpact','documents','advancementHistory','readiness','status',
  ]) {
    assert.ok(brief[key] !== undefined, 'missing section: ' + key);
  }
  assert.ok(brief.aiShowBrief.text.length > 0);
});

test('unknown showId rejects with not_found', async () => {
  reset();
  await assert.rejects(() => showBrief.buildBrief('nope', { now }), /show_not_found/);
});

// ── WHAT CHANGED ──────────────────────────────────────────────────────────

test('WHAT CHANGED surfaces AiChangeLog rows since the cutoff with source', async () => {
  reset(); seedShow(); seedAdvance();
  seedChangeLog();
  const brief = await showBrief.buildBrief('show_1', { now, since: '2026-08-01T00:00:00Z' });
  assert.ok(brief.whatChanged.length >= 1);
  const item = brief.whatChanged[0];
  assert.match(item.text, /Doors Time.*19:00.*→.*19:30/);
  assert.ok(item.sources.length >= 1);
  assert.equal(item.sources[0].kind, 'change');
  assert.equal(item.sources[0].threadId, 'thread_1');
  assert.match(item.sources[0].ref, /^\/email\?thread=/);
});

test('WHAT CHANGED omits AiChangeLog rows older than the cutoff', async () => {
  reset(); seedShow(); seedAdvance();
  seedChangeLog({ at: '2026-01-01T00:00:00Z' });
  const brief = await showBrief.buildBrief('show_1', { now, since: '2026-08-01T00:00:00Z' });
  assert.equal(brief.whatChanged.length, 0);
});

// ── MISSING INFORMATION ───────────────────────────────────────────────────

test('MISSING INFORMATION flags baseline advance fields that are empty', async () => {
  reset(); seedShow({ showTime: '', doorsTime: '' }); seedAdvance();
  const brief = await showBrief.buildBrief('show_1', { now });
  const keys = brief.missingInformation.map(i => i.key);
  for (const req of ['showTime','doorsTime','curfewTime','loadInTime']) {
    assert.ok(keys.includes(req), 'expected missing: ' + req);
  }
  // Missing items should carry NO source — they represent absence of evidence.
  assert.equal(brief.missingInformation[0].sources.length, 0);
});

test('MISSING INFORMATION drops items whose values are already on file', async () => {
  reset();
  seedShow({ showTime: '20:00', doorsTime: '19:00' });
  seedAdvance({ curfew: '23:00' });
  store.get('Schedule').push({ id: 'sch_1', showId: 'show_1', label: 'Load-In', time: '10:00' });
  store.get('Schedule').push({ id: 'sch_2', showId: 'show_1', label: 'Sound Check', time: '16:00' });
  store.get('Schedule').push({ id: 'sch_3', showId: 'show_1', label: 'Load-Out', time: '23:30' });
  const brief = await showBrief.buildBrief('show_1', { now });
  const keys = brief.missingInformation.map(i => i.key);
  for (const filled of ['showTime','doorsTime','curfewTime','loadInTime','soundcheckTime','loadOutTime']) {
    assert.ok(!keys.includes(filled), 'should not report as missing: ' + filled);
  }
});

// ── PROPOSED FORM UPDATES ─────────────────────────────────────────────────

test('PROPOSED FORM UPDATES lists pending EmailFacts with preview + source', async () => {
  reset(); seedShow(); seedAdvance();
  seedFact();
  const brief = await showBrief.buildBrief('show_1', { now });
  assert.equal(brief.proposedFormUpdates.length, 1);
  const p = brief.proposedFormUpdates[0];
  assert.equal(p.field, 'truck_count');
  assert.equal(p.proposed, '4');
  assert.ok(['low','high','unknown'].includes(p.risk));
  assert.equal(p.sources[0].kind, 'fact');
  assert.equal(p.sources[0].threadId, 'thread_1');
  // No chain-of-thought — a concise reason at most.
  assert.ok(!/\bchain[- ]of[- ]thought\b/i.test(p.reason || ''));
});

// ── CONFLICTS ─────────────────────────────────────────────────────────────

test('CONFLICTS surface EmailFacts with a non-empty conflicts array', async () => {
  reset(); seedShow(); seedAdvance();
  seedFact({
    id: 'fact_conflict', field: 'curfew_time', newValue: '22:00',
    conflicts: JSON.stringify([{ withValue: '23:00', critical: true }]),
  });
  const brief = await showBrief.buildBrief('show_1', { now });
  const item = brief.conflicts.find(c => c.id === 'fact:fact_conflict');
  assert.ok(item, 'expected conflict item');
  assert.match(item.text, /Conflicting information/i);
  assert.ok(item.sources.length >= 1);
});

// ── VENUE IMPACT ──────────────────────────────────────────────────────────

test('VENUE IMPACT returns unknown when no venue rule exists (never fabricates)', async () => {
  reset(); seedShow(); seedAdvance();
  seedFact({ id: 'fact_wl', field: 'wireless_channels', status: 'approved', newValue: '48' });
  const brief = await showBrief.buildBrief('show_1', { now });
  const wl = brief.venueImpact.find(v => v.title === 'Wireless channels');
  assert.ok(wl, 'expected venue impact entry');
  assert.equal(wl.known, false);
  assert.equal(wl.matches, 'unknown');
  assert.equal(wl.needsAction, true);
});

test('VENUE IMPACT reports mismatch when tour requests more than the venue rule allows', async () => {
  reset(); seedShow(); seedAdvance();
  store.get('VenueKnowledge').push({
    id: 'vk_motors', kind: 'rule', status: 'active',
    category: 'technical', subcategory: 'motors',
    attributePath: 'technical.motors.total', scope: 'venue', dataType: 'number',
    value: '12', unit: 'ct', confidence: '1',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  });
  seedFact({ id: 'fact_cm', field: 'chain_motor_count', status: 'approved', newValue: '24' });
  const brief = await showBrief.buildBrief('show_1', { now });
  const cm = brief.venueImpact.find(v => v.title === 'Chain motors');
  assert.ok(cm);
  assert.equal(cm.known, true);
  assert.notEqual(cm.matches, 'yes');
  assert.equal(cm.needsAction, true);
});

// ── DOCUMENTS ─────────────────────────────────────────────────────────────

test('DOCUMENTS marks each expected doc present or missing based on ArtistDocuments', async () => {
  reset(); seedShow(); seedAdvance();
  store.get('ArtistDocuments').push({
    id: 'doc_rider', showId: 'show_1', name: 'Technical Rider v2.pdf',
    category: 'rider', fileId: 'drive_1', uploadedAt: '2026-08-15T00:00:00Z',
  });
  const brief = await showBrief.buildBrief('show_1', { now });
  const rider = brief.documents.find(d => d.label === 'Technical rider');
  const plot  = brief.documents.find(d => d.label === 'Stage plot');
  assert.equal(rider.status, 'present');
  assert.equal(rider.sources[0].kind, 'document');
  assert.equal(rider.sources[0].id, 'doc_rider');
  assert.equal(plot.status, 'missing');
  assert.equal(plot.sources.length, 0);
});

// ── RECOMMENDED ACTIONS ───────────────────────────────────────────────────

test('RECOMMENDED ACTIONS aggregates missing/proposal/conflict counts with tiers', async () => {
  reset(); seedShow(); seedAdvance();
  seedFact();
  seedFact({ id: 'fact_conflict', field: 'curfew_time',
             conflicts: JSON.stringify([{ withValue: '23:00', critical: true }]) });
  const brief = await showBrief.buildBrief('show_1', { now });
  const texts = brief.recommendedActions.map(a => a.text).join('\n');
  assert.match(texts, /Review \d+ pending AI proposal/);
  assert.match(texts, /Resolve \d+ open conflict/);
  assert.match(texts, /Fill \d+ missing baseline field/);
  assert.ok(brief.recommendedActions.every(a => a.tier));
});

// ── AI SHOW BRIEF (summary text) ──────────────────────────────────────────

test('aiShowBrief is a concise, deterministic summary — no free-form generation', async () => {
  reset(); seedShow(); seedAdvance();
  seedFact();
  const brief = await showBrief.buildBrief('show_1', { now });
  assert.ok(brief.aiShowBrief.text.length < 500);
  // No chain-of-thought markers.
  assert.ok(!/let'?s|first,|step \d|thinking|reason(?:ing)?:/i.test(brief.aiShowBrief.text));
  assert.match(brief.aiShowBrief.text, /Fictional Artist/);
  assert.match(brief.aiShowBrief.text, /2026-11-01/);
});

// ── Source traceability ──────────────────────────────────────────────────

test('every source entry has a stable {kind,id} pair usable for drill-down', async () => {
  reset(); seedShow(); seedAdvance();
  seedFact();
  seedChangeLog();
  const brief = await showBrief.buildBrief('show_1', { now, since: '2026-08-01T00:00:00Z' });
  const gather = (items) => (items || []).flatMap(i => i.sources || []);
  const allSources = [
    ...gather(brief.whatChanged),
    ...gather(brief.needsAttention),
    ...gather(brief.conflicts),
    ...gather(brief.waitingOn),
    ...gather(brief.recentEmailIntel),
    ...gather(brief.proposedFormUpdates),
    ...gather(brief.venueImpact),
    ...gather(brief.documents.filter(d => d.status === 'present')),
    ...gather(brief.advancementHistory),
  ];
  assert.ok(allSources.length > 0);
  for (const s of allSources) {
    assert.ok(s.kind, 'source without kind: ' + JSON.stringify(s));
    assert.ok(s.id !== undefined, 'source without id: ' + JSON.stringify(s));
  }
});
