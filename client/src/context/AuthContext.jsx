import { createContext, useContext, useState, useCallback, useMemo } from 'react'
import api from '../api'

const AuthContext = createContext(null)

const VIEW_AS_KEY = 'wj_view_as_role'

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
      setViewAsRoleState('')
      setUser(res.data.user)
    }
    return res.data
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem('wj_token')
    localStorage.removeItem('wj_user')
    localStorage.removeItem(VIEW_AS_KEY)
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
