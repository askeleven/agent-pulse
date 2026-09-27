import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { evaluate } from './evaluate.js'
import { readEvents } from './events.js'
import { loadRules, RulesError } from './rules.js'
import { toMillis } from './time.js'
import { VERSION } from './version.js'

/**
 * A Model Context Protocol server over stdio, written against the spec directly so the
 * package keeps zero runtime dependencies. Messages are newline-delimited JSON-RPC 2.0.
 */

/** Newest first. The first is offered when a client asks for one we do not know. */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

const INSTRUCTIONS =
  'Call pulse_status to find out whether an agent is actually doing its work, rather than ' +
  'assuming it is. If healthy is false, tell a person plainly which agent and capability ' +
  'is alerting and why, using the detail text. Never say an agent is working when a ' +
  'finding says it is silent or below what is expected: no activity is the failure, not ' +
  'a sign that all is well. An at_cap info finding means a designed limit was reached; ' +
  'that is by design, not an outage. A malformed_events warning means some log lines ' +
  'were skipped, so counts may be low.'

const TOOLS = [
  {
    name: 'pulse_status',
    title: 'Check whether agents are working',
    description:
      'Evaluates an agent-pulse rules file against a JSONL event log and returns healthy ' +
      '(false when anything is alerting) and the findings: agents that went silent, output ' +
      'below the expected volume inside a working window, repeated failures for one target ' +
      'and action, authentication, configuration or quota failures, and accepted messages ' +
      'that were never delivered. Read-only: it does not notify anyone.',
    inputSchema: {
      type: 'object',
      properties: {
        rules_path: { type: 'string', description: 'The pulse.json rules file.' },
        events_path: { type: 'string', description: 'The JSONL event log.' },
        now: {
          type: 'string',
          description: 'Evaluate as of this ISO 8601 time instead of now. For replaying a past incident.',
        },
      },
      required: ['rules_path', 'events_path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
]

/**
 * @typedef {object} ServeOptions
 * @property {NodeJS.ReadableStream} [input]
 * @property {NodeJS.WritableStream} [output]
 */

/**
 * Serves until the input stream closes.
 *
 * @param {ServeOptions} [options]
 * @returns {Promise<void>}
 */
export function serve(options = {}) {
  const { input = process.stdin, output = process.stdout } = options
  const send = (/** @type {object} */ message) => {
    output.write(`${JSON.stringify(message)}\n`)
  }

  /** @type {Promise<void>[]} */
  const pending = []
  const lines = createInterface({ input, crlfDelay: Infinity })
  lines.on('line', (line) => {
    if (!line.trim()) return
    pending.push(handleLine(line, send))
  })
  return new Promise((done) => {
    lines.on('close', () => {
      Promise.all(pending).then(() => done())
    })
  })
}

/**
 * @param {string} line
 * @param {(message: object) => void} send
 * @returns {Promise<void>}
 */
async function handleLine(line, send) {
  /** @type {any} */
  let message
  try {
    message = JSON.parse(line)
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }

  const isRequest = message && typeof message === 'object' && 'id' in message
  if (!isRequest) return // Notifications, including notifications/initialized.

  const { id, method, params } = message
  try {
    const result = await dispatch(method, params ?? {})
    send({ jsonrpc: '2.0', id, result })
  } catch (error) {
    const code = error instanceof RpcError ? error.code : -32603
    send({ jsonrpc: '2.0', id, error: { code, message: /** @type {Error} */ (error).message } })
  }
}

class RpcError extends Error {
  /**
   * @param {number} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * @param {string} method
 * @param {any} params
 * @returns {Promise<object>}
 */
async function dispatch(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion)
          ? params.protocolVersion
          : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-pulse', title: 'agent-pulse', version: VERSION },
        instructions: INSTRUCTIONS,
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call':
      return callTool(params.name, params.arguments ?? {})
    default:
      throw new RpcError(-32601, `Method not found: ${method}`)
  }
}

class ToolInputError extends Error {}

/**
 * Tool failures are results with isError set, not protocol errors, so the model sees
 * the message and can act on it.
 *
 * @param {string} name
 * @param {any} args
 * @returns {Promise<object>}
 */
async function callTool(name, args) {
  if (name !== 'pulse_status') throw new RpcError(-32602, `Unknown tool: ${name}`)
  try {
    const payload = await pulseStatus(args)
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    }
  } catch (error) {
    if (error instanceof RulesError || error instanceof ToolInputError) {
      return { content: [{ type: 'text', text: error.message }], isError: true }
    }
    throw error
  }
}

/**
 * @param {any} args
 */
async function pulseStatus(args) {
  if (typeof args.rules_path !== 'string' || !args.rules_path) throw new ToolInputError('rules_path is required.')
  if (typeof args.events_path !== 'string' || !args.events_path) throw new ToolInputError('events_path is required.')
  let now
  if (args.now !== undefined) {
    now = toMillis(args.now)
    if (now === null) throw new ToolInputError(`now must be an ISO 8601 time, got ${JSON.stringify(args.now)}.`)
  }
  const rules = await loadRules(resolve(args.rules_path))
  let log
  try {
    log = await readEvents(resolve(args.events_path))
  } catch (error) {
    throw new ToolInputError(`Could not read ${args.events_path}: ${/** @type {Error} */ (error).message}`)
  }
  const result = evaluate(rules, log.events, {
    now,
    malformed: log.malformed,
    malformedLines: log.malformedLines,
    missing: log.missing,
  })
  return { healthy: result.healthy, now: result.now, summary: result.summary, findings: result.findings }
}
