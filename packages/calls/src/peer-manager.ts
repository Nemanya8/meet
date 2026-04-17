/**
 * PeerManager: WebRTC peer connection management with trickle ICE
 *
 * Implements WebRTC connections where ICE candidates are sent incrementally
 * as they are discovered. Supports data channels and media streams for video conferencing.
 */

import type { TurnCredentials } from './turn-credentials'
import type { LogFn } from './types'

export interface PeerManagerEvents {
  onConnect: (peerId: string) => void
  onClose: (peerId: string) => void
  onError: (peerId: string, error: Error) => void
  onData: (peerId: string, data: Uint8Array) => void
  onStream: (peerId: string, stream: MediaStream) => void
  onScreenShare: (peerId: string, stream: MediaStream | null) => void
  onOfferReady: (peerId: string, sdp: string) => void
  onAnswerReady: (peerId: string, sdp: string) => void
  onIceCandidate: (peerId: string, candidate: RTCIceCandidate) => void
  onRenegotiationOffer: (peerId: string, sdp: string) => void
  onRenegotiationAnswer: (peerId: string, sdp: string) => void
  onLog: LogFn
}

interface BufferedCandidate {
  candidate: string
  sdpMid: string | null
  sdpMLineIndex: number | null
}

interface PeerConnection {
  pc: RTCPeerConnection
  dc: RTCDataChannel | null
  role: 'offerer' | 'answerer'
  connected: boolean
  createdAt: number
  remoteDescriptionSet: boolean
  pendingCandidates: BufferedCandidate[]
  localStream?: MediaStream
  hasInitialStream: boolean
  initialStreamId?: string
  screenShareVideoSender?: RTCRtpSender
  screenShareStream?: MediaStream
  disconnectTimer?: ReturnType<typeof setTimeout>
}

export class PeerManager {
  private turnCredentials: TurnCredentials
  private events: PeerManagerEvents
  private peers = new Map<string, PeerConnection>()
  private placeholderStream: MediaStream | null = null
  private placeholderCanvas: HTMLCanvasElement | null = null

  constructor(turnCredentials: TurnCredentials, events: PeerManagerEvents) {
    this.turnCredentials = turnCredentials
    this.events = events
  }

  private getPlaceholderStream(): MediaStream {
    if (this.placeholderStream) return this.placeholderStream

    const canvas = document.createElement('canvas')
    canvas.width = 2
    canvas.height = 2
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.fillStyle = 'black'
      ctx.fillRect(0, 0, 2, 2)
    }
    const stream = canvas.captureStream(1)
    this.placeholderCanvas = canvas
    this.placeholderStream = stream
    return stream
  }

  private addScreenShareSlot(pc: RTCPeerConnection): RTCRtpSender | undefined {
    const placeholderStream = this.getPlaceholderStream()
    const videoTrack = placeholderStream.getVideoTracks()[0]
    if (!videoTrack) return undefined
    return pc.addTrack(videoTrack, placeholderStream)
  }

  getConnectedPeers(): string[] {
    const connected: string[] = []
    for (const [peerId, conn] of this.peers) {
      if (conn.connected) connected.push(peerId)
    }
    return connected
  }

  hasPeer(peerId: string): boolean {
    return this.peers.has(peerId)
  }

  isConnected(peerId: string): boolean {
    return this.peers.get(peerId)?.connected ?? false
  }

  getPeer(peerId: string): PeerConnection | undefined {
    return this.peers.get(peerId)
  }

  getScreenShareStream(peerId: string): MediaStream | undefined {
    return this.peers.get(peerId)?.screenShareStream
  }

  async createOffer(
    peerId: string,
    localStream?: MediaStream,
    forceRelay = false
  ): Promise<void> {
    if (this.peers.has(peerId)) {
      this.events.onLog(`Connection to ${peerId} already exists`, 'warning')
      return
    }

    const iceServers = this.turnCredentials.getIceServers(forceRelay)
    const pc = new RTCPeerConnection({
      iceServers,
      iceCandidatePoolSize: 10,
      ...(forceRelay && { iceTransportPolicy: 'relay' as const })
    })

    if (localStream) {
      localStream.getTracks().forEach((track) => {
        pc.addTrack(track, localStream)
      })
    }

    const screenShareSender = this.addScreenShareSlot(pc)

    const dc = pc.createDataChannel('data', { ordered: true })

    const conn: PeerConnection = {
      pc,
      dc,
      role: 'offerer',
      connected: false,
      createdAt: Date.now(),
      remoteDescriptionSet: false,
      pendingCandidates: [],
      localStream,
      hasInitialStream: false,
      screenShareVideoSender: screenShareSender
    }
    this.peers.set(peerId, conn)
    this.setupPeerConnectionEvents(peerId, pc)
    this.setupDataChannelEvents(peerId, dc)

    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      this.events.onLog(`Offer ready for ${peerId} (trickle ICE)`, 'success')
      this.events.onOfferReady(peerId, pc.localDescription!.sdp)
    } catch (error) {
      this.events.onLog(`Failed to create offer for ${peerId}: ${error}`, 'error')
      this.cleanupPeer(peerId)
      throw error
    }
  }

  async handleOffer(
    peerId: string,
    offerSdp: string,
    localStream?: MediaStream,
    forceRelay = false
  ): Promise<void> {
    if (this.peers.has(peerId)) {
      const existing = this.peers.get(peerId)!
      if (existing.connected) {
        this.events.onLog(`Already connected to ${peerId}, ignoring offer`, 'info')
        return
      }
      this.cleanupPeer(peerId)
    }

    const iceServers = this.turnCredentials.getIceServers(forceRelay)
    const pc = new RTCPeerConnection({
      iceServers,
      iceCandidatePoolSize: 10,
      ...(forceRelay && { iceTransportPolicy: 'relay' as const })
    })

    if (localStream) {
      localStream.getTracks().forEach((track) => {
        pc.addTrack(track, localStream)
      })
    }

    const screenShareSender = this.addScreenShareSlot(pc)

    const conn: PeerConnection = {
      pc,
      dc: null,
      role: 'answerer',
      connected: false,
      createdAt: Date.now(),
      remoteDescriptionSet: false,
      pendingCandidates: [],
      localStream,
      hasInitialStream: false,
      screenShareVideoSender: screenShareSender
    }
    this.peers.set(peerId, conn)
    this.setupPeerConnectionEvents(peerId, pc)

    pc.ondatachannel = (event) => {
      const dc = event.channel
      conn.dc = dc
      this.setupDataChannelEvents(peerId, dc)
    }

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp })
      conn.remoteDescriptionSet = true
      await this.drainPendingCandidates(peerId)
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      this.events.onLog(`Answer ready for ${peerId} (trickle ICE)`, 'success')
      this.events.onAnswerReady(peerId, pc.localDescription!.sdp)
    } catch (error) {
      this.events.onLog(`Failed to handle offer from ${peerId}: ${error}`, 'error')
      this.cleanupPeer(peerId)
      throw error
    }
  }

  async handleAnswer(peerId: string, answerSdp: string): Promise<void> {
    const conn = this.peers.get(peerId)
    if (!conn) {
      this.events.onLog(`No pending connection for ${peerId}, ignoring answer`, 'warning')
      return
    }
    if (conn.role !== 'offerer') {
      this.events.onLog(`Received answer but we are not the offerer for ${peerId}`, 'warning')
      return
    }
    if (conn.pc.signalingState !== 'have-local-offer') {
      this.events.onLog(
        `Ignoring answer from ${peerId}: wrong signaling state (${conn.pc.signalingState})`,
        'warning'
      )
      return
    }

    try {
      await conn.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
      conn.remoteDescriptionSet = true
      await this.drainPendingCandidates(peerId)
    } catch (error) {
      this.events.onLog(`Failed to handle answer from ${peerId}: ${error}`, 'error')
      this.cleanupPeer(peerId)
      throw error
    }
  }

  send(peerId: string, data: string | Uint8Array): boolean {
    const conn = this.peers.get(peerId)
    if (!conn || !conn.dc || conn.dc.readyState !== 'open') return false

    try {
      if (typeof data === 'string') {
        conn.dc.send(data)
      } else {
        const buffer = new ArrayBuffer(data.length)
        new Uint8Array(buffer).set(data)
        conn.dc.send(buffer)
      }
      return true
    } catch (error) {
      this.events.onLog(`Failed to send data to ${peerId}: ${error}`, 'error')
      return false
    }
  }

  broadcast(data: string | Uint8Array): void {
    let buffer: ArrayBuffer | null = null
    if (typeof data !== 'string') {
      buffer = new ArrayBuffer(data.length)
      new Uint8Array(buffer).set(data)
    }

    for (const [, conn] of this.peers) {
      if (conn.connected && conn.dc?.readyState === 'open') {
        try {
          if (typeof data === 'string') {
            conn.dc.send(data)
          } else {
            conn.dc.send(buffer!)
          }
        } catch {
          // Ignore errors on broadcast
        }
      }
    }
  }

  closePeer(peerId: string): void {
    this.cleanupPeer(peerId)
  }

  closeAll(): void {
    for (const peerId of this.peers.keys()) {
      this.cleanupPeer(peerId)
    }
  }

  async addScreenShareTracks(screenStream: MediaStream): Promise<boolean> {
    let replacedAny = false
    const videoTrack = screenStream.getVideoTracks()[0]
    if (!videoTrack) return false

    for (const [peerId, conn] of this.peers) {
      if (!conn.connected || !conn.screenShareVideoSender) continue
      try {
        await conn.screenShareVideoSender.replaceTrack(videoTrack)
        this.events.onLog(`Replaced screen share track for ${peerId}`, 'success')
        replacedAny = true
      } catch (error) {
        this.events.onLog(`Failed to replace screen share track for ${peerId}: ${error}`, 'error')
      }
    }
    return replacedAny
  }

  async removeScreenShareTracks(): Promise<void> {
    const placeholderStream = this.getPlaceholderStream()
    const placeholderTrack = placeholderStream.getVideoTracks()[0]
    if (!placeholderTrack) return

    for (const [peerId, conn] of this.peers) {
      if (!conn.screenShareVideoSender) continue
      try {
        await conn.screenShareVideoSender.replaceTrack(placeholderTrack)
        this.events.onLog(`Restored placeholder track for ${peerId}`, 'info')
      } catch (error) {
        this.events.onLog(`Failed to restore placeholder for ${peerId}: ${error}`, 'error')
      }
    }
  }

  async addScreenShareTracksToPeer(
    peerId: string,
    screenStream: MediaStream
  ): Promise<boolean> {
    const conn = this.peers.get(peerId)
    if (!conn || !conn.connected || !conn.screenShareVideoSender) return false

    const videoTrack = screenStream.getVideoTracks()[0]
    if (!videoTrack) return false

    try {
      await conn.screenShareVideoSender.replaceTrack(videoTrack)
      this.events.onLog(`Replaced screen share track for late joiner ${peerId}`, 'success')
      return true
    } catch (error) {
      this.events.onLog(`Failed to replace screen share track for ${peerId}: ${error}`, 'error')
      return false
    }
  }

  async addIceCandidate(
    peerId: string,
    candidate: string,
    sdpMid: string | null,
    sdpMLineIndex: number | null
  ): Promise<void> {
    const conn = this.peers.get(peerId)
    if (!conn) return

    if (!conn.remoteDescriptionSet) {
      conn.pendingCandidates.push({ candidate, sdpMid, sdpMLineIndex })
      return
    }

    try {
      await conn.pc.addIceCandidate(
        new RTCIceCandidate({ candidate, sdpMid, sdpMLineIndex })
      )
    } catch (error) {
      this.events.onLog(`Failed to add ICE candidate from ${peerId}: ${error}`, 'warning')
    }
  }

  private async drainPendingCandidates(peerId: string): Promise<void> {
    const conn = this.peers.get(peerId)
    if (!conn) return

    const candidates = conn.pendingCandidates.splice(0)
    for (const { candidate, sdpMid, sdpMLineIndex } of candidates) {
      try {
        await conn.pc.addIceCandidate(
          new RTCIceCandidate({ candidate, sdpMid, sdpMLineIndex })
        )
      } catch (error) {
        this.events.onLog(`Failed to add buffered ICE candidate from ${peerId}: ${error}`, 'warning')
      }
    }

    if (candidates.length > 0) {
      this.events.onLog(`Drained ${candidates.length} buffered ICE candidates for ${peerId}`, 'info')
    }
  }

  async handleRenegotiationOffer(peerId: string, offerSdp: string): Promise<void> {
    const conn = this.peers.get(peerId)
    if (!conn || !conn.connected) return

    try {
      await conn.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp })
      const answer = await conn.pc.createAnswer()
      await conn.pc.setLocalDescription(answer)
      await new Promise((resolve) => setTimeout(resolve, 100))
      const sdp = conn.pc.localDescription?.sdp
      if (!sdp) throw new Error('No local description after setLocalDescription')
      this.events.onRenegotiationAnswer(peerId, sdp)
    } catch (error) {
      this.events.onLog(
        `Failed to handle renegotiation offer from ${peerId}: ${error}`,
        'error'
      )
    }
  }

  async handleRenegotiationAnswer(peerId: string, answerSdp: string): Promise<void> {
    const conn = this.peers.get(peerId)
    if (!conn) return

    try {
      await conn.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
    } catch (error) {
      this.events.onLog(
        `Failed to handle renegotiation answer from ${peerId}: ${error}`,
        'error'
      )
    }
  }

  private setupPeerConnectionEvents(peerId: string, pc: RTCPeerConnection): void {
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.events.onIceCandidate(peerId, event.candidate)
      }
    }

    pc.ontrack = (event) => {
      const conn = this.peers.get(peerId)
      if (!conn) return

      const stream = event.streams?.[0] || new MediaStream([event.track])
      const streamId = stream.id

      if (!conn.hasInitialStream) {
        conn.hasInitialStream = true
        conn.initialStreamId = streamId
        this.events.onStream(peerId, stream)
      } else if (streamId === conn.initialStreamId) {
        this.events.onStream(peerId, stream)
      } else {
        conn.screenShareStream = stream
      }
    }

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState
      const conn = this.peers.get(peerId)
      if (!conn) return

      if (state === 'connected' || state === 'completed') {
        if (conn.disconnectTimer) {
          clearTimeout(conn.disconnectTimer)
          conn.disconnectTimer = undefined
        }
        if (!conn.connected) {
          conn.connected = true
          this.events.onConnect(peerId)
        }
      } else if (state === 'disconnected') {
        if (!conn.disconnectTimer) {
          conn.disconnectTimer = setTimeout(() => {
            this.handleConnectionFailure(peerId, 'disconnected-timeout')
          }, 5000)
        }
      } else if (state === 'failed' || state === 'closed') {
        if (conn.disconnectTimer) {
          clearTimeout(conn.disconnectTimer)
          conn.disconnectTimer = undefined
        }
        this.handleConnectionFailure(peerId, state)
      }
    }

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      const conn = this.peers.get(peerId)
      if (!conn) return

      if (state === 'connected') {
        if (conn.disconnectTimer) {
          clearTimeout(conn.disconnectTimer)
          conn.disconnectTimer = undefined
        }
        if (!conn.connected) {
          conn.connected = true
          this.events.onConnect(peerId)
        }
      } else if (state === 'failed' || state === 'closed') {
        if (conn.disconnectTimer) return
        if (conn.connected) {
          conn.disconnectTimer = setTimeout(() => {
            this.handleConnectionFailure(peerId, `${state}-timeout`)
          }, 5000)
        } else {
          this.handleConnectionFailure(peerId, state)
        }
      }
    }
  }

  private setupDataChannelEvents(peerId: string, dc: RTCDataChannel): void {
    dc.binaryType = 'arraybuffer'

    dc.onopen = () => {
      const conn = this.peers.get(peerId)
      if (conn && !conn.connected) {
        conn.connected = true
        this.events.onConnect(peerId)
      }
    }

    dc.onclose = () => {
      const conn = this.peers.get(peerId)
      if (conn?.disconnectTimer) return
      this.handleConnectionFailure(peerId, 'datachannel-closed')
    }

    dc.onerror = () => {
      this.events.onError(peerId, new Error('DataChannel error'))
    }

    dc.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.events.onData(peerId, new Uint8Array(event.data))
      } else if (typeof event.data === 'string') {
        this.events.onData(peerId, new TextEncoder().encode(event.data))
      }
    }
  }

  private handleConnectionFailure(peerId: string, reason: string): void {
    const conn = this.peers.get(peerId)
    if (!conn) return

    this.events.onLog(`Connection failure for ${peerId}: ${reason}`, 'warning')
    const wasConnected = conn.connected
    this.cleanupPeer(peerId)
    if (wasConnected) {
      this.events.onClose(peerId)
    }
  }

  private cleanupPeer(peerId: string): void {
    const conn = this.peers.get(peerId)
    if (!conn) return

    if (conn.disconnectTimer) {
      clearTimeout(conn.disconnectTimer)
      conn.disconnectTimer = undefined
    }

    try {
      if (conn.dc) conn.dc.close()
      conn.pc.close()
    } catch {
      // Ignore errors during cleanup
    }

    this.peers.delete(peerId)
  }
}
