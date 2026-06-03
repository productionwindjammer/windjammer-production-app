import { createContext, useContext, useState, useCallback, useMemo } from 'react'
import api from '../api'

const AuthContext = createContext(null)

const VIEW_AS_KEY = 'wj_view_as_role'
const KICKOFF_TS_KEY = 'wj_last_kickoff'
const KICKOFF_MIN_INTERVAL_MS = 5 * 60 * 1000 // don't kick off more than once per 5 min

// Fire a background sync + bot pass. Fire-and-forget; never throws.
// Gated by a localStorage timestamp so a page refresh doesn't re-trigger.
export function triggerLoginKickoff({ force = false } = {}) {
  try {
    if (!localStorage.getItem('wj_token')) return
    if (!force) {
      const last = parseInt(localStorage.getItem(KICKOFF_TS_KEY) || '0', 10)
      if (last && Date.now() - last < KICKOFF_MIN_INTERVAL_MS) return
    }
    localStorage.setItem(KICKOFF_TS_KEY, String(Date.now()))
    api.post('/sync/login-kickoff').then(r => {
      if (r?.data?.newEmails || r?.data?.botAdvancesProcessed)
        console.log('[kickoff]', r.data)
    }).catch(err => {
      // Reset timestamp on failure so the next visit retries.
      localStorage.removeItem(KICKOFF_TS_KEY)
      console.warn('[kickoff] failed:', err?.response?.data?.message || err.message)
    })
  } catch { /* ignore */ }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('wj_user')) } catch { return null }
  })

  // Admin-only "view as" override — lets admins preview the app as any other
  // role without re-logging-in. Persisted so a page reload keeps the view.
  const [viewAsRole, setViewAsRoleState] = useState(() => {
    try { return localStorage.getItem(VIEW_AS_KEY) || '' } catch { return '' }
  })

  const setViewAsRole = useCallback(role => {
    if (role) localStorage.setItem(VIEW_AS_KEY, role)
    else      localStorage.removeItem(VIEW_AS_KEY)
    setViewAsRoleState(role || '')
  }, [])

  const login = useCallback(async (email, password) => {
    const res = await api.post('/auth/login', { email, password })
    if (res.data.success) {
      localStorage.setItem('wj_token', res.data.token)
      localStorage.setItem('wj_user', JSON.stringify(res.data.user))
      // Always reset any view-as override on a fresh login
      localStorage.removeItem(VIEW_AS_KEY)
      localStorage.removeItem(KICKOFF_TS_KEY)
      setViewAsRoleState('')
      setUser(res.data.user)
      // Kick off Gmail sync + bot extraction in the background.
      triggerLoginKickoff({ force: true })
    }
    return res.data
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem('wj_token')
    localStorage.removeItem('wj_user')
    localStorage.removeItem(VIEW_AS_KEY)
    localStorage.removeItem(KICKOFF_TS_KEY)
    setViewAsRoleState('')
    setUser(null)
  }, [])

  const isAdmin = user?.role === 'admin'
  // Only admins may impersonate. Everyone else sees their real role.
  const effectiveRole = isAdmin && viewAsRole ? viewAsRole : (user?.role || '')

  const value = useMemo(() => ({
    user, login, logout,
    isAdmin,
    viewAsRole: isAdmin ? viewAsRole : '',
    setViewAsRole,
    effectiveRole,
  }), [user, login, logout, isAdmin, viewAsRole, setViewAsRole, effectiveRole])

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
