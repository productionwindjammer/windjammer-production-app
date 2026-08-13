// Shared client-side export helpers used by patch lists, labor sheets,
// settlement, tech pack, etc. Two primary formats:
//   1. Print / PDF  — opens a print-optimized new tab with a supplied HTML body.
//   2. CSV          — assembles rows via helpers and triggers a browser download.
//
// All helpers are DOM-only (no dependencies) so they run anywhere in the SPA.

// ── HTML / CSV escaping ─────────────────────────────────────────────────────
export function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function csvCell(v) {
  const s = String(v ?? '')
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function csvRow(cells) {
  return cells.map(csvCell).join(',')
}

export function toCsv(lines) {
  // Prepend BOM so Excel opens UTF-8 correctly.
  return '\ufeff' + lines.join('\r\n')
}

// ── Filename sanitizing ─────────────────────────────────────────────────────
export function safeFilename(s, fallback = 'export') {
  const cleaned = String(s || '')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 80)
  return cleaned || fallback
}

// ── Download trigger ────────────────────────────────────────────────────────
export function triggerDownload(filename, mime, content) {
  const blob = new Blob([content], { type: mime })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function downloadCsv(filename, lines) {
  triggerDownload(safeFilename(filename, 'export') + '.csv', 'text/csv;charset=utf-8', toCsv(lines))
}

// ── Print window ────────────────────────────────────────────────────────────
// Default styles apply to every printed document so we get consistent
// letterhead-style output across the app. Callers supply title, orientation,
// header meta, and the body HTML.

const PRINT_BASE_CSS = `
  * { box-sizing: border-box; }
  html, body { background: #fff; color: #000; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11pt; line-height: 1.35; padding: 16px 20px; }
  .hdr { border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 12px; }
  h1 { margin: 0 0 4px; font-size: 20pt; font-weight: 900; letter-spacing: 0.4px; text-transform: uppercase; }
  .sub { font-size: 12pt; font-weight: 700; margin-bottom: 4px; }
  .meta { display: flex; gap: 18px; flex-wrap: wrap; font-size: 10pt; }
  h2 { font-size: 12pt; margin: 14px 0 6px; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid #000; padding-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  th, td { border: 1px solid #000; padding: 4px 8px; text-align: left; vertical-align: top; }
  thead th { background: #000; color: #fff; font-size: 10pt; font-weight: 800; text-transform: uppercase; letter-spacing: 0.4px; }
  tbody td { font-size: 10pt; }
  tbody tr { page-break-inside: avoid; }
  .num, td.num, th.num { text-align: center; font-variant-numeric: tabular-nums; }
  .right { text-align: right; }
  .money { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .totals { margin-top: 8px; font-size: 11pt; }
  .totals table { width: auto; margin-left: auto; }
  .totals td { border: none; padding: 2px 8px; }
  .totals .lbl { text-align: right; color: #333; }
  .totals .val { text-align: right; font-weight: 800; font-variant-numeric: tabular-nums; }
  .totals .grand td { border-top: 2px solid #000; padding-top: 5px; font-size: 12pt; }
  .foot { margin-top: 14px; font-size: 8pt; text-align: right; color: #333; }
  .content { font-size: 11pt; line-height: 1.45; }
  .content h1, .content h2, .content h3 { border: none; text-transform: none; letter-spacing: 0; margin-top: 12px; }
  .content h1 { font-size: 16pt; }
  .content h2 { font-size: 14pt; }
  .content h3 { font-size: 12pt; }
  .content ul, .content ol { margin: 6px 0 8px 22px; }
  .content p  { margin: 6px 0; }
  .content img { max-width: 100%; }
  @media print { .noprint { display: none; } }
  .noprint { margin: 10px 0 12px; }
  .noprint button { font-size: 11pt; font-weight: 700; padding: 6px 14px; cursor: pointer; margin-right: 6px; }
`

/**
 * Open a new window containing a print-ready document.
 *
 * @param {Object} opts
 * @param {string} opts.title        Page/tab title and default filename hint.
 * @param {string} opts.heading      Big banner heading (usually same as title).
 * @param {string} [opts.subtitle]   Small line under the heading.
 * @param {Array<{label:string,value:string}>} [opts.meta]  Header pill list.
 * @param {string} opts.bodyHtml     Main content HTML (already escaped).
 * @param {'portrait'|'landscape'} [opts.orientation]  Default 'portrait'.
 * @param {'letter'|'a4'} [opts.paper] Default 'letter'.
 * @param {boolean} [opts.autoPrint] Auto-open print dialog on load (default true).
 * @param {number} [opts.winWidth]   Window width. Default 900.
 * @param {number} [opts.winHeight]  Window height. Default 1100.
 */
export function openPrintWindow(opts) {
  const {
    title, heading, subtitle,
    meta = [], bodyHtml,
    orientation = 'portrait',
    paper = 'letter',
    autoPrint = true,
    winWidth  = orientation === 'landscape' ? 1100 : 900,
    winHeight = 1100,
  } = opts

  const pageCss = `@page { size: ${paper} ${orientation}; margin: 0.45in; }`
  const metaHtml = meta.filter(m => m && m.value != null && m.value !== '')
    .map(m => `<span><strong>${escHtml(m.label)}:</strong> ${escHtml(m.value)}</span>`)
    .join('')

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(title)}</title>
<style>${pageCss}\n${PRINT_BASE_CSS}</style></head><body>
  <div class="noprint">
    <button onclick="window.print()">🖨️ Print / Save as PDF</button>
    <button onclick="window.close()">Close</button>
  </div>
  <div class="hdr">
    <h1>${escHtml(heading || title)}</h1>
    ${subtitle ? `<div class="sub">${escHtml(subtitle)}</div>` : ''}
    ${metaHtml ? `<div class="meta">${metaHtml}</div>` : ''}
  </div>
  ${bodyHtml}
  <div class="foot">Exported ${escHtml(new Date().toLocaleString())}</div>
  ${autoPrint ? `<script>window.addEventListener('load', () => setTimeout(() => window.print(), 300));<\/script>` : ''}
</body></html>`

  const w = window.open('', '_blank', `width=${winWidth},height=${winHeight}`)
  if (!w) { alert('Pop-up blocked. Please allow pop-ups to print this document.'); return null }
  w.document.open()
  w.document.write(html)
  w.document.close()
  return w
}

// ── HTML helpers for building tables in the print body ──────────────────────
/**
 * Build a table HTML string.
 * @param {Array<{label:string, align?:'left'|'right'|'center', className?:string}>} columns
 * @param {Array<Array<string|number>>} rows  Cell values (raw, will be escaped).
 * @param {Object} [opts]
 * @param {Array<Array<string|number>>} [opts.footRows] Optional footer rows.
 */
export function htmlTable(columns, rows, opts = {}) {
  const head = columns.map(c => {
    const cls = [c.align === 'right' ? 'right' : '', c.align === 'center' ? 'num' : '', c.className || '']
      .filter(Boolean).join(' ')
    return `<th${cls ? ` class="${cls}"` : ''}>${escHtml(c.label)}</th>`
  }).join('')

  const body = rows.map(r => {
    const cells = columns.map((c, i) => {
      const cls = [c.align === 'right' ? 'right' : '', c.align === 'center' ? 'num' : '', c.className || '']
        .filter(Boolean).join(' ')
      return `<td${cls ? ` class="${cls}"` : ''}>${escHtml(r[i] ?? '')}</td>`
    }).join('')
    return `<tr>${cells}</tr>`
  }).join('')

  const foot = (opts.footRows || []).map(r => {
    const cells = columns.map((c, i) => {
      const cls = [c.align === 'right' ? 'right' : '', c.align === 'center' ? 'num' : '', c.className || '']
        .filter(Boolean).join(' ')
      return `<td${cls ? ` class="${cls}"` : ''}>${escHtml(r[i] ?? '')}</td>`
    }).join('')
    return `<tr>${cells}</tr>`
  }).join('')

  return `<table>
    <thead><tr>${head}</tr></thead>
    <tbody>${body}</tbody>
    ${foot ? `<tfoot>${foot}</tfoot>` : ''}
  </table>`
}

// Currency formatter that handles null/blank input.
export function money(n) {
  const v = parseFloat(n)
  if (!Number.isFinite(v)) return ''
  return v.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
}
