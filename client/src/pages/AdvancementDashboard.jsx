import { useEffect, useMemo, useState } from 'react'
import api from '../api'
import Modal from '../components/Modal'

const TIER_COLOR = {
  critical: '#ef4444',
  high:     '#f59e0b',
  medium:   '#3b82f6',
  low:      '#94a3b8',
}
const TIER_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' }

const STATUS_STYLE = {
  advanced:              { bg: '#166534', fg: '#dcfce7', label: 'ADVANCED' },
  ready_pending_review:  { bg: '#075985', fg: '#e0f2fe', label: 'READY — PENDING REVIEW' },
  in_progress:           { bg: '#78350f', fg: '#fef3c7', label: 'IN PROGRESS' },
  blocked:               { bg: '#7f1d1d', fg: '#fee2e2', label: 'BLOCKED' },
  not_started:           { bg: '#334155', fg: '#e2e8f0', label: 'NOT STARTED' },
}

const CHECK_STATUS = {
  confirmed: { fg: '#22c55e', label: '✓ Confirmed' },
  open:      { fg: '#f59e0b', label: '◐ Open' },
  missing:   { fg: '#ef4444', label: '✕ Missing' },
  conflict:  { fg: '#f43f5e', label: '⚡ Conflict' },
  risk:      { fg: '#eab308', label: '⚠ Risk' },
}

export default function AdvancementDashboard() {
  const [dashboard, setDashboard] = useState([])
  const [loading, setLoading]     = useState(true)
  const [detail, setDetail]       = useState(null)     // full evaluate() result
  const [detailLoading, setDL]    = useState(false)
  const [rules, setRules]         = useState(null)     // per-show applies audit
  const [rulesOpen, setRulesOpen] = useState(false)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const { data } = await api.get('/advancement/dashboard')
      setDashboard(data.data || [])
    } catch (err) {
      console.error(err)
    } finally { setLoading(false) }
  }

  async function openDetail(showId) {
    setDL(true)
    setDetail({ showId, loading: true })
    try {
      const { data } = await api.get(`/advancement/${showId}`)
      setDetail(data.data)
    } catch (err) {
      alert(err.response?.data?.message || err.message)
      setDetail(null)
    } finally { setDL(false) }
  }

  async function openRules(showId) {
    try {
      const { data } = await api.get(`/advancement/${showId}/rules`)
      setRules(data.data)
      setRulesOpen(true)
    } catch (err) { alert(err.response?.data?.message || err.message) }
  }

  const grouped = useMemo(() => {
    const g = { blocked: [], in_progress: [], ready_pending_review: [], advanced: [], not_started: [] }
    for (const s of dashboard) (g[s.status] || (g[s.status] = [])).push(s)
    return g
  }, [dashboard])

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
        <h1 style={{ margin: 0 }}>🎯 Show Advancement</h1>
        <button onClick={load} disabled={loading} style={btnGhost}>{loading ? 'Loading…' : 'Refresh'}</button>
      </div>
      <p style={{ color: '#94a3b8', marginTop: 0 }}>
        For each upcoming show, what does the PM need to know and do to advance it?
        Requirements are dynamic — they only apply when the show actually needs them.
      </p>

      {loading ? <div style={{ color: '#94a3b8' }}>Loading…</div> : (
        <>
          <StatusRow grouped={grouped} />
          <ShowTable rows={dashboard} onOpen={openDetail} onRules={openRules} />
        </>
      )}

      <Modal isOpen={!!detail} onClose={() => setDetail(null)} title={detail?.showName ? `${detail.showName} — ${detail.showDate || ''}` : 'Advancement'} size="large">
        {detailLoading || detail?.loading ? <div style={{ color: '#94a3b8' }}>Loading…</div> :
          detail ? <DetailView data={detail} onRules={() => openRules(detail.showId)} /> : null}
      </Modal>

      <Modal isOpen={rulesOpen} onClose={() => setRulesOpen(false)} title="Why each requirement did or did not fire" size="large">
        {rules ? <RulesAudit rules={rules} /> : null}
      </Modal>
    </div>
  )
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function StatusRow({ grouped }) {
  const order = ['blocked', 'in_progress', 'ready_pending_review', 'advanced', 'not_started']
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, margin: '10px 0 20px' }}>
      {order.map(k => {
        const s = STATUS_STYLE[k]
        const count = (grouped[k] || []).length
        return (
          <div key={k} style={{ background: s.bg, color: s.fg, borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{count}</div>
            <div style={{ fontSize: 11, letterSpacing: 0.5 }}>{s.label}</div>
          </div>
        )
      })}
    </div>
  )
}

function ShowTable({ rows, onOpen, onRules }) {
  if (!rows.length) return <div style={{ color: '#94a3b8' }}>No upcoming shows.</div>
  return (
    <div style={cardBox}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: '#0f172a' }}>
            <th style={th}>Date</th>
            <th style={th}>Show</th>
            <th style={th}>Stage</th>
            <th style={th}>Status</th>
            <th style={th}>Critical</th>
            <th style={th}>High</th>
            <th style={th}>Top priorities</th>
            <th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.showId} style={{ borderBottom: '1px solid #1e293b' }}>
              <td style={td}>{r.date || '—'}</td>
              <td style={td}><strong>{r.showName || 'Untitled'}</strong></td>
              <td style={td}>{r.stage || '—'}</td>
              <td style={td}><StatusBadge status={r.status} /></td>
              <td style={{ ...td, color: r.critical ? TIER_COLOR.critical : '#64748b', fontWeight: 700 }}>{r.critical || 0}</td>
              <td style={{ ...td, color: r.high ? TIER_COLOR.high : '#64748b', fontWeight: 700 }}>{r.high || 0}</td>
              <td style={td}>
                {(r.topPriorities || []).length === 0 ? <span style={{ color: '#64748b' }}>—</span> :
                  <ul style={{ margin: 0, paddingLeft: 16, color: '#cbd5e1', fontSize: 12 }}>
                    {r.topPriorities.map(p => (
                      <li key={p.id}>
                        <span style={{ color: TIER_COLOR[p.tier], fontWeight: 700 }}>{TIER_LABEL[p.tier]}:</span> {p.title}
                      </li>
                    ))}
                  </ul>}
              </td>
              <td style={td}>
                <button style={btnLink} onClick={() => onOpen(r.showId)}>Detail</button>
                <button style={btnLink} onClick={() => onRules(r.showId)}>Why?</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function StatusBadge({ status }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.not_started
  return <span style={{ background: s.bg, color: s.fg, padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700 }}>{s.label}</span>
}

function DetailView({ data, onRules }) {
  const s = STATUS_STYLE[data.status] || STATUS_STYLE.not_started
  return (
    <div>
      {/* ── SHOW STATUS ── */}
      <Section title="📋 SHOW STATUS">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 }}>
          <StatusBadge status={data.status} />
          <button style={btnGhost} onClick={onRules}>See why each rule did/didn't apply →</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          {['critical','high','medium','low'].map(t => (
            <ReadinessBar key={t} tier={t} data={data.readiness[t]} />
          ))}
        </div>
      </Section>

      {/* ── TOP PRIORITIES ── */}
      <Section title="⚠️ TOP PRIORITIES">
        {['critical','high','medium','low'].map(t => (data.priorities[t]?.length ? (
          <PriorityBlock key={t} tier={t} rules={data.priorities[t]} />
        ) : null))}
        {['critical','high','medium','low'].every(t => !(data.priorities[t]?.length)) && (
          <div style={{ color: '#22c55e' }}>Nothing outstanding.</div>
        )}
      </Section>

      {/* ── OPEN ITEMS + CONFIRMED ── */}
      <Section title="✓ CONFIRMED">
        {data.confirmed.length ? <RuleList rules={data.confirmed} /> : <em style={{ color: '#94a3b8' }}>Nothing confirmed yet.</em>}
      </Section>

      {data.conflicts?.length ? <Section title="⚡ CONFLICTS"><RuleList rules={data.conflicts} /></Section> : null}
      {data.missing?.length   ? <Section title="✕ MISSING INFORMATION"><RuleList rules={data.missing} /></Section> : null}
      {data.risks?.length     ? <Section title="⚠ RISKS (unknown venue capability)"><RuleList rules={data.risks} /></Section> : null}

      {/* ── RECENT CHANGES ── */}
      {data.recentChanges?.length ? (
        <Section title="🔀 RECENT CHANGES (last 72h)">
          {data.recentChanges.map((c, i) => (
            <div key={i} style={rowBox}>
              <div><strong>{c.field}</strong>: <s style={{ color: '#94a3b8' }}>{stringify(c.from)}</s> → <span style={{ color: '#22c55e' }}>{stringify(c.to)}</span></div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>from {c.sender || 'unknown'} • {c.at || ''}</div>
              {c.why ? <div style={{ fontSize: 12, color: '#cbd5e1' }}>{c.why}</div> : null}
            </div>
          ))}
        </Section>
      ) : null}

      {/* ── UPCOMING DEADLINES ── */}
      {data.upcomingDeadlines?.length ? (
        <Section title="⏰ UPCOMING DEADLINES">
          {data.upcomingDeadlines.map((d, i) => (
            <div key={i} style={rowBox}>
              <div style={{ color: '#f59e0b' }}>“{d.excerpt}”</div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>from {d.from || 'unknown'} • {d.at || ''}</div>
            </div>
          ))}
        </Section>
      ) : null}

      {/* ── DEPENDENCIES ── */}
      {data.dependencies?.length ? (
        <Section title="🔗 DEPENDENCIES">
          {data.dependencies.map((d, i) => (
            <div key={i} style={rowBox}>
              <div>“{d.excerpt}”</div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>from {d.from || 'unknown'}</div>
            </div>
          ))}
        </Section>
      ) : null}

      {/* ── WAITING ON ── */}
      {data.waitingOn?.length ? (
        <Section title="⏳ WAITING ON">
          {data.waitingOn.map((w, i) => (
            <div key={i} style={rowBox}>
              <div><strong>{w.kind === 'email_fact' ? `Approve email fact: ${w.field}` : w.ruleId}</strong></div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>{w.why || ''}{w.from ? ` — from ${w.from}` : ''}</div>
            </div>
          ))}
        </Section>
      ) : null}

      {/* ── AI RECOMMENDED ACTIONS ── */}
      {data.recommendedActions?.length ? (
        <Section title="👉 RECOMMENDED ACTIONS (in priority order)">
          <ol style={{ paddingLeft: 20 }}>
            {data.recommendedActions.map((a, i) => (
              <li key={i} style={{ marginBottom: 8 }}>
                <span style={{ color: TIER_COLOR[a.tier], fontWeight: 700, marginRight: 6 }}>{TIER_LABEL[a.tier]}:</span>
                {a.action}
                <div style={{ fontSize: 12, color: '#94a3b8' }}>{a.why}</div>
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      <div style={{ fontSize: 11, color: '#64748b', marginTop: 20 }}>
        {data.appliedRuleCount} rules applied to this show • evaluated {data.evaluatedAt}
      </div>
    </div>
  )
}

function ReadinessBar({ tier, data }) {
  if (!data || !data.total) return (
    <div style={{ background: '#0f172a', padding: 8, borderRadius: 6, borderLeft: `3px solid ${TIER_COLOR[tier]}` }}>
      <div style={{ fontSize: 11, color: '#94a3b8', letterSpacing: 0.5 }}>{TIER_LABEL[tier].toUpperCase()}</div>
      <div style={{ fontSize: 14, color: '#64748b' }}>N/A</div>
    </div>
  )
  return (
    <div style={{ background: '#0f172a', padding: 8, borderRadius: 6, borderLeft: `3px solid ${TIER_COLOR[tier]}` }}>
      <div style={{ fontSize: 11, color: '#94a3b8', letterSpacing: 0.5 }}>{TIER_LABEL[tier].toUpperCase()}</div>
      <div style={{ fontSize: 14 }}>
        <span style={{ color: '#22c55e' }}>{data.confirmed}</span>
        <span style={{ color: '#94a3b8' }}> / {data.total} confirmed</span>
      </div>
      {data.blocked > 0 && (
        <div style={{ fontSize: 11, color: TIER_COLOR[tier] }}>{data.blocked} blocked</div>
      )}
    </div>
  )
}

function PriorityBlock({ tier, rules }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 12, color: TIER_COLOR[tier], fontWeight: 700, letterSpacing: 0.5, marginBottom: 4 }}>
        {TIER_LABEL[tier].toUpperCase()} ({rules.length})
      </div>
      <RuleList rules={rules} />
    </div>
  )
}

function RuleList({ rules }) {
  return (
    <div>
      {rules.map(r => {
        const cs = CHECK_STATUS[r.status] || CHECK_STATUS.open
        return (
          <div key={r.id} style={rowBox}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <div><strong>{r.title}</strong> <span style={{ color: '#64748b', fontSize: 11 }}>({r.id})</span></div>
              <div style={{ color: cs.fg, fontSize: 12, fontWeight: 700 }}>{cs.label}</div>
            </div>
            <div style={{ fontSize: 13, color: '#cbd5e1', marginTop: 3 }}>{r.reason}</div>
            {r.explanation ? <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
              <em>Why this applies:</em> {r.explanation}
            </div> : null}
            {r.action ? <div style={{ fontSize: 12, color: '#fbbf24', marginTop: 3 }}>→ {r.action}</div> : null}
          </div>
        )
      })}
    </div>
  )
}

function RulesAudit({ rules }) {
  const applied = rules.filter(r => r.applies)
  const skipped = rules.filter(r => !r.applies)
  return (
    <div>
      <div style={{ color: '#94a3b8', fontSize: 13, marginBottom: 10 }}>
        Every rule is evaluated for every show. This shows which fired for THIS show and which were skipped, so nothing is applied silently.
      </div>
      <Section title={`✓ APPLIED (${applied.length})`}>
        {applied.map(r => (
          <div key={r.id} style={rowBox}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>{r.title}</strong>
              <span style={{ color: TIER_COLOR[r.tier], fontSize: 11, fontWeight: 700 }}>{TIER_LABEL[r.tier]} · {r.category}</span>
            </div>
            <div style={{ fontSize: 12, color: '#cbd5e1' }}>Because: {r.because}</div>
            <div style={{ fontSize: 11, color: '#64748b' }}>{r.id}</div>
          </div>
        ))}
      </Section>
      <Section title={`⊘ SKIPPED (${skipped.length})`}>
        {skipped.map(r => (
          <div key={r.id} style={{ ...rowBox, opacity: 0.6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>{r.title}</strong>
              <span style={{ color: TIER_COLOR[r.tier], fontSize: 11 }}>{TIER_LABEL[r.tier]} · {r.category}</span>
            </div>
            <div style={{ fontSize: 12, color: '#94a3b8' }}>Does not apply to this show.</div>
            <div style={{ fontSize: 11, color: '#64748b' }}>{r.id}</div>
          </div>
        ))}
      </Section>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 12, color: '#e2e8f0', fontWeight: 700, letterSpacing: 0.6, marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  )
}

function stringify(v) {
  if (v == null) return '—'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

// ─── Style tokens (align with EmailIntel / VenueKnowledge dark-theme) ────────
const cardBox = { background: '#1e293b', border: '1px solid #334155', borderRadius: 8, overflow: 'hidden', marginTop: 10 }
const th      = { textAlign: 'left', padding: '10px 12px', fontSize: 11, letterSpacing: 0.5, color: '#94a3b8', borderBottom: '1px solid #334155' }
const td      = { padding: '10px 12px', fontSize: 13, verticalAlign: 'top', color: '#e2e8f0' }
const btnGhost = { background: 'transparent', border: '1px solid #475569', color: '#e2e8f0', padding: '6px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }
const btnLink  = { background: 'transparent', border: 'none', color: '#60a5fa', cursor: 'pointer', padding: '2px 6px', fontSize: 12 }
const rowBox   = { background: '#0f172a', border: '1px solid #1e293b', borderRadius: 6, padding: '8px 10px', marginBottom: 6 }
