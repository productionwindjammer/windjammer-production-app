import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api'
import Modal from '../components/Modal'
import { useAuth } from '../context/AuthContext'

const BLANK_EVENT = {
  name: '', description: '', startDate: '', endDate: '', color: '#7c3aed', notes: '',
}

const PRESET_COLORS = ['#7c3aed', '#2563eb', '#059669', '#d97706', '#dc2626', '#db2777', '#0891b2', '#4b5563']

function parseDate(s) { return s ? new Date(s + 'T12:00:00') : null }
function fmtRange(start, end) {
  const a = parseDate(start), b = parseDate(end)
  if (!a && !b) return '—'
  const fmt = d => d?.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  if (!b || (a && b && a.getTime() === b.getTime())) return fmt(a)
  return `${a?.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${fmt(b)}`
}

export default function Events() {
  const navigate = useNavigate()
  const { user, effectiveRole } = useAuth()
  const role = effectiveRole || user?.role || ''
  const canEdit = ['admin', 'production_manager'].includes(role)

  const [events, setEvents]   = useState([])
  const [shows, setShows]     = useState([])
  const [loading, setLoading] = useState(true)

  const [modal, setModal]     = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm]       = useState(BLANK_EVENT)
  const [saving, setSaving]   = useState(false)

  const [attachModal, setAttachModal] = useState(null) // event being attached to
  const [attachIds, setAttachIds]     = useState(new Set())
  const [attaching, setAttaching]     = useState(false)

  useEffect(() => { load() }, [])
  async function load() {
    setLoading(true)
    try {
      const [eRes, sRes] = await Promise.all([api.get('/events'), api.get('/shows')])
      setEvents((eRes.data.data || []).sort((a, b) => (a.startDate || '').localeCompare(b.startDate || '')))
      setShows(sRes.data.data || [])
    } finally { setLoading(false) }
  }

  const showsByEvent = useMemo(() => {
    const m = new Map()
    for (const s of shows) {
      if (!s.eventId) continue
      if (!m.has(s.eventId)) m.set(s.eventId, [])
      m.get(s.eventId).push(s)
    }
    for (const arr of m.values()) arr.sort((a, b) => (a.date || '').localeCompare(b.date || ''))
    return m
  }, [shows])

  const unattachedShows = useMemo(
    () => shows.filter(s => !s.eventId).sort((a, b) => (a.date || '').localeCompare(b.date || '')),
    [shows]
  )

  function openAdd() {
    setEditing(null)
    setForm(BLANK_EVENT)
    setModal(true)
  }
  function openEdit(ev) {
    setEditing(ev)
    setForm({ ...BLANK_EVENT, ...ev })
    setModal(true)
  }

  async function handleSave() {
    if (!form.name?.trim()) { alert('Event name is required'); return }
    setSaving(true)
    try {
      if (editing) {
        await api.put(`/events/${editing.id}`, form)
      } else {
        await api.post('/events', form)
      }
      await load()
      setModal(false)
    } catch (err) {
      alert(err?.response?.data?.message || err.message || 'Save failed')
    } finally { setSaving(false) }
  }

  async function handleDelete(ev) {
    const linked = showsByEvent.get(ev.id)?.length || 0
    const msg = linked > 0
      ? `Delete "${ev.name}"? Its ${linked} attached show${linked === 1 ? '' : 's'} will be un-grouped (not deleted).`
      : `Delete "${ev.name}"?`
    if (!confirm(msg)) return
    await api.delete(`/events/${ev.id}`)
    await load()
  }

  function openAttach(ev) {
    setAttachModal(ev)
    setAttachIds(new Set())
  }
  function toggleAttach(id) {
    setAttachIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  async function handleAttach() {
    if (attachIds.size === 0) { setAttachModal(null); return }
    setAttaching(true)
    try {
      await api.post(`/events/${attachModal.id}/attach-shows`, { showIds: [...attachIds] })
      setAttachModal(null)
      await load()
    } catch (err) {
      alert(err?.response?.data?.message || err.message || 'Attach failed')
    } finally { setAttaching(false) }
  }
  async function handleDetach(eventId, showId) {
    if (!confirm('Remove this show from the event?')) return
    await api.post(`/events/${eventId}/detach-show`, { showId })
    await load()
  }

  if (loading) return <div className="loading">Loading events…</div>

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Events</div>
          <div className="page-subtitle">Festivals, residencies, and multi-day bookings</div>
        </div>
        {canEdit && <button className="btn btn-primary" onClick={openAdd}>+ New Event</button>}
      </div>

      {events.length === 0 && (
        <div className="card">
          <div className="empty-state">
            No events yet. Use events to group multiple shows into a single booking
            (a weekend festival, a 3-night residency, a private-event weekend).
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gap: 16 }}>
        {events.map(ev => {
          const list = showsByEvent.get(ev.id) || []
          return (
            <div key={ev.id} className="card" style={{ borderLeft: `4px solid ${ev.color || '#7c3aed'}` }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 20 }}>🎪</span>
                    <h3 style={{ margin: 0 }}>{ev.name}</h3>
                    <span className="badge" style={{ background: ev.color || '#7c3aed', color: '#fff' }}>
                      {list.length} show{list.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 4 }}>
                    {fmtRange(ev.startDate, ev.endDate)}
                    {ev.description ? ` · ${ev.description}` : ''}
                  </div>
                </div>
                {canEdit && (
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/events/${ev.id}/schedule`)}>📅 Schedule</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => openAttach(ev)}>+ Add Shows</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => openEdit(ev)}>Edit</button>
                    <button className="btn btn-danger btn-sm" onClick={() => handleDelete(ev)}>Delete</button>
                  </div>
                )}
                {!canEdit && (
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/events/${ev.id}/schedule`)}>📅 Schedule</button>
                  </div>
                )}
              </div>

              {list.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 12, fontStyle: 'italic' }}>
                  No shows attached yet. Click "+ Add Shows" to build the lineup.
                </div>
              ) : (
                <div style={{ marginTop: 12, display: 'grid', gap: 6 }}>
                  {list.map(s => (
                    <div
                      key={s.id}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '8px 10px',
                        background: 'rgba(255,255,255,0.03)',
                        borderRadius: 6, cursor: 'pointer',
                      }}
                      onClick={() => navigate(`/shows/${s.id}`)}
                    >
                      <span style={{ minWidth: 90, fontSize: 13, color: 'var(--text-muted)' }}>{s.date || '—'}</span>
                      <span className={`badge badge-${s.stage}`}>{s.stage === 'inside' ? 'Inside' : 'Beach'}</span>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <strong>{s.artist || s.eventName || 'Untitled'}</strong>
                        {s.support ? <span style={{ color: 'var(--text-muted)' }}> · {s.support}</span> : null}
                      </span>
                      <span className={`badge badge-${s.status || 'pending'}`}>{s.status || 'pending'}</span>
                      {canEdit && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={e => { e.stopPropagation(); handleDetach(ev.id, s.id) }}
                          title="Remove from event"
                        >×</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {modal && (
        <Modal
          title={editing ? 'Edit Event' : 'New Event'}
          onClose={() => setModal(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save Event'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div className="form-group">
              <label>Event Name *</label>
              <input
                value={form.name}
                onChange={e => setForm(v => ({ ...v, name: e.target.value }))}
                placeholder="e.g. Spring Fest 2026, Weekend Residency"
                autoFocus
              />
            </div>
            <div className="form-group">
              <label>Short Description</label>
              <input
                value={form.description}
                onChange={e => setForm(v => ({ ...v, description: e.target.value }))}
                placeholder="Optional — shown on the events list"
              />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Start Date</label>
                <input
                  type="date"
                  value={form.startDate}
                  onChange={e => setForm(v => ({ ...v, startDate: e.target.value }))}
                />
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  Auto-fills from the earliest attached show if left blank.
                </div>
              </div>
              <div className="form-group">
                <label>End Date</label>
                <input
                  type="date"
                  value={form.endDate}
                  onChange={e => setForm(v => ({ ...v, endDate: e.target.value }))}
                />
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  Auto-fills from the latest attached show if left blank.
                </div>
              </div>
            </div>
            <div className="form-group">
              <label>Color</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {PRESET_COLORS.map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setForm(v => ({ ...v, color: c }))}
                    style={{
                      width: 32, height: 32, borderRadius: 6, background: c,
                      border: form.color === c ? '2px solid #fff' : '2px solid transparent',
                      cursor: 'pointer',
                    }}
                    aria-label={`Color ${c}`}
                  />
                ))}
                <input
                  type="color"
                  value={form.color || '#7c3aed'}
                  onChange={e => setForm(v => ({ ...v, color: e.target.value }))}
                  style={{ width: 40, height: 32, padding: 0, border: 'none', background: 'transparent' }}
                />
              </div>
            </div>
            <div className="form-group">
              <label>Notes</label>
              <textarea
                rows={3}
                value={form.notes}
                onChange={e => setForm(v => ({ ...v, notes: e.target.value }))}
                placeholder="Internal notes about this event."
              />
            </div>
          </div>
        </Modal>
      )}

      {attachModal && (
        <Modal
          title={`Add Shows to ${attachModal.name}`}
          onClose={() => setAttachModal(null)}
          size="modal-lg"
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setAttachModal(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleAttach} disabled={attaching || attachIds.size === 0}>
                {attaching ? 'Attaching…' : `Attach ${attachIds.size} Show${attachIds.size === 1 ? '' : 's'}`}
              </button>
            </>
          }
        >
          {unattachedShows.length === 0 ? (
            <div className="empty-state">
              No unattached shows to add. Create shows on the Shows page first, then come back here.
            </div>
          ) : (
            <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
              {unattachedShows.map(s => {
                const selected = attachIds.has(s.id)
                return (
                  <label
                    key={s.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                      background: selected ? 'rgba(124,58,237,0.1)' : 'transparent',
                    }}
                  >
                    <input type="checkbox" checked={selected} onChange={() => toggleAttach(s.id)} />
                    <span style={{ minWidth: 90, fontSize: 13, color: 'var(--text-muted)' }}>{s.date || '—'}</span>
                    <span className={`badge badge-${s.stage}`}>{s.stage === 'inside' ? 'Inside' : 'Beach'}</span>
                    <span style={{ flex: 1 }}>
                      <strong>{s.artist || s.eventName || 'Untitled'}</strong>
                      {s.support ? <span style={{ color: 'var(--text-muted)' }}> · {s.support}</span> : null}
                    </span>
                  </label>
                )
              })}
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}
