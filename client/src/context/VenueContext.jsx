import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import api from '../api'
import { useAuth } from './AuthContext'

/**
 * Venue-wide defaults (per-stage capacity + day-of-show timeline) that are
 * persisted server-side and shared across all users. Fetched once per session
 * after login; admins & production managers can update via the Settings page
 * or the manager dashboard.
 *
 * Shape:
 *   {
 *     stages: {
 *       <stageKey>: {
 *         capacity: <number>,
 *         daySheet: {
 *           default: { [itemKey]: 'HH:MM' },
 *           byDay:   { '0'..'6': { [itemKey]: 'HH:MM' } }   // 0 = Sunday
 *         }
 *       }
 *     }
 *   }
 *
 * `meta.daySheetItems` is the ordered list of `{ key, label }` for the fixed
 * day-sheet template, driven by the server.
 */

const FALLBACK_DAY_SHEET = {
  default: {
    loadIn:     '15:00',
    soundCheck: '17:00',
    doors:      '19:00',
    set1:       '20:00',
    changeover: '21:00',
    set2:       '21:30',
    curfew:     '23:00',
  },
  byDay: {},
}

const FALLBACK = {
  stages: {
    inside: { capacity: 500,  daySheet: FALLBACK_DAY_SHEET },
    beach:  { capacity: 1200, daySheet: FALLBACK_DAY_SHEET },
  },
}

const FALLBACK_ITEMS = [
  { key: 'loadIn',     label: 'Load In' },
  { key: 'soundCheck', label: 'Sound Check' },
  { key: 'doors',      label: 'Doors' },
  { key: 'set1',       label: 'Set 1' },
  { key: 'changeover', label: 'Changeover' },
  { key: 'set2',       label: 'Set 2' },
  { key: 'curfew',     label: 'Curfew / Load Out' },
]

const VenueContext = createContext(null)

export function VenueProvider({ children }) {
  const { user } = useAuth()
  const [venue, setVenue] = useState(FALLBACK)
  const [items, setItems] = useState(FALLBACK_ITEMS)
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get('/settings/venue')
      if (data?.data)  setVenue(data.data)
      if (data?.meta?.daySheetItems?.length) setItems(data.meta.daySheetItems)
      setLoaded(true)
    } catch (err) {
      // Non-fatal — keep fallback values.
      console.warn('[venue] fetch failed:', err.message)
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    if (!user) { setLoaded(false); return }
    refresh()
  }, [user, refresh])

  const save = useCallback(async (patch) => {
    const { data } = await api.put('/settings/venue', patch)
    if (data?.data) setVenue(data.data)
    return data?.data
  }, [])

  const value = useMemo(() => ({
    venue, items, loaded, refresh, save,
  }), [venue, items, loaded, refresh, save])

  return <VenueContext.Provider value={value}>{children}</VenueContext.Provider>
}

export function useVenue() {
  return useContext(VenueContext) || { venue: FALLBACK, items: FALLBACK_ITEMS, loaded: false, refresh: () => {}, save: async () => {} }
}
