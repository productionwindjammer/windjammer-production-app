import { useEffect, useState } from 'react'
import api from '../api'
import Modal from '../components/Modal'
import RichEditor from '../components/RichEditor'

const BLANK = {
  name: '', description: '', category: 'advance',
  subject: '', body: '', attachments: '[]',
}

// Tech pack sections available for the "attach one section" recipe. Keep in
// sync with the venue tech pack layout.
const TECHPACK_SECTIONS = [
  { key: 'overview',    label: 'Venue Overview' },
  { key: 'staging',     label: 'Stage Dimensions & Specs' },
  { key: 'power',       label: 'Power Distribution' },
  { key: 'audio',       label: 'Audio System' },
  { key: 'lighting',    label: 'Lighting' },
  { key: 'backline',    label: 'Backline / House Gear' },
  { key: 'stagePlot',   label: 'Stage Plot & Photos' },
  { key: 'loadIn',      label: 'Load-in / Parking / Push' },
  { key: 'hospitality', label: 'Hospitality / Dressing Room' },
]

// Artist document categories — must match the DOC_TYPES list on Artists.jsx.
const ARTIST_DOC_TYPES = [
  { value: 'rider',       label: 'Tech Rider' },
  { value: 'hospitality', label: 'Hospitality Rider' },
  { value: 'stagePlot',   label: 'Stage Plot' },
  { value: 'inputList',   label: 'Input List' },
  { value: 'consoleFile', label: 'Console File / Scene' },
  { value: 'contract',    label: 'Contract' },
  { value: 'w9',          label: 'W-9' },
  { value: 'other',       label: 'Other' },
]

const STAGE_CHOICES = [
  { value: 'auto',   label: "Match show's stage" },
  { value: 'inside', label: 'Inside Stage' },
  { value: 'beach',  label: 'Beach Stage' },
]

const PLACEHOLDERS = [
  { tag: 'artist',         desc: 'Headliner name' },
  { tag: 'date',           desc: 'Show date (YYYY-MM-DD)' },
  { tag: 'date_long',      desc: 'Show date, long form (e.g. Friday, Oct 3, 2026)' },
  { tag: 'stage_label',    desc: 'Inside Stage / Beach Stage' },
  { tag: 'doors',          desc: 'Doors time' },
  { tag: 'showTime',       desc: 'Show start time' },
  { tag: 'curfew',         desc: 'Curfew (from advance)' },
  { tag: 'promoter',       desc: 'Promoter name' },
  { tag: 'tourManager',    desc: 'Tour manager' },
  { tag: 'advanceContact', desc: 'Tour advance contact (falls back to artist registry)' },
  { tag: 'advanceEmail',   desc: 'Tour advance email' },
  { tag: 'advancePhone',   desc: 'Tour advance phone' },
  { tag: 'venue',          desc: 'The Windjammer' },
  { tag: 'sender.name',    desc: 'Signed-in user name' },
]

function parseAttachments(str) {
  try {
    const arr = typeof str === 'string' ? JSON.parse(str || '[]') : (str || [])
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}
function attachmentLabel(spec) {
  if (spec.label) return spec.label
  if (spec.type === 'techpack-pdf')     return `Tech pack PDF (${spec.stage || 'auto'})`
  if (spec.type === 'techpack-full')    return `Full tech pack (${spec.stage || 'auto'})`
  if (spec.type === 'techpack-section') {
    const s = TECHPACK_SECTIONS.find(x => x.key === spec.section)
    return `Tech pack — ${s?.label || spec.section} (${spec.stage || 'auto'})`
  }
  if (spec.type === 'artist-doc') {
    const d = ARTIST_DOC_TYPES.find(x => x.value === spec.docType)
    return `Artist document — ${d?.label || spec.docType} (from show's artist)`
  }
  if (spec.type === 'drive-file') return `Drive file: ${spec.filename || spec.fileId}`
  return spec.type || 'attachment'
}

export default function EmailTemplates() {
  const [rows, setRows]         = useState([])
  const [loading, setLoading]   = useState(true)
  const [modal, setModal]       = useState(false)
  const [editing, setEditing]   = useState(null)
  const [form, setForm]         = useState(BLANK)
  const [saving, setSaving]     = useState(false)
  const [addAttachOpen, setAddAttachOpen] = useState(false)

  useEffect(() => { load() }, [])
  async function load() {
    setLoading(true)
    try {
      const res = await api.get('/email-templates')
      setRows(res.data.data || [])
    } finally { setLoading(false) }
  }

  function openAdd() {
    setEditing(null)
    setForm(BLANK)
    setModal(true)
  }
  function openEdit(r) {
    setEditing(r)
    setForm({
      ...BLANK,
      ...r,
      attachments: typeof r.attachments === 'string' ? r.attachments : JSON.stringify(r.attachments || []),
    })
    setModal(true)
  }

  async function handleSave() {
    if (!form.name || !form.subject) { alert('Name and Subject are required.'); return }
    setSaving(true)
    try {
      // Ensure attachments is valid JSON before saving.
      let attachments = form.attachments
      try { JSON.parse(attachments) } catch { attachments = '[]' }
      const payload = { ...form, attachments, updatedAt: new Date().toISOString() }
      if (editing) await api.put(`/email-templates/${editing.id}`, payload)
      else         await api.post('/email-templates', payload)
      await load()
      setModal(false)
    } catch (err) {
      alert('Save failed: ' + (err.response?.data?.message || err.message))
    } finally { setSaving(false) }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this template?')) return
    await api.delete(`/email-templates/${id}`)
    await load()
  }

  const attachments = parseAttachments(form.attachments)

  function updateAttachments(next) {
    setForm(v => ({ ...v, attachments: JSON.stringify(next) }))
  }
  function addAttachment(spec) {
    updateAttachments([...attachments, spec])
    setAddAttachOpen(false)
  }
  function removeAttachment(idx) {
    updateAttachments(attachments.filter((_, i) => i !== idx))
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Email Templates</div>
          <div className="page-subtitle">
            Reusable email templates with merge tags and auto-attached documents.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" onClick={openAdd}>+ New Template</button>
        </div>
      </div>

      <div className="card">
        {loading ? <div className="loading">Loading…</div> : rows.length === 0 ? (
          <div className="empty-state">No templates yet.</div>
        ) : (
          <div className="table-wrap responsive-cards">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Subject</th>
                  <th>Attachments</th>
                  <th>Updated</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const atts = parseAttachments(r.attachments)
                  return (
                    <tr key={r.id}>
                      <td data-label="Name">
                        <strong>{r.name}</strong>
                        {r.description && (
                          <div className="text-muted" style={{ fontSize: 12 }}>{r.description}</div>
                        )}
                      </td>
                      <td data-label="Subject" style={{ maxWidth: 300 }}>
                        <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.subject}</span>
                      </td>
                      <td data-label="Attachments">
                        {atts.length === 0 ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                            {atts.map((a, i) => (
                              <span key={i} style={{ fontSize: 11 }}>📎 {attachmentLabel(a)}</span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td data-label="Updated" className="text-muted" style={{ fontSize: 12 }}>
                        {r.updatedAt ? new Date(r.updatedAt).toLocaleDateString() : '—'}
                      </td>
                      <td data-label="Actions">
                        <div className="actions-cell">
                          <button className="btn btn-ghost btn-sm" onClick={() => openEdit(r)}>Edit</button>
                          <button className="btn btn-danger btn-sm" onClick={() => handleDelete(r.id)}>Del</button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal && (
        <Modal
          title={editing ? 'Edit Template' : 'New Template'}
          onClose={() => setModal(false)}
          size="modal-xl"
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div className="form-row">
              <div className="form-group" style={{ flex: 2 }}>
                <label>Name</label>
                <input value={form.name} onChange={e => setForm(v => ({ ...v, name: e.target.value }))} placeholder="Advance — Initiate with tour" />
              </div>
              <div className="form-group">
                <label>Category</label>
                <select value={form.category} onChange={e => setForm(v => ({ ...v, category: e.target.value }))}>
                  <option value="advance">Advance</option>
                  <option value="day-of">Day of Show</option>
                  <option value="settlement">Settlement</option>
                  <option value="general">General</option>
                </select>
              </div>
            </div>

            <div className="form-group">
              <label>Description</label>
              <input value={form.description} onChange={e => setForm(v => ({ ...v, description: e.target.value }))} placeholder="Optional — helps other users pick the right template" />
            </div>

            <div className="form-group">
              <label>Subject</label>
              <input value={form.subject} onChange={e => setForm(v => ({ ...v, subject: e.target.value }))} placeholder="Advance — {{artist}} at The Windjammer, {{date_long}}" />
            </div>

            <details style={{ marginBottom: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>
                Available merge tags (click to insert into subject)
              </summary>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {PLACEHOLDERS.map(p => (
                  <button
                    key={p.tag}
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ fontSize: 11 }}
                    title={p.desc}
                    onClick={() => setForm(v => ({ ...v, subject: (v.subject || '') + `{{${p.tag}}}` }))}
                  >{`{{${p.tag}}}`}</button>
                ))}
              </div>
            </details>

            <div className="form-group">
              <label>Body</label>
              {/* RichEditor is uncontrolled; remount per template so initialHTML captures the right value. */}
              <RichEditor
                key={editing?.id || 'new'}
                initialHTML={form.body}
                onChange={html => setForm(v => ({ ...v, body: html }))}
              />
            </div>

            <div className="form-group">
              <label>Attachments (auto-attached when template is used)</label>
              {attachments.length === 0 ? (
                <div className="text-muted" style={{ fontSize: 12, padding: '6px 0' }}>
                  No attachments — click "+ Add attachment" to include the tech pack or a specific section.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {attachments.map((a, i) => (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 10px', background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6,
                    }}>
                      <span style={{ fontSize: 13, flex: 1 }}>📎 {attachmentLabel(a)}</span>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeAttachment(i)}>Remove</button>
                    </div>
                  ))}
                </div>
              )}
              <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => setAddAttachOpen(true)}>
                + Add attachment
              </button>
            </div>
          </div>

          {addAttachOpen && (
            <AttachmentPicker
              onCancel={() => setAddAttachOpen(false)}
              onPick={addAttachment}
            />
          )}
        </Modal>
      )}
    </div>
  )
}

function AttachmentPicker({ onCancel, onPick }) {
  const [type, setType]       = useState('techpack-pdf')
  const [stage, setStage]     = useState('auto')
  const [section, setSection] = useState(TECHPACK_SECTIONS[0].key)
  const [docType, setDocType] = useState(ARTIST_DOC_TYPES[0].value)

  function submit() {
    if (type === 'techpack-pdf') {
      onPick({ type: 'techpack-pdf', stage })
    } else if (type === 'techpack-full') {
      onPick({ type: 'techpack-full', stage })
    } else if (type === 'techpack-section') {
      onPick({ type: 'techpack-section', stage, section })
    } else if (type === 'artist-doc') {
      onPick({ type: 'artist-doc', docType })
    }
  }

  return (
    <Modal
      title="Add attachment"
      onClose={onCancel}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" onClick={submit}>Add</button>
        </>
      }
    >
      <div className="form-grid">
        <div className="form-group">
          <label>Type</label>
          <select value={type} onChange={e => setType(e.target.value)}>
            <option value="techpack-pdf">Current tech pack PDF (uploaded on Tech Pack page)</option>
            <option value="techpack-full">Full tech pack (single generated HTML file)</option>
            <option value="techpack-section">One tech pack section (HTML)</option>
            <option value="artist-doc">Artist document (rider, plot, etc.)</option>
          </select>
        </div>
        {(type === 'techpack-pdf' || type === 'techpack-full' || type === 'techpack-section') && (
          <div className="form-group">
            <label>Stage</label>
            <select value={stage} onChange={e => setStage(e.target.value)}>
              {STAGE_CHOICES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
        )}
        {type === 'techpack-section' && (
          <div className="form-group">
            <label>Section</label>
            <select value={section} onChange={e => setSection(e.target.value)}>
              {TECHPACK_SECTIONS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </div>
        )}
        {type === 'artist-doc' && (
          <div className="form-group">
            <label>Document category</label>
            <select value={docType} onChange={e => setDocType(e.target.value)}>
              {ARTIST_DOC_TYPES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
            <div className="text-muted" style={{ fontSize: 12, marginTop: 4 }}>
              Pulls the most recently uploaded document of this category from the show's artist. Falls back silently if none exists.
            </div>
          </div>
        )}
        {type === 'techpack-pdf' && (
          <div className="text-muted" style={{ fontSize: 12 }}>
            Attaches the working PDF uploaded on the Tech Pack page for the selected stage. Falls back silently if no PDF has been uploaded.
          </div>
        )}
        {(type === 'techpack-full' || type === 'techpack-section') && (
          <div className="text-muted" style={{ fontSize: 12 }}>
            "Match show's stage" pulls the tech pack that matches whichever stage the show is on.
          </div>
        )}
      </div>
    </Modal>
  )
}
