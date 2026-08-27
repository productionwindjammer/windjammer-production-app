'use strict';

/**
 * Validate the LLM configuration at server startup. Prints a redacted,
 * non-secret status line and returns a structured result the /api/llm/status
 * endpoint can serve back to admins. Never prints, returns, or transmits
 * the API key itself.
 *
 * `mask(key)` shows only the last four characters after the leading
 * "sk-ant-…" prefix; that's enough to identify the key at a glance without
 * exposing anything usable.
 */

const config = require('../config/server-config');

function mask(key) {
  if (!key) return null;
  const s = String(key);
  if (s.length <= 8) return '****';
  return `${s.slice(0, 7)}…${s.slice(-4)}`;
}

// Windows `process.env` is case-insensitive so `anthropic_API_KEY` and
// `ANTHROPIC_API_KEY` collapse into one; on Linux (Railway) they don't.
// Callers may inject a synthetic `env` (tests) to exercise the Linux path.
function detectMiscased(env) {
  if (env.ANTHROPIC_API_KEY) return null;
  for (const k of Object.keys(env)) {
    if (k !== 'ANTHROPIC_API_KEY' && k.toUpperCase() === 'ANTHROPIC_API_KEY' && env[k]) return k;
  }
  return null;
}

function validateAtStartup({ log = console, env = null } = {}) {
  const llm = config.llm || {};
  const provider = llm.provider || 'anthropic';
  const key         = env ? (env.ANTHROPIC_API_KEY || '') : (llm.anthropicKey || '');
  const miscasedKey = env ? detectMiscased(env) : (llm.miscasedKey || null);

  if (miscasedKey) {
    log.warn(`[llm] ⚠️  Found env var "${miscasedKey}" but the app reads "ANTHROPIC_API_KEY". Rename it — Linux env vars are case-sensitive. Email extraction is falling back to rules-v1 until this is fixed.`);
  }

  if (!key) {
    log.warn(`[llm] ANTHROPIC_API_KEY not set — LLM email extraction disabled. Rules-v1 extractor will run for every thread. Set the key in Railway (Variables) and locally in .env to enable Claude.`);
    return { configured: false, provider, model: llm.model, miscasedKey: miscasedKey || null };
  }

  const shapeOk = /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key);
  if (!shapeOk) {
    log.warn(`[llm] ANTHROPIC_API_KEY is set but does not match the expected "sk-ant-…" shape. Double-check the value.`);
  }

  log.info(`[llm] provider=${provider} model=${llm.model} key=${mask(key)} — extractor primary. Rules-v1 fallback on failure.`);
  return { configured: true, provider, model: llm.model, keyPreview: mask(key), miscasedKey: null };
}

function publicStatus({ env = null } = {}) {
  const llm = config.llm || {};
  const key         = env ? (env.ANTHROPIC_API_KEY || '') : (llm.anthropicKey || '');
  const miscasedKey = env ? detectMiscased(env) : (llm.miscasedKey || null);
  return {
    provider: llm.provider || 'anthropic',
    model:    llm.model,
    configured: Boolean(key),
    keyPreview: key ? mask(key) : null,
    miscasedKey: miscasedKey || null,
  };
}

module.exports = { validateAtStartup, publicStatus, mask, _internals: { detectMiscased } };
