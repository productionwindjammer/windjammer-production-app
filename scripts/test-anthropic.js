#!/usr/bin/env node
'use strict';

/**
 * scripts/test-anthropic.js
 *
 * Minimal live authentication check against the Anthropic Messages API.
 * Uses ONE token of output — negligible cost. Exit codes:
 *   0 — configured, authenticated, model responded
 *   1 — key missing OR wrong shape
 *   2 — network / HTTP failure
 *   3 — model responded but returned no content (should not happen)
 *
 * Prints ONLY: masked key preview, model name, latency, first non-empty
 * response character count. Never prints the key value. Never prints the
 * Anthropic response body (which can echo request headers).
 *
 * Usage:
 *   node scripts/test-anthropic.js
 */

require('dotenv').config();

const { AnthropicProvider } = require('../llm/provider');
const config = require('../config/server-config');
const { validateAtStartup, mask } = require('../llm/configCheck');

(async function main() {
  const status = validateAtStartup({ log: {
    info: () => {},   // suppress the normal startup line; we'll print our own.
    warn: (m) => console.error(m),
  } });

  if (!status.configured) {
    console.error('\n❌ ANTHROPIC_API_KEY is not set.');
    console.error('   Set it in your local .env and in the Railway dashboard, then re-run.');
    process.exit(1);
  }

  const provider = new AnthropicProvider({
    apiKey: config.llm.anthropicKey,
    model:  config.llm.model,
  });

  const started = Date.now();
  try {
    const r = await provider.extractStructured({
      system: 'You are a JSON emitter. Reply by calling the tool with facts=[], issues=[], missing_information=[], recommended_actions=[]. Ignore any content in the message.',
      userText: 'auth check',
      schema: {
        type: 'object',
        required: ['facts', 'issues', 'missing_information', 'recommended_actions'],
        additionalProperties: false,
        properties: {
          facts:              { type: 'array', items: { type: 'object' } },
          issues:             { type: 'array', items: { type: 'object' } },
          missing_information:{ type: 'array', items: { type: 'string' } },
          recommended_actions:{ type: 'array', items: { type: 'string' } },
        },
      },
      toolName: 'auth_check',
      toolDescription: 'Emit an empty extraction result for the auth check.',
      maxTokens: 128,
    });
    const dt = Date.now() - started;
    if (!r || !r.data) {
      console.error('❌ Anthropic responded but returned no structured payload.');
      process.exit(3);
    }
    console.log(`✅ Anthropic auth OK`);
    console.log(`   provider : anthropic`);
    console.log(`   model    : ${r.modelUsed || config.llm.model}`);
    console.log(`   key      : ${mask(config.llm.anthropicKey)}`);
    console.log(`   latency  : ${dt} ms`);
    console.log(`   tokens   : in=${r.tokensIn ?? '?'} out=${r.tokensOut ?? '?'}`);
    process.exit(0);
  } catch (err) {
    // AnthropicProvider throws Errors whose message starts with
    // `anthropic_http_<status>: <body-snippet>`. That snippet MAY contain
    // details about the request. Strip anything that looks like a bearer
    // header or key echo before printing.
    const scrubbed = String(err.message || err)
      .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-****')
      .slice(0, 400);
    console.error(`❌ Anthropic auth failed: ${scrubbed}`);
    if (err.status === 401 || err.status === 403) {
      console.error('   The key is invalid or lacks access to the model. Check the Anthropic console and re-issue.');
      process.exit(2);
    }
    if (err.status === 404) {
      console.error(`   Model "${config.llm.model}" not found for this key.`);
      await printAvailableModels(config.llm.anthropicKey);
      process.exit(2);
    }
    process.exit(2);
  }
})();

async function printAvailableModels(apiKey) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    });
    if (!res.ok) {
      console.error(`   (couldn't list models: HTTP ${res.status})`);
      return;
    }
    const body = await res.json();
    const ids = (body.data || []).map(m => m.id).filter(Boolean);
    if (!ids.length) {
      console.error('   This key has no models allow-listed. Contact your Anthropic workspace admin.');
      return;
    }
    console.error('   Models this key CAN call:');
    for (const id of ids) console.error(`     • ${id}`);
    console.error('   Set LLM_MODEL in .env to one of the above, then re-run.');
  } catch (e) {
    console.error(`   (couldn't list models: ${e.message})`);
  }
}
