/**
 * Meet: High-level API for WebRTC video conferencing via product-sdk Statement Store
 *
 * This is the main entry point for applications using @productivity/calls.
 * It provides an event-based API wrapping the lower-level CallsProvider.
 */

import { CallsProvider } from './provider'
import { CallsError } from './errors'
import type { CallsMeetConfig, ConnectionStatus } from './types'

export interface PeerInfo {
  peerId: string
  displayName?: string
}

type MeetEventMap = {
  status: (status: ConnectionStatus, message?: string) => void
  peerJoined: (peer: PeerInfo) => void
  peerLeft: (peerId: string) => void
  peerConnected: (peerId: string) => void
  peerDisconnected: (peerId: string) => void
  stream: (peerId: string, stream: MediaStream) => void
  data: (peerId: string, data: unknown) => void
  log: (message: string, type: string) => void
  error: (error: Error) => void
  screenShareStateChange: (peerId: string | null, username?: string) => void
  screenShare: (peerId: string, stream: MediaStream | null) => void
}

type MeetEvent = keyof MeetEventMap

export class Meet {
  private config: CallsMeetConfig
  private provider: CallsProvider | null = null
  private localStream: MediaStream | null = null
  private eventListeners = new Map<string, Set<(...args: unknown[]) => void>>()
  private peerInfoMap = new Map<string, PeerInfo>()

  constructor(config: CallsMeetConfig) {
    this.validateConfig(config)
    this.config = config
  }

  // ============================================================================
  // Event Emitter
  // ============================================================================

  on<E extends MeetEvent>(event: E, callback: MeetEventMap[E]): () => void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set())
    }
    this.eventListeners.get(event)!.add(callback as (...args: unknown[]) => void)
    return () => {
      this.eventListeners.get(event)?.delete(callback as (...args: unknown[]) => void)
    }
  }

  off<E extends MeetEvent>(event: E, callback: MeetEventMap[E]): void {
    this.eventListeners.get(event)?.delete(callback as (...args: unknown[]) => void)
  }

  once<E extends MeetEvent>(event: E, callback: MeetEventMap[E]): () => void {
    const wrappedCallback = ((...args: unknown[]) => {
      this.off(event, wrappedCallback as MeetEventMap[E])
      ;(callback as (...args: unknown[]) => void)(...args)
    }) as MeetEventMap[E]
    return this.on(event, wrappedCallback)
  }

  private emit(event: string, ...args: unknown[]): void {
    const listeners = this.eventListeners.get(event)
    if (listeners) {
      for (const callback of listeners) {
        try {
          callback(...args)
        } catch (error) {
          console.error(`Error in ${event} event handler:`, error)
        }
      }
    }
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  setLocalStream(stream: MediaStream | null): void {
    this.localStream = stream
    if (this.provider) {
      this.provider.setLocalStream(stream)
    }
  }

  getLocalStream(): MediaStream | null {
    return this.localStream
  }

  async connect(): Promise<void> {
    if (this.provider) {
      throw CallsError.alreadyConnected()
    }

    try {
      this.provider = new CallsProvider(this.config.roomId, {
        accountId: this.config.accountId,
        peerId: this.config.identity.peerId,
        username: this.config.identity.displayName,
        roomKey: this.config.options?.roomKey,
        appTopic: this.config.options?.appTopic,
        turnKeyId: this.config.turn?.keyId,
        turnApiToken: this.config.turn?.apiToken,
        forceRelay: this.config.options?.forceRelay,
        presenceExpiry: this.config.options?.presenceExpiry,
        onStatus: (status, message) => {
          this.emit('status', status, message)
        },
        onPeerConnect: (peerId) => {
          this.emit('peerConnected', peerId)
        },
        onPeerDisconnect: (peerId) => {
          this.emit('peerDisconnected', peerId)
          const knownPeers = this.provider?.getConnectedPeers() || []
          if (!knownPeers.includes(peerId)) {
            this.peerInfoMap.delete(peerId)
            this.emit('peerLeft', peerId)
          }
        },
        onStream: (peerId, stream) => {
          this.emit('stream', peerId, stream)
        },
        onScreenShare: (peerId, stream) => {
          this.emit('screenShare', peerId, stream)
        },
        onScreenShareStateChange: (peerId, username) => {
          this.emit('screenShareStateChange', peerId, username)
        },
        onData: (peerId, data) => {
          try {
            const decoded = new TextDecoder().decode(data)
            const parsed = JSON.parse(decoded)
            this.emit('data', peerId, parsed)
          } catch {
            this.emit('data', peerId, data)
          }
        },
        onLog: (message, type) => {
          if (this.config.options?.debug || type === 'error') {
            this.emit('log', message, type)
          }
        }
      })

      if (this.localStream) {
        this.provider.setLocalStream(this.localStream)
      }

      await this.provider.connect()
    } catch (error) {
      this.provider = null
      throw CallsError.connectionFailed(
        error instanceof Error ? error.message : 'Connection failed',
        error instanceof Error ? error : undefined
      )
    }
  }

  async disconnect(): Promise<void> {
    if (!this.provider) return

    try {
      await this.provider.disconnect()
    } finally {
      this.provider = null
      this.peerInfoMap.clear()
      this.eventListeners.clear()
    }
  }

  removeAllListeners(): void {
    this.eventListeners.clear()
  }

  isConnected(): boolean {
    return this.provider?.getStatus() === 'connected'
  }

  getStatus(): ConnectionStatus {
    return this.provider?.getStatus() ?? 'disconnected'
  }

  // ============================================================================
  // Screen Share
  // ============================================================================

  async startScreenShare(): Promise<MediaStream | null> {
    if (!this.provider) throw CallsError.notConnected()
    return this.provider.startScreenShare()
  }

  async stopScreenShare(): Promise<void> {
    if (!this.provider) return
    await this.provider.stopScreenShare()
  }

  isScreenSharing(): boolean {
    return this.provider?.isScreenSharing() ?? false
  }

  isLocalScreenSharing(): boolean {
    return this.provider?.isLocalScreenSharing() ?? false
  }

  getScreenSharer(): { peerId: string; username?: string } | null {
    return this.provider?.getScreenSharer() ?? null
  }

  // ============================================================================
  // Peer Information
  // ============================================================================

  getConnectedPeers(): string[] {
    return this.provider?.getConnectedPeers() ?? []
  }

  getPeerInfo(peerId: string): PeerInfo | undefined {
    return this.peerInfoMap.get(peerId)
  }

  getAllPeers(): PeerInfo[] {
    return Array.from(this.peerInfoMap.values())
  }

  // ============================================================================
  // Data Transmission
  // ============================================================================

  send(peerId: string, data: string | object): boolean {
    if (!this.provider) throw CallsError.notConnected()
    const encoded = typeof data === 'string' ? data : JSON.stringify(data)
    return this.provider.send(peerId, encoded)
  }

  broadcast(data: string | object): void {
    if (!this.provider) throw CallsError.notConnected()
    const encoded = typeof data === 'string' ? data : JSON.stringify(data)
    this.provider.broadcast(encoded)
  }

  // ============================================================================
  // Room Information
  // ============================================================================

  getRoomId(): string {
    return this.config.roomId
  }

  getPeerId(): string {
    return this.config.identity.peerId
  }

  getDisplayName(): string | undefined {
    return this.config.identity.displayName
  }

  // ============================================================================
  // Meeting Optimizations
  // ============================================================================

  enableOptimizations(): void {
    this.provider?.enableOptimizations()
  }

  disableOptimizations(): void {
    this.provider?.disableOptimizations()
  }

  setPeerVisible(peerId: string, visible: boolean): void {
    this.provider?.setPeerVisible(peerId, visible)
  }

  pinPeer(peerId: string): void {
    this.provider?.pinPeer(peerId)
  }

  unpinPeer(peerId: string): void {
    this.provider?.unpinPeer(peerId)
  }

  // ============================================================================
  // Internal
  // ============================================================================

  private validateConfig(config: CallsMeetConfig): void {
    if (!config.roomId) throw CallsError.invalidConfig('roomId is required')
    if (!config.accountId) throw CallsError.invalidConfig('accountId is required')
    if (!config.identity?.peerId) throw CallsError.invalidConfig('identity.peerId is required')
  }
}
