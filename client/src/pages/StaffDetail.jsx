import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import api from '../api'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { formatTime } from '../utils/time'
import { hasFinancialAccess } from '../utils/roles'

// Parse a YYYY-MM-DD (or ISO) date string as local noon so downstream
// comparisons don't get bitten by UTC offsets.
const parseDate = d => {
  if (!d) return null
  const s = String(d)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T12:00:00')
  const dt = new Date(s)
  return Number.isNaN(dt.getTime()) ? null : dt
}

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d }

function parseRates(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : [] }
  catch { return [] }
}

function tenureLabel(startDate) {
  const d = parseDate(startDate)
  if (!d) return '—'
  const now = new Date()
  const months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth())
  if (months < 1)  return 'less than 1 month'
  if (months < 12) return `${months} month${months === 1 ? '' : 's'}`
  const years = Math.floor(months / 12)
  const rem   = months % 12
  return rem === 0
    ? `${years} year${years === 1 ? '' : 's'}`
    : `${years}y ${rem}mo`
}

function rowCost(row) {
  const rate = parseFloat(row?.rate)
  if (!Number.isFinite(rate)) return parseFloat(row?.total || 0) || 0
  if ((row.payType || 'hour') === 'day') {
    const d = parseFloat(row.days || '1')
    return (Number.isFinite(d) ? d : 1) * rate
  }
  const h = parseFloat(row.hours)
  return (Number.isFinite(h) ? h : 0) * rate
}

export default function StaffDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { settings } = useSettings()
  const { user, effectiveRole } = useAuth()
  const tf = settings.timeFormat || '12h'
  const role = effectiveRole || user?.role || ''
  const canSeeFinancials = hasFinancialAccess(role)

  const [staff,   setStaff]   = useState(null)
  const [labor,   setLabor]   = useState([])
  const [shows,   setShows]   = useState([])
  const [loading, setLoading] = useState(true)
  const [tab,     setTab]     = useState('overview')
  const [error,   setError]   = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      api.get('/staff'),
      api.get('/labor'),
      api.get('/shows').catch(() => ({ data: { data: [] } })),
    ])
      .then(([staffRes, laborRes, showsRes]) => {
        if (cancelled) return
        const list = staffRes.data.data || []
        const found = list.find(s => String(s.id) === String(id))
        if (!found) {
          setError('Staff member not found.')
        } else {
          setStaff(found)
        }
        setLabor((laborRes.data.data || []).filter(l => String(l.staffId) === String(id)))
        setShows(showsRes.data.data || [])
      })
      .catch(err => setError(err?.response?.data?.message || err.message || 'Failed to load staff'))
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id])

  // ── Derived data ────────────────────────────────────────────────
  const today = startOfToday()
  const showById = useMemo(() => {
    const m = new Map()
    for (const s of shows) m.set(String(s.id), s)
    return m
  }, [shows])

  // Enrich labor rows with the show date (for sorting) + human labels.
  const enriched = useMemo(() => labor.map(row => {
    const show = row.showId ? showById.get(String(row.showId)) : null
    const dateStr = show?.date || (row.createdAt ? String(row.createdAt).slice(0, 10) : '')
    const d = parseDate(dateStr)
    return { ...row, _show: show, _date: d, _dateStr: dateStr, _cost: rowCost(row) }
  }), [labor, showById])

  const sorted   = useMemo(() => [...enriched].sort((a, b) => (b._date || 0) - (a._date || 0)), [enriched])
  const upcoming = useMemo(() => sorted.filter(r => r._date && r._date >= today).reverse(), [sorted, today])
  const past     = useMemo(() => sorted.filter(r => !r._date || r._date < today), [sorted, today])

  // Cost totals for the Pay tab
  const totals = useMemo(() => {
    const now  = new Date()
    const yStart = new Date(now.getFullYear(), 0, 1)
    const d30    = new Date(now.getTime() - 30 * 86400000)
    let lifetime = 0, ytd = 0, last30 = 0, shiftCount = 0
    for (const r of enriched) {
      const c = r._cost || 0
      lifetime += c
      if (r._date && r._date >= yStart) ytd    += c
      if (r._date && r._date >= d30)    last30 += c
      if (c > 0 || r._date) shiftCount++
    }
    return { lifetime, ytd, last30, shiftCount, avg: shiftCount ? lifetime / shiftCount : 0 }
  }, [enriched])

  const rates = staff ? parseRates(staff.rates) : []
  const initials = (staff?.name || '')
    .split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0]).join('').toUpperCase() || '?'
  const isActive = staff?.active !== 'false'
  const onboarded = staff?.onboardingComplete === 'true' || staff?.onboardingComplete === true
  const stageBadgeRgb = staff?.stage === 'beach' ? '74,222,128'
                      : staff?.stage === 'inside' ? '96,174,255'
                      : '148,163,184'

  // ── Actions ─────────────────────────────────────────────────────
  const [invitingBusy, setInvitingBusy] = useState(false)
  const [inviteMsg,    setInviteMsg]    = useState(null)
  async function sendInvite() {
    if (!staff?.email) return
    setInvitingBusy(true); setInviteMsg(null)
    try {
      const res = await api.post(`/staff/${staff.id}/invite`)
      if (res.data?.success) setInviteMsg({ kind: 'ok', text: `Invite sent to ${staff.email}` })
      else setInviteMsg({ kind: 'err', text: res.data?.message || 'Could not send invite' })
    } catch (err) {
      setInviteMsg({ kind: 'err', text: err.response?.data?.message || err.message })
    } finally { setInvitingBusy(false) }
  }
  async function toggleActive() {
    if (!staff) return
    const next = isActive ? 'false' : 'true'
    if (!confirm(`Mark ${staff.name} as ${next === 'true' ? 'Active' : 'Inactive'}?`)) return
    try {
      await api.put(`/staff/${staff.id}`, { active: next })
      setStaff(s => ({ ...s, active: next }))
    } catch (err) {
      alert(err.response?.data?.message || err.message)
    }
  }

  if (loading) return <div className="loading">Loading staff…</div>
  if (error)   return (
    <div className="card" style={{ textAlign: 'center', padding: 32 }}>
      <div style={{ fontSize: '2rem', marginBottom: 8 }}>👤</div>
      <div style={{ marginBottom: 12 }}>{error}</div>
      <Link className="btn btn-ghost" to="/staff">← Back to Staff</Link>
    </div>
  )
  if (!staff) return null

  return (
    <div>
      {/* ── Header / breadcrumb ─────────────────────────────────── */}
      <div className="page-header">
        <div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>
            <Link to="/staff" style={{ color: 'var(--text-muted)', textDecoration: 'none' }}>← Staff</Link>
          </div>
          <div className="page-title">{staff.name || 'Unnamed staff'}</div>
          <div className="page-subtitle">
            {staff.role || 'No role set'}{staff.department ? ` · ${staff.department}` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {staff.email && !onboarded && (
            <button className="btn btn-ghost" onClick={sendInvite} disabled={invitingBusy}>
              {invitingBusy ? 'Sending…' : '📧 Send Invite'}
            </button>
          )}
          <button className="btn btn-ghost" onClick={toggleActive}>
            {isActive ? 'Mark Inactive' : 'Mark Active'}
          </button>
          <button className="btn btn-primary" onClick={() => navigate(`/staff?edit=${staff.id}`)}>
            ✏️ Edit Profile
          </button>
        </div>
      </div>

      {inviteMsg && (
        <div className="card" style={{
          marginBottom: 12, padding: 10,
          background: inviteMsg.kind === 'ok' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
          border: `1px solid ${inviteMsg.kind === 'ok' ? 'rgba(16,185,129,0.35)' : 'rgba(239,68,68,0.35)'}`,
          color: inviteMsg.kind === 'ok' ? '#86efac' : '#fca5a5',
          fontSize: 13,
        }}>
          {inviteMsg.text}
        </div>
      )}

      {/* ── Hero card ───────────────────────────────────────────── */}
      <div className="card" style={{
        marginBottom: 16,
        display: 'flex', alignItems: 'flex-start', gap: 20, flexWrap: 'wrap',
        background: `linear-gradient(135deg, rgba(${stageBadgeRgb},0.12), rgba(255,255,255,0.02))`,
        border: `1px solid rgba(${stageBadgeRgb}, 0.25)`,
      }}>
        <div style={{
          width: 72, height: 72, borderRadius: '50%',
          background: `rgba(${stageBadgeRgb}, 0.2)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontSize: 24, fontWeight: 700,
          border: `2px solid rgba(${stageBadgeRgb}, 0.4)`,
          flexShrink: 0,
        }}>{initials}</div>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>{staff.name}</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 13, color: 'var(--text-muted)' }}>
            {staff.email && <span>✉️ <a href={`mailto:${staff.email}`} style={{ color: 'var(--text)' }}>{staff.email}</a></span>}
            {staff.phone && <span>📞 <a href={`tel:${staff.phone}`} style={{ color: 'var(--text)' }}>{staff.phone}</a></span>}
            {staff.startDate && <span>📅 Started {staff.startDate} ({tenureLabel(staff.startDate)})</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {staff.stage === 'both'
            ? <><span className="badge badge-inside">Inside</span><span className="badge badge-beach">Beach</span></>
            : staff.stage && <span className={`badge badge-${staff.stage}`}>{staff.stage === 'inside' ? 'Inside' : 'Beach'}</span>}
          <span className={`badge badge-${isActive ? 'confirmed' : 'cancelled'}`}>
            {isActive ? 'Active' : 'Inactive'}
          </span>
          <span className={`badge badge-${onboarded ? 'confirmed' : 'pending'}`}>
            {onboarded ? '✅ Onboarded' : '⏳ Onboarding'}
          </span>
        </div>
      </div>

      {/* ── Stat strip ──────────────────────────────────────────── */}
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Shifts (all time)</div>
          <div className="stat-value">{enriched.length}</div>
          <div className="stat-sub">{upcoming.length} upcoming · {past.length} past</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Next Call</div>
          <div className="stat-value" style={{ fontSize: '1.05rem' }}>
            {upcoming[0]
              ? (upcoming[0]._date ? upcoming[0]._date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '—')
              : 'None scheduled'}
          </div>
          <div className="stat-sub">
            {upcoming[0]?.callTime ? `Call ${formatTime(upcoming[0].callTime, tf)}` : upcoming[0]?._show?.artist || upcoming[0]?.showName || ''}
          </div>
        </div>
        {canSeeFinancials && (
          <>
            <div className="stat-card">
              <div className="stat-label">YTD Pay</div>
              <div className="stat-value" style={{ color: '#86efac' }}>${totals.ytd.toFixed(0)}</div>
              <div className="stat-sub">since Jan 1</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Last 30 Days</div>
              <div className="stat-value" style={{ color: '#86efac' }}>${totals.last30.toFixed(0)}</div>
              <div className="stat-sub">avg ${totals.avg.toFixed(0)} / shift</div>
            </div>
          </>
        )}
      </div>

      {/* ── Tabs ────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 16, borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
        {[
          { key: 'overview',   label: '📋 Overview' },
          { key: 'shifts',     label: `👷 Shifts (${enriched.length})` },
          ...(canSeeFinancials ? [{ key: 'pay', label: '💵 Pay' }] : []),
          { key: 'onboarding', label: `🎓 Onboarding${onboarded ? '' : ' ⚠️'}` },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: '10px 18px', background: 'none', border: 'none',
              borderBottom: tab === t.key ? '2px solid var(--accent)' : '2px solid transparent',
              color: tab === t.key ? '#fff' : 'rgba(255,255,255,0.5)',
              cursor: 'pointer', fontSize: 14,
              fontWeight: tab === t.key ? 600 : 400,
              transition: 'all 0.15s', marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── OVERVIEW TAB ────────────────────────────────────────── */}
      {tab === 'overview' && (
        <div className="card" style={{ padding: 24 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 18 }}>
            <InfoBlock label="Contact">
              <InfoRow k="Email" v={staff.email ? <a href={`mailto:${staff.email}`}>{staff.email}</a> : '—'} />
              <InfoRow k="Phone" v={staff.phone ? <a href={`tel:${staff.phone}`}>{staff.phone}</a> : '—'} />
            </InfoBlock>
            <InfoBlock label="Employment">
              <InfoRow k="Role"       v={staff.role || '—'} />
              <InfoRow k="Department" v={staff.department || '—'} />
              <InfoRow k="Start Date" v={staff.startDate || '—'} />
              <InfoRow k="Tenure"     v={tenureLabel(staff.startDate)} />
            </InfoBlock>
            <InfoBlock label="Stage / Status">
              <InfoRow k="Stage Assignment" v={
                staff.stage === 'both' ? 'Inside & Beach'
                : staff.stage === 'inside' ? 'Inside Stage'
                : staff.stage === 'beach'  ? 'Beach Stage'
                : '—'
              } />
              <InfoRow k="Active"     v={isActive ? 'Yes' : 'No'} />
              <InfoRow k="Onboarded"  v={onboarded ? 'Complete' : 'Pending'} />
            </InfoBlock>
          </div>
          {staff.notes && (
            <div style={{ marginTop: 18 }}>
              <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)', fontWeight: 600, marginBottom: 6 }}>Notes</div>
              <div style={{ padding: 12, background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)', borderRadius: 8, whiteSpace: 'pre-wrap', fontSize: 13 }}>
                {staff.notes}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── SHIFTS TAB ──────────────────────────────────────────── */}
      {tab === 'shifts' && (
        <ShiftsPanel
          upcoming={upcoming}
          past={past}
          tf={tf}
          canSeeFinancials={canSeeFinancials}
          navigate={navigate}
        />
      )}

      {/* ── PAY TAB ─────────────────────────────────────────────── */}
      {tab === 'pay' && canSeeFinancials && (
        <div className="card" style={{ padding: 24 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 18, marginBottom: 22 }}>
            <PayStat label="Lifetime Earnings"   value={totals.lifetime} />
            <PayStat label="Year to Date"        value={totals.ytd} />
            <PayStat label="Last 30 Days"        value={totals.last30} />
            <PayStat label="Avg per Shift"       value={totals.avg} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 18 }}>
            <InfoBlock label="Default Rates">
              <InfoRow k="Default Pay Type" v={staff.payType === 'day' ? 'Day Rate' : 'Hourly'} />
              <InfoRow k="Day Rate"    v={staff.dayRate    ? `$${staff.dayRate}`    : '—'} />
              <InfoRow k="Hourly Rate" v={staff.hourlyRate ? `$${staff.hourlyRate}` : '—'} />
            </InfoBlock>
            <InfoBlock label={`Position Rates (${rates.length})`}>
              {rates.length === 0
                ? <div className="text-muted" style={{ fontSize: 13 }}>No position-specific rates. Defaults apply.</div>
                : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr><th>Position</th><th>Type</th><th style={{ textAlign: 'right' }}>Rate</th></tr>
                      </thead>
                      <tbody>
                        {rates.map((r, i) => (
                          <tr key={i}>
                            <td><strong>{r.role || '(unnamed)'}</strong></td>
                            <td className="text-muted">{r.payType === 'day' ? 'Day' : 'Hour'}</td>
                            <td style={{ textAlign: 'right' }}>
                              {r.rate ? `$${r.rate}${r.payType === 'day' ? '/day' : '/hr'}` : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </InfoBlock>
          </div>
        </div>
      )}

      {/* ── ONBOARDING TAB ──────────────────────────────────────── */}
      {tab === 'onboarding' && (
        <OnboardingPanel staff={staff} onboarded={onboarded} onEdit={() => navigate(`/staff?edit=${staff.id}`)} />
      )}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────── Sub-panels ─ */

function ShiftsPanel({ upcoming, past, tf, canSeeFinancials, navigate }) {
  const [scope, setScope] = useState('all') // 'all' | 'upcoming' | 'past'
  const rows = scope === 'upcoming' ? upcoming : scope === 'past' ? past : [...upcoming, ...past]

  return (
    <div>
      <div className="filter-bar">
        <SegSwitch
          value={scope}
          onChange={setScope}
          options={[
            { v: 'all',      l: `All (${upcoming.length + past.length})` },
            { v: 'upcoming', l: `Upcoming (${upcoming.length})` },
            { v: 'past',     l: `Past (${past.length})` },
          ]}
        />
      </div>

      <div className="card" style={{ padding: 0 }}>
        {rows.length === 0 ? (
          <div className="empty-state">No shifts recorded.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Show / Task</th>
                  <th>Position</th>
                  <th>Call</th>
                  <th>Wrap</th>
                  <th>Units</th>
                  <th>Stage</th>
                  {canSeeFinancials && <th style={{ textAlign: 'right' }}>Pay</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const facility = !r.showId
                  return (
                    <tr
                      key={r.id}
                      style={{ cursor: r.showId ? 'pointer' : 'default' }}
                      onClick={() => r.showId && navigate(`/shows/${r.showId}`)}
                    >
                      <td>
                        <strong>{r._date
                          ? r._date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
                          : '—'}</strong>
                      </td>
                      <td>
                        {facility
                          ? <><span className="badge badge-warning" style={{ marginRight: 6 }}>Facility</span>{r.showName || '(unlabeled)'}</>
                          : (r._show?.artist || r._show?.eventName || r.showName || '—')}
                      </td>
                      <td className="text-muted">{r.role || '—'}</td>
                      <td className="text-muted">{r.callTime ? formatTime(r.callTime, tf) : '—'}</td>
                      <td className="text-muted">{r.wrapTime ? formatTime(r.wrapTime, tf) : '—'}</td>
                      <td className="text-muted">
                        {(r.payType || 'hour') === 'day'
                          ? `${r.days || 1} day${(r.days || 1) == 1 ? '' : 's'}`
                          : (r.hours ? `${r.hours} hr` : '—')}
                      </td>
                      <td>
                        {r.stage
                          ? <span className={`badge badge-${r.stage}`}>{r.stage === 'inside' ? 'Inside' : 'Beach'}</span>
                          : <span className="text-muted">—</span>}
                      </td>
                      {canSeeFinancials && (
                        <td style={{ textAlign: 'right' }}>
                          <strong style={{ color: r._cost > 0 ? '#6ee7b7' : 'var(--text-muted)' }}>
                            {r._cost > 0 ? `$${r._cost.toFixed(2)}` : '—'}
                          </strong>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

const ONBOARDING_ITEMS = [
  'I-9 Completed', 'W-4 Completed', 'Emergency Contact on File',
  'Background Check', 'Safety Briefing', 'Stage Protocol Review',
  'LN Code of Conduct', 'Rigging Safety (if applicable)', 'Equipment Training',
]

function OnboardingPanel({ staff, onboarded, onEdit }) {
  const rawCerts = String(staff.certifications || '')
  // Naive normaliser: everything comma-separated becomes a "yes"; the
  // checklist below highlights which canonical items are covered so a PM
  // can see gaps at a glance.
  const gotSet = new Set(
    rawCerts.split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  )
  const rows = ONBOARDING_ITEMS.map(item => ({
    item,
    done: gotSet.has(item.toLowerCase()) || rawCerts.toLowerCase().includes(item.toLowerCase()),
  }))
  const doneCount = rows.filter(r => r.done).length

  return (
    <div className="card" style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)', fontWeight: 600 }}>
            Onboarding Progress
          </div>
          <div style={{ fontSize: '1.4rem', fontWeight: 700, marginTop: 2 }}>
            {doneCount}/{ONBOARDING_ITEMS.length}
            <span style={{ marginLeft: 10, fontSize: '0.85rem', color: onboarded ? '#86efac' : 'var(--warning)', fontWeight: 500 }}>
              {onboarded ? 'Marked complete' : 'In progress'}
            </span>
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onEdit}>Edit certifications</button>
      </div>

      {/* Progress bar */}
      <div style={{ height: 8, background: 'rgba(255,255,255,0.06)', borderRadius: 999, overflow: 'hidden', marginBottom: 20 }}>
        <div style={{
          width: `${Math.round((doneCount / ONBOARDING_ITEMS.length) * 100)}%`,
          height: '100%',
          background: onboarded ? '#22c55e' : 'var(--accent)',
          transition: 'width 0.3s',
        }} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 8 }}>
        {rows.map(r => (
          <div key={r.item} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
            border: `1px solid ${r.done ? 'rgba(34,197,94,0.35)' : 'var(--border)'}`,
            borderRadius: 8,
            background: r.done ? 'rgba(34,197,94,0.08)' : 'rgba(255,255,255,0.02)',
            fontSize: 13,
          }}>
            <span style={{ fontSize: 16 }}>{r.done ? '✅' : '⬜'}</span>
            <span style={{ color: r.done ? 'var(--text)' : 'var(--text-muted)' }}>{r.item}</span>
          </div>
        ))}
      </div>

      {rawCerts && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)', fontWeight: 600, marginBottom: 6 }}>
            Free-form Certifications
          </div>
          <div style={{ padding: 12, background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, whiteSpace: 'pre-wrap' }}>
            {rawCerts}
          </div>
        </div>
      )}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────── Small UI bits ─ */

function InfoBlock({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)', fontWeight: 600, marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
        {children}
      </div>
    </div>
  )
}

function InfoRow({ k, v }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 10, alignItems: 'baseline' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{k}</span>
      <span style={{ color: 'var(--text)' }}>{v}</span>
    </div>
  )
}

function PayStat({ label, value }) {
  return (
    <div style={{ padding: '14px 16px', border: '1px solid var(--border)', borderRadius: 10, background: 'rgba(255,255,255,0.02)' }}>
      <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)', fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#86efac', marginTop: 4 }}>
        ${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
      </div>
    </div>
  )
}

function SegSwitch({ value, onChange, options }) {
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden' }}>
      {options.map(o => {
        const active = o.v === value
        return (
          <button
            key={o.v}
            type="button"
            onClick={() => onChange(o.v)}
            style={{
              background: active ? 'rgba(59,130,246,0.18)' : 'transparent',
              color: active ? 'var(--accent)' : 'var(--text-muted)',
              border: 'none', padding: '7px 14px', fontSize: 13,
              cursor: 'pointer', fontWeight: active ? 600 : 500,
            }}
          >{o.l}</button>
        )
      })}
    </div>
  )
}
