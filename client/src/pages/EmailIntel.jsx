import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import api from '../api'
import Modal from '../components/Modal'
import { useAuth } from '../context/AuthContext'
import { ROLE } from '../utils/roles'

const CAN_DECIDE = [ROLE.ADMIN, ROLE.PRODUCTION_MANAGER]

const SAMPLE_THREAD = `Devon Kim <dkim@example-tourco.test>
Subject: The Northern Lights — advance
Date: 2026-09-01T09:00:00Z

Hi team — we'll roll in with 3 trucks and 2 buses for load-in Wednesday at 8 AM.
Please book 6 stagehands.
— Devon Kim, Tour Manager

---

Devon Kim <dkim@example-tourco.test>
Subject: The Northern Lights — advance
Date: 2026-09-02T14:00:00Z

Actually, make that 4 trucks. Also we need 24 wireless channels — is that OK?
Please confirm by Friday EOD.`

export default function EmailIntel() {
  const { user } = useAuth()
  const canDecide = CAN_DECIDE.includes(user?.role)
  const [searchParams] = useSearchParams()

  const [queue, setQueue]     = useState([])         // fact rows
  const [previews, setPreviews] = useState({})       // factId -> preview from /queue?withPreview=1
  const [threads, setThreads] = useState([])
  const [issues, setIssues]   = useState([])
  const [changes, setChanges] = useState([])         // AI change audit log
  const [loading, setLoading] = useState(true)
  const [tab, setTab]         = useState('queue')
  const [filterShowId, setFilterShowId] = useState(searchParams.get('showId') || '')
  const [selected, setSelected] = useState(null) // fact being reviewed
  const [selectedPreview, setSelectedPreview] = useState(null)
  const [modal, setModal]     = useState(false) // 'analyze' | 'detail' | false
  const [analyzeText, setAnalyzeText] = useState(SAMPLE_THREAD)
  const [analyzeResult, setAnalyzeResult] = useState(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [deciding, setDeciding]   = useState(false)
  const [checked, setChecked]     = useState(new Set()) // for batch approve
  const [batching, setBatching]   = useState(false)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const [q, t, i, c] = await Promise.all([
        api.get('/email-intel/queue?withPreview=1'),
        api.get('/email-intel/threads'),
        api.get('/email-intel/issues'),
        api.get('/ai-changes').catch(() => ({ data: { data: [] } })),
      ])
      const rows = q.data.data || []
      // withPreview=1 returns [{fact, preview}, ...]. Older shape returns [fact].
      if (rows.length && rows[0]?.fact) {
        setQueue(rows.map(r => r.fact))
        const pmap = {}
        for (const r of rows) if (r.fact) pmap[r.fact.id] = r.preview
        setPreviews(pmap)
      } else {
        setQueue(rows)
        setPreviews({})
      }
      setThreads(t.data.data || [])
      setIssues(i.data.data  || [])
      setChanges(c.data.data || [])
      setChecked(new Set())
    } finally { setLoading(false) }
  }

  const filteredQueue = useMemo(() => {
    return queue.filter(f => !filterShowId || f.showId === filterShowId)
  }, [queue, filterShowId])

  const byThread = useMemo(() => {
    const g = {}
    for (const f of filteredQueue) {
      if (!g[f.threadId]) g[f.threadId] = []
      g[f.threadId].push(f)
    }
    return g
  }, [filteredQueue])

  // Batch selection: only low-risk + no-conflict + mapped facts can be picked.
  const batchable = useMemo(() => {
    const set = new Set()
    for (const f of filteredQueue) {
      const p = previews[f.id]
      if (!p || !p.supported) continue
      if (p.risk !== 'low') continue
      if ((p.conflicts || []).length > 0) continue
      if (p.status === 'conflict' || p.status === 'uncertain') continue
      set.add(f.id)
    }
    return set
  }, [filteredQueue, previews])

  function toggleCheck(id) {
    setChecked(prev => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }
  function toggleAllBatch() {
    setChecked(prev => {
      const all = [...batchable]
      const allSelected = all.every(id => prev.has(id))
      return new Set(allSelected ? [] : all)
    })
  }
  async function runBatchApprove() {
    if (checked.size === 0) return
    setBatching(true)
    try {
      const { data } = await api.post('/email-intel/facts/batch-approve', { ids: [...checked] })
      const failed = (data.data || []).filter(r => !r.ok)
      if (failed.length) {
        alert(`Approved ${(data.data.length - failed.length)}/${data.data.length}. ${failed.length} skipped:\n` +
          failed.map(f => `• ${f.id}: ${f.reason || f.message}`).join('\n'))
      }
      await load()
    } catch (err) {
      alert(err.response?.data?.message || err.message)
    } finally { setBatching(false) }
  }

  async function openDetail(fact) {
    setSelected(fact); setSelectedPreview(null); setModal('detail')
    try {
      const { data } = await api.get(`/email-intel/facts/${fact.id}/preview`)
      setSelectedPreview(data.data)
    } catch { /* preview is best-effort */ }
  }

  async function decide(id, action, opts = {}) {
    setDeciding(true)
    try {
      const payload = { note: opts.note || '' }
      if (opts.correctedValue !== undefined && opts.correctedValue !== '') {
        payload.correctedValue = opts.correctedValue
        payload.correctionType = opts.correctionType || 'SHOW_SPECIFIC'
        payload.reason = opts.reason || ''
      }
      await api.post(`/email-intel/facts/${id}/${action}`, payload)
      setSelected(null)
      await load()
    } catch (err) {
      alert(err.response?.data?.message || err.message)
    } finally { setDeciding(false) }
  }

  async function runAnalyze() {
    setAnalyzing(true); setAnalyzeResult(null)
    try {
      const messages = parseAnalyzePasteToMessages(analyzeText)
      if (messages.length === 0) throw new Error('Could not parse any messages from the paste.')
      const res = await api.post('/email-intel/analyze', { messages })
      setAnalyzeResult(res.data.data)
    } catch (err) {
      setAnalyzeResult({ error: err.response?.data?.message || err.message })
    } finally { setAnalyzing(false) }
  }

  async function stageAnalyzedThread() {
    if (!analyzeResult || analyzeResult.error) return
    try {
      await api.post('/email-intel/propose', { analysis: analyzeResult })
      setModal(false); setAnalyzeResult(null)
      await load()
    } catch (err) {
      alert(err.response?.data?.message || err.message)
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Email Intelligence ✉️🧠</div>
          <div className="page-subtitle">
            Threads read as conversations. Every change is a proposal — nothing overwrites show data without your approval.
          </div>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-ghost" onClick={() => { setAnalyzeText(SAMPLE_THREAD); setAnalyzeResult(null); setModal('analyze') }}>
            🔍 Analyze a Thread
          </button>
        </div>
      </div>

      <div className="flex gap-2 mb-4">
        <button className={`btn ${tab==='queue' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('queue')}>
          Review Queue ({queue.length})
        </button>
        <button className={`btn ${tab==='threads' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('threads')}>
          Threads ({threads.length})
        </button>
        <button className={`btn ${tab==='issues' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('issues')}>
          Issues ({issues.length})
        </button>
        <button className={`btn ${tab==='audit' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('audit')}>
          Audit Log ({changes.length})
        </button>
      </div>

      {loading ? (
        <div className="card"><div className="loading">Loading…</div></div>
      ) : tab === 'queue' ? (
        <QueueView
          byThread={byThread} filterShowId={filterShowId} setFilterShowId={setFilterShowId}
          threads={threads}
          previews={previews}
          checked={checked}
          batchable={batchable}
          canDecide={canDecide}
          onToggleCheck={toggleCheck}
          onToggleAll={toggleAllBatch}
          onBatchApprove={runBatchApprove}
          batching={batching}
          onOpen={openDetail}
        />
      ) : tab === 'threads' ? (
        <ThreadsView threads={threads} />
      ) : tab === 'issues' ? (
        <IssuesView issues={issues} />
      ) : (
        <AuditView changes={changes} />
      )}

      {/* ── Analyze modal ─────────────────────────────────────────────── */}
      {modal === 'analyze' && (
        <Modal onClose={() => setModal(false)} title="Analyze an email thread" size="lg">
          <div className="text-muted" style={{ fontSize: 13, marginBottom: 8 }}>
            Paste one or more emails, separated by <code>---</code>. Each block needs a <code>From:</code>, <code>Subject:</code>, and <code>Date:</code> line, then a blank line, then the body.
          </div>
          <textarea
            className="input"
            rows={12}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
            value={analyzeText}
            onChange={e => setAnalyzeText(e.target.value)}
          />
          <div className="flex gap-2" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
            <button className="btn btn-ghost"   onClick={() => setModal(false)}>Close</button>
            <button className="btn btn-primary" disabled={analyzing} onClick={runAnalyze}>
              {analyzing ? 'Analyzing…' : 'Analyze'}
            </button>
          </div>
          {analyzeResult && (
            <div style={{ marginTop: 12 }}>
              {analyzeResult.error ? (
                <div className="card" style={{ background: 'rgba(220,50,50,0.08)' }}>
                  <strong>Error:</strong> {analyzeResult.error}
                </div>
              ) : (
                <AnalysisSummary
                  analysis={analyzeResult}
                  canStage={canDecide}
                  onStage={stageAnalyzedThread}
                />
              )}
            </div>
          )}
        </Modal>
      )}

      {/* ── Detail modal (approve/reject) ─────────────────────────────── */}
      {modal === 'detail' && selected && (
        <Modal onClose={() => { setModal(false); setSelected(null); setSelectedPreview(null) }} title="Review proposed change" size="lg">
          {selectedPreview ? <ReviewCard preview={selectedPreview} /> : <div className="text-muted" style={{ fontSize: 12 }}>Loading preview…</div>}
          <FactDetail fact={selected} />
          {canDecide && selected.status === 'proposed' && (
            <CorrectionAndDecideBar
              fact={selected}
              deciding={deciding}
              onReject={(note) => decide(selected.id, 'reject', { note })}
              onApprove={(opts) => decide(selected.id, 'approve', opts)}
            />
          )}
        </Modal>
      )}
    </div>
  )
}

// ── Queue grouped by thread ────────────────────────────────────────────────
function QueueView({ byThread, threads, filterShowId, setFilterShowId, previews, checked, batchable, canDecide, onToggleCheck, onToggleAll, onBatchApprove, batching, onOpen }) {
  const threadIds = Object.keys(byThread)
  if (threadIds.length === 0) return (
    <div className="card">
      <div className="empty-state">
        <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>No proposals waiting for review</div>
        <div className="text-muted" style={{ fontSize: 13 }}>
          Analyze an email thread to stage proposed changes.
        </div>
      </div>
    </div>
  )
  return (
    <>
      <div className="flex gap-2 mb-2" style={{ alignItems: 'center' }}>
        <select className="input" value={filterShowId} onChange={e => setFilterShowId(e.target.value)}>
          <option value="">All shows</option>
          {threads.filter(t => t.showId).map(t => (
            <option key={t.id} value={t.showId}>{t.showId} — {t.subject}</option>
          ))}
        </select>
        {canDecide && (
          <>
            <button
              className="btn btn-ghost btn-sm"
              onClick={onToggleAll}
              disabled={batchable.size === 0}
              title={batchable.size === 0 ? 'No low-risk items available' : 'Select all low-risk items'}
            >
              Select all low-risk ({batchable.size})
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={onBatchApprove}
              disabled={batching || checked.size === 0}
              title="Batch approve is only available for low-risk changes. High-risk items must be approved individually."
            >
              {batching ? 'Approving…' : `Approve Selected (${checked.size})`}
            </button>
            {checked.size > 0 && (
              <span className="text-muted" style={{ fontSize: 12 }}>
                🔒 High-risk items are excluded from batch approval by design.
              </span>
            )}
          </>
        )}
      </div>
      {threadIds.map(tid => (
        <div key={tid} className="card" style={{ marginBottom: 12 }}>
          <ThreadHeader thread={threads.find(t => t.id === tid)} tid={tid} count={byThread[tid].length} />
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {canDecide && <th style={{ width: 30 }}></th>}
                  <th>Field</th>
                  <th>Current → Proposed</th>
                  <th>Source</th>
                  <th>Confidence</th>
                  <th>Risk</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {byThread[tid].map(f => (
                  <QueueRow
                    key={f.id}
                    fact={f}
                    preview={previews?.[f.id]}
                    canDecide={canDecide}
                    checked={checked?.has(f.id)}
                    canCheck={batchable?.has(f.id)}
                    onToggleCheck={onToggleCheck}
                    onOpen={onOpen}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  )
}

function ThreadHeader({ thread, tid, count }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
      <div>
        <div style={{ fontWeight: 600 }}>{thread?.subject || '(no subject)'}</div>
        <div className="text-muted" style={{ fontSize: 12 }}>
          Thread <code>{tid}</code>
          {thread?.showId ? <> · assigned to show <code>{thread.showId}</code></> : <> · <span style={{ color: '#e6aa1e' }}>unassigned</span></>}
          {thread?.messageCount && <> · {thread.messageCount} messages</>}
        </div>
      </div>
      <div className="text-muted" style={{ fontSize: 12 }}>{count} proposed change{count===1?'':'s'}</div>
    </div>
  )
}

function QueueRow({ fact, preview, canDecide, checked, canCheck, onToggleCheck, onOpen }) {
  const conflicts = safeJson(fact.conflicts, [])
  const conf = preview?.confidence?.level || fact.kind || 'medium'
  const confBadge = conf === 'high' ? 'confirmed' : conf === 'low' ? 'cancelled' : 'pending'
  const riskColor = preview?.risk === 'high' ? '#e04a4a' : preview?.risk === 'low' ? '#22c55e' : '#94a3b8'
  const statusLabel = preview?.status === 'conflict'  ? '⚡ Conflict'
                    : preview?.status === 'uncertain' ? '❓ Uncertain'
                    : preview?.status === 'no_change' ? '= No change'
                    : preview?.status === 'unmapped'  ? '❔ Unmapped'
                    : conflicts.length ? '⚡ Conflict' : '● Ready'
  return (
    <tr>
      {canDecide && (
        <td>
          <input
            type="checkbox"
            checked={!!checked}
            disabled={!canCheck}
            onChange={() => onToggleCheck(fact.id)}
            title={canCheck ? 'Include in batch approve' : 'Not eligible for batch approve (high-risk, conflict, or unmapped)'}
          />
        </td>
      )}
      <td>
        <div style={{ fontFamily: 'monospace', fontSize: 12 }}>{preview?.displayLabel || fact.field}</div>
        <div className="text-muted" style={{ fontSize: 11 }}>{preview?.category || fact.category}</div>
      </td>
      <td>
        <div style={{ fontSize: 13 }}>
          {preview ? (
            <>
              <span className="text-muted">{preview.currentValue ? String(preview.currentValue) : '—'}</span>
              {' → '}
              <strong>{preview.proposedValue || safeJson(fact.newValue)}</strong>
            </>
          ) : (
            <>
              {fact.previousValue && fact.previousValue !== 'null' && fact.previousValue !== '""'
                ? <><del className="text-muted">{safeJson(fact.previousValue)}</del> → </>
                : null}
              <strong>{safeJson(fact.newValue)}</strong>
            </>
          )}
        </div>
      </td>
      <td className="text-muted" style={{ fontSize: 12 }}>
        {fact.senderName || fact.senderEmail || fact.sourceFrom}
        {fact.senderRole && <div style={{ fontSize: 11 }}>{fact.senderRole.replace(/_/g,' ')}</div>}
      </td>
      <td>
        <span className={`badge badge-${confBadge}`}>{conf}</span>
      </td>
      <td>
        <span style={{ color: riskColor, fontWeight: 600, fontSize: 12 }}>
          {preview?.risk ? preview.risk.toUpperCase() : '—'}
        </span>
      </td>
      <td style={{ fontSize: 12 }}>{statusLabel}</td>
      <td>
        <button className="btn btn-ghost btn-sm" onClick={() => onOpen(fact)}>Review</button>
      </td>
    </tr>
  )
}

function fmtAction(a) {
  if (!a) return '—'
  if (a === 'escalate_to_admin')                return '🚨 Escalate to admin'
  if (a === 'review_conflict_with_current_show')return '⚠ Reconcile with show'
  if (a === 'book_vendor_to_cover_shortfall')   return '📞 Book vendor'
  if (a === 'update_show_record')               return '✏ Update show'
  if (a === 'mark_confirmed')                   return '✅ Mark confirmed'
  if (a === 'add_to_show_record')               return '➕ Add to show'
  return a.replace(/_/g, ' ')
}

// ── Detail (EMAIL → AI → CHANGE → SOURCE → CONFIDENCE → CONFLICTS → ACTION) ─
function FactDetail({ fact }) {
  const conflicts = safeJson(fact.conflicts, [])
  const prev = fact.previousValue && fact.previousValue !== 'null' && fact.previousValue !== '""' ? safeJson(fact.previousValue) : null
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <Section label="📧 EMAIL">
        <div className="text-muted" style={{ fontSize: 12 }}>{fact.sourceFrom || fact.senderEmail}</div>
        <blockquote style={{ margin: '4px 0 0 0', padding: '8px 12px', borderLeft: '3px solid var(--accent,#4a90e2)', background: 'rgba(255,255,255,0.03)', fontSize: 13 }}>
          {fact.sourceExcerpt}
        </blockquote>
      </Section>

      <Section label="🧠 WHAT AI UNDERSTOOD">
        <div style={{ fontSize: 13 }}>{fact.reasoningSummary}</div>
      </Section>

      <Section label="🔀 WHAT WILL CHANGE">
        <div style={{ fontFamily: 'monospace', fontSize: 13 }}>
          <strong>{fact.field}</strong>
          {fact.advancePath && <span className="text-muted"> ({fact.advancePath})</span>}
        </div>
        <div style={{ marginTop: 4 }}>
          {prev != null ? <><del className="text-muted">{String(prev)}</del> → </> : null}
          <strong>{String(safeJson(fact.newValue))}</strong>
        </div>
      </Section>

      <Section label="📎 SOURCE">
        <div className="text-muted" style={{ fontSize: 12 }}>
          Thread <code>{fact.threadId}</code> · Message <code>{fact.messageId}</code>
          {fact.sourceDate && <> · {fact.sourceDate}</>}
          <br />
          Extractor: <code>{fact.extractor}</code>
        </div>
      </Section>

      <Section label="📊 CONFIDENCE">
        <div>
          <span className={`badge badge-${Number(fact.confidence) >= 0.85 ? 'confirmed' : Number(fact.confidence) >= 0.7 ? 'pending' : 'cancelled'}`}>
            {Math.round(Number(fact.confidence) * 100)}%
          </span>
          <span className="text-muted" style={{ marginLeft: 8, fontSize: 12 }}>kind: {fact.kind}</span>
        </div>
      </Section>

      <Section label="⚠ CONFLICTS">
        {conflicts.length === 0 ? (
          <div className="text-muted" style={{ fontSize: 12 }}>None detected.</div>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            {conflicts.map((c, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                {c.critical && <span style={{ color: '#e04a4a' }}>🚨 </span>}
                <strong>{c.kind.replace(/_/g,' ')}</strong>
                {c.path && <> · <code style={{ fontSize: 11 }}>{c.path}</code></>}
                {c.current != null && <> · current: <code>{String(c.current)}</code></>}
                {c.proposed != null && <> · proposed: <code>{String(c.proposed)}</code></>}
                {c.matches && <> · match: {c.matches}</>}
                {c.needsVendor && <> · needs vendor</>}
                {c.note && <div className="text-muted" style={{ fontSize: 11 }}>{c.note}</div>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section label="👉 RECOMMENDED ACTION">
        <div style={{ fontWeight: 600 }}>{fmtAction(fact.recommendedAction)}</div>
      </Section>
    </div>
  )
}

function Section({ label, children }) {
  return (
    <div>
      <div className="text-muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>{label}</div>
      {children}
    </div>
  )
}

// ── Threads / Issues secondary views ──────────────────────────────────────
function ThreadsView({ threads }) {
  if (threads.length === 0) return <div className="card"><div className="empty-state">No threads yet</div></div>
  return (
    <div className="card">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Subject</th><th>Show</th><th>Msgs</th><th>Last</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {threads.map(t => (
              <tr key={t.id}>
                <td>{t.subject || '(no subject)'}</td>
                <td className="text-muted">{t.showId || <span style={{ color: '#e6aa1e' }}>unassigned</span>}</td>
                <td>{t.messageCount}</td>
                <td className="text-muted" style={{ fontSize: 12 }}>{t.lastMessageAt}</td>
                <td><span className="badge">{t.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function IssuesView({ issues }) {
  if (issues.length === 0) return <div className="card"><div className="empty-state">No open issues</div></div>
  return (
    <div className="card">
      <div className="table-wrap">
        <table>
          <thead><tr><th>Kind</th><th>Excerpt</th><th>Thread</th><th>Date</th></tr></thead>
          <tbody>
            {issues.map(i => (
              <tr key={i.id}>
                <td><span className="badge">{i.kind}</span></td>
                <td style={{ fontSize: 13 }}>{i.excerpt}</td>
                <td className="text-muted" style={{ fontSize: 12 }}><code>{i.threadId}</code></td>
                <td className="text-muted" style={{ fontSize: 12 }}>{i.date}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Analysis summary panel inside the Analyze modal ──────────────────────
function AnalysisSummary({ analysis, canStage, onStage }) {
  return (
    <div className="card" style={{ background: 'rgba(255,255,255,0.03)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <div>
          <strong>{analysis.subject || '(no subject)'}</strong>
          <div className="text-muted" style={{ fontSize: 12 }}>
            {analysis.messageCount} messages · {analysis.participants.length} participants
          </div>
        </div>
        <div className="text-muted" style={{ fontSize: 12 }}>
          Show:{' '}
          {analysis.showAssignment.showId
            ? <><code>{analysis.showAssignment.showId}</code> ({Math.round(analysis.showAssignment.confidence*100)}%)</>
            : <span style={{ color: '#e6aa1e' }}>unassigned — {analysis.showAssignment.reason}</span>}
        </div>
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Proposed facts ({analysis.facts.length})</div>
      {analysis.facts.length === 0 ? (
        <div className="text-muted" style={{ fontSize: 12 }}>No extractable facts.</div>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
          {analysis.facts.map(f => (
            <li key={f.id} style={{ marginBottom: 4 }}>
              <code style={{ fontSize: 11 }}>{f.field}</code>: {f.previousValue != null ? <><del className="text-muted">{String(f.previousValue)}</del> → </> : null}
              <strong>{String(f.newValue)}</strong>{' '}
              <span className="text-muted" style={{ fontSize: 11 }}>· {f.kind} · {Math.round(f.confidence*100)}%</span>
              {f.conflicts?.length > 0 && <span style={{ color: '#e04a4a', fontSize: 11 }}> · {f.conflicts.length} conflict(s)</span>}
              <div className="text-muted" style={{ fontSize: 11 }}>{f.reasoningSummary}</div>
            </li>
          ))}
        </ul>
      )}
      {analysis.issues.length > 0 && (
        <>
          <div style={{ fontSize: 13, fontWeight: 600, marginTop: 8 }}>Issues ({analysis.issues.length})</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
            {analysis.issues.slice(0, 8).map((i, k) => (
              <li key={k}><span className="badge">{i.kind}</span> {i.excerpt}</li>
            ))}
          </ul>
        </>
      )}
      {canStage && analysis.facts.length > 0 && (
        <div className="flex gap-2" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="btn btn-primary" onClick={onStage}>Stage as proposals</button>
        </div>
      )}
    </div>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────────
function safeJson(text, fallback) {
  if (text === null || text === undefined || text === '') return fallback ?? '—'
  if (typeof text !== 'string') return text
  try { return JSON.parse(text) } catch { return text }
}

// Very forgiving parser: accepts blocks separated by `---`. Each block should
// have header lines (From:, Subject:, Date:) then a blank line then body.
function parseAnalyzePasteToMessages(text) {
  const blocks = text.split(/\n-{3,}\n/).map(b => b.trim()).filter(Boolean)
  const out = []
  let idx = 0
  for (const block of blocks) {
    idx += 1
    const lines = block.split(/\n/)
    let from = '', subject = '', date = '', bodyStart = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line === '') { bodyStart = i + 1; break }
      const m1 = /^from:\s*(.+)/i.exec(line);         if (m1) { from = m1[1].trim(); continue }
      const m2 = /^subject:\s*(.+)/i.exec(line);      if (m2) { subject = m2[1].trim(); continue }
      const m3 = /^date:\s*(.+)/i.exec(line);         if (m3) { date = m3[1].trim(); continue }
      // First non-header line — treat the first line as `from` if not yet set.
      if (!from && /@/.test(line)) { from = line.trim(); continue }
      // Anything else means body begins here.
      bodyStart = i; break
    }
    const body = lines.slice(bodyStart).join('\n').trim()
    out.push({
      id: `paste_${idx}`,
      threadId: 'paste_thread',
      from, subject, date: date || new Date().toISOString(),
      body,
    })
  }
  return out
}

// ── Review card: the spec-mandated FIELD/CURRENT/PROPOSED/SOURCE/CONFIDENCE/REASON/STATUS view.
function ReviewCard({ preview }) {
  if (!preview) return null
  const statusColor = preview.status === 'conflict' ? '#e04a4a'
                    : preview.status === 'uncertain' ? '#eab308'
                    : preview.status === 'no_change' ? '#94a3b8'
                    : preview.status === 'unmapped' ? '#eab308'
                    : '#22c55e'
  const riskColor   = preview.risk === 'high' ? '#e04a4a' : '#22c55e'
  const confColor   = preview.confidence?.level === 'high' ? '#22c55e' : preview.confidence?.level === 'low' ? '#e04a4a' : '#eab308'
  return (
    <div className="card" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', marginBottom: 12 }}>
      {preview.message && (
        <div style={{ background: statusColor, color: '#0b1220', padding: '6px 10px', borderRadius: 4, marginBottom: 10, fontSize: 13, fontWeight: 600 }}>
          {preview.message}
        </div>
      )}
      <table style={{ width: '100%', fontSize: 13 }}>
        <tbody>
          <ReviewRow label="Field">{preview.displayLabel} <span className="text-muted" style={{ fontFamily: 'monospace', fontSize: 11 }}>({preview.field})</span></ReviewRow>
          <ReviewRow label="Current value">{preview.currentValue ? String(preview.currentValue) : <span className="text-muted">(empty)</span>}</ReviewRow>
          <ReviewRow label="Proposed value"><strong>{preview.proposedValue || <span className="text-muted">(none)</span>}</strong></ReviewRow>
          <ReviewRow label="Source">
            {preview.source?.from || 'unknown'}
            {preview.source?.date && <span className="text-muted"> · {preview.source.date}</span>}
            {preview.source?.excerpt && (
              <blockquote style={{ margin: '4px 0 0', padding: '4px 8px', borderLeft: '3px solid rgba(255,255,255,0.15)', fontSize: 12, color: '#cbd5e1' }}>
                {preview.source.excerpt}
              </blockquote>
            )}
          </ReviewRow>
          <ReviewRow label="Confidence">
            <span style={{ color: confColor, fontWeight: 600 }}>{preview.confidence?.level?.toUpperCase() || '—'}</span>
            {preview.confidence?.because && <span className="text-muted"> — {preview.confidence.because}</span>}
          </ReviewRow>
          <ReviewRow label="Reason">{preview.reason || <span className="text-muted">—</span>}</ReviewRow>
          <ReviewRow label="Risk"><span style={{ color: riskColor, fontWeight: 600 }}>{preview.risk?.toUpperCase()}</span></ReviewRow>
          <ReviewRow label="Status"><span style={{ color: statusColor, fontWeight: 600 }}>{preview.status?.toUpperCase()}</span></ReviewRow>
          {preview.target && (
            <ReviewRow label="Will write to">
              <code style={{ fontSize: 12 }}>{preview.target}.{preview.targetKey}</code>
            </ReviewRow>
          )}
        </tbody>
      </table>
    </div>
  )
}
function ReviewRow({ label, children }) {
  return (
    <tr>
      <td style={{ width: 130, verticalAlign: 'top', color: '#94a3b8', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', padding: '4px 8px 4px 0' }}>{label}</td>
      <td style={{ padding: '4px 0' }}>{children}</td>
    </tr>
  )
}

// PM can override the AI value before approving. The override is recorded as
// a correction; repeated corrections become candidate rules in the Knowledge
// Review page. Nothing here becomes authoritative on its own.
function CorrectionAndDecideBar({ fact, deciding, onReject, onApprove }) {
  const [correcting, setCorrecting] = useState(false)
  const [correctedValue, setCorrectedValue] = useState(String(fact.newValue ?? ''))
  const [correctionType, setCorrectionType] = useState('SHOW_SPECIFIC')
  const [reason, setReason] = useState('')
  const changed = String(correctedValue) !== String(fact.newValue ?? '')
  return (
    <div style={{ marginTop: 16, borderTop: '1px solid #eee', paddingTop: 12 }}>
      {correcting && (
        <div style={{ background: '#fafafa', border: '1px solid #eee', padding: 10, borderRadius: 6, marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>
            The AI proposed <code>{String(fact.newValue)}</code>. Enter your corrected value and how you'd classify this correction.
            Repeated corrections become candidate rules on the <strong>Knowledge Review</strong> page.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <label style={{ fontSize: 11, color: '#666' }}>Corrected value
              <input className="input" value={correctedValue} onChange={e => setCorrectedValue(e.target.value)} />
            </label>
            <label style={{ fontSize: 11, color: '#666' }}>Classification
              <select className="input" value={correctionType} onChange={e => setCorrectionType(e.target.value)}>
                {['SHOW_SPECIFIC','VENUE_SPECIFIC','PROMOTER_SPECIFIC','TOUR_SPECIFIC','ARTIST_SPECIFIC','VENDOR_SPECIFIC','INDUSTRY_WIDE','ONE_TIME'].map(v =>
                  <option key={v} value={v}>{v}</option>
                )}
              </select>
            </label>
          </div>
          <label style={{ fontSize: 11, color: '#666', display: 'block', marginTop: 8 }}>Reason (recorded in correction log)
            <input className="input" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. we always run 6 hands for headliners" />
          </label>
        </div>
      )}
      <div className="flex gap-2" style={{ justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={() => window.open(`/email?thread=${encodeURIComponent(fact.threadId || '')}`, '_blank')}>View Source</button>
        {!correcting
          ? <button className="btn btn-ghost" onClick={() => setCorrecting(true)}>Correct value…</button>
          : <button className="btn btn-ghost" onClick={() => setCorrecting(false)}>Cancel correction</button>}
        <button className="btn btn-danger" disabled={deciding} onClick={() => onReject('')}>Reject</button>
        <button className="btn btn-primary" disabled={deciding} onClick={() =>
          onApprove(correcting && changed ? { correctedValue, correctionType, reason } : {})
        }>
          {correcting && changed ? 'Approve with correction' : 'Approve'}
        </button>
      </div>
    </div>
  )
}


// ── Audit log tab ────────────────────────────────────────────────────────
function AuditView({ changes }) {
  if (!changes || changes.length === 0) return (
    <div className="card">
      <div className="empty-state">
        <div style={{ fontSize: 32, marginBottom: 8 }}>📜</div>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>No AI-driven changes yet</div>
        <div className="text-muted" style={{ fontSize: 13 }}>
          Every approved AI change lands here — previous value, new value, approver, source, extractor, and reason.
        </div>
      </div>
    </div>
  )
  return (
    <div className="card">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Show</th>
              <th>Field</th>
              <th>Prev → New</th>
              <th>Approver</th>
              <th>Source</th>
              <th>Reason</th>
              <th>Risk / Status</th>
            </tr>
          </thead>
          <tbody>
            {changes.map(c => (
              <tr key={c.id}>
                <td style={{ fontSize: 12 }}>{c.at}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{c.showId || '—'}</td>
                <td>
                  <div style={{ fontFamily: 'monospace', fontSize: 12 }}>{c.field}</div>
                  <div className="text-muted" style={{ fontSize: 11 }}>{c.changeCategory} · {c.target}.{c.targetField}</div>
                </td>
                <td style={{ fontSize: 13 }}>
                  <span className="text-muted">{c.previousValue || '(empty)'}</span>
                  {' → '}
                  <strong>{c.newValue}</strong>
                </td>
                <td style={{ fontSize: 12 }}>{c.approvedBy}</td>
                <td style={{ fontSize: 12 }}>
                  {c.sourceFrom}
                  {c.sourceDate && <div className="text-muted" style={{ fontSize: 11 }}>{c.sourceDate}</div>}
                </td>
                <td style={{ fontSize: 12, maxWidth: 240 }}>{c.reason}</td>
                <td style={{ fontSize: 12 }}>
                  <div style={{ color: c.risk === 'high' ? '#e04a4a' : '#22c55e', fontWeight: 600 }}>{(c.risk || '').toUpperCase()}</div>
                  <div className="text-muted">{c.status}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

