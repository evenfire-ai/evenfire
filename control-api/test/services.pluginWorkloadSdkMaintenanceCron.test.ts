import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as sdkDb from '../src/services/pluginWorkloadSdkDb.js'
import {
  startPluginWorkloadSdkMaintenanceCron,
  stopPluginWorkloadSdkMaintenanceCron,
} from '../src/services/pluginWorkloadSdkMaintenanceCron.js'

vi.mock('../src/db.js', () => ({
  pool: {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn(),
  },
  withTransaction: vi.fn(),
}))

vi.mock('../src/services/pluginWorkloadSdkDb.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/pluginWorkloadSdkDb.js')>(
    '../src/services/pluginWorkloadSdkDb.js'
  )
  return {
    ...actual,
    failStaleInvocations: vi.fn(),
    prunePluginWorkloadSdkExpiredIdempotency: vi.fn(),
  }
})

describe('pluginWorkloadSdkMaintenanceCron (plan §5.1, OQ-5)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(sdkDb.failStaleInvocations).mockReset().mockResolvedValue(2)
    vi.mocked(sdkDb.prunePluginWorkloadSdkExpiredIdempotency).mockReset().mockResolvedValue(5)
  })

  afterEach(() => {
    stopPluginWorkloadSdkMaintenanceCron()
    vi.useRealTimers()
  })

  it('sweeps stale invocations and prunes expired idempotency rows on each tick', async () => {
    startPluginWorkloadSdkMaintenanceCron(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sdkDb.failStaleInvocations).toHaveBeenCalledWith(180)
    expect(sdkDb.prunePluginWorkloadSdkExpiredIdempotency).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sdkDb.prunePluginWorkloadSdkExpiredIdempotency).toHaveBeenCalledTimes(2)
  })

  it('survives sweep errors and keeps ticking', async () => {
    vi.mocked(sdkDb.failStaleInvocations).mockRejectedValue(new Error('db down'))
    startPluginWorkloadSdkMaintenanceCron(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sdkDb.failStaleInvocations).toHaveBeenCalledTimes(2)
  })

  it('is idempotent on double start and stops cleanly', async () => {
    startPluginWorkloadSdkMaintenanceCron(60_000)
    startPluginWorkloadSdkMaintenanceCron(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sdkDb.prunePluginWorkloadSdkExpiredIdempotency).toHaveBeenCalledTimes(1)
    stopPluginWorkloadSdkMaintenanceCron()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(sdkDb.prunePluginWorkloadSdkExpiredIdempotency).toHaveBeenCalledTimes(1)
  })
})
