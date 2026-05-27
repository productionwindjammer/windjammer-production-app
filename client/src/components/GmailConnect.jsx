import { useEffect, useState } from 'react'
import api from '../api'

/**
 * Self-service Gmail connect widget.
 * Shows the current user's connection status and a Connect/Disconnect button.
 * Opens Google's consent screen in a popup; refreshes status on close.
 */
export default function GmailConnect({ onChange }) {
  const [status, setStatus] = useState(null)
  const [busy, setBusy]     = useState(false)

  async function refresh() {
    try {
      const res = await api.get('/gmail/me')
      setStatus(res.data)
      onChange?.(res.data)
    } catch (err) {
      setStatus({ success: false, message: err.response?.data?.message || err.message })
    }
  }

  useEffect(() => { refresh() }, [])

  async function handleConnect() {
    setBusy(true)
    try {
      const res = await api.get('/gmail/auth-url')
      const popup = window.open(res.data.url, 'gmail-oauth', 'width=520,height=720')
      if (!popup) {
        alert('Popup blocked. Allow popups for this site and try again.')
        return
      }
      // Poll for popup close, then refresh status
      const timer = setInterval(async () => {
        if (popup.closed) {
          clearInterval(timer)
          await refresh()
          setBusy(false)
        }
      }, 600)
    } catch (err) {
      alert('Could not start Gmail connect: ' + (err.response?.data?.message || err.message))
      setBusy(false)
    }
  }

  async function handleDisconnect() {
    if (!confirm('Disconnect your Gmail from Windjammer? Synced messages will remain in the system.')) return
    setBusy(true)
    try {
      await api.post('/gmail/disconnect')
      await refresh()
    } catch (err) {
      alert('Disconnect failed: ' + (err.response?.data?.message || err.message))
    } finally { setBusy(false) }
  }

  if (!status) return null

  if (status.configured === false) {
    return (
      <div className="card" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', padding: 12, color: '#fca5a5' }}>
        Gmail OAuth client credentials are not configured on the server. Ask an admin to set <code>GMAIL_CLIENT_ID</code> / <code>GMAIL_CLIENT_SECRET</code>.
      </div>
    )
  }

  if (status.connected) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="card" style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.3)', padding: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ color: '#86efac', fontWeight: 600 }}>
              ✅ Gmail connected
              {status.isHouseMailbox && (
                <span style={{ marginLeft: 8, fontSize: 11, padding: '2px 8px', borderRadius: 10, background: 'rgba(167,139,250,0.2)', color: '#c4b5fd' }}>
                  🏠 House mailbox
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', marginTop: 3 }}>
              {status.gmailEmail}
              {status.connectedAt ? ` · since ${status.connectedAt.slice(0, 10)}` : ''}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={handleDisconnect} disabled={busy}>
            Disconnect
          </button>
        </div>
        <LabelMappings />
      </div>
    )
  }

  return (
    <div className="card" style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.3)', padding: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ color: '#93c5fd', fontWeight: 600 }}>Connect your Gmail</div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', marginTop: 3 }}>
          Emails sent to your address about Windjammer shows will be synced into the system. Only you (and admins) will see them unless an admin marks your account as the house mailbox.
        </div>
      </div>
      <button className="btn btn-primary btn-sm" onClick={handleConnect} disabled={busy}>
        {busy ? 'Opening…' : '🔗 Connect Gmail'}
      </button>
    </div>
  )
}

// ── Linked labels manager ────────────────────────────────────────────────────
// Map a Gmail label to a show so any email carrying that label is (a) included
// in the sync (even if it lives outside the inbox) and (b) auto-linked to the
// show. Useful for filtering tour-specific emails into a folder in Gmail.
function LabelMappings() {
  const [labels, setLabels]     = useState([])
  const [shows, setShows]       = useState([])
  const [mappings, setMappings] = useState([])
  const [labelId, setLabelId]   = useState('')
  const [showId, setShowId]     = useState('')
  const [showPast, setShowPast] = useState(false)
  const [loading, setLoading]   = useState(true)
  const [adding, setAdding]     = useState(false)
  const [err, setErr]           = useState('')

  async function loadAll() {
    setLoading(true)
    setErr('')
    try {
      const [lr, mr, sr] = await Promise.all([
        api.get('/gmail/labels').catch(e => ({ data: { labels: [], message: e.response?.data?.message || e.message } })),
        api.get('/gmail/label-mappings'),
        api.get('/shows'),
      ])
      setLabels(lr.data.labels || [])
      if (lr.data.message) setErr(lr.data.message)
      setMappings(mr.data.mappings || [])
      const showRows = sr.data?.data ?? sr.data?.shows ?? (Array.isArray(sr.data) ? sr.data : [])
      setShows(Array.isArray(showRows) ? showRows : [])
    } catch (e) {
      setErr(e.response?.data?.message || e.message)
    } finally { setLoading(false) }
  }
  useEffect(() => { loadAll() }, [])

  async function handleAdd() {
    if (!labelId || !showId) return
    const label = labels.find(l => l.id === labelId)
    setAdding(true)
    try {
      await api.post('/gmail/label-mappings', { labelId, labelName: label?.name || labelId, showId })
      setLabelId(''); setShowId('')
      await loadAll()
    } catch (e) {
      alert('Could not add mapping: ' + (e.response?.data?.message || e.message))
    } finally { setAdding(false) }
  }

  async function handleDelete(id) {
    if (!confirm('Remove this label → show link? Already-synced emails stay put.')) return
    try {
      await api.delete(`/gmail/label-mappings/${id}`)
      await loadAll()
    } catch (e) {
      alert('Could not remove: ' + (e.response?.data?.message || e.message))
    }
  }

  const todayStr = new Date().toISOString().slice(0, 10)
  const showOptions = [...shows]
    .filter(s => showPast || !s.date || s.date >= todayStr)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
  // Filter out labels already mapped (so we don't suggest dupes)
  const mappedLabelIds = new Set(mappings.map(m => m.labelId))
  const availableLabels = labels.filter(l => !mappedLabelIds.has(l.id))

  return (
    <div className="card" style={{ padding: 12, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>🏷️ Linked labels</div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>
            Map a Gmail label to a show — every email with that label syncs into the app and auto-links to the show.
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={loadAll} disabled={loading}>
          {loading ? '…' : '↻'}
        </button>
      </div>

      {err && (
        <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5', padding: 8, borderRadius: 6, fontSize: 12, marginBottom: 8 }}>
          {err}
        </div>
      )}

      {mappings.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
          {mappings.map(m => (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', background: 'rgba(255,255,255,0.04)', borderRadius: 4, fontSize: 13 }}>
              <span style={{ background: 'rgba(99,102,241,0.18)', color: '#c7d2fe', padding: '2px 8px', borderRadius: 10, fontSize: 11 }}>
                🏷️ {m.labelName}
              </span>
              <span style={{ color: 'rgba(255,255,255,0.4)' }}>→</span>
              <span style={{ flex: 1, color: 'rgba(255,255,255,0.85)' }}>{m.showName}</span>
              <button className="btn btn-ghost btn-sm" onClick={() => handleDelete(m.id)} title="Remove">✕</button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={labelId} onChange={e => setLabelId(e.target.value)} style={{ flex: '1 1 160px', minWidth: 140, padding: '5px 7px', fontSize: 13 }} disabled={loading || availableLabels.length === 0}>
          <option value="">{loading ? 'Loading labels…' : availableLabels.length === 0 ? 'No more labels' : '-- pick a Gmail label --'}</option>
          {availableLabels.map(l => (
            <option key={l.id} value={l.id}>{l.type === 'system' ? '📥 ' : '🏷️ '}{l.name}</option>
          ))}
        </select>
        <select value={showId} onChange={e => setShowId(e.target.value)} style={{ flex: '1 1 200px', minWidth: 160, padding: '5px 7px', fontSize: 13 }}>
          <option value="">-- pick a show --</option>
          {showOptions.map(s => (
            <option key={s.id} value={s.id}>{(s.date || '') + ' — ' + (s.artist || s.eventName || s.id)}</option>
          ))}
        </select>
        <label style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={showPast} onChange={e => setShowPast(e.target.checked)} style={{ width: 13, height: 13, accentColor: '#3b82f6' }} />
          past
        </label>
        <button className="btn btn-primary btn-sm" onClick={handleAdd} disabled={!labelId || !showId || adding}>
          {adding ? 'Linking…' : 'Link'}
        </button>
      </div>
    </div>
  )
}
