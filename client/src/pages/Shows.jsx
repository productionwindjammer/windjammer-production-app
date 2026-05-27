import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api'
import Modal from '../components/Modal'
import { useSettings } from '../context/SettingsContext'
import { formatTime } from '../utils/time'

const DEFAULT_PROMOTER = 'Scottie Frier'

const BLANK = {
  date: '', artist: '', eventName: '', stage: 'inside', status: 'pending',
  showTime: '', doorsTime: '', capacity: '', ticketPrice: '', support: '',
  promoter: DEFAULT_PROMOTER, tourManager: '', notes: ''
}

export default function Shows() {
  const { settings } = useSettings()
  const tf = settings.timeFormat || '12h'
  const navigate = useNavigate()
  const [shows, setShows]       = useState([])
  const [loading, setLoading]   = useState(true)
  const [modal, setModal]       = useState(false)
  const [editing, setEditing]   = useState(null)
  const [form, setForm]         = useState(BLANK)
  const [filter, setFilter]     = useState({ stage: '', status: '', search: '' })
  const [showPast, setShowPast] = useState(false)
  const [saving, setSaving]     = useState(false)
  const [supportActs, setSupportActs] = useState([])

  // ── Scraper state ──────────────────────────────────────────────────────────
  const [scrapeOpen, setScrapeOpen]     = useState(false)
  const [scraping, setScraping]         = useState(false)
  const [scrapeResults, setScrapeResults] = useState(null)
  const [scrapeError, setScrapeError]   = useState(null)
  const [selected, setSelected]         = useState(new Set()) // URLs/keys of checked rows
  const [importing, setImporting]       = useState(false)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const res = await api.get('/shows')
      setShows((res.data.data || []).sort((a, b) => new Date(a.date) - new Date(b.date)))
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
    setModal(true)
  }
  function openEdit(s) {
    setEditing(s)
    setForm({ ...BLANK, ...s, promoter: s.promoter || DEFAULT_PROMOTER })
    setSupportActs(parseSupport(s.support))
    setModal(true)
  }

  async function handleSave() {
    setSaving(true)
    try {
      const payload = {
        ...form,
        support: supportActs.map(s => s.trim()).filter(Boolean).join(', '),
      }
      if (editing) {
        await api.put(`/shows/${editing.id}`, payload)
      } else {
        await api.post('/shows', payload)
      }
      await load()
      setModal(false)
    } finally { setSaving(false) }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this show?')) return
    await api.delete(`/shows/${id}`)
    await load()
  }

  // ── Scraper ────────────────────────────────────────────────────────────────
  async function handleScrape() {
    setScraping(true)
    setScrapeError(null)
    setScrapeResults(null)
    try {
      const res = await api.get('/scrape/shows')
      const data = res.data.data || []
      setScrapeResults(data)
      // Pre-select all new (non-duplicate) events
      setSelected(new Set(data.filter(e => !e.isDuplicate).map(e => e.url || `${e.date}::${e.title}`)))
    } catch (err) {
      setScrapeError(err.response?.data?.message || err.message)
    } finally {
      setScraping(false)
    }
  }

  async function handleImport() {
    if (!scrapeResults) return
    const toImport = scrapeResults.filter(e => selected.has(e.url || `${e.date}::${e.title}`))
    if (toImport.length === 0) return
    setImporting(true)
    try {
      const res = await api.post('/scrape/import', { events: toImport })
      await load()
      setScrapeOpen(false)
      setScrapeResults(null)
      alert(`✅ Imported ${res.data.created} show${res.data.created !== 1 ? 's' : ''}.`)
    } catch (err) {
      alert('Import failed: ' + (err.response?.data?.message || err.message))
    } finally {
      setImporting(false)
    }
  }

  function toggleSelect(key) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const f = form
  const set = k => e => setForm(v => ({ ...v, [k]: e.target.value }))

  const normalizeTitle = t =>
    t.replace(/\s*[-–]\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*/i, '')
     .replace(/\s*\((monday|tuesday|wednesday|thursday|friday|saturday|sunday)\)\s*$/i, '')
     .trim().toLowerCase()

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
          <button className="btn btn-ghost" onClick={() => { setScrapeOpen(true); handleScrape() }}>🔄 Import from Website</button>
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
        {loading ? <div className="loading">Loading…</div> : (
          <div className="table-wrap responsive-cards">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Artist / Event</th>
                  <th>Stage</th>
                  <th>Show Time</th>
                  <th>Capacity</th>
                  <th>Status</th>
                  <th>Tour Manager</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={8}><div className="empty-state">No shows found</div></td></tr>
                )}
                {filtered.map(show => (
                  <tr key={show.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/shows/${show.id}`)}>
                    <td data-label="Date" className="text-muted">{show.date}</td>
                    <td data-label="Artist"><strong>{show.artist || show.eventName || '—'}</strong></td>
                    <td data-label="Stage"><span className={`badge badge-${show.stage}`}>{show.stage === 'inside' ? 'Inside' : 'Beach'}</span></td>
                    <td data-label="Show Time" className="text-muted">{show.showTime ? formatTime(show.showTime, tf) : '—'}</td>
                    <td data-label="Capacity" className="text-muted">{show.capacity || '—'}</td>
                    <td data-label="Status"><span className={`badge badge-${show.status || 'pending'}`}>{show.status || 'pending'}</span></td>
                    <td data-label="Tour Manager" className="text-muted">{show.tourManager || '—'}</td>
                      <td data-label="Actions" onClick={e => e.stopPropagation()}>
                      <div className="actions-cell">
                        <button className="btn btn-ghost btn-sm" onClick={() => openEdit(show)}>Edit</button>
                        <button className="btn btn-danger btn-sm" onClick={() => handleDelete(show.id)}>Del</button>
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

      {scrapeOpen && (
        <Modal
          title="🔄 Import Shows from Website"
          onClose={() => setScrapeOpen(false)}
          size="modal-lg"
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setScrapeOpen(false)}>Close</button>
              <button className="btn btn-ghost" onClick={handleScrape} disabled={scraping}>
                {scraping ? '⟳ Refreshing…' : '⟳ Refresh'}
              </button>
              <button
                className="btn btn-primary"
                onClick={handleImport}
                disabled={importing || !scrapeResults || selected.size === 0}
              >
                {importing ? 'Importing…' : `Import ${selected.size} Show${selected.size !== 1 ? 's' : ''}`}
              </button>
            </>
          }
        >
          {scraping && <div className="loading">Fetching events from the-windjammer.com…</div>}
          {scrapeError && (
            <div style={{padding:'12px',background:'#fef2f2',borderRadius:6,color:'#991b1b',marginBottom:12}}>
              ⚠️ {scrapeError}
            </div>
          )}
          {scrapeResults && !scraping && (
            <>
              <p style={{margin:'0 0 12px',color:'rgba(255,255,255,0.55)',fontSize:'0.88rem'}}>
                Found {scrapeResults.length} upcoming event{scrapeResults.length !== 1 ? 's' : ''}. Events already in the app are greyed out.
              </p>
              <div style={{display:'flex',flexDirection:'column',gap:6}}>
                {scrapeResults.length === 0 && (
                  <div className="empty-state">No upcoming events found on the-windjammer.com.</div>
                )}
                {scrapeResults.map(ev => {
                  const key = ev.url || `${ev.date}::${ev.title}`
                  const isChecked = selected.has(key)
                  return (
                    <div
                      key={key}
                      onClick={() => !ev.isDuplicate && toggleSelect(key)}
                      style={{
                        display:'flex',gap:8,alignItems:'center',
                        padding:'10px 14px',borderRadius:8,cursor:ev.isDuplicate?'default':'pointer',
                        background: ev.isDuplicate ? 'rgba(255,255,255,0.03)' : isChecked ? 'rgba(59,130,246,0.12)' : 'rgba(255,255,255,0.06)',
                        border: `1px solid ${isChecked && !ev.isDuplicate ? 'rgba(59,130,246,0.4)' : 'rgba(255,255,255,0.08)'}`,
                        opacity: ev.isDuplicate ? 0.45 : 1,
                        transition:'all 0.15s',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => {}}
                        disabled={ev.isDuplicate}
                        style={{flexShrink:0,width:14,height:14,accentColor:'#3b82f6',cursor:ev.isDuplicate?'default':'pointer',marginTop:1}}
                      />
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontWeight:600,fontSize:14,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                          {ev.title}
                        </div>
                        <div style={{fontSize:12,color:'rgba(255,255,255,0.45)',marginTop:2}}>
                          {ev.date}
                          {ev.time && ` · ${formatTime(ev.time, tf)}`}
                          {ev.isDuplicate && <span style={{marginLeft:8,color:'#6ee7b7'}}>✓ Already in app</span>}
                        </div>
                      </div>
                      <div style={{display:'flex',gap:6,flexShrink:0}}>
                        <span className={`badge badge-${ev.stage}`} style={{fontSize:11}}>
                          {ev.stage === 'inside' ? 'Inside' : 'Beach'}
                        </span>
                        {ev.url && (
                          <a
                            href={ev.url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={e => e.stopPropagation()}
                            style={{fontSize:11,color:'rgba(255,255,255,0.35)',textDecoration:'none'}}
                            title="View on the-windjammer.com"
                          >↗</a>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  )
}
