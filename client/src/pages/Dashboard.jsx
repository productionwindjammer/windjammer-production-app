import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api'
import Modal from '../components/Modal'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { useVenue } from '../context/VenueContext'
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
  const isCrew         = role === 'crew' || role === 'staff' || role === 'tech'
  const isManager      = role === 'admin' || role === 'production_manager'
  const isStageManager = role === 'stage_manager'
  const isPromoter     = role === 'promoter'
  const isVenue        = role === 'venue_management'

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
    if (isCrew || isManager || isStageManager || isVenue) requests.push(api.get('/labor'))
    else requests.push(null)
    if (isVenue || isManager || isStageManager || isPromoter) requests.push(api.get('/advancing'))
    else requests.push(null)
    if (isPromoter || isManager || isStageManager) {
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
  }, [isCrew, isManager, isStageManager, isVenue, isPromoter, reloadKey])

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
  return <ManagerDashboard user={user} shows={shows} labor={labor} navigate={navigate} isManager={isManager} isStageManager={isStageManager} />
}

/* ─────────────────────────────────────────────────────────────── Manager ── */

function ManagerDashboard({ user, shows, labor, navigate, isManager, isStageManager }) {
  const today = startOfToday()
  const upcomingRaw = shows.filter(s => {
    const d = parseDate(s.date); return d && d >= today && s.status !== 'cancelled'
  })
  // Collapse multi-night runs (same artist + stage) into a single event
  const upcoming = useMemo(() => groupShowRuns(upcomingRaw), [shows])
  const thisWeek = upcoming.filter(s => (parseDate(s.date) - today) / 86400000 <= 7)
  const next30   = upcoming.filter(s => (parseDate(s.date) - today) / 86400000 <= 30)
  const insideShows = upcoming.filter(s => s.stage === 'inside')
  const beachShows  = upcoming.filter(s => s.stage === 'beach')
  const { settings } = useSettings()
  const { venue } = useVenue()
  const tf = settings.timeFormat || '12h'

  // Stage Manager doesn't drive advancing/labor triage, so skip the todo list
  // entirely for them — no Action Items stat, no Needs Attention panel.
  const todos = useMemo(
    () => (isStageManager ? [] : buildTodoList(upcoming, labor)),
    [upcoming, labor, isStageManager],
  )
  const laborByShow = useMemo(() => {
    const m = new Map()
    for (const l of labor) {
      const cur = m.get(l.showId) || 0
      m.set(l.showId, cur + 1)
    }
    return m
  }, [labor])
  const greeting = user?.name ? `Hi ${user.name.split(' ')[0]}` : 'Welcome'

  // ─── Quick Add Show (Operations Center) ─────────────────────────
  const [addOpen, setAddOpen]     = useState(false)
  const [addForm, setAddForm]     = useState(QUICK_BLANK)
  const [addSaving, setAddSaving] = useState(false)
  const [addError, setAddError]   = useState('')
  function openQuickAdd() { setAddForm(QUICK_BLANK); setAddError(''); setAddOpen(true) }
  async function saveQuickAdd() {
    if (!addForm.date || !addForm.artist) { setAddError('Date and Artist are required.'); return }
    setAddSaving(true); setAddError('')
    try {
      await api.post('/shows', { ...addForm, status: 'confirmed', eventName: addForm.artist })
      setAddOpen(false)
      // Simple refresh — take the manager to the shows list so they see it.
      navigate('/shows')
    } catch (e) {
      setAddError(e?.response?.data?.message || e.message || 'Could not add show')
    } finally { setAddSaving(false) }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">{greeting} — here's what needs you</div>
          <div className="page-subtitle">The Windjammer · Inside Stage &amp; Beach Stage</div>
        </div>
        <button className="btn btn-primary" onClick={openQuickAdd}>+ Add Show</button>
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
        {!isStageManager && (
          <div className="stat-card">
            <div className="stat-label">Action Items</div>
            <div className="stat-value" style={{ color: 'var(--warning)' }}>{todos.length}</div>
            <div className="stat-sub">need attention</div>
          </div>
        )}
      </div>

      <OperationsCenter
        todos={todos}
        navigate={navigate}
        onAddShow={openQuickAdd}
        isManager={isManager}
        isStageManager={isStageManager}
      />

      <div className="card">
        <div className="card-header">
          <span className="card-title">Next 30 Days</span>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/shows')}>All shows</button>
        </div>
        {next30.length === 0 ? (
          <div className="empty-state">No shows in the next 30 days</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {next30.map(show => (
              <DetailedShowRow
                key={show.id}
                show={show}
                tf={tf}
                venue={venue}
                today={today}
                crewCount={(show._allShowIds || [show.id]).reduce((n, id) => n + (laborByShow.get(id) || 0), 0)}
                onClick={() => navigate(`/shows/${show.id}`)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Quick-add show modal (Operations Center) ─────────────── */}
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
              <textarea value={addForm.notes} onChange={e => setAddForm(f => ({ ...f, notes: e.target.value }))} placeholder="Anything the team should know up front…" />
            </div>
            {addError && <div className="error-msg">{addError}</div>}
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Details like tickets, support, and contacts can be filled in from the show page.
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

/**
 * Operations Center — quick-launch actions plus a triage list of the
 * top items needing the PM's attention. Replaces the venue-defaults
 * card on the manager dashboard; venue defaults live on Settings.
 * Stage Manager sees the same quick actions minus financial pages
 * (Vendors, Staff) and without the Needs Attention triage list.
 */
function OperationsCenter({ todos, navigate, onAddShow, isManager, isStageManager }) {
  const topTodos = todos.slice(0, 5)
  const actions = [
    { icon: '➕', label: 'Add Show',    hint: 'Quick add',      onClick: onAddShow,                      primary: true },
    !isStageManager && { icon: '👥', label: 'Add Staff',   hint: 'Crew & techs',   onClick: () => navigate('/staff') },
    !isStageManager && { icon: '✉️', label: 'Invite User', hint: 'Accounts',       onClick: () => navigate('/users') },
    { icon: '👷', label: 'Labor',       hint: 'Crew & calls',   onClick: () => navigate('/labor') },
    { icon: '🎭', label: 'Artists',     hint: 'Roster',         onClick: () => navigate('/artists') },
    !isStageManager && { icon: '🏢', label: 'Vendors',     hint: 'Suppliers',      onClick: () => navigate('/vendors') },
    { icon: '📋', label: 'Advancing',   hint: 'Production',     onClick: () => navigate('/advancing') },
    { icon: '🎬', label: 'Day of Show', hint: 'Run of show',    onClick: () => navigate('/day-of-show') },
    { icon: '📄', label: 'Tech Pack',   hint: 'Docs',           onClick: () => navigate('/tech-pack') },
  ].filter(Boolean)

  // Stage Manager sees only the quick-actions column — no triage list.
  const showTodos = !isStageManager

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Operations Center</span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {showTodos ? 'Quick actions & open items' : 'Quick actions'}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: showTodos ? 'minmax(0, 1.35fr) minmax(0, 1fr)' : 'minmax(0, 1fr)', gap: 20 }}>
        {/* ── Quick Actions ────────────────────────────────────── */}
        <div>
          <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', fontWeight: 600, marginBottom: 10 }}>
            Quick Actions
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 10 }}>
            {actions.map(a => (
              <button
                key={a.label}
                type="button"
                onClick={a.onClick}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4,
                  padding: '12px 14px',
                  borderRadius: 10,
                  border: `1px solid ${a.primary ? 'var(--accent)' : 'var(--border)'}`,
                  background: a.primary ? 'rgba(59,130,246,0.12)' : 'rgba(255,255,255,0.02)',
                  color: 'var(--text)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'background 0.15s, border-color 0.15s',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.background = a.primary ? 'rgba(59,130,246,0.2)' : 'rgba(255,255,255,0.06)'
                  e.currentTarget.style.borderColor = a.primary ? 'var(--accent)' : 'rgba(255,255,255,0.2)'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = a.primary ? 'rgba(59,130,246,0.12)' : 'rgba(255,255,255,0.02)'
                  e.currentTarget.style.borderColor = a.primary ? 'var(--accent)' : 'var(--border)'
                }}
              >
                <span style={{ fontSize: '1.25rem', lineHeight: 1 }}>{a.icon}</span>
                <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>{a.label}</span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{a.hint}</span>
              </button>
            ))}
          </div>
        </div>

        {/* ── Needs Attention ──────────────────────────────────── */}
        {showTodos && (
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', fontWeight: 600 }}>
                Needs Attention
              </div>
              {isManager && todos.length > topTodos.length && (
                <button className="btn btn-ghost btn-sm" onClick={() => navigate('/advancing')}>
                  See all {todos.length}
                </button>
              )}
            </div>
            {topTodos.length === 0 ? (
              <div className="empty-state" style={{ padding: '20px 12px', fontSize: '0.85rem' }}>
                🎉 All caught up — nothing needs you right now.
              </div>
            ) : (
              <ul className="todo-list">
                {topTodos.map((t, i) => (
                  <li
                    key={`${t.showId}-${t.kind}-${i}`}
                    className="todo-item"
                    onClick={() => navigate(`/shows/${t.showId}`)}
                  >
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
        )}
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

/**
 * Full-width detailed row used by the manager dashboard's "Next 30 Days"
 * view. Shows date, artist / run info, times, ticket status, advance
 * progress, crew count, and contact — enough for a PM to triage at a
 * glance without clicking into each show.
 */
function DetailedShowRow({ show, onClick, tf = '12h', venue, today, crewCount = 0 }) {
  const isRun = (show._nights || 1) > 1
  const d = parseDate(show.date)
  const days = d && today ? Math.round((d - today) / 86400000) : null
  const inLabel = days == null ? '' : days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `in ${days}d`
  const stageRgb = show.stage === 'inside' ? '96,174,255' : '74,222,128'
  const { sold, capacity, pct } = getTicketStats(show, venue)
  const advanceDone = show.advancingComplete === true || show.advancingComplete === 'true'
  const hasContact  = !!(show.tourManager || show.promoter || show.advanceEmail)
  const contactLabel = show.tourManager || show.promoter || show.advanceEmail || ''

  return (
    <div
      onClick={onClick}
      style={{
        display: 'grid',
        gridTemplateColumns: '72px 1fr auto',
        gap: 16,
        alignItems: 'center',
        padding: '14px 16px',
        borderRadius: 10,
        border: `1px solid rgba(${stageRgb}, 0.25)`,
        background: `linear-gradient(135deg, rgba(${stageRgb},0.08) 0%, rgba(255,255,255,0.02) 100%)`,
        cursor: 'pointer',
        transition: 'background 0.15s, border-color 0.15s',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = `rgba(${stageRgb}, 0.55)` }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = `rgba(${stageRgb}, 0.25)` }}
    >
      {/* Date block */}
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', fontWeight: 600 }}>
          {d ? d.toLocaleDateString('en-US', { weekday: 'short' }) : ''}
        </div>
        <div style={{ fontSize: '1.6rem', fontWeight: 700, lineHeight: 1.1, color: 'var(--text)' }}>
          {d ? d.getDate() : '—'}
        </div>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
          {d ? d.toLocaleDateString('en-US', { month: 'short' }) : ''}
        </div>
        {inLabel && (
          <div style={{ marginTop: 4, fontSize: '0.65rem', fontWeight: 600, color: days != null && days <= 3 ? 'var(--warning)' : 'var(--text-muted)' }}>
            {inLabel}
          </div>
        )}
      </div>

      {/* Main info */}
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
          <span style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text)' }}>
            {show.artist || show.eventName || 'Untitled show'}
          </span>
          <span className={`badge badge-${show.stage}`}>{show.stage === 'inside' ? 'Inside' : 'Beach'}</span>
          {show.status && show.status !== 'confirmed' && (
            <span className={`badge badge-${show.status}`}>{show.status}</span>
          )}
          {isRun && (
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 500 }}>
              · {show._nights} nights ({dateRangeLabel(show._dates)})
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
          {show.showTime  && <span>🕐 Show {formatTime(show.showTime, tf)}</span>}
          {show.doorsTime && <span>🚪 Doors {formatTime(show.doorsTime, tf)}</span>}
          {!show.showTime && !show.doorsTime && <span style={{ color: 'var(--warning)' }}>⏰ No times set</span>}
          {hasContact
            ? <span>🎭 {contactLabel}</span>
            : <span style={{ color: 'var(--warning)' }}>📞 No contact</span>}
          {show.ticketPrice && <span>💵 ${show.ticketPrice}</span>}
        </div>
        {show.notes && (
          <div style={{ marginTop: 6, fontSize: '0.75rem', color: 'rgba(255,255,255,0.5)', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {show.notes}
          </div>
        )}
      </div>

      {/* Right-side stats */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end', minWidth: 130 }}>
        {(capacity || sold > 0) && (
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'right' }}>
            🎟 <strong style={{ color: 'var(--text)' }}>{sold}</strong>{capacity ? ` / ${capacity}` : ''}
            {pct != null && (
              <span style={{ marginLeft: 6, fontWeight: 700, color: pct >= 80 ? '#86efac' : pct >= 40 ? '#fde68a' : '#fca5a5' }}>
                {pct}%
              </span>
            )}
          </div>
        )}
        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
          👥 <strong style={{ color: crewCount > 0 ? 'var(--text)' : 'var(--warning)' }}>{crewCount}</strong> crew
        </div>
        <span
          className={`badge badge-${advanceDone ? 'success' : hasContact ? 'warning' : 'inside'}`}
          style={{ fontSize: '0.68rem' }}
        >
          {advanceDone ? '✓ Advanced' : hasContact ? 'Advancing' : 'Needs contact'}
        </span>
      </div>
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
