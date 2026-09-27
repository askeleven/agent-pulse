import { normaliseEvent } from './events.js'
import { validateRules } from './rules.js'
import { formatDuration, isoSeconds, toMillis } from './time.js'
import { activeWindow, startOfDay } from './window.js'

/**
 * @typedef {import('./events.js').Event} Event
 * @typedef {import('./rules.js').Rules} Rules
 * @typedef {import('./rules.js').Check} Check
 *
 * @typedef {'alert'|'warn'|'info'} Severity
 *
 * @typedef {'no_events'|'silent'|'below_expected'|'failure_streak'|'auth_failure'
 *   |'config_failure'|'quota_exhausted'|'undelivered'|'malformed_events'|'at_cap'} FindingCode
 *
 * @typedef {object} Finding
 * @property {string} key Stable across runs while the same problem persists:
 *   `agent/capability/code`, plus `/target/action` for failures (`-` when absent), or
 *   `events/code` for problems with the log itself.
 * @property {FindingCode} code Stable, safe to match on.
 * @property {Severity} severity `alert` means something is not working. `warn` means
 *   worth a look. `info` is by design.
 * @property {string | null} agent Null for problems with the log itself.
 * @property {string | null} capability
 * @property {string} detail Plain English.
 * @property {Record<string, unknown>} data The numbers behind the detail.
 *
 * @typedef {object} Summary
 * @property {number} checks
 * @property {number} events Valid events at or before `now`.
 * @property {number} alerts
 * @property {number} warnings
 * @property {number} info
 *
 * @typedef {object} Result
 * @property {boolean} healthy True when there are no alert findings.
 * @property {string} now The time evaluated at, ISO 8601.
 * @property {Summary} summary
 * @property {Finding[]} findings Alerts first, then warnings, then info.
 *
 * @typedef {object} EvaluateOptions
 * @property {number | string | Date} [now] Defaults to the current time.
 * @property {number} [malformed] Lines already found unreadable by `readEvents`.
 * @property {number[]} [malformedLines]
 * @property {boolean} [missing] The log file does not exist.
 *
 * @typedef {{ first: Event, last: Event, count: number }} FailureRun
 */

const SEVERITY_ORDER = { alert: 0, warn: 1, info: 2 }
const HARD_FAILURES = /** @type {const} */ ({
  auth: { code: 'auth_failure', title: 'Authentication failed' },
  config: { code: 'config_failure', title: 'Configuration failure' },
  quota: { code: 'quota_exhausted', title: 'Quota or usage limit reached' },
})
const MAX_IDS = 10

/**
 * Evaluates rules against events at one point in time. Pure: no I/O, no clock unless
 * `now` is left out. Events after `now` are ignored, so a log can be replayed.
 *
 * @param {Rules | unknown} rules Validated rules, or a raw rules object to validate.
 * @param {Array<Event | import('./events.js').PulseEvent | unknown>} events Parsed or raw.
 * @param {EvaluateOptions} [options]
 * @returns {Result}
 */
export function evaluate(rules, events, options = {}) {
  const checked = validateRules(rules)
  const now = options.now === undefined ? Date.now() : toMillis(options.now)
  if (now === null) throw new TypeError(`now must be an ISO 8601 time, epoch milliseconds or a Date`)

  let malformed = options.malformed ?? 0
  const malformedLines = [...(options.malformedLines ?? [])]
  /** @type {Map<string, Event[]>} */
  const byCheck = new Map()
  let count = 0
  for (const raw of events) {
    const event = raw && typeof raw === 'object' && 't' in raw ? /** @type {Event} */ (raw) : normaliseEvent(raw)
    if (!event) {
      malformed++
      continue
    }
    if (event.t > now) continue
    count++
    const key = pairKey(event.agent, event.capability)
    const list = byCheck.get(key)
    if (list) list.push(event)
    else byCheck.set(key, [event])
  }

  /** @type {Finding[]} */
  const findings = []
  if (malformed > 0) {
    const where = malformedLines.length ? ` (line ${malformedLines.join(', ')}${malformed > malformedLines.length ? ', ...' : ''})` : ''
    findings.push({
      key: 'events/malformed_events',
      code: 'malformed_events',
      severity: 'warn',
      agent: null,
      capability: null,
      detail: `${malformed} ${plural(malformed, 'line')} in the event log could not be read and ${malformed === 1 ? 'was' : 'were'} skipped${where}.`,
      data: { count: malformed, lines: malformedLines },
    })
  }

  if (count === 0) {
    findings.push({
      key: 'events/no_events',
      code: 'no_events',
      severity: 'alert',
      agent: null,
      capability: null,
      detail: options.missing
        ? 'The event log does not exist. Nothing has recorded any activity, so nothing can be shown to be working.'
        : 'The event log has no events. Nothing has recorded any activity, so nothing can be shown to be working.',
      data: { missing: options.missing === true },
    })
  } else {
    for (const check of checked.checks) {
      const list = byCheck.get(pairKey(check.agent, check.capability)) ?? []
      list.sort((a, b) => a.t - b.t)
      findings.push(...evaluateCheck(check, list, now))
    }
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const tally = (/** @type {Severity} */ s) => findings.filter((f) => f.severity === s).length
  return {
    healthy: tally('alert') === 0,
    now: isoSeconds(now),
    summary: {
      checks: checked.checks.length,
      events: count,
      alerts: tally('alert'),
      warnings: tally('warn'),
      info: tally('info'),
    },
    findings,
  }
}

/**
 * @template T
 * @param {T[]} list
 * @param {(item: T) => boolean} test
 * @returns {T | undefined}
 */
function findLast(list, test) {
  for (let i = list.length - 1; i >= 0; i--) if (test(list[i])) return list[i]
  return undefined
}

/**
 * @param {string} agent
 * @param {string} capability
 */
function pairKey(agent, capability) {
  return `${agent}\u0000${capability}`
}

/**
 * @param {number} n
 * @param {string} word
 */
function plural(n, word) {
  return n === 1 ? word : `${word}s`
}

/**
 * @param {string | undefined} target
 * @param {string | undefined} action
 * @returns {string}
 */
function describeTarget(target, action) {
  if (target && action) return `${action} on ${target}`
  if (action) return action
  if (target) return target
  return 'unlabelled actions'
}

/**
 * @param {Check} check
 * @param {Event[]} events This check's events, oldest first, none after now.
 * @param {number} now
 * @returns {Finding[]}
 */
function evaluateCheck(check, events, now) {
  const { agent, capability } = check
  /** @type {Finding[]} */
  const findings = []
  /**
   * @param {FindingCode} code
   * @param {Severity} severity
   * @param {string} detail
   * @param {Record<string, unknown>} data
   * @param {string[]} [suffix]
   */
  const add = (code, severity, detail, data, suffix = []) =>
    findings.push({ key: [agent, capability, code, ...suffix].join('/'), code, severity, agent, capability, detail, data })

  // A delivered event for a message already counted as accepted is the same output.
  const acceptedIds = new Set(events.filter((e) => e.type === 'accepted' && e.id).map((e) => e.id))
  const isOutput = (/** @type {Event} */ e) =>
    e.type === 'action' || e.type === 'accepted' || (e.type === 'delivered' && !(e.id && acceptedIds.has(e.id)))

  if (check.heartbeat) {
    const { every, everyText } = check.heartbeat
    const last = events.at(-1)
    if (!last || now - last.t >= every) {
      add(
        'silent',
        'alert',
        last
          ? `No events in the last ${everyText}. The last one was ${formatDuration(now - last.t)} ago (${last.type}).`
          : `No events have ever been recorded for ${agent}/${capability}.`,
        { every: everyText, lastEventAt: last ? isoSeconds(last.t) : null },
      )
    }
  }

  for (const [k, x] of (check.expect ?? []).entries()) {
    // Each window has its own key once there is more than one, so overlapping windows cannot collide.
    const suffix = (check.expect ?? []).length > 1 ? [`expect${k}`] : []
    const window = activeWindow(now, x)
    if (window && now - window.start >= x.per) {
      const from = now - x.per
      const count = events.filter((e) => e.t > from && isOutput(e)).length
      if (count < x.min) {
        const lastOutput = findLast(events, isOutput)
        const when = x.during || x.days ? ` (${[x.daysText, x.during?.text, x.tz].filter(Boolean).join(' ')})` : ''
        const data = {
          count,
          min: x.min,
          per: x.perText,
          lastOutputAt: lastOutput ? isoSeconds(lastOutput.t) : null,
        }
        const cap = check.cap
        const capStart = cap ? (cap.per === 'day' ? startOfDay(now, cap.tz) : now - cap.per) : 0
        const capCount = cap ? events.filter((e) => e.t >= capStart && isOutput(e)).length : 0
        if (cap && capCount >= cap.max) {
          const period = cap.per === 'day' ? 'today' : `in the last ${cap.perText}`
          add(
            'at_cap',
            'info',
            `Designed limit reached, not an outage: ${capCount} of ${cap.max} ${period}. ` +
              `${count} in the last ${x.perText} is under the expected ${x.min} because of the cap.`,
            { ...data, capCount, capMax: cap.max, capPer: cap.perText },
            suffix,
          )
        } else {
          add(
            'below_expected',
            'alert',
            `${count} ${plural(count, 'output')} in the last ${x.perText}, expected at least ${x.min}${when}. ` +
              (lastOutput ? `The last one was ${formatDuration(now - lastOutput.t)} ago.` : 'None recorded yet.'),
            data,
            suffix,
          )
        }
      }
    }
  }

  // Failures, kept per (target, action). Only a success for the same pair clears them, so
  // reads that keep working cannot hide sends that keep failing.
  /** @type {Map<string, { target?: string, action?: string, streak: Event[], hard: Map<string, FailureRun> }>} */
  const pairs = new Map()
  for (const e of events) {
    if (e.type === 'run') continue
    const key = `${e.target ?? ''}\u0000${e.action ?? ''}`
    let pair = pairs.get(key)
    if (!pair) {
      pair = { target: e.target, action: e.action, streak: [], hard: new Map() }
      pairs.set(key, pair)
    }
    if (e.type !== 'failed') {
      pair.streak = []
      pair.hard.clear()
      continue
    }
    const cls = e.error_class
    if (cls === 'input') continue // One bad record. Not the agent's health.
    if (cls === 'auth' || cls === 'config' || cls === 'quota') {
      const run = pair.hard.get(cls)
      if (run) {
        run.last = e
        run.count++
      } else {
        pair.hard.set(cls, { first: e, last: e, count: 1 })
      }
      continue
    }
    pair.streak.push(e)
  }

  for (const pair of pairs.values()) {
    const suffix = [pair.target ?? '-', pair.action ?? '-']
    const label = describeTarget(pair.target, pair.action)
    for (const [cls, run] of pair.hard) {
      const kind = HARD_FAILURES[/** @type {keyof typeof HARD_FAILURES} */ (cls)]
      add(
        kind.code,
        'alert',
        `${kind.title} for ${label}, ${run.count} ${plural(run.count, 'time')} with no success since. ` +
          `Last ${formatDuration(now - run.last.t)} ago${run.last.detail ? `: ${run.last.detail}` : '.'}`,
        {
          target: pair.target ?? null,
          action: pair.action ?? null,
          count: run.count,
          firstAt: isoSeconds(run.first.t),
          lastAt: isoSeconds(run.last.t),
          error: run.last.detail ?? null,
        },
        suffix,
      )
    }
    if (check.streak && pair.streak.length >= check.streak.failures) {
      const first = pair.streak[0]
      const last = /** @type {Event} */ (pair.streak.at(-1))
      add(
        'failure_streak',
        'alert',
        `${pair.streak.length} failures in a row for ${label} over ${formatDuration(last.t - first.t)}, none succeeded since. ` +
          `Last ${formatDuration(now - last.t)} ago${last.detail ? `: ${last.detail}` : '.'}`,
        {
          target: pair.target ?? null,
          action: pair.action ?? null,
          count: pair.streak.length,
          threshold: check.streak.failures,
          firstAt: isoSeconds(first.t),
          lastAt: isoSeconds(last.t),
          error: last.detail ?? null,
        },
        suffix,
      )
    }
  }

  if (check.delivery) {
    const { within, withinText, lookback } = check.delivery
    const delivered = new Set()
    const failed = new Set()
    for (const e of events) {
      if (!e.id) continue
      if (e.type === 'delivered') delivered.add(e.id)
      if (e.type === 'failed') failed.add(e.id)
    }
    /** @type {Map<string, Event>} */
    const accepted = new Map()
    for (const e of events) {
      if (e.type === 'accepted' && e.id && e.t > now - within - lookback && !accepted.has(e.id)) accepted.set(e.id, e)
    }
    let due = 0
    /** @type {string[]} */
    const missing = []
    let failedCount = 0
    for (const [id, e] of accepted) {
      const hasFailed = failed.has(id)
      if (!hasFailed && now - e.t < within) continue // Still has time.
      due++
      if (hasFailed) {
        failedCount++
        missing.push(id)
      } else if (!delivered.has(id)) {
        missing.push(id)
      }
    }
    if (missing.length) {
      const shown = missing.slice(0, MAX_IDS)
      add(
        'undelivered',
        'alert',
        `${missing.length} of ${due} accepted ${plural(due, 'message')} not delivered within ${withinText}` +
          (failedCount ? ` (${failedCount} reported failed)` : '') +
          `: ${shown.join(', ')}${missing.length > shown.length ? `, and ${missing.length - shown.length} more` : ''}.`,
        { count: missing.length, checked: due, failed: failedCount, ids: shown, within: withinText },
      )
    }
  }

  return findings
}
