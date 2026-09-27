import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { serve } from '../src/mcp.js'

/**
 * @param {object[]} messages
 * @returns {Promise<any[]>}
 */
async function mcpSession(messages) {
  const input = new PassThrough()
  const output = new PassThrough()
  /** @type {string[]} */
  const chunks = []
  output.on('data', (c) => chunks.push(String(c)))
  const done = serve({ input, output })
  for (const m of messages) input.write(`${JSON.stringify(m)}\n`)
  input.end()
  await done
  return chunks.join('').trim().split('\n').map((l) => JSON.parse(l))
}

test('mcp: initialize, list tools, pulse_status, and errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pulse-'))
  const rulesPath = join(dir, 'pulse.json')
  const eventsPath = join(dir, 'events.jsonl')
  const badRules = join(dir, 'bad.json')
  await writeFile(rulesPath, JSON.stringify({ checks: [{ agent: 'sdr', capability: 'email', heartbeat: { every: '10m' } }] }))
  await writeFile(badRules, JSON.stringify({ checks: [{ agent: 'sdr' }] }))
  await writeFile(eventsPath, `${JSON.stringify({ ts: '2026-09-28T14:00:00Z', agent: 'sdr', capability: 'email', type: 'run' })}\n`)

  const call = (/** @type {number} */ id, /** @type {object} */ args) => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'pulse_status', arguments: args },
  })
  const replies = await mcpSession([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    call(3, { rules_path: rulesPath, events_path: eventsPath, now: '2026-09-28T14:30:00Z' }),
    call(4, { rules_path: rulesPath, events_path: eventsPath, now: '2026-09-28T14:05:00Z' }),
    call(5, { rules_path: badRules, events_path: eventsPath }),
    call(6, { rules_path: rulesPath, events_path: join(dir, 'missing.jsonl'), now: '2026-09-28T14:05:00Z' }),
    { jsonrpc: '2.0', id: 7, method: 'nope' },
    { jsonrpc: '2.0', id: 8, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
  ])
  const byId = Object.fromEntries(replies.map((r) => [r.id, r]))

  assert.equal(replies.length, 8, 'the notification gets no reply')
  assert.equal(byId[1].result.protocolVersion, '2025-06-18')
  assert.equal(byId[1].result.serverInfo.name, 'agent-pulse')
  assert.match(byId[1].result.instructions, /at_cap/)
  assert.equal(byId[8].result.protocolVersion, '2025-11-25')
  assert.deepEqual(byId[2].result.tools.map((/** @type {{name: string}} */ t) => t.name), ['pulse_status'])

  const alerting = byId[3].result.structuredContent
  assert.equal(alerting.healthy, false)
  assert.deepEqual(alerting.findings.map((/** @type {{key: string}} */ f) => f.key), ['sdr/email/silent'])
  assert.deepEqual(JSON.parse(byId[3].result.content[0].text), alerting)

  assert.equal(byId[4].result.structuredContent.healthy, true)
  assert.equal(byId[5].result.isError, true)
  assert.match(byId[5].result.content[0].text, /checks\[0\]\.capability: is required/)
  assert.equal(byId[6].result.structuredContent.findings[0].code, 'no_events')
  assert.equal(byId[7].error.code, -32601)
})
