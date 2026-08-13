// Labor sheet export (print/PDF + CSV).
// Consumes the filtered row set already shown in the UI so the printout
// matches what the operator sees on screen.

import {
  csvCell, csvRow, downloadCsv, escHtml, htmlTable, money, openPrintWindow, safeFilename,
} from './exportHelpers'
import { formatTime } from './time'

function fmtUnits(row) {
  if ((row.payType || 'hour') === 'day') {
    const n = row.days || 1
    return `${n} day${String(n) === '1' ? '' : 's'}`
  }
  return row.hours ? `${row.hours} hr` : ''
}

function fmtRate(row) {
  if (!row.rate) return ''
  return `${money(row.rate)}${(row.payType || 'hour') === 'day' ? '/day' : '/hr'}`
}

function stageLabel(s) {
  if (s === 'inside') return 'Inside'
  if (s === 'beach')  return 'Beach'
  return s || ''
}

function showLabel(row) {
  const isFacility = !row.showId
  const name = row.showName || (isFacility ? '(unlabeled)' : '')
  return isFacility ? `[Facility] ${name}` : name
}

/**
 * @param {Object} opts
 * @param {Array} opts.rows        Filtered labor rows to export.
 * @param {string} [opts.title]    Sheet title (defaults to "Labor Sheet").
 * @param {string} [opts.subtitle] Optional line under the heading.
 * @param {Object} [opts.filter]   Filter context to describe in the header.
 * @param {string} [opts.timeFormat] '12h' | '24h' (default '12h').
 * @param {boolean} [opts.includeFinancials] Whether to include Rate / Total columns.
 * @param {number}  [opts.totalCost] Precomputed total for the filtered rows.
 */
export function buildLaborCsv(opts) {
  const {
    rows, title = 'Labor Sheet', subtitle,
    filter = {}, timeFormat = '12h',
    includeFinancials = true, totalCost,
  } = opts

  const lines = []
  lines.push(csvCell(title))
  if (subtitle) lines.push(csvCell(subtitle))
  if (filter.showName) lines.push(csvCell(`Show: ${filter.showName}`))
  if (filter.stage)    lines.push(csvCell(`Stage: ${stageLabel(filter.stage)}`))
  lines.push(csvCell(`Exported: ${new Date().toLocaleString()}`))
  lines.push('')

  const headers = ['Worker', 'Role', 'Show / Task', 'Stage', 'Call', 'Wrap', 'Units']
  if (includeFinancials) headers.push('Rate', 'Total')
  headers.push('Union', 'Notes')
  lines.push(csvRow(headers))

  rows.forEach(r => {
    const base = [
      r.workerName || '',
      r.role       || '',
      showLabel(r),
      stageLabel(r.stage),
      r.callTime ? formatTime(r.callTime, timeFormat) : '',
      r.wrapTime ? formatTime(r.wrapTime, timeFormat) : '',
      fmtUnits(r),
    ]
    if (includeFinancials) base.push(fmtRate(r), r.total ? money(r.total) : '')
    base.push(r.union === 'true' ? 'Y' : '', r.notes || '')
    lines.push(csvRow(base))
  })

  if (includeFinancials && Number.isFinite(totalCost)) {
    lines.push('')
    lines.push(csvRow(['', '', '', '', '', '', 'TOTAL', '', money(totalCost)]))
  }

  return lines
}

export function exportLaborCsv(opts) {
  downloadCsv(safeFilename(opts.title || 'labor-sheet'), buildLaborCsv(opts))
}

export function exportLaborPrint(opts) {
  const {
    rows, title = 'Labor Sheet', subtitle,
    filter = {}, timeFormat = '12h',
    includeFinancials = true, totalCost,
  } = opts

  const columns = [
    { label: 'Worker' },
    { label: 'Role' },
    { label: 'Show / Task' },
    { label: 'Stage' },
    { label: 'Call' },
    { label: 'Wrap' },
    { label: 'Units' },
  ]
  if (includeFinancials) {
    columns.push({ label: 'Rate',  align: 'right' })
    columns.push({ label: 'Total', align: 'right' })
  }
  columns.push({ label: 'Union' })

  const bodyRows = rows.map(r => {
    const base = [
      r.workerName || '',
      r.role || '',
      showLabel(r),
      stageLabel(r.stage),
      r.callTime ? formatTime(r.callTime, timeFormat) : '',
      r.wrapTime ? formatTime(r.wrapTime, timeFormat) : '',
      fmtUnits(r),
    ]
    if (includeFinancials) base.push(fmtRate(r), r.total ? money(r.total) : '')
    base.push(r.union === 'true' ? '✓' : '')
    return base
  })

  let footRows
  if (includeFinancials && Number.isFinite(totalCost)) {
    const blanks = Array(columns.length - 3).fill('')
    footRows = [[...blanks, 'TOTAL', money(totalCost), '']]
  }

  const meta = []
  if (filter.showName) meta.push({ label: 'Show', value: filter.showName })
  if (filter.stage)    meta.push({ label: 'Stage', value: stageLabel(filter.stage) })
  meta.push({ label: 'Rows', value: String(rows.length) })

  const bodyHtml = `
    ${subtitle ? `<div class="sub" style="margin-bottom:8px">${escHtml(subtitle)}</div>` : ''}
    ${htmlTable(columns, bodyRows, { footRows })}
  `

  openPrintWindow({
    title,
    heading: title,
    meta,
    bodyHtml,
    orientation: 'landscape',
  })
}
