import { useEffect, useState } from 'react'
import api from '../api'
import Modal from '../components/Modal'
import { filterShowList } from '../utils/showFilters'
import { useSettings } from '../context/SettingsContext'
import { formatTime } from '../utils/time'

const BLANK = {
  showId: '', showName: '', stage: 'inside', date: '',
  eventType: 'time', label: '', time: '', duration: '',
  responsible: '', notes: ''
}

export default function DayOfShow() {
  const { settings } = useSettings()
  const tf = settings.timeFormat || '12h'
  const [items, setItems]     = useState([])
  const [shows, setShows]     = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal]     = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm]       = useState(BLANK)
  const [saving, setSaving]   = useState(false)
  const [selectedShow, setSelectedShow] = useState('')
  const [showPastShows, setShowPastShows] = useState(false)

  useEffect(() => {
    Promise.all([api.get('/schedule'), api.get('/shows')]).then(([sc, s]) => {
      setItems(sc.data.data || [])
      setShows(s.data.data || [])
    }).finally(() => setLoading(false))
  }, [])

  async function load() {
    const [sc, s] = await Promise.all([api.get('/schedule'), api.get('/shows')])
    setItems(sc.data.data || [])
    setShows(s.data.data || [])
  }

  function openAdd() { setEditing(null); setForm(BLANK); setModal(true) }
  function openEdit(r) { setEditing(r); setForm({ ...BLANK, ...r }); setModal(true) }

  async function handleSave() {
    setSaving(true)
    try {
      if (editing) await api.put(`/schedule/${editing.id}`, form)
      else await api.post('/schedule', form)
      await load()
      setModal(false)
    } finally { setSaving(false) }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this schedule item?')) return
    await api.delete(`/schedule/${id}`)
    await load()
  }

  const set = k => e => setForm(v => ({ ...v, [k]: e.target.value }))
  const f = form

  const upcomingShows = filterShowList(shows, { showPast: showPastShows })
  const filtered = items
    .filter(i => !selectedShow || i.showId === selectedShow)
    .sort((a, b) => (a.time || '').localeCompare(b.time || ''))

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Day of Show</div>
          <div className="page-subtitle">Load-in to load-out schedule and timeline management</div>
        </div>
        <button className="btn btn-primary" onClick={openAdd}>+ Add Item</button>
      </div>

      <div className="filter-bar">
        <select value={selectedShow} onChange={e => setSelectedShow(e.target.value)}>
          <option value="">All Shows</option>
          {upcomingShows.map(s => (
            <option key={s.id} value={s.id}>{s.date} — {s.artist || s.eventName} ({s.stage})</option>
          ))}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'rgba(255,255,255,0.7)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={showPastShows} onChange={e => setShowPastShows(e.target.checked)} />
          Show all (incl. past)
        </label>
      </div>

      <div className="card">
        {loading ? <div className="loading">Loading…</div> : (
          <div className="table-wrap responsive-cards">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event / Task</th>
                  <th>Show</th>
                  <th>Stage</th>
                  <th>Responsible</th>
                  <th>Notes</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={7}><div className="empty-state">No schedule items found</div></td></tr>
                )}
                {filtered.map(item => (
                  <tr key={item.id}>
                    <td data-label="Time"><strong>{item.time ? formatTime(item.time, tf) : '—'}</strong></td>
                    <td data-label="Event">{item.label || '—'}</td>
                    <td data-label="Show" className="text-muted">{item.showName || '—'}</td>
                    <td data-label="Stage"><span className={`badge badge-${item.stage}`}>{item.stage === 'inside' ? 'Inside' : 'Beach'}</span></td>
                    <td data-label="Responsible" className="text-muted">{item.responsible || '—'}</td>
                    <td data-label="Notes" className="text-muted" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.notes || '—'}</td>
                    <td data-label="Actions">
                      <div className="actions-cell">
                        <button className="btn btn-ghost btn-sm" onClick={() => openEdit(item)}>Edit</button>
                        <button className="btn btn-danger btn-sm" onClick={() => handleDelete(item.id)}>Del</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal && (
        <Modal
          title={editing ? 'Edit Schedule Item' : 'Add Schedule Item'}
          onClose={() => setModal(false)}
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
            <div className="form-group">
              <label>Show</label>
              <select value={f.showId} onChange={e => {
                const s = shows.find(s => s.id === e.target.value)
                setForm(v => ({ ...v, showId: e.target.value, showName: s ? `${s.date} — ${s.artist || s.eventName}` : '', stage: s?.stage || v.stage }))
              }}>
                <option value="">Select show…</option>
                {upcomingShows.map(s => (
                  <option key={s.id} value={s.id}>{s.date} — {s.artist || s.eventName} ({s.stage})</option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Time</label>
                <input type="time" value={f.time} onChange={set('time')} />
              </div>
              <div className="form-group">
                <label>Stage</label>
                <select value={f.stage} onChange={set('stage')}>
                  <option value="inside">Inside Stage</option>
                  <option value="beach">Beach Stage</option>
                </select>
              </div>
            </div>
            <div className="form-group">
              <label>Label / Event</label>
              <input value={f.label} onChange={set('label')} placeholder="e.g. Load In, Sound Check, Doors, Set 1, Load Out…" />
            </div>
            <div className="form-group">
              <label>Responsible Party</label>
              <input value={f.responsible} onChange={set('responsible')} placeholder="Who is responsible for this item" />
            </div>
            <div className="form-group">
              <label>Notes</label>
              <textarea value={f.notes} onChange={set('notes')} />
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
