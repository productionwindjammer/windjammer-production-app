import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api'
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
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const requests = [api.get('/shows')]
    if (isCrew || isManager || isVenue) requests.push(api.get('/labor'))
    else requests.push(null)
    if (isVenue || isManager) requests.push(api.get('/advancing'))
    else requests.push(null)
    Promise.all(requests.map(r => r || Promise.resolve(null)))
      .then(results => {
        setShows(results[0].data.data || [])
        if (results[1]) setLabor(results[1].data.data || [])
        if (results[2]) setAdvancing(results[2].data.data || [])
      })
      .finally(() => setLoading(false))
  }, [isCrew, isManager, isVenue])

  if (loading) return <div className="loading">Loading dashboard…</div>

  if (isPromoter) return <PromoterDashboard user={user} shows={shows} navigate={navigate} tf={tf} />
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
            <span className="card-title">Your To-Do List</span>
            {isManager && (
              <button className="btn btn-ghost btn-sm" onClick={() => navigate('/advancing')}>Advancing</button>
            )}
          </div>
          {todos.length === 0 ? (
            <div className="empty-state">🎉 All caught up — no open action items.</div>
          ) : (
            <ul className="todo-list">
              {todos.map(t => (
                <li key={`${t.showId}-${t.kind}`} className="todo-item" onClick={() => navigate(`/shows/${t.showId}`)}>
                  <span className={`todo-badge todo-${t.severity}`}>{t.icon}</span>
                  <div className="todo-body">
                    <div className="todo-title">{t.title}</div>
                    <div className="todo-meta">{t.subtitle}</div>
                  </div>
                  <span className="todo-date">{t.dateLabel}</span>
                </li>
              ))}
            </ul>
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
    </div>
  )
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
 * Promoter view: focuses on the four things a promoter actually opens the
 * app for — ticket sales pace, shows still needing attention (status not yet
 * confirmed / missing times), the upcoming week at a glance, and a roll-up
 * of recently advanced shows that are now production-ready.
 *
 * The single in-house promoter sees ALL upcoming shows here; clicking any
 * row jumps to that show's detail page where they can edit dates, ticket
 * counts, status, and TM contact info (write access is granted server-side).
 */
function PromoterDashboard({ user, shows, navigate, tf }) {
  const today = startOfToday()
  const upcomingRaw = shows.filter(s => {
    const d = parseDate(s.date); return d && d >= today && s.status !== 'cancelled'
  })
  const upcoming = useMemo(() => groupShowRuns(upcomingRaw), [shows])
  const thisWeek = upcoming.filter(s => (parseDate(s.date) - today) / 86400000 <= 7)

  // "Needs attention" = not yet confirmed/settled, OR missing doors/show time,
  //                     OR no TM/promoter contact on file.
  const needsAttention = upcoming
    .map(s => {
      const reasons = []
      const stat = (s.status || 'pending').toLowerCase()
      if (stat === 'pending' || stat === 'advancing') reasons.push(stat === 'pending' ? 'Hold — not confirmed' : 'Advancing')
      if (!s.showTime && !s.doorsTime) reasons.push('No doors / show time')
      if (!s.tourManager && !s.promoter && !s.advanceEmail && !s.advanceContact) reasons.push('No advance contact')
      return reasons.length ? { ...s, _reasons: reasons } : null
    })
    .filter(Boolean)
    .slice(0, 12)

  const recentlyAdvanced = upcoming
    .filter(s => s.advancingComplete === 'true' || s.advancingComplete === true)
    .slice(0, 8)

  // Sales totals over the next 14 days — useful pulse for promoter
  const next14 = upcoming.filter(s => (parseDate(s.date) - today) / 86400000 <= 14)
  const salesPulse = next14.reduce((acc, s) => {
    const { sold, capacity } = getTicketStats(s)
    acc.sold     += sold
    acc.capacity += (capacity || 0)
    return acc
  }, { sold: 0, capacity: 0 })
  const pulsePct = salesPulse.capacity
    ? Math.round((salesPulse.sold / salesPulse.capacity) * 100)
    : null

  const greeting = user?.name ? `Hi ${user.name.split(' ')[0]}` : 'Welcome'

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">{greeting} — promoter overview</div>
          <div className="page-subtitle">The Windjammer · all upcoming shows</div>
        </div>
        <button className="btn btn-primary" onClick={() => navigate('/shows')}>+ Manage shows</button>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Upcoming Shows</div>
          <div className="stat-value">{upcoming.length}</div>
          <div className="stat-sub">{thisWeek.length} this week</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Needs Attention</div>
          <div className="stat-value" style={{ color: 'var(--warning)' }}>{needsAttention.length}</div>
          <div className="stat-sub">holds, missing times, etc.</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Sales (next 14 days)</div>
          <div className="stat-value">{salesPulse.sold.toLocaleString()}</div>
          <div className="stat-sub">
            {salesPulse.capacity
              ? `of ${salesPulse.capacity.toLocaleString()} cap · ${pulsePct}%`
              : 'no capacity data'}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Production-Ready</div>
          <div className="stat-value" style={{ color: '#86efac' }}>{recentlyAdvanced.length}</div>
          <div className="stat-sub">advanced & confirmed</div>
        </div>
      </div>

      <div className="two-col-grid">
        <div className="card">
          <div className="card-header">
            <span className="card-title">Needs Your Attention</span>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/shows')}>All shows</button>
          </div>
          {needsAttention.length === 0 ? (
            <div className="empty-state">🎉 Every upcoming show is confirmed and contacts on file.</div>
          ) : (
            <ul className="todo-list">
              {needsAttention.map(s => {
                const d = parseDate(s.date)
                const days = d ? Math.round((d - today) / 86400000) : null
                const dateLabel = days == null ? '' : days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `${days}d`
                const severity = days != null && days <= 7 ? 'high' : days != null && days <= 21 ? 'med' : 'low'
                return (
                  <li key={s.id} className="todo-item" onClick={() => navigate(`/shows/${s.id}`)}>
                    <span className={`todo-badge todo-${severity}`}>⚠️</span>
                    <div className="todo-body">
                      <div className="todo-title">{s.artist || s.eventName || 'Untitled show'}</div>
                      <div className="todo-meta">{s._reasons.join(' · ')}</div>
                    </div>
                    <span className="todo-date">{dateLabel}</span>
                  </li>
                )
              })}
            </ul>
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

      <div className="card">
        <div className="card-header">
          <span className="card-title">Ticket Sales</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Click any show to update sold count</span>
        </div>
        {upcoming.length === 0 ? (
          <div className="empty-state">No upcoming shows on the books.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Artist</th>
                  <th>Stage</th>
                  <th>Sold / Cap</th>
                  <th style={{ width: '28%' }}>% Sold</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {upcoming.map(s => {
                  const d = parseDate(s.date)
                  const { sold, capacity, pct } = getTicketStats(s)
                  const stat = (s.status || 'pending').toLowerCase()
                  const isRun = (s._nights || 1) > 1
                  const barColor = pct == null ? '#666' : pct >= 80 ? '#22c55e' : pct >= 40 ? '#eab308' : '#ef4444'
                  return (
                    <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/shows/${s.id}`)}>
                      <td>
                        <strong>{d ? d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '—'}</strong>
                        {isRun && (
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            {s._nights} nights ({dateRangeLabel(s._dates)})
                          </div>
                        )}
                      </td>
                      <td>{s.artist || s.eventName || '—'}</td>
                      <td>
                        {s.stage && (
                          <span className={`badge badge-${s.stage}`}>
                            {s.stage === 'inside' ? 'Inside' : 'Beach'}
                          </span>
                        )}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <strong>{sold.toLocaleString()}</strong>
                        {capacity ? <span style={{ color: 'var(--text-muted)' }}> / {capacity.toLocaleString()}</span> : null}
                      </td>
                      <td>
                        {pct == null ? (
                          <span className="text-muted" style={{ fontSize: 12 }}>—</span>
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 3, overflow: 'hidden' }}>
                              <div style={{ width: `${pct}%`, height: '100%', background: barColor, transition: 'width 0.3s' }} />
                            </div>
                            <span style={{ fontSize: 12, fontWeight: 600, minWidth: 34, textAlign: 'right' }}>{pct}%</span>
                          </div>
                        )}
                      </td>
                      <td>
                        <span className={`badge badge-${stat}`} style={{ textTransform: 'capitalize' }}>{stat}</span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Recently Advanced</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Production has these ready</span>
        </div>
        {recentlyAdvanced.length === 0 ? (
          <div className="empty-state">No shows have been advanced yet.</div>
        ) : (
          <ul className="todo-list">
            {recentlyAdvanced.map(s => {
              const d = parseDate(s.date)
              const dateLabel = d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''
              return (
                <li key={s.id} className="todo-item" onClick={() => navigate(`/shows/${s.id}`)}>
                  <span className="todo-badge todo-low">✓</span>
                  <div className="todo-body">
                    <div className="todo-title">{s.artist || s.eventName || 'Untitled show'}</div>
                    <div className="todo-meta">
                      {s.stage === 'inside' ? 'Inside Stage' : s.stage === 'beach' ? 'Beach Stage' : ''}
                      {s.showTime ? ` · Show ${formatTime(s.showTime, tf)}` : ''}
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
