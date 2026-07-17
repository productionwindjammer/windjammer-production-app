// Shared navigation definitions used by both the sidebar and any future top menu.
// `roles` lists who can SEE the item. Missing/empty roles array means "everyone".
// Keep server route guards (server.js `requireRole`) in sync when changing this.

export const NAV_ITEMS = [
  { label: 'Dashboard',    path: '/dashboard',    icon: '📊' },
  { label: 'Shows',        path: '/shows',         icon: '🎭' },
  { label: 'Calendar',     path: '/calendar',      icon: '🗓️' },
  { label: 'Artists',      path: '/artists',       icon: '🎤' },
  { label: 'Advancing',    path: '/advancing',     icon: '📋', sub: true, roles: ['admin', 'production_manager', 'stage_manager', 'venue_management'] },
  { label: 'Labor',        path: '/labor',         icon: '👷', sub: true, roles: ['admin', 'production_manager', 'stage_manager'] },
  { label: 'Day of Show',  path: '/day-of-show',   icon: '📅', sub: true, roles: ['admin', 'production_manager', 'stage_manager', 'venue_management', 'crew', 'staff', 'tech'] },
  { label: 'Vendors',      path: '/vendors',       icon: '🏢', roles: ['admin', 'production_manager'] },
  { label: 'Staff',        path: '/staff',         icon: '👥', roles: ['admin', 'production_manager'] },
  { label: 'Users',        path: '/users',         icon: '🔐', roles: ['admin'] },
  { label: 'Tech Pack',    path: '/tech-pack',     icon: '📁', roles: ['admin', 'production_manager', 'stage_manager', 'venue_management', 'crew', 'staff', 'tech'] },
  { label: 'Settings',     path: '/settings',      icon: '⚙️' },
]

export function navForRole(role) {
  return NAV_ITEMS.filter(item => !item.roles || item.roles.includes(role))
}

export function canAccess(path, role) {
  const item = NAV_ITEMS.find(i => i.path === path)
  if (!item) return true
  return !item.roles || item.roles.includes(role)
}
