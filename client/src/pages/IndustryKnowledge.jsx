import { useEffect, useMemo, useState } from 'react'
import api from '../api'

/**
 * Industry Knowledge Layer browser.
 *
 * Read-only view of the six-tier stratified ontology plus CRUD for the
 * venue's local rule set (UserOntologyRules sheet). Nothing here overrides
 * the seed ontology — user rules extend it at query time via
 * industryKnowledge.resolveTerm().
 */

const TIER_HELP = [
  ['show_specific',         'Facts about a specific show (approved EmailFacts + Advancing rows).'],
  ['user_instructed',       'Venue admin rules added here. Highest authority for terminology.'],
  ['venue_policy',          'VenueKnowledge rules (kind=rule, active).'],
  ['historical_observation','VenueKnowledge observations. Informational — not authoritative.'],
  ['industry_standard',     'Curated seed ontology. General industry practice; may vary by venue/union/region/scale.'],
  ['unknown',               'No information available in any tier. Never fabricated.'],
]

const RULE_KINDS = [
  { value: 'term_disambiguation',  label: 'Term disambiguation', hint: 'e.g. "PM" → production_manager_venue in advance emails.' },
  { value: 'synonym',              label: 'Synonym',             hint: 'e.g. "crew call" → load_in.' },
  { value: 'concept_override',     label: 'Concept override',    hint: 'Override the description for a concept.' },
  { value: 'variability_note',     label: 'Variability note',    hint: 'Region/union/scale-specific note.' },
  { value: 'operational_convention', label: 'Operational convention', hint: 'e.g. "We always run fire-marshal walk 30 min before doors."' },
]

export default function IndustryKnowledge() {
  const [tab, setTab]           = useState('domains')
  const [domains, setDomains]   = useState([])
  const [concepts, setConcepts] = useState([])
  const [workflows, setWorkflows] = useState([])
  const [selectedDomain, setSelectedDomain] = useState('')
  const [rules, setRules]       = useState([])
  const [resolveInput, setResolveInput] = useState({ term: '', context: '' })
  const [resolveResult, setResolveResult] = useState(null)
  const [ruleDraft, setRuleDraft] = useState({ kind: 'term_disambiguation', subject: '', statement: '', scope: 'venue-wide', note: '' })
  const [ruleError, setRuleError] = useState(null)
  const [busy, setBusy] = useState(false)

  async function load() {
    setBusy(true)
    try {
      const [d, c, w, r] = await Promise.all([
        api.get('/industry/domains'),
        api.get('/industry/concepts'),
        api.get('/industry/workflows'),
        api.get('/industry/user-rules'),
      ])
      setDomains(d.data.data || [])
      setConcepts(c.data.data || [])
      setWorkflows(w.data.data || [])
      setRules(r.data.data || [])
    } finally { setBusy(false) }
  }
  useEffect(() => { load() }, [])

  const filteredConcepts = useMemo(() =>
    selectedDomain ? concepts.filter(c => c.domain === selectedDomain) : concepts,
    [concepts, selectedDomain])

  async function runResolve(e) {
    e?.preventDefault?.()
    if (!resolveInput.term.trim()) return
    setResolveResult(null)
    const r = await api.post('/industry/resolve', resolveInput)
    setResolveResult(r.data.data)
  }

  async function addRule(e) {
    e?.preventDefault?.()
    setRuleError(null)
    try {
      let statement = ruleDraft.statement.trim()
      if (ruleDraft.kind === 'term_disambiguation' || ruleDraft.kind === 'synonym') {
        if (!statement.startsWith('{')) statement = JSON.stringify({ conceptId: statement })
      }
      await api.post('/industry/user-rules', { ...ruleDraft, statement })
      setRuleDraft({ kind: 'term_disambiguation', subject: '', statement: '', scope: 'venue-wide', note: '' })
      load()
    } catch (err) {
      setRuleError(err.response?.data?.message || err.message)
    }
  }

  async function removeRule(id) {
    if (!confirm('Delete this rule?')) return
    await api.delete('/industry/user-rules/' + id)
    load()
  }

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h1 style={{ margin: 0 }}>Industry Knowledge</h1>
          <div style={{ color: '#666', marginTop: 4, fontSize: 13 }}>
            Live-concert domain ontology. Venue policy and user rules override industry standard. Unknown stays unknown — nothing here is fabricated.
          </div>
        </div>
        <button className="btn" onClick={load} disabled={busy}>Refresh</button>
      </div>

      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #ddd', marginBottom: 16 }}>
        {[
          ['domains',   'Domains'],
          ['concepts',  'Concepts'],
          ['workflows', 'Workflows'],
          ['resolve',   'Resolve Term'],
          ['rules',     'User Rules'],
          ['tiers',     'Knowledge Tiers'],
        ].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)}
            style={{ padding: '8px 14px', border: 0, background: tab === k ? '#1a4a7a' : 'transparent',
                     color: tab === k ? '#fff' : '#333', borderRadius: '6px 6px 0 0', cursor: 'pointer' }}>
            {l}
          </button>
        ))}
      </div>

      {tab === 'domains' && <DomainsView domains={domains} concepts={concepts} onOpen={(id) => { setSelectedDomain(id); setTab('concepts') }} />}
      {tab === 'concepts' && (
        <ConceptsView concepts={filteredConcepts} domains={domains} selectedDomain={selectedDomain} onDomain={setSelectedDomain} />
      )}
      {tab === 'workflows' && <WorkflowsView workflows={workflows} />}
      {tab === 'resolve' && (
        <ResolveView input={resolveInput} onChange={setResolveInput} onRun={runResolve} result={resolveResult} concepts={concepts} />
      )}
      {tab === 'rules' && (
        <RulesView
          rules={rules}
          draft={ruleDraft}
          onDraft={setRuleDraft}
          onAdd={addRule}
          onDelete={removeRule}
          error={ruleError}
          concepts={concepts}
        />
      )}
      {tab === 'tiers' && <TiersView />}
    </div>
  )
}

function DomainsView({ domains, concepts, onOpen }) {
  const count = (id) => concepts.filter(c => c.domain === id).length
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
      {domains.map(d => (
        <div key={d.id} onClick={() => onOpen(d.id)}
             style={{ border: '1px solid #ddd', borderRadius: 8, padding: 14, cursor: 'pointer', background: '#fff' }}>
          <div style={{ fontWeight: 600 }}>{d.label}</div>
          {d.parent && <div style={{ fontSize: 11, color: '#888' }}>subdomain of {d.parent}</div>}
          <div style={{ marginTop: 8, fontSize: 12, color: '#555' }}>{count(d.id)} concepts</div>
        </div>
      ))}
    </div>
  )
}

function ConceptsView({ concepts, domains, selectedDomain, onDomain }) {
  const [selected, setSelected] = useState(null)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 16 }}>
      <div>
        <div style={{ marginBottom: 8 }}>
          <select value={selectedDomain} onChange={e => onDomain(e.target.value)} className="input">
            <option value="">All domains</option>
            {domains.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
        </div>
        <div style={{ border: '1px solid #ddd', borderRadius: 6, maxHeight: '70vh', overflow: 'auto' }}>
          {concepts.map(c => (
            <div key={c.id} onClick={() => setSelected(c)}
                 style={{ padding: '8px 10px', borderBottom: '1px solid #eee', cursor: 'pointer',
                          background: selected?.id === c.id ? '#eef4fa' : '#fff' }}>
              <div style={{ fontWeight: 500, fontSize: 13 }}>{c.label}</div>
              <div style={{ fontSize: 11, color: '#888' }}>{c.kind} · {c.domain}</div>
            </div>
          ))}
          {concepts.length === 0 && <div style={{ padding: 10, color: '#888' }}>No concepts.</div>}
        </div>
      </div>
      <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, background: '#fff' }}>
        {selected ? <ConceptDetail concept={selected} /> : <div style={{ color: '#888' }}>Select a concept.</div>}
      </div>
    </div>
  )
}

function ConceptDetail({ concept }) {
  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 600 }}>{concept.label}</div>
      <div style={{ color: '#666', fontSize: 12 }}>
        {concept.kind} · {concept.domain} · tier: industry_standard
      </div>
      <p style={{ marginTop: 12 }}>{concept.description}</p>
      {concept.synonyms?.length > 0 && (
        <Row label="Synonyms"><em>{concept.synonyms.join(', ')}</em></Row>
      )}
      {concept.responsibilities?.length > 0 && (
        <Row label="Responsibilities">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {concept.responsibilities.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </Row>
      )}
      {concept.relatedTo?.length > 0 && (
        <Row label="Related concepts">{concept.relatedTo.join(', ')}</Row>
      )}
      {concept.variability?.length > 0 && (
        <Row label="Variability">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {concept.variability.map((v, i) => (
              <li key={i}><strong>{v.dimension}:</strong> {v.note}</li>
            ))}
          </ul>
        </Row>
      )}
    </div>
  )
}

function Row({ label, children }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ marginTop: 4 }}>{children}</div>
    </div>
  )
}

function WorkflowsView({ workflows }) {
  return (
    <div>
      {workflows.map(wf => (
        <div key={wf.id} style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, marginBottom: 12, background: '#fff' }}>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{wf.label}</div>
          {wf.description && <div style={{ color: '#555', marginTop: 4 }}>{wf.description}</div>}
          {wf.stages?.length > 0 && (
            <Row label="Stages">
              <table style={{ width: '100%', fontSize: 13 }}>
                <thead><tr style={{ textAlign: 'left', color: '#666' }}>
                  <th>Stage</th><th>Owner</th><th>Window</th><th>Notes</th>
                </tr></thead>
                <tbody>
                  {wf.stages.map((s, i) => (
                    <tr key={i} style={{ borderTop: '1px solid #eee' }}>
                      <td>{s.name}</td>
                      <td>{s.owner || '—'}</td>
                      <td>{s.typicalWindow || '—'}</td>
                      <td>{s.description || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Row>
          )}
          {wf.standardInfoRequired?.length > 0 && (
            <Row label="Standard information required">
              <div style={{ fontSize: 12 }}>{wf.standardInfoRequired.join(' · ')}</div>
            </Row>
          )}
          {wf.commonExceptions?.length > 0 && (
            <Row label="Common exceptions">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {wf.commonExceptions.map((e, i) => <li key={i}><strong>{e.case}:</strong> {e.deviation}</li>)}
              </ul>
            </Row>
          )}
          {wf.commonConflicts?.length > 0 && (
            <Row label="Common conflicts">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {wf.commonConflicts.map((c, i) => <li key={i}><strong>{c.case}:</strong> {c.consequence}</li>)}
              </ul>
            </Row>
          )}
          {wf.variability?.length > 0 && (
            <Row label="Variability">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {wf.variability.map((v, i) => <li key={i}><strong>{v.dimension}:</strong> {v.note}</li>)}
              </ul>
            </Row>
          )}
        </div>
      ))}
    </div>
  )
}

function ResolveView({ input, onChange, onRun, result }) {
  return (
    <div style={{ maxWidth: 720 }}>
      <p style={{ color: '#555' }}>
        Try any term or acronym. Ambiguous acronyms (PM, TM, plot, rider, push) require context — the resolver will refuse to guess.
      </p>
      <form onSubmit={onRun} style={{ display: 'grid', gap: 8 }}>
        <input className="input" placeholder="Term (e.g. PM)"
               value={input.term} onChange={e => onChange({ ...input, term: e.target.value })} />
        <textarea className="input" placeholder='Context (paste surrounding text — e.g. "advance email from tour PM")'
                  rows={4}
                  value={input.context} onChange={e => onChange({ ...input, context: e.target.value })} />
        <div><button className="btn primary" type="submit">Resolve</button></div>
      </form>
      {result && (
        <div style={{ marginTop: 16, border: '1px solid #ddd', borderRadius: 8, padding: 14, background: '#fff' }}>
          <div style={{ fontSize: 13, color: '#666' }}>Result</div>
          <div style={{ marginTop: 6, fontSize: 15 }}>
            <strong>Resolved:</strong> {result.resolved ? 'yes' : 'no'}<br/>
            <strong>Concept:</strong> {result.conceptId || '(none)'}<br/>
            <strong>Tier:</strong> {result.tier}<br/>
            <strong>Reason:</strong> {result.reason}
          </div>
          {result.alternatives?.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 12, color: '#888' }}>Alternatives (could not disambiguate)</div>
              <div>{result.alternatives.join(', ')}</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function RulesView({ rules, draft, onDraft, onAdd, onDelete, error, concepts }) {
  const kindHint = RULE_KINDS.find(k => k.value === draft.kind)?.hint
  return (
    <div>
      <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, background: '#fff', marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Add a rule</div>
        <p style={{ color: '#555', fontSize: 13, marginTop: 0 }}>
          User rules override industry standard. Venue policy still overrides authoritative facts.
        </p>
        <form onSubmit={onAdd} style={{ display: 'grid', gap: 8, maxWidth: 720 }}>
          <label style={{ fontSize: 12, color: '#666' }}>Kind
            <select className="input" value={draft.kind} onChange={e => onDraft({ ...draft, kind: e.target.value })}>
              {RULE_KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </label>
          {kindHint && <div style={{ fontSize: 12, color: '#888' }}>{kindHint}</div>}
          <label style={{ fontSize: 12, color: '#666' }}>Subject (term or concept id)
            <input className="input" value={draft.subject} onChange={e => onDraft({ ...draft, subject: e.target.value })} />
          </label>
          <label style={{ fontSize: 12, color: '#666' }}>Statement
            <input className="input" placeholder={draft.kind === 'term_disambiguation' || draft.kind === 'synonym' ? 'concept id, e.g. production_manager_venue' : 'text or JSON'}
                   value={draft.statement} onChange={e => onDraft({ ...draft, statement: e.target.value })} />
          </label>
          <label style={{ fontSize: 12, color: '#666' }}>Scope
            <input className="input" placeholder="venue-wide  |  context:settlement  |  context:advance"
                   value={draft.scope} onChange={e => onDraft({ ...draft, scope: e.target.value })} />
          </label>
          <label style={{ fontSize: 12, color: '#666' }}>Note (optional)
            <input className="input" value={draft.note} onChange={e => onDraft({ ...draft, note: e.target.value })} />
          </label>
          {error && <div style={{ color: '#c00' }}>{error}</div>}
          <div><button className="btn primary" type="submit">Add rule</button></div>
        </form>
      </div>

      <div style={{ border: '1px solid #ddd', borderRadius: 8, background: '#fff' }}>
        <div style={{ padding: 12, fontWeight: 600 }}>Active rules ({rules.length})</div>
        <table style={{ width: '100%', fontSize: 13 }}>
          <thead><tr style={{ textAlign: 'left', background: '#f8f8f8' }}>
            <th style={{ padding: 8 }}>Kind</th>
            <th style={{ padding: 8 }}>Subject</th>
            <th style={{ padding: 8 }}>Statement</th>
            <th style={{ padding: 8 }}>Scope</th>
            <th style={{ padding: 8 }}>Added</th>
            <th style={{ padding: 8 }}></th>
          </tr></thead>
          <tbody>
            {rules.map(r => (
              <tr key={r.id} style={{ borderTop: '1px solid #eee' }}>
                <td style={{ padding: 8 }}>{r.kind}</td>
                <td style={{ padding: 8 }}>{r.subject}</td>
                <td style={{ padding: 8, fontFamily: 'monospace', fontSize: 11 }}>{r.statement}</td>
                <td style={{ padding: 8 }}>{r.scope}</td>
                <td style={{ padding: 8, fontSize: 11, color: '#666' }}>{r.addedBy} · {r.addedAt?.slice(0, 10)}</td>
                <td style={{ padding: 8 }}><button className="btn small" onClick={() => onDelete(r.id)}>Delete</button></td>
              </tr>
            ))}
            {rules.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 16, color: '#888', textAlign: 'center' }}>
                No user rules yet. The industry-standard seed is in effect.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function TiersView() {
  return (
    <div style={{ maxWidth: 820 }}>
      <p style={{ color: '#555' }}>
        The knowledge layer stratifies information into six tiers. For factual questions (like "what is the curfew tonight?"),
        we walk the tiers from top to bottom and use the first authoritative answer. Unknown never overrides anything.
      </p>
      <table style={{ width: '100%', fontSize: 14, background: '#fff', border: '1px solid #ddd', borderRadius: 8 }}>
        <thead><tr style={{ background: '#f8f8f8', textAlign: 'left' }}>
          <th style={{ padding: 10 }}>#</th>
          <th style={{ padding: 10 }}>Tier</th>
          <th style={{ padding: 10 }}>What it is</th>
        </tr></thead>
        <tbody>
          {TIER_HELP.map(([tier, note], i) => (
            <tr key={tier} style={{ borderTop: '1px solid #eee' }}>
              <td style={{ padding: 10 }}>{i + 1}</td>
              <td style={{ padding: 10 }}><code>{tier}</code></td>
              <td style={{ padding: 10 }}>{note}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 12, color: '#555', fontSize: 13 }}>
        Precedence for facts (top wins): show_specific → user_instructed → venue_policy → historical_observation → industry_standard → unknown.<br/>
        Precedence for terminology (top wins): user_instructed → venue_policy → industry_standard.
      </div>
    </div>
  )
}
