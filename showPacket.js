'use strict';

// Show Packet — the one-page printable a PM takes on-site.
// Composed from authoritative sheet rows only. NO AI content, NO extraction,
// NO fabrication. If a field is missing it prints as "—".

const sheets = require('./sheets');
const config = require('./config/server-config');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function or(v, fallback = '—') {
  const s = String(v == null ? '' : v).trim();
  return s ? s : fallback;
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' });
}

async function buildPacketData(showId) {
  const [shows, advances, schedule, labor, docs, contacts, asks] = await Promise.all([
    sheets.getRows(config.googleSheets.sheets.shows),
    sheets.getRows(config.googleSheets.sheets.advancing),
    sheets.getRows(config.googleSheets.sheets.schedule),
    sheets.getRows(config.googleSheets.sheets.labor),
    sheets.getRows(config.googleSheets.sheets.artistDocuments).catch(() => []),
    sheets.getRows(config.googleSheets.sheets.showContacts).catch(() => []),
    sheets.getRows(config.googleSheets.sheets.showAsks).catch(() => []),
  ]);
  const show = shows.find(s => String(s.id) === String(showId));
  if (!show) { const e = new Error('show_not_found'); e.code = 'not_found'; throw e; }
  const advance = advances.find(a => String(a.showId) === String(showId)) || {};
  const showSchedule = schedule.filter(r => String(r.showId) === String(showId))
    .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const showLabor = labor.filter(r => String(r.showId) === String(showId))
    .sort((a, b) => (a.callTime || '').localeCompare(b.callTime || ''));
  const showDocs = docs.filter(d => String(d.showId) === String(showId));
  const showContacts = contacts.filter(c => String(c.showId) === String(showId));
  const openAsks = asks.filter(a =>
    String(a.showId) === String(showId) && a.status !== 'received' && a.status !== 'cancelled');
  return { show, advance, showSchedule, showLabor, showDocs, showContacts, openAsks };
}

function renderPacketHtml(data) {
  const { show, advance, showSchedule, showLabor, showDocs, showContacts, openAsks } = data;
  const shorePower = advance.hasShorePower === 'yes' ? 'Available'
    : advance.hasShorePower === 'no'      ? 'NOT available (generator required)'
    : advance.hasShorePower === 'n/a'     ? 'N/A (no buses)'
    : '—';
  const contactRows = showContacts.length
    ? showContacts
        .sort((a, b) => (a.role || '').localeCompare(b.role || ''))
        .map(c => `<tr>
          <td>${esc(or(c.role))}</td>
          <td><strong>${esc(or(c.name))}</strong>${c.isPrimary === 'true' ? ' <span class="tag">Primary</span>' : ''}</td>
          <td>${esc(or(c.phone))}</td>
          <td>${esc(or(c.email))}</td>
          <td class="muted">${esc(or(c.notes, ''))}</td>
        </tr>`).join('')
    : '<tr><td colspan="5" class="muted center">No contacts on file.</td></tr>';
  const scheduleRows = showSchedule.length
    ? showSchedule.map(r => `<tr>
        <td class="mono">${esc(or(r.time))}</td>
        <td>${esc(or(r.label))}</td>
        <td>${esc(or(r.responsible, ''))}</td>
        <td class="muted">${esc(or(r.notes, ''))}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="muted center">No schedule items entered.</td></tr>';
  const laborRows = showLabor.length
    ? showLabor.map(r => `<tr>
        <td class="mono">${esc(or(r.callTime))}</td>
        <td class="mono">${esc(or(r.wrapTime, ''))}</td>
        <td>${esc(or(r.workerName))}</td>
        <td>${esc(or(r.role))}</td>
        <td class="muted">${esc(or(r.notes, ''))}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="muted center">No labor call entered.</td></tr>';
  const asksRows = openAsks.length
    ? openAsks.map(a => `<tr>
        <td>${esc(or(a.item))}</td>
        <td>${esc(or(a.askedOf, ''))}</td>
        <td class="mono">${esc(or(a.askedAt ? a.askedAt.slice(0, 10) : ''))}</td>
        <td class="mono">${esc(or(a.dueBy || ''))}</td>
        <td class="muted">${esc(or(a.notes, ''))}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="muted center">Nothing outstanding. Nice.</td></tr>';
  const docList = showDocs.length
    ? showDocs.map(d => `<li>${esc(or(d.name))}${d.category ? ` <span class="muted">(${esc(d.category)})</span>` : ''}</li>`).join('')
    : '<li class="muted">No documents on file.</li>';

  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Show Packet · ${esc(or(show.artist))} · ${esc(or(show.date))}</title>
<style>
  @media print { @page { margin: 0.4in; } .noprint { display: none !important; } }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #111; font: 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 8in; margin: 0 auto; padding: 24px; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  h2 { margin: 22px 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: #444; border-bottom: 1px solid #ddd; padding-bottom: 3px; }
  .hdr { display: flex; justify-content: space-between; align-items: flex-start; }
  .hdr .meta { text-align: right; font-size: 12px; color: #444; }
  .kv { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px 16px; margin: 8px 0; }
  .kv > div { font-size: 11.5px; }
  .kv .k { color: #666; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
  th { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em; color: #666; font-weight: 600; }
  .mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; white-space: nowrap; }
  .muted { color: #888; }
  .center { text-align: center; }
  .tag { display: inline-block; background: #e6f4ea; color: #106a1f; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.05em; padding: 1px 5px; border-radius: 3px; margin-left: 4px; }
  .toolbar { position: sticky; top: 0; background: #f8fafc; padding: 8px 12px; border-bottom: 1px solid #e2e8f0; text-align: right; }
  .toolbar button { background: #111; color: #fff; border: 0; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .note { white-space: pre-wrap; margin: 4px 0 0; font-size: 11.5px; }
  .footer { margin-top: 24px; padding-top: 8px; border-top: 1px solid #ddd; color: #999; font-size: 10.5px; text-align: center; }
</style>
</head><body>
<div class="toolbar noprint"><button onclick="window.print()">Print / Save PDF</button></div>
<div class="wrap">
  <div class="hdr">
    <div>
      <h1>${esc(or(show.artist))}</h1>
      <div class="muted">${esc(or(show.eventName, ''))}</div>
    </div>
    <div class="meta">
      <div><strong>${esc(fmtDate(show.date))}</strong></div>
      <div>${esc(or(show.venue, ''))}${show.stage ? ` · ${esc(show.stage)}` : ''}</div>
      <div>Doors ${esc(or(show.doorsTime))} · Show ${esc(or(show.showTime))}</div>
    </div>
  </div>

  <h2>Show Info</h2>
  <div class="kv">
    <div><div class="k">Capacity</div>${esc(or(show.capacity))}</div>
    <div><div class="k">Support</div>${esc(or(show.support, ''))}</div>
    <div><div class="k">Promoter</div>${esc(or(show.promoter, ''))}</div>
    <div><div class="k">Tour Manager</div>${esc(or(show.tourManager, ''))}</div>
  </div>

  <h2>Load-In Logistics</h2>
  <div class="kv">
    <div><div class="k">Load-In Start</div>${esc(or(advance.loadInStart))}</div>
    <div><div class="k">Load-Out End</div>${esc(or(advance.loadOutEnd))}</div>
    <div><div class="k">Curfew</div>${esc(or(advance.curfew))}</div>
    <div><div class="k">Sound Restrictions</div>${esc(or(advance.soundRestrictions))}</div>
    <div><div class="k">Trucks</div>${esc(or(advance.truckCount))}</div>
    <div><div class="k">Buses</div>${esc(or(advance.busCount))}</div>
    <div><div class="k">Shore Power</div>${esc(shorePower)}</div>
    <div><div class="k">Rider Received</div>${advance.riderReceived === 'true' ? 'Yes' : 'No'}</div>
  </div>
  ${advance.dockAccess ? `<div class="note"><strong>Dock / Access:</strong> ${esc(advance.dockAccess)}</div>` : ''}

  <h2>Call Sheet</h2>
  <table>
    <thead><tr><th>Role</th><th>Name</th><th>Phone</th><th>Email</th><th>Notes</th></tr></thead>
    <tbody>${contactRows}</tbody>
  </table>

  <h2>Schedule</h2>
  <table>
    <thead><tr><th>Time</th><th>Item</th><th>Responsible</th><th>Notes</th></tr></thead>
    <tbody>${scheduleRows}</tbody>
  </table>

  <h2>Labor Call</h2>
  <table>
    <thead><tr><th>Call</th><th>Wrap</th><th>Name</th><th>Role</th><th>Notes</th></tr></thead>
    <tbody>${laborRows}</tbody>
  </table>

  <h2>Waiting On</h2>
  <table>
    <thead><tr><th>Item</th><th>Asked Of</th><th>Asked</th><th>Due</th><th>Notes</th></tr></thead>
    <tbody>${asksRows}</tbody>
  </table>

  <h2>Production Notes</h2>
  ${advance.riderNotes       ? `<div class="note"><strong>Rider:</strong> ${esc(advance.riderNotes)}</div>` : ''}
  ${advance.productionNeeds  ? `<div class="note"><strong>Production:</strong> ${esc(advance.productionNeeds)}</div>` : ''}
  ${advance.backlineNotes    ? `<div class="note"><strong>Backline:</strong> ${esc(advance.backlineNotes)}</div>` : ''}
  ${advance.localCrewNeeds   ? `<div class="note"><strong>Local Crew:</strong> ${esc(advance.localCrewNeeds)}</div>` : ''}
  ${advance.cateringNotes    ? `<div class="note"><strong>Catering:</strong> ${esc(advance.cateringNotes)}</div>` : ''}
  ${advance.hospitalityNotes ? `<div class="note"><strong>Hospitality:</strong> ${esc(advance.hospitalityNotes)}</div>` : ''}
  ${advance.stagingChanges   ? `<div class="note"><strong>Staging Changes:</strong> ${esc(advance.stagingChanges)}</div>` : ''}
  ${advance.notes            ? `<div class="note"><strong>Other:</strong> ${esc(advance.notes)}</div>` : ''}
  ${!(advance.riderNotes || advance.productionNeeds || advance.backlineNotes || advance.localCrewNeeds || advance.cateringNotes || advance.hospitalityNotes || advance.stagingChanges || advance.notes)
    ? '<div class="muted">No production notes entered.</div>' : ''}

  <h2>Documents On File</h2>
  <ul>${docList}</ul>

  <div class="footer">Generated ${esc(new Date().toLocaleString())} · Windjammer Production</div>
</div>
</body></html>`;
}

module.exports = { buildPacketData, renderPacketHtml };
