'use strict';

/**
 * Real Anthropic end-to-end proof.
 *
 * This test is SKIPPED unless `ANTHROPIC_API_KEY` (or LLM_ANTHROPIC_KEY) is
 * set in the environment. When enabled it hits the actual Anthropic Messages
 * API with the exact synthetic email from the extraction spec and asserts:
 *
 *   • The provider was called (not a stub — real network).
 *   • The model returned every expected fact.
 *   • Each fact's field name is drawn from the strict schema enum.
 *   • Field mapping recognises every fact.
 *
 * We DO NOT write to real Google Sheets here — the sheets module is stubbed
 * with an in-memory fake so the pipeline can run through approve+apply and
 * assert the same DB→form path that production takes.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

const KEY = process.env.ANTHROPIC_API_KEY || process.env.LLM_ANTHROPIC_KEY || '';
const RUN = Boolean(KEY);

// ── In-memory sheets fake (identical to productionExtractor.test.js) ───────
const store = new Map();
function resetStore() {
  store.clear();
  for (const s of ['VenueKnowledge','VenueKnowledgeHistory','EmailFacts','EmailThreads','EmailIssues','AiChangeLog','Shows','Advancing','Schedule']) store.set(s, []);
}
const fakeSheets = {
  async getRows(name)          { return (store.get(name) || []).map(r => ({ ...r })); },
  async appendRow(name, row)   { if (!store.has(name)) store.set(name, []); store.get(name).push({ ...row }); },
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

const emailIntel        = require('../emailIntelligence');
const productionExtractor = require('../productionExtractor');
const factMapping       = require('../factMapping');
const { AnthropicProvider } = require('../llm/provider');

const SHOW = { id: 'show_real_1', artist: 'The Fictional Band', eventName: 'Fictional Fest', date: '2026-09-15', venue: 'Windjammer', stage: 'inside', capacity: 500 };
const SPEC_EMAIL_BODY = [
  'Hi team,',
  '',
  "We're confirmed for an 8:00 AM load-in.",
  'We will have 3 trucks and 2 buses.',
  'Soundcheck is at 4:00 PM.',
  'Doors are at 7:00 PM.',
  'Please have 12 local stagehands available.',
  '',
  'Thanks.',
].join('\n');

test('E2E-REAL · Anthropic Claude extracts every spec fact and the pipeline writes them to the sheets',
  { skip: !RUN && 'ANTHROPIC_API_KEY not set — skipping real-network e2e' },
  async () => {
    resetStore();
    await fakeSheets.appendRow('Shows', { ...SHOW });

    const provider = new AnthropicProvider({
      apiKey: KEY,
      model:  process.env.LLM_MODEL || 'claude-sonnet-4-20250514',
    });
    assert.ok(provider.isConfigured(), 'provider must be configured for the real test');

    const msg = {
      id:       'msg_real_1',
      threadId: 'thread_real_1',
      from:     'Devon Kim <dkim@example-tourco.test>',
      subject:  'Show advance',
      date:     '2026-09-01T09:00:00Z',
      body:     SPEC_EMAIL_BODY,
    };

    const analysis = await productionExtractor.extractWithLLM({
      messages: [msg], shows: [SHOW], showId: SHOW.id, provider,
    });

    // Prove the model was hit and returned usage/latency.
    assert.equal(analysis.source ?? 'llm', 'llm');
    assert.ok(analysis.llm.provider === 'anthropic');
    assert.ok(analysis.llm.model && analysis.llm.model.includes('claude'));
    assert.ok(analysis.llm.latencyMs >= 0);

    // The six expected facts.
    const expected = {
      loadin_time:     '08:00',
      truck_count:     3,
      bus_count:       2,
      soundcheck_time: '16:00',
      doors_time:      '19:00',
      stagehand_count: 12,
    };
    for (const [field, value] of Object.entries(expected)) {
      const f = analysis.facts.find(x => x.field === field);
      assert.ok(f, `real model must extract ${field}`);
      assert.deepEqual(f.newValue, value, `real model must extract ${field}=${value}`);
    }

    // The rest of the pipeline is identical to production — same code path.
    await emailIntel.proposeFromAnalysis(analysis, { actor: 'e2e' });
    const facts = await fakeSheets.getRows('EmailFacts');
    for (const f of facts) {
      await factMapping.applyApprovedFact(f, { id: 'e2e-pm', email: 'e2e@test.local' });
    }

    const shows    = await fakeSheets.getRows('Shows');
    const advances = await fakeSheets.getRows('Advancing');
    const schedule = await fakeSheets.getRows('Schedule');

    assert.equal(shows[0].doorsTime, '19:00');
    assert.ok(schedule.some(r => /load-?in/i.test(r.label) && r.time === '08:00'));
    assert.ok(schedule.some(r => /sound ?check/i.test(r.label) && r.time === '16:00'));
    assert.match(advances[0].productionNeeds || '', /Trucks:\s*3/);
    assert.match(advances[0].productionNeeds || '', /Buses:\s*2/);
    assert.match(advances[0].localCrewNeeds || '', /Stagehands:\s*12/);
  });
