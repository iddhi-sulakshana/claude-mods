export type BridgeKind =
  | 'message'
  | 'question'
  | 'reply'
  | 'handoff'
  | 'review-request'
  | 'status'

/** Where a session runs inside cmux: its workspace and terminal surface (UUIDs from cmux's environment). */
export type CmuxRef = {
  workspace: string
  surface?: string
}

export type BridgePeer = {
  id: string
  name: string
  role: string
  cwd: string
  updatedAt: number
  /** Set when the session runs inside cmux, so peers can focus its workspace. */
  cmux?: CmuxRef
}

export type BridgeMessage = {
  id: string
  kind: BridgeKind
  from: { id: string; name: string; role: string; cwd: string }
  to: string
  subject?: string
  body: string
  replyTo?: string
  handoffPath?: string
  createdAt: number
}

/** One sent message, as written to `events/<id>.json` for a board app to draw. */
export type BridgeEvent = {
  v: 1
  id: string
  /** Unix milliseconds. */
  at: number
  kind: BridgeKind
  from: { id: string; name: string }
  /** The recipient names: the live sessions it went to, or the one name it is queued for. */
  to: string[]
  preview: string
}

export type BridgeLogEntry = {
  direction: 'in' | 'out'
  message: BridgeMessage
  isDelivered: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'session-bridge': {
      me: BridgePeer | null
      peers: BridgePeer[]
      log: BridgeLogEntry[]
      isAuto: boolean
    }
  }
}
