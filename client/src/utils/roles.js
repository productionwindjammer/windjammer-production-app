// Role identifiers used across the app. Keep in sync with:
//   - server.js requireRole()/crudRoutes writeRoles arrays
//   - client/src/nav.js NAV_ITEMS roles
//   - client/src/pages/Users.jsx ROLES dropdown
//   - client/src/components/ViewAsSwitcher.jsx VIEW_AS_OPTIONS
export const ROLE = {
  ADMIN:              'admin',
  PRODUCTION_MANAGER: 'production_manager',
  STAGE_MANAGER:      'stage_manager',
  VENUE_MANAGEMENT:   'venue_management',
  PROMOTER:           'promoter',
  CREW:               'crew',
  STAFF:              'staff',
  TECH:               'tech',
}

// Convenience groupings.
export const CREW_ROLES     = [ROLE.CREW, ROLE.STAFF, ROLE.TECH]
export const MANAGER_ROLES  = [ROLE.ADMIN, ROLE.PRODUCTION_MANAGER]
// Anyone who has "manager-like" duties (create shows, run advancing, build
// crew calls). Stage Manager sits in this tier but with financials hidden.
export const MANAGER_PLUS   = [ROLE.ADMIN, ROLE.PRODUCTION_MANAGER, ROLE.STAGE_MANAGER]

/**
 * Roles allowed to see monetary information (rates, totals, settlement,
 * vendor bookings, artist guarantees, labor cost columns, etc.).
 *
 * Stage Manager, Promoter, and Crew are intentionally excluded — Stage
 * Manager runs advancing/creation but never sees dollar amounts.
 */
export function hasFinancialAccess(role) {
  return role === ROLE.ADMIN
      || role === ROLE.PRODUCTION_MANAGER
      || role === ROLE.VENUE_MANAGEMENT
}

/** Can this role write to the /labor endpoint (create/edit crew calls)? */
export function canManageLabor(role) {
  return MANAGER_PLUS.includes(role)
}

/** Can this role create/edit shows? */
export function canManageShows(role) {
  return MANAGER_PLUS.includes(role) || role === ROLE.PROMOTER
}

/** Can this role write to advancing records? */
export function canManageAdvancing(role) {
  return MANAGER_PLUS.includes(role)
      || role === ROLE.PROMOTER
      || role === ROLE.VENUE_MANAGEMENT
}

/**
 * Human-readable label for a role, used in the header user chip and
 * anywhere else we display the role name.
 */
export const ROLE_LABELS = {
  [ROLE.ADMIN]:              'Admin',
  [ROLE.PRODUCTION_MANAGER]: 'Production Manager',
  [ROLE.STAGE_MANAGER]:      'Stage Manager',
  [ROLE.VENUE_MANAGEMENT]:   'Venue Management',
  [ROLE.PROMOTER]:           'Promoter',
  [ROLE.CREW]:               'Crew',
  [ROLE.STAFF]:              'Crew',
  [ROLE.TECH]:               'Crew',
}
