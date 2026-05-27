import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import api from '../api'
import Modal from '../components/Modal'
import { useSettings } from '../context/SettingsContext'
import { formatTime } from '../utils/time'
import { getTicketStats } from '../utils/stages'

const BLANK_ADV = {
  riderReceived: 'false', riderNotes: '', stagingChanges: '', capacityChanges: '',
  soundRestrictions: '', curfew: '', productionNeeds: '', backlineNotes: '',
  cateringNotes: '', hospitalityNotes: '', localCrewNeeds: '', advancingComplete: 'false',
  advanceContact: '', advancePhone: '', advanceEmail: '', notes: '',
}

const BLANK_SCHED = {
  eventType: 'time', label: '', time: '', duration: '', responsible: '', notes: '',
}

const BLANK_LABOR = {
  staffId: '', workerName: '', role: '', callTime: '', wrapTime: '',
  payType: 'hour', days: '1',
  hours: '', rate: '', total: '', union: 'false', notes: '',
}

const BLANK_SHOW = {
  date: '', artist: '', eventName: '', stage: 'inside', status: 'pending',
  showTime: '', doorsTime: '', capacity: '', ticketPrice: '', ticketsSold: '', guarantee: '',
  promoter: '', tourManager: '', notes: '',
}

export default function ShowDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { settings } = useSettings()
  const tf = settings.timeFormat || '12h'

  const [show, setShow]           = useState(null)
  const [siblings, setSiblings]   = useState([]) // other dates of the same multi-night run
  const [advancing, setAdvancing] = useState(null)
  const [schedule, setSchedule]   = useState([])
  const [labor, setLabor]         = useState([])
  const [loading, setLoading]     = useState(true)
  const [copyingFrom, setCopyingFrom] = useState('')
  const [activeTab, setActiveTab] = useState('advancing')
  const [artistFilled, setArtistFilled] = useState(false)

  // Show edit
  const [showModal, setShowModal]   = useState(false)
  const [showForm, setShowForm]     = useState(BLANK_SHOW)
  const [savingShow, setSavingShow] = useState(false)

  // Advancing
  const [advForm, setAdvForm]     = useState(BLANK_ADV)
  const [savingAdv, setSavingAdv] = useState(false)
  const [savedAdv, setSavedAdv]   = useState(false)

  // Schedule
  const [schedModal, setSchedModal]     = useState(false)
  const [schedEditing, setSchedEditing] = useState(null)
  const [schedForm, setSchedForm]       = useState(BLANK_SCHED)
  const [savingSched, setSavingSched]   = useState(false)

  // Labor
  const [laborModal, setLaborModal]     = useState(false)
  const [laborEditing, setLaborEditing] = useState(null)
  const [laborForm, setLaborForm]       = useState(BLANK_LABOR)
  const [savingLabor, setSavingLabor]   = useState(false)
  const [staff, setStaff]               = useState([])
  const [quickAddName, setQuickAddName] = useState('')
  const [quickAddBusy, setQuickAddBusy] = useState(false)
  const [quickAddError, setQuickAddError] = useState('')
  const showLaborQuickAdd = laborForm.staffId === '__new__'

  // Bulk Build-Crew modal
  const [crewModal, setCrewModal]       = useState(false)
  const [crewRows, setCrewRows]         = useState([])
  const [crewSaving, setCrewSaving]     = useState(false)
  const [crewQuickRow, setCrewQuickRow] = useState(null)
  const [crewQuickName, setCrewQuickName] = useState('')
  const [crewQuickBusy, setCrewQuickBusy] = useState(false)

  useEffect(() => { loadAll() }, [id]) // eslint-disable-line

  // ── Load all data ────────────────────────────────────────────────────────────
  async function loadAll() {
    setLoading(true)
    try {
      const [showsRes, advRes, schedRes, laborRes, staffRes] = await Promise.all([
        api.get('/shows'),
        api.get('/advancing'),
        api.get('/schedule'),
        api.get('/labor'),
        api.get('/staff'),
      ])

      const shows = showsRes.data.data || []
      const thisShow = shows.find(s => s.id === id)
      if (!thisShow) { navigate('/shows'); return }
      setShow(thisShow)
      setShowForm({ ...BLANK_SHOW, ...thisShow })

      // Find sibling shows: same artist + stage (case-insensitive) = same run
      const artistLc = (thisShow.artist || thisShow.eventName || '').trim().toLowerCase()
      const sibs = artistLc
        ? shows
            .filter(s => (s.artist || s.eventName || '').trim().toLowerCase() === artistLc
                       && (s.stage || '').toLowerCase() === (thisShow.stage || '').toLowerCase())
            .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
        : [thisShow]
      setSiblings(sibs)

      const advances = advRes.data.data || []
      let adv = advances.find(a => a.showId === id)
      let prefilled = false

      if (!adv) {
        // ── Search artist history for pre-fill ─────────────────────────────
        const artistKey = (thisShow.artist || thisShow.eventName || '').toLowerCase().trim()
        const history = artistKey.length > 3
          ? advances
              .filter(a => a.showId !== id && (a.showName || '').toLowerCase().includes(artistKey.slice(0, 12)))
              .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
          : []

        const prev = history[0]
        if (prev) prefilled = true

        const newAdv = {
          showId: id,
          showName: `${thisShow.date} — ${thisShow.artist || thisShow.eventName}`,
          stage: thisShow.stage,
          riderReceived: 'false',
          advancingComplete: 'false',
          riderNotes:       prev?.riderNotes       || '',
          productionNeeds:  prev?.productionNeeds  || '',
          backlineNotes:    prev?.backlineNotes     || '',
          stagingChanges:   '',
          capacityChanges:  '',
          soundRestrictions: prev?.soundRestrictions || '',
          curfew:           '',
          cateringNotes:    prev?.cateringNotes    || '',
          hospitalityNotes: prev?.hospitalityNotes || '',
          localCrewNeeds:   prev?.localCrewNeeds   || '',
          advanceContact:   '',
          advancePhone:     '',
          advanceEmail:     '',
          notes:            '',
        }
        const res = await api.post('/advancing', newAdv)
        adv = res.data.data
      }

      setAdvancing(adv)
      setAdvForm({ ...BLANK_ADV, ...adv })
      setArtistFilled(prefilled)

      setSchedule(
        (schedRes.data.data || [])
          .filter(s => s.showId === id)
          .sort((a, b) => (a.time || '').localeCompare(b.time || ''))
      )
      setLabor((laborRes.data.data || []).filter(l => l.showId === id))
      setStaff(staffRes.data.data || [])
    } finally {
      setLoading(false)
    }
  }

  async function reloadSchedule() {
    const res = await api.get('/schedule')
    setSchedule(
      (res.data.data || [])
        .filter(s => s.showId === id)
        .sort((a, b) => (a.time || '').localeCompare(b.time || ''))
    )
  }

  async function reloadLabor() {
    const res = await api.get('/labor')
    setLabor((res.data.data || []).filter(l => l.showId === id))
  }

  // ── Show edit ────────────────────────────────────────────────────────────────
  async function handleSaveShow() {
    setSavingShow(true)
    try {
      await api.put(`/shows/${show.id}`, showForm)
      const res = await api.get('/shows')
      const updated = (res.data.data || []).find(s => s.id === id)
      if (updated) { setShow(updated); setShowForm({ ...BLANK_SHOW, ...updated }) }
      setShowModal(false)
    } finally { setSavingShow(false) }
  }

  // ── Advancing ────────────────────────────────────────────────────────────────
  const setAdv = k => e => setAdvForm(v => ({ ...v, [k]: e.target.value }))

  async function handleSaveAdv() {
    if (!advancing) return
    setSavingAdv(true)
    try {
      await api.put(`/advancing/${advancing.id}`, advForm)
      setSavedAdv(true)
      setTimeout(() => setSavedAdv(false), 2500)
    } finally { setSavingAdv(false) }
  }

  // ── Schedule ──────────────────────────────────────────────────────────────────
  const setS = k => e => setSchedForm(v => ({ ...v, [k]: e.target.value }))

  function openAddSched() { setSchedEditing(null); setSchedForm({ ...BLANK_SCHED }); setSchedModal(true) }
  function openEditSched(r) { setSchedEditing(r); setSchedForm({ ...BLANK_SCHED, ...r }); setSchedModal(true) }

  async function handleSaveSched() {
    setSavingSched(true)
    try {
      const payload = {
        ...schedForm,
        showId:   id,
        showName: `${show.date} — ${show.artist || show.eventName}`,
        stage:    show.stage,
        date:     show.date,
      }
      if (schedEditing) await api.put(`/schedule/${schedEditing.id}`, payload)
      else await api.post('/schedule', payload)
      await reloadSchedule()
      setSchedModal(false)
    } finally { setSavingSched(false) }
  }

  async function handleDeleteSched(sid) {
    if (!confirm('Delete this item?')) return
    await api.delete(`/schedule/${sid}`)
    await reloadSchedule()
  }

  async function handleCopySchedule(fromShowId) {
    if (!fromShowId) return
    setCopyingFrom(fromShowId)
    try {
      const sourceShow = siblings.find(s => s.id === fromShowId)
      const sourceName = sourceShow ? `Night ${siblings.findIndex(s => s.id === fromShowId) + 1} (${sourceShow.date})` : 'that night'
      const replaceAll = schedule.length > 0
        ? confirm(`Copy ${sourceName}'s schedule into THIS day?\n\nClick OK to REPLACE this day's ${schedule.length} item(s).\nClick Cancel to keep both (append).`)
        : true
      const res = await api.get('/schedule')
      const allSched = res.data.data || []
      const sourceItems = allSched.filter(s => s.showId === fromShowId)
      if (sourceItems.length === 0) {
        alert('That night has no schedule items yet.')
        return
      }
      if (replaceAll) {
        await Promise.all(schedule.map(s => api.delete(`/schedule/${s.id}`)))
      }
      for (const item of sourceItems) {
        // eslint-disable-next-line no-unused-vars
        const { id: _omit, createdAt, updatedAt, ...rest } = item
        await api.post('/schedule', {
          ...rest,
          showId:   id,
          showName: `${show.date} — ${show.artist || show.eventName}`,
          stage:    show.stage,
          date:     show.date,
        })
      }
      await reloadSchedule()
    } finally {
      setCopyingFrom('')
    }
  }

  // ── Labor ────────────────────────────────────────────────────────────────────
  const setL = k => e => setLaborForm(v => ({ ...v, [k]: e.target.value }))

  function calcTotal(h, r) {
    const hv = parseFloat(h), rv = parseFloat(r)
    return !isNaN(hv) && !isNaN(rv) ? (hv * rv).toFixed(2) : ''
  }

  function parseRates(raw) {
    if (!raw) return []
    if (Array.isArray(raw)) return raw
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : [] }
    catch { return [] }
  }

  const selectedLaborStaff = staff.find(s => s.id === laborForm.staffId)
  const selectedLaborRates = selectedLaborStaff ? parseRates(selectedLaborStaff.rates) : []

  function pickLaborStaff(sid) {
    if (sid === '__new__') {
      setQuickAddName(''); setQuickAddError('')
      setLaborForm(v => ({ ...v, staffId: '__new__', workerName: '' }))
      return
    }
    const s = staff.find(x => x.id === sid)
    if (!s) { setLaborForm(v => ({ ...v, staffId: '', workerName: '' })); return }
    const rates = parseRates(s.rates)
    if (rates.length === 1) {
      const r = rates[0]
      setLaborForm(v => ({
        ...v, staffId: s.id, workerName: s.name || '',
        role: r.role || s.role || v.role,
        payType: r.payType || v.payType || 'hour',
        rate: r.rate || '',
      }))
      return
    }
    const payType = s.payType || 'hour'
    const rate = payType === 'day' ? (s.dayRate || '') : (s.hourlyRate || '')
    setLaborForm(v => ({
      ...v, staffId: s.id, workerName: s.name || '',
      role: s.role || v.role,
      payType, rate,
    }))
  }

  function pickLaborStaffPosition(idx) {
    const r = selectedLaborRates[Number(idx)]
    if (!r) return
    setLaborForm(v => ({
      ...v, role: r.role || v.role,
      payType: r.payType || 'hour', rate: r.rate || '',
    }))
  }

  async function quickAddLaborWorker() {
    const name = quickAddName.trim()
    if (!name) { setQuickAddError('Enter a name'); return }
    setQuickAddBusy(true); setQuickAddError('')
    try {
      const res = await api.post('/staff', { name, active: 'true' })
      const created = res.data?.data || res.data
      if (!created?.id) throw new Error('Could not add worker')
      setStaff(prev => [...prev, created])
      setLaborForm(v => ({ ...v, staffId: created.id, workerName: created.name || name }))
      setQuickAddName('')
    } catch (err) {
      setQuickAddError(err.response?.data?.message || err.message || 'Could not add worker')
    } finally {
      setQuickAddBusy(false)
    }
  }

  // ── Bulk Build-Crew helpers (scoped to this show) ──────────────────────────
  const newRowId = () => `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  function makeCrewRow(role) {
    return { _rid: newRowId(), staffId: '', workerName: '', role: role || '',
             callTime: '', wrapTime: '', payType: 'hour', days: '1', hours: '', rate: '', union: 'false' }
  }
  function openCrewBuilder() {
    setCrewRows([
      makeCrewRow('House Crew'),
      makeCrewRow('House Crew'),
      makeCrewRow('House Crew'),
    ])
    setCrewQuickRow(null); setCrewQuickName('')
    setCrewModal(true)
  }
  function updateCrewRow(rid, patch) {
    setCrewRows(rows => rows.map(r => r._rid === rid ? { ...r, ...patch } : r))
  }
  function pickCrewWorker(rid, sid) {
    if (sid === '__new__') { setCrewQuickRow(rid); setCrewQuickName(''); return }
    const s = staff.find(x => x.id === sid)
    if (!s) { updateCrewRow(rid, { staffId: '', workerName: '' }); return }
    const rates = parseRates(s.rates)
    if (rates.length >= 1) {
      const r = rates[0]
      updateCrewRow(rid, {
        staffId: s.id, workerName: s.name || '', role: r.role || s.role || '',
        payType: r.payType || 'hour', rate: r.rate || '',
      })
    } else {
      const payType = s.payType || 'hour'
      const rate = payType === 'day' ? (s.dayRate || '') : (s.hourlyRate || '')
      updateCrewRow(rid, { staffId: s.id, workerName: s.name || '', role: s.role || '', payType, rate })
    }
  }
  async function commitCrewQuickAdd() {
    const name = crewQuickName.trim()
    if (!name) return
    setCrewQuickBusy(true)
    try {
      const res = await api.post('/staff', { name, active: 'true' })
      const created = res.data?.data || res.data
      if (!created?.id) throw new Error('Could not add worker')
      setStaff(prev => [...prev, created])
      if (crewQuickRow) updateCrewRow(crewQuickRow, { staffId: created.id, workerName: created.name || name })
      setCrewQuickRow(null); setCrewQuickName('')
    } catch (err) {
      alert(err.response?.data?.message || err.message || 'Could not add worker')
    } finally {
      setCrewQuickBusy(false)
    }
  }
  function calcRowTotal(r) {
    if ((r.payType || 'hour') === 'day') {
      const d = parseFloat(r.days || '1'), rate = parseFloat(r.rate)
      return !isNaN(d) && !isNaN(rate) ? (d * rate).toFixed(2) : ''
    }
    const h = parseFloat(r.hours), rate = parseFloat(r.rate)
    return !isNaN(h) && !isNaN(rate) ? (h * rate).toFixed(2) : ''
  }
  async function handleCrewSave() {
    const valid = crewRows.filter(r => r.staffId && r.staffId !== '__new__' && r.workerName)
    if (valid.length === 0) { alert('Add at least one worker.'); return }
    setCrewSaving(true)
    try {
      for (const r of valid) {
        const payload = {
          showId: id, showName: `${show.date} — ${show.artist || show.eventName}`, stage: show.stage,
          staffId: r.staffId, workerName: r.workerName, role: r.role || '',
          callTime: r.callTime || '', wrapTime: r.wrapTime || '',
          payType: r.payType || 'hour', days: r.days || '1', hours: r.hours || '',
          rate: r.rate || '', total: calcRowTotal(r), union: r.union || 'false', notes: '',
        }
        await api.post('/labor', payload)
      }
      await reloadLabor()
      setCrewModal(false)
    } catch (err) {
      alert(err.response?.data?.message || err.message || 'Save failed')
    } finally {
      setCrewSaving(false)
    }
  }

  function openAddLabor() { setLaborEditing(null); setLaborForm({ ...BLANK_LABOR }); setQuickAddName(''); setQuickAddError(''); setLaborModal(true) }
  function openEditLabor(r) { setLaborEditing(r); setLaborForm({ ...BLANK_LABOR, ...r }); setLaborModal(true) }

  async function handleSaveLabor() {
    setSavingLabor(true)
    try {
      const payload = {
        ...laborForm,
        total:    calcTotal(laborForm.hours, laborForm.rate),
        showId:   id,
        showName: `${show.date} — ${show.artist || show.eventName}`,
        stage:    show.stage,
      }
      if (laborEditing) await api.put(`/labor/${laborEditing.id}`, payload)
      else await api.post('/labor', payload)
      await reloadLabor()
      setLaborModal(false)
    } finally { setSavingLabor(false) }
  }

  async function handleDeleteLabor(lid) {
    if (!confirm('Delete this labor entry?')) return
    await api.delete(`/labor/${lid}`)
    await reloadLabor()
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  if (loading) return <div className="loading">Loading show…</div>
  if (!show) return null

  const stageColor = show.stage === 'inside' ? '#3b82f6' : '#10b981'
  const stageRgb   = show.stage === 'inside' ? '59,130,246' : '16,185,129'
  const totalLaborCost = labor.reduce((sum, l) => sum + parseFloat(l.total || 0), 0)
  const f = advForm

  return (
    <div>

      {/* ── Show Banner ───────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginBottom: 8 }}>
          <Link to="/shows" style={{ color: 'rgba(255,255,255,0.4)', textDecoration: 'none' }}>
            ← All Shows
          </Link>
        </div>
        <div style={{
          borderRadius: 10, padding: '20px 24px',
          background: `linear-gradient(135deg, rgba(${stageRgb},0.14) 0%, rgba(255,255,255,0.03) 100%)`,
          border: `1px solid rgba(${stageRgb},0.25)`,
          display: 'flex', alignItems: 'flex-start', gap: 20, flexWrap: 'wrap',
        }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 24, fontWeight: 700, marginBottom: 6 }}>
              {show.artist || show.eventName || 'Untitled Show'}
            </div>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.55)', display: 'flex', gap: 18, flexWrap: 'wrap' }}>
              <span>📅 {show.date}</span>
              {show.showTime  && <span>🕐 Show: {formatTime(show.showTime, tf)}</span>}
              {show.doorsTime && <span>🚪 Doors: {formatTime(show.doorsTime, tf)}</span>}
              {(() => {
                const { sold, capacity, pct } = getTicketStats(show)
                if (!capacity && !sold) return null
                return (
                  <span title="Tickets sold / capacity">
                    🎟 {sold}{capacity ? ` / ${capacity}` : ''}
                    {pct != null && <strong style={{ marginLeft: 4, color: pct >= 80 ? '#86efac' : pct >= 40 ? '#fde68a' : '#fca5a5' }}>· {pct}%</strong>}
                  </span>
                )
              })()}
              {show.tourManager && <span>🎭 TM: {show.tourManager}</span>}
              {show.promoter  && <span>📣 {show.promoter}</span>}
              {show.ticketPrice && <span>💵 ${show.ticketPrice}</span>}
            </div>
            {show.notes && (
              <div style={{ marginTop: 8, fontSize: 13, color: 'rgba(255,255,255,0.4)', fontStyle: 'italic' }}>
                {show.notes}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className={`badge badge-${show.stage}`}>{show.stage === 'inside' ? 'Inside Stage' : 'Beach Stage'}</span>
            <span className={`badge badge-${show.status || 'pending'}`}>{show.status || 'pending'}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => { setShowForm({ ...BLANK_SHOW, ...show }); setShowModal(true) }}>
              ✏️ Edit
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/email?showId=${id}`)}>
              ✉️ Email
            </button>
          </div>
        </div>
      </div>

      {/* ── Day selector (only shown for multi-night runs) ──────────────── */}
      {siblings.length > 1 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          padding: '10px 14px', marginBottom: 16, borderRadius: 8,
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}>
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.08em', marginRight: 4 }}>
            {siblings.length}-Night Run · Day
          </span>
          {siblings.map((s, idx) => {
            const isActive = s.id === id
            const d = s.date ? new Date(s.date + 'T12:00:00') : null
            return (
              <button
                key={s.id}
                onClick={() => isActive ? null : navigate(`/shows/${s.id}`)}
                style={{
                  padding: '6px 12px', borderRadius: 6, cursor: isActive ? 'default' : 'pointer',
                  border: isActive ? `1px solid ${stageColor}` : '1px solid rgba(255,255,255,0.1)',
                  background: isActive ? `rgba(${stageRgb},0.18)` : 'transparent',
                  color: isActive ? '#fff' : 'rgba(255,255,255,0.65)',
                  fontWeight: isActive ? 600 : 400, fontSize: 13,
                }}
              >
                Night {idx + 1}
                {d && <span style={{ marginLeft: 6, opacity: 0.7, fontSize: 11 }}>
                  · {d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>}
              </button>
            )
          })}
        </div>
      )}

      {/* ── Tabs ─────────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
        {[
          { key: 'advancing', label: '🎸 Advancing' },
          { key: 'schedule',  label: `📋 Day of Show${schedule.length ? ` (${schedule.length})` : ''}` },
          { key: 'labor',     label: `👷 Crew${labor.length ? ` · $${totalLaborCost.toFixed(0)}` : ''}` },
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              padding: '10px 20px', background: 'none', border: 'none',
              borderBottom: activeTab === tab.key ? `2px solid ${stageColor}` : '2px solid transparent',
              color: activeTab === tab.key ? '#fff' : 'rgba(255,255,255,0.45)',
              cursor: 'pointer', fontSize: 14,
              fontWeight: activeTab === tab.key ? 600 : 400,
              transition: 'all 0.15s', marginBottom: -1,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          ADVANCING TAB
      ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'advancing' && (
        <div className="card" style={{ padding: '24px' }}>
          {artistFilled && (
            <div style={{ marginBottom: 18, padding: '10px 14px', borderRadius: 6, border: '1px solid rgba(59,130,246,0.35)', background: 'rgba(59,130,246,0.1)', fontSize: 13, color: '#93c5fd' }}>
              ℹ️ Technical fields were pre-filled from a previous {show.artist || show.eventName} advance — review and update as needed.
            </div>
          )}

          <div className="form-grid">
            <div className="form-row">
              <div className="form-group">
                <label>Advance Contact</label>
                <input value={f.advanceContact} onChange={setAdv('advanceContact')} placeholder="TM / Production contact" />
              </div>
              <div className="form-group">
                <label>Contact Phone</label>
                <input value={f.advancePhone} onChange={setAdv('advancePhone')} />
              </div>
            </div>
            <div className="form-group">
              <label>Advance Contact Email</label>
              <input type="email" value={f.advanceEmail} onChange={setAdv('advanceEmail')} />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Rider Received?</label>
                <select value={f.riderReceived} onChange={setAdv('riderReceived')}>
                  <option value="false">No</option>
                  <option value="true">Yes</option>
                </select>
              </div>
              <div className="form-group">
                <label>Advancing Complete?</label>
                <select value={f.advancingComplete} onChange={setAdv('advancingComplete')}>
                  <option value="false">Open</option>
                  <option value="true">Complete</option>
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Curfew</label>
                <input type="time" value={f.curfew} onChange={setAdv('curfew')} />
              </div>
              <div className="form-group">
                <label>Sound Restrictions</label>
                <input value={f.soundRestrictions} onChange={setAdv('soundRestrictions')} placeholder="e.g. 100 dB limit at FOH" />
              </div>
            </div>
            <div className="form-group">
              <label>Rider Notes</label>
              <textarea rows={3} value={f.riderNotes} onChange={setAdv('riderNotes')} placeholder="Technical rider details…" />
            </div>
            <div className="form-group">
              <label>Production Needs</label>
              <textarea rows={3} value={f.productionNeeds} onChange={setAdv('productionNeeds')} placeholder="Sound, lights, video, staging…" />
            </div>
            <div className="form-group">
              <label>Staging / Capacity Changes</label>
              <textarea rows={2} value={f.stagingChanges} onChange={setAdv('stagingChanges')} placeholder="Any modifications to standard staging…" />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Backline Notes</label>
                <textarea rows={3} value={f.backlineNotes} onChange={setAdv('backlineNotes')} />
              </div>
              <div className="form-group">
                <label>Local Crew Needs</label>
                <textarea rows={3} value={f.localCrewNeeds} onChange={setAdv('localCrewNeeds')} placeholder="Stagehand count, specialties…" />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Catering Notes</label>
                <textarea rows={3} value={f.cateringNotes} onChange={setAdv('cateringNotes')} />
              </div>
              <div className="form-group">
                <label>Hospitality Notes</label>
                <textarea rows={3} value={f.hospitalityNotes} onChange={setAdv('hospitalityNotes')} />
              </div>
            </div>
            <div className="form-group">
              <label>Additional Notes</label>
              <textarea rows={3} value={f.notes} onChange={setAdv('notes')} />
            </div>
          </div>

          <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button className="btn btn-ghost" onClick={() => navigate('/advancing')}>
              Full Advancing View →
            </button>
            <button className="btn btn-primary" onClick={handleSaveAdv} disabled={savingAdv}>
              {savedAdv ? '✅ Saved!' : savingAdv ? 'Saving…' : 'Save Advancing'}
            </button>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          SCHEDULE TAB
      ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'schedule' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            {siblings.length > 1 && (
              <select
                value={copyingFrom}
                onChange={e => handleCopySchedule(e.target.value)}
                style={{
                  padding: '8px 12px', borderRadius: 6, fontSize: 13,
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.12)', color: '#fff',
                }}
              >
                <option value="">📋 Copy schedule from another night…</option>
                {siblings.filter(s => s.id !== id).map((s, idx) => {
                  const nightIdx = siblings.findIndex(x => x.id === s.id) + 1
                  return <option key={s.id} value={s.id}>Night {nightIdx} — {s.date}</option>
                })}
              </select>
            )}
            <button className="btn btn-primary" onClick={openAddSched}>+ Add Item</button>
          </div>
          <div className="card">
            {schedule.length === 0 ? (
              <div className="empty-state">No schedule items yet — click "+ Add Item" to build the day-of-show timeline.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Event / Task</th>
                      <th>Duration</th>
                      <th>Responsible</th>
                      <th>Notes</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedule.map(item => (
                      <tr key={item.id}>
                        <td><strong>{item.time ? formatTime(item.time, tf) : '—'}</strong></td>
                        <td>{item.label || '—'}</td>
                        <td className="text-muted">{item.duration ? `${item.duration} min` : '—'}</td>
                        <td className="text-muted">{item.responsible || '—'}</td>
                        <td className="text-muted" style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.notes || '—'}</td>
                        <td>
                          <div className="actions-cell">
                            <button className="btn btn-ghost btn-sm" onClick={() => openEditSched(item)}>Edit</button>
                            <button className="btn btn-danger btn-sm" onClick={() => handleDeleteSched(item.id)}>Del</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          LABOR TAB
      ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'labor' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            {labor.length > 0 && (
              <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.6)' }}>
                <strong style={{ color: '#fff' }}>{labor.length}</strong> worker{labor.length !== 1 ? 's' : ''} ·{' '}
                Total: <strong style={{ color: '#6ee7b7' }}>${totalLaborCost.toFixed(2)}</strong>
              </div>
            )}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" onClick={openCrewBuilder}>+ Build Crew</button>
              <button className="btn btn-primary" onClick={openAddLabor}>+ Add Worker</button>
            </div>
          </div>
          <div className="card">
            {labor.length === 0 ? (
              <div className="empty-state">No labor entries yet.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Role</th>
                      <th>Name</th>
                      <th>Call</th>
                      <th>Wrap</th>
                      <th>Hours</th>
                      <th>Rate</th>
                      <th>Total</th>
                      <th>Notes</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {labor.map(l => (
                      <tr key={l.id}>
                        <td><strong>{l.role || '—'}</strong></td>
                        <td>{l.workerName || '—'}</td>
                        <td className="text-muted">{l.callTime ? formatTime(l.callTime, tf) : '—'}</td>
                        <td className="text-muted">{l.wrapTime ? formatTime(l.wrapTime, tf) : '—'}</td>
                        <td className="text-muted">{l.hours || '—'}</td>
                        <td className="text-muted">{l.rate ? `$${l.rate}` : '—'}</td>
                        <td><strong style={{ color: '#6ee7b7' }}>{l.total ? `$${l.total}` : '—'}</strong></td>
                        <td className="text-muted" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.notes || '—'}</td>
                        <td>
                          <div className="actions-cell">
                            <button className="btn btn-ghost btn-sm" onClick={() => openEditLabor(l)}>Edit</button>
                            <button className="btn btn-danger btn-sm" onClick={() => handleDeleteLabor(l.id)}>Del</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          SHOW EDIT MODAL
      ══════════════════════════════════════════════════════════════════════ */}
      {showModal && (
        <Modal
          title="Edit Show"
          onClose={() => setShowModal(false)}
          size="modal-lg"
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setShowModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSaveShow} disabled={savingShow}>
                {savingShow ? 'Saving…' : 'Save Show'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div className="form-row">
              <div className="form-group">
                <label>Date *</label>
                <input type="date" value={showForm.date} onChange={e => setShowForm(v => ({ ...v, date: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>Stage *</label>
                <select value={showForm.stage} onChange={e => setShowForm(v => ({ ...v, stage: e.target.value }))}>
                  <option value="inside">Inside Stage</option>
                  <option value="beach">Beach Stage</option>
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Artist Name</label>
                <input value={showForm.artist} onChange={e => setShowForm(v => ({ ...v, artist: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>Event Name</label>
                <input value={showForm.eventName} onChange={e => setShowForm(v => ({ ...v, eventName: e.target.value }))} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Doors Time</label>
                <input type="time" value={showForm.doorsTime} onChange={e => setShowForm(v => ({ ...v, doorsTime: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>Show Time</label>
                <input type="time" value={showForm.showTime} onChange={e => setShowForm(v => ({ ...v, showTime: e.target.value }))} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Capacity</label>
                <input type="number" value={showForm.capacity} onChange={e => setShowForm(v => ({ ...v, capacity: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>Status</label>
                <select value={showForm.status} onChange={e => setShowForm(v => ({ ...v, status: e.target.value }))}>
                  <option value="pending">Pending</option>
                  <option value="advancing">Advancing</option>
                  <option value="confirmed">Confirmed</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Tour Manager</label>
                <input value={showForm.tourManager} onChange={e => setShowForm(v => ({ ...v, tourManager: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>Promoter</label>
                <input value={showForm.promoter} onChange={e => setShowForm(v => ({ ...v, promoter: e.target.value }))} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Ticket Price</label>
                <input value={showForm.ticketPrice} onChange={e => setShowForm(v => ({ ...v, ticketPrice: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>Tickets Sold</label>
                <input type="number" min="0" value={showForm.ticketsSold} onChange={e => setShowForm(v => ({ ...v, ticketsSold: e.target.value }))} placeholder="e.g. 320" />
              </div>
              <div className="form-group">
                <label>Guarantee</label>
                <input value={showForm.guarantee} onChange={e => setShowForm(v => ({ ...v, guarantee: e.target.value }))} />
              </div>
            </div>
            <div className="form-group">
              <label>Notes</label>
              <textarea value={showForm.notes} onChange={e => setShowForm(v => ({ ...v, notes: e.target.value }))} />
            </div>
          </div>
        </Modal>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          SCHEDULE MODAL
      ══════════════════════════════════════════════════════════════════════ */}
      {schedModal && (
        <Modal
          title={schedEditing ? 'Edit Schedule Item' : 'Add Schedule Item'}
          onClose={() => setSchedModal(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setSchedModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSaveSched} disabled={savingSched}>
                {savingSched ? 'Saving…' : 'Save'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div className="form-row">
              <div className="form-group">
                <label>Time</label>
                <input type="time" value={schedForm.time} onChange={setS('time')} />
              </div>
              <div className="form-group">
                <label>Duration (min)</label>
                <input type="number" value={schedForm.duration} onChange={setS('duration')} placeholder="e.g. 90" />
              </div>
            </div>
            <div className="form-group">
              <label>Event / Task</label>
              <input value={schedForm.label} onChange={setS('label')} placeholder="Load-in, Soundcheck, Doors open, Set, Load-out…" />
            </div>
            <div className="form-group">
              <label>Responsible</label>
              <input value={schedForm.responsible} onChange={setS('responsible')} placeholder="Stage Manager, Audio, etc." />
            </div>
            <div className="form-group">
              <label>Notes</label>
              <textarea value={schedForm.notes} onChange={setS('notes')} />
            </div>
          </div>
        </Modal>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          LABOR MODAL
      ══════════════════════════════════════════════════════════════════════ */}
      {laborModal && (
        <Modal
          title={laborEditing ? 'Edit Labor Entry' : 'Add Worker'}
          onClose={() => setLaborModal(false)}
          size="modal-lg"
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setLaborModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSaveLabor} disabled={savingLabor}>
                {savingLabor ? 'Saving…' : 'Save'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div className="form-group">
              <label>Worker *</label>
              <select value={laborForm.staffId || ''} onChange={e => pickLaborStaff(e.target.value)}>
                <option value="">— Select worker —</option>
                {staff.filter(s => s.active !== 'false')
                  .slice()
                  .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
                  .map(s => (
                    <option key={s.id} value={s.id}>{s.name}{s.role ? ` — ${s.role}` : ''}</option>
                  ))}
                <option value="__new__">+ Add new worker…</option>
              </select>
              {showLaborQuickAdd && (
                <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    autoFocus
                    value={quickAddName}
                    onChange={e => setQuickAddName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); quickAddLaborWorker() } }}
                    placeholder="New worker name"
                    style={{ flex: '1 1 200px' }}
                  />
                  <button type="button" className="btn btn-primary btn-sm" onClick={quickAddLaborWorker} disabled={quickAddBusy}>
                    {quickAddBusy ? 'Adding…' : 'Add'}
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setLaborForm(v => ({ ...v, staffId: '' })); setQuickAddError('') }}>
                    Cancel
                  </button>
                  {quickAddError && <span style={{ color: '#dc2626', fontSize: 12, width: '100%' }}>{quickAddError}</span>}
                </div>
              )}
            </div>
            {selectedLaborRates.length > 1 && (
              <div className="form-group">
                <label>Position (rate)</label>
                <select onChange={e => pickLaborStaffPosition(e.target.value)} defaultValue="">
                  <option value="">— Pick a position rate —</option>
                  {selectedLaborRates.map((r, i) => (
                    <option key={i} value={i}>
                      {r.role || '(unnamed)'} — ${r.rate || '0.00'}{r.payType === 'day' ? '/day' : '/hr'}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="form-row">
              <div className="form-group">
                <label>Role</label>
                <input value={laborForm.role} onChange={setL('role')} placeholder="Audio Engineer, Stage Manager…" />
              </div>
              <div className="form-group">
                <label>Name (override)</label>
                <input value={laborForm.workerName} onChange={setL('workerName')} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Call Time</label>
                <input type="time" value={laborForm.callTime} onChange={setL('callTime')} />
              </div>
              <div className="form-group">
                <label>Wrap Time</label>
                <input type="time" value={laborForm.wrapTime} onChange={setL('wrapTime')} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Hours</label>
                <input type="number" step="0.5" value={laborForm.hours}
                  onChange={e => setLaborForm(v => ({ ...v, hours: e.target.value, total: calcTotal(e.target.value, v.rate) }))} />
              </div>
              <div className="form-group">
                <label>Rate ($/hr)</label>
                <input type="number" step="0.01" value={laborForm.rate}
                  onChange={e => setLaborForm(v => ({ ...v, rate: e.target.value, total: calcTotal(v.hours, e.target.value) }))} />
              </div>
              <div className="form-group">
                <label>Total</label>
                <input value={laborForm.total ? `$${laborForm.total}` : ''} readOnly style={{ opacity: 0.6 }} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Union?</label>
                <select value={laborForm.union} onChange={setL('union')}>
                  <option value="false">No</option>
                  <option value="true">Yes</option>
                </select>
              </div>
              <div className="form-group">
                <label>Notes</label>
                <input value={laborForm.notes} onChange={setL('notes')} />
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          BUILD CREW (bulk) MODAL — scoped to this show
      ══════════════════════════════════════════════════════════════════════ */}
      {crewModal && (
        <Modal
          title={`Build Crew — ${show?.date || ''} ${show?.artist || show?.eventName || ''}`}
          onClose={() => setCrewModal(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setCrewModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleCrewSave} disabled={crewSaving}>
                {crewSaving ? 'Saving…' : `Save ${crewRows.filter(r => r.staffId && r.staffId !== '__new__').length} entries`}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div style={{ display: 'flex', gap: 8, margin: '4px 0 8px', flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCrewRows(r => [...r, makeCrewRow('House Crew')])}>+ House Crew row</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCrewRows(r => [...r, makeCrewRow('Stagehand')])}>+ Stagehand row</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCrewRows(r => [...r, makeCrewRow('')])}>+ Custom row</button>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    <th style={{ padding: '6px 4px', minWidth: 180 }}>Worker</th>
                    <th style={{ padding: '6px 4px', minWidth: 130 }}>Position</th>
                    <th style={{ padding: '6px 4px', width: 90 }}>Call</th>
                    <th style={{ padding: '6px 4px', width: 90 }}>Wrap</th>
                    <th style={{ padding: '6px 4px', width: 80 }}>Type</th>
                    <th style={{ padding: '6px 4px', width: 75 }}>Units</th>
                    <th style={{ padding: '6px 4px', width: 90 }}>Rate $</th>
                    <th style={{ padding: '6px 4px', width: 32 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {crewRows.map(r => (
                    <tr key={r._rid} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '6px 4px', verticalAlign: 'top' }}>
                        <select value={r.staffId || ''} onChange={e => pickCrewWorker(r._rid, e.target.value)} style={{ width: '100%' }}>
                          <option value="">— Select —</option>
                          {staff.filter(s => s.active !== 'false')
                            .slice()
                            .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
                            .map(s => (
                              <option key={s.id} value={s.id}>{s.name}{s.role ? ` — ${s.role}` : ''}</option>
                            ))}
                          <option value="__new__">+ Add new worker…</option>
                        </select>
                        {crewQuickRow === r._rid && (
                          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                            <input
                              autoFocus
                              value={crewQuickName}
                              onChange={e => setCrewQuickName(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitCrewQuickAdd() } }}
                              placeholder="New worker name"
                              style={{ flex: 1, fontSize: 12 }}
                            />
                            <button type="button" className="btn btn-primary btn-sm" onClick={commitCrewQuickAdd} disabled={crewQuickBusy} style={{ padding: '2px 8px' }}>
                              {crewQuickBusy ? '…' : 'Add'}
                            </button>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setCrewQuickRow(null); updateCrewRow(r._rid, { staffId: '' }) }} style={{ padding: '2px 6px' }}>✕</button>
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '6px 4px', verticalAlign: 'top' }}>
                        <input value={r.role} onChange={e => updateCrewRow(r._rid, { role: e.target.value })} style={{ width: '100%' }} placeholder="Position" />
                      </td>
                      <td style={{ padding: '6px 4px', verticalAlign: 'top' }}>
                        <input type="time" value={r.callTime} onChange={e => updateCrewRow(r._rid, { callTime: e.target.value })} style={{ width: '100%' }} />
                      </td>
                      <td style={{ padding: '6px 4px', verticalAlign: 'top' }}>
                        <input type="time" value={r.wrapTime} onChange={e => updateCrewRow(r._rid, { wrapTime: e.target.value })} style={{ width: '100%' }} />
                      </td>
                      <td style={{ padding: '6px 4px', verticalAlign: 'top' }}>
                        <select value={r.payType} onChange={e => updateCrewRow(r._rid, { payType: e.target.value })} style={{ width: '100%' }}>
                          <option value="hour">Hour</option>
                          <option value="day">Day</option>
                        </select>
                      </td>
                      <td style={{ padding: '6px 4px', verticalAlign: 'top' }}>
                        {r.payType === 'day'
                          ? <input type="number" step="0.5" value={r.days} onChange={e => updateCrewRow(r._rid, { days: e.target.value })} style={{ width: '100%' }} placeholder="1" />
                          : <input type="number" step="0.5" value={r.hours} onChange={e => updateCrewRow(r._rid, { hours: e.target.value })} style={{ width: '100%' }} placeholder="0" />
                        }
                      </td>
                      <td style={{ padding: '6px 4px', verticalAlign: 'top' }}>
                        <input type="number" step="0.01" value={r.rate} onChange={e => updateCrewRow(r._rid, { rate: e.target.value })} style={{ width: '100%' }} placeholder="0" />
                      </td>
                      <td style={{ padding: '6px 4px', verticalAlign: 'top', textAlign: 'center' }}>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCrewRows(rows => rows.filter(x => x._rid !== r._rid))} style={{ padding: '2px 6px' }} title="Remove row">✕</button>
                      </td>
                    </tr>
                  ))}
                  {crewRows.length === 0 && (
                    <tr><td colSpan={8}><div className="empty-state" style={{ padding: 20 }}>No rows. Use the buttons above to add some.</div></td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
              Tip: Rates auto-fill from each worker's saved Staff rate. Override any field per row before saving.
            </div>
          </div>
        </Modal>
      )}

    </div>
  )
}
