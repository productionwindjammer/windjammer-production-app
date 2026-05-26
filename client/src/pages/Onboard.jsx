import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import api from '../api'
import { useAuth } from '../context/AuthContext'

const EMPTY_RATE = { role: '', payType: 'day', rate: '' }

export default function Onboard() {
  const { token } = useParams()
  const navigate = useNavigate()
  const auth = useAuth()

  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [prefill, setPrefill] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone]       = useState(false)

  const [form, setForm] = useState({
    password: '',
    confirm:  '',
    phone:    '',
    address:  '',
    emergencyContactName: '',
    emergencyContactPhone: '',
    emergencyContactRelation: '',
    tshirtSize: 'L',
    stage:     'both',
    department:'',
    role:      '',
    rates:     [ { ...EMPTY_RATE } ],
  })

  useEffect(() => {
    let alive = true
    api.get(`/onboard/${token}`)
      .then(res => {
        if (!alive) return
        if (!res.data.success) { setError(res.data.message || 'Invalid invite link'); return }
        setPrefill(res.data.prefill)
        setForm(f => ({
          ...f,
          phone:      res.data.prefill.phone || '',
          department: res.data.prefill.department || '',
          stage:      res.data.prefill.stage || 'both',
          role:       res.data.prefill.role || '',
        }))
      })
      .catch(err => setError(err.response?.data?.message || 'Invalid invite link'))
      .finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [token])

  function update(field, value) { setForm(f => ({ ...f, [field]: value })) }
  function updateRate(i, field, value) {
    setForm(f => ({ ...f, rates: f.rates.map((r, idx) => idx === i ? { ...r, [field]: value } : r) }))
  }
  function addRate()     { setForm(f => ({ ...f, rates: [...f.rates, { ...EMPTY_RATE }] })) }
  function removeRate(i) { setForm(f => ({ ...f, rates: f.rates.filter((_, idx) => idx !== i) })) }

  async function submit(e) {
    e.preventDefault()
    setError('')
    if (form.password.length < 8)                   { setError('Password must be at least 8 characters.'); return }
    if (form.password !== form.confirm)             { setError('Passwords do not match.'); return }
    if (!form.phone)                                { setError('Please enter a phone number.'); return }
    if (!form.emergencyContactName || !form.emergencyContactPhone) {
      setError('Please add an emergency contact (name + phone).'); return
    }
    setSubmitting(true)
    try {
      const cleanRates = form.rates
        .filter(r => r.role && r.rate)
        .map(r => ({ role: r.role.trim(), payType: r.payType, rate: Number(r.rate) || 0 }))
      const res = await api.post(`/onboard/${token}`, {
        password: form.password,
        phone: form.phone,
        address: form.address,
        emergencyContactName: form.emergencyContactName,
        emergencyContactPhone: form.emergencyContactPhone,
        emergencyContactRelation: form.emergencyContactRelation,
        tshirtSize: form.tshirtSize,
        stage: form.stage,
        department: form.department,
        role: form.role,
        rates: cleanRates,
      })
      if (!res.data.success) { setError(res.data.message || 'Could not complete onboarding.'); return }
      // Sign the new user in.
      localStorage.setItem('wj_token', res.data.token)
      localStorage.setItem('wj_user',  JSON.stringify(res.data.user))
      if (auth?.user !== undefined) {
        // Best-effort context update; if AuthProvider exposes setUser via login() only,
        // we still rely on localStorage and a navigate() to trigger a re-mount.
      }
      setDone(true)
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Could not complete onboarding.')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <Wrap><p>Loading your invite…</p></Wrap>
  if (error && !prefill) return <Wrap><h2>Invite Problem</h2><p style={{ color: '#b91c1c' }}>{error}</p></Wrap>

  if (done) {
    return (
      <Wrap>
        <h1 style={{ margin: '0 0 8px' }}>You're all set, {prefill.name?.split(' ')[0] || 'welcome'}!</h1>
        <p>Your account is ready. You can head straight to the dashboard, or install Windjammer on your devices first.</p>
        <InstallInstructions />
        <button
          onClick={() => { window.location.href = '/dashboard' }}
          style={btnPrimary}
        >
          Go to Dashboard →
        </button>
      </Wrap>
    )
  }

  return (
    <Wrap>
      <h1 style={{ margin: '0 0 4px' }}>Welcome, {prefill.name?.split(' ')[0] || ''}</h1>
      <p style={{ color: '#475569', margin: '0 0 20px' }}>
        Finish setting up your Windjammer Production account ({prefill.email}).
      </p>

      <form onSubmit={submit}>
        <Section title="1. Set Your Password">
          <Row>
            <Field label="New password (min 8 chars)">
              <input type="password" value={form.password} onChange={e => update('password', e.target.value)} style={input} required />
            </Field>
            <Field label="Confirm password">
              <input type="password" value={form.confirm} onChange={e => update('confirm', e.target.value)} style={input} required />
            </Field>
          </Row>
        </Section>

        <Section title="2. Contact Info">
          <Row>
            <Field label="Phone">
              <input value={form.phone} onChange={e => update('phone', e.target.value)} style={input} required />
            </Field>
            <Field label="T-Shirt Size">
              <select value={form.tshirtSize} onChange={e => update('tshirtSize', e.target.value)} style={input}>
                {['XS','S','M','L','XL','2XL','3XL'].map(s => <option key={s}>{s}</option>)}
              </select>
            </Field>
          </Row>
          <Field label="Address">
            <textarea value={form.address} onChange={e => update('address', e.target.value)} style={{ ...input, minHeight: 60 }} />
          </Field>
        </Section>

        <Section title="3. Emergency Contact">
          <Row>
            <Field label="Name"><input value={form.emergencyContactName} onChange={e => update('emergencyContactName', e.target.value)} style={input} required /></Field>
            <Field label="Phone"><input value={form.emergencyContactPhone} onChange={e => update('emergencyContactPhone', e.target.value)} style={input} required /></Field>
            <Field label="Relationship"><input value={form.emergencyContactRelation} onChange={e => update('emergencyContactRelation', e.target.value)} style={input} placeholder="Spouse, parent…" /></Field>
          </Row>
        </Section>

        <Section title="4. Role & Stage">
          <Row>
            <Field label="Preferred Role">
              <input value={form.role} onChange={e => update('role', e.target.value)} style={input} placeholder="Stagehand, A1, LD…" />
            </Field>
            <Field label="Department">
              <input value={form.department} onChange={e => update('department', e.target.value)} style={input} placeholder="Audio, Lighting, Production…" />
            </Field>
            <Field label="Stage">
              <select value={form.stage} onChange={e => update('stage', e.target.value)} style={input}>
                <option value="inside">Inside</option>
                <option value="beach">Beach</option>
                <option value="both">Both</option>
              </select>
            </Field>
          </Row>
        </Section>

        <Section title="5. Pay Rates" subtitle="Add a rate for each position you work. Leave blank if unsure — an admin can fill these in later.">
          {form.rates.map((r, i) => (
            <Row key={i}>
              <Field label={i === 0 ? 'Position' : ''}>
                <input value={r.role} onChange={e => updateRate(i, 'role', e.target.value)} style={input} placeholder="Stagehand" />
              </Field>
              <Field label={i === 0 ? 'Pay Type' : ''}>
                <select value={r.payType} onChange={e => updateRate(i, 'payType', e.target.value)} style={input}>
                  <option value="day">Day Rate</option>
                  <option value="hour">Hourly</option>
                </select>
              </Field>
              <Field label={i === 0 ? 'Amount ($)' : ''}>
                <input type="number" value={r.rate} onChange={e => updateRate(i, 'rate', e.target.value)} style={input} />
              </Field>
              <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                <button type="button" onClick={() => removeRate(i)} style={btnGhost} disabled={form.rates.length === 1}>×</button>
              </div>
            </Row>
          ))}
          <button type="button" onClick={addRate} style={btnGhost}>+ Add another position</button>
        </Section>

        {error && <p style={{ color: '#b91c1c', margin: '12px 0' }}>{error}</p>}

        <button type="submit" disabled={submitting} style={btnPrimary}>
          {submitting ? 'Finishing up…' : 'Finish & Sign In'}
        </button>
      </form>
    </Wrap>
  )
}

function InstallInstructions() {
  const appUrl = window.location.origin
  return (
    <div style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', borderRadius: 12, padding: 20, margin: '20px 0' }}>
      <h3 style={{ margin: '0 0 10px' }}>📲 Get the Windjammer app on your devices</h3>
      <p style={{ margin: '0 0 10px' }}>
        Access Windjammer any time at <a href={appUrl}>{appUrl}</a>. For a native app feel, install it:
      </p>
      <ul style={{ margin: 0, paddingLeft: 22, lineHeight: 1.7 }}>
        <li><strong>iPhone / iPad:</strong> Open in Safari → tap <em>Share</em> → <em>Add to Home Screen</em>.</li>
        <li><strong>Android:</strong> Open in Chrome → tap the ⋮ menu → <em>Install app</em>.</li>
        <li><strong>Desktop (Chrome / Edge):</strong> Click the install icon (⊕) in the address bar, or ⋮ menu → <em>Install Windjammer</em>.</li>
      </ul>
      <p style={{ color: '#64748b', fontSize: 13, marginTop: 10, marginBottom: 0 }}>
        No app store needed — installs in seconds.
      </p>
    </div>
  )
}

// ── tiny presentational helpers ──────────────────────────────────────────────
function Wrap({ children }) {
  return (
    <div style={{ height: '100vh', overflowY: 'auto', WebkitOverflowScrolling: 'touch', background: '#0f172a', padding: '40px 20px', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', background: '#fff', borderRadius: 16, padding: 32, boxShadow: '0 10px 30px rgba(0,0,0,0.2)' }}>
        {children}
      </div>
    </div>
  )
}
function Section({ title, subtitle, children }) {
  return (
    <div style={{ margin: '24px 0', paddingTop: 16, borderTop: '1px solid #e2e8f0' }}>
      <h3 style={{ margin: '0 0 4px' }}>{title}</h3>
      {subtitle && <p style={{ color: '#64748b', margin: '0 0 12px', fontSize: 14 }}>{subtitle}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
    </div>
  )
}
function Row({ children }) {
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(${children.length || 1}, 1fr)`, gap: 12 }}>{children}</div>
}
function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: '#334155', fontWeight: 600 }}>
      {label}{children}
    </label>
  )
}
const input = { padding: '10px 12px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 14, fontWeight: 400 }
const btnPrimary = { padding: '12px 24px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 8, fontSize: 16, fontWeight: 600, cursor: 'pointer' }
const btnGhost   = { padding: '8px 14px', background: 'transparent', color: '#475569', border: '1px solid #cbd5e1', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }
