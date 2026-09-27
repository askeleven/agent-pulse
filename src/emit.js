import { appendFile } from 'node:fs/promises'
import { eventProblem } from './events.js'

/**
 * Appends one event to the log, adding `ts` when it is left out. Each call is a single
 * append of one line, so several processes can write to the same log.
 *
 * @param {string} path
 * @param {import('./events.js').PulseEvent} event
 * @param {{ now?: number }} [options] `now` is for tests.
 * @returns {Promise<import('./events.js').PulseEvent>} What was written.
 */
export async function emit(path, event, options = {}) {
  const line = { ts: new Date(options.now ?? Date.now()).toISOString(), ...event }
  if (line.ts === undefined) line.ts = new Date(options.now ?? Date.now()).toISOString()
  const problem = eventProblem(line)
  if (problem) throw new TypeError(`Not a valid event: ${problem}.`)
  await appendFile(path, `${JSON.stringify(line)}\n`)
  return line
}
