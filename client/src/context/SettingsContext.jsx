import { createContext, useContext, useEffect, useState, useCallback } from 'react'

/**
 * User-level UI preferences persisted in localStorage and reflected onto
 * <html data-theme="…" data-menu="…"> so CSS can style everything.
 * These are per-browser, not synced server-side — a user can have desktop
 * layout on their laptop and mobile layout on their phone simultaneously.
 */
const DEFAULTS = {
  theme:    'dark',   // 'dark' | 'light'
  menuPos:  'side',   // 'side' | 'top'
  density:  'comfortable', // 'comfortable' | 'compact'
  landing:  '/dashboard',  // default route after login
  timeFormat: '12h',       // '12h' | '24h' — applies to all displayed/outbound times
  // 'auto'  → follow viewport width (mobile styles under 720px)
  // 'on'    → force the mobile layout regardless of viewport (great when
  //           a user prefers the phone-style chrome on a tablet or wants
  //           to work on their laptop with the mobile navigation)
  // 'off'   → force desktop layout even on narrow screens
  mobileMode: 'auto',
}

const STORAGE_KEY = 'wj_settings'

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

function applyToDom(s) {
  const root = document.documentElement
  root.setAttribute('data-theme',   s.theme)
  root.setAttribute('data-menu',    s.menuPos)
  root.setAttribute('data-density', s.density)
  // Explicit override wins; 'auto' clears the attribute so the media
  // query is the only thing deciding mobile-vs-desktop at that point.
  if (s.mobileMode === 'on')       root.setAttribute('data-mobile', 'true')
  else if (s.mobileMode === 'off') root.setAttribute('data-mobile', 'false')
  else                             root.removeAttribute('data-mobile')
}

const SettingsContext = createContext(null)

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(readStored)

  useEffect(() => {
    applyToDom(settings)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  }, [settings])

  const update = useCallback((patch) => {
    setSettings(prev => ({ ...prev, ...patch }))
  }, [])

  const reset = useCallback(() => setSettings({ ...DEFAULTS }), [])

  return (
    <SettingsContext.Provider value={{ settings, update, reset }}>
      {children}
    </SettingsContext.Provider>
  )
}

export function useSettings() {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used inside <SettingsProvider>')
  return ctx
}

// Apply persisted settings immediately at module load so first paint is correct.
if (typeof document !== 'undefined') applyToDom(readStored())
