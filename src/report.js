/**
 * @typedef {import('./evaluate.js').Result} Result
 * @typedef {import('./evaluate.js').Finding} Finding
 * @typedef {import('./evaluate.js').FindingCode} FindingCode
 * @typedef {import('./evaluate.js').Severity} Severity
 */

const COLOURS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
}

/** Headings for each finding code. */
export const CODE_TITLES = /** @type {Record<FindingCode, string>} */ ({
  no_events: 'No events recorded',
  silent: 'Silent',
  below_expected: 'Below expected volume',
  failure_streak: 'Failing repeatedly',
  auth_failure: 'Authentication failure',
  config_failure: 'Configuration failure',
  quota_exhausted: 'Quota or usage limit reached',
  undelivered: 'Accepted but not delivered',
  malformed_events: 'Unreadable event log lines',
  at_cap: 'At its designed limit',
})

const SECTIONS = /** @type {const} */ ([
  ['alert', 'ALERT', 'red'],
  ['warn', 'WARN', 'yellow'],
  ['info', 'INFO', 'cyan'],
])

/**
 * @param {boolean} enabled
 * @returns {(code: string, text: string) => string}
 */
function painter(enabled) {
  return (code, text) => (enabled ? `${code}${text}${COLOURS.reset}` : text)
}

/**
 * @param {string} text
 * @param {number} width
 * @param {string} indent
 * @returns {string}
 */
function wrap(text, width, indent) {
  /** @type {string[]} */
  const lines = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return lines.map((l) => indent + l).join('\n')
}

/**
 * @param {number} n
 * @param {string} word
 */
function count(n, word) {
  return `${n} ${n === 1 ? word : `${word}s`}`
}

/**
 * The report a person reads: the verdict first, then findings grouped by severity.
 *
 * @param {Result} result
 * @param {{ colour?: boolean, width?: number }} [options]
 * @returns {string}
 */
export function formatText(result, options = {}) {
  const { colour = true, width = 76 } = options
  const paint = painter(colour)
  const { summary } = result
  const lines = ['']

  if (result.healthy) {
    lines.push(`${paint(COLOURS.green, 'HEALTHY')}  ${paint(COLOURS.bold, `${count(summary.checks, 'check')}, nothing missing`)}`)
  } else {
    lines.push(
      `${paint(COLOURS.red, 'ALERT')}  ${paint(COLOURS.bold, `${count(summary.alerts, 'alert')}`)}` +
        paint(COLOURS.dim, ` across ${count(summary.checks, 'check')}`),
    )
  }
  lines.push(paint(COLOURS.dim, `         ${count(summary.events, 'event')} read, evaluated at ${result.now}`))

  for (const [severity, heading, colourName] of SECTIONS) {
    const group = result.findings.filter((f) => f.severity === severity)
    if (group.length === 0) continue
    lines.push('')
    lines.push(paint(COLOURS[colourName], heading))
    for (const f of group) {
      const who = f.agent === null ? 'event log' : `${f.agent}/${f.capability}`
      lines.push(`  ${paint(COLOURS.bold, who)}  ${CODE_TITLES[f.code]}`)
      lines.push(wrap(f.detail, width - 6, '      '))
    }
  }

  lines.push('')
  return lines.join('\n')
}
