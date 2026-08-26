import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'

// Small inline banner that surfaces pending AI proposals for a given show,
// so the PM sees them from inside the existing Advancing / Show forms without
// leaving the page or opening a duplicate form. Uses the same queue endpoint
// as the EmailIntel page — no duplication.
export default function AiProposalsBanner({ showId, compact = false }) {
  const [pending, setPending] = useState([])
  const [changes, setChanges] = useState([])
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!showId) return
    let alive = true
    ;(async () => {
      setLoading(true)
      try {
        const [q, c] = await Promise.all([
          api.get(`/email-intel/queue?withPreview=1&showId=${encodeURIComponent(showId)}`),
          api.get(`/ai-changes?showId=${encodeURIComponent(showId)}`).catch(() => ({ data: { data: [] } })),
        ])
        if (!alive) return
        const rows = q.data.data || []
        setPending(rows.map(r => r.fact ? { fact: r.fact, preview: r.preview } : { fact: r, preview: null }))
        setChanges(c.data.data || [])
      } finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [showId])

  if (loading || (pending.length === 0 && changes.length === 0)) return null

  const conflicts = pending.filter(p => p.preview?.status === 'conflict').length
  const uncertain = pending.filter(p => p.preview?.status === 'uncertain' || p.preview?.status === 'unmapped').length
  const ready     = pending.length - conflicts - uncertain
  const recentChangesN = changes.length

  return (
    <div style={{
      gridColumn: '1 / -1',
      background: 'rgba(30,64,175,0.10)',
      border: '1px solid rgba(96,165,250,0.35)',
      borderRadius: 6,
      padding: '0.6rem 0.8rem',
      fontSize: '0.85rem',
      marginBottom: compact ? 8 : 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div>
          🧠 <strong>AI proposals for this show:</strong>{' '}
          {pending.length > 0 ? (
            <>
              <span style={{ color: '#22c55e' }}>{ready} ready</span>
              {uncertain > 0 && <>, <span style={{ color: '#eab308' }}>{uncertain} needs confirmation</span></>}
              {conflicts > 0 && <>, <span style={{ color: '#ef4444' }}>{conflicts} conflict{conflicts===1?'':'s'}</span></>}
            </>
          ) : <span style={{ color: '#94a3b8' }}>none pending</span>}
          {recentChangesN > 0 && <span style={{ color: '#94a3b8', marginLeft: 8 }}>· {recentChangesN} AI change{recentChangesN===1?'':'s'} on record</span>}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {(pending.length > 0 || recentChangesN > 0) && (
            <button
              type="button"
              onClick={e => { e.preventDefault(); setExpanded(v => !v) }}
              style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.2)', color: 'inherit', padding: '2px 8px', borderRadius: 3, fontSize: 12, cursor: 'pointer' }}
            >
              {expanded ? 'Hide' : 'Show details'}
            </button>
          )}
          <Link
            to={`/email-intel?showId=${encodeURIComponent(showId)}`}
            style={{ background: '#2563eb', color: '#fff', padding: '2px 8px', borderRadius: 3, fontSize: 12, textDecoration: 'none' }}
          >
            Review in Email Intel →
          </Link>
        </div>
      </div>

      {expanded && (
        <div style={{ marginTop: 8, background: 'rgba(0,0,0,0.20)', padding: 8, borderRadius: 4 }}>
          {pending.length > 0 && (
            <>
              <div style={{ fontSize: 11, color: '#94a3b8', letterSpacing: 0.5, marginBottom: 4 }}>PENDING</div>
              {pending.map(({ fact, preview }) => (
                <div key={fact.id} style={{ marginBottom: 6, fontSize: 12 }}>
                  <strong>{preview?.displayLabel || fact.field}</strong>
                  {': '}
                  <span style={{ color: '#94a3b8' }}>{preview?.currentValue || '(empty)'}</span>
                  {' → '}
                  <strong>{preview?.proposedValue || fact.newValue}</strong>
                  {preview?.status === 'conflict'  && <span style={{ color: '#ef4444', marginLeft: 6 }}>⚡ conflict</span>}
                  {preview?.status === 'uncertain' && <span style={{ color: '#eab308', marginLeft: 6 }}>❓ needs confirmation</span>}
                  {preview?.status === 'unmapped'  && <span style={{ color: '#eab308', marginLeft: 6 }}>❔ unmapped</span>}
                  {preview?.risk === 'high'        && <span style={{ color: '#ef4444', marginLeft: 6, fontSize: 10, fontWeight: 700 }}>HIGH RISK</span>}
                  <div style={{ color: '#94a3b8', fontSize: 11 }}>from {fact.senderName || fact.senderEmail || 'unknown'} · {fact.sourceDate || ''}</div>
                </div>
              ))}
            </>
          )}
          {recentChangesN > 0 && (
            <>
              <div style={{ fontSize: 11, color: '#94a3b8', letterSpacing: 0.5, marginTop: 8, marginBottom: 4 }}>RECENTLY APPLIED</div>
              {changes.slice(0, 5).map(c => (
                <div key={c.id} style={{ marginBottom: 4, fontSize: 12 }}>
                  <strong>{c.field}</strong>: <span style={{ color: '#94a3b8' }}>{c.previousValue || '(empty)'}</span> → <strong>{c.newValue}</strong>
                  <span style={{ color: '#94a3b8', marginLeft: 6, fontSize: 11 }}>by {c.approvedBy} · {c.at}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
