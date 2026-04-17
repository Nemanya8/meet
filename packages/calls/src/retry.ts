import type { LogFn } from './types'

export interface RetryManagerDeps {
  shouldOffer: (peerId: string) => boolean
  getKnownPeerIds: () => string[]
  hasPeer: (peerId: string) => boolean
  initiateConnection: (peerId: string) => Promise<void>
  log: LogFn
}

export class RetryManager {
  private MAX_RETRIES = 3
  private retryAttempts = new Map<string, number>()
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private deps: RetryManagerDeps

  constructor(deps: RetryManagerDeps) {
    this.deps = deps
  }

  getAttempts(peerId: string): number {
    return this.retryAttempts.get(peerId) || 0
  }

  incrementAttempts(peerId: string): void {
    const attempts = this.retryAttempts.get(peerId) || 0
    this.retryAttempts.set(peerId, attempts + 1)
  }

  scheduleRetry(peerId: string): void {
    const existingTimer = this.retryTimers.get(peerId)
    if (existingTimer) {
      clearTimeout(existingTimer)
      this.retryTimers.delete(peerId)
    }

    const attempts = this.retryAttempts.get(peerId) || 0
    if (attempts >= this.MAX_RETRIES) {
      this.retryAttempts.delete(peerId)
      return
    }

    if (!this.deps.shouldOffer(peerId)) return

    this.retryAttempts.set(peerId, attempts + 1)
    const delay = Math.min(2000 * Math.pow(2, attempts), 10000)

    const timer = setTimeout(async () => {
      this.retryTimers.delete(peerId)
      const knownPeerIds = this.deps.getKnownPeerIds()
      if (knownPeerIds.includes(peerId) && !this.deps.hasPeer(peerId)) {
        await this.deps.initiateConnection(peerId)
      }
    }, delay)
    this.retryTimers.set(peerId, timer)
  }

  clearRetryState(peerId: string): void {
    const timer = this.retryTimers.get(peerId)
    if (timer) {
      clearTimeout(timer)
      this.retryTimers.delete(peerId)
    }
    this.retryAttempts.delete(peerId)
  }

  clearAll(): void {
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
    this.retryAttempts.clear()
  }
}
