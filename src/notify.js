import { formatDuration, isoSeconds, toMillis } from './time.js'

/**
 * @typedef {import('./evaluate.js').Finding} Finding
 * @typedef {import('./state.js').State} State
 * @typedef {import('./state.js').StateEntry} StateEntry
 *
 * @typedef {object} Notice A finding to tell someone about.
 * @property {Finding} finding
 * @property {boolean} repeat It was already notified and the cooldown has passed.
 * @property {string} firstSeen ISO 8601.
 *
 * @typedef {object} Resolved
 * @property {string} key
 * @property {StateEntry} entry
 *
 * @typedef {object} Plan
 * @property {Notice[]} notices New findings, and ones whose cooldown has passed.
 * @property {Resolved[]} resolved Findings notified before that are gone now.
 * @property {State} next The state to save once the notification has been sent.
 *
 * @typedef {object} SendResult
 * @property {boolean} ok
 * @property {number} [status] HTTP status, when there was a response.
 * @property {string} [error] What went wrong.
 */

export const TIMEOUT_MS = 10_000

/**
 * Decides what to send. Alerts and warnings are tracked; info findings are by design and
 * are never sent. Pure.
 *
 * @param {Finding[]} findings
 * @param {State} state
 * @param {{ now: number, cooldown: number }} options
 * @returns {Plan}
 */
export function planNotifications(findings, state, options) {
  const { now, cooldown } = options
  const nowIso = isoSeconds(now)
  /** @type {State} */
  const next = { version: 1, findings: {} }
  /** @type {Notice[]} */
  const notices = []
  for (const finding of findings) {
    if (finding.severity === 'info') continue
    const prev = state.findings[finding.key]
    const base = {
      agent: finding.agent,
      capability: finding.capability,
      code: finding.code,
      severity: finding.severity,
      detail: finding.detail,
    }
    if (!prev) {
      notices.push({ finding, repeat: false, firstSeen: nowIso })
      next.findings[finding.key] = { firstSeen: nowIso, lastNotified: nowIso, ...base }
      continue
    }
    const last = toMillis(prev.lastNotified) ?? 0
    if (now - last >= cooldown) {
      notices.push({ finding, repeat: true, firstSeen: prev.firstSeen })
      next.findings[finding.key] = { ...prev, ...base, lastNotified: nowIso }
    } else {
      next.findings[finding.key] = { ...prev, ...base }
    }
  }
  /** @type {Resolved[]} */
  const resolved = []
  for (const [key, entry] of Object.entries(state.findings)) {
    if (!(key in next.findings)) resolved.push({ key, entry })
  }
  return { notices, resolved, next }
}

/**
 * The message for one run, or null when there is nothing to say. Plain text, one line
 * per finding, so it reads the same in Slack, Discord, or a terminal.
 *
 * @param {Plan} plan
 * @param {{ now: number }} options
 * @returns {string | null}
 */
export function formatMessage(plan, options) {
  const { notices, resolved } = plan
  if (notices.length === 0 && resolved.length === 0) return null
  const alerts = notices.filter((n) => n.finding.severity === 'alert').length
  const warnings = notices.length - alerts
  const counts = [
    alerts ? `${alerts} alerting` : '',
    warnings ? `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}` : '',
    resolved.length ? `${resolved.length} resolved` : '',
  ].filter(Boolean)
  const lines = [`agent-pulse: ${counts.join(', ')}`]
  for (const { finding, repeat, firstSeen } of notices) {
    const since = repeat ? ` (still, first seen ${formatDuration(options.now - (toMillis(firstSeen) ?? options.now))} ago)` : ''
    lines.push(`[${finding.severity.toUpperCase()}] ${who(finding)} ${finding.code}: ${finding.detail}${since}`)
  }
  for (const { entry } of resolved) {
    const lasted = options.now - (toMillis(entry.firstSeen) ?? options.now)
    lines.push(`[RESOLVED] ${who(entry)} ${entry.code}${lasted > 0 ? `, after ${formatDuration(lasted)}` : ''}`)
  }
  return lines.join('\n')
}

/**
 * @param {{ agent: string | null, capability: string | null }} f
 * @returns {string}
 */
function who(f) {
  return f.agent === null ? 'event log' : `${f.agent}/${f.capability}`
}

/**
 * POSTs `{ "text": ... }` as JSON. That is the Slack incoming-webhook format; Discord
 * accepts it at the webhook URL with `/slack` on the end. Never throws.
 *
 * @param {string} url
 * @param {string} text
 * @param {{ fetch?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<SendResult>}
 */
export async function postWebhook(url, text, options = {}) {
  const { fetch: fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = options
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { ok: false, status: res.status, error: `webhook answered HTTP ${res.status}` }
    return { ok: true, status: res.status }
  } catch (error) {
    return { ok: false, error: describeError(error, timeoutMs) }
  }
}

/**
 * GETs a dead-man's-switch URL, such as a healthchecks.io check, to say this run
 * finished. Never throws.
 *
 * @param {string} url
 * @param {{ fetch?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<SendResult>}
 */
export async function pingHeartbeat(url, options = {}) {
  const { fetch: fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = options
  try {
    const res = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { ok: false, status: res.status, error: `heartbeat URL answered HTTP ${res.status}` }
    return { ok: true, status: res.status }
  } catch (error) {
    return { ok: false, error: describeError(error, timeoutMs) }
  }
}

/**
 * @param {unknown} error
 * @param {number} timeoutMs
 * @returns {string}
 */
function describeError(error, timeoutMs) {
  const e = /** @type {Error & { cause?: { message?: string } }} */ (error)
  if (e?.name === 'TimeoutError') return `no answer within ${timeoutMs / 1000}s`
  return e?.cause?.message ? `${e.message} (${e.cause.message})` : String(e?.message ?? error)
}
