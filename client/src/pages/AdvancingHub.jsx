import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { ADVANCING_TABS } from '../nav'

export default function AdvancingHub() {
  const { user } = useAuth()
  const role = user?.role
  const visible = ADVANCING_TABS.filter(t => !t.roles || t.roles.includes(role))
  return (
    <div>
      <div
        className="advancing-tab-bar"
        style={{
          display: 'flex', gap: 4, flexWrap: 'wrap',
          borderBottom: '1px solid var(--border)',
          marginBottom: 16, paddingBottom: 8,
        }}
      >
        {visible.map(t => (
          <NavLink
            key={t.path || 'index'}
            end={t.path === ''}
            to={t.path ? `/advancing/${t.path}` : '/advancing'}
            className={({ isActive }) => `btn btn-sm ${isActive ? 'btn-primary' : 'btn-ghost'}`}
            style={{ textDecoration: 'none' }}
          >
            <span style={{ marginRight: 4 }}>{t.icon}</span>{t.label}
          </NavLink>
        ))}
      </div>
      <Outlet />
    </div>
  )
}
