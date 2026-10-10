import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnStepInput } from 'claude-code'

import {
  CLASSIFIER_SYSTEM,
  DEFAULTS,
  classifierPrompt,
  continuationDecision,
  decide,
  decideFromLaya,
  highStakesSignals,
  isContinuation,
  layaBody,
  logLine,
  parseLaya,
  parseVerdict,
  plan,
  readConfig,
} from './route'
import type { Config, Decision, Plan } from './route'

type $ = EngineInterface

/** A warm Laya answers in well under a second; past this the turn goes out unchanged. */
const LAYA_TIMEOUT_MS = 5_000

const pausedAtom = atom({ plugin: 'model-router', key: 'isPaused' } as const, false)
const switchAtom = atom({ plugin: 'model-router', key: 'modelSwitch' } as const, null)
const lastAtom = atom({ plugin: 'model-router', key: 'last' } as const, null)
const lastTierAtom = atom({ plugin: 'model-router', key: 'lastTier' } as const, null)

// Module variables start over on a hot reload; a turn caught mid-reload is sent unchanged.
let config: Config = DEFAULTS
/** The prompt that will start the next turn, set at prompt.submit and taken at its first step. */
let pending: string | undefined
/** What each recent turn's first step decided, so the turn's later steps match it. */
const routes = new Map<string, Plan>()

const describeError = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0]?.slice(0, 160) ?? 'unknown error'

const hasChanges = (applied: Plan | undefined): applied is Plan =>
  applied !== undefined && (applied.model !== undefined || applied.effort !== undefined)

/** Writes a decision to the transcript and keeps it for /router. */
async function record($: $, text: string) {
  $.ui.log(text)
  await update($, lastAtom, () => text)
}

async function previousReply($: $): Promise<string | undefined> {
  const messages = await $.session.messages()
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role === 'assistant' && message.text.trim() !== '') return message.text
  }
  return undefined
}

/** Asks the local Laya server; a string says why there is no decision. */
async function classifyWithLaya($: $, text: string): Promise<Decision | string> {
  const stop = new AbortController()
  const timeout = $.clock
    .sleep(LAYA_TIMEOUT_MS, { signal: stop.signal })
    .then(() => 'timeout' as const)
    .catch(() => 'cancelled' as const)
  const request = $.http.fetch(`${config.layaUrl}/v1/systemone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: layaBody(text),
  })
  try {
    const response = await Promise.race([request, timeout])
    if (response === 'timeout') return `laya gave no answer within ${LAYA_TIMEOUT_MS / 1000}s`
    if (response === 'cancelled') return 'laya call cancelled'
    if (!response.ok) return `laya answered HTTP ${response.status}`
    const reading = parseLaya(response.text)
    if (reading === undefined) return 'laya answer unreadable'
    return decideFromLaya(reading, highStakesSignals(text))
  } catch (error) {
    return `laya unreachable (${describeError(error)})`
  } finally {
    stop.abort()
    request.catch(() => undefined)
  }
}

/** Asks a Claude model; a string says why there is no decision. */
async function classifyWithModel($: $, text: string, reply: string | undefined): Promise<Decision | string> {
  const answer = await $.model.complete({
    model: config.classifierModel,
    system: CLASSIFIER_SYSTEM,
    prompt: classifierPrompt(text, reply),
    maxTokens: 200,
    effort: 'low',
    timeoutMs: 10_000,
  })
  if (!answer.isAnswered) return `classifier gave no answer (${answer.reason})`
  const verdict = parseVerdict(answer.text)
  if (verdict === undefined) return 'classifier answer unreadable'
  return decide(verdict, highStakesSignals(text))
}

/** Classifies the prompt that starts this turn and plans its requests; undefined sends them unchanged. */
async function routeTurn($: $, e: TurnStepInput): Promise<Plan | undefined> {
  const text = pending
  pending = undefined
  if (text === undefined) {
    await record($, 'router: no prompt starts this turn → request unchanged')
    return undefined
  }

  const classified = isContinuation(text)
    ? continuationDecision(await read($, lastTierAtom))
    : config.classifier === 'laya'
      ? await classifyWithLaya($, text)
      : await classifyWithModel($, text, await previousReply($).catch(() => undefined))
  if (typeof classified === 'string') {
    await record($, `router: ${classified} → request unchanged`)
    return undefined
  }

  const decision = classified
  await update($, lastTierAtom, () => decision.tier)
  const modelSwitch = await read($, switchAtom)
  const applied = plan(
    decision.tier,
    { model: e.model, effort: e.effort },
    { ...config, switchMainModel: modelSwitch ?? config.switchMainModel },
  )
  await record($, logLine(decision, applied))
  return applied
}

async function choose($: $, e: TurnStepInput): Promise<Plan | undefined> {
  if (await read($, pausedAtom)) {
    pending = undefined
    return undefined
  }
  if (e.index > 0) return routes.get(e.turnId)

  const applied = await routeTurn($, e)
  if (applied !== undefined) {
    routes.set(e.turnId, applied)
    for (const key of [...routes.keys()].slice(0, Math.max(0, routes.size - 20))) routes.delete(key)
  }
  return applied
}

async function status($: $): Promise<string> {
  const isPaused = await read($, pausedAtom)
  const modelSwitch = await read($, switchAtom)
  const last = await read($, lastAtom)
  const isSwitching = modelSwitch ?? config.switchMainModel
  return [
    `Model router: ${isPaused ? 'paused for this session' : 'routing'}`,
    `Effort routing: ${config.routeEffort ? `on (mechanical ≤ ${config.mechanicalEffort}, hard ≥ ${config.hardEffort})` : 'off'}`,
    `Main-model switching: ${isSwitching ? 'on' : 'off'}${modelSwitch === null ? ' (setting)' : ' (this session)'}; hard → ${config.strongModel}, ordinary → ${config.ordinaryModel}, mechanical → ${config.cheapModel}`,
    `Classifier: ${config.classifier === 'laya' ? `laya at ${config.layaUrl}` : config.classifierModel}`,
    `Last decision: ${last ?? 'none yet'}`,
  ].join('\n')
}

export const register: Register = (on, options) => {
  config = readConfig(options as Readonly<Record<string, unknown>>)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'router',
      description: 'Model router: show status, pause or resume routing, or switch the main model for this session',
      argumentHint: '[on|off|model on|model off|model default]',
    })
    return started
  })

  on('prompt.submit', ($, e, next) => {
    // A prompt folded into a running turn starts no turn of its own; a slash command is no task.
    if (e.turnId === undefined && !e.text.trimStart().startsWith('/')) pending = e.text
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)

    let applied: Plan | undefined
    try {
      applied = await choose($, e)
    } catch (error) {
      routes.delete(e.turnId)
      await record($, `router: failed (${describeError(error)}) → request unchanged`).catch(() => undefined)
      applied = undefined
    }
    if (!hasChanges(applied)) return yield* next(e)

    const rewritten: TurnStepInput = {
      ...e,
      ...(applied.model !== undefined ? { model: applied.model } : {}),
      ...(applied.effort !== undefined ? { effort: applied.effort } : {}),
    }
    const stream = next(rewritten)[Symbol.asyncIterator]()
    let hasOutput = false
    try {
      while (true) {
        const chunk = await stream.next()
        if (chunk.done) return chunk.value
        hasOutput = true
        yield chunk.value
      }
    } catch (error) {
      // Output already reached the turn: nothing can be taken back, so the error stands.
      if (hasOutput) throw error
      routes.delete(e.turnId)
      await record($, `router: routed request failed before any output (${describeError(error)}) → resent unchanged`).catch(
        () => undefined,
      )
    }
    return yield* next(e)
  })

  on('command.run', { command: 'router' }, async ($, e) => {
    const words = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const [first, second] = words

    if (first === 'off' || first === 'on') {
      await update($, pausedAtom, () => first === 'off')
      const text = first === 'off' ? 'router: paused for this session → requests unchanged' : 'router: resumed'
      $.ui.log(text)
      return { text: await status($) }
    }
    if (first === 'model' && (second === 'on' || second === 'off' || second === 'default')) {
      await update($, switchAtom, () => (second === 'default' ? null : second === 'on'))
      const warning =
        second === 'on'
          ? '\nNote: the prompt cache is per model, so each switch re-reads the conversation uncached.'
          : ''
      return { text: `${await status($)}${warning}` }
    }
    if (first !== undefined && first !== 'status') {
      return { text: `Usage: /router [on|off|model on|model off|model default]\n\n${await status($)}` }
    }
    return { text: await status($) }
  })
}
