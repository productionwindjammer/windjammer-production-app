import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api'
import Modal from '../components/Modal'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { filterShowList } from '../utils/showFilters'
import { formatTime } from '../utils/time'

const BLANK = {
  showId: '', showName: '', stage: 'inside',
  riderReceived: 'false', riderNotes: '',
  stagingChanges: '', capacityChanges: '',
  soundRestrictions: '', curfew: '',
  productionNeeds: '', backlineNotes: '',
  cateringNotes: '', hospitalityNotes: '',
  localCrewNeeds: '', advancingComplete: 'false',
  advanceContact: '', advancePhone: '', advanceEmail: '',
  notes: ''
}

const SCHED_BLANK = { showId: '', showName: '', stage: 'inside', label: '', time: '', responsible: '', notes: '' }

// Default day-of-show timeline seeded the first time a show's schedule is opened.
// Times are intentionally blank so users fill in based on the actual show.
const DEFAULT_SCHEDULE_TEMPLATE = [
  { label: 'Crew Call / Load-In',     responsible: 'Production' },
  { label: 'Local Crew Call',         responsible: 'Stagehands' },
  { label: 'Stage Set / Backline In', responsible: 'Stage' },
  { label: 'Line Check',              responsible: 'Audio' },
  { label: 'Artist Arrival',          responsible: 'Tour' },
  { label: 'Sound Check',             responsible: 'Audio' },
  { label: 'Catering / Dinner',       responsible: 'Hospitality' },
  { label: 'House Open / Doors',      responsible: 'FOH' },
  { label: 'Opener Set',              responsible: 'Stage' },
  { label: 'Changeover',              responsible: 'Stage' },
  { label: 'Headliner Set',           responsible: 'Stage' },
  { label: 'Load-Out',                responsible: 'Production' },
]

export default function Advancing() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const { settings } = useSettings()
  const tf = settings.timeFormat || '12h'

  const [records, setRecords]     = useState([])
  const [shows, setShows]         = useState([])
  const [loading, setLoading]     = useState(true)
  const [modal, setModal]         = useState(false)
  const [editing, setEditing]     = useState(null)
  const [form, setForm]           = useState(BLANK)
  const [saving, setSaving]       = useState(false)
  const [filter, setFilter]       = useState('')
  const [showPastShows, setShowPastShows] = useState(false)

  // Bot
  const [analyzing, setAnalyzing] = useState(new Set())

  // View / bot modal
  const [viewRecord, setViewRecord]       = useState(null)
  const [botResult, setBotResult]         = useState(null)
  const [extractedData, setExtractedData] = useState(null)  // bot's email-extracted suggestions
  const [extEdits, setExtEdits]           = useState({})    // per-field overrides while reviewing
  const [acceptingExt, setAcceptingExt]   = useState(false)
  const [analyzingView, setAnalyzingView] = useState(false)

  // Schedule (Day of Show) state — managed from Advancing view
  const [schedItems, setSchedItems]           = useState([])
  const [loadingSchedule, setLoadingSchedule] = useState(false)
  const [schedModal, setSchedModal]           = useState(false)
  const [schedEditing, setSchedEditing]       = useState(null)
  const [schedForm, setSchedForm]             = useState(SCHED_BLANK)
  const [schedSaving, setSchedSaving]         = useState(false)

  // Production notes modal
  const [notesRecord, setNotesRecord]   = useState(null)
  const [notesData, setNotesData]       = useState(null)
  const [loadingNotes, setLoadingNotes] = useState(false)
  const [notesSending, setNotesSending] = useState(false)
  const [notesTo, setNotesTo]           = useState('')
  const [notesCc, setNotesCc]           = useState('')
  const [notesSent, setNotesSent]       = useState(false)

  useEffect(() => {
    Promise.all([api.get('/advancing'), api.get('/shows')]).then(([a, s]) => {
      setRecords(a.data.data || [])
      setShows(s.data.data || [])
    }).finally(() => setLoading(false))
  }, [])

  async function load() {
    const [a, s] = await Promise.all([api.get('/advancing'), api.get('/shows')])
    setRecords(a.data.data || [])
    setShows(s.data.data || [])
  }

  function openAdd() { setEditing(null); setForm(BLANK); setModal(true) }
  function openEdit(r) { setEditing(r); setForm({ ...BLANK, ...r }); setModal(true) }

  async function handleSave() {
    setSaving(true)
    try {
      const payload = { ...form }
      if (editing) await api.put(`/advancing/${editing.id}`, payload)
      else await api.post('/advancing', payload)
      await load()
      setModal(false)
    } finally { setSaving(false) }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this advance record?')) return
    await api.delete(`/advancing/${id}`)
    await load()
  }

  // ── Bot analysis ────────────────────────────────────────────────────────────
  async function handleAnalyze(record, { fromView = false } = {}) {
    if (fromView) setAnalyzingView(true)
    else setAnalyzing(prev => new Set([...prev, record.id]))
    try {
      const res = await api.post(`/advancing/${record.id}/analyze`)
      const result = res.data.data
      // New response shape: { flags, extracted }. Tolerate the old shape too.
      const flags     = result?.flags ?? result
      const extracted = result?.extracted ?? null
      if (fromView) {
        setBotResult(flags)
        setExtractedData(extracted)
        setExtEdits({})
      }
      await load()
    } catch (err) {
      alert('Analysis failed: ' + (err.response?.data?.message || err.message))
    } finally {
      if (fromView) setAnalyzingView(false)
      else setAnalyzing(prev => { const n = new Set(prev); n.delete(record.id); return n })
    }
  }

  // ── Accept / dismiss extracted fields ──────────────────────────────────────
  async function applyExtraction({ acceptKeys = [], dismissKeys = [] }) {
    if (!viewRecord) return
    if (acceptKeys.length === 0 && dismissKeys.length === 0) return
    setAcceptingExt(true)
    try {
      const fields = extractedData?.fields || {}
      const updates = {}
      for (const k of acceptKeys) {
        const fallback = fields[k]?.value || ''
        const v = extEdits[k] !== undefined ? extEdits[k] : fallback
        if (v && String(v).trim()) updates[k] = v
      }
      const res = await api.post(`/advancing/${viewRecord.id}/accept-extraction`, { updates, dismissKeys })
      if (!res.data.success) throw new Error(res.data.message || 'Failed')
      // Refresh extracted blob locally
      const nextFields = { ...fields }
      for (const k of [...acceptKeys, ...dismissKeys]) delete nextFields[k]
      setExtractedData(prev => prev ? { ...prev, fields: nextFields } : prev)
      setExtEdits(prev => {
        const n = { ...prev }
        for (const k of [...acceptKeys, ...dismissKeys]) delete n[k]
        return n
      })
      // Reflect new values on the visible record + table data
      setViewRecord(prev => prev ? { ...prev, ...updates, botExtracted: JSON.stringify({ ...(extractedData||{}), fields: nextFields }) } : prev)
      await load()
    } catch (err) {
      alert('Failed to apply: ' + (err.response?.data?.message || err.message))
    } finally {
      setAcceptingExt(false)
    }
  }

  // ── View modal ──────────────────────────────────────────────────────────────
  function openView(r) {
    setViewRecord(r)
    try { setBotResult(r.botNotes ? JSON.parse(r.botNotes) : null) }
    catch { setBotResult(null) }
    try { setExtractedData(r.botExtracted ? JSON.parse(r.botExtracted) : null) }
    catch { setExtractedData(null) }
    setExtEdits({})
    // Load schedule items for this show; seed defaults if none exist yet.
    setLoadingSchedule(true)
    api.get('/schedule').then(async res => {
      const all = res.data.data || []
      const mine = all.filter(i => i.showId === r.showId)
      if (mine.length === 0 && r.showId) {
        try {
          const seeded = await Promise.all(DEFAULT_SCHEDULE_TEMPLATE.map(t => api.post('/schedule', {
            ...SCHED_BLANK,
            ...t,
            showId:   r.showId,
            showName: r.showName || getShowLabel(r),
            stage:    r.stage || 'inside',
          }).then(resp => resp.data.data).catch(() => null)))
          setSchedItems(seeded.filter(Boolean))
        } catch {
          setSchedItems([])
        }
      } else {
        setSchedItems(mine.sort((a, b) => (a.time || '').localeCompare(b.time || '')))
      }
    }).finally(() => setLoadingSchedule(false))
  }

  // ── Schedule CRUD (Day of Show, managed from Advancing) ────────────────────
  function openSchedAdd() {
    setSchedEditing(null)
    setSchedForm({
      ...SCHED_BLANK,
      showId:   viewRecord.showId,
      showName: viewRecord.showName || getShowLabel(viewRecord),
      stage:    viewRecord.stage,
    })
    setSchedModal(true)
  }

  function openSchedEdit(item) {
    setSchedEditing(item)
    setSchedForm({ ...SCHED_BLANK, ...item })
    setSchedModal(true)
  }

  async function handleSchedSave() {
    setSchedSaving(true)
    try {
      if (schedEditing) await api.put(`/schedule/${schedEditing.id}`, schedForm)
      else await api.post('/schedule', schedForm)
      const res = await api.get('/schedule')
      setSchedItems(
        (res.data.data || [])
          .filter(i => i.showId === viewRecord.showId)
          .sort((a, b) => (a.time || '').localeCompare(b.time || ''))
      )
      setSchedModal(false)
    } finally { setSchedSaving(false) }
  }

  async function handleSchedDelete(id) {
    if (!confirm('Delete this schedule item?')) return
    await api.delete(`/schedule/${id}`)
    const res = await api.get('/schedule')
    setSchedItems(
      (res.data.data || [])
        .filter(i => i.showId === viewRecord.showId)
        .sort((a, b) => (a.time || '').localeCompare(b.time || ''))
    )
  }

  // Open a print-ready day sheet in a new window. Clean white background, bold
  // type, sized for letter paper.
  function printDaySheet() {
    if (!viewRecord) return
    const show = shows.find(s => s.id === viewRecord.showId)
    const title = viewRecord.showName || getShowLabel(viewRecord)
    const dateLine = show?.date ? new Date(show.date + 'T00:00:00').toLocaleDateString(undefined, { weekday:'long', year:'numeric', month:'long', day:'numeric' }) : ''
    const stageLine = viewRecord.stage === 'beach' ? 'Beach Stage' : 'Inside Stage'
    const curfew = viewRecord.curfew ? `Curfew: ${viewRecord.curfew}` : ''
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]))
    const rows = (schedItems.length ? schedItems : [{}]).map(it => `
      <tr>
        <td class="time">${it.time ? esc(formatTime(it.time, tf)) : '&nbsp;'}</td>
        <td class="label">${esc(it.label || '')}</td>
        <td class="resp">${esc(it.responsible || '')}</td>
        <td class="notes">${esc(it.notes || '')}</td>
      </tr>`).join('')
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Day Sheet — ${esc(title)}</title>
<style>
  @page { size: letter; margin: 0.5in; }
  * { box-sizing: border-box; }
  html, body { background: #fff; color: #000; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 13pt; line-height: 1.35; padding: 18px 22px; }
  .hdr { border-bottom: 3px solid #000; padding-bottom: 10px; margin-bottom: 14px; }
  h1 { margin: 0 0 4px; font-size: 22pt; font-weight: 900; letter-spacing: 0.5px; text-transform: uppercase; }
  .sub { font-size: 12pt; font-weight: 700; }
  .meta { display: flex; gap: 22px; flex-wrap: wrap; margin-top: 6px; font-size: 11pt; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th, td { border: 1px solid #000; padding: 8px 10px; text-align: left; vertical-align: top; }
  thead th { background: #000; color: #fff; font-size: 11pt; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; }
  tbody td { font-size: 13pt; }
  tbody td.time { font-weight: 900; white-space: nowrap; width: 1%; }
  tbody td.label { font-weight: 700; }
  tbody td.resp { font-weight: 700; width: 18%; }
  tbody td.notes { width: 32%; }
  tbody tr { page-break-inside: avoid; }
  .foot { margin-top: 14px; font-size: 9pt; color: #000; text-align: right; }
  @media print { .noprint { display: none; } }
  .noprint { margin: 10px 0 16px; }
  .noprint button { font-size: 11pt; font-weight: 700; padding: 6px 14px; cursor: pointer; }
</style></head><body>
  <div class="noprint">
    <button onclick="window.print()">Print</button>
    <button onclick="window.close()">Close</button>
  </div>
  <div class="hdr">
    <h1>Day of Show Schedule</h1>
    <div class="sub">${esc(title)}</div>
    <div class="meta">
      ${dateLine ? `<span>${esc(dateLine)}</span>` : ''}
      <span>${esc(stageLine)}</span>
      ${curfew ? `<span>${esc(curfew)}</span>` : ''}
      ${viewRecord.advanceContact ? `<span>Contact: ${esc(viewRecord.advanceContact)}${viewRecord.advancePhone ? ' · ' + esc(viewRecord.advancePhone) : ''}</span>` : ''}
    </div>
  </div>
  <table>
    <thead><tr><th>Time</th><th>Event / Task</th><th>Responsible</th><th>Notes</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="foot">Printed ${esc(new Date().toLocaleString())}</div>
  <script>window.addEventListener('load', () => setTimeout(() => window.print(), 250));<\/script>
</body></html>`
    const w = window.open('', '_blank', 'width=900,height=1100')
    if (!w) { alert('Pop-up blocked. Please allow pop-ups to print the day sheet.'); return }
    w.document.open()
    w.document.write(html)
    w.document.close()
  }

  // ── Production notes ────────────────────────────────────────────────────────
  async function openNotes(r) {
    setNotesRecord(r)
    setNotesData(null)
    setLoadingNotes(true)
    setNotesSent(false)
    setNotesTo(r.advanceEmail || '')
    setNotesCc('')
    try {
      const [laborRes, schedRes] = await Promise.all([api.get('/labor'), api.get('/schedule')])
      const labor    = (laborRes.data.data || []).filter(l => l.showId === r.showId)
      const schedule = (schedRes.data.data || []).filter(s => s.showId === r.showId)
      const show     = shows.find(s => s.id === r.showId) || {}
      setNotesData({ show, labor, schedule })
    } finally { setLoadingNotes(false) }
  }

  function generateNotesHtml(record, data) {
    if (!data) return ''
    const { show, labor, schedule } = data
    const now = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    const stageName  = record.stage === 'inside' ? 'Inside Stage' : 'Beach Stage'
    const stageColor = record.stage === 'inside' ? '#1a4a7a' : '#1a6b4a'
    const showLabel  = record.showName || getShowLabel(record)

    const scheduleRows = [...schedule]
      .sort((a, b) => (a.time || '').localeCompare(b.time || ''))
      .map(s => `<tr>
        <td style="padding:5px 12px 5px 0;border-bottom:1px solid #eee;white-space:nowrap">${formatTime(s.time, tf) || '—'}</td>
        <td style="padding:5px 12px 5px 0;border-bottom:1px solid #eee;font-weight:600">${s.label || s.eventType || '—'}</td>
        <td style="padding:5px 12px 5px 0;border-bottom:1px solid #eee;color:#555">${s.responsible || ''}</td>
        <td style="padding:5px 0;border-bottom:1px solid #eee;color:#777">${s.notes || ''}</td>
      </tr>`).join('')

    const laborRows = labor
      .map(l => `<tr>
        <td style="padding:5px 12px 5px 0;border-bottom:1px solid #eee;font-weight:600">${l.role || '—'}</td>
        <td style="padding:5px 12px 5px 0;border-bottom:1px solid #eee">${l.workerName || '—'}</td>
        <td style="padding:5px 12px 5px 0;border-bottom:1px solid #eee">${formatTime(l.callTime, tf) || '—'}</td>
        <td style="padding:5px 0;border-bottom:1px solid #eee;color:#777">${l.notes || ''}</td>
      </tr>`).join('')

    let botSection = ''
    try {
      const b = record.botNotes ? JSON.parse(record.botNotes) : null
      if (b?.issues?.length > 0) {
        const items = b.issues.map(i =>
          `<li style="margin:6px 0;padding:8px 12px;background:${i.status === 'flag' ? '#fff1f2' : '#fffbeb'};border-left:3px solid ${i.status === 'flag' ? '#dc2626' : '#d97706'};border-radius:3px">
            <strong>${i.icon || ''} ${i.category}</strong><br>
            <span style="font-size:13px;color:#555">${i.note}</span>
          </li>`).join('')
        botSection = `<h3 style="color:#dc2626;border-bottom:1px solid #fecaca;padding-bottom:6px;margin-top:28px">⚠️ Flagged Items (Internal Review)</h3><ul style="margin:0;padding-left:0;list-style:none">${items}</ul>`
      }
    } catch {}

    return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:820px;margin:0 auto;color:#1a1a1a;padding:24px 20px">
      <div style="text-align:center;border-bottom:4px solid ${stageColor};padding-bottom:18px;margin-bottom:22px">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#999;margin-bottom:4px">Windjammer Production Management</div>
        <h1 style="margin:0;font-size:24px;color:${stageColor}">${showLabel}</h1>
        <div style="margin-top:6px;font-size:13px;color:#666">${stageName} · ${show.date || ''}${show.showTime ? ` · Show: ${formatTime(show.showTime, tf)}` : ''}${show.doorsTime ? ` · Doors: ${formatTime(show.doorsTime, tf)}` : ''}</div>
        <div style="margin-top:6px;font-size:12px;color:#999">Production Brief issued ${now}${user?.name ? ` by ${user.name}` : ''} · <span style="color:${record.advancingComplete === 'true' ? '#16a34a' : '#d97706'}">${record.advancingComplete === 'true' ? '✅ Advancing Complete' : '🔄 In Progress'}</span></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px">
        <div>
          <h3 style="margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:${stageColor};border-bottom:1px solid #e5e7eb;padding-bottom:5px">Show Info</h3>
          <table style="font-size:14px;border-collapse:collapse;width:100%">
            <tr><td style="padding:3px 12px 3px 0;color:#999;width:120px">Date</td><td>${show.date || '—'}</td></tr>
            <tr><td style="padding:3px 12px 3px 0;color:#999">Show Time</td><td>${formatTime(show.showTime, tf) || '—'}</td></tr>
            <tr><td style="padding:3px 12px 3px 0;color:#999">Doors</td><td>${formatTime(show.doorsTime, tf) || '—'}</td></tr>
            <tr><td style="padding:3px 12px 3px 0;color:#999">Curfew</td><td>${record.curfew || '—'}</td></tr>
            <tr><td style="padding:3px 12px 3px 0;color:#999">Capacity</td><td>${show.capacity || '—'}</td></tr>
            <tr><td style="padding:3px 12px 3px 0;color:#999">Sound Restrict.</td><td>${record.soundRestrictions || '—'}</td></tr>
          </table>
        </div>
        <div>
          <h3 style="margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:${stageColor};border-bottom:1px solid #e5e7eb;padding-bottom:5px">Tour Contacts</h3>
          <table style="font-size:14px;border-collapse:collapse;width:100%">
            <tr><td style="padding:3px 12px 3px 0;color:#999;width:130px">Advance Contact</td><td>${record.advanceContact || '—'}</td></tr>
            <tr><td style="padding:3px 12px 3px 0;color:#999">Email</td><td>${record.advanceEmail || '—'}</td></tr>
            <tr><td style="padding:3px 12px 3px 0;color:#999">Phone</td><td>${record.advancePhone || '—'}</td></tr>
            <tr><td style="padding:3px 12px 3px 0;color:#999">Tour Manager</td><td>${show.tourManager || '—'}</td></tr>
            <tr><td style="padding:3px 12px 3px 0;color:#999">Promoter</td><td>${show.promoter || '—'}</td></tr>
          </table>
        </div>
      </div>
      <h3 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:${stageColor};border-bottom:1px solid #e5e7eb;padding-bottom:5px">Staging & Technical</h3>
      <div style="font-size:14px;margin-bottom:20px;line-height:1.6">
        ${record.productionNeeds ? `<p style="margin:4px 0"><strong>Production Needs:</strong> ${record.productionNeeds}</p>` : ''}
        ${record.backlineNotes   ? `<p style="margin:4px 0"><strong>Backline:</strong> ${record.backlineNotes}</p>` : ''}
        ${record.stagingChanges  ? `<p style="margin:4px 0"><strong>Staging Changes:</strong> ${record.stagingChanges}</p>` : ''}
        ${record.riderNotes      ? `<p style="margin:4px 0"><strong>Rider Notes:</strong> ${record.riderNotes}</p>` : ''}
        ${!record.productionNeeds && !record.backlineNotes && !record.stagingChanges && !record.riderNotes ? '<p style="color:#999;margin:0">No staging notes entered.</p>' : ''}
      </div>
      <h3 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:${stageColor};border-bottom:1px solid #e5e7eb;padding-bottom:5px">Catering & Hospitality</h3>
      <div style="font-size:14px;margin-bottom:20px;line-height:1.6">
        ${record.cateringNotes    ? `<p style="margin:4px 0"><strong>Catering:</strong> ${record.cateringNotes}</p>` : ''}
        ${record.hospitalityNotes ? `<p style="margin:4px 0"><strong>Hospitality:</strong> ${record.hospitalityNotes}</p>` : ''}
        ${!record.cateringNotes && !record.hospitalityNotes ? '<p style="color:#999;margin:0">No catering notes entered.</p>' : ''}
      </div>
      <h3 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:${stageColor};border-bottom:1px solid #e5e7eb;padding-bottom:5px">Local Crew</h3>
      <div style="font-size:14px;margin-bottom:20px">${record.localCrewNeeds ? `<p style="margin:0;line-height:1.6">${record.localCrewNeeds}</p>` : '<p style="color:#999;margin:0">No local crew requirements entered.</p>'}</div>
      ${schedule.length > 0 ? `
        <h3 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:${stageColor};border-bottom:1px solid #e5e7eb;padding-bottom:5px">Day of Show Schedule</h3>
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
          <thead><tr>
            <th style="text-align:left;padding:5px 12px 5px 0;border-bottom:2px solid #e5e7eb;color:#999;font-size:12px">TIME</th>
            <th style="text-align:left;padding:5px 12px 5px 0;border-bottom:2px solid #e5e7eb;color:#999;font-size:12px">EVENT</th>
            <th style="text-align:left;padding:5px 12px 5px 0;border-bottom:2px solid #e5e7eb;color:#999;font-size:12px">RESPONSIBLE</th>
            <th style="text-align:left;padding:5px 0;border-bottom:2px solid #e5e7eb;color:#999;font-size:12px">NOTES</th>
          </tr></thead>
          <tbody>${scheduleRows}</tbody>
        </table>` : ''}
      ${labor.length > 0 ? `
        <h3 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:${stageColor};border-bottom:1px solid #e5e7eb;padding-bottom:5px">Labor Assignments</h3>
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
          <thead><tr>
            <th style="text-align:left;padding:5px 12px 5px 0;border-bottom:2px solid #e5e7eb;color:#999;font-size:12px">POSITION</th>
            <th style="text-align:left;padding:5px 12px 5px 0;border-bottom:2px solid #e5e7eb;color:#999;font-size:12px">NAME</th>
            <th style="text-align:left;padding:5px 12px 5px 0;border-bottom:2px solid #e5e7eb;color:#999;font-size:12px">CALL TIME</th>
            <th style="text-align:left;padding:5px 0;border-bottom:2px solid #e5e7eb;color:#999;font-size:12px">NOTES</th>
          </tr></thead>
          <tbody>${laborRows}</tbody>
        </table>` : ''}
      ${record.notes ? `<h3 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:${stageColor};border-bottom:1px solid #e5e7eb;padding-bottom:5px">Additional Notes</h3><p style="font-size:14px;margin-bottom:20px;line-height:1.6">${record.notes}</p>` : ''}
      ${botSection}
      <div style="text-align:center;margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;color:#bbb;font-size:11px">Windjammer Production Management · Confidential · Generated ${now}</div>
    </div>`
  }

  async function handleSendNotes() {
    if (!notesTo) return
    setNotesSending(true)
    try {
      const html = generateNotesHtml(notesRecord, notesData)
      await api.post('/production-notes/send', {
        to: notesTo, cc: notesCc || undefined,
        subject: `Production Brief — ${notesRecord.showName || getShowLabel(notesRecord)}`,
        html,
      })
      setNotesSent(true)
    } catch (err) {
      alert('Failed to send: ' + (err.response?.data?.message || err.message))
    } finally { setNotesSending(false) }
  }

  function handlePrintNotes() {
    const html = generateNotesHtml(notesRecord, notesData)
    const win = window.open('', '_blank')
    win.document.write(`<!DOCTYPE html><html><head><title>Production Brief</title></head><body style="margin:0">${html}</body></html>`)
    win.document.close()
    win.focus()
    setTimeout(() => win.print(), 400)
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const set = k => e => setForm(v => ({ ...v, [k]: e.target.value }))
  const f = form

  const filtered = records.filter(r =>
    !filter || (r.showName || r.showId || '').toLowerCase().includes(filter.toLowerCase())
  )

  function getShowLabel(r) {
    if (r.showName) return r.showName
    const s = shows.find(s => s.id === r.showId)
    return s ? `${s.date} — ${s.artist || s.eventName}` : r.showId
  }

  // Legacy compat used in old JSX below
  function getShowName(id) {
    const s = shows.find(s => s.id === id)
    return s ? `${s.date} — ${s.artist || s.eventName}` : id
  }

  function getBotStatus(r) {
    try {
      const b = r.botNotes ? JSON.parse(r.botNotes) : null
      if (!b) return null
      const open    = (b.issues || []).filter(i => !i.resolution)
      const flags   = open.filter(i => i.status === 'flag').length
      const reviews = open.filter(i => i.status === 'review').length
      return { flags, reviews, total: b.issues?.length || 0, summary: b.summary, analyzedAt: b.analyzedAt }
    } catch { return null }
  }

  // Acknowledge or dismiss a bot-flagged issue on the currently viewed record.
  async function resolveIssue(index, resolution) {
    if (!viewRecord) return
    let src = botResult
    if (!src && viewRecord.botNotes) {
      try { src = typeof viewRecord.botNotes === 'string' ? JSON.parse(viewRecord.botNotes) : viewRecord.botNotes } catch { src = null }
    }
    if (!src || !Array.isArray(src.issues)) return
    const stamp = new Date().toISOString()
    const who = user?.name || user?.email || ''
    const issues = src.issues.map((it, i) => i === index
      ? (resolution ? { ...it, resolution, resolvedBy: who, resolvedAt: stamp } : (() => {
          const { resolution: _r, resolvedBy: _b, resolvedAt: _a, ...rest } = it
          return rest
        })())
      : it)
    const updated = { ...src, issues }
    const botNotes = JSON.stringify(updated)
    setBotResult(updated)
    setViewRecord(v => v ? { ...v, botNotes } : v)
    setRecords(rs => rs.map(r => r.id === viewRecord.id ? { ...r, botNotes } : r))
    try { await api.put(`/advancing/${viewRecord.id}`, { botNotes }) }
    catch (err) { console.warn('resolveIssue failed:', err?.message || err) }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Advancing</div>
          <div className="page-subtitle">Pre-show rider requirements, staging and technical needs</div>
        </div>
        <button className="btn btn-primary" onClick={openAdd}>+ Add Advance</button>
      </div>

      <div className="filter-bar">
        <input
          placeholder="Search show…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
      </div>

      <div className="card">
        {loading ? <div className="loading">Loading…</div> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Show</th>
                  <th>Stage</th>
                  <th>Rider</th>
                  <th>Curfew</th>
                  <th>Contact</th>
                  <th>Bot Analysis</th>
                  <th>Complete</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={8}><div className="empty-state">No advance records found</div></td></tr>
                )}
                {filtered.map(r => {
                  const bot = getBotStatus(r);
                  return (
                    <tr key={r.id}>
                      <td>
                        <button className="btn btn-link" style={{padding:0,fontWeight:600}} onClick={() => openView(r)}>
                          {r.showName || getShowName(r.showId)}
                        </button>
                      </td>
                      <td><span className={`badge badge-${r.stage}`}>{r.stage === 'inside' ? 'Inside' : 'Beach'}</span></td>
                      <td>{r.riderReceived === 'true' ? '✅ Received' : '⏳ Pending'}</td>
                      <td className="text-muted">{r.curfew || '—'}</td>
                      <td className="text-muted">{r.advanceContact || '—'}</td>
                      <td>
                        {!bot ? (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => handleAnalyze(r)}
                            disabled={analyzing.has(r.id)}
                          >
                            {analyzing.has(r.id) ? '⏳ Analyzing…' : '⚡ Analyze'}
                          </button>
                        ) : (
                          <div style={{display:'flex',gap:4,flexWrap:'wrap',alignItems:'center'}}>
                            {bot.flags > 0 && <span className="badge" style={{background:'#fee2e2',color:'#991b1b'}}>🚩 {bot.flags} flag{bot.flags!==1?'s':''}</span>}
                            {bot.reviews > 0 && <span className="badge" style={{background:'#fef3c7',color:'#92400e'}}>⚠️ {bot.reviews} to verify</span>}
                            {bot.flags === 0 && bot.reviews === 0 && <span className="badge" style={{background:'#d1fae5',color:'#065f46'}}>✅ Clear</span>}
                            <button
                              className="btn btn-ghost btn-sm"
                              style={{fontSize:'0.7rem',padding:'1px 4px'}}
                              onClick={() => handleAnalyze(r)}
                              disabled={analyzing.has(r.id)}
                              title="Re-analyze"
                            >↺</button>
                          </div>
                        )}
                      </td>
                      <td>
                        <span className={`badge badge-${r.advancingComplete === 'true' ? 'confirmed' : 'pending'}`}>
                          {r.advancingComplete === 'true' ? 'Complete' : 'Open'}
                        </span>
                      </td>
                      <td>
                        <div className="actions-cell">
                          <button className="btn btn-ghost btn-sm" onClick={() => openView(r)}>View</button>
                          <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/email?showId=${r.showId}`)}>✉️</button>
                          <button className="btn btn-ghost btn-sm" onClick={() => openEdit(r)}>Edit</button>
                          <button className="btn btn-danger btn-sm" onClick={() => handleDelete(r.id)}>Del</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal && (
        <Modal
          title={editing ? 'Edit Advance' : 'New Advance Record'}
          onClose={() => setModal(false)}
          size="modal-lg"
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div className="form-row">
              <div className="form-group">
                <label>
                  Show
                  <label style={{ float: 'right', fontSize: 11, fontWeight: 400, color: 'var(--text-muted)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={showPastShows} onChange={e => setShowPastShows(e.target.checked)} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                    Show all (incl. past)
                  </label>
                </label>
                <select value={f.showId} onChange={e => {
                  const s = shows.find(s => s.id === e.target.value)
                  setForm(v => ({ ...v, showId: e.target.value, showName: s ? `${s.date} — ${s.artist || s.eventName}` : '' }))
                }}>
                  <option value="">Select show…</option>
                  {filterShowList(shows, { showPast: showPastShows }).map(s => (
                    <option key={s.id} value={s.id}>{s.date} — {s.artist || s.eventName} ({s.stage})</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Stage</label>
                <select value={f.stage} onChange={set('stage')}>
                  <option value="inside">Inside Stage</option>
                  <option value="beach">Beach Stage</option>
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Advance Contact</label>
                <input value={f.advanceContact} onChange={set('advanceContact')} placeholder="TM / Production contact" />
              </div>
              <div className="form-group">
                <label>Contact Phone</label>
                <input value={f.advancePhone} onChange={set('advancePhone')} placeholder="Phone number" />
              </div>
            </div>
            <div className="form-group">
              <label>Advance Contact Email</label>
              <input type="email" value={f.advanceEmail} onChange={set('advanceEmail')} />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Rider Received?</label>
                <select value={f.riderReceived} onChange={set('riderReceived')}>
                  <option value="false">No</option>
                  <option value="true">Yes</option>
                </select>
              </div>
              <div className="form-group">
                <label>Advancing Complete?</label>
                <select value={f.advancingComplete} onChange={set('advancingComplete')}>
                  <option value="false">Open</option>
                  <option value="true">Complete</option>
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Curfew</label>
                <input type="time" value={f.curfew} onChange={set('curfew')} />
              </div>
              <div className="form-group">
                <label>Sound Restrictions</label>
                <input value={f.soundRestrictions} onChange={set('soundRestrictions')} placeholder="e.g. 100dB limit at FOH" />
              </div>
            </div>
            <div className="form-group">
              <label>Rider Notes</label>
              <textarea value={f.riderNotes} onChange={set('riderNotes')} placeholder="Technical rider details…" />
            </div>
            <div className="form-group">
              <label>Production Needs</label>
              <textarea value={f.productionNeeds} onChange={set('productionNeeds')} placeholder="Sound, lights, video, staging…" />
            </div>
            <div className="form-group">
              <label>Staging / Capacity Changes</label>
              <textarea value={f.stagingChanges} onChange={set('stagingChanges')} placeholder="Any staging or capacity modifications…" />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Backline Notes</label>
                <textarea value={f.backlineNotes} onChange={set('backlineNotes')} />
              </div>
              <div className="form-group">
                <label>Local Crew Needs</label>
                <textarea value={f.localCrewNeeds} onChange={set('localCrewNeeds')} placeholder="Stagehand count, specialties…" />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Catering Notes</label>
                <textarea value={f.cateringNotes} onChange={set('cateringNotes')} />
              </div>
              <div className="form-group">
                <label>Hospitality Notes</label>
                <textarea value={f.hospitalityNotes} onChange={set('hospitalityNotes')} />
              </div>
            </div>
            <div className="form-group">
              <label>Additional Notes</label>
              <textarea value={f.notes} onChange={set('notes')} />
            </div>
          </div>
        </Modal>
      )}

      {viewRecord && (
        <Modal
          title={`Advance: ${viewRecord.showName || getShowName(viewRecord.showId)}`}
          onClose={() => { setViewRecord(null); setBotResult(null); setExtractedData(null); setExtEdits({}); setAnalyzingView(false); }}
          size="modal-lg"
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => { setViewRecord(null); setBotResult(null); setExtractedData(null); setExtEdits({}); setAnalyzingView(false); }}>Close</button>
              <button className="btn btn-ghost" onClick={() => { const r = viewRecord; setViewRecord(null); setBotResult(null); setExtractedData(null); setExtEdits({}); setAnalyzingView(false); openEdit(r); }}>Edit</button>
              <button className="btn btn-ghost" onClick={() => { setViewRecord(null); setBotResult(null); setExtractedData(null); setExtEdits({}); setAnalyzingView(false); navigate(`/email?showId=${viewRecord.showId}`); }}>✉️ Email Thread</button>
              <button className="btn btn-primary" onClick={() => { const r = viewRecord; setViewRecord(null); setBotResult(null); setExtractedData(null); setExtEdits({}); setAnalyzingView(false); openNotes(r); }}>📋 Production Brief</button>
            </>
          }
        >
          <div style={{display:'grid',gap:'1rem'}}>
            <div style={{display:'flex',gap:'0.5rem',flexWrap:'wrap'}}>
              <span className={`badge badge-${viewRecord.stage}`}>{viewRecord.stage === 'inside' ? 'Inside Stage' : 'Beach Stage'}</span>
              <span className={`badge badge-${viewRecord.riderReceived === 'true' ? 'confirmed' : 'pending'}`}>Rider: {viewRecord.riderReceived === 'true' ? 'Received' : 'Pending'}</span>
              <span className={`badge badge-${viewRecord.advancingComplete === 'true' ? 'confirmed' : 'pending'}`}>{viewRecord.advancingComplete === 'true' ? 'Advancing Complete' : 'Advancing Open'}</span>
              {viewRecord.curfew && <span className="badge">Curfew: {viewRecord.curfew}</span>}
              {viewRecord.soundRestrictions && <span className="badge badge-pending">🔇 {viewRecord.soundRestrictions}</span>}
            </div>

            {viewRecord.advanceContact && (
              <div>
                <strong>{viewRecord.advanceContact}</strong>
                {viewRecord.advancePhone && <span className="text-muted"> · {viewRecord.advancePhone}</span>}
                {viewRecord.advanceEmail && <span className="text-muted"> · {viewRecord.advanceEmail}</span>}
              </div>
            )}

            {/* ── Bot-extracted from emails (review & accept) ────────────────── */}
            {extractedData?.fields && Object.keys(extractedData.fields).length > 0 && (
              <>
                <hr style={{margin:'0.25rem 0'}} />
                <div style={{background:'#eff6ff',border:'1px solid #bfdbfe',borderRadius:8,padding:'0.75rem'}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'0.5rem'}}>
                    <div>
                      <strong>🤖 Extracted from emails</strong>
                      <span className="text-muted" style={{marginLeft:8,fontSize:'0.8rem'}}>
                        {Object.keys(extractedData.fields).length} suggestion{Object.keys(extractedData.fields).length !== 1 ? 's' : ''} · {extractedData.emailCount || 0} email{extractedData.emailCount !== 1 ? 's' : ''} scanned
                      </span>
                    </div>
                    <div style={{display:'flex',gap:6}}>
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={acceptingExt}
                        onClick={() => applyExtraction({ dismissKeys: Object.keys(extractedData.fields) })}
                      >Dismiss all</button>
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={acceptingExt}
                        onClick={() => applyExtraction({ acceptKeys: Object.keys(extractedData.fields) })}
                      >{acceptingExt ? 'Applying…' : '✅ Accept all'}</button>
                    </div>
                  </div>
                  <div style={{display:'grid',gap:'0.5rem'}}>
                    {Object.entries(extractedData.fields).map(([key, f]) => {
                      const editValue = extEdits[key] !== undefined ? extEdits[key] : f.value
                      const currentValue = viewRecord[key] || ''
                      const conflict = currentValue && currentValue.trim() && currentValue.trim() !== f.value.trim()
                      const confColor = f.confidence === 'high' ? '#065f46' : f.confidence === 'medium' ? '#92400e' : '#374151'
                      const confBg    = f.confidence === 'high' ? '#d1fae5' : f.confidence === 'medium' ? '#fef3c7' : '#e5e7eb'
                      return (
                        <div key={key} style={{background:'#fff',borderRadius:6,padding:'0.6rem 0.75rem',border:'1px solid #e5e7eb'}}>
                          <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',gap:8,marginBottom:4}}>
                            <div>
                              <strong>{f.label || key}</strong>
                              <span style={{marginLeft:8,fontSize:'0.7rem',padding:'1px 6px',borderRadius:10,background:confBg,color:confColor,fontWeight:600,textTransform:'uppercase'}}>{f.confidence}</span>
                              {conflict && <span style={{marginLeft:8,fontSize:'0.7rem',padding:'1px 6px',borderRadius:10,background:'#fee2e2',color:'#991b1b',fontWeight:600}}>OVERWRITES</span>}
                            </div>
                            <div style={{display:'flex',gap:4}}>
                              <button
                                className="btn btn-ghost btn-sm"
                                disabled={acceptingExt}
                                onClick={() => applyExtraction({ dismissKeys: [key] })}
                                title="Don't apply this suggestion"
                              >✕</button>
                              <button
                                className="btn btn-primary btn-sm"
                                disabled={acceptingExt}
                                onClick={() => applyExtraction({ acceptKeys: [key] })}
                                title="Apply this value to the advance record"
                              >Accept</button>
                            </div>
                          </div>
                          <textarea
                            value={editValue}
                            onChange={e => setExtEdits(prev => ({ ...prev, [key]: e.target.value }))}
                            rows={Math.min(4, Math.max(1, Math.ceil(editValue.length / 80)))}
                            style={{width:'100%',fontSize:'0.85rem',padding:'4px 6px',border:'1px solid #d1d5db',borderRadius:4,resize:'vertical',fontFamily:'inherit'}}
                          />
                          {conflict && (
                            <div style={{fontSize:'0.75rem',color:'#991b1b',marginTop:4}}>
                              <strong>Current value:</strong> <span style={{color:'#6b7280'}}>{currentValue}</span>
                            </div>
                          )}
                          {f.source?.quote && (
                            <div style={{fontSize:'0.72rem',color:'#6b7280',marginTop:6,paddingTop:6,borderTop:'1px dashed #e5e7eb',fontStyle:'italic'}}>
                              “{f.source.quote}” — <span style={{color:'#374151'}}>{f.source.subject}</span>{f.source.from ? ` · ${f.source.from.replace(/<.*>/, '').trim()}` : ''}
                            </div>
                          )}
                          {f.alternates?.length > 0 && (
                            <div style={{fontSize:'0.72rem',color:'#6b7280',marginTop:4}}>
                              {f.alternates.length} other candidate{f.alternates.length !== 1 ? 's' : ''} in earlier emails
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </>
            )}

            <hr style={{margin:'0.25rem 0'}} />

            <div>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'0.5rem'}}>
                <strong>Bot Analysis</strong>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => handleAnalyze(viewRecord, { fromView: true })}
                  disabled={analyzingView || analyzing.has(viewRecord.id)}
                >
                  {analyzingView || analyzing.has(viewRecord.id) ? '⏳ Analyzing…' : (botResult || viewRecord.botNotes) ? '↺ Re-analyze' : '⚡ Run Analysis'}
                </button>
              </div>

              {(() => {
                let issues = [];
                try {
                  let src = botResult;
                  if (!src && viewRecord.botNotes) src = typeof viewRecord.botNotes === 'string' ? JSON.parse(viewRecord.botNotes) : viewRecord.botNotes;
                  if (src) issues = (typeof src === 'string' ? JSON.parse(src) : src).issues || [];
                } catch {}
                if (analyzingView || analyzing.has(viewRecord.id)) {
                  return <div className="text-muted">Analyzing email threads and rider notes…</div>;
                }
                if (!issues.length) {
                  return <div className="text-muted" style={{fontSize:'0.9rem'}}>No analysis run yet. Click "Run Analysis" to check for conflicts.</div>;
                }
                if (issues.length === 0) {
                  return <div style={{color:'#065f46',background:'#d1fae5',padding:'0.75rem',borderRadius:6}}>✅ No conflicts detected. All rider needs appear to be covered by venue capabilities.</div>;
                }
                return (
                  <div style={{display:'grid',gap:'0.5rem'}}>
                    {issues.map((issue, i) => {
                      const resolved = issue.resolution === 'acknowledged' || issue.resolution === 'dismissed'
                      const borderColor = resolved ? '#cbd5e1' : (issue.status === 'flag' ? '#ef4444' : '#f59e0b')
                      const bg = resolved ? '#f8fafc' : (issue.status === 'flag' ? '#fef2f2' : '#fffbeb')
                      return (
                        <div key={i} style={{
                          padding:'0.75rem',
                          borderRadius:6,
                          borderLeft:`4px solid ${borderColor}`,
                          background: bg,
                          opacity: resolved ? 0.75 : 1
                        }}>
                          <div style={{display:'flex',gap:'0.5rem',alignItems:'baseline',flexWrap:'wrap'}}>
                            <span style={{fontWeight:600,textDecoration: resolved ? 'line-through' : 'none'}}>{issue.category}</span>
                            <span style={{fontSize:'0.75rem',fontWeight:600,color:issue.status==='flag'?'#991b1b':'#92400e'}}>
                              {issue.status === 'flag' ? '🚩 Follow-up Needed' : '⚠️ Verify Specs'}
                            </span>
                            {issue.resolution === 'acknowledged' && (
                              <span className="badge" style={{background:'#d1fae5',color:'#065f46'}}>✅ Acknowledged</span>
                            )}
                            {issue.resolution === 'dismissed' && (
                              <span className="badge" style={{background:'#e5e7eb',color:'#374151'}}>🚫 Dismissed</span>
                            )}
                          </div>
                          <div style={{marginTop:'0.25rem',fontSize:'0.9rem'}}>{issue.note}</div>
                          {resolved && (issue.resolvedBy || issue.resolvedAt) && (
                            <div className="text-muted" style={{fontSize:'0.75rem',marginTop:4}}>
                              by {issue.resolvedBy || 'unknown'}
                              {issue.resolvedAt ? ` · ${new Date(issue.resolvedAt).toLocaleString()}` : ''}
                            </div>
                          )}
                          <div style={{display:'flex',gap:6,marginTop:8}}>
                            {!resolved ? (
                              <>
                                <button className="btn btn-ghost btn-sm" onClick={() => resolveIssue(i, 'acknowledged')}>✅ Acknowledge</button>
                                <button className="btn btn-ghost btn-sm" onClick={() => resolveIssue(i, 'dismissed')}>🚫 Dismiss</button>
                              </>
                            ) : (
                              <button className="btn btn-ghost btn-sm" onClick={() => resolveIssue(i, null)}>↺ Reopen</button>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                );
              })()}
            </div>

            {(viewRecord.riderNotes || viewRecord.productionNeeds || viewRecord.backlineNotes || viewRecord.localCrewNeeds || viewRecord.cateringNotes || viewRecord.hospitalityNotes || viewRecord.stagingChanges || viewRecord.notes) && (
              <>
                <hr style={{margin:'0.25rem 0'}} />
                <div style={{display:'grid',gap:'0.75rem'}}>
                  {viewRecord.riderNotes && <div><strong>Rider Notes</strong><p style={{margin:'0.25rem 0 0',whiteSpace:'pre-wrap',fontSize:'0.9rem'}}>{viewRecord.riderNotes}</p></div>}
                  {viewRecord.productionNeeds && <div><strong>Production Needs</strong><p style={{margin:'0.25rem 0 0',whiteSpace:'pre-wrap',fontSize:'0.9rem'}}>{viewRecord.productionNeeds}</p></div>}
                  {viewRecord.backlineNotes && <div><strong>Backline</strong><p style={{margin:'0.25rem 0 0',whiteSpace:'pre-wrap',fontSize:'0.9rem'}}>{viewRecord.backlineNotes}</p></div>}
                  {viewRecord.localCrewNeeds && <div><strong>Local Crew</strong><p style={{margin:'0.25rem 0 0',whiteSpace:'pre-wrap',fontSize:'0.9rem'}}>{viewRecord.localCrewNeeds}</p></div>}
                  {viewRecord.cateringNotes && <div><strong>Catering</strong><p style={{margin:'0.25rem 0 0',whiteSpace:'pre-wrap',fontSize:'0.9rem'}}>{viewRecord.cateringNotes}</p></div>}
                  {viewRecord.hospitalityNotes && <div><strong>Hospitality</strong><p style={{margin:'0.25rem 0 0',whiteSpace:'pre-wrap',fontSize:'0.9rem'}}>{viewRecord.hospitalityNotes}</p></div>}
                  {viewRecord.stagingChanges && <div><strong>Staging / Capacity Changes</strong><p style={{margin:'0.25rem 0 0',whiteSpace:'pre-wrap',fontSize:'0.9rem'}}>{viewRecord.stagingChanges}</p></div>}
                  {viewRecord.notes && <div><strong>Additional Notes</strong><p style={{margin:'0.25rem 0 0',whiteSpace:'pre-wrap',fontSize:'0.9rem'}}>{viewRecord.notes}</p></div>}
                </div>
              </>
            )}

            {/* ── Day of Show Schedule ── */}
            <hr style={{margin:'0.25rem 0'}} />
            <div>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'0.5rem'}}>
                <strong>Day of Show Schedule</strong>
                <div style={{display:'flex',gap:6}}>
                  <button className="btn btn-ghost btn-sm" onClick={printDaySheet} disabled={loadingSchedule}>🖨️ Print</button>
                  <button className="btn btn-ghost btn-sm" onClick={openSchedAdd}>+ Add Item</button>
                </div>
              </div>
              {loadingSchedule ? (
                <div className="text-muted" style={{fontSize:'0.9rem'}}>Loading…</div>
              ) : schedItems.length === 0 ? (
                <div className="text-muted" style={{fontSize:'0.9rem'}}>No schedule items yet. Click + Add Item to build the timeline.</div>
              ) : (
                <table style={{width:'100%',fontSize:'0.875rem',borderCollapse:'collapse'}}>
                  <thead>
                    <tr>
                      {['Time','Event / Task','Responsible','Notes',''].map(h => (
                        <th key={h} style={{textAlign:'left',paddingBottom:6,color:'var(--text-muted)',fontWeight:600,fontSize:'0.75rem',borderBottom:'1px solid var(--border)',paddingRight:8}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {schedItems.map(item => (
                      <tr key={item.id}>
                        <td style={{padding:'5px 8px 5px 0',whiteSpace:'nowrap',borderBottom:'1px solid var(--border)'}}><strong>{item.time ? formatTime(item.time, tf) : '—'}</strong></td>
                        <td style={{padding:'5px 8px 5px 0',borderBottom:'1px solid var(--border)'}}>{item.label || '—'}</td>
                        <td style={{padding:'5px 8px 5px 0',color:'var(--text-muted)',borderBottom:'1px solid var(--border)'}}>{item.responsible || '—'}</td>
                        <td style={{padding:'5px 8px 5px 0',color:'var(--text-muted)',maxWidth:180,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',borderBottom:'1px solid var(--border)'}}>{item.notes || '—'}</td>
                        <td style={{padding:'5px 0',whiteSpace:'nowrap',borderBottom:'1px solid var(--border)'}}>
                          <div className="actions-cell">
                            <button className="btn btn-ghost btn-sm" onClick={() => openSchedEdit(item)}>Edit</button>
                            <button className="btn btn-danger btn-sm" onClick={() => handleSchedDelete(item.id)}>Del</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </Modal>
      )}

      {schedModal && (
        <Modal
          title={schedEditing ? 'Edit Schedule Item' : 'Add Schedule Item'}
          onClose={() => setSchedModal(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setSchedModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSchedSave} disabled={schedSaving}>
                {schedSaving ? 'Saving…' : 'Save'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div className="form-row">
              <div className="form-group">
                <label>Time</label>
                <input type="time" value={schedForm.time} onChange={e => setSchedForm(v => ({ ...v, time: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>Stage</label>
                <select value={schedForm.stage} onChange={e => setSchedForm(v => ({ ...v, stage: e.target.value }))}>
                  <option value="inside">Inside Stage</option>
                  <option value="beach">Beach Stage</option>
                </select>
              </div>
            </div>
            <div className="form-group">
              <label>Event / Task</label>
              <input value={schedForm.label} onChange={e => setSchedForm(v => ({ ...v, label: e.target.value }))} placeholder="e.g. Load In, Sound Check, Doors, Set 1, Load Out…" />
            </div>
            <div className="form-group">
              <label>Responsible Party</label>
              <input value={schedForm.responsible} onChange={e => setSchedForm(v => ({ ...v, responsible: e.target.value }))} placeholder="Who is responsible" />
            </div>
            <div className="form-group">
              <label>Notes</label>
              <textarea value={schedForm.notes} onChange={e => setSchedForm(v => ({ ...v, notes: e.target.value }))} />
            </div>
          </div>
        </Modal>
      )}

      {notesRecord && (
        <Modal
          title={`Production Brief — ${notesRecord.showName || getShowName(notesRecord.showId)}`}
          onClose={() => { setNotesRecord(null); setNotesData(null); setNotesSent(false); }}
          size="modal-xl"
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => { setNotesRecord(null); setNotesData(null); setNotesSent(false); }}>Close</button>
              <button className="btn btn-ghost" onClick={handlePrintNotes}>🖨 Print / PDF</button>
              <button className="btn btn-primary" onClick={handleSendNotes} disabled={notesSending || notesSent}>
                {notesSent ? '✅ Sent!' : notesSending ? 'Sending…' : '✉️ Send to Staff'}
              </button>
            </>
          }
        >
          {loadingNotes ? (
            <div className="loading">Building production brief…</div>
          ) : (
            <div style={{display:'grid',gap:'1rem'}}>
              <div className="form-row">
                <div className="form-group">
                  <label>To</label>
                  <input value={notesTo} onChange={e => setNotesTo(e.target.value)} placeholder="email@venue.com, …" />
                </div>
                <div className="form-group">
                  <label>Cc</label>
                  <input value={notesCc} onChange={e => setNotesCc(e.target.value)} placeholder="optional" />
                </div>
              </div>
              <iframe
                srcDoc={generateNotesHtml(notesRecord, notesData)}
                style={{width:'100%',height:480,border:'1px solid #e5e7eb',borderRadius:6,background:'#fff'}}
                title="Production Brief Preview"
              />
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}
