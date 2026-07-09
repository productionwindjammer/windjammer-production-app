import { useEffect, useMemo, useState } from 'react'
import { useVenue } from '../context/VenueContext'
import { STAGE_NAMES } from '../utils/stages'

/**
 * Admin / production-manager card for editing venue-wide defaults. Each
 * stage owns its own capacity + day-sheet times (default row plus optional
 * per-day-of-week overrides).
 *
 * Show-level fields (per-show `capacity`, `doorsTime`, `showTime`) always
 * take priority over anything set here. Existing shows keep the times that
 * were seeded when they were created; these defaults only affect new shows.
 *
 * Rendered from both /settings and the production-manager dashboard.
 */

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export default function VenueDefaultsCard({ compact = false } = {}) {
  const { venue, items, refresh, save } = useVenue()
  const stageKeys = useMemo(() => Object.keys(venue.stages || {}), [venue])
  const [activeStage, setActiveStage] = useState(stageKeys[0] || 'inside')
  const [stages, setStages]           = useState({}) // { [key]: { capacity, daySheet: { default, byDay } } }
  const [saving, setSaving]           = useState(false)
  const [msg, setMsg]                 = useState(null)
  const [showDayCols, setShowDayCols] = useState(false)

  // Snapshot server state into local editable form on every venue update.
  useEffect(() => {
    setStages(clone(venue.stages || {}))
    const anyOverrides = Object.values(venue.stages || {})
      .some(s => Object.keys(s?.daySheet?.byDay || {}).length > 0)
    if (anyOverrides) setShowDayCols(true)
  }, [venue])

  // Keep the active tab valid if stage keys change.
  useEffect(() => {
    if (!activeStage && stageKeys.length) setActiveStage(stageKeys[0])
    else if (activeStage && !stageKeys.includes(activeStage) && stageKeys.length) {
      setActiveStage(stageKeys[0])
    }
  }, [stageKeys, activeStage])

  const stage = stages[activeStage] || { capacity: '', daySheet: { default: {}, byDay: {} } }

  function patchStage(patch) {
    setStages(prev => ({
      ...prev,
      [activeStage]: { ...(prev[activeStage] || {}), ...patch },
    }))
  }
  function patchDaySheet(patch) {
    setStages(prev => {
      const cur = prev[activeStage] || { daySheet: { default: {}, byDay: {} } }
      return {
        ...prev,
        [activeStage]: {
          ...cur,
          daySheet: { ...(cur.daySheet || {}), ...patch },
        },
      }
    })
  }
  function setStageCap(val) {
    patchStage({ capacity: val === '' ? '' : Number(val) })
  }
  function setDefaultTime(itemKey, val) {
    patchDaySheet({ default: { ...(stage.daySheet?.default || {}), [itemKey]: val } })
  }
  function setDayTime(dow, itemKey, val) {
    const byDay = { ...(stage.daySheet?.byDay || {}) }
    const cur = { ...(byDay[dow] || {}) }
    if (val) cur[itemKey] = val
    else delete cur[itemKey]
    if (Object.keys(cur).length) byDay[dow] = cur
    else delete byDay[dow]
    patchDaySheet({ byDay })
  }
  function clearDay(dow) {
    const byDay = { ...(stage.daySheet?.byDay || {}) }
    delete byDay[dow]
    patchDaySheet({ byDay })
  }

  async function handleSave() {
    setSaving(true); setMsg(null)
    try {
      // Only send positive capacities; blanks fall back on the server.
      const stagesOut = {}
      for (const [k, v] of Object.entries(stages)) {
        const cap = Number(v?.capacity)
        const stageOut = {
          daySheet: {
            default: v?.daySheet?.default || {},
            byDay:   v?.daySheet?.byDay   || {},
          },
        }
        if (Number.isFinite(cap) && cap > 0) stageOut.capacity = cap
        stagesOut[k] = stageOut
      }
      await save({ stages: stagesOut })
      setMsg({ kind: 'ok', text: 'Venue defaults saved.' })
    } catch (err) {
      setMsg({ kind: 'err', text: err.response?.data?.message || err.message })
    } finally { setSaving(false) }
  }

  async function handleReset() {
    if (!confirm('Reload the current server values and discard your unsaved changes?')) return
    await refresh()
    setMsg(null)
  }

  return (
    <div className="card">
      <div className="card-header"><div className="card-title">Venue defaults</div></div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
        Every stage keeps its own capacity and day-sheet times. A show’s own
        <code style={{ margin: '0 3px' }}>capacity</code>,
        <code style={{ margin: '0 3px' }}>doorsTime</code>, and
        <code style={{ margin: '0 3px' }}>showTime</code> fields always win
        when they’re filled in.
      </div>

      {/* Stage tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 14, flexWrap: 'wrap' }}>
        {stageKeys.map(k => {
          const active = k === activeStage
          return (
            <button
              key={k} type="button" onClick={() => setActiveStage(k)}
              style={{
                background: active ? 'rgba(59,130,246,0.18)' : 'transparent',
                color: active ? 'var(--accent)' : 'var(--text-muted)',
                border: `1px solid ${active ? 'rgba(59,130,246,0.45)' : 'var(--border)'}`,
                borderRadius: 7, padding: '7px 14px', fontSize: 13,
                fontWeight: active ? 600 : 500, cursor: 'pointer',
              }}
            >
              {STAGE_NAMES[k] || k}
            </button>
          )
        })}
      </div>

      {/* Capacity */}
      <div style={{ marginBottom: 20, maxWidth: 240 }}>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 5 }}>
          {STAGE_NAMES[activeStage] || activeStage} capacity
        </label>
        <input
          className="input" type="number" min={1} step={1}
          value={stage.capacity ?? ''}
          onChange={e => setStageCap(e.target.value)}
        />
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
          Default max attendance for this stage.
        </div>
      </div>

      {/* Day-sheet times */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontWeight: 600 }}>
          {STAGE_NAMES[activeStage] || activeStage} — day-sheet default times
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={showDayCols}
            onChange={e => setShowDayCols(e.target.checked)}
          />
          Set different times per day of week
        </label>
      </div>

      <div style={{ overflowX: 'auto', marginBottom: 14 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--text-muted)' }}>
              <th style={{ padding: '6px 8px', minWidth: 140 }}>Item</th>
              <th style={{ padding: '6px 8px', minWidth: 110 }}>Default</th>
              {showDayCols && DOW_LABELS.map((d, i) => (
                <th key={i} style={{ padding: '6px 8px', minWidth: 110, textAlign: 'center' }}>
                  {d}
                  {stage.daySheet?.byDay?.[String(i)] && (
                    <button
                      type="button"
                      title="Clear this day's overrides"
                      onClick={() => clearDay(String(i))}
                      style={{ marginLeft: 6, background: 'transparent', border: 'none',
                               color: 'var(--danger)', cursor: 'pointer', fontSize: 12 }}
                    >×</button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map(it => (
              <tr key={it.key} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '6px 8px', color: 'var(--text)' }}>{it.label}</td>
                <td style={{ padding: '6px 8px' }}>
                  <input
                    className="input" type="time"
                    value={stage.daySheet?.default?.[it.key] || ''}
                    onChange={e => setDefaultTime(it.key, e.target.value)}
                    style={{ minWidth: 100 }}
                  />
                </td>
                {showDayCols && DOW_LABELS.map((_, i) => (
                  <td key={i} style={{ padding: '6px 8px' }}>
                    <input
                      className="input" type="time"
                      value={stage.daySheet?.byDay?.[String(i)]?.[it.key] || ''}
                      placeholder={stage.daySheet?.default?.[it.key] || ''}
                      onChange={e => setDayTime(String(i), it.key, e.target.value)}
                      style={{ minWidth: 100 }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save venue defaults'}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={handleReset} disabled={saving}>
          Reload from server
        </button>
      </div>
      {msg && (
        <div style={{
          marginTop: 10, fontSize: 12,
          padding: '7px 10px', borderRadius: 6,
          background: msg.kind === 'ok' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
          color: msg.kind === 'ok' ? '#4ade80' : '#fca5a5',
          border: `1px solid ${msg.kind === 'ok' ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)'}`,
        }}>{msg.text}</div>
      )}
      {!compact && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10 }}>
          Existing shows keep whatever times were seeded when they were created.
          These defaults only affect shows added from now on (and any that haven’t
          seeded a day sheet yet).
        </div>
      )}
    </div>
  )
}

// Small deep-clone helper — venue.stages is always plain JSON so this is safe.
function clone(v) { return JSON.parse(JSON.stringify(v)) }
