import { useEffect, useMemo, useState, Fragment } from 'react'
import { Link, Navigate } from 'react-router-dom'
import api from '../api'
import { useAuth } from '../context/AuthContext'
import { money } from '../utils/exportHelpers'

// Production Budgets — yearly + per-show allocations with live actuals rolled up
// from Labor.total, Maintenance.actualCost (status=complete), and VendorBookings.amount.
// A budget row stores its category allocations as a JSON blob in the `categories` field.

const ALLOWED_ROLES = ['admin', 'production_manager']

const CATEGORIES = [
  { key: 'labor',               label: 'Labor',               color: '#4f8cff' },
  { key: 'maintenance',         label: 'Maintenance',         color: '#2fa36a' },
  { key: 'repairs',             label: 'Repairs',             color: '#c26a00' },
  { key: 'upgrades',            label: 'Upgrades / Capital',  color: '#7a5cff' },
  { key: 'vendors',             label: 'Vendors',             color: '#c94f7c' },
  { key: 'catering',            label: 'Catering / Hospitality', color: '#ff8c42' },
  { key: 'production_supplies', label: 'Production Supplies', color: '#8a6a3f' },
  { key: 'travel',              label: 'Travel / Lodging',    color: '#0b7bcf' },
  { key: 'miscellaneous',       label: 'Miscellaneous',       color: '#6b7280' },
]

const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map(c => [c.key, c.label]))
const CATEGORY_COLOR = Object.fromEntries(CATEGORIES.map(c => [c.key, c.color]))

function emptyAllocations() {
  return CATEGORIES.reduce((acc, c) => (acc[c.key] = 0, acc), {})
}

function parseCategories(raw) {
  if (!raw) return emptyAllocations()
  const arr = Array.isArray(raw) ? raw : (() => { try { return JSON.parse(raw) } catch { return [] } })()
  const out = emptyAllocations()
  if (Array.isArray(arr)) {
    arr.forEach(entry => {
      if (entry && entry.key && (entry.key in out)) out[entry.key] = parseFloat(entry.allocated) || 0
    })
  }
  return out
}

function serializeCategories(allocations) {
  return JSON.stringify(
    CATEGORIES.map(c => ({ key: c.key, allocated: parseFloat(allocations[c.key]) || 0 }))
  )
}

// Maintenance category -> budget category mapping.
function maintenanceBudgetCategory(row) {
  const cat = (row.category || '').toLowerCase()
  const type = (row.itemType || 'issue').toLowerCase()
  if (type === 'project') return 'upgrades'
  if (cat === 'repair')      return 'repairs'
  if (cat === 'maintenance') return 'maintenance'
  if (cat === 'inspection')  return 'maintenance'
  if (cat === 'upgrade')     return 'upgrades'
  return 'miscellaneous'
}

function yearOf(dateStr) {
  return (dateStr || '').slice(0, 4)
}

function Bar({ value, allocated, color = '#4f8cff' }) {
  if (!allocated || allocated <= 0) {
    // No allocation: show a neutral bar so the user still sees relative spend visually.
    return (
      <div style={{ background: 'var(--border)', borderRadius: 4, height: 10 }}>
        {value > 0 && (
          <div style={{ width: '100%', height: '100%', background: '#c0392b', borderRadius: 4 }} title="Unbudgeted spend" />
        )}
      </div>
    )
  }
  const pct = Math.min(100, Math.round((value / allocated) * 100))
  const over = value > allocated
  return (
    <div style={{ background: 'var(--border)', borderRadius: 4, height: 10, position: 'relative', overflow: 'hidden' }}>
      <div style={{
        width: `${pct}%`, height: '100%',
        background: over ? '#c0392b' : (pct > 85 ? '#c26a00' : color),
      }} />
    </div>
  )
}

function Kpi({ label, value, sub, danger, warn }) {
  const color = danger ? '#c0392b' : warn ? '#c26a00' : undefined
  return (
    <div style={{
      background: 'var(--bg-card)', border: `1px solid ${danger ? '#c0392b66' : warn ? '#c26a0066' : 'var(--border)'}`,
      borderRadius: 8, padding: '14px 16px', minWidth: 170, flex: '1 1 170px'
    }}>
      <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: color || 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4, color }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

export default function Budgets() {
  const { user, effectiveRole } = useAuth()
  const role = effectiveRole || user?.role || ''
  const allowed = ALLOWED_ROLES.includes(role)

  const now = new Date()
  const [year, setYear] = useState(String(now.getFullYear()))

  const [budgets, setBudgets] = useState([])
  const [labor, setLabor]     = useState([])
  const [maint, setMaint]     = useState([])
  const [vendorBookings, setVendorBookings] = useState([])
  const [shows, setShows]     = useState([])
  const [loading, setLoading] = useState(true)

  // Per-show expansion — the id of the show whose budget grid is open.
  const [expandedShow, setExpandedShow] = useState(null)

  // Working allocation edits keyed by budget scope key. Saves happen on demand.
  const [yearDraft, setYearDraft]     = useState(null)
  const [showDrafts, setShowDrafts]   = useState({})   // { [showId]: { labor: '', ... } }
  const [savingKey, setSavingKey]     = useState(null)

  useEffect(() => {
    if (!allowed) return
    let cancelled = false
    ;(async () => {
      try {
        const [b, l, m, vb, s] = await Promise.all([
          api.get('/budgets'),
          api.get('/labor'),
          api.get('/maintenance'),
          api.get('/vendor-bookings').catch(() => ({ data: { data: [] } })),
          api.get('/shows'),
        ])
        if (cancelled) return
        setBudgets(b.data.data || [])
        setLabor(l.data.data || [])
        setMaint(m.data.data || [])
        setVendorBookings(vb.data.data || [])
        setShows(s.data.data || [])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [allowed])

  const showById = useMemo(() => Object.fromEntries(shows.map(s => [s.id, s])), [shows])

  const yearOptions = useMemo(() => {
    const set = new Set()
    const cur = now.getFullYear()
    for (let y = cur - 2; y <= cur + 2; y++) set.add(String(y))
    shows.forEach(s => { if (s.date) set.add(s.date.slice(0, 4)) })
    budgets.forEach(b => { if (b.scope === 'year' && b.scopeKey) set.add(b.scopeKey) })
    return [...set].sort()
  }, [budgets, shows])

  // ── Budget lookups ──────────────────────────────────────────────────────
  const yearBudget = useMemo(() => {
    return budgets.find(b => b.scope === 'year' && b.scopeKey === year) || null
  }, [budgets, year])

  const yearAllocations = useMemo(() => parseCategories(yearBudget?.categories), [yearBudget])

  const showBudgetsById = useMemo(() => {
    const map = {}
    budgets.forEach(b => {
      if (b.scope === 'show' && b.scopeKey) map[b.scopeKey] = b
    })
    return map
  }, [budgets])

  // ── Actual rollups ──────────────────────────────────────────────────────
  const yearShows = useMemo(() => {
    return shows
      .filter(s => (s.date || '').startsWith(year))
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
  }, [shows, year])

  const showActuals = useMemo(() => {
    // Per-show breakdown by category (labor + vendors so far — maintenance is not show-tied).
    const bucket = {}
    labor.forEach(row => {
      if (!row.showId) return
      const b = bucket[row.showId] ||= emptyAllocations()
      b.labor += parseFloat(row.total) || 0
    })
    vendorBookings.forEach(row => {
      if (!row.showId) return
      const b = bucket[row.showId] ||= emptyAllocations()
      b.vendors += parseFloat(row.amount) || 0
    })
    return bucket
  }, [labor, vendorBookings])

  const yearActuals = useMemo(() => {
    const totals = emptyAllocations()

    labor.forEach(row => {
      const show = row.showId ? showById[row.showId] : null
      const d = show?.date || (row.createdAt ? row.createdAt.slice(0, 10) : '')
      if (yearOf(d) === year) totals.labor += parseFloat(row.total) || 0
    })

    maint.forEach(row => {
      if (row.status !== 'complete') return
      if (yearOf(row.completedDate) !== year) return
      const cat = maintenanceBudgetCategory(row)
      totals[cat] = (totals[cat] || 0) + (parseFloat(row.actualCost) || 0)
    })

    vendorBookings.forEach(row => {
      const show = row.showId ? showById[row.showId] : null
      const d = show?.date
      if (yearOf(d) === year) totals.vendors += parseFloat(row.amount) || 0
    })

    return totals
  }, [labor, maint, vendorBookings, showById, year])

  // ── Persistence helpers ─────────────────────────────────────────────────
  async function saveYearBudget() {
    setSavingKey(`year:${year}`)
    try {
      const allocations = yearDraft || yearAllocations
      const categories = serializeCategories(allocations)
      const totalAllocated = Object.values(allocations).reduce((s, v) => s + (parseFloat(v) || 0), 0)
      if (yearBudget) {
        const patch = { categories, totalAllocated, updatedAt: new Date().toISOString() }
        await api.put(`/budgets/${yearBudget.id}`, patch)
        setBudgets(list => list.map(b => b.id === yearBudget.id ? { ...b, ...patch } : b))
      } else {
        const res = await api.post('/budgets', {
          scope: 'year', scopeKey: year, categories, totalAllocated,
        })
        setBudgets(list => [...list, res.data.data])
      }
      setYearDraft(null)
    } finally {
      setSavingKey(null)
    }
  }

  async function saveShowBudget(showId) {
    setSavingKey(`show:${showId}`)
    try {
      const existing = showBudgetsById[showId]
      const allocations = showDrafts[showId] || parseCategories(existing?.categories)
      const categories = serializeCategories(allocations)
      const totalAllocated = Object.values(allocations).reduce((s, v) => s + (parseFloat(v) || 0), 0)
      if (existing) {
        const patch = { categories, totalAllocated, updatedAt: new Date().toISOString() }
        await api.put(`/budgets/${existing.id}`, patch)
        setBudgets(list => list.map(b => b.id === existing.id ? { ...b, ...patch } : b))
      } else {
        const res = await api.post('/budgets', {
          scope: 'show', scopeKey: showId, categories, totalAllocated,
        })
        setBudgets(list => [...list, res.data.data])
      }
      setShowDrafts(d => { const n = { ...d }; delete n[showId]; return n })
    } finally {
      setSavingKey(null)
    }
  }

  function setYearAllocation(key, value) {
    setYearDraft(d => ({ ...(d || yearAllocations), [key]: value }))
  }
  function setShowAllocation(showId, key, value) {
    setShowDrafts(d => {
      const current = d[showId] || parseCategories(showBudgetsById[showId]?.categories)
      return { ...d, [showId]: { ...current, [key]: value } }
    })
  }

  if (!allowed) return <Navigate to="/dashboard" replace />

  const totalYearAllocated = Object.values(yearAllocations).reduce((s, v) => s + (parseFloat(v) || 0), 0)
  const totalYearActual    = Object.values(yearActuals).reduce((s, v) => s + v, 0)
  const yearRemaining      = totalYearAllocated - totalYearActual
  const yearPct = totalYearAllocated > 0 ? Math.round((totalYearActual / totalYearAllocated) * 100) : 0
  const yearOver = totalYearAllocated > 0 && totalYearActual > totalYearAllocated

  const editingYear = yearDraft !== null

  return (
    <div style={{ padding: '1rem 1.25rem', maxWidth: 1200 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>📊 Production Budgets</h2>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Year</span>
          <select value={year} onChange={e => { setYear(e.target.value); setYearDraft(null); setShowDrafts({}) }}>
            {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          {yearBudget ? `Budget set · updated ${yearBudget.updatedAt?.slice(0, 10) || ''}` : 'No budget yet for this year'}
        </span>
      </div>

      {/* Yearly KPIs */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        <Kpi label={`${year} Budget`} value={money(totalYearAllocated)} />
        <Kpi label="Actual YTD"       value={money(totalYearActual)} />
        <Kpi label="Remaining"        value={money(yearRemaining)}
             danger={yearOver} warn={!yearOver && yearPct >= 85} />
        <Kpi label="% Used"           value={`${yearPct}%`}
             danger={yearOver} warn={!yearOver && yearPct >= 85} />
        <Kpi label="Shows In Year"    value={String(yearShows.length)} />
      </div>

      {/* Yearly budget table */}
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Annual Category Budget</h3>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {editingYear && (
              <button className="btn" onClick={() => setYearDraft(null)}>Discard</button>
            )}
            <button className="btn btn-primary"
              disabled={!editingYear || savingKey === `year:${year}`}
              onClick={saveYearBudget}>
              {savingKey === `year:${year}` ? 'Saving…' : (yearBudget ? 'Save Changes' : 'Create Budget')}
            </button>
          </div>
        </div>

        {loading ? <p>Loading…</p> : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thLeft}>Category</th>
                <th style={thRight}>Allocated</th>
                <th style={thRight}>Actual</th>
                <th style={thRight}>Remaining</th>
                <th style={thRight}>% Used</th>
                <th style={{ minWidth: 160 }}></th>
              </tr>
            </thead>
            <tbody>
              {CATEGORIES.map(c => {
                const allocated = parseFloat((yearDraft || yearAllocations)[c.key]) || 0
                const actual    = yearActuals[c.key] || 0
                const remaining = allocated - actual
                const pct       = allocated > 0 ? Math.round((actual / allocated) * 100) : 0
                const over      = allocated > 0 && actual > allocated
                const unbudget  = !allocated && actual > 0
                return (
                  <tr key={c.key}>
                    <td style={tdLeft}>
                      <span style={{ display: 'inline-block', width: 8, height: 8, background: c.color, borderRadius: 2, marginRight: 8, verticalAlign: 'middle' }} />
                      {c.label}
                    </td>
                    <td style={tdRight}>
                      <input type="number" step="0.01" style={cellInput}
                        value={(yearDraft || yearAllocations)[c.key] ?? 0}
                        onChange={e => setYearAllocation(c.key, e.target.value)} />
                    </td>
                    <td style={tdRight}>{money(actual)}</td>
                    <td style={{ ...tdRight, color: over ? '#c0392b' : undefined }}>
                      {allocated ? money(remaining) : ''}
                    </td>
                    <td style={{ ...tdRight, color: over ? '#c0392b' : unbudget ? '#c0392b' : undefined }}>
                      {allocated ? `${pct}%` : unbudget ? 'unbudgeted' : ''}
                    </td>
                    <td><Bar value={actual} allocated={allocated} color={c.color} /></td>
                  </tr>
                )
              })}
              <tr style={{ borderTop: '2px solid var(--border)' }}>
                <td style={{ ...tdLeft, fontWeight: 700 }}>Total</td>
                <td style={{ ...tdRight, fontWeight: 700 }}>{money(
                  Object.values(yearDraft || yearAllocations).reduce((s, v) => s + (parseFloat(v) || 0), 0)
                )}</td>
                <td style={{ ...tdRight, fontWeight: 700 }}>{money(totalYearActual)}</td>
                <td style={{ ...tdRight, fontWeight: 700, color: yearOver ? '#c0392b' : undefined }}>
                  {money(yearRemaining)}
                </td>
                <td style={{ ...tdRight, fontWeight: 700, color: yearOver ? '#c0392b' : undefined }}>
                  {yearPct}%
                </td>
                <td></td>
              </tr>
            </tbody>
          </table>
        )}
      </div>

      {/* Per-show budgets */}
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Per-Show Budgets — {year}</h3>
          <span style={{ marginLeft: 12, color: 'var(--text-muted)', fontSize: 12 }}>
            {yearShows.filter(s => showBudgetsById[s.id]).length} of {yearShows.length} shows have a budget
          </span>
        </div>

        {loading ? <p>Loading…</p> : yearShows.length === 0 ? (
          <p style={{ color: 'var(--text-muted)' }}>No shows in {year}.</p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thLeft}>Date</th>
                <th style={thLeft}>Show</th>
                <th style={thLeft}>Stage</th>
                <th style={thRight}>Allocated</th>
                <th style={thRight}>Actual</th>
                <th style={thRight}>Remaining</th>
                <th style={{ minWidth: 140 }}></th>
                <th style={thRight}></th>
              </tr>
            </thead>
            <tbody>
              {yearShows.map(show => {
                const budget = showBudgetsById[show.id]
                const allocations = showDrafts[show.id] || parseCategories(budget?.categories)
                const actuals = showActuals[show.id] || emptyAllocations()
                const totalAlloc  = Object.values(allocations).reduce((s, v) => s + (parseFloat(v) || 0), 0)
                const totalActual = Object.values(actuals).reduce((s, v) => s + v, 0)
                const remaining   = totalAlloc - totalActual
                const over        = totalAlloc > 0 && totalActual > totalAlloc
                const isOpen      = expandedShow === show.id
                const dirty       = !!showDrafts[show.id]
                return (
                  <Fragment key={show.id}>
                    <tr style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={tdLeft}>{show.date || ''}</td>
                      <td style={tdLeft}>
                        <Link to={`/shows/${show.id}`}>{show.artist || show.eventName || '(unnamed)'}</Link>
                      </td>
                      <td style={{ ...tdLeft, textTransform: 'capitalize' }}>{show.stage || ''}</td>
                      <td style={tdRight}>{totalAlloc ? money(totalAlloc) : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                      <td style={tdRight}>{money(totalActual)}</td>
                      <td style={{ ...tdRight, color: over ? '#c0392b' : undefined }}>
                        {totalAlloc ? money(remaining) : ''}
                      </td>
                      <td><Bar value={totalActual} allocated={totalAlloc} /></td>
                      <td style={{ ...tdRight }}>
                        <button className="btn btn-sm"
                          onClick={() => setExpandedShow(isOpen ? null : show.id)}>
                          {isOpen ? 'Hide' : (budget ? 'Edit' : 'Set Budget')}
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr style={{ background: 'rgba(127,127,127,0.06)' }}>
                        <td colSpan={8} style={{ padding: 14, borderTop: '1px solid var(--border)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
                            <strong>Categories for this show</strong>
                            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                              {dirty && (
                                <button className="btn btn-sm" onClick={() =>
                                  setShowDrafts(d => { const n = { ...d }; delete n[show.id]; return n })
                                }>Discard</button>
                              )}
                              <button className="btn btn-primary btn-sm"
                                disabled={!dirty || savingKey === `show:${show.id}`}
                                onClick={() => saveShowBudget(show.id)}>
                                {savingKey === `show:${show.id}` ? 'Saving…' : (budget ? 'Save' : 'Create')}
                              </button>
                            </div>
                          </div>
                          <table style={tableStyle}>
                            <thead>
                              <tr>
                                <th style={thLeft}>Category</th>
                                <th style={thRight}>Allocated</th>
                                <th style={thRight}>Actual</th>
                                <th style={thRight}>Remaining</th>
                                <th style={{ minWidth: 140 }}></th>
                              </tr>
                            </thead>
                            <tbody>
                              {CATEGORIES.map(c => {
                                const allocated = parseFloat(allocations[c.key]) || 0
                                const actual    = actuals[c.key] || 0
                                const rem       = allocated - actual
                                const isTracked = c.key === 'labor' || c.key === 'vendors'
                                return (
                                  <tr key={c.key}>
                                    <td style={tdLeft}>
                                      <span style={{ display: 'inline-block', width: 8, height: 8, background: c.color, borderRadius: 2, marginRight: 8, verticalAlign: 'middle' }} />
                                      {c.label}
                                      {!isTracked && (
                                        <span title="Actuals for this category are only rolled up at the yearly level."
                                          style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-muted)' }}>
                                          (yearly only)
                                        </span>
                                      )}
                                    </td>
                                    <td style={tdRight}>
                                      <input type="number" step="0.01" style={cellInput}
                                        value={allocations[c.key] ?? 0}
                                        onChange={e => setShowAllocation(show.id, c.key, e.target.value)} />
                                    </td>
                                    <td style={tdRight}>{isTracked ? money(actual) : <span style={{ color: 'var(--text-muted)', opacity: 0.5 }}>—</span>}</td>
                                    <td style={{ ...tdRight, color: (isTracked && actual > allocated && allocated > 0) ? '#c0392b' : undefined }}>
                                      {isTracked && allocated ? money(rem) : ''}
                                    </td>
                                    <td>{isTracked && <Bar value={actual} allocated={allocated} color={c.color} />}</td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                            Actuals shown here come from Labor (row.total) and Vendor Bookings (row.amount)
                            attached to this show. Other categories track at the yearly level only for now.
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 13 }
const tdLeft  = { padding: '6px 8px', borderBottom: '1px solid var(--border)' }
const tdRight = { padding: '6px 8px', borderBottom: '1px solid var(--border)', textAlign: 'right', whiteSpace: 'nowrap' }
const thLeft  = { padding: '6px 8px', textAlign: 'left',  borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)' }
const thRight = { padding: '6px 8px', textAlign: 'right', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)' }
const cellInput = {
  width: 110, textAlign: 'right', padding: '4px 6px',
  border: '1px solid var(--border)', borderRadius: 4, fontSize: 13,
  background: 'var(--bg-card)', color: 'var(--text)',
}
