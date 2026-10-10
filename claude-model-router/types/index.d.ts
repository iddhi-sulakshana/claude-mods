export type Tier = 'mechanical' | 'ordinary' | 'hard'

declare module 'claude-code' {
  interface PluginState {
    'model-router': {
      /** Routing paused for this session with /router off. */
      isPaused: boolean
      /** Session override of switchMainModel; null follows the setting. */
      modelSwitch: boolean | null
      /** The last decision's log line. */
      last: string | null
      /** The last decided tier, which a short continuation ("yes", "go ahead") inherits. */
      lastTier: 'mechanical' | 'ordinary' | 'hard' | null
    }
  }
}
