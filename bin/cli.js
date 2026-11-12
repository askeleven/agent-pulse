#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { check, emit, RulesError, EVENT_TYPES } from '../src/index.js'
import { formatText } from '../src/report.js'
import { toMillis } from '../src/time.js'
import { serve } from '../src/mcp.js'
import { VERSION } from '../src/version.js'
import { starHint } from './star-hint.js'

const USAGE = `
agent-pulse check --rules pulse.json --events events.jsonl [options]
agent-pulse emit --events events.jsonl --agent <a> --capability <c> --type <t> [fields]
agent-pulse mcp

  Alerts when an agent stops doing its work. Reads a JSONL log of what agents did and
  a rules file saying what they should be doing, and reports what is missing: no
  events, output below the expected volume, repeated failures, and messages accepted
  but never delivered. Run it from cron.

check
  --rules <file>         The rules file. Required.
  --events <file>        The event log. Required. A missing file is an alert.
  --state <file>         Cooldown state. Default .agent-pulse-state.json next to the
                         rules. Only used with a webhook.
  --webhook <url>        POST new and repeat alerts, and resolutions, as {"text": ...}.
  --heartbeat-url <url>  GET after every evaluation that completes, alerting or not.
  --now <iso>            Evaluate as of this time. For replaying an incident.
  --json                 Machine-readable output.
  --no-colour            Plain text.

emit
  --events <file>        The log to append to. Required.
  --agent, --capability  Required.
  --type <t>             ${EVENT_TYPES.join(', ')}. Required.
  --target, --action, --id, --error-class, --detail, --ts
                         Optional. ts defaults to now.

  --version, --help

Environment
  AGENT_PULSE_WEBHOOK_URL     Used when --webhook is not given.
  AGENT_PULSE_HEARTBEAT_URL   Used when --heartbeat-url is not given.

Exit codes
  0  healthy
  1  alerting
  2  could not run

Examples
  npx @askeleven/agent-pulse check --rules pulse.json --events events.jsonl
  npx @askeleven/agent-pulse emit --events events.jsonl --agent sdr --capability email --type action
  npx @askeleven/agent-pulse mcp       # MCP server over stdio, for agents
`

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function main(argv) {
  const [command, ...rest] = argv
  if (command === 'mcp') {
    await serve()
    return 0
  }
  if (command === 'check') return runCheck(rest)
  if (command === 'emit') return runEmit(rest)
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE)
    return command === undefined ? 2 : 0
  }
  process.stderr.write(`Unknown command: ${command}\n${USAGE}`)
  return 2
}

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
async function runCheck(args) {
  let values
  try {
    values = parseArgs({
      args,
      options: {
        rules: { type: 'string' },
        events: { type: 'string' },
        state: { type: 'string' },
        webhook: { type: 'string' },
        'heartbeat-url': { type: 'string' },
        now: { type: 'string' },
        json: { type: 'boolean', default: false },
        // parseArgs has no --no-x negation, so both spellings are declared explicitly.
        'no-colour': { type: 'boolean', default: false },
        'no-color': { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }).values
  } catch (error) {
    process.stderr.write(`${/** @type {Error} */ (error).message}\n${USAGE}`)
    return 2
  }
  if (values.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  if (!values.rules || !values.events) {
    process.stderr.write(`check needs --rules and --events.\n${USAGE}`)
    return 2
  }
  if (values.now !== undefined && toMillis(values.now) === null) {
    process.stderr.write(`--now must be an ISO 8601 time, got ${values.now}\n`)
    return 2
  }

  let run
  try {
    run = await check({
      rulesPath: values.rules,
      eventsPath: values.events,
      statePath: values.state,
      webhookUrl: values.webhook || process.env.AGENT_PULSE_WEBHOOK_URL || undefined,
      heartbeatUrl: values['heartbeat-url'] || process.env.AGENT_PULSE_HEARTBEAT_URL || undefined,
      now: values.now,
    })
  } catch (error) {
    if (error instanceof RulesError) {
      process.stderr.write(`${error.message}\n`)
      return 2
    }
    process.stderr.write(`Could not run: ${/** @type {Error} */ (error).message}\n`)
    return 2
  }

  const { result, notification, heartbeat, warnings } = run
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ ...result, notification, heartbeat }, null, 2)}\n`)
  } else {
    process.stdout.write(formatText(result, { colour: useColour(values) }))
    if (notification?.sent) {
      process.stdout.write(
        `Posted to the webhook: ${notification.alerts} ${notification.alerts === 1 ? 'finding' : 'findings'}, ` +
          `${notification.resolved} resolved.\n\n`,
      )
    } else if (notification && !notification.error) {
      process.stdout.write('Nothing new to post to the webhook.\n\n')
    }
  }
  if (notification?.error) process.stderr.write(`Webhook failed: ${notification.error}. Will retry next run.\n`)
  if (heartbeat && !heartbeat.ok) process.stderr.write(`Heartbeat ping failed: ${heartbeat.error}\n`)
  for (const warning of warnings) process.stderr.write(`${warning}\n`)

  return result.healthy ? 0 : 1
}

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
async function runEmit(args) {
  let values
  try {
    values = parseArgs({
      args,
      options: {
        events: { type: 'string' },
        agent: { type: 'string' },
        capability: { type: 'string' },
        type: { type: 'string' },
        target: { type: 'string' },
        action: { type: 'string' },
        id: { type: 'string' },
        'error-class': { type: 'string' },
        detail: { type: 'string' },
        ts: { type: 'string' },
      },
    }).values
  } catch (error) {
    process.stderr.write(`${/** @type {Error} */ (error).message}\n${USAGE}`)
    return 2
  }
  if (!values.events) {
    process.stderr.write(`emit needs --events.\n${USAGE}`)
    return 2
  }
  try {
    await emit(values.events, {
      ...(values.ts ? { ts: values.ts } : {}),
      agent: values.agent ?? '',
      capability: values.capability ?? '',
      type: /** @type {import('../src/events.js').EventType} */ (values.type ?? ''),
      target: values.target,
      action: values.action,
      id: values.id,
      error_class: values['error-class'],
      detail: values.detail,
    })
  } catch (error) {
    process.stderr.write(`${/** @type {Error} */ (error).message}\n`)
    return 2
  }
  return 0
}

/**
 * Honours --no-colour, --no-color, NO_COLOR, and a non-TTY stdout.
 *
 * @param {Record<string, unknown>} values
 * @returns {boolean}
 */
function useColour(values) {
  if (values['no-colour'] || values['no-color']) return false
  if (process.env.NO_COLOR) return false
  return process.stdout.isTTY === true
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
    starHint('agent-pulse', code, process.argv.slice(2))
  },
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exitCode = 2
  },
)
