/**
 * SignalingManager: WebRTC signaling via statement store channels
 *
 * - No heartbeats: Presence written once with store-level expiry
 * - Older peer offers: Peer who joined first initiates connections
 * - Subscribe API: Real-time updates via statement store subscription
 */

import type { SDKTransportClient } from './sdk-client'
import type {
  ChannelValue,
  GossipPeerInfo,
  LogFn,
  OfferValue,
  AnswerValue,
  IceCandidateValue,
  IceCandidateEntry,
  PresenceValue
} from './types'
import { getHandshakeChannel, getPresenceChannel, isOfferer } from './types'

export interface SignalingEvents {
  onPeerDiscovered: (peerId: string, joinTime: number, username?: string) => void
  onOfferReceived: (from: string, sdp: string) => void
  onAnswerReceived: (from: string, sdp: string) => void
  onIceCandidatesReceived: (
    from: string,
    candidates: Array<{ candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }>
  ) => void
  onLog: LogFn
}

export interface SignalingConfig {
  store: SDKTransportClient
  documentId: string
  peerId: string
  username?: string
  events: SignalingEvents
}

export class SignalingManager {
  private store: SDKTransportClient
  private documentId: string
  private peerId: string
  private username?: string
  private events: SignalingEvents

  private joinTime = 0
  private knownPeers = new Map<string, PresenceValue>()
  private processedOffers = new Set<string>()
  private processedAnswers = new Set<string>()
  private unsubscribe: (() => void) | null = null

  constructor(config: SignalingConfig) {
    this.store = config.store
    this.documentId = config.documentId
    this.peerId = config.peerId
    this.username = config.username
    this.events = config.events
  }

  getJoinTime(): number {
    return this.joinTime
  }

  getKnownPeers(): Map<string, PresenceValue> {
    return new Map(this.knownPeers)
  }

  getKnownPeerIds(): string[] {
    return Array.from(this.knownPeers.keys())
  }

  shouldOffer(otherPeerId: string): boolean {
    const otherPresence = this.knownPeers.get(otherPeerId)
    if (!otherPresence) return false
    return isOfferer(this.joinTime, otherPresence.timestamp, this.peerId, otherPeerId)
  }

  hasPeer(peerId: string): boolean {
    return this.knownPeers.has(peerId)
  }

  addPeerFromGossip(peerInfo: GossipPeerInfo): boolean {
    if (peerInfo.peerId === this.peerId) return false

    const existingPresence = this.knownPeers.get(peerInfo.peerId)
    if (!existingPresence) {
      const presence: PresenceValue = {
        type: 'presence',
        peerId: peerInfo.peerId,
        timestamp: peerInfo.joinTime,
        username: peerInfo.username
      }
      this.knownPeers.set(peerInfo.peerId, presence)
      this.events.onLog(
        `Discovered peer via gossip: ${peerInfo.username || peerInfo.peerId}`,
        'success'
      )
      return true
    } else if (peerInfo.joinTime !== existingPresence.timestamp) {
      const presence: PresenceValue = {
        type: 'presence',
        peerId: peerInfo.peerId,
        timestamp: peerInfo.joinTime,
        username: peerInfo.username
      }
      this.knownPeers.set(peerInfo.peerId, presence)
      this.clearProcessedForPeer(peerInfo.peerId)
      this.events.onLog(
        `Peer reconnected (via gossip): ${peerInfo.username || peerInfo.peerId}`,
        'info'
      )
      return true
    }
    return false
  }

  async republishPresence(): Promise<boolean> {
    this.events.onLog('Republishing presence for peer discovery', 'info')
    return this.publishPresence()
  }

  async start(): Promise<void> {
    this.joinTime = Date.now()
    await this.publishPresence()

    this.unsubscribe = this.store.onStatement((value: ChannelValue) => {
      this.handleStatement(value)
    })

    await this.processExistingStatements()
    this.events.onLog('Signaling manager started (subscribe mode)', 'success')
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    this.knownPeers.clear()
    this.processedOffers.clear()
    this.processedAnswers.clear()
    this.events.onLog('Signaling manager stopped', 'info')
  }

  async sendOffer(to: string, sdp: string): Promise<boolean> {
    const otherPresence = this.knownPeers.get(to)
    if (!otherPresence) {
      this.events.onLog(`Cannot send offer to ${to}: peer not known`, 'error')
      return false
    }
    if (!this.shouldOffer(to)) {
      this.events.onLog(`Cannot send offer to ${to}: we are not the offerer`, 'error')
      return false
    }

    const channel = getHandshakeChannel(this.documentId, this.peerId, to)
    const value: OfferValue = {
      type: 'offer',
      from: this.peerId,
      to,
      sdp,
      timestamp: Date.now()
    }
    this.events.onLog(`Sending offer to ${to}`, 'blockchain')
    return this.store.write(channel, value)
  }

  async sendAnswer(to: string, sdp: string): Promise<boolean> {
    if (this.shouldOffer(to)) {
      this.events.onLog(`Cannot send answer to ${to}: we are not the answerer`, 'error')
      return false
    }

    const channel = getHandshakeChannel(this.documentId, this.peerId, to)
    const value: AnswerValue = {
      type: 'answer',
      from: this.peerId,
      to,
      sdp,
      timestamp: Date.now()
    }
    this.events.onLog(`Sending answer to ${to}`, 'blockchain')
    return this.store.write(channel, value)
  }

  async sendCandidates(
    to: string,
    candidates: IceCandidateEntry[]
  ): Promise<boolean> {
    if (candidates.length === 0) return true
    const channel = getHandshakeChannel(this.documentId, this.peerId, to)
    const value: IceCandidateValue = {
      type: 'ice-candidate',
      from: this.peerId,
      to,
      candidates,
      timestamp: Date.now()
    }
    return this.store.write(channel, value)
  }

  private async publishPresence(): Promise<boolean> {
    const channel = getPresenceChannel(this.documentId, this.peerId)
    const value: PresenceValue = {
      type: 'presence',
      peerId: this.peerId,
      timestamp: this.joinTime,
      username: this.username
    }

    try {
      const result = await this.store.write(channel, value)
      if (result) {
        this.events.onLog('Published presence', 'blockchain')
      }
      return result
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      this.events.onLog(`Presence write error: ${msg}`, 'error')
      return false
    }
  }

  private async processExistingStatements(): Promise<void> {
    const presences = await this.store.readPresences()
    for (const [, value] of presences) {
      if (value.type === 'presence') {
        this.handlePresence(value)
      }
    }

    const handshakes = await this.store.readHandshakes()
    for (const [, value] of handshakes) {
      if (value.type === 'offer' || value.type === 'answer') {
        this.handleHandshake(value)
      }
    }
  }

  private handleStatement(value: ChannelValue): void {
    if (value.type === 'presence') {
      this.handlePresence(value)
    } else if (value.type === 'offer' || value.type === 'answer') {
      this.handleHandshake(value)
    } else if (value.type === 'ice-candidate') {
      this.handleIceCandidate(value)
    }
  }

  private handleIceCandidate(value: IceCandidateValue): void {
    if (value.to !== this.peerId) return
    this.events.onIceCandidatesReceived(value.from, value.candidates)
  }

  private handlePresence(presence: PresenceValue): void {
    if (presence.peerId === this.peerId) return

    const existingPresence = this.knownPeers.get(presence.peerId)
    if (!existingPresence) {
      this.knownPeers.set(presence.peerId, presence)
      this.events.onLog(`Discovered peer: ${presence.username || presence.peerId}`, 'success')
      this.events.onPeerDiscovered(presence.peerId, presence.timestamp, presence.username)
    } else if (presence.timestamp !== existingPresence.timestamp) {
      this.knownPeers.set(presence.peerId, presence)
      this.clearProcessedForPeer(presence.peerId)
      this.events.onLog(`Peer reconnected: ${presence.username || presence.peerId}`, 'info')
      this.events.onPeerDiscovered(presence.peerId, presence.timestamp, presence.username)
    }
  }

  private handleHandshake(value: OfferValue | AnswerValue): void {
    if (value.type === 'offer') {
      this.handleOffer(value)
    } else {
      this.handleAnswer(value)
    }
  }

  private handleOffer(offer: OfferValue): void {
    if (offer.to !== this.peerId) return

    const processKey = `offer:${offer.from}:${offer.timestamp}`
    if (this.processedOffers.has(processKey)) return

    const senderPresence = this.knownPeers.get(offer.from)
    if (
      senderPresence &&
      !isOfferer(senderPresence.timestamp, this.joinTime, offer.from, this.peerId)
    ) {
      this.events.onLog(
        `Ignoring invalid offer from ${offer.from}: they should not be offerer`,
        'warning'
      )
      return
    }

    this.processedOffers.add(processKey)
    this.events.onLog(`Received offer from ${offer.from}`, 'blockchain')
    this.events.onOfferReceived(offer.from, offer.sdp)
  }

  private handleAnswer(answer: AnswerValue): void {
    if (answer.to !== this.peerId) return

    const processKey = `answer:${answer.from}:${answer.timestamp}`
    if (this.processedAnswers.has(processKey)) return

    const senderPresence = this.knownPeers.get(answer.from)
    if (
      senderPresence &&
      !isOfferer(this.joinTime, senderPresence.timestamp, this.peerId, answer.from)
    ) {
      this.events.onLog(
        `Ignoring invalid answer from ${answer.from}: we should not be offerer`,
        'warning'
      )
      return
    }

    this.processedAnswers.add(processKey)
    this.events.onLog(`Received answer from ${answer.from}`, 'blockchain')
    this.events.onAnswerReceived(answer.from, answer.sdp)
  }

  private clearProcessedForPeer(peerId: string): void {
    const toRemove: string[] = []
    for (const key of this.processedOffers) {
      if (key.startsWith(`offer:${peerId}:`)) toRemove.push(key)
    }
    for (const key of toRemove) this.processedOffers.delete(key)

    toRemove.length = 0
    for (const key of this.processedAnswers) {
      if (key.startsWith(`answer:${peerId}:`)) toRemove.push(key)
    }
    for (const key of toRemove) this.processedAnswers.delete(key)
  }
}
