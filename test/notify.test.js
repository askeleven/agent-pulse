import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { check, planNotifications, formatMessage, postWebhook, pingHeartbeat, emptyState, loadState } from '../src/index.js'

const RULES = {
  defaults: { tz: 'America/New_York', cooldown: '30m' },
  checks: [{ agent: 'sdr', capability: 'email', heartbeat: { every: '10m' } }],
}

/** @param {string} time HH:MM UTC on 28 September 2026 */
const at = (time) => `2026-09-28T${time}:00Z`

/**
 * A fetch that records every call and answers with `status`.
 *
 * @param {number | Error} [status]
 */
function fakeFetch(status = 200) {
  /** @type {{ url: string, method: string, body: any }[]} */
  const calls = []
  /** @type {typeof fetch} */
  const fn = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
    if (status instanceof Error) throw status
    return new Response('ok', { status })
  }
  return { fn, calls }
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pulse-'))
  const rulesPath = join(dir, 'pulse.json')
  const eventsPath = join(dir, 'events.jsonl')
  await writeFile(rulesPath, JSON.stringify(RULES))
  await writeFile(eventsPath, `${JSON.stringify({ ts: at('14:00'), agent: 'sdr', capability: 'email', type: 'run' })}\n`)
  return { dir, rulesPath, eventsPath }
}

test('check: posts {text} once, stays quiet within the cooldown, repeats after it, resolves once', async () => {
  const { dir, rulesPath, eventsPath } = await setup()
  const { fn, calls } = fakeFetch()
  const base = { rulesPath, eventsPath, webhookUrl: 'https://hooks.example/abc', fetch: fn }

  // 14:20: silent for 20m. First notification.
  const first = await check({ ...base, now: at('14:20') })
  assert.equal(first.result.healthy, false)
  assert.deepEqual(first.notification, { sent: true, alerts: 1, resolved: 0 })
  assert.equal(first.statePath, join(dir, '.agent-pulse-state.json'))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].url, 'https://hooks.example/abc')
  assert.deepEqual(Object.keys(calls[0].body), ['text'])
  assert.equal(
    calls[0].body.text,
    'agent-pulse: 1 alerting\n[ALERT] sdr/email silent: No events in the last 10m. The last one was 20m ago (run).',
  )

  // 14:40: still silent, 20m after the last notification. Suppressed.
  const second = await check({ ...base, now: at('14:40') })
  assert.equal(second.result.healthy, false)
  assert.deepEqual(second.notification, { sent: false, alerts: 0, resolved: 0 })
  assert.equal(calls.length, 1)

  // 14:50: 30m since the last notification. Repeated, saying how long it has been.
  const third = await check({ ...base, now: at('14:50') })
  assert.equal(third.notification?.sent, true)
  assert.equal(calls.length, 2)
  assert.match(calls[1].body.text, /\(still, first seen 30m ago\)$/)

  // The agent recovers: one resolved message, then nothing.
  await writeFile(eventsPath, `${JSON.stringify({ ts: at('14:55'), agent: 'sdr', capability: 'email', type: 'run' })}\n`, { flag: 'a' })
  const fourth = await check({ ...base, now: at('15:00') })
  assert.equal(fourth.result.healthy, true)
  assert.deepEqual(fourth.notification, { sent: true, alerts: 0, resolved: 1 })
  assert.equal(calls[2].body.text, 'agent-pulse: 1 resolved\n[RESOLVED] sdr/email silent, after 40m')

  const fifth = await check({ ...base, now: at('15:01') })
  assert.deepEqual(fifth.notification, { sent: false, alerts: 0, resolved: 0 })
  assert.equal(calls.length, 3)
  assert.deepEqual((await loadState(join(dir, '.agent-pulse-state.json'))).state, { version: 1, findings: {} })
})

test('check: a failed webhook is reported, never thrown, and retried next run', async () => {
  const { dir, rulesPath, eventsPath } = await setup()
  const down = fakeFetch(500)
  const run = await check({ rulesPath, eventsPath, webhookUrl: 'https://hooks.example/x', fetch: down.fn, now: at('14:20') })
  assert.equal(run.result.healthy, false)
  assert.deepEqual(run.notification, { sent: false, alerts: 1, resolved: 0, error: 'webhook answered HTTP 500' })
  assert.equal(existsSync(join(dir, '.agent-pulse-state.json')), false, 'state not advanced')

  const unreachable = fakeFetch(new TypeError('fetch failed'))
  const again = await check({ rulesPath, eventsPath, webhookUrl: 'https://hooks.example/x', fetch: unreachable.fn, now: at('14:21') })
  assert.equal(again.notification?.error, 'fetch failed')

  const up = fakeFetch()
  const later = await check({ rulesPath, eventsPath, webhookUrl: 'https://hooks.example/x', fetch: up.fn, now: at('14:22') })
  assert.equal(later.notification?.sent, true)
  assert.equal(up.calls.length, 1)
})

test('check: the heartbeat URL is pinged after every evaluation, alerting or not', async () => {
  const { rulesPath, eventsPath } = await setup()
  const { fn, calls } = fakeFetch()
  const alerting = await check({ rulesPath, eventsPath, heartbeatUrl: 'https://hc.example/ping/1', fetch: fn, now: at('14:20') })
  assert.equal(alerting.result.healthy, false)
  assert.deepEqual(alerting.heartbeat, { ok: true, status: 200 })
  const healthy = await check({ rulesPath, eventsPath, heartbeatUrl: 'https://hc.example/ping/1', fetch: fn, now: at('14:05') })
  assert.equal(healthy.result.healthy, true)
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [
    ['GET', 'https://hc.example/ping/1'],
    ['GET', 'https://hc.example/ping/1'],
  ])
  assert.equal(healthy.notification, null, 'no webhook, no state')
})

test('check: an explicit state path, and a corrupt state file is a warning, not a failure', async () => {
  const { dir, rulesPath, eventsPath } = await setup()
  const statePath = join(dir, 'custom-state.json')
  await writeFile(statePath, '{ not json')
  const { fn } = fakeFetch()
  const run = await check({ rulesPath, eventsPath, statePath, webhookUrl: 'https://h.example', fetch: fn, now: at('14:20') })
  assert.equal(run.notification?.sent, true)
  assert.match(run.warnings[0], /was unreadable; starting fresh/)
  const saved = JSON.parse(await readFile(statePath, 'utf8'))
  assert.deepEqual(Object.keys(saved.findings), ['sdr/email/silent'])
  assert.equal(saved.findings['sdr/email/silent'].firstSeen, at('14:20'))
})

test('planNotifications: info findings are never sent', () => {
  const plan = planNotifications(
    [{ key: 'a/b/at_cap', code: 'at_cap', severity: 'info', agent: 'a', capability: 'b', detail: 'x', data: {} }],
    emptyState(),
    { now: Date.parse(at('14:00')), cooldown: 0 },
  )
  assert.deepEqual(plan.notices, [])
  assert.equal(formatMessage(plan, { now: 0 }), null)
})

test('postWebhook and pingHeartbeat time out instead of hanging', async () => {
  // AbortSignal.timeout does not hold the event loop open; a real socket would.
  /** @type {typeof fetch} */
  const hang = (_url, init) =>
    new Promise((_resolve, reject) => {
      const socket = setTimeout(() => reject(new Error('the timeout never fired')), 5000)
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(socket)
        reject(init.signal?.reason)
      })
    })
  assert.deepEqual(await postWebhook('https://h.example', 'hi', { fetch: hang, timeoutMs: 20 }), {
    ok: false,
    error: 'no answer within 0.02s',
  })
  assert.deepEqual(await pingHeartbeat('https://h.example', { fetch: hang, timeoutMs: 20 }), {
    ok: false,
    error: 'no answer within 0.02s',
  })
})
