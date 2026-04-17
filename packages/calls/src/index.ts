/**
 * @productivity/calls
 *
 * WebRTC video conferencing via product-sdk Statement Store.
 * Adapted from ss-meet to use the host environment's signing and transport.
 */

// Main API
export { Meet } from './meet'
export type { PeerInfo } from './meet'

// Core Components
export { CallsProvider } from './provider'
export { SDKTransportClient } from './sdk-client'
export { SignalingManager } from './signaling'
export { PeerManager } from './peer-manager'
export { TurnCredentials } from './turn-credentials'

// Meeting Optimizations
export {
  ActiveSpeakerDetector,
  VideoVisibilityManager,
  AdaptiveBitrateController,
  SimulcastManager,
  LastNVideoManager,
  QualityTierManager
} from './meeting-optimizations'
export type { QualityTier } from './meeting-optimizations'

// Types
export type {
  LogType,
  LogFn,
  ConnectionStatus,
  PresenceValue,
  OfferValue,
  AnswerValue,
  ChannelValue,
  GossipPeerInfo,
  PeerSyncMessage,
  ScreenShareMessage,
  CallsProviderConfig,
  CallsMeetConfig
} from './types'

export {
  generatePeerId,
  isOfferer,
  getPresenceChannel,
  getHandshakeChannel,
  isPeerSyncMessage,
  isScreenShareMessage
} from './types'

// Room Encryption
export {
  generateRoomKey,
  importRoomKey,
  encryptChannelData,
  decryptChannelData,
  isEncryptedData,
  isValidRoomKey,
  extractRoomKeyFromUrl,
  createShareableUrl
} from './room-encryption'

// Errors
export { CallsError } from './errors'
export type { CallsErrorCode } from './errors'
