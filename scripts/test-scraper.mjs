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

const normalizeTitle = t => t
  .replace(/\s*[-–]\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*/i, '')
  .replace(/\s*\((monday|tuesday|wednesday|thursday|friday|saturday|sunday)\)\s*$/i, '')
  .trim();

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
  const dateM = row.match(/<b>\s*(\d{1,2})\s*<\/b>\s*([\w]+),?\s*(\d{4})/i);
  if (dateM) {
    const mo = MO[dateM[2].toLowerCase()] || '01';
    date = `${dateM[3]}-${mo}-${dateM[1].padStart(2,'0')}`;
  }

  const ulM = row.match(/<ul[^>]*>([\s\S]*?)<\/ul>/i);
  let showTime = '';
  if (ulM) {
    const liM = [...ulM[1].matchAll(/<li[^>]*>([^<]+)<\/li>/gi)];
    showTime = liM[1]?.[1]?.trim() || '';
  }

  const stage = /beach|n[uü]trl/i.test(title) ? 'beach' : 'inside';
  events.push({ title, date, time: showTime, stage, url });
}

events.sort((a, b) => (a.date || '9999') < (b.date || '9999') ? -1 : 1);
const unique = [];
const seenTitle = new Set();
for (const ev of events) {
  const norm = normalizeTitle(ev.title).toLowerCase();
  if (seenTitle.has(norm)) continue;
  seenTitle.add(norm);
  unique.push({ ...ev, title: normalizeTitle(ev.title) });
}

console.log(`Found ${unique.length} unique events (from ${events.length} total):`);
unique.forEach(e => console.log(`  [${e.date}] [${e.stage}] ${e.time} — ${e.title}`));
