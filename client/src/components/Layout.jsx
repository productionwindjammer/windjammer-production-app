import { Outlet } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import Sidebar from './Sidebar'
import TopNav from './TopNav'
import ViewAsSwitcher from './ViewAsSwitcher'

const ROLE_LABELS = {
  admin: 'Admin',
  production_manager: 'Production Manager',
  crew: 'Crew',
  staff: 'Crew',
  tech: 'Crew',
  promoter: 'Promoter',
  venue_management: 'Venue Management',
}

export default function Layout() {
  const { user, logout, isAdmin, viewAsRole, setViewAsRole, effectiveRole } = useAuth()
  const { settings } = useSettings()
  const useTop = settings.menuPos === 'top'
  const impersonating = isAdmin && !!viewAsRole

  return (
    <>
      <header className="app-header">
        <div className="header-dot" />
        <h1>Windjammer Production</h1>
        <div className="header-right">
          <ViewAsSwitcher />
          <div className="user-chip">
            <span><strong>{user?.name}</strong></span>
            <span style={{ textTransform: 'capitalize' }}>{user?.role?.replace('_', ' ')}</span>
          </div>
          <button className="btn-logout" onClick={logout}>Sign out</button>
        </div>
      </header>
      {impersonating && (
        <div className="impersonation-banner" role="status">
          <span>
            👁️ Viewing as <strong>{ROLE_LABELS[effectiveRole] || effectiveRole}</strong>
            &nbsp;— actions still run as your admin account.
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setViewAsRole('')}>
            Exit view
          </button>
        </div>
      )}
      {useTop && <TopNav />}
      <div className="app-layout">
        {!useTop && <Sidebar />}
        <main className="main-content">
          <Outlet />
        </main>
      </div>
    </>
  )
}

