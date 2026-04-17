import type { MeshHealthTracker } from './mesh-health'
import type { GossipPeerInfo, LogFn, PresenceValue } from './types'

export interface PeerSyncDeps {
  peerId: string
  username?: string
  getConnectedPeers: () => string[]
  broadcast: (data: Uint8Array) => void
  getKnownPeers: () => Map<string, PresenceValue>
  getJoinTime: () => number
  addPeerFromGossip: (peerInfo: GossipPeerInfo) => boolean
  isConnected: (peerId: string) => boolean
  republishPresence: () => Promise<boolean>
  onPeerDiscovered: (peerId: string, joinTime: number, username?: string) => Promise<void>
  meshHealth: MeshHealthTracker
  log: LogFn
}

export class PeerSyncManager {
  private PEER_SYNC_INTERVAL = 15000
  private peerSyncTimer: ReturnType<typeof setInterval> | null = null
  private pendingPresenceRefresh = false
  private deps: PeerSyncDeps

  constructor(deps: PeerSyncDeps) {
    this.deps = deps
  }

  start(): void {
    if (this.peerSyncTimer) return

    setTimeout(() => this.broadcastSync(), 2000)

    this.peerSyncTimer = setInterval(() => {
      this.broadcastSync()
    }, this.PEER_SYNC_INTERVAL)
  }

  stop(): void {
    if (this.peerSyncTimer) {
      clearInterval(this.peerSyncTimer)
      this.peerSyncTimer = null
    }
  }

  broadcastClose(): void {
    const message = {
      type: '__peer-close__',
      peerId: this.deps.peerId,
      timestamp: Date.now()
    }
    const data = new TextEncoder().encode(JSON.stringify(message))
    this.deps.broadcast(data)
  }

  async handleMessage(
    _fromPeerId: string,
    message: {
      peerId: string
      joinTime: number
      username?: string
      peers: Array<{ peerId: string; joinTime: number; username?: string }>
    }
  ): Promise<void> {
    this.deps.meshHealth.updateReport(
      message.peerId,
      message.peers.map((p) => p.peerId)
    )

    let discoveredNewPeers = false

    const senderInfo = {
      peerId: message.peerId,
      joinTime: message.joinTime,
      username: message.username
    }
    if (this.deps.addPeerFromGossip(senderInfo)) {
      discoveredNewPeers = true
      await this.deps.onPeerDiscovered(message.peerId, message.joinTime, message.username)
    }

    for (const peerInfo of message.peers) {
      if (peerInfo.peerId === this.deps.peerId) continue
      if (this.deps.isConnected(peerInfo.peerId)) continue

      if (this.deps.addPeerFromGossip(peerInfo)) {
        discoveredNewPeers = true
        await this.deps.onPeerDiscovered(peerInfo.peerId, peerInfo.joinTime, peerInfo.username)
      }
    }

    if (discoveredNewPeers && !this.pendingPresenceRefresh) {
      this.pendingPresenceRefresh = true
      setTimeout(async () => {
        this.pendingPresenceRefresh = false
        await this.deps.republishPresence()
      }, 1000)
    }
  }

  private broadcastSync(): void {
    const connectedPeers = this.deps.getConnectedPeers()
    if (connectedPeers.length === 0) return

    const peers = connectedPeers.map((peerId) => {
      const presence = this.deps.getKnownPeers().get(peerId)
      return {
        peerId,
        joinTime: presence?.timestamp || 0,
        username: presence?.username
      }
    })

    const message = {
      type: '__peer-sync__',
      peerId: this.deps.peerId,
      joinTime: this.deps.getJoinTime(),
      username: this.deps.username,
      peers
    }

    const data = new TextEncoder().encode(JSON.stringify(message))
    this.deps.broadcast(data)
  }
}
