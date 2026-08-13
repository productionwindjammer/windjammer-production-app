// Tech Pack export: one long stage document, print/PDF or downloadable HTML.

import { escHtml, openPrintWindow, safeFilename, triggerDownload } from './exportHelpers'

function stripHtmlEditorNoise(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
}

function sectionsHtml(sections) {
  const rendered = sections
    .filter(s => stripHtmlEditorNoise(s.content).trim())
    .map((s, i) => `
      <section style="${i === 0 ? '' : 'margin-top:28px;'}">
        <h2 style="border-bottom:1px solid #ccc;padding-bottom:6px;margin-bottom:10px">
          ${escHtml(s.icon || '')} ${escHtml(s.title)}
        </h2>
        <div class="content">${stripHtmlEditorNoise(s.content)}</div>
      </section>
    `).join('')
  return rendered || '<em>(This tech pack is empty.)</em>'
}

/** Print an entire stage's tech pack as one long document. */
export function exportTechPackStagePrint({ stageLabel, sections, updatedAt }) {
  openPrintWindow({
    title:    `Tech Pack — ${stageLabel}`,
    heading:  'Tech Pack',
    subtitle: stageLabel,
    meta: updatedAt ? [{ label: 'Last updated', value: new Date(updatedAt).toLocaleString() }] : [],
    bodyHtml: sectionsHtml(sections),
    orientation: 'portrait',
  })
}

/** Download a stage's tech pack as a self-contained HTML file. */
export function exportTechPackStageHtml({ stageLabel, sections, updatedAt }) {
  const title = `Tech Pack — ${stageLabel}`
  const stamp = updatedAt
    ? `<div style="color:#555;font-size:0.85em;margin-bottom:14px">Last updated ${escHtml(new Date(updatedAt).toLocaleString())}</div>`
    : ''
  const full = `<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(title)}</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; max-width: 8.5in; margin: 0.5in auto; color: #111; }
  h1 { margin: 0 0 4px; }
  h2 { margin: 24px 0 8px; border-bottom: 1px solid #ccc; padding-bottom: 6px; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; }
</style></head><body>
  <h1>${escHtml(stageLabel)} Tech Pack</h1>
  ${stamp}
  ${sectionsHtml(sections)}
</body></html>`
  triggerDownload(
    safeFilename(`${stageLabel}_TechPack`) + '.html',
    'text/html;charset=utf-8',
    full,
  )
}

/** Print/save just one section as PDF. */
export function exportTechPackSectionPrint({ stageLabel, section, updatedAt }) {
  openPrintWindow({
    title:    `${stageLabel} — ${section.title}`,
    heading:  section.title,
    subtitle: stageLabel,
    meta: updatedAt ? [{ label: 'Last updated', value: new Date(updatedAt).toLocaleString() }] : [],
    bodyHtml: `<div class="content">${stripHtmlEditorNoise(section.content) || '<em>(This section is empty.)</em>'}</div>`,
    orientation: 'portrait',
  })
}
