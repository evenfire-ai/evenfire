import { type ClientRateLimitInfo, MemoryStore } from 'express-rate-limit'

const MINUTE_MS = 60_000

/**
 * Verified-principal edge counters use the same calendar minute as the PG
 * ledger. Server-generated source-IP keys retain MemoryStore's first-hit
 * window so the independent anonymous safeguard keeps its existing contract.
 */
export class CalendarMinuteRateLimitStore extends MemoryStore {
  private scopedKey(key: string, nowMs: number): string {
    return key.includes(':ip:') ? key : `${Math.floor(nowMs / MINUTE_MS)}:${key}`
  }

  override async increment(key: string): Promise<ClientRateLimitInfo> {
    const nowMs = Date.now()
    const result = await super.increment(this.scopedKey(key, nowMs))
    return key.includes(':ip:')
      ? result
      : { ...result, resetTime: new Date((Math.floor(nowMs / MINUTE_MS) + 1) * MINUTE_MS) }
  }

  override async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const nowMs = Date.now()
    const result = await super.get(this.scopedKey(key, nowMs))
    return !result || key.includes(':ip:')
      ? result
      : { ...result, resetTime: new Date((Math.floor(nowMs / MINUTE_MS) + 1) * MINUTE_MS) }
  }

  override async decrement(key: string): Promise<void> {
    await super.decrement(this.scopedKey(key, Date.now()))
  }

  override async resetKey(key: string): Promise<void> {
    await super.resetKey(this.scopedKey(key, Date.now()))
  }
}
