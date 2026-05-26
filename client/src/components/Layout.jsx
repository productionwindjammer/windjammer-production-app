import { Outlet } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import Sidebar from './Sidebar'
import TopNav from './TopNav'

export default function Layout() {
  const { user, logout } = useAuth()
  const { settings } = useSettings()
  const useTop = settings.menuPos === 'top'

  return (
    <>
      <header className="app-header">
        <div className="header-dot" />
        <h1>Windjammer Production</h1>
        <div className="header-right">
          <div className="user-chip">
            <span><strong>{user?.name}</strong></span>
            <span style={{ textTransform: 'capitalize' }}>{user?.role?.replace('_', ' ')}</span>
          </div>
          <button className="btn-logout" onClick={logout}>Sign out</button>
        </div>
      </header>
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

