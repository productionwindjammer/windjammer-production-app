import { useEffect, useState } from 'react'
import api from '../api'
import Modal from '../components/Modal'
import GmailConnect from '../components/GmailConnect'
import { useAuth } from '../context/AuthContext'

const BLANK = { name: '', email: '', role: 'crew', password: '', active: 'true', invite: true }

const ROLES = [
  { value: 'admin',              label: 'Admin' },
  { value: 'production_manager', label: 'Production Manager' },
  { value: 'stage_manager',      label: 'Stage Manager' },
  { value: 'venue_management',   label: 'Venue Management' },
  { value: 'promoter',           label: 'Promoter' },
  { value: 'crew',               label: 'Crew' },
]

export default function Users() {
  const { user: me } = useAuth()
  const [users, setUsers]   = useState([])
  const [loading, setLoad]  = useState(true)
  const [modal, setModal]   = useState(false)
  const [editing, setEdit]  = useState(null)
  const [form, setForm]     = useState(BLANK)
  const [saving, setSav]    = useState(false)
  const [filter, setFilter] = useState('')
  const [error, setError]   = useState('')
  const [invited, setInvited] = useState(null)   // { email, inviteUrl } after a successful invite

  useEffect(() => { load() }, [])

  async function load() {
    setLoad(true)
    try {
      const res = await api.get('/users')
      setUsers(res.data.data || [])
    } catch (err) {
      setError(err.response?.data?.message || err.message)
    } finally { setLoad(false) }
  }

  function openAdd()  { setEdit(null); setForm(BLANK);                                       setError(''); setModal(true) }
  function openEdit(u){ setEdit(u);    setForm({ ...BLANK, ...u, password: '', invite: false }); setError(''); setModal(true) }

  async function handleSave() {
    setSav(true); setError('')
    try {
      if (editing) {
        const payload = { ...form }
        delete payload.invite
        if (!payload.password) delete payload.password   // don't overwrite hash with blank
        await api.put(`/users/${editing.id}`, payload)
      } else {
        if (!form.invite && !form.password) {
          setError('Password is required for new users (or switch to invite mode).')
          setSav(false); return
        }
        const payload = { ...form }
        if (payload.invite) delete payload.password
        const res = await api.post('/users', payload)
        if (res.data?.invited) setInvited(res.data.invited)
      }
      await load()
      setModal(false)
    } catch (err) {
      setError(err.response?.data?.message || err.message)
    } finally { setSav(false) }
  }

  async function handleResendInvite(u) {
    try {
      const res = await api.post(`/users/${u.id}/invite`)
      if (res.data?.success) {
        setInvited({ email: u.email, inviteUrl: res.data.inviteUrl })
      } else {
        alert(res.data?.message || 'Could not send invite.')
      }
    } catch (err) {
      alert(err.response?.data?.message || err.message)
    }
  }

  async function handleDelete(u) {
    if (!confirm(`Delete user ${u.email}?`)) return
    try { await api.delete(`/users/${u.id}`); await load() }
    catch (err) { alert('Delete failed: ' + (err.response?.data?.message || err.message)) }
  }

  async function toggleHouse(u) {
    const next = String(u.isHouseMailbox).toLowerCase() !== 'true'
    if (next && !u.gmailEmail) {
      alert('User must connect their Gmail before being set as house mailbox.')
      return
    }
    try {
      await api.post(`/gmail/house/${u.id}`, { isHouse: next })
      await load()
    } catch (err) {
      alert('Could not update: ' + (err.response?.data?.message || err.message))
    }
  }

  const set = k => e => setForm(v => ({ ...v, [k]: e.target.value }))
  const f   = form

  const filtered = users.filter(u =>
    !filter ||
    (u.name  || '').toLowerCase().includes(filter.toLowerCase()) ||
    (u.email || '').toLowerCase().includes(filter.toLowerCase())
  )

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Users</div>
          <div className="page-subtitle">Login accounts and access roles</div>
        </div>
        <button className="btn btn-primary" onClick={openAdd}>+ Add User</button>
      </div>

      {invited && (
        <div className="card" style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.35)', color: '#86efac', padding: 14, marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 280 }}>
            ✉️ <strong>Invite sent</strong> to <code>{invited.email}</code>. They'll set their own password and complete their profile.
            {invited.inviteUrl && (
              <div style={{ marginTop: 6, fontSize: 12 }}>
                Direct link (in case email didn't arrive): <code style={{ background: 'rgba(0,0,0,0.3)', padding: '2px 6px', borderRadius: 4, userSelect: 'all', wordBreak: 'break-all' }}>{invited.inviteUrl}</code>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {invited.inviteUrl && (
              <button className="btn btn-ghost btn-sm" onClick={() => { navigator.clipboard?.writeText(invited.inviteUrl) }}>Copy Link</button>
            )}
            <button className="btn btn-ghost btn-sm" onClick={() => setInvited(null)}>Dismiss</button>
          </div>
        </div>
      )}

      <div style={{ marginBottom: 12 }}>
        <GmailConnect />
      </div>

      <div className="filter-bar">
        <input placeholder="Search name or email…" value={filter} onChange={e => setFilter(e.target.value)} />
      </div>

      {error && !modal && (
        <div className="card" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5', padding: 12, marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div className="card">
        {loading ? <div className="loading">Loading…</div> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Gmail</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={7}><div className="empty-state">No users found</div></td></tr>
                )}
                {filtered.map(u => (
                  <tr key={u.id}>
                    <td><strong>{u.name || '—'}</strong></td>
                    <td className="text-muted">{u.email}</td>
                    <td><span className="badge badge-inside" style={{ textTransform: 'capitalize' }}>{(u.role || '').replace('_', ' ')}</span></td>
                    <td style={{ fontSize: 12 }}>
                      {u.gmailEmail ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <span style={{ color: '#86efac' }}>✓ {u.gmailEmail}</span>
                          {me?.role === 'admin' && (
                            <button
                              className="btn btn-ghost btn-sm"
                              style={{ fontSize: 10, padding: '2px 6px' }}
                              onClick={() => toggleHouse(u)}
                              title="Toggle house mailbox"
                            >
                              {String(u.isHouseMailbox).toLowerCase() === 'true' ? '🏠 House' : 'Set as house'}
                            </button>
                          )}
                        </div>
                      ) : <span className="text-muted">—</span>}
                    </td>
                    <td>
                      <span className={`badge badge-${u.active === 'true' ? 'confirmed' : 'cancelled'}`}>
                        {u.active === 'true' ? 'Active' : 'Disabled'}
                      </span>
                    </td>
                    <td className="text-muted">{(u.createdAt || '').slice(0, 10)}</td>
                    <td>
                      <div className="actions-cell">
                        {u.onboardingComplete !== 'true' && u.email && (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => handleResendInvite(u)}
                            title="Send onboarding invite email"
                          >
                            ✉️ Invite
                          </button>
                        )}
                        <button className="btn btn-ghost btn-sm" onClick={() => openEdit(u)}>Edit</button>
                        <button className="btn btn-danger btn-sm" onClick={() => handleDelete(u)}>Del</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal && (
        <Modal
          title={editing ? `Edit User — ${editing.email}` : (f.invite ? 'Invite User' : 'Add User')}
          onClose={() => setModal(false)}
          size="modal-lg"
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving
                  ? (!editing && f.invite ? 'Sending…' : 'Saving…')
                  : (!editing && f.invite ? '✉️ Send Invite' : 'Save')}
              </button>
            </>
          }
        >
          {error && (
            <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5', padding: 10, borderRadius: 6, marginBottom: 12 }}>
              {error}
            </div>
          )}
          <div className="form-grid">
            <div className="form-row">
              <div className="form-group">
                <label>Full Name *</label>
                <input value={f.name} onChange={set('name')} />
              </div>
              <div className="form-group">
                <label>Email *</label>
                <input type="email" value={f.email} onChange={set('email')} disabled={!!editing} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Role *</label>
                <select value={f.role} onChange={set('role')}>
                  {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>Status</label>
                <select value={f.active} onChange={set('active')}>
                  <option value="true">Active</option>
                  <option value="false">Disabled</option>
                </select>
              </div>
            </div>
            <div className="form-group">
              <label>{editing ? 'Reset Password (leave blank to keep current)' : (f.invite ? 'Password' : 'Password *')}</label>
              {!editing && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <input
                    id="invite-mode"
                    type="checkbox"
                    checked={!!f.invite}
                    onChange={e => setForm(v => ({ ...v, invite: e.target.checked, password: e.target.checked ? '' : v.password }))}
                    style={{ width: 'auto' }}
                  />
                  <label htmlFor="invite-mode" style={{ margin: 0, cursor: 'pointer', fontSize: 13, fontWeight: 500 }}>
                    Send invite email — user sets their own password
                  </label>
                </div>
              )}
              {(editing || !f.invite) && (
                <>
                  <input
                    type="text"
                    value={f.password}
                    onChange={set('password')}
                    placeholder={editing ? 'Leave blank to keep current password' : 'Initial password'}
                  />
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>
                    Password will be bcrypt-hashed before storage.
                  </div>
                </>
              )}
              {!editing && f.invite && (
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', marginTop: 4, padding: 10, background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.25)', borderRadius: 6 }}>
                  An email with a signed onboarding link will be sent to <strong>{f.email || 'this address'}</strong>. The link is valid for 7 days. If no house Gmail mailbox is connected, you'll get a direct link to copy after saving.
                </div>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
