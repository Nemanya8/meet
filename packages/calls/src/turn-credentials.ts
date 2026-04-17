/**
 * TurnCredentials: Manages ICE server configuration for WebRTC
 *
 * Uses Cloudflare TURN with direct credentials (no HTTP fetch).
 */

export interface TurnConfig {
  keyId?: string
  apiToken?: string
}

export class TurnCredentials {
  private turnKeyId: string
  private apiToken: string

  constructor(config: TurnConfig = {}) {
    this.turnKeyId = config.keyId || ''
    this.apiToken = config.apiToken || ''
  }

  getIceServers(forceRelay = false): RTCIceServer[] {
    const servers: RTCIceServer[] = []

    if (!forceRelay) {
      servers.push({ urls: 'stun:stun.cloudflare.com:3478' })
      servers.push({ urls: 'stun:stun.l.google.com:19302' })
    }

    if (this.turnKeyId && this.apiToken) {
      servers.push({
        urls: [
          'turn:turn.cloudflare.com:3478?transport=udp',
          'turn:turn.cloudflare.com:3478?transport=tcp',
          'turns:turn.cloudflare.com:5349?transport=tcp'
        ],
        username: this.turnKeyId,
        credential: this.apiToken
      })
    }

    return servers
  }

  hasCloudflareConfig(): boolean {
    return !!(this.turnKeyId && this.apiToken)
  }
}
