import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api'
import Modal from '../components/Modal'
import VenueDefaultsCard from '../components/VenueDefaultsCard'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { formatTime } from '../utils/time'
import { getTicketStats } from '../utils/stages'

// Parse YYYY-MM-DD dates as local noon to avoid UTC timezone shifts
const parseDate = d => d ? new Date(d + 'T12:00:00') : null
const startOfToday = () => { const d = new Date(); d.setHours(0,0,0,0); return d }

// Group shows so a multi-night run by the same artist on the same stage
// counts as ONE event. The earliest dated row becomes the representative
// (its id is used for navigation); extra dates are kept on `._dates`.
function groupShowRuns(shows) {
  const buckets = new Map()
  for (const s of shows) {
    const artistKey = (s.artist || s.eventName || '').trim().toLowerCase()
    if (!artistKey) {
      // No artist name — treat as its own event (use id as key)
      buckets.set(`__id__${s.id}`, [s]); continue
    }
    const key = `${artistKey}|${(s.stage || '').toLowerCase()}`
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(s)
  }
  const groups = []
  for (const rows of buckets.values()) {
    rows.sort((a, b) => (parseDate(a.date) || 0) - (parseDate(b.date) || 0))
    const rep = rows[0]
    groups.push({
      ...rep,
      _dates: rows.map(r => r.date).filter(Boolean),
      _allShowIds: rows.map(r => r.id),
      _nights: rows.length,
    })
  }
  return groups
}

function dateRangeLabel(dates) {
  if (!dates || dates.length === 0) return ''
  const ds = dates.map(parseDate).filter(Boolean).sort((a, b) => a - b)
  if (ds.length === 0) return ''
  const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  if (ds.length === 1) return fmt(ds[0])
  // Same month? Show "Jun 12–14"
  const first = ds[0], last = ds[ds.length - 1]
  if (first.getMonth() === last.getMonth()) {
    return `${first.toLocaleDateString('en-US', { month: 'short' })} ${first.getDate()}–${last.getDate()}`
  }
  return `${fmt(first)} – ${fmt(last)}`
}

export default function Dashboard() {
  const { user, effectiveRole } = useAuth()
  const { settings } = useSettings()
  const tf = settings.timeFormat || '12h'
  const navigate = useNavigate()
  const role = effectiveRole || user?.role || ''
  const isCrew     = role === 'crew' || role === 'staff' || role === 'tech'
  const isManager  = role === 'admin' || role === 'production_manager'
  const isPromoter = role === 'promoter'
  const isVenue    = role === 'venue_management'

  const [shows, setShows] = useState([])
  const [labor, setLabor] = useState([])
  const [advancing, setAdvancing] = useState([])
  const [artists, setArtists]     = useState([])
  const [loading, setLoading] = useState(true)
  // Bumped whenever a promoter action saves new data, so the dashboard
  // refresh is independent from the initial fetch.
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const requests = [api.get('/shows')]
    if (isCrew || isManager || isVenue) requests.push(api.get('/labor'))
    else requests.push(null)
    if (isVenue || isManager || isPromoter) requests.push(api.get('/advancing'))
    else requests.push(null)
    if (isPromoter || isManager) {
      requests.push(api.get('/artists').catch(() => ({ data: { data: [] } })))
    } else {
      requests.push(null)
    }
    Promise.all(requests.map(r => r || Promise.resolve(null)))
      .then(results => {
        setShows(results[0].data.data || [])
        if (results[1]) setLabor(results[1].data.data || [])
        if (results[2]) setAdvancing(results[2].data.data || [])
        if (results[3]) setArtists(results[3].data.data || [])
      })
      .finally(() => setLoading(false))
  }, [isCrew, isManager, isVenue, isPromoter, reloadKey])

  if (loading) return <div className="loading">Loading dashboard…</div>

  if (isPromoter) return (
    <PromoterDashboard
      user={user}
      shows={shows}
      advancing={advancing}
      artists={artists}
      navigate={navigate}
      tf={tf}
      onReload={() => setReloadKey(k => k + 1)}
    />
  )
  if (isVenue)    return <VenueDashboard    user={user} shows={shows} labor={labor} advancing={advancing} navigate={navigate} tf={tf} />
  if (isCrew)     return <CrewDashboard     user={user} shows={shows} labor={labor} navigate={navigate} />
  return <ManagerDashboard user={user} shows={shows} labor={labor} navigate={navigate} isManager={isManager} />
}

/* ─────────────────────────────────────────────────────────────── Manager ── */

function ManagerDashboard({ user, shows, labor, navigate, isManager }) {
  const today = startOfToday()
  const upcomingRaw = shows.filter(s => {
    const d = parseDate(s.date); return d && d >= today && s.status !== 'cancelled'
  })
  // Collapse multi-night runs (same artist + stage) into a single event
  const upcoming = useMemo(() => groupShowRuns(upcomingRaw), [shows])
  const thisWeek = upcoming.filter(s => (parseDate(s.date) - today) / 86400000 <= 7)
  const insideShows = upcoming.filter(s => s.stage === 'inside')
  const beachShows  = upcoming.filter(s => s.stage === 'beach')
  const { settings } = useSettings()
  const tf = settings.timeFormat || '12h'

  const todos = useMemo(() => buildTodoList(upcoming, labor), [upcoming, labor])
  const greeting = user?.name ? `Hi ${user.name.split(' ')[0]}` : 'Welcome'

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">{greeting} — here's what needs you</div>
          <div className="page-subtitle">The Windjammer · Inside Stage &amp; Beach Stage</div>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Upcoming Shows</div>
          <div className="stat-value">{upcoming.length}</div>
          <div className="stat-sub">{thisWeek.length} this week</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Inside Stage</div>
          <div className="stat-value" style={{ color: '#60aeff' }}>{insideShows.length}</div>
          <div className="stat-sub">upcoming events</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Beach Stage</div>
          <div className="stat-value" style={{ color: '#4ade80' }}>{beachShows.length}</div>
          <div className="stat-sub">upcoming events</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Action Items</div>
          <div className="stat-value" style={{ color: 'var(--warning)' }}>{todos.length}</div>
          <div className="stat-sub">need attention</div>
        </div>
      </div>

      <div className="two-col-grid">
        <div className="card">
          <div className="card-header">
            <span className="card-title">Shows Requiring Attention</span>
            {isManager && (
              <button className="btn btn-ghost btn-sm" onClick={() => navigate('/advancing')}>Advancing</button>
            )}
          </div>
          {todos.length === 0 ? (
            <div className="empty-state">🎉 All caught up — nothing needs you right now.</div>
          ) : (
            <div style={{ display:'flex', alignItems:'center', gap:16, padding:'12px 4px' }}>
              <span style={{
                display:'inline-flex', alignItems:'center', justifyContent:'center',
                minWidth:64, height:64, padding:'0 14px',
                borderRadius:'50%', background:'rgba(245,158,11,0.15)',
                border:'2px solid var(--warning)', color:'var(--warning)',
                fontSize:28, fontWeight:700, lineHeight:1,
              }}>{todoShowCount(todos)}</span>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:15, fontWeight:600, marginBottom:2 }}>
                  {todoShowCount(todos)} show{todoShowCount(todos) === 1 ? '' : 's'} need{todoShowCount(todos) === 1 ? 's' : ''} attention
                </div>
                <div style={{ fontSize:13, color:'rgba(255,255,255,0.6)' }}>
                  {todos.length} open item{todos.length === 1 ? '' : 's'} across advancing, labor, and prep.
                </div>
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => navigate('/advancing')}>Review</button>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title">This Week</span>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/shows')}>All shows</button>
          </div>
          {thisWeek.length === 0 ? (
            <div className="empty-state">No shows in the next 7 days</div>
          ) : (
            <div className="form-grid">
              {thisWeek.map(show => (
                <ShowRow key={show.id} show={show} tf={tf} onClick={() => navigate(`/shows/${show.id}`)} />
              ))}
            </div>
          )}
        </div>
      </div>

      {isManager && <VenueDefaultsCard compact />}
    </div>
  )
}

function todoShowCount(todos) {
  const ids = new Set()
  for (const t of todos) if (t.showId) ids.add(t.showId)
  return ids.size || todos.length
}

function buildTodoList(upcomingShows, laborRows) {
  const items = []
  const now = startOfToday()
  for (const s of upcomingShows) {
    const showDate = parseDate(s.date)
    const days = showDate ? Math.round((showDate - now) / 86400000) : null
    const dateLabel = days == null ? '' : days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `${days}d`
    const severity = days != null && days <= 3 ? 'high' : days != null && days <= 10 ? 'med' : 'low'
    const runSuffix = s._nights > 1 ? ` (${s._nights} nights)` : ''
    const title = (s.artist || s.eventName || 'Untitled show') + runSuffix
    const showIds = s._allShowIds || [s.id]

    if (s.advancingComplete !== 'true' && s.advancingComplete !== true) {
      const hasContact = s.tourManager || s.promoter || s.advanceEmail
      items.push({
        showId: s.id, kind: 'advancing',
        icon: hasContact ? '✉️' : '📞',
        title: hasContact ? `Advance ${title}` : `Find contact for ${title}`,
        subtitle: hasContact
          ? `Confirm production details with ${s.tourManager || s.promoter || s.advanceEmail}`
          : 'No tour manager / promoter on file yet',
        dateLabel, severity,
      })
    }

    if (!s.showTime && !s.doorsTime) {
      items.push({
        showId: s.id, kind: 'showtime',
        icon: '⏰',
        title: `Add doors / show time — ${title}`,
        subtitle: 'No times set on the show',
        dateLabel, severity,
      })
    }

    if (days != null && days <= 14) {
      // A run is "crewed" if ANY of its dates has labor entries
      const crewCount = laborRows.filter(l => showIds.includes(l.showId)).length
      if (crewCount === 0) {
        items.push({
          showId: s.id, kind: 'crew',
          icon: '👥',
          title: `Schedule crew — ${title}`,
          subtitle: 'No labor entries yet for this show',
          dateLabel, severity,
        })
      }
    }
  }
  const sevRank = { high: 0, med: 1, low: 2 }
  return items.sort((a, b) => sevRank[a.severity] - sevRank[b.severity])
}

function ShowRow({ show, onClick, tf = '12h' }) {
  const isRun = (show._nights || 1) > 1
  const d = parseDate(show.date)
  return (
    <div onClick={onClick} className="week-row">
      <div className="week-date">
        <div className="week-day">{d ? d.getDate() : '—'}</div>
        <div>{d ? d.toLocaleDateString('en-US', { month: 'short' }) : ''}</div>
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>
          {show.artist || show.eventName || '—'}
          {isRun && <span style={{ marginLeft: 6, fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 500 }}>
            · {show._nights} nights ({dateRangeLabel(show._dates)})
          </span>}
        </div>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
          {[show.showTime, show.doorsTime].filter(Boolean).map(t => formatTime(t, tf)).join(' / ') || show.venue || ''}
        </div>
      </div>
      <span className={`badge badge-${show.stage}`}>{show.stage === 'inside' ? 'Inside' : 'Beach'}</span>
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────── Crew ── */

function CrewDashboard({ user, shows, labor, navigate }) {
  const { settings } = useSettings()
  const tf = settings.timeFormat || '12h'
  const today = startOfToday()
  const myName = (user?.name || '').toLowerCase()
  const myId = user?.staffId || ''

  const mine = labor
    .filter(l => (myId && l.staffId === myId) || (myName && (l.workerName || '').toLowerCase() === myName))
    .map(l => {
      const show = shows.find(s => s.id === l.showId)
      return { ...l, _show: show, _date: parseDate(show?.date) }
    })
    .filter(l => l._date && l._date >= today && l._show?.status !== 'cancelled')
    .sort((a, b) => a._date - b._date)

  const next = mine[0]
  const greeting = user?.name ? `Hi ${user.name.split(' ')[0]}` : 'Welcome'

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">{greeting} — your schedule</div>
          <div className="page-subtitle">{mine.length} upcoming call{mine.length === 1 ? '' : 's'}</div>
        </div>
      </div>

      {next && (
        <div className="card next-call-card">
          <div className="next-call-label">Next Call</div>
          <div className="next-call-grid">
            <div>
              <div className="next-call-show">{next._show?.artist || next._show?.eventName || '—'}</div>
              <div className="next-call-meta">
                {next._date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                {next._show?.stage ? ` · ${next._show.stage === 'inside' ? 'Inside Stage' : 'Beach Stage'}` : ''}
              </div>
            </div>
            <div className="next-call-time">
              <div className="next-call-time-value">{next.callTime ? formatTime(next.callTime, tf) : '—'}</div>
              <div className="next-call-time-label">Call</div>
            </div>
          </div>
          <div className="next-call-role">{next.role || 'Crew'}</div>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <span className="card-title">Upcoming Calls</span>
        </div>
        {mine.length === 0 ? (
          <div className="empty-state">
            No upcoming calls on your schedule.<br />
            <small>If you think this is wrong, ask your production manager to add you to a show.</small>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Show</th>
                  <th>Role</th>
                  <th>Call</th>
                  <th>Wrap</th>
                  <th>Stage</th>
                </tr>
              </thead>
              <tbody>
                {mine.map(l => (
                  <tr key={l.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/shows/${l.showId}`)}>
                    <td>
                      <strong>{l._date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</strong>
                    </td>
                    <td>{l._show?.artist || l._show?.eventName || l.showName || '—'}</td>
                    <td>{l.role || '—'}</td>
                    <td>{l.callTime ? formatTime(l.callTime, tf) : '—'}</td>
                    <td>{l.wrapTime ? formatTime(l.wrapTime, tf) : '—'}</td>
                    <td>
                      {l._show?.stage && (
                        <span className={`badge badge-${l._show.stage}`}>
                          {l._show.stage === 'inside' ? 'Inside' : 'Beach'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
/* ────────────────────────────────────────────────────────────── Promoter ── */

/**
 * Promoter view: deliberately simple. The promoter is the least technical
 * person in the workflow — their two jobs are (1) add shows and (2) make sure
 * each artist has an advance contact production can talk to. Everything else
 * on this page is read-only visibility so they can see what's happening.
 */
const QUICK_BLANK = { date: '', artist: '', stage: 'inside', showTime: '', notes: '' }
const CONTACT_BLANK = { contactName: '', contactEmail: '', contactPhone: '' }

function PromoterDashboard({ user, shows, advancing, artists, navigate, tf, onReload }) {
  const today = startOfToday()
  const upcomingRaw = shows.filter(s => {
    const d = parseDate(s.date); return d && d >= today && s.status !== 'cancelled'
  })
  const upcoming = useMemo(() => groupShowRuns(upcomingRaw), [shows])
  const next30 = upcoming.filter(s => (parseDate(s.date) - today) / 86400000 <= 30)
  const greeting = user?.name ? `Hi ${user.name.split(' ')[0]}` : 'Welcome'

  // ─── Quick Add Show ─────────────────────────────────────────────
  const [addOpen, setAddOpen]   = useState(false)
  const [addForm, setAddForm]   = useState(QUICK_BLANK)
  const [addSaving, setAddSaving] = useState(false)
  function openQuickAdd() { setAddForm(QUICK_BLANK); setAddOpen(true) }
  async function saveQuickAdd() {
    if (!addForm.date || !addForm.artist) { alert('Date and Artist are required.'); return }
    setAddSaving(true)
    try {
      await api.post('/shows', { ...addForm, status: 'pending', eventName: addForm.artist })
      setAddOpen(false); onReload()
    } catch (e) {
      alert('Could not add show: ' + (e?.response?.data?.message || e.message))
    } finally { setAddSaving(false) }
  }

  // ─── Connect Contact (per artist) ───────────────────────────────
  const [contactArtist, setContactArtist] = useState(null)
  const [contactForm, setContactForm]     = useState(CONTACT_BLANK)
  const [contactSaving, setContactSaving] = useState(false)
  function openContact(artist) {
    setContactArtist(artist)
    setContactForm({
      contactName:  artist?.contactName  || '',
      contactEmail: artist?.contactEmail || '',
      contactPhone: artist?.contactPhone || '',
    })
  }
  async function saveContact() {
    if (!contactArtist) return
    setContactSaving(true)
    try {
      await api.put(`/artists/${contactArtist.id}`, contactForm)
      setContactArtist(null); onReload()
    } catch (e) {
      alert('Could not save contact: ' + (e?.response?.data?.message || e.message))
    } finally { setContactSaving(false) }
  }
  // Quick-create an artist record from a show that has none on file yet,
  // then immediately open the contact modal for it.
  async function addArtistFromShow(show) {
    const name = (show.artist || show.eventName || '').trim()
    if (!name) { alert('This show has no artist name yet — edit the show first.'); return }
    try {
      const res = await api.post('/artists', { name })
      const artist = res.data?.data || { id: '', name, contactName: '', contactEmail: '', contactPhone: '' }
      openContact(artist)
      onReload()
    } catch (e) {
      alert('Could not create artist: ' + (e?.response?.data?.message || e.message))
    }
  }

  // ─── "Needs contacts" worklist ──────────────────────────────────
  // For every upcoming show: find the artist by name and flag it if no
  // contact email/phone is on file.
  const artistByName = useMemo(() => {
    const m = new Map()
    for (const a of artists) m.set((a.name || '').trim().toLowerCase(), a)
    return m
  }, [artists])
  const needsContact = useMemo(() => upcoming
    .map(s => {
      const name = (s.artist || s.eventName || '').trim()
      if (!name) return { show: s, artist: null, missing: 'name' }
      const a = artistByName.get(name.toLowerCase())
      if (!a) return { show: s, artist: null, missing: 'artist' }
      if (!a.contactEmail && !a.contactPhone) return { show: s, artist: a, missing: 'contact' }
      return null
    })
    .filter(Boolean), [upcoming, artistByName])

  // ─── Advance status per show ─────────────────────────────────────
  const advanceByShow = useMemo(() => {
    const m = new Map()
    for (const a of advancing) m.set(a.showId, a)
    return m
  }, [advancing])

  function advanceStatusFor(show) {
    const adv = advanceByShow.get(show.id)
    if (!adv) return { tag: 'not started', tone: 'low' }
    let extracted = null, schedule = null
    try { extracted = adv.botExtracted ? JSON.parse(adv.botExtracted) : null } catch {}
    try { schedule  = adv.botSchedule  ? JSON.parse(adv.botSchedule)  : null } catch {}
    const fieldCount = extracted ? Object.keys(extracted.fields || {}).length : 0
    const itemCount  = schedule  ? (schedule.items  || []).length             : 0
    if (adv.advancingComplete === 'true' || adv.advancingComplete === true)
      return { tag: 'ready', tone: 'success', detail: 'Production has confirmed.' }
    if (fieldCount || itemCount)
      return {
        tag: 'in progress', tone: 'warning',
        detail: `Bot has ${fieldCount} suggestion${fieldCount === 1 ? '' : 's'}${itemCount ? ` · ${itemCount} schedule item${itemCount === 1 ? '' : 's'}` : ''}.`,
      }
    return { tag: 'advancing', tone: 'inside', detail: adv.botLastRun ? 'Waiting on more info from artist team.' : 'Production has opened the advance.' }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">{greeting}</div>
          <div className="page-subtitle">The Windjammer · promoter overview</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={openQuickAdd}>+ Add Show</button>
          <button className="btn btn-ghost" onClick={() => navigate('/artists')}>Manage Contacts</button>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Upcoming Shows</div>
          <div className="stat-value">{upcoming.length}</div>
          <div className="stat-sub">{next30.length} in next 30 days</div>
        </div>
        <div className="stat-card" style={needsContact.length ? { borderColor: 'var(--warning)' } : null}>
          <div className="stat-label">Needs Advance Contact</div>
          <div className="stat-value" style={{ color: needsContact.length ? 'var(--warning)' : '#86efac' }}>
            {needsContact.length}
          </div>
          <div className="stat-sub">artists production can't reach yet</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Production In Progress</div>
          <div className="stat-value">{upcoming.filter(s => { const t = advanceStatusFor(s).tag; return t === 'in progress' || t === 'advancing' }).length}</div>
          <div className="stat-sub">shows being advanced now</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Production Ready</div>
          <div className="stat-value" style={{ color: '#86efac' }}>{upcoming.filter(s => advanceStatusFor(s).tag === 'ready').length}</div>
          <div className="stat-sub">confirmed by production</div>
        </div>
      </div>

      {/* ── Action item: connect contacts ─────────────────────────── */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">⚠️ Connect Production with Advance Contacts</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Your most important job</span>
        </div>
        {needsContact.length === 0 ? (
          <div className="empty-state">🎉 Every upcoming artist has someone production can reach. You're all set.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Show</th>
                  <th>Status</th>
                  <th style={{ width: 200 }}></th>
                </tr>
              </thead>
              <tbody>
                {needsContact.map(({ show, artist, missing }) => {
                  const d = parseDate(show.date)
                  const dateLabel = d ? d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '—'
                  const label =
                    missing === 'name'    ? 'No artist name on show'   :
                    missing === 'artist'  ? 'Artist not in registry'   :
                                            'No phone or email on file'
                  return (
                    <tr key={show.id + ':' + (artist?.id || missing)}>
                      <td><strong>{dateLabel}</strong></td>
                      <td>{show.artist || show.eventName || '—'}</td>
                      <td><span className="badge badge-warning">{label}</span></td>
                      <td>
                        {missing === 'contact' && (
                          <button className="btn btn-primary btn-sm" onClick={() => openContact(artist)}>
                            Add Contact
                          </button>
                        )}
                        {missing === 'artist' && (
                          <button className="btn btn-primary btn-sm" onClick={() => addArtistFromShow(show)}>
                            Create Artist
                          </button>
                        )}
                        {missing === 'name' && (
                          <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/shows/${show.id}`)}>
                            Open Show
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="two-col-grid">
        {/* ── What production is doing ─────────────────────────────── */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">What Production Is Working On</span>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/shows')}>All shows</button>
          </div>
          {next30.length === 0 ? (
            <div className="empty-state">No shows in the next 30 days.</div>
          ) : (
            <ul className="todo-list">
              {next30.slice(0, 10).map(s => {
                const d = parseDate(s.date)
                const status = advanceStatusFor(s)
                const dateLabel = d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''
                return (
                  <li key={s.id} className="todo-item" onClick={() => navigate(`/shows/${s.id}`)}>
                    <span className={`todo-badge todo-${status.tone === 'success' ? 'low' : status.tone === 'warning' ? 'med' : 'low'}`}>
                      {status.tag === 'ready' ? '✓' : status.tag === 'in progress' ? '⚙️' : '·'}
                    </span>
                    <div className="todo-body">
                      <div className="todo-title">{s.artist || s.eventName || 'Untitled show'}</div>
                      <div className="todo-meta">
                        <span className={`badge badge-${status.tone}`} style={{ marginRight: 6 }}>{status.tag}</span>
                        {status.detail || ''}
                      </div>
                    </div>
                    <span className="todo-date">{dateLabel}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>

      {/* ── Quick-add show modal ────────────────────────────────── */}
      {addOpen && (
        <Modal
          title="Add a Show"
          onClose={() => setAddOpen(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setAddOpen(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveQuickAdd} disabled={addSaving}>
                {addSaving ? 'Saving…' : 'Add Show'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div className="form-row">
              <div className="form-group">
                <label>Date *</label>
                <input type="date" value={addForm.date} onChange={e => setAddForm(f => ({ ...f, date: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>Stage</label>
                <select value={addForm.stage} onChange={e => setAddForm(f => ({ ...f, stage: e.target.value }))}>
                  <option value="inside">Inside Stage</option>
                  <option value="beach">Beach Stage</option>
                </select>
              </div>
            </div>
            <div className="form-group">
              <label>Artist *</label>
              <input value={addForm.artist} placeholder="Headliner / event name" autoFocus
                onChange={e => setAddForm(f => ({ ...f, artist: e.target.value }))} />
            </div>
            <div className="form-group">
              <label>Show Time</label>
              <input type="time" value={addForm.showTime} onChange={e => setAddForm(f => ({ ...f, showTime: e.target.value }))} />
            </div>
            <div className="form-group">
              <label>Notes</label>
              <textarea value={addForm.notes} onChange={e => setAddForm(f => ({ ...f, notes: e.target.value }))} placeholder="Anything production should know up front…" />
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              You can fill in tickets, support, and contacts later from the show page.
            </div>
          </div>
        </Modal>
      )}

      {/* ── Add / edit contact modal ────────────────────────────── */}
      {contactArtist && (
        <Modal
          title={`Advance Contact — ${contactArtist.name || 'Artist'}`}
          onClose={() => setContactArtist(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setContactArtist(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveContact} disabled={contactSaving}>
                {contactSaving ? 'Saving…' : 'Save Contact'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div className="form-group">
              <label>Tour Manager / Contact Name</label>
              <input value={contactForm.contactName} autoFocus
                onChange={e => setContactForm(f => ({ ...f, contactName: e.target.value }))} />
            </div>
            <div className="form-group">
              <label>Email</label>
              <input type="email" value={contactForm.contactEmail}
                onChange={e => setContactForm(f => ({ ...f, contactEmail: e.target.value }))} />
            </div>
            <div className="form-group">
              <label>Phone</label>
              <input value={contactForm.contactPhone}
                onChange={e => setContactForm(f => ({ ...f, contactPhone: e.target.value }))} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Once saved, production can email this contact directly and the bot will start pulling info from their replies.
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}


/* ─────────────────────────────────────────────────────────────── Venue ── */

/**
 * Venue Management view: deliberately minimal for now. The detailed
 * dashboard (occupancy, revenue indicators, etc.) is planned for a later
 * pass — this stub keeps the role usable in the meantime.
 */
function VenueDashboard({ user, shows, labor, advancing, navigate }) {
  const today = startOfToday()
  const upcomingShows = shows.filter(s => {
    const d = parseDate(s.date); return d && d >= today && s.status !== 'cancelled'
  })
  const upcoming = useMemo(() => groupShowRuns(upcomingShows), [shows])
  const thisWeek = upcoming.filter(s => (parseDate(s.date) - today) / 86400000 <= 7)
  const greeting = user?.name ? `Hi ${user.name.split(' ')[0]}` : 'Welcome'

  // Per-show labor cost (only counts shows that haven't passed yet)
  const upcomingShowIds = new Set(upcomingShows.map(s => s.id))
  const laborByShow = useMemo(() => {
    const m = new Map()
    for (const l of labor) {
      if (!upcomingShowIds.has(l.showId)) continue
      const rate = parseFloat(l.rate || 0) || 0
      const amt = (l.payType || 'day') === 'day'
        ? (parseFloat(l.days  || 0) || 0) * rate
        : (parseFloat(l.hours || 0) || 0) * rate
      const cur = m.get(l.showId) || { cost: 0, count: 0 }
      m.set(l.showId, { cost: cur.cost + amt, count: cur.count + 1 })
    }
    return m
  }, [labor, shows])

  const totalUpcomingLabor = Array.from(laborByShow.values()).reduce((s, v) => s + v.cost, 0)
  const thisWeekLabor = thisWeek.reduce((s, show) => s + (laborByShow.get(show.id)?.cost || 0), 0)

  // Advance review queue: anything not yet approved on an upcoming show
  const reviewQueue = useMemo(() => {
    return (advancing || [])
      .filter(a => upcomingShowIds.has(a.showId))
      .map(a => ({
        ...a,
        show: shows.find(s => s.id === a.showId),
      }))
      .filter(a => a.show)
      .sort((a, b) => new Date(a.show.date) - new Date(b.show.date))
  }, [advancing, shows])

  const pendingReview = reviewQueue.filter(a => (a.mgmtStatus || 'pending') === 'pending')
  const changesRequested = reviewQueue.filter(a => a.mgmtStatus === 'changes_requested')

  const fmtMoney = n => `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">{greeting} — venue overview</div>
          <div className="page-subtitle">The Windjammer · management snapshot</div>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Upcoming Shows</div>
          <div className="stat-value">{upcoming.length}</div>
          <div className="stat-sub">{thisWeek.length} this week</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Labor — This Week</div>
          <div className="stat-value" style={{ color: '#16a34a' }}>{fmtMoney(thisWeekLabor)}</div>
          <div className="stat-sub">scheduled crew cost</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Labor — All Upcoming</div>
          <div className="stat-value" style={{ color: '#16a34a' }}>{fmtMoney(totalUpcomingLabor)}</div>
          <div className="stat-sub">across {upcoming.length} show{upcoming.length !== 1 ? 's' : ''}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Advances Awaiting Review</div>
          <div className="stat-value" style={{ color: pendingReview.length ? 'var(--warning)' : 'inherit' }}>{pendingReview.length}</div>
          <div className="stat-sub">{changesRequested.length} flagged for changes</div>
        </div>
      </div>

      <div className="two-col-grid">
        <div className="card">
          <div className="card-header">
            <span className="card-title">Advance Reviews</span>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/advancing')}>Open Advancing</button>
          </div>
          {reviewQueue.length === 0 ? (
            <div className="empty-state">No upcoming advances to review.</div>
          ) : (
            <ul className="todo-list">
              {reviewQueue.slice(0, 8).map(a => {
                const status = a.mgmtStatus || 'pending'
                const badge = status === 'approved'
                  ? { txt: '✅ Approved', bg: '#d1fae5', fg: '#065f46' }
                  : status === 'changes_requested'
                    ? { txt: '⚠️ Changes', bg: '#fee2e2', fg: '#991b1b' }
                    : { txt: '⏳ Pending', bg: '#e5e7eb', fg: '#374151' }
                return (
                  <li key={a.id} className="todo-item" onClick={() => navigate('/advancing')}>
                    <span className="todo-badge" style={{ background: badge.bg, color: badge.fg }}>{badge.txt.split(' ')[0]}</span>
                    <div className="todo-body">
                      <div className="todo-title">{a.show.artist || a.show.eventName || a.showName}</div>
                      <div className="todo-meta">
                        {a.show.date} · {a.show.stage === 'inside' ? 'Inside Stage' : 'Beach Stage'}
                        {a.advanceContact ? ` · ${a.advanceContact}` : ''}
                      </div>
                    </div>
                    <span className="badge" style={{ background: badge.bg, color: badge.fg }}>{badge.txt}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title">Labor Cost by Show</span>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/shows')}>All shows</button>
          </div>
          {upcoming.length === 0 ? (
            <div className="empty-state">No upcoming shows.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Show</th>
                    <th>Stage</th>
                    <th style={{ textAlign: 'right' }}>Crew</th>
                    <th style={{ textAlign: 'right' }}>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {upcoming.slice(0, 10).map(s => {
                    const info = laborByShow.get(s.id) || { cost: 0, count: 0 }
                    return (
                      <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/shows/${s.id}`)}>
                        <td className="text-muted">{s.date}</td>
                        <td><strong>{s.artist || s.eventName || '—'}</strong></td>
                        <td><span className={`badge badge-${s.stage}`}>{s.stage === 'inside' ? 'Inside' : 'Beach'}</span></td>
                        <td style={{ textAlign: 'right' }} className="text-muted">{info.count || '—'}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: info.cost > 0 ? '#16a34a' : 'var(--text-muted)' }}>
                          {info.cost > 0 ? fmtMoney(info.cost) : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
