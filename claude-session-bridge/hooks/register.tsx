import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionReceiveOrigin, SessionSendResult, Timer } from 'claude-code'

import type { BridgeKind, BridgeLogEntry, BridgeMessage, BridgePeer, CmuxRef } from '../types'
import {
  RATE_LIMIT,
  STALE_MS,
  asKind,
  clip,
  cmuxArgv,
  cmuxFromEnv,
  defaultName,
  describePeers,
  formatDelivery,
  formatHandoff,
  formatPeerText,
  formatPrompt,
  handoffBody,
  isLive,
  newMessageId,
  parseDelivery,
  parseSpawn,
  resolveTarget,
  sanitizeName,
  spawnCommand,
  splitTarget,
  tabTitle,
  withinWindow,
} from './bridge'

type $ = EngineInterface

const PLUGIN = 'session-bridge'
const PANE = 'session-bridge'
const TOOL_FAILED = () => ({ deny: 'session-bridge: the bridge tool failed (run claude --debug for the reason).' })

const meAtom = atom({ plugin: 'session-bridge', key: 'me' } as const, null)
const peersAtom = atom({ plugin: 'session-bridge', key: 'peers' } as const, [])
const logAtom = atom({ plugin: 'session-bridge', key: 'log' } as const, [])
const autoAtom = atom({ plugin: 'session-bridge', key: 'isAuto' } as const, true)

type Identity = { name: string; role: string }

/** What the bridge held for a session that ended while the process goes on (/clear, /resume). */
type Carried = { me: BridgePeer | null; log: BridgeLogEntry[]; isAuto: boolean }

// Module variables start over on a hot reload; session.start sets them again.
let root = ''
let autoDefault = true
let isPolling = false
let autoStamps: number[] = []
let lastStatus = ''
let timers: Timer[] = []
let carried: Carried | undefined
let rebasing: Promise<BridgePeer> | undefined
/** Where this session runs in cmux; undefined outside cmux, or with the `cmux` option off. */
let cmux: CmuxRef | undefined

const dirs = {
  sessions: () => `${root}/sessions`,
  inbox: (name: string) => `${root}/inbox/${name}`,
  archive: (name: string) => `${root}/archive/${name}`,
  handoffs: () => `${root}/handoffs`,
}
const sessionFile = (id: string) => `${dirs.sessions()}/${id}.json`

async function sh($: $, argv: string[]) {
  try {
    return (await $.process.run(argv, { timeoutMs: 10_000 })).exitCode === 0
  } catch {
    return false
  }
}

/** Runs one cmux CLI call. A failure is logged for debugging and never reaches the model or the person. */
async function cmuxRun($: $, argv: string[] | undefined) {
  if (cmux === undefined || argv === undefined) return false
  const ok = await sh($, argv)
  if (!ok) $.ui.log(`session-bridge: \`${argv.slice(0, 2).join(' ')}\` failed`, { to: 'debug' })
  return ok
}

/** Raises a cmux notification (the workspace is marked unread) next to the in-session toast. */
function cmuxNotify($: $, body: string) {
  return cmux === undefined ? undefined : cmuxRun($, cmuxArgv.notify(cmux, 'Session bridge', body))
}

/**
 * This session's identity. A /resume (and a /clear) moves the process to
 * another session without a session.start: `$.session.id()` answers the new
 * id and that session's `$.state` may start empty, so the bridge takes the
 * new session on here instead of failing every call from then on.
 */
async function me($: $): Promise<BridgePeer> {
  const held = await read($, meAtom)
  if (held !== null && held.id === (await $.session.id())) return held
  if (root === '') throw new Error('session bridge is not started yet')
  return rebase($, held)
}

/**
 * Moves the bridge onto the session the process now runs. It takes the
 * identity that session had on the bridge before (a resumed conversation's),
 * else keeps the one the process had; unread messages and the delivery mode
 * come along when the session's state started empty.
 */
function rebase($: $, held: BridgePeer | null): Promise<BridgePeer> {
  rebasing ??= (async () => {
    const id = await $.session.id()
    const now = await $.clock.now()
    const cwd = await $.session.cwd()
    const before = held ?? carried?.me ?? null
    const kept = carried
    carried = undefined

    const stored = (await $.store.get(`identity:${id}`)) as Identity | undefined
    const peers = await readPeers($)
    const isTaken = (name: string) =>
      peers.some(p => p.name === name && p.id !== id && p.id !== before?.id && isLive(p, now))
    const identity: Identity =
      stored && !isTaken(stored.name) ? stored : (before ?? { name: defaultName(cwd, id), role: 'general' })
    const self: BridgePeer = { id, name: identity.name, role: identity.role, cwd, updatedAt: now, ...(cmux ? { cmux } : {}) }

    if (before !== null && before.id !== id) await sh($, ['rm', '-f', sessionFile(before.id)])
    await update($, meAtom, () => self)
    if (held === null) {
      await update($, autoAtom, () => kept?.isAuto ?? autoDefault)
      if (kept) await update($, logAtom, () => kept.log)
    }
    await $.store.set(`identity:${id}`, { name: self.name, role: self.role })
    await sh($, ['mkdir', '-p', dirs.sessions(), dirs.inbox(self.name), dirs.archive(self.name)])
    await $.fs.write(sessionFile(id), JSON.stringify(self))
    $.ui.log(`session-bridge: now session ${id.slice(0, 8)} as "${self.name}"`, { to: 'debug' })
    arm($)
    return self
  })().finally(() => {
    rebasing = undefined
  })
  return rebasing
}

/** Starts the heartbeat and inbox timers, stopping any running ones first. */
function arm($: $) {
  for (const timer of timers) timer.cancel()
  timers = [
    $.clock.every(10_000, () => void heartbeat($).catch(error => $.ui.log(`session-bridge heartbeat: ${error}`, { to: 'debug' }))),
    $.clock.every(2_000, () => void poll($).catch(error => $.ui.log(`session-bridge poll: ${error}`, { to: 'debug' }))),
  ]
}

async function readPeers($: $): Promise<BridgePeer[]> {
  const entries = await $.fs.list(dirs.sessions()).catch(() => [])
  const peers: BridgePeer[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    const path = `${dirs.sessions()}/${entry.name}`
    try {
      const peer = JSON.parse(await $.fs.read(path)) as BridgePeer
      if (typeof peer.id === 'string' && typeof peer.name === 'string') peers.push(peer)
    } catch {
      // A half-written or foreign file: skip it, the next heartbeat rewrites ours.
    }
  }
  return peers
}

async function showStatus($: $) {
  const self = await read($, meAtom)
  if (self === null) return
  const now = await $.clock.now()
  const peers = (await read($, peersAtom)).filter(p => p.id !== self.id && isLive(p, now))
  const unread = (await read($, logAtom)).filter(l => l.direction === 'in' && !l.isDelivered).length
  const isAuto = await read($, autoAtom)
  const text = `⇄ ${self.name}${self.role !== 'general' ? ` (${self.role})` : ''} · ${peers.length} peer${peers.length === 1 ? '' : 's'}${unread > 0 ? ` · ${unread} unread` : ''}${isAuto ? '' : ' · manual'}`
  if (text !== lastStatus) {
    lastStatus = text
    $.ui.status(text)
    if (cmux !== undefined) await cmuxRun($, cmuxArgv.setStatus(cmux, text))
  }
}

async function heartbeat($: $) {
  const self = await me($)
  const now = await $.clock.now()
  const next: BridgePeer = { ...self, cwd: await $.session.cwd(), updatedAt: now }
  await $.fs.write(sessionFile(next.id), JSON.stringify(next))
  await update($, meAtom, () => next)

  const peers = await readPeers($)
  for (const peer of peers) {
    // Sessions that died without a session.end leave a file behind; sweep old ones.
    if (peer.id !== next.id && now - peer.updatedAt > 10 * STALE_MS) {
      await sh($, ['rm', '-f', sessionFile(peer.id)])
    }
  }
  await update($, peersAtom, () => peers.filter(p => now - p.updatedAt <= 10 * STALE_MS))
  await showStatus($)
}

function appendLog($: $, entries: BridgeLogEntry[]) {
  return update($, logAtom, log => [...log, ...entries].slice(-100))
}

function markDelivered($: $, ids: ReadonlySet<string>) {
  return update($, logAtom, log =>
    log.map(l => (l.direction === 'in' && ids.has(l.message.id) ? { ...l, isDelivered: true } : l)),
  )
}

async function unread($: $) {
  return (await read($, logAtom)).filter(l => l.direction === 'in' && !l.isDelivered).map(l => l.message)
}

async function receivedIds($: $) {
  return new Set((await read($, logAtom)).filter(l => l.direction === 'in').map(l => l.message.id))
}

/**
 * Whether an incoming delivery may reach the model now: auto mode is on and
 * the loop guard has room. Counts the delivery when it may.
 */
async function admitAuto($: $) {
  const now = await $.clock.now()
  autoStamps = withinWindow(autoStamps, now)
  if (!(await read($, autoAtom))) return false
  if (autoStamps.length >= RATE_LIMIT) {
    await update($, autoAtom, () => false)
    $.ui.toast(
      `Session bridge: ${RATE_LIMIT}+ auto-delivered messages in 5 minutes, switched to manual. /bridge-auto on to resume.`,
      { timeoutMs: 10_000 },
    )
    void cmuxNotify($, `${RATE_LIMIT}+ auto-delivered messages in 5 minutes, switched to manual (/bridge-auto on to resume).`)
    return false
  }
  autoStamps.push(now)
  return true
}

/**
 * Moves each waiting message out of our inbox (the move is the claim) and hands
 * it on. The inbox holds what was sent before this session took its name, or
 * what could not be delivered directly.
 */
async function poll($: $) {
  if (isPolling) return
  isPolling = true
  try {
    const self = await me($)
    const inbox = dirs.inbox(self.name)
    const entries = await $.fs.list(inbox).catch(() => [])
    const waiting = entries
      .filter(e => e.kind === 'file' && e.name.endsWith('.json') && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort()
    if (waiting.length === 0) return

    const seen = await receivedIds($)
    const claimed: BridgeMessage[] = []
    for (const name of waiting) {
      const archived = `${dirs.archive(self.name)}/${name}`
      if (!(await sh($, ['mv', `${inbox}/${name}`, archived]))) continue
      try {
        const message = JSON.parse(await $.fs.read(archived)) as BridgeMessage
        if (!seen.has(message.id)) claimed.push(message)
      } catch {
        $.ui.log(`session-bridge: unreadable message ${archived}`, { to: 'debug' })
      }
    }
    if (claimed.length === 0) return

    await appendLog($, claimed.map(message => ({ direction: 'in', message, isDelivered: false })))
    const senders = [...new Set(claimed.map(m => m.from.name))].join(', ')

    if (await admitAuto($)) {
      await markDelivered($, new Set(claimed.map(m => m.id)))
      $.ui.toast(`Session bridge: ${claimed.length} message${claimed.length === 1 ? '' : 's'} from ${senders}`)
      void $.prompt.submit({ text: formatPrompt(claimed) })
    } else {
      $.ui.toast(`Session bridge: ${claimed.length} new from ${senders}. /bridge-inbox to read.`)
      void cmuxNotify($, `${claimed.length} new message${claimed.length === 1 ? '' : 's'} from ${senders}. Run /bridge-inbox to read.`)
    }
  } finally {
    isPolling = false
    await showStatus($).catch(() => undefined)
  }
}

/** Writes a message into an inbox: temp file first, then a rename, so a reader never sees half of it. */
async function enqueue($: $, message: BridgeMessage) {
  const inbox = dirs.inbox(message.to)
  const temp = `${inbox}/.${message.id}.tmp`
  await $.fs.write(temp, JSON.stringify(message))
  return sh($, ['mv', temp, `${inbox}/${message.id}.json`])
}

/**
 * Hands a message straight to a running session through Claude Code's own
 * session channel, the one the SendMessage tool uses: the receiver shows it as
 * another session's message and reads it inside a running turn.
 */
async function deliver($: $, peer: BridgePeer, message: BridgeMessage): Promise<SessionSendResult> {
  try {
    return await $.session.send({ to: { sessionId: peer.id }, text: formatPeerText(message) })
  } catch (error) {
    return { isDelivered: false, reason: String(error) }
  }
}

/** Sends to each live recipient directly; a name with no running session, or one the channel refused, gets the inbox file. */
async function send(
  $: $,
  to: string,
  draft: { kind: BridgeKind; body: string; subject?: string; replyTo?: string; handoffPath?: string },
): Promise<{ ok: true; text: string; message: BridgeMessage } | { ok: false; reason: string }> {
  const self = await me($)
  const now = await $.clock.now()
  const peers = await readPeers($)
  const resolved = resolveTarget(to, peers, self, now)
  if (resolved.kind === 'error') return { ok: false, reason: resolved.reason }
  if (draft.body.trim() === '') return { ok: false, reason: 'The message is empty.' }

  const names = resolved.kind === 'live' ? resolved.names : [resolved.name]
  const message: BridgeMessage = {
    id: newMessageId(now, Math.random()),
    kind: draft.kind,
    from: { id: self.id, name: self.name, role: self.role, cwd: self.cwd },
    to: names.join(','),
    body: draft.body,
    createdAt: now,
    ...(draft.subject ? { subject: draft.subject } : {}),
    ...(draft.replyTo ? { replyTo: draft.replyTo } : {}),
    ...(draft.handoffPath ? { handoffPath: draft.handoffPath } : {}),
  }

  const fellBack: string[] = []
  for (const name of names) {
    const addressed = { ...message, to: name }
    const peer = peers.find(p => p.name === name && p.id !== self.id && isLive(p, now))
    if (peer) {
      const sent = await deliver($, peer, addressed)
      if (sent.isDelivered) continue
      $.ui.log(`session-bridge: direct delivery to ${name} failed (${sent.reason}); using its inbox file`, { to: 'debug' })
      fellBack.push(`${name} (${sent.reason})`)
    }
    if (!(await enqueue($, addressed))) {
      return { ok: false, reason: `Could not place the message in ${dirs.inbox(name)}.` }
    }
  }
  await appendLog($, [{ direction: 'out', message, isDelivered: true }])

  const text =
    resolved.kind === 'offline'
      ? `No live session is named "${resolved.name}". The ${message.kind} (${message.id}) is queued and will be delivered when a session takes that name (/bridge-name ${resolved.name}).`
      : `Sent ${message.kind} ${message.id} to ${names.join(', ')}.${
          fellBack.length > 0
            ? ` Direct delivery failed for ${fellBack.join(', ')}, so it went to the inbox file, which a running bridge session reads every 2 s.`
            : ''
        }`
  return { ok: true, text, message }
}

async function gitSummary($: $) {
  try {
    const run = await $.process.run(['git', 'status', '--short', '--branch'], { timeoutMs: 10_000 })
    if (run.exitCode !== 0) return undefined
    const [branch = '', ...changes] = run.stdout.trim().split('\n')
    return `${branch.replace(/^## /, '')}; ${changes.filter(Boolean).length} changed path(s)`
  } catch {
    return undefined
  }
}

async function transcriptTail($: $, count: number) {
  if (count <= 0) return undefined
  const messages = await $.session.messages()
  if (!Array.isArray(messages)) return undefined
  return messages
    .slice(-count)
    .map(m => `**${m.role}:** ${clip(m.text.trim() || '(tool use only)', 2_000)}`)
    .join('\n\n')
}

async function handoff(
  $: $,
  to: string,
  input: { title: string; summary: string; nextSteps: string; files: string[]; transcriptCount: number },
) {
  const self = await me($)
  const now = await $.clock.now()
  const id = newMessageId(now, Math.random())
  const doc = formatHandoff({
    title: input.title,
    summary: input.summary,
    nextSteps: input.nextSteps,
    files: input.files,
    from: self,
    to,
    createdAt: now,
    git: await gitSummary($),
    transcript: await transcriptTail($, input.transcriptCount),
  })
  const path = `${dirs.handoffs()}/${id}.md`
  await $.fs.write(path, doc)
  return send($, to, {
    kind: 'handoff',
    subject: input.title,
    body: handoffBody(doc, path),
    handoffPath: path,
  })
}

async function setIdentity($: $, rawName: string | undefined, rawRole: string | undefined) {
  const self = await me($)
  const name = rawName === undefined || rawName.trim() === '' ? self.name : sanitizeName(rawName)
  const role = rawRole === undefined || rawRole.trim() === '' ? self.role : sanitizeName(rawRole) || self.role
  if (name === '') return { ok: false as const, reason: `"${rawName}" is not a usable name.` }

  const now = await $.clock.now()
  const taken = (await readPeers($)).find(p => p.name === name && p.id !== self.id && isLive(p, now))
  if (taken) return { ok: false as const, reason: `"${name}" is already used by live session ${taken.id.slice(0, 8)} in ${taken.cwd}.` }

  await update($, meAtom, () => ({ ...self, name, role }))
  await $.store.set(`identity:${self.id}`, { name, role })
  await sh($, ['mkdir', '-p', dirs.inbox(name), dirs.archive(name)])
  // The tab carries the name the session plays, so a row of cmux tabs reads planner / builder / auditor.
  if (cmux !== undefined) await cmuxRun($, cmuxArgv.renameTab(cmux, tabTitle(name, role)))
  await heartbeat($)
  await poll($)
  return { ok: true as const, text: `This session is now "${name}" (role: ${role}).` }
}

/**
 * Starts another Claude Code session in a new cmux workspace, named and with its role already
 * set, and queues a first message for it. The message waits in the inbox of that name, so the
 * new session reads it as soon as it has started.
 */
async function spawn(
  $: $,
  input: { name: string; role?: string; cwd?: string; skipPermissions: boolean; message?: string },
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  if (cmux === undefined) {
    return { ok: false, reason: 'Spawning needs this session to run inside cmux (there is no CMUX_WORKSPACE_ID here), or the cmux option is off.' }
  }
  const self = await me($)
  const name = sanitizeName(input.name)
  if (name === '') return { ok: false, reason: `"${input.name}" is not a usable session name.` }
  const now = await $.clock.now()
  const taken = (await readPeers($)).find(p => p.name === name && isLive(p, now))
  if (taken) return { ok: false, reason: `"${name}" is already used by live session ${taken.id.slice(0, 8)} in ${taken.cwd}.` }

  const role = sanitizeName(input.role ?? '') || 'general'
  const cwd = input.cwd?.trim() || self.cwd
  await sh($, ['mkdir', '-p', dirs.inbox(name), dirs.archive(name)])
  if (!(await cmuxRun($, cmuxArgv.spawn(cwd, spawnCommand({ name, role, skipPermissions: input.skipPermissions }))))) {
    return { ok: false, reason: 'cmux could not open a new workspace (is cmux running, and is the folder there?).' }
  }
  const queued = input.message?.trim()
    ? await send($, name, { kind: 'message', body: input.message })
    : undefined
  if (queued && !queued.ok) {
    return { ok: true, text: `Started "${name}" (role: ${role}) in a new cmux workspace in ${cwd}, but its first message was not queued: ${queued.reason}` }
  }
  return {
    ok: true,
    text: `Started "${name}" (role: ${role}) in a new cmux workspace in ${cwd}${input.skipPermissions ? ', with permission prompts OFF (--dangerously-skip-permissions)' : ''}.${
      queued ? ' Its first message is queued and arrives when the session has started.' : ''
    } It appears in bridge_peers once it is up.`,
  }
}

/** Switches cmux to the workspace of another live session that runs in cmux. */
async function focus($: $, to: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  if (cmux === undefined) return { ok: false, reason: 'Focusing needs this session to run inside cmux, with the cmux option on.' }
  const now = await $.clock.now()
  const name = sanitizeName(to)
  const peers = (await readPeers($)).filter(p => isLive(p, now))
  const peer = peers.find(p => p.name === name) ?? (to.trim().length >= 6 ? peers.find(p => p.id.startsWith(to.trim())) : undefined)
  if (peer === undefined) return { ok: false, reason: `No live session is named "${to}".` }
  if (peer.cmux === undefined) return { ok: false, reason: `"${peer.name}" does not run in cmux, so there is no workspace to switch to.` }
  for (const argv of cmuxArgv.focus(peer.cmux)) await cmuxRun($, argv)
  return { ok: true, text: `Switched cmux to "${peer.name}".` }
}

async function describe($: $) {
  return describePeers(await me($), await readPeers($), await $.clock.now())
}

/** A delivery another session's bridge composed (not its model's own SendMessage, not a teammate's). */
const isFromBridge = (origin: SessionReceiveOrigin) =>
  origin.kind === 'peer' && 'plugin' in origin && origin.plugin === PLUGIN && !('teammate' in origin)

const args = (e: object) => e as unknown as Record<string, unknown>
const str = (value: unknown) => (typeof value === 'string' ? value : undefined)

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    const home = (await $.env.get('HOME')) ?? ''
    root = (await $.env.get('CLAUDE_SESSION_BRIDGE_DIR')) ?? `${home}/.claude/session-bridge`
    autoDefault = options.autoDeliver !== false

    cmux = undefined
    if (options.cmux !== false) {
      const env: Record<string, string | undefined> = {
        CMUX_WORKSPACE_ID: await $.env.get('CMUX_WORKSPACE_ID'),
        CMUX_SURFACE_ID: await $.env.get('CMUX_SURFACE_ID'),
        CMUX_PANEL_ID: await $.env.get('CMUX_PANEL_ID'),
      }
      const ref = cmuxFromEnv(key => env[key])
      // Inside cmux but its CLI does not answer: leave the cmux features off.
      if (ref !== undefined && (await sh($, cmuxArgv.ping()))) cmux = ref
    }

    // A session started by bridge_spawn carries the name and role it should take.
    const envName = sanitizeName((await $.env.get('CLAUDE_SESSION_BRIDGE_NAME')) ?? '')
    const envRole = sanitizeName((await $.env.get('CLAUDE_SESSION_BRIDGE_ROLE')) ?? '')

    const id = await $.session.id()
    const stored = (await $.store.get(`identity:${id}`)) as Identity | undefined
    const self: BridgePeer = {
      id,
      name: stored?.name ?? (envName || defaultName(e.cwd, id)),
      role: stored?.role ?? (envRole || 'general'),
      cwd: e.cwd,
      updatedAt: await $.clock.now(),
      ...(cmux ? { cmux } : {}),
    }
    if (stored === undefined && envName !== '') await $.store.set(`identity:${id}`, { name: self.name, role: self.role })
    // A reload keeps the identity the session already took, and its auto setting.
    const held = await read($, meAtom)
    await update($, meAtom, () => (held !== null && held.id === id ? held : self))
    const { version } = await $.state.get({ plugin: 'session-bridge', key: 'isAuto' } as const)
    if (version === 0) await update($, autoAtom, () => autoDefault)

    const name = (await me($)).name
    await sh($, ['mkdir', '-p', dirs.sessions(), dirs.handoffs(), dirs.inbox(name), dirs.archive(name)])

    if (cmux !== undefined && stored === undefined && envName !== '') {
      await cmuxRun($, cmuxArgv.renameTab(cmux, tabTitle(self.name, self.role)))
    }

    await Promise.all([
      $.tool.register({
        name: 'bridge_peers',
        description:
          'Session bridge: list the other Claude Code sessions running on this machine that you can message (name, role, working directory), and this session\'s own name and role.',
        inputSchema: { type: 'object', properties: {} },
        isDeferred: false,
      }),
      $.tool.register({
        name: 'bridge_send',
        description:
          'Session bridge: send a message to another running Claude Code session (by name from bridge_peers, or "*" for all live peers). Use it to coordinate: ask a planner a question, report a result to the builder, request a review from an auditor, or reply to a peer message (set reply_to). Messages to a name with no live session are queued until a session takes that name. Do not send acknowledgements.',
        inputSchema: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Recipient session name, a session-id prefix, or "*" for every live peer.' },
            body: { type: 'string', description: 'The message. Be specific and self-contained: the recipient cannot see your conversation.' },
            kind: { type: 'string', enum: ['message', 'question', 'reply', 'review-request', 'status'], description: 'Default "message".' },
            subject: { type: 'string', description: 'Optional one-line subject.' },
            reply_to: { type: 'string', description: 'The id of the peer message this answers.' },
          },
          required: ['to', 'body'],
        },
        isDeferred: false,
      }),
      $.tool.register({
        name: 'bridge_handoff',
        description:
          'Session bridge: hand off work to another session with a written context document (saved under ~/.claude/session-bridge/handoffs and delivered to the recipient). Use when another session should continue, implement, or audit what you planned or built. Write the summary so a fresh session with no access to your conversation can act on it.',
        inputSchema: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Recipient session name, or "*".' },
            title: { type: 'string', description: 'One-line title of the work being handed off.' },
            summary: { type: 'string', description: 'Goal, decisions made, current state, constraints and gotchas.' },
            next_steps: { type: 'string', description: 'What the recipient should do, in order, and how to verify it.' },
            files: { type: 'array', items: { type: 'string' }, description: 'Relevant file paths.' },
            transcript_messages: { type: 'number', description: 'Also attach this many of the latest transcript messages (0-40, default 0).' },
          },
          required: ['to', 'title', 'summary', 'next_steps'],
        },
        isDeferred: false,
      }),
      $.tool.register({
        name: 'bridge_inbox',
        description:
          'Session bridge: read peer messages that arrived but have not been shown to you yet (when auto-delivery is off), plus the last few exchanged.',
        inputSchema: { type: 'object', properties: {} },
        isDeferred: false,
      }),
      $.tool.register({
        name: 'bridge_identify',
        description:
          'Session bridge: set this session\'s name and/or role on the bridge (e.g. name "planner", role "plan"; or "builder"/"build", "auditor"/"audit"). Do this when the user tells you which part you play.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short unique name: letters, digits, ".", "_" or "-".' },
            role: { type: 'string', description: 'What this session does, e.g. plan, build, audit, review.' },
          },
        },
        isDeferred: false,
      }),
      ...(cmux === undefined
        ? []
        : [
            $.tool.register({
              name: 'bridge_spawn',
              description:
                'Session bridge (cmux): start another Claude Code session in a new cmux workspace, with the given bridge name and role, and optionally queue a first message for it (it reads it as soon as it is up). Use it only when the user asked for a new session. skip_permissions starts it with --dangerously-skip-permissions: set it only when the user explicitly asked for that, never on your own.',
              inputSchema: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Bridge name for the new session: letters, digits, ".", "_" or "-".' },
                  role: { type: 'string', description: 'Its role, e.g. build, audit, review. Default general.' },
                  cwd: { type: 'string', description: 'Folder to start in. Default: this session\'s folder.' },
                  message: { type: 'string', description: 'First message for the new session. Be specific and self-contained: it cannot see this conversation.' },
                  skip_permissions: { type: 'boolean', description: 'Start with --dangerously-skip-permissions. Only if the user explicitly asked. Default false.' },
                },
                required: ['name'],
              },
              isDeferred: false,
            }),
            $.tool.register({
              name: 'bridge_focus',
              description: 'Session bridge (cmux): switch cmux to the workspace of another live session that runs in cmux, so the user can see it.',
              inputSchema: {
                type: 'object',
                properties: { name: { type: 'string', description: 'Session name, or a session-id prefix, from bridge_peers.' } },
                required: ['name'],
              },
              isDeferred: false,
            }),
            $.command.register({ name: 'bridge-spawn', description: 'Session bridge (cmux): start a named session in a new cmux workspace', argumentHint: '<name> [role] [--skip-permissions] [-- first message]' }),
            $.command.register({ name: 'bridge-focus', description: 'Session bridge (cmux): switch to another session\'s cmux workspace', argumentHint: '<name>' }),
          ]),
      $.command.register({ name: 'bridge', description: 'Session bridge: show peers and recent messages in a pane' }),
      $.command.register({ name: 'bridge-name', description: 'Session bridge: name this session (and set its role)', argumentHint: '<name> [role]' }),
      $.command.register({ name: 'bridge-send', description: 'Session bridge: send a message to another session', argumentHint: '<name|*> <message>' }),
      $.command.register({ name: 'bridge-handoff', description: 'Session bridge: summarize this conversation and hand it to another session', argumentHint: '<name|*> [instructions for the recipient]' }),
      $.command.register({ name: 'bridge-inbox', description: 'Session bridge: read unread peer messages (and pass them to the model)' }),
      $.command.register({ name: 'bridge-auto', description: 'Session bridge: auto-deliver peer messages as turns, or only notify', argumentHint: '[on|off]' }),
    ])

    await heartbeat($)
    arm($)
    void poll($).catch(error => $.ui.log(`session-bridge poll: ${error}`, { to: 'debug' }))

    return started
  })

  on('session.end', async ($, e, next) => {
    if (root !== '') {
      // After a /clear or a /resume the process goes on as another session,
      // whose state may start empty: keep what this one held for it.
      carried = { me: await read($, meAtom), log: await read($, logAtom), isAuto: await read($, autoAtom) }
      await sh($, ['rm', '-f', sessionFile(e.sessionId)])
      if (cmux !== undefined) {
        lastStatus = ''
        await cmuxRun($, cmuxArgv.clearStatus(cmux))
      }
    }
    return next(e)
  })

  // A /resume fires no session.start; the first turn after one moves the
  // bridge over (the timers would too, within 2 s, if they still run).
  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined && root !== '') {
      void me($).catch(error => $.ui.log(`session-bridge: ${error}`, { to: 'debug' }))
    }
    return next(e)
  })

  // ---- direct deliveries from other sessions' bridges ----

  on('session.receive', async ($, e, next) => {
    if (e.agentId !== undefined || root === '' || !isFromBridge(e.origin)) return next(e)
    const self = await me($)
    const message = parseDelivery(e.text, self.name)
    if (message === undefined) return next(e)
    if ((await receivedIds($)).has(message.id)) {
      return { consumed: `session-bridge: ${message.id} was already delivered` }
    }

    const isAuto = await admitAuto($)
    await appendLog($, [{ direction: 'in', message, isDelivered: isAuto }])
    await showStatus($)
    if (isAuto) return next(e)
    $.ui.toast(`Session bridge: new ${message.kind} from ${message.from.name}. /bridge-inbox to read.`)
    void cmuxNotify($, `New ${message.kind} from ${message.from.name}. Run /bridge-inbox to read.`)
    return { consumed: 'session-bridge: manual delivery is on; held for /bridge-inbox' }
  })

  // ---- tools the model calls ----

  on('tool.call', { tool: 'mcp__session-bridge__bridge_peers' }, async $ => ({ result: await describe($) })).catch(TOOL_FAILED)

  on('tool.call', { tool: 'mcp__session-bridge__bridge_send' }, async ($, e) => {
    const a = args(e)
    const sent = await send($, str(a.to) ?? '', {
      kind: asKind(a.kind),
      body: str(a.body) ?? '',
      subject: str(a.subject),
      replyTo: str(a.reply_to),
    })
    return sent.ok ? { result: sent.text } : { deny: sent.reason }
  }).catch(TOOL_FAILED)

  on('tool.call', { tool: 'mcp__session-bridge__bridge_handoff' }, async ($, e) => {
    const a = args(e)
    const count = typeof a.transcript_messages === 'number' ? a.transcript_messages : 0
    const sent = await handoff($, str(a.to) ?? '', {
      title: str(a.title) ?? 'Handoff',
      summary: str(a.summary) ?? '',
      nextSteps: str(a.next_steps) ?? '',
      files: Array.isArray(a.files) ? a.files.filter((f): f is string => typeof f === 'string') : [],
      transcriptCount: Math.max(0, Math.min(40, Math.floor(count))),
    })
    return sent.ok ? { result: `${sent.text} Document: ${sent.message.handoffPath}` } : { deny: sent.reason }
  }).catch(TOOL_FAILED)

  on('tool.call', { tool: 'mcp__session-bridge__bridge_inbox' }, async $ => {
    const fresh = await unread($)
    await markDelivered($, new Set(fresh.map(m => m.id)))
    await showStatus($)
    if (fresh.length > 0) return { result: formatPrompt(fresh) }
    const recent = (await read($, logAtom)).slice(-5)
    return {
      result:
        recent.length === 0
          ? 'No messages yet.'
          : `No unread messages. Last ${recent.length} exchanged:\n\n${recent
              .map(l => `${l.direction === 'in' ? 'received' : 'sent'}: ${clip(formatDelivery(l.message), 1_500)}`)
              .join('\n\n')}`,
    }
  }).catch(TOOL_FAILED)

  on('tool.call', { tool: 'mcp__session-bridge__bridge_identify' }, async ($, e) => {
    const a = args(e)
    const set = await setIdentity($, str(a.name), str(a.role))
    return set.ok ? { result: set.text } : { deny: set.reason }
  }).catch(TOOL_FAILED)

  on('tool.call', { tool: 'mcp__session-bridge__bridge_spawn' }, async ($, e) => {
    const a = args(e)
    const made = await spawn($, {
      name: str(a.name) ?? '',
      role: str(a.role),
      cwd: str(a.cwd),
      message: str(a.message),
      skipPermissions: a.skip_permissions === true,
    })
    return made.ok ? { result: made.text } : { deny: made.reason }
  }).catch(TOOL_FAILED)

  on('tool.call', { tool: 'mcp__session-bridge__bridge_focus' }, async ($, e) => {
    const shown = await focus($, str(args(e).name) ?? '')
    return shown.ok ? { result: shown.text } : { deny: shown.reason }
  }).catch(TOOL_FAILED)

  // ---- slash commands the person runs ----

  on('command.run', { command: 'bridge' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Session bridge' })
    return { text: await describe($) }
  })

  on('command.run', { command: 'bridge-name' }, async ($, e) => {
    const [name, role] = e.args.trim().split(/\s+/)
    if (!name) return { text: `${await describe($)}\n\nUsage: /bridge-name <name> [role]` }
    const set = await setIdentity($, name, role)
    return { text: set.ok ? set.text : set.reason }
  })

  on('command.run', { command: 'bridge-spawn' }, async ($, e) => {
    const parsed = parseSpawn(e.args)
    if (!parsed.name) return { text: 'Usage: /bridge-spawn <name> [role] [--skip-permissions] [-- first message]' }
    const made = await spawn($, {
      name: parsed.name,
      role: parsed.role,
      message: parsed.message,
      skipPermissions: parsed.skipPermissions,
    })
    return { text: made.ok ? made.text : made.reason }
  })

  on('command.run', { command: 'bridge-focus' }, async ($, e) => {
    if (!e.args.trim()) return { text: 'Usage: /bridge-focus <name>' }
    const shown = await focus($, e.args.trim())
    return { text: shown.ok ? shown.text : shown.reason }
  })

  on('command.run', { command: 'bridge-send' }, async ($, e) => {
    const { to, text } = splitTarget(e.args)
    if (!to || !text) return { text: 'Usage: /bridge-send <name|*> <message>' }
    const sent = await send($, to, { kind: 'message', body: text })
    return { text: sent.ok ? sent.text : sent.reason }
  })

  on('command.run', { command: 'bridge-handoff' }, async ($, e) => {
    const { to, text: notes } = splitTarget(e.args)
    if (!to) return { text: 'Usage: /bridge-handoff <name|*> [instructions for the recipient]' }
    $.ui.toast('Session bridge: writing the handoff…')
    const written = await $.model.fork({
      prompt: [
        'Write a handoff document so a fresh Claude Code session, with no access to this conversation, can continue the work.',
        'Markdown only, no preamble. Start with one line "TITLE: <short title>". Then sections:',
        '## Goal, ## Done so far, ## Current state (uncommitted changes, open questions, decisions and why), ## Next steps (numbered, with how to verify), ## Relevant files (paths).',
        'Be concrete: exact paths, commands, names. Keep it under 1500 words.',
        notes ? `Instructions from the user for the recipient: ${notes}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    })
    if (!written.isAnswered) return { text: `Could not write the handoff (${written.reason}).` }

    const titleLine = /^TITLE:\s*(.+)$/m.exec(written.text)
    const title = titleLine?.[1]?.trim() ?? 'Context handoff'
    const summary = written.text.replace(/^TITLE:.*\n?/m, '').trim()
    const sent = await handoff($, to, {
      title,
      summary: notes ? `${summary}\n\n## Instructions from the user\n\n${notes}` : summary,
      nextSteps: '',
      files: [],
      transcriptCount: 0,
    })
    return { text: sent.ok ? `${sent.text}\nDocument: ${sent.message.handoffPath}` : sent.reason }
  })

  on('command.run', { command: 'bridge-inbox' }, async $ => {
    const fresh = await unread($)
    if (fresh.length === 0) return { text: 'No unread peer messages.' }
    await markDelivered($, new Set(fresh.map(m => m.id)))
    await showStatus($)
    const shown = fresh
      .map(m => `[${m.kind}] from ${m.from.name}${m.subject ? `: ${m.subject}` : ''}\n${clip(m.body, 1_200)}`)
      .join('\n\n')
    return { text: shown, context: [formatPrompt(fresh)] }
  })

  on('command.run', { command: 'bridge-auto' }, async ($, e) => {
    const word = e.args.trim().toLowerCase()
    const isAuto = word === '' ? !(await read($, autoAtom)) : word === 'on' || word === 'true'
    await update($, autoAtom, () => isAuto)
    autoStamps = []
    await showStatus($)
    if (isAuto) void poll($).catch(error => $.ui.log(`session-bridge poll: ${error}`, { to: 'debug' }))
    return {
      text: isAuto
        ? 'Peer messages reach the model as soon as they arrive.'
        : 'Peer messages only notify; read them with /bridge-inbox.',
    }
  })

  // ---- the pane ----

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const self = await read($, meAtom)
    const peers = await read($, peersAtom)
    const log = await read($, logAtom)
    const isAuto = await read($, autoAtom)
    const now = await $.clock.now()
    const width = Math.max(20, e.props.bodyColumns ?? 60)
    const live = peers.filter(p => self !== null && p.id !== self.id && isLive(p, now))
    const room = Math.max(3, (e.viewport?.rows ?? 30) - live.length - 10)

    return (
      <Box flexDirection="column">
        <Text bold>
          {self === null ? 'Starting…' : `${self.name} · role ${self.role}`}
        </Text>
        <Box>
          <Text dimColor>{isAuto ? 'Auto-delivery on ' : 'Manual (notify only) '}</Text>
          <Button key="auto" label={isAuto ? 'Switch to manual' : 'Switch to auto'} onPress={() => update($, autoAtom, v => !v)} />
        </Box>
        <Text> </Text>
        <Text bold>Peers</Text>
        {live.length === 0 && <Text dimColor>No other live sessions.</Text>}
        {live.map(p => (
          <Box>
            <Text>{clip(`• ${p.name} (${p.role}) ${p.cwd}`, width - 12)} </Text>
            {cmux !== undefined && p.cmux !== undefined && (
              <Button key={`focus-${p.id}`} label="Focus" onPress={() => void focus($, p.name)} />
            )}
          </Box>
        ))}
        <Text> </Text>
        <Text bold>Messages</Text>
        {log.length === 0 && <Text dimColor>None yet.</Text>}
        {log.slice(-room).map(l => (
          <Text dimColor={l.direction === 'out' || l.isDelivered}>
            {clip(
              `${l.direction === 'in' ? '←' : '→'} ${l.direction === 'in' ? l.message.from.name : l.message.to} [${l.message.kind}] ${l.message.subject ?? l.message.body.replace(/\s+/g, ' ')}`,
              width - 2,
            )}
          </Text>
        ))}
      </Box>
    )
  })
}
