'use strict';

/**
 * Email Intelligence tests — realistic synthetic concert-production email
 * threads. These lock in the behavior contract:
 *
 *   • Threads are read as CONVERSATIONS, not isolated documents.
 *   • Later messages supersede earlier ones (previousValue is preserved).
 *   • Everything comes out as `proposed`; nothing overwrites show data.
 *   • Every fact carries provenance (message id, thread id, excerpt, extractor).
 *   • Show assignment refuses to guess when ambiguous.
 *   • Conflicts (vs current show data and vs venue capability) are detected.
 *
 * All sender emails, artist names, and companies below are SYNTHETIC.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

// ── In-memory sheets fake, shared with venueKnowledge ──────────────────────
const store = new Map();
function resetStore() {
  store.clear();
  store.set('VenueKnowledge', []);
  store.set('VenueKnowledgeHistory', []);
  store.set('EmailFacts', []);
  store.set('EmailThreads', []);
  store.set('EmailIssues', []);
}
const fakeSheets = {
  async getRows(name)               { return (store.get(name) || []).map(r => ({ ...r })); },
  async appendRow(name, row)        { if (!store.has(name)) store.set(name, []); store.get(name).push({ ...row }); },
  async appendRows(name, rows)      { for (const r of rows) await fakeSheets.appendRow(name, r); },
  async updateRowById(name, id, patch) {
    const rows = store.get(name) || [];
    const i = rows.findIndex(r => String(r.id) === String(id));
    if (i < 0) throw new Error('missing row ' + id);
    rows[i] = { ...rows[i], ...patch };
  },
  async deleteRowById(name, id)     { store.set(name, (store.get(name)||[]).filter(r => String(r.id)!==String(id))); },
  async ensureHeaders() {}, async ensureSheet() {},
};
const sheetsPath = path.resolve(__dirname, '..', 'sheets.js');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

const emailIntel     = require('../emailIntelligence');
const venueKnowledge = require('../venueKnowledge');

// ── Synthetic corpus helpers ───────────────────────────────────────────────
const THREAD = 'thread_TEST_001';
let msgCounter = 0;
function msg(overrides) {
  msgCounter += 1;
  return {
    id:        `msg_${msgCounter}`,
    threadId:  THREAD,
    from:      'Jamie Rivera <jrivera@example-tourco.test>',
    fromName:  'Jamie Rivera',
    subject:   'Test Show — advance',
    date:      `2026-09-0${msgCounter}T10:00:00Z`,
    body:      '',
    ...overrides,
  };
}
function resetCounter() { msgCounter = 0; }

const SHOW = { id: 'show_1', name: 'Fictional Fest 2026', artist: 'The Northern Lights', date: '2026-09-15' };

// ─────────────────────────────────────────────────────────────────────────
// 1. The exact scenario from the spec: "Actually, make that 4 trucks."
// ─────────────────────────────────────────────────────────────────────────
test('supersedes truck count when sender writes "actually, make that 4 trucks"', async () => {
  resetStore(); resetCounter();
  const m1 = msg({
    from: 'Devon Kim <dkim@example-tourco.test>', fromName: 'Devon Kim',
    body: 'Hi team — we\'ll be rolling in with 3 trucks and 2 buses for load-in Wednesday. Thanks. — Devon Kim, Tour Manager',
  });
  const m2 = msg({
    from: 'Devon Kim <dkim@example-tourco.test>', fromName: 'Devon Kim',
    body: 'Actually, make that 4 trucks. Buses unchanged.',
  });

  const analysis = await emailIntel.analyzeThread({ messages: [m1, m2], shows: [SHOW] });

  const truck = analysis.facts.find(f => f.field === 'truck_count');
  assert.ok(truck, 'must extract a truck_count fact');
  assert.equal(truck.previousValue, 3);
  assert.equal(truck.newValue, 4);
  assert.equal(truck.status, 'proposed', 'facts must never be auto-applied');
  assert.equal(truck.kind, 'correction');
  assert.ok(truck.confidence >= 0.85, 'explicit correction should be high-confidence');
  assert.match(truck.reasoningSummary, /correct|superseding|restated/i);
  assert.ok(truck.reasoningSummary.length < 240, 'reasoning summary must be concise');
  // Provenance is required.
  assert.equal(truck.provenance.sourceMessageId, m2.id);
  assert.equal(truck.provenance.sourceThreadId, THREAD);
  assert.match(truck.provenance.sourceExcerpt, /make that 4 trucks/i);
  assert.ok(truck.provenance.extractor);
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Load-in change (schedule time supersession)
// ─────────────────────────────────────────────────────────────────────────
test('load-in time correction supersedes prior time', async () => {
  resetStore(); resetCounter();
  const m1 = msg({ body: 'Confirming load-in at 8:00 AM Wednesday. — Jamie Rivera, Tour Manager' });
  const m2 = msg({ body: 'Correction: load-in needs to push to 9:30 AM. Sound check at 4pm.' });

  const analysis = await emailIntel.analyzeThread({ messages: [m1, m2], shows: [SHOW] });

  const loadin = analysis.facts.find(f => f.field === 'loadin_time');
  const sc     = analysis.facts.find(f => f.field === 'soundcheck_time');
  assert.equal(loadin.previousValue, '08:00');
  assert.equal(loadin.newValue,      '09:30');
  assert.equal(loadin.status,        'proposed');
  assert.equal(sc.newValue,          '16:00');
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Labor request — recognized as request, not confirmation
// ─────────────────────────────────────────────────────────────────────────
test('labor request classified as request intent with count value', async () => {
  resetStore(); resetCounter();
  const m1 = msg({
    from: 'Sam Torres <storres@example-tourco.test>',
    body: 'Please book 8 stagehands and 4 riggers for our load-in. Thanks. — Sam Torres, Production Manager',
  });
  const analysis = await emailIntel.analyzeThread({ messages: [m1], shows: [SHOW] });
  const hands   = analysis.facts.find(f => f.field === 'stagehand_count');
  const riggers = analysis.facts.find(f => f.field === 'rigger_count');
  assert.equal(hands.newValue,   8);
  assert.equal(riggers.newValue, 4);
  assert.equal(hands.kind,   'request');
  assert.equal(riggers.kind, 'request');
  assert.ok(analysis.perMessage[0].intents.includes('request'));
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Catering change
// ─────────────────────────────────────────────────────────────────────────
test('catering: dinner count is updated when sender says "bump dinner to 90"', async () => {
  resetStore(); resetCounter();
  const m1 = msg({ body: 'Catering: 75 dinners at 5pm, 40 lunches at noon.' });
  const m2 = msg({ body: 'Update: bump dinner to 90.' });

  const analysis = await emailIntel.analyzeThread({ messages: [m1, m2], shows: [SHOW] });
  const dinner = analysis.facts.find(f => f.field === 'dinner_count');
  const lunch  = analysis.facts.find(f => f.field === 'lunch_count');
  assert.equal(dinner.previousValue, 75);
  assert.equal(dinner.newValue,      90);
  assert.ok(['change','correction'].includes(dinner.kind), `expected change or correction, got ${dinner.kind}`);
  assert.equal(lunch.newValue,       40, 'lunch value should carry forward untouched');
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Audio / lighting / RF requirements — technical extractions
// ─────────────────────────────────────────────────────────────────────────
test('audio, lighting, RF and motor counts extracted from technical rider email', async () => {
  resetStore(); resetCounter();
  const m1 = msg({
    from: 'Alex Chen <achen@example-tourco.test>',
    body: `Tech rider highlights:
- 12 line array boxes per side
- 16 subs
- 24 wireless channels
- 32 moving lights
- 12 chain motors
Please confirm.
— Alex Chen, Production Manager`,
  });
  const analysis = await emailIntel.analyzeThread({ messages: [m1], shows: [SHOW] });
  const byField = Object.fromEntries(analysis.facts.map(f => [f.field, f]));
  assert.equal(byField.line_array_boxes.newValue,  12);
  assert.equal(byField.subwoofer_count.newValue,   16);
  assert.equal(byField.wireless_channels.newValue, 24);
  assert.equal(byField.moving_light_count.newValue,32);
  assert.equal(byField.chain_motor_count.newValue, 12);
  // RF and motors are safety/critical categories.
  assert.equal(byField.wireless_channels.criticality, 'critical');
  assert.equal(byField.chain_motor_count.criticality, 'critical');
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Hospitality, transportation, parking, credentials
// ─────────────────────────────────────────────────────────────────────────
test('hospitality, parking, and credential requests are extracted with category tags', async () => {
  resetStore(); resetCounter();
  const m1 = msg({
    body: `Hospitality: 6 dressing rooms, 4 showers. Transportation: 2 sprinter vans for airport. Parking: 3 bus parking spots overnight. Credentials: 45 all-access passes.`,
  });
  const a = await emailIntel.analyzeThread({ messages: [m1], shows: [SHOW] });
  const map = Object.fromEntries(a.facts.map(f => [f.field, f]));
  assert.equal(map.dressing_room_count.newValue, 6);
  assert.equal(map.shower_count.newValue, 4);
  assert.equal(map.van_count.newValue, 2);
  assert.equal(map.parking_spaces.newValue, 3);
  assert.equal(map.credential_count.newValue, 45);
  // Category routing is correct so the review UI can group these.
  assert.equal(map.credential_count.category, 'credentials');
  assert.equal(map.parking_spaces.category,   'parking');
});

// ─────────────────────────────────────────────────────────────────────────
// 7. Conflicting information: two senders disagree in the same thread
// ─────────────────────────────────────────────────────────────────────────
test('detects supersession within thread; last message wins with prior recorded', async () => {
  resetStore(); resetCounter();
  const m1 = msg({
    from: 'Tour <tm@example-tourco.test>', fromName: 'Devon',
    body: 'We need 6 stagehands for load-in.',
  });
  const m2 = msg({
    from: 'Promoter <promoter@example-promo.test>', fromName: 'Sasha',
    body: 'Actually we need 10 stagehands.',
  });
  const a = await emailIntel.analyzeThread({ messages: [m1, m2], shows: [SHOW] });
  const hands = a.facts.find(f => f.field === 'stagehand_count');
  assert.equal(hands.previousValue, 6);
  assert.equal(hands.newValue,      10);
  assert.equal(hands.status,        'proposed');
});

// ─────────────────────────────────────────────────────────────────────────
// 8. Conflict vs current authoritative show data
// ─────────────────────────────────────────────────────────────────────────
test('conflict is flagged when proposed value differs from authoritative show data', async () => {
  resetStore(); resetCounter();
  const m1 = msg({ body: 'Load-in at 10 AM.' });
  const a = await emailIntel.analyzeThread({
    messages: [m1], shows: [SHOW],
    existingShowData: { schedule: { loadIn: '08:00' } },
  });
  const loadin = a.facts.find(f => f.field === 'loadin_time');
  const conf   = loadin.conflicts.find(c => c.kind === 'authoritative_show_data');
  assert.ok(conf, 'should raise conflict against current schedule');
  assert.equal(conf.current, '08:00');
  assert.equal(conf.proposed, '10:00');
  assert.equal(loadin.recommendedAction, 'review_conflict_with_current_show');
});

// ─────────────────────────────────────────────────────────────────────────
// 9. Conflict vs venue capability (RF exceeds venue's channel count)
// ─────────────────────────────────────────────────────────────────────────
test('conflict is flagged when request exceeds venue capability', async () => {
  resetStore(); resetCounter();
  // Seed a venue rule.
  await venueKnowledge.createItem({
    kind: 'rule', category: 'technical', subcategory: 'rf',
    attributePath: 'technical.rf.available_channels',
    scope: 'venue', dataType: 'number', value: 16, source: 'manual',
  }, 'user:seed');

  const m1 = msg({ body: 'We need 24 wireless channels for this show.' });
  const a = await emailIntel.analyzeThread({ messages: [m1], shows: [SHOW] });
  const rf = a.facts.find(f => f.field === 'wireless_channels');
  const conf = rf.conflicts.find(c => c.kind === 'venue_capability');
  assert.ok(conf, 'should raise venue capability conflict');
  assert.equal(conf.matches, 'no');
  assert.equal(conf.critical, true, 'RF is safety-critical');
  assert.equal(rf.recommendedAction, 'escalate_to_admin');
});

// ─────────────────────────────────────────────────────────────────────────
// 10. Unknown-safety-critical still surfaces conflict as unknown
// ─────────────────────────────────────────────────────────────────────────
test('safety-critical unknown venue capability is flagged rather than silently accepted', async () => {
  resetStore(); resetCounter();
  const m1 = msg({ body: 'We\'ll need pyrotechnics during the encore.' });
  const a = await emailIntel.analyzeThread({ messages: [m1], shows: [SHOW] });
  const pyro = a.facts.find(f => f.field === 'pyro_requested');
  assert.ok(pyro, 'must extract pyro request');
  assert.equal(pyro.newValue, true);
  const conf = pyro.conflicts.find(c => c.kind === 'venue_capability_unknown');
  assert.ok(conf, 'unknown safety-critical capability must be surfaced');
  assert.equal(conf.critical, true);
});

// ─────────────────────────────────────────────────────────────────────────
// 11. Deadline detection ("please confirm by Friday EOD")
// ─────────────────────────────────────────────────────────────────────────
test('detects deadlines and questions as thread issues', async () => {
  resetStore(); resetCounter();
  const m1 = msg({ body: 'Please confirm final catering counts by Friday EOD. Also, is the loading dock open at 6 AM?' });
  const a = await emailIntel.analyzeThread({ messages: [m1], shows: [SHOW] });
  assert.ok(a.issues.some(i => i.kind === 'deadline'),  'must detect deadline');
  assert.ok(a.issues.some(i => i.kind === 'question'),  'must detect question');
  assert.ok(a.perMessage[0].intents.includes('deadline'));
  assert.ok(a.perMessage[0].intents.includes('question'));
});

// ─────────────────────────────────────────────────────────────────────────
// 12. Show assignment: refuses to guess when ambiguous
// ─────────────────────────────────────────────────────────────────────────
test('show assignment is null (not guessed) when there is no clear signal', async () => {
  resetStore(); resetCounter();
  const shows = [
    { id: 'a', name: 'Show A', artist: 'Band A', date: '2026-09-15' },
    { id: 'b', name: 'Show B', artist: 'Band B', date: '2026-09-20' },
  ];
  const m1 = msg({ subject: 'quick advance question', body: 'What time is load-in?' });
  const a = await emailIntel.analyzeThread({ messages: [m1], shows });
  assert.equal(a.showAssignment.showId, null);
  assert.match(a.showAssignment.reason, /no_show_signals|ambiguous/);
});

// ─────────────────────────────────────────────────────────────────────────
// 13. Show assignment: clear signal (artist name in subject)
// ─────────────────────────────────────────────────────────────────────────
test('show assignment succeeds when artist name is present', async () => {
  resetStore(); resetCounter();
  const shows = [
    { id: 'a', name: 'Fictional Fest', artist: 'The Northern Lights', date: '2026-09-15' },
    { id: 'b', name: 'Other Show',      artist: 'Different Band',      date: '2026-09-20' },
  ];
  const m1 = msg({ subject: 'The Northern Lights — advance', body: 'Load-in at 9 AM on September 15.' });
  const a = await emailIntel.analyzeThread({ messages: [m1], shows });
  assert.equal(a.showAssignment.showId, 'a');
  assert.ok(a.showAssignment.confidence >= 0.7);
});

// ─────────────────────────────────────────────────────────────────────────
// 14. Extraction never overwrites — everything goes through proposed state
// ─────────────────────────────────────────────────────────────────────────
test('proposeFromAnalysis writes facts as proposed and never mutates authoritative sheets', async () => {
  resetStore(); resetCounter();
  const m1 = msg({ body: 'Adding 3 trucks and 2 buses.' });
  const analysis = await emailIntel.analyzeThread({ messages: [m1], shows: [SHOW] });
  const res = await emailIntel.proposeFromAnalysis(analysis, { actor: 'user:tester' });
  assert.equal(res.facts.length >= 2, true);
  const allProposed = (store.get('EmailFacts') || []).every(f => f.status === 'proposed');
  assert.equal(allProposed, true);
});

// ─────────────────────────────────────────────────────────────────────────
// 15. Approve/reject workflow
// ─────────────────────────────────────────────────────────────────────────
test('approve/reject transitions and supersedes prior approved facts on same slot', async () => {
  resetStore(); resetCounter();
  const first = msg({ body: '3 trucks confirmed.' });
  const a1 = await emailIntel.analyzeThread({ messages: [first], shows: [SHOW] });
  a1.showAssignment = { showId: SHOW.id, confidence: 1, reason: 'test_override', alternatives: [] };
  const w1 = await emailIntel.proposeFromAnalysis(a1, { actor: 'user:tester' });
  const truckFact1 = w1.facts.find(f => f.field === 'truck_count');
  const approved1  = await emailIntel.approveFact(truckFact1.id, 'user:pm');
  assert.equal(approved1.status, 'approved');

  // A later thread bumps trucks — the newly-approved fact should supersede the first.
  msgCounter = 5;
  const second = msg({ threadId: 'thread_TEST_002', body: 'Bumped to 5 trucks total.' });
  const a2 = await emailIntel.analyzeThread({ messages: [second], shows: [SHOW] });
  // Force showId on the second so both facts land on the same slot.
  a2.showAssignment = { showId: SHOW.id, confidence: 1, reason: 'test_override', alternatives: [] };
  const w2 = await emailIntel.proposeFromAnalysis(a2, { actor: 'user:tester' });
  const truckFact2 = w2.facts.find(f => f.field === 'truck_count');
  await emailIntel.approveFact(truckFact2.id, 'user:pm');

  const finalRows = store.get('EmailFacts');
  const first_    = finalRows.find(r => r.id === truckFact1.id);
  const second_   = finalRows.find(r => r.id === truckFact2.id);
  assert.equal(first_.status,        'superseded');
  assert.equal(first_.supersededBy,  truckFact2.id);
  assert.equal(second_.status,       'approved');
});

// ─────────────────────────────────────────────────────────────────────────
// 16. Cannot approve or reject something that is not proposed
// ─────────────────────────────────────────────────────────────────────────
test('approve/reject reject non-proposed facts', async () => {
  resetStore(); resetCounter();
  const m1 = msg({ body: '3 trucks.' });
  const a = await emailIntel.analyzeThread({ messages: [m1], shows: [SHOW] });
  const w = await emailIntel.proposeFromAnalysis(a, { actor: 'user:t' });
  const id = w.facts[0].id;
  await emailIntel.approveFact(id, 'user:pm');
  await assert.rejects(() => emailIntel.approveFact(id, 'user:pm'), /status/);
  await assert.rejects(() => emailIntel.rejectFact(id, 'user:pm'),  /status/);
});

// ─────────────────────────────────────────────────────────────────────────
// 17. Sender role is inferred from signature block
// ─────────────────────────────────────────────────────────────────────────
test('sender role hint is picked up from signature keywords', async () => {
  resetStore(); resetCounter();
  const m1 = msg({
    from: 'Pat Nguyen <pat@example-tourco.test>',
    body: 'Hi — please confirm parking for 2 buses.\n\nThanks,\nPat Nguyen\nTour Manager, Northern Lights Tour',
  });
  const a = await emailIntel.analyzeThread({ messages: [m1], shows: [SHOW] });
  assert.equal(a.perMessage[0].sender.role, 'tour_manager');
});

// ─────────────────────────────────────────────────────────────────────────
// 18. Concise reasoning; no chain-of-thought
// ─────────────────────────────────────────────────────────────────────────
test('reasoning summary is a single concise line and never a chain-of-thought dump', async () => {
  resetStore(); resetCounter();
  const m1 = msg({ body: 'Actually make that 4 trucks.' });
  const a = await emailIntel.analyzeThread({ messages: [m1], shows: [SHOW] });
  const f = a.facts.find(x => x.field === 'truck_count');
  assert.ok(f.reasoningSummary.length < 240, 'reasoning must be short');
  assert.ok(!f.reasoningSummary.includes('\n'), 'reasoning must be a single line');
  // No hidden chain-of-thought keys.
  assert.equal(f.chainOfThought, undefined);
  assert.equal(f.thoughts,       undefined);
});
