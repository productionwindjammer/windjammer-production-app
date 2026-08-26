'use strict';

/**
 * Industry Knowledge Layer tests.
 *
 * Locks in:
 *   - Precedence: show_specific > user_instructed > venue_policy >
 *     historical_observation > industry_standard > unknown.
 *   - Ambiguous acronyms (PM, TM, plot, rider, push) are never
 *     auto-normalized without context.
 *   - Safe synonyms (load-in / load in / loadin) DO normalize.
 *   - User rules override industry standard for term disambiguation.
 *   - mergedView flags conflicts between authoritative tiers.
 *   - Unknown stays unknown — no fabrication.
 *   - Variability is exposed for domain areas where practice differs.
 *   - User rule CRUD reaches the UserOntologyRules sheet.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

// ── In-memory sheets fake ──────────────────────────────────────────────────
const store = new Map();
function resetStore() {
  store.clear();
  store.set('UserOntologyRules', []);
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

const industry = require('../industryKnowledge');

// ── Ontology surface ──────────────────────────────────────────────────────

test('lists all domains from the ontology', () => {
  const domains = industry.listDomains().map(d => d.id);
  for (const req of [
    'show_advancement','production','tour_management','production_management',
    'venue_management','promoters','booking','agencies','artist_management',
    'technical_production','audio','lighting','video','rigging','stage_management',
    'backline','rf','power','labor','stagehands','security','hospitality','catering',
    'transportation','trucking','buses','parking','credentials','dressing_rooms',
    'production_offices','schedule','settlement','safety','fire_life_safety',
    'venue_operations','documents','vendor_coordination',
  ]) {
    assert.ok(domains.includes(req), `missing required domain: ${req}`);
  }
});

test('every concept references a known domain', () => {
  const domains = new Set(industry.listDomains().map(d => d.id));
  for (const c of industry.listConcepts()) {
    assert.ok(domains.has(c.domain), `concept ${c.id} has unknown domain ${c.domain}`);
  }
});

test('getConcept returns the ontology entry', () => {
  const c = industry.getConcept('production_manager_venue');
  assert.equal(c.label, 'Production Manager (Venue)');
  assert.equal(c.domain, 'production_management');
  assert.ok(Array.isArray(c.responsibilities) && c.responsibilities.length > 0);
});

test('workflows include the show_advance workflow with required info', () => {
  const wf = industry.getWorkflow('show_advance');
  assert.ok(wf);
  assert.ok(wf.stages.length >= 5);
  assert.ok(wf.standardInfoRequired.includes('curfewTime'));
  assert.ok(wf.commonConflicts.some(c => c.case === 'rig_weight_vs_capacity'));
});

test('operationalConsequence returns severity + consequence', () => {
  const c = industry.operationalConsequence('unpermitted_pyro');
  assert.equal(c.severity, 'critical');
  assert.match(c.consequence, /fire marshal/i);
});

test('variability is expressed where industry practice varies', () => {
  const rigger = industry.getConcept('rigger');
  assert.ok(rigger.variability && rigger.variability.length > 0);
  const power = industry.getConcept('power_service');
  assert.ok(power.variability && power.variability.some(v => v.dimension === 'region'));
});

// ── resolveTerm: safe synonyms normalize; ambiguous acronyms do not ────────

test('resolveTerm normalizes safe synonyms without context', () => {
  const r1 = industry.resolveTerm('load in');
  const r2 = industry.resolveTerm('load-in');
  const r3 = industry.resolveTerm('loadin');
  assert.equal(r1.conceptId, 'load_in');
  assert.equal(r2.conceptId, 'load_in');
  assert.equal(r3.conceptId, 'load_in');
  assert.equal(r1.tier, 'industry_standard');
  assert.equal(r1.resolved, true);
});

test('resolveTerm refuses to guess ambiguous "PM" without context', () => {
  const r = industry.resolveTerm('PM', { context: '' });
  assert.equal(r.resolved, false);
  assert.equal(r.tier, 'unknown');
  assert.ok(r.alternatives.includes('production_manager_venue'));
  assert.ok(r.alternatives.includes('tour_production_manager'));
});

test('resolveTerm disambiguates "PM" with venue/advance context', () => {
  const r = industry.resolveTerm('PM', { context: 'Hi from the venue advance team' });
  assert.equal(r.resolved, true);
  assert.equal(r.conceptId, 'production_manager_venue');
  assert.equal(r.tier, 'industry_standard');
});

test('resolveTerm disambiguates "plot" as rig plot when rigging context is present', () => {
  const r = industry.resolveTerm('plot', { context: 'attached rig plot with motor points' });
  assert.equal(r.conceptId, 'rig_plot');
});

test('resolveTerm returns unknown for a truly unknown token, never fabricates', () => {
  const r = industry.resolveTerm('zorknob', { context: 'anything' });
  assert.equal(r.resolved, false);
  assert.equal(r.tier, 'unknown');
  assert.equal(r.conceptId, null);
});

// ── User rules override industry standard for terminology ──────────────────

test('user_instructed term rule overrides ambiguous acronym', () => {
  const rules = [{
    id: 'u1', kind: 'term_disambiguation', subject: 'PM',
    statement: JSON.stringify({ conceptId: 'promoter_rep' }),
    scope: 'venue-wide', status: 'active',
  }];
  const r = industry.resolveTerm('PM', { context: '', userRules: rules });
  assert.equal(r.resolved, true);
  assert.equal(r.conceptId, 'promoter_rep');
  assert.equal(r.tier, 'user_instructed');
});

test('user synonym rule maps a custom term to a concept', () => {
  const rules = [{
    id: 'u2', kind: 'synonym', subject: 'crew call',
    statement: JSON.stringify({ conceptId: 'load_in' }),
    scope: 'venue-wide', status: 'active',
  }];
  const r = industry.resolveTerm('crew call', { userRules: rules });
  assert.equal(r.resolved, true);
  assert.equal(r.conceptId, 'load_in');
  assert.equal(r.tier, 'user_instructed');
});

test('scoped user rule is ignored when context does not match', () => {
  const rules = [{
    id: 'u3', kind: 'term_disambiguation', subject: 'PM',
    statement: JSON.stringify({ conceptId: 'promoter_rep' }),
    scope: 'context:settlement', status: 'active',
  }];
  // Non-matching context → rule ignored → returns unresolved (no default guess).
  const r = industry.resolveTerm('PM', { context: 'load in and soundcheck', userRules: rules });
  assert.notEqual(r.conceptId, 'promoter_rep');
});

// ── mergedView: precedence + conflicts ─────────────────────────────────────

test('mergedView returns industry_standard when nothing else supplied', () => {
  const view = industry.mergedView({ conceptId: 'load_in' }, {});
  assert.equal(view.resolvedTier, 'industry_standard');
  assert.ok(view.layers.length === 1);
});

test('mergedView elevates show_specific value above venue policy', () => {
  const view = industry.mergedView(
    { conceptId: 'load_in', attributePath: 'schedule.load_in_time' },
    {
      showFacts: [{ conceptId: 'load_in', attributePath: 'schedule.load_in_time', value: '10:00', id: 'f1' }],
      venueRules: [{ conceptId: 'load_in', attributePath: 'schedule.load_in_time', value: '12:00', id: 'v1' }],
    },
  );
  assert.equal(view.resolvedTier, 'show_specific');
  assert.equal(view.resolvedValue, '10:00');
});

test('mergedView flags conflict between two authoritative tiers with different values', () => {
  const view = industry.mergedView(
    { attributePath: 'operations.curfew' },
    {
      venueRules:   [{ attributePath: 'operations.curfew', value: '23:00', id: 'v1' }],
      userRules:    [{ subject: 'curfew', attributePath: 'operations.curfew', kind: 'operational_convention', statement: '"22:00"', id: 'u1' }],
    },
  );
  assert.ok(view.conflicts.length > 0);
});

test('unknown subject with no data returns tier=unknown, never fabricates', () => {
  const view = industry.mergedView({ conceptId: 'nonexistent_concept' }, {});
  assert.equal(view.resolvedTier, 'unknown');
  assert.equal(view.resolvedValue, null);
});

// ── informationRequirements ────────────────────────────────────────────────

test('informationRequirements exposes the advance baseline info list', () => {
  const req = industry.informationRequirements('show_advance');
  for (const k of ['showTime','doorsTime','loadInTime','curfewTime','wirelessChannels','truckCount']) {
    assert.ok(req.includes(k), `missing standard requirement: ${k}`);
  }
});

// ── User rule CRUD (sheet-backed) ──────────────────────────────────────────

test('addUserRule persists to UserOntologyRules sheet', async () => {
  resetStore();
  const row = await industry.addUserRule(
    { kind: 'synonym', subject: 'crew call', statement: JSON.stringify({ conceptId: 'load_in' }), scope: 'venue-wide' },
    { email: 'pm@example.test' },
  );
  assert.ok(row.id);
  assert.equal(row.status, 'active');
  const stored = store.get('UserOntologyRules');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].subject, 'crew call');
});

test('addUserRule rejects unknown kind', async () => {
  resetStore();
  await assert.rejects(
    () => industry.addUserRule({ kind: 'bogus', subject: 'x', statement: 'y' }, { email: 'pm@example.test' }),
    /invalid rule kind/,
  );
});

test('loadUserRules returns only active rules', async () => {
  resetStore();
  store.get('UserOntologyRules').push({ id: 'r1', kind: 'synonym', subject: 'crew call', statement: '{}', scope: 'venue-wide', status: 'active' });
  store.get('UserOntologyRules').push({ id: 'r2', kind: 'synonym', subject: 'old term',  statement: '{}', scope: 'venue-wide', status: 'archived' });
  const rules = await industry.loadUserRules();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, 'r1');
});

test('updateUserRule patches the sheet row', async () => {
  resetStore();
  const created = await industry.addUserRule(
    { kind: 'synonym', subject: 'crew call', statement: JSON.stringify({ conceptId: 'load_in' }) },
    { email: 'pm@example.test' },
  );
  const updated = await industry.updateUserRule(created.id, { note: 'updated' }, { email: 'pm@example.test' });
  assert.equal(updated.note, 'updated');
  assert.equal(updated.id, created.id);
  assert.ok(updated.updatedAt);
});

test('deleteUserRule removes the row', async () => {
  resetStore();
  const row = await industry.addUserRule(
    { kind: 'synonym', subject: 'crew call', statement: JSON.stringify({ conceptId: 'load_in' }) },
    { email: 'pm@example.test' },
  );
  await industry.deleteUserRule(row.id);
  assert.equal(store.get('UserOntologyRules').length, 0);
});
