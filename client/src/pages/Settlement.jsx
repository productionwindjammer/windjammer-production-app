import { useEffect, useState } from 'react'
import api from '../api'
import Modal from '../components/Modal'
import { filterShowList } from '../utils/showFilters'

const BLANK = {
  showId: '', showName: '', stage: 'inside',
  artistGuarantee: '', ticketRevenue: '', otherRevenue: '',
  totalRevenue: '',
  productionCost: '', laborCost: '', vendorCost: '',
  cateringCost: '', securityCost: '', miscCost: '',
  totalCosts: '', netSettlement: '',
  artistPayment: '', artistPaymentDate: '', artistPaymentMethod: '',
  settledBy: '', notes: '', status: 'pending'
}

function sum(...vals) {
  return vals.reduce((a, b) => a + (parseFloat(b) || 0), 0)
}

export default function Settlement() {
  const [records, setRecords] = useState([])
  const [shows, setShows]     = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal]     = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm]       = useState(BLANK)
  const [saving, setSaving]   = useState(false)
  const [showPastShows, setShowPastShows] = useState(false)

  useEffect(() => {
    Promise.all([api.get('/settlement'), api.get('/shows')]).then(([r, s]) => {
      setRecords(r.data.data || [])
      setShows(s.data.data || [])
    }).finally(() => setLoading(false))
  }, [])

  async function load() {
    const [r, s] = await Promise.all([api.get('/settlement'), api.get('/shows')])
    setRecords(r.data.data || [])
    setShows(s.data.data || [])
  }

  function openAdd() { setEditing(null); setForm(BLANK); setModal(true) }
  function openEdit(r) { setEditing(r); setForm({ ...BLANK, ...r }); setModal(true) }

  async function handleSave() {
    setSaving(true)
    const totalRevenue = sum(form.ticketRevenue, form.otherRevenue).toFixed(2)
    const totalCosts   = sum(form.productionCost, form.laborCost, form.vendorCost, form.cateringCost, form.securityCost, form.miscCost).toFixed(2)
    const netSettlement = (parseFloat(totalRevenue) - parseFloat(totalCosts) - (parseFloat(form.artistGuarantee) || 0)).toFixed(2)
    const payload = { ...form, totalRevenue, totalCosts, netSettlement }
    try {
      if (editing) await api.put(`/settlement/${editing.id}`, payload)
      else await api.post('/settlement', payload)
      await load()
      setModal(false)
    } finally { setSaving(false) }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this settlement?')) return
    await api.delete(`/settlement/${id}`)
    await load()
  }

  const set = k => e => setForm(v => ({ ...v, [k]: e.target.value }))
  const f = form

  const previewRevenue = sum(f.ticketRevenue, f.otherRevenue)
  const previewCosts   = sum(f.productionCost, f.laborCost, f.vendorCost, f.cateringCost, f.securityCost, f.miscCost)
  const previewNet     = previewRevenue - previewCosts - (parseFloat(f.artistGuarantee) || 0)

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Settlement</div>
          <div className="page-subtitle">Show accounting, artist payments, and cost tracking</div>
        </div>
        <button className="btn btn-primary" onClick={openAdd}>+ New Settlement</button>
      </div>

      <div className="card">
        {loading ? <div className="loading">Loading…</div> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Show</th>
                  <th>Stage</th>
                  <th>Guarantee</th>
                  <th>Ticket Revenue</th>
                  <th>Total Costs</th>
                  <th>Net Settlement</th>
                  <th>Artist Paid</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {records.length === 0 && (
                  <tr><td colSpan={9}><div className="empty-state">No settlements yet</div></td></tr>
                )}
                {records.map(r => (
                  <tr key={r.id}>
                    <td><strong>{r.showName || '—'}</strong></td>
                    <td><span className={`badge badge-${r.stage}`}>{r.stage === 'inside' ? 'Inside' : 'Beach'}</span></td>
                    <td>{r.artistGuarantee ? `$${r.artistGuarantee}` : '—'}</td>
                    <td>{r.ticketRevenue ? `$${r.ticketRevenue}` : '—'}</td>
                    <td>{r.totalCosts ? `$${r.totalCosts}` : '—'}</td>
                    <td>
                      <strong style={{ color: parseFloat(r.netSettlement) >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                        {r.netSettlement ? `$${r.netSettlement}` : '—'}
                      </strong>
                    </td>
                    <td>{r.artistPaymentDate || '—'}</td>
                    <td><span className={`badge badge-${r.status || 'pending'}`}>{r.status || 'pending'}</span></td>
                    <td>
                      <div className="actions-cell">
                        <button className="btn btn-ghost btn-sm" onClick={() => openEdit(r)}>Edit</button>
                        <button className="btn btn-danger btn-sm" onClick={() => handleDelete(r.id)}>Del</button>
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
          title={editing ? 'Edit Settlement' : 'New Settlement'}
          onClose={() => setModal(false)}
          size="modal-lg"
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save Settlement'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div className="form-row">
              <div className="form-group">
                <label>
                  Show
                  <label style={{ float: 'right', fontSize: 11, fontWeight: 400, color: 'var(--text-muted)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={showPastShows} onChange={e => setShowPastShows(e.target.checked)} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                    Show all (incl. past)
                  </label>
                </label>
                <select value={f.showId} onChange={e => {
                  const s = shows.find(s => s.id === e.target.value)
                  setForm(v => ({ ...v, showId: e.target.value, showName: s ? `${s.date} — ${s.artist || s.eventName}` : '', stage: s?.stage || v.stage }))
                }}>
                  <option value="">Select show…</option>
                  {filterShowList(shows, { showPast: showPastShows }).map(s => (
                    <option key={s.id} value={s.id}>{s.date} — {s.artist || s.eventName}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Status</label>
                <select value={f.status} onChange={set('status')}>
                  <option value="pending">Pending</option>
                  <option value="settled">Settled</option>
                  <option value="disputed">Disputed</option>
                </select>
              </div>
            </div>
            <hr className="divider" />
            <div style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Revenue</div>
            <div className="form-row">
              <div className="form-group">
                <label>Artist Guarantee</label>
                <input type="number" step="0.01" value={f.artistGuarantee} onChange={set('artistGuarantee')} placeholder="0.00" />
              </div>
              <div className="form-group">
                <label>Ticket Revenue</label>
                <input type="number" step="0.01" value={f.ticketRevenue} onChange={set('ticketRevenue')} placeholder="0.00" />
              </div>
            </div>
            <div className="form-group">
              <label>Other Revenue</label>
              <input type="number" step="0.01" value={f.otherRevenue} onChange={set('otherRevenue')} placeholder="Bar, merch splits, etc." />
            </div>
            <hr className="divider" />
            <div style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Costs</div>
            <div className="form-row">
              <div className="form-group">
                <label>Production Cost</label>
                <input type="number" step="0.01" value={f.productionCost} onChange={set('productionCost')} placeholder="0.00" />
              </div>
              <div className="form-group">
                <label>Labor Cost</label>
                <input type="number" step="0.01" value={f.laborCost} onChange={set('laborCost')} placeholder="0.00" />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Vendor / Rental Cost</label>
                <input type="number" step="0.01" value={f.vendorCost} onChange={set('vendorCost')} placeholder="0.00" />
              </div>
              <div className="form-group">
                <label>Catering Cost</label>
                <input type="number" step="0.01" value={f.cateringCost} onChange={set('cateringCost')} placeholder="0.00" />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Security Cost</label>
                <input type="number" step="0.01" value={f.securityCost} onChange={set('securityCost')} placeholder="0.00" />
              </div>
              <div className="form-group">
                <label>Misc Cost</label>
                <input type="number" step="0.01" value={f.miscCost} onChange={set('miscCost')} placeholder="0.00" />
              </div>
            </div>
            <div className="card" style={{ background: 'rgba(255,255,255,0.03)', marginTop: 4 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, fontSize: '0.85rem' }}>
                <div><div className="stat-label">Total Revenue</div><div style={{ fontSize: '1.2rem', fontWeight: 700 }}>${previewRevenue.toFixed(2)}</div></div>
                <div><div className="stat-label">Total Costs</div><div style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--danger)' }}>${previewCosts.toFixed(2)}</div></div>
                <div><div className="stat-label">Net Settlement</div><div style={{ fontSize: '1.2rem', fontWeight: 700, color: previewNet >= 0 ? 'var(--success)' : 'var(--danger)' }}>${previewNet.toFixed(2)}</div></div>
              </div>
            </div>
            <hr className="divider" />
            <div style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Artist Payment</div>
            <div className="form-row">
              <div className="form-group">
                <label>Payment Date</label>
                <input type="date" value={f.artistPaymentDate} onChange={set('artistPaymentDate')} />
              </div>
              <div className="form-group">
                <label>Payment Method</label>
                <input value={f.artistPaymentMethod} onChange={set('artistPaymentMethod')} placeholder="Check, Wire, Cash…" />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Settled By</label>
                <input value={f.settledBy} onChange={set('settledBy')} placeholder="Staff member name" />
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
