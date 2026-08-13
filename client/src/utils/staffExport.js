// Staff roster + single-staff profile export.

import {
  csvCell, csvRow, downloadCsv, escHtml, htmlTable, money, openPrintWindow, safeFilename,
} from './exportHelpers'

function stageLabel(s) {
  if (s === 'inside') return 'Inside'
  if (s === 'beach')  return 'Beach'
  if (s === 'both')   return 'Both'
  return s || ''
}

function parseRates(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : [] }
  catch { return [] }
}

function summarizeRate(row, includeFinancials) {
  if (!includeFinancials) return ''
  if ((row.payType || 'day') === 'day') {
    return row.dayRate ? `${money(row.dayRate)}/day` : ''
  }
  return row.hourlyRate ? `${money(row.hourlyRate)}/hr` : ''
}

/** Roster CSV: one row per staff member. */
export function buildStaffRosterCsv(rows, opts = {}) {
  const { includeFinancials = true } = opts
  const header = [
    'Name', 'Role', 'Department', 'Stage', 'Email', 'Phone',
    'Start Date', 'Onboarded', 'Status',
  ]
  if (includeFinancials) header.push('Default Rate')
  header.push('Certifications', 'Notes')

  const lines = [
    csvCell('Staff Roster'),
    csvCell(`Exported: ${new Date().toLocaleString()}`),
    '',
    csvRow(header),
  ]
  rows.forEach(s => {
    const base = [
      s.name || '',
      s.role || '',
      s.department || '',
      stageLabel(s.stage),
      s.email || '',
      s.phone || '',
      s.startDate || '',
      s.onboardingComplete === 'true' || s.onboardingComplete === true ? 'Y' : '',
      s.active === 'false' ? 'Inactive' : 'Active',
    ]
    if (includeFinancials) base.push(summarizeRate(s, true))
    base.push(s.certifications || '', s.notes || '')
    lines.push(csvRow(base))
  })
  return lines
}

export function exportStaffRosterCsv(rows, opts) {
  downloadCsv('staff-roster', buildStaffRosterCsv(rows, opts))
}

export function exportStaffRosterPrint(rows, opts = {}) {
  const { includeFinancials = true, filterMeta = {} } = opts
  const columns = [
    { label: 'Name' },
    { label: 'Role' },
    { label: 'Stage' },
    { label: 'Phone' },
    { label: 'Email' },
    { label: 'Status' },
  ]
  if (includeFinancials) columns.push({ label: 'Default Rate', align: 'right' })

  const bodyRows = rows.map(s => {
    const base = [
      s.name || '',
      s.role || '',
      stageLabel(s.stage),
      s.phone || '',
      s.email || '',
      s.active === 'false' ? 'Inactive' : 'Active',
    ]
    if (includeFinancials) base.push(summarizeRate(s, true))
    return base
  })

  const meta = [
    filterMeta.role   && { label: 'Role',   value: filterMeta.role },
    filterMeta.stage  && { label: 'Stage',  value: stageLabel(filterMeta.stage) },
    filterMeta.search && { label: 'Search', value: filterMeta.search },
    { label: 'Rows',  value: String(rows.length) },
  ].filter(Boolean)

  openPrintWindow({
    title: 'Staff Roster',
    heading: 'Staff Roster',
    meta,
    bodyHtml: htmlTable(columns, bodyRows),
    orientation: 'landscape',
  })
}

/** Per-staff profile sheet: personal info + rates + labor history totals. */
export function exportStaffProfilePrint(staff, opts = {}) {
  const {
    labor = [],
    includeFinancials = true,
    totals = {},
    timeFormat = '12h',
  } = opts

  const info = htmlTable(
    [{ label: 'Field' }, { label: 'Value' }],
    [
      ['Role',        staff.role || ''],
      ['Department',  staff.department || ''],
      ['Stage',       stageLabel(staff.stage)],
      ['Email',       staff.email || ''],
      ['Phone',       staff.phone || ''],
      ['Start Date',  staff.startDate || ''],
      ['Onboarded',   staff.onboardingComplete === 'true' || staff.onboardingComplete === true ? 'Yes' : 'No'],
      ['Status',      staff.active === 'false' ? 'Inactive' : 'Active'],
    ],
  )

  const rates = parseRates(staff.rates)
  const rateRows = []
  if (staff.dayRate || staff.hourlyRate) {
    rateRows.push(['Default', (staff.payType || 'day') === 'day'
      ? (staff.dayRate ? `${money(staff.dayRate)}/day` : '')
      : (staff.hourlyRate ? `${money(staff.hourlyRate)}/hr` : '')])
  }
  rates.forEach(r => {
    if (!r) return
    const rate = (r.payType || 'day') === 'day'
      ? (r.rate ? `${money(r.rate)}/day` : '')
      : (r.rate ? `${money(r.rate)}/hr` : '')
    rateRows.push([r.role || '(unnamed)', rate])
  })
  const ratesHtml = includeFinancials && rateRows.length
    ? `<h2>Rates</h2>${htmlTable([{ label: 'Role' }, { label: 'Rate', align: 'right' }], rateRows)}`
    : ''

  const totalsHtml = includeFinancials ? `
    <div class="totals">
      <table>
        <tr><td class="lbl">Shifts</td><td class="val">${escHtml(totals.shiftCount ?? labor.length ?? '')}</td></tr>
        <tr><td class="lbl">Last 30 Days</td><td class="val">${escHtml(money(totals.last30))}</td></tr>
        <tr><td class="lbl">Year to Date</td><td class="val">${escHtml(money(totals.ytd))}</td></tr>
        <tr class="grand"><td class="lbl">Lifetime</td><td class="val">${escHtml(money(totals.lifetime))}</td></tr>
      </table>
    </div>
  ` : ''

  const laborCols = [
    { label: 'Date' },
    { label: 'Show / Task' },
    { label: 'Role' },
    { label: 'Units' },
  ]
  if (includeFinancials) laborCols.push({ label: 'Total', align: 'right' })
  const laborRows = labor.slice(0, 200).map(r => {
    const date = r._dateStr || r.showDate || ''
    const units = (r.payType || 'hour') === 'day'
      ? `${r.days || 1} day${String(r.days || 1) === '1' ? '' : 's'}`
      : (r.hours ? `${r.hours} hr` : '')
    const base = [date, r.showName || (r.showId ? '' : '[Facility]'), r.role || '', units]
    if (includeFinancials) base.push(r.total ? money(r.total) : (r._cost ? money(r._cost) : ''))
    return base
  })

  const laborHtml = laborRows.length
    ? `<h2>Labor History (${labor.length})</h2>${htmlTable(laborCols, laborRows)}
        ${labor.length > 200 ? `<div class="foot">Showing first 200 of ${labor.length} entries.</div>` : ''}`
    : ''

  const notes = staff.notes
    ? `<h2>Notes</h2><div class="content">${escHtml(staff.notes).replace(/\n/g, '<br>')}</div>`
    : ''

  const bodyHtml = `
    <h2>Profile</h2>
    ${info}
    ${ratesHtml}
    ${totalsHtml}
    ${laborHtml}
    ${notes}
  `

  openPrintWindow({
    title:   `Staff — ${staff.name || 'Unnamed'}`,
    heading: staff.name || 'Unnamed',
    subtitle: staff.role || '',
    meta: [
      staff.department && { label: 'Department', value: staff.department },
      { label: 'Stage', value: stageLabel(staff.stage) },
    ].filter(Boolean),
    bodyHtml,
    orientation: 'portrait',
  })
}

export function exportStaffProfileCsv(staff, opts = {}) {
  const { labor = [], includeFinancials = true } = opts
  const lines = [
    csvCell(`Staff Profile: ${staff.name || 'Unnamed'}`),
    csvCell(`Exported: ${new Date().toLocaleString()}`),
    '',
    csvCell('PROFILE'),
    csvRow(['Role',        staff.role || '']),
    csvRow(['Department',  staff.department || '']),
    csvRow(['Stage',       stageLabel(staff.stage)]),
    csvRow(['Email',       staff.email || '']),
    csvRow(['Phone',       staff.phone || '']),
    csvRow(['Start Date',  staff.startDate || '']),
    csvRow(['Onboarded',   staff.onboardingComplete === 'true' ? 'Y' : '']),
    csvRow(['Status',      staff.active === 'false' ? 'Inactive' : 'Active']),
  ]

  if (includeFinancials) {
    lines.push('', csvCell('RATES'))
    if (staff.dayRate)    lines.push(csvRow(['Default (day)',  staff.dayRate]))
    if (staff.hourlyRate) lines.push(csvRow(['Default (hour)', staff.hourlyRate]))
    parseRates(staff.rates).forEach(r => {
      lines.push(csvRow([`${r.role || '(unnamed)'} (${r.payType || 'day'})`, r.rate || '']))
    })
  }

  if (labor.length) {
    lines.push('', csvCell('LABOR HISTORY'))
    const header = ['Date', 'Show / Task', 'Role', 'Units']
    if (includeFinancials) header.push('Total')
    lines.push(csvRow(header))
    labor.forEach(r => {
      const date  = r._dateStr || r.showDate || ''
      const units = (r.payType || 'hour') === 'day'
        ? `${r.days || 1} day${String(r.days || 1) === '1' ? '' : 's'}`
        : (r.hours ? `${r.hours} hr` : '')
      const line = [date, r.showName || (r.showId ? '' : '[Facility]'), r.role || '', units]
      if (includeFinancials) line.push(r.total || r._cost || '')
      lines.push(csvRow(line))
    })
  }

  if (staff.notes) {
    lines.push('', csvCell('NOTES'), csvCell(staff.notes))
  }

  downloadCsv(safeFilename(`staff_${staff.name || staff.id || 'profile'}`), lines)
}
