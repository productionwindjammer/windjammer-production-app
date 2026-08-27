// Shared navigation definitions used by both the sidebar and any future top menu.
// `roles` lists who can SEE the item. Missing/empty roles array means "everyone".
// Keep server route guards (server.js `requireRole`) in sync when changing this.

export const NAV_ITEMS = [
  { label: 'Dashboard',    path: '/dashboard',    icon: '📊' },
  { label: 'Shows',        path: '/shows',         icon: '🎭' },
  { label: 'Events',       path: '/events',        icon: '🎪', sub: true, roles: ['admin', 'production_manager', 'stage_manager', 'venue_management'] },
  { label: 'Calendar',     path: '/calendar',      icon: '🗓️' },
  { label: 'Artists',      path: '/artists',       icon: '🎤' },
  { label: 'Advancing',    path: '/advancing',     icon: '📋', sub: true, roles: ['admin', 'production_manager', 'stage_manager', 'venue_management'] },
  { label: 'Labor',        path: '/labor',         icon: '👷', sub: true, roles: ['admin', 'production_manager', 'stage_manager'] },
  { label: 'Financials',   path: '/financials',    icon: '💰', sub: true, roles: ['admin', 'production_manager'] },
  { label: 'Budgets',      path: '/budgets',       icon: '📊', sub: true, roles: ['admin', 'production_manager'] },
  { label: 'Maintenance',  path: '/maintenance',   icon: '🛠️', sub: true, roles: ['admin', 'production_manager', 'stage_manager'] },
  { label: 'Day of Show',  path: '/day-of-show',   icon: '📅', sub: true, roles: ['admin', 'production_manager', 'stage_manager', 'venue_management', 'crew', 'staff', 'tech'] },
  { label: 'Vendors',      path: '/vendors',       icon: '🏢', roles: ['admin', 'production_manager'] },
  { label: 'Staff',        path: '/staff',         icon: '👥', roles: ['admin', 'production_manager'] },
  { label: 'Users',        path: '/users',         icon: '🔐', roles: ['admin', 'production_manager'] },
  { label: 'Tech Pack',    path: '/tech-pack',     icon: '📁', roles: ['admin', 'production_manager', 'stage_manager', 'venue_management', 'crew', 'staff', 'tech'] },
  { label: 'Email',        path: '/email',         icon: '✉️', roles: ['admin', 'production_manager', 'stage_manager'] },
  { label: 'Settings',     path: '/settings',      icon: '⚙️' },
]

// Sub-tabs shown inside the Advancing hub. Role gating mirrors the former
// top-level entries so users can't reach a page via URL that they couldn't see.
export const ADVANCING_TABS = [
  { path: '',                   label: 'Overview',           icon: '📋', roles: ['admin', 'production_manager', 'stage_manager', 'venue_management'] },
  { path: 'advancement',        label: 'Advancement',        icon: '🎯', roles: ['admin', 'production_manager', 'stage_manager'] },
  { path: 'advance-intel',      label: 'Advance Intel',      icon: '🤖', roles: ['admin', 'production_manager'] },
  { path: 'email-intel',        label: 'Email Intel',        icon: '🧠', roles: ['admin', 'production_manager', 'stage_manager'] },
  { path: 'email-templates',    label: 'Email Templates',    icon: '📝', roles: ['admin', 'production_manager'] },
  { path: 'venue-intel',        label: 'Venue Intel',        icon: '🏛️', roles: ['admin', 'production_manager', 'venue_management', 'stage_manager'] },
  { path: 'knowledge-review',   label: 'Knowledge Review',   icon: '🔎', roles: ['admin', 'production_manager'] },
  { path: 'industry-knowledge', label: 'Industry Knowledge', icon: '📚', roles: ['admin', 'production_manager', 'venue_management', 'stage_manager'] },
]

export function navForRole(role) {
  return NAV_ITEMS.filter(item => !item.roles || item.roles.includes(role))
}

export function canAccess(path, role) {
  const item = NAV_ITEMS.find(i => i.path === path)
  if (item) return !item.roles || item.roles.includes(role)
  // Advancing hub sub-paths — gate by the tab's roles.
  const m = /^\/advancing\/([^/?#]+)/.exec(path)
  if (m) {
    const tab = ADVANCING_TABS.find(t => t.path === m[1])
    if (tab) return !tab.roles || tab.roles.includes(role)
  }
  return true
}
