// Shared helpers for filtering/sorting shows consistently across views.
// Default rule: shows whose date is before today are hidden unless the
// user opts in via the "Show all (incl. past)" toggle.

// Status marker meaning "the production team is not involved with this show"
// (e.g. venue-only rental, external promoter handling their own crew).
// Hidden from production dashboards/calendars alongside cancelled shows.
export const NO_PRODUCTION_STATUS = 'no_production'

export function isProductionActive(show) {
  const s = (show?.status || '').toLowerCase()
  return s !== 'cancelled' && s !== NO_PRODUCTION_STATUS
}

export function isUpcoming(show, today = startOfToday()) {
  if (!show?.date) return true // no date = always show
  const d = new Date(show.date + 'T12:00:00')
  if (isNaN(d)) return true
  return d >= today
}

export function startOfToday() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

// Returns shows filtered by past/upcoming and sorted by date (asc).
// When showPast=true, all shows are returned (no date filter).
export function filterShowList(shows, { showPast = false } = {}) {
  const today = startOfToday()
  const filtered = showPast
    ? [...shows]
    : shows.filter(s => isUpcoming(s, today))
  return filtered.sort((a, b) => {
    const da = a.date || ''
    const db = b.date || ''
    return da.localeCompare(db)
  })
}
