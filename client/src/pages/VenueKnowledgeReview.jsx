import { useEffect, useMemo, useState } from 'react'
import api from '../api'

/**
 * Venue Knowledge Review — the human authorization surface for the
 * learning system. Nothing here becomes an authoritative rule until an
 * admin/PM explicitly accepts it. Version history is preserved by the
 * VenueKnowledge history sheet automatically on promotion.
 */

const STATUS_TABS = [
  ['proposed',  'Proposed'],
  ['edited',    'Edited'],
  ['accepted',  'Accepted'],
  ['rejected',  'Rejected'],
]

const CORRECTION_TYPES = [
  'SHOW_SPECIFIC','VENUE_SPECIFIC','PROMOTER_SPECIFIC','TOUR_SPECIFIC',
  'ARTIST_SPECIFIC','VENDOR_SPECIFIC','INDUSTRY_WIDE','ONE_TIME',
]

export default function VenueKnowledgeReview() {
  const [tab, setTab] = useState('proposed')
  const [tabCorrections, setTabCorrections] = useState('candidates')
  const [candidates, setCandidates] = useState([])
  const [corrections, setCorrections] = useState([])
  const [selected, setSelected] = useState(null)
  const [busy, setBusy] = useState(false)
  const [scanResult, setScanResult] = useState(null)
  const [editDraft, setEditDraft] = useState(null)
  const [error, setError] = useState(null)

  async function load() {
    setBusy(true)
    try {
      const [c, x] = await Promise.all([
        api.get('/knowledge-candidates?status=' + encodeURIComponent(tab)),
        api.get('/corrections'),
      ])
      setCandidates(c.data.data || [])
      setCorrections(x.data.data || [])
    } finally { setBusy(false) }
  }
  useEffect(() => { load() /* eslint-disable-line */ }, [tab])

  async function runScan() {
    setError(null)
    setScanResult(null)
    try {
      const r = await api.post('/corrections/scan', {})
      setScanResult(r.data.data)
      load()
    } catch (err) {
      setError(err.response?.data?.message || err.message)
    }
  }

  async function review(cand, action, patch = {}) {
    setError(null)
    try {
      await api.post(`/knowledge-candidates/${cand.id}/review`, { action, ...patch })
      setSelected(null); setEditDraft(null)
      load()
    } catch (err) {
      setError(err.response?.data?.message || err.message)
    }
  }

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ margin: 0 }}>Venue Knowledge Review</h1>
          <div style={{ color: 'var(--text-muted)', marginTop: 4, fontSize: 13, maxWidth: 700 }}>
            Repeated PM corrections surface here as <em>candidate rules</em>. Nothing becomes authoritative until you accept it.
            Version history is preserved automatically when a candidate is accepted.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={load} disabled={busy}>Refresh</button>
          <button className="btn primary" onClick={runScan} disabled={busy}>Scan for patterns</button>
        </div>
      </div>

      {scanResult && (
        <div style={{ marginTop: 12, background: '#eef4fa', border: '1px solid #bcd', padding: 10, borderRadius: 6 }}>
          <strong>Scan complete.</strong> {scanResult.created?.length || 0} new candidate(s), {scanResult.updated?.length || 0} updated,
          {' '}{scanResult.skipped?.length || 0} below threshold.
        </div>
      )}
      {error && (
        <div style={{ marginTop: 12, background: '#fbeeee', border: '1px solid #c99', color: '#800', padding: 10, borderRadius: 6 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #ddd', margin: '16px 0' }}>
        {[['candidates','Candidates'], ['corrections','Corrections log']].map(([k, l]) => (
          <button key={k} onClick={() => setTabCorrections(k)}
            style={{ padding: '8px 14px', border: 0, background: tabCorrections === k ? '#1a4a7a' : 'transparent',
                     color: tabCorrections === k ? '#fff' : '#333', borderRadius: '6px 6px 0 0', cursor: 'pointer' }}>
            {l}
          </button>
        ))}
      </div>

      {tabCorrections === 'candidates' && (
        <>
          <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
            {STATUS_TABS.map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)}
                style={{ padding: '6px 10px', border: '1px solid var(--border)',
                         background: tab === k ? '#333' : '#fff', color: tab === k ? '#fff' : '#333',
                         borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                {l}
              </button>
            ))}
          </div>
          <CandidateTable
            candidates={candidates}
            onSelect={(c) => { setSelected(c); setEditDraft(makeEditDraft(c)) }}
          />
          {selected && (
            <ReviewModal
              candidate={selected}
              editDraft={editDraft}
              onEditDraft={setEditDraft}
              onClose={() => { setSelected(null); setEditDraft(null) }}
              onReject={(note) => review(selected, 'reject', { reviewNote: note })}
              onEdit={() => review(selected, 'edit', editDraft)}
              onAccept={() => review(selected, 'accept', editDraft)}
            />
          )}
        </>
      )}

      {tabCorrections === 'corrections' && (
        <CorrectionsTable corrections={corrections} />
      )}
    </div>
  )
}

function makeEditDraft(c) {
  const bool = (v) => String(v || '').toLowerCase() === 'true'
  return {
    value:         c.value,
    scope:         c.scope || c.scopeKey || 'venue',
    effectiveFrom: c.effectiveFrom || '',
    expiresAt:     c.expiresAt || '',
    authoritative: bool(c.authoritative),
    temporary:     bool(c.temporary),
    reviewNote:    c.reviewNote || '',
  }
}

function CandidateTable({ candidates, onSelect }) {
  if (candidates.length === 0) return <div style={{ color: 'var(--text-muted)', padding: 20 }}>No candidates in this status.</div>
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', background: 'var(--bg-card)' }}>
      <table style={{ width: '100%', fontSize: 13 }}>
        <thead>
          <tr style={{ background: 'var(--bg-sidebar)', textAlign: 'left' }}>
            <th style={{ padding: 10 }}>Field</th>
            <th style={{ padding: 10 }}>Proposed value</th>
            <th style={{ padding: 10 }}>Suggested scope</th>
            <th style={{ padding: 10 }}>Scope key</th>
            <th style={{ padding: 10 }}>Occurrences</th>
            <th style={{ padding: 10 }}>Shows</th>
            <th style={{ padding: 10 }}>Updated</th>
            <th style={{ padding: 10 }}></th>
          </tr>
        </thead>
        <tbody>
          {candidates.map(c => {
            const showCount = safeParse(c.showIds)?.length || 0
            return (
              <tr key={c.id} style={{ borderTop: '1px solid #eee' }}>
                <td style={{ padding: 10 }}><code>{c.field}</code></td>
                <td style={{ padding: 10, fontWeight: 500 }}>{c.value}</td>
                <td style={{ padding: 10 }}>
                  <span style={{ padding: '2px 8px', borderRadius: 10, background: '#e6f0ff', color: '#1a4a7a', fontSize: 11 }}>
                    Potential {classificationLabel(c.suggestedClassification)} detected
                  </span>
                </td>
                <td style={{ padding: 10, color: 'var(--text-muted)' }}>{c.scopeValue || '(any)'}</td>
                <td style={{ padding: 10 }}>{c.occurrences}</td>
                <td style={{ padding: 10 }}>{showCount}</td>
                <td style={{ padding: 10, color: 'var(--text-muted)', fontSize: 11 }}>{(c.updatedAt || c.at || '').slice(0, 16).replace('T', ' ')}</td>
                <td style={{ padding: 10 }}>
                  <button className="btn small" onClick={() => onSelect(c)}>Review</button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function classificationLabel(cls) {
  const map = {
    VENUE_SPECIFIC: 'venue-specific rule',
    PROMOTER_SPECIFIC: 'promoter-specific rule',
    TOUR_SPECIFIC: 'tour-specific pattern',
    ARTIST_SPECIFIC: 'artist-specific pattern',
    VENDOR_SPECIFIC: 'vendor-specific rule',
    INDUSTRY_WIDE: 'industry-wide observation',
  }
  return map[cls] || cls
}

function ReviewModal({ candidate, editDraft, onEditDraft, onClose, onReject, onEdit, onAccept }) {
  const showIds = safeParse(candidate.showIds) || []
  const supporting = safeParse(candidate.supportingCorrectionIds) || []
  const [rejectNote, setRejectNote] = useState('')
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: 'var(--bg-card)', width: 720, maxHeight: '90vh', overflow: 'auto', borderRadius: 8, padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h2 style={{ margin: 0 }}>Review candidate</h2>
            <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>
              <code>{candidate.field}</code> = <strong>{candidate.value}</strong>
            </div>
            <div style={{ marginTop: 6, fontSize: 13, color: 'var(--text-muted)' }}>
              Detected as <strong>{classificationLabel(candidate.suggestedClassification)}</strong>
              {' '}from {candidate.occurrences} correction(s) across {showIds.length} show(s){candidate.scopeValue ? ` for ${candidate.scopeValue}` : ''}.
              This is a proposal — nothing is authoritative until you accept.
            </div>
          </div>
          <button className="btn" onClick={onClose}>Close</button>
        </div>

        <hr style={{ margin: '16px 0' }} />

        <h3 style={{ margin: '0 0 8px' }}>Assign scope and effective dates</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Value">
            <input className="input" value={editDraft.value}
                   onChange={e => onEditDraft({ ...editDraft, value: e.target.value })} />
          </Field>
          <Field label="Scope">
            <select className="input" value={editDraft.scope}
                    onChange={e => onEditDraft({ ...editDraft, scope: e.target.value })}>
              <option value="venue">Venue-wide</option>
              <option value="promoter">Promoter</option>
              <option value="tourName">Tour</option>
              <option value="artist">Artist</option>
              <option value="vendor">Vendor</option>
            </select>
          </Field>
          <Field label="Effective from">
            <input className="input" type="date" value={editDraft.effectiveFrom}
                   onChange={e => onEditDraft({ ...editDraft, effectiveFrom: e.target.value })} />
          </Field>
          <Field label="Expires at">
            <input className="input" type="date" value={editDraft.expiresAt}
                   onChange={e => onEditDraft({ ...editDraft, expiresAt: e.target.value })} />
          </Field>
          <Field label="Authoritative">
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={editDraft.authoritative}
                     onChange={e => onEditDraft({ ...editDraft, authoritative: e.target.checked })} />
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Full-confidence venue rule</span>
            </label>
          </Field>
          <Field label="Temporary">
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={editDraft.temporary}
                     onChange={e => onEditDraft({ ...editDraft, temporary: e.target.checked })} />
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Retire on expiration</span>
            </label>
          </Field>
        </div>
        <Field label="Review note">
          <textarea className="input" rows={2} value={editDraft.reviewNote}
                    onChange={e => onEditDraft({ ...editDraft, reviewNote: e.target.value })}
                    placeholder="Why this decision — recorded in version history." />
        </Field>

        <hr style={{ margin: '16px 0' }} />
        <h3 style={{ margin: '0 0 8px' }}>Supporting evidence</h3>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {supporting.length} correction row(s) in <code>AiCorrections</code>. Shows: {showIds.join(', ') || '—'}
        </div>

        <hr style={{ margin: '16px 0' }} />

        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 1 }}>
            <input className="input" style={{ flex: 1 }} placeholder="Reject reason (recorded)"
                   value={rejectNote} onChange={e => setRejectNote(e.target.value)} />
            <button className="btn" onClick={() => onReject(rejectNote)}>Reject</button>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onEdit}>Save edits (still pending)</button>
            <button className="btn primary" onClick={onAccept}>Accept &amp; promote</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function CorrectionsTable({ corrections }) {
  if (corrections.length === 0) return <div style={{ color: 'var(--text-muted)', padding: 20 }}>No corrections yet.</div>
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'auto', background: 'var(--bg-card)' }}>
      <table style={{ width: '100%', fontSize: 12 }}>
        <thead>
          <tr style={{ background: 'var(--bg-sidebar)', textAlign: 'left' }}>
            <th style={{ padding: 8 }}>When</th>
            <th style={{ padding: 8 }}>Actor</th>
            <th style={{ padding: 8 }}>Show</th>
            <th style={{ padding: 8 }}>Field</th>
            <th style={{ padding: 8 }}>AI</th>
            <th style={{ padding: 8 }}>Corrected</th>
            <th style={{ padding: 8 }}>Type</th>
            <th style={{ padding: 8 }}>Reason</th>
          </tr>
        </thead>
        <tbody>
          {corrections.map(c => (
            <tr key={c.id} style={{ borderTop: '1px solid #eee' }}>
              <td style={{ padding: 8, color: 'var(--text-muted)' }}>{(c.at || '').slice(0, 16).replace('T', ' ')}</td>
              <td style={{ padding: 8 }}>{c.actor}</td>
              <td style={{ padding: 8 }}>{c.showId}</td>
              <td style={{ padding: 8 }}><code>{c.field}</code></td>
              <td style={{ padding: 8, textDecoration: 'line-through', color: 'var(--text-muted)' }}>{c.aiValue}</td>
              <td style={{ padding: 8, fontWeight: 500 }}>{c.correctedValue}</td>
              <td style={{ padding: 8 }}>
                <span style={{ padding: '2px 6px', background: '#f0f0f0', borderRadius: 4, fontSize: 11 }}>{c.correctionType}</span>
              </td>
              <td style={{ padding: 8, color: 'var(--text-muted)' }}>{c.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'block', marginTop: 8 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 }}>{label}</div>
      {children}
    </label>
  )
}

function safeParse(s) {
  if (s == null || s === '') return null
  if (typeof s !== 'string') return s
  try { return JSON.parse(s) } catch { return null }
}
