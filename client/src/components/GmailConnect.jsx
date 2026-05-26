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
