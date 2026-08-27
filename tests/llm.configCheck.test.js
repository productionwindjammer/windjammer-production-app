'use strict';

/**
 * Config-check tests — prove the LLM key handling meets the security bar:
 *   • Never returns the key value
 *   • Detects miscased env vars without echoing them
 *   • Warns loudly when unset
 *   • Reports a masked preview for identification only
 *   • Rejects obviously-wrong key shapes
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

// Reset the config module between tests so env changes take effect.
function loadFresh() {
  delete require.cache[require.resolve('../config/server-config')];
  delete require.cache[require.resolve('../llm/configCheck')];
  return require('../llm/configCheck');
}

// Silent logger the tests can inspect.
function fakeLog() {
  const calls = { info: [], warn: [], error: [] };
  return { calls, info: m => calls.info.push(m), warn: m => calls.warn.push(m), error: m => calls.error.push(m) };
}

// Synthetic env — Windows' process.env is case-insensitive; passing a plain
// object lets the tests exercise the Linux (Railway) behavior deterministically.
function env(vars) { return { ...vars }; }

test('mask · never returns the raw key', () => {
  const { mask } = loadFresh();
  const raw = 'sk-ant-api03-verylongsecrettokenthatshouldneverleak-xyz';
  const m = mask(raw);
  assert.ok(!m.includes('verylongsecret'), 'body must not appear in mask');
  assert.ok(m.startsWith('sk-ant-'), 'prefix should be visible for identification');
  assert.ok(m.endsWith('-xyz'), 'last 4 chars should be visible for identification');
});

test('validateAtStartup · warns and returns configured=false when key missing', () => {
  const { validateAtStartup } = loadFresh();
  const log = fakeLog();
  const status = validateAtStartup({ log, env: env({}) });
  assert.equal(status.configured, false);
  assert.equal(status.miscasedKey, null);
  assert.ok(log.calls.warn.some(m => /not set/i.test(m)));
  for (const m of [...log.calls.info, ...log.calls.warn]) {
    assert.ok(!/sk-ant-[A-Za-z0-9_-]{10,}/.test(m), 'no key value may appear');
  }
});

test('validateAtStartup · warns loudly when a MISCASED env var is present', () => {
  const { validateAtStartup } = loadFresh();
  const log = fakeLog();
  const status = validateAtStartup({
    log, env: env({ anthropic_API_KEY: 'sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }),
  });
  assert.equal(status.configured, false, 'miscased key must not count as configured');
  assert.equal(status.miscasedKey, 'anthropic_API_KEY');
  const combined = log.calls.warn.join('\n');
  assert.match(combined, /anthropic_API_KEY/);
  assert.match(combined, /case-sensitive/i);
  assert.ok(!combined.includes('sk-ant-api03-xxxx'), 'must not echo the value');
});

test('validateAtStartup · reports masked preview + configured=true for a valid key shape', () => {
  const { validateAtStartup } = loadFresh();
  const key = 'sk-ant-api03-' + 'A'.repeat(40) + '-Z9';
  const log = fakeLog();
  const status = validateAtStartup({ log, env: env({ ANTHROPIC_API_KEY: key }) });
  assert.equal(status.configured, true);
  assert.equal(status.miscasedKey, null);
  assert.ok(status.keyPreview.endsWith('-Z9'));
  assert.ok(!status.keyPreview.includes('A'.repeat(20)), 'preview must not contain most of the key');
  assert.ok(log.calls.info.length >= 1);
  for (const line of log.calls.info) {
    assert.ok(!line.includes(key), 'info line must not contain the full key');
  }
});

test('validateAtStartup · warns when key shape looks wrong', () => {
  const { validateAtStartup } = loadFresh();
  const log = fakeLog();
  const status = validateAtStartup({ log, env: env({ ANTHROPIC_API_KEY: 'not-a-real-key' }) });
  assert.equal(status.configured, true, 'a wrong-shape key is still passed through — Anthropic will 401');
  assert.ok(log.calls.warn.some(m => /shape/i.test(m)));
});

test('publicStatus · shape sent to the admin UI never includes the key', () => {
  const { publicStatus } = loadFresh();
  const key = 'sk-ant-api03-' + 'B'.repeat(40) + '-Q4';
  const s = publicStatus({ env: env({ ANTHROPIC_API_KEY: key }) });
  assert.deepEqual(Object.keys(s).sort(), ['configured', 'keyPreview', 'miscasedKey', 'model', 'provider'].sort());
  for (const [k, v] of Object.entries(s)) {
    assert.ok(!String(v ?? '').includes(key), `${k} must not contain the full key`);
  }
  assert.equal(s.configured, true);
  assert.equal(s.provider, 'anthropic');
  assert.ok(s.keyPreview.endsWith('-Q4'));
});

test('AnthropicProvider · errors never echo the api key', async () => {
  const key = 'sk-ant-api03-' + 'C'.repeat(40) + '-Zz';
  const { AnthropicProvider } = require('../llm/provider');
  // Fetch stub that echoes the auth header in the response body to try to
  // trick us into leaking it in an error message.
  const fetchImpl = async (url, opts) => ({
    ok: false, status: 401,
    text: async () => `unauthorized: your header was x-api-key: ${opts.headers['x-api-key']}`,
    json: async () => ({}),
  });
  const p = new AnthropicProvider({ apiKey: key, model: 'claude-sonnet-4-20250514', fetchImpl });
  let caught;
  try {
    await p.extractStructured({ system: 's', userText: 'u', schema: { type: 'object' }, toolName: 't' });
  } catch (err) { caught = err; }
  assert.ok(caught, 'must throw');
  assert.ok(!caught.message.includes(key), 'provider error must not echo the key');
});

test('AnthropicProvider · does NOT put the key in fetched URL', async () => {
  const key = 'sk-ant-api03-' + 'D'.repeat(40) + '-Bx';
  const { AnthropicProvider } = require('../llm/provider');
  let capturedUrl = '', capturedHeaders = null, capturedBody = '';
  const fetchImpl = async (url, opts) => {
    capturedUrl = url; capturedHeaders = opts.headers; capturedBody = opts.body;
    return {
      ok: true, status: 200,
      json: async () => ({ content: [{ type: 'tool_use', name: 't', input: {} }], usage: {} }),
    };
  };
  const p = new AnthropicProvider({ apiKey: key, model: 'x', fetchImpl });
  await p.extractStructured({ system: 's', userText: 'u', schema: { type: 'object' }, toolName: 't' });
  assert.ok(!capturedUrl.includes(key), 'URL must not contain the key');
  assert.ok(!capturedBody.includes(key), 'request body must not contain the key');
  assert.equal(capturedHeaders['x-api-key'], key, 'key must be in the x-api-key header only');
});
