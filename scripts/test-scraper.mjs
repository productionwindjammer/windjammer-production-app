// One-off smoke test for the updated Windjammer scraper.
// Mirrors the helpers in server.js and prints what would be imported.
// Run with:  node scripts/test-scraper.mjs

const html = await fetch('https://the-windjammer.com/events/', {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
}).then(r => r.text());

const MO = { january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',
             july:'07',august:'08',september:'09',october:'10',november:'11',december:'12' };

const decodeHtml = s => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
  .replace(/&ndash;/g, '–').replace(/&mdash;/g, '—')
  .replace(/&hellip;/g, '…').replace(/&quot;/g, '"');

function detectStage(title) {
  const t = String(title || '').toLowerCase();
  if (/inside stage/.test(t)) return 'inside';
  if (/beach stage|on the beach|n[uü]trl/.test(t)) return 'beach';
  return 'inside';
}

function cleanArtistTitle(t) {
  return String(t || '')
    .replace(/\s*[-–]\s*21\s*(?:up|&\s*up|and\s*up)\b.*$/i, '')
    .replace(/\s*[-–]\s*night\s*\d+\s*$/i, '')
    .replace(/\s*[-–]\s*(mon|tues|wednes|thurs|fri|satur|sun)day(\s+(morning|afternoon|evening|night))?\s*$/i, '')
    .replace(/\s*\((mon|tues|wednes|thurs|fri|satur|sun)day\)\s*$/i, '')
    .replace(/\s*[-–]?\s*on the\s+(n[uü]trl\s+)?beach(\s+stage)?\s*$/i, '')
    .replace(/\s*[-–]?\s*on the\s+inside\s+stage\s*$/i, '')
    .replace(/\s*[-–]\s*$/, '')
    .trim();
}

function splitHeadlinerAndSupport(title) {
  let headliner = String(title || '').trim();
  let support   = '';
  let aliases   = '';
  if (!headliner) return { headliner: '', support: '', artistAliases: '' };
  const wm = headliner.match(/^(.+?)\s+(?:with|w\/)\s+(.+)$/i);
  if (wm) { headliner = wm[1].trim(); support = wm[2].trim(); }
  const fm = headliner.match(/^(.+?)\s+(?:featuring|feat\.?|ft\.?)\s+(.+)$/i);
  if (fm) { headliner = fm[1].trim(); aliases = fm[2].trim(); }
  return { headliner, support, artistAliases: aliases };
}

const events = [];
const seen = new Set();
const rows = html.split('<div class="event-content-row">');
rows.shift();

for (const row of rows) {
  const urlM = row.match(/href="(https?:\/\/the-windjammer\.com\/event\/[^"]+)"/i);
  if (!urlM) continue;
  const url = urlM[1].replace(/\/$/, '');
  if (seen.has(url)) continue;
  seen.add(url);

  const h2M = row.match(/<h2[^>]*>\s*<a[^>]*>([^<]+)<\/a>/i);
  const title = decodeHtml(h2M ? h2M[1].trim() : url.split('/event/')[1]?.replace(/-/g,' ') || '');
  if (!title) continue;

  let date = '';
  const dateDivM = row.match(/<div[^>]*event-content-date[^>]*>([\s\S]*?)<\/div>/i);
  if (dateDivM) {
    const dateText = dateDivM[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#\d+;/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const dmy = dateText.match(/(\d{1,2})\s+([a-z]+),?\s+(\d{4})/i);
    if (dmy) {
      const mo = MO[dmy[2].toLowerCase()] || '01';
      date = `${dmy[3]}-${mo}-${dmy[1].padStart(2, '0')}`;
    }
  }

  const ulM = row.match(/<ul[^>]*>([\s\S]*?)<\/ul>/i);
  let showTime = '';
  if (ulM) {
    const liM = [...ulM[1].matchAll(/<li[^>]*>([^<]+)<\/li>/gi)];
    showTime = liM[1]?.[1]?.trim() || '';
  }

  events.push({ title, date, time: showTime, stage: detectStage(title), url });
}

events.sort((a, b) => (a.date || '9999') < (b.date || '9999') ? -1 : 1);

const seenNight = new Set();
const cleaned = [];
for (const ev of events) {
  const clean = cleanArtistTitle(ev.title);
  const key = `${ev.date}|${clean.toLowerCase()}`;
  if (seenNight.has(key)) continue;
  seenNight.add(key);
  const { headliner, support, artistAliases } = splitHeadlinerAndSupport(clean);
  cleaned.push({ ...ev, title: clean, artist: headliner, support, artistAliases, runKey: clean.toLowerCase() });
}

const runCounts = new Map();
for (const ev of cleaned) runCounts.set(ev.runKey, (runCounts.get(ev.runKey) || 0) + 1);
const runSeen = new Map();
const withRuns = cleaned.map(ev => {
  const total = runCounts.get(ev.runKey) || 1;
  const idx = (runSeen.get(ev.runKey) || 0) + 1;
  runSeen.set(ev.runKey, idx);
  return { ...ev, multiNight: total > 1, runNights: total, nightIndex: idx };
});

console.log(`Parsed ${withRuns.length} nights.\n`);
for (const ev of withRuns) {
  const badge   = ev.multiNight ? ` [run ${ev.nightIndex}/${ev.runNights}]` : '';
  const supTag  = ev.support        ? `  · support: ${ev.support}`     : '';
  const aliasTag= ev.artistAliases  ? `  · alias: ${ev.artistAliases}` : '';
  console.log(`  [${ev.date}] [${ev.stage.padEnd(6)}] ${ev.time.padEnd(9)} — ${ev.artist}${badge}${supTag}${aliasTag}`);
}

console.log('\nMulti-night runs:');
const runs = new Map();
for (const ev of withRuns) {
  if (!ev.multiNight) continue;
  if (!runs.has(ev.runKey)) runs.set(ev.runKey, []);
  runs.get(ev.runKey).push(ev);
}
for (const [k, list] of runs) {
  console.log(`  ${list[0].title} (${list[0].stage}) — ${list.map(e => e.date).join(', ')}`);
}

// ── Dedupe against a synthetic "existing shows" sheet ─────────────────────────
// Verifies the same duplicate-checker used in server.js. Update these to match
// scenarios you want to test.
function normalizeArtistKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function buildDuplicateChecker(existingShows, existingArtists) {
  const alternates = new Map();
  for (const a of existingArtists || []) {
    const names = [a.name, ...String(a.aliases || '').split(',')]
      .map(normalizeArtistKey).filter(Boolean);
    if (names.length === 0) continue;
    for (const n of names) alternates.set(n, names);
  }
  const showsByUrl = new Map();
  const showsByDate = new Map();
  const URL_RE = /https?:\/\/the-windjammer\.com\/event\/[^\s"'>]+/i;
  for (const s of existingShows || []) {
    const m = String(s.notes || '').match(URL_RE);
    if (m) {
      const clean = m[0].replace(/\/$/, '');
      if (!showsByUrl.has(clean)) showsByUrl.set(clean, []);
      showsByUrl.get(clean).push(s);
    }
    const d = s.date || '';
    if (!d) continue;
    if (!showsByDate.has(d)) showsByDate.set(d, []);
    showsByDate.get(d).push({ key: normalizeArtistKey(s.artist || s.eventName || '') });
  }
  return function isDupOf(ev) {
    if (ev.url && showsByUrl.has(ev.url.replace(/\/$/, ''))) return true;
    if (!ev.date) return false;
    const dayShows = showsByDate.get(ev.date);
    if (!dayShows || dayShows.length === 0) return false;
    const evKeys = new Set();
    for (const raw of [ev.artist, ev.title]) {
      const k = normalizeArtistKey(raw);
      if (!k) continue;
      evKeys.add(k);
      for (const alt of alternates.get(k) || []) evKeys.add(alt);
    }
    for (const key of evKeys) {
      if (!key) continue;
      for (const { key: existingKey } of dayShows) {
        if (!existingKey) continue;
        if (existingKey === key) return true;
        if (existingKey.length >= 6 && key.includes(existingKey)) return true;
        if (key.length      >= 6 && existingKey.includes(key))    return true;
      }
    }
    return false;
  };
}

const fakeExistingShows = [
  // Manual entry, exact match on artist and date
  { date: '2026-08-20', artist: 'HIGH 5' },
  // Manual entry using a shorter form of the headliner
  { date: '2026-08-22', artist: 'Wilderado' },
  // Manual entry using an alias — should still match via the registry
  { date: '2026-08-30', artist: 'MB & Friends' },
  // Manual entry as an ampersand/and variant
  { date: '2026-10-17', artist: 'Ax And the Hatchetmen' },
  // Same URL was imported before under a slightly different artist name
  { date: '2026-11-05', artist: 'Drake M.', notes: 'imported from https://the-windjammer.com/event/drake-milligan-on-the-nutrl-beach-stage/' },
  // Different date should NOT block scraper's Aug 23 Wilderado
  { date: '2026-08-24', artist: 'Wilderado' },
];
const fakeExistingArtists = [
  { name: 'Mark Bryan & Friends', aliases: 'MB & Friends, MB and Friends' },
];

const isDup = buildDuplicateChecker(fakeExistingShows, fakeExistingArtists);
const flagged = withRuns.map(ev => ({ ...ev, isDup: isDup(ev) }));

console.log('\nDedupe against synthetic manual entries:');
for (const ev of flagged) {
  if (!ev.isDup) continue;
  console.log(`  SKIP  [${ev.date}] ${ev.artist} — matched an existing show`);
}
const wouldImport = flagged.filter(e => !e.isDup);
console.log(`\nWould import ${wouldImport.length} of ${flagged.length} scraped nights.`);
