import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api'
import Modal from '../components/Modal'
import { useSettings } from '../context/SettingsContext'
import { useAuth } from '../context/AuthContext'
import { formatTime } from '../utils/time'

const DEFAULT_PROMOTER = 'Scottie Frier'

const BLANK = {
  date: '', artist: '', eventName: '', stage: 'inside', status: 'pending',
  showTime: '', doorsTime: '', capacity: '', ticketPrice: '', support: '',
  promoter: DEFAULT_PROMOTER, tourManager: '', notes: ''
}

export default function Shows() {
  const { settings } = useSettings()
  const { user, effectiveRole } = useAuth()
  const role = effectiveRole || user?.role || ''
  const canSeeLaborCost = ['admin', 'production_manager', 'venue_management'].includes(role)
  const tf = settings.timeFormat || '12h'
  const navigate = useNavigate()
  const [shows, setShows]       = useState([])
  const [labor, setLabor]       = useState([])
  const [loading, setLoading]   = useState(true)
  const [modal, setModal]       = useState(false)
  const [editing, setEditing]   = useState(null)
  const [form, setForm]         = useState(BLANK)
  const [filter, setFilter]     = useState({ stage: '', status: '', search: '' })
  const [showPast, setShowPast] = useState(false)
  const [saving, setSaving]     = useState(false)
  const [supportActs, setSupportActs] = useState([])
  const [additionalDates, setAdditionalDates] = useState([])
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const requests = [api.get('/shows')]
      if (canSeeLaborCost) requests.push(api.get('/labor'))
      const results = await Promise.all(requests)
      setShows((results[0].data.data || []).sort((a, b) => new Date(a.date) - new Date(b.date)))
      if (results[1]) setLabor(results[1].data.data || [])
    } finally { setLoading(false) }
  }

  function parseSupport(str) {
    return String(str || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  }

  function openAdd() {
    setEditing(null)
    setForm(BLANK)
    setSupportActs([])
    setAdditionalDates([])
    setModal(true)
  }
  function openEdit(s) {
    setEditing(s)
    setForm({ ...BLANK, ...s, promoter: s.promoter || DEFAULT_PROMOTER })
    setSupportActs(parseSupport(s.support))
    setAdditionalDates([])
    setModal(true)
  }

  async function handleSave() {
    setSaving(true)
    try {
      const primarySupport = supportActs.map(s => s.trim()).filter(Boolean).join(', ')
      const payload = { ...form, support: primarySupport }
      if (editing) {
        await api.put(`/shows/${editing.id}`, payload)
      } else {
        // Primary night first, then any additional nights sharing artist/stage/etc.
        // Each extra night can override the support list (empty = inherit primary).
        await api.post('/shows', payload)
        const seen = new Set([payload.date])
        for (const extra of additionalDates) {
          const d = String(extra.date || '').trim()
          if (!d || seen.has(d)) continue
          seen.add(d)
          const nightSupport = String(extra.support || '').trim()
          await api.post('/shows', {
            ...payload,
            date: d,
            support: nightSupport || primarySupport,
          })
        }
      }
      await load()
      setModal(false)
    } finally { setSaving(false) }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this show?')) return
    await api.delete(`/shows/${id}`)
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    await load()
  }

  function toggleRow(id) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllVisible(ids, allChecked) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (allChecked) ids.forEach(id => next.delete(id))
      else ids.forEach(id => next.add(id))
      return next
    })
  }

  async function handleBulkDelete() {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    if (!confirm(`Delete ${ids.length} show${ids.length !== 1 ? 's' : ''}? This cannot be undone.`)) return
    setBulkDeleting(true)
    try {
      const results = await Promise.allSettled(ids.map(id => api.delete(`/shows/${id}`)))
      const failed = results.filter(r => r.status === 'rejected').length
      if (failed > 0) alert(`${failed} of ${ids.length} deletions failed.`)
      setSelectedIds(new Set())
      await load()
    } finally {
      setBulkDeleting(false)
    }
  }

  const f = form
  const set = k => e => setForm(v => ({ ...v, [k]: e.target.value }))

  const normalizeTitle = t =>
    t.replace(/\s*[-–]\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*/i, '')
     .replace(/\s*\((monday|tuesday|wednesday|thursday|friday|saturday|sunday)\)\s*$/i, '')
     .trim().toLowerCase()

  const laborCostByShow = useMemo(() => {
    const m = new Map()
    for (const l of labor) {
      const id = l.showId
      if (!id) continue
      const rate = parseFloat(l.rate || 0) || 0
      let amt = 0
      if ((l.payType || 'day') === 'day') amt = (parseFloat(l.days || 0) || 0) * rate
      else                                amt = (parseFloat(l.hours || 0) || 0) * rate
      m.set(id, (m.get(id) || 0) + amt)
    }
    return m
  }, [labor])

  const filtered = (() => {
    // Local-midnight start of today, so a show dated today is still visible.
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
    const sorted = shows.filter(s => {
      if (!showPast && s.date) {
        const d = new Date(s.date + 'T12:00:00')
        if (!isNaN(d) && d < todayStart) return false
      }
      if (filter.stage && s.stage !== filter.stage) return false
      if (filter.status && s.status !== filter.status) return false
      if (filter.search) {
        const q = filter.search.toLowerCase()
        return (s.artist || s.eventName || '').toLowerCase().includes(q)
      }
      return true
    }).sort((a, b) => new Date(a.date) - new Date(b.date))
    const seen = new Set()
    return sorted.filter(s => {
      const key = normalizeTitle(s.artist || s.eventName || '')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  })()

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Shows</div>
          <div className="page-subtitle">All concerts and private events</div>
        </div>
        <div style={{display:'flex',gap:8}}>
          {selectedIds.size > 0 && (
            <button
              className="btn btn-danger"
              onClick={handleBulkDelete}
              disabled={bulkDeleting}
            >
              {bulkDeleting ? 'Deleting…' : `Delete ${selectedIds.size} Selected`}
            </button>
          )}
          <button className="btn btn-primary" onClick={openAdd}>+ Add Show</button>
        </div>
      </div>

      <div className="filter-bar">
        <input
          placeholder="Search artist or event…"
          value={filter.search}
          onChange={e => setFilter(f => ({ ...f, search: e.target.value }))}
        />
        <select value={filter.stage} onChange={e => setFilter(f => ({ ...f, stage: e.target.value }))}>
          <option value="">All Stages</option>
          <option value="inside">Inside Stage</option>
          <option value="beach">Beach Stage</option>
        </select>
        <select value={filter.status} onChange={e => setFilter(f => ({ ...f, status: e.target.value }))}>
          <option value="">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="advancing">Advancing</option>
          <option value="confirmed">Confirmed</option>
          <option value="cancelled">Cancelled</option>
          <option value="settled">Settled</option>
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'rgba(255,255,255,0.7)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={showPast} onChange={e => setShowPast(e.target.checked)} />
          Show all (incl. past)
        </label>
      </div>

      <div className="card">
        {loading ? <div className="loading">Loading…</div> : (() => {
          const visibleIds = filtered.map(s => s.id)
          const allChecked = visibleIds.length > 0 && visibleIds.every(id => selectedIds.has(id))
          const someChecked = !allChecked && visibleIds.some(id => selectedIds.has(id))
          return (
          <div className="table-wrap responsive-cards">
            <table>
              <thead>
                <tr>
                  <th style={{width:32}}>
                    <input
                      type="checkbox"
                      checked={allChecked}
                      ref={el => { if (el) el.indeterminate = someChecked }}
                      onChange={() => toggleAllVisible(visibleIds, allChecked)}
                      title={allChecked ? 'Deselect all' : 'Select all'}
                      style={{cursor:'pointer'}}
                    />
                  </th>
                  <th>Date</th>
                  <th>Artist / Event</th>
                  <th>Stage</th>
                  <th>Show Time</th>
                  <th>Capacity</th>
                  <th>Status</th>
                  <th>Tour Manager</th>
                  {canSeeLaborCost && <th>Labor Cost</th>}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={canSeeLaborCost ? 10 : 9}><div className="empty-state">No shows found</div></td></tr>
                )}
                {filtered.map(show => {
                  const isSelected = selectedIds.has(show.id)
                  return (
                  <tr
                    key={show.id}
                    style={{ cursor: 'pointer', background: isSelected ? 'rgba(59,130,246,0.08)' : undefined }}
                    onClick={() => navigate(`/shows/${show.id}`)}
                  >
                    <td data-label="" onClick={e => { e.stopPropagation(); toggleRow(show.id) }} style={{width:32}}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {}}
                        style={{cursor:'pointer'}}
                      />
                    </td>
                    <td data-label="Date" className="text-muted">{show.date}</td>
                    <td data-label="Artist"><strong>{show.artist || show.eventName || '—'}</strong></td>
                    <td data-label="Stage"><span className={`badge badge-${show.stage}`}>{show.stage === 'inside' ? 'Inside' : 'Beach'}</span></td>
                    <td data-label="Show Time" className="text-muted">{show.showTime ? formatTime(show.showTime, tf) : '—'}</td>
                    <td data-label="Capacity" className="text-muted">{show.capacity || '—'}</td>
                    <td data-label="Status"><span className={`badge badge-${show.status || 'pending'}`}>{show.status || 'pending'}</span></td>
                    <td data-label="Tour Manager" className="text-muted">{show.tourManager || '—'}</td>
                    {canSeeLaborCost && (() => {
                      const cost = laborCostByShow.get(show.id) || 0
                      return (
                        <td data-label="Labor Cost" style={{fontWeight:600,color: cost > 0 ? '#16a34a' : 'var(--text-muted)'}}>
                          {cost > 0 ? `$${cost.toLocaleString(undefined, {minimumFractionDigits:0, maximumFractionDigits:0})}` : '—'}
                        </td>
                      )
                    })()}
                      <td data-label="Actions" onClick={e => e.stopPropagation()}>
                      <div className="actions-cell">
                        <button className="btn btn-ghost btn-sm" onClick={() => openEdit(show)}>Edit</button>
                        <button className="btn btn-danger btn-sm" onClick={() => handleDelete(show.id)}>Del</button>
                      </div>
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          )
        })()}
      </div>

      {modal && (
        <Modal
          title={editing ? 'Edit Show' : 'Add Show'}
          onClose={() => setModal(false)}
          size="modal-lg"
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save Show'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div className="form-row">
              <div className="form-group">
                <label>Date *</label>
                <input type="date" value={f.date} onChange={set('date')} required />
                {!editing && additionalDates.map((extra, i) => (
                  <div key={i} style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        type="date"
                        value={extra.date}
                        onChange={e => {
                          const v = e.target.value
                          setAdditionalDates(arr => arr.map((x, j) => (j === i ? { ...x, date: v } : x)))
                        }}
                        style={{ flex: 1 }}
                      />
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setAdditionalDates(arr => arr.filter((_, j) => j !== i))}
                        title="Remove this night"
                      >×</button>
                    </div>
                    <input
                      value={extra.support}
                      onChange={e => {
                        const v = e.target.value
                        setAdditionalDates(arr => arr.map((x, j) => (j === i ? { ...x, support: v } : x)))
                      }}
                      placeholder="Support acts (comma-separated) — leave blank to match Night 1"
                      style={{ fontSize: 12 }}
                    />
                  </div>
                ))}
                {!editing && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ marginTop: 6, alignSelf: 'flex-start' }}
                    onClick={() => {
                      setAdditionalDates(arr => {
                        // Default new date to day after latest known date
                        const all = [f.date, ...arr.map(x => x.date)].filter(Boolean).sort()
                        const last = all[all.length - 1]
                        let next = ''
                        if (last) {
                          const dt = new Date(last + 'T12:00:00')
                          dt.setDate(dt.getDate() + 1)
                          next = dt.toISOString().slice(0, 10)
                        }
                        return [...arr, { date: next, support: '' }]
                      })
                    }}
                  >+ Add another night</button>
                )}
                {!editing && additionalDates.length > 0 && (
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginTop: 6 }}>
                    Creates {additionalDates.filter(x => x.date).length + 1} separate shows sharing artist, stage, and defaults. Each night can be edited independently afterward.
                  </div>
                )}
              </div>
              <div className="form-group">
                <label>Stage *</label>
                <select value={f.stage} onChange={set('stage')}>
                  <option value="inside">Inside Stage</option>
                  <option value="beach">Beach Stage</option>
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Headlining Artist</label>
                <input value={f.artist} onChange={set('artist')} placeholder="Headliner name" />
                {supportActs.map((name, i) => (
                  <div key={i} style={{ display:'flex', gap:6, marginTop:6 }}>
                    <input
                      value={name}
                      onChange={e => {
                        const v = e.target.value
                        setSupportActs(arr => arr.map((x, j) => (j === i ? v : x)))
                      }}
                      placeholder={`Support act ${i + 1}`}
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setSupportActs(arr => arr.filter((_, j) => j !== i))}
                      title="Remove support act"
                    >×</button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ marginTop: 6, alignSelf: 'flex-start' }}
                  onClick={() => setSupportActs(arr => [...arr, ''])}
                >+ Add support act</button>
              </div>
              <div className="form-group">
                <label>Event Name</label>
                <input value={f.eventName} onChange={set('eventName')} placeholder="Private event name" />
              </div>
            </div>
            <div className="form-row-3">
              <div className="form-group">
                <label>Doors Time</label>
                <input type="time" value={f.doorsTime} onChange={set('doorsTime')} />
              </div>
              <div className="form-group">
                <label>Show Time</label>
                <input type="time" value={f.showTime} onChange={set('showTime')} />
              </div>
              <div className="form-group">
                <label>Status</label>
                <select value={f.status} onChange={set('status')}>
                  <option value="pending">Pending</option>
                  <option value="advancing">Advancing</option>
                  <option value="confirmed">Confirmed</option>
                  <option value="cancelled">Cancelled</option>
                  <option value="settled">Settled</option>
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Capacity</label>
                <input type="number" value={f.capacity} onChange={set('capacity')} placeholder="Max attendance" />
              </div>
              <div className="form-group">
                <label>Ticket Price</label>
                <input value={f.ticketPrice} onChange={set('ticketPrice')} placeholder="$0.00" />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Promoter</label>
                <input value={f.promoter} onChange={set('promoter')} placeholder="Promoter name" />
              </div>
              <div className="form-group">
                <label>Tour Manager</label>
                <input value={f.tourManager} onChange={set('tourManager')} placeholder="TM name and contact" />
              </div>
            </div>
            <div className="form-group">
              <label>Notes</label>
              <textarea value={f.notes} onChange={set('notes')} placeholder="Additional notes…" />
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
