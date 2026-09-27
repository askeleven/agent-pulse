import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  evaluate,
  validateRules,
  parseEvents,
  readEvents,
  emit,
  RulesError,
  parseDuration,
  formatText,
} from '../src/index.js'

/** Monday 28 September 2026, New York is on EDT (UTC-4): 13:00Z is 09:00 local. */
const MONDAY = '2026-09-28'

/**
 * @param {string} time HH:MM in UTC on MONDAY, or a full ISO string.
 * @param {Partial<import('../src/events.js').PulseEvent>} [fields]
 * @returns {import('../src/events.js').PulseEvent}
 */
const ev = (time, fields = {}) => ({
  ts: time.length === 5 ? `${MONDAY}T${time}:00Z` : time,
  agent: 'sdr',
  capability: 'email',
  type: 'action',
  ...fields,
})

/** @param {string} time */
const at = (time) => `${MONDAY}T${time}:00Z`

/**
 * @param {object} check
 * @param {object} [defaults]
 */
const rules = (check, defaults = { tz: 'America/New_York' }) =>
  validateRules({ defaults, checks: [{ agent: 'sdr', capability: 'email', ...check }] })

/** @param {import('../src/evaluate.js').Result} result */
const codes = (result) => result.findings.map((f) => f.code)

const EXPECT = { expect: { min: 3, per: '1h', during: '09:00-17:00', days: 'mon-fri' } }

test('expect: silence inside the window is below_expected', () => {
  const events = [ev('12:00'), ev('12:10'), ev('12:20'), ev('12:30')]
  const result = evaluate(rules(EXPECT), events, { now: at('14:30') })
  assert.equal(result.healthy, false)
  assert.deepEqual(codes(result), ['below_expected'])
  const f = result.findings[0]
  assert.equal(f.key, 'sdr/email/below_expected')
  assert.equal(f.severity, 'alert')
  assert.deepEqual(
    { count: f.data.count, min: f.data.min },
    { count: 0, min: 3 },
  )
  assert.match(f.detail, /0 outputs in the last 1h, expected at least 3 \(mon-fri 09:00-17:00 America\/New_York\)/)
  assert.match(f.detail, /The last one was 2h ago/)
})

test('expect: enough output inside the window is healthy', () => {
  const events = [ev('13:40'), ev('13:50'), ev('14:00', { type: 'accepted', id: 'a' }), ev('14:01', { type: 'delivered', id: 'a' })]
  const result = evaluate(rules(EXPECT), events, { now: at('14:30') })
  assert.equal(result.healthy, true)
  assert.deepEqual(result.findings, [])
})

test('expect: a delivered event for an accepted id is not counted twice', () => {
  const events = [ev('13:40'), ev('14:00', { type: 'accepted', id: 'a' }), ev('14:01', { type: 'delivered', id: 'a' })]
  const result = evaluate(rules(EXPECT), events, { now: at('14:30') })
  assert.equal(result.findings[0].data.count, 2)
})

test('expect: run events do not count as output', () => {
  const events = [ev('14:00', { type: 'run' }), ev('14:10', { type: 'run' }), ev('14:20', { type: 'run' })]
  const result = evaluate(rules(EXPECT), events, { now: at('14:30') })
  assert.deepEqual(codes(result), ['below_expected'])
})

test('expect: outside the window, or on a day off, nothing is expected', () => {
  const events = [ev('10:00')]
  // 08:30 local, before the window opens.
  assert.equal(evaluate(rules(EXPECT), events, { now: at('12:30') }).healthy, true)
  // 18:00 local, after it closes.
  assert.equal(evaluate(rules(EXPECT), events, { now: at('22:00') }).healthy, true)
  // Sunday.
  assert.equal(evaluate(rules(EXPECT), [ev('2026-09-27T10:00:00Z')], { now: '2026-09-27T15:00:00Z' }).healthy, true)
})

test('expect: the first `per` of a window is not judged', () => {
  const events = [ev('10:00')]
  // 09:30 local: the window has been open 30m, less than the 1h it counts over.
  assert.equal(evaluate(rules(EXPECT), events, { now: at('13:30') }).healthy, true)
  assert.deepEqual(codes(evaluate(rules(EXPECT), events, { now: at('14:00') })), ['below_expected'])
})

test('expect: a window that runs past midnight', () => {
  const night = { expect: { min: 1, per: '30m', during: '22:00-02:00' } }
  const events = [ev('2026-09-28T01:00:00Z')]
  // 01:00 local on the 29th (05:00Z) belongs to the window that opened on the 28th.
  assert.deepEqual(codes(evaluate(rules(night), events, { now: '2026-09-29T05:00:00Z' })), ['below_expected'])
  assert.equal(evaluate(rules(night), events, { now: '2026-09-29T07:00:00Z' }).healthy, true)
})

test('expect: the window follows daylight saving in America/New_York', () => {
  const check = { expect: { min: 1, per: '15m', during: '09:00-11:15' } }
  // Sunday 8 March 2026, clocks go forward at 02:00. 09:00 is 13:00Z, not 14:00Z.
  // A fixed UTC-5 offset would put 13:20Z at 08:20, outside the window.
  const inside = evaluate(rules(check), [], { now: '2026-03-08T13:20:00Z' })
  assert.deepEqual(codes(inside), ['no_events'])
  const events = [ev('2026-03-08T12:00:00Z')]
  assert.deepEqual(codes(evaluate(rules(check), events, { now: '2026-03-08T13:20:00Z' })), ['below_expected'])
  // The day before, still EST: 09:00 is 14:00Z, so 13:20Z is 08:20, before the window.
  assert.equal(evaluate(rules(check), [ev('2026-03-07T12:00:00Z')], { now: '2026-03-07T13:20:00Z' }).healthy, true)
  assert.deepEqual(codes(evaluate(rules(check), [ev('2026-03-07T12:00:00Z')], { now: '2026-03-07T14:20:00Z' })), ['below_expected'])
  // 11:15 EDT on the 8th is 15:15Z; after it, the window is closed.
  assert.equal(evaluate(rules(check), events, { now: '2026-03-08T15:16:00Z' }).healthy, true)
  // And back in November: 1 November 2026, 09:00 EST is 14:00Z.
  const fall = [ev('2026-11-01T12:00:00Z')]
  assert.equal(evaluate(rules(check), fall, { now: '2026-11-01T13:20:00Z' }).healthy, true)
  assert.deepEqual(codes(evaluate(rules(check), fall, { now: '2026-11-01T14:20:00Z' })), ['below_expected'])
})

test('expect: several windows for one agent, each judged on its own', () => {
  const two = rules({
    expect: [
      { min: 3, per: '1h', during: '09:00-11:00', days: 'mon-fri' },
      { min: 2, per: '1h', during: '14:00-17:00', days: 'mon-fri' },
    ],
  })
  const morning = [ev('13:10'), ev('13:30'), ev('13:50')]
  // Midday is between windows, so no output is expected.
  assert.equal(evaluate(two, morning, { now: at('16:30') }).healthy, true)
  // An hour into the afternoon window with nothing sent.
  const result = evaluate(two, morning, { now: at('19:30') })
  assert.deepEqual(codes(result), ['below_expected'])
  assert.equal(result.findings[0].key, 'sdr/email/below_expected/expect1')
  assert.throws(() => rules({ expect: [] }), /expect: must not be an empty array/)
})

test('cap: reaching the designed limit turns below_expected into at_cap info', () => {
  const check = { ...EXPECT, cap: { max: 5, per: 'day' } }
  // Five sends early this morning (local), none in the last hour.
  const events = ['12:01', '12:02', '12:03', '12:04', '12:05'].map((t) => ev(t))
  const result = evaluate(rules(check), events, { now: at('14:30') })
  assert.equal(result.healthy, true)
  assert.deepEqual(codes(result), ['at_cap'])
  assert.equal(result.findings[0].severity, 'info')
  assert.match(result.findings[0].detail, /^Designed limit reached, not an outage: 5 of 5 today/)
  // Yesterday's sends do not count toward today's cap.
  const yesterday = events.map((e) => ({ ...e, ts: String(e.ts).replace('09-28', '09-27') }))
  assert.deepEqual(codes(evaluate(rules(check), yesterday, { now: at('14:30') })), ['below_expected'])
})

test('cap: a trailing duration', () => {
  const check = { ...EXPECT, cap: { max: 2, per: '3h' } }
  const events = [ev('12:00'), ev('12:10')]
  assert.deepEqual(codes(evaluate(rules(check), events, { now: at('14:30') })), ['at_cap'])
  assert.deepEqual(codes(evaluate(rules(check), events, { now: at('15:30') })), ['below_expected'])
})

test('streak: reads succeeding do not hide sends failing', () => {
  const read = { target: 'gmail', action: 'read' }
  const send = { target: 'gmail', action: 'send' }
  const events = [
    ev('14:00', send),
    ev('14:01', { ...send, type: 'failed', detail: '550 recipient rejected' }),
    ev('14:02', read),
    ev('14:03', { ...send, type: 'failed' }),
    ev('14:04', read),
    ev('14:05', { ...send, type: 'failed', error_class: 'transient', detail: '550 recipient rejected' }),
    ev('14:06', read),
  ]
  const result = evaluate(rules({ streak: { failures: 3 } }), events, { now: at('14:10') })
  assert.deepEqual(codes(result), ['failure_streak'])
  const f = result.findings[0]
  assert.equal(f.key, 'sdr/email/failure_streak/gmail/send')
  assert.equal(f.data.count, 3)
  assert.match(f.detail, /^3 failures in a row for send on gmail/)
  assert.match(f.detail, /550 recipient rejected$/)
})

test('streak: a success for the same target and action resets it', () => {
  const send = { target: 'gmail', action: 'send' }
  const events = [
    ev('14:01', { ...send, type: 'failed' }),
    ev('14:02', { ...send, type: 'failed', error_class: 'rate_limit' }),
    ev('14:03', send),
    ev('14:04', { ...send, type: 'failed' }),
  ]
  assert.equal(evaluate(rules({ streak: { failures: 3 } }), events, { now: at('14:10') }).healthy, true)
})

test('error classes: input never alerts or counts; auth, config and quota alert on the first', () => {
  const send = { target: 'gmail', action: 'send' }
  const inputOnly = [1, 2, 3, 4, 5].map((m) => ev(`14:0${m}`, { ...send, type: 'failed', error_class: 'input' }))
  assert.equal(evaluate(rules({ streak: { failures: 3 } }), inputOnly, { now: at('14:10') }).healthy, true)

  const mixed = [
    ev('14:01', { ...send, type: 'failed' }),
    ev('14:02', { ...send, type: 'failed', error_class: 'input' }),
    ev('14:03', { ...send, type: 'failed' }),
  ]
  assert.equal(evaluate(rules({ streak: { failures: 3 } }), mixed, { now: at('14:10') }).healthy, true)

  const hard = [
    ev('14:01', { target: 'crm', action: 'write', type: 'failed', error_class: 'auth', detail: '401 token expired' }),
    ev('14:02', { target: 'model', type: 'failed', error_class: 'quota', detail: 'usage limit reached' }),
    ev('14:03', { target: 'calendar', action: 'book', type: 'failed', error_class: 'config' }),
  ]
  // No streak rule at all: these alert anyway.
  const result = evaluate(rules({}), hard, { now: at('14:10') })
  assert.deepEqual(
    result.findings.map((f) => f.key),
    ['sdr/email/auth_failure/crm/write', 'sdr/email/config_failure/calendar/book', 'sdr/email/quota_exhausted/model/-'],
  )
  assert.match(result.findings[0].detail, /^Authentication failed for write on crm, 1 time with no success since\. Last 9m ago: 401 token expired$/)

  // A later success for the same target and action clears it.
  const fixed = [...hard, ev('14:05', { target: 'crm', action: 'write' })]
  assert.deepEqual(codes(evaluate(rules({}), fixed, { now: at('14:10') })), ['config_failure', 'quota_exhausted'])
})

test('delivery: accepted without delivered after `within` is undelivered; delivered in time is fine', () => {
  const check = { capability: 'sms', delivery: { within: '30m' } }
  const sms = (/** @type {string} */ t, /** @type {object} */ f) => ev(t, { capability: 'sms', ...f })
  const events = [
    sms('13:00', { type: 'accepted', id: 'a' }),
    sms('13:02', { type: 'delivered', id: 'a' }),
    sms('13:10', { type: 'accepted', id: 'b' }),
    sms('13:20', { type: 'accepted', id: 'c' }),
    sms('13:21', { type: 'failed', id: 'c', detail: 'carrier refused' }),
    sms('13:50', { type: 'accepted', id: 'd' }), // Still has time.
  ]
  const result = evaluate(rules(check), events, { now: at('14:00') })
  assert.deepEqual(codes(result), ['undelivered'])
  const f = result.findings[0]
  assert.equal(f.key, 'sdr/sms/undelivered')
  assert.deepEqual(f.data.ids, ['b', 'c'])
  assert.equal(f.data.failed, 1)
  assert.match(f.detail, /^2 of 3 accepted messages not delivered within 30m \(1 reported failed\): b, c\.$/)

  const allDelivered = [
    sms('13:00', { type: 'accepted', id: 'a' }),
    sms('13:25', { type: 'delivered', id: 'a' }),
  ]
  assert.equal(evaluate(rules(check), allDelivered, { now: at('14:00') }).healthy, true)
})

test('delivery: lists at most ten ids', () => {
  const check = { delivery: { within: '5m' } }
  const events = Array.from({ length: 12 }, (_, i) => ev('13:00', { type: 'accepted', id: `m${i}` }))
  const f = evaluate(rules(check), events, { now: at('14:00') }).findings[0]
  assert.equal(f.data.count, 12)
  assert.equal(/** @type {string[]} */ (f.data.ids).length, 10)
  assert.match(f.detail, /and 2 more\.$/)
})

test('heartbeat: no events at all for the check in `every` is silent', () => {
  const check = { heartbeat: { every: '10m' } }
  const other = ev('14:25', { capability: 'inbox' })
  const events = [ev('14:00', { type: 'run' }), other]
  const result = evaluate(rules(check), events, { now: at('14:30') })
  assert.deepEqual(codes(result), ['silent'])
  assert.match(result.findings[0].detail, /^No events in the last 10m\. The last one was 30m ago \(run\)\.$/)
  assert.equal(evaluate(rules(check), [ev('14:25', { type: 'run' })], { now: at('14:30') }).healthy, true)
  assert.match(evaluate(rules(check), [other], { now: at('14:30') }).findings[0].detail, /No events have ever been recorded for sdr\/email/)
})

test('no_events: a missing or empty log is one alert, not one per check', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pulse-'))
  const log = await readEvents(join(dir, 'nope.jsonl'))
  assert.equal(log.missing, true)
  const result = evaluate(rules({ heartbeat: { every: '10m' }, ...EXPECT }), log.events, { now: at('14:30'), missing: log.missing })
  assert.deepEqual(result.findings.map((f) => f.key), ['events/no_events'])
  assert.match(result.findings[0].detail, /^The event log does not exist/)
  assert.equal(result.healthy, false)
  assert.match(evaluate(rules({}), [], { now: at('14:30') }).findings[0].detail, /^The event log has no events/)
})

test('malformed lines are counted, reported once as a warning, and never crash', () => {
  const text = [
    JSON.stringify(ev('14:00')),
    'not json',
    '',
    JSON.stringify({ ...ev('14:01'), type: 'sent' }),
    JSON.stringify({ ...ev('14:02'), ts: 'yesterday' }),
    '[1,2]',
    JSON.stringify(ev('14:03', { id: 42 })),
  ].join('\n')
  const log = parseEvents(text)
  assert.equal(log.events.length, 2)
  assert.equal(log.events[1].id, '42')
  assert.equal(log.malformed, 4)
  assert.deepEqual(log.malformedLines, [2, 4, 5, 6])
  const result = evaluate(rules({ heartbeat: { every: '1h' } }), log.events, { now: at('14:30'), ...log })
  assert.equal(result.healthy, true, 'a warning alone is not an outage')
  assert.deepEqual(result.findings.map((f) => [f.key, f.severity]), [['events/malformed_events', 'warn']])
  assert.match(result.findings[0].detail, /^4 lines in the event log could not be read and were skipped \(line 2, 4, 5, 6\)\.$/)
})

test('evaluate accepts raw events and epoch milliseconds, and ignores events after now', () => {
  const result = evaluate(
    { checks: [{ agent: 'sdr', capability: 'email', heartbeat: { every: '10m' } }] },
    [{ ts: Date.parse(at('14:25')), agent: 'sdr', capability: 'email', type: 'run' }, ev('15:00'), { nonsense: true }],
    { now: at('14:30') },
  )
  assert.equal(result.summary.events, 1)
  assert.deepEqual(codes(result), ['malformed_events'])
})

test('findings are ordered by severity, then key', () => {
  const check = { ...EXPECT, heartbeat: { every: '10m' }, streak: { failures: 1 } }
  const events = [ev('12:00', { type: 'failed', target: 'x' }), 'garbage']
  const result = evaluate(rules(check), events, { now: at('14:30') })
  assert.deepEqual(result.findings.map((f) => f.key), [
    'sdr/email/below_expected',
    'sdr/email/failure_streak/x/-',
    'sdr/email/silent',
    'events/malformed_events',
  ])
  assert.deepEqual(result.summary, { checks: 1, events: 1, alerts: 3, warnings: 1, info: 0 })
})

test('rules: every problem is reported with where it is', () => {
  assert.throws(
    () =>
      validateRules({
        defaults: { tz: 'Mars/Olympus', colour: 'red' },
        checks: [
          { agent: 'sdr', capability: 'email', expect: { min: 0, per: '15 minutes', during: '9-5', days: 'weekdays' } },
          { agent: 'sdr', capability: 'email', heartbeat: { every: 600 } },
          { capability: 'sms', cap: { max: 10, per: 'day' }, delivery: { within: '30m', lookback: 'forever' } },
          { agent: 'a', capability: 'b', expect: { min: 1, per: '2h', during: '09:00-10:00' } },
        ],
      }),
    (/** @type {RulesError} */ error) => {
      assert.ok(error instanceof RulesError)
      const expected = [
        /^defaults\.colour: unknown field/,
        /^defaults\.tz: is not a time zone/,
        /^checks\[0\]\.expect\.min: must be a whole number/,
        /^checks\[0\]\.expect\.per: must be a duration/,
        /^checks\[0\]\.expect\.during: must look like "09:00-17:00"/,
        /^checks\[0\]\.expect\.days: "weekdays" is not a day or range/,
        /^checks\[1\]: repeats sdr\/email from checks\[0\]/,
        /^checks\[1\]\.heartbeat\.every: must be a duration/,
        /^checks\[2\]\.agent: is required/,
        /^checks\[2\]\.delivery\.lookback: must be a duration/,
        /^checks\[2\]\.cap: only changes how "expect" is reported/,
        /^checks\[3\]\.expect\.per: is longer than the window/,
      ]
      assert.equal(error.problems.length, expected.length, error.message)
      expected.forEach((re, i) => assert.match(error.problems[i], re))
      return true
    },
  )
  assert.throws(() => validateRules({ checks: [] }), /checks: must be a non-empty array/)
  assert.throws(() => validateRules([]), /must be a JSON object/)
})

test('rules: days accepts ranges, lists and wrap-around', () => {
  const days = (/** @type {unknown} */ d) =>
    validateRules({ checks: [{ agent: 'a', capability: 'b', expect: { min: 1, per: '1h', days: d } }] }).checks[0].expect?.[0].days
  assert.deepEqual(days('mon-fri'), [1, 2, 3, 4, 5])
  assert.deepEqual(days(['sat', 'sun']), [0, 6])
  assert.deepEqual(days('fri-mon'), [0, 1, 5, 6])
  assert.deepEqual(days('Mon, wed'), [1, 3])
})

test('parseDuration', () => {
  assert.equal(parseDuration('15m'), 900_000)
  assert.equal(parseDuration('1h30m'), 5_400_000)
  assert.equal(parseDuration('1d'), 86_400_000)
  assert.equal(parseDuration('45s'), 45_000)
  assert.equal(parseDuration('15'), null)
  assert.equal(parseDuration('soon'), null)
  assert.equal(parseDuration(''), null)
})

test('emit appends one line and fills in ts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pulse-'))
  const path = join(dir, 'events.jsonl')
  await writeFile(path, '')
  const now = Date.parse(at('14:00'))
  await emit(path, { agent: 'sdr', capability: 'email', type: 'action', target: 'gmail' }, { now })
  await emit(path, { ts: at('14:05'), agent: 'sdr', capability: 'email', type: 'run' })
  await assert.rejects(emit(path, /** @type {any} */ ({ agent: 'sdr', capability: 'email', type: 'nope' })), /Not a valid event: type must be one of/)
  const lines = (await readFile(path, 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(lines, [
    { ts: '2026-09-28T14:00:00.000Z', agent: 'sdr', capability: 'email', type: 'action', target: 'gmail' },
    { ts: at('14:05'), agent: 'sdr', capability: 'email', type: 'run' },
  ])
})

test('formatText: verdict first, findings grouped by severity', () => {
  const healthy = evaluate(rules({ heartbeat: { every: '1h' } }), [ev('14:20')], { now: at('14:30') })
  assert.match(formatText(healthy, { colour: false }), /^\nHEALTHY {2}1 check, nothing missing\n {9}1 event read, evaluated at 2026-09-28T14:30:00Z\n$/)

  const events = [ev('12:00'), 'garbage']
  const alerting = evaluate(rules({ ...EXPECT, heartbeat: { every: '10m' } }), events, { now: at('14:30') })
  const text = formatText(alerting, { colour: false })
  assert.match(text, /^\nALERT {2}2 alerts across 1 check\n/)
  assert.match(text, /\nALERT\n {2}sdr\/email {2}Below expected volume\n {6}0 outputs/)
  assert.match(text, /\nWARN\n {2}event log {2}Unreadable event log lines\n/)
  assert.ok(text.indexOf('\nALERT\n') < text.indexOf('\nWARN\n'))
})
