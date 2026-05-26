import { NavLink } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { navForRole } from '../nav'
import InstallApp from './InstallApp'

export default function Sidebar() {
  const { user } = useAuth()
  const items = navForRole(user?.role)
  return (
    <nav className="sidebar">
      <div className="sidebar-brand">
        <img src="/windjammer-logo.png" alt="The Windjammer" className="sidebar-logo" />
        <p>Production Management</p>
      </div>
      <div className="sidebar-section-label">Navigation</div>
      {items.map(item => (
        <NavLink
          key={item.path}
          to={item.path}
          className={({ isActive }) => `sidebar-item${isActive ? ' active' : ''}${item.sub ? ' sidebar-sub' : ''}`}
        >
          <span className="sidebar-icon">{item.icon}</span>
          {item.label}
        </NavLink>
      ))}
      <div className="sidebar-footer">
        <InstallApp />
      </div>
    </nav>
  )
}
