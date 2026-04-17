/**
 * Typed error handling for the calls package.
 */

export type CallsErrorCode =
  | 'CONNECTION_FAILED'
  | 'SIGNALING_FAILED'
  | 'PEER_CONNECTION_FAILED'
  | 'ICE_GATHERING_FAILED'
  | 'DATA_CHANNEL_FAILED'
  | 'MEDIA_FAILED'
  | 'INVALID_CONFIG'
  | 'NOT_CONNECTED'
  | 'ALREADY_CONNECTED'
  | 'BLOCKCHAIN_ERROR'
  | 'TURN_CREDENTIALS_FAILED'

export class CallsError extends Error {
  code: CallsErrorCode
  override cause?: Error

  constructor(code: CallsErrorCode, message: string, cause?: Error) {
    super(message)
    this.name = 'CallsError'
    this.code = code
    this.cause = cause
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CallsError)
    }
  }

  static connectionFailed(message: string, cause?: Error) {
    return new CallsError('CONNECTION_FAILED', message, cause)
  }

  static signalingFailed(message: string, cause?: Error) {
    return new CallsError('SIGNALING_FAILED', message, cause)
  }

  static peerConnectionFailed(peerId: string, cause?: Error) {
    return new CallsError('PEER_CONNECTION_FAILED', `Failed to connect to peer: ${peerId}`, cause)
  }

  static iceGatheringFailed(cause?: Error) {
    return new CallsError('ICE_GATHERING_FAILED', 'ICE gathering failed or timed out', cause)
  }

  static dataChannelFailed(peerId: string, cause?: Error) {
    return new CallsError('DATA_CHANNEL_FAILED', `Data channel failed with peer: ${peerId}`, cause)
  }

  static mediaFailed(message: string, cause?: Error) {
    return new CallsError('MEDIA_FAILED', message, cause)
  }

  static invalidConfig(message: string) {
    return new CallsError('INVALID_CONFIG', message)
  }

  static notConnected() {
    return new CallsError('NOT_CONNECTED', 'Not connected to meeting')
  }

  static alreadyConnected() {
    return new CallsError('ALREADY_CONNECTED', 'Already connected to meeting')
  }

  static blockchainError(message: string, cause?: Error) {
    return new CallsError('BLOCKCHAIN_ERROR', message, cause)
  }

  static turnCredentialsFailed(cause?: Error) {
    return new CallsError('TURN_CREDENTIALS_FAILED', 'Failed to fetch TURN credentials', cause)
  }
}
