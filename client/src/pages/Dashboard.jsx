import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { formatTime } from '../utils/time'

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
  const { user } = useAuth()
  const { settings } = useSettings()
  const tf = settings.timeFormat || '12h'
  const navigate = useNavigate()
  const role = user?.role || ''
  const isCrew = role === 'crew' || role === 'staff' || role === 'tech'
  const isManager = role === 'admin' || role === 'production_manager'

  const [shows, setShows] = useState([])
  const [labor, setLabor] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const requests = [api.get('/shows')]
    if (isCrew || isManager) requests.push(api.get('/labor'))
    Promise.all(requests)
      .then(results => {
        setShows(results[0].data.data || [])
        if (results[1]) setLabor(results[1].data.data || [])
      })
      .finally(() => setLoading(false))
  }, [isCrew, isManager])

  if (loading) return <div className="loading">Loading dashboard…</div>

  return isCrew
    ? <CrewDashboard user={user} shows={shows} labor={labor} navigate={navigate} />
    : <ManagerDashboard user={user} shows={shows} labor={labor} navigate={navigate} isManager={isManager} />
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
                <ShowRow key={show.id} show={show} onClick={() => navigate(`/shows/${show.id}`)} />
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

function ShowRow({ show, onClick }) {
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
