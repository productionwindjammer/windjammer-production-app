// Time formatting helpers.
//
// We always STORE times as 24-hour "HH:MM" strings (what <input type="time">
// gives us). For DISPLAY we honor the user's preference from Settings —
// default is 12-hour with AM/PM. Everything that goes to a printed day
// sheet, email, or any view that workers see should run through formatTime().

/**
 * Convert a stored "HH:MM" (or "HH:MM:SS") value to a display string.
 * Returns the original input unchanged if it doesn't look like a time.
 *
 * @param {string} value  e.g. "14:30"
 * @param {'12h'|'24h'} mode
 */
export function formatTime(value, mode = '12h') {
  if (!value) return ''
  const m = String(value).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/)
  if (!m) return value
  let h = parseInt(m[1], 10)
  const min = m[2]
  if (isNaN(h) || h < 0 || h > 23) return value
  if (mode === '24h') return `${String(h).padStart(2, '0')}:${min}`
  const period = h >= 12 ? 'PM' : 'AM'
  let h12 = h % 12
  if (h12 === 0) h12 = 12
  return `${h12}:${min} ${period}`
}

// Parse a time string to minutes-since-midnight. Handles the shapes we
// actually see (stored "HH:MM", legacy "H:MM", freeform "9am" / "9:30 PM").
// Returns Infinity for empty / unparseable so those rows sort to the end.
export function timeToMinutes(value) {
  if (value == null) return Infinity
  const s = String(value).trim()
  if (!s) return Infinity
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i)
  if (!m) return Infinity
  let h = parseInt(m[1], 10)
  const min = m[2] != null ? parseInt(m[2], 10) : 0
  const ap = m[3] ? m[3][0].toLowerCase() : null
  if (isNaN(h) || isNaN(min) || min < 0 || min > 59) return Infinity
  if (ap) {
    if (h < 1 || h > 12) return Infinity
    h = h % 12
    if (ap === 'p') h += 12
  } else {
    if (h < 0 || h > 23) return Infinity
  }
  return h * 60 + min
}

// Comparator for Array.sort — chronological order of the `.time` field.
// Ties fall back to any secondary key on the object so ordering is stable.
export function byTime(a, b) {
  const ta = timeToMinutes(a?.time)
  const tb = timeToMinutes(b?.time)
  if (ta !== tb) return ta - tb
  return String(a?.label || a?.title || '').localeCompare(String(b?.label || b?.title || ''))
}

// Comparator that sorts by .date then .time — for cross-day schedule views.
export function byDateThenTime(a, b) {
  const da = String(a?.date || '')
  const db = String(b?.date || '')
  if (da !== db) return da.localeCompare(db)
  return byTime(a, b)
}
