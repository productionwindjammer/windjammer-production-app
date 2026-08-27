import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import api from '../api'
import Modal from '../components/Modal'
import { useAuth } from '../context/AuthContext'
import { formatTime, byTime } from '../utils/time'

// Roles allowed to add/edit/delete items on the event schedule.
const EDIT_ROLES = ['admin', 'production_manager', 'venue_management', 'promoter']

const CATEGORIES = [
  'Load-in', 'Setup', 'Sound Check', 'Line Check', 'Doors',
  'Set', 'Break', 'Encore', 'Load-out', 'Meal', 'Meeting', 'Other',
]

const CATEGORY_COLOR = {
  'Load-in':     '#2563eb',
  'Setup':       '#2563eb',
  'Sound Check': '#0891b2',
  'Line Check':  '#0891b2',
  'Doors':       '#059669',
  'Set':         '#7c3aed',
  'Break':       '#6b7280',
  'Encore':      '#7c3aed',
  'Load-out':    '#d97706',
  'Meal':        '#059669',
  'Meeting':     '#4b5563',
  'Other':       '#6b7280',
}

const BLANK_ITEM = {
  date: '', time: '', label: '',
  eventType: 'Set', stage: '', showId: '', notes: '',
}

function parseDate(s) { return s ? new Date(s + 'T12:00:00') : null }
function fmtDay(s) {
  const d = parseDate(s); if (!d) return '—'
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

export default function EventSchedule() {
  const navigate = useNavigate()
  const { id: eventId } = useParams()
  const { user, effectiveRole } = useAuth()
  const role = effectiveRole || user?.role || ''
  const canEdit = EDIT_ROLES.includes(role)

  const [event, setEvent]     = useState(null)
  const [shows, setShows]     = useState([])
  const [items, setItems]     = useState([])
  const [loading, setLoading] = useState(true)

  const [filterDay,      setFilterDay]      = useState('')
  const [filterShow,     setFilterShow]     = useState('')
  const [filterCategory, setFilterCategory] = useState('')

  const [modal, setModal]     = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm]       = useState(BLANK_ITEM)
  const [saving, setSaving]   = useState(false)

  useEffect(() => { load() }, [eventId])

  async function load() {
    setLoading(true)
    try {
      const res = await api.get(`/events/${eventId}/schedule`)
      const d = res.data.data || {}
      setEvent(d.event || null)
      setShows((d.shows || []).sort((a, b) => (a.date || '').localeCompare(b.date || '')))
      setItems(d.items || [])
    } catch (err) {
      alert(err?.response?.data?.message || err.message || 'Failed to load schedule')
    } finally { setLoading(false) }
  }

  const days = useMemo(() => {
    const set = new Set()
    for (const s of shows) if (s.date) set.add(s.date)
    for (const i of items) if (i.date) set.add(i.date)
    if (event?.startDate) set.add(event.startDate)
    if (event?.endDate)   set.add(event.endDate)
    return [...set].sort()
  }, [shows, items, event])

  const filtered = useMemo(() => {
    return items.filter(it => {
      if (filterDay      && it.date       !== filterDay)      return false
      if (filterShow === '__event__' && it.showId)            return false
      if (filterShow && filterShow !== '__event__' && String(it.showId || '') !== filterShow) return false
      if (filterCategory && (it.eventType || '') !== filterCategory) return false
      return true
    })
  }, [items, filterDay, filterShow, filterCategory])

  const grouped = useMemo(() => {
    const map = new Map()
    for (const it of filtered) {
      const key = it.date || '—'
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(it)
    }
    for (const arr of map.values()) arr.sort(byTime)
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [filtered])

  const showById = useMemo(() => new Map(shows.map(s => [String(s.id), s])), [shows])

  function openAdd(preset = {}) {
    setEditing(null)
    setForm({
      ...BLANK_ITEM,
      date: filterDay || event?.startDate || days[0] || '',
      showId: filterShow && filterShow !== '__event__' ? filterShow : '',
      ...preset,
    })
    setModal(true)
  }
  function openEdit(it) {
    setEditing(it)
    setForm({
      date:      it.date || '',
      time:      it.time || '',
      label:     it.label || '',
      eventType: it.eventType || 'Other',
      stage:     it.stage || '',
      showId:    it.showId ? String(it.showId) : '',
      notes:     it.notes || '',
    })
    setModal(true)
  }

  async function handleSave() {
    if (!form.label?.trim()) { alert('Label is required'); return }
    if (!form.date)          { alert('Date is required');  return }
    setSaving(true)
    try {
      const showRow = form.showId ? showById.get(String(form.showId)) : null
      const payload = {
        date:      form.date,
        time:      form.time || '',
        label:     form.label.trim(),
        eventType: form.eventType || 'Other',
        stage:     form.stage || showRow?.stage || '',
        showId:    form.showId || '',
        showName:  showRow ? (showRow.artist || showRow.eventName || '') : (event?.name || ''),
        notes:     form.notes || '',
        eventId:   eventId,
        duration:  '',
        responsible: '',
      }
      if (editing) {
        await api.put(`/schedule/${editing.id}`, payload)
      } else {
        await api.post('/schedule', payload)
      }
      await load()
      setModal(false)
    } catch (err) {
      alert(err?.response?.data?.message || err.message || 'Save failed')
    } finally { setSaving(false) }
  }

  async function handleDelete(it) {
    if (!confirm(`Delete "${it.label}"?`)) return
    try {
      await api.delete(`/schedule/${it.id}`)
      await load()
    } catch (err) {
      alert(err?.response?.data?.message || err.message || 'Delete failed')
    }
  }

  if (loading) return <div className="loading">Loading schedule…</div>
  if (!event)  return <div className="loading">Event not found.</div>

  return (
    <div>
      <div className="page-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/events')}>← Events</button>
            <div className="page-title" style={{ margin: 0 }}>{event.name} — Schedule</div>
          </div>
          <div className="page-subtitle">
            {shows.length} show{shows.length === 1 ? '' : 's'} · {items.length} scheduled item{items.length === 1 ? '' : 's'}
          </div>
        </div>
        {canEdit && <button className="btn btn-primary" onClick={() => openAdd()}>+ Add Item</button>}
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              className={`btn btn-sm ${filterDay === '' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setFilterDay('')}
            >All Days</button>
            {days.map(d => (
              <button
                key={d}
                className={`btn btn-sm ${filterDay === d ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setFilterDay(d)}
              >{fmtDay(d)}</button>
            ))}
          </div>
          <div style={{ flex: 1 }} />
          <select value={filterShow} onChange={e => setFilterShow(e.target.value)}>
            <option value="">All shows</option>
            <option value="__event__">Event-wide only</option>
            {shows.map(s => (
              <option key={s.id} value={String(s.id)}>
                {s.date || '—'} · {s.artist || s.eventName || 'Untitled'}
              </option>
            ))}
          </select>
          <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
            <option value="">All categories</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      {grouped.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            No schedule items yet. {canEdit
              ? 'Click "+ Add Item" to start building the run of show.'
              : 'The production team hasn\'t added any items yet.'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          {grouped.map(([day, list]) => (
            <div key={day} className="card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <h3 style={{ margin: 0 }}>{fmtDay(day)}</h3>
                <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{day !== '—' ? day : ''}</span>
                <span style={{ flex: 1 }} />
                {canEdit && (
                  <button className="btn btn-ghost btn-sm" onClick={() => openAdd({ date: day === '—' ? '' : day })}>
                    + Item on this day
                  </button>
                )}
              </div>
              <div style={{ display: 'grid', gap: 6 }}>
                {list.map(it => {
                  const show = it.showId ? showById.get(String(it.showId)) : null
                  const cat  = it.eventType || 'Other'
                  const color = CATEGORY_COLOR[cat] || '#6b7280'
                  return (
                    <div
                      key={it.id}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '80px 4px 1fr auto',
                        gap: 12, alignItems: 'center',
                        padding: '10px 12px',
                        background: 'var(--bg-card)',
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                      }}
                    >
                      <div style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, fontSize: 14 }}>
                        {it.time ? formatTime(it.time, '12h') : '—'}
                      </div>
                      <div style={{ background: color, height: '100%', borderRadius: 2, minHeight: 32 }} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <strong style={{ fontSize: 14 }}>{it.label || 'Untitled'}</strong>
                          <span
                            className="badge"
                            style={{ background: `${color}22`, color, border: `1px solid ${color}55` }}
                          >{cat}</span>
                          {show ? (
                            <span className="badge" style={{ background: 'rgba(124,58,237,0.15)', color: '#c4b5fd', border: '1px solid rgba(124,58,237,0.35)' }}>
                              🎤 {show.artist || show.eventName || 'Show'}
                            </span>
                          ) : (
                            <span className="badge" style={{ background: 'rgba(127,127,127,0.18)', color: 'var(--text-muted)', border: '1px solid rgba(127,127,127,0.35)' }}>
                              Event-wide
                            </span>
                          )}
                          {it.stage && (
                            <span className={`badge badge-${it.stage}`}>{it.stage === 'inside' ? 'Inside' : it.stage === 'beach' ? 'Beach' : it.stage}</span>
                          )}
                        </div>
                        {it.notes && (
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, whiteSpace: 'pre-wrap' }}>
                            {it.notes}
                          </div>
                        )}
                      </div>
                      {canEdit && (
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button className="btn btn-ghost btn-sm" onClick={() => openEdit(it)}>Edit</button>
                          <button className="btn btn-danger btn-sm" onClick={() => handleDelete(it)}>Del</button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && (
        <Modal
          title={editing ? 'Edit Schedule Item' : 'New Schedule Item'}
          onClose={() => setModal(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save Item'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div className="form-row">
              <div className="form-group">
                <label>Date *</label>
                <input
                  type="date"
                  value={form.date}
                  onChange={e => setForm(v => ({ ...v, date: e.target.value }))}
                />
              </div>
              <div className="form-group">
                <label>Time</label>
                <input
                  type="time"
                  value={form.time}
                  onChange={e => setForm(v => ({ ...v, time: e.target.value }))}
                />
              </div>
            </div>
            <div className="form-group">
              <label>Label *</label>
              <input
                value={form.label}
                onChange={e => setForm(v => ({ ...v, label: e.target.value }))}
                placeholder='e.g. "Support A load-in", "Gates open", "Headliner set"'
                autoFocus
              />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Category</label>
                <select
                  value={form.eventType}
                  onChange={e => setForm(v => ({ ...v, eventType: e.target.value }))}
                >
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>Location / Stage</label>
                <select
                  value={form.stage}
                  onChange={e => setForm(v => ({ ...v, stage: e.target.value }))}
                >
                  <option value="">— none —</option>
                  <option value="inside">Inside Stage</option>
                  <option value="beach">Beach Stage</option>
                  <option value="backstage">Backstage</option>
                  <option value="green_room">Green Room</option>
                  <option value="office">Office</option>
                </select>
              </div>
            </div>
            <div className="form-group">
              <label>Link to Show (optional)</label>
              <select
                value={form.showId}
                onChange={e => setForm(v => ({ ...v, showId: e.target.value }))}
              >
                <option value="">— event-wide (not tied to a specific show) —</option>
                {shows.map(s => (
                  <option key={s.id} value={String(s.id)}>
                    {s.date || '—'} · {s.artist || s.eventName || 'Untitled'} ({s.stage || 'inside'})
                  </option>
                ))}
              </select>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                Leave blank for items that apply to the whole event (gates, meals, meetings).
              </div>
            </div>
            <div className="form-group">
              <label>Notes</label>
              <textarea
                rows={3}
                value={form.notes}
                onChange={e => setForm(v => ({ ...v, notes: e.target.value }))}
                placeholder="Optional details, contacts, contingencies."
              />
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
