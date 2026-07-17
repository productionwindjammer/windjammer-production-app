import { useState, useEffect } from 'react'
import api from '../api'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import VenueDefaultsCard from '../components/VenueDefaultsCard'
import {
  isPushSupported,
  notificationPermission,
  getCurrentSubscription,
  enablePush,
  disablePush,
  sendTestPush,
} from '../api/push'

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

          <Field label="Layout" hint="Force the phone-style layout on this browser, or let it follow the viewport width. Choice is remembered per device — desktop on your laptop, mobile on your phone.">
            <SegBtn
              options={[
                { v: 'auto', l: '🖥 Auto' },
                { v: 'on',   l: '📱 Mobile' },
                { v: 'off',  l: '💻 Desktop' },
              ]}
              value={settings.mobileMode}
              onChange={v => update({ mobileMode: v })}
            />
          </Field>
        </div>
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

      {/* ── Notifications ────────────────────────────────────────────── */}
      <NotificationsCard />

      {/* ── Admin tools ─────────────────────────────────────────────── */}
      {(user?.role === 'admin' || user?.role === 'production_manager') && <VenueDefaultsCard />}
      {user?.role === 'admin' && <AdminToolsCard />}

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

// ── Notifications card ───────────────────────────────────────────────────────
// Per-event push prefs + browser permission/subscription toggle.
const EVENTS = [
  { key: 'showUpdates',   label: 'New shows added',         hint: 'When a show is created or a key field is updated.' },
  { key: 'docUploads',    label: 'Documents uploaded',      hint: 'Riders, stage plots, input lists, etc.' },
  { key: 'shiftAssigned', label: 'My shifts',                hint: 'When a shift is created with you on it.' },
  { key: 'emailReceived', label: 'New advance emails',       hint: 'When new email arrives in a show inbox.' },
  { key: 'dayOfShow',     label: 'Day-of-show reminders',    hint: 'A heads-up before doors / call times.' },
]

function NotificationsCard() {
  const supported = isPushSupported()
  const [perm, setPerm] = useState(supported ? notificationPermission() : 'unsupported')
  const [subscribed, setSubscribed] = useState(false)
  const [prefs, setPrefs] = useState({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (supported) {
        const sub = await getCurrentSubscription().catch(() => null)
        if (!cancelled) setSubscribed(!!sub)
      }
      try {
        const { data } = await api.get('/me/notification-prefs')
        if (!cancelled) setPrefs(data?.prefs || {})
      } catch {}
    })()
    return () => { cancelled = true }
  }, [supported])

  async function enable() {
    setBusy(true); setMsg(null)
    try {
      await enablePush()
      setPerm(notificationPermission())
      setSubscribed(true)
      setMsg({ kind: 'ok', text: 'Notifications enabled on this device.' })
    } catch (err) {
      setMsg({ kind: 'err', text: err.message || 'Failed to enable notifications.' })
    } finally { setBusy(false) }
  }

  async function disable() {
    setBusy(true); setMsg(null)
    try {
      await disablePush()
      setSubscribed(false)
      setMsg({ kind: 'ok', text: 'Notifications disabled on this device.' })
    } catch (err) {
      setMsg({ kind: 'err', text: err.message || 'Failed to disable.' })
    } finally { setBusy(false) }
  }

  async function test() {
    setBusy(true); setMsg(null)
    try {
      const { data } = await sendTestPush()
      if (data?.sent) {
        setMsg({ kind: 'ok', text: `Test sent to ${data.sent} device${data.sent === 1 ? '' : 's'} — check for the banner.` })
      } else {
        const reason = data?.message ||
          (data?.skipped === 'no-vapid' ? 'Server has no VAPID keys configured.' :
           data?.skipped === 'no-subs' ? 'This account has no subscribed devices on the server yet — click “Enable on this device” first.' :
           data?.skipped === 'pref-off' ? 'Notifications are turned off for this event type.' :
           'Server reported 0 devices reached.')
        setMsg({ kind: 'err', text: reason })
      }
    } catch (err) {
      setMsg({ kind: 'err', text: err.response?.data?.message || err.message })
    } finally { setBusy(false) }
  }

  async function togglePref(key, value) {
    const next = { ...prefs, [key]: value }
    setPrefs(next)
    try { await api.put('/me/notification-prefs', next) }
    catch (err) { setMsg({ kind: 'err', text: 'Failed to save preference: ' + (err.response?.data?.message || err.message) }) }
  }

  return (
    <div className="card">
      <div className="card-header"><div className="card-title">Notifications</div></div>

      {!supported && (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          This browser does not support push notifications. Try Chrome, Edge, or Firefox on desktop, or install the app to your home screen on iOS 16.4+ / Android.
        </div>
      )}

      {supported && (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
            Notifications work on desktop (Chrome/Edge/Firefox/Safari) and on mobile when the app is installed to your home screen.
            Click <strong>Enable on this device</strong> on every device where you want to receive alerts.
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              This device: <strong style={{ color: subscribed ? 'var(--success)' : 'var(--text-muted)' }}>
                {subscribed ? 'Enabled' : 'Disabled'}
              </strong>
              {perm === 'denied' && (
                <span style={{ color: 'var(--danger)', marginLeft: 8 }}>
                  (browser permission is blocked — re-enable in browser site settings)
                </span>
              )}
            </span>
            {!subscribed && (
              <button className="btn btn-primary btn-sm" onClick={enable} disabled={busy || perm === 'denied'}>
                {busy ? 'Working…' : 'Enable on this device'}
              </button>
            )}
            {subscribed && (
              <>
                <button className="btn btn-ghost btn-sm" onClick={disable} disabled={busy}>
                  Disable on this device
                </button>
                <button className="btn btn-ghost btn-sm" onClick={test} disabled={busy}>
                  Send test
                </button>
              </>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            {EVENTS.map(ev => {
              const on = prefs[ev.key] !== false
              return (
                <Field key={ev.key} label={ev.label} hint={ev.hint}>
                  <SegBtn
                    options={[{ v: 'on', l: '🔔 On' }, { v: 'off', l: '🔕 Off' }]}
                    value={on ? 'on' : 'off'}
                    onChange={v => togglePref(ev.key, v === 'on')}
                  />
                </Field>
              )
            })}
          </div>

          {msg && <InlineMsg msg={msg} />}
        </>
      )}
    </div>
  )
}

// -- Admin Tools (admin only) ------------------------------------------------
function AdminToolsCard() {
  const [migrating, setMigrating] = useState(false)
  const [result, setResult]       = useState(null)
  const [error, setError]         = useState(null)

  async function migrate() {
    if (!confirm("Move every show folder's attachments into the matched artist folder? This relocates files in Google Drive and records each one in the artist library. Existing artist documents are not duplicated.")) return
    setMigrating(true); setResult(null); setError(null)
    try {
      const r = await api.post('/admin/migrate-all-show-attachments')
      setResult(r.data)
    } catch (err) {
      setError(err.response?.data?.message || err.message)
    } finally { setMigrating(false) }
  }

  return (
    <div className="card">
      <div className="card-header"><div className="card-title">Admin tools</div></div>
      <div style={{ display: 'grid', gap: 14 }}>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Migrate show attachments to artist folders</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
            One-time backfill: walks every show with a Drive folder, finds the matching artist, and moves files
            (riders, plots, input lists, etc.) into that artist's permanent folder so future shows inherit them.
          </div>
          <button className="btn btn-primary btn-sm" onClick={migrate} disabled={migrating}>
            {migrating ? 'Migrating...' : 'Run migration'}
          </button>
          {result && (
            <div style={{ marginTop: 10, fontSize: 12 }}>
              <div style={{ color: 'var(--success)' }}>
                Migrated {result.files || 0} file(s) across {result.migrated || 0} show(s).
              </div>
              {result.skipped?.length > 0 && (
                <details style={{ marginTop: 6 }}>
                  <summary style={{ cursor: 'pointer', color: 'var(--text-muted)' }}>
                    {result.skipped.length} show(s) skipped
                  </summary>
                  <ul style={{ margin: '6px 0 0 18px', color: 'var(--text-muted)' }}>
                    {result.skipped.map((s, i) => (
                      <li key={i}><code>{s.artist || s.showId}</code> - {s.reason}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
          {error && (
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--danger)' }}>Error: {error}</div>
          )}
        </div>
      </div>
    </div>
  )
}

