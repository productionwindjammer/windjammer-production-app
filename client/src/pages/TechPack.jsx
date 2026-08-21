import { useEffect, useMemo, useRef, useState } from 'react'
import api from '../api'
import RichEditor from '../components/RichEditor'
import ExportMenu from '../components/ExportMenu'
import { useAuth } from '../context/AuthContext'
import {
  exportTechPackStagePrint,
  exportTechPackStageHtml,
  exportTechPackSectionPrint,
} from '../utils/techpackExport'

const STAGES = [
  { id: 'inside', label: 'Inside Stage', color: '#60aeff' },
  { id: 'beach',  label: 'Beach Stage',  color: '#4ade80' },
]

// Fallback layout when the server doesn't return sections yet (very fresh install).
const DEFAULT_SECTIONS = [
  { key: 'overview',    title: 'Venue Overview',              icon: '📍', content: '' },
  { key: 'staging',     title: 'Stage Dimensions & Specs',    icon: '📐', content: '' },
  { key: 'power',       title: 'Power Distribution',          icon: '⚡', content: '' },
  { key: 'audio',       title: 'Audio System',                icon: '🔊', content: '' },
  { key: 'lighting',    title: 'Lighting',                    icon: '💡', content: '' },
  { key: 'backline',    title: 'Backline / House Gear',       icon: '🎸', content: '' },
  { key: 'stagePlot',   title: 'Stage Plot & Photos',         icon: '🎥', content: '' },
  { key: 'loadIn',      title: 'Load-in / Parking / Push',    icon: '🗺', content: '' },
  { key: 'hospitality', title: 'Hospitality / Dressing Room', icon: '🍽', content: '' },
]

export default function TechPack() {
  const { effectiveRole } = useAuth()
  const canEdit = ['admin', 'production_manager', 'stage_manager'].includes(effectiveRole)
  const [docs, setDocs]       = useState([])       // one per stage: { stage, sections, updatedAt }
  const [loading, setLoading] = useState(true)
  const [stage, setStage]     = useState('inside')
  const [sections, setSections] = useState(DEFAULT_SECTIONS)
  const [dirty, setDirty]     = useState(false)
  const [saving, setSaving]   = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [pdfBusy, setPdfBusy] = useState(false)
  const pdfInputRef = useRef(null)
  const scrollRef = useRef(null)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const res = await api.get('/techpack')
      setDocs(res.data.data || [])
    } finally { setLoading(false) }
  }

  // Sync editable state when the loaded doc or selected stage changes.
  useEffect(() => {
    const doc = docs.find(d => d.stage === stage)
    setSections(doc?.sections?.length ? doc.sections : DEFAULT_SECTIONS)
    setDirty(false)
  }, [docs, stage])

  const stageInfo   = STAGES.find(s => s.id === stage)
  const currentDoc  = docs.find(d => d.stage === stage)

  function switchStage(newStage) {
    if (dirty && !confirm('You have unsaved changes — discard them?')) return
    setStage(newStage)
    setSaveMsg('')
    // Scroll long-form back to the top for the new stage
    setTimeout(() => scrollRef.current?.scrollTo({ top: 0 }), 0)
  }

  function updateSection(key, patch) {
    setSections(prev => prev.map(s => s.key === key ? { ...s, ...patch } : s))
    setDirty(true)
  }

  function jumpTo(key) {
    const el = document.getElementById(`tp-section-${key}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  async function handleSave() {
    setSaving(true)
    try {
      await api.put(`/techpack/${stage}`, { sections })
      await load()
      setDirty(false)
      setSaveMsg('Saved!')
      setTimeout(() => setSaveMsg(''), 2500)
    } catch (err) {
      alert('Save failed: ' + (err.response?.data?.message || err.message))
    } finally { setSaving(false) }
  }

  async function handlePdfUpload(e) {
    const file = e.target.files?.[0]
    if (file) e.target.value = ''
    if (!file) return
    if (file.size > 25 * 1024 * 1024) {
      alert('PDF is larger than 25 MB — please compress or split it before uploading.')
      return
    }
    setPdfBusy(true)
    try {
      const data = await new Promise((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result).split(',')[1])
        r.onerror = reject
        r.readAsDataURL(file)
      })
      await api.post(`/techpack/${stage}/pdf`, {
        filename: file.name,
        mimeType: file.type || 'application/pdf',
        data,
      })
      await load()
    } catch (err) {
      alert('PDF upload failed: ' + (err.response?.data?.message || err.message))
    } finally { setPdfBusy(false) }
  }

  async function handlePdfRemove() {
    if (!confirm('Remove the current tech pack PDF? The file will be moved to Drive trash.')) return
    setPdfBusy(true)
    try {
      await api.delete(`/techpack/${stage}/pdf`)
      await load()
    } catch (err) {
      alert('Remove failed: ' + (err.response?.data?.message || err.message))
    } finally { setPdfBusy(false) }
  }

  const filledCount = useMemo(
    () => sections.filter(s => (s.content || '').trim() && s.content !== '<br>').length,
    [sections],
  )

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Tech Pack</div>
          <div className="page-subtitle">
            One long-form document per stage — sections stack top to bottom.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {saveMsg && <span className="success-msg">{saveMsg}</span>}
          {dirty && <span style={{ color: 'var(--warning)', fontSize: '0.8rem' }}>Unsaved changes</span>}
          <ExportMenu
            items={[
              {
                key: 'print-stage',
                label: `🖨️ Print full ${stageInfo?.label || 'stage'} pack / Save as PDF`,
                onClick: () => exportTechPackStagePrint({
                  stageLabel: stageInfo?.label || '',
                  sections,
                  updatedAt: currentDoc?.updatedAt,
                }),
              },
              {
                key: 'html-stage',
                label: `📄 Download ${stageInfo?.label || 'stage'} pack as HTML`,
                onClick: () => exportTechPackStageHtml({
                  stageLabel: stageInfo?.label || '',
                  sections,
                  updatedAt: currentDoc?.updatedAt,
                }),
              },
            ]}
          />
          <button className="btn btn-primary" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? 'Saving…' : 'Save Tech Pack'}
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '232px 1fr', gap: 16, alignItems: 'start' }}>

        {/* ── Left nav: stage picker + jump-to-section ── */}
        <div className="card" style={{ padding: 0, overflow: 'hidden', position: 'sticky', top: 12 }}>
          {STAGES.map(s => {
            const active = stage === s.id
            return (
              <div
                key={s.id}
                onClick={() => switchStage(s.id)}
                style={{
                  padding: '12px 16px',
                  cursor: 'pointer',
                  fontWeight: 700,
                  fontSize: '0.85rem',
                  color: active ? s.color : 'var(--text-muted)',
                  background: active ? 'rgba(255,255,255,0.05)' : 'transparent',
                  borderLeft: `3px solid ${active ? s.color : 'transparent'}`,
                  borderBottom: '1px solid var(--border)',
                  transition: 'background 0.12s, color 0.12s',
                }}
              >
                {s.label}
              </div>
            )
          })}
          <div style={{
            padding: '10px 16px 6px',
            fontSize: '0.7rem',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--text-muted)',
          }}>
            Sections ({filledCount}/{sections.length})
          </div>
          {sections.map(s => (
            <div
              key={s.key}
              onClick={() => jumpTo(s.key)}
              style={{
                padding: '7px 16px 7px 22px',
                cursor: 'pointer',
                fontSize: '0.82rem',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                color: 'var(--text)',
                borderBottom: '1px solid var(--border)',
                transition: 'background 0.12s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <span style={{ fontSize: '0.95rem' }}>{s.icon}</span>
              <span style={{ flex: 1 }}>{s.title}</span>
              {(s.content || '').trim() && s.content !== '<br>' && (
                <span title="Has content" style={{ color: '#4ade80', fontSize: '0.7rem' }}>●</span>
              )}
            </div>
          ))}
        </div>

        {/* ── Long-form editor pane ── */}
        <div ref={scrollRef} className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{
            padding: '14px 20px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            background: 'rgba(255,255,255,0.02)',
            position: 'sticky',
            top: 0,
            zIndex: 2,
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: '1rem' }}>
                {stageInfo?.label} Tech Pack
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
                {currentDoc?.updatedAt
                  ? `Last saved ${new Date(currentDoc.updatedAt).toLocaleString()}`
                  : 'Not yet saved'}
              </div>
            </div>
          </div>

          {/* Current tech pack PDF — the working document sent to tours/promoters. */}
          <div style={{
            padding: '12px 20px',
            borderBottom: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            background: currentDoc?.pdfFileId ? 'rgba(74,222,128,0.06)' : 'rgba(255,255,255,0.02)',
          }}>
            <div style={{ fontSize: '1.4rem' }}>📄</div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
                Current PDF
              </div>
              {currentDoc?.pdfFileId ? (
                <div style={{ marginTop: 2 }}>
                  <a
                    href={currentDoc.pdfUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontWeight: 600, wordBreak: 'break-all' }}
                  >
                    {currentDoc.pdfFilename || 'View PDF'}
                  </a>
                  {currentDoc.pdfUpdatedAt && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      Uploaded {new Date(currentDoc.pdfUpdatedAt).toLocaleString()}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ marginTop: 2, fontSize: 13, color: 'var(--text-muted)' }}>
                  No PDF uploaded yet. Upload the current working tech pack PDF so it can be auto-attached to advance emails.
                </div>
              )}
            </div>
            {canEdit && (
              <>
                <input
                  ref={pdfInputRef}
                  type="file"
                  accept="application/pdf"
                  style={{ display: 'none' }}
                  onChange={handlePdfUpload}
                />
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => pdfInputRef.current?.click()}
                  disabled={pdfBusy}
                >
                  {pdfBusy ? 'Working…' : currentDoc?.pdfFileId ? '↻ Replace' : '⬆ Upload PDF'}
                </button>
                {currentDoc?.pdfFileId && (
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={handlePdfRemove}
                    disabled={pdfBusy}
                  >
                    Remove
                  </button>
                )}
              </>
            )}
          </div>

          {loading ? (
            <div className="loading">Loading tech pack…</div>
          ) : (
            <div style={{ padding: '10px 20px 40px' }}>
              {sections.map((s, i) => (
                <TechPackSection
                  key={s.key}
                  section={s}
                  stageLabel={stageInfo?.label || ''}
                  updatedAt={currentDoc?.updatedAt}
                  first={i === 0}
                  onChange={patch => updateSection(s.key, patch)}
                />
              ))}
              {/* Sticky action row at the bottom keeps Save reachable on long docs */}
              <div style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 10,
                marginTop: 22,
                paddingTop: 16,
                borderTop: '1px solid var(--border)',
              }}>
                {dirty && (
                  <span style={{ alignSelf: 'center', color: 'var(--warning)', fontSize: '0.8rem' }}>
                    Unsaved changes
                  </span>
                )}
                <button className="btn btn-primary" onClick={handleSave} disabled={saving || !dirty}>
                  {saving ? 'Saving…' : 'Save Tech Pack'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Renders one section header + inline rich editor. Remounts the editor whenever
// the section identity changes (stage switch, initial load) via `key` so its
// internal state matches the incoming content.
function TechPackSection({ section, stageLabel, updatedAt, first, onChange }) {
  const [collapsed, setCollapsed] = useState(false)
  const filled = (section.content || '').trim() && section.content !== '<br>'

  return (
    <section
      id={`tp-section-${section.key}`}
      style={{
        marginTop: first ? 6 : 26,
        scrollMarginTop: 90,
      }}
    >
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 4px',
        borderBottom: '1px solid var(--border)',
        marginBottom: 10,
      }}>
        <span style={{ fontSize: '1.2rem' }}>{section.icon}</span>
        <h3 style={{ margin: 0, fontSize: '1rem', flex: 1 }}>{section.title}</h3>
        {filled && <span style={{ fontSize: '0.7rem', color: '#4ade80' }}>● has content</span>}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => exportTechPackSectionPrint({ stageLabel, section, updatedAt })}
          title="Print this section only"
          style={{ fontSize: '0.7rem' }}
        >
          🖨️
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setCollapsed(c => !c)}
          title={collapsed ? 'Expand' : 'Collapse'}
          style={{ fontSize: '0.7rem' }}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      </div>
      {!collapsed && (
        <RichEditor
          key={`${section.key}`}
          initialHTML={section.content || ''}
          onChange={html => onChange({ content: html })}
        />
      )}
    </section>
  )
}
