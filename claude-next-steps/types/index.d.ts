export type NextStep = { label: string; prompt: string }

export type Suggestions = {
  turnId: string
  status: 'loading' | 'ready'
  steps: NextStep[]
}

declare module 'claude-code' {
  interface PluginState {
    'next-steps': { current: Suggestions | null }
  }
}
