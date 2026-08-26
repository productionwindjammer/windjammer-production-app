import { useEffect, useMemo, useState } from 'react'
import api from '../api'
import Modal from '../components/Modal'
import { useAuth } from '../context/AuthContext'
import { ROLE } from '../utils/roles'

// ── Taxonomy ────────────────────────────────────────────────────────────────
// Must match server-side venueKnowledge.js CATEGORY_SUBCATEGORIES exactly.
const CATEGORIES = [
  { key: 'physical',    label: 'Physical',    icon: '🏛️' },
  { key: 'technical',   label: 'Technical',   icon: '🎛️' },
  { key: 'labor',       label: 'Labor',       icon: '👷' },
  { key: 'operations',  label: 'Operations',  icon: '🚦' },
  { key: 'hospitality', label: 'Hospitality', icon: '🍽️' },
  { key: 'vendors',     label: 'Vendors',     icon: '🤝' },
]

const SUBCATEGORIES = {
  physical:    ['rooms', 'stage', 'audience', 'dock', 'parking', 'access', 'elevators', 'production_office'],
  technical:   ['audio', 'consoles', 'microphones', 'rf', 'lighting', 'video', 'led', 'projection', 'backline', 'rigging', 'motors', 'power'],
  labor:       ['departments', 'union', 'minimum_calls', 'overtime', 'meals', 'standard_calls', 'local_vendors'],
  operations:  ['building_rules', 'production_rules', 'curfew', 'loading', 'access', 'security', 'fire_life_safety', 'credentials', 'parking'],
  hospitality: ['dressing_rooms', 'green_rooms', 'showers', 'laundry', 'catering', 'equipment'],
  vendors:     ['audio', 'lighting', 'video', 'backline', 'transportation', 'catering', 'rigging', 'security', 'other'],
}

const DATA_TYPES = ['number', 'string', 'boolean', 'list', 'range', 'object']
const KINDS      = ['rule', 'observation']
const STATUSES   = ['active', 'draft', 'superseded', 'expired', 'rejected']
const SCOPES     = ['venue', 'stage:inside', 'stage:beach', 'building']

const BLANK = {
  kind: 'rule',
  category: 'technical',
  subcategory: 'power',
  attributePath: '',
  scope: 'venue',
  subject: '',
  dataType: 'number',
  valueText: '',
  unit: '',
  confidence: '',
  status: 'active',
  source: 'manual',
  sourceRef: '',
  effectiveFrom: '',
  effectiveTo: '',
  notes: '',
  sampleSize: '',
}

// Write access is admin / PM / venue_management. Everyone else can read.
const CAN_WRITE = [ROLE.ADMIN, ROLE.PRODUCTION_MANAGER, ROLE.VENUE_MANAGEMENT]

export default function VenueKnowledge() {
  const { user } = useAuth()
  const canWrite = CAN_WRITE.includes(user?.role)
  const canDelete = user?.role === ROLE.ADMIN

  const [items, setItems]       = useState([])
  const [loading, setLoading]   = useState(true)
  const [tab, setTab]           = useState('technical')
  const [kindFilter, setKindFilter] = useState('rule')
  const [search, setSearch]     = useState('')
  const [modal, setModal]       = useState(false) // 'edit' | 'history' | 'analyze' | false
  const [editing, setEditing]   = useState(null)
  const [form, setForm]         = useState(BLANK)
  const [saving, setSaving]     = useState(false)
  const [historyRows, setHistoryRows] = useState([])
  const [analyzeReq, setAnalyzeReq]   = useState({
    category: 'technical', attributePath: '', requestedValue: '', unit: '', scope: 'venue',
  })
  const [analyzeResult, setAnalyzeResult] = useState(null)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const res = await api.get('/venue-knowledge')
      setItems(res.data.data || [])
    } finally { setLoading(false) }
  }

  // ── Grouped by subcategory for the active category tab ──────────────────
  const visibleItems = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter(it =>
      it.category === tab &&
      (kindFilter === 'all' || it.kind === kindFilter) &&
      it.status !== 'superseded' &&
      it.status !== 'expired' &&
      (!q ||
        (it.attributePath || '').toLowerCase().includes(q) ||
        (it.subcategory   || '').toLowerCase().includes(q) ||
        (it.notes         || '').toLowerCase().includes(q) ||
        JSON.stringify(it.value || '').toLowerCase().includes(q)),
    )
  }, [items, tab, kindFilter, search])

  const grouped = useMemo(() => {
    const g = {}
    for (const it of visibleItems) {
      const key = it.subcategory || '(uncategorized)'
      if (!g[key]) g[key] = []
      g[key].push(it)
    }
    return g
  }, [visibleItems])

  const stats = useMemo(() => {
    const total = items.filter(i => i.status === 'active').length
    const rules = items.filter(i => i.status === 'active' && i.kind === 'rule').length
    const obs   = items.filter(i => i.status === 'active' && i.kind === 'observation').length
    return { total, rules, obs }
  }, [items])

  // ── Form helpers ────────────────────────────────────────────────────────
  function openAdd() {
    setEditing(null)
    setForm({ ...BLANK, category: tab, subcategory: SUBCATEGORIES[tab]?.[0] || '', kind: kindFilter === 'observation' ? 'observation' : 'rule' })
    setModal('edit')
  }

  function openEdit(it) {
    setEditing(it)
    setForm({
      ...BLANK,
      ...it,
      valueText: formatValueForInput(it.value, it.dataType),
      sourceRef: it.sourceRef ? JSON.stringify(it.sourceRef) : '',
      confidence: it.confidence ?? '',
      sampleSize: it.sampleSize ?? '',
    })
    setModal('edit')
  }

  async function openHistory(it) {
    setEditing(it)
    setHistoryRows([])
    setModal('history')
    try {
      const res = await api.get(`/venue-knowledge/${it.id}/history`)
      setHistoryRows(res.data.data || [])
    } catch (err) {
      alert('Failed to load history: ' + (err.response?.data?.message || err.message))
    }
  }

  async function handleSave() {
    setSaving(true)
    try {
      const body = {
        kind:          form.kind,
        category:      form.category,
        subcategory:   form.subcategory,
        attributePath: form.attributePath.trim(),
        scope:         form.scope,
        subject:       form.subject.trim(),
        dataType:      form.dataType,
        value:         parseValueInput(form.valueText, form.dataType),
        unit:          form.unit.trim(),
        confidence:    form.confidence === '' ? undefined : Number(form.confidence),
        status:        form.status,
        source:        form.source,
        sourceRef:     tryParseJson(form.sourceRef),
        effectiveFrom: form.effectiveFrom,
        effectiveTo:   form.effectiveTo,
        notes:         form.notes.trim(),
        sampleSize:    form.sampleSize === '' ? undefined : Number(form.sampleSize),
      }
      if (editing) await api.put(`/venue-knowledge/${editing.id}`, body)
      else         await api.post('/venue-knowledge', body)
      await load()
      setModal(false)
    } catch (err) {
      alert(err.response?.data?.message || err.message)
    } finally { setSaving(false) }
  }

  async function handleArchive(it) {
    if (!confirm(`Archive "${it.attributePath}"? Superseded/expired rows stay searchable but leave the active view.`)) return
    try {
      await api.delete(`/venue-knowledge/${it.id}`)
      await load()
    } catch (err) {
      alert(err.response?.data?.message || err.message)
    }
  }

  async function runAnalyze() {
    setAnalyzeResult(null)
    try {
      const body = {
        ...analyzeReq,
        requestedValue: parseValueInput(analyzeReq.requestedValue, 'auto'),
      }
      const res = await api.post('/venue-knowledge/analyze', body)
      setAnalyzeResult(res.data.data)
    } catch (err) {
      setAnalyzeResult({ error: err.response?.data?.message || err.message })
    }
  }

  const set = k => e => setForm(v => ({ ...v, [k]: e.target.value }))

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Venue Intelligence 🏛️</div>
          <div className="page-subtitle">
            Persistent, structured knowledge about the venue — what the building can do, what it can't, and what we've learned from past shows.
          </div>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-ghost" onClick={() => { setAnalyzeResult(null); setModal('analyze') }}>
            🔍 Ask the Venue
          </button>
          {canWrite && (
            <button className="btn btn-primary" onClick={openAdd}>
              + Add {kindFilter === 'observation' ? 'Observation' : 'Rule'}
            </button>
          )}
        </div>
      </div>

      {/* Guidance banner: this is the taxonomy the AI relies on. */}
      <div className="card" style={{ marginBottom: 12, background: 'var(--surface-2, rgba(255,255,255,0.03))' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 16 }}>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>📏 Rule</div>
            <div className="text-muted" style={{ fontSize: 13 }}>
              Permanent capabilities & constraints. "Building holds 350A three-phase stage power." Used by the AI to compare tour requests.
            </div>
          </div>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>📊 Observation</div>
            <div className="text-muted" style={{ fontSize: 13 }}>
              Historical patterns tied to a subject (promoter, artist, tour). "AC Entertainment usually catering ~75." Never treated as capability.
            </div>
          </div>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>🚫 Not a show fact</div>
            <div className="text-muted" style={{ fontSize: 13 }}>
              Current-show details (this artist's line array count, tonight's set time) belong on the Advance / Schedule — <em>not</em> here.
            </div>
          </div>
        </div>
      </div>

      <div className="flex gap-2 mb-2" style={{ flexWrap: 'wrap' }}>
        {CATEGORIES.map(c => {
          const count = items.filter(i => i.category === c.key && i.status === 'active').length
          return (
            <button key={c.key}
              className={`btn ${tab === c.key ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setTab(c.key)}>
              {c.icon} {c.label} ({count})
            </button>
          )
        })}
      </div>

      <div className="flex gap-2 mb-4" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="flex gap-2">
          {['rule', 'observation', 'all'].map(k => (
            <button key={k}
              className={`btn btn-sm ${kindFilter === k ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setKindFilter(k)}>
              {k === 'rule' ? '📏 Rules' : k === 'observation' ? '📊 Observations' : 'All'}
            </button>
          ))}
        </div>
        <input
          className="input"
          style={{ flex: 1, minWidth: 200 }}
          placeholder="Search attribute path, notes, or value…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div className="text-muted" style={{ fontSize: 12 }}>
          {stats.total} active · {stats.rules} rules · {stats.obs} observations
        </div>
      </div>

      {loading ? (
        <div className="card"><div className="loading">Loading venue knowledge…</div></div>
      ) : Object.keys(grouped).length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div style={{ fontSize: 32, marginBottom: 8 }}>🏛️</div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Nothing recorded yet in {tab}</div>
            <div className="text-muted" style={{ fontSize: 13 }}>
              {canWrite
                ? `Add the venue's ${tab} rules so the AI can compare tour requests against real capability.`
                : `A production manager needs to record the venue's ${tab} rules.`}
            </div>
          </div>
        </div>
      ) : (
        Object.entries(grouped).map(([sub, rows]) => (
          <div key={sub} className="card" style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
              <div style={{ fontWeight: 600, textTransform: 'capitalize' }}>
                {sub.replace(/_/g, ' ')}
                <span className="text-muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
                  {rows.length} item{rows.length === 1 ? '' : 's'}
                </span>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Attribute</th>
                    <th>Value</th>
                    <th>Scope</th>
                    <th>Kind</th>
                    {kindFilter !== 'rule' && <th>Subject</th>}
                    <th>Confidence</th>
                    <th>Source</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(it => (
                    <tr key={it.id}>
                      <td>
                        <div style={{ fontFamily: 'monospace', fontSize: 12 }}>{it.attributePath}</div>
                        {it.notes && <div className="text-muted" style={{ fontSize: 11 }}>{it.notes}</div>}
                      </td>
                      <td>
                        <span style={{ fontWeight: 600 }}>{formatValueForDisplay(it.value)}</span>
                        {it.unit && <span className="text-muted"> {it.unit}</span>}
                      </td>
                      <td className="text-muted" style={{ fontSize: 12 }}>{it.scope || 'venue'}</td>
                      <td>
                        <span className={`badge badge-${it.kind === 'rule' ? 'confirmed' : 'pending'}`}>
                          {it.kind === 'rule' ? '📏 Rule' : '📊 Obs'}
                        </span>
                      </td>
                      {kindFilter !== 'rule' && <td className="text-muted" style={{ fontSize: 12 }}>{it.subject || '—'}</td>}
                      <td className="text-muted" style={{ fontSize: 12 }}>
                        {it.confidence != null ? `${Math.round(Number(it.confidence) * 100)}%` : '—'}
                        {it.sampleSize && <span> · n={it.sampleSize}</span>}
                      </td>
                      <td className="text-muted" style={{ fontSize: 12 }}>{it.source || '—'}</td>
                      <td>
                        <div className="actions-cell">
                          <button className="btn btn-ghost btn-sm" onClick={() => openHistory(it)}>History</button>
                          {canWrite && <button className="btn btn-ghost btn-sm" onClick={() => openEdit(it)}>Edit</button>}
                          {canDelete && <button className="btn btn-danger btn-sm" onClick={() => handleArchive(it)}>Archive</button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}

      {/* ── Add / Edit modal ─────────────────────────────────────────────── */}
      {modal === 'edit' && (
        <Modal onClose={() => setModal(false)} title={editing ? 'Edit knowledge item' : 'Add knowledge item'} size="lg">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label>Kind</label>
              <select className="input" value={form.kind} onChange={set('kind')}>
                {KINDS.map(k => <option key={k} value={k}>{k}</option>)}
              </select>
              <div className="text-muted" style={{ fontSize: 11, marginTop: 2 }}>
                <strong>rule</strong> = permanent venue capability. <strong>observation</strong> = pattern about a subject (requires subject).
              </div>
            </div>
            <div>
              <label>Status</label>
              <select className="input" value={form.status} onChange={set('status')}>
                {STATUSES.filter(s => s !== 'superseded').map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>

            <div>
              <label>Category</label>
              <select className="input" value={form.category} onChange={e => setForm(v => ({
                ...v, category: e.target.value, subcategory: SUBCATEGORIES[e.target.value]?.[0] || '',
              }))}>
                {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <label>Subcategory</label>
              <select className="input" value={form.subcategory} onChange={set('subcategory')}>
                {(SUBCATEGORIES[form.category] || []).map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </select>
            </div>

            <div style={{ gridColumn: '1 / -1' }}>
              <label>Attribute path <span className="text-muted" style={{ fontSize: 11 }}>(dotted, e.g. <code>technical.power.stage_amps</code>)</span></label>
              <input className="input" value={form.attributePath} onChange={set('attributePath')} placeholder="technical.power.stage_amps" />
            </div>

            <div>
              <label>Scope</label>
              <select className="input" value={form.scope} onChange={set('scope')}>
                {SCOPES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label>Data type</label>
              <select className="input" value={form.dataType} onChange={set('dataType')}>
                {DATA_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>

            <div style={{ gridColumn: '1 / -1' }}>
              <label>
                Value
                <span className="text-muted" style={{ fontSize: 11, marginLeft: 6 }}>
                  {form.dataType === 'list'    && '(JSON array, e.g. ["Avid S6L","DiGiCo SD10"])'}
                  {form.dataType === 'range'   && '(JSON, e.g. {"min":0,"max":1200})'}
                  {form.dataType === 'object'  && '(JSON object)'}
                  {form.dataType === 'boolean' && '(true or false)'}
                  {form.dataType === 'number'  && '(numeric)'}
                  {form.dataType === 'string'  && '(plain text)'}
                </span>
              </label>
              <input className="input" value={form.valueText} onChange={set('valueText')} placeholder={
                form.dataType === 'list'   ? '["Avid S6L-32D","DiGiCo SD10"]' :
                form.dataType === 'range'  ? '{"min":0,"max":1200}' :
                form.dataType === 'number' ? '400' :
                form.dataType === 'boolean'? 'true' : ''
              } />
            </div>
            <div>
              <label>Unit</label>
              <input className="input" value={form.unit} onChange={set('unit')} placeholder="A, ft, lbs, meals…" />
            </div>
            <div>
              <label>Confidence (0–1)</label>
              <input className="input" type="number" min="0" max="1" step="0.05" value={form.confidence} onChange={set('confidence')} />
            </div>

            {form.kind === 'observation' && (
              <>
                <div>
                  <label>Subject <span className="text-muted" style={{ fontSize: 11 }}>(required)</span></label>
                  <input className="input" value={form.subject} onChange={set('subject')} placeholder="promoter:AC Entertainment" />
                </div>
                <div>
                  <label>Sample size</label>
                  <input className="input" type="number" min="0" value={form.sampleSize} onChange={set('sampleSize')} />
                </div>
              </>
            )}

            <div>
              <label>Source</label>
              <select className="input" value={form.source} onChange={set('source')}>
                {['manual','tech_pack','vendor_spec','observation','ai_extract'].map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label>Source ref (JSON, optional)</label>
              <input className="input" value={form.sourceRef} onChange={set('sourceRef')} placeholder='{"docId":"..."}' />
            </div>

            <div>
              <label>Effective from</label>
              <input className="input" type="date" value={form.effectiveFrom || ''} onChange={set('effectiveFrom')} />
            </div>
            <div>
              <label>Effective to</label>
              <input className="input" type="date" value={form.effectiveTo || ''} onChange={set('effectiveTo')} />
            </div>

            <div style={{ gridColumn: '1 / -1' }}>
              <label>Notes</label>
              <textarea className="input" rows={2} value={form.notes} onChange={set('notes')} placeholder="Context, caveats, references…" />
            </div>
          </div>
          <div className="flex gap-2" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={() => setModal(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={saving} onClick={handleSave}>
              {saving ? 'Saving…' : editing ? 'Save new version' : 'Create'}
            </button>
          </div>
        </Modal>
      )}

      {/* ── History modal ────────────────────────────────────────────────── */}
      {modal === 'history' && editing && (
        <Modal onClose={() => setModal(false)} title={`History — ${editing.attributePath}`}>
          {historyRows.length === 0 ? (
            <div className="text-muted">No history recorded.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Action</th>
                    <th>Who</th>
                    <th>Snapshot</th>
                  </tr>
                </thead>
                <tbody>
                  {historyRows.map(h => (
                    <tr key={h.id}>
                      <td className="text-muted" style={{ fontSize: 12 }}>{h.changedAt}</td>
                      <td><span className="badge">{h.action}</span></td>
                      <td className="text-muted" style={{ fontSize: 12 }}>{h.changedBy || '—'}</td>
                      <td>
                        <details>
                          <summary className="text-muted" style={{ fontSize: 12, cursor: 'pointer' }}>view</summary>
                          <pre style={{ fontSize: 11, maxWidth: 480, whiteSpace: 'pre-wrap' }}>{prettyJson(h.snapshot)}</pre>
                        </details>
                        {h.note && <div className="text-muted" style={{ fontSize: 11, marginTop: 4 }}>{h.note}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}

      {/* ── Ask the Venue modal ──────────────────────────────────────────── */}
      {modal === 'analyze' && (
        <Modal onClose={() => setModal(false)} title="Ask the Venue" size="lg">
          <div className="text-muted" style={{ fontSize: 13, marginBottom: 12 }}>
            Compare a request against what the venue can actually provide. If we have no rule on file, the answer will be <strong>unknown</strong> —
            the system will never invent a capability.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label>Category</label>
              <select className="input" value={analyzeReq.category} onChange={e => setAnalyzeReq(v => ({ ...v, category: e.target.value }))}>
                {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <label>Scope</label>
              <select className="input" value={analyzeReq.scope} onChange={e => setAnalyzeReq(v => ({ ...v, scope: e.target.value }))}>
                {SCOPES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label>Attribute path</label>
              <input className="input" value={analyzeReq.attributePath} onChange={e => setAnalyzeReq(v => ({ ...v, attributePath: e.target.value }))} placeholder="technical.power.stage_amps" />
            </div>
            <div>
              <label>Requested value</label>
              <input className="input" value={analyzeReq.requestedValue} onChange={e => setAnalyzeReq(v => ({ ...v, requestedValue: e.target.value }))} placeholder={'e.g. 400 or true or ["Avid S6L"]'} />
            </div>
            <div>
              <label>Unit</label>
              <input className="input" value={analyzeReq.unit} onChange={e => setAnalyzeReq(v => ({ ...v, unit: e.target.value }))} placeholder="A, ft, lbs…" />
            </div>
          </div>
          <div className="flex gap-2" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn btn-ghost" onClick={() => setModal(false)}>Close</button>
            <button className="btn btn-primary" onClick={runAnalyze}>Analyze</button>
          </div>
          {analyzeResult && <AnalyzeResultCard result={analyzeResult} />}
        </Modal>
      )}
    </div>
  )
}

// ── Result card for Ask-the-Venue ─────────────────────────────────────────
function AnalyzeResultCard({ result }) {
  if (result.error) return (
    <div className="card" style={{ marginTop: 12, background: 'rgba(220, 50, 50, 0.08)' }}>
      <strong>Error:</strong> {result.error}
    </div>
  )
  const color =
    result.matches === 'yes'     ? 'rgba(60, 180, 90, 0.12)' :
    result.matches === 'no'      ? 'rgba(220, 50, 50, 0.12)' :
    result.matches === 'partial' ? 'rgba(230, 170, 30, 0.12)' :
                                    'rgba(120, 120, 120, 0.12)'
  return (
    <div className="card" style={{ marginTop: 12, background: color }}>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>
        {result.matches === 'yes'     && '✅ Venue can support this'}
        {result.matches === 'no'      && '❌ Venue cannot support this'}
        {result.matches === 'partial' && '⚠️ Partial capability'}
        {result.matches === 'unknown' && '❓ Unknown — no venue knowledge on file'}
        {result.critical && <span style={{ marginLeft: 8, fontSize: 13 }}>🚨 CRITICAL</span>}
      </div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <strong>Reason:</strong> {result.reason}
      </div>
      {result.capability && (
        <div style={{ fontSize: 13, marginBottom: 6 }}>
          <strong>Venue provides:</strong> {formatValueForDisplay(result.capability.value)} {result.capability.unit || ''}
        </div>
      )}
      {result.gap && (
        <div style={{ fontSize: 13, marginBottom: 6 }}>
          <strong>Gap:</strong> <code style={{ fontSize: 11 }}>{JSON.stringify(result.gap)}</code>
        </div>
      )}
      {result.needsVendor && <div style={{ fontSize: 13 }}>👉 Requires vendor rental to cover shortfall.</div>}
      {result.matches === 'unknown' && !result.capability && (
        <div style={{ fontSize: 13, marginTop: 8, padding: 8, background: 'rgba(255,255,255,0.04)', borderRadius: 4 }}>
          <strong>Action needed:</strong> A production manager should record this rule so the AI can answer future questions.
        </div>
      )}
      {result.observations && result.observations.length > 0 && (
        <div style={{ fontSize: 12, marginTop: 8 }}>
          <div className="text-muted">Related observations (not treated as capability):</div>
          <ul style={{ margin: '4px 0 0 16px' }}>
            {result.observations.map(o => (
              <li key={o.id}>
                {o.subject}: {formatValueForDisplay(o.value)} {o.unit || ''} {o.sampleSize ? `(n=${o.sampleSize})` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ── Value formatters ──────────────────────────────────────────────────────
function formatValueForDisplay(v) {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (Array.isArray(v)) return v.join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function formatValueForInput(v, dataType) {
  if (v === null || v === undefined) return ''
  if (dataType === 'list' || dataType === 'range' || dataType === 'object') return JSON.stringify(v)
  return String(v)
}

function parseValueInput(text, dataType) {
  const t = (text ?? '').trim()
  if (t === '') return ''
  if (dataType === 'auto') {
    // Try JSON, then number, then boolean, then string.
    try { return JSON.parse(t) } catch { /* fall through */ }
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
    if (t === 'true') return true
    if (t === 'false') return false
    return t
  }
  if (dataType === 'number')  return Number(t)
  if (dataType === 'boolean') return t === 'true'
  if (dataType === 'list' || dataType === 'range' || dataType === 'object') {
    try { return JSON.parse(t) } catch { return t }
  }
  return t
}

function tryParseJson(text) {
  const t = (text ?? '').trim()
  if (!t) return ''
  try { return JSON.parse(t) } catch { return t }
}

function prettyJson(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return text }
}
