// Patch-list-specific export builders.
// See client/src/utils/exportHelpers.js for the shared building blocks.

import {
  escHtml, csvCell, csvRow, downloadCsv, openPrintWindow, safeFilename,
} from './exportHelpers'

/**
 * Build a CSV that contains both the inputs and outputs tables, separated by
 * a blank line and a section header. Columns: Ch, Name, +48V (inputs only),
 * then one column per patch point.
 */
export function buildPatchListCsv({ name, inputs, outputs, inputCols, outputCols, meta = {} }) {
  const lines = []
  lines.push(csvCell(`Patch List: ${name || 'Untitled'}`))
  if (meta.showTitle) lines.push(csvCell(`Show: ${meta.showTitle}`))
  if (meta.date)      lines.push(csvCell(`Date: ${meta.date}`))
  if (meta.stage)     lines.push(csvCell(`Stage: ${meta.stage}`))
  lines.push(csvCell(`Exported: ${new Date().toLocaleString()}`))
  lines.push('')

  lines.push(csvCell('INPUTS'))
  lines.push(csvRow(['Ch', 'Name', '+48V', ...inputCols]))
  inputs.forEach((r, i) => {
    lines.push(csvRow([
      r.n ?? (i + 1),
      r.name || '',
      r.phantom ? 'Y' : '',
      ...inputCols.map(c => r.patch?.[c] ?? ''),
    ]))
  })

  lines.push('')
  lines.push(csvCell('OUTPUTS'))
  lines.push(csvRow(['Ch', 'Name', ...outputCols]))
  outputs.forEach((r, i) => {
    lines.push(csvRow([
      r.n ?? (i + 1),
      r.name || '',
      ...outputCols.map(c => r.patch?.[c] ?? ''),
    ]))
  })

  return lines
}

export function exportPatchListCsv(data) {
  downloadCsv(safeFilename(data.name || 'patch-list'), buildPatchListCsv(data))
}

/** Open a print-optimized window with both tables laid out for landscape. */
export function exportPatchListPrint(data) {
  const { name, inputs, outputs, inputCols, outputCols, meta = {} } = data
  const title = name || 'Patch List'

  const inputHeadCells = ['Ch', 'Name', '+48V', ...inputCols]
    .map(h => `<th>${escHtml(h)}</th>`).join('')
  const inputRows = inputs.map((r, i) => `
    <tr>
      <td class="num" style="width:34px">${escHtml(r.n ?? (i + 1))}</td>
      <td style="font-weight:700;min-width:130px">${escHtml(r.name || '')}</td>
      <td class="num" style="width:40px;font-weight:900">${r.phantom ? '✕' : ''}</td>
      ${inputCols.map(c => `<td class="num">${escHtml(r.patch?.[c] ?? '')}</td>`).join('')}
    </tr>`).join('')

  const outputHeadCells = ['Ch', 'Name', ...outputCols]
    .map(h => `<th>${escHtml(h)}</th>`).join('')
  const outputRows = outputs.map((r, i) => `
    <tr>
      <td class="num" style="width:34px">${escHtml(r.n ?? (i + 1))}</td>
      <td style="font-weight:700;min-width:130px">${escHtml(r.name || '')}</td>
      ${outputCols.map(c => `<td class="num">${escHtml(r.patch?.[c] ?? '')}</td>`).join('')}
    </tr>`).join('')

  const bodyHtml = `
    <h2>Inputs (${inputs.length})</h2>
    <table>
      <thead><tr>${inputHeadCells}</tr></thead>
      <tbody>${inputRows}</tbody>
    </table>
    <h2>Outputs (${outputs.length})</h2>
    <table>
      <thead><tr>${outputHeadCells}</tr></thead>
      <tbody>${outputRows}</tbody>
    </table>
  `

  openPrintWindow({
    title,
    heading: title,
    meta: [
      { label: 'Show',  value: meta.showTitle },
      { label: 'Date',  value: meta.date },
      { label: 'Stage', value: meta.stage },
    ],
    bodyHtml,
    orientation: 'landscape',
  })
}

export function exportPatchList(format, data) {
  if (format === 'csv')   return exportPatchListCsv(data)
  if (format === 'print') return exportPatchListPrint(data)
}
