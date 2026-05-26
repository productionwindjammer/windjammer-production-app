import { useEffect, useState } from 'react'
import api from '../api'
import Modal from '../components/Modal'
import { filterShowList } from '../utils/showFilters'

const BLANK = {
  showId: '', showName: '', stage: 'inside',
  staffId: '', workerName: '', role: '', callTime: '', wrapTime: '',
  payType: 'day', days: '1', hours: '', rate: '', total: '', union: 'false',
  notes: ''
}

export default function Labor() {
  const [entries, setEntries] = useState([])
  const [shows, setShows]     = useState([])
  const [staff, setStaff]     = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal]     = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm]       = useState(BLANK)
  const [saving, setSaving]   = useState(false)
  const [filter, setFilter]   = useState({ show: '', stage: '' })
  const [showPastShows, setShowPastShows] = useState(false)
  const [quickAddName, setQuickAddName] = useState('')
  const [quickAddBusy, setQuickAddBusy] = useState(false)
  const [quickAddError, setQuickAddError] = useState('')
  const showQuickAdd = form.staffId === '__new__'

  useEffect(() => {
    Promise.all([api.get('/labor'), api.get('/shows'), api.get('/staff')]).then(([l, s, st]) => {
      setEntries(l.data.data || [])
      setShows(s.data.data || [])
      setStaff(st.data.data || [])
    }).finally(() => setLoading(false))
  }, [])

  async function load() {
    const [l, s, st] = await Promise.all([api.get('/labor'), api.get('/shows'), api.get('/staff')])
    setEntries(l.data.data || [])
    setShows(s.data.data || [])
    setStaff(st.data.data || [])
  }

  function openAdd() { setEditing(null); setForm(BLANK); setModal(true) }
  function openEdit(r) { setEditing(r); setForm({ ...BLANK, ...r }); setModal(true) }

  function calcTotal(form) {
    if ((form.payType || 'day') === 'day') {
      const d = parseFloat(form.days || '1'), r = parseFloat(form.rate)
      return !isNaN(d) && !isNaN(r) ? (d * r).toFixed(2) : ''
    }
    const h = parseFloat(form.hours), r = parseFloat(form.rate)
    return !isNaN(h) && !isNaN(r) ? (h * r).toFixed(2) : ''
  }

  function parseRates(raw) {
    if (!raw) return []
    if (Array.isArray(raw)) return raw
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : [] }
    catch { return [] }
  }

  const selectedStaff = staff.find(s => s.id === form.staffId)
  const selectedRates = selectedStaff ? parseRates(selectedStaff.rates) : []

  function pickStaff(id) {
    if (id === '__new__') {
      setQuickAddName('')
      setQuickAddError('')
      setForm(v => ({ ...v, staffId: '__new__', workerName: '' }))
      return
    }
    const s = staff.find(x => x.id === id)
    if (!s) { setForm(v => ({ ...v, staffId: '', workerName: '' })); return }
    const rates = parseRates(s.rates)
    // If exactly one position rate, auto-pick it. Otherwise fall back to defaults
    // and let the user choose from the Position dropdown.
    if (rates.length === 1) {
      const r = rates[0]
      setForm(v => ({
        ...v,
        staffId: s.id,
        workerName: s.name || '',
        role: r.role || s.role || v.role,
        payType: r.payType || 'day',
        rate: r.rate || '',
      }))
      return
    }
    const payType = s.payType || 'day'
    const rate = payType === 'day' ? (s.dayRate || '') : (s.hourlyRate || '')
    setForm(v => ({
      ...v,
      staffId: s.id,
      workerName: s.name || '',
      role: s.role || v.role,
      payType,
      rate,
    }))
  }

  function pickStaffPosition(idx) {
    const r = selectedRates[Number(idx)]
    if (!r) return
    setForm(v => ({
      ...v,
      role: r.role || v.role,
      payType: r.payType || 'day',
      rate: r.rate || '',
    }))
  }

  async function quickAddWorker() {
    const name = quickAddName.trim()
    if (!name) { setQuickAddError('Enter a name'); return }
    setQuickAddBusy(true); setQuickAddError('')
    try {
      const res = await api.post('/staff', { name, active: 'true' })
      const created = res.data?.data || res.data
      if (!created?.id) throw new Error('Could not create staff record')
      setStaff(prev => [...prev, created])
      setForm(v => ({ ...v, staffId: created.id, workerName: created.name || name }))
      setQuickAddName('')
    } catch (err) {
      setQuickAddError(err.response?.data?.message || err.message || 'Could not add worker')
    } finally {
      setQuickAddBusy(false)
    }
  }

  async function handleSave() {
    setSaving(true)
    const payload = { ...form, total: calcTotal(form) }
    try {
      if (editing) await api.put(`/labor/${editing.id}`, payload)
      else await api.post('/labor', payload)
      await load()
      setModal(false)
    } finally { setSaving(false) }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this labor entry?')) return
    try {
      await api.delete(`/labor/${id}`)
      await load()
    } catch (err) {
      alert(err.response?.data?.message || err.message || 'Delete failed')
    }
  }

  const set = k => e => setForm(v => ({ ...v, [k]: e.target.value }))
  const f = form

  const filtered = entries.filter(e => {
    if (filter.show && e.showId !== filter.show) return false
    if (filter.stage && e.stage !== filter.stage) return false
    return true
  })

  const totalCost = filtered.reduce((sum, e) => sum + (parseFloat(e.total) || 0), 0)

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Labor</div>
          <div className="page-subtitle">Stagehand, casual labor, and runner assignments</div>
        </div>
        <button className="btn btn-primary" onClick={openAdd}>+ Add Labor</button>
      </div>

      <div className="filter-bar">
        <select value={filter.show} onChange={e => setFilter(f => ({ ...f, show: e.target.value }))}>
          <option value="">All Shows</option>
          {filterShowList(shows, { showPast: showPastShows }).map(s => (
            <option key={s.id} value={s.id}>{s.date} — {s.artist || s.eventName}</option>
          ))}
        </select>
        <select value={filter.stage} onChange={e => setFilter(f => ({ ...f, stage: e.target.value }))}>
          <option value="">All Stages</option>
          <option value="inside">Inside Stage</option>
          <option value="beach">Beach Stage</option>
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'rgba(255,255,255,0.7)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={showPastShows} onChange={e => setShowPastShows(e.target.checked)} />
          Show all (incl. past)
        </label>
        {filtered.length > 0 && (
          <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            Total: <strong style={{ color: 'var(--text)' }}>${totalCost.toFixed(2)}</strong>
          </span>
        )}
      </div>

      <div className="card">
        {loading ? <div className="loading">Loading…</div> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Role</th>
                  <th>Show</th>
                  <th>Stage</th>
                  <th>Call</th>
                  <th>Wrap</th>
                  <th>Units</th>
                  <th>Rate</th>
                  <th>Total</th>
                  <th>Union</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={11}><div className="empty-state">No labor entries found</div></td></tr>
                )}
                {filtered.map(e => (
                  <tr key={e.id}>
                    <td><strong>{e.workerName || '—'}</strong></td>
                    <td className="text-muted">{e.role || '—'}</td>
                    <td className="text-muted">{e.showName || '—'}</td>
                    <td><span className={`badge badge-${e.stage}`}>{e.stage === 'inside' ? 'Inside' : 'Beach'}</span></td>
                    <td className="text-muted">{e.callTime || '—'}</td>
                    <td className="text-muted">{e.wrapTime || '—'}</td>
                    <td>{(e.payType || 'hour') === 'day' ? `${e.days || 1} day${(e.days || 1) == 1 ? '' : 's'}` : (e.hours ? `${e.hours} hr` : '—')}</td>
                    <td>{e.rate ? `$${e.rate}${(e.payType || 'hour') === 'day' ? '/day' : '/hr'}` : '—'}</td>
                    <td><strong>{e.total ? `$${e.total}` : '—'}</strong></td>
                    <td>{e.union === 'true' ? '✅' : '—'}</td>
                    <td>
                      <div className="actions-cell">
                        <button className="btn btn-ghost btn-sm" onClick={() => openEdit(e)}>Edit</button>
                        <button className="btn btn-danger btn-sm" onClick={() => handleDelete(e.id)}>Del</button>
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
          title={editing ? 'Edit Labor Entry' : 'Add Labor Entry'}
          onClose={() => setModal(false)}
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
            <div className="form-row">
              <div className="form-group">
                <label>Show</label>
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
                <label>Stage</label>
                <select value={f.stage} onChange={set('stage')}>
                  <option value="inside">Inside Stage</option>
                  <option value="beach">Beach Stage</option>
                </select>
              </div>
            </div>
            <div className="form-group">
              <label>Worker *</label>
              <select value={form.staffId || ''} onChange={e => pickStaff(e.target.value)}>
                <option value="">— Select worker —</option>
                {staff.filter(s => s.active !== 'false')
                  .slice()
                  .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
                  .map(s => (
                    <option key={s.id} value={s.id}>{s.name}{s.role ? ` — ${s.role}` : ''}</option>
                  ))}
                <option value="__new__">+ Add new worker…</option>
              </select>
              {showQuickAdd && (
                <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    autoFocus
                    value={quickAddName}
                    onChange={e => setQuickAddName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); quickAddWorker() } }}
                    placeholder="New worker name"
                    style={{ flex: '1 1 200px' }}
                  />
                  <button type="button" className="btn btn-primary btn-sm" onClick={quickAddWorker} disabled={quickAddBusy}>
                    {quickAddBusy ? 'Adding…' : 'Add'}
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setForm(v => ({ ...v, staffId: '' })); setQuickAddError('') }}>
                    Cancel
                  </button>
                  {quickAddError && <span style={{ color: '#dc2626', fontSize: 12, width: '100%' }}>{quickAddError}</span>}
                </div>
              )}
            </div>
            {selectedRates.length > 1 && (
              <div className="form-group">
                <label>Position (rate)</label>
                <select onChange={e => pickStaffPosition(e.target.value)} defaultValue="">
                  <option value="">— Pick a position rate —</option>
                  {selectedRates.map((r, i) => (
                    <option key={i} value={i}>
                      {r.role || '(unnamed)'} — ${r.rate || '0.00'}{r.payType === 'day' ? '/day' : '/hr'}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="form-row">
              <div className="form-group">
                <label>Role / Position</label>
                <input value={f.role} onChange={set('role')} placeholder="Stagehand, Runner, Security…" />
              </div>
              <div className="form-group">
                <label>Pay Type</label>
                <select value={f.payType} onChange={set('payType')}>
                  <option value="day">Day Rate</option>
                  <option value="hour">Hourly</option>
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Call Time</label>
                <input type="time" value={f.callTime} onChange={set('callTime')} />
              </div>
              <div className="form-group">
                <label>Wrap Time</label>
                <input type="time" value={f.wrapTime} onChange={set('wrapTime')} />
              </div>
            </div>
            <div className="form-row-3">
              {f.payType === 'day' ? (
                <div className="form-group">
                  <label>Days</label>
                  <input type="number" step="0.5" value={f.days} onChange={set('days')} placeholder="1" />
                </div>
              ) : (
                <div className="form-group">
                  <label>Hours</label>
                  <input type="number" step="0.5" value={f.hours} onChange={set('hours')} placeholder="0.0" />
                </div>
              )}
              <div className="form-group">
                <label>{f.payType === 'day' ? 'Day Rate ($)' : 'Rate ($/hr)'}</label>
                <input type="number" step="0.01" value={f.rate} onChange={set('rate')} placeholder="0.00" />
              </div>
              <div className="form-group">
                <label>Auto Total</label>
                <input value={calcTotal(f) ? `$${calcTotal(f)}` : ''} readOnly placeholder="—" style={{ opacity: 0.7 }} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Union?</label>
                <select value={f.union} onChange={set('union')}>
                  <option value="false">No</option>
                  <option value="true">Yes</option>
                </select>
              </div>
              <div className="form-group">
                <label>Notes</label>
                <input value={f.notes} onChange={set('notes')} />
              </div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
