// Settlement export: list view (CSV / print) + per-record statement (print).

import {
  csvCell, csvRow, downloadCsv, escHtml, htmlTable, money, openPrintWindow, safeFilename,
} from './exportHelpers'

function stageLabel(s) {
  if (s === 'inside') return 'Inside'
  if (s === 'beach')  return 'Beach'
  return s || ''
}

/** CSV of the current filtered settlement list. */
export function buildSettlementListCsv(rows) {
  const lines = [
    csvCell('Settlement Summary'),
    csvCell(`Exported: ${new Date().toLocaleString()}`),
    '',
    csvRow([
      'Show', 'Stage', 'Guarantee', 'Ticket Revenue', 'Other Revenue',
      'Production', 'Labor', 'Vendor', 'Catering', 'Security', 'Misc',
      'Total Revenue', 'Total Costs', 'Net Settlement',
      'Artist Paid Date', 'Payment Method', 'Settled By', 'Status', 'Notes',
    ]),
  ]
  rows.forEach(r => {
    lines.push(csvRow([
      r.showName || '',
      stageLabel(r.stage),
      r.artistGuarantee || '',
      r.ticketRevenue   || '',
      r.otherRevenue    || '',
      r.productionCost  || '',
      r.laborCost       || '',
      r.vendorCost      || '',
      r.cateringCost    || '',
      r.securityCost    || '',
      r.miscCost        || '',
      r.totalRevenue    || '',
      r.totalCosts      || '',
      r.netSettlement   || '',
      r.artistPaymentDate   || '',
      r.artistPaymentMethod || '',
      r.settledBy       || '',
      r.status          || 'pending',
      r.notes           || '',
    ]))
  })
  return lines
}

export function exportSettlementListCsv(rows) {
  downloadCsv('settlement-summary', buildSettlementListCsv(rows))
}

/** Printable summary of all filtered rows. */
export function exportSettlementListPrint(rows) {
  const columns = [
    { label: 'Show' },
    { label: 'Stage' },
    { label: 'Guarantee',  align: 'right' },
    { label: 'Revenue',    align: 'right' },
    { label: 'Costs',      align: 'right' },
    { label: 'Net',        align: 'right' },
    { label: 'Paid',       align: 'right' },
    { label: 'Status' },
  ]
  const bodyRows = rows.map(r => [
    r.showName || '',
    stageLabel(r.stage),
    money(r.artistGuarantee),
    money(r.totalRevenue),
    money(r.totalCosts),
    money(r.netSettlement),
    r.artistPaymentDate || '',
    r.status || 'pending',
  ])

  const totals = rows.reduce((acc, r) => ({
    rev:   acc.rev   + (parseFloat(r.totalRevenue)  || 0),
    costs: acc.costs + (parseFloat(r.totalCosts)    || 0),
    net:   acc.net   + (parseFloat(r.netSettlement) || 0),
  }), { rev: 0, costs: 0, net: 0 })

  const footRows = [[
    `${rows.length} record${rows.length === 1 ? '' : 's'}`,
    '',
    '',
    money(totals.rev),
    money(totals.costs),
    money(totals.net),
    '',
    '',
  ]]

  openPrintWindow({
    title: 'Settlement Summary',
    heading: 'Settlement Summary',
    meta: [{ label: 'Records', value: String(rows.length) }],
    bodyHtml: htmlTable(columns, bodyRows, { footRows }),
    orientation: 'landscape',
  })
}

/** Printable per-show settlement statement suitable for the artist / venue file. */
export function exportSettlementStatementPrint(record) {
  const r = record || {}
  const revenueRows = [
    ['Ticket Revenue', money(r.ticketRevenue)],
    ['Other Revenue',  money(r.otherRevenue)],
  ]
  const costRows = [
    ['Production',     money(r.productionCost)],
    ['Labor',          money(r.laborCost)],
    ['Vendor / Rental',money(r.vendorCost)],
    ['Catering',       money(r.cateringCost)],
    ['Security',       money(r.securityCost)],
    ['Misc',           money(r.miscCost)],
  ]

  const twoColTable = (rowsList) => htmlTable(
    [{ label: 'Item' }, { label: 'Amount', align: 'right' }],
    rowsList,
  )

  const totalsHtml = `
    <div class="totals">
      <table>
        <tr><td class="lbl">Total Revenue</td><td class="val">${escHtml(money(r.totalRevenue))}</td></tr>
        <tr><td class="lbl">Total Costs</td><td class="val">${escHtml(money(r.totalCosts))}</td></tr>
        <tr><td class="lbl">Artist Guarantee</td><td class="val">${escHtml(money(r.artistGuarantee))}</td></tr>
        <tr class="grand"><td class="lbl">Net Settlement</td><td class="val">${escHtml(money(r.netSettlement))}</td></tr>
      </table>
    </div>
  `

  const paymentTable = htmlTable(
    [{ label: 'Field' }, { label: 'Value' }],
    [
      ['Payment Date',   r.artistPaymentDate || ''],
      ['Payment Method', r.artistPaymentMethod || ''],
      ['Settled By',     r.settledBy || ''],
      ['Status',         r.status || 'pending'],
    ],
  )

  const bodyHtml = `
    <h2>Revenue</h2>
    ${twoColTable(revenueRows)}
    <h2>Costs</h2>
    ${twoColTable(costRows)}
    ${totalsHtml}
    <h2>Artist Payment</h2>
    ${paymentTable}
    ${r.notes ? `<h2>Notes</h2><div class="content">${escHtml(r.notes).replace(/\n/g, '<br>')}</div>` : ''}
  `

  openPrintWindow({
    title:   `Settlement — ${r.showName || 'Untitled'}`,
    heading: 'Settlement Statement',
    subtitle: r.showName || '',
    meta: [
      { label: 'Stage',  value: stageLabel(r.stage) },
      { label: 'Status', value: r.status || 'pending' },
    ],
    bodyHtml,
    orientation: 'portrait',
  })
}

export function exportSettlementStatementCsv(record) {
  const r = record || {}
  const lines = [
    csvCell(`Settlement Statement: ${r.showName || 'Untitled'}`),
    csvCell(`Stage: ${stageLabel(r.stage)}`),
    csvCell(`Status: ${r.status || 'pending'}`),
    csvCell(`Exported: ${new Date().toLocaleString()}`),
    '',
    csvCell('REVENUE'),
    csvRow(['Ticket Revenue',  r.ticketRevenue  || '']),
    csvRow(['Other Revenue',   r.otherRevenue   || '']),
    csvRow(['Total Revenue',   r.totalRevenue   || '']),
    '',
    csvCell('COSTS'),
    csvRow(['Production',      r.productionCost || '']),
    csvRow(['Labor',           r.laborCost      || '']),
    csvRow(['Vendor / Rental', r.vendorCost     || '']),
    csvRow(['Catering',        r.cateringCost   || '']),
    csvRow(['Security',        r.securityCost   || '']),
    csvRow(['Misc',            r.miscCost       || '']),
    csvRow(['Total Costs',     r.totalCosts     || '']),
    '',
    csvCell('SETTLEMENT'),
    csvRow(['Artist Guarantee', r.artistGuarantee || '']),
    csvRow(['Net Settlement',   r.netSettlement   || '']),
    '',
    csvCell('PAYMENT'),
    csvRow(['Payment Date',   r.artistPaymentDate   || '']),
    csvRow(['Payment Method', r.artistPaymentMethod || '']),
    csvRow(['Settled By',     r.settledBy           || '']),
    '',
    csvCell('NOTES'),
    csvCell(r.notes || ''),
  ]
  downloadCsv(safeFilename(`settlement_${r.showName || r.id || 'record'}`), lines)
}
