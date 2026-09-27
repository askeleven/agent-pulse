/**
 * Durations and wall-clock time in a named time zone, using only Intl. Offsets are looked
 * up for the instant in question, so daylight saving changes are handled wherever they
 * fall rather than assumed from a fixed offset.
 */

const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 }
const DURATION = /^(?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/

/**
 * Parses a duration such as `15m`, `2h`, `1h30m`, `1d` or `45s`.
 *
 * @param {unknown} value
 * @returns {number | null} Milliseconds, or null when it is not a duration.
 */
export function parseDuration(value) {
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  if (!text) return null
  const match = DURATION.exec(text)
  if (!match) return null
  const [, d, h, m, s] = match
  return (
    Number(d ?? 0) * UNIT_MS.d +
    Number(h ?? 0) * UNIT_MS.h +
    Number(m ?? 0) * UNIT_MS.m +
    Number(s ?? 0) * UNIT_MS.s
  )
}

/**
 * The two largest units, for people: `45s`, `12m`, `2h 5m`, `3d 1h`.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`
}

/**
 * Epoch milliseconds from an ISO 8601 string, epoch milliseconds, or a Date.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function toMillis(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** @type {Map<string, Intl.DateTimeFormat>} */
const formatters = new Map()

/**
 * @param {string} timeZone
 * @returns {Intl.DateTimeFormat}
 */
function formatter(timeZone) {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formatters.set(timeZone, f)
  }
  return f
}

/**
 * @param {unknown} timeZone
 * @returns {boolean} Whether Intl knows this IANA zone, such as `America/New_York`.
 */
export function isTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return false
  try {
    formatter(timeZone)
    return true
  } catch {
    return false
  }
}

/**
 * @typedef {object} LocalDate
 * @property {number} year
 * @property {number} month 1 to 12.
 * @property {number} day
 *
 * @typedef {LocalDate & { hour: number, minute: number, second: number }} LocalTime
 */

/**
 * The wall-clock time at an instant in a time zone.
 *
 * @param {number} ms
 * @param {string} timeZone
 * @returns {LocalTime}
 */
export function zonedParts(ms, timeZone) {
  /** @type {Record<string, number>} */
  const parts = {}
  for (const part of formatter(timeZone).formatToParts(ms)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second,
  }
}

/**
 * How far the zone's wall clock is ahead of UTC at an instant, in milliseconds.
 *
 * @param {number} ms
 * @param {string} timeZone
 * @returns {number}
 */
function offsetAt(ms, timeZone) {
  const whole = Math.floor(ms / 1000) * 1000
  const p = zonedParts(whole, timeZone)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole
}

/**
 * The instant a local wall-clock time happens in a zone. A time skipped by a
 * spring-forward change resolves to the moment after the jump; a time repeated by a
 * fall-back change resolves to its first occurrence.
 *
 * @param {LocalDate} date
 * @param {number} minutes Minutes after local midnight. 1440 is the next midnight.
 * @param {string} timeZone
 * @returns {number}
 */
export function zonedTimeToUtc(date, minutes, timeZone) {
  const local = Date.UTC(date.year, date.month - 1, date.day, 0, minutes)
  const before = offsetAt(local, timeZone)
  const first = local - before
  const after = offsetAt(first, timeZone)
  if (after === before) return first
  const second = local - after
  if (offsetAt(second, timeZone) === after) return second
  return Math.max(first, second)
}

/**
 * @param {LocalDate} date
 * @param {number} days
 * @returns {LocalDate}
 */
export function addDays(date, days) {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/**
 * @param {LocalDate} date
 * @returns {number} 0 for Sunday to 6 for Saturday.
 */
export function weekday(date) {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
}

/**
 * @param {number} ms
 * @returns {string} ISO 8601 in UTC, to the second.
 */
export function isoSeconds(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}
