/**
 * CallsProvider: Main orchestrator for WebRTC video calling via product-sdk Statement Store
 *
 * Thin coordinator that delegates to:
 * - PeerManager: WebRTC connection management
 * - SignalingManager: Peer discovery and offer/answer exchange
 * - SDKTransportClient: product-sdk read/write operations
 * - RetryManager: Connection retry with backoff
 * - PeerSyncManager: Gossip-based peer discovery
 * - MeshHealthTracker: Mesh asymmetry detection
 * - ScreenShareManager: Screen share state
 */

import { PeerManager } from './peer-manager'
import { SDKTransportClient } from './sdk-client'
import { SignalingManager } from './signaling'
import { TurnCredentials } from './turn-credentials'
import { QualityTierManager } from './meeting-optimizations'
import { RetryManager } from './retry'
import { MeshHealthTracker } from './mesh-health'
import type { MeshHealthReport } from './mesh-health'
import { ScreenShareManager } from './screen-share'
import { PeerSyncManager } from './peer-sync'
import type { CallsProviderConfig, ConnectionStatus, IceCandidateEntry, LogFn } from './types'
import { isPeerCloseMessage, isPeerSyncMessage, isScreenShareMessage } from './types'

export class CallsProvider {
  private documentId: string
  private peerId: string
  private config: CallsProviderConfig
  private store: SDKTransportClient
  private signaling: SignalingManager
  private peerManager: PeerManager
  private turnCredentials: TurnCredentials
  private retry: RetryManager
  private meshHealth: MeshHealthTracker
  private screenShare: ScreenShareManager
  private peerSync: PeerSyncManager
  private status: ConnectionStatus = 'disconnected'

  private localStream: MediaStream | null = null
  private connectingPeers = new Set<string>()

  // ICE candidate batching
  private ICE_BATCH_INTERVAL = 200
  private pendingCandidates = new Map<string, IceCandidateEntry[]>()
  private iceBatchTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private pendingAnswers = new Map<string, Promise<boolean>>()

  // Meeting optimizations
  private qualityManager: QualityTierManager | null = null
  private optimizationsEnabled = false

  constructor(documentId: string, config: CallsProviderConfig) {
    this.documentId = documentId
    this.peerId = config.peerId
    this.config = config
    const onLog: LogFn = config.onLog || (() => {})

    this.turnCredentials = new TurnCredentials({
      keyId: config.turnKeyId,
      apiToken: config.turnApiToken
    })

    this.store = new SDKTransportClient({
      accountId: config.accountId,
      documentId,
      appTopic: config.appTopic,
      roomKey: config.roomKey,
      onLog
    })

    this.peerManager = new PeerManager(this.turnCredentials, {
      onConnect: this.handlePeerConnect.bind(this),
      onClose: this.handlePeerClose.bind(this),
      onError: this.handlePeerError.bind(this),
      onData: this.handlePeerData.bind(this),
      onStream: this.handlePeerStream.bind(this),
      onScreenShare: (peerId, stream) => this.screenShare.handleStream(peerId, stream),
      onOfferReady: this.handleOfferReady.bind(this),
      onAnswerReady: this.handleAnswerReady.bind(this),
      onIceCandidate: this.handleIceCandidate.bind(this),
      onRenegotiationOffer: this.handleRenegotiationOfferReady.bind(this),
      onRenegotiationAnswer: this.handleRenegotiationAnswerReady.bind(this),
      onLog
    })

    this.signaling = new SignalingManager({
      store: this.store,
      documentId,
      peerId: this.peerId,
      username: config.username,
      events: {
        onPeerDiscovered: this.handlePeerDiscovered.bind(this),
        onOfferReceived: this.handleOfferReceived.bind(this),
        onAnswerReceived: this.handleAnswerReceived.bind(this),
        onIceCandidatesReceived: this.handleIceCandidatesReceived.bind(this),
        onLog
      }
    })

    this.retry = new RetryManager({
      shouldOffer: (peerId) => this.signaling.shouldOffer(peerId),
      getKnownPeerIds: () => this.signaling.getKnownPeerIds(),
      hasPeer: (peerId) => this.peerManager.hasPeer(peerId),
      initiateConnection: (peerId) => this.initiateConnection(peerId),
      log: onLog
    })

    this.meshHealth = new MeshHealthTracker(
      this.peerId,
      () => this.peerManager.getConnectedPeers()
    )

    this.screenShare = new ScreenShareManager({
      peerId: this.peerId,
      username: config.username,
      getConnectedPeers: () => this.peerManager.getConnectedPeers(),
      broadcast: (data) => this.peerManager.broadcast(data),
      sendToPeer: (peerId, data) => this.peerManager.send(peerId, data),
      addScreenShareTracks: (stream) => this.peerManager.addScreenShareTracks(stream),
      removeScreenShareTracks: () => this.peerManager.removeScreenShareTracks(),
      addScreenShareTracksToPeer: (peerId, stream) =>
        this.peerManager.addScreenShareTracksToPeer(peerId, stream),
      getScreenShareStreamFromPeer: (peerId) => this.peerManager.getScreenShareStream(peerId),
      onScreenShare: config.onScreenShare,
      onScreenShareStateChange: config.onScreenShareStateChange,
      log: onLog
    })

    this.peerSync = new PeerSyncManager({
      peerId: this.peerId,
      username: config.username,
      getConnectedPeers: () => this.peerManager.getConnectedPeers(),
      broadcast: (data) => this.peerManager.broadcast(data),
      getKnownPeers: () => this.signaling.getKnownPeers(),
      getJoinTime: () => this.signaling.getJoinTime(),
      addPeerFromGossip: (info) => this.signaling.addPeerFromGossip(info),
      isConnected: (peerId) => this.peerManager.isConnected(peerId),
      republishPresence: () => this.signaling.republishPresence(),
      onPeerDiscovered: (peerId, joinTime, username) =>
        this.handlePeerDiscovered(peerId, joinTime, username),
      meshHealth: this.meshHealth,
      log: onLog
    })
  }

  getStatus(): ConnectionStatus {
    return this.status
  }

  getPeerId(): string {
    return this.peerId
  }

  getDocumentId(): string {
    return this.documentId
  }

  getConnectedPeers(): string[] {
    return this.peerManager.getConnectedPeers()
  }

  getJoinTime(): number {
    return this.signaling.getJoinTime()
  }

  getPeerManager(): PeerManager {
    return this.peerManager
  }

  getMeshHealth(): MeshHealthReport {
    return this.meshHealth.getMeshHealth()
  }

  setLocalStream(stream: MediaStream | null): void {
    this.localStream = stream
    this.log(`Local stream ${stream ? 'set' : 'cleared'}`, 'info')
  }

  getLocalStream(): MediaStream | null {
    return this.localStream
  }

  async startScreenShare(): Promise<MediaStream | null> {
    return this.screenShare.startScreenShare()
  }

  async stopScreenShare(): Promise<void> {
    return this.screenShare.stopScreenShare()
  }

  isScreenSharing(): boolean {
    return this.screenShare.isScreenSharing()
  }

  isLocalScreenSharing(): boolean {
    return this.screenShare.isLocalScreenSharing()
  }

  getScreenSharer(): { peerId: string; username?: string } | null {
    return this.screenShare.getScreenSharer()
  }

  getScreenShareStream(): MediaStream | null {
    return this.screenShare.getScreenShareStream()
  }

  clearScreenShareState(): void {
    this.screenShare.clearState()
  }

  enableOptimizations(): void {
    if (this.optimizationsEnabled) return
    this.qualityManager = new QualityTierManager((msg, type) => this.log(msg, type))
    this.qualityManager.onTierChange((peerId, tier) => {
      this.config.onQualityChange?.(peerId, tier)
    })
    this.qualityManager.start()
    this.optimizationsEnabled = true
  }

  disableOptimizations(): void {
    if (!this.optimizationsEnabled || !this.qualityManager) return
    this.qualityManager.stop()
    this.qualityManager = null
    this.optimizationsEnabled = false
  }

  getQualityManager(): QualityTierManager | null {
    return this.qualityManager
  }

  setPeerVisible(peerId: string, visible: boolean): void {
    this.qualityManager?.setPeerVisible(peerId, visible)
  }

  pinPeer(peerId: string): void {
    this.qualityManager?.setPeerPinned(peerId, true)
  }

  unpinPeer(peerId: string): void {
    this.qualityManager?.setPeerPinned(peerId, false)
  }

  async connect(): Promise<void> {
    if (this.status !== 'disconnected') {
      throw new Error('Already connected or connecting')
    }

    this.setStatus('connecting', 'Connecting via product-sdk...')

    try {
      await this.store.connect()
      await this.signaling.start()
      this.peerSync.start()
      this.setStatus('connected', `Connected as ${this.peerId}`)
      this.log(`Connected to room: ${this.documentId}`, 'success')
    } catch (error) {
      this.setStatus('disconnected', 'Connection failed')
      throw error
    }
  }

  async disconnect(): Promise<void> {
    this.disableOptimizations()
    this.screenShare.cleanupForDisconnect()

    this.peerSync.broadcastClose()
    this.peerSync.stop()

    this.retry.clearAll()
    this.connectingPeers.clear()

    for (const timer of this.iceBatchTimers.values()) clearTimeout(timer)
    this.iceBatchTimers.clear()
    this.pendingCandidates.clear()

    this.signaling.stop()
    this.peerManager.closeAll()
    await this.store.disconnect()

    this.setStatus('disconnected', 'Disconnected')
  }

  send(peerId: string, data: string | Uint8Array): boolean {
    return this.peerManager.send(peerId, data)
  }

  broadcast(data: string | Uint8Array): void {
    this.peerManager.broadcast(data)
  }

  private async handlePeerDiscovered(
    peerId: string,
    joinTime: number,
    username?: string
  ): Promise<void> {
    this.log(`Peer discovered: ${username || peerId} (joined at ${joinTime})`, 'info')

    if (this.peerManager.hasPeer(peerId) || this.connectingPeers.has(peerId)) return

    if (this.signaling.shouldOffer(peerId)) {
      this.log(`I am offerer for ${peerId} (I joined first)`, 'info')
      await this.initiateConnection(peerId)
    } else {
      this.log(`I am answerer for ${peerId} (they joined first)`, 'info')
    }
  }

  private async handleOfferReceived(from: string, sdp: string): Promise<void> {
    if (this.peerManager.isConnected(from)) return

    this.connectingPeers.add(from)

    try {
      const attempts = this.retry.getAttempts(from)
      const forceRelay = this.config.forceRelay || attempts >= 1
      await this.peerManager.handleOffer(from, sdp, this.localStream || undefined, forceRelay)
    } catch (error) {
      this.log(`Failed to handle offer from ${from}: ${error}`, 'error')
      this.connectingPeers.delete(from)
      this.retry.incrementAttempts(from)
    }
  }

  private async handleAnswerReceived(from: string, sdp: string): Promise<void> {
    try {
      await this.peerManager.handleAnswer(from, sdp)
    } catch (error) {
      this.log(`Failed to handle answer from ${from}: ${error}`, 'error')
      this.retry.scheduleRetry(from)
    }
  }

  private handlePeerConnect(peerId: string): void {
    this.connectingPeers.delete(peerId)
    this.retry.clearRetryState(peerId)
    this.config.onPeerConnect?.(peerId)
    this.screenShare.notifyNewPeer(peerId)
  }

  private handlePeerCloseMessage(peerId: string): void {
    this.log(`Received close signal from ${peerId}`, 'info')
    this.retry.clearRetryState(peerId)
    this.connectingPeers.delete(peerId)
    this.peerManager.closePeer(peerId)
    this.config.onPeerDisconnect?.(peerId)
    this.qualityManager?.unregisterPeer(peerId)
    this.meshHealth.removeReport(peerId)
    this.screenShare.handleSharerDisconnected(peerId)
  }

  private handlePeerClose(peerId: string): void {
    this.connectingPeers.delete(peerId)
    this.config.onPeerDisconnect?.(peerId)
    this.qualityManager?.unregisterPeer(peerId)
    this.screenShare.handleSharerDisconnected(peerId)

    const knownPeerIds = this.signaling.getKnownPeerIds()
    if (knownPeerIds.includes(peerId)) {
      this.retry.scheduleRetry(peerId)
    }
  }

  private handlePeerError(peerId: string, error: Error): void {
    this.log(`Peer error with ${peerId}: ${error.message}`, 'error')
    this.retry.scheduleRetry(peerId)
  }

  private handlePeerData(peerId: string, data: Uint8Array): void {
    try {
      const text = new TextDecoder().decode(data)
      const parsed = JSON.parse(text)

      if (isPeerCloseMessage(parsed)) {
        this.handlePeerCloseMessage(parsed.peerId)
        return
      }
      if (isPeerSyncMessage(parsed)) {
        this.peerSync.handleMessage(peerId, parsed)
        return
      }
      if (isScreenShareMessage(parsed)) {
        this.screenShare.handleMessage(peerId, parsed)
        return
      }
      if (parsed.type === '__renegotiation-offer__' || parsed.type === '__renegotiation-answer__') {
        this.handleRenegotiationMessage(peerId, parsed)
        return
      }
    } catch {
      // Not JSON - pass through
    }

    this.config.onData?.(peerId, data)
  }

  private handlePeerStream(peerId: string, stream: MediaStream): void {
    if (this.qualityManager) {
      const peer = this.peerManager.getPeer(peerId)
      if (peer) {
        const videoSender = peer.pc.getSenders().find((s) => s.track?.kind === 'video')
        if (videoSender) {
          this.qualityManager.registerPeer(peerId, stream, videoSender, peer.pc)
        }
      }
    }
    this.config.onStream?.(peerId, stream)
  }

  private async handleOfferReady(peerId: string, sdp: string): Promise<void> {
    await this.signaling.sendOffer(peerId, sdp)
  }

  private async handleAnswerReady(peerId: string, sdp: string): Promise<void> {
    const answerPromise = this.signaling.sendAnswer(peerId, sdp)
    this.pendingAnswers.set(peerId, answerPromise)
    try {
      await answerPromise
    } finally {
      this.pendingAnswers.delete(peerId)
    }
  }

  private handleIceCandidate(peerId: string, candidate: RTCIceCandidate): void {
    let batch = this.pendingCandidates.get(peerId)
    if (!batch) {
      batch = []
      this.pendingCandidates.set(peerId, batch)
    }
    batch.push({
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex
    })

    if (!this.iceBatchTimers.has(peerId)) {
      const timer = setTimeout(() => {
        this.iceBatchTimers.delete(peerId)
        this.flushIceCandidates(peerId)
      }, this.ICE_BATCH_INTERVAL)
      this.iceBatchTimers.set(peerId, timer)
    }
  }

  private async flushIceCandidates(peerId: string): Promise<void> {
    // Wait for any pending answer to be submitted first — answer and ICE share the same
    // statement store channel, so the answer must have a higher expiry than ICE candidates.
    const pending = this.pendingAnswers.get(peerId)
    if (pending) await pending

    const batch = this.pendingCandidates.get(peerId)
    if (!batch || batch.length === 0) return
    this.pendingCandidates.delete(peerId)
    await this.signaling.sendCandidates(peerId, batch)
  }

  private async handleIceCandidatesReceived(
    from: string,
    candidates: IceCandidateEntry[]
  ): Promise<void> {
    for (const { candidate, sdpMid, sdpMLineIndex } of candidates) {
      await this.peerManager.addIceCandidate(from, candidate, sdpMid, sdpMLineIndex)
    }
  }

  private async initiateConnection(peerId: string): Promise<void> {
    if (this.connectingPeers.has(peerId) || this.peerManager.hasPeer(peerId)) return

    this.connectingPeers.add(peerId)

    try {
      const attempts = this.retry.getAttempts(peerId)
      const forceRelay = this.config.forceRelay || attempts >= 1
      await this.peerManager.createOffer(peerId, this.localStream || undefined, forceRelay)
    } catch (error) {
      this.log(`Failed to create offer for ${peerId}: ${error}`, 'error')
      this.connectingPeers.delete(peerId)
      this.retry.scheduleRetry(peerId)
    }
  }

  private setStatus(status: ConnectionStatus, message?: string): void {
    this.status = status
    this.config.onStatus?.(status, message)
  }

  private log(message: string, type: LogFn extends (m: string, t: infer T) => void ? T : never): void {
    this.config.onLog?.(message, type)
  }

  private handleRenegotiationOfferReady(peerId: string, sdp: string): void {
    const message = { type: '__renegotiation-offer__', sdp, timestamp: Date.now() }
    const data = new TextEncoder().encode(JSON.stringify(message))
    this.peerManager.send(peerId, data)
  }

  private handleRenegotiationAnswerReady(peerId: string, sdp: string): void {
    const message = { type: '__renegotiation-answer__', sdp, timestamp: Date.now() }
    const data = new TextEncoder().encode(JSON.stringify(message))
    this.peerManager.send(peerId, data)
  }

  private async handleRenegotiationMessage(
    fromPeerId: string,
    parsed: { type: string; sdp: string }
  ): Promise<void> {
    if (parsed.type === '__renegotiation-offer__') {
      await this.peerManager.handleRenegotiationOffer(fromPeerId, parsed.sdp)
    } else if (parsed.type === '__renegotiation-answer__') {
      await this.peerManager.handleRenegotiationAnswer(fromPeerId, parsed.sdp)
    }
  }
}
