import { describe, expect, it } from 'vitest'
import { parseDbWorkerStallTimeoutMs } from '../config'

describe('CLERUM_DB_WORKER_STALL_TIMEOUT_MS', () => {
  it('defaults to 30000 when unset or blank', () => {
    expect(parseDbWorkerStallTimeoutMs(undefined, 2000)).toBe(30_000)
    expect(parseDbWorkerStallTimeoutMs('  ', 2000)).toBe(30_000)
  })

  it('accepts an integer of at least 1000 that exceeds the sync timeout', () => {
    expect(parseDbWorkerStallTimeoutMs('15000', 2000)).toBe(15_000)
    expect(parseDbWorkerStallTimeoutMs('1000', 999)).toBe(1000)
  })

  it.each(['abc', '1.5', '-1', '0', '999', '30s'])('rejects %s', raw => {
    expect(() => parseDbWorkerStallTimeoutMs(raw, 500)).toThrow(
      `CLERUM_DB_WORKER_STALL_TIMEOUT_MS='${raw}' must be an integer of at least 1000`
    )
  })

  it('rejects a value that does not exceed the sync timeout', () => {
    expect(() => parseDbWorkerStallTimeoutMs('2000', 2000)).toThrow(
      "CLERUM_DB_WORKER_STALL_TIMEOUT_MS='2000' must exceed CLERUM_DB_PERSIST_SYNC_TIMEOUT_MS (2000)"
    )
  })
})
