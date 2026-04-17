import type { LogFn, ScreenShareMessage } from './types'

export interface ScreenShareDeps {
  peerId: string
  username?: string
  getConnectedPeers: () => string[]
  broadcast: (data: Uint8Array) => void
  sendToPeer: (peerId: string, data: Uint8Array) => boolean
  addScreenShareTracks: (stream: MediaStream) => Promise<boolean>
  removeScreenShareTracks: () => Promise<void>
  addScreenShareTracksToPeer: (peerId: string, stream: MediaStream) => Promise<boolean>
  getScreenShareStreamFromPeer: (peerId: string) => MediaStream | undefined
  onScreenShare?: (peerId: string, stream: MediaStream | null) => void
  onScreenShareStateChange?: (peerId: string | null, username?: string) => void
  log: LogFn
}

export class ScreenShareManager {
  private deps: ScreenShareDeps
  private screenShareStream: MediaStream | null = null
  private screenSharerPeerId: string | null = null
  private screenSharerUsername?: string

  constructor(deps: ScreenShareDeps) {
    this.deps = deps
  }

  async startScreenShare(): Promise<MediaStream | null> {
    if (this.screenSharerPeerId && this.screenSharerPeerId !== this.deps.peerId) {
      const connectedPeers = this.deps.getConnectedPeers()
      if (!connectedPeers.includes(this.screenSharerPeerId)) {
        this.screenSharerPeerId = null
        this.screenSharerUsername = undefined
        this.deps.onScreenShareStateChange?.(null)
      } else {
        this.deps.log(
          `Cannot start screen share: ${this.screenSharerUsername || this.screenSharerPeerId} is already sharing`,
          'warning'
        )
        return null
      }
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      this.screenShareStream = stream
      this.screenSharerPeerId = this.deps.peerId
      this.screenSharerUsername = this.deps.username

      this.broadcastState('start')
      await this.deps.addScreenShareTracks(stream)

      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        this.stopScreenShare()
      })

      this.deps.onScreenShareStateChange?.(this.deps.peerId, this.deps.username)
      return stream
    } catch (error) {
      this.deps.log(`Failed to start screen share: ${error}`, 'error')
      return null
    }
  }

  async stopScreenShare(): Promise<void> {
    if (this.screenSharerPeerId !== this.deps.peerId) return

    if (this.screenShareStream) {
      this.screenShareStream.getTracks().forEach((track) => track.stop())
    }

    await this.deps.removeScreenShareTracks()
    this.broadcastState('stop')

    this.screenShareStream = null
    this.screenSharerPeerId = null
    this.screenSharerUsername = undefined
    this.deps.onScreenShareStateChange?.(null)
  }

  isScreenSharing(): boolean {
    return this.screenSharerPeerId !== null
  }

  isLocalScreenSharing(): boolean {
    return this.screenSharerPeerId === this.deps.peerId
  }

  getScreenSharer(): { peerId: string; username?: string } | null {
    if (!this.screenSharerPeerId) return null
    return { peerId: this.screenSharerPeerId, username: this.screenSharerUsername }
  }

  getScreenShareStream(): MediaStream | null {
    return this.screenShareStream
  }

  clearState(): void {
    this.screenSharerPeerId = null
    this.screenSharerUsername = undefined
    this.deps.onScreenShareStateChange?.(null)
  }

  notifyNewPeer(peerId: string): void {
    if (this.screenSharerPeerId !== this.deps.peerId || !this.screenShareStream) return

    const message: ScreenShareMessage = {
      type: '__screen-share__',
      action: 'start',
      peerId: this.deps.peerId,
      username: this.deps.username,
      timestamp: Date.now()
    }
    const data = new TextEncoder().encode(JSON.stringify(message))
    this.deps.sendToPeer(peerId, data)
    this.deps.addScreenShareTracksToPeer(peerId, this.screenShareStream)
  }

  handleSharerDisconnected(peerId: string): void {
    if (this.screenSharerPeerId !== peerId) return
    this.screenSharerPeerId = null
    this.screenSharerUsername = undefined
    this.deps.onScreenShareStateChange?.(null)
  }

  handleStream(peerId: string, stream: MediaStream | null): void {
    this.deps.onScreenShare?.(peerId, stream)
  }

  handleMessage(fromPeerId: string, message: ScreenShareMessage): void {
    if (message.action === 'start') {
      this.screenSharerPeerId = message.peerId
      this.screenSharerUsername = message.username
      this.deps.onScreenShareStateChange?.(message.peerId, message.username)

      const stream = this.deps.getScreenShareStreamFromPeer(fromPeerId)
      if (stream) {
        this.deps.onScreenShare?.(fromPeerId, stream)
      }
    } else {
      this.screenSharerPeerId = null
      this.screenSharerUsername = undefined
      this.deps.onScreenShareStateChange?.(null)
      this.deps.onScreenShare?.(fromPeerId, null)
    }
  }

  cleanupForDisconnect(): void {
    if (this.screenSharerPeerId === this.deps.peerId && this.screenShareStream) {
      this.broadcastState('stop')
      this.screenShareStream.getTracks().forEach((track) => track.stop())
      this.screenShareStream = null
    }
    this.screenSharerPeerId = null
    this.screenSharerUsername = undefined
  }

  private broadcastState(action: 'start' | 'stop'): void {
    const message: ScreenShareMessage = {
      type: '__screen-share__',
      action,
      peerId: this.deps.peerId,
      username: this.deps.username,
      timestamp: Date.now()
    }
    const data = new TextEncoder().encode(JSON.stringify(message))
    this.deps.broadcast(data)
  }
}
