import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
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

  it('U9: logs an error and stops the periodic lifecycle when the store becomes unavailable after initialize', async () => {
    vi.useFakeTimers()
    const value = await root()
    const initialize = vi.spyOn(GfsDownloadStore.prototype, 'initialize')
    const error = vi.spyOn(logger, 'error')
    const warn = vi.spyOn(logger, 'warn')
    // Real sweeps throughout: the store becomes unavailable only because a real
    // persist fails during a periodic sweep, which marks the store `unsafe`.
    const cleanup = vi.spyOn(GfsDownloadStore.prototype, 'cleanupExpired')
    const runtime = await bootstrapGfsRuntime(value)
    runtimes.push(runtime)
    await expect(initialize.mock.results[0]!.value).resolves.toBeUndefined()
    // initialize() sweeps once itself; the lifecycle's first sweep is the second.
    for (let turn = 0; turn < 20 && cleanup.mock.calls.length < 2; turn += 1)
      await Promise.resolve()
    expect(cleanup).toHaveBeenCalledTimes(2)
    await cleanup.mock.results[1]!.value
    // The settled sweep schedules the next one through promise callbacks only;
    // flush microtasks without advancing the fake clock.
    for (let turn = 0; turn < 20 && vi.getTimerCount() === 0; turn += 1) await Promise.resolve()
    expect(runtime.store.isAvailable()).toBe(true)
    expect(vi.getTimerCount()).toBe(1)

    // A published record that expires before the next periodic sweep, so that
    // sweep must remove it and persist the released charge.
    const callerRoot = join(value, 'users', 'caller-a')
    await fs.mkdir(callerRoot, { recursive: true, mode: 0o700 })
    const transfer = await runtime.store.createTransfer({
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      source: {
        kind: 'gfs',
        drive: 'main',
        resourceId: 'a'.repeat(32),
        gfsUri: `gfs://main/${'a'.repeat(32)}`,
        name: 'input.csv',
        version: 7,
      },
      sizeBytes: 7,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await fs.writeFile(join(callerRoot, transfer.partialPath), 'fixture')
    const receipt = await runtime.store.publish(
      transfer.id,
      'caller-a',
      createHash('sha256').update('fixture').digest('hex')
    )
    expect(runtime.store.debugRecord(receipt.id)?.state).toBe('completed')

    // The next ledger write fails at the filesystem layer, before its rename.
    const probe = await fs.open(join(value, '.gfs-download-store', 'ledger-v1.json'), 'r')
    const prototype = Object.getPrototypeOf(probe) as FileHandle
    await probe.close()
    const originalWriteFile = prototype.writeFile
    const failedLedgerWrites: Record<string, Record<string, unknown>>[] = []
    vi.spyOn(prototype, 'writeFile').mockImplementation(async function (
      this: FileHandle,
      ...args: Parameters<FileHandle['writeFile']>
    ) {
      const [data] = args
      if (
        failedLedgerWrites.length === 0 &&
        typeof data === 'string' &&
        data.includes('"records"')
      ) {
        failedLedgerWrites.push(JSON.parse(data))
        throw Object.assign(new Error('injected ledger write failure'), { code: 'EIO' })
      }
      return originalWriteFile.apply(this, args)
    })

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    // Witness: the periodic sweep ran and its persist is the write that failed,
    // releasing the expired record's charge. The sweep does real I/O, so wait
    // for it to settle rather than for the fake clock.
    expect(cleanup).toHaveBeenCalledTimes(3)
    await expect(cleanup.mock.results[2]!.value).rejects.toThrow('injected ledger write failure')
    const stopLogged = () =>
      error.mock.calls.some(
        ([, message]) => typeof message === 'string' && message.includes('no longer available')
      )
    for (let turn = 0; turn < 20 && !stopLogged(); turn += 1) await Promise.resolve()
    expect(failedLedgerWrites).toHaveLength(1)
    expect(failedLedgerWrites[0]!.records).not.toHaveProperty(receipt.id)
    expect(
      warn.mock.calls.filter(([, message]) => message === 'GFS download cleanup failed')
    ).toHaveLength(1)
    expect(runtime.store.isAvailable()).toBe(false)
    const stopLogs = error.mock.calls.filter(
      ([, message]) => typeof message === 'string' && message.includes('no longer available')
    )
    expect(stopLogs).toEqual([
      [
        { component: 'gfs-runtime', available: false },
        'GFS download store is no longer available; periodic cleanup stopped and managed GFS operations are disabled',
      ],
    ])
    // The lifecycle schedules nothing more: another period passes without a sweep.
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(cleanup).toHaveBeenCalledTimes(3)
  })

  it('closes initialized ownership even when a failed persist has made the store unavailable', async () => {
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
