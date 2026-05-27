import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import api from '../api'
import Modal from '../components/Modal'
import { useAuth } from '../context/AuthContext'

const BLANK_ARTIST = {
  name: '', aliases: '', agency: '', agent: '',
  contactName: '', contactEmail: '', contactPhone: '',
  notes: '',
}

const DOC_TYPES = [
  { value: 'rider',       label: 'Tech Rider' },
  { value: 'hospitality', label: 'Hospitality Rider' },
  { value: 'stagePlot',   label: 'Stage Plot' },
  { value: 'inputList',   label: 'Input List' },
  { value: 'contract',    label: 'Contract' },
  { value: 'w9',          label: 'W-9' },
  { value: 'other',       label: 'Other' },
]

const DOC_TYPE_LABEL = Object.fromEntries(DOC_TYPES.map(t => [t.value, t.label]))

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result || ''
      const comma = String(result).indexOf(',')
      resolve(comma >= 0 ? String(result).slice(comma + 1) : String(result))
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export default function Artists() {
  const { id } = useParams()
  if (id) return <ArtistDetail id={id} />
  return <ArtistsList />
}

// ── List ─────────────────────────────────────────────────────────────────
function ArtistsList() {
  const navigate = useNavigate()
  const { effectiveRole } = useAuth()
  const canEdit = ['admin', 'production_manager'].includes(effectiveRole)

  const [artists, setArtists] = useState([])
  const [docs, setDocs]       = useState([]) // not strictly needed; left out
  const [loading, setLoading] = useState(true)
  const [search, setSearch]   = useState('')
  const [modal, setModal]     = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm]       = useState(BLANK_ARTIST)
  const [saving, setSaving]   = useState(false)

  useEffect(() => { load() }, [])
  async function load() {
    setLoading(true)
    try {
      const res = await api.get('/artists')
      setArtists(res.data.data || [])
    } finally { setLoading(false) }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = [...artists].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    if (!q) return list
    return list.filter(a =>
      (a.name || '').toLowerCase().includes(q) ||
      (a.aliases || '').toLowerCase().includes(q) ||
      (a.agency || '').toLowerCase().includes(q)
    )
  }, [artists, search])

  function openAdd() { setEditing(null); setForm(BLANK_ARTIST); setModal(true) }
  function openEdit(a) { setEditing(a); setForm({ ...BLANK_ARTIST, ...a }); setModal(true) }

  async function save(e) {
    e.preventDefault()
    if (!form.name?.trim()) { alert('Name is required'); return }
    setSaving(true)
    try {
      if (editing?.id) await api.put(`/artists/${editing.id}`, form)
      else             await api.post('/artists', form)
      setModal(false)
      await load()
    } catch (err) {
      alert('Failed to save: ' + (err?.response?.data?.message || err.message))
    } finally { setSaving(false) }
  }

  async function remove(a) {
    if (!confirm(`Delete artist "${a.name}"?\n\nThis does NOT delete attached documents — they remain in Drive but lose their registry entry.`)) return
    try { await api.delete(`/artists/${a.id}`); await load() }
    catch (err) { alert('Delete failed: ' + (err?.response?.data?.message || err.message)) }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>🎤 Artist Registry</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="search" placeholder="Search artists, aliases, agency…"
            value={search} onChange={e => setSearch(e.target.value)}
            style={{ minWidth: 260 }}
          />
          {canEdit && <button className="btn btn-primary" onClick={openAdd}>+ Add Artist</button>}
        </div>
      </div>

      {loading ? <div>Loading…</div> : filtered.length === 0 ? (
        <div className="card" style={{ padding: 24, textAlign: 'center', color: 'rgba(255,255,255,0.6)' }}>
          No artists yet.{canEdit && ' Click "+ Add Artist" to start the registry.'}
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="data-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Aliases</th>
                <th>Agency</th>
                <th>Contact</th>
                {canEdit && <th style={{ width: 120 }}></th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map(a => (
                <tr key={a.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/artists/${a.id}`)}>
                  <td><strong>{a.name}</strong></td>
                  <td style={{ color: 'rgba(255,255,255,0.6)' }}>{a.aliases}</td>
                  <td>{a.agency}</td>
                  <td style={{ fontSize: 13 }}>
                    {a.contactName}
                    {a.contactEmail && <div style={{ opacity: 0.65 }}>{a.contactEmail}</div>}
                  </td>
                  {canEdit && (
                    <td onClick={e => e.stopPropagation()}>
                      <button className="btn btn-ghost btn-sm" onClick={() => openEdit(a)}>Edit</button>
                      <button className="btn btn-danger btn-sm" onClick={() => remove(a)}>Del</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <Modal title={editing ? `Edit ${editing.name}` : 'Add Artist'} onClose={() => setModal(false)}>
          <form onSubmit={save} className="form-grid">
            <label>Name *
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
            </label>
            <label>Aliases / "also known as"
              <input value={form.aliases} placeholder="comma-separated"
                onChange={e => setForm(f => ({ ...f, aliases: e.target.value }))} />
            </label>
            <div className="form-row">
              <label>Agency
                <input value={form.agency} onChange={e => setForm(f => ({ ...f, agency: e.target.value }))} />
              </label>
              <label>Agent
                <input value={form.agent} onChange={e => setForm(f => ({ ...f, agent: e.target.value }))} />
              </label>
            </div>
            <div className="form-row">
              <label>Tour mgmt / contact name
                <input value={form.contactName} onChange={e => setForm(f => ({ ...f, contactName: e.target.value }))} />
              </label>
              <label>Contact email
                <input type="email" value={form.contactEmail} onChange={e => setForm(f => ({ ...f, contactEmail: e.target.value }))} />
              </label>
              <label>Contact phone
                <input value={form.contactPhone} onChange={e => setForm(f => ({ ...f, contactPhone: e.target.value }))} />
              </label>
            </div>
            <label>Notes
              <textarea rows={3} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
              <button type="button" className="btn btn-ghost" onClick={() => setModal(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}

// ── Detail ───────────────────────────────────────────────────────────────
function ArtistDetail({ id }) {
  const navigate = useNavigate()
  const { effectiveRole } = useAuth()
  const canEdit = ['admin', 'production_manager'].includes(effectiveRole)

  const [artist, setArtist] = useState(null)
  const [docs, setDocs]     = useState([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadMeta, setUploadMeta] = useState({ type: 'rider', year: '', notes: '' })

  useEffect(() => { load() }, [id])
  async function load() {
    setLoading(true)
    try {
      const [aRes, dRes] = await Promise.all([
        api.get('/artists'),
        api.get(`/artists/${id}/documents`),
      ])
      setArtist((aRes.data.data || []).find(a => a.id === id) || null)
      setDocs(dRes.data.data || [])
    } finally { setLoading(false) }
  }

  async function onUpload(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // reset so same file can be re-picked
    if (!file) return
    if (file.size > 25 * 1024 * 1024) { alert('Max file size is 25MB.'); return }
    setUploading(true)
    try {
      const data = await fileToBase64(file)
      await api.post(`/artists/${id}/documents`, {
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        data,
        type: uploadMeta.type,
        year: uploadMeta.year,
        notes: uploadMeta.notes,
      })
      setUploadMeta({ type: 'rider', year: '', notes: '' })
      await load()
    } catch (err) {
      alert('Upload failed: ' + (err?.response?.data?.message || err.message))
    } finally { setUploading(false) }
  }

  async function removeDoc(d) {
    if (!confirm(`Delete "${d.name}"?\n\nThis also removes the file from Drive.`)) return
    try { await api.delete(`/artist-documents/${d.id}`); await load() }
    catch (err) { alert('Delete failed: ' + (err?.response?.data?.message || err.message)) }
  }

  if (loading) return <div>Loading…</div>
  if (!artist) return (
    <div>
      <Link to="/artists" className="btn btn-ghost btn-sm">‹ Artists</Link>
      <p>Artist not found.</p>
    </div>
  )

  // Group docs by type, newest first within each
  const grouped = docs.reduce((acc, d) => {
    const k = d.type || 'other'
    if (!acc[k]) acc[k] = []
    acc[k].push(d)
    return acc
  }, {})
  for (const k of Object.keys(grouped)) {
    grouped[k].sort((a, b) => (b.year || '').localeCompare(a.year || '') || (b.createdAt || '').localeCompare(a.createdAt || ''))
  }

  return (
    <div>
      <Link to="/artists" className="btn btn-ghost btn-sm">‹ Artists</Link>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, margin: '8px 0 20px' }}>
        <div>
          <h1 style={{ margin: 0 }}>🎤 {artist.name}</h1>
          {artist.aliases && <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: 13 }}>aka {artist.aliases}</div>}
          <div style={{ marginTop: 8, fontSize: 14, color: 'rgba(255,255,255,0.7)' }}>
            {artist.agency && <span>{artist.agency}{artist.agent && ` · ${artist.agent}`}</span>}
          </div>
          {(artist.contactName || artist.contactEmail || artist.contactPhone) && (
            <div style={{ marginTop: 4, fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>
              {artist.contactName}{artist.contactEmail && ` · ${artist.contactEmail}`}{artist.contactPhone && ` · ${artist.contactPhone}`}
            </div>
          )}
        </div>
        {artist.driveFolderId && (
          <a className="btn btn-ghost btn-sm" target="_blank" rel="noreferrer"
             href={`https://drive.google.com/drive/folders/${artist.driveFolderId}`}>📁 Open Drive folder</a>
        )}
      </div>

      {artist.notes && (
        <div className="card" style={{ padding: 16, marginBottom: 20, whiteSpace: 'pre-wrap' }}>{artist.notes}</div>
      )}

      {/* Upload (PM+) */}
      {canEdit && (
        <div className="card" style={{ padding: 16, marginBottom: 20 }}>
          <h3 style={{ marginTop: 0 }}>Add a document</h3>
          <div className="form-row" style={{ alignItems: 'flex-end' }}>
            <label>Type
              <select value={uploadMeta.type} onChange={e => setUploadMeta(m => ({ ...m, type: e.target.value }))}>
                {DOC_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
            <label>Year (optional)
              <input type="number" min="1980" max="2100" value={uploadMeta.year} placeholder="e.g. 2026"
                onChange={e => setUploadMeta(m => ({ ...m, year: e.target.value }))} />
            </label>
            <label style={{ flex: 1, minWidth: 200 }}>Notes (optional)
              <input value={uploadMeta.notes} placeholder="e.g. Updated band size"
                onChange={e => setUploadMeta(m => ({ ...m, notes: e.target.value }))} />
            </label>
            <label className="btn btn-primary" style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}>
              {uploading ? 'Uploading…' : '📎 Choose file'}
              <input type="file" hidden onChange={onUpload} disabled={uploading} />
            </label>
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
            Stored in the artist's Google Drive folder (max 25 MB). All crew & staff can view.
          </div>
        </div>
      )}

      {/* Document list */}
      {docs.length === 0 ? (
        <div className="card" style={{ padding: 24, textAlign: 'center', color: 'rgba(255,255,255,0.6)' }}>
          No documents yet.{canEdit && ' Upload a tech rider, stage plot, or anything reusable across years.'}
        </div>
      ) : (
        Object.entries(grouped).map(([type, list]) => (
          <div key={type} style={{ marginBottom: 20 }}>
            <h3 style={{ marginBottom: 8, fontSize: 14, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'rgba(255,255,255,0.55)' }}>
              {DOC_TYPE_LABEL[type] || type} <span style={{ opacity: 0.5, fontWeight: 400 }}>({list.length})</span>
            </h3>
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <table className="data-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>File</th>
                    <th style={{ width: 80 }}>Year</th>
                    <th>Notes</th>
                    <th style={{ width: 160 }}>Uploaded</th>
                    <th style={{ width: 180 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map(d => (
                    <tr key={d.id}>
                      <td><strong>📄 {d.name}</strong></td>
                      <td>{d.year || ''}</td>
                      <td style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)' }}>{d.notes}</td>
                      <td style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
                        {d.uploadedBy && <div>{d.uploadedBy}</div>}
                        {d.createdAt && <div>{new Date(d.createdAt).toLocaleDateString()}</div>}
                      </td>
                      <td>
                        <a className="btn btn-ghost btn-sm" target="_blank" rel="noreferrer" href={d.webViewLink}>Open</a>
                        {canEdit && (
                          <button className="btn btn-danger btn-sm" onClick={() => removeDoc(d)}>Del</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </div>
  )
}
