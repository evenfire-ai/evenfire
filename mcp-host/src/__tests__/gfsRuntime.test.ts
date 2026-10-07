import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type GfsRuntime, bootstrapGfsRuntime } from '../gfsRuntime'
import { GfsDownloadStore, GfsDownloadStoreError } from '../internalTools/gfsDownloadStore'
import { logger } from '../logger'

const roots: string[] = []
const stores: GfsDownloadStore[] = []
const runtimes: GfsRuntime[] = []

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

async function root() {
  const value = await fs.mkdtemp(join(tmpdir(), 'gfs-runtime-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  vi.useRealTimers()
  for (const runtime of runtimes.splice(0)) await runtime.stop()
  for (const store of stores.splice(0)) await store.close()
  vi.restoreAllMocks()
  for (const value of roots.splice(0)) await fs.rm(value, { recursive: true, force: true })
})

describe('GFS runtime bootstrap', () => {
  it('contains recovery-required startup and does not retry unverified contention', async () => {
    const value = await root()
    await fs.mkdir(join(value, '.gfs-download-store'), { mode: 0o700 })
    const initialize = vi.spyOn(GfsDownloadStore.prototype, 'initialize')
    const runtime = await bootstrapGfsRuntime(value)
    runtimes.push(runtime)

    expect(runtime.store.isAvailable()).toBe(false)
    expect(runtime.workspaceProvider).toBeDefined()
    expect(initialize).toHaveBeenCalledOnce()
    await runtime.stop()
  })

  it('retries verified v2 writer contention and starts cleanup when the old writer releases', async () => {
    const value = await root()
    const first = new GfsDownloadStore(value)
    stores.push(first)
    await first.initialize()
    const cleanupStarted = deferred()
    const cleanup = vi
      .spyOn(GfsDownloadStore.prototype, 'cleanupExpired')
      .mockImplementation(async () => {
        cleanupStarted.resolve()
      })
    // Fake timers keep each retry out of the old writer's close(). With real
    // timers a 25 ms retry can start verifying the in-process prior owner and
    // see it release mid-verification; that is classified as ambiguous
    // ownership (non-transient), the retry ends in recovery-required state and
    // cleanup never starts. Under host load this hung the test until the 5 s
    // timeout. Store I/O stays real; only the retry schedule is controlled.
    vi.useFakeTimers()
    const initialize = vi.spyOn(GfsDownloadStore.prototype, 'initialize')
    const runtime = await bootstrapGfsRuntime(value, { retryDelayMs: 25, maxRetryAttempts: 40 })
    runtimes.push(runtime)
    expect(runtime.store.isAvailable()).toBe(false)
    expect(cleanup).not.toHaveBeenCalled()
    await expect(initialize.mock.results[0]!.value).rejects.toMatchObject({
      code: 'writer_locked',
      transientWriterContention: true,
    })
    expect(vi.getTimerCount()).toBe(1)

    // A retry while the old writer still holds stays verified contention and
    // schedules the next retry instead of ending the supervision.
    await vi.advanceTimersByTimeAsync(25)
    expect(initialize).toHaveBeenCalledTimes(2)
    await expect(initialize.mock.results[1]!.value).rejects.toMatchObject({
      code: 'writer_locked',
      transientWriterContention: true,
    })
    // The settled rejection reschedules through promise callbacks only; flush
    // microtasks without advancing the fake clock.
    for (let turn = 0; turn < 20 && vi.getTimerCount() === 0; turn += 1) await Promise.resolve()
    expect(vi.getTimerCount()).toBe(1)
    expect(runtime.store.isAvailable()).toBe(false)
    expect(cleanup).not.toHaveBeenCalled()

    await first.close()
    await vi.advanceTimersByTimeAsync(25)
    expect(initialize).toHaveBeenCalledTimes(3)
    await cleanupStarted.promise
    expect(runtime.store.isAvailable()).toBe(true)
    expect(cleanup).toHaveBeenCalledOnce()
    await runtime.stop()
  })

  it('stops retry scheduling without reacquiring after shutdown', async () => {
    const value = await root()
    const first = new GfsDownloadStore(value)
    stores.push(first)
    await first.initialize()
    vi.useFakeTimers()
    const initialize = vi.spyOn(GfsDownloadStore.prototype, 'initialize')
    const runtime = await bootstrapGfsRuntime(value, { retryDelayMs: 25, maxRetryAttempts: 40 })
    runtimes.push(runtime)
    await runtime.stop()
    await first.close()
    await vi.advanceTimersByTimeAsync(100)

    expect(initialize).toHaveBeenCalledOnce()
    expect(runtime.store.isAvailable()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('joins a slow retry, closes its late ownership, and never schedules a post-stop sweep', async () => {
    const value = await root()
    vi.useFakeTimers()
    let available = false
    const retryEntered = deferred()
    const retryReleased = deferred()
    vi.spyOn(GfsDownloadStore.prototype, 'isAvailable').mockImplementation(() => available)
    vi.spyOn(GfsDownloadStore.prototype, 'initialize')
      .mockRejectedValueOnce(new GfsDownloadStoreError('writer_locked', true))
      .mockImplementation(async () => {
        retryEntered.resolve()
        await retryReleased.promise
        available = true
      })
    const cleanup = vi.spyOn(GfsDownloadStore.prototype, 'cleanupExpired').mockResolvedValue()
    const close = vi.spyOn(GfsDownloadStore.prototype, 'close').mockImplementation(async () => {
      available = false
    })
    const runtime = await bootstrapGfsRuntime(value, { retryDelayMs: 25 })
    runtimes.push(runtime)
    await vi.advanceTimersByTimeAsync(25)
    await retryEntered.promise
    const stopping = runtime.stop()
    expect(runtime.stop()).toBe(stopping)
    expect(close).not.toHaveBeenCalled()
    try {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
      expect(cleanup).not.toHaveBeenCalled()
    } finally {
      retryReleased.resolve()
    }
    await stopping

    expect(close).toHaveBeenCalledOnce()
    expect(runtime.store.isAvailable()).toBe(false)
    expect(cleanup).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('serializes slow sweeps and joins the current sweep before closing', async () => {
    const value = await root()
    vi.useFakeTimers()
    const sweepEntered = deferred()
    const sweepReleased = deferred()
    vi.spyOn(GfsDownloadStore.prototype, 'initialize').mockResolvedValue()
    vi.spyOn(GfsDownloadStore.prototype, 'isAvailable').mockReturnValue(true)
    const close = vi.spyOn(GfsDownloadStore.prototype, 'close').mockResolvedValue()
    const cleanup = vi
      .spyOn(GfsDownloadStore.prototype, 'cleanupExpired')
      .mockResolvedValueOnce()
      .mockImplementation(async () => {
        sweepEntered.resolve()
        await sweepReleased.promise
      })
    const runtime = await bootstrapGfsRuntime(value)
    runtimes.push(runtime)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    await sweepEntered.promise
    const stopping = runtime.stop()
    try {
      await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000)
      expect(cleanup).toHaveBeenCalledTimes(2)
      expect(close).not.toHaveBeenCalled()
    } finally {
      sweepReleased.resolve()
    }
    await stopping

    expect(close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('U9: logs that recovery is required when initialize succeeds but the store is unavailable', async () => {
    const initialize = vi.spyOn(GfsDownloadStore.prototype, 'initialize')
    vi.spyOn(GfsDownloadStore.prototype, 'isAvailable').mockReturnValue(false)
    const error = vi.spyOn(logger, 'error')
    const runtime = await bootstrapGfsRuntime(await root())
    runtimes.push(runtime)

    expect(initialize).toHaveBeenCalledOnce()
    await expect(initialize.mock.results[0]!.value).resolves.toBeUndefined()
    const recoveryLogs = error.mock.calls.filter(([, message]) =>
      message.includes('operator recovery is required')
    )
    expect(recoveryLogs).toEqual([
      [
        { component: 'gfs-runtime', available: false },
        'GFS download store initialized but is not available; operator recovery is required and managed GFS delivery is disabled',
      ],
    ])
  })

  it('closes initialized ownership even when quarantine makes the store unavailable', async () => {
    const runtime = await bootstrapGfsRuntime(await root())
    runtimes.push(runtime)
    const close = vi.spyOn(runtime.store, 'close')
    vi.spyOn(runtime.store, 'isAvailable').mockReturnValue(false)

    await runtime.stop()
    expect(close).toHaveBeenCalledOnce()
    vi.restoreAllMocks()
    expect(runtime.store.isAvailable()).toBe(false)
  })

  it('ends bounded retries when the verified contention budget is exhausted', async () => {
    const value = await root()
    vi.useFakeTimers()
    vi.spyOn(GfsDownloadStore.prototype, 'isAvailable').mockReturnValue(false)
    const initialize = vi
      .spyOn(GfsDownloadStore.prototype, 'initialize')
      .mockRejectedValue(new GfsDownloadStoreError('writer_locked', true))
    const cleanup = vi.spyOn(GfsDownloadStore.prototype, 'cleanupExpired').mockResolvedValue()
    const runtime = await bootstrapGfsRuntime(value, { retryDelayMs: 25, maxRetryAttempts: 2 })
    runtimes.push(runtime)
    await vi.advanceTimersByTimeAsync(100)

    expect(initialize).toHaveBeenCalledTimes(3)
    expect(cleanup).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
