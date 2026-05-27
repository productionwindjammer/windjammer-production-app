import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api'
import Modal from '../components/Modal'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { formatTime } from '../utils/time'

// Color palette per stage (matches existing badge-inside / badge-beach hues)
const STAGE_COLORS = {
  inside: { bg: 'rgba(26,74,122,0.85)',  border: '#3b82f6', text: '#fff' },
  beach:  { bg: 'rgba(26,107,74,0.85)',  border: '#10b981', text: '#fff' },
}
const STATUS_DIM = { pending: 0.55, advancing: 0.75, cancelled: 0.35, settled: 0.5, confirmed: 1 }

function ymd(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function parseYmd(s) {
  if (!s) return null
  // Treat bare YYYY-MM-DD as local midday to avoid TZ shifts
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0)
  return new Date(s)
}

function monthMatrix(year, month /* 0-indexed */) {
  // Week starts Sunday. Returns 6 rows × 7 days of Date objects.
  const first = new Date(year, month, 1)
  const start = new Date(first)
  start.setDate(1 - first.getDay())
  const rows = []
  for (let r = 0; r < 6; r++) {
    const row = []
    for (let c = 0; c < 7; c++) {
      const d = new Date(start)
      d.setDate(start.getDate() + r * 7 + c)
      row.push(d)
    }
    rows.push(row)
  }
  return rows
}

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']

const BLANK_UNAV = { staffId: '', staffName: '', startDate: '', endDate: '', reason: '' }

export default function Calendar() {
  const navigate = useNavigate()
  const { effectiveRole } = useAuth()
  const { settings } = useSettings()
  const tf = settings?.timeFormat || '12h'
  const canEditUnav = ['admin', 'production_manager'].includes(effectiveRole)

  const today = new Date()
  const [cursor, setCursor] = useState(new Date(today.getFullYear(), today.getMonth(), 1))
  const [shows, setShows] = useState([])
  const [unav, setUnav]   = useState([])
  const [staff, setStaff] = useState([])
  const [loading, setLoading] = useState(true)

  // Unavailability modal (PM+ only)
  const [modal, setModal]     = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm]       = useState(BLANK_UNAV)
  const [saving, setSaving]   = useState(false)

  useEffect(() => { load() }, [])
  async function load() {
    setLoading(true)
    try {
      const [showsRes, unavRes, staffRes] = await Promise.all([
        api.get('/shows'),
        api.get('/unavailability').catch(() => ({ data: { data: [] } })),
        api.get('/staff').catch(() => ({ data: { data: [] } })),
      ])
      setShows(showsRes.data.data || [])
      setUnav(unavRes.data.data || [])
      setStaff(staffRes.data.data || [])
    } finally { setLoading(false) }
  }

  // Group events by date string
  const eventsByDate = useMemo(() => {
    const map = new Map()
    for (const s of shows) {
      if (!s.date) continue
      const key = String(s.date).slice(0, 10)
      if (!map.has(key)) map.set(key, [])
      map.get(key).push({ type: 'show', show: s })
    }
    for (const u of unav) {
      const start = parseYmd(u.startDate)
      const end   = parseYmd(u.endDate || u.startDate)
      if (!start || !end) continue
      const d = new Date(start)
      while (d <= end) {
        const key = ymd(d)
        if (!map.has(key)) map.set(key, [])
        map.get(key).push({ type: 'unav', unav: u })
        d.setDate(d.getDate() + 1)
      }
    }
    return map
  }, [shows, unav])

  const matrix = monthMatrix(cursor.getFullYear(), cursor.getMonth())
  const todayKey = ymd(today)
  const monthLabel = `${MONTH_NAMES[cursor.getMonth()]} ${cursor.getFullYear()}`

  function go(deltaMonths) {
    const next = new Date(cursor)
    next.setMonth(next.getMonth() + deltaMonths)
    setCursor(next)
  }

  // ── Unavailability handlers ────────────────────────────────────────
  function openAddUnav(presetDate) {
    setEditing(null)
    setForm({ ...BLANK_UNAV, startDate: presetDate || ymd(today), endDate: presetDate || ymd(today) })
    setModal(true)
  }
  function openEditUnav(u) {
    setEditing(u)
    setForm({ ...BLANK_UNAV, ...u, endDate: u.endDate || u.startDate })
    setModal(true)
  }
  async function saveUnav(e) {
    e?.preventDefault?.()
    if (!form.staffId) { alert('Pick a staff member'); return }
    if (!form.startDate) { alert('Start date required'); return }
    const staffRec = staff.find(s => s.id === form.staffId)
    const payload = {
      ...form,
      staffName: staffRec?.name || form.staffName || '',
      endDate: form.endDate || form.startDate,
    }
    setSaving(true)
    try {
      if (editing?.id) await api.put(`/unavailability/${editing.id}`, payload)
      else             await api.post('/unavailability', payload)
      setModal(false)
      await load()
    } catch (err) {
      alert('Failed to save: ' + (err?.response?.data?.message || err.message))
    } finally { setSaving(false) }
  }
  async function deleteUnav(u) {
    if (!confirm(`Delete unavailability for ${u.staffName} (${u.startDate}${u.endDate && u.endDate !== u.startDate ? ` – ${u.endDate}` : ''})?`)) return
    try {
      await api.delete(`/unavailability/${u.id}`)
      await load()
    } catch (err) {
      alert('Failed to delete: ' + (err?.response?.data?.message || err.message))
    }
  }

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>🗓️ Calendar</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => go(-1)}>‹ Prev</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setCursor(new Date(today.getFullYear(), today.getMonth(), 1))}>Today</button>
          <button className="btn btn-ghost btn-sm" onClick={() => go(1)}>Next ›</button>
          <div style={{ minWidth: 180, textAlign: 'center', fontWeight: 600, fontSize: 18 }}>{monthLabel}</div>
          {canEditUnav && (
            <button className="btn btn-primary btn-sm" onClick={() => openAddUnav()}>+ Unavailability</button>
          )}
        </div>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12, fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>
        <LegendDot color={STAGE_COLORS.inside.border} label="Inside Stage" />
        <LegendDot color={STAGE_COLORS.beach.border}  label="Beach Stage" />
        <LegendDot color="#9ca3af" label="Unavailable crew" />
        <span style={{ marginLeft: 'auto', opacity: 0.6 }}>Dimmed = pending / cancelled / settled</span>
      </div>

      {loading ? <div>Loading…</div> : (
        <div style={{ border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, overflow: 'hidden', background: 'rgba(255,255,255,0.02)' }}>
          {/* Day-of-week header */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', background: 'rgba(255,255,255,0.04)', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            {DOW.map(d => (
              <div key={d} style={{ padding: '8px 10px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.55)', textAlign: 'center' }}>{d}</div>
            ))}
          </div>

          {/* Weeks */}
          {matrix.map((row, ri) => (
            <div key={ri} style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', borderTop: ri === 0 ? 'none' : '1px solid rgba(255,255,255,0.06)' }}>
              {row.map((d, ci) => {
                const key      = ymd(d)
                const isMonth  = d.getMonth() === cursor.getMonth()
                const isToday  = key === todayKey
                const items    = eventsByDate.get(key) || []
                return (
                  <div
                    key={ci}
                    onClick={canEditUnav ? () => openAddUnav(key) : undefined}
                    style={{
                      minHeight: 110, padding: 6,
                      borderLeft: ci === 0 ? 'none' : '1px solid rgba(255,255,255,0.06)',
                      background: isToday ? 'rgba(59,130,246,0.08)' : 'transparent',
                      opacity: isMonth ? 1 : 0.35,
                      cursor: canEditUnav ? 'pointer' : 'default',
                      position: 'relative',
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: isToday ? 700 : 500, color: isToday ? '#60a5fa' : 'rgba(255,255,255,0.7)', marginBottom: 4, textAlign: 'right' }}>
                      {d.getDate()}
                    </div>
                    {(() => {
                      const shown = items.slice(0, 3)
                      const hidden = items.length - shown.length
                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                          {shown.map((it, i) => it.type === 'show' ? (
                            <ShowChip key={`s${i}`} show={it.show} tf={tf} onClick={e => { e.stopPropagation(); navigate(`/shows/${it.show.id}`) }} />
                          ) : (
                            <UnavChip key={`u${i}`} u={it.unav} canEdit={canEditUnav}
                              onClick={e => { e.stopPropagation(); if (canEditUnav) openEditUnav(it.unav) }}
                              onDelete={e => { e.stopPropagation(); deleteUnav(it.unav) }} />
                          ))}
                          {hidden > 0 && (
                            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', textAlign: 'center' }}>+{hidden} more</div>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}

      {/* Unavailability modal */}
      {modal && (
        <Modal title={editing ? 'Edit Unavailability' : 'Mark Crew Unavailable'} onClose={() => setModal(false)}>
          <form onSubmit={saveUnav} className="form-grid">
            <label>Crew member
              <select value={form.staffId} onChange={e => setForm(f => ({ ...f, staffId: e.target.value }))} required>
                <option value="">— select —</option>
                {staff
                  .slice()
                  .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
                  .map(s => <option key={s.id} value={s.id}>{s.name}{s.role ? ` · ${s.role}` : ''}</option>)}
              </select>
            </label>
            <div className="form-row">
              <label>Start date
                <input type="date" value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} required />
              </label>
              <label>End date
                <input type="date" value={form.endDate} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} />
              </label>
            </div>
            <label>Reason (optional)
              <input type="text" value={form.reason} placeholder="e.g. Vacation, Out of town" onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} />
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
              {editing && <button type="button" className="btn btn-danger" onClick={() => { setModal(false); deleteUnav(editing) }}>Delete</button>}
              <button type="button" className="btn btn-ghost" onClick={() => setModal(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}

function LegendDot({ color, label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: 'inline-block' }} />
      {label}
    </span>
  )
}

function ShowChip({ show, tf, onClick }) {
  const stage  = (show.stage || 'inside').toLowerCase()
  const colors = STAGE_COLORS[stage] || STAGE_COLORS.inside
  const status = (show.status || 'pending').toLowerCase()
  const dim    = STATUS_DIM[status] ?? 1
  const label  = show.artist || show.eventName || 'Untitled'
  const time   = show.showTime ? formatTime(show.showTime, tf) : ''
  return (
    <button
      onClick={onClick}
      title={`${label}${time ? ' · ' + time : ''} · ${stage} · ${status}`}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        background: colors.bg, color: colors.text,
        border: `1px solid ${colors.border}`, borderRadius: 4,
        padding: '3px 6px', fontSize: 11, lineHeight: 1.3,
        cursor: 'pointer', opacity: dim,
        textDecoration: status === 'cancelled' ? 'line-through' : 'none',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}
    >
      {time && <span style={{ opacity: 0.85, marginRight: 4, fontVariantNumeric: 'tabular-nums' }}>{time}</span>}
      {label}
    </button>
  )
}

function UnavChip({ u, canEdit, onClick, onDelete }) {
  const label = u.staffName || 'Crew'
  return (
    <span
      onClick={onClick}
      title={`${label} unavailable${u.reason ? ' — ' + u.reason : ''}`}
      style={{
        display: 'flex', alignItems: 'center', gap: 4,
        background: 'rgba(120,120,120,0.25)', color: 'rgba(255,255,255,0.75)',
        border: '1px dashed rgba(255,255,255,0.2)', borderRadius: 4,
        padding: '2px 6px', fontSize: 10, lineHeight: 1.3,
        cursor: canEdit ? 'pointer' : 'default',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}
    >
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>🚫 {label}</span>
      {canEdit && (
        <span onClick={onDelete} title="Delete" style={{ opacity: 0.5, paddingLeft: 4 }}>✕</span>
      )}
    </span>
  )
}
