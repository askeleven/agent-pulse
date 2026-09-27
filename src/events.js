import { readFile } from 'node:fs/promises'
import { toMillis } from './time.js'

/**
 * @typedef {'run'|'action'|'accepted'|'delivered'|'failed'} EventType
 *
 * @typedef {'auth'|'config'|'quota'|'transient'|'rate_limit'|'input'} ErrorClass
 *
 * @typedef {object} PulseEvent One line of the event log, as an agent writes it.
 * @property {string | number} [ts] ISO 8601 time or epoch milliseconds. Required in the
 *   log; `emit` fills it in when it is left out.
 * @property {string} agent Which agent, such as `sdr`.
 * @property {string} capability What it was doing, such as `email`. One capability per
 *   thing whose volume you want to count.
 * @property {EventType} type `run` for a scheduler tick or a turn that started, `action`
 *   for work done, `accepted` when a provider took a message, `delivered` when it confirmed
 *   it arrived, `failed` when something did not work.
 * @property {string} [target] The system acted on: a provider, integration or inbox. Not
 *   an individual recipient; put that in `id` or `detail`.
 * @property {string} [action] Such as `send` or `read`.
 * @property {string | number} [id] Message or job id, to match `accepted` with `delivered`.
 * @property {ErrorClass | string} [error_class] On `failed` events.
 * @property {string} [detail] Free text, shown in alerts.
 *
 * @typedef {object} Event A parsed event.
 * @property {number} t Epoch milliseconds.
 * @property {string} agent
 * @property {string} capability
 * @property {EventType} type
 * @property {string} [target]
 * @property {string} [action]
 * @property {string} [id]
 * @property {string} [error_class]
 * @property {string} [detail]
 *
 * @typedef {object} EventLog
 * @property {Event[]} events In file order.
 * @property {number} malformed Lines that could not be read.
 * @property {number[]} malformedLines Line numbers of the first ten.
 * @property {boolean} missing The file does not exist.
 */

/** @type {readonly EventType[]} */
export const EVENT_TYPES = ['run', 'action', 'accepted', 'delivered', 'failed']

/** @type {readonly ErrorClass[]} */
export const ERROR_CLASSES = ['auth', 'config', 'quota', 'transient', 'rate_limit', 'input']

const OPTIONAL_FIELDS = /** @type {const} */ (['target', 'action', 'id', 'error_class', 'detail'])
const MAX_LINES_REPORTED = 10

/**
 * What is wrong with an event, or null when it is fine.
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
export function eventProblem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not a JSON object'
  const e = /** @type {Record<string, unknown>} */ (raw)
  if (toMillis(e.ts) === null) return 'ts must be an ISO 8601 time or epoch milliseconds'
  for (const field of ['agent', 'capability']) {
    if (typeof e[field] !== 'string' || !e[field]) return `${field} must be a non-empty string`
  }
  if (!EVENT_TYPES.includes(/** @type {EventType} */ (e.type))) {
    return `type must be one of ${EVENT_TYPES.join(', ')}`
  }
  for (const field of OPTIONAL_FIELDS) {
    const v = e[field]
    if (v === undefined || v === null || typeof v === 'string') continue
    if (field === 'id' && typeof v === 'number') continue
    return `${field} must be a string`
  }
  return null
}

/**
 * @param {unknown} raw
 * @returns {Event | null} Null when the event is not valid.
 */
export function normaliseEvent(raw) {
  if (eventProblem(raw) !== null) return null
  const e = /** @type {Record<string, unknown>} */ (raw)
  /** @type {Event} */
  const event = {
    t: /** @type {number} */ (toMillis(e.ts)),
    agent: /** @type {string} */ (e.agent),
    capability: /** @type {string} */ (e.capability),
    type: /** @type {EventType} */ (e.type),
  }
  for (const field of OPTIONAL_FIELDS) {
    const v = e[field]
    if (v !== undefined && v !== null && v !== '') event[field] = String(v)
  }
  return event
}

/**
 * Parses JSONL. Blank lines are skipped; lines that are not valid events are counted,
 * never thrown.
 *
 * @param {string} text
 * @returns {Omit<EventLog, 'missing'>}
 */
export function parseEvents(text) {
  /** @type {Event[]} */
  const events = []
  let malformed = 0
  /** @type {number[]} */
  const malformedLines = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    let event = null
    try {
      event = normaliseEvent(JSON.parse(line))
    } catch {
      event = null
    }
    if (event) {
      events.push(event)
    } else {
      malformed++
      if (malformedLines.length < MAX_LINES_REPORTED) malformedLines.push(i + 1)
    }
  }
  return { events, malformed, malformedLines }
}

/**
 * Reads an event log. A missing file is reported, not thrown: an agent that never wrote
 * anything is exactly what this is here to catch.
 *
 * @param {string} path
 * @returns {Promise<EventLog>}
 */
export async function readEvents(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      return { events: [], malformed: 0, malformedLines: [], missing: true }
    }
    throw error
  }
  return { ...parseEvents(text), missing: false }
}
