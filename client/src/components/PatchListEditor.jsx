import { useEffect, useRef, useState, useCallback } from 'react'
import api from '../api'

/**
 * PatchListEditor — spreadsheet-style editor for a show's audio patch list.
 *
 * REAL-TIME COLLABORATION
 * -----------------------
 * Multiple engineers may be editing the same list during a show. Every cell
 * edit sends PATCH /api/patch-lists/:id/cell with a small JSON payload; the
 * server serializes writes per-list and broadcasts each change over SSE so
 * every other connected editor updates within ~50ms.
 *
 * Each PATCH carries a `sourceId` unique to this browser tab; incoming
 * broadcasts whose sourceId matches ours are ignored, so we don't clobber
 * the local caret position while a user is mid-type. Text edits fire on
 * blur (not every keystroke) to keep both traffic and echo suppression
 * simple; toggles fire immediately.
 *
 * Props:
 *   patchList  — the row from /api/patch-lists (id, inputs, outputs, …)
 *   canEdit    — boolean; disables inputs when false
 *   onLocalChange(next) — invoked with the next full patchList after each
 *                        applied change so the parent can keep a fresh
 *                        reference around (e.g. for print/export).
 */

const DEFAULT_INPUT_COUNT  = 48
const DEFAULT_OUTPUT_COUNT = 16

// Random per-tab id so we can ignore echoes of our own broadcasts.
const CLIENT_SOURCE_ID = `wj-${Math.random().toString(36).slice(2, 10)}`

function parseJsonArray(raw, fallback = []) {
  if (Array.isArray(raw)) return raw
  if (!raw) return fallback
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : fallback
  } catch { return fallback }
}

function normalizeChannels(raw, defaultCount) {
  const arr = parseJsonArray(raw, [])
  const out = []
  for (let i = 0; i < Math.max(arr.length, defaultCount); i++) {
    const src = arr[i] || {}
    out.push({
      n:       src.n ?? (i + 1),
      name:    src.name    || '',
      phantom: src.phantom === true || src.phantom === 'true',
      patch:   { ...(src.patch || {}) },
    })
  }
  return out
}

export default function PatchListEditor({ patchList, canEdit, onLocalChange }) {
  const [inputs,  setInputs]  = useState(() => normalizeChannels(patchList.inputs,  DEFAULT_INPUT_COUNT))
  const [outputs, setOutputs] = useState(() => normalizeChannels(patchList.outputs, DEFAULT_OUTPUT_COUNT))
  const [inputCols,  setInputCols]  = useState(() => parseJsonArray(patchList.inputPatchPoints))
  const [outputCols, setOutputCols] = useState(() => parseJsonArray(patchList.outputPatchPoints))
  const [name,       setName]       = useState(patchList.name || '')
  const [presence,   setPresence]   = useState(1)      // # of editors online (incl. us)
  const [lastEditor, setLastEditor] = useState(null)   // { by, at } for the last remote change
  const [connected,  setConnected]  = useState(false)  // SSE stream live?
  const [saveState,  setSaveState]  = useState('idle') // 'idle' | 'saving' | 'error'

  // Keep the freshest snapshot for anyone who calls onLocalChange
  const snapshot = useRef({ inputs, outputs, inputCols, outputCols, name })
  useEffect(() => {
    snapshot.current = { inputs, outputs, inputCols, outputCols, name }
    onLocalChange?.({
      ...patchList,
      name,
      inputPatchPoints:  JSON.stringify(inputCols),
      outputPatchPoints: JSON.stringify(outputCols),
      inputs:            JSON.stringify(inputs),
      outputs:           JSON.stringify(outputs),
    })
  }, [inputs, outputs, inputCols, outputCols, name]) // eslint-disable-line

  // If the parent hands us a different patchList (e.g. user switched lists),
  // reset local state to the new server-shipped values.
  useEffect(() => {
    setInputs(normalizeChannels(patchList.inputs,  DEFAULT_INPUT_COUNT))
    setOutputs(normalizeChannels(patchList.outputs, DEFAULT_OUTPUT_COUNT))
    setInputCols(parseJsonArray(patchList.inputPatchPoints))
    setOutputCols(parseJsonArray(patchList.outputPatchPoints))
    setName(patchList.name || '')
  }, [patchList.id]) // eslint-disable-line

  // ── Server sync ───────────────────────────────────────────────────────────
  // Push a single cell update. Wrapped in useCallback so it's stable for
  // per-cell inputs. Failures show a transient "save error" pill; the local
  // state already reflects the intended value so the user isn't blocked.
  const pushCell = useCallback(async (path, value) => {
    setSaveState('saving')
    try {
      await api.patch(`/patch-lists/${patchList.id}/cell`, {
        path, value, sourceId: CLIENT_SOURCE_ID,
      })
      setSaveState('idle')
    } catch (err) {
      console.error('[patch cell]', path, err?.response?.data?.message || err.message)
      setSaveState('error')
      setTimeout(() => setSaveState(s => (s === 'error' ? 'idle' : s)), 3000)
    }
  }, [patchList.id])

  // Full-document PUT for changes that touch structure (add/remove columns).
  // Broadcasts a 'reload' event to peers, who then re-fetch this list.
  const pushFullUpdate = useCallback(async (patch) => {
    setSaveState('saving')
    try {
      await api.put(`/patch-lists/${patchList.id}`, patch)
      setSaveState('idle')
    } catch (err) {
      console.error('[patch put]', err?.response?.data?.message || err.message)
      setSaveState('error')
      setTimeout(() => setSaveState(s => (s === 'error' ? 'idle' : s)), 3000)
    }
  }, [patchList.id])

  // ── SSE subscription ──────────────────────────────────────────────────────
  // EventSource can't send Authorization headers so we pass the JWT as a
  // query param; the server accepts ?access_token= for read-only endpoints.
  useEffect(() => {
    if (!patchList.id) return
    const token = localStorage.getItem('wj_token') || ''
    const url   = `/api/patch-lists/${patchList.id}/stream?access_token=${encodeURIComponent(token)}`
    let es
    try { es = new EventSource(url) } catch { return }

    es.onopen  = () => setConnected(true)
    es.onerror = () => setConnected(false)

    es.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (!msg || !msg.type) return

      if (msg.type === 'presence') { setPresence(msg.count || 1); return }
      if (msg.type === 'reload')   {
        // Someone changed structure — refetch the whole doc.
        api.get(`/patch-lists`).then(res => {
          const fresh = (res.data.data || []).find(r => r.id === patchList.id)
          if (fresh) {
            setInputs(normalizeChannels(fresh.inputs,  DEFAULT_INPUT_COUNT))
            setOutputs(normalizeChannels(fresh.outputs, DEFAULT_OUTPUT_COUNT))
            setInputCols(parseJsonArray(fresh.inputPatchPoints))
            setOutputCols(parseJsonArray(fresh.outputPatchPoints))
            setName(fresh.name || '')
          }
        }).catch(() => {})
        return
      }
      if (msg.type === 'cell') {
        // Ignore the echo of our own change so we don't fight the caret.
        if (msg.sourceId && msg.sourceId === CLIENT_SOURCE_ID) return
        setLastEditor({ by: msg.by || 'someone', at: msg.at })
        applyRemoteCell(msg.path, msg.value)
      }
    }

    return () => { try { es.close() } catch {} setConnected(false) }
  }, [patchList.id])

  // Apply a remote cell change to local state.
  const applyRemoteCell = useCallback((path, value) => {
    const parts = path.split('.')
    if (parts[0] === 'inputs' || parts[0] === 'outputs') {
      const setFn = parts[0] === 'inputs' ? setInputs : setOutputs
      const idx   = parseInt(parts[1], 10)
      if (Number.isNaN(idx)) return
      const sub   = parts[2]
      const key   = parts.slice(3).join('.') || null
      setFn(prev => {
        const next = prev.slice()
        while (next.length <= idx) next.push({ n: next.length + 1, name: '', phantom: false, patch: {} })
        const item = { ...next[idx], patch: { ...(next[idx].patch || {}) } }
        if (sub === 'patch') { if (key) item.patch[key] = value }
        else if (sub === 'phantom') { item.phantom = value === true || value === 'true' }
        else if (sub)               { item[sub] = value }
        next[idx] = item
        return next
      })
    } else if (parts[0] === 'name') {
      setName(String(value ?? ''))
    } else if (parts[0] === 'inputPatchPoints') {
      setInputCols(Array.isArray(value) ? value : parseJsonArray(value))
    } else if (parts[0] === 'outputPatchPoints') {
      setOutputCols(Array.isArray(value) ? value : parseJsonArray(value))
    }
  }, [])

  // ── Editing helpers ───────────────────────────────────────────────────────
  function editChannel(kind, idx, sub, key, value) {
    const setFn = kind === 'inputs' ? setInputs : setOutputs
    setFn(prev => {
      const next = prev.slice()
      const item = { ...next[idx], patch: { ...(next[idx].patch || {}) } }
      if (sub === 'patch') { if (key) item.patch[key] = value }
      else if (sub === 'phantom') { item.phantom = !!value }
      else if (sub)               { item[sub] = value }
      next[idx] = item
      return next
    })
    const path = sub === 'patch' ? `${kind}.${idx}.patch.${key}` : `${kind}.${idx}.${sub}`
    pushCell(path, sub === 'phantom' ? (value ? 'true' : 'false') : value)
  }

  function addPatchColumn(kind) {
    const name = prompt(
      kind === 'input'
        ? 'Name of the new input patch point (e.g. "Stage Box A", "Sub Snake 1", "Split L"):'
        : 'Name of the new output patch point (e.g. "Amp Rack A", "Broadcast Feed"):'
    )
    if (!name?.trim()) return
    const cleaned = name.trim()
    if (kind === 'input') {
      if (inputCols.includes(cleaned)) { alert('That column already exists.'); return }
      const next = [...inputCols, cleaned]
      setInputCols(next)
      pushFullUpdate({ inputPatchPoints: JSON.stringify(next) })
    } else {
      if (outputCols.includes(cleaned)) { alert('That column already exists.'); return }
      const next = [...outputCols, cleaned]
      setOutputCols(next)
      pushFullUpdate({ outputPatchPoints: JSON.stringify(next) })
    }
  }

  function removePatchColumn(kind, colName) {
    if (!confirm(`Remove the "${colName}" column?\n\nAll patched values in that column will be lost.`)) return
    if (kind === 'input') {
      const next = inputCols.filter(c => c !== colName)
      setInputCols(next)
      // Also strip that key from every input row locally.
      setInputs(prev => prev.map(r => {
        const { [colName]: _, ...rest } = (r.patch || {})
        return { ...r, patch: rest }
      }))
      // Server-side: PUT the whole doc so removal is atomic.
      const cleanedInputs = inputs.map(r => {
        const { [colName]: _, ...rest } = (r.patch || {})
        return { ...r, patch: rest }
      })
      pushFullUpdate({
        inputPatchPoints: JSON.stringify(next),
        inputs:           JSON.stringify(cleanedInputs),
      })
    } else {
      const next = outputCols.filter(c => c !== colName)
      setOutputCols(next)
      setOutputs(prev => prev.map(r => {
        const { [colName]: _, ...rest } = (r.patch || {})
        return { ...r, patch: rest }
      }))
      const cleanedOutputs = outputs.map(r => {
        const { [colName]: _, ...rest } = (r.patch || {})
        return { ...r, patch: rest }
      })
      pushFullUpdate({
        outputPatchPoints: JSON.stringify(next),
        outputs:           JSON.stringify(cleanedOutputs),
      })
    }
  }

  function renameList(nextName) {
    setName(nextName)
    pushCell('name', nextName)
  }

  function addRow(kind) {
    const arr = kind === 'inputs' ? inputs : outputs
    const setFn = kind === 'inputs' ? setInputs : setOutputs
    const nextArr = [...arr, { n: arr.length + 1, name: '', phantom: false, patch: {} }]
    setFn(nextArr)
    // Structural change — full doc write so peers refetch.
    const patch = kind === 'inputs'
      ? { inputs:  JSON.stringify(nextArr) }
      : { outputs: JSON.stringify(nextArr) }
    pushFullUpdate(patch)
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Header: name + live status + save state */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        padding: '10px 14px', borderRadius: 8,
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={e => e.target.value !== (patchList.name || '') && renameList(e.target.value)}
          placeholder="Patch list name"
          disabled={!canEdit}
          style={{ fontSize: 15, fontWeight: 600, flex: 1, minWidth: 200 }}
        />

        <LiveBadge connected={connected} presence={presence} />
        <SaveBadge state={saveState} />

        {lastEditor?.by && (
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
            Last edit by <strong>{lastEditor.by}</strong>
          </span>
        )}
      </div>

      {/* ── Inputs table ──────────────────────────────────────────────── */}
      <PatchTable
        kind="inputs"
        rows={inputs}
        cols={inputCols}
        canEdit={canEdit}
        showPhantom
        onEdit={(idx, sub, key, val) => editChannel('inputs', idx, sub, key, val)}
        onAddColumn={() => addPatchColumn('input')}
        onRemoveColumn={(c) => removePatchColumn('input', c)}
        onAddRow={() => addRow('inputs')}
        title={`Inputs (${inputs.length})`}
        subtitle="+48V toggles phantom power. Add columns for each patch device (stage box, sub-snake, split, etc.); cells hold the channel number on that device."
      />

      {/* ── Outputs table ─────────────────────────────────────────────── */}
      <PatchTable
        kind="outputs"
        rows={outputs}
        cols={outputCols}
        canEdit={canEdit}
        showPhantom={false}
        onEdit={(idx, sub, key, val) => editChannel('outputs', idx, sub, key, val)}
        onAddColumn={() => addPatchColumn('output')}
        onRemoveColumn={(c) => removePatchColumn('output', c)}
        onAddRow={() => addRow('outputs')}
        title={`Outputs (${outputs.length})`}
        subtitle="Console outputs — typically wedge/IEM sends, sub drives, broadcast feeds. Add columns for each downstream device."
      />
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────
function LiveBadge({ connected, presence }) {
  const color = connected ? '#86efac' : '#fca5a5'
  const bg    = connected ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)'
  return (
    <span
      title={connected ? `${presence} editor${presence === 1 ? '' : 's'} online` : 'Reconnecting…'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '3px 10px', borderRadius: 12,
        background: bg, color, fontSize: 12, fontWeight: 600,
      }}
    >
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: color, boxShadow: connected ? `0 0 8px ${color}` : 'none',
      }} />
      {connected ? `LIVE · ${presence}` : 'OFFLINE'}
    </span>
  )
}

function SaveBadge({ state }) {
  if (state === 'idle') return null
  const map = {
    saving: { text: 'Saving…', color: '#fde68a', bg: 'rgba(234,179,8,0.15)' },
    error:  { text: 'Save error', color: '#fca5a5', bg: 'rgba(239,68,68,0.15)' },
  }[state]
  return (
    <span style={{
      padding: '3px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600,
      background: map.bg, color: map.color,
    }}>{map.text}</span>
  )
}

// Editable text cell that only commits on blur (so remote broadcasts don't
// interrupt the user mid-word). Uses an uncontrolled defaultValue that resyncs
// whenever the underlying `value` prop changes AND the cell is not focused.
function CellText({ value, onCommit, disabled, style, placeholder }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current) return
    if (document.activeElement === ref.current) return
    if (ref.current.value !== (value ?? '')) ref.current.value = value ?? ''
  }, [value])
  return (
    <input
      ref={ref}
      defaultValue={value ?? ''}
      placeholder={placeholder}
      disabled={disabled}
      onBlur={e => {
        const next = e.target.value
        if (next !== (value ?? '')) onCommit(next)
      }}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
      style={{
        width: '100%', background: 'transparent', border: 'none',
        color: 'inherit', font: 'inherit', padding: '6px 8px',
        outline: 'none', ...style,
      }}
    />
  )
}

function PhantomToggle({ on, onToggle, disabled }) {
  return (
    <button
      onClick={() => !disabled && onToggle(!on)}
      disabled={disabled}
      title={on ? 'Phantom power ON (+48V)' : 'Phantom power OFF'}
      style={{
        width: 26, height: 26, borderRadius: 4, cursor: disabled ? 'default' : 'pointer',
        background: on ? 'rgba(239,68,68,0.2)' : 'rgba(255,255,255,0.04)',
        border: `1px solid ${on ? 'rgba(239,68,68,0.5)' : 'rgba(255,255,255,0.15)'}`,
        color: on ? '#fca5a5' : 'rgba(255,255,255,0.3)',
        fontWeight: 700, fontSize: 14, lineHeight: 1,
      }}
    >
      {on ? '✕' : ''}
    </button>
  )
}

function PatchTable({
  kind, rows, cols, canEdit, showPhantom,
  onEdit, onAddColumn, onRemoveColumn, onAddRow,
  title, subtitle,
}) {
  const headerCellStyle = {
    padding: '8px 10px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em',
    color: 'rgba(255,255,255,0.55)', fontWeight: 600, textAlign: 'left',
    borderBottom: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.02)',
  }
  const cellStyle = {
    padding: 0, borderBottom: '1px solid rgba(255,255,255,0.05)',
    fontSize: 13,
  }
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{
        padding: '12px 14px', display: 'flex', alignItems: 'center',
        gap: 12, flexWrap: 'wrap', borderBottom: '1px solid rgba(255,255,255,0.08)',
      }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{title}</div>
          {subtitle && <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>{subtitle}</div>}
        </div>
        {canEdit && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-ghost btn-sm" onClick={onAddColumn}>+ Patch point</button>
            <button className="btn btn-ghost btn-sm" onClick={onAddRow}>+ Row</button>
          </div>
        )}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
          <thead>
            <tr>
              <th style={{ ...headerCellStyle, width: 46, textAlign: 'center' }}>Ch</th>
              <th style={{ ...headerCellStyle, minWidth: 180 }}>Name</th>
              {showPhantom && (
                <th style={{ ...headerCellStyle, width: 60, textAlign: 'center' }}>+48V</th>
              )}
              {cols.map(c => (
                <th key={c} style={{ ...headerCellStyle, minWidth: 110 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                    <span>{c}</span>
                    {canEdit && (
                      <button
                        onClick={() => onRemoveColumn(c)}
                        title={`Remove ${c} column`}
                        style={{
                          border: 'none', background: 'transparent', cursor: 'pointer',
                          color: 'rgba(255,255,255,0.35)', fontSize: 12, padding: '0 4px',
                        }}
                      >✕</button>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr key={idx}>
                <td style={{ ...cellStyle, textAlign: 'center', color: 'rgba(255,255,255,0.5)', fontVariantNumeric: 'tabular-nums' }}>
                  {row.n ?? (idx + 1)}
                </td>
                <td style={cellStyle}>
                  <CellText
                    value={row.name}
                    disabled={!canEdit}
                    placeholder={kind === 'inputs' ? 'e.g. Kick In' : 'e.g. Wedge 1'}
                    onCommit={val => onEdit(idx, 'name', null, val)}
                  />
                </td>
                {showPhantom && (
                  <td style={{ ...cellStyle, textAlign: 'center' }}>
                    <PhantomToggle
                      on={!!row.phantom}
                      disabled={!canEdit}
                      onToggle={on => onEdit(idx, 'phantom', null, on)}
                    />
                  </td>
                )}
                {cols.map(c => (
                  <td key={c} style={cellStyle}>
                    <CellText
                      value={row.patch?.[c] ?? ''}
                      disabled={!canEdit}
                      placeholder="—"
                      style={{ textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}
                      onCommit={val => onEdit(idx, 'patch', c, val)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {cols.length === 0 && (
        <div style={{
          padding: 14, textAlign: 'center',
          color: 'rgba(255,255,255,0.4)', fontSize: 12, fontStyle: 'italic',
          borderTop: '1px solid rgba(255,255,255,0.05)',
        }}>
          Click <strong>+ Patch point</strong> to add columns like "Stage Box A", "Sub Snake 1", or "Split L".
        </div>
      )}
    </div>
  )
}
