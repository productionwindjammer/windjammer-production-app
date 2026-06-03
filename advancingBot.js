'use strict';

/**
 * Windjammer Advancing Bot — Rule-based analysis engine
 *
 * Scans advancing record fields + email snippets for technical
 * requirements, cross-references against the venue tech pack,
 * and returns a list of flagged items for the production team.
 */

function stripHtml(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

const RULES = [
  {
    category: 'FOH Console',
    icon: '🎚',
    keywords: [
      'avid', 'sc48', 'profile', 'digico', 'sd5', 'sd7', 'sd9', 'sd11', 'sd12',
      'yamaha', 'cl5', 'cl3', 'cl1', 'pm5d', 'rivage', 'pm10', 'midas', 'pro2',
      'pro6', 'pro9', 'heritage', 'x32', 'wing', 'neve', 'ssl', 'mixing console',
      'foh console', 'foh desk', 'mixing desk', 'control surface',
    ],
    fields: ['riderNotes', 'productionNeeds'],
    tip: 'Verify house console matches artist preference, or confirm artist is bringing their own.',
  },
  {
    category: 'Monitor System',
    icon: '🎧',
    keywords: [
      'iem', 'in-ear monitor', 'in ear monitor', 'in-ear', 'wedge monitor',
      'floor monitor', 'sidefill', 'side fill', 'monitor world', 'mon eng',
      'monitor engineer', 'shure psm', 'sennheiser g', 'rf coordination',
      'rf system', 'wireless iem',
    ],
    fields: ['riderNotes', 'productionNeeds', 'backlineNotes'],
    tip: 'Confirm IEM vs wedge setup and whether house monitor system is acceptable.',
  },
  {
    category: 'PA System',
    icon: '🔊',
    keywords: [
      'line array', 'pa system', 'point source', 'subwoofer', 'delay tower',
      'front fill', 'd&b', 'l-acoustics', 'k2', 'k1', 'v-dosc', 'jbl', 'nexo',
      'meyer', 'danley', 'kling', 'frenger', 'clair', 'hangs', 'speaker system',
    ],
    fields: ['riderNotes', 'productionNeeds'],
    tip: 'Check if artist has PA system preferences and whether house rig is acceptable.',
  },
  {
    category: 'SPL / Noise Restrictions',
    icon: '📊',
    keywords: [
      'spl', 'db limit', 'dba limit', 'decibel limit', 'noise ordinance',
      'sound ordinance', 'volume limit', 'noise curfew', 'sound level',
    ],
    fields: ['soundRestrictions', 'curfew', 'riderNotes'],
    tip: 'Confirm both artist SPL expectations and any venue noise ordinance with the show contact.',
  },
  {
    category: 'Lighting',
    icon: '💡',
    keywords: [
      'moving light', 'moving head', 'mover', 'led par', 'led wash', 'led beam',
      'follow spot', 'spot operator', 'dimmer rack', 'haze machine', 'hazer',
      'fog machine', 'co2', 'strobe', 'truss', 'ground support', 'lighting rig',
      'lighting designer', 'ld ', 'lighting package',
    ],
    fields: ['riderNotes', 'productionNeeds'],
    tip: 'Verify lighting rig meets rider spec and confirm spot/LD operator availability.',
  },
  {
    category: 'Video / LED',
    icon: '📺',
    keywords: [
      'led wall', 'video wall', 'led screen', 'imag', 'i-mag', 'camera op',
      'projection', 'projector', 'd3', 'disguise', 'resolume', 'media server',
      'video playback', 'content playback', 'video package', 'led panel',
    ],
    fields: ['riderNotes', 'productionNeeds'],
    tip: 'Confirm video/LED wall availability and spec against rider requirements.',
  },
  {
    category: 'Backline',
    icon: '🎸',
    keywords: [
      'drum kit', 'drum riser', 'bass amp', 'guitar amp', 'keyboard', 'piano',
      'grand piano', 'upright piano', 'hammond', 'b3 organ', 'backline',
      'ac30', 'marshall', 'ampeg', 'fender twin', 'provided by venue',
      'backline provided', 'bis provided',
    ],
    fields: ['backlineNotes', 'riderNotes'],
    tip: 'Confirm whether backline is provided by venue, artist, or third-party rental.',
  },
  {
    category: 'Stage Dimensions',
    icon: '📐',
    keywords: [
      'stage size', 'stage dimension', 'stage width', 'stage depth',
      'performance area', 'drum riser height', 'barricade', 'crowd barrier',
      'pit area', 'thrust stage', 'runway', 'catwalk', 'forestage', 'stage plot',
    ],
    fields: ['stagingChanges', 'riderNotes', 'productionNeeds'],
    tip: 'Compare required stage dimensions against venue specs in the Tech Pack.',
  },
  {
    category: 'Power',
    icon: '⚡',
    keywords: [
      'power distro', 'power distribution', 'generator', 'cam-loc', 'camloc',
      'shore power', 'amp service', '100 amp', '200 amp', '400 amp',
      'single phase', 'three phase', '208v', '240v', 'power draw',
    ],
    fields: ['riderNotes', 'productionNeeds'],
    tip: 'Verify required power draw against venue power distribution capacity.',
  },
  {
    category: 'Catering / Hospitality',
    icon: '🍽',
    keywords: [
      'catering rider', 'meal buyout', 'buy-out', 'per diem', 'dressing room',
      'green room', 'vegan', 'vegetarian', 'gluten free', 'nut free', 'halal',
      'kosher', 'food allergy', 'hospitality rider', 'towels', 'shower access',
    ],
    fields: ['cateringNotes', 'hospitalityNotes', 'riderNotes'],
    tip: 'Review catering and hospitality requests and confirm fulfillment plan with the team.',
  },
  {
    category: 'Local Crew',
    icon: '👷',
    keywords: [
      'stagehand', 'stagehands', 'iatse', 'local crew', 'loaders', 'spot op',
      'follow spot op', 'rigger', 'carpenter', 'electrician', 'wardrobe',
      'runner', 'local call', 'crew call',
    ],
    fields: ['localCrewNeeds', 'riderNotes'],
    tip: 'Confirm local crew headcount, call times, and any specialty positions.',
  },
  {
    category: 'Load-in / Logistics',
    icon: '🚛',
    keywords: [
      'load-in time', 'load in time', 'load-out', 'load out', 'semi truck',
      'bus parking', 'coach parking', 'truck access', 'loading dock',
      'freight elevator', 'forklift', 'pallet jack', 'production advance',
    ],
    fields: ['riderNotes', 'productionNeeds', 'notes'],
    tip: 'Confirm load-in access, elevator/dock availability, and bus/truck parking.',
  },
];

/**
 * @param {Object} advancing  - The advancing record from Google Sheets
 * @param {string} techpackText - Stripped plain-text content of all tech pack docs for the stage
 * @param {string[]} emailSnippets - Array of email snippet strings for the show
 * @returns {{ issues: Array, summary: string, analyzedAt: string }}
 */
function analyzeAdvance(advancing, techpackText, emailSnippets = []) {
  const emailText = emailSnippets.join(' ').toLowerCase();
  const issues = [];

  for (const rule of RULES) {
    const fieldText = rule.fields
      .map(f => (advancing[f] || ''))
      .join(' ')
      .toLowerCase();

    const combined = fieldText + ' ' + emailText;
    const articleHits = rule.keywords.filter(kw => combined.includes(kw));

    if (articleHits.length === 0) continue;

    const techHits = rule.keywords.filter(kw => techpackText.includes(kw));
    const status = techHits.length > 0 ? 'review' : 'flag';

    const hitList = articleHits.slice(0, 3).map(k => `"${k}"`).join(', ');
    const note = techHits.length > 0
      ? `Artist/rider references ${hitList}. Venue tech pack also covers this area — verify specs align.`
      : `Artist/rider references ${hitList}. Not addressed in venue tech pack — may need follow-up with tour contact.`;

    issues.push({
      category: rule.category,
      icon: rule.icon,
      note,
      tip: rule.tip,
      status, // 'review' = needs verification, 'flag' = not in tech pack
    });
  }

  const flags   = issues.filter(i => i.status === 'flag').length;
  const reviews = issues.filter(i => i.status === 'review').length;

  let summary;
  if (issues.length === 0) {
    summary = 'No technical conflicts detected based on current advancing notes and emails.';
  } else {
    summary = `${flags} item${flags !== 1 ? 's' : ''} need${flags !== 1 ? '' : 's'} follow-up · ${reviews} item${reviews !== 1 ? 's' : ''} need${reviews !== 1 ? '' : 's'} verification against tech pack.`;
  }

  return { issues, summary, analyzedAt: new Date().toISOString() };
}

// ──────────────────────────────────────────────────────────────────────────────
// EMAIL EXTRACTION — pull structured advance info out of raw email bodies
// ──────────────────────────────────────────────────────────────────────────────

const CONF = { high: 3, medium: 2, low: 1 };

// Map an advancing-record fieldKey → human label (used in the review UI)
const FIELD_LABELS = {
  advanceContact:    'Advance Contact',
  advancePhone:      'Contact Phone',
  advanceEmail:      'Contact Email',
  curfew:            'Curfew',
  soundRestrictions: 'Sound Restrictions',
  riderNotes:        'Rider Notes',
  productionNeeds:   'Production Needs',
  backlineNotes:     'Backline',
  cateringNotes:     'Catering',
  hospitalityNotes:  'Hospitality',
  localCrewNeeds:    'Local Crew',
  stagingChanges:    'Staging / Capacity',
  notes:             'Additional Notes',
};

// Convert HTML to plain text but PRESERVE line breaks (extractors rely on lines)
function htmlToText(html) {
  return (html || '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Strip Gmail quoted-reply blocks ("On Mon, ... wrote:" and ">"-prefixed lines)
function stripQuotedReply(text) {
  const lines = text.split('\n');
  const out = [];
  for (const line of lines) {
    if (/^\s*on\s+(mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(line)
        && /wrote:\s*$/i.test(line)) break;
    if (/^-{2,}\s*original\s+message\s*-{2,}/i.test(line)) break;
    if (/^\s*from:\s*.+\s+sent:\s*/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

function bodyOf(email) {
  if (email.textBody && email.textBody.trim()) return stripQuotedReply(email.textBody);
  if (email.htmlBody && email.htmlBody.trim()) return stripQuotedReply(htmlToText(email.htmlBody));
  return email.snippet || '';
}

// Build a short quote (≤180 chars) around a match index for citation in the UI
function quoteAround(body, idx, len) {
  const start = Math.max(0, idx - 40);
  const end   = Math.min(body.length, idx + len + 80);
  let q = body.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) q = '…' + q;
  if (end < body.length) q = q + '…';
  return q.length > 200 ? q.slice(0, 200) + '…' : q;
}

function pushCandidate(bag, key, value, confidence, email, body, idx, matchLen) {
  if (!value || !String(value).trim()) return;
  const v = String(value).trim().replace(/\s+/g, ' ').slice(0, 1000);
  bag[key] = bag[key] || [];
  bag[key].push({
    value: v,
    confidence,
    sourceEmailId: email.gmailMessageId,
    sourceSubject: email.subject || '(no subject)',
    sourceDate:    email.date || '',
    sourceFrom:    email.from || '',
    sourceQuote:   idx >= 0 ? quoteAround(body, idx, matchLen || v.length) : '',
  });
}

// ── Field-level extractors ────────────────────────────────────────────────────

// Curfew: "curfew 11pm" | "hard curfew at 23:00" | "curfew: 11:00 pm"
function extractCurfew(body, email, bag) {
  const re = /(?:hard\s+)?curfew(?:\s+is)?\s*[:\-]?\s*((?:\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)|\d{1,2}:\d{2})/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    pushCandidate(bag, 'curfew', m[1].toUpperCase().replace(/\./g, ''), 'high', email, body, m.index, m[0].length);
  }
}

// Sound restrictions: "100 dB limit" | "noise ordinance" | "95 dBA at FOH"
function extractSoundRestrictions(body, email, bag) {
  const dbRe = /(\d{2,3}\s*db[a]?(?:\s*(?:limit|ceiling|cap|max(?:imum)?)?(?:\s+at\s+(?:foh|front\s+of\s+house|the\s+board))?)?)/gi;
  let m;
  while ((m = dbRe.exec(body)) !== null) {
    if (Number(m[1].match(/\d+/)[0]) < 60) continue; // skip stray small numbers
    pushCandidate(bag, 'soundRestrictions', m[1], 'medium', email, body, m.index, m[0].length);
  }
  const ordRe = /(noise\s+ordinance[^.\n]{0,160}\.?|sound\s+ordinance[^.\n]{0,160}\.?)/gi;
  while ((m = ordRe.exec(body)) !== null) {
    pushCandidate(bag, 'soundRestrictions', m[1].trim(), 'high', email, body, m.index, m[0].length);
  }
}

// Phone numbers — prefer ones near signature / contact context
function extractPhone(body, email, bag) {
  const phoneRe = /(\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/g;
  let m;
  while ((m = phoneRe.exec(body)) !== null) {
    const before = body.slice(Math.max(0, m.index - 80), m.index).toLowerCase();
    const conf = /(cell|mobile|phone|call|text|tm|tour\s*manager|prod|c:|m:|p:)/.test(before) ? 'high' : 'low';
    pushCandidate(bag, 'advancePhone', m[0], conf, email, body, m.index, m[0].length);
  }
}

// Contact name + email from signature block (last ~15 non-empty lines)
function extractSignature(body, email, bag) {
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
  const tail  = lines.slice(-15);
  // Find an email address in the tail
  const emailRe = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i;
  let sigEmail = null, sigEmailIdx = -1;
  for (let i = tail.length - 1; i >= 0; i--) {
    const em = tail[i].match(emailRe);
    if (em) { sigEmail = em[0]; sigEmailIdx = i; break; }
  }
  if (sigEmail) {
    const idx = body.lastIndexOf(sigEmail);
    pushCandidate(bag, 'advanceEmail', sigEmail, 'high', email, body, idx, sigEmail.length);
  }
  // Name = first short line in tail that looks like a person ("Firstname Lastname")
  for (const line of tail) {
    if (line.length > 60) continue;
    if (emailRe.test(line)) continue;
    if (/\d/.test(line)) continue;
    if (/^(sent from|get outlook|cheers|thanks|best|regards|sincerely|--+)/i.test(line)) continue;
    if (/^[A-Z][a-zA-Z'\-]+\s+[A-Z][a-zA-Z'\-]+/.test(line)) {
      const idx = body.lastIndexOf(line);
      pushCandidate(bag, 'advanceContact', line.split(/[,|·•]/)[0].trim(), 'medium', email, body, idx, line.length);
      // Role / title often follows on next line — capture and append
      break;
    }
  }
}

// Section blocks — "Backline:" "Hospitality:" "Catering:" etc.
// Capture everything until the next section header or a blank line followed by another header.
const SECTION_MAP = [
  { key: 'backlineNotes',    headers: ['backline', 'b-line', 'gear list', 'equipment list'] },
  { key: 'hospitalityNotes', headers: ['hospitality', 'green room', 'dressing room', 'green-room'] },
  { key: 'cateringNotes',    headers: ['catering', 'meals', 'meal', 'food', 'dietary', 'buyout', 'buy-out', 'buy out'] },
  { key: 'productionNeeds',  headers: ['production', 'production needs', 'production notes', 'tech needs', 'technical needs', 'audio', 'sound', 'lighting', 'lights', 'video'] },
  { key: 'stagingChanges',   headers: ['stage', 'staging', 'stage plot', 'stage size', 'stage dimensions', 'risers'] },
  { key: 'localCrewNeeds',   headers: ['local crew', 'crew', 'stagehands', 'hands needed', 'labor', 'iatse'] },
  { key: 'riderNotes',       headers: ['rider', 'tech rider', 'technical rider'] },
];

function extractSections(body, email, bag) {
  const lines = body.split('\n');
  // Find header lines: short line starting with a known header word followed by ":" or end-of-line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.length > 80) continue;
    const m = line.match(/^([a-z][a-z &/\-]{2,40})\s*[:\-]\s*(.*)$/i);
    if (!m) continue;
    const header  = m[1].trim().toLowerCase();
    const inline  = m[2].trim();
    let target = null;
    for (const sec of SECTION_MAP) {
      if (sec.headers.includes(header)) { target = sec.key; break; }
    }
    if (!target) continue;
    // Gather following lines until next header, blank gap, or 12 lines max
    const collected = [];
    if (inline) collected.push(inline);
    for (let j = i + 1; j < Math.min(lines.length, i + 13); j++) {
      const next = lines[j].trim();
      if (!next) { if (collected.length) break; else continue; }
      if (/^[a-z][a-z &/\-]{2,40}\s*[:\-]\s*/i.test(next) && next.length < 60) break;
      collected.push(next);
    }
    const value = collected.join(' ').replace(/\s+/g, ' ').trim();
    if (!value) continue;
    const startIdx = body.indexOf(line);
    pushCandidate(bag, target, value, 'high', email, body, startIdx, line.length + value.length);
  }
}

// Rider attachment hint (informational only — appended to riderNotes if present)
function extractAttachments(email, bag) {
  let atts = [];
  try { atts = JSON.parse(email.attachmentMeta || '[]'); } catch { /* ignore */ }
  for (const a of atts) {
    const fn = (a.filename || '').toLowerCase();
    if (/rider|stage[\s_\-]?plot|input[\s_\-]?list|patch/.test(fn)) {
      bag.riderNotes = bag.riderNotes || [];
      bag.riderNotes.push({
        value: `Rider/tech doc attached: ${a.filename}`,
        confidence: 'high',
        sourceEmailId: email.gmailMessageId,
        sourceSubject: email.subject || '(no subject)',
        sourceDate:    email.date || '',
        sourceFrom:    email.from || '',
        sourceQuote:   `Attachment: ${a.filename}`,
      });
    }
  }
}

function runExtractors(email, bag) {
  const body = bodyOf(email);
  if (!body) { extractAttachments(email, bag); return; }
  extractCurfew(body, email, bag);
  extractSoundRestrictions(body, email, bag);
  extractPhone(body, email, bag);
  extractSignature(body, email, bag);
  extractSections(body, email, bag);
  extractAttachments(email, bag);
}

/**
 * Extract structured advance info from a list of FULL emails.
 * Each email must have at minimum: { gmailMessageId, subject, from, date, snippet }
 * and one of: textBody, htmlBody.
 *
 * Returns: {
 *   [fieldKey]: {
 *     label, value, confidence, source: { emailId, subject, from, date, quote },
 *     alternates: [{ value, source: {emailId, subject} }, ...]
 *   }
 * }
 */
function extractFromEmails(emails = []) {
  const bag = {};
  // Process inbound emails first; most recent last so signatures overwrite stale ones
  const sorted = [...emails].sort((a, b) => {
    const da = Date.parse(a.date || '') || 0;
    const db = Date.parse(b.date || '') || 0;
    return da - db;
  });
  for (const e of sorted) {
    if ((e.direction || '').toLowerCase() === 'outbound') continue;
    runExtractors(e, bag);
  }

  const out = {};
  for (const [key, cands] of Object.entries(bag)) {
    if (!cands.length) continue;
    // Dedupe by normalized value
    const seen = new Set();
    const unique = [];
    for (const c of cands) {
      const k = c.value.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(c);
    }
    // Sort: highest confidence first, then most recent
    unique.sort((a, b) => {
      const cd = (CONF[b.confidence] || 0) - (CONF[a.confidence] || 0);
      if (cd !== 0) return cd;
      return (Date.parse(b.sourceDate) || 0) - (Date.parse(a.sourceDate) || 0);
    });
    const best = unique[0];
    out[key] = {
      label:      FIELD_LABELS[key] || key,
      value:      best.value,
      confidence: best.confidence,
      source: {
        emailId: best.sourceEmailId,
        subject: best.sourceSubject,
        from:    best.sourceFrom,
        date:    best.sourceDate,
        quote:   best.sourceQuote,
      },
      alternates: unique.slice(1, 4).map(c => ({
        value: c.value,
        source: { emailId: c.sourceEmailId, subject: c.sourceSubject, quote: c.sourceQuote },
      })),
    };
  }
  return { fields: out, extractedAt: new Date().toISOString(), emailCount: sorted.length };
}

// ──────────────────────────────────────────────────────────────────────────────
// EMAIL → SHOW CLASSIFIER
// Picks the most likely show for a Gmail message using: known advance-contact
// email, artist name (+ registry aliases), event name, show date appearing in
// the message, and temporal proximity (email sent close to the show date).
// When the email's full body is available it's added to the haystack so the
// classifier can pick up references like "see you in Cleveland on 8/12" that
// don't make it into the snippet.
// ──────────────────────────────────────────────────────────────────────────────

function _dateVariants(dateStr) {
  if (!dateStr) return [];
  const d = new Date(dateStr);
  if (isNaN(d)) return [];
  const months    = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const monthsAbb = ['jan','feb','mar','apr','may','jun','jul','aug','sep','sept','oct','nov','dec'];
  const m  = d.getUTCMonth(), day = d.getUTCDate(), y = d.getUTCFullYear();
  const pad = n => String(n).padStart(2, '0');
  return [
    dateStr.toLowerCase(),
    `${pad(m+1)}/${pad(day)}/${y}`,
    `${m+1}/${day}/${y}`,
    `${m+1}/${day}`,
    `${months[m]} ${day}`,
    `${months[m]} ${day}, ${y}`,
    `${monthsAbb[m]} ${day}`,
    `${monthsAbb[m]} ${day}, ${y}`,
    `${day} ${months[m]}`,
    `${day} ${monthsAbb[m]}`,
  ].map(s => s.toLowerCase());
}

/**
 * @param {Object} parsed   - { subject, snippet, from, to, cc, date, textBody?, htmlBody? }
 * @param {Array}  shows    - rows from the Shows sheet
 * @param {Array}  advances - rows from the Advancing sheet
 * @param {Array}  artists  - rows from the Artists sheet (for aliases)
 * @returns {{showId, showName, reason, confidence: 'high'|'medium'|'low', score: number}|null}
 */
function classifyEmailToShow(parsed, shows, advances = [], artists = []) {
  // Build the full haystack: headers + snippet + body (if present).
  // Body is the richest source of "context" — strip HTML so keywords match.
  let bodyText = '';
  if (parsed.textBody && parsed.textBody.trim()) {
    bodyText = parsed.textBody;
  } else if (parsed.htmlBody && parsed.htmlBody.trim()) {
    bodyText = htmlToText(parsed.htmlBody);
  }
  // Keep haystack bounded — first ~8k chars covers nearly all advance emails
  // without blowing memory when scanning hundreds of messages.
  if (bodyText.length > 8000) bodyText = bodyText.slice(0, 8000);

  const haystackParts = [
    parsed.subject || '',
    parsed.snippet || '',
    parsed.from    || '',
    parsed.to      || '',
    parsed.cc      || '',
    bodyText,
  ].map(s => String(s).toLowerCase());
  const hay    = haystackParts.join(' \n ');
  const fromTo = `${parsed.from || ''} ${parsed.to || ''} ${parsed.cc || ''}`.toLowerCase();

  // Parse the email's send date for temporal proximity scoring
  let emailDate = null;
  if (parsed.date) {
    const d = new Date(parsed.date);
    if (!isNaN(d)) emailDate = d;
  }

  // Map of show.artist (lowercased) -> alias list (lowercased)
  const aliasMap = new Map();
  for (const a of artists) {
    const name = (a.name || '').toLowerCase().trim();
    if (!name) continue;
    const aliases = String(a.aliases || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    aliasMap.set(name, aliases);
  }

  // Helper: resolve a show's artist string to a row in the artist registry.
  function resolveArtist(artistStr) {
    if (!artistStr) return null;
    const key = String(artistStr).trim().toLowerCase();
    if (!key) return null;
    for (const a of artists) {
      const name = String(a.name || '').trim().toLowerCase();
      if (!name) continue;
      if (name === key) return a;
      const aliases = String(a.aliases || '').split(',').map(s => s.trim().toLowerCase());
      if (aliases.includes(key)) return a;
      if (key.includes(name) || name.includes(key)) return a;
    }
    return null;
  }

  function withArtist(result, artistStr) {
    const a = resolveArtist(artistStr);
    if (a) { result.artistId = a.id; result.artistName = a.name || ''; }
    return result;
  }

  // 1) Advance-contact email match (always highest confidence)
  for (const adv of advances) {
    const ae = (adv.advanceEmail || '').toLowerCase().trim();
    if (ae && fromTo.includes(ae)) {
      const show = shows.find(s => s.id === adv.showId);
      const showName = show
        ? `${show.date || ''} — ${show.artist || show.eventName || ''}`.trim().replace(/^—\s*/, '')
        : (adv.showName || '');
      return withArtist(
        { showId: adv.showId, showName, reason: `contact:${ae}`, confidence: 'high', score: 100 },
        show?.artist || ''
      );
    }
  }

  // 2) Score every show by artist/event/date hits — longer tokens win.
  let best = null;
  for (const s of shows) {
    let score = 0;
    const hits = [];
    const artist = (s.artist || '').toLowerCase().trim();
    const event  = (s.eventName || '').toLowerCase().trim();

    let artistHit = false;
    if (artist && artist.length >= 3 && hay.includes(artist)) {
      score += 10 + artist.length; hits.push(`artist:${artist}`); artistHit = true;
    } else if (artist) {
      const aliases = aliasMap.get(artist) || [];
      for (const al of aliases) {
        if (al.length >= 3 && hay.includes(al)) {
          score += 10 + al.length; hits.push(`alias:${al}`); artistHit = true; break;
        }
      }
    }

    if (event && event.length >= 4 && hay.includes(event)) {
      score += 8 + event.length; hits.push(`event:${event}`);
    }

    let dateInBody = false;
    if (s.date) {
      for (const v of _dateVariants(s.date)) {
        if (v.length >= 4 && hay.includes(v)) {
          score += 5; hits.push(`date:${v}`); dateInBody = true; break;
        }
      }
    }

    if (emailDate && s.date) {
      const sd = new Date(s.date);
      if (!isNaN(sd)) {
        const diffDays = (sd - emailDate) / 86400000;
        if (diffDays >= -14 && diffDays <= 60) {
          score += 3; hits.push('proximity');
          if (artistHit) score += 5;
        }
      }
    }

    if (score > 0 && (!best || score > best.score)) {
      best = { score, show: s, reason: hits.join('+'), artistHit, dateInBody };
    }
  }

  // 3) Fallback: look for ANY artist in the registry mentioned in the email,
  //    even if no specific dated show qualifies. Emails about a band that
  //    isn't on the calendar yet (or that spans multiple shows) still get
  //    linked to the artist record so the conversation is preserved.
  function findArtistOnly() {
    let bestA = null;
    for (const a of artists) {
      const name = String(a.name || '').trim().toLowerCase();
      if (!name || name.length < 3) continue;
      let hit = null;
      if (hay.includes(name)) hit = { artist: a, via: name, len: name.length };
      else {
        const aliases = String(a.aliases || '').split(',').map(s => s.trim().toLowerCase()).filter(s => s.length >= 3);
        for (const al of aliases) {
          if (hay.includes(al)) { hit = { artist: a, via: al, len: al.length }; break; }
        }
      }
      if (hit && (!bestA || hit.len > bestA.len)) bestA = hit;
    }
    return bestA;
  }

  if (!best || (!best.artistHit && !best.dateInBody) || best.score < 10) {
    const artistOnly = findArtistOnly();
    if (artistOnly) {
      // Direct name match is medium confidence; alias-only is low.
      const aliases = String(artistOnly.artist.aliases || '').toLowerCase();
      const isPrimary = artistOnly.via === String(artistOnly.artist.name || '').trim().toLowerCase();
      return {
        artistId:   artistOnly.artist.id,
        artistName: artistOnly.artist.name || '',
        showId:     '',
        showName:   '',
        reason:     `artist-only:${artistOnly.via}`,
        confidence: isPrimary ? 'medium' : 'low',
        score:      10 + artistOnly.len,
      };
    }
    if (!best) return null;
    if (best.score < 10) return null;
  }

  // Confidence: artist + date (or proximity) is high; artist alone is medium;
  // date or weak signal alone is low (caller can decide to treat as suggestion).
  let confidence = 'low';
  if (best.artistHit && (best.dateInBody || best.reason.includes('proximity'))) {
    confidence = 'high';
  } else if (best.artistHit) {
    confidence = 'medium';
  } else if (best.dateInBody && best.score >= 13) {
    confidence = 'medium';
  }

  const s = best.show;
  const showName = `${s.date || ''} — ${s.artist || s.eventName || ''}`.trim().replace(/^—\s*/, '');
  return withArtist(
    { showId: s.id, showName, reason: best.reason, confidence, score: best.score },
    s.artist || ''
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// SCHEDULE / RUN-OF-SHOW EXTRACTOR
// Pulls a day-of-show timeline out of emails that look like a ROS / day sheet /
// schedule / itinerary. Returns an ordered list of { time, label, responsible?,
// notes?, confidence, source } items the UI can review and apply to /schedule.
// ──────────────────────────────────────────────────────────────────────────────

// Subject/body keywords that flag an email as schedule-bearing.
const SCHEDULE_KEYWORDS = [
  'run of show', 'run-of-show', 'ros',
  'day sheet', 'daysheet', 'day-sheet',
  'day of show', 'day-of-show',
  'schedule', 'itinerary', 'timeline',
  'show day', 'advance schedule',
];

// Common responsible-party hints — when one shows up near a line we tag it.
const RESPONSIBLE_HINTS = [
  { rx: /\b(stagehand|local crew|loaders?)\b/i,        who: 'Stagehands' },
  { rx: /\b(audio|sound|foh|monitors?|a1|a2)\b/i,      who: 'Audio' },
  { rx: /\b(lighting|lx|ld|l1)\b/i,                    who: 'Lighting' },
  { rx: /\b(video|v1|cam(era)?|projection)\b/i,        who: 'Video' },
  { rx: /\b(backline|bl|stage tech)\b/i,               who: 'Stage' },
  { rx: /\b(catering|caterer|meal)\b/i,                who: 'Hospitality' },
  { rx: /\b(hospitality|green room|dressing room)\b/i, who: 'Hospitality' },
  { rx: /\b(security|t-shirt|merch)\b/i,               who: 'House' },
  { rx: /\b(box office|will call|doors?)\b/i,          who: 'FOH' },
  { rx: /\b(production|prod\b)\b/i,                    who: 'Production' },
  { rx: /\b(tour|tm|tour manager|artist|band|talent)\b/i, who: 'Tour' },
];

// Pull a clock time off the front of a line. Returns null when nothing parses.
// Handles:
//   "9:00 AM", "9:00am", "09:00", "9 AM", "9pm",
//   "9:00 - 10:00 AM"  (start is taken),
//   "12:00 NOON" / "12:00 MIDNIGHT"
function _parseClockTime(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // Try "HH:MM[am|pm]" or "HH[am|pm]" or "HH:MM" (24h)
  const m = s.match(/^([0-2]?\d)(?::([0-5]\d))?\s*(am|pm|noon|midnight)?\b/i);
  if (!m) return null;
  let h  = parseInt(m[1], 10);
  let mm = m[2] ? parseInt(m[2], 10) : 0;
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'noon')     { h = 12; mm = 0; }
  else if (ap === 'midnight') { h = 0; mm = 0; }
  else if (ap === 'pm' && h < 12) h += 12;
  else if (ap === 'am' && h === 12) h = 0;
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// Regex matching a line that begins with a time, separated from the label by
// space, dash, en/em dash, colon, tab, or pipe. The capture groups give us the
// raw time string and the rest of the line.
const LINE_RX = /^[\s>*-]*([0-2]?\d(?::[0-5]\d)?\s*(?:am|pm|noon|midnight)?)\s*[-\u2013\u2014:|\t\s]\s*(.+?)\s*$/i;

function _scoreScheduleEmail(emailLike) {
  const hay = `${emailLike.subject || ''} ${emailLike.snippet || ''} ${emailLike.textBody || ''}`.toLowerCase();
  let score = 0;
  for (const kw of SCHEDULE_KEYWORDS) {
    if (hay.includes(kw)) score += kw.length >= 8 ? 3 : 2;
  }
  // Bonus when the subject itself is labeled as a schedule
  const subj = String(emailLike.subject || '').toLowerCase();
  if (/\b(ros|run of show|day sheet|schedule|itinerary)\b/.test(subj)) score += 5;
  return score;
}

function _guessResponsible(text) {
  for (const { rx, who } of RESPONSIBLE_HINTS) {
    if (rx.test(text)) return who;
  }
  return '';
}

// Pull schedule rows out of one block of text. Returns [{ time, label, responsible, raw }]
function _parseScheduleBlock(text) {
  if (!text) return [];
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let lastHHMM = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line || line.length > 200) continue;
    const m = line.match(LINE_RX);
    if (!m) continue;
    const time = _parseClockTime(m[1]);
    if (!time) continue;
    let label = m[2].trim();
    // Trim trailing parenthetical-only or trailing dashes
    label = label.replace(/^[-\u2013\u2014:\s]+/, '').replace(/\s+/g, ' ');
    if (!label || label.length < 2 || label.length > 120) continue;
    // Skip if the "label" is actually just another time range
    if (/^\d{1,2}(:\d{2})?\s*(am|pm)?$/i.test(label)) continue;

    // Crude monotonicity check — schedules generally go forward in time.
    // If the new time is earlier than the previous one by >12h we probably
    // crossed into "the next day"; we still accept it but stop boosting score.
    lastHHMM = time;

    out.push({
      time,
      label,
      responsible: _guessResponsible(label),
      raw: line,
    });
  }
  return out;
}

/**
 * @param {Array}  emails  - [{subject, from, date, snippet, textBody?, htmlBody?, gmailMessageId, direction?}]
 * @param {Object} [opts]
 * @param {number} [opts.minScore=2] - minimum schedule-keyword score to consider an email
 * @returns {{items: Array, sources: Array, scannedCount: number, extractedAt: string}}
 *   items[i] = { time, label, responsible, notes, confidence, source: {emailId, subject, from, date, quote} }
 */
function extractSchedule(emails = [], opts = {}) {
  const minScore = opts.minScore ?? 2;
  // Sort newest-first so the freshest schedule wins on time collisions.
  const sorted = [...emails].sort((a, b) =>
    (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)
  );

  // Per-time-slot bag of candidates: "HH:MM|label-lower" -> candidate
  const bag = new Map();
  const sources = [];
  let scanned = 0;

  for (const e of sorted) {
    // Skip outbound messages — we want what the tour/promoter sent us.
    if ((e.direction || '').toLowerCase() === 'outbound') continue;

    const score = _scoreScheduleEmail(e);
    if (score < minScore) continue;
    scanned++;

    // Prefer plain text body; otherwise convert HTML.
    let body = e.textBody && e.textBody.trim()
      ? e.textBody
      : (e.htmlBody ? htmlToText(e.htmlBody) : '');
    if (!body) body = `${e.subject || ''}\n${e.snippet || ''}`;
    if (body.length > 16000) body = body.slice(0, 16000);

    const rows = _parseScheduleBlock(body);
    if (rows.length === 0) continue;

    // Email-level confidence: lots of items + strong keywords = high.
    let conf = 'low';
    if (rows.length >= 6 && score >= 6) conf = 'high';
    else if (rows.length >= 3 && score >= 4) conf = 'medium';

    const sourceMeta = {
      emailId: e.gmailMessageId || e.id || '',
      subject: e.subject || '',
      from:    e.from    || '',
      date:    e.date    || '',
      itemCount: rows.length,
      score,
      confidence: conf,
    };
    sources.push(sourceMeta);

    for (const r of rows) {
      const key = `${r.time}|${r.label.toLowerCase()}`;
      const candidate = {
        time:        r.time,
        label:       r.label,
        responsible: r.responsible || '',
        notes:       '',
        confidence:  conf,
        source: {
          emailId: sourceMeta.emailId,
          subject: sourceMeta.subject,
          from:    sourceMeta.from,
          date:    sourceMeta.date,
          quote:   r.raw.slice(0, 200),
        },
      };
      const prev = bag.get(key);
      if (!prev || CONF[candidate.confidence] > CONF[prev.confidence]) {
        bag.set(key, candidate);
      }
    }
  }

  // Final ordering: by clock time, then label
  const items = [...bag.values()].sort((a, b) => {
    if (a.time !== b.time) return a.time.localeCompare(b.time);
    return a.label.localeCompare(b.label);
  });

  return {
    items,
    sources,
    scannedCount: scanned,
    extractedAt: new Date().toISOString(),
  };
}

module.exports = {
  analyzeAdvance,
  stripHtml,
  htmlToText,
  extractFromEmails,
  classifyEmailToShow,
  extractSchedule,
  FIELD_LABELS,
};
