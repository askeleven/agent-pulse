import { addDays, weekday, zonedParts, zonedTimeToUtc } from './time.js'

/**
 * @typedef {object} Window A daily time range in local wall-clock minutes.
 * @property {number} start Minutes after midnight, 0 to 1439.
 * @property {number} end Minutes after midnight, 1 to 1440. At or before start means the
 *   window runs past midnight into the next day.
 * @property {string} text As written, such as `09:00-11:15`.
 *
 * @typedef {object} Schedule When a window is open.
 * @property {Window | null} during Null means all day.
 * @property {number[] | null} days 0 for Sunday to 6 for Saturday. Null means every day.
 * @property {string} tz IANA time zone the window is in.
 *
 * @typedef {object} Span
 * @property {number} start Epoch ms.
 * @property {number} end Epoch ms.
 */

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const RANGE = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/

/**
 * Parses `HH:MM-HH:MM`. `24:00` is allowed as an end.
 *
 * @param {string} text
 * @returns {Window | string} The window, or what is wrong with it.
 */
export function parseDuring(text) {
  const match = RANGE.exec(text.trim())
  if (!match) return `must look like "09:00-17:00", got "${text}"`
  const [sh, sm, eh, em] = match.slice(1).map(Number)
  if (sh > 23 || sm > 59) return `start time ${match[1]}:${match[2]} is not a time of day`
  if (eh > 24 || em > 59 || (eh === 24 && em !== 0)) {
    return `end time ${match[3]}:${match[4]} is not a time of day`
  }
  const start = sh * 60 + sm
  const end = eh * 60 + em
  if (start === end) {
    return 'start and end are the same; leave "during" out for all day'
  }
  return { start, end, text: text.trim() }
}

/**
 * Parses `mon-fri`, `sat,sun`, `mon`, or an array of those.
 *
 * @param {unknown} value
 * @returns {number[] | string} Sorted day numbers, or what is wrong.
 */
export function parseDays(value) {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null
  if (!items || items.length === 0) {
    return 'must be a day range like "mon-fri" or a list like ["mon", "wed"]'
  }
  /** @type {Set<number>} */
  const days = new Set()
  for (const item of items) {
    if (typeof item !== 'string') return `"${String(item)}" is not a day name`
    const [from, to, ...rest] = item.trim().toLowerCase().split('-')
    const a = DAY_NAMES.indexOf(from)
    const b = to === undefined ? a : DAY_NAMES.indexOf(to)
    if (a < 0 || b < 0 || rest.length) {
      return `"${item.trim()}" is not a day or range; use ${DAY_NAMES.join(', ')}`
    }
    for (let d = a; ; d = (d + 1) % 7) {
      days.add(d)
      if (d === b) break
    }
  }
  return [...days].sort((x, y) => x - y)
}

/**
 * @param {Window | null} during
 * @returns {number} How long each window is open, in milliseconds.
 */
export function windowLength(during) {
  if (!during) return 86_400_000
  const minutes = during.end > during.start ? during.end - during.start : during.end + 1440 - during.start
  return minutes * 60_000
}

/**
 * The window open at `now`, or null when none is. With no `during` and no `days` the
 * window is always open and has no start.
 *
 * @param {number} now
 * @param {Schedule} schedule
 * @returns {Span | null}
 */
export function activeWindow(now, schedule) {
  const { during, days, tz } = schedule
  if (!during && !days) return { start: -Infinity, end: Infinity }
  const startMinute = during ? during.start : 0
  const endMinute = during ? during.end : 1440
  const today = zonedParts(now, tz)
  // A window that runs past midnight may have opened yesterday.
  for (const offset of [0, -1]) {
    const date = addDays(today, offset)
    if (days && !days.includes(weekday(date))) continue
    const start = zonedTimeToUtc(date, startMinute, tz)
    const endDate = endMinute > startMinute ? date : addDays(date, 1)
    const end = zonedTimeToUtc(endDate, endMinute, tz)
    if (now >= start && now < end) return { start, end }
  }
  return null
}

/**
 * Local midnight at the start of the day containing `now`.
 *
 * @param {number} now
 * @param {string} tz
 * @returns {number}
 */
export function startOfDay(now, tz) {
  return zonedTimeToUtc(zonedParts(now, tz), 0, tz)
}
