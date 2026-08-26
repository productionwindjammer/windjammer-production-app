'use strict';

/**
 * Email Intelligence — read a thread of production emails as a CONVERSATION
 * (not isolated documents), extract structured production facts, and stage
 * them as PROPOSED changes for a production manager to approve.
 *
 * Design contract (independent of extractor implementation):
 *   • Every fact is `proposed` when first surfaced. Nothing overwrites
 *     authoritative show data automatically.
 *   • Every fact carries provenance: source message id, thread id, quoted
 *     excerpt, extractor name/version, extracted-at timestamp.
 *   • Every fact records a concise `reasoningSummary` (one line). We do NOT
 *     store private chain-of-thought.
 *   • Within a thread, later mentions supersede earlier ones. When a value
 *     changes, the fact records `previousValue` alongside `newValue`.
 *   • Show assignment is a first-class question. If the show is unknown, we
 *     say so — the system never guesses.
 *   • Conflicts (thread-internal, vs authoritative show data, vs venue
 *     capability) are detected explicitly and surfaced on the fact.
 *
 * The current extractor is deterministic rule-based (extractor='rules-v1').
 * The public entry point `analyzeThread` returns the same shape that a
 * future LLM extractor will emit, so downstream review UI and approval flow
 * do not change when the extractor is swapped.
 */

const sheets = require('./sheets');
const config = require('./config/server-config');
const venueKnowledge = require('./venueKnowledge');

const SHEET_FACTS   = config.googleSheets.sheets.emailFacts;
const SHEET_THREADS = config.googleSheets.sheets.emailThreads;
const SHEET_ISSUES  = config.googleSheets.sheets.emailIssues;

const EXTRACTOR = 'rules-v1';

// ── Field vocabulary ────────────────────────────────────────────────────────
// Each entry maps a canonical field name to:
//   • synonyms      — noun phrases that identify the field in prose
//   • type          — 'count' | 'time' | 'string' | 'bool' | 'list'
//   • category      — routing hint for downstream review (labor/hospitality/etc)
//   • advancePath   — dotted path on the Advancing/show record (for conflict check)
//   • venuePath     — venueKnowledge attribute path (for capability check)
//   • criticality   — 'critical' | 'normal'
//
// Numbers ≤ this many words apart from a synonym are considered attached.
const NUMBER_PROXIMITY_WORDS = 6;

const FIELD_VOCAB = {
  truck_count: {
    synonyms: ['truck','trucks','tractor-trailer','tractor-trailers','tractor trailer','53-footer','53 footer','53s'],
    type: 'count', category: 'transportation', advancePath: 'trucks',
  },
  bus_count: {
    synonyms: ['bus','buses','coach','coaches','tour bus','tour buses'],
    type: 'count', category: 'transportation', advancePath: 'buses',
  },
  van_count: {
    synonyms: ['van','vans','sprinter','sprinters'],
    type: 'count', category: 'transportation', advancePath: 'vans',
  },
  breakfast_count: {
    synonyms: ['breakfast','breakfasts'], type: 'count', category: 'hospitality',
    advancePath: 'catering.breakfast', venuePath: 'hospitality.catering.breakfast_count',
  },
  lunch_count: {
    synonyms: ['lunch','lunches'], type: 'count', category: 'hospitality',
    advancePath: 'catering.lunch', venuePath: 'hospitality.catering.lunch_count',
  },
  dinner_count: {
    synonyms: ['dinner','dinners'], type: 'count', category: 'hospitality',
    advancePath: 'catering.dinner', venuePath: 'hospitality.catering.dinner_count',
  },
  meal_count: {
    synonyms: ['meal','meals'], type: 'count', category: 'hospitality',
  },
  stagehand_count: {
    synonyms: ['stagehand','stagehands','hand','hands','loader','loaders','pusher','pushers'],
    type: 'count', category: 'labor', advancePath: 'labor.hands',
  },
  rigger_count: {
    synonyms: ['rigger','riggers','up-rigger','up riggers','ground rigger','ground riggers'],
    type: 'count', category: 'labor', advancePath: 'labor.riggers', venuePath: 'technical.rigging',
    criticality: 'critical',
  },
  electrician_count: {
    synonyms: ['electrician','electricians','house electrician'],
    type: 'count', category: 'labor', advancePath: 'labor.electricians',
  },
  forklift_count: {
    synonyms: ['forklift','forklifts','fork'],
    type: 'count', category: 'labor', advancePath: 'labor.forklifts',
  },
  parking_spaces: {
    synonyms: ['parking space','parking spaces','parking spot','parking spots','bus parking spot','bus parking spots'],
    type: 'count', category: 'parking', advancePath: 'parking.spaces',
    venuePath: 'operations.parking.bus_spaces',
  },
  credential_count: {
    synonyms: ['credential','credentials','laminate','laminates','all-access pass','all-access passes','all access pass','all access passes','working pass','working passes'],
    type: 'count', category: 'credentials', advancePath: 'credentials.count',
  },
  guest_list_count: {
    synonyms: ['guest list','guest-list','plus one','plus ones','plus-ones','GA ticket','GA tickets'],
    type: 'count', category: 'credentials', advancePath: 'guestList.count',
  },
  wireless_channels: {
    synonyms: ['wireless mic','wireless mics','wireless channel','wireless channels','RF channel','RF channels','IEM channel','IEM channels','IEM','IEMs'],
    type: 'count', category: 'technical', advancePath: 'audio.wirelessCount',
    venuePath: 'technical.rf.available_channels', criticality: 'critical',
  },
  line_array_boxes: {
    synonyms: ['line array box','line array boxes','box per side','boxes per side','K1','K1s','K2','K2s','V-DOSC','V DOSC'],
    type: 'count', category: 'technical', advancePath: 'audio.lineArrayBoxes',
    venuePath: 'technical.audio.line_array_boxes',
  },
  subwoofer_count: {
    synonyms: ['sub','subs','subwoofer','subwoofers','KS28','KS28s'],
    type: 'count', category: 'technical', advancePath: 'audio.subs',
    venuePath: 'technical.audio.subs',
  },
  moving_light_count: {
    synonyms: ['moving light','moving lights','mover','movers','spot','spots','wash','washes','profile','profiles'],
    type: 'count', category: 'technical', advancePath: 'lighting.movers',
    venuePath: 'technical.lighting.movers',
  },
  chain_motor_count: {
    synonyms: ['chain motor','chain motors','motor','motors','1-ton motor','1-ton motors','ton motor','ton motors'],
    type: 'count', category: 'technical', advancePath: 'rigging.motors',
    venuePath: 'technical.motors.count', criticality: 'critical',
  },
  power_amps: {
    synonyms: ['amp service','amps of service','A service','amp three-phase','A three-phase','A 3-phase','A of power','amps'],
    type: 'count', category: 'technical', advancePath: 'power.amps',
    venuePath: 'technical.power.stage_amps', criticality: 'critical',
  },
  shower_count: {
    synonyms: ['shower','showers'], type: 'count', category: 'hospitality',
    advancePath: 'hospitality.showers', venuePath: 'hospitality.showers.count',
  },
  dressing_room_count: {
    synonyms: ['dressing room','dressing rooms'], type: 'count', category: 'hospitality',
    advancePath: 'hospitality.dressingRooms',
  },
  loadin_time: {
    synonyms: ['load-in','load in','loadin','load-in time'],
    type: 'time', category: 'schedule', advancePath: 'schedule.loadIn',
  },
  soundcheck_time: {
    synonyms: ['soundcheck','sound check','sound-check'],
    type: 'time', category: 'schedule', advancePath: 'schedule.soundcheck',
  },
  doors_time: {
    synonyms: ['doors'], type: 'time', category: 'schedule', advancePath: 'schedule.doors',
  },
  show_time: {
    synonyms: ['show time','showtime','downbeat','set time','headliner start'],
    type: 'time', category: 'schedule', advancePath: 'schedule.showStart',
  },
  loadout_time: {
    synonyms: ['load-out','load out','loadout'], type: 'time', category: 'schedule',
    advancePath: 'schedule.loadOut',
  },
  curfew_time: {
    synonyms: ['curfew','hard curfew'], type: 'time', category: 'operations',
    advancePath: 'schedule.curfew', venuePath: 'operations.curfew.time', criticality: 'critical',
  },
  stage_size: {
    synonyms: ['stage','deck'], type: 'string', category: 'physical',
    advancePath: 'stage.size', venuePath: 'physical.stage.size',
  },
  pyro_requested: {
    synonyms: ['pyro','pyrotechnics','flame','flame effect','flame effects','confetti cannon','confetti cannons','CO2','CO2 jets'],
    type: 'bool', category: 'operations', venuePath: 'operations.fire_life_safety.pyro_permitted',
    criticality: 'critical',
  },
};

// ── Conversation-level markers ──────────────────────────────────────────────
// These are matched against sentences, not the whole message, so proximity to
// the field mention is what carries meaning.
const CORRECTION_MARKERS = [
  /\bactually,?\s*(?:make (?:that|it)|now|it'?s|let'?s (?:make|do))/i,
  /\bscratch that\b/i,
  /\bcorrection[:\-]/i,
  /\bupdate[:\-]/i,
  /\brevise (?:to|that to)\b/i,
  /\bchange (?:that )?to\b/i,
  /\bwe'?re (?:now (?:at|up to)|up to)\b/i,
  /\bnvm,?/i,
  /\bnever ?mind\b/i,
  /\bdisregard (?:my )?(?:previous|earlier|last)\b/i,
  /\b(?:let me|lemme) (?:correct|update|revise|amend)\b/i,
  /\bmake (?:that|it)\s+\d/i,
];

const REQUEST_MARKERS = [
  /\bplease\b/i, /\bneed(?:ed|s|ing)?\b/i, /\bcan (?:we|you|i) (?:get|have|add|book|hire)\b/i,
  /\brequesting\b/i, /\brequest\b/i, /\bcould (?:you|we)\b/i, /\bwould (?:you|it be possible)\b/i,
  /\bcan I get\b/i, /\bhoping (?:to|for)\b/i, /\blooking for\b/i,
];

const CONFIRM_MARKERS = [
  /\bconfirmed?\b/i, /\bconfirming\b/i, /\bwe'?re set\b/i, /\ball set\b/i,
  /\bgood to go\b/i, /\block(?:ed)? in\b/i, /\ball locked\b/i, /\bsounds good\b/i,
  /\bapproved\b/i, /\bworks for us\b/i,
];

const CHANGE_MARKERS = [
  /\bchange(?:d)?\b/i, /\bupdate(?:d)?\b/i, /\bmov(?:e|ed|ing)\b/i,
  /\bpush(?:ed|ing)? (?:back|forward|to)\b/i, /\bshift(?:ed|ing)?\b/i,
  /\bincreas(?:e|ed|ing)\b/i, /\bdecreas(?:e|ed|ing)\b/i,
  /\breduc(?:e|ed|ing)\b/i, /\bbump(?:ed|ing)? (?:up|to)\b/i,
];

const CONFLICT_MARKERS = [
  /\bthat doesn'?t work\b/i, /\bthat won'?t work\b/i, /\bwe can'?t\b/i,
  /\bimpossible\b/i, /\bconflict(?:s|ing)?\b/i, /\bnot possible\b/i,
];

const ROLE_SIGNATURE_HINTS = [
  { pattern: /\btour manager\b/i,          role: 'tour_manager' },
  { pattern: /\bproduction manager\b/i,    role: 'production_manager' },
  { pattern: /\bstage manager\b/i,         role: 'stage_manager' },
  { pattern: /\bfoh engineer\b|\bfoh mixer\b|\bfront of house\b/i, role: 'foh_engineer' },
  { pattern: /\bmonitor engineer\b/i,      role: 'monitor_engineer' },
  { pattern: /\blighting director\b|\bLD\b/, role: 'lighting_director' },
  { pattern: /\bpromoter\b/i,              role: 'promoter' },
  { pattern: /\bagent\b/i,                 role: 'agent' },
  { pattern: /\bcaterer\b|\bcatering\b/i,  role: 'caterer' },
  { pattern: /\btransportation coordinator\b|\btrucking coordinator\b/i, role: 'transportation' },
];

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Analyze an ordered thread. Does NOT write anything. Returns the structured
 * analysis result the review UI (and tests) consume.
 *
 * Input:
 *   messages          — [{ id, threadId, from, fromName, to?, subject, date, body }]
 *   shows             — [{ id, name, artist, date, ... }] (optional; enables show detection)
 *   existingShowData  — {} keyed by advancePath, current authoritative values (optional)
 *
 * Output shape is stable and documented in the return literal below.
 */
async function analyzeThread({ messages = [], shows = [], existingShowData = {}, threadContext = null } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return emptyAnalysis('no_messages');
  }

  const ordered = [...messages].sort(sortByDate);
  const threadId = ordered[0].threadId || ordered[0].id;

  // ── (1) Show assignment ─────────────────────────────────────────────────
  const showAssignment = identifyShow(ordered, shows, threadContext);

  // ── (2..7) Per-message extraction ───────────────────────────────────────
  const perMessage = ordered.map(msg => analyzeMessage(msg));

  // ── Thread-level rollup: supersede earlier facts with later ones ────────
  const factsBySlot = new Map(); // key = `${field}:${scope}` → fact
  const facts = [];

  for (const m of perMessage) {
    for (const raw of m.rawFacts) {
      const slot = `${raw.field}:${raw.scope || 'default'}`;
      const prior = factsBySlot.get(slot);
      const fact = buildFact(raw, m, prior, threadId);
      factsBySlot.set(slot, fact);
    }
  }
  for (const f of factsBySlot.values()) facts.push(f);

  // Detect conflicts against authoritative show data and venue capability.
  for (const fact of facts) {
    fact.conflicts = await detectConflicts(fact, existingShowData);
    fact.criticality = fact.conflicts.some(c => c.critical) ? 'critical' : (fact.criticality || 'normal');
    fact.recommendedAction = recommendAction(fact);
  }

  // Aggregate thread-level issues (deadlines, unresolved questions, risks).
  const issues = perMessage.flatMap(m => m.issues.map(i => ({ ...i, messageId: m.messageId })));

  return {
    threadId,
    subject: ordered[0].subject || '',
    participants: uniqueParticipants(ordered),
    messageCount: ordered.length,
    firstMessageAt: ordered[0].date || null,
    lastMessageAt:  ordered[ordered.length - 1].date || null,
    showAssignment,
    facts,
    issues,
    perMessage: perMessage.map(m => ({
      messageId: m.messageId,
      from:      m.from,
      sender:    m.sender,
      intents:   m.intents,
      excerpts:  m.excerpts.slice(0, 4),
    })),
    extractor: EXTRACTOR,
    analyzedAt: new Date().toISOString(),
  };
}

/**
 * Analyze a single message in isolation (no thread rollup). Useful for
 * incoming-mail webhooks.
 */
function analyzeMessage(msg) {
  const sender  = identifySender(msg);
  const sents   = splitSentences(msg.body || '');
  const intents = classifyIntents(sents);
  const rawFacts = [];
  for (const s of sents) {
    rawFacts.push(...extractFactsFromSentence(s, msg));
  }
  const issues = detectIssues(sents, msg, intents);
  return {
    messageId: msg.id,
    threadId:  msg.threadId || msg.id,
    from:      msg.from,
    sender,
    intents,
    rawFacts,
    issues,
    excerpts:  sents.filter(s => rawFacts.some(f => f.excerpt === s)).slice(0, 5),
    date:      msg.date,
    subject:   msg.subject,
  };
}

/**
 * Persist an analysis: writes/updates the thread row and appends any facts
 * as PROPOSED. Never touches authoritative show sheets.
 */
async function proposeFromAnalysis(analysis, { actor = 'ai:email-intel' } = {}) {
  if (!analysis || !analysis.threadId) throw new Error('analysis missing threadId');

  await upsertThread({
    id:            analysis.threadId,
    subject:       analysis.subject,
    showId:        analysis.showAssignment?.showId || '',
    showConfidence:analysis.showAssignment?.confidence ?? '',
    participants:  JSON.stringify(analysis.participants || []),
    firstMessageAt:analysis.firstMessageAt || '',
    lastMessageAt: analysis.lastMessageAt || '',
    messageCount:  String(analysis.messageCount || 0),
    lastAnalyzedAt:new Date().toISOString(),
    status:        analysis.showAssignment?.showId ? 'assigned' : 'unassigned',
  });

  // Idempotent write: if the same (messageId, field, scope) has already been
  // proposed for this show, skip it. Re-analyzing a thread must never
  // produce duplicate facts. Dedupe is by source message + field + scope so
  // that later thread analyses can still legitimately supersede earlier
  // facts (different messageId), while re-runs on the same messages are
  // no-ops.
  const showIdCol = analysis.showAssignment?.showId || '';
  const existing  = await sheets.getRows(SHEET_FACTS);
  const seen = new Set(existing.map(r =>
    `${r.messageId || ''}|${r.field || ''}|${r.scope || 'default'}|${r.showId || ''}`,
  ));

  const written = [];
  const skipped = [];
  for (const fact of analysis.facts) {
    const key = `${fact.messageId || ''}|${fact.field || ''}|${fact.scope || 'default'}|${showIdCol}`;
    if (seen.has(key)) { skipped.push(key); continue; }
    seen.add(key);
    const row = flattenFact(fact, { threadId: analysis.threadId, showId: showIdCol, actor });
    await sheets.appendRow(SHEET_FACTS, row);
    written.push(row);
  }

  const existingIssues = await sheets.getRows(SHEET_ISSUES);
  const seenIssues = new Set(existingIssues.map(r =>
    `${r.messageId || ''}|${r.kind || ''}|${r.excerpt || ''}|${r.showId || ''}`,
  ));
  for (const issue of analysis.issues) {
    const key = `${issue.messageId || ''}|${issue.kind || ''}|${issue.excerpt || ''}|${showIdCol}`;
    if (seenIssues.has(key)) continue;
    seenIssues.add(key);
    await sheets.appendRow(SHEET_ISSUES, flattenIssue(issue, {
      threadId: analysis.threadId,
      showId:   showIdCol,
      actor,
    }));
  }
  return { threadId: analysis.threadId, facts: written, issueCount: analysis.issues.length, skippedDuplicates: skipped.length };
}

async function listQueue({ status = 'proposed', showId = null, threadId = null } = {}) {
  const rows = await sheets.getRows(SHEET_FACTS);
  return rows.filter(r =>
    (status  ? r.status  === status  : true) &&
    (showId  ? r.showId  === showId  : true) &&
    (threadId? r.threadId === threadId: true),
  );
}

async function getFactById(id) {
  const rows = await sheets.getRows(SHEET_FACTS);
  return rows.find(r => String(r.id) === String(id)) || null;
}

async function approveFact(id, actor, note = '') {
  const fact = await getFactById(id);
  if (!fact) { const e = new Error('not_found'); e.code = 'not_found'; throw e; }
  if (fact.status !== 'proposed') { const e = new Error(`cannot approve fact in status '${fact.status}'`); e.code = 'invalid_state'; throw e; }
  await sheets.updateRowById(SHEET_FACTS, id, {
    status: 'approved', decidedBy: actor, decidedAt: new Date().toISOString(), decisionNote: note,
  });
  // Approving a fact that changes an existing slot supersedes prior approved facts on the same slot.
  const rows = await sheets.getRows(SHEET_FACTS);
  const slot = `${fact.field}:${fact.scope || 'default'}`;
  for (const r of rows) {
    if (String(r.id) === String(id)) continue;
    if (`${r.field}:${r.scope || 'default'}` !== slot) continue;
    if (r.showId !== fact.showId) continue;
    if (r.status !== 'approved') continue;
    await sheets.updateRowById(SHEET_FACTS, r.id, { status: 'superseded', supersededBy: id, decidedAt: new Date().toISOString() });
  }
  return { ...fact, status: 'approved' };
}

async function rejectFact(id, actor, note = '') {
  const fact = await getFactById(id);
  if (!fact) { const e = new Error('not_found'); e.code = 'not_found'; throw e; }
  if (fact.status !== 'proposed') { const e = new Error(`cannot reject fact in status '${fact.status}'`); e.code = 'invalid_state'; throw e; }
  await sheets.updateRowById(SHEET_FACTS, id, {
    status: 'rejected', decidedBy: actor, decidedAt: new Date().toISOString(), decisionNote: note,
  });
  return { ...fact, status: 'rejected' };
}

// ── Sender / show identification ────────────────────────────────────────────

function identifySender(msg) {
  const from      = (msg.from || '').trim();
  const fromName  = (msg.fromName || parseNameFromFrom(from) || '').trim();
  const email     = parseEmailFromFrom(from);
  const domain    = (email.split('@')[1] || '').toLowerCase();
  const roleHint  = detectRoleFromSignature(msg.body || '');
  return {
    email,
    name:   fromName,
    domain,
    role:   roleHint || null,
    known:  Boolean(email),
  };
}

function detectRoleFromSignature(body) {
  const tail = body.split('\n').slice(-15).join('\n');
  for (const h of ROLE_SIGNATURE_HINTS) {
    if (h.pattern.test(tail) || h.pattern.test(body)) return h.role;
  }
  return null;
}

function parseEmailFromFrom(from) {
  const m = from.match(/<([^>]+)>/);
  if (m) return m[1].trim();
  const m2 = from.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return m2 ? m2[0].trim() : '';
}

function parseNameFromFrom(from) {
  const m = from.match(/^([^<]+)</);
  if (m) return m[1].trim().replace(/^"|"$/g, '');
  return '';
}

/**
 * Show assignment. NEVER guesses. Returns { showId, confidence, reason,
 * alternatives } and if there is no confident match, showId is null and the
 * caller must route this thread to the "unassigned" queue.
 */
function identifyShow(messages, shows, threadContext) {
  if (threadContext && threadContext.showId) {
    return { showId: threadContext.showId, confidence: 1.0, reason: 'thread_previously_assigned', alternatives: [] };
  }
  if (!Array.isArray(shows) || shows.length === 0) {
    return { showId: null, confidence: 0, reason: 'no_shows_available', alternatives: [] };
  }
  const hay = messages.map(m => `${m.subject || ''}\n${m.body || ''}`).join('\n').toLowerCase();
  const scored = shows.map(show => {
    let score = 0;
    const reasons = [];
    const name   = (show.name   || '').toLowerCase();
    const artist = (show.artist || '').toLowerCase();
    if (artist && hay.includes(artist)) { score += 3; reasons.push('artist_name'); }
    if (name   && name !== artist && hay.includes(name)) { score += 2; reasons.push('show_name'); }
    if (show.date && hay.includes(show.date.toLowerCase())) { score += 2; reasons.push('date_iso'); }
    if (show.date) {
      const spoken = formatSpokenDate(show.date);
      if (spoken && hay.includes(spoken.toLowerCase())) { score += 2; reasons.push('date_spoken'); }
    }
    return { show, score, reasons };
  }).filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { showId: null, confidence: 0, reason: 'no_show_signals_in_thread', alternatives: [] };
  const top = scored[0];
  const next = scored[1];

  // If top is uniquely ahead by a real margin, assign. Otherwise stay unassigned.
  if (top.score >= 3 && (!next || top.score - next.score >= 2)) {
    return {
      showId:     top.show.id,
      showName:   top.show.name || top.show.artist || '',
      confidence: Math.min(0.98, 0.6 + 0.08 * top.score),
      reason:     top.reasons.join('+'),
      alternatives: scored.slice(1, 4).map(x => ({ showId: x.show.id, score: x.score, reasons: x.reasons })),
    };
  }
  return {
    showId: null,
    confidence: 0,
    reason: 'ambiguous_multiple_candidates',
    alternatives: scored.slice(0, 4).map(x => ({ showId: x.show.id, score: x.score, reasons: x.reasons, showName: x.show.name || x.show.artist || '' })),
  };
}

function formatSpokenDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const monthIdx = Number(m[2]) - 1;
  const day  = Number(m[3]);
  return `${months[monthIdx]} ${day}`;
}

// ── Intent classification ───────────────────────────────────────────────────

function classifyIntents(sentences) {
  const set = new Set();
  for (const s of sentences) {
    if (REQUEST_MARKERS.some(r => r.test(s)))    set.add('request');
    if (CONFIRM_MARKERS.some(r => r.test(s)))    set.add('confirmation');
    if (CHANGE_MARKERS.some(r => r.test(s)) ||
        CORRECTION_MARKERS.some(r => r.test(s))) set.add('change');
    if (/\?/.test(s))                            set.add('question');
    if (CONFLICT_MARKERS.some(r => r.test(s)))   set.add('conflict_signal');
    if (DEADLINE_REGEX.test(s))                  set.add('deadline');
  }
  return [...set];
}

// ── Fact extraction ─────────────────────────────────────────────────────────

function extractFactsFromSentence(sentence, msg) {
  const facts = [];
  const isCorrection = CORRECTION_MARKERS.some(r => r.test(sentence));
  const isRequest    = REQUEST_MARKERS.some(r => r.test(sentence));
  const isConfirm    = CONFIRM_MARKERS.some(r => r.test(sentence));

  for (const [field, spec] of Object.entries(FIELD_VOCAB)) {
    if (spec.type === 'count')  facts.push(...extractCountFact(sentence, field, spec, msg, { isCorrection, isRequest, isConfirm }));
    if (spec.type === 'time')   facts.push(...extractTimeFact(sentence, field, spec, msg, { isCorrection, isRequest, isConfirm }));
    if (spec.type === 'bool')   facts.push(...extractBoolFact(sentence, field, spec, msg, { isCorrection, isRequest, isConfirm }));
  }
  return facts;
}

function extractCountFact(sentence, field, spec, msg, ctx) {
  const out = [];
  for (const syn of spec.synonyms) {
    // Look for `<number> <synonym>` or `<synonym> <verb-ish> <number>` within proximity.
    const numNearSyn = numberNearWord(sentence, syn, NUMBER_PROXIMITY_WORDS);
    if (numNearSyn == null) continue;
    out.push(makeRaw({
      field, value: numNearSyn, unit: 'count', category: spec.category,
      synonym: syn, excerpt: sentence.trim(), msg, ctx, criticality: spec.criticality,
      advancePath: spec.advancePath, venuePath: spec.venuePath,
    }));
    break; // one synonym match per field per sentence
  }
  return out;
}

function extractTimeFact(sentence, field, spec, msg, ctx) {
  const out = [];
  for (const syn of spec.synonyms) {
    if (!new RegExp(`\\b${escapeRegex(syn)}\\b`, 'i').test(sentence)) continue;
    const time = findTimeNearWord(sentence, syn);
    if (!time) continue;
    out.push(makeRaw({
      field, value: time, unit: 'time', category: spec.category,
      synonym: syn, excerpt: sentence.trim(), msg, ctx, criticality: spec.criticality,
      advancePath: spec.advancePath, venuePath: spec.venuePath,
    }));
    break;
  }
  return out;
}

function extractBoolFact(sentence, field, spec, msg, ctx) {
  const out = [];
  for (const syn of spec.synonyms) {
    if (!new RegExp(`\\b${escapeRegex(syn)}\\b`, 'i').test(sentence)) continue;
    const negation = /\b(no|not|without|no need for|can'?t|cannot|will not|won'?t)\b[^.]{0,30}\b$/i;
    const localSlice = sentence.slice(Math.max(0, sentence.toLowerCase().indexOf(syn.toLowerCase()) - 30), sentence.toLowerCase().indexOf(syn.toLowerCase()) + syn.length + 10);
    const value = negation.test(localSlice) ? false : true;
    out.push(makeRaw({
      field, value, unit: 'bool', category: spec.category, synonym: syn,
      excerpt: sentence.trim(), msg, ctx, criticality: spec.criticality,
      advancePath: spec.advancePath, venuePath: spec.venuePath,
    }));
    break;
  }
  return out;
}

function makeRaw({ field, value, unit, category, synonym, excerpt, msg, ctx, criticality, advancePath, venuePath }) {
  return {
    field,
    value,
    unit,
    category,
    scope: 'default',
    synonym,
    excerpt,
    messageId: msg.id,
    threadId:  msg.threadId || msg.id,
    messageDate: msg.date,
    isCorrection: !!ctx.isCorrection,
    isRequest:    !!ctx.isRequest,
    isConfirm:    !!ctx.isConfirm,
    criticality:  criticality || 'normal',
    advancePath, venuePath,
    from: msg.from,
  };
}

function buildFact(raw, msgAnalysis, prior, threadId) {
  // Base confidence: 0.7 baseline, +0.15 for explicit correction/confirm, -0.15 if hedged.
  let confidence = 0.7;
  if (raw.isCorrection || raw.isConfirm) confidence += 0.15;
  if (raw.isRequest && !raw.isCorrection && !raw.isConfirm) confidence += 0.05;
  if (/\bmaybe\b|\bpossibly\b|\bnot sure\b|\btbd\b|\btentative\b/i.test(raw.excerpt)) confidence -= 0.15;
  if (msgAnalysis.sender.role) confidence += 0.05; // clearer accountability
  confidence = Math.max(0.3, Math.min(0.99, Number(confidence.toFixed(2))));

  const previousValue = prior ? prior.newValue : null;
  const kind = raw.isConfirm ? 'confirmation'
             : raw.isRequest ? 'request'
             : raw.isCorrection ? 'correction'
             : previousValue !== null && previousValue !== undefined && String(previousValue) !== String(raw.value)
               ? 'change'
               : 'assertion';

  const reasoning = buildReasoningSummary({ raw, prior, previousValue, kind, sender: msgAnalysis.sender });

  return {
    id:            `fact_${Date.now()}${Math.random().toString(36).slice(2,6)}`,
    threadId,
    messageId:     raw.messageId,
    field:         raw.field,
    category:      raw.category,
    scope:         raw.scope,
    kind,
    previousValue: previousValue,
    newValue:      raw.value,
    unit:          raw.unit,
    status:        'proposed',
    confidence,
    criticality:   raw.criticality,
    advancePath:   raw.advancePath || null,
    venuePath:     raw.venuePath   || null,
    sender:        msgAnalysis.sender,
    provenance: {
      sourceMessageId: raw.messageId,
      sourceThreadId:  threadId,
      sourceExcerpt:   raw.excerpt,
      sourceFrom:      raw.from,
      sourceDate:      raw.messageDate,
      extractor:       EXTRACTOR,
      synonymMatched:  raw.synonym,
      extractedAt:     new Date().toISOString(),
    },
    reasoningSummary: reasoning,
    conflicts: [], // filled in by detectConflicts()
  };
}

function buildReasoningSummary({ raw, prior, previousValue, kind, sender }) {
  const who = sender.role ? sender.role.replace('_',' ')
            : sender.name || sender.email || 'sender';
  if (kind === 'correction') {
    return `${who} explicitly corrected ${humanField(raw.field)} to ${humanValue(raw.value, raw.unit)}${previousValue != null ? ` (previously ${humanValue(previousValue, raw.unit)})` : ''}.`;
  }
  if (kind === 'change') {
    return `${who} restated ${humanField(raw.field)} as ${humanValue(raw.value, raw.unit)}, superseding earlier value ${humanValue(previousValue, raw.unit)}.`;
  }
  if (kind === 'request') {
    return `${who} requested ${humanField(raw.field)} = ${humanValue(raw.value, raw.unit)}.`;
  }
  if (kind === 'confirmation') {
    return `${who} confirmed ${humanField(raw.field)} = ${humanValue(raw.value, raw.unit)}.`;
  }
  return `${who} stated ${humanField(raw.field)} = ${humanValue(raw.value, raw.unit)}.`;
}

function humanField(field) { return field.replace(/_/g, ' '); }
function humanValue(v, unit) { if (v == null) return '—'; if (unit === 'time') return v; if (unit === 'bool') return v ? 'yes' : 'no'; return String(v); }

// ── Issue detection ─────────────────────────────────────────────────────────

const DEADLINE_REGEX = /\b(by|before|no later than|EOD|COB|end of day|close of business)\b[^.]{0,60}/i;

function detectIssues(sentences, msg, intents) {
  const issues = [];
  for (const s of sentences) {
    if (/\?/.test(s)) {
      issues.push({ kind: 'question', excerpt: s.trim(), from: msg.from, date: msg.date });
    }
    const dl = s.match(DEADLINE_REGEX);
    if (dl) {
      issues.push({ kind: 'deadline', excerpt: s.trim(), phrase: dl[0], from: msg.from, date: msg.date });
    }
    if (CONFLICT_MARKERS.some(r => r.test(s))) {
      issues.push({ kind: 'conflict_signal', excerpt: s.trim(), from: msg.from, date: msg.date });
    }
    if (/\b(if|assuming|depends on|contingent on|pending)\b/i.test(s)) {
      issues.push({ kind: 'dependency', excerpt: s.trim(), from: msg.from, date: msg.date });
    }
    if (/\b(risk|concern|worried|problem|issue|blocker)\b/i.test(s)) {
      issues.push({ kind: 'risk', excerpt: s.trim(), from: msg.from, date: msg.date });
    }
  }
  return issues;
}

// ── Conflict detection ─────────────────────────────────────────────────────

async function detectConflicts(fact, existingShowData) {
  const conflicts = [];

  if (fact.advancePath && existingShowData) {
    const current = getPath(existingShowData, fact.advancePath);
    if (current !== undefined && current !== null && current !== '' && String(current) !== String(fact.newValue)) {
      conflicts.push({
        kind: 'authoritative_show_data',
        path: fact.advancePath,
        current,
        proposed: fact.newValue,
        critical: fact.criticality === 'critical',
      });
    }
  }

  if (fact.venuePath) {
    try {
      const r = await venueKnowledge.analyzeCapability({
        category:      fact.category,
        attributePath: fact.venuePath,
        requestedValue: fact.newValue,
        unit:          fact.unit === 'count' ? undefined : fact.unit,
        criticality:   fact.criticality,
      });
      if (r.matches === 'no' || r.matches === 'partial') {
        conflicts.push({
          kind: 'venue_capability',
          path: fact.venuePath,
          matches: r.matches,
          gap: r.gap,
          critical: r.critical,
          needsVendor: r.needsVendor,
        });
      } else if (r.matches === 'unknown' && r.critical) {
        conflicts.push({
          kind: 'venue_capability_unknown',
          path: fact.venuePath,
          critical: true,
          note: 'safety-critical venue capability is not on file',
        });
      }
    } catch (err) {
      // Never let a venue-knowledge failure suppress the fact; surface as info.
      conflicts.push({ kind: 'venue_check_failed', path: fact.venuePath, error: err.message, critical: false });
    }
  }

  return conflicts;
}

function recommendAction(fact) {
  if (fact.conflicts.some(c => c.critical))            return 'escalate_to_admin';
  if (fact.conflicts.some(c => c.kind === 'authoritative_show_data')) return 'review_conflict_with_current_show';
  if (fact.conflicts.some(c => c.kind === 'venue_capability' && (c.needsVendor || c.matches === 'no'))) return 'book_vendor_to_cover_shortfall';
  if (fact.kind === 'correction' || fact.kind === 'change') return 'update_show_record';
  if (fact.kind === 'confirmation') return 'mark_confirmed';
  if (fact.kind === 'request')      return 'add_to_show_record';
  return 'review_and_approve';
}

// ── Persistence adapters ────────────────────────────────────────────────────

function flattenFact(fact, { threadId, showId, actor }) {
  return {
    id:              fact.id,
    threadId,
    showId:          showId || '',
    messageId:       fact.messageId,
    field:           fact.field,
    category:        fact.category,
    scope:           fact.scope,
    kind:            fact.kind,
    previousValue:   fact.previousValue == null ? '' : JSON.stringify(fact.previousValue),
    newValue:        JSON.stringify(fact.newValue),
    unit:            fact.unit || '',
    status:          fact.status,
    confidence:      String(fact.confidence),
    criticality:     fact.criticality,
    advancePath:     fact.advancePath || '',
    venuePath:       fact.venuePath   || '',
    senderEmail:     fact.sender?.email || '',
    senderName:      fact.sender?.name  || '',
    senderRole:      fact.sender?.role  || '',
    sourceExcerpt:   fact.provenance.sourceExcerpt,
    sourceFrom:      fact.provenance.sourceFrom,
    sourceDate:      fact.provenance.sourceDate || '',
    extractor:       fact.provenance.extractor,
    reasoningSummary:fact.reasoningSummary,
    conflicts:       JSON.stringify(fact.conflicts || []),
    recommendedAction: fact.recommendedAction || '',
    createdAt:       new Date().toISOString(),
    createdBy:       actor,
    decidedBy:       '',
    decidedAt:       '',
    decisionNote:    '',
    supersededBy:    '',
  };
}

function flattenIssue(issue, { threadId, showId, actor }) {
  return {
    id:        `issue_${Date.now()}${Math.random().toString(36).slice(2,6)}`,
    threadId,
    showId:    showId || '',
    messageId: issue.messageId || '',
    kind:      issue.kind,
    excerpt:   issue.excerpt || '',
    phrase:    issue.phrase  || '',
    from:      issue.from    || '',
    date:      issue.date    || '',
    status:    'open',
    createdAt: new Date().toISOString(),
    createdBy: actor,
  };
}

async function upsertThread(row) {
  const existing = await sheets.getRows(SHEET_THREADS);
  if (existing.find(r => String(r.id) === String(row.id))) {
    await sheets.updateRowById(SHEET_THREADS, row.id, row);
  } else {
    await sheets.appendRow(SHEET_THREADS, row);
  }
}

// ── Small utilities ─────────────────────────────────────────────────────────

function sortByDate(a, b) { return (a.date || '').localeCompare(b.date || ''); }

function uniqueParticipants(messages) {
  const seen = new Set();
  const out = [];
  for (const m of messages) {
    const email = parseEmailFromFrom(m.from || '');
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, name: m.fromName || parseNameFromFrom(m.from || '') });
  }
  return out;
}

function splitSentences(text) {
  if (!text) return [];
  return text
    .replace(/\r\n/g, '\n')
    .split(/(?<=[.!?])\s+|\n{2,}|\n(?=[A-Z0-9])/)
    .map(s => s.trim())
    .filter(Boolean);
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function numberNearWord(sentence, word, proximityWords) {
  // Case-insensitive scan. Returns the closest integer within N word-tokens of `word`.
  const lower = sentence.toLowerCase();
  const wordL = word.toLowerCase();
  const idx = lower.indexOf(wordL);
  if (idx < 0) return null;
  const window = 60; // characters, roughly proximityWords * ~9
  const start = Math.max(0, idx - window);
  const end   = Math.min(sentence.length, idx + wordL.length + window);
  const slice = sentence.slice(start, end);
  const numMatches = [...slice.matchAll(/\b(\d{1,4})\b/g)];
  if (numMatches.length === 0) return null;
  // Choose the number closest to the synonym's local position.
  const synLocal = idx - start;
  let best = null;
  let bestDist = Infinity;
  for (const m of numMatches) {
    const dist = Math.abs(m.index - synLocal);
    if (dist < bestDist) { best = m[1]; bestDist = dist; }
  }
  return best == null ? null : Number(best);
}

const TIME_REGEX = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|AM|PM)\b|\b([01]?\d|2[0-3]):([0-5]\d)\b/;

function findTimeNearWord(sentence, word) {
  const lower = sentence.toLowerCase();
  const wordL = word.toLowerCase();
  const idx = lower.indexOf(wordL);
  if (idx < 0) return null;
  const start = Math.max(0, idx - 40);
  const end   = Math.min(sentence.length, idx + wordL.length + 40);
  const m = sentence.slice(start, end).match(TIME_REGEX);
  if (!m) return null;
  if (m[4] != null) {
    return `${String(m[4]).padStart(2, '0')}:${m[5]}`;
  }
  let hh = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && hh < 12) hh += 12;
  if (ap === 'am' && hh === 12) hh = 0;
  return `${String(hh).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function getPath(obj, path) {
  if (!obj || !path) return undefined;
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

function emptyAnalysis(reason) {
  return {
    threadId: null, subject: '', participants: [], messageCount: 0,
    firstMessageAt: null, lastMessageAt: null,
    showAssignment: { showId: null, confidence: 0, reason, alternatives: [] },
    facts: [], issues: [], perMessage: [],
    extractor: EXTRACTOR, analyzedAt: new Date().toISOString(),
  };
}

module.exports = {
  analyzeThread, analyzeMessage,
  proposeFromAnalysis,
  listQueue, getFactById, approveFact, rejectFact,
  identifySender, identifyShow, classifyIntents,
  // Exposed for tests
  _internals: {
    FIELD_VOCAB, CORRECTION_MARKERS, REQUEST_MARKERS, CONFIRM_MARKERS, DEADLINE_REGEX,
    splitSentences, numberNearWord, findTimeNearWord, extractFactsFromSentence,
  },
};
