/**
 * TurnCredentials: Manages ICE server configuration for WebRTC
 *
 * Fetches ephemeral TURN credentials from the Cloudflare TURN API.
 */

export interface TurnConfig {
  keyId?: string
  apiToken?: string
}

export class TurnCredentials {
  private turnKeyId: string
  private apiToken: string
  private cachedCredentials: { username: string; credential: string } | null = null
  private credentialExpiry = 0

  constructor(config: TurnConfig = {}) {
    this.turnKeyId = config.keyId || ''
    this.apiToken = config.apiToken || ''
  }

  async fetchCredentials(): Promise<{ username: string; credential: string } | null> {
    if (this.cachedCredentials && Date.now() < this.credentialExpiry) {
      return this.cachedCredentials
    }

    if (!this.turnKeyId || !this.apiToken) return null

    try {
      const ttl = 86400
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${this.turnKeyId}/credentials/generate`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ ttl })
        }
      )
      if (!res.ok) return null
      const data = await res.json()
      this.cachedCredentials = {
        username: data.iceServers.username,
        credential: data.iceServers.credential
      }
      this.credentialExpiry = Date.now() + (ttl - 60) * 1000
      return this.cachedCredentials
    } catch {
      return null
    }
  }

  async getIceServers(forceRelay = false): Promise<RTCIceServer[]> {
    const servers: RTCIceServer[] = []

    if (!forceRelay) {
      servers.push({ urls: 'stun:stun.cloudflare.com:3478' })
      servers.push({ urls: 'stun:stun.l.google.com:19302' })
    }

    const creds = await this.fetchCredentials()
    if (creds) {
      servers.push({
        urls: [
          'turn:turn.cloudflare.com:3478?transport=udp',
          'turn:turn.cloudflare.com:3478?transport=tcp',
          'turns:turn.cloudflare.com:5349?transport=tcp'
        ],
        username: creds.username,
        credential: creds.credential
      })
    }

    return servers
  }

  hasCloudflareConfig(): boolean {
    return !!(this.turnKeyId && this.apiToken)
  }
}
