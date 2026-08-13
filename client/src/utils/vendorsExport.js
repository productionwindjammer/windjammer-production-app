// Vendors + vendor bookings export.

import {
  csvCell, csvRow, downloadCsv, htmlTable, money, openPrintWindow,
} from './exportHelpers'

export function buildVendorsCsv(rows) {
  const lines = [
    csvCell('Vendor Directory'),
    csvCell(`Exported: ${new Date().toLocaleString()}`),
    '',
    csvRow(['Company', 'Category', 'Contact Name', 'Phone', 'Email', 'Website', 'Status', 'Notes']),
  ]
  rows.forEach(v => lines.push(csvRow([
    v.company || '',
    v.category || '',
    v.contactName || '',
    v.phone || '',
    v.email || '',
    v.website || '',
    v.active === 'true' ? 'Active' : 'Inactive',
    v.notes || '',
  ])))
  return lines
}

export function exportVendorsCsv(rows) {
  downloadCsv('vendors', buildVendorsCsv(rows))
}

export function exportVendorsPrint(rows) {
  const columns = [
    { label: 'Company' },
    { label: 'Category' },
    { label: 'Contact' },
    { label: 'Phone' },
    { label: 'Email' },
    { label: 'Status' },
  ]
  const bodyRows = rows.map(v => [
    v.company || '',
    v.category || '',
    v.contactName || '',
    v.phone || '',
    v.email || '',
    v.active === 'true' ? 'Active' : 'Inactive',
  ])
  openPrintWindow({
    title: 'Vendor Directory',
    heading: 'Vendor Directory',
    meta: [{ label: 'Vendors', value: String(rows.length) }],
    bodyHtml: htmlTable(columns, bodyRows),
    orientation: 'landscape',
  })
}

export function buildBookingsCsv(rows) {
  const lines = [
    csvCell('Vendor Bookings'),
    csvCell(`Exported: ${new Date().toLocaleString()}`),
    '',
    csvRow(['Show', 'Vendor', 'Service', 'Confirmed Date', 'Amount', 'Paid', 'Notes']),
  ]
  rows.forEach(b => lines.push(csvRow([
    b.showName || b.showId || '',
    b.vendorName || b.vendorId || '',
    b.service || '',
    b.confirmedDate || '',
    b.amount || '',
    b.paid === 'true' ? 'Y' : '',
    b.notes || '',
  ])))
  return lines
}

export function exportBookingsCsv(rows) {
  downloadCsv('vendor-bookings', buildBookingsCsv(rows))
}

export function exportBookingsPrint(rows) {
  const columns = [
    { label: 'Show' },
    { label: 'Vendor' },
    { label: 'Service' },
    { label: 'Confirmed' },
    { label: 'Amount', align: 'right' },
    { label: 'Paid' },
  ]
  const bodyRows = rows.map(b => [
    b.showName || b.showId || '',
    b.vendorName || b.vendorId || '',
    b.service || '',
    b.confirmedDate || '',
    money(b.amount),
    b.paid === 'true' ? '✓' : '',
  ])

  const total = rows.reduce((a, r) => a + (parseFloat(r.amount) || 0), 0)
  const footRows = [[`${rows.length} booking${rows.length === 1 ? '' : 's'}`, '', '', '', money(total), '']]

  openPrintWindow({
    title: 'Vendor Bookings',
    heading: 'Vendor Bookings',
    meta: [{ label: 'Rows', value: String(rows.length) }],
    bodyHtml: htmlTable(columns, bodyRows, { footRows }),
    orientation: 'landscape',
  })
}
