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
  const [advances, setAdvances] = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal]     = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm]       = useState(BLANK)
  const [saving, setSaving]   = useState(false)
  const [selectedShow, setSelectedShow] = useState('')
  const [showPastShows, setShowPastShows] = useState(false)
  // ─── Bot ROS / Day-Sheet extraction ───
  const [botModal, setBotModal]   = useState(false)
  const [botLoading, setBotLoading] = useState(false)
  const [botError, setBotError]   = useState('')
  const [botResult, setBotResult] = useState(null)   // { items, sources, ... }
  const [botPicked, setBotPicked] = useState({})     // index -> bool
  const [botReplace, setBotReplace] = useState(false)
  const [botApplying, setBotApplying] = useState(false)

  async function runBotExtract() {
    if (!selectedShow) { alert('Pick a show first to scan its emails.'); return }
    setBotModal(true); setBotLoading(true); setBotError(''); setBotResult(null); setBotPicked({})
    try {
      const { data } = await api.post('/schedule/extract', { showId: selectedShow })
      if (!data.success) throw new Error(data.message || 'Extraction failed')
      setBotResult(data)
      const picks = {}; (data.items || []).forEach((_, i) => { picks[i] = true })
      setBotPicked(picks)
    } catch (err) {
      setBotError(err?.response?.data?.message || err.message || 'Extraction failed')
    } finally { setBotLoading(false) }
  }

  async function applyBotItems() {
    if (!botResult) return
    const items = (botResult.items || [])
      .filter((_, i) => botPicked[i])
      .map(it => ({ time: it.time, label: it.label, responsible: it.responsible, notes: it.notes }))
    if (items.length === 0) { alert('Select at least one item.'); return }
    setBotApplying(true)
    try {
      const { data } = await api.post('/schedule/apply', {
        showId: selectedShow, items, replaceExisting: botReplace,
      })
      if (!data.success) throw new Error(data.message || 'Apply failed')
      await load()
      setBotModal(false)
    } catch (err) {
      setBotError(err?.response?.data?.message || err.message || 'Apply failed')
    } finally { setBotApplying(false) }
  }

  useEffect(() => {
    Promise.all([
      api.get('/schedule'),
      api.get('/shows'),
      api.get('/advancing').catch(() => ({ data: { data: [] } })),
    ]).then(([sc, s, a]) => {
      setItems(sc.data.data || [])
      setShows(s.data.data || [])
      setAdvances(a.data.data || [])
    }).finally(() => setLoading(false))
  }, [])

  async function load() {
    const [sc, s, a] = await Promise.all([
      api.get('/schedule'),
      api.get('/shows'),
      api.get('/advancing').catch(() => ({ data: { data: [] } })),
    ])
    setItems(sc.data.data || [])
    setShows(s.data.data || [])
    setAdvances(a.data.data || [])
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

  const currentAdvance = selectedShow ? advances.find(a => a.showId === selectedShow) : null
  const botBanner = (() => {
    if (!currentAdvance?.botAutoApplied) return null
    const count = currentAdvance.botAutoAppliedCount || ''
    let when = currentAdvance.botAutoApplied
    try { when = new Date(currentAdvance.botAutoApplied).toLocaleString() } catch {}
    return { count, when }
  })()

  function handlePrint() {
    // Group filtered items by show so "All Shows" prints one page per show.
    const groups = new Map()
    for (const it of filtered) {
      const sid = it.showId || '_'
      if (!groups.has(sid)) groups.set(sid, [])
      groups.get(sid).push(it)
    }
    if (groups.size === 0) { alert('No schedule items to print.'); return }

    const pages = []
    for (const [sid, rows] of groups) {
      const show = shows.find(s => s.id === sid)
      const dateStr = show?.date || rows[0]?.date || ''
      let prettyDate = dateStr
      if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
        const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number)
        const dt = new Date(y, m - 1, d)
        prettyDate = dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: '2-digit', year: 'numeric' })
      }
      const rowsHtml = rows.map(it => `
        <tr>
          <td class="label">${escapeHtml(it.label || '')}</td>
          <td class="time">${it.time ? escapeHtml(formatTime(it.time, tf)) : ''}</td>
        </tr>`).join('')
      pages.push(`
        <section class="page">
          <header>
            <h1>The Windjammer</h1>
            <h2>Isle of Palms, SC</h2>
            <h2>${escapeHtml(prettyDate)}</h2>
          </header>
          <table>${rowsHtml}</table>
        </section>`)
    }

    const html = `<!DOCTYPE html><html><head>
      <title>Day Sheet</title>
      <style>
        @page { size: letter; margin: 0.6in; }
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; background: #fff; color: #000;
          font-family: 'Impact','Arial Black','Helvetica Neue',sans-serif;
          -webkit-font-smoothing: antialiased; }
        .page { page-break-after: always; padding: 0.25in 0; }
        .page:last-child { page-break-after: auto; }
        header { text-align: center; margin-bottom: 0.4in; }
        header h1 { font-size: 34pt; margin: 0 0 4pt; letter-spacing: 0.5pt; }
        header h2 { font-size: 22pt; margin: 0; font-weight: 900; }
        table { margin: 0 auto; border-collapse: collapse; width: 70%; }
        td { padding: 6pt 0; font-size: 22pt; font-weight: 900; vertical-align: baseline; }
        td.label { text-align: right; padding-right: 0.6in; }
        td.time  { text-align: left;  white-space: nowrap; font-variant-numeric: tabular-nums; }
      </style>
    </head><body>${pages.join('')}</body></html>`

    const win = window.open('', '_blank')
    win.document.write(html)
    win.document.close()
    win.focus()
    setTimeout(() => win.print(), 400)
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]))
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Day of Show</div>
          <div className="page-subtitle">Load-in to load-out schedule and timeline management</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" onClick={runBotExtract} disabled={!selectedShow} title={selectedShow ? 'Scan linked emails for a Run-of-Show / day sheet' : 'Pick a show first'}>🤖 Auto-Fill From Emails</button>
          <button className="btn btn-ghost" onClick={handlePrint} disabled={filtered.length === 0}>🖨 Print Day Sheet</button>
          <button className="btn btn-primary" onClick={openAdd}>+ Add Item</button>
        </div>
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

      {botBanner && (
        <div className="alert" style={{ background:'rgba(99,102,241,0.12)', border:'1px solid rgba(99,102,241,0.35)', color:'#c7d2fe', padding:'10px 14px', borderRadius:8, marginBottom:12, fontSize:13 }}>
          🤖 Auto-filled by the bot{botBanner.count ? <> (<strong>{botBanner.count}</strong> item{botBanner.count === '1' ? '' : 's'})</> : null} on {botBanner.when}. Review and edit as needed.
        </div>
      )}

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

      {botModal && (
        <Modal
          title="🤖 Auto-Fill Day of Show from Emails"
          onClose={() => setBotModal(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setBotModal(false)}>Close</button>
              <button
                className="btn btn-primary"
                onClick={applyBotItems}
                disabled={botApplying || botLoading || !botResult || (botResult.items || []).length === 0}
              >
                {botApplying ? 'Applying…' : `Apply ${Object.values(botPicked).filter(Boolean).length} Item(s)`}
              </button>
            </>
          }
        >
          {botLoading && <div className="loading">Scanning emails…</div>}
          {botError && <div className="alert alert-error">{botError}</div>}
          {!botLoading && botResult && (
            <>
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', marginBottom: 12 }}>
                Scanned <strong>{botResult.scannedCount}</strong> of {botResult.candidateCount} schedule-looking
                email(s) ({botResult.linkedEmailCount} linked to show
                {botResult.artistName ? <> / <em>{botResult.artistName}</em></> : null}). Found <strong>{(botResult.items || []).length}</strong> schedule item(s).
              </div>
              {(botResult.items || []).length === 0 ? (
                <div className="empty-state">
                  No timed schedule lines detected. Make sure a Run-of-Show / Day Sheet email is linked to this show.
                </div>
              ) : (
                <>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 10, cursor: 'pointer' }}>
                    <input type="checkbox" checked={botReplace} onChange={e => setBotReplace(e.target.checked)} />
                    Replace existing schedule for this show (deletes current items first)
                  </label>
                  <div className="table-wrap" style={{ maxHeight: 380, overflowY: 'auto' }}>
                    <table>
                      <thead>
                        <tr>
                          <th style={{ width: 28 }}></th>
                          <th>Time</th>
                          <th>Label</th>
                          <th>Responsible</th>
                          <th>Source</th>
                          <th>Conf</th>
                        </tr>
                      </thead>
                      <tbody>
                        {botResult.items.map((it, i) => (
                          <tr key={i}>
                            <td>
                              <input
                                type="checkbox"
                                checked={!!botPicked[i]}
                                onChange={e => setBotPicked(p => ({ ...p, [i]: e.target.checked }))}
                              />
                            </td>
                            <td><strong>{formatTime(it.time, tf)}</strong></td>
                            <td>{it.label}</td>
                            <td className="text-muted">{it.responsible || '—'}</td>
                            <td className="text-muted" style={{ fontSize: 11, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${it.source?.subject || ''}\n${it.source?.quote || ''}`}>
                              {it.source?.subject || '—'}
                            </td>
                            <td>
                              <span className={`badge badge-${it.confidence === 'high' ? 'success' : it.confidence === 'medium' ? 'warning' : 'inside'}`}>{it.confidence}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </Modal>
      )}
    </div>
  )
}
