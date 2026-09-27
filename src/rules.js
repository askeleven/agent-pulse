import { readFile } from 'node:fs/promises'
import { isTimeZone, parseDuration } from './time.js'
import { parseDays, parseDuring, windowLength } from './window.js'

/**
 * @typedef {import('./window.js').Window} Window
 *
 * @typedef {object} ExpectRule At least `min` outputs in every trailing `per` while the
 *   window is open.
 * @property {number} min
 * @property {number} per Milliseconds.
 * @property {string} perText
 * @property {Window | null} during
 * @property {number[] | null} days
 * @property {string | null} daysText
 * @property {string} tz
 *
 * @typedef {object} HeartbeatRule Some event, of any type, at least every `every`.
 * @property {number} every
 * @property {string} everyText
 *
 * @typedef {object} StreakRule Alert on this many failures in a row for one target and
 *   action.
 * @property {number} failures
 *
 * @typedef {object} DeliveryRule Accepted messages must be delivered within `within`.
 * @property {number} within
 * @property {string} withinText
 * @property {number} lookback Accepted messages older than within + lookback are ignored.
 * @property {string} lookbackText
 *
 * @typedef {object} CapRule A designed limit. Reaching it explains low volume.
 * @property {number} max
 * @property {number | 'day'} per Trailing milliseconds, or the local calendar day.
 * @property {string} perText
 * @property {string} tz
 *
 * @typedef {object} Check
 * @property {string} agent
 * @property {string} capability
 * @property {ExpectRule[] | null} expect One or more windows, each judged on its own.
 * @property {HeartbeatRule | null} heartbeat
 * @property {StreakRule | null} streak
 * @property {DeliveryRule | null} delivery
 * @property {CapRule | null} cap
 *
 * @typedef {object} Defaults
 * @property {string} tz
 * @property {number} cooldown Milliseconds between repeat notifications for one finding.
 * @property {string} cooldownText
 *
 * @typedef {object} Rules Validated rules, as `validateRules` returns them.
 * @property {Defaults} defaults
 * @property {Check[]} checks
 */

export const DEFAULT_TZ = 'UTC'
export const DEFAULT_COOLDOWN = '30m'
export const DEFAULT_DELIVERY_LOOKBACK = '24h'

/** Rules objects that came out of validateRules, so evaluate does not validate twice. */
const validated = new WeakSet()

export class RulesError extends Error {
  /**
   * @param {string[]} problems
   * @param {string} [source] File name, for the message.
   */
  constructor(problems, source) {
    const where = source ?? 'The rules'
    super(
      problems.length === 1
        ? `${where}: ${problems[0]}`
        : `${where} has ${problems.length} problems:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    )
    this.name = 'RulesError'
    this.problems = problems
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Checks raw rules strictly and returns them with durations, windows and days parsed.
 * Every problem is collected, so one run shows them all.
 *
 * @param {unknown} raw
 * @param {string} [source]
 * @returns {Rules}
 */
export function validateRules(raw, source) {
  if (raw && validated.has(/** @type {object} */ (raw))) return /** @type {Rules} */ (raw)
  /** @type {string[]} */
  const problems = []
  const problem = (/** @type {string} */ path, /** @type {string} */ message) =>
    problems.push(`${path}: ${message}`)

  /**
   * @param {Record<string, unknown>} obj
   * @param {string[]} allowed
   * @param {string} path
   */
  const noUnknownKeys = (obj, allowed, path) => {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) problem(path ? `${path}.${key}` : key, `unknown field (allowed: ${allowed.join(', ')})`)
    }
  }

  /**
   * @param {unknown} value
   * @param {string} path
   * @param {{ zero?: boolean }} [options]
   * @returns {number | null}
   */
  const duration = (value, path, options = {}) => {
    const ms = parseDuration(value)
    if (ms === null || (ms === 0 && !options.zero)) {
      problem(path, `must be a duration like "15m", "2h" or "1d", got ${JSON.stringify(value)}`)
      return null
    }
    return ms
  }

  /**
   * @param {unknown} value
   * @param {string} path
   * @returns {number | null}
   */
  const positiveInteger = (value, path) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      problem(path, `must be a whole number of 1 or more, got ${JSON.stringify(value)}`)
      return null
    }
    return value
  }

  /**
   * @param {unknown} value
   * @param {string} path
   * @param {string} fallback
   * @returns {string}
   */
  const timeZone = (value, path, fallback) => {
    if (value === undefined) return fallback
    if (!isTimeZone(value)) {
      problem(path, `is not a time zone Intl knows, got ${JSON.stringify(value)} (use an IANA name like "America/New_York")`)
      return fallback
    }
    return /** @type {string} */ (value)
  }

  if (!isObject(raw)) throw new RulesError(['must be a JSON object with a "checks" array'], source)
  noUnknownKeys(raw, ['defaults', 'checks'], '')

  /** @type {Defaults} */
  const defaults = { tz: DEFAULT_TZ, cooldown: 30 * 60_000, cooldownText: DEFAULT_COOLDOWN }
  if (raw.defaults !== undefined) {
    if (!isObject(raw.defaults)) {
      problem('defaults', 'must be an object')
    } else {
      noUnknownKeys(raw.defaults, ['tz', 'cooldown'], 'defaults')
      defaults.tz = timeZone(raw.defaults.tz, 'defaults.tz', DEFAULT_TZ)
      if (raw.defaults.cooldown !== undefined) {
        const ms = duration(raw.defaults.cooldown, 'defaults.cooldown', { zero: true })
        if (ms !== null) {
          defaults.cooldown = ms
          defaults.cooldownText = String(raw.defaults.cooldown)
        }
      }
    }
  }

  /** @type {Check[]} */
  const checks = []
  if (!Array.isArray(raw.checks) || raw.checks.length === 0) {
    problem('checks', 'must be a non-empty array')
  } else {
    /** @type {Map<string, number>} */
    const seen = new Map()
    raw.checks.forEach((/** @type {unknown} */ c, i) => {
      const path = `checks[${i}]`
      if (!isObject(c)) {
        problem(path, 'must be an object')
        return
      }
      noUnknownKeys(c, ['agent', 'capability', 'expect', 'heartbeat', 'streak', 'delivery', 'cap'], path)
      for (const field of ['agent', 'capability']) {
        if (typeof c[field] !== 'string' || !c[field]) problem(`${path}.${field}`, 'is required and must be a non-empty string')
      }
      const agent = String(c.agent ?? '')
      const capability = String(c.capability ?? '')
      const pair = `${agent}/${capability}`
      if (agent && capability) {
        if (seen.has(pair)) {
          problem(path, `repeats ${pair} from checks[${seen.get(pair)}]; put every rule for one agent and capability in one check`)
        } else {
          seen.set(pair, i)
        }
      }

      /** @type {Check} */
      const check = { agent, capability, expect: null, heartbeat: null, streak: null, delivery: null, cap: null }

      const section = (/** @type {string} */ name, /** @type {string[]} */ allowed) => {
        const value = c[name]
        if (value === undefined) return null
        if (!isObject(value)) {
          problem(`${path}.${name}`, 'must be an object')
          return null
        }
        noUnknownKeys(value, allowed, `${path}.${name}`)
        return value
      }

      /** @type {Record<string, unknown>[]} */
      const expects = []
      if (c.expect !== undefined) {
        const list = Array.isArray(c.expect) ? c.expect : [c.expect]
        if (list.length === 0) problem(`${path}.expect`, 'must not be an empty array')
        list.forEach((/** @type {unknown} */ value, k) => {
          const p = Array.isArray(c.expect) ? `${path}.expect[${k}]` : `${path}.expect`
          if (!isObject(value)) {
            problem(p, 'must be an object, or an array of objects')
            return
          }
          noUnknownKeys(value, ['min', 'per', 'during', 'days', 'tz'], p)
          expects.push(value)
        })
      }
      /** @type {ExpectRule[]} */
      const expectRules = []
      expects.forEach((expect, k) => {
        const p = Array.isArray(c.expect) ? `${path}.expect[${k}]` : `${path}.expect`
        const min = positiveInteger(expect.min, `${p}.min`)
        const per = duration(expect.per, `${p}.per`)
        let during = null
        if (expect.during !== undefined) {
          const parsed = typeof expect.during === 'string' ? parseDuring(expect.during) : 'must be a string like "09:00-17:00"'
          if (typeof parsed === 'string') problem(`${p}.during`, parsed)
          else during = parsed
        }
        let days = null
        if (expect.days !== undefined) {
          const parsed = parseDays(expect.days)
          if (typeof parsed === 'string') problem(`${p}.days`, parsed)
          else days = parsed
        }
        const tz = timeZone(expect.tz, `${p}.tz`, defaults.tz)
        if (per !== null && (during || days) && per > windowLength(during)) {
          problem(`${p}.per`, `is longer than the window, so this check could never run`)
        }
        if (min !== null && per !== null) {
          expectRules.push({
            min,
            per,
            perText: String(expect.per),
            during,
            days,
            daysText: days ? (Array.isArray(expect.days) ? expect.days.join(',') : String(expect.days)) : null,
            tz,
          })
        }
      })
      if (expectRules.length) check.expect = expectRules
      const expect = expects.length > 0

      const heartbeat = section('heartbeat', ['every'])
      if (heartbeat) {
        const every = duration(heartbeat.every, `${path}.heartbeat.every`)
        if (every !== null) check.heartbeat = { every, everyText: String(heartbeat.every) }
      }

      const streak = section('streak', ['failures'])
      if (streak) {
        const failures = positiveInteger(streak.failures, `${path}.streak.failures`)
        if (failures !== null) check.streak = { failures }
      }

      const delivery = section('delivery', ['within', 'lookback'])
      if (delivery) {
        const within = duration(delivery.within, `${path}.delivery.within`)
        const lookbackText = delivery.lookback === undefined ? DEFAULT_DELIVERY_LOOKBACK : delivery.lookback
        const lookback = duration(lookbackText, `${path}.delivery.lookback`)
        if (within !== null && lookback !== null) {
          check.delivery = { within, withinText: String(delivery.within), lookback, lookbackText: String(lookbackText) }
        }
      }

      const cap = section('cap', ['max', 'per', 'tz'])
      if (cap) {
        const p = `${path}.cap`
        const max = positiveInteger(cap.max, `${p}.max`)
        const per = cap.per === 'day' ? 'day' : duration(cap.per, `${p}.per`)
        const tz = timeZone(cap.tz, `${p}.tz`, check.expect?.[0].tz ?? defaults.tz)
        if (!expect) problem(p, 'only changes how "expect" is reported; add "expect" or remove "cap"')
        if (max !== null && per !== null) check.cap = { max, per, perText: String(cap.per), tz }
      }

      checks.push(check)
    })
  }

  if (problems.length) throw new RulesError(problems, source)
  const rules = { defaults, checks }
  validated.add(rules)
  return rules
}

/**
 * Reads and validates a rules file.
 *
 * @param {string} path
 * @returns {Promise<Rules>}
 */
export async function loadRules(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code
    throw new RulesError([code === 'ENOENT' ? 'no such file' : /** @type {Error} */ (error).message], path)
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new RulesError([`not valid JSON (${/** @type {Error} */ (error).message})`], path)
  }
  return validateRules(raw, path)
}
