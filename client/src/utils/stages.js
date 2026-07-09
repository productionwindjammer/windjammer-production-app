// Per-stage default capacities. These mirror config/server-config.js and
// represent the venue's physical limit. Admins can override the stage
// defaults via Settings → Venue defaults (stored server-side and exposed
// through VenueContext). Individual shows can still override via the
// `capacity` field on the show row (e.g., reduced cap layouts).
export const STAGE_CAPACITIES = {
  inside: 500,
  beach:  1200,
}

export const STAGE_NAMES = {
  inside: 'Inside Stage',
  beach:  'Beach Stage',
}

/**
 * Returns the effective capacity for a show.
 *   1. Show's per-show `capacity` override (if a positive number)
 *   2. Venue-defaults stage capacity (from VenueContext, if provided)
 *   3. Hard-coded STAGE_CAPACITIES fallback
 *   4. null
 */
export function getCapacity(show, venue) {
  if (!show) return null
  const override = Number(show.capacity)
  if (Number.isFinite(override) && override > 0) return override
  const fromVenue = Number(venue?.stages?.[show.stage]?.capacity)
  if (Number.isFinite(fromVenue) && fromVenue > 0) return fromVenue
  return STAGE_CAPACITIES[show.stage] ?? null
}

/** Returns { sold, capacity, pct } for a show. pct is 0–100 (or null). */
export function getTicketStats(show, venue) {
  const capacity = getCapacity(show, venue)
  const soldRaw  = Number(show?.ticketsSold)
  const sold     = Number.isFinite(soldRaw) && soldRaw >= 0 ? soldRaw : 0
  const pct      = capacity ? Math.min(100, Math.round((sold / capacity) * 100)) : null
  return { sold, capacity, pct }
}
