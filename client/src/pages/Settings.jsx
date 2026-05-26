import { useState } from 'react'
import api from '../api'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import GmailConnect from '../components/GmailConnect'

const NAV_PATHS = [
  { label: 'Dashboard',    path: '/dashboard' },
  { label: 'Shows',        path: '/shows' },
  { label: 'Advancing',    path: '/advancing' },
  { label: 'Day of Show',  path: '/day-of-show' },
  { label: 'Vendors',      path: '/vendors' },
  { label: 'Staff',        path: '/staff' },
  { label: 'Tech Pack',    path: '/tech-pack' },
  { label: 'Email',        path: '/email' },
]

export default function Settings() {
  const { user } = useAuth()
  const { settings, update, reset } = useSettings()

  // ── Change password state ────────────────────────────────────────────────
  const [pwCurrent,  setPwCurrent]  = useState('')
  const [pwNew,      setPwNew]      = useState('')
  const [pwConfirm,  setPwConfirm]  = useState('')
  const [pwBusy,     setPwBusy]     = useState(false)
  const [pwMsg,      setPwMsg]      = useState(null) // { kind, text }

  async function submitPassword(e) {
    e.preventDefault()
    setPwMsg(null)
    if (pwNew !== pwConfirm)  return setPwMsg({ kind: 'err', text: 'New password and confirmation do not match.' })
    if (pwNew.length < 8)     return setPwMsg({ kind: 'err', text: 'New password must be at least 8 characters.' })
    setPwBusy(true)
    try {
      await api.post('/auth/change-password', { currentPassword: pwCurrent, newPassword: pwNew })
      setPwMsg({ kind: 'ok', text: 'Password updated.' })
      setPwCurrent(''); setPwNew(''); setPwConfirm('')
    } catch (err) {
      setPwMsg({ kind: 'err', text: err.response?.data?.message || 'Failed to update password.' })
    } finally {
      setPwBusy(false)
    }
  }

  // ── Display name state ───────────────────────────────────────────────────
  const [displayName, setDisplayName] = useState(user?.name || '')
  const [nameBusy,    setNameBusy]    = useState(false)
  const [nameMsg,     setNameMsg]     = useState(null)

  async function submitName(e) {
    e.preventDefault()
    setNameMsg(null)
    if (!displayName.trim()) return setNameMsg({ kind: 'err', text: 'Name cannot be empty.' })
    setNameBusy(true)
    try {
      await api.patch('/auth/profile', { name: displayName.trim() })
      const stored = JSON.parse(localStorage.getItem('wj_user') || '{}')
      localStorage.setItem('wj_user', JSON.stringify({ ...stored, name: displayName.trim() }))
      setNameMsg({ kind: 'ok', text: 'Saved. Refresh to see the new name in the header.' })
    } catch (err) {
      setNameMsg({ kind: 'err', text: err.response?.data?.message || 'Failed to update name.' })
    } finally {
      setNameBusy(false)
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Settings</div>
          <div className="page-subtitle">Preferences for your account and this browser.</div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={reset}>Reset UI defaults</button>
      </div>

      {/* ── Appearance ──────────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-header"><div className="card-title">Appearance</div></div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
          <Field label="Theme" hint="Switch between dark and light modes.">
            <SegBtn options={[{ v: 'dark', l: '🌙 Dark' }, { v: 'light', l: '☀️ Light' }]}
                    value={settings.theme} onChange={v => update({ theme: v })} />
          </Field>

          <Field label="Menu position" hint="Move the navigation to the side or across the top.">
            <SegBtn options={[{ v: 'side', l: '⬅ Side' }, { v: 'top', l: '⬆ Top' }]}
                    value={settings.menuPos} onChange={v => update({ menuPos: v })} />
          </Field>

          <Field label="Density" hint="Tighter spacing fits more on screen.">
            <SegBtn options={[{ v: 'comfortable', l: 'Comfortable' }, { v: 'compact', l: 'Compact' }]}
                    value={settings.density} onChange={v => update({ density: v })} />
          </Field>

          <Field label="Default landing page" hint="Where you land right after login.">
            <select className="input" value={settings.landing} onChange={e => update({ landing: e.target.value })}>
              {NAV_PATHS.map(n => <option key={n.path} value={n.path}>{n.label}</option>)}
            </select>
          </Field>

          <Field label="Time format" hint="How call times, doors, show times, etc. are displayed and printed.">
            <SegBtn options={[{ v: '12h', l: '12-hour (1:30 PM)' }, { v: '24h', l: '24-hour (13:30)' }]}
                    value={settings.timeFormat} onChange={v => update({ timeFormat: v })} />
          </Field>
        </div>
      </div>

      {/* ── Connected Accounts ──────────────────────────────────────────── */}
      <div className="card">
        <div className="card-header"><div className="card-title">Connected accounts</div></div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
          Link your personal Gmail so messages sent to you can be pulled into shows. Only you can see your messages
          unless an admin promotes your account to the shared "house" mailbox.
        </div>
        <GmailConnect />
      </div>

      {/* ── Profile ────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-header"><div className="card-title">Profile</div></div>
        <form onSubmit={submitName} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Field label="Display name" style={{ flex: 1, minWidth: 220 }}>
            <input className="input" value={displayName} onChange={e => setDisplayName(e.target.value)} />
          </Field>
          <button className="btn btn-primary" disabled={nameBusy}>{nameBusy ? 'Saving…' : 'Save'}</button>
        </form>
        {nameMsg && <InlineMsg msg={nameMsg} />}
        <div style={{ marginTop: 14, fontSize: 12, color: 'var(--text-muted)' }}>
          Email: <code>{user?.email}</code> &nbsp;·&nbsp; Role: <code style={{ textTransform: 'capitalize' }}>{user?.role?.replace('_', ' ')}</code>
        </div>
      </div>

      {/* ── Change password ────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-header"><div className="card-title">Change password</div></div>
        <form onSubmit={submitPassword} style={{ display: 'grid', gap: 10, maxWidth: 420 }}>
          <Field label="Current password">
            <input className="input" type="password" autoComplete="current-password"
                   value={pwCurrent} onChange={e => setPwCurrent(e.target.value)} required />
          </Field>
          <Field label="New password" hint="At least 8 characters.">
            <input className="input" type="password" autoComplete="new-password"
                   value={pwNew} onChange={e => setPwNew(e.target.value)} required />
          </Field>
          <Field label="Confirm new password">
            <input className="input" type="password" autoComplete="new-password"
                   value={pwConfirm} onChange={e => setPwConfirm(e.target.value)} required />
          </Field>
          <div>
            <button className="btn btn-primary" disabled={pwBusy}>{pwBusy ? 'Updating…' : 'Update password'}</button>
          </div>
        </form>
        {pwMsg && <InlineMsg msg={pwMsg} />}
      </div>
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────
function Field({ label, hint, children, style }) {
  return (
    <div style={style}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 5 }}>{label}</label>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{hint}</div>}
    </div>
  )
}

function SegBtn({ options, value, onChange }) {
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden' }}>
      {options.map(o => {
        const active = o.v === value
        return (
          <button key={o.v} type="button" onClick={() => onChange(o.v)}
                  style={{
                    background: active ? 'rgba(59,130,246,0.18)' : 'transparent',
                    color: active ? 'var(--accent)' : 'var(--text-muted)',
                    border: 'none', padding: '7px 14px', fontSize: 13,
                    cursor: 'pointer', fontWeight: active ? 600 : 500,
                  }}>
            {o.l}
          </button>
        )
      })}
    </div>
  )
}

function InlineMsg({ msg }) {
  const ok = msg.kind === 'ok'
  return (
    <div style={{
      marginTop: 10, fontSize: 12,
      padding: '7px 10px', borderRadius: 6,
      background: ok ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
      color: ok ? '#4ade80' : '#fca5a5',
      border: `1px solid ${ok ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)'}`,
    }}>{msg.text}</div>
  )
}
