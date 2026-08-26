import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import api from '../api'

/**
 * Show Brief — the PM's AI workspace for one show.
 *
 * Every assertion is grounded by a `sources` array. Clicking a source opens
 * either the source email thread, the fact detail in Email Intel, or the
 * artist document. No internal chain-of-thought is exposed — only concise
 * summary text with drill-down evidence.
 */

const SECTIONS = [
  { key: 'aiShowBrief',        title: 'AI Show Brief' },
  { key: 'whatChanged',        title: 'What Changed' },
  { key: 'needsAttention',     title: 'Needs Attention' },
  { key: 'conflicts',          title: 'Conflicts' },
  { key: 'keyContacts',        title: 'Key Contacts' },
  { key: 'loadInPlan',         title: 'Load-In Plan' },
  { key: 'missingInformation', title: 'Missing Information' },
  { key: 'waitingOn',          title: 'Waiting On' },
  { key: 'recommendedActions', title: 'Recommended Actions' },
  { key: 'recentEmailIntel',   title: 'Recent Email Intelligence' },
  { key: 'proposedFormUpdates',title: 'Proposed Form Updates' },
  { key: 'venueImpact',        title: 'Venue Impact' },
  { key: 'documents',          title: 'Documents' },
  { key: 'advancementHistory', title: 'Advancement History' },
]

export default function ShowBrief() {
  const { id: showId } = useParams()
  const [brief, setBrief] = useState(null)
  const [busy, setBusy]   = useState(false)
  const [err, setErr]     = useState(null)
  const [drill, setDrill] = useState(null) // { title, sources }

  async function load() {
    setBusy(true); setErr(null)
    try {
      const r = await api.get('/show-brief/' + encodeURIComponent(showId))
      setBrief(r.data.data)
    } catch (e) {
      setErr(e.response?.data?.message || e.message)
    } finally { setBusy(false) }
  }
  useEffect(() => { load() }, [showId]) // eslint-disable-line

  if (busy && !brief) return <div style={{ padding: 20 }}>Loading brief…</div>
  if (err) return <div style={{ padding: 20, color: '#c00' }}>{err}</div>
  if (!brief) return null

  return (
    <div style={{ padding: 20, display: 'grid', gap: 16 }}>
      <AiDisclosureBanner />
      <Header brief={brief} onRefresh={load} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 12 }}>
        {SECTIONS.slice(1).map(sec => (
          <SectionCard key={sec.key} title={sec.title} onOpenSources={setDrill}>
            {renderSection(sec.key, brief, setDrill)}
          </SectionCard>
        ))}
      </div>
      {drill && <SourceDrawer title={drill.title} sources={drill.sources} onClose={() => setDrill(null)} />}
    </div>
  )
}

// Persistent disclosure at the top of every brief. Required by product
// guarantee: the UI must clearly distinguish AI-composed content from
// authoritative data. Nothing here is a database of record — it is a
// composed view over the show's existing rows.
function AiDisclosureBanner() {
  return (
    <div style={{
      border: '1px solid #cfe0f5', background: '#f2f8ff', color: '#1a4a7a',
      borderRadius: 6, padding: '8px 12px', fontSize: 13, lineHeight: 1.4,
    }}>
      <div><strong>AI-composed brief.</strong> Every claim below links to its source row
        (email, form entry, or audit event). No value is ever changed until a
        production manager approves it.</div>
      <div style={{ marginTop: 4, fontSize: 12 }}>
        Each line is labelled:
        {' '}<ClaimBadge type="fact" /> verified from a source row,
        {' '}<ClaimBadge type="inference" /> derived by the engine,
        {' '}<ClaimBadge type="recommendation" /> a suggested action,
        {' '}<ClaimBadge type="assumption" /> an industry-standard fallback,
        {' '}<ClaimBadge type="unknown" /> a known gap.
      </div>
    </div>
  )
}

function Header({ brief, onRefresh }) {
  const s = brief.show || {}
  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, background: '#fff' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <div style={{ fontSize: 12, color: '#888' }}>
            <Link to={`/shows/${s.id}`}>← Show page</Link> ·
            <Link to={`/email-intel?showId=${s.id}`} style={{ marginLeft: 6 }}>Email Intel</Link>
          </div>
          <h1 style={{ margin: '4px 0 0' }}>{s.artist || s.eventName || 'Show'} — {s.date}</h1>
          <div style={{ color: '#555', marginTop: 6, fontSize: 14 }}>{brief.aiShowBrief?.text}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <StatusPill status={brief.status} />
          <ReadinessBar readiness={brief.readiness} />
          <button className="btn" onClick={onRefresh}>Refresh</button>
        </div>
      </div>
    </div>
  )
}

function StatusPill({ status }) {
  const colors = {
    blocked:              { bg: '#fee', color: '#900' },
    in_progress:          { bg: '#fff4e0', color: '#a06000' },
    ready_pending_review: { bg: '#eef4fa', color: '#1a4a7a' },
    advanced:             { bg: '#eaf6ea', color: '#2a6b2a' },
    not_started:          { bg: '#f4f4f4', color: '#555' },
  }
  const c = colors[status] || { bg: '#f0f0f0', color: '#333' }
  return (
    <span style={{ padding: '4px 10px', borderRadius: 12, background: c.bg, color: c.color, fontSize: 12, fontWeight: 600 }}>
      {String(status || '').replace(/_/g, ' ') || 'unknown'}
    </span>
  )
}

function ReadinessBar({ readiness }) {
  if (!readiness) return null
  const tiers = ['critical', 'high', 'medium', 'low']
  return (
    <div style={{ display: 'flex', gap: 6, fontSize: 11 }}>
      {tiers.map(t => {
        const r = readiness[t] || { unresolved: 0, total: 0 }
        return (
          <span key={t} style={{
            padding: '2px 6px', borderRadius: 4,
            background: r.unresolved > 0 ? '#fbeeee' : '#eaf6ea',
            color: r.unresolved > 0 ? '#800' : '#2a6b2a',
          }}>
            {t}: {r.unresolved}/{r.total}
          </span>
        )
      })}
    </div>
  )
}

function SectionCard({ title, children }) {
  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 14, background: '#fff' }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#1a4a7a', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function renderSection(key, brief, setDrill) {
  const items = brief[key]
  if (!items || (Array.isArray(items) && items.length === 0)) {
    return <div style={{ color: '#888', fontSize: 13 }}>No items.</div>
  }
  switch (key) {
    case 'whatChanged':         return <ChangeList items={items} setDrill={setDrill} />
    case 'needsAttention':      return <RuleList items={items} setDrill={setDrill} showTier />
    case 'conflicts':           return <ConflictList items={items} setDrill={setDrill} />
    case 'missingInformation':  return <MissingList items={items} />
    case 'waitingOn':           return <WaitingList items={items} setDrill={setDrill} />
    case 'keyContacts':         return <ContactsList items={items} />
    case 'loadInPlan':          return <LoadInList items={items} />
    case 'recommendedActions':  return <ActionList items={items} setDrill={setDrill} />
    case 'recentEmailIntel':    return <IntelList items={items} setDrill={setDrill} />
    case 'proposedFormUpdates': return <ProposalList items={items} setDrill={setDrill} />
    case 'venueImpact':         return <ImpactList items={items} setDrill={setDrill} />
    case 'documents':           return <DocList items={items} setDrill={setDrill} />
    case 'advancementHistory':  return <HistoryList items={items} setDrill={setDrill} />
    default: return null
  }
}

function TinyMeta({ text }) {
  return <span style={{ fontSize: 11, color: '#888' }}>{text}</span>
}

// Epistemic label — mirrors the CLAIM_TYPES exported by showBrief.js. The
// PM must be able to tell at a glance whether a line is verified truth
// (FACT), a derivation from truth (INFERENCE), an action to consider
// (RECOMMENDATION), an industry-standard fallback (ASSUMPTION), or a known
// gap (UNKNOWN). Never show a claim without one of these.
const CLAIM_STYLE = {
  fact:           { bg: '#eaf6ea', color: '#2a6b2a', label: 'FACT' },
  inference:      { bg: '#eef4fa', color: '#1a4a7a', label: 'INFERENCE' },
  recommendation: { bg: '#fff4e0', color: '#a06000', label: 'RECOMMEND' },
  assumption:     { bg: '#f4efe0', color: '#7a6a00', label: 'ASSUMPTION' },
  unknown:        { bg: '#fee',    color: '#900',    label: 'UNKNOWN' },
}
function ClaimBadge({ type }) {
  if (!type) return null
  const c = CLAIM_STYLE[type] || CLAIM_STYLE.unknown
  return (
    <span style={{
      display: 'inline-block', padding: '1px 6px', borderRadius: 3,
      background: c.bg, color: c.color, fontSize: 10, fontWeight: 700,
      letterSpacing: 0.3, marginRight: 6, verticalAlign: 'middle',
    }}>{c.label}</span>
  )
}

function SourcesLink({ item, setDrill }) {
  if (!item.sources || item.sources.length === 0) return null
  return (
    <button className="btn small" style={{ marginLeft: 6, padding: '1px 6px', fontSize: 11 }}
            onClick={() => setDrill({ title: item.text || item.title || 'Sources', sources: item.sources })}>
      View source ({item.sources.length})
    </button>
  )
}

function ChangeList({ items, setDrill }) {
  return items.slice(0, 10).map(i => (
    <div key={i.id} style={{ padding: '6px 0', borderTop: '1px solid #f0f0f0' }}>
      <div style={{ fontSize: 13 }}><ClaimBadge type={i.claimType} />{i.text}</div>
      <TinyMeta text={`${(i.at || '').replace('T', ' ').slice(0, 16)} · ${i.approvedBy || ''}`} />
      <SourcesLink item={i} setDrill={setDrill} />
    </div>
  ))
}
function RuleList({ items, setDrill, showTier }) {
  return items.map(i => (
    <div key={i.id} style={{ padding: '6px 0', borderTop: '1px solid #f0f0f0' }}>
      <div style={{ fontSize: 13, fontWeight: 500 }}>
        <ClaimBadge type={i.claimType} />
        {showTier && <TierBadge tier={i.tier} />} {i.title}
      </div>
      <div style={{ fontSize: 12, color: '#555' }}>{i.text}</div>
      {i.action && <div style={{ fontSize: 12, color: '#1a4a7a', marginTop: 2 }}>→ {i.action}</div>}
      {i.deadline && <TinyMeta text={`due ${i.deadline}`} />}
      <SourcesLink item={i} setDrill={setDrill} />
    </div>
  ))
}
function TierBadge({ tier }) {
  const colors = { critical:'#900', high:'#a06000', medium:'#1a4a7a', low:'#555' }
  return (
    <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: '#f4f4f4', color: colors[tier] || '#333', marginRight: 4 }}>
      {tier}
    </span>
  )
}
function ConflictList({ items, setDrill }) {
  return items.map(i => (
    <div key={i.id} style={{ padding: '6px 0', borderTop: '1px solid #f0f0f0' }}>
      <div style={{ fontSize: 13, fontWeight: 500, color: '#900' }}>
        <ClaimBadge type={i.claimType} />{i.title}
      </div>
      <div style={{ fontSize: 12, color: '#555' }}>{i.text}</div>
      {i.action && <div style={{ fontSize: 12, color: '#1a4a7a' }}>→ {i.action}</div>}
      <SourcesLink item={i} setDrill={setDrill} />
    </div>
  ))
}
function MissingList({ items }) {
  return items.map(i => (
    <div key={i.id} style={{ padding: '6px 0', borderTop: '1px solid #f0f0f0', fontSize: 13 }}>
      <ClaimBadge type={i.claimType} />
      <span style={{ color: '#900' }}>●</span> {i.label}
      <TinyMeta text={` · ${i.where}`} />
    </div>
  ))
}
function WaitingList({ items, setDrill }) {
  return items.map(i => (
    <div key={i.id} style={{ padding: '6px 0', borderTop: '1px solid #f0f0f0' }}>
      <div style={{ fontSize: 13 }}>
        <ClaimBadge type={i.claimType} />
        {i.overdue && <span style={{ marginRight: 6, fontSize: 10, background: '#fee', color: '#900', padding: '1px 5px', borderRadius: 3, fontWeight: 600 }}>OVERDUE</span>}
        {i.text}
      </div>
      {i.why && <TinyMeta text={i.why} />}
      <SourcesLink item={i} setDrill={setDrill} />
    </div>
  ))
}
function ContactsList({ items }) {
  const known   = items.filter(i => i.claimType === 'fact')
  const missing = items.filter(i => i.claimType === 'unknown')
  return (
    <>
      {known.map(i => (
        <div key={i.id} style={{ padding: '6px 0', borderTop: '1px solid #f0f0f0', fontSize: 13 }}>
          <ClaimBadge type={i.claimType} />
          <strong>{i.role}:</strong> {i.name || '—'}
          {i.isPrimary && <span style={{ marginLeft: 6, fontSize: 10, background: '#eaf6ea', color: '#2a6b2a', padding: '1px 5px', borderRadius: 3 }}>PRIMARY</span>}
          <div style={{ fontSize: 12, color: '#555', marginLeft: 60 }}>
            {i.phone && <span>📞 {i.phone}</span>}
            {i.phone && i.email && <span> · </span>}
            {i.email && <span>✉ {i.email}</span>}
          </div>
        </div>
      ))}
      {missing.map(i => (
        <div key={i.id} style={{ padding: '6px 0', borderTop: '1px solid #f0f0f0', fontSize: 13 }}>
          <ClaimBadge type={i.claimType} />
          <span style={{ color: '#900' }}>●</span> {i.text}
        </div>
      ))}
    </>
  )
}
function LoadInList({ items }) {
  return items.map(i => (
    <div key={i.id} style={{ padding: '6px 0', borderTop: '1px solid #f0f0f0', fontSize: 13 }}>
      <ClaimBadge type={i.claimType} />
      {i.claimType === 'unknown' && <span style={{ color: '#900' }}>●</span>}
      {' '}{i.text}
    </div>
  ))
}
function ActionList({ items, setDrill }) {
  return items.map(i => (
    <div key={i.id} style={{ padding: '6px 0', borderTop: '1px solid #f0f0f0' }}>
      <div style={{ fontSize: 13 }}>
        <ClaimBadge type={i.claimType} />
        <TierBadge tier={i.tier} /> {i.text}
      </div>
      {i.why && <TinyMeta text={i.why} />}
      <SourcesLink item={i} setDrill={setDrill} />
    </div>
  ))
}
function IntelList({ items, setDrill }) {
  return items.map(i => (
    <div key={i.id} style={{ padding: '6px 0', borderTop: '1px solid #f0f0f0' }}>
      <div style={{ fontSize: 13 }}><ClaimBadge type={i.claimType} />{i.text}</div>
      {i.excerpt && <div style={{ fontSize: 12, color: '#555', fontStyle: 'italic', marginTop: 2 }}>“{i.excerpt}”</div>}
      <TinyMeta text={(i.at || '').replace('T', ' ').slice(0, 16)} />
      <SourcesLink item={i} setDrill={setDrill} />
    </div>
  ))
}
function ProposalList({ items, setDrill }) {
  return items.map(i => (
    <div key={i.id} style={{ padding: '6px 0', borderTop: '1px solid #f0f0f0' }}>
      <div style={{ fontSize: 13 }}>
        <ClaimBadge type={i.claimType} />
        <strong>{i.humanField}</strong>: {String(i.current ?? '—')} → <strong>{String(i.proposed)}</strong>
        <RiskBadge risk={i.risk} />
      </div>
      {i.reason && <TinyMeta text={i.reason} />}
      <SourcesLink item={i} setDrill={setDrill} />
    </div>
  ))
}
function RiskBadge({ risk }) {
  const map = { high:{bg:'#fee',color:'#900'}, low:{bg:'#eaf6ea',color:'#2a6b2a'}, unknown:{bg:'#f4f4f4',color:'#666'} }
  const c = map[risk] || map.unknown
  return <span style={{ marginLeft: 6, padding: '1px 6px', borderRadius: 3, background: c.bg, color: c.color, fontSize: 10 }}>{risk}</span>
}
function ImpactList({ items, setDrill }) {
  return items.map(i => (
    <div key={i.id} style={{ padding: '6px 0', borderTop: '1px solid #f0f0f0' }}>
      <div style={{ fontSize: 13, fontWeight: 500 }}>
        <ClaimBadge type={i.claimType} />{i.title}
      </div>
      <div style={{ fontSize: 12 }}>
        Requested {String(i.requested)} · Venue: {i.capability ? String(i.capability.value) : 'unknown'} ·
        <span style={{ color: i.matches === 'yes' ? '#2a6b2a' : '#900', marginLeft: 4 }}>{i.matches}</span>
        {i.critical && <span style={{ marginLeft: 6, color: '#900', fontWeight: 600 }}>CRITICAL</span>}
      </div>
      {i.reason && <TinyMeta text={i.reason} />}
      <SourcesLink item={i} setDrill={setDrill} />
    </div>
  ))
}
function DocList({ items, setDrill }) {
  return items.map(i => (
    <div key={i.id} style={{ padding: '6px 0', borderTop: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div>
        <div style={{ fontSize: 13 }}><ClaimBadge type={i.claimType} />{i.label}</div>
        {i.fileName && <TinyMeta text={i.fileName} />}
      </div>
      <div>
        {i.status === 'present'
          ? <span style={{ padding: '2px 8px', borderRadius: 10, background: '#eaf6ea', color: '#2a6b2a', fontSize: 11 }}>on file</span>
          : <span style={{ padding: '2px 8px', borderRadius: 10, background: '#fee', color: '#900', fontSize: 11 }}>missing</span>}
        <SourcesLink item={i} setDrill={setDrill} />
      </div>
    </div>
  ))
}
function HistoryList({ items, setDrill }) {
  return items.slice(0, 12).map(i => (
    <div key={i.id} style={{ padding: '6px 0', borderTop: '1px solid #f0f0f0' }}>
      <div style={{ fontSize: 13 }}><ClaimBadge type={i.claimType} />{i.text}</div>
      <TinyMeta text={`${(i.at || '').replace('T', ' ').slice(0, 16)} · ${i.by || ''} · ${i.kind}`} />
      <SourcesLink item={i} setDrill={setDrill} />
    </div>
  ))
}

/**
 * Sources drawer — the drill-down surface. Each source is a link to the
 * concrete evidence: source email thread, fact detail, or document.
 */
function SourceDrawer({ title, sources, onClose }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
         onClick={onClose}>
      <div style={{ background: '#fff', width: 640, maxHeight: '85vh', overflow: 'auto', borderRadius: 8, padding: 20 }}
           onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <h3 style={{ margin: 0 }}>Sources</h3>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
        <div style={{ fontSize: 13, color: '#555', marginTop: 4 }}>{title}</div>
        <div style={{ marginTop: 16, display: 'grid', gap: 10 }}>
          {sources.map((s, i) => (
            <div key={i} style={{ border: '1px solid #eee', borderRadius: 6, padding: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <div style={{ fontSize: 12, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>{s.kind}</div>
                {s.at && <div style={{ fontSize: 11, color: '#888' }}>{String(s.at).replace('T', ' ').slice(0, 16)}</div>}
              </div>
              {s.from && <div style={{ fontSize: 13, marginTop: 4 }}>from <strong>{s.from}</strong></div>}
              {s.excerpt && <div style={{ marginTop: 6, padding: 8, background: '#fafafa', borderLeft: '3px solid #ddd', fontSize: 13, fontStyle: 'italic' }}>“{s.excerpt}”</div>}
              {s.label && !s.excerpt && <div style={{ fontSize: 13, marginTop: 4 }}>{s.label}</div>}
              <div style={{ marginTop: 8, display: 'flex', gap: 8, fontSize: 12 }}>
                {s.ref && <Link to={s.ref}>Open →</Link>}
                {s.threadId && <TinyMeta text={`thread ${s.threadId.slice(0, 12)}`} />}
                {s.factId && <TinyMeta text={`fact ${s.factId.slice(0, 12)}`} />}
              </div>
            </div>
          ))}
          {sources.length === 0 && <div style={{ color: '#888' }}>No sources.</div>}
        </div>
      </div>
    </div>
  )
}
