import { useEffect, useMemo, useState } from 'react'
import api from '../api'
import Modal from '../components/Modal'
import { filterShowList } from '../utils/showFilters'
import { useSettings } from '../context/SettingsContext'
import { formatTime, byTime, byDateThenTime } from '../utils/time'

const BLANK = {
  showId: '', showName: '', stage: 'inside', date: '',
  eventType: 'time', label: '', time: '', duration: '',
  responsible: '', notes: ''
}

const STAGES = [
  { key: 'inside', label: 'Inside Stage' },
  { key: 'beach',  label: 'Beach Stage'  },
]

function todayYmd() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}
function shiftYmd(ymd, days) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(ymd)) return ymd
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + days)
  const yy = dt.getFullYear()
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const dd = String(dt.getDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}
function prettyDateLong(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(ymd)) return ymd || ''
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  })
}

export default function DayOfShow() {
  const { settings } = useSettings()
  const tf = settings.timeFormat || '12h'
  const [items, setItems]     = useState([])
  const [shows, setShows]     = useState([])
  const [events, setEvents]   = useState([])
  const [advances, setAdvances] = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal]     = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm]       = useState(BLANK)
  const [saving, setSaving]   = useState(false)
  const [selectedShow, setSelectedShow] = useState('')
  const [showPastShows, setShowPastShows] = useState(false)
  const [viewMode, setViewMode] = useState('show') // 'show' | 'day'
  const [dayDate, setDayDate]   = useState(todayYmd())

  useEffect(() => {
    Promise.all([
      api.get('/schedule'),
      api.get('/shows'),
      api.get('/advancing').catch(() => ({ data: { data: [] } })),
      api.get('/events').catch(() => ({ data: { data: [] } })),
    ]).then(([sc, s, a, e]) => {
      setItems(sc.data.data || [])
      setShows(s.data.data || [])
      setAdvances(a.data.data || [])
      setEvents(e.data.data || [])
    }).finally(() => setLoading(false))
  }, [])

  async function load() {
    const [sc, s, a, e] = await Promise.all([
      api.get('/schedule'),
      api.get('/shows'),
      api.get('/advancing').catch(() => ({ data: { data: [] } })),
      api.get('/events').catch(() => ({ data: { data: [] } })),
    ])
    setItems(sc.data.data || [])
    setShows(s.data.data || [])
    setAdvances(a.data.data || [])
    setEvents(e.data.data || [])
  }

  // Backfill: when the user picks a show, ensure the standard day-sheet is
  // seeded on the server and any generic "Set 1"/"Set 2" placeholders get
  // renamed with the headliner/support names. Idempotent server-side.
  useEffect(() => {
    if (!selectedShow || loading) return
    const mine = items.filter(i => i.showId === selectedShow)
    const hasGenericSet = mine.some(i => i.label === 'Set 1' || i.label === 'Set 2')
    if (mine.length > 0 && !hasGenericSet) return
    let cancelled = false
    ;(async () => {
      try {
        const { data } = await api.post('/schedule/ensure-defaults', { showId: selectedShow })
        if (!cancelled && ((data?.seeded || 0) > 0 || (data?.renamed || 0) > 0)) await load()
      } catch { /* silent */ }
    })()
    return () => { cancelled = true }
  }, [selectedShow, items, loading])

  function openAdd(preset = {}) {
    setEditing(null)
    setForm({ ...BLANK, ...preset })
    setModal(true)
  }
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

  // Resolve an item's effective date: prefer explicit date, fall back to its show's date.
  const showsById = useMemo(() => {
    const m = new Map()
    for (const s of shows) m.set(String(s.id), s)
    return m
  }, [shows])
  function itemDate(it) {
    return it.date || showsById.get(String(it.showId))?.date || ''
  }

  // "By Show" filter — supports either a single show id, or an "event:<id>"
  // pseudo-value that includes every show attached to the event.
  const filteredByShow = (() => {
    if (!selectedShow) return items.slice().sort(byTime)
    if (selectedShow.startsWith('event:')) {
      const eventId = selectedShow.slice(6)
      const showIds = new Set(shows.filter(s => s.eventId === eventId).map(s => s.id))
      return items
        .filter(i => showIds.has(i.showId))
        .sort((a, b) => (itemDate(a) || '').localeCompare(itemDate(b) || '') || byTime(a, b))
    }
    return items
      .filter(i => i.showId === selectedShow)
      .sort(byTime)
  })()

  // "By Day" filter — every item on the selected date, regardless of show.
  const dayItems = useMemo(() => {
    return items
      .filter(i => itemDate(i) === dayDate)
      .sort(byTime)
  }, [items, dayDate, showsById])
  const dayItemsByStage = useMemo(() => {
    const map = new Map(STAGES.map(s => [s.key, []]))
    for (const it of dayItems) {
      const key = it.stage || 'inside'
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(it)
    }
    return map
  }, [dayItems])
  const showsForDay = useMemo(() => shows.filter(s => s.date === dayDate), [shows, dayDate])
  const showsForDayByStage = useMemo(() => {
    const map = new Map(STAGES.map(s => [s.key, []]))
    for (const s of showsForDay) {
      const key = s.stage || 'inside'
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(s)
    }
    return map
  }, [showsForDay])

  const currentAdvance = selectedShow && !selectedShow.startsWith('event:')
    ? advances.find(a => a.showId === selectedShow)
    : null

  const eventById = useMemo(() => new Map(events.map(e => [e.id, e])), [events])

  // Event context for the current By-Day view: an event whose date range
  // covers the selected dayDate.
  const dayEvent = useMemo(() => {
    for (const ev of events) {
      const start = ev.startDate || null
      const end   = ev.endDate   || ev.startDate
      if (!start) continue
      if (dayDate >= start && dayDate <= (end || start)) return ev
    }
    return null
  }, [events, dayDate])

  // If an Event is selected in the By-Show dropdown, gather its shows.
  const selectedEvent = selectedShow && selectedShow.startsWith('event:')
    ? eventById.get(selectedShow.slice(6))
    : null
  const selectedEventShows = useMemo(() => {
    if (!selectedEvent) return []
    return shows
      .filter(s => s.eventId === selectedEvent.id)
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
  }, [selectedEvent, shows])

  // Print the full day across both stages: one page per stage, run of show.
  function printDaySheetForDay() {
    const pages = []
    for (const stage of STAGES) {
      const rows = dayItemsByStage.get(stage.key) || []
      if (rows.length === 0) continue
      const stageShows = showsForDayByStage.get(stage.key) || []
      const artistLine = stageShows.map(s => s.artist || s.eventName).filter(Boolean).join(' · ')
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
            <h2>${escapeHtml(prettyDateLong(dayDate))}</h2>
            <h3>${escapeHtml(stage.label)}${artistLine ? ` — ${escapeHtml(artistLine)}` : ''}</h3>
          </header>
          <table>${rowsHtml}</table>
        </section>`)
    }
    if (pages.length === 0) { alert('No schedule items to print for this day.'); return }
    openPrintWindow(pages)
  }

  function openPrintWindow(pages) {
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
        header h3 { font-size: 16pt; margin: 6pt 0 0; font-weight: 700; color: #333; }
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

  function handlePrint() {
    if (viewMode === 'day') return printDaySheetForDay()
    // Group filtered items by show so "All Shows" prints one page per show.
    const groups = new Map()
    for (const it of filteredByShow) {
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

    openPrintWindow(pages)
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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 0, border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6, overflow: 'hidden' }}>
            <button
              className={`btn btn-sm ${viewMode === 'show' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setViewMode('show')}
              style={{ borderRadius: 0 }}
            >By Show</button>
            <button
              className={`btn btn-sm ${viewMode === 'day' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setViewMode('day')}
              style={{ borderRadius: 0 }}
            >By Day (both stages)</button>
          </div>
          <button
            className="btn btn-ghost"
            onClick={handlePrint}
            disabled={viewMode === 'day' ? dayItems.length === 0 : filteredByShow.length === 0}
          >🖨 Print Day Sheet</button>
          <button
            className="btn btn-primary"
            onClick={() => openAdd(viewMode === 'day' ? { date: dayDate } : {})}
          >+ Add Item</button>
        </div>
      </div>

      {viewMode === 'show' ? (
        <div className="filter-bar">
          <select value={selectedShow} onChange={e => setSelectedShow(e.target.value)}>
            <option value="">All Shows</option>
            {events.length > 0 && (
              <optgroup label="🎪 Events">
                {events.map(ev => (
                  <option key={ev.id} value={`event:${ev.id}`}>{ev.name} (all shows)</option>
                ))}
              </optgroup>
            )}
            <optgroup label="Individual Shows">
              {upcomingShows.map(s => (
                <option key={s.id} value={s.id}>{s.date} — {s.artist || s.eventName} ({s.stage})</option>
              ))}
            </optgroup>
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'rgba(255,255,255,0.7)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={showPastShows} onChange={e => setShowPastShows(e.target.checked)} />
            Show all (incl. past)
          </label>
        </div>
      ) : (
        <div className="filter-bar" style={{ alignItems: 'center' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setDayDate(shiftYmd(dayDate, -1))}>◀ Prev</button>
          <input
            type="date"
            value={dayDate}
            onChange={e => setDayDate(e.target.value || todayYmd())}
            style={{ maxWidth: 180 }}
          />
          <button className="btn btn-ghost btn-sm" onClick={() => setDayDate(shiftYmd(dayDate, 1))}>Next ▶</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setDayDate(todayYmd())}>Today</button>
          <span style={{ marginLeft: 12, fontSize: 13, color: 'rgba(255,255,255,0.7)' }}>{prettyDateLong(dayDate)}</span>
        </div>
      )}

      {viewMode === 'day' && dayEvent && (
        <div
          className="card"
          style={{
            borderLeft: `4px solid ${dayEvent.color || '#7c3aed'}`,
            display: 'flex', alignItems: 'center', gap: 12, marginTop: 8, padding: '12px 16px',
          }}
        >
          <span style={{ fontSize: 20 }}>🎪</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>{dayEvent.name}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {dayEvent.startDate}{dayEvent.endDate && dayEvent.endDate !== dayEvent.startDate ? ` – ${dayEvent.endDate}` : ''}
              {dayEvent.description ? ` · ${dayEvent.description}` : ''}
            </div>
          </div>
          {dayEvent.startDate && (
            <button className="btn btn-ghost btn-sm" onClick={() => setDayDate(dayEvent.startDate)}>Jump to Day 1</button>
          )}
        </div>
      )}

      {viewMode === 'show' && selectedEvent && (
        <div
          className="card"
          style={{
            borderLeft: `4px solid ${selectedEvent.color || '#7c3aed'}`,
            marginTop: 8, padding: '12px 16px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 20 }}>🎪</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{selectedEvent.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {selectedEventShows.length} show{selectedEventShows.length === 1 ? '' : 's'}
                {selectedEvent.description ? ` · ${selectedEvent.description}` : ''}
              </div>
            </div>
          </div>
          {selectedEventShows.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
              {selectedEventShows.map(s => (
                <button
                  key={s.id}
                  className="btn btn-ghost btn-sm"
                  onClick={() => setSelectedShow(s.id)}
                  title={`${s.artist || s.eventName} · ${s.stage}`}
                >
                  {s.date} · {s.artist || s.eventName}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {viewMode === 'show' ? (
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
                  {filteredByShow.length === 0 && (
                    <tr><td colSpan={7}><div className="empty-state">No schedule items found</div></td></tr>
                  )}
                  {filteredByShow.map(item => (
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
      ) : (
        <div className="day-stage-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 16 }}>
          {loading && <div className="card"><div className="loading">Loading…</div></div>}
          {!loading && STAGES.map(stage => {
            const rows = dayItemsByStage.get(stage.key) || []
            const stageShows = showsForDayByStage.get(stage.key) || []
            return (
              <div key={stage.key} className="card" style={{ display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 8 }}>
                  <div>
                    <span className={`badge badge-${stage.key}`}>{stage.label}</span>
                    <div style={{ marginTop: 6, fontSize: 13, color: 'rgba(255,255,255,0.7)' }}>
                      {stageShows.length === 0
                        ? 'No show scheduled'
                        : stageShows.map(s => `${s.artist || s.eventName}${s.showTime ? ` · ${formatTime(s.showTime, tf)}` : ''}`).join(' + ')}
                    </div>
                  </div>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => openAdd({
                      date: dayDate,
                      stage: stage.key,
                      showId: stageShows[0]?.id || '',
                      showName: stageShows[0] ? `${stageShows[0].date} — ${stageShows[0].artist || stageShows[0].eventName}` : '',
                    })}
                  >+ Add item</button>
                </div>
                {rows.length === 0 ? (
                  <div className="empty-state" style={{ padding: '20px 8px' }}>No items scheduled</div>
                ) : (
                  <table style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th style={{ width: 80 }}>Time</th>
                        <th>Event</th>
                        <th style={{ width: 130 }}>Responsible</th>
                        <th style={{ width: 90 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(item => (
                        <tr key={item.id}>
                          <td><strong>{item.time ? formatTime(item.time, tf) : '—'}</strong></td>
                          <td>
                            <div style={{ fontWeight: 600 }}>{item.label || '—'}</div>
                            {item.showName && <div className="text-muted" style={{ fontSize: 12 }}>{item.showName}</div>}
                            {item.notes && <div className="text-muted" style={{ fontSize: 12, marginTop: 2 }}>{item.notes}</div>}
                          </td>
                          <td className="text-muted">{item.responsible || '—'}</td>
                          <td>
                            <div className="actions-cell">
                              <button className="btn btn-ghost btn-sm" onClick={() => openEdit(item)}>Edit</button>
                              <button className="btn btn-danger btn-sm" onClick={() => handleDelete(item.id)}>Del</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )
          })}
        </div>
      )}

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
              <label>Show (optional)</label>
              <select value={f.showId} onChange={e => {
                const s = shows.find(s => s.id === e.target.value)
                setForm(v => ({
                  ...v,
                  showId: e.target.value,
                  showName: s ? `${s.date} — ${s.artist || s.eventName}` : '',
                  stage: s?.stage || v.stage,
                  date: s?.date || v.date,
                }))
              }}>
                <option value="">— None (facility item) —</option>
                {upcomingShows.map(s => (
                  <option key={s.id} value={s.id}>{s.date} — {s.artist || s.eventName} ({s.stage})</option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Date</label>
                <input type="date" value={f.date} onChange={set('date')} />
              </div>
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
