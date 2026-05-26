import { useEffect, useState } from 'react'
import api from '../api'
import RichEditor from '../components/RichEditor'

const STAGES = [
  { id: 'inside', label: 'Inside Stage', color: '#60aeff' },
  { id: 'beach',  label: 'Beach Stage',  color: '#4ade80' },
]

const DOC_TYPES = [
  { key: 'overview',  label: 'Stage Overview & Specs',       icon: '🏟' },
  { key: 'techpack',  label: 'Full Tech Pack',                icon: '📋' },
  { key: 'lighting',  label: 'Lighting Patch & Fixture List', icon: '💡' },
  { key: 'audio',     label: 'Audio Spec Sheet',              icon: '🔊' },
  { key: 'stageplot', label: 'Stage Plot / Dimensions',       icon: '📐' },
  { key: 'power',     label: 'Power Distribution',            icon: '⚡' },
  { key: 'catering',  label: 'Catering / Hospitality Rider',  icon: '🍽' },
  { key: 'loadinmap', label: 'Load-in Map / Directions',      icon: '🗺' },
]

export default function TechPack() {
  const [docs, setDocs]           = useState([])
  const [loading, setLoading]     = useState(true)
  const [stage, setStage]         = useState('inside')
  const [docType, setDocType]     = useState('overview')
  const [content, setContent]     = useState('')
  const [editorKey, setEditorKey] = useState('inside-overview')
  const [dirty, setDirty]         = useState(false)
  const [saving, setSaving]       = useState(false)
  const [saveMsg, setSaveMsg]     = useState('')

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const res = await api.get('/techpack')
      setDocs(res.data.data || [])
    } finally { setLoading(false) }
  }

  // When docs load (or stage/docType changes), sync content
  useEffect(() => {
    const doc = docs.find(d => d.stage === stage && d.docType === docType)
    setContent(doc?.content || '')
  }, [docs, stage, docType])

  function switchDoc(newStage, newDocType) {
    if (dirty && !confirm('You have unsaved changes — discard them?')) return
    setStage(newStage)
    setDocType(newDocType)
    setEditorKey(`${newStage}-${newDocType}`)
    setDirty(false)
    setSaveMsg('')
  }

  async function handleSave() {
    const doc = docs.find(d => d.stage === stage && d.docType === docType)
    if (!doc) return
    setSaving(true)
    try {
      await api.put(`/techpack/${doc.id}`, { content, updatedAt: new Date().toISOString() })
      await load()
      setDirty(false)
      setSaveMsg('Saved!')
      setTimeout(() => setSaveMsg(''), 2500)
    } finally { setSaving(false) }
  }

  const currentDoc  = docs.find(d => d.stage === stage && d.docType === docType)
  const stageInfo   = STAGES.find(s => s.id === stage)
  const docInfo     = DOC_TYPES.find(d => d.key === docType)

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Tech Pack</div>
          <div className="page-subtitle">Stage technical documents — always editable</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {saveMsg && <span className="success-msg">{saveMsg}</span>}
          {dirty && <span style={{ color: 'var(--warning)', fontSize: '0.8rem' }}>Unsaved changes</span>}
          <button className="btn btn-primary" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? 'Saving…' : 'Save Document'}
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '224px 1fr', gap: 16, alignItems: 'start' }}>

        {/* ── Left nav ── */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {STAGES.map(s => (
            <div key={s.id}>
              <div style={{
                padding: '10px 16px',
                fontWeight: 700,
                fontSize: '0.75rem',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: s.color,
                background: 'rgba(255,255,255,0.04)',
                borderBottom: '1px solid var(--border)',
              }}>
                {s.label}
              </div>
              {DOC_TYPES.map(d => {
                const active = stage === s.id && docType === d.key
                return (
                  <div
                    key={d.key}
                    onClick={() => switchDoc(s.id, d.key)}
                    style={{
                      padding: '8px 16px 8px 22px',
                      fontSize: '0.82rem',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      background: active ? 'rgba(59,130,246,0.15)' : 'transparent',
                      color: active ? '#60a5fa' : 'var(--text-muted)',
                      borderBottom: '1px solid var(--border)',
                      transition: 'background 0.12s, color 0.12s',
                    }}
                  >
                    <span>{d.icon}</span>
                    <span>{d.label}</span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        {/* ── Editor pane ── */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{
            padding: '14px 20px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}>
            <span style={{ fontSize: '1.25rem' }}>{docInfo?.icon}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>
                {docInfo?.label}
              </div>
              <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 2 }}>
                <span className={`badge badge-${stage}`} style={{ marginRight: 8, fontSize: '0.65rem' }}>
                  {stageInfo?.label}
                </span>
                {currentDoc?.updatedAt
                  ? `Last saved ${new Date(currentDoc.updatedAt).toLocaleString()}`
                  : 'Not yet saved'}
              </div>
            </div>
          </div>

          {loading
            ? <div className="loading">Loading documents…</div>
            : <RichEditor
                key={editorKey}
                initialHTML={content}
                onChange={html => { setContent(html); setDirty(true) }}
              />
          }
        </div>
      </div>
    </div>
  )
}
