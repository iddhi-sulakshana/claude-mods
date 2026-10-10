import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { BridgeMessage, BridgePeer } from '../types'
import {
  defaultName,
  formatPrompt,
  resolveTarget,
  sanitizeName,
  splitTarget,
} from '../hooks/bridge'

const ROOT = '/bridge'
const ME = 'aaaa1111-0000-0000-0000-000000000000'
const NOW = 1_000_000

const peer = (over: Partial<BridgePeer>): BridgePeer => ({
  id: 'bbbb2222-0000',
  name: 'planner',
  role: 'plan',
  cwd: '/work/app',
  updatedAt: NOW,
  ...over,
})

describe('helpers', () => {
  test('names are sanitized and defaulted from the cwd', () => {
    expect(sanitizeName('  My Planner!! ')).toBe('my-planner')
    expect(defaultName('/Users/x/Codes/Web App', ME)).toBe('web-app-aaaa')
  })

  test('targets resolve to live peers, broadcasts, or an offline queue', () => {
    const self = peer({ id: ME, name: 'builder', role: 'build' })
    const peers = [self, peer({}), peer({ id: 'cccc', name: 'old', updatedAt: NOW - 120_000 })]

    expect(resolveTarget('Planner', peers, self, NOW)).toEqual({ kind: 'live', names: ['planner'] })
    expect(resolveTarget('*', peers, self, NOW)).toEqual({ kind: 'live', names: ['planner'] })
    expect(resolveTarget('old', peers, self, NOW)).toEqual({ kind: 'offline', name: 'old' })
    expect(resolveTarget('builder', peers, self, NOW).kind).toBe('error')
    expect(resolveTarget('bbbb2222', peers, self, NOW)).toEqual({ kind: 'live', names: ['planner'] })
  })

  test('slash-command arguments split into target and text', () => {
    expect(splitTarget('auditor please review src/')).toEqual({ to: 'auditor', text: 'please review src/' })
    expect(splitTarget('auditor')).toEqual({ to: 'auditor', text: '' })
  })
})

/** An in-memory file system and process table beneath the plugin. */
function world(on: On) {
  const files = new Map<string, string>()
  const submitted: string[] = []

  mock.env(on, { HOME: '/home', CLAUDE_SESSION_BRIDGE_DIR: ROOT })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: ME }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__session-bridge__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.list', ($, e) => {
    const prefix = `${e.path}/`
    const names = [...files.keys()]
      .filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map(p => p.slice(prefix.length))
    return { value: names.map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', ($, e) => ({ value: run(e.argv) }))
  const done = (exitCode: number) => ({ exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  const run = (argv: readonly string[]) => {
    const [command, ...rest] = argv
    if (command === 'mv') {
      const [from = '', to = ''] = rest
      const text = files.get(from)
      if (text === undefined) return done(1)
      files.delete(from)
      files.set(to, text)
      return done(0)
    }
    if (command === 'rm') {
      for (const path of rest) files.delete(path)
      return done(0)
    }
    return done(command === 'mkdir' ? 0 : 128)
  }
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })

  return { files, submitted }
}

const incoming = (over: Partial<BridgeMessage> = {}): BridgeMessage => ({
  id: `${NOW}-abc123`,
  kind: 'review-request',
  from: { id: 'bbbb2222-0000', name: 'planner', role: 'plan', cwd: '/work/app' },
  to: 'app-aaaa',
  subject: 'Check the auth refactor',
  body: 'Please audit src/auth for token leaks.',
  createdAt: NOW,
  ...over,
})

describe('the bridge', () => {
  test('sends to a live peer by writing into its inbox', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const { files } = world(on)
    files.set(`${ROOT}/sessions/bbbb2222-0000.json`, JSON.stringify(peer({})))

    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    expect(files.has(`${ROOT}/sessions/${ME}.json`)).toBe(true)

    const sent = await $.tool.call({
      tool: 'mcp__session-bridge__bridge_send',
      to: 'planner',
      body: 'Plan step 2 is done; tests pass.',
      kind: 'status',
    } as never)
    expect(sent.deny).toBeUndefined()

    const [path] = [...files.keys()].filter(p => p.startsWith(`${ROOT}/inbox/planner/`) && p.endsWith('.json'))
    expect(path).toBeDefined()
    const message = JSON.parse(files.get(path ?? '') ?? '{}') as BridgeMessage
    expect(message.body).toBe('Plan step 2 is done; tests pass.')
    expect(message.kind).toBe('status')
    expect(message.from.name).toBe('app-aaaa')
  })

  test('claims an incoming message and submits it as a prompt', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    const { files, submitted } = world(on)

    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    files.set(`${ROOT}/inbox/app-aaaa/${NOW}-abc123.json`, JSON.stringify(incoming()))
    await clock.advance(2_000)

    expect(submitted.length).toBe(1)
    expect(submitted[0]).toContain('Please audit src/auth for token leaks.')
    expect(submitted[0]).toContain('kind="review-request"')
    expect(files.has(`${ROOT}/inbox/app-aaaa/${NOW}-abc123.json`)).toBe(false)
    expect(files.has(`${ROOT}/archive/app-aaaa/${NOW}-abc123.json`)).toBe(true)
  })

  test('in manual mode only notifies, and /bridge-inbox hands the message to the model', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    const { files, submitted } = world(on)

    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'bridge-auto', args: 'off' } as never)
    files.set(`${ROOT}/inbox/app-aaaa/${NOW}-abc123.json`, JSON.stringify(incoming()))
    await clock.advance(2_000)
    expect(submitted.length).toBe(0)

    const ran = await $.command.run({ command: 'bridge-inbox', args: '' } as never)
    expect(ran.text).toContain('from planner')
    expect(ran.context?.[0]).toContain('Please audit src/auth')
  })
})

test('formatPrompt frames messages as peer input', () => {
  const text = formatPrompt([incoming()])
  expect(text).toContain('not from the user')
  expect(text).toContain('<peer-session-message id=')
})
