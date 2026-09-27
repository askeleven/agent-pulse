import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url))
const EXAMPLES = fileURLToPath(new URL('../examples/', import.meta.url))

/**
 * @param {string[]} args
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function run(args) {
  return new Promise((resolve) => {
    const env = { ...process.env, AGENT_PULSE_WEBHOOK_URL: '', AGENT_PULSE_HEARTBEAT_URL: '', NO_COLOR: '1' }
    execFile(process.execPath, [CLI, ...args], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr })
    })
  })
}

const example = ['check', '--rules', join(EXAMPLES, 'pulse.json'), '--events', join(EXAMPLES, 'events.jsonl')]

test('cli: exit 0 when healthy', async () => {
  const r = await run([...example, '--now', '2026-09-28T14:00:30Z'])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /^\nHEALTHY {2}3 checks, nothing missing/)
})

test('cli: exit 1 when alerting, with --json', async () => {
  const r = await run([...example, '--now', '2026-09-28T15:30:00Z', '--json'])
  assert.equal(r.code, 1, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.healthy, false)
  assert.deepEqual(out.findings.map((/** @type {{key: string}} */ f) => f.key), [
    'receptionist/sms/undelivered',
    'sdr/email/below_expected',
    'sdr/email/failure_streak/gmail/send',
  ])
  assert.equal(out.notification, null)
})

test('cli: exit 2 when it cannot run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pulse-'))
  const bad = join(dir, 'bad.json')
  await writeFile(bad, '{"checks": [{"agent": "a", "capability": "b", "heartbeat": {"every": "often"}}]}')

  const invalid = await run(['check', '--rules', bad, '--events', join(dir, 'e.jsonl')])
  assert.equal(invalid.code, 2)
  assert.match(invalid.stderr, /checks\[0\]\.heartbeat\.every: must be a duration/)

  const missingRules = await run(['check', '--rules', join(dir, 'none.json'), '--events', join(dir, 'e.jsonl')])
  assert.equal(missingRules.code, 2)
  assert.match(missingRules.stderr, /none\.json: no such file/)

  assert.equal((await run(['check', '--rules', bad])).code, 2)
  assert.equal((await run([...example, '--now', 'tuesday'])).code, 2)
  assert.equal((await run(['frobnicate'])).code, 2)
  assert.equal((await run(['check', '--bogus'])).code, 2)
})

test('cli: a missing event log is an alert (exit 1), not a crash', async () => {
  const r = await run(['check', '--rules', join(EXAMPLES, 'pulse.json'), '--events', '/nonexistent/events.jsonl'])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /No events recorded\n {6}The event log does not exist/)
})

test('cli: an unreachable webhook is reported on stderr and the exit code still reflects health', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pulse-'))
  const r = await run([
    ...example,
    '--now', '2026-09-28T15:30:00Z',
    '--state', join(dir, 'state.json'),
    '--webhook', 'http://127.0.0.1:9/hook',
  ])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /^Webhook failed: .+ Will retry next run\.\n$/)
})

test('cli: emit appends an event; bad events exit 2', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pulse-'))
  const path = join(dir, 'events.jsonl')
  const ok = await run(['emit', '--events', path, '--agent', 'sdr', '--capability', 'email', '--type', 'failed', '--target', 'gmail', '--action', 'send', '--error-class', 'auth', '--ts', '2026-09-28T14:00:00Z'])
  assert.equal(ok.code, 0, ok.stderr)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    ts: '2026-09-28T14:00:00Z',
    agent: 'sdr',
    capability: 'email',
    type: 'failed',
    target: 'gmail',
    action: 'send',
    error_class: 'auth',
  })
  const bad = await run(['emit', '--events', path, '--agent', 'sdr', '--capability', 'email', '--type', 'sent'])
  assert.equal(bad.code, 2)
  assert.match(bad.stderr, /type must be one of run, action, accepted, delivered, failed/)
})

test('cli: --version and --help', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal((await run(['--version'])).stdout.trim(), pkg.version)
  assert.equal((await run(['check', '--version'])).stdout.trim(), pkg.version)
  const help = await run(['--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /Exit codes/)
})
