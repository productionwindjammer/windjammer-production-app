// Tech Pack export: single doc or full stage bundle, print/PDF only
// (rich HTML content doesn't map cleanly to CSV).

import { escHtml, openPrintWindow, safeFilename, triggerDownload } from './exportHelpers'

function docHeading(stageLabel, docLabel) {
  return `${stageLabel} — ${docLabel}`
}

function stripHtmlEditorNoise(html) {
  // Very light sanitization: drop <script>/<style> if any snuck in.
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
}

/** Print a single tech pack document. */
export function exportTechPackDocPrint({ stageLabel, docLabel, html, updatedAt }) {
  const bodyHtml = `<div class="content">${stripHtmlEditorNoise(html) || '<em>(This document is empty.)</em>'}</div>`
  openPrintWindow({
    title:   docHeading(stageLabel, docLabel),
    heading: docLabel,
    subtitle: stageLabel,
    meta: updatedAt ? [{ label: 'Last saved', value: new Date(updatedAt).toLocaleString() }] : [],
    bodyHtml,
    orientation: 'portrait',
  })
}

/** Download a single doc's raw HTML (openable in browsers / Word). */
export function exportTechPackDocHtml({ stageLabel, docLabel, html }) {
  const title = docHeading(stageLabel, docLabel)
  const full = `<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(title)}</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; max-width: 8.5in; margin: 0.5in auto; color: #111; }
  h1, h2, h3 { margin-top: 1em; }
  img { max-width: 100%; }
</style></head><body>
  <h1>${escHtml(docLabel)}</h1>
  <div style="color:#555;margin-bottom:16px">${escHtml(stageLabel)}</div>
  ${stripHtmlEditorNoise(html) || '<em>(empty)</em>'}
</body></html>`
  triggerDownload(
    safeFilename(`${stageLabel}_${docLabel}`) + '.html',
    'text/html;charset=utf-8',
    full,
  )
}

/**
 * Print an entire stage's tech pack as one document (all sections stacked).
 * Each section starts on a fresh page.
 */
export function exportTechPackStagePrint({ stageLabel, sections }) {
  const bodyHtml = sections.map((sec, i) => `
    <div style="${i === 0 ? '' : 'page-break-before: always;'}">
      <h2>${escHtml(sec.docLabel)}</h2>
      <div class="content">${stripHtmlEditorNoise(sec.html) || '<em>(This document is empty.)</em>'}</div>
    </div>
  `).join('')

  openPrintWindow({
    title:   `Tech Pack — ${stageLabel}`,
    heading: 'Tech Pack',
    subtitle: stageLabel,
    meta: [{ label: 'Sections', value: String(sections.length) }],
    bodyHtml,
    orientation: 'portrait',
  })
}
