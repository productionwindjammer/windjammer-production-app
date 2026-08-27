'use strict';

/**
 * LLM provider abstraction.
 *
 * Contract (every provider must satisfy):
 *   - `isConfigured()`  → boolean. False when no credentials / no model.
 *   - `name`            → 'anthropic' | 'openai' | 'stub' | ...
 *   - `model`           → concrete model string (e.g. 'claude-sonnet-4-...')
 *   - `extractStructured({ system, userText, schema, toolName, toolDescription, maxTokens })`
 *       Returns { data, tokensIn, tokensOut, latencyMs, modelUsed }.
 *       `data` MUST already be a plain JS object that matches `schema`.
 *       The provider is responsible for schema-constrained generation.
 *
 * The provider NEVER receives Windjammer secrets, credentials, database
 * handles, or filesystem access. It receives only the sanitized text the
 * caller has decided is safe to share with the model.
 */

class LLMProvider {
  get name()  { throw new Error('name must be overridden'); }
  get model() { throw new Error('model must be overridden'); }
  isConfigured() { return false; }
  async extractStructured(_opts) { throw new Error('extractStructured must be overridden'); }
}

/**
 * Anthropic Messages API with tool-use for schema-constrained output.
 * Anthropic guarantees the tool `input` matches the tool's `input_schema`
 * when `tool_choice` is forced to that tool.
 */
class AnthropicProvider extends LLMProvider {
  constructor({ apiKey, model, apiVersion = '2023-06-01', fetchImpl = null, endpoint = 'https://api.anthropic.com/v1/messages' } = {}) {
    super();
    this.apiKey  = apiKey || '';
    this._model  = model || 'claude-sonnet-4-20250514';
    this.apiVersion = apiVersion;
    this.endpoint   = endpoint;
    this.fetch      = fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  }
  get name()  { return 'anthropic'; }
  get model() { return this._model; }
  isConfigured() { return Boolean(this.apiKey && this.fetch); }

  async extractStructured({ system, userText, schema, toolName = 'record_production_facts', toolDescription = 'Record structured production facts extracted from the email thread.', maxTokens = 2048 }) {
    if (!this.isConfigured()) throw new Error('anthropic_not_configured');
    const started = Date.now();
    const body = {
      model: this._model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userText }],
      tools: [{ name: toolName, description: toolDescription, input_schema: schema }],
      tool_choice: { type: 'tool', name: toolName },
    };
    const res = await this.fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': this.apiVersion,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await safeText(res);
      const err = new Error(`anthropic_http_${res.status}: ${detail.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    const toolUse = (json.content || []).find(c => c.type === 'tool_use' && c.name === toolName);
    if (!toolUse) throw new Error('anthropic_no_tool_use_in_response');
    return {
      data:       toolUse.input,
      modelUsed:  json.model || this._model,
      tokensIn:   json.usage?.input_tokens  ?? null,
      tokensOut:  json.usage?.output_tokens ?? null,
      latencyMs:  Date.now() - started,
    };
  }
}

async function safeText(res) { try { return await res.text(); } catch { return ''; } }

/**
 * Test/CI provider. Emits whatever `program` returns. Never touches network.
 * `program` is a function of { system, userText, schema } → data object.
 */
class StubProvider extends LLMProvider {
  constructor({ program, model = 'stub-1' } = {}) {
    super();
    this._program = program || (() => ({ facts: [], conflicts: [], missing_information: [], recommended_actions: [] }));
    this._model = model;
    this.lastCall = null;
  }
  get name()  { return 'stub'; }
  get model() { return this._model; }
  isConfigured() { return true; }
  async extractStructured({ system, userText, schema, toolName }) {
    this.lastCall = { system, userText, schema, toolName };
    const data = await this._program({ system, userText, schema, toolName });
    return { data, modelUsed: this._model, tokensIn: null, tokensOut: null, latencyMs: 0 };
  }
}

/**
 * Factory: pick a provider from server-config + env. Never throws when
 * unconfigured — returns a provider whose `isConfigured()` is false, and the
 * caller decides whether to fall back.
 */
function getProviderFromConfig(cfg = {}) {
  const name = (cfg.provider || 'anthropic').toLowerCase();
  if (name === 'anthropic') {
    return new AnthropicProvider({ apiKey: cfg.anthropicKey || '', model: cfg.model });
  }
  if (name === 'stub') {
    return new StubProvider({ program: cfg.stubProgram, model: cfg.model });
  }
  // Unknown provider names collapse to a null-configured Anthropic client so
  // isConfigured() is false and the caller falls back to rules-v1.
  return new AnthropicProvider({ apiKey: '', model: cfg.model });
}

module.exports = { LLMProvider, AnthropicProvider, StubProvider, getProviderFromConfig };
