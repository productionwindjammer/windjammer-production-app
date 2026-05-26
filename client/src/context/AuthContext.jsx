import { createContext, useContext, useState, useCallback } from 'react'
import api from '../api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('wj_user')) } catch { return null }
  })

  const login = useCallback(async (email, password) => {
    const res = await api.post('/auth/login', { email, password })
    if (res.data.success) {
      localStorage.setItem('wj_token', res.data.token)
      localStorage.setItem('wj_user', JSON.stringify(res.data.user))
      setUser(res.data.user)
    }
    return res.data
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem('wj_token')
    localStorage.removeItem('wj_user')
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider value={{ user, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
