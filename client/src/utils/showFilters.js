// Shared helpers for filtering/sorting shows consistently across views.
// Default rule: shows whose date is before today are hidden unless the
// user opts in via the "Show all (incl. past)" toggle.

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
