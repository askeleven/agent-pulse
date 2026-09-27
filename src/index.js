import { dirname, join } from 'node:path'
import { readEvents } from './events.js'
import { loadRules } from './rules.js'
import { evaluate } from './evaluate.js'
import { loadState, saveState, DEFAULT_STATE_FILE } from './state.js'
import { planNotifications, formatMessage, postWebhook, pingHeartbeat } from './notify.js'
import { toMillis } from './time.js'

export { evaluate } from './evaluate.js'
export { parseEvents, readEvents, normaliseEvent, eventProblem, EVENT_TYPES, ERROR_CLASSES } from './events.js'
export {
  validateRules,
  loadRules,
  RulesError,
  DEFAULT_TZ,
  DEFAULT_COOLDOWN,
  DEFAULT_DELIVERY_LOOKBACK,
} from './rules.js'
export { emit } from './emit.js'
export { loadState, saveState, emptyState, DEFAULT_STATE_FILE } from './state.js'
export { planNotifications, formatMessage, postWebhook, pingHeartbeat } from './notify.js'
export { formatText } from './report.js'
export { parseDuration, formatDuration } from './time.js'

/**
 * @typedef {import('./events.js').PulseEvent} PulseEvent
 * @typedef {import('./events.js').Event} Event
 * @typedef {import('./events.js').EventType} EventType
 * @typedef {import('./events.js').ErrorClass} ErrorClass
 * @typedef {import('./rules.js').Rules} Rules
 * @typedef {import('./rules.js').Check} Check
 * @typedef {import('./evaluate.js').Result} Result
 * @typedef {import('./evaluate.js').Finding} Finding
 * @typedef {import('./evaluate.js').FindingCode} FindingCode
 * @typedef {import('./evaluate.js').Severity} Severity
 * @typedef {import('./notify.js').SendResult} SendResult
 *
 * @typedef {object} CheckOptions
 * @property {string} rulesPath
 * @property {string} eventsPath
 * @property {string} [statePath] Defaults to `.agent-pulse-state.json` next to the rules.
 * @property {string} [webhookUrl] Where to post alerts.
 * @property {string} [heartbeatUrl] Pinged after every evaluation that completes.
 * @property {number | string | Date} [now]
 * @property {typeof fetch} [fetch] For tests.
 *
 * @typedef {object} Notification
 * @property {boolean} sent A message was posted.
 * @property {number} alerts Findings in the message.
 * @property {number} resolved Resolved findings in the message.
 * @property {string} [error] Why posting failed. State is left as it was, so the next
 *   run tries again.
 *
 * @typedef {object} CheckRun
 * @property {Result} result
 * @property {Notification | null} notification Null without a webhook.
 * @property {SendResult | null} heartbeat Null without a heartbeat URL.
 * @property {string | null} statePath The state file used, when there was a webhook.
 * @property {string[]} warnings Things that went wrong around the evaluation, such as a
 *   corrupt or unwritable state file.
 */

/**
 * Everything the CLI's `check` does: read the rules and the log, evaluate, notify
 * through a webhook with cooldowns and resolutions, and ping a heartbeat URL. Throws only
 * when it cannot evaluate at all (bad rules, unreadable log); webhook, heartbeat and state
 * problems are returned instead.
 *
 * State is only read and written when there is a webhook, because it only exists to
 * decide what to send.
 *
 * @param {CheckOptions} options
 * @returns {Promise<CheckRun>}
 */
export async function check(options) {
  const now = options.now === undefined ? Date.now() : toMillis(options.now)
  if (now === null) throw new TypeError('now must be an ISO 8601 time, epoch milliseconds or a Date')

  const rules = await loadRules(options.rulesPath)
  const log = await readEvents(options.eventsPath)
  const result = evaluate(rules, log.events, {
    now,
    malformed: log.malformed,
    malformedLines: log.malformedLines,
    missing: log.missing,
  })

  /** @type {string[]} */
  const warnings = []
  /** @type {Notification | null} */
  let notification = null
  /** @type {string | null} */
  let statePath = null

  if (options.webhookUrl) {
    const path = options.statePath ?? join(dirname(options.rulesPath), DEFAULT_STATE_FILE)
    statePath = path
    const { state, corrupt } = await loadState(path).catch((error) => {
      warnings.push(`Could not read state file ${path}: ${error.message}`)
      return { state: { version: /** @type {const} */ (1), findings: {} }, corrupt: false }
    })
    if (corrupt) warnings.push(`State file ${path} was unreadable; starting fresh.`)
    const plan = planNotifications(result.findings, state, { now, cooldown: rules.defaults.cooldown })
    const text = formatMessage(plan, { now })
    let saved = true
    if (text) {
      const sent = await postWebhook(options.webhookUrl, text, { fetch: options.fetch })
      notification = {
        sent: sent.ok,
        alerts: plan.notices.length,
        resolved: plan.resolved.length,
        ...(sent.ok ? {} : { error: sent.error }),
      }
      saved = sent.ok
    } else {
      notification = { sent: false, alerts: 0, resolved: 0 }
    }
    if (saved) {
      await saveState(path, plan.next).catch((error) => {
        warnings.push(`Could not write state file ${path}: ${error.message}`)
      })
    }
  }

  const heartbeat = options.heartbeatUrl ? await pingHeartbeat(options.heartbeatUrl, { fetch: options.fetch }) : null

  return { result, notification, heartbeat, statePath, warnings }
}
