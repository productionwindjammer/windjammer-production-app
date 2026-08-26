'use strict';

/**
 * Show Advancement Intelligence
 *
 * Answers: "What does the PM need to know and do to advance THIS show?"
 *
 * Design principles:
 *   • No naive % complete. Advancement is expressed as a set of unresolved
 *     rules bucketed by operational-impact tier (critical/high/medium/low).
 *   • Requirements are dynamic. Every rule declares `applies(state)`; the
 *     engine skips rules that don't apply. An acoustic gig does NOT inherit
 *     an arena rigging checklist.
 *   • Every requirement carries an `explanation` — a one-line reason WHY it
 *     applies to this show. The PM should never have to guess.
 *   • State is composed from multiple tiers: show record + advance record +
 *     schedule + labor + vendor bookings + venue knowledge + APPROVED email
 *     facts. Proposed (unreviewed) email facts surface as "waiting on".
 *   • Overall status reflects unresolved operational RISK, not field count.
 *
 * The engine is stateless: `evaluate(state)` is pure. `buildShowState(...)`
 * composes state from the live sheets (with an injectable adapter for tests).
 */

const sheetsReal    = require('./sheets');
const config        = require('./config/server-config');
const venueKnowledge = require('./venueKnowledge');

const SHEETS = config.googleSheets.sheets;

// ── Signal detection ────────────────────────────────────────────────────────
// Advance rows store free prose in riderNotes/productionNeeds/etc. Signals
// tell us which requirement clusters apply to this show. A signal returns
// `{ applies, because }` so the engine can print the reason.

function concatAdvanceProse(advance) {
  if (!advance) return '';
  return [
    advance.riderNotes, advance.productionNeeds, advance.backlineNotes,
    advance.stagingChanges, advance.cateringNotes, advance.hospitalityNotes,
    advance.localCrewNeeds, advance.soundRestrictions, advance.notes,
  ].filter(Boolean).join('\n').toLowerCase();
}

function signal(applies, because) { return applies ? { applies: true, because } : { applies: false }; }

function factExists(state, field) {
  return state.approvedFacts && state.approvedFacts[field] != null;
}

function factValue(state, field) {
  return state.approvedFacts?.[field]?.newValue;
}

function hasRiggingSignal(state) {
  const prose = concatAdvanceProse(state.advance);
  if (/\b(rigging|hang points?|chain motors?|truss hangs?|flying rig|1[- ]ton motors?|motor points?)\b/.test(prose))
    return signal(true, 'rider prose mentions rigging');
  if (factExists(state, 'chain_motor_count')) return signal(true, `email fact: ${factValue(state,'chain_motor_count')} chain motors`);
  if (factExists(state, 'rigger_count'))      return signal(true, `email fact: ${factValue(state,'rigger_count')} riggers requested`);
  return signal(false);
}

function hasRfSignal(state) {
  const prose = concatAdvanceProse(state.advance);
  if (/\b(wireless|iem|in[- ]ear|rf coordination|rf channel|shure psm|sennheiser g[34])\b/.test(prose))
    return signal(true, 'rider prose mentions wireless/RF');
  if (factExists(state, 'wireless_channels')) return signal(true, `email fact: ${factValue(state,'wireless_channels')} wireless channels`);
  return signal(false);
}

function hasTruckSignal(state) {
  const prose = concatAdvanceProse(state.advance);
  if (/\b(semi[- ]truck|tractor[- ]trailer|53[- ]?footer|\d+\s+trucks?|\d+\s+buses?)\b/.test(prose))
    return signal(true, 'rider prose mentions trucks or buses');
  if (factExists(state, 'truck_count')) return signal(true, `email fact: ${factValue(state,'truck_count')} trucks`);
  if (factExists(state, 'bus_count'))   return signal(true, `email fact: ${factValue(state,'bus_count')} buses`);
  return signal(false);
}

function hasCateringSignal(state) {
  const prose = concatAdvanceProse(state.advance);
  if (advanceField(state.advance, 'cateringNotes'))
    return signal(true, 'advance has catering notes');
  if (/\b(catering|meals?|dinners?|lunches?|breakfasts?|buy[- ]?out|per[- ]?diem|dietary)\b/.test(prose))
    return signal(true, 'rider prose mentions catering');
  if (factExists(state, 'dinner_count') || factExists(state, 'lunch_count') || factExists(state, 'breakfast_count') || factExists(state, 'meal_count'))
    return signal(true, 'email facts include meal counts');
  return signal(false);
}

function hasPyroSignal(state) {
  const prose = concatAdvanceProse(state.advance);
  if (/\b(pyro|pyrotechnics?|flame effects?|confetti cannon|co2 jets?)\b/.test(prose))
    return signal(true, 'rider prose mentions pyro/flame/CO2');
  if (factValue(state, 'pyro_requested') === true) return signal(true, 'email fact: pyro requested');
  return signal(false);
}

function hasPowerSignal(state) {
  const prose = concatAdvanceProse(state.advance);
  if (/\b(\d{2,3})\s*(?:amp|a)\s*(?:service|three[- ]phase|3[- ]phase)?\b/.test(prose))
    return signal(true, 'rider prose mentions amp service');
  if (/\b(cam[- ]?lock|three[- ]phase|shore power|generator)\b/.test(prose))
    return signal(true, 'rider prose mentions cam-lock/three-phase/shore power');
  if (factExists(state, 'power_amps')) return signal(true, `email fact: ${factValue(state,'power_amps')}A`);
  return signal(false);
}

function hasMovingLightSignal(state) {
  const prose = concatAdvanceProse(state.advance);
  if (/\b(moving lights?|movers?|profiles?|washes|spot ops?|follow spots?)\b/.test(prose))
    return signal(true, 'rider prose mentions moving lights');
  if (factExists(state, 'moving_light_count')) return signal(true, `email fact: ${factValue(state,'moving_light_count')} movers`);
  return signal(false);
}

function advanceField(advance, key) { return advance && advance[key] && String(advance[key]).trim() !== ''; }

// ── Rule catalog ────────────────────────────────────────────────────────────
// Each rule owns: id, category, tier, applies(state), check(state).
// `check` returns { status, reason, evidence?, waitingOn?, deadline?, action? }.
//   status ∈ 'confirmed' | 'open' | 'missing' | 'conflict' | 'risk'
//   The engine attaches `explanation` from applies().because so the PM sees WHY.

const RULES = [
  // ── Baseline ───────────────────────────────────────────────────────────
  {
    id: 'baseline.show_date',
    category: 'baseline', tier: 'critical',
    title: 'Show date confirmed',
    applies: () => signal(true, 'every show needs a date'),
    check(state) {
      const d = state.show?.date;
      return d
        ? { status: 'confirmed', reason: `date is ${d}` }
        : { status: 'missing',   reason: 'no date on file', action: 'set show date' };
    },
  },
  {
    id: 'baseline.stage_assigned',
    category: 'baseline', tier: 'critical',
    title: 'Stage assigned',
    applies: () => signal(true, 'every show must be assigned to a stage'),
    check(state) {
      const s = state.show?.stage;
      return s
        ? { status: 'confirmed', reason: `stage: ${s}` }
        : { status: 'missing',   reason: 'no stage assigned', action: 'assign stage' };
    },
  },
  {
    id: 'baseline.show_time',
    category: 'baseline', tier: 'high',
    title: 'Show time set',
    applies: () => signal(true, 'PA/security/staff need showtime'),
    check(state) {
      const t = state.show?.showTime;
      return t ? { status: 'confirmed', reason: `showtime: ${t}` } : { status: 'missing', reason: 'showtime blank', action: 'set showtime' };
    },
  },
  {
    id: 'baseline.doors_time',
    category: 'baseline', tier: 'high',
    title: 'Doors time set',
    applies: () => signal(true, 'FOH/security need doors time'),
    check(state) {
      const t = state.show?.doorsTime;
      return t ? { status: 'confirmed', reason: `doors: ${t}` } : { status: 'missing', reason: 'doors time blank', action: 'set doors time' };
    },
  },
  {
    id: 'baseline.load_in_scheduled',
    category: 'baseline', tier: 'high',
    title: 'Load-in on the day-of-show schedule',
    applies: () => signal(true, 'crew and vendors need a load-in slot'),
    check(state) {
      const hit = (state.schedule || []).find(s => /load[- ]?in|crew call/i.test(s.label || ''));
      if (hit && hit.time) return { status: 'confirmed', reason: `load-in at ${hit.time}` };
      if (hit)             return { status: 'open',      reason: 'load-in on schedule but no time set', action: 'set load-in time' };
      return { status: 'missing', reason: 'no load-in row on schedule', action: 'add load-in to schedule' };
    },
  },
  {
    id: 'baseline.advance_record_exists',
    category: 'baseline', tier: 'critical',
    title: 'Advance record started',
    applies: () => signal(true, 'advancing cannot proceed without an advance record'),
    check(state) {
      return state.advance
        ? { status: 'confirmed', reason: 'advance row present' }
        : { status: 'missing',   reason: 'no advance row for this show', action: 'create advance record' };
    },
  },
  {
    id: 'baseline.tour_contact',
    category: 'baseline', tier: 'high',
    title: 'Tour advance contact identified',
    applies: () => signal(true, 'PM needs a person to advance the show with'),
    check(state) {
      const a = state.advance || {};
      const name  = a.advanceContact || state.show?.tourManager;
      const email = a.advanceEmail   || '';
      const phone = a.advancePhone   || '';
      if (name && (email || phone)) return { status: 'confirmed', reason: `${name} (${email || phone})` };
      if (name)                     return { status: 'open',      reason: `${name} on file but no email/phone`, action: 'get tour contact email or phone' };
      return { status: 'missing', reason: 'no tour contact', action: 'ask promoter for tour advance contact' };
    },
  },
  {
    id: 'baseline.promoter_contact',
    category: 'baseline', tier: 'medium',
    title: 'Promoter of record identified',
    applies: () => signal(true, 'every show has a promoter of record'),
    check(state) {
      const p = state.show?.promoter;
      return p ? { status: 'confirmed', reason: p } : { status: 'missing', reason: 'no promoter listed', action: 'set promoter' };
    },
  },

  // ── Venue-specific ────────────────────────────────────────────────────
  {
    id: 'venue.curfew_known',
    category: 'venue', tier: 'high',
    title: 'Curfew known for tonight',
    applies: () => signal(true, 'every show has an operational curfew'),
    check(state) {
      const c = state.advance?.curfew;
      if (c && String(c).trim()) return { status: 'confirmed', reason: `curfew: ${c}` };
      const vr = state.venueRules?.['operations.curfew.time'];
      if (vr && vr.value) return { status: 'confirmed', reason: `venue rule: ${vr.value}` };
      return { status: 'missing', reason: 'no curfew set on advance and no venue-wide rule', action: 'confirm curfew with promoter/venue' };
    },
  },
  {
    id: 'venue.sound_restrictions_documented',
    category: 'venue', tier: 'medium',
    title: 'Sound restrictions documented',
    applies: (state) => hasPowerSignal(state).applies || /db/.test(concatAdvanceProse(state.advance))
      ? signal(true, 'audio/production content on the advance triggers this check')
      : signal(true, 'venue sound ordinance always applies'),
    check(state) {
      const sr = state.advance?.soundRestrictions;
      if (sr && String(sr).trim()) return { status: 'confirmed', reason: `advance: ${sr}` };
      const vr = state.venueRules?.['operations.building_rules.spl_limit'];
      if (vr && vr.value) return { status: 'confirmed', reason: `venue rule: ${vr.value} dB` };
      return { status: 'open', reason: 'no sound restrictions on file', action: 'confirm venue SPL limit and add to advance' };
    },
  },

  // ── Rigging cluster (only when rigging is required) ──────────────────
  {
    id: 'rigging.plot_present',
    category: 'artist', tier: 'critical',
    title: 'Rigging plot on file',
    applies: hasRiggingSignal,
    check(state) {
      // Look for a rider/plot doc mention on advance prose.
      const prose = concatAdvanceProse(state.advance);
      if (/\b(rigging plot|hang plot|weight plot|approved rigging plot)\b/.test(prose))
        return { status: 'confirmed', reason: 'rigging/hang plot referenced in advance' };
      return { status: 'missing', reason: 'tour requires rigging but no plot referenced', action: 'request approved rigging plot from tour' };
    },
  },
  {
    id: 'rigging.weight_within_capacity',
    category: 'artist', tier: 'critical',
    title: 'Rig weight within venue capacity',
    applies: hasRiggingSignal,
    async check(state) {
      const vr = state.venueRules?.['technical.rigging.max_load_lbs'];
      if (!vr) return { status: 'risk', reason: 'venue rigging capacity is not on file — cannot verify safety', action: 'record venue rigging capacity in Venue Intelligence' };
      // Try to parse requested weight from prose.
      const m = (concatAdvanceProse(state.advance) || '').match(/(\d{3,5})\s*(?:lb|lbs|pounds)\b.{0,30}(rig|hang|motors|points)/);
      if (m) {
        const requested = Number(m[1]);
        if (requested > Number(vr.value)) return { status: 'conflict', reason: `requested ${requested} lbs exceeds venue rig capacity ${vr.value} lbs`, action: 'escalate to admin — rig weight exceeds venue capacity' };
        return { status: 'confirmed', reason: `requested ${requested} lbs within ${vr.value} lbs capacity` };
      }
      return { status: 'open', reason: 'venue capacity known but tour has not stated total rig weight', action: 'request total rig weight from tour' };
    },
  },
  {
    id: 'rigging.qualified_rigger_booked',
    category: 'artist', tier: 'critical',
    title: 'Qualified rigger booked',
    applies: hasRiggingSignal,
    check(state) {
      const riggers = (state.labor || []).filter(l => /rigger/i.test(l.role || ''));
      const requested = factValue(state, 'rigger_count');
      if (riggers.length === 0)
        return { status: 'missing', reason: 'no riggers on the labor call', action: 'book qualified riggers' };
      if (requested && riggers.length < Number(requested))
        return { status: 'open', reason: `only ${riggers.length} of ${requested} requested riggers booked`, action: `book ${Number(requested) - riggers.length} more rigger(s)` };
      return { status: 'confirmed', reason: `${riggers.length} rigger(s) on call` };
    },
  },

  // ── Truck / logistics cluster ─────────────────────────────────────────
  {
    id: 'trucks.count_specified',
    category: 'artist', tier: 'medium',
    title: 'Truck count specified',
    applies: hasTruckSignal,
    check(state) {
      const trucks = factValue(state, 'truck_count');
      if (trucks) return { status: 'confirmed', reason: `${trucks} trucks (from approved email fact)` };
      return { status: 'open', reason: 'truck signal present but no confirmed count', action: 'confirm truck count with tour' };
    },
  },
  {
    id: 'trucks.dock_confirmed',
    category: 'artist', tier: 'high',
    title: 'Loading dock access confirmed',
    applies: hasTruckSignal,
    check(state) {
      const vr = state.venueRules?.['physical.dock.available'];
      if (vr && vr.value === false) return { status: 'conflict', reason: 'venue rule: no dock available', action: 'escalate to admin — arrange street load-in' };
      const prose = concatAdvanceProse(state.advance);
      if (/loading dock|freight elevator|dock access/.test(prose))
        return { status: 'confirmed', reason: 'dock referenced on advance' };
      return { status: 'open', reason: 'trucks expected but dock access not documented', action: 'confirm dock/loading access with tour' };
    },
  },
  {
    id: 'trucks.parking_arranged',
    category: 'artist', tier: 'medium',
    title: 'Truck/bus parking arranged',
    applies: hasTruckSignal,
    check(state) {
      const parking = factValue(state, 'parking_spaces');
      if (parking) return { status: 'confirmed', reason: `${parking} bus/truck parking spaces` };
      return { status: 'open', reason: 'no bus/truck parking documented', action: 'confirm overnight parking with tour' };
    },
  },

  // ── RF cluster ────────────────────────────────────────────────────────
  {
    id: 'rf.channel_count_known',
    category: 'artist', tier: 'high',
    title: 'RF/wireless channel count known',
    applies: hasRfSignal,
    check(state) {
      const n = factValue(state, 'wireless_channels');
      if (n) return { status: 'confirmed', reason: `${n} wireless channels requested` };
      return { status: 'open', reason: 'wireless mentioned but channel count unconfirmed', action: 'confirm wireless channel count with tour' };
    },
  },
  {
    id: 'rf.frequency_coordinated',
    category: 'artist', tier: 'critical',
    title: 'RF frequencies coordinated with venue/other users',
    applies: hasRfSignal,
    async check(state) {
      const n = factValue(state, 'wireless_channels');
      const vr = state.venueRules?.['technical.rf.available_channels'];
      if (n && vr) {
        if (Number(n) > Number(vr.value))
          return { status: 'conflict', reason: `${n} channels requested but venue supports ${vr.value}`, action: 'escalate — book RF vendor and coordinate frequencies' };
      }
      if (vr && !n) return { status: 'open', reason: 'venue supports RF but tour count is unknown', action: 'confirm channel count and run scan' };
      if (!vr) return { status: 'risk', reason: 'venue RF capability is not on file — cannot verify coordination', action: 'record venue RF capability in Venue Intelligence' };
      return { status: 'open', reason: 'RF scan not documented', action: 'run RF coordination scan pre-show' };
    },
  },

  // ── Catering cluster ──────────────────────────────────────────────────
  {
    id: 'catering.headcount_confirmed',
    category: 'artist', tier: 'medium',
    title: 'Catering headcount confirmed',
    applies: hasCateringSignal,
    check(state) {
      const anyMeal = factValue(state,'dinner_count') || factValue(state,'lunch_count') || factValue(state,'breakfast_count') || factValue(state,'meal_count');
      if (anyMeal) return { status: 'confirmed', reason: 'meal counts confirmed via approved email facts' };
      if (advanceField(state.advance, 'cateringNotes')) return { status: 'open', reason: 'catering notes on advance but no confirmed head counts', action: 'confirm meal head counts' };
      return { status: 'missing', reason: 'catering required but no counts', action: 'ask tour for meal counts' };
    },
  },
  {
    id: 'catering.dietary_captured',
    category: 'artist', tier: 'medium',
    title: 'Dietary restrictions captured',
    applies: hasCateringSignal,
    check(state) {
      const prose = concatAdvanceProse(state.advance);
      if (/\b(vegan|vegetarian|gluten[- ]free|nut[- ]free|halal|kosher|allergen|allergy)\b/.test(prose))
        return { status: 'confirmed', reason: 'dietary language present on advance' };
      return { status: 'open', reason: 'no dietary requirements captured', action: 'ask tour for dietary restrictions' };
    },
  },
  {
    id: 'catering.responsibility_assigned',
    category: 'artist', tier: 'low',
    title: 'Catering responsibility assigned (in-house vs vendor)',
    applies: hasCateringSignal,
    check(state) {
      const booked = (state.vendorBookings || []).find(b => /cater/i.test(b.service || '') || /cater/i.test(b.vendorName || ''));
      if (booked) return { status: 'confirmed', reason: `${booked.vendorName || 'vendor'} booked for catering` };
      return { status: 'open', reason: 'no catering vendor booked', action: 'confirm in-house or book catering vendor' };
    },
  },
  {
    id: 'catering.meal_times_scheduled',
    category: 'artist', tier: 'low',
    title: 'Meal times on day-of-show schedule',
    applies: hasCateringSignal,
    check(state) {
      const hit = (state.schedule || []).some(s => /meal|dinner|catering|lunch|breakfast/i.test(s.label || ''));
      return hit ? { status: 'confirmed', reason: 'meal window on schedule' } : { status: 'open', reason: 'no meal window on schedule', action: 'add meal window to schedule' };
    },
  },

  // ── Pyro (safety-critical) ────────────────────────────────────────────
  {
    id: 'pyro.permit_verified',
    category: 'artist', tier: 'critical',
    title: 'Pyro/flame permit and fire-marshal sign-off',
    applies: hasPyroSignal,
    async check(state) {
      const vr = state.venueRules?.['operations.fire_life_safety.pyro_permitted'];
      if (vr && vr.value === false)
        return { status: 'conflict', reason: 'venue rule: pyro NOT permitted', action: 'escalate — pyro not allowed at this venue' };
      if (!vr)
        return { status: 'risk', reason: 'safety-critical: venue pyro rule is not on file', action: 'record venue pyro rule in Venue Intelligence' };
      const prose = concatAdvanceProse(state.advance);
      if (/\b(permit|fire marshal|afsp|pyrotechnician)\b/.test(prose))
        return { status: 'confirmed', reason: 'permit/fire-marshal language on advance' };
      return { status: 'missing', reason: 'pyro requested but no permit/sign-off documented', action: 'obtain fire-marshal permit and pyrotechnician credentials' };
    },
  },

  // ── Power ─────────────────────────────────────────────────────────────
  {
    id: 'power.within_capacity',
    category: 'artist', tier: 'critical',
    title: 'Power draw within venue capacity',
    applies: hasPowerSignal,
    async check(state) {
      const vr = state.venueRules?.['technical.power.stage_amps'];
      if (!vr) return { status: 'risk', reason: 'venue stage-amps capacity is not on file — cannot verify', action: 'record venue stage amps in Venue Intelligence' };
      const req = factValue(state, 'power_amps');
      if (req && Number(req) > Number(vr.value))
        return { status: 'conflict', reason: `requested ${req}A exceeds venue capacity ${vr.value}A`, action: 'escalate — book power distro/generator' };
      if (req) return { status: 'confirmed', reason: `${req}A requested, ${vr.value}A available` };
      return { status: 'open', reason: 'power signal present but no confirmed amp draw', action: 'confirm amp draw with tour' };
    },
  },

  // ── Lighting ─────────────────────────────────────────────────────────
  {
    id: 'lighting.movers_covered',
    category: 'artist', tier: 'medium',
    title: 'Moving-light package covered',
    applies: hasMovingLightSignal,
    check(state) {
      const req = factValue(state, 'moving_light_count');
      const vr  = state.venueRules?.['technical.lighting.movers'];
      if (req && vr && Number(req) > Number(vr.value))
        return { status: 'conflict', reason: `${req} movers requested, venue has ${vr.value}`, action: 'book lighting vendor for shortfall' };
      if (req && vr) return { status: 'confirmed', reason: `${req} movers requested, venue has ${vr.value}` };
      if (req) return { status: 'open', reason: 'movers requested but venue capability unknown', action: 'record venue mover count in Venue Intelligence' };
      return { status: 'open', reason: 'moving lights mentioned but count unconfirmed', action: 'confirm moving light count with tour' };
    },
  },

  // ── Crew coverage (baseline) ─────────────────────────────────────────
  {
    id: 'crew.local_hands_booked',
    category: 'baseline', tier: 'high',
    title: 'Local hands booked on labor call',
    applies: (state) => {
      // Every real show needs hands unless the advance explicitly says otherwise
      // (e.g. an acoustic guitarist with a house engineer only). Detect the
      // "no local crew" signal from prose.
      const prose = concatAdvanceProse(state.advance);
      if (/\b(no local crew|no hands? needed|solo acoustic|acoustic only|self[- ]contained)\b/.test(prose))
        return signal(false);
      return signal(true, 'shows need at least a minimum hands call unless self-contained');
    },
    check(state) {
      const hands = (state.labor || []).filter(l => /hand|loader|stagehand/i.test(l.role || ''));
      if (hands.length === 0) return { status: 'missing', reason: 'no hands on the labor call', action: 'add local hands to labor call' };
      return { status: 'confirmed', reason: `${hands.length} hand(s) on call` };
    },
  },
];

// ── Public API ──────────────────────────────────────────────────────────────

async function evaluate(state) {
  const evaluatedAt = new Date().toISOString();

  // Turn approvedFacts array into a lookup.
  if (Array.isArray(state.approvedFacts)) {
    const map = {};
    for (const f of state.approvedFacts) {
      if (f.field) map[f.field] = f;
    }
    state.approvedFacts = map;
  }
  if (Array.isArray(state.venueRules)) {
    const map = {};
    for (const r of state.venueRules) if (r.attributePath) map[r.attributePath] = r;
    state.venueRules = map;
  }

  const applied = [];
  for (const rule of RULES) {
    const app = await Promise.resolve(rule.applies(state));
    if (!app || !app.applies) continue;
    let checked;
    try {
      checked = await Promise.resolve(rule.check(state));
    } catch (err) {
      checked = { status: 'risk', reason: `check failed: ${err.message}`, action: 'inspect engine error' };
    }
    applied.push({
      id: rule.id, category: rule.category, tier: rule.tier, title: rule.title,
      explanation: app.because, // WHY this rule applies to this show
      status: checked.status,
      reason: checked.reason,
      evidence: checked.evidence || null,
      waitingOn: checked.waitingOn || null,
      deadline: checked.deadline || null,
      action: checked.action || null,
    });
  }

  // Bucket by status.
  const confirmed = applied.filter(r => r.status === 'confirmed');
  const open      = applied.filter(r => r.status === 'open');
  const missing   = applied.filter(r => r.status === 'missing');
  const conflict  = applied.filter(r => r.status === 'conflict');
  const risk      = applied.filter(r => r.status === 'risk');

  // Prioritize unresolved by tier.
  const unresolved = applied.filter(r => r.status !== 'confirmed');
  const priorities = {
    critical: unresolved.filter(r => r.tier === 'critical'),
    high:     unresolved.filter(r => r.tier === 'high'),
    medium:   unresolved.filter(r => r.tier === 'medium'),
    low:      unresolved.filter(r => r.tier === 'low'),
  };

  const readiness = {
    critical: countTier(applied, 'critical'),
    high:     countTier(applied, 'high'),
    medium:   countTier(applied, 'medium'),
    low:      countTier(applied, 'low'),
  };

  const status =
    priorities.critical.length > 0                          ? 'blocked'
    : priorities.high.length     > 0                        ? 'in_progress'
    : (priorities.medium.length + priorities.low.length) > 0 ? 'ready_pending_review'
    : applied.length === 0                                  ? 'not_started'
    :                                                          'advanced';

  // Ancillary streams that aren't rule-based but the PM needs at a glance.
  const recentChanges = collectRecentChanges(state);
  const upcomingDeadlines = collectDeadlines(state);
  const dependencies      = collectDependencies(state);
  const waitingOn         = collectWaitingOn(state, applied);
  const importantComms    = collectImportantComms(state);
  const recommendedActions = unresolved
    .filter(r => r.action)
    .sort((a, b) => tierOrder(a.tier) - tierOrder(b.tier))
    .map(r => ({ ruleId: r.id, tier: r.tier, action: r.action, why: r.reason }));

  return {
    showId: state.show?.id || null,
    showName: state.show?.artist || state.show?.eventName || '',
    showDate: state.show?.date || null,
    stage:    state.show?.stage || null,
    evaluatedAt,
    status,
    readiness,
    priorities,
    confirmed, open, missing, conflicts: conflict, risks: risk,
    upcomingDeadlines, dependencies, waitingOn, recentChanges,
    importantCommunications: importantComms,
    recommendedActions,
    appliedRuleCount: applied.length,
    linkedEmailCount: (state.linkedEmails || []).length,
  };
}

function tierOrder(t) { return { critical: 0, high: 1, medium: 2, low: 3 }[t] ?? 9; }

function countTier(applied, tier) {
  const rows = applied.filter(r => r.tier === tier);
  return {
    total:     rows.length,
    confirmed: rows.filter(r => r.status === 'confirmed').length,
    unresolved:rows.filter(r => r.status !== 'confirmed').length,
    blocked:   rows.filter(r => r.status === 'conflict' || r.status === 'missing').length,
  };
}

function collectRecentChanges(state) {
  const facts = state.recentFacts || [];
  const cutoff = state.now ? new Date(state.now).getTime() - 1000*60*60*72 : Date.now() - 1000*60*60*72;
  return facts.filter(f => f.kind === 'change' || f.kind === 'correction')
              .filter(f => !f.sourceDate || new Date(f.sourceDate).getTime() >= cutoff)
              .map(f => ({ field: f.field, from: f.previousValue, to: f.newValue, at: f.sourceDate, sender: f.senderName || f.senderEmail, why: f.reasoningSummary }));
}

function collectDeadlines(state) {
  return (state.emailIssues || []).filter(i => i.kind === 'deadline').map(i => ({
    excerpt: i.excerpt, phrase: i.phrase, from: i.from, at: i.date, threadId: i.threadId,
  }));
}

function collectDependencies(state) {
  return (state.emailIssues || []).filter(i => i.kind === 'dependency').map(i => ({
    excerpt: i.excerpt, from: i.from, at: i.date, threadId: i.threadId,
  }));
}

function collectWaitingOn(state, applied) {
  const items = [];
  for (const p of (state.pendingFacts || [])) {
    items.push({ kind: 'email_fact', field: p.field, from: p.senderName || p.senderEmail, threadId: p.threadId, why: 'proposed email fact awaiting PM approval' });
  }
  for (const r of applied) {
    if (r.waitingOn) items.push({ kind: 'rule', ruleId: r.id, why: r.waitingOn });
  }
  return items;
}

function collectImportantComms(state) {
  const facts = state.recentFacts || [];
  const critical = facts.filter(f => f.criticality === 'critical' || (Array.isArray(f.conflicts) ? f.conflicts.some(c => c.critical) : false));
  const bySender = new Map();
  for (const f of critical) {
    const key = f.senderEmail || f.senderName || 'unknown';
    if (!bySender.has(key)) bySender.set(key, { from: key, samples: [] });
    bySender.get(key).samples.push({ field: f.field, when: f.sourceDate, excerpt: f.sourceExcerpt, why: f.reasoningSummary });
  }
  return [...bySender.values()];
}

// ── State builder ───────────────────────────────────────────────────────────

async function buildShowState(showId, { sheetsAdapter = sheetsReal, now = null } = {}) {
  const [shows, advances, schedule, labor, vendorBookings, emailFacts, emailIssues, venueRuleRows, emails] = await Promise.all([
    sheetsAdapter.getRows(SHEETS.shows),
    sheetsAdapter.getRows(SHEETS.advancing),
    sheetsAdapter.getRows(SHEETS.schedule),
    sheetsAdapter.getRows(SHEETS.labor),
    sheetsAdapter.getRows(SHEETS.vendorBookings),
    sheetsAdapter.getRows(SHEETS.emailFacts).catch(() => []),
    sheetsAdapter.getRows(SHEETS.emailIssues).catch(() => []),
    sheetsAdapter.getRows(SHEETS.venueKnowledge).catch(() => []),
    sheetsAdapter.getRows(SHEETS.emails).catch(() => []),
  ]);

  const show    = shows.find(s => String(s.id) === String(showId));
  if (!show) { const e = new Error('show_not_found'); e.code = 'not_found'; throw e; }
  const advance = advances.find(a => String(a.showId) === String(showId));

  const relevantFacts = emailFacts.filter(f => String(f.showId) === String(showId));
  const approvedFacts = relevantFacts
    .filter(f => f.status === 'approved')
    .map(f => ({ ...f, newValue: safeParse(f.newValue), previousValue: safeParse(f.previousValue), conflicts: safeParse(f.conflicts, []) }));
  const pendingFacts = relevantFacts
    .filter(f => f.status === 'proposed')
    .map(f => ({ ...f, newValue: safeParse(f.newValue), previousValue: safeParse(f.previousValue) }));
  const recentFacts  = relevantFacts
    .map(f => ({ ...f, newValue: safeParse(f.newValue), previousValue: safeParse(f.previousValue), conflicts: safeParse(f.conflicts, []) }));

  const showIssues = emailIssues.filter(i => String(i.showId) === String(showId));
  const linkedEmails = emails
    .filter(e => String(e.showId) === String(showId))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const activeVenue = venueRuleRows
    .filter(r => r.kind === 'rule' && r.status === 'active')
    .map(r => ({ ...r, value: safeParse(r.value) }));

  return {
    show,
    advance,
    schedule: schedule.filter(s => String(s.showId) === String(showId)),
    labor:    labor.filter(l => String(l.showId) === String(showId)),
    vendorBookings: vendorBookings.filter(b => String(b.showId) === String(showId)),
    approvedFacts, pendingFacts, recentFacts,
    emailIssues: showIssues,
    linkedEmails,
    venueRules: activeVenue,
    now: now || new Date().toISOString(),
  };
}

function safeParse(v, fallback) {
  if (v === '' || v == null) return fallback ?? null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

// ── Dashboard summary across many shows ─────────────────────────────────────

async function dashboardSummary({ sheetsAdapter = sheetsReal, upcomingOnly = true } = {}) {
  const shows = await sheetsAdapter.getRows(SHEETS.shows);
  const today = new Date().toISOString().slice(0, 10);
  const filtered = upcomingOnly
    ? shows.filter(s => !s.date || s.date >= today)
    : shows;
  const summaries = [];
  for (const show of filtered) {
    try {
      const state = await buildShowState(show.id, { sheetsAdapter });
      const result = await evaluate(state);
      summaries.push({
        showId: show.id, showName: show.artist || show.eventName || '',
        date: show.date, stage: show.stage,
        status: result.status,
        readiness: result.readiness,
        critical: result.priorities.critical.length,
        high: result.priorities.high.length,
        medium: result.priorities.medium.length,
        low: result.priorities.low.length,
        topPriorities: [...result.priorities.critical, ...result.priorities.high].slice(0, 3).map(p => ({
          id: p.id, title: p.title, tier: p.tier, reason: p.reason, action: p.action,
        })),
      });
    } catch (err) {
      summaries.push({ showId: show.id, showName: show.artist || show.eventName || '', date: show.date, error: err.message });
    }
  }
  summaries.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return summaries;
}

module.exports = {
  evaluate, buildShowState, dashboardSummary,
  RULES,
  // Exposed for tests
  _signals: { hasRiggingSignal, hasRfSignal, hasTruckSignal, hasCateringSignal, hasPyroSignal, hasPowerSignal, hasMovingLightSignal },
};
