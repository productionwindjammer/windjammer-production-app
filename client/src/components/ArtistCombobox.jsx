import { useEffect, useMemo, useRef, useState } from 'react'
import api from '../api'

// Single-flight, module-level cache so many pickers on one page don't refetch.
let cache = null
let pending = null
const subscribers = new Set()

async function loadArtists() {
  if (cache) return cache
  if (!pending) {
    pending = api.get('/artists')
      .then(r => { cache = (r.data?.data) || []; return cache })
      .catch(() => { cache = []; return cache })
      .finally(() => { pending = null })
  }
  return pending
}

function notify() { for (const fn of subscribers) fn(cache || []) }

// Call after a show create/update so the next open of the picker sees any
// newly auto-registered artists.
export function invalidateArtistCache() { cache = null; pending = null; notify() }

// Same match logic as the Artists page filter: name, aliases, agency.
function matchArtist(a, q) {
  return (
    (a.name    || '').toLowerCase().includes(q) ||
    (a.aliases || '').toLowerCase().includes(q) ||
    (a.agency  || '').toLowerCase().includes(q)
  )
}

const MAX_RESULTS = 8

export default function ArtistCombobox({
  value, onChange,
  placeholder, style, className,
  autoFocus,
  onBlur,
}) {
  const rootRef  = useRef(null)
  const inputRef = useRef(null)
  const [artists, setArtists] = useState(cache || [])
  const [open, setOpen]         = useState(false)
  const [highlight, setHi]      = useState(0)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!cache) loadArtists().then(list => setArtists(list))
    else setArtists(cache)
    subscribers.add(setArtists)
    return () => { subscribers.delete(setArtists) }
  }, [])

  useEffect(() => {
    if (!open) return
    function onDoc(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const q = String(value || '').trim().toLowerCase()

  const matches = useMemo(() => {
    const sorted = [...artists].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    if (!q) return sorted.slice(0, MAX_RESULTS)
    return sorted.filter(a => matchArtist(a, q)).slice(0, MAX_RESULTS)
  }, [artists, q])

  const hasExact = useMemo(
    () => artists.some(a => (a.name || '').trim().toLowerCase() === q),
    [artists, q]
  )
  const showCreate = q.length > 0 && !hasExact
  const optionCount = (showCreate ? 1 : 0) + matches.length

  useEffect(() => {
    if (highlight >= optionCount) setHi(Math.max(0, optionCount - 1))
  }, [optionCount, highlight])

  async function pickCreate() {
    const name = String(value || '').trim()
    if (!name || creating) return
    setCreating(true)
    try {
      const res = await api.post('/artists', { name })
      const created = res.data?.data || { id: `local-${Date.now()}`, name }
      cache = [...(cache || []), created]
      notify()
      onChange(created.name || name)
      setOpen(false)
    } catch (err) {
      alert('Could not create artist: ' + (err?.response?.data?.message || err.message))
    } finally { setCreating(false) }
  }

  function pickMatch(a) {
    onChange(a.name || '')
    setOpen(false)
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) setOpen(true)
      setHi(h => Math.min(optionCount - 1, h + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHi(h => Math.max(0, h - 1))
    } else if (e.key === 'Enter') {
      if (!open) return
      e.preventDefault()
      if (showCreate && highlight === 0) return pickCreate()
      const idx = showCreate ? highlight - 1 : highlight
      const hit = matches[idx]
      if (hit) pickMatch(hit)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        value={value || ''}
        onChange={e => { onChange(e.target.value); setOpen(true); setHi(0) }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        onBlur={onBlur}
        placeholder={placeholder}
        style={{ width: '100%', ...(style || {}) }}
        className={className}
        autoFocus={autoFocus}
        autoComplete="off"
      />
      {open && optionCount > 0 && (
        <div
          role="listbox"
          style={{
            position: 'absolute', top: '100%', left: 0, right: 0,
            zIndex: 50, marginTop: 4,
            background: 'var(--surface, #1e1f24)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 6,
            boxShadow: '0 8px 20px rgba(0,0,0,0.35)',
            maxHeight: 280, overflowY: 'auto',
          }}
        >
          {showCreate && (
            <div
              role="option"
              aria-selected={highlight === 0}
              onMouseDown={e => { e.preventDefault(); pickCreate() }}
              onMouseEnter={() => setHi(0)}
              style={{
                padding: '8px 10px', cursor: 'pointer',
                background: highlight === 0 ? 'rgba(255,255,255,0.08)' : 'transparent',
                borderBottom: matches.length ? '1px solid rgba(255,255,255,0.08)' : 'none',
                fontSize: 13,
              }}
            >
              <span style={{ color: 'var(--accent, #4ea1ff)', fontWeight: 600 }}>
                {creating ? 'Creating…' : '+ Create new artist'}
              </span>
              <span style={{ color: 'rgba(255,255,255,0.85)' }}>{' '}“{value}”</span>
            </div>
          )}
          {matches.map((a, i) => {
            const idx = (showCreate ? 1 : 0) + i
            return (
              <div
                key={a.id}
                role="option"
                aria-selected={highlight === idx}
                onMouseDown={e => { e.preventDefault(); pickMatch(a) }}
                onMouseEnter={() => setHi(idx)}
                style={{
                  padding: '8px 10px', cursor: 'pointer',
                  background: highlight === idx ? 'rgba(255,255,255,0.08)' : 'transparent',
                  fontSize: 13,
                  display: 'flex', flexDirection: 'column', gap: 2,
                }}
              >
                <span style={{ color: '#fff' }}>{a.name}</span>
                {(a.agency || a.aliases) && (
                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
                    {[a.agency, a.aliases].filter(Boolean).join(' · ')}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
