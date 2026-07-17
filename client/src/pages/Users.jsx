import { useEffect, useState } from 'react'
import api from '../api'
import Modal from '../components/Modal'
import GmailConnect from '../components/GmailConnect'
import { useAuth } from '../context/AuthContext'

const BLANK = { name: '', email: '', role: 'crew', password: '', active: 'true' }

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

  function openAdd()  { setEdit(null); setForm(BLANK);                  setError(''); setModal(true) }
  function openEdit(u){ setEdit(u);    setForm({ ...BLANK, ...u, password: '' }); setError(''); setModal(true) }

  async function handleSave() {
    setSav(true); setError('')
    try {
      if (editing) {
        const payload = { ...form }
        if (!payload.password) delete payload.password   // don't overwrite hash with blank
        await api.put(`/users/${editing.id}`, payload)
      } else {
        if (!form.password) { setError('Password is required for new users.'); setSav(false); return }
        await api.post('/users', form)
      }
      await load()
      setModal(false)
    } catch (err) {
      setError(err.response?.data?.message || err.message)
    } finally { setSav(false) }
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
          title={editing ? `Edit User — ${editing.email}` : 'Add User'}
          onClose={() => setModal(false)}
          size="modal-lg"
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
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
              <label>{editing ? 'Reset Password (leave blank to keep current)' : 'Password *'}</label>
              <input type="text" value={f.password} onChange={set('password')} placeholder={editing ? 'Leave blank to keep current password' : 'Initial password'} />
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>
                Password will be bcrypt-hashed before storage.
              </div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
