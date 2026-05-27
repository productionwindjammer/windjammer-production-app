import { createContext, useContext, useEffect, useState, useCallback } from 'react'

// Lightweight global state for the split-screen shell.
// - enabled: whether the right pane is visible
// - rightPath: which route the right pane is showing (rendered in a same-origin iframe)
// - ratio: 0..1 width fraction for the LEFT pane
// Persisted to localStorage so the layout survives reloads.

const STORAGE_KEY = 'wj_split'
const DEFAULTS = { enabled: false, rightPath: '/calendar', ratio: 0.5 }

function read() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch { return { ...DEFAULTS } }
}

const SplitContext = createContext(null)

export function SplitProvider({ children }) {
  const [state, setState] = useState(read)

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch {}
  }, [state])

  const toggle      = useCallback(() => setState(s => ({ ...s, enabled: !s.enabled })), [])
  const setEnabled  = useCallback(v => setState(s => ({ ...s, enabled: !!v })), [])
  const setRightPath = useCallback(p => setState(s => ({ ...s, rightPath: p })), [])
  const setRatio    = useCallback(r => setState(s => ({ ...s, ratio: Math.min(0.85, Math.max(0.15, r)) })), [])

  const popout = useCallback((path) => {
    const w = Math.min(1100, Math.floor(window.screen.availWidth * 0.5))
    const h = Math.floor(window.screen.availHeight * 0.9)
    const left = window.screen.availWidth - w
    window.open(path, '_blank', `width=${w},height=${h},left=${left},top=0,noopener=no`)
  }, [])

  return (
    <SplitContext.Provider value={{ ...state, toggle, setEnabled, setRightPath, setRatio, popout }}>
      {children}
    </SplitContext.Provider>
  )
}

export function useSplit() {
  const v = useContext(SplitContext)
  if (!v) throw new Error('useSplit must be used within SplitProvider')
  return v
}

// True when this window is rendered inside another window (i.e. it's the right
// pane of a split view). Used by Layout to hide chrome.
export function isEmbedded() {
  try { return window.self !== window.top } catch { return true }
}
