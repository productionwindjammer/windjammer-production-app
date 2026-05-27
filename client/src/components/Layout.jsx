import { Outlet } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { useLocation } from 'react-router-dom'
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
  const [mobileOpen, setMobileOpen] = useState(false)
  const location = useLocation()

  // Close the mobile drawer on every route change
  useEffect(() => { setMobileOpen(false) }, [location.pathname])

  return (
    <>
      <header className="app-header">
        {!useTop && (
          <button
            type="button"
            className="mobile-menu-btn"
            aria-label="Open navigation"
            onClick={() => setMobileOpen(true)}
          >
            ☰
          </button>
        )}
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
        {!useTop && (
          <>
            <div
              className={'mobile-nav-overlay' + (mobileOpen ? ' open' : '')}
              onClick={() => setMobileOpen(false)}
            />
            <div className={mobileOpen ? 'sidebar-wrapper open' : 'sidebar-wrapper'}>
              <Sidebar className={mobileOpen ? 'open' : ''} />
            </div>
          </>
        )}
        <main className="main-content">
          <Outlet />
        </main>
      </div>
    </>
  )
}


