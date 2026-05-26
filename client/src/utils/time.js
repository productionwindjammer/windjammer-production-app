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
