// Per-stage default capacities. These mirror config/server-config.js and
// represent the venue's physical limit. Individual shows can still override
// via the `capacity` field on the show row (e.g., reduced cap layouts).
export const STAGE_CAPACITIES = {
  inside: 500,
  beach:  1200,
}

export const STAGE_NAMES = {
  inside: 'Inside Stage',
  beach:  'Beach Stage',
}

/** Returns the effective capacity for a show: the show's override if set,
 *  otherwise the stage default. Returns null if neither is known. */
export function getCapacity(show) {
  if (!show) return null
  const override = Number(show.capacity)
  if (Number.isFinite(override) && override > 0) return override
  return STAGE_CAPACITIES[show.stage] ?? null
}

/** Returns { sold, capacity, pct } for a show. pct is 0–100 (or null). */
export function getTicketStats(show) {
  const capacity = getCapacity(show)
  const soldRaw  = Number(show?.ticketsSold)
  const sold     = Number.isFinite(soldRaw) && soldRaw >= 0 ? soldRaw : 0
  const pct      = capacity ? Math.min(100, Math.round((sold / capacity) * 100)) : null
  return { sold, capacity, pct }
}
