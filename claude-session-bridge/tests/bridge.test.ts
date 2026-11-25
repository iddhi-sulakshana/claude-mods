import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { BridgeMessage, BridgePeer } from '../types'
import {
  cmuxArgv,
  cmuxFromEnv,
  defaultName,
  defaultRoot,
  EVENT_TTL_MS,
  fileArgv,
  spawnArgv,
  zendrArgv,
  zendrFromEnv,
  eventRecord,
  formatPeerText,
  formatPrompt,
  parseDelivery,
  parseSpawn,
  isExpiredEvent,
  preview,
  resolveTarget,
  sanitizeName,
  spawnCommand,
  splitTarget,
  tabTitle,
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
    expect(defaultName('C:\\Users\\x\\Codes\\Web App', ME)).toBe('web-app-aaaa')
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
function world(on: On, extraEnv: Record<string, string> = {}) {
  const files = new Map<string, string>()
  const cmuxCalls: string[][] = []
  const hcCalls: string[][] = []
  /** Every other command run: the file operations. */
  const commands: string[][] = []
  const submitted: string[] = []
  const sent: { to: string; text: string }[] = []
  let refusal: string | undefined
  let sessionId = ME

  mock.env(on, { HOME: '/home', CLAUDE_SESSION_BRIDGE_DIR: ROOT, ...extraEnv })
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
  // On Windows the engine hands these hooks absolute paths with a drive and backslashes
  // (C:\bridge\...): keys stay in the /bridge/... form the tests read back.
  const norm = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/)/, '')
  on('fs.write', ($, e) => {
    files.set(norm(e.path), e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const text = files.get(norm(e.path))
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.list', ($, e) => {
    const prefix = `${norm(e.path)}/`
    const names = [...files.keys()]
      .filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map(p => p.slice(prefix.length))
    return { value: names.map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', ($, e) => ({ value: run(e.argv) }))
  const done = (exitCode: number) => ({ exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  const move = (from: string, to: string) => {
    const text = files.get(norm(from))
    if (text === undefined) return done(1)
    files.delete(norm(from))
    files.set(norm(to), text)
    return done(0)
  }
  const run = (argv: readonly string[]): ReturnType<typeof done> => {
    const [command, ...rest] = argv
    if (command === 'cmux') {
      cmuxCalls.push([...argv])
      return done(0)
    }
    if (command === 'hc') {
      hcCalls.push([...argv])
      return done(0)
    }
    commands.push([...argv])
    // cmd's own, as the bridge runs them on Windows: cmd /d /c move|del|mkdir ...
    if (command === 'cmd') {
      const [, , op = '', ...args] = rest
      if (op === 'move') return move(args[1] ?? '', args[2] ?? '')
      if (op === 'del') {
        for (const path of args.filter(a => !a.startsWith('/'))) files.delete(norm(path))
        return done(0)
      }
      return done(op === 'mkdir' ? 0 : 1)
    }
    if (command === 'mv') return move(rest[0] ?? '', rest[1] ?? '')
    if (command === 'rm') {
      for (const path of rest) files.delete(norm(path))
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
    cmuxCalls,
    hcCalls,
    commands,
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

const CMUX_ENV = { CMUX_WORKSPACE_ID: 'WS-1111', CMUX_SURFACE_ID: 'SF-2222' }

describe('cmux helpers', () => {
  test('cmux is detected from its environment, and only there', () => {
    expect(cmuxFromEnv(() => undefined)).toBeUndefined()
    expect(cmuxFromEnv(key => ({ CMUX_WORKSPACE_ID: 'W' })[key])).toEqual({ workspace: 'W' })
    expect(cmuxFromEnv(key => ({ CMUX_WORKSPACE_ID: 'W', CMUX_PANEL_ID: 'P' })[key])).toEqual({ workspace: 'W', surface: 'P' })
    expect(cmuxFromEnv(key => ({ CMUX_WORKSPACE_ID: 'W', CMUX_SURFACE_ID: 'S', CMUX_PANEL_ID: 'P' })[key])).toEqual({
      workspace: 'W',
      surface: 'S',
    })
  })

  test('cmux commands name the workspace and surface', () => {
    const ref = { workspace: 'W', surface: 'S' }
    expect(cmuxArgv.notify(ref, 'T', 'B')).toEqual(['cmux', 'notify', '--title', 'T', '--body', 'B', '--workspace', 'W', '--surface', 'S'])
    expect(cmuxArgv.renameTab(ref, 'planner')).toEqual(['cmux', 'rename-tab', '--workspace', 'W', '--surface', 'S', 'planner'])
    expect(cmuxArgv.renameTab({ workspace: 'W' }, 'planner')).toBeUndefined()
    expect(cmuxArgv.focus(ref)[0]).toEqual(['cmux', 'select-workspace', '--workspace', 'W'])
    expect(tabTitle('planner', 'plan')).toBe('planner (plan)')
    expect(tabTitle('planner', 'general')).toBe('planner')
  })

  test('a spawned session gets its name and role in the environment, and permissions off only when asked', () => {
    expect(spawnCommand({ name: 'builder', role: 'build', skipPermissions: false })).toBe(
      'CLAUDE_SESSION_BRIDGE_NAME=builder CLAUDE_SESSION_BRIDGE_ROLE=build claude',
    )
    expect(spawnCommand({ name: 'builder', role: 'build', skipPermissions: true })).toContain('--dangerously-skip-permissions')
  })

  test('the spawned command is configurable and may read a key file when the shell runs it', () => {
    const command = 'ANTHROPIC_BASE_URL=https://example.test ANTHROPIC_API_KEY="$(cat ~/.config/some.key)" claude'
    const text = spawnCommand({ name: 'builder', role: 'build', skipPermissions: true, command })
    expect(text).toBe(
      `CLAUDE_SESSION_BRIDGE_NAME=builder CLAUDE_SESSION_BRIDGE_ROLE=build ${command} --dangerously-skip-permissions`,
    )
    expect(spawnCommand({ name: 'b', role: 'r', skipPermissions: false, command: '  ' })).toContain(' claude')
    expect(spawnCommand({ name: 'b', role: 'r', skipPermissions: false, command: 'one\ntwo' })).toContain('one two')
    expect(spawnCommand({ name: 'b', role: 'r', skipPermissions: false, command: 'tclaude' })).not.toContain('--dangerously')
  })

  test('/bridge-spawn arguments split into name, role, flag and first message', () => {
    expect(parseSpawn('builder build --skip-permissions -- do the thing -- twice')).toEqual({
      name: 'builder',
      role: 'build',
      skipPermissions: true,
      message: 'do the thing -- twice',
    })
    expect(parseSpawn('auditor')).toEqual({ name: 'auditor', role: '', skipPermissions: false, message: '' })
  })
})

describe('the bridge in cmux', () => {
  const start = ($: any) => $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })

  test('the peer file records the cmux workspace, and the sidebar shows the bridge', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const { files, cmuxCalls } = world(on, CMUX_ENV)
    await start($)
    const me = JSON.parse(files.get(`${ROOT}/sessions/${ME}.json`) ?? '{}') as BridgePeer
    expect(me.cmux).toEqual({ workspace: 'WS-1111', surface: 'SF-2222' })
    expect(cmuxCalls.some(c => c[1] === 'ping')).toBe(true)
    const status = cmuxCalls.find(c => c[1] === 'set-status')
    expect(status?.slice(0, 3)).toEqual(['cmux', 'set-status', 'bridge'])
    expect(status?.[3]).toContain('app-aaaa')
  })

  test('outside cmux nothing calls cmux', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const { files, cmuxCalls } = world(on)
    await start($)
    expect(cmuxCalls).toEqual([])
    expect((JSON.parse(files.get(`${ROOT}/sessions/${ME}.json`) ?? '{}') as BridgePeer).cmux).toBeUndefined()
  })

  test('the cmux option off ignores cmux even inside it', { options: { cmux: false } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const { files, cmuxCalls } = world(on, CMUX_ENV)
    await start($)
    expect(cmuxCalls).toEqual([])
    expect((JSON.parse(files.get(`${ROOT}/sessions/${ME}.json`) ?? '{}') as BridgePeer).cmux).toBeUndefined()
  })

  test('a held message raises a cmux notification', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const { cmuxCalls } = world(on, CMUX_ENV)
    await start($)
    await $.command.run({ command: 'bridge-auto', args: 'off' } as never)
    await $.session.receive({
      agentId: undefined,
      origin: { kind: 'peer', plugin: 'session-bridge' },
      text: formatPeerText(incoming({ id: `${NOW}-zzz999` })),
    } as never)
    const note = cmuxCalls.find(c => c[1] === 'notify')
    expect(note).toBeDefined()
    expect(note?.join(' ')).toContain('planner')
    expect(note?.join(' ')).toContain('/bridge-inbox')
  })

  test('naming the session renames its cmux tab', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const { cmuxCalls } = world(on, CMUX_ENV)
    await start($)
    await $.tool.call({ tool: 'mcp__session-bridge__bridge_identify', name: 'builder', role: 'build' } as never)
    expect(cmuxCalls.find(c => c[1] === 'rename-tab')).toEqual(['cmux', 'rename-tab', '--workspace', 'WS-1111', '--surface', 'SF-2222', 'builder (build)'])
  })

  test('a session started with a name in its environment takes it', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const { files, cmuxCalls } = world(on, { ...CMUX_ENV, CLAUDE_SESSION_BRIDGE_NAME: 'Builder', CLAUDE_SESSION_BRIDGE_ROLE: 'build' })
    await start($)
    const me = JSON.parse(files.get(`${ROOT}/sessions/${ME}.json`) ?? '{}') as BridgePeer
    expect([me.name, me.role]).toEqual(['builder', 'build'])
    expect(cmuxCalls.some(c => c[1] === 'rename-tab' && c.at(-1) === 'builder (build)')).toBe(true)
  })

  test('bridge_spawn opens a workspace running claude with the name, and queues the first message', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const { files, cmuxCalls } = world(on, CMUX_ENV)
    await start($)
    const result = await $.tool.call({
      tool: 'mcp__session-bridge__bridge_spawn',
      name: 'Builder',
      role: 'build',
      cwd: '/work/other',
      message: 'Implement step 1.',
    } as never)
    expect(result.deny).toBeUndefined()
    const made = cmuxCalls.find(c => c[1] === 'new-workspace')
    expect(made).toEqual([
      'cmux', 'new-workspace', '--cwd', '/work/other', '--command',
      'CLAUDE_SESSION_BRIDGE_NAME=builder CLAUDE_SESSION_BRIDGE_ROLE=build claude',
    ])
    expect(inboxFiles(files, 'builder').length).toBe(1)
    expect(String(result.result)).not.toContain('permission prompts OFF')
  })

  test('bridge_spawn runs the configured spawnCommand option', { options: { spawnCommand: 'tclaude' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const { cmuxCalls } = world(on, CMUX_ENV)
    await start($)
    await $.tool.call({ tool: 'mcp__session-bridge__bridge_spawn', name: 'builder' } as never)
    const made = cmuxCalls.find(c => c[1] === 'new-workspace')
    expect(made?.at(-1)).toBe('CLAUDE_SESSION_BRIDGE_NAME=builder CLAUDE_SESSION_BRIDGE_ROLE=general tclaude')
  })

  test('bridge_spawn turns permission prompts off only when asked', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const { cmuxCalls } = world(on, CMUX_ENV)
    await start($)
    const result = await $.tool.call({ tool: 'mcp__session-bridge__bridge_spawn', name: 'rogue', skip_permissions: true } as never)
    expect(cmuxCalls.find(c => c[1] === 'new-workspace')?.at(-1)).toContain('--dangerously-skip-permissions')
    expect(String(result.result)).toContain('permission prompts OFF')
  })

  test('bridge_spawn refuses a name a live session already has', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const { files, cmuxCalls } = world(on, CMUX_ENV)
    files.set(`${ROOT}/sessions/bbbb2222-0000.json`, JSON.stringify(peer({})))
    await start($)
    const result = await $.tool.call({ tool: 'mcp__session-bridge__bridge_spawn', name: 'planner' } as never)
    expect(result.deny).toContain('already used')
    expect(cmuxCalls.some(c => c[1] === 'new-workspace')).toBe(false)
  })

  test('bridge_spawn is not offered outside cmux', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const { cmuxCalls } = world(on)
    await start($)
    const result = await $.tool.call({ tool: 'mcp__session-bridge__bridge_spawn', name: 'builder' } as never)
    expect(result.deny).toBeDefined()
    expect(cmuxCalls).toEqual([])
  })

  test('bridge_focus switches cmux to a peer that runs in cmux, and refuses one that does not', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const { files, cmuxCalls } = world(on, CMUX_ENV)
    files.set(`${ROOT}/sessions/bbbb2222-0000.json`, JSON.stringify(peer({ cmux: { workspace: 'WS-9999', surface: 'SF-8888' } })))
    files.set(`${ROOT}/sessions/cccc3333-0000.json`, JSON.stringify(peer({ id: 'cccc3333-0000', name: 'plain' })))
    await start($)
    const ok = await $.tool.call({ tool: 'mcp__session-bridge__bridge_focus', name: 'planner' } as never)
    expect(ok.deny).toBeUndefined()
    expect(cmuxCalls.find(c => c[1] === 'select-workspace')).toEqual(['cmux', 'select-workspace', '--workspace', 'WS-9999'])
    const no = await $.tool.call({ tool: 'mcp__session-bridge__bridge_focus', name: 'plain' } as never)
    expect(no.deny).toContain('does not run in cmux')
  })
})

describe('agentboard event files', () => {
  test('a send leaves one event file with names and a preview', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const { files } = world(on)
    files.set(`${ROOT}/sessions/bbbb2222-0000.json`, JSON.stringify(peer({})))
    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'mcp__session-bridge__bridge_send', to: 'planner', body: 'Step 2 is done.', kind: 'status' } as never)

    const names = [...files.keys()].filter(p => p.startsWith(`${ROOT}/events/`))
    expect(names.length).toBe(1)
    expect(names[0]?.endsWith('.json')).toBe(true)
    const event = JSON.parse(files.get(names[0] ?? '') ?? '{}')
    expect(event).toEqual({ v: 1, id: event.id, at: NOW, kind: 'status', from: { id: ME, name: 'app-aaaa' },
      to: ['planner'], preview: 'Step 2 is done.' })
  })

  test('the heartbeat removes old event files and keeps the rest', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    const { files } = world(on)
    const old = `${ROOT}/events/${NOW - EVENT_TTL_MS - 1}-aaaaaa.json`
    const fresh = `${ROOT}/events/${NOW}-bbbbbb.json`
    const foreign = `${ROOT}/events/notes.json`
    for (const path of [old, fresh, foreign]) files.set(path, '{}')
    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    await clock.advance(10_000)
    expect([files.has(old), files.has(fresh), files.has(foreign)]).toEqual([false, true, true])
  })
})

describe('agentboard events', () => {
  const VECTORS: [string, string][] = [
    ['Lead', 'lead'], ['Lead 2', 'lead-2'], ["O'Neil", 'o-neil'], ['  Ben  ', 'ben'], ['Ünal', 'nal'], ['日本', ''],
    ['.hidden.', 'hidden'], ['KYC_new.v2', 'kyc_new.v2'], ['a'.repeat(50), 'a'.repeat(40)], ['a'.repeat(39) + ' b', 'a'.repeat(39) + '-'],
  ]
  test('sanitizeName agrees with agentboard', () => {
    for (const [input, want] of VECTORS) expect(sanitizeName(input)).toBe(want)
  })
  test('preview flattens, strips control characters and cuts to 80', () => {
    expect(preview('hello\n\tworld')).toBe('hello world')
    expect(preview('a\u0007b')).toBe('ab')
    const long = preview('x'.repeat(200))
    expect(long.length).toBe(80)
    expect(long.endsWith('…')).toBe(true)
  })
  test('eventRecord keeps what agentboard draws, not the body', () => {
    const msg: BridgeMessage = { id: `${NOW}-abc123`, kind: 'question', from: { id: ME, name: 'lead', role: 'lead', cwd: '/w' },
      to: 'ben,cy', body: 'Which DB?', createdAt: NOW }
    expect(eventRecord(msg, ['ben', 'cy'])).toEqual({ v: 1, id: `${NOW}-abc123`, at: NOW, kind: 'question',
      from: { id: ME, name: 'lead' }, to: ['ben', 'cy'], preview: 'Which DB?' })
  })
  test('old event files expire; files it does not understand never do', () => {
    expect(isExpiredEvent(`${NOW - EVENT_TTL_MS - 1}-aaaaaa.json`, NOW)).toBe(true)
    expect(isExpiredEvent(`.${NOW - EVENT_TTL_MS - 1}-aaaaaa.tmp`, NOW)).toBe(true)
    expect(isExpiredEvent(`${NOW}-aaaaaa.json`, NOW)).toBe(false)
    expect(isExpiredEvent('notes.json', NOW)).toBe(false)
  })
})

describe('files on Windows', () => {
  test('the folder is under USERPROFILE when there is no HOME', () => {
    expect(defaultRoot(key => ({ HOME: '/home/me' })[key])).toBe('/home/me/.claude/session-bridge')
    expect(defaultRoot(key => ({ USERPROFILE: 'C:\\Users\\me' })[key])).toBe('C:/Users/me/.claude/session-bridge')
  })

  test('mkdir, mv and rm become cmd\'s own, with backslashes', () => {
    expect(fileArgv(false).move('/a/b', '/c/d')).toEqual(['mv', '/a/b', '/c/d'])
    expect(fileArgv(true).move('C:/a/b', 'C:/c/d')).toEqual(['cmd', '/d', '/c', 'move', '/y', 'C:\\a\\b', 'C:\\c\\d'])
    expect(fileArgv(true).remove(['C:/a', 'C:/b'])).toEqual(['cmd', '/d', '/c', 'del', '/f', '/q', 'C:\\a', 'C:\\b'])
    expect(fileArgv(true).mkdir(['C:/a/b'])).toEqual(['cmd', '/d', '/c', 'mkdir', 'C:\\a\\b'])
  })

  test('on Windows the inbox is claimed with cmd move, and the message still arrives', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    const { files, submitted, commands } = world(on, { OS: 'Windows_NT' })
    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    files.set(`${ROOT}/inbox/app-aaaa/${NOW}-abc123.json`, JSON.stringify(incoming()))
    await clock.advance(2_000)
    expect(submitted.length).toBe(1)
    expect(commands.some(c => c[0] === 'cmd' && c[3] === 'move')).toBe(true)
    expect(commands.some(c => c[0] === 'mv' || c[0] === 'mkdir' || c[0] === 'rm')).toBe(false)
  })
})

const ZENDR_ENV = { HC_TERMINAL_ID: 't7' }
const bridgeLabel = (calls: string[][], key: string) =>
  calls.filter(c => c[1] === 'label' && c[3]?.startsWith(`bridge.${key}=`)).map(c => c[3]?.slice(`bridge.${key}=`.length) ?? '')

describe('Zendr helpers', () => {
  test('Zendr is detected from its terminal id, and only there', () => {
    expect(zendrFromEnv(() => undefined)).toBeUndefined()
    expect(zendrFromEnv(key => ({ HC_TERMINAL_ID: 't7' })[key])).toEqual({ terminal: 't7' })
  })

  test('requests go to Zendr as JSON labels on a terminal', () => {
    const ref = { terminal: 't7' }
    expect(zendrArgv.setStatus(ref, 'S')).toEqual(['hc', 'label', 't7', 'bridge.status={"text":"S"}'])
    expect(zendrArgv.clearStatus(ref)).toEqual(['hc', 'label', 't7', 'bridge.status='])
    expect(zendrArgv.renameTab(ref, 'planner (plan)')).toEqual(['hc', 'label', 't7', 'bridge.title={"name":"planner (plan)"}'])
    expect(zendrArgv.focus({ terminal: 't9' }, 'X')).toEqual(['hc', 'label', 't9', 'bridge.focus={"id":"X"}'])
  })

  test('a spawned Zendr session runs in PowerShell on Windows, the login shell elsewhere', () => {
    const win = spawnArgv({ name: 'builder', role: 'build', skipPermissions: false, isWindows: true })
    expect(win.slice(0, 4)).toEqual(['powershell', '-NoLogo', '-NoExit', '-Command'])
    expect(win[4]).toBe("$env:CLAUDE_SESSION_BRIDGE_NAME='builder'; $env:CLAUDE_SESSION_BRIDGE_ROLE='build'; claude")
    expect(spawnArgv({ name: 'b', role: 'r', skipPermissions: true, isWindows: true })[4]).toContain('claude --dangerously-skip-permissions')
    expect(spawnArgv({ name: 'b', role: 'r', skipPermissions: false, isWindows: false, shell: '/bin/zsh' })).toEqual([
      '/bin/zsh', '-lc', 'CLAUDE_SESSION_BRIDGE_NAME=b CLAUDE_SESSION_BRIDGE_ROLE=r claude',
    ])
  })
})

describe('the bridge in Zendr', () => {
  const start = ($: any) => $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })

  test('the peer file records the terminal, and the sidebar shows the bridge', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const { files, hcCalls } = world(on, ZENDR_ENV)
    await start($)
    const me = JSON.parse(files.get(`${ROOT}/sessions/${ME}.json`) ?? '{}') as BridgePeer
    expect(me.zendr).toEqual({ terminal: 't7' })
    expect(hcCalls[0]).toEqual(['hc', 'get', 't7', '--json'])
    expect(JSON.parse(bridgeLabel(hcCalls, 'status')[0] ?? '{}').text).toContain('app-aaaa')
  })

  test('inside cmux, cmux wins and hc is never called', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const { files, hcCalls } = world(on, { ...CMUX_ENV, ...ZENDR_ENV })
    await start($)
    expect(hcCalls).toEqual([])
    expect((JSON.parse(files.get(`${ROOT}/sessions/${ME}.json`) ?? '{}') as BridgePeer).zendr).toBeUndefined()
  })

  test('the zendr option off ignores Zendr', { options: { zendr: false } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const { hcCalls } = world(on, ZENDR_ENV)
    await start($)
    expect(hcCalls).toEqual([])
  })

  test('naming the session names its tab, and a held message notifies', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const { hcCalls } = world(on, ZENDR_ENV)
    await start($)
    await $.tool.call({ tool: 'mcp__session-bridge__bridge_identify', name: 'builder', role: 'build' } as never)
    expect(bridgeLabel(hcCalls, 'title')).toContain('{"name":"builder (build)"}')
    await $.command.run({ command: 'bridge-auto', args: 'off' } as never)
    await $.session.receive({
      agentId: undefined,
      origin: { kind: 'peer', plugin: 'session-bridge' },
      text: formatPeerText(incoming({ id: `${NOW}-zzz999`, to: 'builder' })),
    } as never)
    const note = JSON.parse(bridgeLabel(hcCalls, 'notify')[0] ?? '{}')
    expect(note.title).toBe('Session bridge')
    expect(note.body).toContain('planner')
  })

  test('bridge_spawn asks Zendr for a space running claude with the name, and queues the first message', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const { files, hcCalls } = world(on, { ...ZENDR_ENV, OS: 'Windows_NT' })
    await start($)
    const result = await $.tool.call({
      tool: 'mcp__session-bridge__bridge_spawn',
      name: 'Builder',
      role: 'build',
      cwd: 'C:/work/other',
      message: 'Implement step 1.',
    } as never)
    expect(result.deny).toBeUndefined()
    expect(String(result.result)).toContain('a new Zendr space')
    const request = JSON.parse(bridgeLabel(hcCalls, 'spawn')[0] ?? '{}')
    expect([request.name, request.cwd]).toEqual(['builder', 'C:/work/other'])
    expect(request.argv[0]).toBe('powershell')
    expect(request.argv.at(-1)).toContain("$env:CLAUDE_SESSION_BRIDGE_NAME='builder'")
    expect(inboxFiles(files, 'builder').length).toBe(1)
  })

  test('bridge_focus shows a peer that runs in Zendr, and refuses one that does not', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const { files, hcCalls } = world(on, ZENDR_ENV)
    files.set(`${ROOT}/sessions/bbbb2222-0000.json`, JSON.stringify(peer({ zendr: { terminal: 't9' } })))
    files.set(`${ROOT}/sessions/cccc3333-0000.json`, JSON.stringify(peer({ id: 'cccc3333-0000', name: 'plain' })))
    await start($)
    const ok = await $.tool.call({ tool: 'mcp__session-bridge__bridge_focus', name: 'planner' } as never)
    expect(ok.deny).toBeUndefined()
    expect(hcCalls.some(c => c[1] === 'label' && c[2] === 't9' && c[3]?.startsWith('bridge.focus='))).toBe(true)
    const no = await $.tool.call({ tool: 'mcp__session-bridge__bridge_focus', name: 'plain' } as never)
    expect(no.deny).toContain('does not run in Zendr')
  })
})
