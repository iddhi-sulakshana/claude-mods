import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { BridgeMessage, BridgePeer } from '../types'
import {
  defaultName,
  formatPeerText,
  formatPrompt,
  parseDelivery,
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

/** An in-memory file system, process table and session channel beneath the plugin. */
function world(on: On) {
  const files = new Map<string, string>()
  const submitted: string[] = []
  const sent: { to: string; text: string }[] = []
  let refusal: string | undefined
  let sessionId = ME

  mock.env(on, { HOME: '/home', CLAUDE_SESSION_BRIDGE_DIR: ROOT })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('session.id', () => ({ value: sessionId }))
  on('session.send', ($, e) => {
    sent.push({ to: e.to, text: e.text })
    return refusal === undefined ? { isDelivered: true } : { isDelivered: false, reason: refusal }
  })
  on('session.receive', ($, e) => ({ text: e.text }))

  // A /resume hands the process a new session whose $.state starts empty:
  // once `freshState()` is called, state is answered from a new, empty map.
  let fresh: Map<string, { value: unknown; version: number }> | undefined
  on('state.get', ($, e, next) => {
    if (!fresh) return next(e)
    return { value: fresh.get(e.key) ?? { value: undefined, version: 0 } }
  })
  on('state.set', ($, e, next) => {
    if (!fresh) return next(e)
    const held = fresh.get(e.key) ?? { value: undefined, version: 0 }
    if (e.ifVersion !== undefined && e.ifVersion !== held.version) {
      return { value: { isSet: false as const, version: held.version } }
    }
    fresh.set(e.key, { value: e.value, version: held.version + 1 })
    return { value: { isSet: true as const, version: held.version + 1 } }
  })
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

  return {
    files,
    submitted,
    sent,
    refuse: (reason: string) => {
      refusal = reason
    },
    becomeSession: (id: string) => {
      sessionId = id
    },
    freshState: () => {
      fresh = new Map()
    },
  }
}

const inboxFiles = (files: Map<string, string>, name: string) =>
  [...files.keys()].filter(p => p.startsWith(`${ROOT}/inbox/${name}/`) && p.endsWith('.json'))

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
  test('sends to a live peer directly through the session channel', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const { files, sent } = world(on)
    files.set(`${ROOT}/sessions/bbbb2222-0000.json`, JSON.stringify(peer({})))

    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    expect(files.has(`${ROOT}/sessions/${ME}.json`)).toBe(true)

    const result = await $.tool.call({
      tool: 'mcp__session-bridge__bridge_send',
      to: 'planner',
      body: 'Plan step 2 is done; tests pass.',
      kind: 'status',
    } as never)
    expect(result.deny).toBeUndefined()

    expect(sent.length).toBe(1)
    expect(sent[0]?.to).toContain('bbbb2222-0000')
    expect(sent[0]?.text).toContain('Plan step 2 is done; tests pass.')
    expect(sent[0]?.text).toContain('kind="status"')
    expect(sent[0]?.text).toContain('from="app-aaaa"')
    expect(inboxFiles(files, 'planner').length).toBe(0)
  })

  test('falls back to the inbox file when the session channel refuses', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const { files, sent, refuse } = world(on)
    files.set(`${ROOT}/sessions/bbbb2222-0000.json`, JSON.stringify(peer({})))
    refuse('the recipient is not running')

    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    const result = await $.tool.call({
      tool: 'mcp__session-bridge__bridge_send',
      to: 'planner',
      body: 'Plan step 2 is done; tests pass.',
    } as never)

    expect(sent.length).toBe(1)
    const [path] = inboxFiles(files, 'planner')
    expect(path).toBeDefined()
    const message = JSON.parse(files.get(path ?? '') ?? '{}') as BridgeMessage
    expect(message.body).toBe('Plan step 2 is done; tests pass.')
    expect(message.from.name).toBe('app-aaaa')
    expect(JSON.stringify(result)).toContain('inbox file')
  })

  test('queues a message for a name no running session has', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const { files, sent } = world(on)

    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    const result = await $.tool.call({
      tool: 'mcp__session-bridge__bridge_send',
      to: 'auditor',
      body: 'Review src/auth when you start.',
    } as never)

    expect(sent.length).toBe(0)
    expect(inboxFiles(files, 'auditor').length).toBe(1)
    expect(JSON.stringify(result)).toContain('queued')
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
  test('lets a direct bridge message through and records it', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    world(on)

    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    const got = await $.session.receive({
      origin: { kind: 'peer', plugin: 'session-bridge' },
      text: formatPeerText(incoming()),
    })
    expect(got.consumed).toBeUndefined()
    expect(got.text).toContain('Please audit src/auth for token leaks.')

    const inbox = await $.tool.call({ tool: 'mcp__session-bridge__bridge_inbox' } as never)
    expect(JSON.stringify(inbox)).toContain('No unread messages. Last 1 exchanged')

    const again = await $.session.receive({
      origin: { kind: 'peer', plugin: 'session-bridge' },
      text: formatPeerText(incoming()),
    })
    expect(again.consumed).toBeDefined()
  })

  test('in manual mode holds a direct message for /bridge-inbox', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    world(on)

    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'bridge-auto', args: 'off' } as never)
    const got = await $.session.receive({
      origin: { kind: 'peer', plugin: 'session-bridge' },
      text: formatPeerText(incoming()),
    })
    expect(got.consumed).toBeDefined()

    const ran = await $.command.run({ command: 'bridge-inbox', args: '' } as never)
    expect(ran.text).toContain('from planner')
    expect(ran.context?.[0]).toContain('Please audit src/auth')
  })

  test('the loop guard switches direct delivery to manual', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    world(on)

    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    const results = []
    for (let i = 0; i < 9; i++) {
      results.push(
        await $.session.receive({
          origin: { kind: 'peer', plugin: 'session-bridge' },
          text: formatPeerText(incoming({ id: `${NOW}-m${i}` })),
        }),
      )
    }
    expect(results.slice(0, 8).every(r => r.consumed === undefined)).toBe(true)
    expect(results[8]?.consumed).toBeDefined()
  })

  test('leaves other sessions\' own messages alone', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    world(on)

    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'bridge-auto', args: 'off' } as never)
    const got = await $.session.receive({ origin: { kind: 'peer' }, text: formatPeerText(incoming()) })
    expect(got.consumed).toBeUndefined()

    const inbox = await $.tool.call({ tool: 'mcp__session-bridge__bridge_inbox' } as never)
    expect(JSON.stringify(inbox)).toContain('No messages yet.')
  })

  test('after a /resume it takes on the resumed session instead of failing', async ($, on) => {
    const RESUMED = 'dddd4444-0000-0000-0000-000000000000'
    const clock = mock.clock(on, { now: NOW })
    mock.store(on, { [`identity:${RESUMED}`]: { name: 'planner', role: 'plan' } })
    const { files, becomeSession, freshState } = world(on)

    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    expect(files.has(`${ROOT}/sessions/${ME}.json`)).toBe(true)

    await $.session.end({ reason: 'resume', sessionId: ME, resume: { id: ME } } as never)
    freshState()
    becomeSession(RESUMED)
    await $.turn.start({ text: 'hi', turnId: 'turn-1' })
    await clock.advance(10_000)

    expect(files.has(`${ROOT}/sessions/${ME}.json`)).toBe(false)
    const now = JSON.parse(files.get(`${ROOT}/sessions/${RESUMED}.json`) ?? '{}') as BridgePeer
    expect(now.name).toBe('planner')

    const peers = await $.tool.call({ tool: 'mcp__session-bridge__bridge_peers' } as never)
    expect(peers.deny).toBeUndefined()
    expect(JSON.stringify(peers)).toContain('This session: planner')
  })

  test('a /resume into a conversation new to the bridge keeps the name, mode and unread messages', async ($, on) => {
    const RESUMED = 'eeee5555-0000-0000-0000-000000000000'
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    const { files, becomeSession, freshState } = world(on)

    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'bridge-auto', args: 'off' } as never)
    await $.session.receive({ origin: { kind: 'peer', plugin: 'session-bridge' }, text: formatPeerText(incoming()) })

    await $.session.end({ reason: 'resume', sessionId: ME, resume: { id: ME } } as never)
    freshState()
    becomeSession(RESUMED)
    await clock.advance(2_000)

    const now = JSON.parse(files.get(`${ROOT}/sessions/${RESUMED}.json`) ?? '{}') as BridgePeer
    expect(now.name).toBe('app-aaaa')
    const held = await $.session.receive({
      origin: { kind: 'peer', plugin: 'session-bridge' },
      text: formatPeerText(incoming({ id: `${NOW}-later1` })),
    })
    expect(held.consumed).toBeDefined()

    const ran = await $.command.run({ command: 'bridge-inbox', args: '' } as never)
    expect(ran.text).toContain('Please audit src/auth')
    expect(ran.context?.[0]).toContain(`${NOW}-abc123`)
    expect(ran.context?.[0]).toContain(`${NOW}-later1`)
  })
})

test('formatPrompt frames messages as peer input', () => {
  const text = formatPrompt([incoming()])
  expect(text).toContain('not from the user')
  expect(text).toContain('<peer-session-message id=')
})

test('a direct delivery reads back as the message it carries', () => {
  const message = incoming({ replyTo: `${NOW}-prev01`, handoffPath: '/bridge/handoffs/x.md' })
  const text = `Another Claude session sent a message:\n${formatPeerText(message)}`
  expect(parseDelivery(text, 'app-aaaa')).toEqual({ ...message, from: { ...message.from, id: '' } })
  expect(parseDelivery('just text', 'app-aaaa')).toBeUndefined()
})
