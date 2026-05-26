import { NavLink } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { navForRole } from '../nav'

export default function TopNav() {
  const { effectiveRole } = useAuth()
  const items = navForRole(effectiveRole)
  return (
    <nav className="top-nav">
      {items.map(item => (
        <NavLink
          key={item.path}
          to={item.path}
          className={({ isActive }) => `top-nav-item${isActive ? ' active' : ''}`}
        >
          <span className="sidebar-icon">{item.icon}</span>
          {item.label}
        </NavLink>
      ))}
    </nav>
  )
}
