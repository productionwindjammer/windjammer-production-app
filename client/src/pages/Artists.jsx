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
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)

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
    try {
      await api.delete(`/artists/${a.id}`)
      setSelectedIds(prev => { const n = new Set(prev); n.delete(a.id); return n })
      await load()
    } catch (err) { alert('Delete failed: ' + (err?.response?.data?.message || err.message)) }
  }

  function toggleRow(id) {
    setSelectedIds(prev => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }

  function toggleAllVisible(ids, allChecked) {
    setSelectedIds(prev => {
      const n = new Set(prev)
      if (allChecked) ids.forEach(id => n.delete(id))
      else ids.forEach(id => n.add(id))
      return n
    })
  }

  async function handleBulkDelete() {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    if (!confirm(`Delete ${ids.length} artist${ids.length !== 1 ? 's' : ''}?\n\nAttached documents remain in Drive but lose their registry entry. This cannot be undone.`)) return
    setBulkDeleting(true)
    try {
      const results = await Promise.allSettled(ids.map(id => api.delete(`/artists/${id}`)))
      const failed = results.filter(r => r.status === 'rejected').length
      if (failed > 0) alert(`${failed} of ${ids.length} deletions failed.`)
      setSelectedIds(new Set())
      await load()
    } finally { setBulkDeleting(false) }
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
          {canEdit && selectedIds.size > 0 && (
            <button
              className="btn btn-danger"
              onClick={handleBulkDelete}
              disabled={bulkDeleting}
            >
              {bulkDeleting ? 'Deleting…' : `Delete ${selectedIds.size} Selected`}
            </button>
          )}
          {canEdit && <button className="btn btn-primary" onClick={openAdd}>+ Add Artist</button>}
        </div>
      </div>

      {loading ? <div>Loading…</div> : filtered.length === 0 ? (
        <div className="card" style={{ padding: 24, textAlign: 'center', color: 'rgba(255,255,255,0.6)' }}>
          No artists yet.{canEdit && ' Click "+ Add Artist" to start the registry.'}
        </div>
      ) : (() => {
        const visibleIds = filtered.map(a => a.id)
        const allChecked = visibleIds.length > 0 && visibleIds.every(id => selectedIds.has(id))
        const someChecked = !allChecked && visibleIds.some(id => selectedIds.has(id))
        return (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="data-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                {canEdit && (
                  <th style={{ width: 32 }}>
                    <input
                      type="checkbox"
                      checked={allChecked}
                      ref={el => { if (el) el.indeterminate = someChecked }}
                      onChange={() => toggleAllVisible(visibleIds, allChecked)}
                      title={allChecked ? 'Deselect all' : 'Select all'}
                      style={{cursor:'pointer'}}
                    />
                  </th>
                )}
                <th>Name</th>
                <th>Aliases</th>
                <th>Agency</th>
                <th>Contact</th>
                {canEdit && <th style={{ width: 120 }}></th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map(a => {
                const isSelected = selectedIds.has(a.id)
                return (
                <tr
                  key={a.id}
                  style={{ cursor: 'pointer', background: isSelected ? 'rgba(59,130,246,0.08)' : undefined }}
                  onClick={() => navigate(`/artists/${a.id}`)}
                >
                  {canEdit && (
                    <td style={{ width: 32 }} onClick={e => { e.stopPropagation(); toggleRow(a.id) }}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {}}
                        style={{cursor:'pointer'}}
                      />
                    </td>
                  )}
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
                )
              })}
            </tbody>
          </table>
        </div>
        )
      })()}

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
  const [shows, setShows]   = useState([])
  const [advancing, setAdvancing] = useState([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadMeta, setUploadMeta] = useState({ type: 'rider', year: '', notes: '', showId: '' })

  useEffect(() => { load() }, [id])
  async function load() {
    setLoading(true)
    try {
      const [aRes, dRes, sRes, advRes] = await Promise.all([
        api.get('/artists'),
        api.get(`/artists/${id}/documents`),
        api.get('/shows'),
        api.get('/advancing').catch(() => ({ data: { data: [] } })),
      ])
      setArtist((aRes.data.data || []).find(a => a.id === id) || null)
      setDocs(dRes.data.data || [])
      setShows(sRes.data.data || [])
      setAdvancing(advRes.data.data || [])
    } finally { setLoading(false) }
  }

  async function onUpload(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.size > 25 * 1024 * 1024) { alert('Max file size is 25MB.'); return }
    setUploading(true)
    try {
      const data = await fileToBase64(file)
      // If a show is selected, also stamp its date and auto-derive the year
      const linkedShow = artistShows.find(s => s.id === uploadMeta.showId)
      const showDate   = linkedShow?.date || ''
      const derivedYr  = uploadMeta.year || (showDate ? showDate.slice(0, 4) : '')
      await api.post(`/artists/${id}/documents`, {
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        data,
        type:     uploadMeta.type,
        year:     derivedYr,
        notes:    uploadMeta.notes,
        showId:   uploadMeta.showId || '',
        showDate,
      })
      setUploadMeta({ type: 'rider', year: '', notes: '', showId: uploadMeta.showId })
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

  // ── Derived: shows for this artist (matched by name, case-insensitive) ──
  const artistShows = useMemo(() => {
    if (!artist) return []
    const key = (artist.name || '').trim().toLowerCase()
    const aliases = (artist.aliases || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    const names = new Set([key, ...aliases])
    return shows
      .filter(s => {
        const n = (s.artist || s.eventName || '').trim().toLowerCase()
        return n && (names.has(n) || [...names].some(x => x && (n.includes(x) || x.includes(n))))
      })
      .sort((a, b) => (b.date || '').localeCompare(a.date || '')) // newest first
  }, [shows, artist])

  // Pre-select the most recent show in the upload form when shows load
  useEffect(() => {
    if (!uploadMeta.showId && artistShows.length > 0) {
      // Prefer an upcoming show if any, otherwise the most recent past one
      const todayStr = new Date().toISOString().slice(0, 10)
      const upcoming = [...artistShows].reverse().find(s => (s.date || '') >= todayStr)
      setUploadMeta(m => ({ ...m, showId: (upcoming || artistShows[0])?.id || '' }))
    }
  }, [artistShows]) // eslint-disable-line

  if (loading) return <div>Loading…</div>
  if (!artist) return (
    <div>
      <Link to="/artists" className="btn btn-ghost btn-sm">‹ Artists</Link>
      <p>Artist not found.</p>
    </div>
  )

  // Index docs by showId; collect "unscoped" (library) docs separately
  const docsByShow = new Map()
  const unscopedDocs = []
  for (const d of docs) {
    if (d.showId) {
      if (!docsByShow.has(d.showId)) docsByShow.set(d.showId, [])
      docsByShow.get(d.showId).push(d)
    } else {
      unscopedDocs.push(d)
    }
  }
  // Newest docs first within each show
  for (const arr of docsByShow.values()) {
    arr.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  }
  unscopedDocs.sort((a, b) =>
    (b.year || '').localeCompare(a.year || '') || (b.createdAt || '').localeCompare(a.createdAt || '')
  )

  // Group unscoped library docs by type
  const libraryByType = unscopedDocs.reduce((acc, d) => {
    const k = d.type || 'other'
    if (!acc[k]) acc[k] = []
    acc[k].push(d)
    return acc
  }, {})

  const advanceByShow = new Map(advancing.map(a => [a.showId, a]))
  const todayStr = new Date().toISOString().slice(0, 10)

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
          <div style={{ marginTop: 6, fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
            {artistShows.length} show{artistShows.length === 1 ? '' : 's'} on record · {docs.length} document{docs.length === 1 ? '' : 's'}
          </div>
        </div>
        {artist.driveFolderId && (
          <a className="btn btn-ghost btn-sm" target="_blank" rel="noreferrer"
             href={`https://drive.google.com/drive/folders/${artist.driveFolderId}`}>📁 Open Drive folder</a>
        )}
      </div>

      {artist.notes && (
        <div className="card" style={{ padding: 16, marginBottom: 20, whiteSpace: 'pre-wrap' }}>{artist.notes}</div>
      )}

      {/* Production defaults — single source of truth for rider/needs/contact */}
      <ArtistDefaults artist={artist} canEdit={canEdit} onSaved={load} />

      {/* Patch list templates saved for this artist */}
      <ArtistPatchTemplates artist={artist} canEdit={canEdit} />

      {/* Upload (PM+) */}
      {canEdit && (
        <div className="card" style={{ padding: 16, marginBottom: 20 }}>
          <h3 style={{ marginTop: 0 }}>Add a document</h3>
          <div className="form-row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label>Type
              <select value={uploadMeta.type} onChange={e => setUploadMeta(m => ({ ...m, type: e.target.value }))}>
                {DOC_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
            <label>Attach to show
              <select value={uploadMeta.showId} onChange={e => setUploadMeta(m => ({ ...m, showId: e.target.value }))}>
                <option value="">— Reusable library (no show) —</option>
                {artistShows.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.date}{s.stage ? ` · ${s.stage}` : ''}{s.status ? ` · ${s.status}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>Year
              <input type="number" min="1980" max="2100" value={uploadMeta.year} placeholder="auto"
                onChange={e => setUploadMeta(m => ({ ...m, year: e.target.value }))} style={{ width: 90 }} />
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
            Tip: link a document to a specific show to file it under that performance's history. Skip the show to keep it as a reusable template (e.g. a stage plot that doesn't change).
          </div>
        </div>
      )}

      {/* ── Reusable library ─────────────────────────────────────────── */}
      {unscopedDocs.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 16, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'rgba(255,255,255,0.7)' }}>
            📚 Reusable Library
          </h2>
          {Object.entries(libraryByType).map(([type, list]) => (
            <DocTable key={type} title={DOC_TYPE_LABEL[type] || type} docs={list} canEdit={canEdit} onDelete={removeDoc} />
          ))}
        </div>
      )}

      {/* ── Show history (chronological, newest first) ─────────────── */}
      <div>
        <h2 style={{ fontSize: 16, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'rgba(255,255,255,0.7)' }}>
          🗓️ Show History
        </h2>
        {artistShows.length === 0 ? (
          <div className="card" style={{ padding: 24, textAlign: 'center', color: 'rgba(255,255,255,0.6)' }}>
            No shows on record for {artist.name} yet.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {artistShows.map(s => {
              const sdocs = docsByShow.get(s.id) || []
              const adv   = advanceByShow.get(s.id)
              const isFuture = (s.date || '') >= todayStr
              const stage = (s.stage || 'inside').toLowerCase()
              const stageColor = stage === 'beach' ? '#10b981' : '#3b82f6'
              return (
                <div key={s.id} className="card" style={{ padding: 16, borderLeft: `3px solid ${stageColor}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
                    <div>
                      <div style={{ fontSize: 16, fontWeight: 600 }}>
                        {formatLongDate(s.date)}
                        {isFuture && <span style={{ marginLeft: 8, fontSize: 11, padding: '2px 6px', borderRadius: 3, background: 'rgba(59,130,246,0.2)', color: '#93c5fd' }}>UPCOMING</span>}
                      </div>
                      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', marginTop: 2 }}>
                        <span className={`badge badge-${stage}`}>{stage === 'inside' ? 'Inside Stage' : 'Beach Stage'}</span>
                        <span className={`badge badge-${s.status || 'pending'}`} style={{ marginLeft: 6 }}>{s.status || 'pending'}</span>
                        {s.eventName && s.eventName !== s.artist && <span style={{ marginLeft: 8 }}>· {s.eventName}</span>}
                      </div>
                    </div>
                    <Link to={`/shows/${s.id}`} className="btn btn-ghost btn-sm">Open show →</Link>
                  </div>

                  {/* Quick advance summary */}
                  {adv && (
                    <div style={{ marginTop: 10, fontSize: 13, color: 'rgba(255,255,255,0.75)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      {adv.advancingComplete === 'true' && <span style={{ color: '#10b981' }}>✓ Advance complete</span>}
                      {adv.curfew && <span>Curfew: <strong>{adv.curfew}</strong></span>}
                      {adv.advanceContact && <span>TM: {adv.advanceContact}</span>}
                    </div>
                  )}

                  {/* Documents attached to this show */}
                  {sdocs.length === 0 ? (
                    <div style={{ marginTop: 12, fontSize: 12, color: 'rgba(255,255,255,0.4)', fontStyle: 'italic' }}>
                      No documents attached to this show.{canEdit && ' Use the upload form above and pick this show.'}
                    </div>
                  ) : (
                    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {sdocs.map(d => (
                        <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'rgba(255,255,255,0.03)', borderRadius: 4 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 3, background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.7)', marginRight: 8 }}>
                              {DOC_TYPE_LABEL[d.type] || d.type}
                            </span>
                            <strong style={{ fontSize: 13 }}>📄 {d.name}</strong>
                            {d.notes && <span style={{ marginLeft: 8, fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>· {d.notes}</span>}
                          </div>
                          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>{d.uploadedBy}</span>
                            <a className="btn btn-ghost btn-sm" target="_blank" rel="noreferrer" href={d.webViewLink}>Open</a>
                            {canEdit && <button className="btn btn-danger btn-sm" onClick={() => removeDoc(d)}>✕</button>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function DocTable({ title, docs, canEdit, onDelete }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <h3 style={{ marginBottom: 6, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'rgba(255,255,255,0.5)' }}>
        {title} <span style={{ opacity: 0.6, fontWeight: 400 }}>({docs.length})</span>
      </h3>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="data-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>File</th>
              <th style={{ width: 70 }}>Year</th>
              <th>Notes</th>
              <th style={{ width: 140 }}>Uploaded</th>
              <th style={{ width: 150 }}></th>
            </tr>
          </thead>
          <tbody>
            {docs.map(d => (
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
                  {canEdit && <button className="btn btn-danger btn-sm" onClick={() => onDelete(d)}>Del</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Artist Production Defaults ────────────────────────────────────────────
// Editable card on the artist detail page. These values become the fallback
// for every show featuring this artist; per-show Advancing rows can override
// any field for a one-off, but the artist row is the source of truth.
const DEFAULT_FIELDS = [
  { key: 'advanceContact',   label: 'Advance Contact',  type: 'text' },
  { key: 'advanceEmail',     label: 'Advance Email',    type: 'email' },
  { key: 'advancePhone',     label: 'Advance Phone',    type: 'text' },
  { key: 'riderNotes',       label: 'Rider Notes',      type: 'textarea' },
  { key: 'productionNeeds',  label: 'Production Needs', type: 'textarea' },
  { key: 'backlineNotes',    label: 'Backline',         type: 'textarea' },
  { key: 'hospitalityNotes', label: 'Hospitality',      type: 'textarea' },
  { key: 'cateringNotes',    label: 'Catering',         type: 'textarea' },
]

function ArtistDefaults({ artist, canEdit, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [form, setForm]       = useState(() => Object.fromEntries(DEFAULT_FIELDS.map(f => [f.key, artist[f.key] || ''])))
  const [saving, setSaving]   = useState(false)

  useEffect(() => {
    setForm(Object.fromEntries(DEFAULT_FIELDS.map(f => [f.key, artist[f.key] || ''])))
  }, [artist.id]) // eslint-disable-line

  const filled = DEFAULT_FIELDS.filter(f => (artist[f.key] || '').trim())

  async function save() {
    setSaving(true)
    try {
      await api.put(`/artists/${artist.id}`, form)
      setEditing(false)
      await onSaved?.()
    } catch (err) {
      alert('Save failed: ' + (err.response?.data?.message || err.message))
    } finally { setSaving(false) }
  }

  return (
    <div className="card" style={{ padding: 16, marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>
          🎛️ Production Defaults
          <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: 'rgba(255,255,255,0.5)' }}>
            Fallback for every show — per-show Advancing rows can override.
          </span>
        </h3>
        {canEdit && !editing && (
          <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>✎ Edit defaults</button>
        )}
      </div>

      {!editing ? (
        filled.length === 0 ? (
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', fontStyle: 'italic' }}>
            No defaults set. {canEdit && 'Click "Edit defaults" to add rider, production needs, and contact info that every show will inherit.'}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
            {filled.map(f => (
              <div key={f.key}>
                <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'rgba(255,255,255,0.5)', marginBottom: 3 }}>{f.label}</div>
                <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{artist[f.key]}</div>
              </div>
            ))}
          </div>
        )
      ) : (
        <div className="form-grid">
          {DEFAULT_FIELDS.map(f => (
            <label key={f.key}>{f.label}
              {f.type === 'textarea'
                ? <textarea rows={2} value={form[f.key]} onChange={e => setForm(s => ({ ...s, [f.key]: e.target.value }))} />
                : <input type={f.type} value={form[f.key]} onChange={e => setForm(s => ({ ...s, [f.key]: e.target.value }))} />
              }
            </label>
          ))}
          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={() => { setEditing(false); setForm(Object.fromEntries(DEFAULT_FIELDS.map(f => [f.key, artist[f.key] || '']))) }} disabled={saving}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save defaults'}</button>
          </div>
        </div>
      )}
    </div>
  )
}

function formatLongDate(ymd) {
  if (!ymd) return 'No date'
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd)
  if (!m) return ymd
  const d = new Date(+m[1], +m[2] - 1, +m[3])
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' })
}

// ═══════════════════════════════════════════════════════════════════════════
// ArtistPatchTemplates — lists patch-list templates saved for this artist
// and lets admins delete stale ones. New templates are created from the
// Patch List tab on a show (via "💾 Save as artist template").
// ═══════════════════════════════════════════════════════════════════════════
function ArtistPatchTemplates({ artist, canEdit }) {
  const [rows,    setRows]    = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  async function load() {
    setLoading(true); setError('')
    try {
      const res = await api.get('/patch-lists')
      const all = res.data.data || []
      const mine = all.filter(r =>
        r.isTemplate === 'true' &&
        (r.artistId === artist.id ||
          (artist.name && (r.artistName || '').toLowerCase() === (artist.name || '').toLowerCase()))
      )
      setRows(mine)
    } catch (err) {
      setError(err?.response?.data?.error || err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [artist.id]) // eslint-disable-line

  async function remove(t) {
    if (!confirm(`Delete template "${t.name}"?\n\nThis cannot be undone.`)) return
    try {
      await api.delete(`/patch-lists/${t.id}`)
      setRows(prev => prev.filter(x => x.id !== t.id))
    } catch (err) {
      alert('Delete failed: ' + (err?.response?.data?.error || err.message))
    }
  }

  function summarize(t) {
    const inputs  = parseCount(t.inputs)
    const outputs = parseCount(t.outputs)
    const inCols  = parseCount(t.inputPatchPoints)
    const outCols = parseCount(t.outputPatchPoints)
    const bits = []
    if (inputs)  bits.push(`${inputs} in`)
    if (outputs) bits.push(`${outputs} out`)
    if (inCols + outCols) bits.push(`${inCols + outCols} patch pt${inCols + outCols === 1 ? '' : 's'}`)
    return bits.join(' · ') || 'empty'
  }

  return (
    <div className="card" style={{ padding: 16, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>🔌 Patch list templates</h3>
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
          Reusable patch configurations for {artist.name}
        </span>
      </div>

      {loading && <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13 }}>Loading…</div>}

      {!loading && error && (
        <div style={{ color: '#fca5a5', fontSize: 13 }}>Couldn't load templates: {error}</div>
      )}

      {!loading && !error && rows.length === 0 && (
        <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: 13, fontStyle: 'italic' }}>
          No templates saved yet. From any show for {artist.name}, open the Patch List tab and click
          <strong> 💾 Save as artist template</strong> to build a starting point for future shows.
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Summary</th>
                <th>Saved</th>
                {canEdit && <th style={{ width: 40 }}></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(t => (
                <tr key={t.id}>
                  <td>{t.name || '(untitled)'}</td>
                  <td style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>{summarize(t)}</td>
                  <td style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12 }}>
                    {t.createdAt ? new Date(t.createdAt).toLocaleDateString() : '—'}
                  </td>
                  {canEdit && (
                    <td>
                      <button
                        className="btn btn-ghost btn-sm"
                        title="Delete template"
                        onClick={() => remove(t)}
                      >🗑</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function parseCount(raw) {
  if (Array.isArray(raw)) return raw.length
  if (!raw) return 0
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.length : 0 } catch { return 0 }
}
