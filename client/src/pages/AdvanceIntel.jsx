import { useEffect, useState } from 'react'
import api from '../api'

const CATEGORY_LABELS = {
  people: 'Who is involved',
  organizations: 'Organizations',
  schedule: 'Schedule',
  production: 'Production requirements',
  labor: 'Labor',
  hospitality: 'Hospitality',
  transportation: 'Transportation',
  venue_requirements: 'What the venue needs to provide',
  responsibilities: 'Responsibilities',
  tasks: 'What to do next',
  dependencies: 'Dependencies',
  changes: 'What changed',
  conflicts: 'Conflicts',
  missing_information: 'What we are waiting for',
  risks: 'Risks',
  small_details: 'Small operational details',
  documents: 'Documents',
  other: 'Other',
}

const CATEGORY_ORDER = [
  'changes', 'conflicts', 'risks', 'venue_requirements', 'tasks',
  'people', 'schedule', 'production', 'labor', 'hospitality',
  'transportation', 'responsibilities', 'dependencies',
  'missing_information', 'small_details', 'documents', 'organizations', 'other',
]

const STATUS_COLOR = {
  confirmed: 'var(--success)', proposed: 'var(--info)',
  requested: 'var(--info)',    unconfirmed: 'var(--warning)',
  inferred:  'var(--warning)', conflicting: 'var(--danger)',
  superseded: 'var(--text-muted)', cancelled: 'var(--text-muted)',
  unknown: 'var(--text-muted)',
}

function AtomCard({ atom }) {
  const p = atom.payload || {}
  const title = p.full_name || p.name || p.title || p.kind || p.department || p.category || p.requirement || p.description || p.text || p.path || atom.path
  return (
    <div style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 6, marginBottom: 8, background: 'var(--bg)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{title}</div>
        <div style={{ fontSize: 11, display: 'flex', gap: 6 }}>
          <span style={{ color: STATUS_COLOR[atom.status] || 'var(--text-muted)' }}>{atom.status}</span>
          <span style={{ color: 'var(--text-muted)' }}>· {atom.confidence}</span>
        </div>
      </div>
      {p.role && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{p.role_category || p.role}{p.organization ? ` · ${p.organization}` : ''}</div>}
      {(p.emails?.length || p.phones?.length) && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {(p.emails || []).join(' · ')}{p.emails?.length && p.phones?.length ? ' · ' : ''}{(p.phones || []).join(' · ')}
        </div>
      )}
      {p.time_local_hhmm && <div style={{ fontSize: 12 }}>@ {p.time_local_hhmm}{p.time_text ? ` (${p.time_text})` : ''}</div>}
      {p.count != null && <div style={{ fontSize: 12 }}>× {p.count}{p.unit ? ` ${p.unit}` : ''}</div>}
      {p.value && !p.count && <div style={{ fontSize: 12 }}>{p.value}</div>}
      {p.description && p.description !== title && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{p.description}</div>}
      {p.deadline && <div style={{ fontSize: 12 }}>Deadline: {p.deadline}</div>}
      {p.priority && <div style={{ fontSize: 12 }}>Priority: {p.priority}</div>}
      {p.severity && <div style={{ fontSize: 12 }}>Severity: {p.severity}</div>}
      {p.previous && p.next && <div style={{ fontSize: 12 }}>{p.previous} → <strong>{p.next}</strong>{p.reason ? ` — ${p.reason}` : ''}</div>}
      {p.a && p.b && <div style={{ fontSize: 12 }}>{p.a} <span style={{ color: 'var(--danger)' }}>vs</span> {p.b}</div>}
      <details style={{ marginTop: 6 }}>
        <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--text-muted)' }}>Source</summary>
        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
          <div>"{atom.quotedText}"</div>
          <div>— {atom.sender || 'sender'} {atom.senderEmail ? `<${atom.senderEmail}>` : ''}{atom.model ? ` · ${atom.model}` : ''}</div>
          <div>Message id: <code>{atom.sourceEmailId}</code></div>
        </div>
      </details>
    </div>
  )
}

export default function AdvanceIntel() {
  const [shows, setShows]     = useState([])
  const [showId, setShowId]   = useState('')
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)

  useEffect(() => {
    api.get('/shows').then(r => {
      const list = r.data?.data || r.data?.shows || r.data || []
      // Only surface upcoming shows — past shows clutter the dropdown.
      const today = new Date(); today.setHours(0, 0, 0, 0)
      const upcoming = list
        .filter(s => {
          if (!s?.date) return false
          const d = new Date(s.date)
          if (Number.isNaN(d.getTime())) return false
          d.setHours(0, 0, 0, 0)
          return d >= today
        })
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      setShows(upcoming)
      if (upcoming.length && !showId) setShowId(String(upcoming[0].id))
    }).catch(e => setError(e.response?.data?.message || e.message))
  }, [])

  useEffect(() => {
    if (!showId) return
    setLoading(true); setError(null)
    api.get(`/advance/${encodeURIComponent(showId)}`)
      .then(r => setData(r.data?.data || null))
      .catch(e => setError(e.response?.data?.message || e.message))
      .finally(() => setLoading(false))
  }, [showId])

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Advance Intelligence</h2>
        <select value={showId} onChange={e => setShowId(e.target.value)} style={{ padding: 6 }}>
          {shows.map(s => (
            <option key={s.id} value={s.id}>
              {s.date} — {s.artist || s.eventName}{s.venue ? ` @ ${s.venue}` : ''}
            </option>
          ))}
        </select>
        {loading && <span style={{ color: 'var(--text-muted)' }}>Loading…</span>}
        {error && <span style={{ color: 'var(--danger)' }}>{error}</span>}
      </div>

      {data && (
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
            {Object.entries(data.counts || {}).filter(([, n]) => n > 0).map(([k, n]) => (
              <span key={k} style={{ marginRight: 10 }}><strong>{n}</strong> {k}</span>
            ))}
            {Object.values(data.counts || {}).every(n => !n) && <em>No advance intelligence yet for this show. Analyze or reanalyze its emails to populate.</em>}
          </div>
          {CATEGORY_ORDER.filter(c => (data.facts?.[c] || []).length > 0).map(cat => (
            <section key={cat} style={{ marginBottom: 20 }}>
              <h3 style={{ margin: '0 0 8px 0', fontSize: 15 }}>
                {CATEGORY_LABELS[cat]} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({data.facts[cat].length})</span>
              </h3>
              {data.facts[cat].map(a => <AtomCard key={a.id} atom={a} />)}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
