import { readFile, rename, writeFile } from 'node:fs/promises'

/**
 * @typedef {object} StateEntry What was last said about one finding.
 * @property {string} firstSeen ISO 8601.
 * @property {string} lastNotified ISO 8601.
 * @property {string | null} agent
 * @property {string | null} capability
 * @property {import('./evaluate.js').FindingCode} code
 * @property {import('./evaluate.js').Severity} severity
 * @property {string} detail The most recent detail.
 *
 * @typedef {object} State
 * @property {1} version
 * @property {Record<string, StateEntry>} findings Keyed by finding key.
 */

export const DEFAULT_STATE_FILE = '.agent-pulse-state.json'

/** @returns {State} */
export function emptyState() {
  return { version: 1, findings: {} }
}

/**
 * Reads the state file. A missing file is an empty state. So is an unreadable one, with
 * `corrupt` set: losing cooldowns means a repeat notification, which beats no alerting.
 *
 * @param {string} path
 * @returns {Promise<{ state: State, corrupt: boolean }>}
 */
export async function loadState(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return { state: emptyState(), corrupt: false }
    throw error
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed && parsed.version === 1 && parsed.findings && typeof parsed.findings === 'object') {
      return { state: parsed, corrupt: false }
    }
  } catch {
    // Fall through.
  }
  return { state: emptyState(), corrupt: true }
}

/**
 * Writes the state atomically: a temporary file, then a rename over the old one, so a
 * crash mid-write never leaves half a file.
 *
 * @param {string} path
 * @param {State} state
 * @returns {Promise<void>}
 */
export async function saveState(path, state) {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`)
  await rename(tmp, path)
}
