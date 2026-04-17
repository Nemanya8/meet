/**
 * Core types for the calls package.
 *
 * Key design principles:
 * - Subscribe API: Real-time message delivery (replay + live updates)
 * - Store-level expiry: Statements auto-expire, no heartbeats needed
 * - Older peer offers: The peer who joined first initiates connections
 * - Single handshake channel: Offer and answer on the same channel per peer pair
 */

import type { ProductAccountId } from '@novasamatech/product-sdk'

// ============================================================================
// Log types
// ============================================================================

export type LogType =
  | 'info'
  | 'error'
  | 'warning'
  | 'success'
  | 'blockchain'

export type LogFn = (message: string, type: LogType) => void

// ============================================================================
// Connection status
// ============================================================================

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected'

// ============================================================================
// Channel value types
// ============================================================================

export interface PresenceValue {
  type: 'presence'
  peerId: string
  timestamp: number
  username?: string
}

export interface OfferValue {
  type: 'offer'
  from: string
  to: string
  sdp: string
  timestamp: number
}

export interface AnswerValue {
  type: 'answer'
  from: string
  to: string
  sdp: string
  timestamp: number
}

export interface IceCandidateEntry {
  candidate: string
  sdpMid: string | null
  sdpMLineIndex: number | null
}

export interface IceCandidateValue {
  type: 'ice-candidate'
  from: string
  to: string
  candidates: IceCandidateEntry[]
  timestamp: number
}

export type ChannelValue = PresenceValue | OfferValue | AnswerValue | IceCandidateValue

// ============================================================================
// Peer Sync (Gossip) Types
// ============================================================================

export interface GossipPeerInfo {
  peerId: string
  joinTime: number
  username?: string
}

export interface PeerSyncMessage {
  type: '__peer-sync__'
  peerId: string
  joinTime: number
  username?: string
  peers: GossipPeerInfo[]
}

export interface ScreenShareMessage {
  type: '__screen-share__'
  action: 'start' | 'stop'
  peerId: string
  username?: string
  timestamp: number
}

export interface PeerCloseMessage {
  type: '__peer-close__'
  peerId: string
  timestamp: number
}

export function isPeerCloseMessage(data: unknown): data is PeerCloseMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as PeerCloseMessage).type === '__peer-close__'
  )
}

export function isPeerSyncMessage(data: unknown): data is PeerSyncMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as PeerSyncMessage).type === '__peer-sync__'
  )
}

export function isScreenShareMessage(data: unknown): data is ScreenShareMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as ScreenShareMessage).type === '__screen-share__'
  )
}

// ============================================================================
// Channel Naming Functions
// ============================================================================

export function getPresenceChannel(documentId: string, peerId: string): string {
  return `${documentId}/presence/peer-${peerId}`
}

export function getHandshakeChannel(documentId: string, peerA: string, peerB: string): string {
  const [first, second] = [peerA, peerB].sort()
  return `${documentId}/handshake/${first}-${second}`
}


// ============================================================================
// Offerer Selection (Older Peer Offers)
// ============================================================================

export function isOfferer(
  myJoinTime: number,
  otherJoinTime: number,
  myPeerId: string,
  otherPeerId: string
): boolean {
  if (myJoinTime !== otherJoinTime) {
    return myJoinTime < otherJoinTime
  }
  return myPeerId < otherPeerId
}

// ============================================================================
// Utility Functions
// ============================================================================

export function generatePeerId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

// ============================================================================
// Provider Config
// ============================================================================

export interface CallsProviderConfig {
  peerId: string
  username?: string
  accountId: ProductAccountId
  roomKey?: CryptoKey
  appTopic?: string
  forceRelay?: boolean
  presenceExpiry?: number

  // TURN credentials
  turnKeyId?: string
  turnApiToken?: string

  // Callbacks
  onStatus?: (status: ConnectionStatus, message?: string) => void
  onPeerConnect?: (peerId: string) => void
  onPeerDisconnect?: (peerId: string) => void
  onStream?: (peerId: string, stream: MediaStream) => void
  onScreenShare?: (peerId: string, stream: MediaStream | null) => void
  onScreenShareStateChange?: (peerId: string | null, username?: string) => void
  onData?: (peerId: string, data: Uint8Array) => void
  onLog?: LogFn
  onQualityChange?: (peerId: string, tier: string) => void
}

export interface CallsMeetConfig {
  roomId: string
  accountId: ProductAccountId
  identity: {
    peerId: string
    displayName?: string
  }
  turn?: {
    keyId: string
    apiToken: string
  }
  options?: {
    forceRelay?: boolean
    presenceExpiry?: number
    debug?: boolean
    roomKey?: CryptoKey
    appTopic?: string
  }
}
