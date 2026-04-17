/**
 * SDK Transport Client
 *
 * Transport layer using @novasamatech/product-sdk Statement Store.
 * Unlike the standalone ss-meet which connects directly to substrate nodes,
 * this uses the host environment's product-sdk for signing and submission.
 */

import {
  createStatementStore,
  type ProductAccountId,
  type SignedStatement,
  type Statement,
  type Topic
} from '@novasamatech/product-sdk'
import { blake2b256 } from '@polkadot-labs/hdkd-helpers'

import type { ChannelValue, LogFn } from './types'
import { encryptChannelData, decryptChannelData, isEncryptedData } from './room-encryption'

/** Convert a string to a 32-byte topic hash using blake2b */
export function stringToTopic(str: string): Uint8Array {
  const bytes = new TextEncoder().encode(str)
  return blake2b256(bytes)
}

export interface SDKClientConfig {
  accountId: ProductAccountId
  documentId: string
  appTopic?: string
  roomKey?: CryptoKey
  onLog?: LogFn
}

export class SDKTransportClient {
  private accountId: ProductAccountId
  private documentId: string
  private appTopic: string
  private roomKey?: CryptoKey
  private log: LogFn
  private statementStore: ReturnType<typeof createStatementStore>
  private subscription: { unsubscribe: () => void } | null = null
  private destroyed: boolean = false

  // Statement cache (channel key -> value)
  private statements = new Map<string, ChannelValue>()
  private onStatementCallbacks: Array<(value: ChannelValue) => void> = []
  private initialSyncComplete = false

  constructor(config: SDKClientConfig) {
    this.accountId = config.accountId
    this.documentId = config.documentId
    this.appTopic = config.appTopic || 'ss-meet'
    this.roomKey = config.roomKey
    this.log = config.onLog || (() => {})
    this.statementStore = createStatementStore()
  }

  async connect(): Promise<void> {
    if (this.destroyed) return

    this.log(`[statement-store] Connecting via product-sdk...`, 'info')
    this.log(`[statement-store] Account: ${this.accountId[0]}, derivation: ${this.accountId[1]}`, 'blockchain')
    this.log(`[statement-store] Document: ${this.documentId}, topic: ${this.appTopic}`, 'blockchain')

    // Start subscription for this room
    await this.startSubscription()
    this.log(`[statement-store] Connection established`, 'success')
  }

  async disconnect(): Promise<void> {
    this.destroyed = true
    this.stopSubscription()
    const stmtCount = this.statements.size
    this.statements.clear()
    this.onStatementCallbacks = []
    this.initialSyncComplete = false
    this.log(`[statement-store] Disconnected (had ${stmtCount} cached statements)`, 'info')
  }

  isInitialSyncComplete(): boolean {
    return this.initialSyncComplete
  }

  isConnected(): boolean {
    return !this.destroyed
  }

  getAccountId(): ProductAccountId {
    return this.accountId
  }

  async write(channel: string, value: ChannelValue): Promise<boolean> {
    if (this.destroyed) {
      this.log(`[statement-store] Write rejected — transport destroyed`, 'error')
      throw new Error('Transport destroyed')
    }

    const json = JSON.stringify(value)
    this.log(`[statement-store] Writing ${value.type} to channel: ${channel} (${json.length} bytes)`, 'blockchain')

    let dataString: string
    if (this.roomKey) {
      dataString = await encryptChannelData(this.roomKey, json)
      this.log(`[statement-store] Encrypted payload (${dataString.length} bytes)`, 'info')
    } else {
      dataString = json
    }

    const data = new TextEncoder().encode(dataString)

    try {
      // Expiry format: upper 32 bits = expiry timestamp in seconds, lower 32 bits = sequence/priority
      // See: polkadot-sdk/substrate/client/statement-store/src/lib.rs
      const expiryTimestampSecs = Math.floor(Date.now() / 1000) + 600 // 10 minutes from now
      const sequenceNumber = Date.now() % 0xFFFFFFFF
      const expiry = (BigInt(expiryTimestampSecs) << BigInt(32)) | BigInt(sequenceNumber)
      this.log(`[statement-store] Expiry: ${expiryTimestampSecs}s (${new Date(expiryTimestampSecs * 1000).toISOString()}), seq: ${sequenceNumber}`, 'info')

      const statement: Statement = {
        proof: undefined,
        decryptionKey: stringToTopic(this.documentId),
        expiry,
        channel: stringToTopic(channel),
        topics: [stringToTopic(this.appTopic), stringToTopic(this.documentId)],
        data
      }

      this.log(`[statement-store] Creating proof for ${value.type} (account: ${this.accountId[0]})...`, 'blockchain')

      const proofPromise = this.statementStore.createProof(this.accountId, statement)
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('createProof timeout — host not responding after 10s')), 10000)
      })

      const proof = await Promise.race([proofPromise, timeoutPromise])
      this.log(`[statement-store] Proof created, submitting ${value.type}...`, 'blockchain')

      const signedStatement: SignedStatement = {
        ...statement,
        proof
      }

      await this.statementStore.submit(signedStatement)

      this.log(`[statement-store] Submitted ${value.type} to ${channel.split('/').pop()}`, 'success')
      return true
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      this.log(`[statement-store] Failed to write ${value.type} to ${channel}: ${msg}`, 'error')
      this.handleSubmitError(error)
      return false
    }
  }

  onStatement(callback: (value: ChannelValue) => void): () => void {
    this.onStatementCallbacks.push(callback)
    return () => {
      const index = this.onStatementCallbacks.indexOf(callback)
      if (index >= 0) {
        this.onStatementCallbacks.splice(index, 1)
      }
    }
  }

  readCached(): Map<string, ChannelValue> {
    return new Map(this.statements)
  }

  async readAll(topicFilter?: string): Promise<Map<string, ChannelValue>> {
    const results = new Map<string, ChannelValue>()
    for (const [key, value] of this.statements) {
      if (!topicFilter) {
        results.set(key, value)
      } else if (key.startsWith(topicFilter)) {
        results.set(key, value)
      } else if (topicFilter === 'presence' && value.type === 'presence') {
        results.set(key, value)
      } else if (topicFilter === 'handshake' && (value.type === 'offer' || value.type === 'answer')) {
        results.set(key, value)
      }
    }
    return results
  }

  async readPresences(): Promise<Map<string, ChannelValue>> {
    return this.readAll('presence')
  }

  async readHandshakes(): Promise<Map<string, ChannelValue>> {
    return this.readAll('handshake')
  }

  private async startSubscription(): Promise<void> {
    const sdkTopics: Topic[] = [
      stringToTopic(this.appTopic),
      stringToTopic(this.documentId)
    ]

    this.initialSyncComplete = false
    let isFirstBatch = true

    this.log(`[statement-store] Subscribing to topics: ["${this.appTopic}", "${this.documentId}"]`, 'blockchain')

    this.subscription = this.statementStore.subscribe(sdkTopics, async (statements) => {
      this.log(`[statement-store] Received batch: ${statements.length} statement(s)${isFirstBatch ? ' (initial sync)' : ''}`, 'blockchain')

      for (const stmt of statements) {
        try {
          this.log(`[statement-store] Processing statement: keys=[${Object.keys(stmt).join(',')}], hasData=${!!stmt.data}, dataLen=${stmt.data?.length ?? 0}`, 'info')
          await this.handleStatementReceived(stmt)
        } catch (err) {
          this.log(`[statement-store] Error processing statement: ${err}`, 'error')
        }
      }

      if (isFirstBatch) {
        isFirstBatch = false
        this.initialSyncComplete = true
        this.log(`[statement-store] Initial sync complete (${this.statements.size} cached)`, 'success')
      }
    })

    this.log('[statement-store] Subscription active', 'blockchain')
  }

  private stopSubscription(): void {
    if (this.subscription) {
      this.subscription.unsubscribe()
      this.subscription = null
      this.log('[statement-store] Subscription stopped', 'info')
    }
  }

  private async handleStatementReceived(statement: SignedStatement): Promise<void> {
    try {
      if (!statement.data) {
        this.log('[statement-store] Received statement with no data, skipping', 'warning')
        return
      }

      // Verify documentId matches
      const expectedDecryptionKey = stringToTopic(this.documentId)
      if (
        statement.decryptionKey &&
        !uint8ArraysEqual(new Uint8Array(statement.decryptionKey), expectedDecryptionKey)
      ) {
        this.log('[statement-store] Statement decryptionKey mismatch, skipping', 'info')
        return
      }

      const rawData = new TextDecoder().decode(statement.data)

      let json: string
      if (this.roomKey && isEncryptedData(rawData)) {
        try {
          json = await decryptChannelData(this.roomKey, rawData)
        } catch {
          this.log('[statement-store] Failed to decrypt statement (wrong room key?)', 'warning')
          return
        }
      } else {
        json = rawData
      }

      const value = JSON.parse(json) as ChannelValue
      const key = this.getChannelKey(value)
      if (!key) {
        this.log(`[statement-store] Could not derive channel key for type: ${value.type}`, 'warning')
        return
      }

      const isTransient = value.type === 'ice-candidate'

      const existing = this.statements.get(key)
      if (!existing || value.timestamp > existing.timestamp) {
        const isNew = !existing
        this.statements.set(key, value)
        const sender = value.type === 'presence' ? value.peerId : value.from
        this.log(
          `[statement-store] ${isNew ? 'New' : 'Updated'} ${value.type} from ${sender} (cache: ${this.statements.size})`,
          'blockchain'
        )

        for (const callback of this.onStatementCallbacks) {
          callback(value)
        }
      } else if (isTransient) {
        for (const callback of this.onStatementCallbacks) {
          callback(value)
        }
      } else {
        this.log(`[statement-store] Duplicate/stale ${value.type}, skipping`, 'info')
      }
    } catch (err) {
      this.log(`[statement-store] Failed to parse statement: ${err}`, 'warning')
    }
  }

  private getChannelKey(value: ChannelValue): string | null {
    switch (value.type) {
      case 'presence':
        return `presence/${value.peerId}`
      case 'offer':
      case 'answer': {
        const [first, second] = [value.from, value.to].sort()
        return `handshake/${first}-${second}`
      }
      case 'ice-candidate': {
        const [first, second] = [value.from, value.to].sort()
        return `handshake/${first}-${second}`
      }
      default:
        return null
    }
  }

  private handleSubmitError(error: unknown): void {
    if (error instanceof Error && error.message.includes('timeout')) {
      this.log(
        `Host API timeout - createProof handler may not be implemented. Account: ${this.accountId[0]}`,
        'error'
      )
      return
    }

    if (error && typeof error === 'object' && 'tag' in error) {
      const sdkError = error as { tag: string; value?: { reason?: string } }
      switch (sdkError.tag) {
        case 'StatementProofErr::UnknownAccount':
          this.log(`Unknown account - check ProductAccountId: ${this.accountId[0]}`, 'error')
          break
        case 'StatementProofErr::UnableToSign':
          this.log('Unable to sign statement', 'error')
          break
        case 'StatementProofErr::Unknown':
          this.log(`Proof error: ${sdkError.value?.reason || 'unknown'}`, 'error')
          break
        default:
          this.log(`SDK error: ${JSON.stringify(error)}`, 'error')
      }
    }
  }
}

function uint8ArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
