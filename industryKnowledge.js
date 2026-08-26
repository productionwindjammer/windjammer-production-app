'use strict';

/**
 * Live Concert Industry Knowledge Layer.
 *
 * Six tiers, stacked highest-authority first for factual questions:
 *
 *   show_specific         — approved EmailFacts + Advancing row values
 *   user_instructed       — UserOntologyRules sheet (venue admin overrides)
 *   venue_policy          — VenueKnowledge rules (kind='rule', status='active')
 *   historical_observation — VenueKnowledge observations
 *   industry_standard     — seed ontology in ./industryKnowledge/ontology.js
 *   unknown               — always the safe default; never fabricated
 *
 * For TERMINOLOGY / SYNONYM resolution the precedence is:
 *
 *   user_instructed  >  venue_policy (kind='rule', category='operations')  >  industry_standard
 *
 * Context-aware resolution: ambiguous acronyms (PM, TM, plot, rider, push)
 * are NEVER auto-normalized. Callers must pass a `context` string; if the
 * context does not clearly disambiguate we return { resolved: false, ... }.
 *
 * The knowledge layer NEVER invents an answer. If nothing in any tier
 * matches, the result carries tier='unknown'.
 */

const { randomUUID } = require('crypto');
const sheetsLib = require('./sheets');
const config = require('./config/server-config');
const ontology = require('./industryKnowledge/ontology');

const USER_RULES_SHEET = config.googleSheets.sheets.userOntologyRules;

const TIERS = [
  'show_specific',
  'user_instructed',
  'venue_policy',
  'historical_observation',
  'industry_standard',
  'unknown',
];

const TIER_RANK = TIERS.reduce((m, t, i) => (m[t] = i, m), {});

const USER_RULE_KINDS = [
  'term_disambiguation', // "In our shop, 'PM' means production_manager_venue unless the sender is a promoter."
  'synonym',             // "'crew call' is our name for load_in."
  'concept_override',    // Override a description/responsibility for a concept.
  'variability_note',    // Add a variability note (e.g. our region is right-to-work).
  'operational_convention', // "We always run a fire-marshal walk 30 min before doors."
];

// ── Public API ──────────────────────────────────────────────────────────────

function listDomains() {
  return Object.values(ontology.DOMAINS);
}

function listConcepts({ domain } = {}) {
  if (!domain) return ontology.CONCEPTS.slice();
  return ontology.CONCEPTS.filter(c => c.domain === domain);
}

function getConcept(id) {
  return ontology.CONCEPTS.find(c => c.id === id) || null;
}

function getWorkflow(id) {
  return ontology.WORKFLOWS.find(w => w.id === id) || null;
}

function listWorkflows() {
  return ontology.WORKFLOWS.slice();
}

function operationalConsequence(key) {
  return ontology.OPERATIONAL_CONSEQUENCES[key] || null;
}

/**
 * Standard information the AI/PM should collect for a given domain
 * (aggregated from workflows + concepts).
 */
function informationRequirements(domainId) {
  const wf = ontology.WORKFLOWS.find(w =>
    w.standardInfoRequired && (w.id === domainId || w.id === 'show_advance'),
  );
  return wf?.standardInfoRequired || [];
}

// ── Term resolution ─────────────────────────────────────────────────────────

/**
 * Context-aware term resolution.
 *
 * @param {string} term        Raw term from an email/document.
 * @param {object} opts
 * @param {string} opts.context Free text around the term. Used to disambiguate.
 * @param {Array}  opts.userRules Optional pre-loaded user rules (see loadUserRules).
 * @returns {{ resolved: boolean, conceptId: string|null, tier: string, reason: string, alternatives?: Array }}
 */
function resolveTerm(term, { context = '', userRules = [] } = {}) {
  const t = String(term || '').trim();
  if (!t) return { resolved: false, conceptId: null, tier: 'unknown', reason: 'empty_term' };

  const ctxLower = String(context || '').toLowerCase();

  // 1. USER-INSTRUCTED rules take precedence for terminology.
  const userTerm = userRules.find(r =>
    r.kind === 'term_disambiguation' &&
    r.subject && r.subject.toLowerCase() === t.toLowerCase() &&
    ruleAppliesToContext(r, ctxLower),
  );
  if (userTerm && userTerm.statement) {
    const parsed = tryParseJSON(userTerm.statement);
    const conceptId = parsed?.conceptId || (typeof userTerm.statement === 'string' ? userTerm.statement : null);
    if (conceptId && getConcept(conceptId)) {
      return { resolved: true, conceptId, tier: 'user_instructed', reason: `user rule ${userTerm.id}` };
    }
  }
  const userSyn = userRules.find(r =>
    r.kind === 'synonym' &&
    r.subject && r.subject.toLowerCase() === t.toLowerCase(),
  );
  if (userSyn && userSyn.statement) {
    const parsed = tryParseJSON(userSyn.statement);
    const conceptId = parsed?.conceptId || (typeof userSyn.statement === 'string' ? userSyn.statement : null);
    if (conceptId && getConcept(conceptId)) {
      return { resolved: true, conceptId, tier: 'user_instructed', reason: `user synonym rule ${userSyn.id}` };
    }
  }

  // 2. INDUSTRY STANDARD safe synonyms — unambiguous.
  const safe = ontology.SAFE_SYNONYMS.find(s =>
    s.canonical.toLowerCase() === t.toLowerCase() ||
    s.forms.some(f => f.toLowerCase() === t.toLowerCase()),
  );
  if (safe) {
    return {
      resolved: true,
      conceptId: getConcept(safe.canonical) ? safe.canonical : safe.canonical,
      tier: 'industry_standard',
      reason: 'safe synonym match',
    };
  }

  // 3. Direct concept id / label match.
  const direct = ontology.CONCEPTS.find(c =>
    c.id.toLowerCase() === t.toLowerCase() ||
    c.label.toLowerCase() === t.toLowerCase() ||
    (c.synonyms || []).some(s => s.toLowerCase() === t.toLowerCase()),
  );
  if (direct) {
    return {
      resolved: true,
      conceptId: direct.id,
      tier: 'industry_standard',
      reason: 'direct concept match',
    };
  }

  // 4. AMBIGUOUS term — requires context to disambiguate. Never guess.
  const amb = ontology.AMBIGUOUS_TERMS.find(a => a.term.toLowerCase() === t.toLowerCase());
  if (amb) {
    const scored = amb.candidates.map(cand => {
      const hits = (cand.contexts || []).filter(kw => ctxLower.includes(kw.toLowerCase())).length;
      return { conceptId: cand.conceptId, hits };
    });
    scored.sort((a, b) => b.hits - a.hits);
    const top = scored[0];
    const clear = top && top.hits > 0 && (scored.length === 1 || top.hits > scored[1].hits);
    if (clear) {
      return {
        resolved: true,
        conceptId: top.conceptId,
        tier: 'industry_standard',
        reason: 'ambiguous term disambiguated by context',
      };
    }
    return {
      resolved: false,
      conceptId: null,
      tier: 'unknown',
      reason: 'ambiguous term without disambiguating context',
      alternatives: amb.candidates.map(c => c.conceptId),
    };
  }

  return { resolved: false, conceptId: null, tier: 'unknown', reason: 'no match' };
}

function ruleAppliesToContext(rule, ctxLower) {
  const scope = String(rule.scope || 'venue-wide').toLowerCase();
  if (!scope || scope === 'venue-wide' || scope === 'all') return true;
  // scope of form "context:<keyword>" — require the keyword in ctx.
  if (scope.startsWith('context:')) {
    const kw = scope.slice(8).trim();
    return kw && ctxLower.includes(kw.toLowerCase());
  }
  // event:/promoter:/artist: scopes are handled at the calling site by
  // pre-filtering userRules. Treat as applies here.
  return true;
}

function tryParseJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// ── Merged / stratified view ────────────────────────────────────────────────

/**
 * Return a stratified view of what we know about a subject, layered by tier.
 * The caller supplies per-tier data (already loaded); this function does not
 * hit the network. This keeps the module test-friendly and lets callers
 * batch their sheet reads.
 *
 * @param {object} subject { conceptId?, term?, attributePath? }
 * @param {object} sources { showFacts, userRules, venueRules, observations }
 * @returns {{ layers: Array, resolvedValue: any, resolvedTier: string, alternatives: Array, conflicts: Array }}
 */
function mergedView(subject, sources = {}) {
  const layers = [];
  const conflicts = [];
  const { showFacts = [], userRules = [], venueRules = [], observations = [] } = sources;

  // show_specific
  showFacts.forEach(f => {
    if (matchesSubject(f, subject)) {
      layers.push({ tier: 'show_specific', value: f.value ?? f.newValue, from: f, note: f.note || '' });
    }
  });
  // user_instructed
  userRules.forEach(r => {
    if (matchesSubject(r, subject)) {
      layers.push({ tier: 'user_instructed', value: parseStatement(r.statement), from: r, note: r.note || '' });
    }
  });
  // venue_policy — VenueKnowledge rules
  venueRules.forEach(r => {
    if (matchesSubject(r, subject)) {
      layers.push({ tier: 'venue_policy', value: r.value, from: r, note: r.notes || '' });
    }
  });
  // historical_observation
  observations.forEach(o => {
    if (matchesSubject(o, subject)) {
      layers.push({ tier: 'historical_observation', value: o.value, from: o, note: o.notes || '' });
    }
  });
  // industry_standard
  if (subject.conceptId) {
    const c = getConcept(subject.conceptId);
    if (c) layers.push({ tier: 'industry_standard', value: c, from: c, note: c.description || '' });
  }

  layers.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);

  if (!layers.length) {
    return { layers: [], resolvedValue: null, resolvedTier: 'unknown', alternatives: [], conflicts: [] };
  }

  const top = layers[0];
  const alternatives = layers.slice(1);
  // Conflict = two DIFFERENT values within tiers that both purport to be authoritative
  // (show_specific vs user_instructed vs venue_policy).
  const authoritative = layers.filter(l => l.tier === 'show_specific' || l.tier === 'user_instructed' || l.tier === 'venue_policy');
  for (let i = 0; i < authoritative.length; i++) {
    for (let j = i + 1; j < authoritative.length; j++) {
      if (!valuesEqual(authoritative[i].value, authoritative[j].value)) {
        conflicts.push({ a: authoritative[i], b: authoritative[j] });
      }
    }
  }

  return {
    layers,
    resolvedValue: top.value,
    resolvedTier: top.tier,
    alternatives,
    conflicts,
  };
}

function matchesSubject(row, subject) {
  if (subject.conceptId && (row.conceptId === subject.conceptId || row.subject === subject.conceptId)) return true;
  if (subject.attributePath && row.attributePath === subject.attributePath) return true;
  if (subject.term && row.subject && String(row.subject).toLowerCase() === String(subject.term).toLowerCase()) return true;
  return false;
}

function valuesEqual(a, b) {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

function parseStatement(s) {
  const parsed = tryParseJSON(s);
  return parsed !== null ? parsed : s;
}

// ── User rules CRUD (sheet-backed) ──────────────────────────────────────────

async function ensureUserRulesSheet({ sheetsAdapter = sheetsLib } = {}) {
  if (!sheetsAdapter.ensureSheet || !sheetsAdapter.ensureHeaders) return;
  await sheetsAdapter.ensureSheet(USER_RULES_SHEET);
  await sheetsAdapter.ensureHeaders(USER_RULES_SHEET, [
    'id', 'kind', 'subject', 'statement', 'scope', 'note', 'addedBy', 'addedAt', 'updatedAt', 'status',
  ]);
}

async function loadUserRules({ sheetsAdapter = sheetsLib } = {}) {
  const rows = await sheetsAdapter.getRows(USER_RULES_SHEET);
  return (rows || []).filter(r => r && r.id && (!r.status || r.status === 'active'));
}

async function addUserRule(rule, actor, { sheetsAdapter = sheetsLib } = {}) {
  if (!USER_RULE_KINDS.includes(rule.kind)) throw new Error(`invalid rule kind: ${rule.kind}`);
  if (!rule.subject) throw new Error('subject required');
  if (rule.statement === undefined || rule.statement === null || rule.statement === '') throw new Error('statement required');
  const row = {
    id: randomUUID(),
    kind: rule.kind,
    subject: rule.subject,
    statement: typeof rule.statement === 'string' ? rule.statement : JSON.stringify(rule.statement),
    scope: rule.scope || 'venue-wide',
    note: rule.note || '',
    addedBy: actor?.email || actor?.name || 'system',
    addedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'active',
  };
  await sheetsAdapter.appendRow(USER_RULES_SHEET, row);
  return row;
}

async function updateUserRule(id, patch, actor, { sheetsAdapter = sheetsLib } = {}) {
  const rows = await sheetsAdapter.getRows(USER_RULES_SHEET);
  const row = rows.find(r => r.id === id);
  if (!row) throw new Error('rule not found');
  const next = {
    ...row,
    ...patch,
    statement: patch.statement !== undefined
      ? (typeof patch.statement === 'string' ? patch.statement : JSON.stringify(patch.statement))
      : row.statement,
    updatedAt: new Date().toISOString(),
  };
  await sheetsAdapter.updateRowById(USER_RULES_SHEET, id, next);
  return next;
}

async function deleteUserRule(id, { sheetsAdapter = sheetsLib } = {}) {
  await sheetsAdapter.deleteRowById(USER_RULES_SHEET, id);
}

module.exports = {
  TIERS,
  USER_RULE_KINDS,
  listDomains,
  listConcepts,
  getConcept,
  getWorkflow,
  listWorkflows,
  operationalConsequence,
  informationRequirements,
  resolveTerm,
  mergedView,
  ensureUserRulesSheet,
  loadUserRules,
  addUserRule,
  updateUserRule,
  deleteUserRule,
  _internals: { matchesSubject, valuesEqual, parseStatement, ruleAppliesToContext },
};
