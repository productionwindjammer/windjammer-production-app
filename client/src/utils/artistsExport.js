// Artists registry export.

import {
  csvCell, csvRow, downloadCsv, escHtml, htmlTable, openPrintWindow, safeFilename,
} from './exportHelpers'

export function buildArtistsCsv(rows) {
  const lines = [
    csvCell('Artist Registry'),
    csvCell(`Exported: ${new Date().toLocaleString()}`),
    '',
    csvRow(['Name', 'Aliases', 'Agency', 'Agent', 'Contact Name', 'Contact Email', 'Contact Phone', 'Notes']),
  ]
  rows.forEach(a => lines.push(csvRow([
    a.name || '',
    a.aliases || '',
    a.agency || '',
    a.agent || '',
    a.contactName || '',
    a.contactEmail || '',
    a.contactPhone || '',
    a.notes || '',
  ])))
  return lines
}

export function exportArtistsCsv(rows) {
  downloadCsv('artists', buildArtistsCsv(rows))
}

export function exportArtistsPrint(rows) {
  const columns = [
    { label: 'Name' },
    { label: 'Agency' },
    { label: 'Agent' },
    { label: 'Contact' },
    { label: 'Email' },
    { label: 'Phone' },
  ]
  const bodyRows = rows.map(a => [
    a.name || '',
    a.agency || '',
    a.agent || '',
    a.contactName || '',
    a.contactEmail || '',
    a.contactPhone || '',
  ])
  openPrintWindow({
    title: 'Artist Registry',
    heading: 'Artist Registry',
    meta: [{ label: 'Artists', value: String(rows.length) }],
    bodyHtml: htmlTable(columns, bodyRows),
    orientation: 'landscape',
  })
}

/** Single artist profile sheet including any provided document list. */
export function exportArtistProfilePrint(artist, opts = {}) {
  const { docs = [], shows = [] } = opts
  const a = artist || {}

  const profile = htmlTable(
    [{ label: 'Field' }, { label: 'Value' }],
    [
      ['Name',          a.name || ''],
      ['Aliases',       a.aliases || ''],
      ['Agency',        a.agency || ''],
      ['Agent',         a.agent || ''],
      ['Contact Name',  a.contactName || ''],
      ['Contact Email', a.contactEmail || ''],
      ['Contact Phone', a.contactPhone || ''],
    ],
  )

  const docsHtml = docs.length
    ? `<h2>Documents (${docs.length})</h2>${htmlTable(
        [{ label: 'Type' }, { label: 'File' }, { label: 'Uploaded' }, { label: 'Show / Year' }],
        docs.map(d => [
          d.docTypeLabel || d.docType || '',
          d.fileName || d.name || '',
          d.uploadedAt ? new Date(d.uploadedAt).toLocaleDateString() : '',
          d.showDate || d.year || '',
        ]),
      )}`
    : ''

  const showsHtml = shows.length
    ? `<h2>Show History (${shows.length})</h2>${htmlTable(
        [{ label: 'Date' }, { label: 'Event' }, { label: 'Stage' }, { label: 'Status' }],
        shows.map(s => [
          s.date || '',
          s.artist || s.eventName || '',
          s.stage === 'inside' ? 'Inside' : s.stage === 'beach' ? 'Beach' : (s.stage || ''),
          s.status || '',
        ]),
      )}`
    : ''

  const notes = a.notes
    ? `<h2>Notes</h2><div class="content">${escHtml(a.notes).replace(/\n/g, '<br>')}</div>`
    : ''

  openPrintWindow({
    title: `Artist — ${a.name || 'Unnamed'}`,
    heading: a.name || 'Unnamed Artist',
    subtitle: a.agency || '',
    meta: [
      a.agent && { label: 'Agent', value: a.agent },
      a.contactEmail && { label: 'Email', value: a.contactEmail },
    ].filter(Boolean),
    bodyHtml: `<h2>Profile</h2>${profile}${docsHtml}${showsHtml}${notes}`,
    orientation: 'portrait',
  })
}

export function exportArtistProfileCsv(artist, opts = {}) {
  const { docs = [], shows = [] } = opts
  const a = artist || {}
  const lines = [
    csvCell(`Artist Profile: ${a.name || 'Unnamed'}`),
    csvCell(`Exported: ${new Date().toLocaleString()}`),
    '',
    csvCell('PROFILE'),
    csvRow(['Name',          a.name || '']),
    csvRow(['Aliases',       a.aliases || '']),
    csvRow(['Agency',        a.agency || '']),
    csvRow(['Agent',         a.agent || '']),
    csvRow(['Contact Name',  a.contactName || '']),
    csvRow(['Contact Email', a.contactEmail || '']),
    csvRow(['Contact Phone', a.contactPhone || '']),
  ]

  if (docs.length) {
    lines.push('', csvCell('DOCUMENTS'), csvRow(['Type', 'File', 'Uploaded', 'Show / Year']))
    docs.forEach(d => lines.push(csvRow([
      d.docTypeLabel || d.docType || '',
      d.fileName || d.name || '',
      d.uploadedAt ? new Date(d.uploadedAt).toLocaleDateString() : '',
      d.showDate || d.year || '',
    ])))
  }
  if (shows.length) {
    lines.push('', csvCell('SHOW HISTORY'), csvRow(['Date', 'Event', 'Stage', 'Status']))
    shows.forEach(s => lines.push(csvRow([
      s.date || '',
      s.artist || s.eventName || '',
      s.stage || '',
      s.status || '',
    ])))
  }
  if (a.notes) lines.push('', csvCell('NOTES'), csvCell(a.notes))

  downloadCsv(safeFilename(`artist_${a.name || a.id || 'profile'}`), lines)
}
