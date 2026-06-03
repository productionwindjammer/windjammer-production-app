import axios from 'axios'

const api = axios.create({ baseURL: '/api' })

api.interceptors.request.use(config => {
  const token = localStorage.getItem('wj_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// Decode a JWT payload (no verification). Returns {} on any failure.
function decodeJwt(token) {
  try {
    const payload = token.split('.')[1]
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(json)
  } catch { return {} }
}

function tokenIsExpired(token) {
  if (!token) return true
  const { exp } = decodeJwt(token)
  if (!exp) return false
  return Date.now() / 1000 >= exp
}

api.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401) {
      // Only force a logout when the token itself is actually expired/missing.
      // Otherwise a single misbehaving endpoint (e.g. a soft probe on Settings)
      // would boot the user mid-session.
      const token = localStorage.getItem('wj_token')
      if (!token || tokenIsExpired(token)) {
        localStorage.removeItem('wj_token')
        localStorage.removeItem('wj_user')
        localStorage.removeItem('wj_last_kickoff')
        if (!location.pathname.startsWith('/login')) {
          window.location.href = '/login'
        }
      }
    }
    return Promise.reject(err)
  }
)

export default api
