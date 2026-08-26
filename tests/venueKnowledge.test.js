'use strict';

/**
 * Venue Intelligence tests.
 *
 * These tests exercise the venueKnowledge module against an in-memory fake of
 * the sheets facade. They lock in the two most important behaviors:
 *
 *   1. When the venue has no rule on file, analyzeCapability MUST return
 *      { known:false, matches:'unknown' } and MUST NOT synthesize a value.
 *   2. Observations (historical patterns) are never treated as venue
 *      capabilities. Only kind='rule' rows are used by analyzeCapability.
 *
 * We stub the sheets module via require.cache before loading venueKnowledge,
 * so no Google API calls happen and the tests run offline.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

// ── In-memory fake of the sheets facade ────────────────────────────────────
const store = new Map(); // sheetName -> Array<row>

function resetStore() {
  store.clear();
  store.set('VenueKnowledge', []);
  store.set('VenueKnowledgeHistory', []);
}

const fakeSheets = {
  async getRows(sheetName)              { return (store.get(sheetName) || []).map(r => ({ ...r })); },
  async appendRow(sheetName, row)       {
    if (!store.has(sheetName)) store.set(sheetName, []);
    store.get(sheetName).push({ ...row });
  },
  async appendRows(sheetName, rows)     {
    for (const r of rows) await fakeSheets.appendRow(sheetName, r);
  },
  async updateRowById(sheetName, id, patch) {
    const rows = store.get(sheetName) || [];
    const idx  = rows.findIndex(r => String(r.id) === String(id));
    if (idx < 0) throw new Error('row not found in fake sheets: ' + id);
    rows[idx] = { ...rows[idx], ...patch };
  },
  async deleteRowById(sheetName, id)    {
    const rows = store.get(sheetName) || [];
    store.set(sheetName, rows.filter(r => String(r.id) !== String(id)));
  },
  async ensureHeaders() { /* no-op in tests */ },
  async ensureSheet()   { /* no-op in tests */ },
};

// Preload require.cache so that `require('./sheets')` inside venueKnowledge.js
// resolves to our fake. This must happen BEFORE the first require of the module.
const sheetsPath = path.resolve(__dirname, '..', 'sheets.js');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

const venueKnowledge = require('../venueKnowledge');

// ── Helpers ────────────────────────────────────────────────────────────────
async function seedRule(overrides = {}) {
  return venueKnowledge.createItem({
    kind:          'rule',
    category:      'technical',
    subcategory:   'power',
    attributePath: 'technical.power.stage_amps',
    scope:         'venue',
    dataType:      'number',
    value:         400,
    unit:          'A',
    source:        'manual',
    ...overrides,
  }, 'user:admin');
}

// ── 1. Unknown attribute → unknown result, no fabrication ──────────────────
test('analyzeCapability returns unknown when no rule exists', async () => {
  resetStore();
  const result = await venueKnowledge.analyzeCapability({
    category:      'technical',
    attributePath: 'technical.audio.line_array_boxes',
    requestedValue: 12,
    unit:          'boxes',
  });
  assert.equal(result.known,   false);
  assert.equal(result.matches, 'unknown');
  assert.equal(result.capability, null,
    'analyzeCapability must NOT invent a capability when unknown');
  assert.equal(result.reason, 'no_venue_knowledge_on_file');
  assert.equal(result.needsAction, true);
});

// ── 2. Request within venue capacity → match, no action needed ─────────────
test('analyzeCapability reports yes when request is within capacity', async () => {
  resetStore();
  await seedRule({ value: 400 });
  const result = await venueKnowledge.analyzeCapability({
    category:      'technical',
    attributePath: 'technical.power.stage_amps',
    requestedValue: 200,
    unit:          'A',
  });
  assert.equal(result.known,       true);
  assert.equal(result.matches,     'yes');
  assert.equal(result.needsVendor, false);
  assert.equal(result.needsAction, false);
  assert.equal(result.capability.value, 400);
});

// ── 3. Request exceeds capacity → no, critical for safety category ─────────
test('analyzeCapability flags critical shortfall for power', async () => {
  resetStore();
  await seedRule({ value: 200 });
  const result = await venueKnowledge.analyzeCapability({
    category:      'technical',
    attributePath: 'technical.power.stage_amps',
    requestedValue: 400,
    unit:          'A',
  });
  assert.equal(result.matches,     'no');
  assert.equal(result.critical,    true, 'power shortfall must be critical');
  assert.equal(result.needsVendor, true);
  assert.equal(result.gap.shortBy, 200);
});

// ── 4. List/enum capability → partial match returns partial ────────────────
test('analyzeCapability reports partial when some list items unavailable', async () => {
  resetStore();
  await venueKnowledge.createItem({
    kind:          'rule',
    category:      'technical',
    subcategory:   'audio',
    attributePath: 'technical.audio.consoles',
    scope:         'venue',
    dataType:      'list',
    value:         ['Avid S6L-32D', 'DiGiCo SD10'],
    source:        'manual',
  }, 'user:admin');
  const result = await venueKnowledge.analyzeCapability({
    category:      'technical',
    attributePath: 'technical.audio.consoles',
    requestedValue: ['Avid S6L-32D', 'Yamaha Rivage PM10'],
  });
  assert.equal(result.matches,     'partial');
  assert.equal(result.needsVendor, true);
  assert.deepEqual(result.gap.missing, ['Yamaha Rivage PM10']);
});

// ── 5. Observations MUST NOT be treated as capabilities ────────────────────
test('analyzeCapability ignores observations; only rules count', async () => {
  resetStore();
  // Only an observation exists — no rule. Analyzing must return unknown.
  await venueKnowledge.createItem({
    kind:          'observation',
    subject:       'promoter:AC Entertainment',
    category:      'hospitality',
    subcategory:   'catering',
    attributePath: 'hospitality.catering.dinner_count',
    scope:         'venue',
    dataType:      'number',
    value:         75,
    sampleSize:    12,
    source:        'observation',
  }, 'user:admin');

  const result = await venueKnowledge.analyzeCapability({
    category:      'hospitality',
    attributePath: 'hospitality.catering.dinner_count',
    requestedValue: 60,
  });
  assert.equal(result.known,   false, 'observation is not a capability');
  assert.equal(result.matches, 'unknown');
  assert.equal(result.capability, null);
  // But observations should be surfaced separately so the user sees the
  // historical context without it being mistaken for a rule.
  assert.ok(Array.isArray(result.observations));
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].subject, 'promoter:AC Entertainment');
});

// ── 6. Update creates new version; old row is superseded ───────────────────
test('updateItem preserves version history via supersedes chain', async () => {
  resetStore();
  const original = await seedRule({ value: 400, notes: 'per 2019 electrical drawings' });
  const updated  = await venueKnowledge.updateItem(original.id, {
    value: 600,
    notes: 'upgraded switchgear June 2024',
  }, 'user:admin', 'switchgear upgrade');

  assert.notEqual(updated.id, original.id, 'update must create new row');
  assert.equal(updated.supersedes, original.id);

  const all = await venueKnowledge.listAll({});
  const oldRow = all.find(r => r.id === original.id);
  const newRow = all.find(r => r.id === updated.id);
  assert.equal(oldRow.status, 'superseded');
  assert.equal(oldRow.supersededBy, updated.id);
  assert.equal(newRow.status, 'active');
  assert.equal(newRow.value, 600);

  const history = await venueKnowledge.getHistory(updated.id);
  assert.ok(history.length >= 1, 'history log should record the update');
  assert.equal(history[history.length - 1].action, 'update');
});

// ── 7. Unknown attribute path with critical category still flags critical ──
test('analyzeCapability flags critical:true for unknown safety-critical paths', async () => {
  resetStore();
  const result = await venueKnowledge.analyzeCapability({
    category:      'operations',
    attributePath: 'operations.fire_life_safety.pyro_permitted',
    requestedValue: true,
  });
  assert.equal(result.known,      false);
  assert.equal(result.matches,    'unknown');
  assert.equal(result.critical,   true, 'fire/life/safety must be flagged critical even when unknown');
  assert.equal(result.needsAction, true);
});

// ── 8. Validation: unknown category/kind is rejected ───────────────────────
test('createItem rejects invalid kind and invalid category', async () => {
  resetStore();
  await assert.rejects(
    () => venueKnowledge.createItem({
      kind: 'guess', category: 'technical', attributePath: 'x.y', value: 1,
    }, 'u'),
    /validation/,
  );
  await assert.rejects(
    () => venueKnowledge.createItem({
      kind: 'rule', category: 'made_up', attributePath: 'x.y', value: 1,
    }, 'u'),
    /validation/,
  );
  // Observation missing subject
  await assert.rejects(
    () => venueKnowledge.createItem({
      kind: 'observation', category: 'hospitality', subcategory: 'catering',
      attributePath: 'hospitality.catering.dinner_count', value: 50,
    }, 'u'),
    /subject/,
  );
});

// ── 9. When request omits value, capability is reported but no fabrication ─
test('analyzeCapability without requestedValue returns capability but matches=unknown', async () => {
  resetStore();
  await seedRule({ value: 400 });
  const result = await venueKnowledge.analyzeCapability({
    category:      'technical',
    attributePath: 'technical.power.stage_amps',
  });
  assert.equal(result.known,          true);
  assert.equal(result.matches,        'unknown');
  assert.equal(result.capability.value, 400);
  assert.equal(result.reason,         'no_requested_value_supplied');
});
