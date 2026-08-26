'use strict';

/**
 * Show Brief — the production manager's AI workspace for a single show.
 *
 * Composes the 12 spec-mandated sections deterministically from existing
 * state:
 *   1. AI SHOW BRIEF        (2–3 sentence operational summary)
 *   2. WHAT CHANGED         (AiChangeLog + AiCorrections since a cutoff)
 *   3. NEEDS ATTENTION      (advancementEngine priorities.critical + high)
 *   4. CONFLICTS            (facts with conflicts + rule conflicts)
 *   5. MISSING INFORMATION  (industry standardInfoRequired minus what's on file)
 *   6. WAITING ON           (pending facts + rule waitingOn)
 *   7. RECOMMENDED ACTIONS  (advancementEngine + top-level heuristics)
 *   8. RECENT EMAIL INTEL   (newest EmailFacts + EmailIssues)
 *   9. PROPOSED FORM UPDATES(pending EmailFacts + factMapping.preview)
 *  10. VENUE IMPACT         (venueKnowledge.analyzeCapability for each request)
 *  11. DOCUMENTS            (expected doc types + ArtistDocuments status)
 *  12. ADVANCEMENT HISTORY  (AiChangeLog + corrections timeline)
 *
 * Every item carries a `sources` array so the UI can drill from the summary
 * → underlying fact → source email/document/rule. No chain-of-thought is
 * exposed — sources are the evidence.
 *
 * The output is a pure JSON structure. No LLM, no free-text hallucination.
 */

const sheetsReal      = require('./sheets');
const config          = require('./config/server-config');
const advancement     = require('./advancementEngine');
const venueKnowledge  = require('./venueKnowledge');
const factMapping     = require('./factMapping');
const industry        = require('./industryKnowledge');

const SHEETS = config.googleSheets.sheets;

// The system's epistemic taxonomy. Every item surfaced by this module must
// carry exactly one of these on `claimType`. The UI displays a badge so the
// PM can tell at a glance whether a line is verified truth, a derivation,
// an actionable prompt, an industry-standard fallback, or a known gap.
//   FACT           — recorded in a sheet with a source row (email/audit/document)
//   INFERENCE      — derived by our engine from one or more facts; not itself recorded
//   RECOMMENDATION — an action the PM should consider taking
//   ASSUMPTION     — an industry-standard fallback used because no venue rule/fact exists
//   UNKNOWN        — information that is missing; the ABSENCE of a source
const CLAIM = Object.freeze({
  FACT: 'fact',
  INFERENCE: 'inference',
  RECOMMENDATION: 'recommendation',
  ASSUMPTION: 'assumption',
  UNKNOWN: 'unknown',
});

// Industry standard field → the ONE Show/Advance/Schedule surface where a
// PM would look for it. Also used to derive "missing information".
const STANDARD_FIELD_TARGETS = {
  showTime:        { field: 'show_time',        label: 'Show time',        where: 'Shows.showTime' },
  doorsTime:       { field: 'doors_time',       label: 'Doors time',       where: 'Shows.doorsTime' },
  loadInTime:      { field: 'loadin_time',      label: 'Load-in time',     where: 'Schedule (Load-In)' },
  soundcheckTime:  { field: 'soundcheck_time',  label: 'Soundcheck time',  where: 'Schedule (Sound Check)' },
  curfewTime:      { field: 'curfew_time',      label: 'Curfew',           where: 'Advancing.curfew' },
  loadOutTime:     { field: 'loadout_time',     label: 'Load-out time',    where: 'Schedule (Load-Out)' },
  wirelessChannels:{ field: 'wireless_channels',label: 'Wireless channels',where: 'Advancing.productionNeeds' },
  chainMotorCount: { field: 'chain_motor_count',label: 'Chain motors',     where: 'Advancing.productionNeeds' },
  truckCount:      { field: 'truck_count',      label: 'Truck count',      where: 'Advancing.notes' },
  busCount:        { field: 'bus_count',        label: 'Bus count',        where: 'Advancing.notes' },
  parkingSpaces:   { field: 'parking_spaces',   label: 'Parking spaces',   where: 'Advancing.notes' },
  guestListCount:  { field: 'guest_list_count', label: 'Guest list count', where: 'Advancing.hospitalityNotes' },
  mealCounts:      { field: 'meal_count',       label: 'Meal counts',      where: 'Advancing.cateringNotes' },
  dressingRoomCount:{field: 'dressing_room_count',label:'Dressing rooms',  where: 'Advancing.hospitalityNotes' },
  hospitalityRider:{ field: null,               label: 'Hospitality rider',where: 'ArtistDocuments (hospitality)' },
  technicalRider:  { field: null,               label: 'Technical rider',  where: 'ArtistDocuments (rider)' },
  stagePlot:       { field: null,               label: 'Stage plot',       where: 'ArtistDocuments (stage_plot)' },
  inputList:       { field: null,               label: 'Input list',       where: 'ArtistDocuments (input_list)' },
};

const DOC_EXPECTATIONS = [
  { key: 'rider',           label: 'Technical rider',         matches: ['rider','technical rider','tech rider'] },
  { key: 'hospitality',     label: 'Hospitality rider',       matches: ['hospitality','hosp rider'] },
  { key: 'stage_plot',      label: 'Stage plot',              matches: ['stage plot','plot'] },
  { key: 'input_list',      label: 'Input list',              matches: ['input list','channel list','input sheet'] },
  { key: 'rig_plot',        label: 'Rig plot',                matches: ['rig plot','rigging plot','hang plot','weight plot'] },
  { key: 'lighting_plot',   label: 'Lighting plot',           matches: ['lighting plot','light plot','lx plot'] },
  { key: 'schedule',        label: 'Production schedule',     matches: ['schedule','day sheet','day of show'] },
];

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Build the brief for a single show.
 *
 * @param {string} showId
 * @param {object} opts
 * @param {object} opts.sheetsAdapter override for tests
 * @param {string} opts.since ISO date; WHAT CHANGED cutoff (default: now - 14d)
 * @param {string} opts.now ISO date; test override
 */
async function buildBrief(showId, opts = {}) {
  const sheetsAdapter = opts.sheetsAdapter || sheetsReal;
  const now = opts.now || new Date().toISOString();
  const since = opts.since || new Date(new Date(now).getTime() - 14 * 24 * 3600 * 1000).toISOString();

  const state = await advancement.buildShowState(showId, { sheetsAdapter, now });
  const evaluation = await advancement.evaluate(state);

  const [changeLog, corrections, artistDocuments, showContacts, showAsks] = await Promise.all([
    sheetsAdapter.getRows(SHEETS.aiChangeLog).catch(() => []),
    sheetsAdapter.getRows(SHEETS.aiCorrections).catch(() => []),
    sheetsAdapter.getRows(SHEETS.artistDocuments).catch(() => []),
    sheetsAdapter.getRows(SHEETS.showContacts).catch(() => []),
    sheetsAdapter.getRows(SHEETS.showAsks).catch(() => []),
  ]);

  const showChanges = changeLog.filter(r => String(r.showId) === String(showId));
  const showCorrections = corrections.filter(r => String(r.showId) === String(showId));
  const contactsForShow = showContacts.filter(r => String(r.showId) === String(showId));
  const asksForShow = showAsks.filter(r => String(r.showId) === String(showId));

  // Per-section isolation: if one builder throws (e.g. a malformed row in one
  // sheet), we return a degraded section rather than 500ing the whole brief.
  // A PM opening this page during a live show cannot be blocked by a single
  // broken row somewhere in the workspace.
  const safe = (label, fn) => {
    try { return fn(); }
    catch (err) {
      console.error(`[showBrief] section "${label}" failed:`, err.message);
      return { items: [], error: 'section_unavailable', message: err.message };
    }
  };
  const safeAsync = async (label, fn) => {
    try { return await fn(); }
    catch (err) {
      console.error(`[showBrief] section "${label}" failed:`, err.message);
      return { items: [], error: 'section_unavailable', message: err.message };
    }
  };

  const whatChanged        = safe('whatChanged',        () => buildWhatChanged(showChanges, showCorrections, since));
  const needsAttention     = safe('needsAttention',     () => buildNeedsAttention(evaluation, state));
  const conflicts          = safe('conflicts',          () => buildConflicts(evaluation, state));
  const missingInformation = safe('missingInformation', () => buildMissingInformation(state));
  const waitingOn          = safe('waitingOn',          () => buildWaitingOn(evaluation, state, asksForShow, now));
  const keyContacts        = safe('keyContacts',        () => buildKeyContacts(contactsForShow));
  const loadInPlan         = safe('loadInPlan',         () => buildLoadInPlan(state));
  const recentEmailIntel   = safe('recentEmailIntel',   () => buildRecentEmailIntel(state));
  const proposedFormUpdates= await safeAsync('proposedFormUpdates', () => buildProposedFormUpdates(state, sheetsAdapter));
  const venueImpact        = await safeAsync('venueImpact',         () => buildVenueImpact(state));
  const documents          = safe('documents',          () => buildDocuments(showId, artistDocuments));
  const advancementHistory = safe('advancementHistory', () => buildAdvancementHistory(showChanges, showCorrections));
  const recommendedActions = safe('recommendedActions', () => buildRecommendedActions(evaluation, {
    needsAttention, conflicts, missingInformation, proposedFormUpdates, waitingOn, venueImpact, documents,
  }));
  const aiShowBrief        = safe('aiShowBrief', () => composeSummary(state, evaluation, {
    needsAttention, conflicts, missingInformation, proposedFormUpdates, waitingOn,
  }));

  return {
    showId,
    show: state.show || null,
    generatedAt: now,
    windowSince: since,
    aiShowBrief,
    whatChanged,
    needsAttention,
    conflicts,
    missingInformation,
    waitingOn,
    recommendedActions,
    recentEmailIntel,
    proposedFormUpdates,
    venueImpact,
    documents,
    advancementHistory,
    keyContacts,
    loadInPlan,
    // Small counters for at-a-glance UI headers.
    readiness: evaluation.readiness,
    status: evaluation.status,
  };
}

// ── Section builders ───────────────────────────────────────────────────────

function buildWhatChanged(showChanges, showCorrections, since) {
  const items = [];
  for (const c of showChanges) {
    if (c.at && c.at < since) continue;
    if (c.status && c.status !== 'applied') continue;
    items.push({
      id: c.id,
      claimType: CLAIM.FACT,
      text: `${humanField(c.field)}: ${displayValue(c.previousValue)} → ${displayValue(c.newValue)}`,
      at: c.at,
      approvedBy: c.approvedBy,
      changeCategory: c.changeCategory,
      sources: [changeSource(c)],
    });
  }
  for (const k of showCorrections) {
    if (k.at && k.at < since) continue;
    items.push({
      id: k.id,
      claimType: CLAIM.FACT,
      text: `${k.actor} corrected ${humanField(k.field)}: AI said ${displayValue(k.aiValue)}, actual ${displayValue(k.correctedValue)}`,
      at: k.at,
      correctionType: k.correctionType,
      sources: [correctionSource(k)],
    });
  }
  items.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  return items;
}

function buildNeedsAttention(evaluation) {
  const items = [];
  for (const r of (evaluation.priorities?.critical || [])) {
    items.push({
      id: r.id, claimType: CLAIM.RECOMMENDATION,
      tier: 'critical', title: r.title, text: r.reason || r.explanation,
      status: r.status, action: r.action, deadline: r.deadline,
      sources: [ruleSource(r)],
    });
  }
  for (const r of (evaluation.priorities?.high || [])) {
    items.push({
      id: r.id, claimType: CLAIM.RECOMMENDATION,
      tier: 'high', title: r.title, text: r.reason || r.explanation,
      status: r.status, action: r.action, deadline: r.deadline,
      sources: [ruleSource(r)],
    });
  }
  return items;
}

function buildConflicts(evaluation, state) {
  const items = [];
  for (const r of (evaluation.conflicts || [])) {
    items.push({
      id: r.id, claimType: CLAIM.INFERENCE,
      title: r.title, text: r.reason,
      action: r.action || 'PM must resolve',
      sources: [ruleSource(r)],
    });
  }
  const factConflicts = (state.recentFacts || []).filter(f =>
    (Array.isArray(f.conflicts) && f.conflicts.length > 0) || f.status === 'conflict',
  );
  for (const f of factConflicts) {
    items.push({
      id: `fact:${f.id}`,
      claimType: CLAIM.INFERENCE,
      title: humanField(f.field),
      text: `Conflicting information detected for ${humanField(f.field)}. PM must resolve.`,
      sources: [factSource(f)],
    });
  }
  return items;
}

function buildMissingInformation(state) {
  const items = [];
  const requirements = industry.informationRequirements('show_advance');
  const shows = state.show || {};
  const advance = state.advance || {};
  const schedule = state.schedule || [];
  const approved = state.approvedFacts || {};

  for (const key of requirements) {
    const target = STANDARD_FIELD_TARGETS[key];
    if (!target) continue;
    if (hasValueOnFormOrFact(key, target, shows, advance, schedule, approved)) continue;
    items.push({
      id: `missing:${key}`,
      claimType: CLAIM.UNKNOWN,
      key,
      label: target.label,
      where: target.where,
      text: `${target.label} not on file.`,
      sources: [], // no source — this is the ABSENCE of a source.
    });
  }
  return items;
}

function hasValueOnFormOrFact(key, target, show, advance, schedule, approved) {
  const emptyish = (v) => v === undefined || v === null || v === '';
  if (key === 'showTime')      return !emptyish(show.showTime);
  if (key === 'doorsTime')     return !emptyish(show.doorsTime);
  if (key === 'curfewTime')    return !emptyish(advance.curfew) || approved.curfew_time;
  if (key === 'loadInTime')    return schedule.some(s => /load[- ]?in/i.test(s.label || s.name || ''));
  if (key === 'soundcheckTime')return schedule.some(s => /sound ?check/i.test(s.label || s.name || ''));
  if (key === 'loadOutTime')   return schedule.some(s => /load[- ]?out/i.test(s.label || s.name || ''));
  if (target.field && approved[target.field]) return true;
  if (target.field && new RegExp(`\\b${target.field}\\b`, 'i').test(concatAdvance(advance))) return true;
  return false;
}

function concatAdvance(a) {
  if (!a) return '';
  return [a.riderNotes, a.productionNeeds, a.backlineNotes, a.cateringNotes, a.hospitalityNotes, a.localCrewNeeds, a.stagingChanges, a.notes].filter(Boolean).join(' ');
}

function buildWaitingOn(evaluation, state, asks = [], nowIso) {
  const items = [];
  // PM-tracked explicit asks are FACTs (someone typed them). Overdue ones
  // still count as FACTs — the fact that they're overdue is INFERENCEd from
  // dueBy vs today, so we surface both.
  const today = (nowIso || new Date().toISOString()).slice(0, 10);
  for (const a of asks) {
    if (a.status === 'received' || a.status === 'cancelled') continue;
    const overdue = a.dueBy && a.dueBy < today;
    items.push({
      id: `ask:${a.id}`,
      claimType: CLAIM.FACT,
      text: `${a.item}${a.askedOf ? ` — asked ${a.askedOf}` : ''}${a.dueBy ? ` (due ${a.dueBy})` : ''}${overdue ? ' — OVERDUE' : ''}`,
      askedOf: a.askedOf || '',
      askedAt: a.askedAt || '',
      dueBy: a.dueBy || '',
      overdue: !!overdue,
      source: a.source || 'manual',
      sources: [{ kind: 'showAsk', id: a.id, label: a.item }],
    });
  }
  for (const w of (evaluation.waitingOn || [])) {
    if (w.kind === 'email_fact') {
      const fact = (state.pendingFacts || []).find(f => f.field === w.field && f.threadId === w.threadId);
      items.push({
        id: `waiting:fact:${fact?.id || w.field}`,
        claimType: CLAIM.INFERENCE,
        from: w.from,
        text: `Waiting on ${w.from || 'sender'} for ${humanField(w.field)}.`,
        why: w.why,
        sources: fact ? [factSource(fact)] : [],
      });
    } else {
      items.push({
        id: `waiting:${w.ruleId}`,
        claimType: CLAIM.INFERENCE,
        text: w.why,
        sources: [{ kind: 'rule', id: w.ruleId, label: w.ruleId }],
      });
    }
  }
  return items;
}

// Critical seats every professional advance needs filled. Missing = UNKNOWN.
// One-of alternatives (either Tour Manager OR Tour Production Manager
// counts for the "who runs the tour side" seat) live in the second slot.
const CRITICAL_CONTACT_ROLES = [
  { label: 'Tour Manager', alt: ['Tour Manager', 'Tour Production Manager'] },
  { label: 'Promoter Rep', alt: ['Promoter Rep'] },
  { label: 'FOH Engineer', alt: ['FOH Engineer', 'House Sound'] },
];

function buildKeyContacts(contacts) {
  const items = [];
  const seenRoles = new Set();
  for (const c of contacts) {
    if (!c.name && !c.phone && !c.email) continue;
    items.push({
      id: `contact:${c.id}`,
      claimType: CLAIM.FACT,
      role: c.role || 'Unspecified',
      name: c.name || '',
      phone: c.phone || '',
      email: c.email || '',
      isPrimary: c.isPrimary === 'true',
      notes: c.notes || '',
      text: `${c.role || 'Contact'}: ${c.name || '—'}${c.phone ? ` · ${c.phone}` : ''}${c.email ? ` · ${c.email}` : ''}`,
      sources: [{ kind: 'showContact', id: c.id, label: c.role || c.name }],
    });
    seenRoles.add(String(c.role || '').toLowerCase());
  }
  for (const req of CRITICAL_CONTACT_ROLES) {
    const filled = req.alt.some(r => seenRoles.has(r.toLowerCase()));
    if (!filled) {
      items.push({
        id: `contact:missing:${req.label}`,
        claimType: CLAIM.UNKNOWN,
        role: req.label,
        text: `${req.label} not on the call sheet.`,
        sources: [],
      });
    }
  }
  return items;
}

function buildLoadInPlan(state) {
  const items = [];
  const a = state.advance || {};
  const push = (id, claim, text, extra = {}) => items.push({ id, claimType: claim, text, ...extra, sources: [{ kind: 'advance', id: a.id || 'advance', label: 'Advancing' }] });

  if (a.loadInStart)  push('loadin:start', CLAIM.FACT, `Load-in start: ${a.loadInStart}`);
  else                push('loadin:start', CLAIM.UNKNOWN, 'Load-in start time not on file.');
  if (a.loadOutEnd)   push('loadin:end',   CLAIM.FACT, `Load-out end: ${a.loadOutEnd}`);
  else                push('loadin:end',   CLAIM.UNKNOWN, 'Load-out end time not on file.');

  const trucks = a.truckCount === '' || a.truckCount == null ? null : Number(a.truckCount);
  if (trucks == null) push('loadin:trucks', CLAIM.UNKNOWN, 'Truck count not on file.');
  else                push('loadin:trucks', CLAIM.FACT, `Trucks: ${trucks}`, { value: trucks });

  const buses = a.busCount === '' || a.busCount == null ? null : Number(a.busCount);
  if (buses == null)  push('loadin:buses', CLAIM.UNKNOWN, 'Bus count not on file.');
  else                push('loadin:buses', CLAIM.FACT, `Tour buses: ${buses}`, { value: buses });

  const sp = a.hasShorePower || 'unknown';
  if (sp === 'unknown' || sp === '') {
    push('loadin:shorepower', CLAIM.UNKNOWN, 'Bus shore power availability not confirmed.');
  } else if (sp === 'yes') {
    push('loadin:shorepower', CLAIM.FACT, 'Bus shore power available.');
  } else if (sp === 'no') {
    push('loadin:shorepower', CLAIM.FACT, 'Bus shore power NOT available — generator required.');
  } else if (sp === 'n/a') {
    push('loadin:shorepower', CLAIM.FACT, 'Shore power not applicable (no buses).');
  }

  if (buses != null && buses > 0 && sp !== 'yes' && sp !== 'n/a') {
    items.push({
      id: 'loadin:bus-generator-risk',
      claimType: CLAIM.INFERENCE,
      text: `${buses} bus(es) expected on site${sp === 'no' ? ' with no shore power — expect all-night generator noise and possible neighbor complaints.' : ' but shore power is unconfirmed — confirm before load-in.'}`,
      sources: [{ kind: 'advance', id: a.id || 'advance', label: 'Advancing' }],
    });
  }
  if (a.dockAccess) {
    push('loadin:dock', CLAIM.FACT, `Dock/access notes: ${a.dockAccess}`);
  }
  return items;
}

async function buildProposedFormUpdates(state, sheetsAdapter) {
  const pending = state.pendingFacts || [];
  const items = [];
  for (const f of pending) {
    let preview = null;
    try {
      preview = await factMapping.preview({
        ...f,
        newValue: f.newValue,
        conflicts: f.conflicts || [],
      }, { sheetsAdapter });
    } catch { /* preview failures are non-fatal */ }
    items.push({
      id: f.id,
      claimType: CLAIM.INFERENCE,
      field: f.field,
      humanField: humanField(f.field),
      current: preview?.currentValue ?? null,
      proposed: preview?.proposedValue ?? f.newValue,
      risk: preview?.risk || 'unknown',
      status: preview?.status || 'pending_review',
      reason: preview?.reason || f.reasoningSummary,
      confidence: preview?.confidence,
      sources: [factSource(f)],
    });
  }
  return items;
}

function buildRecentEmailIntel(state) {
  const facts = (state.recentFacts || []).slice().sort((a, b) => (b.sourceDate || '').localeCompare(a.sourceDate || ''));
  const issues = (state.emailIssues || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const items = [];
  const seenThreads = new Set();
  for (const f of facts.slice(0, 8)) {
    if (f.threadId) seenThreads.add(f.threadId);
    items.push({
      id: `intel:fact:${f.id}`,
      claimType: CLAIM.FACT,
      text: `${humanField(f.field)}: ${displayValue(f.newValue)} — ${f.senderName || f.senderEmail || 'unknown sender'}`,
      excerpt: f.sourceExcerpt,
      at: f.sourceDate,
      sources: [factSource(f)],
    });
  }
  for (const i of issues.slice(0, 6)) {
    if (i.threadId) seenThreads.add(i.threadId);
    items.push({
      id: `intel:issue:${i.id}`,
      claimType: CLAIM.INFERENCE,
      text: `${i.kind}: ${i.excerpt || i.phrase || ''}`,
      at: i.date,
      sources: [issueSource(i)],
    });
  }
  // Surface linked emails that haven't produced structured facts/issues yet
  // so the PM sees the bot IS aware of them as source material. Grouped by
  // gmailThreadId → one row per thread with the newest subject/from/snippet.
  const linked = (state.linkedEmails || []).slice();
  const byThread = new Map();
  for (const e of linked) {
    const tid = e.gmailThreadId || e.threadId || e.id;
    if (!tid || seenThreads.has(tid)) continue;
    const cur = byThread.get(tid);
    if (!cur || (e.date || '') > (cur.date || '')) byThread.set(tid, e);
  }
  for (const e of [...byThread.values()].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 6)) {
    items.push({
      id: `intel:email:${e.id}`,
      claimType: CLAIM.UNKNOWN,
      text: `Linked email — ${e.subject || '(no subject)'} — ${e.from || 'unknown sender'}`,
      excerpt: e.snippet || '',
      at: e.date,
      sources: [emailSource(e)],
    });
  }
  return items;
}

async function buildVenueImpact(state) {
  const items = [];
  const facts = { ...(state.approvedFacts || {}) };
  const factList = Object.entries(facts).map(([field, f]) => ({ field, fact: f }));

  const impactFields = [
    { field: 'chain_motor_count',  path: 'technical.motors.total',    label: 'Chain motors' },
    { field: 'rigger_count',       path: 'labor.riggers.available',   label: 'Riggers' },
    { field: 'wireless_channels',  path: 'technical.rf.channels',     label: 'Wireless channels' },
    { field: 'power_amps',         path: 'technical.power.amps',      label: 'Power (amps)' },
    { field: 'line_array_boxes',   path: 'technical.audio.la_boxes',  label: 'Line array boxes' },
    { field: 'meal_count',         path: 'hospitality.catering.meals',label: 'Meals' },
    { field: 'parking_spaces',     path: 'operations.parking.spaces', label: 'Parking spaces' },
    { field: 'truck_count',        path: 'physical.dock.trucks',      label: 'Trucks' },
    { field: 'bus_count',          path: 'physical.parking.buses',    label: 'Buses' },
    { field: 'pyro_requested',     path: 'operations.fire_life_safety.pyro', label: 'Pyro' },
  ];

  for (const map of impactFields) {
    const entry = factList.find(x => x.field === map.field);
    if (!entry) continue;
    let analysis = null;
    try {
      analysis = await venueKnowledge.analyzeCapability({
        attributePath: map.path,
        requestedValue: entry.fact.newValue,
      });
    } catch { /* ignore */ }
    if (!analysis) continue;
    // A venue rule is a FACT; a critical unknown is an UNKNOWN gap; anything
    // else (industry-standard fallback) is an ASSUMPTION.
    const claimType = analysis.known
      ? CLAIM.FACT
      : (analysis.critical ? CLAIM.UNKNOWN : CLAIM.ASSUMPTION);
    items.push({
      id: `impact:${map.field}`,
      claimType,
      title: map.label,
      requested: entry.fact.newValue,
      matches: analysis.matches,
      known: analysis.known,
      critical: !!analysis.critical,
      needsAction: !!analysis.needsAction,
      needsVendor: !!analysis.needsVendor,
      reason: analysis.reason,
      capability: analysis.capability,
      sources: [factSource(entry.fact), ...(analysis.sources || []).map(s => ({ kind: 'venue_rule', id: s.id || '', label: s.label || 'venue rule' }))],
    });
  }
  return items;
}

function buildDocuments(showId, artistDocuments) {
  const items = [];
  const docs = (artistDocuments || []).filter(d => matchesShow(d, showId));
  for (const spec of DOC_EXPECTATIONS) {
    const match = docs.find(d => spec.matches.some(m => matchesTag(d, m)));
    if (match) {
      items.push({
        id: `doc:${spec.key}`,
        claimType: CLAIM.FACT,
        label: spec.label,
        status: 'present',
        fileName: match.name || match.fileName,
        uploadedAt: match.uploadedAt || match.createdAt,
        sources: [{ kind: 'document', id: match.id, label: match.name || spec.label, fileId: match.fileId || '' }],
      });
    } else {
      items.push({
        id: `doc:${spec.key}`,
        claimType: CLAIM.UNKNOWN,
        label: spec.label,
        status: 'missing',
        sources: [],
      });
    }
  }
  return items;
}

function matchesShow(doc, showId) {
  if (!showId) return true;
  if (doc.showId && String(doc.showId) === String(showId)) return true;
  return false; // artist-scoped docs handled by caller if needed
}

function matchesTag(doc, tag) {
  const t = String(tag).toLowerCase();
  return String(doc.category || doc.type || doc.kind || doc.name || '').toLowerCase().includes(t);
}

function buildAdvancementHistory(showChanges, showCorrections) {
  const items = [];
  for (const c of showChanges) {
    items.push({
      id: c.id,
      claimType: CLAIM.FACT,
      at: c.at,
      kind: 'change',
      text: `Applied ${humanField(c.field)}: ${displayValue(c.previousValue)} → ${displayValue(c.newValue)}`,
      by: c.approvedBy,
      sources: [changeSource(c)],
    });
  }
  for (const k of showCorrections) {
    items.push({
      id: k.id,
      claimType: CLAIM.FACT,
      at: k.at,
      kind: 'correction',
      text: `${k.actor} corrected ${humanField(k.field)} to ${displayValue(k.correctedValue)}`,
      by: k.actor,
      sources: [correctionSource(k)],
    });
  }
  items.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  return items;
}

function buildRecommendedActions(evaluation, sections) {
  const items = [];
  // Advance engine's per-rule actions come first (they carry tier already).
  for (const a of (evaluation.recommendedActions || [])) {
    items.push({
      id: `action:${a.ruleId}`,
      claimType: CLAIM.RECOMMENDATION,
      text: a.action,
      why: a.why,
      tier: a.tier,
      sources: [{ kind: 'rule', id: a.ruleId, label: a.ruleId }],
    });
  }
  // Top-level heuristics.
  if (sections.conflicts.length > 0) {
    items.push({
      id: 'action:resolve_conflicts',
      claimType: CLAIM.RECOMMENDATION,
      text: `Resolve ${sections.conflicts.length} open conflict${sections.conflicts.length === 1 ? '' : 's'}.`,
      tier: 'critical',
      sources: sections.conflicts.flatMap(c => c.sources).slice(0, 3),
    });
  }
  if (sections.proposedFormUpdates.length > 0) {
    items.push({
      id: 'action:review_proposals',
      claimType: CLAIM.RECOMMENDATION,
      text: `Review ${sections.proposedFormUpdates.length} pending AI proposal${sections.proposedFormUpdates.length === 1 ? '' : 's'}.`,
      tier: 'medium',
      sources: sections.proposedFormUpdates.flatMap(p => p.sources).slice(0, 3),
    });
  }
  if (sections.missingInformation.length > 0) {
    items.push({
      id: 'action:fill_missing',
      claimType: CLAIM.RECOMMENDATION,
      text: `Fill ${sections.missingInformation.length} missing baseline field${sections.missingInformation.length === 1 ? '' : 's'}.`,
      tier: 'high',
      sources: [],
    });
  }
  if (sections.waitingOn.length > 0) {
    items.push({
      id: 'action:follow_up',
      claimType: CLAIM.RECOMMENDATION,
      text: `Follow up on ${sections.waitingOn.length} outstanding thread${sections.waitingOn.length === 1 ? '' : 's'}.`,
      tier: 'medium',
      sources: sections.waitingOn.flatMap(w => w.sources).slice(0, 3),
    });
  }
  if (sections.documents.some(d => d.status === 'missing')) {
    const missing = sections.documents.filter(d => d.status === 'missing');
    items.push({
      id: 'action:request_documents',
      claimType: CLAIM.RECOMMENDATION,
      text: `Request ${missing.length} missing document${missing.length === 1 ? '' : 's'}: ${missing.map(d => d.label).join(', ')}.`,
      tier: 'high',
      sources: [],
    });
  }
  return items;
}

// ── The AI Show Brief (short summary paragraph) ───────────────────────────
// Deterministic, source-grounded. NO free-form generation.

function composeSummary(state, evaluation, sections) {
  const s = state.show || {};
  const parts = [];
  const artist = s.artist || s.eventName || '(unknown artist)';
  const date = s.date || 'date TBD';
  parts.push(`${artist} on ${date} — ${statusText(evaluation.status)}.`);

  const criticalCount = evaluation.priorities?.critical?.length || 0;
  const conflictCount = sections.conflicts.length;
  const missingCount  = sections.missingInformation.length;
  const proposalCount = sections.proposedFormUpdates.length;
  const waitingCount  = sections.waitingOn.length;

  const bullets = [];
  if (criticalCount)  bullets.push(`${criticalCount} safety- or schedule-critical item${criticalCount === 1 ? '' : 's'} unresolved`);
  if (conflictCount)  bullets.push(`${conflictCount} conflict${conflictCount === 1 ? '' : 's'} pending PM resolution`);
  if (proposalCount)  bullets.push(`${proposalCount} AI proposal${proposalCount === 1 ? '' : 's'} awaiting review`);
  if (missingCount)   bullets.push(`${missingCount} baseline field${missingCount === 1 ? '' : 's'} not on file`);
  if (waitingCount)   bullets.push(`waiting on ${waitingCount} outstanding item${waitingCount === 1 ? '' : 's'}`);
  if (bullets.length) parts.push(bullets.join('; ') + '.');
  else                parts.push('No open items surface at this time.');

  const linkedCount = (state.linkedEmails || []).length;
  if (linkedCount) {
    parts.push(`${linkedCount} email${linkedCount === 1 ? '' : 's'} linked to this show inform this brief.`);
  }

  return { claimType: CLAIM.INFERENCE, text: parts.join(' '), asOf: state.now };
}

function statusText(status) {
  switch (status) {
    case 'blocked':               return 'blocked by unresolved critical items';
    case 'in_progress':           return 'advancing';
    case 'ready_pending_review':  return 'ready pending review';
    case 'advanced':              return 'fully advanced';
    case 'not_started':           return 'not yet advanced';
    default:                      return status || 'in unknown state';
  }
}

// ── Source builders ────────────────────────────────────────────────────────

function factSource(f) {
  return {
    kind: 'fact', id: f.id, factId: f.id,
    threadId: f.threadId || '', messageId: f.sourceMessageId || '',
    excerpt: f.sourceExcerpt || '', from: f.senderName || f.senderEmail || '',
    at: f.sourceDate || '',
    ref: f.threadId ? `/email?thread=${encodeURIComponent(f.threadId)}` : `/email-intel?showId=${encodeURIComponent(f.showId || '')}`,
  };
}
function changeSource(c) {
  return {
    kind: 'change', id: c.id, changeId: c.id,
    threadId: c.sourceThreadId || '', messageId: c.sourceMessageId || '',
    excerpt: c.sourceExcerpt || '', at: c.at,
    ref: c.sourceThreadId ? `/email?thread=${encodeURIComponent(c.sourceThreadId)}` : '',
  };
}
function correctionSource(k) {
  return { kind: 'correction', id: k.id, at: k.at, actor: k.actor, ref: '/venue-knowledge-review' };
}
function ruleSource(r) {
  return { kind: 'rule', id: r.id, label: r.title || r.id, ref: '' };
}
function issueSource(i) {
  return {
    kind: 'issue', id: i.id, threadId: i.threadId || '',
    excerpt: i.excerpt || i.phrase || '', at: i.date,
    ref: i.threadId ? `/email?thread=${encodeURIComponent(i.threadId)}` : '',
  };
}
function emailSource(e) {
  const tid = e.gmailThreadId || e.threadId || '';
  return {
    kind: 'email', id: e.id, threadId: tid, messageId: e.gmailMessageId || '',
    excerpt: e.snippet || '', from: e.from || '', at: e.date || '',
    ref: tid ? `/email?thread=${encodeURIComponent(tid)}` : `/email`,
  };
}

// ── Formatting helpers ────────────────────────────────────────────────────

function humanField(f) {
  if (!f) return '';
  return String(f).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function displayValue(v) {
  if (v == null || v === '') return '—';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

module.exports = {
  buildBrief,
  CLAIM_TYPES: CLAIM,
  _internals: { buildMissingInformation, buildWhatChanged, composeSummary, humanField },
};
