import { useEffect, useMemo, useState, Fragment } from 'react'
import { Navigate } from 'react-router-dom'
import api from '../api'
import Modal from '../components/Modal'
import { useAuth } from '../context/AuthContext'
import { money } from '../utils/exportHelpers'

// Maintenance — issues (repair/upkeep tickets) + projects (production-head proposals).
// stage_manager can submit and edit; only admin / production_manager may approve,
// reject, or delete. quotes column is a JSON blob (parsed on read, stringified on write).

const ALLOWED_ROLES  = ['admin', 'production_manager', 'stage_manager']
const APPROVER_ROLES = ['admin', 'production_manager']

const ITEM_TYPES = [
  { key: 'issue',   label: 'Issue / Ticket',   color: '#0b7bcf' },
  { key: 'project', label: 'Project Proposal', color: '#7a5cff' },
]

const CATEGORIES = [
  { key: 'repair',      label: 'Repair' },
  { key: 'maintenance', label: 'Maintenance' },
  { key: 'upgrade',     label: 'Upgrade' },
  { key: 'inspection',  label: 'Inspection' },
]

const PRIORITIES = [
  { key: 'low',    label: 'Low',    color: '#6b7280' },
  { key: 'medium', label: 'Medium', color: '#0b7bcf' },
  { key: 'high',   label: 'High',   color: '#c26a00' },
  { key: 'urgent', label: 'Urgent', color: '#c0392b' },
]

const STATUSES = [
  { key: 'proposed',     label: 'Proposed',     color: '#7a5cff', kind: 'project' },
  { key: 'under_review', label: 'Under Review', color: '#5e4bd4', kind: 'project' },
  { key: 'needs_info',   label: 'Needs Info',   color: '#c26a00', kind: 'project' },
  { key: 'rejected',     label: 'Rejected',     color: '#c0392b', kind: 'project' },
  { key: 'open',         label: 'Open',         color: '#6b7280', kind: 'issue'   },
  { key: 'quoting',      label: 'Quoting',      color: '#0b7bcf', kind: 'any'     },
  { key: 'approved',     label: 'Approved',     color: '#2fa36a', kind: 'any'     },
  { key: 'scheduled',    label: 'Scheduled',    color: '#8a6a3f', kind: 'any'     },
  { key: 'in_progress',  label: 'In Progress',  color: '#c26a00', kind: 'any'     },
  { key: 'complete',     label: 'Complete',     color: '#2fa36a', kind: 'any'     },
  { key: 'deferred',     label: 'Deferred',     color: '#999',    kind: 'any'     },
  { key: 'cancelled',    label: 'Cancelled',    color: '#999',    kind: 'any'     },
]

const OPEN_STATUSES     = new Set(['open', 'quoting', 'approved', 'scheduled', 'in_progress'])
const PROPOSAL_STATUSES = new Set(['proposed', 'under_review', 'needs_info'])
const APPROVAL_LOCKED_STATUSES = new Set(['approved', 'rejected'])

const BLANK_ISSUE = {
  itemType: 'issue',
  title: '', description: '', category: 'repair', area: '', priority: 'medium',
  status: 'open', reportedBy: '', reportedDate: '', dueDate: '', scheduledDate: '',
  completedDate: '', estimatedCost: '', approvedCost: '', actualCost: '',
  vendorId: '', vendorName: '', invoiceNumber: '', notes: '',
  proposedBy: '', justification: '', scope: '', budgetLow: '', budgetHigh: '',
  approvedBy: '', approvedAt: '', rejectedReason: '',
}

const BLANK_PROJECT = { ...BLANK_ISSUE, itemType: 'project', category: 'upgrade', status: 'proposed' }

function today() {
  return new Date().toISOString().slice(0, 10)
}

function parseQuotes(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

function Chip({ color, children, title }) {
  return (
    <span title={title} style={{
      background: color, color: '#fff', fontSize: 11, padding: '2px 8px',
      borderRadius: 10, whiteSpace: 'nowrap'
    }}>{children}</span>
  )
}

function priorityChip(p) {
  const found = PRIORITIES.find(x => x.key === p) || PRIORITIES[0]
  return <Chip color={found.color}>{found.label}</Chip>
}
function statusChip(s) {
  const found = STATUSES.find(x => x.key === s) || STATUSES[0]
  return <Chip color={found.color}>{found.label}</Chip>
}

export default function Maintenance() {
  const { user, effectiveRole } = useAuth()
  const role = effectiveRole || user?.role || ''
  const allowed  = ALLOWED_ROLES.includes(role)
  const canApprove = APPROVER_ROLES.includes(role)
  const canDelete  = APPROVER_ROLES.includes(role)
  const myIdentity = (user?.name || user?.email || '').trim()

  const [items, setItems]     = useState([])
  const [vendors, setVendors] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)

  const [filter, setFilter] = useState({
    tab: 'all',       // 'all' | 'issues' | 'proposals' | 'pending'
    status: 'open_all',
    category: '', priority: '', area: '', q: '',
  })
  const [expanded, setExpanded] = useState(null)

  const [modal, setModal]   = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm]     = useState(BLANK_ISSUE)

  // Rejection reason prompt is inline in the expanded panel; no modal needed.
  const [rejectDraft, setRejectDraft] = useState({})   // { [itemId]: reasonText }

  const [quoteForm, setQuoteForm] = useState({ vendorName: '', amount: '', filedDate: '', validUntil: '', notes: '' })

  useEffect(() => {
    if (!allowed) return
    let cancelled = false
    ;(async () => {
      try {
        const [m, v] = await Promise.all([
          api.get('/maintenance'),
          api.get('/vendors').catch(() => ({ data: { data: [] } })),
        ])
        if (cancelled) return
        setItems((m.data.data || []).map(row => ({ ...row, quotes: parseQuotes(row.quotes) })))
        setVendors(v.data.data || [])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [allowed])

  const areaOptions = useMemo(() => {
    const set = new Set()
    items.forEach(i => { if (i.area) set.add(i.area) })
    return [...set].sort()
  }, [items])

  const filtered = useMemo(() => {
    const q = filter.q.trim().toLowerCase()
    return items.filter(i => {
      const type = i.itemType || 'issue'
      if (filter.tab === 'issues'    && type !== 'issue')   return false
      if (filter.tab === 'proposals' && type !== 'project') return false
      if (filter.tab === 'pending'   && !PROPOSAL_STATUSES.has(i.status)) return false
      if (filter.tab !== 'pending') {
        if (filter.status === 'open_all') {
          const isOpen = OPEN_STATUSES.has(i.status) || PROPOSAL_STATUSES.has(i.status)
          if (!isOpen) return false
        } else if (filter.status && i.status !== filter.status) return false
      }
      if (filter.category && i.category !== filter.category) return false
      if (filter.priority && i.priority !== filter.priority) return false
      if (filter.area && i.area !== filter.area) return false
      if (q) {
        const hay = `${i.title} ${i.description} ${i.area} ${i.vendorName} ${i.notes} ${i.justification} ${i.scope} ${i.proposedBy}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    }).sort((a, b) => {
      // Pending proposals bubble to the top, then urgent, then due date.
      const ap = PROPOSAL_STATUSES.has(a.status) ? 0 : 1
      const bp = PROPOSAL_STATUSES.has(b.status) ? 0 : 1
      if (ap !== bp) return ap - bp
      const pRank = { urgent: 0, high: 1, medium: 2, low: 3 }
      const pa = pRank[a.priority] ?? 4
      const pb = pRank[b.priority] ?? 4
      if (pa !== pb) return pa - pb
      if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate)
      if (a.dueDate && !b.dueDate) return -1
      if (!a.dueDate && b.dueDate) return 1
      return (b.reportedDate || '').localeCompare(a.reportedDate || '')
    })
  }, [items, filter])

  const kpis = useMemo(() => {
    const openItems       = items.filter(i => OPEN_STATUSES.has(i.status))
    const urgentOpen      = openItems.filter(i => i.priority === 'urgent').length
    const overdueOpen     = openItems.filter(i => i.dueDate && i.dueDate < today()).length
    const openEstimated   = openItems.reduce((s, i) => s + (parseFloat(i.estimatedCost) || 0), 0)
    const openApproved    = openItems.reduce((s, i) => s + (parseFloat(i.approvedCost)  || 0), 0)
    const completedActual = items
      .filter(i => i.status === 'complete')
      .reduce((s, i) => s + (parseFloat(i.actualCost) || 0), 0)
    const ytd = items.filter(i =>
      i.status === 'complete' &&
      i.completedDate &&
      i.completedDate.startsWith(String(new Date().getFullYear()))
    ).reduce((s, i) => s + (parseFloat(i.actualCost) || 0), 0)
    const pendingProposals = items.filter(i => (i.itemType === 'project') && PROPOSAL_STATUSES.has(i.status))
    const pendingProposalBudget = pendingProposals.reduce((s, i) => {
      const hi = parseFloat(i.budgetHigh) || 0
      const lo = parseFloat(i.budgetLow)  || 0
      return s + (hi || lo || parseFloat(i.estimatedCost) || 0)
    }, 0)
    return {
      openCount: openItems.length, urgentOpen, overdueOpen, openEstimated, openApproved,
      completedActual, ytd,
      pendingProposals: pendingProposals.length,
      pendingProposalBudget,
    }
  }, [items])

  function openCreate(kind = 'issue') {
    setEditing(null)
    const base = kind === 'project' ? BLANK_PROJECT : BLANK_ISSUE
    setForm({
      ...base,
      reportedBy: myIdentity,
      reportedDate: today(),
      proposedBy: kind === 'project' ? myIdentity : '',
    })
    setModal(true)
  }
  function openEdit(row) {
    setEditing(row)
    setForm({
      itemType: row.itemType || 'issue',
      title: row.title || '', description: row.description || '',
      category: row.category || 'repair', area: row.area || '',
      priority: row.priority || 'medium', status: row.status || 'open',
      reportedBy: row.reportedBy || '', reportedDate: row.reportedDate || '',
      dueDate: row.dueDate || '', scheduledDate: row.scheduledDate || '',
      completedDate: row.completedDate || '',
      estimatedCost: row.estimatedCost || '', approvedCost: row.approvedCost || '',
      actualCost: row.actualCost || '',
      vendorId: row.vendorId || '', vendorName: row.vendorName || '',
      invoiceNumber: row.invoiceNumber || '', notes: row.notes || '',
      proposedBy: row.proposedBy || '', justification: row.justification || '',
      scope: row.scope || '', budgetLow: row.budgetLow || '', budgetHigh: row.budgetHigh || '',
      approvedBy: row.approvedBy || '', approvedAt: row.approvedAt || '',
      rejectedReason: row.rejectedReason || '',
    })
    setModal(true)
  }

  function canEdit(row) {
    if (canApprove) return true
    if (role !== 'stage_manager') return false
    // Stage managers may only edit their own submissions.
    const owner = (row.proposedBy || row.reportedBy || '').trim().toLowerCase()
    return owner && owner === myIdentity.toLowerCase()
  }

  async function saveItem() {
    if (!form.title.trim()) return
    setSaving(true)
    try {
      const payload = { ...form }
      // Auto-stamp completedDate when the user flips status to complete without picking a date.
      if (payload.status === 'complete' && !payload.completedDate) payload.completedDate = today()
      if (editing) {
        await api.put(`/maintenance/${editing.id}`, payload)
        const updated = { ...editing, ...payload, quotes: parseQuotes(payload.quotes ?? editing.quotes) }
        setItems(list => list.map(x => x.id === editing.id ? updated : x))
      } else {
        const res = await api.post('/maintenance', { ...payload, quotes: '[]' })
        const created = res.data.data
        setItems(list => [...list, { ...created, quotes: parseQuotes(created.quotes) }])
      }
      setModal(false)
    } finally {
      setSaving(false)
    }
  }

  async function deleteItem(row) {
    if (!confirm(`Delete "${row.title}"? This cannot be undone.`)) return
    await api.delete(`/maintenance/${row.id}`)
    setItems(list => list.filter(x => x.id !== row.id))
    if (expanded === row.id) setExpanded(null)
  }

  async function persistQuotes(row, newQuotes) {
    await api.put(`/maintenance/${row.id}`, { quotes: JSON.stringify(newQuotes) })
    setItems(list => list.map(x => x.id === row.id
      ? { ...x, quotes: newQuotes }
      : x))
  }

  async function addQuote(row) {
    if (!quoteForm.vendorName.trim() || !quoteForm.amount) return
    const q = {
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      vendorName: quoteForm.vendorName.trim(),
      amount: quoteForm.amount,
      filedDate: quoteForm.filedDate || today(),
      validUntil: quoteForm.validUntil || '',
      notes: quoteForm.notes || '',
      status: 'pending',
    }
    const next = [...(row.quotes || []), q]
    await persistQuotes(row, next)
    setQuoteForm({ vendorName: '', amount: '', filedDate: '', validUntil: '', notes: '' })
  }

  async function removeQuote(row, quoteId) {
    const next = (row.quotes || []).filter(q => q.id !== quoteId)
    await persistQuotes(row, next)
  }

  async function selectQuote(row, quoteId) {
    const next = (row.quotes || []).map(q => ({
      ...q,
      status: q.id === quoteId ? 'selected' : (q.status === 'selected' ? 'rejected' : q.status)
    }))
    const winner = next.find(q => q.id === quoteId)
    // Selecting a quote also stamps the approvedCost and moves the item forward if it's still upstream.
    const patch = { quotes: JSON.stringify(next) }
    if (winner) patch.approvedCost = winner.amount
    if (row.status === 'open' || row.status === 'quoting') patch.status = 'approved'
    await api.put(`/maintenance/${row.id}`, patch)
    setItems(list => list.map(x => x.id === row.id
      ? { ...x, ...patch, quotes: next }
      : x))
  }

  async function decideProposal(row, decision, reason = '') {
    if (!canApprove) return
    const patch = {}
    if (decision === 'approve') {
      patch.status = 'approved'
      patch.approvedBy = myIdentity
      patch.approvedAt = today()
    } else if (decision === 'reject') {
      patch.status = 'rejected'
      patch.approvedBy = myIdentity
      patch.approvedAt = today()
      patch.rejectedReason = reason || ''
    } else if (decision === 'needs_info') {
      patch.status = 'needs_info'
    } else if (decision === 'under_review') {
      patch.status = 'under_review'
    }
    await api.put(`/maintenance/${row.id}`, patch)
    setItems(list => list.map(x => x.id === row.id
      ? { ...x, ...patch }
      : x))
    setRejectDraft(d => ({ ...d, [row.id]: '' }))
  }

  if (!allowed) return <Navigate to="/dashboard" replace />

  return (
    <div style={{ padding: '1rem 1.25rem', maxWidth: 1200 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>🛠️ Maintenance</h2>
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Repairs · Maintenance · Upgrades · Project Proposals</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => openCreate('issue')}>+ New Issue</button>
          <button className="btn btn-primary" onClick={() => openCreate('project')}>+ New Project Proposal</button>
        </div>
      </div>

      {/* KPIs */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        <Kpi label="Open Items"       value={String(kpis.openCount)} />
        <Kpi label="Urgent"           value={String(kpis.urgentOpen)}  danger={kpis.urgentOpen > 0} />
        <Kpi label="Overdue"          value={String(kpis.overdueOpen)} danger={kpis.overdueOpen > 0} />
        <Kpi label="Pending Proposals" value={String(kpis.pendingProposals)}
             sub={kpis.pendingProposalBudget ? money(kpis.pendingProposalBudget) + ' in review' : ''} />
        <Kpi label="Open · Estimated" value={money(kpis.openEstimated)} />
        <Kpi label="Open · Approved"  value={money(kpis.openApproved)} />
        <Kpi label="Completed Spend"  value={money(kpis.completedActual)} sub="Lifetime" />
        <Kpi label="Completed YTD"    value={money(kpis.ytd)} />
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 12, borderBottom: '1px solid var(--border)' }}>
        {[
          { key: 'all',       label: 'All' },
          { key: 'issues',    label: 'Issues' },
          { key: 'proposals', label: 'Project Proposals' },
          { key: 'pending',   label: `Awaiting Approval${kpis.pendingProposals ? ` (${kpis.pendingProposals})` : ''}` },
        ].map(t => {
          const active = filter.tab === t.key
          return (
            <button key={t.key}
              onClick={() => setFilter(f => ({ ...f, tab: t.key }))}
              style={{
                background: 'transparent', border: 0, padding: '8px 14px', cursor: 'pointer',
                fontSize: 13, fontWeight: active ? 600 : 400,
                color: active ? '#0b7bcf' : 'var(--text-muted)',
                borderBottom: active ? '2px solid #0b7bcf' : '2px solid transparent',
              }}>
              {t.label}
            </button>
          )
        })}
      </div>

      {/* Filters */}
      <div style={{
        background: 'var(--bg-sidebar)', border: '1px solid var(--border)', borderRadius: 8,
        padding: 12, marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center'
      }}>
        <input placeholder="Search…" value={filter.q}
          onChange={e => setFilter(f => ({ ...f, q: e.target.value }))}
          style={{ minWidth: 200 }} />
        {filter.tab !== 'pending' && (
          <select value={filter.status} onChange={e => setFilter(f => ({ ...f, status: e.target.value }))}>
            <option value="open_all">All Open</option>
            <option value="">All Statuses</option>
            {STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        )}
        <select value={filter.category} onChange={e => setFilter(f => ({ ...f, category: e.target.value }))}>
          <option value="">All Categories</option>
          {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        <select value={filter.priority} onChange={e => setFilter(f => ({ ...f, priority: e.target.value }))}>
          <option value="">Any Priority</option>
          {PRIORITIES.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        <select value={filter.area} onChange={e => setFilter(f => ({ ...f, area: e.target.value }))}>
          <option value="">All Areas</option>
          {areaOptions.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 'auto' }}>
          {filtered.length} of {items.length}
        </span>
      </div>

      {loading ? <p>Loading…</p> : filtered.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>No maintenance items match these filters.</p>
      ) : (
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--bg-sidebar)' }}>
                <th style={th}>Item</th>
                <th style={th}>Area</th>
                <th style={th}>Category</th>
                <th style={th}>Priority</th>
                <th style={th}>Status</th>
                <th style={th}>Due</th>
                <th style={{ ...th, textAlign: 'right' }}>Est.</th>
                <th style={{ ...th, textAlign: 'right' }}>Approved</th>
                <th style={{ ...th, textAlign: 'right' }}>Actual</th>
                <th style={th}>Quotes</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(row => {
                const isOpen = expanded === row.id
                const overdue = row.dueDate && row.dueDate < today() && OPEN_STATUSES.has(row.status)
                const isProject = (row.itemType || 'issue') === 'project'
                const editable  = canEdit(row)
                return (
                  <Fragment key={row.id}>
                    <tr style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={td}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          {isProject && <Chip color="#7a5cff">PROJECT</Chip>}
                          <span style={{ fontWeight: 600 }}>{row.title}</span>
                        </div>
                        {row.description && (
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                            {row.description.length > 90 ? row.description.slice(0, 90) + '…' : row.description}
                          </div>
                        )}
                        {isProject && row.proposedBy && (
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                            Proposed by {row.proposedBy}
                            {row.approvedBy && ` · ${row.status === 'rejected' ? 'Rejected' : 'Approved'} by ${row.approvedBy}`}
                          </div>
                        )}
                      </td>
                      <td style={td}>{row.area || ''}</td>
                      <td style={{ ...td, textTransform: 'capitalize' }}>{row.category || ''}</td>
                      <td style={td}>{priorityChip(row.priority)}</td>
                      <td style={td}>{statusChip(row.status)}</td>
                      <td style={{ ...td, color: overdue ? '#c0392b' : undefined, fontWeight: overdue ? 600 : 400 }}>
                        {row.dueDate || ''}{overdue && ' ⚠'}
                      </td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        {row.estimatedCost ? money(row.estimatedCost) : ''}
                        {isProject && !row.estimatedCost && (row.budgetLow || row.budgetHigh) && (
                          <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                            {row.budgetLow ? money(row.budgetLow) : ''}
                            {(row.budgetLow && row.budgetHigh) ? '–' : ''}
                            {row.budgetHigh ? money(row.budgetHigh) : ''}
                          </span>
                        )}
                      </td>
                      <td style={{ ...td, textAlign: 'right' }}>{row.approvedCost  ? money(row.approvedCost)  : ''}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{row.actualCost    ? money(row.actualCost)    : ''}</td>
                      <td style={td}>
                        <button className="btn btn-sm" onClick={() => setExpanded(isOpen ? null : row.id)}>
                          {(row.quotes?.length || 0)} {isOpen ? '▲' : '▼'}
                        </button>
                      </td>
                      <td style={td}>
                        {editable && <button className="btn btn-sm" onClick={() => openEdit(row)}>Edit</button>}
                        {editable && canDelete && ' '}
                        {canDelete && <button className="btn btn-sm btn-danger" onClick={() => deleteItem(row)}>Del</button>}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr key={`${row.id}-x`} style={{ background: 'rgba(127,127,127,0.06)' }}>
                        <td colSpan={11} style={{ padding: 14, borderTop: '1px solid var(--border)' }}>
                          {isProject && (
                            <ProposalPanel
                              row={row}
                              canApprove={canApprove}
                              rejectDraft={rejectDraft[row.id] || ''}
                              onRejectDraftChange={v => setRejectDraft(d => ({ ...d, [row.id]: v }))}
                              onDecide={decideProposal}
                            />
                          )}
                          <QuotesPanel
                            row={row}
                            quoteForm={quoteForm}
                            setQuoteForm={setQuoteForm}
                            onAdd={() => addQuote(row)}
                            onSelect={qid => selectQuote(row, qid)}
                            onRemove={qid => removeQuote(row, qid)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <Modal
          title={editing
            ? `Edit ${form.itemType === 'project' ? 'Project Proposal' : 'Maintenance Item'}`
            : (form.itemType === 'project' ? 'New Project Proposal' : 'New Maintenance Item')}
          onClose={() => setModal(false)}
          size="modal-lg"
          footer={
            <>
              <button className="btn" onClick={() => setModal(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={saving || !form.title.trim()} onClick={saveItem}>
                {saving ? 'Saving…' : (editing ? 'Save' : (form.itemType === 'project' ? 'Submit Proposal' : 'Create'))}
              </button>
            </>
          }
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {!editing && (
              <Field label="Type" span={2}>
                <select value={form.itemType}
                  onChange={e => {
                    const t = e.target.value
                    setForm(f => ({
                      ...f, itemType: t,
                      status: t === 'project' ? 'proposed' : 'open',
                      category: t === 'project' ? 'upgrade' : 'repair',
                      proposedBy: t === 'project' ? (f.proposedBy || myIdentity) : '',
                    }))
                  }}>
                  {ITEM_TYPES.map(x => <option key={x.key} value={x.key}>{x.label}</option>)}
                </select>
              </Field>
            )}
            <Field label="Title *" span={2}>
              <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
            </Field>
            <Field label={form.itemType === 'project' ? 'Summary' : 'Description'} span={2}>
              <textarea rows={3} value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
            </Field>

            {form.itemType === 'project' && (
              <>
                <Field label="Justification (why is this needed?)" span={2}>
                  <textarea rows={3} value={form.justification}
                    onChange={e => setForm(f => ({ ...f, justification: e.target.value }))}
                    placeholder="Problem being solved, ROI, safety / compliance driver, capability gained…" />
                </Field>
                <Field label="Scope of Work" span={2}>
                  <textarea rows={3} value={form.scope}
                    onChange={e => setForm(f => ({ ...f, scope: e.target.value }))}
                    placeholder="What's included, deliverables, phases, dependencies…" />
                </Field>
                <Field label="Budget — Low">
                  <input type="number" step="0.01" value={form.budgetLow}
                    onChange={e => setForm(f => ({ ...f, budgetLow: e.target.value }))} />
                </Field>
                <Field label="Budget — High">
                  <input type="number" step="0.01" value={form.budgetHigh}
                    onChange={e => setForm(f => ({ ...f, budgetHigh: e.target.value }))} />
                </Field>
                <Field label="Proposed By">
                  <input value={form.proposedBy}
                    onChange={e => setForm(f => ({ ...f, proposedBy: e.target.value }))} />
                </Field>
              </>
            )}

            <Field label="Category">
              <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
                {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </Field>
            <Field label="Area / Location">
              <input list="maint-areas" value={form.area}
                onChange={e => setForm(f => ({ ...f, area: e.target.value }))}
                placeholder="Inside Stage, Beach FOH, Loading Dock…" />
              <datalist id="maint-areas">
                {areaOptions.map(a => <option key={a} value={a} />)}
              </datalist>
            </Field>
            <Field label="Priority">
              <select value={form.priority} onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}>
                {PRIORITIES.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </Field>
            <Field label="Status">
              <select value={form.status}
                disabled={!canApprove && APPROVAL_LOCKED_STATUSES.has(form.status)}
                onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                {STATUSES
                  .filter(s => {
                    // Hide project-only statuses on issues and vice versa; keep 'any' for both.
                    if (s.kind === 'project' && form.itemType !== 'project') return false
                    if (s.kind === 'issue'   && form.itemType === 'project') return false
                    return true
                  })
                  .filter(s => canApprove || !APPROVAL_LOCKED_STATUSES.has(s.key))
                  .map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </Field>
            <Field label={form.itemType === 'project' ? 'Requested By' : 'Reported By'}>
              <input value={form.reportedBy} onChange={e => setForm(f => ({ ...f, reportedBy: e.target.value }))} />
            </Field>
            <Field label={form.itemType === 'project' ? 'Requested Date' : 'Reported Date'}>
              <input type="date" value={form.reportedDate}
                onChange={e => setForm(f => ({ ...f, reportedDate: e.target.value }))} />
            </Field>
            <Field label="Due / Target Date">
              <input type="date" value={form.dueDate}
                onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))} />
            </Field>
            <Field label="Scheduled Date">
              <input type="date" value={form.scheduledDate}
                onChange={e => setForm(f => ({ ...f, scheduledDate: e.target.value }))} />
            </Field>
            <Field label="Completed Date">
              <input type="date" value={form.completedDate}
                onChange={e => setForm(f => ({ ...f, completedDate: e.target.value }))} />
            </Field>
            <Field label="Estimated Cost">
              <input type="number" step="0.01" value={form.estimatedCost}
                onChange={e => setForm(f => ({ ...f, estimatedCost: e.target.value }))} />
            </Field>
            <Field label="Approved Cost">
              <input type="number" step="0.01" value={form.approvedCost}
                disabled={!canApprove}
                onChange={e => setForm(f => ({ ...f, approvedCost: e.target.value }))} />
            </Field>
            <Field label="Actual Cost">
              <input type="number" step="0.01" value={form.actualCost}
                onChange={e => setForm(f => ({ ...f, actualCost: e.target.value }))} />
            </Field>
            <Field label="Assigned Vendor">
              <select value={form.vendorId}
                onChange={e => {
                  const v = vendors.find(x => x.id === e.target.value)
                  setForm(f => ({ ...f, vendorId: e.target.value, vendorName: v?.company || v?.contactName || f.vendorName }))
                }}>
                <option value="">— None —</option>
                {vendors.map(v => <option key={v.id} value={v.id}>{v.company || v.contactName}</option>)}
              </select>
            </Field>
            <Field label="Invoice #">
              <input value={form.invoiceNumber} onChange={e => setForm(f => ({ ...f, invoiceNumber: e.target.value }))} />
            </Field>
            <Field label="Notes" span={2}>
              <textarea rows={3} value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  )
}

function ProposalPanel({ row, canApprove, rejectDraft, onRejectDraftChange, onDecide }) {
  const isPending = ['proposed', 'under_review', 'needs_info'].includes(row.status)
  const bLo = row.budgetLow  ? money(row.budgetLow)  : ''
  const bHi = row.budgetHigh ? money(row.budgetHigh) : ''
  return (
    <div style={{
      background: 'rgba(122,92,255,0.08)', border: '1px solid rgba(122,92,255,0.30)', borderRadius: 6,
      padding: 12, marginBottom: 14,
    }}>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
        <div><strong>Type:</strong> Project Proposal</div>
        {row.proposedBy && <div><strong>Proposed by:</strong> {row.proposedBy}</div>}
        {(bLo || bHi) && <div><strong>Budget range:</strong> {bLo}{(bLo && bHi) ? ' – ' : ''}{bHi}</div>}
        {row.approvedBy && (
          <div>
            <strong>{row.status === 'rejected' ? 'Rejected' : 'Approved'} by:</strong> {row.approvedBy}
            {row.approvedAt ? ` on ${row.approvedAt}` : ''}
          </div>
        )}
      </div>

      {row.justification && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: 0.3 }}>Justification</div>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{row.justification}</div>
        </div>
      )}
      {row.scope && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: 0.3 }}>Scope of Work</div>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{row.scope}</div>
        </div>
      )}
      {row.rejectedReason && (
        <div style={{ marginBottom: 8, padding: 8, background: 'rgba(192,57,43,0.10)', border: '1px solid rgba(192,57,43,0.35)', borderRadius: 4 }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#c0392b', letterSpacing: 0.3 }}>Rejection Reason</div>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{row.rejectedReason}</div>
        </div>
      )}

      {canApprove && isPending && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <button className="btn btn-primary btn-sm" onClick={() => onDecide(row, 'approve')}>✓ Approve</button>
          {row.status === 'proposed' && (
            <button className="btn btn-sm" onClick={() => onDecide(row, 'under_review')}>Mark Under Review</button>
          )}
          <button className="btn btn-sm" onClick={() => onDecide(row, 'needs_info')}>Request Info</button>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
            <input
              placeholder="Reason (required to reject)"
              value={rejectDraft}
              onChange={e => onRejectDraftChange(e.target.value)}
              style={{ minWidth: 220 }}
            />
            <button className="btn btn-danger btn-sm"
              disabled={!rejectDraft.trim()}
              onClick={() => onDecide(row, 'reject', rejectDraft.trim())}>
              ✕ Reject
            </button>
          </div>
        </div>
      )}
      {!canApprove && isPending && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Awaiting review by admin or production manager.
        </div>
      )}
    </div>
  )
}

function QuotesPanel({ row, quoteForm, setQuoteForm, onAdd, onSelect, onRemove }) {
  const quotes = row.quotes || []
  const selected = quotes.find(q => q.status === 'selected')
  const cheapest = quotes.length
    ? quotes.reduce((min, q) => (parseFloat(q.amount) < parseFloat(min.amount) ? q : min))
    : null
  return (
    <div>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 10, fontSize: 12, color: 'var(--text-muted)' }}>
        <div><strong>{quotes.length}</strong> quote{quotes.length === 1 ? '' : 's'}</div>
        {cheapest && <div>Lowest: <strong>{money(cheapest.amount)}</strong> — {cheapest.vendorName}</div>}
        {selected && <div>Selected: <strong>{money(selected.amount)}</strong> — {selected.vendorName}</div>}
      </div>

      {quotes.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 12 }}>
          <thead>
            <tr>
              <th style={thSm}>Vendor</th>
              <th style={{ ...thSm, textAlign: 'right' }}>Amount</th>
              <th style={thSm}>Filed</th>
              <th style={thSm}>Valid Until</th>
              <th style={thSm}>Status</th>
              <th style={thSm}>Notes</th>
              <th style={thSm}></th>
            </tr>
          </thead>
          <tbody>
            {quotes.map(q => (
              <tr key={q.id}>
                <td style={tdSm}>{q.vendorName}</td>
                <td style={{ ...tdSm, textAlign: 'right' }}>{money(q.amount)}</td>
                <td style={tdSm}>{q.filedDate}</td>
                <td style={tdSm}>{q.validUntil}</td>
                <td style={tdSm}>
                  {q.status === 'selected'  && <Chip color="#2fa36a">Selected</Chip>}
                  {q.status === 'rejected'  && <Chip color="#999">Rejected</Chip>}
                  {(!q.status || q.status === 'pending') && <Chip color="#6b7280">Pending</Chip>}
                </td>
                <td style={{ ...tdSm, color: 'var(--text-muted)' }}>{q.notes || ''}</td>
                <td style={tdSm}>
                  {q.status !== 'selected' && (
                    <button className="btn btn-sm" onClick={() => onSelect(q.id)}>Select</button>
                  )}{' '}
                  <button className="btn btn-sm btn-danger" onClick={() => onRemove(q.id)}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{
        background: 'var(--bg-card)', border: '1px dashed var(--border)', borderRadius: 6,
        padding: 10, display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 2fr auto', gap: 8, alignItems: 'end'
      }}>
        <Field label="Vendor" compact>
          <input value={quoteForm.vendorName}
            onChange={e => setQuoteForm(q => ({ ...q, vendorName: e.target.value }))} />
        </Field>
        <Field label="Amount" compact>
          <input type="number" step="0.01" value={quoteForm.amount}
            onChange={e => setQuoteForm(q => ({ ...q, amount: e.target.value }))} />
        </Field>
        <Field label="Filed" compact>
          <input type="date" value={quoteForm.filedDate}
            onChange={e => setQuoteForm(q => ({ ...q, filedDate: e.target.value }))} />
        </Field>
        <Field label="Valid Until" compact>
          <input type="date" value={quoteForm.validUntil}
            onChange={e => setQuoteForm(q => ({ ...q, validUntil: e.target.value }))} />
        </Field>
        <Field label="Notes" compact>
          <input value={quoteForm.notes}
            onChange={e => setQuoteForm(q => ({ ...q, notes: e.target.value }))} />
        </Field>
        <button className="btn btn-primary" onClick={onAdd}
          disabled={!quoteForm.vendorName.trim() || !quoteForm.amount}>
          + Quote
        </button>
      </div>
    </div>
  )
}

function Kpi({ label, value, sub, danger }) {
  return (
    <div style={{
      background: 'var(--bg-card)', border: `1px solid ${danger ? '#c0392b66' : 'var(--border)'}`,
      borderRadius: 8, padding: '14px 16px', minWidth: 150, flex: '1 1 150px'
    }}>
      <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: danger ? '#c0392b' : 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4, color: danger ? '#c0392b' : undefined }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function Field({ label, span, compact, children }) {
  return (
    <label style={{ display: 'block', gridColumn: span === 2 ? '1 / -1' : undefined }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: compact ? 2 : 4, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      {children}
    </label>
  )
}

const th   = { padding: '10px 12px', textAlign: 'left', fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }
const td   = { padding: '10px 12px', verticalAlign: 'top' }
const thSm = { padding: '4px 8px', textAlign: 'left', fontSize: 11, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }
const tdSm = { padding: '6px 8px', borderBottom: '1px solid var(--border)' }
