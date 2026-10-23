import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { register } from 'prom-client'
import { type GfsRuntime, bootstrapGfsRuntime } from '../gfsRuntime'
import { GfsDownloadStore } from '../internalTools/gfsDownloadStore'
import { logger } from '../logger'

// statfs is the only boundary replaced: the volume sized to its free space,
// so the disk's occupancy never meets the store's free-space floor.
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof fs>()
  const { freeSpaceSizedStatfs } = await import('./fixtures/gfsStoreTestKit')
  return { ...actual, statfs: freeSpaceSizedStatfs(actual.statfs) }
})

const roots: string[] = []
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

async function start(hostRoot: string, cycleMs?: number): Promise<GfsRuntime> {
  const runtime = await bootstrapGfsRuntime(hostRoot, cycleMs === undefined ? {} : { cycleMs })
  runtimes.push(runtime)
  return runtime
}

/** A Host root that is a symlink: initialize refuses it with workspace_unavailable. */
async function symlinkedHostRoot(): Promise<{ link: string; target: string }> {
  const base = await root()
  const target = join(base, 'real-host')
  await fs.mkdir(target, { mode: 0o700 })
  const link = join(base, 'host-link')
  await fs.symlink(target, link)
  return { link, target }
}

async function expiryCount(outcome: string): Promise<number> {
  const metric = register.getSingleMetric('clerum_gfs_download_expiry_total')
  if (metric === undefined) throw new Error('expiry metric is not registered')
  const { values } = await metric.get()
  return values
    .filter(sample => sample.labels.outcome === outcome)
    .reduce((sum, sample) => sum + sample.value, 0)
}

afterEach(async () => {
  vi.useRealTimers()
  for (const runtime of runtimes.splice(0)) await runtime.stop()
  vi.restoreAllMocks()
  for (const value of roots.splice(0)) await fs.rm(value, { recursive: true, force: true })
})

describe('GFS runtime bootstrap', () => {
  it('bootstraps an available store and a workspace provider', async () => {
    const runtime = await start(await root())
    expect(runtime.store.isAvailable()).toBe(true)
    expect(runtime.workspaceProvider).toBeDefined()
  })

  it('rejects a cycle interval below 25ms', async () => {
    await expect(bootstrapGfsRuntime(await root(), { cycleMs: 24 })).rejects.toThrow(
      'GFS runtime cycleMs must be an integer of at least 25ms'
    )
  })

  it('a failed initialize is logged with its code and the next cycle makes the store available', async () => {
    const { link } = await symlinkedHostRoot()
    const error = vi.spyOn(logger, 'error')
    const initialize = vi.spyOn(GfsDownloadStore.prototype, 'initialize')

    const runtime = await start(link, 25)

    expect(runtime.store.isAvailable()).toBe(false)
    expect(error).toHaveBeenCalledWith(
      { component: 'gfs-runtime', code: 'workspace_unavailable' },
      expect.stringContaining('retried by the next cycle')
    )
    // The cause goes away: the symlink becomes a real directory.
    await fs.rm(link)
    await fs.mkdir(link, { mode: 0o700 })
    await vi.waitFor(() => expect(runtime.store.isAvailable()).toBe(true), {
      timeout: 5_000,
      interval: 10,
    })
    // Witness: availability came from a cycle-driven initialize, not the first one.
    expect(initialize.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('the cycle sweeps expired downloads', async () => {
    const hostRoot = await root()
    const callerRoot = join(hostRoot, 'users', 'caller-a')
    await fs.mkdir(callerRoot, { recursive: true, mode: 0o700 })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-08T10:00:00.000Z'))
    const runtime = await start(hostRoot, 25)
    const bytes = Buffer.from('expired content')
    const transfer = await runtime.store.createTransfer({
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      source: {
        kind: 'gfs',
        drive: 'main',
        resourceId: 'f'.repeat(32),
        gfsUri: `gfs://main/${'f'.repeat(32)}`,
        name: 'expired.bin',
        version: 1,
      },
      sizeBytes: bytes.byteLength,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await fs.writeFile(join(callerRoot, transfer.partialPath), bytes)
    await runtime.store.publish(
      transfer.id,
      'caller-a',
      createHash('sha256').update(bytes).digest('hex')
    )
    const directory = join(callerRoot, '.gfs-downloads', `input-${transfer.id}`)
    // Witness: the published download is on disk before it expires.
    await expect(fs.lstat(join(directory, 'source'))).resolves.toBeDefined()
    const removed = await expiryCount('expired_removed')

    vi.setSystemTime(Date.now() + 120_000)

    // The name disappears at the rename to `.trash-<uuid>`; the removal is
    // counted only after the rm is proven, so both are awaited together.
    await vi.waitFor(
      async () => {
        await expect(fs.lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await expiryCount('expired_removed')).toBe(removed + 1)
      },
      { timeout: 5_000, interval: 10 }
    )
  })

  it('a cleanup that throws is logged and the next cycle sweeps again', async () => {
    const runtime = await start(await root(), 25)
    const warn = vi.spyOn(logger, 'warn')
    const cleanup = vi
      .spyOn(GfsDownloadStore.prototype, 'cleanupExpired')
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error('injected EIO'), { code: 'EIO' })
      })

    // Witness: a second cycle reached cleanup after the first one threw.
    await vi.waitFor(() => expect(cleanup.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 5_000,
      interval: 10,
    })

    expect(warn).toHaveBeenCalledWith(
      { component: 'gfs-runtime', code: 'EIO' },
      'GFS download cleanup failed; the next cycle retries it'
    )
    expect(runtime.store.isAvailable()).toBe(true)
  })

  it('stop joins the cycle in flight and closes the store', async () => {
    const runtime = await start(await root(), 25)
    const sweepStarted = deferred()
    const releaseSweep = deferred()
    const cleanup = vi
      .spyOn(GfsDownloadStore.prototype, 'cleanupExpired')
      .mockImplementationOnce(async () => {
        sweepStarted.resolve()
        await releaseSweep.promise
        return { removedExpired: 0, removedIncomplete: 0, removeFailed: 0 }
      })
    await sweepStarted.promise
    let stopped = false
    const stopping = runtime.stop().then(() => {
      stopped = true
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(stopped).toBe(false)

    releaseSweep.resolve()
    await stopping

    expect(cleanup).toHaveBeenCalledOnce()
    expect(runtime.store.isAvailable()).toBe(false)
    await expect(
      runtime.store.createTransfer({
        callerIdentity: 'caller-a',
        callerWorkspacePath: join(tmpdir(), 'unused'),
        source: {
          kind: 'gfs',
          drive: 'main',
          resourceId: 'a'.repeat(32),
          gfsUri: `gfs://main/${'a'.repeat(32)}`,
          name: 'after-stop.bin',
          version: 1,
        },
        sizeBytes: 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
    ).rejects.toMatchObject({ code: 'download_busy' })
  })

  it('the default cycle runs cleanup every five minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const cleanup = vi.spyOn(GfsDownloadStore.prototype, 'cleanupExpired')
    const runtime = await start(await root())
    expect(runtime.store.isAvailable()).toBe(true)

    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1)
    expect(cleanup).not.toHaveBeenCalled()
    // Witness: the cycle reaches cleanup at five minutes, and again five minutes later.
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1))
    // The next cycle is scheduled only after this one settles.
    await cleanup.mock.results[0]!.value
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(2))
  })

  it('stop resolves when the cycle in flight never settles: it waits stopTimeoutMs, warns and closes the store', async () => {
    const runtime = await bootstrapGfsRuntime(await root(), { cycleMs: 25, stopTimeoutMs: 50 })
    runtimes.push(runtime)
    const sweepStarted = deferred()
    vi.spyOn(GfsDownloadStore.prototype, 'cleanupExpired').mockImplementationOnce(() => {
      sweepStarted.resolve()
      return new Promise(() => undefined)
    })
    await sweepStarted.promise
    const close = vi.spyOn(runtime.store, 'close')
    const warn = vi.spyOn(logger, 'warn')

    await runtime.stop()

    expect(warn).toHaveBeenCalledWith(
      { component: 'gfs-runtime', timeoutMs: 50 },
      'GFS runtime stop timed out waiting for the cycle in flight; the store is closed anyway'
    )
    expect(close).toHaveBeenCalledWith(50)
    expect(runtime.store.isAvailable()).toBe(false)
  })

  it('stop during a slow cycle initialize leaves the store unavailable', async () => {
    const { link } = await symlinkedHostRoot()
    const realInitialize = GfsDownloadStore.prototype.initialize
    const retryStarted = deferred()
    const releaseRetry = deferred()
    let calls = 0
    vi.spyOn(GfsDownloadStore.prototype, 'initialize').mockImplementation(async function (
      this: GfsDownloadStore
    ) {
      calls += 1
      if (calls === 2) {
        retryStarted.resolve()
        await releaseRetry.promise
      }
      return realInitialize.call(this)
    })
    const runtime = await start(link, 25)
    expect(runtime.store.isAvailable()).toBe(false)
    await fs.rm(link)
    await fs.mkdir(link, { mode: 0o700 })
    await retryStarted.promise

    const stopping = runtime.stop()
    releaseRetry.resolve()
    await stopping

    // Witness: the slow retry ran to completion before the store was closed.
    expect(calls).toBe(2)
    expect(runtime.store.isAvailable()).toBe(false)
    await expect(runtime.store.initialize()).rejects.toMatchObject({ code: 'download_busy' })
  })
})
