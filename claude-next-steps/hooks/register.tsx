import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelForkResult, Register } from 'claude-code'

import type { NextStep, Suggestions } from '../types'

const current = atom({ plugin: 'next-steps', key: 'current' } as const, null)

const MAX_STEPS = 4
const MAX_LABEL = 40

const ASK = `Suggest what the user is most likely to want to do next in this conversation.

Reply with only a JSON array of 2 to 4 objects, no prose and no code fence:
[{"label": "...", "prompt": "..."}]

- label: 2 to 5 words, starting with a verb, e.g. "Run the tests"
- prompt: the message the user would send to ask for it, written as the user, one or two sentences
- most likely first; only steps that follow from the work so far; never repeat what is already done`

// Keeps the head and the tail of a long text: a reply's summary leads, its
// open questions and next steps close it.
function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text
  }
  const half = Math.floor(max / 2)

  return `${text.slice(0, half)}\n…\n${text.slice(-half)}`
}

function field(item: unknown, name: string): string {
  if (typeof item !== 'object' || item === null) {
    return ''
  }
  const value = (item as Record<string, unknown>)[name]

  return typeof value === 'string' ? value.trim() : ''
}

export function parseSteps(text: string): NextStep[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) {
    return []
  }
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) {
    return []
  }

  const steps: NextStep[] = []
  for (const item of raw) {
    const label = field(item, 'label')
    if (label === '') {
      continue
    }
    steps.push({
      label: label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label,
      prompt: field(item, 'prompt') || label,
    })
  }

  return steps.slice(0, MAX_STEPS)
}

type Ask = { isFull: boolean; prompt: string; answer: string }

async function ask($: EngineInterface, { isFull, prompt, answer }: Ask): Promise<ModelForkResult> {
  if (isFull) {
    return $.model.fork({
      prompt: `Your reply that ended this turn was:\n<reply>\n${clip(answer, 8000)}\n</reply>\n\n${ASK}`,
    })
  }

  return $.model.complete({
    model: 'haiku',
    system: 'You suggest next steps for a session with a coding assistant. You answer with JSON only.',
    prompt: `<user_prompt>\n${clip(prompt, 3000)}\n</user_prompt>\n\n<assistant_reply>\n${clip(answer, 8000)}\n</assistant_reply>\n\n${ASK}`,
    maxTokens: 600,
    effort: 'low',
    timeoutMs: 30000,
  })
}

async function suggest($: EngineInterface, turnId: string, request: Ask) {
  let steps: NextStep[] = []
  try {
    const reply = await ask($, request)
    if (reply.isAnswered) {
      steps = parseSteps(reply.text)
      if (steps.length === 0) {
        $.ui.toast('next-steps: the suggestions came back unreadable')
      }
    } else {
      $.ui.toast(`next-steps: no suggestions (${reply.reason})`)
    }
  } catch (error) {
    $.ui.toast(`next-steps: no suggestions (${String(error).slice(0, 120)})`)
  }
  // A turn that started meanwhile cleared the band; its own steps win.
  await update($, current, (now): Suggestions | null =>
    now?.turnId !== turnId ? now : steps.length === 0 ? null : { turnId, status: 'ready', steps },
  )
}

async function choose($: EngineInterface, step: NextStep, isFill: boolean) {
  await update($, current, () => null)
  if (isFill) {
    await $.prompt.fill({ text: step.prompt })
    return
  }
  await $.prompt.submit({ text: step.prompt, asUser: true })
}

export const register: Register = (on, options) => {
  const isFull = options.source === 'full'
  const isFill = options.onPress === 'fill'
  let lastPrompt = ''

  on('turn.start', async ($, e, next) => {
    if (e.text !== '') {
      lastPrompt = e.text
    }
    await update($, current, () => null)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer' || e.answer.trim() === '') {
      return result
    }
    const surfaces = await $.session.surfaces()
    if (!surfaces.some(surface => surface === 'terminal' || surface === 'desktop')) {
      return result
    }

    await update($, current, (): Suggestions => ({ turnId: e.turnId, status: 'loading', steps: [] }))
    void suggest($, e.turnId, { isFull, prompt: lastPrompt, answer: e.answer })

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, current)
    if (now === null || e.props.hasSurvey || e.props.view.agentId !== undefined) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)

    if (now.status === 'loading') {
      return <Text dimColor>Suggesting next steps…</Text>
    }

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Text dimColor>Next:</Text>
        {now.steps.map((step, index) => (
          <Button
            key={`step-${index}`}
            plain
            hotkey={String(index + 1)}
            label={step.label}
            onPress={() => choose($, step, isFill)}
          />
        ))}
        <Button
          key="dismiss"
          role="dismiss"
          plain
          dimColor
          hotkey="x"
          label="dismiss"
          onPress={() => update($, current, () => null)}
        />
      </Box>
    )
  })
}
