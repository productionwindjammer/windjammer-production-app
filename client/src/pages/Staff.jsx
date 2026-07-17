import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import api from '../api'
import Modal from '../components/Modal'
import { useAuth } from '../context/AuthContext'

const BLANK = {
  name: '', role: '', email: '', phone: '',
  department: '', startDate: '', stage: 'both',
  payType: 'day', dayRate: '', hourlyRate: '',
  rates: '[]',
  onboardingComplete: 'false',
  certifications: '', notes: '', active: 'true'
}

function parseRates(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : [] }
  catch { return [] }
}

const ONBOARDING = [
  'I-9 Completed', 'W-4 Completed', 'Emergency Contact on File',
  'Background Check', 'Safety Briefing', 'Stage Protocol Review',
  'LN Code of Conduct', 'Rigging Safety (if applicable)', 'Equipment Training'
]

export default function Staff() {
  const { user: authUser } = useAuth()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [staff, setStaff]     = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal]     = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm]       = useState(BLANK)
  const [saving, setSaving]   = useState(false)
  const [filter, setFilter]   = useState({ role: '', stage: '', search: '' })
  const [accountCreated, setAccountCreated] = useState(null)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const res = await api.get('/staff')
      setStaff(res.data.data || [])
    } finally { setLoading(false) }
  }

  function openAdd() { setEditing(null); setForm(BLANK); setModal(true) }
  function openEdit(s) { setEditing(s); setForm({ ...BLANK, ...s, rates: typeof s.rates === 'string' ? s.rates : JSON.stringify(parseRates(s.rates)) }); setModal(true) }

  // Support `?edit=<id>` so StaffDetail's "Edit Profile" button can jump
  // straight to the edit modal on the list page without duplicating the form.
  useEffect(() => {
    const editId = searchParams.get('edit')
    if (!editId || loading || modal) return
    const target = staff.find(s => String(s.id) === String(editId))
    if (target) {
      openEdit(target)
      // Clean up the URL so a refresh doesn't reopen the modal.
      const next = new URLSearchParams(searchParams)
      next.delete('edit')
      setSearchParams(next, { replace: true })
    }
  }, [searchParams, staff, loading])

  const rateList = parseRates(form.rates)
  function updateRates(next) { setForm(v => ({ ...v, rates: JSON.stringify(next) })) }
  function addRate()  { updateRates([...rateList, { role: '', payType: 'day', rate: '' }]) }
  function delRate(i) { updateRates(rateList.filter((_, idx) => idx !== i)) }
  function setRate(i, key, val) {
    const copy = rateList.slice()
    copy[i] = { ...copy[i], [key]: val }
    updateRates(copy)
  }

  async function handleSave() {
    setSaving(true)
    try {
      if (editing) await api.put(`/staff/${editing.id}`, form)
      else {
        const res = await api.post('/staff', form)
        if (res.data.invited) setAccountCreated(res.data.invited)
      }
      await load()
      setModal(false)
    } finally { setSaving(false) }
  }

  async function handleDelete(id) {
    if (!confirm('Remove this staff member?')) return
    await api.delete(`/staff/${id}`)
    await load()
  }

  async function handleSendInvite(s) {
    try {
      const res = await api.post(`/staff/${s.id}/invite`)
      if (res.data.success) {
        setAccountCreated({ email: s.email, inviteUrl: res.data.inviteUrl })
      } else {
        alert(res.data.message || 'Could not send invite.')
      }
    } catch (err) {
      alert(err.response?.data?.message || err.message)
    }
  }

  const set = k => e => setForm(v => ({ ...v, [k]: e.target.value }))
  const f = form

  const filtered = staff.filter(s => {
    if (filter.role && (s.role || '') !== filter.role) return false
    if (filter.stage && s.stage !== filter.stage && s.stage !== 'both') return false
    if (filter.search && !(s.name || '').toLowerCase().includes(filter.search.toLowerCase())) return false
    return true
  })

  const roles = [...new Set(staff.map(s => s.role).filter(Boolean))]

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Staff</div>
          <div className="page-subtitle">Team roster, onboarding, and training readiness</div>
        </div>
        <button className="btn btn-primary" onClick={openAdd}>+ Add Staff</button>
      </div>

      {accountCreated && (
        <div className="card" style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.35)', color: '#86efac', padding: 14, marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 280 }}>
            ✉️ <strong>Invite sent</strong> to <code>{accountCreated.email}</code>. They'll set their own password and complete their profile.
            {accountCreated.inviteUrl && (
              <div style={{ marginTop: 6, fontSize: 12 }}>
                Direct link (in case email didn't arrive): <code style={{ background: 'rgba(0,0,0,0.3)', padding: '2px 6px', borderRadius: 4, userSelect: 'all', wordBreak: 'break-all' }}>{accountCreated.inviteUrl}</code>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {accountCreated.inviteUrl && (
              <button className="btn btn-ghost btn-sm" onClick={() => { navigator.clipboard?.writeText(accountCreated.inviteUrl); }}>Copy Link</button>
            )}
            <button className="btn btn-ghost btn-sm" onClick={() => setAccountCreated(null)}>Dismiss</button>
          </div>
        </div>
      )}

      <div className="filter-bar">
        <input
          placeholder="Search name…"
          value={filter.search}
          onChange={e => setFilter(f => ({ ...f, search: e.target.value }))}
        />
        <select value={filter.role} onChange={e => setFilter(f => ({ ...f, role: e.target.value }))}>
          <option value="">All Roles</option>
          {roles.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        <select value={filter.stage} onChange={e => setFilter(f => ({ ...f, stage: e.target.value }))}>
          <option value="">All Stages</option>
          <option value="inside">Inside Stage</option>
          <option value="beach">Beach Stage</option>
          <option value="both">Both</option>
        </select>
      </div>

      <div className="card">
        {loading ? <div className="loading">Loading…</div> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Stage</th>
                  <th>Phone</th>
                  <th>Email</th>
                  <th>Start Date</th>
                  <th>Onboarding</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={9}><div className="empty-state">No staff found</div></td></tr>
                )}
                {filtered.map(s => (
                  <tr key={s.id}>
                    <td>
                      <a
                        href={`/staff/${s.id}`}
                        onClick={e => { e.preventDefault(); navigate(`/staff/${s.id}`) }}
                        style={{ color: 'var(--text)', textDecoration: 'none', fontWeight: 700 }}
                      >
                        {s.name || '—'}
                      </a>
                    </td>
                    <td className="text-muted">{s.role || '—'}</td>
                    <td>
                      {s.stage === 'both'
                        ? <><span className="badge badge-inside" style={{ marginRight: 4 }}>Inside</span><span className="badge badge-beach">Beach</span></>
                        : <span className={`badge badge-${s.stage}`}>{s.stage === 'inside' ? 'Inside' : 'Beach'}</span>
                      }
                    </td>
                    <td className="text-muted">{s.phone || '—'}</td>
                    <td className="text-muted">{s.email || '—'}</td>
                    <td className="text-muted">{s.startDate || '—'}</td>
                    <td>
                      <span className={`badge badge-${s.onboardingComplete === 'true' ? 'confirmed' : 'pending'}`}>
                        {s.onboardingComplete === 'true' ? '✅ Complete' : '⏳ Pending'}
                      </span>
                    </td>
                    <td>
                      <span className={`badge badge-${s.active === 'true' ? 'confirmed' : 'cancelled'}`}>
                        {s.active === 'true' ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td>
                      <div className="actions-cell">
                        <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/staff/${s.id}`)}>View</button>
                        {s.email && s.onboardingComplete !== 'true' && (
                          <button className="btn btn-ghost btn-sm" onClick={() => handleSendInvite(s)} title="Email an onboarding link">📧 Invite</button>
                        )}
                        <button className="btn btn-ghost btn-sm" onClick={() => openEdit(s)}>Edit</button>
                        <button className="btn btn-danger btn-sm" onClick={() => handleDelete(s.id)}>Del</button>
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
          title={editing ? 'Edit Staff Member' : 'Add Staff Member'}
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
          <div className="form-grid">
            {!editing && authUser?.role === 'admin' && (
              <div style={{ padding: 10, borderRadius: 6, background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)', color: '#93c5fd', fontSize: 13 }}>
                🔐 If an email is provided, a default login account (role: <strong>crew</strong>) will be created automatically. The temporary password will be shown after save.
              </div>
            )}
            <div className="form-row">
              <div className="form-group">
                <label>Full Name *</label>
                <input value={f.name} onChange={set('name')} placeholder="Full name" />
              </div>
              <div className="form-group">
                <label>Role / Position</label>
                <input value={f.role} onChange={set('role')} placeholder="Production Manager, Stagehand, Runner…" />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Phone</label>
                <input value={f.phone} onChange={set('phone')} />
              </div>
              <div className="form-group">
                <label>Email</label>
                <input type="email" value={f.email} onChange={set('email')} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Department</label>
                <input value={f.department} onChange={set('department')} placeholder="Production, Operations…" />
              </div>
              <div className="form-group">
                <label>Stage Assignment</label>
                <select value={f.stage} onChange={set('stage')}>
                  <option value="both">Both Stages</option>
                  <option value="inside">Inside Stage</option>
                  <option value="beach">Beach Stage</option>
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Start Date</label>
                <input type="date" value={f.startDate} onChange={set('startDate')} />
              </div>
              <div className="form-group">
                <label>Status</label>
                <select value={f.active} onChange={set('active')}>
                  <option value="true">Active</option>
                  <option value="false">Inactive</option>
                </select>
              </div>
            </div>
            <hr className="divider" />
            <div style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Pay</div>
            <div className="form-row-3">
              <div className="form-group">
                <label>Default Pay Type</label>
                <select value={f.payType} onChange={set('payType')}>
                  <option value="day">Day Rate</option>
                  <option value="hour">Hourly</option>
                </select>
              </div>
              <div className="form-group">
                <label>Default Day Rate ($)</label>
                <input type="number" step="0.01" value={f.dayRate} onChange={set('dayRate')} placeholder="0.00" />
              </div>
              <div className="form-group">
                <label>Default Hourly Rate ($)</label>
                <input type="number" step="0.01" value={f.hourlyRate} onChange={set('hourlyRate')} placeholder="0.00" />
              </div>
            </div>
            <div className="form-group">
              <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>Position Rates (overrides defaults when picked in Labor)</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={addRate}>+ Add Position</button>
              </label>
              {rateList.length === 0 && (
                <div className="text-muted" style={{ fontSize: 13 }}>No position-specific rates. The defaults above will be used.</div>
              )}
              {rateList.map((r, i) => (
                <div key={i} className="form-row-3" style={{ alignItems: 'end', marginTop: 6 }}>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label>Position</label>
                    <input value={r.role || ''} onChange={e => setRate(i, 'role', e.target.value)} placeholder="e.g. A1, Stagehand, Spot" />
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label>Pay Type</label>
                    <select value={r.payType || 'day'} onChange={e => setRate(i, 'payType', e.target.value)}>
                      <option value="day">Day Rate</option>
                      <option value="hour">Hourly</option>
                    </select>
                  </div>
                  <div className="form-group" style={{ margin: 0, display: 'flex', gap: 6 }}>
                    <input type="number" step="0.01" value={r.rate || ''} onChange={e => setRate(i, 'rate', e.target.value)} placeholder="0.00" style={{ flex: 1 }} />
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => delRate(i)} title="Remove">×</button>
                  </div>
                </div>
              ))}
            </div>
            <hr className="divider" />
            <div style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Onboarding</div>
            <div className="form-row">
              <div className="form-group">
                <label>Onboarding Complete?</label>
                <select value={f.onboardingComplete} onChange={set('onboardingComplete')}>
                  <option value="false">Pending</option>
                  <option value="true">Complete</option>
                </select>
              </div>
            </div>
            <div className="form-group">
              <label>Certifications / Training Completed</label>
              <textarea value={f.certifications} onChange={set('certifications')} placeholder={ONBOARDING.join(', ')} />
            </div>
            <div className="form-group">
              <label>Notes</label>
              <textarea value={f.notes} onChange={set('notes')} />
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
