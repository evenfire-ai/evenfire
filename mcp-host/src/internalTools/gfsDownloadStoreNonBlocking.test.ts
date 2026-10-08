/**
 * A FIFO left in the user-writable store tree must never block the GFS store.
 * Every case uses a real FIFO with no peer. If an open blocks anyway, the
 * bounded race reports `blocked`, the other end is opened once to release the
 * worker thread, and the assertion on the outcome fails the test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as syncFs from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  callerDirectory,
  completedCopy,
  downloadDirectory,
  exists,
} from '../__tests__/fixtures/gfsStoreTestKit'
import { bootstrapGfsRuntime } from '../gfsRuntime'
import { GfsDownloadStore } from './gfsDownloadStore'

const KEY = 'fifo-key'
const BOUND_MS = 2_000

let hostRoot: string
const stores: GfsDownloadStore[] = []

beforeEach(() => {
  hostRoot = syncFs.mkdtempSync(path.join(tmpdir(), 'gfs-store-fifo-'))
})

afterEach(async () => {
  for (const opened of stores.splice(0)) await opened.close(0)
  await fs.rm(hostRoot, { recursive: true, force: true })
})

function mkfifo(target: string): void {
  execFileSync('mkfifo', [target])
  if (!syncFs.lstatSync(target).isFIFO()) throw new Error('mkfifo did not create a FIFO')
}

/** A download directory whose meta.json is a FIFO. */
function plantFifoMeta(root: string): string {
  const directory = downloadDirectory(root, randomUUID())
  syncFs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  mkfifo(path.join(directory, 'meta.json'))
  return directory
}

/**
 * Races `pending` against BOUND_MS. A blocked open on `fifo` is released by
 * opening the other end without blocking, so the run never hangs.
 */
async function settleWithin(
  pending: Promise<unknown>,
  fifo: string,
  blockedEnd: 'reader' | 'writer'
): Promise<'settled' | 'blocked'> {
  const observed = pending.then(
    () => undefined,
    () => undefined
  )
  const outcome = await Promise.race([
    observed.then(() => 'settled' as const),
    delay(BOUND_MS).then(() => 'blocked' as const),
  ])
  if (outcome === 'blocked') {
    const peer = syncFs.openSync(
      fifo,
      (blockedEnd === 'reader' ? syncFs.constants.O_WRONLY : syncFs.constants.O_RDONLY) |
        syncFs.constants.O_NONBLOCK
    )
    syncFs.closeSync(peer)
    await observed
  }
  return outcome
}

async function openStore(): Promise<GfsDownloadStore> {
  const opened = new GfsDownloadStore(hostRoot)
  stores.push(opened)
  await opened.initialize()
  return opened
}

describe('GFS download store: a FIFO in the store tree never blocks', () => {
  it('Host bootstrap settles with a meta.json FIFO and removes its directory', async () => {
    const root = callerDirectory(hostRoot, KEY)
    const directory = plantFifoMeta(root)

    const pending = bootstrapGfsRuntime(hostRoot)
    const outcome = await settleWithin(pending, path.join(directory, 'meta.json'), 'reader')
    const runtime = await pending
    try {
      expect(outcome).toBe('settled')
      expect(runtime.store.isAvailable()).toBe(true)
      expect(exists(directory)).toBe(false)
      // Witness: an ordinary download, publication and managed read work.
      const copy = await completedCopy(runtime.store, root, KEY, 1, 32)
      await expect(runtime.store.readManagedFile(copy.receipt.path, KEY)).resolves.toEqual(
        copy.bytes
      )
    } finally {
      await runtime.stop()
    }
  })

  it('a runtime sweep settles with a meta.json FIFO and removes its directory', async () => {
    const store = await openStore()
    const root = callerDirectory(hostRoot, KEY)
    const before = await completedCopy(store, root, KEY, 2, 24)
    const directory = plantFifoMeta(root)

    const sweep = store.cleanupExpired()
    const outcome = await settleWithin(sweep, path.join(directory, 'meta.json'), 'reader')

    expect(outcome).toBe('settled')
    await expect(sweep).resolves.toMatchObject({ removedIncomplete: 1 })
    expect(exists(directory)).toBe(false)
    // Witness: the published copy survives the sweep and a new admission works.
    await expect(store.readManagedFile(before.receipt.path, KEY)).resolves.toEqual(before.bytes)
    const after = await completedCopy(store, root, KEY, 3, 24)
    await expect(store.readManagedFile(after.receipt.path, KEY)).resolves.toEqual(after.bytes)
  })

  it('a meta.json FIFO with a writer attached is judged by its type, not read', async () => {
    const store = await openStore()
    const root = callerDirectory(hostRoot, KEY)
    const directory = plantFifoMeta(root)
    const fifo = path.join(directory, 'meta.json')
    // A writer that never writes: a read would get EAGAIN, not end-of-file.
    const reader = syncFs.openSync(fifo, syncFs.constants.O_RDONLY | syncFs.constants.O_NONBLOCK)
    const writer = syncFs.openSync(fifo, syncFs.constants.O_WRONLY)
    syncFs.closeSync(reader)
    try {
      const sweep = store.cleanupExpired()
      expect(await settleWithin(sweep, fifo, 'reader')).toBe('settled')
      await expect(sweep).resolves.toMatchObject({ removedIncomplete: 1 })
      expect(exists(directory)).toBe(false)
    } finally {
      syncFs.closeSync(writer)
    }
    // Witness: the store keeps admitting and serving afterwards.
    const copy = await completedCopy(store, root, KEY, 6, 24)
    await expect(store.readManagedFile(copy.receipt.path, KEY)).resolves.toEqual(copy.bytes)
  })

  it('managed reads of a published copy whose source became a FIFO refuse without blocking', async () => {
    const store = await openStore()
    const root = callerDirectory(hostRoot, KEY)
    const copy = await completedCopy(store, root, KEY, 4, 32)
    const source = path.join(root, copy.receipt.path)
    // Witness: the published copy is served before the swap.
    await expect(store.readManagedFile(copy.receipt.path, KEY)).resolves.toEqual(copy.bytes)
    syncFs.rmSync(source)
    mkfifo(source)

    const read = store.readManagedFile(copy.receipt.path, KEY)
    expect(await settleWithin(read, source, 'reader')).toBe('settled')
    await expect(read).rejects.toMatchObject({ code: 'download_missing' })
    const prefix = store.readManagedFilePrefix(copy.receipt.path, KEY, 8)
    expect(await settleWithin(prefix, source, 'reader')).toBe('settled')
    await expect(prefix).rejects.toMatchObject({ code: 'download_missing' })

    // The sweep treats it as incomplete and removes it; the store keeps working.
    await store.cleanupExpired()
    expect(exists(path.dirname(source))).toBe(false)
    const next = await completedCopy(store, root, KEY, 5, 32)
    await expect(store.readManagedFile(next.receipt.path, KEY)).resolves.toEqual(next.bytes)
  })
})
