// Shows list export (Print / CSV).

import {
  csvCell, csvRow, downloadCsv, htmlTable, money, openPrintWindow,
} from './exportHelpers'
import { formatTime } from './time'

function stageLabel(s) {
  if (s === 'inside') return 'Inside'
  if (s === 'beach')  return 'Beach'
  return s || ''
}

function pickShowFields(row, opts = {}) {
  const { timeFormat = '12h', laborCostByShow, includeFinancials } = opts
  const laborCost = laborCostByShow?.get?.(row.id)
  const fields = {
    date:      row.date || '',
    artist:    row.artist || row.eventName || '',
    stage:     stageLabel(row.stage),
    doorsTime: row.doorsTime ? formatTime(row.doorsTime, timeFormat) : '',
    showTime:  row.showTime  ? formatTime(row.showTime,  timeFormat) : '',
    capacity:  row.capacity || '',
    ticketPrice: row.ticketPrice ? money(row.ticketPrice) : '',
    status:    row.status || 'pending',
    support:   row.support || '',
    tourManager: row.tourManager || '',
    promoter:  row.promoter || '',
    laborCost: includeFinancials && Number.isFinite(laborCost) && laborCost > 0 ? money(laborCost) : '',
  }
  return fields
}

/** @param {Array} rows  @param {Object} opts */
export function buildShowsCsv(rows, opts = {}) {
  const { includeFinancials } = opts
  const header = [
    'Date', 'Artist / Event', 'Stage', 'Doors', 'Show Time',
    'Capacity', 'Ticket Price', 'Status', 'Support', 'Tour Manager', 'Promoter',
  ]
  if (includeFinancials) header.push('Labor Cost')

  const lines = [
    csvCell('Shows'),
    csvCell(`Exported: ${new Date().toLocaleString()}`),
    '',
    csvRow(header),
  ]
  rows.forEach(r => {
    const f = pickShowFields(r, opts)
    const line = [f.date, f.artist, f.stage, f.doorsTime, f.showTime,
                  f.capacity, f.ticketPrice, f.status, f.support, f.tourManager, f.promoter]
    if (includeFinancials) line.push(f.laborCost)
    lines.push(csvRow(line))
  })
  return lines
}

export function exportShowsCsv(rows, opts) {
  downloadCsv('shows', buildShowsCsv(rows, opts))
}

export function exportShowsPrint(rows, opts = {}) {
  const { includeFinancials, filterMeta = {} } = opts
  const columns = [
    { label: 'Date' },
    { label: 'Artist / Event' },
    { label: 'Stage' },
    { label: 'Show Time' },
    { label: 'Cap', align: 'right' },
    { label: 'Status' },
    { label: 'Tour Manager' },
  ]
  if (includeFinancials) columns.push({ label: 'Labor Cost', align: 'right' })

  const bodyRows = rows.map(r => {
    const f = pickShowFields(r, opts)
    const line = [f.date, f.artist, f.stage, f.showTime, f.capacity, f.status, f.tourManager]
    if (includeFinancials) line.push(f.laborCost)
    return line
  })

  const meta = [
    filterMeta.stage  && { label: 'Stage',  value: stageLabel(filterMeta.stage) },
    filterMeta.status && { label: 'Status', value: filterMeta.status },
    filterMeta.search && { label: 'Search', value: filterMeta.search },
    { label: 'Rows',   value: String(rows.length) },
  ].filter(Boolean)

  openPrintWindow({
    title: 'Shows',
    heading: 'Shows',
    meta,
    bodyHtml: htmlTable(columns, bodyRows),
    orientation: 'landscape',
  })
}
