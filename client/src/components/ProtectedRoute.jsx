import { Navigate, useLocation } from 'react-router-dom'
import { useEffect } from 'react'
import { useAuth, triggerLoginKickoff } from '../context/AuthContext'
import { canAccess } from '../nav'

export default function ProtectedRoute({ children }) {
  const { user, effectiveRole } = useAuth()
  const location = useLocation()
  // Background sync + bot pass whenever a signed-in user lands on a protected
  // route. Internally gated to once per 5 minutes so navigation is cheap.
  useEffect(() => { if (user) triggerLoginKickoff() }, [user])
  if (!user) return <Navigate to="/login" replace />
  if (!canAccess(location.pathname, effectiveRole)) return <Navigate to="/dashboard" replace />
  return children
}
