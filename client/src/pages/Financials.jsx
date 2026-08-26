import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import api from '../api'
import { useAuth } from '../context/AuthContext'
import { money } from '../utils/exportHelpers'

// Financials — MVP scope: labor data only. Restricted to admin + production_manager.
// Uses Labor.total (already stored per-row) as the cost source, matching Labor.jsx.
// A blank showId marks a "facility" / venue-overhead row (see Labor.jsx isFacilityRow).

const ALLOWED_ROLES = ['admin', 'production_manager']

const RANGE_PRESETS = [
  { key: 'mtd',   label: 'This Month' },
  { key: '30d',   label: 'Last 30 Days' },
  { key: 'ytd',   label: 'Year to Date' },
  { key: '12mo',  label: 'Last 12 Months' },
  { key: 'ly',    label: 'Last Year' },
  { key: 'all',   label: 'All Time' },
  { key: 'custom',label: 'Custom' },
]

function ymd(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function presetRange(key) {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  switch (key) {
    case 'mtd': {
      const from = new Date(today.getFullYear(), today.getMonth(), 1)
      return { from: ymd(from), to: ymd(today) }
    }
    case '30d': {
      const from = new Date(today); from.setDate(from.getDate() - 29)
      return { from: ymd(from), to: ymd(today) }
    }
    case 'ytd': {
      const from = new Date(today.getFullYear(), 0, 1)
      return { from: ymd(from), to: ymd(today) }
    }
    case '12mo': {
      const from = new Date(today); from.setMonth(from.getMonth() - 11); from.setDate(1)
      return { from: ymd(from), to: ymd(today) }
    }
    case 'ly': {
      const y = today.getFullYear() - 1
      return { from: `${y}-01-01`, to: `${y}-12-31` }
    }
    case 'all':
    default:
      return { from: '', to: '' }
  }
}

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, (m || 1) - 1, 1)
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

// Simple horizontal bar. `value` is the cost, `max` is the biggest bar in the group.
function Bar({ value, max, color = '#4f8cff' }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0
  return (
    <div style={{ background: '#eef1f5', borderRadius: 4, height: 10, overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color }} />
    </div>
  )
}

function KpiCard({ label, value, sub }) {
  return (
    <div style={{
      background: '#fff', border: '1px solid #e3e6ea', borderRadius: 8,
      padding: '14px 16px', minWidth: 170, flex: '1 1 170px'
    }}>
      <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: '#6b7280' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

export default function Financials() {
  const { user, effectiveRole } = useAuth()
  const role = effectiveRole || user?.role || ''
  const allowed = ALLOWED_ROLES.includes(role)

  const [labor, setLabor]   = useState([])
  const [shows, setShows]   = useState([])
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)

  const [rangePreset, setRangePreset] = useState('ytd')
  const [customFrom, setCustomFrom]   = useState('')
  const [customTo, setCustomTo]       = useState('')
  const [stageFilter, setStageFilter] = useState('')
  const [includeFacility, setIncludeFacility] = useState(true)

  useEffect(() => {
    if (!allowed) return
    let cancelled = false
    ;(async () => {
      try {
        const [l, s, e] = await Promise.all([
          api.get('/api/labor'),
          api.get('/api/shows'),
          api.get('/api/events').catch(() => ({ data: [] })),
        ])
        if (cancelled) return
        setLabor(l.data || [])
        setShows(s.data || [])
        setEvents(e.data || [])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [allowed])

  const showById  = useMemo(() => Object.fromEntries(shows.map(s => [s.id, s])),  [shows])
  const eventById = useMemo(() => Object.fromEntries(events.map(e => [e.id, e])), [events])

  const { from, to } = useMemo(() => {
    if (rangePreset === 'custom') return { from: customFrom, to: customTo }
    return presetRange(rangePreset)
  }, [rangePreset, customFrom, customTo])

  // Assign a bucket date to every labor row: prefer the show's date, fall back to createdAt.
  // Facility rows almost always have no show, so createdAt is the sensible default.
  const enriched = useMemo(() => {
    return labor.map(row => {
      const show = row.showId ? showById[row.showId] : null
      const bucketDate = (show?.date) || (row.createdAt ? row.createdAt.slice(0, 10) : '')
      return {
        ...row,
        _cost: parseFloat(row.total) || 0,
        _hours: parseFloat(row.hours) || 0,
        _days: parseFloat(row.days) || 0,
        _isFacility: !row.showId,
        _showName: show?.artist || show?.eventName || row.showName || '',
        _stage: (row.stage || show?.stage || '').toLowerCase(),
        _date: bucketDate,
        _eventId: show?.eventId || '',
      }
    })
  }, [labor, showById])

  const filtered = useMemo(() => {
    return enriched.filter(r => {
      if (!includeFacility && r._isFacility) return false
      if (stageFilter && r._stage !== stageFilter) return false
      if (from && r._date && r._date < from) return false
      if (to && r._date && r._date > to) return false
      // Rows with no date at all are only shown for "All Time".
      if (!r._date && (from || to)) return false
      return true
    })
  }, [enriched, from, to, stageFilter, includeFacility])

  // ── KPIs ────────────────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const totalCost   = filtered.reduce((s, r) => s + r._cost, 0)
    const showRows    = filtered.filter(r => !r._isFacility)
    const facilityRows= filtered.filter(r => r._isFacility)
    const showCost    = showRows.reduce((s, r) => s + r._cost, 0)
    const facilityCost= facilityRows.reduce((s, r) => s + r._cost, 0)
    const uniqueShows = new Set(showRows.map(r => r.showId)).size
    const avgPerShow  = uniqueShows > 0 ? showCost / uniqueShows : 0
    const totalHours  = filtered.reduce((s, r) => s + r._hours, 0)
    const uniqueWorkers = new Set(filtered.map(r => (r.workerName || '').trim().toLowerCase()).filter(Boolean)).size
    const unionCost   = filtered.filter(r => String(r.union) === 'true').reduce((s, r) => s + r._cost, 0)
    const unionPct    = totalCost > 0 ? Math.round((unionCost / totalCost) * 100) : 0
    return { totalCost, showCost, facilityCost, uniqueShows, avgPerShow, totalHours, uniqueWorkers, unionPct }
  }, [filtered])

  // ── Grouped rollups ─────────────────────────────────────────────────────
  const byMonth = useMemo(() => {
    const map = new Map()
    filtered.forEach(r => {
      if (!r._date) return
      const key = r._date.slice(0, 7)
      map.set(key, (map.get(key) || 0) + r._cost)
    })
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => ({ key: k, label: monthLabel(k), value: v }))
  }, [filtered])

  const byYear = useMemo(() => {
    const map = new Map()
    filtered.forEach(r => {
      if (!r._date) return
      const key = r._date.slice(0, 4)
      map.set(key, (map.get(key) || 0) + r._cost)
    })
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => ({ key: k, label: k, value: v }))
  }, [filtered])

  const byShow = useMemo(() => {
    const map = new Map()
    filtered.forEach(r => {
      if (r._isFacility) return
      const key = r.showId
      if (!map.has(key)) {
        map.set(key, {
          showId: key,
          name: r._showName || '(unnamed)',
          date: r._date,
          stage: r._stage,
          eventId: r._eventId,
          cost: 0,
          hours: 0,
        })
      }
      const bucket = map.get(key)
      bucket.cost  += r._cost
      bucket.hours += r._hours
    })
    return [...map.values()].sort((a, b) => b.cost - a.cost)
  }, [filtered])

  const byEmployee = useMemo(() => {
    const map = new Map()
    filtered.forEach(r => {
      const name = (r.workerName || '').trim()
      if (!name) return
      const key = name.toLowerCase()
      if (!map.has(key)) map.set(key, { name, cost: 0, hours: 0, days: 0, shifts: 0, union: false })
      const b = map.get(key)
      b.cost += r._cost
      b.hours += r._hours
      b.days += r._days
      b.shifts += 1
      if (String(r.union) === 'true') b.union = true
    })
    return [...map.values()].sort((a, b) => b.cost - a.cost)
  }, [filtered])

  const byStage = useMemo(() => {
    const map = new Map()
    filtered.forEach(r => {
      const key = r._isFacility ? 'facility' : (r._stage || 'unspecified')
      map.set(key, (map.get(key) || 0) + r._cost)
    })
    const label = k => k === 'facility' ? 'Facility / Shop'
      : k === 'inside' ? 'Inside'
      : k === 'beach'  ? 'Beach'
      : k[0].toUpperCase() + k.slice(1)
    return [...map.entries()]
      .sort(([, a], [, b]) => b - a)
      .map(([k, v]) => ({ key: k, label: label(k), value: v }))
  }, [filtered])

  const byRole = useMemo(() => {
    const map = new Map()
    filtered.forEach(r => {
      const key = (r.role || '(unspecified)').trim()
      map.set(key, (map.get(key) || 0) + r._cost)
    })
    return [...map.entries()]
      .sort(([, a], [, b]) => b - a)
      .map(([k, v]) => ({ key: k, label: k, value: v }))
  }, [filtered])

  const byEvent = useMemo(() => {
    const map = new Map()
    filtered.forEach(r => {
      if (!r._eventId) return
      const ev = eventById[r._eventId]
      if (!map.has(r._eventId)) {
        map.set(r._eventId, { id: r._eventId, name: ev?.name || '(event)', color: ev?.color || '#888', cost: 0, hours: 0 })
      }
      const b = map.get(r._eventId)
      b.cost += r._cost
      b.hours += r._hours
    })
    return [...map.values()].sort((a, b) => b.cost - a.cost)
  }, [filtered, eventById])

  function exportCsv() {
    const rows = [
      ['Date','Show / Task','Stage','Worker','Role','Pay Type','Days','Hours','Rate','Total','Union'],
      ...filtered.map(r => [
        r._date, r._showName || (r._isFacility ? `[Facility] ${r.showName || ''}` : ''),
        r._stage, r.workerName || '', r.role || '', r.payType || '',
        r.days || '', r.hours || '', r.rate || '', r.total || '',
        String(r.union) === 'true' ? 'Y' : ''
      ])
    ]
    const csv = rows.map(row =>
      row.map(cell => {
        const v = String(cell ?? '')
        return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
      }).join(',')
    ).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `financials-labor-${from || 'all'}_${to || 'now'}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!allowed) return <Navigate to="/dashboard" replace />

  const rangeLabel = from || to
    ? `${from || '…'} → ${to || 'now'}`
    : 'All time'

  const monthMax    = Math.max(0, ...byMonth.map(x => x.value))
  const yearMax     = Math.max(0, ...byYear.map(x => x.value))
  const stageMax    = Math.max(0, ...byStage.map(x => x.value))
  const roleMax     = Math.max(0, ...byRole.map(x => x.value))
  const showMax     = Math.max(0, ...byShow.map(x => x.cost))
  const empMax      = Math.max(0, ...byEmployee.map(x => x.cost))
  const eventMax    = Math.max(0, ...byEvent.map(x => x.cost))

  return (
    <div style={{ padding: '1rem 1.25rem', maxWidth: 1200 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>💰 Financials</h2>
        <span style={{ background: '#fff7cc', color: '#7a5c00', padding: '2px 8px', borderRadius: 4, fontSize: 12 }}>
          Labor only · MVP
        </span>
        <span style={{ color: '#6b7280', fontSize: 13 }}>{rangeLabel}</span>
        <div style={{ marginLeft: 'auto' }}>
          <button className="btn" onClick={exportCsv} disabled={filtered.length === 0}>Export CSV</button>
        </div>
      </div>

      {/* Filters */}
      <div style={{
        background: '#f7f8fa', border: '1px solid #e3e6ea', borderRadius: 8,
        padding: 12, marginBottom: 16, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center'
      }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: '#6b7280' }}>Range</span>
          <select value={rangePreset} onChange={e => setRangePreset(e.target.value)}>
            {RANGE_PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </label>
        {rangePreset === 'custom' && (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, color: '#6b7280' }}>From</span>
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, color: '#6b7280' }}>To</span>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} />
            </label>
          </>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: '#6b7280' }}>Stage</span>
          <select value={stageFilter} onChange={e => setStageFilter(e.target.value)}>
            <option value="">All</option>
            <option value="inside">Inside</option>
            <option value="beach">Beach</option>
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={includeFacility} onChange={e => setIncludeFacility(e.target.checked)} />
          <span style={{ fontSize: 13 }}>Include facility / shop rows</span>
        </label>
      </div>

      {loading ? (
        <p>Loading…</p>
      ) : filtered.length === 0 ? (
        <p style={{ color: '#6b7280' }}>No labor entries in the selected range.</p>
      ) : (
        <>
          {/* KPIs */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
            <KpiCard label="Total Labor Cost" value={money(kpis.totalCost)} sub={`${filtered.length} entries`} />
            <KpiCard label="Show-Attached" value={money(kpis.showCost)} sub={`${kpis.uniqueShows} shows`} />
            <KpiCard label="Facility / Shop" value={money(kpis.facilityCost)} />
            <KpiCard label="Avg Cost / Show" value={money(kpis.avgPerShow)} />
            <KpiCard label="Total Hours" value={kpis.totalHours.toFixed(1)} />
            <KpiCard label="Unique Workers" value={String(kpis.uniqueWorkers)} />
            <KpiCard label="Union Share" value={`${kpis.unionPct}%`} sub={money(kpis.totalCost * kpis.unionPct / 100)} />
          </div>

          {/* Monthly */}
          <Section title="By Month">
            {byMonth.length === 0 ? <Empty /> : (
              <table style={tableStyle}>
                <tbody>
                  {byMonth.map(row => (
                    <tr key={row.key}>
                      <td style={{ ...tdLeft, width: 120 }}>{row.label}</td>
                      <td><Bar value={row.value} max={monthMax} /></td>
                      <td style={tdRight}>{money(row.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          {/* Yearly */}
          <Section title="By Year">
            {byYear.length === 0 ? <Empty /> : (
              <table style={tableStyle}>
                <tbody>
                  {byYear.map(row => (
                    <tr key={row.key}>
                      <td style={{ ...tdLeft, width: 120 }}>{row.label}</td>
                      <td><Bar value={row.value} max={yearMax} color="#7a5cff" /></td>
                      <td style={tdRight}>{money(row.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          {/* Per employee */}
          <Section title={`By Employee (${byEmployee.length})`}>
            {byEmployee.length === 0 ? <Empty /> : (
              <div style={{ overflowX: 'auto' }}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thLeft}>Worker</th>
                      <th style={thRight}>Shifts</th>
                      <th style={thRight}>Hours</th>
                      <th style={thRight}>Days</th>
                      <th style={{ minWidth: 160 }}></th>
                      <th style={thRight}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byEmployee.map(emp => (
                      <tr key={emp.name}>
                        <td style={tdLeft}>
                          {emp.name}
                          {emp.union && <span style={badgeUnion}>UNION</span>}
                        </td>
                        <td style={tdRight}>{emp.shifts}</td>
                        <td style={tdRight}>{emp.hours ? emp.hours.toFixed(1) : ''}</td>
                        <td style={tdRight}>{emp.days ? emp.days : ''}</td>
                        <td><Bar value={emp.cost} max={empMax} color="#2fa36a" /></td>
                        <td style={tdRight}>{money(emp.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {/* Per show */}
          <Section title={`By Show (${byShow.length})`}>
            {byShow.length === 0 ? <Empty /> : (
              <div style={{ overflowX: 'auto' }}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thLeft}>Date</th>
                      <th style={thLeft}>Show</th>
                      <th style={thLeft}>Stage</th>
                      <th style={thRight}>Hours</th>
                      <th style={{ minWidth: 160 }}></th>
                      <th style={thRight}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byShow.map(row => {
                      const ev = row.eventId ? eventById[row.eventId] : null
                      return (
                        <tr key={row.showId}>
                          <td style={tdLeft}>{row.date || ''}</td>
                          <td style={tdLeft}>
                            <Link to={`/shows/${row.showId}`}>{row.name}</Link>
                            {ev && (
                              <span style={{ ...badgeEvent, background: ev.color || '#888' }} title={ev.name}>
                                {ev.name}
                              </span>
                            )}
                          </td>
                          <td style={{ ...tdLeft, textTransform: 'capitalize' }}>{row.stage || ''}</td>
                          <td style={tdRight}>{row.hours ? row.hours.toFixed(1) : ''}</td>
                          <td><Bar value={row.cost} max={showMax} color="#ff8c42" /></td>
                          <td style={tdRight}>{money(row.cost)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {/* Per event (only if any) */}
          {byEvent.length > 0 && (
            <Section title="By Event / Festival">
              <table style={tableStyle}>
                <tbody>
                  {byEvent.map(ev => (
                    <tr key={ev.id}>
                      <td style={{ ...tdLeft, width: 220 }}>
                        <span style={{ ...badgeEvent, background: ev.color || '#888' }}>{ev.name}</span>
                      </td>
                      <td style={tdRight}>{ev.hours ? ev.hours.toFixed(1) + ' h' : ''}</td>
                      <td><Bar value={ev.cost} max={eventMax} color="#c94f7c" /></td>
                      <td style={tdRight}>{money(ev.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          {/* Two-column grid: Stage + Role */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20 }}>
            <Section title="By Stage">
              {byStage.length === 0 ? <Empty /> : (
                <table style={tableStyle}>
                  <tbody>
                    {byStage.map(row => (
                      <tr key={row.key}>
                        <td style={{ ...tdLeft, width: 130 }}>{row.label}</td>
                        <td><Bar value={row.value} max={stageMax} /></td>
                        <td style={tdRight}>{money(row.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>

            <Section title="By Role">
              {byRole.length === 0 ? <Empty /> : (
                <table style={tableStyle}>
                  <tbody>
                    {byRole.map(row => (
                      <tr key={row.key}>
                        <td style={{ ...tdLeft, width: 160 }}>{row.label}</td>
                        <td><Bar value={row.value} max={roleMax} color="#8a6a3f" /></td>
                        <td style={tdRight}>{money(row.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>
          </div>
        </>
      )}
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div style={{
      background: '#fff', border: '1px solid #e3e6ea', borderRadius: 8,
      padding: 14, marginBottom: 20
    }}>
      <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>{title}</h3>
      {children}
    </div>
  )
}

function Empty() {
  return <div style={{ color: '#6b7280', fontSize: 13 }}>No data.</div>
}

const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 13 }
const tdLeft  = { padding: '6px 8px', borderBottom: '1px solid #f0f2f5' }
const tdRight = { padding: '6px 8px', borderBottom: '1px solid #f0f2f5', textAlign: 'right', whiteSpace: 'nowrap' }
const thLeft  = { padding: '6px 8px', textAlign: 'left',  borderBottom: '1px solid #e3e6ea', fontSize: 12, color: '#6b7280' }
const thRight = { padding: '6px 8px', textAlign: 'right', borderBottom: '1px solid #e3e6ea', fontSize: 12, color: '#6b7280' }
const badgeUnion = {
  marginLeft: 6, background: '#e0f0ff', color: '#0b5cad',
  fontSize: 10, padding: '1px 6px', borderRadius: 3, verticalAlign: 'middle'
}
const badgeEvent = {
  marginLeft: 8, color: '#fff', fontSize: 11,
  padding: '1px 8px', borderRadius: 10, verticalAlign: 'middle'
}
