import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  plugin: 'next-steps',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const STEPS = JSON.stringify([
  { label: 'Run the tests', prompt: 'Run the test suite and fix any failures.' },
  { label: 'Commit the change', prompt: 'Commit these changes with a clear message.' },
])

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const DONE = { answer: 'Added the login form.', durationMs: 1, isAborted: false, reason: 'answer' } as const

// The world beneath the plugin: one terminal, a model held until `release`,
// and every prompt the plugin submits or fills recorded.
function world(on: On, reply = STEPS) {
  const clock = mock.clock(on)
  const asked: string[] = []
  const submitted: string[] = []
  const filled: string[] = []
  let release = () => {}
  const held = new Promise<void>(resolve => {
    release = resolve
  })

  on('session.surfaces', () => ({ value: ['terminal'] }))
  // The engine's own band, drawn when the plugin passes.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('model.complete', async ($, e) => {
    asked.push(e.prompt)
    await held
    return { value: { isAnswered: true, text: reply, usage: USAGE } }
  })
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })

  return { clock, asked, submitted, filled, release: () => release() }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a finished turn offers its next steps as buttons (${surface})`, async ($, on) => {
    const w = world(on)
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Button' })).toBeUndefined()

    await $.turn.start({ text: 'add a login form', turnId: 't1' })
    await $.turn.complete({ ...DONE, turnId: 't1' })
    expect(await ui.find({ type: 'Text', text: /Suggesting next steps/ })).toBeDefined()
    expect(w.asked[0]).toContain('add a login form')
    expect(w.asked[0]).toContain('Added the login form.')

    w.release()
    await w.clock.settle()
    expect((await ui.find({ key: 'step-0' }))?.text).toBe('Run the tests')
    expect((await ui.find({ key: 'step-1' }))?.text).toBe('Commit the change')
    expect(await ui.find({ key: 'dismiss' })).toBeDefined()

    await ui.press({ key: 'step-0' })
    expect(w.submitted).toEqual(['Run the test suite and fix any failures.'])
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
  })
}

test('fill mode puts the step in the prompt box instead of sending it', { options: { onPress: 'fill' } }, async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await $.turn.start({ text: 'add a login form', turnId: 't1' })
  await $.turn.complete({ ...DONE, turnId: 't1' })
  w.release()
  await w.clock.settle()

  await ui.press({ key: 'step-1' })
  expect(w.filled).toEqual(['Commit these changes with a clear message.'])
  expect(w.submitted).toEqual([])
})

test('dismiss clears the band', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await $.turn.start({ text: 'add a login form', turnId: 't1' })
  await $.turn.complete({ ...DONE, turnId: 't1' })
  w.release()
  await w.clock.settle()

  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  expect(w.submitted).toEqual([])
})

test('steps that arrive after a new turn started are dropped', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await $.turn.start({ text: 'add a login form', turnId: 't1' })
  await $.turn.complete({ ...DONE, turnId: 't1' })
  await $.turn.start({ text: 'never mind, style it', turnId: 't2' })

  w.release()
  await w.clock.settle()
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Suggesting/ })).toBeUndefined()
})

test('a reply that is not a list of steps leaves the band empty', async ($, on) => {
  const w = world(on, 'Sure, you could run the tests.')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await $.turn.start({ text: 'add a login form', turnId: 't1' })
  await $.turn.complete({ ...DONE, turnId: 't1' })

  w.release()
  await w.clock.settle()
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Suggesting/ })).toBeUndefined()
})

test('interrupted turns and subagent turns ask for nothing', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'add a login form', turnId: 't1' })
  await $.turn.complete({ ...DONE, turnId: 't1', reason: 'aborted', isAborted: true })
  await $.turn.complete({ ...DONE, turnId: 't2', agentId: 'agent-1' })
  await w.clock.settle()
  expect(w.asked).toEqual([])
})
