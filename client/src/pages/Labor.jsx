import { useEffect, useState } from 'react'
import api from '../api'
import Modal from '../components/Modal'
import { filterShowList } from '../utils/showFilters'
import { useSettings } from '../context/SettingsContext'
import { formatTime } from '../utils/time'

const BLANK = {
  showId: '', showName: '', stage: 'inside',
  staffId: '', workerName: '', role: '', callTime: '', wrapTime: '',
  payType: 'day', days: '1', hours: '', rate: '', total: '', union: 'false',
  notes: ''
}

export default function Labor() {
  const { settings } = useSettings()
  const tf = settings.timeFormat || '12h'
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

  // ── Bulk "Build Crew" modal state ──────────────────────────────────────────
  const [crewModal, setCrewModal]       = useState(false)
  const [crewShowId, setCrewShowId]     = useState('')
  const [crewStage, setCrewStage]       = useState('inside')
  const [crewRows, setCrewRows]         = useState([])
  const [crewSaving, setCrewSaving]     = useState(false)
  const [crewQuickRow, setCrewQuickRow] = useState(null) // row id currently in quick-add mode
  const [crewQuickName, setCrewQuickName] = useState('')
  const [crewQuickBusy, setCrewQuickBusy] = useState(false)
  const newRowId = () => `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  function makeCrewRow(role) {
    return { _rid: newRowId(), staffId: '', workerName: '', role: role || '',
             callTime: '', wrapTime: '', payType: 'day', days: '1', hours: '', rate: '', union: 'false' }
  }
  function openCrewBuilder() {
    setCrewShowId('')
    setCrewStage('inside')
    setCrewRows([
      makeCrewRow('House Crew'),
      makeCrewRow('House Crew'),
      makeCrewRow('House Crew'),
    ])
    setCrewQuickRow(null); setCrewQuickName('')
    setCrewModal(true)
  }
  function updateCrewRow(rid, patch) {
    setCrewRows(rows => rows.map(r => r._rid === rid ? { ...r, ...patch } : r))
  }
  function pickCrewWorker(rid, staffId) {
    if (staffId === '__new__') {
      setCrewQuickRow(rid); setCrewQuickName(''); return
    }
    const s = staff.find(x => x.id === staffId)
    if (!s) { updateCrewRow(rid, { staffId: '', workerName: '' }); return }
    const rates = parseRates(s.rates)
    if (rates.length >= 1) {
      const r = rates[0]
      updateCrewRow(rid, {
        staffId: s.id, workerName: s.name || '',
        role: r.role || s.role || '',
        payType: r.payType || 'day', rate: r.rate || '',
      })
    } else {
      const payType = s.payType || 'day'
      const rate = payType === 'day' ? (s.dayRate || '') : (s.hourlyRate || '')
      updateCrewRow(rid, { staffId: s.id, workerName: s.name || '', role: s.role || '', payType, rate })
    }
  }
  async function commitCrewQuickAdd() {
    const name = crewQuickName.trim()
    if (!name) return
    setCrewQuickBusy(true)
    try {
      const res = await api.post('/staff', { name, active: 'true' })
      const created = res.data?.data || res.data
      if (!created?.id) throw new Error('Could not add worker')
      setStaff(prev => [...prev, created])
      if (crewQuickRow) updateCrewRow(crewQuickRow, { staffId: created.id, workerName: created.name || name })
      setCrewQuickRow(null); setCrewQuickName('')
    } catch (err) {
      alert(err.response?.data?.message || err.message || 'Could not add worker')
    } finally {
      setCrewQuickBusy(false)
    }
  }
  function calcRowTotal(r) {
    if ((r.payType || 'day') === 'day') {
      const d = parseFloat(r.days || '1'), rate = parseFloat(r.rate)
      return !isNaN(d) && !isNaN(rate) ? (d * rate).toFixed(2) : ''
    }
    const h = parseFloat(r.hours), rate = parseFloat(r.rate)
    return !isNaN(h) && !isNaN(rate) ? (h * rate).toFixed(2) : ''
  }
  async function handleCrewSave() {
    if (!crewShowId) { alert('Pick a show first.'); return }
    const show = shows.find(s => s.id === crewShowId)
    const showName = show ? `${show.date} — ${show.artist || show.eventName}` : ''
    const valid = crewRows.filter(r => r.staffId && r.staffId !== '__new__' && r.workerName)
    if (valid.length === 0) { alert('Add at least one worker.'); return }
    setCrewSaving(true)
    try {
      for (const r of valid) {
        const payload = {
          showId: crewShowId, showName, stage: crewStage,
          staffId: r.staffId, workerName: r.workerName, role: r.role || '',
          callTime: r.callTime || '', wrapTime: r.wrapTime || '',
          payType: r.payType || 'day', days: r.days || '1', hours: r.hours || '',
          rate: r.rate || '', total: calcRowTotal(r), union: r.union || 'false', notes: '',
        }
        await api.post('/labor', payload)
      }
      await load()
      setCrewModal(false)
    } catch (err) {
      alert(err.response?.data?.message || err.message || 'Save failed')
    } finally {
      setCrewSaving(false)
    }
  }

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
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" onClick={openCrewBuilder}>+ Build Crew (per show)</button>
          <button className="btn btn-primary" onClick={openAdd}>+ Add Labor</button>
        </div>
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
                    <td className="text-muted">{e.callTime ? formatTime(e.callTime, tf) : '—'}</td>
                    <td className="text-muted">{e.wrapTime ? formatTime(e.wrapTime, tf) : '—'}</td>
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

      {crewModal && (
        <Modal
          title="Build Crew for Show"
          onClose={() => setCrewModal(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setCrewModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleCrewSave} disabled={crewSaving}>
                {crewSaving ? 'Saving…' : `Save ${crewRows.filter(r => r.staffId && r.staffId !== '__new__').length} entries`}
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
                <select value={crewShowId} onChange={e => {
                  const s = shows.find(x => x.id === e.target.value)
                  setCrewShowId(e.target.value)
                  if (s?.stage) setCrewStage(s.stage)
                }}>
                  <option value="">Select show…</option>
                  {filterShowList(shows, { showPast: showPastShows }).map(s => (
                    <option key={s.id} value={s.id}>{s.date} — {s.artist || s.eventName}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Stage</label>
                <select value={crewStage} onChange={e => setCrewStage(e.target.value)}>
                  <option value="inside">Inside Stage</option>
                  <option value="beach">Beach Stage</option>
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, margin: '8px 0', flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCrewRows(r => [...r, makeCrewRow('House Crew')])}>+ House Crew row</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCrewRows(r => [...r, makeCrewRow('Stagehand')])}>+ Stagehand row</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCrewRows(r => [...r, makeCrewRow('')])}>+ Custom row</button>
            </div>

            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    <th style={{ padding: '6px 4px', minWidth: 180 }}>Worker</th>
                    <th style={{ padding: '6px 4px', minWidth: 130 }}>Position</th>
                    <th style={{ padding: '6px 4px', width: 90 }}>Call</th>
                    <th style={{ padding: '6px 4px', width: 90 }}>Wrap</th>
                    <th style={{ padding: '6px 4px', width: 80 }}>Type</th>
                    <th style={{ padding: '6px 4px', width: 75 }}>Units</th>
                    <th style={{ padding: '6px 4px', width: 90 }}>Rate $</th>
                    <th style={{ padding: '6px 4px', width: 32 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {crewRows.map(r => (
                    <tr key={r._rid} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '6px 4px', verticalAlign: 'top' }}>
                        <select value={r.staffId || ''} onChange={e => pickCrewWorker(r._rid, e.target.value)} style={{ width: '100%' }}>
                          <option value="">— Select —</option>
                          {staff.filter(s => s.active !== 'false')
                            .slice()
                            .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
                            .map(s => (
                              <option key={s.id} value={s.id}>{s.name}{s.role ? ` — ${s.role}` : ''}</option>
                            ))}
                          <option value="__new__">+ Add new worker…</option>
                        </select>
                        {crewQuickRow === r._rid && (
                          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                            <input
                              autoFocus
                              value={crewQuickName}
                              onChange={e => setCrewQuickName(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitCrewQuickAdd() } }}
                              placeholder="New worker name"
                              style={{ flex: 1, fontSize: 12 }}
                            />
                            <button type="button" className="btn btn-primary btn-sm" onClick={commitCrewQuickAdd} disabled={crewQuickBusy} style={{ padding: '2px 8px' }}>
                              {crewQuickBusy ? '…' : 'Add'}
                            </button>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setCrewQuickRow(null); updateCrewRow(r._rid, { staffId: '' }) }} style={{ padding: '2px 6px' }}>✕</button>
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '6px 4px', verticalAlign: 'top' }}>
                        <input value={r.role} onChange={e => updateCrewRow(r._rid, { role: e.target.value })} style={{ width: '100%' }} placeholder="Position" />
                      </td>
                      <td style={{ padding: '6px 4px', verticalAlign: 'top' }}>
                        <input type="time" value={r.callTime} onChange={e => updateCrewRow(r._rid, { callTime: e.target.value })} style={{ width: '100%' }} />
                      </td>
                      <td style={{ padding: '6px 4px', verticalAlign: 'top' }}>
                        <input type="time" value={r.wrapTime} onChange={e => updateCrewRow(r._rid, { wrapTime: e.target.value })} style={{ width: '100%' }} />
                      </td>
                      <td style={{ padding: '6px 4px', verticalAlign: 'top' }}>
                        <select value={r.payType} onChange={e => updateCrewRow(r._rid, { payType: e.target.value })} style={{ width: '100%' }}>
                          <option value="day">Day</option>
                          <option value="hour">Hour</option>
                        </select>
                      </td>
                      <td style={{ padding: '6px 4px', verticalAlign: 'top' }}>
                        {r.payType === 'day'
                          ? <input type="number" step="0.5" value={r.days} onChange={e => updateCrewRow(r._rid, { days: e.target.value })} style={{ width: '100%' }} placeholder="1" />
                          : <input type="number" step="0.5" value={r.hours} onChange={e => updateCrewRow(r._rid, { hours: e.target.value })} style={{ width: '100%' }} placeholder="0" />
                        }
                      </td>
                      <td style={{ padding: '6px 4px', verticalAlign: 'top' }}>
                        <input type="number" step="0.01" value={r.rate} onChange={e => updateCrewRow(r._rid, { rate: e.target.value })} style={{ width: '100%' }} placeholder="0" />
                      </td>
                      <td style={{ padding: '6px 4px', verticalAlign: 'top', textAlign: 'center' }}>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCrewRows(rows => rows.filter(x => x._rid !== r._rid))} style={{ padding: '2px 6px' }} title="Remove row">✕</button>
                      </td>
                    </tr>
                  ))}
                  {crewRows.length === 0 && (
                    <tr><td colSpan={8}><div className="empty-state" style={{ padding: 20 }}>No rows. Use the buttons above to add some.</div></td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
              Tip: Rates auto-fill from each worker's saved Staff rate. You can override any field per row before saving.
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
