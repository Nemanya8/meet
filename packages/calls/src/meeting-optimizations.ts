/**
 * MeetingOptimizations: Bandwidth and quality optimizations for meeting mode
 *
 * - Active speaker detection using audio levels
 * - Video pause for hidden/background participants
 * - Adaptive bitrate with resolution fallback
 * - Simulcast encoding (3 quality layers)
 * - Last-N video streams
 * - Quality tier management
 */

import type { LogFn } from './types'

// ============================================================================
// Active Speaker Detection
// ============================================================================

export class ActiveSpeakerDetector {
  private config: { speakingThreshold: number; silenceDelay: number; checkInterval: number }
  private audioContexts = new Map<
    string,
    { context: AudioContext; analyser: AnalyserNode; source: MediaStreamAudioSourceNode; dataArray: Uint8Array<ArrayBuffer> }
  >()
  private speakingState = new Map<string, { isSpeaking: boolean; lastSpokeAt: number }>()
  private checkIntervalId: ReturnType<typeof setInterval> | null = null
  private onSpeakerChange?: (speakers: string[]) => void
  private onLog: LogFn

  constructor(config: Partial<{ speakingThreshold: number; silenceDelay: number; checkInterval: number }> = {}, onLog: LogFn) {
    this.config = { speakingThreshold: 30, silenceDelay: 1500, checkInterval: 100, ...config }
    this.onLog = onLog
  }

  addStream(peerId: string, stream: MediaStream): void {
    this.removeStream(peerId)
    const audioTracks = stream.getAudioTracks()
    if (audioTracks.length === 0) return

    try {
      const context = new AudioContext()
      const analyser = context.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.5
      const source = context.createMediaStreamSource(stream)
      source.connect(analyser)
      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      this.audioContexts.set(peerId, { context, analyser, source, dataArray })
      this.speakingState.set(peerId, { isSpeaking: false, lastSpokeAt: 0 })
    } catch (error) {
      this.onLog(`Failed to setup audio detection for ${peerId}: ${error}`, 'error')
    }
  }

  removeStream(peerId: string): void {
    const ctx = this.audioContexts.get(peerId)
    if (ctx) {
      ctx.source.disconnect()
      ctx.context.close().catch(() => {})
      this.audioContexts.delete(peerId)
      this.speakingState.delete(peerId)
    }
  }

  start(onSpeakerChange: (speakers: string[]) => void): void {
    this.onSpeakerChange = onSpeakerChange
    if (this.checkIntervalId) return
    this.checkIntervalId = setInterval(() => this.checkAudioLevels(), this.config.checkInterval)
  }

  stop(): void {
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId)
      this.checkIntervalId = null
    }
    for (const peerId of this.audioContexts.keys()) this.removeStream(peerId)
  }

  getActiveSpeakers(): string[] {
    const now = Date.now()
    return Array.from(this.speakingState.entries())
      .filter(([, state]) => state.isSpeaking || now - state.lastSpokeAt < this.config.silenceDelay)
      .sort((a, b) => b[1].lastSpokeAt - a[1].lastSpokeAt)
      .map(([peerId]) => peerId)
  }

  private checkAudioLevels(): void {
    const now = Date.now()
    let changed = false

    for (const [peerId, ctx] of this.audioContexts) {
      ctx.analyser.getByteFrequencyData(ctx.dataArray)
      const sum = ctx.dataArray.reduce((a, b) => a + b, 0)
      const average = sum / ctx.dataArray.length
      const state = this.speakingState.get(peerId)
      if (!state) continue

      const wasSpeaking = state.isSpeaking
      if (average > this.config.speakingThreshold) {
        state.isSpeaking = true
        state.lastSpokeAt = now
      } else if (now - state.lastSpokeAt > this.config.silenceDelay) {
        state.isSpeaking = false
      }
      if (wasSpeaking !== state.isSpeaking) changed = true
    }

    if (changed && this.onSpeakerChange) {
      this.onSpeakerChange(this.getActiveSpeakers())
    }
  }
}

// ============================================================================
// Video Visibility Manager
// ============================================================================

export class VideoVisibilityManager {
  private visibilityState = new Map<string, boolean>()
  private senders = new Map<string, RTCRtpSender>()
  private onVisibilityChange?: (peerId: string, enabled: boolean) => void
  private documentHidden = false
  private onLog: LogFn

  constructor(onLog: LogFn) {
    this.onLog = onLog
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        this.documentHidden = document.hidden
        for (const peerId of this.visibilityState.keys()) this.updateVideoState(peerId)
      })
    }
  }

  registerSender(peerId: string, sender: RTCRtpSender): void {
    this.senders.set(peerId, sender)
    this.visibilityState.set(peerId, true)
  }

  unregister(peerId: string): void {
    this.senders.delete(peerId)
    this.visibilityState.delete(peerId)
  }

  setVisible(peerId: string, visible: boolean): void {
    const wasVisible = this.visibilityState.get(peerId)
    this.visibilityState.set(peerId, visible)
    if (wasVisible !== visible) this.updateVideoState(peerId)
  }

  private updateVideoState(peerId: string): void {
    const sender = this.senders.get(peerId)
    if (!sender?.track) return
    const peerVisible = this.visibilityState.get(peerId) ?? true
    const shouldBeEnabled = peerVisible && !this.documentHidden
    if (sender.track.enabled !== shouldBeEnabled) {
      sender.track.enabled = shouldBeEnabled
      this.onVisibilityChange?.(peerId, shouldBeEnabled)
    }
  }
}

// ============================================================================
// Adaptive Bitrate Controller
// ============================================================================

export class AdaptiveBitrateController {
  private config: { maxBitrate: number; minBitrate: number; rttThreshold: number; packetLossThreshold: number }
  private senders = new Map<string, RTCRtpSender>()
  private peerConnections = new Map<string, RTCPeerConnection>()
  private currentBitrates = new Map<string, number>()
  private monitorIntervalId: ReturnType<typeof setInterval> | null = null
  private onLog: LogFn

  constructor(config: Partial<{ maxBitrate: number; minBitrate: number; rttThreshold: number; packetLossThreshold: number }> = {}, onLog: LogFn) {
    this.config = { maxBitrate: 1500000, minBitrate: 150000, rttThreshold: 150, packetLossThreshold: 5, ...config }
    this.onLog = onLog
  }

  register(peerId: string, sender: RTCRtpSender, pc: RTCPeerConnection): void {
    this.senders.set(peerId, sender)
    this.peerConnections.set(peerId, pc)
    this.currentBitrates.set(peerId, this.config.maxBitrate)
    this.setBitrate(peerId, this.config.maxBitrate)
  }

  unregister(peerId: string): void {
    this.senders.delete(peerId)
    this.peerConnections.delete(peerId)
    this.currentBitrates.delete(peerId)
  }

  startMonitoring(intervalMs = 2000): void {
    if (this.monitorIntervalId) return
    this.monitorIntervalId = setInterval(() => this.checkAllConnections(), intervalMs)
  }

  stopMonitoring(): void {
    if (this.monitorIntervalId) {
      clearInterval(this.monitorIntervalId)
      this.monitorIntervalId = null
    }
  }

  private async setBitrate(peerId: string, bitrate: number): Promise<void> {
    const sender = this.senders.get(peerId)
    if (!sender) return
    const clamped = Math.max(this.config.minBitrate, Math.min(this.config.maxBitrate, bitrate))
    try {
      const params = sender.getParameters()
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
      params.encodings[0].maxBitrate = clamped
      await sender.setParameters(params)
      this.currentBitrates.set(peerId, clamped)
    } catch (error) {
      this.onLog(`Failed to set bitrate for ${peerId}: ${error}`, 'error')
    }
  }

  private async checkAllConnections(): Promise<void> {
    for (const [peerId, pc] of this.peerConnections) {
      await this.checkConnection(peerId, pc)
    }
  }

  private async checkConnection(peerId: string, pc: RTCPeerConnection): Promise<void> {
    try {
      const stats = await pc.getStats()
      let rtt = 0
      let packetLoss = 0

      stats.forEach((report) => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          rtt = (report.currentRoundTripTime ?? 0) * 1000
        }
        if (report.type === 'outbound-rtp' && report.kind === 'video') {
          const packetsLost = report.packetsLost ?? 0
          const packetsSent = report.packetsSent ?? 1
          packetLoss = (packetsLost / (packetsSent + packetsLost)) * 100
        }
      })

      const currentBitrate = this.currentBitrates.get(peerId) ?? this.config.maxBitrate
      let newBitrate = currentBitrate

      if (rtt > this.config.rttThreshold || packetLoss > this.config.packetLossThreshold) {
        newBitrate = Math.max(this.config.minBitrate, currentBitrate * 0.8)
      } else if (rtt < this.config.rttThreshold * 0.5 && packetLoss < this.config.packetLossThreshold * 0.5) {
        newBitrate = Math.min(this.config.maxBitrate, currentBitrate * 1.1)
      }

      if (Math.abs(newBitrate - currentBitrate) > 50000) {
        await this.setBitrate(peerId, newBitrate)
      }
    } catch {
      // Ignore stats errors
    }
  }
}

// ============================================================================
// Simulcast Manager
// ============================================================================

export class SimulcastManager {
  private config: {
    enabled: boolean
    high: { maxBitrate: number; scaleResolutionDownBy: number }
    medium: { maxBitrate: number; scaleResolutionDownBy: number }
    low: { maxBitrate: number; scaleResolutionDownBy: number }
  }
  private onLog: LogFn

  constructor(config: Partial<SimulcastManager['config']> = {}, onLog: LogFn) {
    this.config = {
      enabled: true,
      high: { maxBitrate: 1500000, scaleResolutionDownBy: 1 },
      medium: { maxBitrate: 500000, scaleResolutionDownBy: 2 },
      low: { maxBitrate: 150000, scaleResolutionDownBy: 4 },
      ...config
    }
    this.onLog = onLog
  }

  async enableSimulcast(sender: RTCRtpSender): Promise<boolean> {
    if (!this.config.enabled) return false
    try {
      const params = sender.getParameters()
      params.encodings = [
        { rid: 'h', maxBitrate: this.config.high.maxBitrate, scaleResolutionDownBy: this.config.high.scaleResolutionDownBy, maxFramerate: 30 },
        { rid: 'm', maxBitrate: this.config.medium.maxBitrate, scaleResolutionDownBy: this.config.medium.scaleResolutionDownBy, maxFramerate: 20 },
        { rid: 'l', maxBitrate: this.config.low.maxBitrate, scaleResolutionDownBy: this.config.low.scaleResolutionDownBy, maxFramerate: 15 }
      ]
      await sender.setParameters(params)
      return true
    } catch (error) {
      this.onLog(`Failed to enable simulcast: ${error}`, 'error')
      return false
    }
  }
}

// ============================================================================
// Last-N Video Manager
// ============================================================================

export class LastNVideoManager {
  private config: { maxVideoStreams: number; pinnedPeers: string[]; recentSpeakerWindow: number }
  private recentSpeakers = new Map<string, number>()
  private videoEnabled = new Map<string, boolean>()
  private onVideoStateChange?: (peerId: string, enabled: boolean) => void
  private onLog: LogFn

  constructor(config: Partial<LastNVideoManager['config']> = {}, onLog: LogFn) {
    this.config = { maxVideoStreams: 4, pinnedPeers: [], recentSpeakerWindow: 10000, ...config }
    this.onLog = onLog
  }

  onPeerSpoke(peerId: string): void {
    this.recentSpeakers.set(peerId, Date.now())
    this.recalculateVideoStates()
  }

  pinPeer(peerId: string): void {
    if (!this.config.pinnedPeers.includes(peerId)) {
      this.config.pinnedPeers.push(peerId)
      this.recalculateVideoStates()
    }
  }

  unpinPeer(peerId: string): void {
    this.config.pinnedPeers = this.config.pinnedPeers.filter((id) => id !== peerId)
    this.recalculateVideoStates()
  }

  addPeer(peerId: string): void {
    this.videoEnabled.set(peerId, true)
    this.recalculateVideoStates()
  }

  removePeer(peerId: string): void {
    this.recentSpeakers.delete(peerId)
    this.videoEnabled.delete(peerId)
  }

  onStateChange(callback: (peerId: string, enabled: boolean) => void): void {
    this.onVideoStateChange = callback
  }

  isVideoEnabled(peerId: string): boolean {
    return this.videoEnabled.get(peerId) ?? false
  }

  private recalculateVideoStates(): void {
    const now = Date.now()
    const allPeers = Array.from(this.videoEnabled.keys())
    const prioritized = allPeers
      .map((peerId) => ({
        peerId,
        isPinned: this.config.pinnedPeers.includes(peerId),
        lastSpokeAt: this.recentSpeakers.get(peerId) ?? 0,
        isRecentSpeaker: now - (this.recentSpeakers.get(peerId) ?? 0) < this.config.recentSpeakerWindow
      }))
      .sort((a, b) => {
        if (a.isPinned && !b.isPinned) return -1
        if (!a.isPinned && b.isPinned) return 1
        return b.lastSpokeAt - a.lastSpokeAt
      })

    const enabledPeers = new Set(prioritized.slice(0, this.config.maxVideoStreams).map((p) => p.peerId))

    for (const peerId of allPeers) {
      const shouldBeEnabled = enabledPeers.has(peerId)
      const wasEnabled = this.videoEnabled.get(peerId)
      if (shouldBeEnabled !== wasEnabled) {
        this.videoEnabled.set(peerId, shouldBeEnabled)
        this.onLog(`Last-N: Video for ${peerId} ${shouldBeEnabled ? 'enabled' : 'disabled'}`, 'info')
        this.onVideoStateChange?.(peerId, shouldBeEnabled)
      }
    }
  }
}

// ============================================================================
// Quality Tier Manager
// ============================================================================

export type QualityTier = 'high' | 'medium' | 'low' | 'audio-only'

interface PeerQualityState {
  peerId: string
  currentTier: QualityTier
  isSpeaking: boolean
  lastSpokeAt: number
  isVisible: boolean
  isPinned: boolean
}

export class QualityTierManager {
  private activeSpeaker: ActiveSpeakerDetector
  private visibility: VideoVisibilityManager
  private adaptiveBitrate: AdaptiveBitrateController
  private simulcast: SimulcastManager
  private lastN: LastNVideoManager
  private peerStates = new Map<string, PeerQualityState>()
  private onQualityChange?: (peerId: string, tier: QualityTier) => void
  private onLog: LogFn

  constructor(onLog: LogFn) {
    this.onLog = onLog
    this.activeSpeaker = new ActiveSpeakerDetector({}, onLog)
    this.visibility = new VideoVisibilityManager(onLog)
    this.adaptiveBitrate = new AdaptiveBitrateController({}, onLog)
    this.simulcast = new SimulcastManager({}, onLog)
    this.lastN = new LastNVideoManager({}, onLog)

    this.activeSpeaker.start((speakers) => {
      speakers.forEach((peerId) => this.lastN.onPeerSpoke(peerId))
      this.recalculateTiers()
    })

    this.lastN.onStateChange((peerId, enabled) => {
      if (!enabled) {
        this.setTier(peerId, 'audio-only')
      } else {
        this.recalculateTiers()
      }
    })
  }

  registerPeer(peerId: string, stream: MediaStream, sender: RTCRtpSender, pc: RTCPeerConnection): void {
    this.peerStates.set(peerId, {
      peerId,
      currentTier: 'medium',
      isSpeaking: false,
      lastSpokeAt: 0,
      isVisible: true,
      isPinned: false
    })
    this.activeSpeaker.addStream(peerId, stream)
    this.visibility.registerSender(peerId, sender)
    this.adaptiveBitrate.register(peerId, sender, pc)
    this.lastN.addPeer(peerId)
    this.simulcast.enableSimulcast(sender)
  }

  unregisterPeer(peerId: string): void {
    this.peerStates.delete(peerId)
    this.activeSpeaker.removeStream(peerId)
    this.visibility.unregister(peerId)
    this.adaptiveBitrate.unregister(peerId)
    this.lastN.removePeer(peerId)
  }

  setPeerVisible(peerId: string, visible: boolean): void {
    const state = this.peerStates.get(peerId)
    if (state) state.isVisible = visible
    this.visibility.setVisible(peerId, visible)
    this.recalculateTiers()
  }

  setPeerPinned(peerId: string, pinned: boolean): void {
    const state = this.peerStates.get(peerId)
    if (state) state.isPinned = pinned
    if (pinned) this.lastN.pinPeer(peerId)
    else this.lastN.unpinPeer(peerId)
  }

  onTierChange(callback: (peerId: string, tier: QualityTier) => void): void {
    this.onQualityChange = callback
  }

  start(): void {
    this.adaptiveBitrate.startMonitoring()
  }

  stop(): void {
    this.activeSpeaker.stop()
    this.adaptiveBitrate.stopMonitoring()
  }

  private setTier(peerId: string, tier: QualityTier): void {
    const state = this.peerStates.get(peerId)
    if (!state || state.currentTier === tier) return
    state.currentTier = tier
    this.onQualityChange?.(peerId, tier)
  }

  private recalculateTiers(): void {
    const activeSpeakers = this.activeSpeaker.getActiveSpeakers()
    const primarySpeaker = activeSpeakers[0]

    for (const [peerId, state] of this.peerStates) {
      const isVideoEnabled = this.lastN.isVideoEnabled(peerId)
      if (!isVideoEnabled) {
        this.setTier(peerId, 'audio-only')
      } else if (peerId === primarySpeaker || state.isPinned) {
        this.setTier(peerId, 'high')
      } else if (activeSpeakers.includes(peerId)) {
        this.setTier(peerId, 'medium')
      } else {
        this.setTier(peerId, 'low')
      }
    }
  }
}
