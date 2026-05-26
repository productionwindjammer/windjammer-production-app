import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { canAccess } from '../nav'

export default function ProtectedRoute({ children }) {
  const { user, effectiveRole } = useAuth()
  const location = useLocation()
  if (!user) return <Navigate to="/login" replace />
  if (!canAccess(location.pathname, effectiveRole)) return <Navigate to="/dashboard" replace />
  return children
}
