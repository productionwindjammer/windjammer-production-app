'use strict';

/**
 * Show Advancement Intelligence tests — multi-show diversity.
 *
 * Locks in the contract:
 *   • Advancement is NOT a percentage. Status reflects unresolved risk.
 *   • Requirements are dynamic. An acoustic show does NOT inherit an arena
 *     rigging/RF/pyro/truck checklist just because those rules exist.
 *   • Every applied requirement carries a WHY (explanation).
 *   • Safety-critical unknown venue capability is a RISK, not a pass.
 *   • Populating many fields does NOT get you to 'advanced' while critical
 *     items are unresolved.
 *
 * All artist / promoter / venue names below are SYNTHETIC.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../advancementEngine');

// ── Fixture helpers ────────────────────────────────────────────────────────
function baseShow(over = {}) {
  return { id: 'show_test', date: '2026-11-01', artist: 'Fictional Artist', stage: 'inside',
           showTime: '20:00', doorsTime: '19:00', promoter: 'Synthetic Promo Co', tourManager: 'Alex Doe', ...over };
}
function baseAdvance(over = {}) {
  return { id: 'adv_test', showId: 'show_test', stage: 'inside',
           advanceContact: 'Alex Doe', advanceEmail: 'ad@example.test', advancePhone: '555-0001',
           curfew: '23:30', riderNotes: '', productionNeeds: '', backlineNotes: '',
           cateringNotes: '', hospitalityNotes: '', localCrewNeeds: '',
           soundRestrictions: '', stagingChanges: '', notes: '', ...over };
}
function baseState(over = {}) {
  return {
    show:       baseShow(over.show),
    advance:    over.advance === null ? null : baseAdvance(over.advance),
    schedule:   over.schedule   || [{ id:'s1', showId:'show_test', label:'Load-in', time:'08:00' }],
    labor:      over.labor      || [{ id:'l1', showId:'show_test', role:'Stagehand', workerName:'Hand 1' }],
    vendorBookings: over.vendorBookings || [],
    approvedFacts:  over.approvedFacts  || [],
    pendingFacts:   over.pendingFacts   || [],
    recentFacts:    over.recentFacts    || [],
    emailIssues:    over.emailIssues    || [],
    venueRules:     over.venueRules     || [],
    now:            over.now || '2026-10-20T12:00:00Z',
  };
}

const findRule = (result, id) => [...result.confirmed, ...result.open, ...result.missing, ...result.conflicts, ...result.risks].find(r => r.id === id);

// ─────────────────────────────────────────────────────────────────────────
// 1. Acoustic gig — NOT an arena. Should NOT trigger rigging, RF, truck, pyro.
// ─────────────────────────────────────────────────────────────────────────
test('acoustic show does not inherit arena-scale requirements', async () => {
  const state = baseState({
    advance: { riderNotes: 'Solo acoustic. Self-contained. Just DI + a vocal mic.', localCrewNeeds: 'no local crew needed' },
  });
  const r = await engine.evaluate(state);
  // No arena-cluster rules should be applied.
  const anyRigging = r.appliedRuleCount && Object.values(r.priorities).flat().concat(r.confirmed).some(x => x.id.startsWith('rigging.'));
  const anyTrucks  = Object.values(r.priorities).flat().concat(r.confirmed).some(x => x.id.startsWith('trucks.'));
  const anyRf      = Object.values(r.priorities).flat().concat(r.confirmed).some(x => x.id.startsWith('rf.'));
  const anyPyro    = Object.values(r.priorities).flat().concat(r.confirmed).some(x => x.id.startsWith('pyro.'));
  const anyHands   = Object.values(r.priorities).flat().concat(r.confirmed).some(x => x.id === 'crew.local_hands_booked');
  assert.equal(anyRigging, false, 'rigging cluster should not apply to acoustic gig');
  assert.equal(anyTrucks,  false, 'truck cluster should not apply to acoustic gig');
  assert.equal(anyRf,      false, 'RF cluster should not apply to acoustic gig');
  assert.equal(anyPyro,    false, 'pyro cluster should not apply to acoustic gig');
  assert.equal(anyHands,   false, 'hands rule should skip self-contained acoustic');
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Arena-tour rider — SHOULD trigger rigging, RF, trucks, hands.
// ─────────────────────────────────────────────────────────────────────────
test('arena-scale rider triggers rigging + RF + trucks + hands clusters', async () => {
  const state = baseState({
    advance: {
      riderNotes: 'Full rigging: 12 chain motors, 6 hang points, approximately 12000 lbs total. 24 wireless channels for IEMs and vocals. Rolling in with 4 trucks and 2 buses.',
      productionNeeds: 'Moving lights (32 movers), 400A three-phase service.',
    },
  });
  const r = await engine.evaluate(state);
  const ids = Object.values(r.priorities).flat().concat(r.confirmed).map(x => x.id);
  assert.ok(ids.some(i => i.startsWith('rigging.')), 'rigging cluster should apply');
  assert.ok(ids.some(i => i.startsWith('trucks.')),  'truck cluster should apply');
  assert.ok(ids.some(i => i.startsWith('rf.')),      'RF cluster should apply');
  assert.ok(ids.includes('crew.local_hands_booked'), 'hands rule should apply');
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Every applied rule carries an explanation (WHY it applies).
// ─────────────────────────────────────────────────────────────────────────
test('every applied rule carries a WHY explanation', async () => {
  const state = baseState({
    advance: { riderNotes: 'Rigging with chain motors. Wireless mics.' },
  });
  const r = await engine.evaluate(state);
  const all = Object.values(r.priorities).flat().concat(r.confirmed, r.risks);
  assert.ok(all.length > 0);
  for (const rule of all) {
    assert.ok(rule.explanation && rule.explanation.length > 0, `rule ${rule.id} missing explanation`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Populating many fields does NOT clear a CRITICAL unresolved item.
//    (Rigging plot missing → status must be 'blocked' regardless.)
// ─────────────────────────────────────────────────────────────────────────
test('lots of populated fields cannot mask a missing critical rigging plot', async () => {
  const state = baseState({
    advance: {
      riderNotes: 'Full rigging: 8 chain motors. Plot forthcoming.',
      productionNeeds: 'FOH DiGiCo. Backline provided. Full tech pack attached.',
      backlineNotes: 'Full backline provided by venue.',
      cateringNotes: 'Vegan dinner for 30 at 5pm.',
      hospitalityNotes: 'Green room ready, towels, showers.',
      soundRestrictions: '100 dB at FOH',
      stagingChanges: 'None.',
      localCrewNeeds: '8 hands, 4 loaders.',
    },
    labor: [
      { role: 'Stagehand' }, { role: 'Stagehand' }, { role: 'Rigger' },
    ],
  });
  const r = await engine.evaluate(state);
  assert.equal(r.status, 'blocked', 'must be blocked while any critical item is unresolved');
  assert.ok(r.priorities.critical.length > 0);
  assert.ok(r.priorities.critical.some(p => p.id === 'rigging.plot_present'));
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Prioritization: rigging shortfall > load-in time change > catering count.
// ─────────────────────────────────────────────────────────────────────────
test('prioritization: safety-critical outranks scheduling outranks meal counts', async () => {
  const state = baseState({
    advance: {
      riderNotes: 'Full rigging setup.', // triggers critical rigging rules
      cateringNotes: 'Dinner needed.',   // triggers medium catering rules
    },
  });
  const r = await engine.evaluate(state);
  assert.ok(r.priorities.critical.length > 0, 'critical bucket populated');
  // First recommendation should be a critical one.
  assert.ok(r.recommendedActions.length > 0);
  assert.equal(r.recommendedActions[0].tier, 'critical');
});

// ─────────────────────────────────────────────────────────────────────────
// 6. RF requested but venue has fewer channels → CONFLICT + escalate.
// ─────────────────────────────────────────────────────────────────────────
test('RF exceeds venue capability is flagged as conflict and escalated', async () => {
  const state = baseState({
    advance: { riderNotes: '24 wireless channels needed.' },
    approvedFacts: [
      { field: 'wireless_channels', newValue: 24, status: 'approved' },
    ],
    venueRules: [
      { attributePath: 'technical.rf.available_channels', value: 16, kind: 'rule', status: 'active' },
    ],
  });
  const r = await engine.evaluate(state);
  const rf = findRule(r, 'rf.frequency_coordinated');
  assert.ok(rf);
  assert.equal(rf.status, 'conflict');
  assert.match(rf.action, /escalate/i);
});

// ─────────────────────────────────────────────────────────────────────────
// 7. Safety-critical unknown venue capability is a RISK, not a pass.
// ─────────────────────────────────────────────────────────────────────────
test('unknown safety-critical venue capability shows as risk', async () => {
  const state = baseState({
    advance: { riderNotes: 'Pyro during encore, CO2 jets.' },
    // No venue rules loaded — pyro rule for the venue is unknown.
  });
  const r = await engine.evaluate(state);
  const pyro = findRule(r, 'pyro.permit_verified');
  assert.ok(pyro);
  assert.equal(pyro.status, 'risk');
  assert.match(pyro.reason, /not on file/i);
});

// ─────────────────────────────────────────────────────────────────────────
// 8. Load-in time missing → HIGH priority, status in_progress.
// ─────────────────────────────────────────────────────────────────────────
test('missing load-in time surfaces as high-priority when nothing critical is open', async () => {
  const state = baseState({
    advance: { curfew: '23:30' },
    schedule: [{ id:'s1', showId:'show_test', label:'Load-in' /* no time */ }],
  });
  const r = await engine.evaluate(state);
  const loadin = findRule(r, 'baseline.load_in_scheduled');
  assert.ok(loadin);
  assert.equal(loadin.status, 'open');
  assert.equal(loadin.tier,   'high');
});

// ─────────────────────────────────────────────────────────────────────────
// 9. Baseline missing tour contact → visible as missing, not "advanced".
// ─────────────────────────────────────────────────────────────────────────
test('missing tour contact prevents "advanced" status', async () => {
  const state = baseState({
    advance: { advanceContact: '', advanceEmail: '', advancePhone: '' },
    show:    { tourManager: '' },
  });
  const r = await engine.evaluate(state);
  const tc = findRule(r, 'baseline.tour_contact');
  assert.equal(tc.status, 'missing');
  assert.notEqual(r.status, 'advanced');
});

// ─────────────────────────────────────────────────────────────────────────
// 10. Fully-populated small show → CAN reach 'advanced' (with no arena stuff).
// ─────────────────────────────────────────────────────────────────────────
test('a small well-advanced show reaches "advanced" status', async () => {
  const state = baseState({
    advance: {
      curfew: '23:30',
      soundRestrictions: '100 dB',
      // No rigging / RF / truck / pyro / catering / lighting signals → those clusters skip.
    },
    schedule: [
      { id:'s1', showId:'show_test', label:'Load-in',   time:'14:00' },
      { id:'s2', showId:'show_test', label:'Soundcheck', time:'17:00' },
    ],
    labor: [
      { role: 'Stagehand' }, { role: 'Stagehand' }, { role: 'Stagehand' }, { role: 'Stagehand' },
    ],
  });
  const r = await engine.evaluate(state);
  assert.equal(r.status, 'advanced', `expected advanced; got ${r.status}. critical:${r.priorities.critical.length} high:${r.priorities.high.length}`);
});

// ─────────────────────────────────────────────────────────────────────────
// 11. Proposed (unapproved) email facts appear on "waiting on" but don't
//     resolve rules — you can't get around approval.
// ─────────────────────────────────────────────────────────────────────────
test('proposed email facts appear on waiting-on and do not resolve rules', async () => {
  const state = baseState({
    advance: { riderNotes: 'Full rigging setup.' },
    pendingFacts: [
      { field: 'rigger_count', newValue: 4, status: 'proposed', senderEmail: 'x@y.test', threadId: 't1' },
    ],
  });
  const r = await engine.evaluate(state);
  assert.ok(r.waitingOn.some(w => w.kind === 'email_fact' && w.field === 'rigger_count'));
  // Rigging cluster should still be unresolved (no riggers on labor call).
  const bookRule = findRule(r, 'rigging.qualified_rigger_booked');
  assert.equal(bookRule.status, 'missing');
});

// ─────────────────────────────────────────────────────────────────────────
// 12. Recent changes and deadlines are surfaced.
// ─────────────────────────────────────────────────────────────────────────
test('recent changes and deadlines are surfaced on the state', async () => {
  const state = baseState({
    recentFacts: [
      { field: 'loadin_time', previousValue: '08:00', newValue: '06:00', kind: 'change',
        sourceDate: '2026-10-19T10:00:00Z', senderName: 'Tour', reasoningSummary: 'Tour moved load-in earlier.' },
    ],
    emailIssues: [
      { kind: 'deadline', excerpt: 'Please confirm catering counts by Friday.', from: 'promoter@x.test', date: '2026-10-19', threadId: 't1' },
    ],
  });
  const r = await engine.evaluate(state);
  assert.equal(r.recentChanges.length, 1);
  assert.equal(r.recentChanges[0].field, 'loadin_time');
  assert.equal(r.upcomingDeadlines.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────
// 13. Catering signal from advance prose triggers all catering rules.
// ─────────────────────────────────────────────────────────────────────────
test('catering cluster triggers only when catering is required', async () => {
  const withCatering = await engine.evaluate(baseState({
    advance: { cateringNotes: 'Dinner for 40 at 5pm. Some vegan.' },
  }));
  const noCatering   = await engine.evaluate(baseState({
    advance: { cateringNotes: '' },
  }));
  const hasClusterA = Object.values(withCatering.priorities).flat().concat(withCatering.confirmed).some(x => x.id.startsWith('catering.'));
  const hasClusterB = Object.values(noCatering.priorities).flat().concat(noCatering.confirmed).some(x => x.id.startsWith('catering.'));
  assert.equal(hasClusterA, true);
  assert.equal(hasClusterB, false);
});

// ─────────────────────────────────────────────────────────────────────────
// 14. Missing advance record entirely → CRITICAL missing.
// ─────────────────────────────────────────────────────────────────────────
test('no advance record at all → blocked with critical missing', async () => {
  const state = baseState({ advance: null });
  const r = await engine.evaluate(state);
  assert.equal(r.status, 'blocked');
  assert.ok(r.missing.some(x => x.id === 'baseline.advance_record_exists'));
});

// ─────────────────────────────────────────────────────────────────────────
// 15. Readiness is multi-dimensional, not a single percentage.
// ─────────────────────────────────────────────────────────────────────────
test('readiness is bucketed by tier, not a single percentage', async () => {
  const r = await engine.evaluate(baseState({ advance: { riderNotes: 'Rigging setup, 24 wireless.' } }));
  assert.ok(r.readiness.critical);
  assert.ok(r.readiness.high);
  assert.ok(r.readiness.medium);
  assert.ok(r.readiness.low);
  assert.equal(r.percentComplete, undefined, 'engine must not expose a naive percentComplete');
});

// ─────────────────────────────────────────────────────────────────────────
// 16. Power exceeds venue capacity → conflict.
// ─────────────────────────────────────────────────────────────────────────
test('power draw exceeding venue capacity is a critical conflict', async () => {
  const state = baseState({
    advance: { riderNotes: 'Need 800A three-phase service.' },
    approvedFacts: [{ field: 'power_amps', newValue: 800, status: 'approved' }],
    venueRules: [{ attributePath: 'technical.power.stage_amps', value: 400, kind: 'rule', status: 'active' }],
  });
  const r = await engine.evaluate(state);
  const p = findRule(r, 'power.within_capacity');
  assert.equal(p.status, 'conflict');
  assert.match(p.action, /escalate/i);
});
