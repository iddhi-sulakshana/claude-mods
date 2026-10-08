export type BridgeKind =
  | 'message'
  | 'question'
  | 'reply'
  | 'handoff'
  | 'review-request'
  | 'status'

export type BridgePeer = {
  id: string
  name: string
  role: string
  cwd: string
  updatedAt: number
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
