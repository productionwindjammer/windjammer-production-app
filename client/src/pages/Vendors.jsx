import { useEffect, useState } from 'react'
import api from '../api'
import Modal from '../components/Modal'

const BLANK_VENDOR = {
  company: '', contactName: '', phone: '', email: '',
  category: '', website: '', notes: '', active: 'true'
}

const BLANK_BOOKING = {
  showId: '', showName: '', vendorId: '', vendorName: '',
  service: '', confirmedDate: '', amount: '', paid: 'false', notes: ''
}

export default function Vendors() {
  const [vendors, setVendors]   = useState([])
  const [bookings, setBookings] = useState([])
  const [shows, setShows]       = useState([])
  const [loading, setLoading]   = useState(true)
  const [tab, setTab]           = useState('vendors')
  const [modal, setModal]       = useState(false)
  const [editing, setEditing]   = useState(null)
  const [form, setForm]         = useState(BLANK_VENDOR)
  const [saving, setSaving]     = useState(false)

  useEffect(() => { load() }, [])

  async function load() {
    const [v, b, s] = await Promise.all([api.get('/vendors'), api.get('/vendor-bookings'), api.get('/shows')])
    setVendors(v.data.data || [])
    setBookings(b.data.data || [])
    setShows(s.data.data || [])
    setLoading(false)
  }

  function openAddVendor() { setEditing(null); setForm(BLANK_VENDOR); setModal('vendor') }
  function openEditVendor(v) { setEditing(v); setForm({ ...BLANK_VENDOR, ...v }); setModal('vendor') }
  function openAddBooking() { setEditing(null); setForm(BLANK_BOOKING); setModal('booking') }
  function openEditBooking(b) { setEditing(b); setForm({ ...BLANK_BOOKING, ...b }); setModal('booking') }

  async function handleSaveVendor() {
    setSaving(true)
    try {
      if (editing) await api.put(`/vendors/${editing.id}`, form)
      else await api.post('/vendors', form)
      await load()
      setModal(false)
    } finally { setSaving(false) }
  }

  async function handleSaveBooking() {
    setSaving(true)
    try {
      if (editing) await api.put(`/vendor-bookings/${editing.id}`, form)
      else await api.post('/vendor-bookings', form)
      await load()
      setModal(false)
    } finally { setSaving(false) }
  }

  async function handleDelete(type, id) {
    if (!confirm('Delete this record?')) return
    await api.delete(`/${type}/${id}`)
    await load()
  }

  const set = k => e => setForm(v => ({ ...v, [k]: e.target.value }))
  const f = form

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Vendors</div>
          <div className="page-subtitle">Subcontractors, rental equipment, and show bookings</div>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-ghost" onClick={() => { setTab('vendors'); openAddVendor() }}>+ Add Vendor</button>
          <button className="btn btn-primary" onClick={() => { setTab('bookings'); openAddBooking() }}>+ Book Vendor</button>
        </div>
      </div>

      <div className="flex gap-2 mb-4">
        <button className={`btn ${tab === 'vendors' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('vendors')}>
          Vendor Directory ({vendors.length})
        </button>
        <button className={`btn ${tab === 'bookings' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab('bookings')}>
          Show Bookings ({bookings.length})
        </button>
      </div>

      {tab === 'vendors' && (
        <div className="card">
          {loading ? <div className="loading">Loading…</div> : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>Contact</th>
                    <th>Category</th>
                    <th>Phone</th>
                    <th>Email</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {vendors.length === 0 && (
                    <tr><td colSpan={7}><div className="empty-state">No vendors yet</div></td></tr>
                  )}
                  {vendors.map(v => (
                    <tr key={v.id}>
                      <td><strong>{v.company || '—'}</strong></td>
                      <td className="text-muted">{v.contactName || '—'}</td>
                      <td className="text-muted">{v.category || '—'}</td>
                      <td className="text-muted">{v.phone || '—'}</td>
                      <td className="text-muted">{v.email || '—'}</td>
                      <td><span className={`badge badge-${v.active === 'true' ? 'confirmed' : 'cancelled'}`}>{v.active === 'true' ? 'Active' : 'Inactive'}</span></td>
                      <td>
                        <div className="actions-cell">
                          <button className="btn btn-ghost btn-sm" onClick={() => openEditVendor(v)}>Edit</button>
                          <button className="btn btn-danger btn-sm" onClick={() => handleDelete('vendors', v.id)}>Del</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'bookings' && (
        <div className="card">
          {loading ? <div className="loading">Loading…</div> : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Show</th>
                    <th>Vendor</th>
                    <th>Service</th>
                    <th>Amount</th>
                    <th>Paid</th>
                    <th>Notes</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {bookings.length === 0 && (
                    <tr><td colSpan={7}><div className="empty-state">No vendor bookings yet</div></td></tr>
                  )}
                  {bookings.map(b => (
                    <tr key={b.id}>
                      <td className="text-muted">{b.showName || b.showId || '—'}</td>
                      <td><strong>{b.vendorName || b.vendorId || '—'}</strong></td>
                      <td className="text-muted">{b.service || '—'}</td>
                      <td>{b.amount ? `$${b.amount}` : '—'}</td>
                      <td><span className={`badge badge-${b.paid === 'true' ? 'confirmed' : 'pending'}`}>{b.paid === 'true' ? 'Paid' : 'Unpaid'}</span></td>
                      <td className="text-muted">{b.notes || '—'}</td>
                      <td>
                        <div className="actions-cell">
                          <button className="btn btn-ghost btn-sm" onClick={() => openEditBooking(b)}>Edit</button>
                          <button className="btn btn-danger btn-sm" onClick={() => handleDelete('vendor-bookings', b.id)}>Del</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {modal === 'vendor' && (
        <Modal
          title={editing ? 'Edit Vendor' : 'Add Vendor'}
          onClose={() => setModal(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSaveVendor} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div className="form-row">
              <div className="form-group">
                <label>Company Name *</label>
                <input value={f.company} onChange={set('company')} placeholder="Company name" />
              </div>
              <div className="form-group">
                <label>Category</label>
                <input value={f.category} onChange={set('category')} placeholder="Audio, Lighting, Security, Staging…" />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Contact Name</label>
                <input value={f.contactName} onChange={set('contactName')} />
              </div>
              <div className="form-group">
                <label>Phone</label>
                <input value={f.phone} onChange={set('phone')} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Email</label>
                <input type="email" value={f.email} onChange={set('email')} />
              </div>
              <div className="form-group">
                <label>Website</label>
                <input value={f.website} onChange={set('website')} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Status</label>
                <select value={f.active} onChange={set('active')}>
                  <option value="true">Active</option>
                  <option value="false">Inactive</option>
                </select>
              </div>
            </div>
            <div className="form-group">
              <label>Notes</label>
              <textarea value={f.notes} onChange={set('notes')} />
            </div>
          </div>
        </Modal>
      )}

      {modal === 'booking' && (
        <Modal
          title={editing ? 'Edit Booking' : 'Book Vendor for Show'}
          onClose={() => setModal(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSaveBooking} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div className="form-group">
              <label>Show</label>
              <select value={f.showId} onChange={e => {
                const s = shows.find(s => s.id === e.target.value)
                setForm(v => ({ ...v, showId: e.target.value, showName: s ? `${s.date} — ${s.artist || s.eventName}` : '' }))
              }}>
                <option value="">Select show…</option>
                {shows.map(s => (
                  <option key={s.id} value={s.id}>{s.date} — {s.artist || s.eventName}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>Vendor</label>
              <select value={f.vendorId} onChange={e => {
                const v = vendors.find(v => v.id === e.target.value)
                setForm(fv => ({ ...fv, vendorId: e.target.value, vendorName: v?.company || '' }))
              }}>
                <option value="">Select vendor…</option>
                {vendors.filter(v => v.active !== 'false').map(v => (
                  <option key={v.id} value={v.id}>{v.company}</option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Service Description</label>
                <input value={f.service} onChange={set('service')} placeholder="What service is being provided?" />
              </div>
              <div className="form-group">
                <label>Amount</label>
                <input type="number" step="0.01" value={f.amount} onChange={set('amount')} placeholder="0.00" />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Paid?</label>
                <select value={f.paid} onChange={set('paid')}>
                  <option value="false">Unpaid</option>
                  <option value="true">Paid</option>
                </select>
              </div>
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
