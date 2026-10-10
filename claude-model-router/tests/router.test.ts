import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnStepInput } from 'claude-code'

import {
  DEFAULTS,
  continuationDecision,
  decide,
  decideFromLaya,
  highStakesSignals,
  isContinuation,
  layaBody,
  parseLaya,
  parseVerdict,
  plan,
} from '../hooks/route'
import type { LayaReading } from '../hooks/route'

describe('rules', () => {
  test('the classifier answer is read leniently and rejected when malformed', () => {
    expect(parseVerdict('```json\n{"tier":"hard","confidence":0.9,"reason":"auth"}\n```')).toEqual({
      tier: 'hard',
      confidence: 0.9,
      reason: 'auth',
    })
    expect(parseVerdict('{"tier":"easy","confidence":0.9}')).toBeUndefined()
    expect(parseVerdict('no json here')).toBeUndefined()
  })

  test('weak evidence moves up', () => {
    expect(decide({ tier: 'ordinary', confidence: 0.4, reason: '' }, []).tier).toBe('hard')
    expect(decide({ tier: 'mechanical', confidence: 0.5, reason: '' }, []).tier).toBe('ordinary')
  })

  test('moving down needs confidence and no high-stakes signal', () => {
    expect(decide({ tier: 'mechanical', confidence: 0.9, reason: '' }, []).tier).toBe('mechanical')
    expect(decide({ tier: 'mechanical', confidence: 0.75, reason: '' }, []).tier).toBe('ordinary')
    expect(decide({ tier: 'mechanical', confidence: 0.95, reason: '' }, ['auth']).tier).toBe('hard')
  })

  test('a high-stakes signal lifts ordinary to hard unless the classifier is confident', () => {
    expect(highStakesSignals('rotate the prod API keys')).toEqual(['production', 'secrets'])
    expect(decide({ tier: 'ordinary', confidence: 0.7, reason: '' }, ['migration']).tier).toBe('hard')
    expect(decide({ tier: 'ordinary', confidence: 0.9, reason: '' }, ['migration']).tier).toBe('ordinary')
  })

  test('effort only moves the way the tier asks', () => {
    expect(plan('mechanical', { model: 'claude-opus-5-5', effort: 'medium' }, DEFAULTS).effort).toBe('low')
    expect(plan('hard', { model: 'claude-opus-5-5', effort: 'max' }, DEFAULTS).effort).toBeUndefined()
    expect(plan('mechanical', { model: 'claude-opus-5-5', effort: 'low' }, DEFAULTS).effort).toBeUndefined()
  })

  test('each tier takes its rung of the Opus → Sonnet → Haiku ladder when switching is on', () => {
    const on = { ...DEFAULTS, switchMainModel: true }
    const model = (tier: 'mechanical' | 'ordinary' | 'hard', from: string) => plan(tier, { model: from, effort: 'medium' }, on).model
    expect(model('hard', 'claude-sonnet-5-5')).toBe('claude-opus-5-5')
    expect(model('ordinary', 'claude-opus-5-5')).toBe('claude-sonnet-5-5')
    expect(model('mechanical', 'claude-opus-5-5')).toBe('claude-haiku-5-5')
    // Already on the rung, including a variant of it: no switch.
    expect(model('hard', 'claude-opus-5-5')).toBeUndefined()
    expect(model('hard', 'claude-opus-5-5[1m]')).toBeUndefined()
    // Switching is off by default.
    expect(plan('mechanical', { model: 'claude-opus-5-5', effort: 'high' }, DEFAULTS).model).toBeUndefined()
  })

  test('nothing above Opus is ever used', () => {
    const above = { ...DEFAULTS, switchMainModel: true, strongModel: 'claude-fable-5-1' }
    const hard = plan('hard', { model: 'claude-sonnet-5-5', effort: 'medium' }, above)
    expect(hard.model).toBeUndefined()
    expect(hard.notes.join(' ')).toContain('not on the Opus → Haiku ladder')
  })
})

const MODEL = { options: { classifier: 'model' } }

const STEP: TurnStepInput = { turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 3 }

/** Answers the router's calls beneath it and records what the turn was sent with. */
function world(on: On, classify: () => string | Error, failRouted = false) {
  const logs: string[] = []
  const sent: TurnStepInput[] = []

  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: [] }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('model.complete', () => {
    const answer = classify()
    if (answer instanceof Error) throw answer
    return {
      value: {
        isAnswered: true as const,
        text: answer,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('turn.step', async function* ($, e) {
    sent.push(e)
    if (failRouted && e.model !== STEP.model) throw new Error('unknown model')
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })

  return { logs, sent }
}

async function runStep($: Engine, step: TurnStepInput) {
  // Drain the stream; the turn's request is what the bottom hook recorded.
  for await (const _ of $.turn.step(step)) {
    // no chunks expected
  }
}

/** A prompt as the person's Enter submits it. */
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

const VERDICT = (tier: string, confidence: number) => JSON.stringify({ tier, confidence, reason: 'test' })

describe('a turn', () => {
  test('a confident mechanical turn lowers effort and logs the decision', MODEL, async ($, on) => {
    const { logs, sent } = world(on, () => VERDICT('mechanical', 0.95))
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
    await $.prompt.submit(typed('fix the typo in README'))
    await runStep($, STEP)
    await runStep($, { ...STEP, index: 1 })

    expect(sent.map(s => s.effort)).toEqual(['low', 'low'])
    expect(sent.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
    expect(logs.at(-1)).toContain('router: mechanical')
    expect(logs.at(-1)).toContain('main-model switching off')
  })

  test('main-model switching sends hard work to the strong model when turned on', MODEL, async ($, on) => {
    const { sent } = world(on, () => VERDICT('hard', 0.9))
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'router', args: 'model on' } as never)
    await $.prompt.submit(typed('redesign the auth flow'))
    await runStep($, { ...STEP, model: 'claude-sonnet-5-5' })

    expect(sent[0]?.model).toBe('claude-opus-5-5')
    expect(sent[0]?.effort).toBe('xhigh')
  })

  test('a classifier failure sends the request unchanged and says so', MODEL, async ($, on) => {
    const { logs, sent } = world(on, () => new Error('overloaded'))
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
    await $.prompt.submit(typed('rename foo to bar'))
    await runStep($, STEP)

    expect(sent).toEqual([STEP])
    expect(logs.at(-1)).toContain('request unchanged')
  })

  test('a routed request that fails before output is resent unchanged', MODEL, async ($, on) => {
    const { logs, sent } = world(on, () => VERDICT('mechanical', 0.95), true)
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'router', args: 'model on' } as never)
    await $.prompt.submit(typed('fix the typo in README'))
    await runStep($, STEP)

    expect(sent.map(s => s.model)).toEqual(['claude-haiku-5-5', 'claude-opus-5-5'])
    expect(sent[1]).toEqual(STEP)
    expect(logs.at(-1)).toContain('resent unchanged')
  })

  test('subagent requests and paused sessions are left alone', MODEL, async ($, on) => {
    const { sent } = world(on, () => VERDICT('mechanical', 0.95))
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
    await $.prompt.submit(typed('fix the typo'))
    await runStep($, { ...STEP, agentId: 'a1' })
    await $.command.run({ command: 'router', args: 'off' } as never)
    await runStep($, STEP)

    expect(sent).toEqual([{ ...STEP, agentId: 'a1' }, STEP])
  })
})


/** Laya's answer for a difficulty distribution [trivial, easy, moderate, hard] and an is_sensitive probability. */
function layaAnswer(p: readonly number[], sensitive: number): string {
  const probabilities = Object.fromEntries(p.map((v, i) => [String(i), v]))
  const score = p.reduce((sum, v, i) => sum + v * i, 0)
  return JSON.stringify({
    model: 'laya-rl-agent',
    answers: {
      difficulty: { type: 'score', score, probabilities, confidence: 0.1 },
      is_sensitive: { type: 'noul', noul: sensitive, confidence: Math.max(sensitive, 1 - sensitive) },
    },
    usage: { input_tokens: 40, output_tokens: 0 },
  })
}

const reading = (p: readonly number[], sensitive: number): LayaReading => {
  const parsed = parseLaya(layaAnswer(p, sensitive))
  if (parsed === undefined) throw new Error('fixture did not parse')
  return parsed
}

describe('laya rules', () => {
  // Distributions measured from the local laya-serve on 2026-10-08.
  test('the measured prompts land where they should', () => {
    const tier = (p: number[], s: number, text: string) => decideFromLaya(reading(p, s), highStakesSignals(text)).tier
    expect(tier([0.28, 0.36, 0.28, 0.07], 0.03, 'fix the typo teh -> the in README.md')).toBe('ordinary')
    expect(tier([0.16, 0.29, 0.48, 0.06], 0.0, 'write unit tests for the date parser')).toBe('ordinary')
    expect(tier([0.04, 0.18, 0.68, 0.1], 0.11, 'add a --verbose flag to the CLI')).toBe('ordinary')
    expect(tier([0.02, 0.22, 0.54, 0.22], 0.69, 'our prod payments webhook double-charges customers')).toBe('hard')
    expect(tier([0.01, 0.14, 0.53, 0.32], 0.08, 'design the multi-tenant architecture')).toBe('hard')
  })

  test('mechanical needs a confident low-difficulty reading and no signals', () => {
    expect(decideFromLaya(reading([0.6, 0.3, 0.08, 0.02], 0.01), []).tier).toBe('mechanical')
    expect(decideFromLaya(reading([0.6, 0.3, 0.08, 0.02], 0.01), ['auth']).tier).toBe('hard')
    expect(decideFromLaya(reading([0.5, 0.2, 0.28, 0.02], 0.01), []).tier).toBe('ordinary')
  })

  test('the move-down bar is 0.75: push and commit go down, a typo fix and a rename do not yet', () => {
    // Measured from the local laya-serve on 2026-10-08.
    const tier = (low: number, mid: number, high: number) =>
      decideFromLaya(reading([low, 0, mid, high], 0.1), []).tier
    expect(tier(0.80, 0.16, 0.04)).toBe('mechanical') // push to the develop
    expect(tier(0.76, 0.22, 0.02)).toBe('mechanical') // commit these changes
    expect(tier(0.74, 0.22, 0.04)).toBe('ordinary')
    expect(tier(0.65, 0.28, 0.07)).toBe('ordinary') // fix the typo in README.md
    expect(tier(0.55, 0.36, 0.09)).toBe('ordinary') // rename usr to user
  })

  test('an easy-looking request with any sensitivity does not move down', () => {
    // Measured live: "what is the main risk when our prod payments webhook retries a charge"
    // read as easy (low 0.95); without keyword signals it must still stay out of mechanical.
    expect(decideFromLaya(reading([0.6, 0.35, 0.03, 0.02], 0.39), []).tier).toBe('ordinary')
    expect(decideFromLaya(reading([0.6, 0.35, 0.03, 0.02], 0.39), ['payments']).tier).toBe('hard')
    expect(decideFromLaya(reading([0.6, 0.29, 0.09, 0.02], 0.05), []).tier).toBe('mechanical')
  })

  test('laya is sent the prompt alone', () => {
    // Measured live: with a long previous reply beside it, "commit" read low 0.19 instead of 0.86.
    expect(JSON.parse(layaBody('commit')).state).toEqual({ request: 'commit' })
  })

  test('a short approval is a continuation; one with a task of its own is not', () => {
    for (const yes of ['yes', 'Go ahead!', 'ok, do it please', 'lgtm', 'sounds good, thanks', 'continue']) {
      expect(isContinuation(yes)).toBe(true)
    }
    for (const task of ['commit', 'go fix the race in auth', 'yes, and fix the auth race', 'next refactor utils', 'please', '']) {
      expect(isContinuation(task)).toBe(false)
    }
    expect(continuationDecision('hard').tier).toBe('hard')
    expect(continuationDecision(null).tier).toBe('ordinary')
  })

  test('an answer of the wrong shape is unreadable', () => {
    expect(parseLaya('{"answers":{}}')).toBeUndefined()
    expect(parseLaya('not json')).toBeUndefined()
  })
})

/** The world beneath the router with Laya answering over HTTP. */
function layaWorld(on: On, answer: () => Promise<{ status: number; text: string }>) {
  const logs: string[] = []
  const sent: TurnStepInput[] = []
  const posted: string[] = []
  const clock = mock.clock(on, { now: 1_000 })
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: [] }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('http.fetch', async ($, e) => {
    posted.push(`${e.url} ${e.init?.body ?? ''}`)
    const { status, text } = await answer()
    return { value: { status, ok: status < 400, headers: {}, text } }
  })
  on('turn.step', async function* ($, e) {
    sent.push(e)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return { logs, sent, posted, clock }
}

describe('a turn classified by laya', () => {
  test('a hard reading raises effort and names laya in the log', async ($, on) => {
    const { logs, sent, posted } = layaWorld(on, async () => ({ status: 200, text: layaAnswer([0.01, 0.14, 0.53, 0.32], 0.08) }))
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
    await $.prompt.submit(typed('design the multi-tenant architecture'))
    await runStep($, STEP)

    expect(posted[0]).toContain('http://127.0.0.1:8765/v1/systemone')
    expect(posted[0]).toContain('design the multi-tenant architecture')
    expect(sent[0]?.effort).toBe('xhigh')
    expect(logs.at(-1)).toContain('router: hard [laya difficulty')
  })

  test('a laya error sends the request unchanged', async ($, on) => {
    const { logs, sent } = layaWorld(on, async () => ({ status: 500, text: 'boom' }))
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
    await $.prompt.submit(typed('rename foo'))
    await runStep($, STEP)

    expect(sent).toEqual([STEP])
    expect(logs.at(-1)).toBe('router: laya answered HTTP 500 → request unchanged')
  })

  test('an unreachable laya sends the request unchanged', async ($, on) => {
    const { logs, sent } = layaWorld(on, async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:8765')
    })
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
    await $.prompt.submit(typed('rename foo'))
    await runStep($, STEP)

    expect(sent).toEqual([STEP])
    expect(logs.at(-1)).toContain('router: laya unreachable')
  })

  test('a laya that does not answer in time sends the request unchanged', async ($, on) => {
    const { logs, sent, clock } = layaWorld(on, () => new Promise(() => undefined))
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
    await $.prompt.submit(typed('rename foo'))
    const step = runStep($, STEP)
    await clock.advance(5_000)
    await step

    expect(sent).toEqual([STEP])
    expect(logs.at(-1)).toBe('router: laya gave no answer within 5s → request unchanged')
  })

  test('a continuation inherits the previous tier without asking laya', async ($, on) => {
    const { logs, sent, posted } = layaWorld(on, async () => ({ status: 200, text: layaAnswer([0.01, 0.14, 0.53, 0.32], 0.08) }))
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
    await $.prompt.submit(typed('plan the token migration across services'))
    await runStep($, { ...STEP, turnId: 't1' })
    await $.prompt.submit(typed('yes, go ahead'))
    await runStep($, { ...STEP, turnId: 't2' })

    expect(posted.length).toBe(1)
    expect(sent.map(s => s.effort)).toEqual(['xhigh', 'xhigh'])
    expect(logs.at(-1)).toContain('continuation of the previous turn (hard)')
  })
})
