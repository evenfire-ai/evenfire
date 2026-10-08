/**
 * Provenance boundary of the GFS download store. A shell command runs with the
 * Host UID and can write anything under `users/`, so a copy found on disk
 * proves nothing about who downloaded it or what it hashes to. These tests
 * plant such copies and check that they are counted and swept but never
 * reused, read or allowed to displace a copy this process published.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as crypto from 'node:crypto'
import { randomUUID } from 'node:crypto'
import * as syncFs from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  callerDirectory,
  completedCopy,
  digestOf,
  downloadDirectory,
  exists,
  expiryCount,
  metaFor,
  plantDownload,
  quotaCount,
  sourceFor,
  startTransfer,
  withEnvironment,
} from '../__tests__/fixtures/gfsStoreTestKit'
import { logger } from '../logger'
import { GfsDownloadStore } from './gfsDownloadStore'

const { hashBoundary, volume } = vi.hoisted(() => ({
  hashBoundary: vi.fn(),
  volume: { totalBytes: undefined as bigint | undefined },
}))
// Pass-through: the store hashes through createHash; the kit uses crypto.hash.
vi.mock('node:crypto', async original => ({
  ...(await original<typeof crypto>()),
  createHash: hashBoundary,
}))
// statfs reports the real free space; a test that sets `volume.totalBytes`
// sizes the volume (block size 1), and with it the retained budget.
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof fs>()
  return {
    ...actual,
    statfs: async (target: string, options: { bigint: true }) => {
      const real = await actual.statfs(target, options)
      if (volume.totalBytes === undefined) return real
      return { ...real, bsize: 1n, blocks: volume.totalBytes, bavail: real.bavail * real.bsize }
    },
  }
})

const A = 'caller-a'
const B = 'caller-b'
const C = 'caller-c'

let nativeCrypto: typeof crypto
let hostRoot: string
let rootA: string
let rootB: string
let store: GfsDownloadStore
const extraStores: GfsDownloadStore[] = []
const outsideRoots: string[] = []

function receiptPathOf(id: string): string {
  return `.gfs-downloads/input-${id}/source`
}

/** A complete, well-formed copy written by a shell command, not by the store. */
function plantComplete(
  root: string,
  identity: string,
  index: number,
  bytes: Buffer,
  options: { id?: string } = {}
) {
  const id = options.id ?? randomUUID()
  return plantDownload(root, {
    id,
    bytes,
    meta: metaFor(id, bytes, Date.now(), { callerIdentity: identity, source: sourceFor(index) }),
  })
}

async function openStore(): Promise<GfsDownloadStore> {
  const opened = new GfsDownloadStore(hostRoot)
  extraStores.push(opened)
  await opened.initialize()
  return opened
}

function outsideDirectory(): string {
  const outside = syncFs.mkdtempSync(path.join(tmpdir(), 'gfs-store-outside-'))
  outsideRoots.push(outside)
  return outside
}

async function expectNotServed(target: GfsDownloadStore, id: string, identity: string) {
  await expect(target.readManagedFile(receiptPathOf(id), identity)).rejects.toMatchObject({
    code: 'download_missing',
  })
  await expect(target.readManagedFilePrefix(receiptPathOf(id), identity)).rejects.toMatchObject({
    code: 'download_missing',
  })
}

function adoptedLogged(info: ReturnType<typeof vi.spyOn>, adopted: number) {
  expect(info).toHaveBeenCalledWith(
    expect.objectContaining({ component: 'GfsDownloadStore', adopted }),
    'GFS download store initialized'
  )
}

beforeEach(async () => {
  nativeCrypto = await vi.importActual<typeof crypto>('node:crypto')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-08T10:00:00.000Z'))
  hashBoundary.mockReset()
  hashBoundary.mockImplementation((algorithm: string) => nativeCrypto.createHash(algorithm))
  volume.totalBytes = undefined
  hostRoot = syncFs.mkdtempSync(path.join(tmpdir(), 'gfs-store-provenance-'))
  rootA = callerDirectory(hostRoot, A)
  rootB = callerDirectory(hostRoot, B)
  store = new GfsDownloadStore(hostRoot)
  await store.initialize()
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const opened of extraStores.splice(0)) await opened.close(0)
  await store.close(0)
  await fs.rm(hostRoot, { recursive: true, force: true })
  for (const outside of outsideRoots.splice(0))
    await fs.rm(outside, { recursive: true, force: true })
})

describe('GFS download store provenance: planted copies', () => {
  it("T-S1: a planted entry in the caller's directory is never reused", async () => {
    const bytes = Buffer.alloc(32, 0x41)
    const planted = plantComplete(rootB, B, 5, bytes)
    const info = vi.spyOn(logger, 'info')
    const restarted = await openStore()

    // Witnesses: the restarted store indexed the copy and counts it under B.
    adoptedLogged(info, 1)
    expect((await restarted.debugInventory()).byCaller.get(B)).toEqual({ files: 1, bytes: 32 })
    hashBoundary.mockClear()

    await expect(restarted.reusableReceipt(B, sourceFor(5), 32)).resolves.toBeUndefined()
    expect(hashBoundary).not.toHaveBeenCalled()
    const transfer = await restarted.createTransfer({
      callerIdentity: B,
      callerWorkspacePath: rootB,
      source: sourceFor(5),
      sizeBytes: 32,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    expect(transfer.id).not.toBe(planted.id)
    expect(exists(planted.sourcePath)).toBe(true)
  })

  it('T-S2: a planted entry is never read through the managed path', async () => {
    const own = await completedCopy(store, rootB, B, 6, 16)
    const bytes = Buffer.alloc(24, 0x42)
    const planted = plantComplete(rootB, B, 7, bytes)

    // Not yet indexed: the managed path must not look at the disk.
    await expectNotServed(store, planted.id, B)
    // Control: the same read path serves B's published copy.
    await expect(store.readManagedFile(own.receipt.path, B)).resolves.toEqual(own.bytes)

    const info = vi.spyOn(logger, 'info')
    const restarted = await openStore()
    adoptedLogged(info, 2)
    expect((await restarted.debugInventory()).byCaller.get(B)).toEqual({ files: 2, bytes: 40 })
    await expectNotServed(restarted, planted.id, B)
    expect(exists(planted.sourcePath)).toBe(true)
  })

  it('T-S3: a planted directory with a published id is removed and the published copy is untouched', async () => {
    const published = await completedCopy(store, rootB, B, 8, 32)
    const forged = Buffer.alloc(32, 0x5a)
    const planted = plantComplete(rootA, B, 8, forged, { id: published.receipt.id })

    await expect(store.cleanupExpired()).resolves.toMatchObject({ removedIncomplete: 1 })

    expect(exists(planted.directory)).toBe(false)
    const reused = await store.reusableReceipt(B, sourceFor(8), 32)
    expect(reused).toMatchObject({ id: published.receipt.id, sha256: digestOf(published.bytes) })
    await expect(store.readManagedFile(published.receipt.path, B)).resolves.toEqual(published.bytes)
  })

  it('T-S4: a planted entry is inventoried under the directory that contains it and evicted first', async () => {
    const bytes = Buffer.alloc(10, 0x43)
    const planted = plantComplete(rootB, C, 9, bytes)
    volume.totalBytes = 20n
    const limited = await withEnvironment(
      {
        MCP_HOST_GFS_MAX_FILE_BYTES: '10',
        MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT: '100',
      },
      async () => {
        vi.resetModules()
        const { GfsDownloadStore: Store } = await import('./gfsDownloadStore')
        const opened = new Store(hostRoot)
        extraStores.push(opened as unknown as GfsDownloadStore)
        await opened.initialize()
        return opened
      }
    )
    const inventory = await limited.debugInventory()
    expect(inventory.byCaller.get(B)).toEqual({ files: 1, bytes: 10 })
    expect(inventory.byCaller.has(C)).toBe(false)
    const denied = await quotaCount('host', 'storage_bytes')

    // 10 planted + 10 requested fit the budget of 20, so nothing is evicted.
    const rootC = callerDirectory(hostRoot, C)
    await startTransfer(limited, rootC, C, 10, 10)
    expect(exists(planted.directory)).toBe(true)

    // 10 + 10 + 10 does not: the plant goes, the active reservation stays.
    await startTransfer(limited, rootB, B, 11, 10)
    expect(exists(planted.directory)).toBe(false)
    expect(await quotaCount('host', 'storage_bytes')).toBe(denied)
  })

  it('T-R1: a restart keeps the copy for accounting and cleanup but does not reuse it', async () => {
    const published = await completedCopy(store, rootB, B, 12, 20)
    await store.close(0)
    const info = vi.spyOn(logger, 'info')

    const restarted = await openStore()

    adoptedLogged(info, 1)
    expect((await restarted.debugInventory()).byCaller.get(B)).toEqual({ files: 1, bytes: 20 })
    await expect(restarted.reusableReceipt(B, sourceFor(12), 20)).resolves.toBeUndefined()
    await expectNotServed(restarted, published.receipt.id, B)
    const again = await startTransfer(restarted, rootB, B, 12, 20)
    expect(again.transfer.id).not.toBe(published.receipt.id)
    const directories = syncFs.readdirSync(path.join(rootB, '.gfs-downloads'))
    expect(directories.filter(name => name.startsWith('input-'))).toHaveLength(2)
  })

  it("P7: a planted entry with the caller's own identity is neither reused nor read", async () => {
    const bytes = Buffer.alloc(18, 0x44)
    const planted = plantComplete(rootA, A, 13, bytes)
    const info = vi.spyOn(logger, 'info')
    const restarted = await openStore()

    adoptedLogged(info, 1)
    expect((await restarted.debugInventory()).byCaller.get(A)).toEqual({ files: 1, bytes: 18 })
    await expect(restarted.reusableReceipt(A, sourceFor(13), 18)).resolves.toBeUndefined()
    await expectNotServed(restarted, planted.id, A)
    expect(exists(planted.sourcePath)).toBe(true)
  })

  it('P8: a meta identity that differs from its directory grants nothing to either caller', async () => {
    const bytes = Buffer.alloc(12, 0x45)
    const planted = plantComplete(rootB, C, 14, bytes)
    const info = vi.spyOn(logger, 'info')
    const restarted = await openStore()

    adoptedLogged(info, 1)
    expect((await restarted.debugInventory()).byCaller.get(B)).toEqual({ files: 1, bytes: 12 })
    await expectNotServed(restarted, planted.id, C)
    await expectNotServed(restarted, planted.id, B)
    await expect(restarted.reusableReceipt(C, sourceFor(14), 12)).resolves.toBeUndefined()
    expect(exists(planted.sourcePath)).toBe(true)
  })

  it('P9: duplicate ids without a published entry are all removed', async () => {
    const id = randomUUID()
    const first = plantComplete(rootA, A, 15, Buffer.alloc(8, 1), { id })
    const second = plantComplete(rootB, B, 15, Buffer.alloc(8, 2), { id })
    const unrelated = plantComplete(rootA, A, 16, Buffer.alloc(8, 3))

    await expect(store.cleanupExpired()).resolves.toMatchObject({ removedIncomplete: 2 })

    expect(exists(first.directory)).toBe(false)
    expect(exists(second.directory)).toBe(false)
    // Witness: the sweep kept the unrelated complete plant.
    expect(exists(unrelated.directory)).toBe(true)
    expect((await store.debugInventory()).files).toBe(1)
  })

  it('P10: a planted directory with an active id is removed and the transfer still publishes', async () => {
    const { transfer, bytes } = await startTransfer(store, rootA, A, 17, 16)
    const planted = plantComplete(rootB, A, 17, Buffer.alloc(16, 0x46), { id: transfer.id })

    await expect(store.cleanupExpired()).resolves.toMatchObject({ removedIncomplete: 1 })

    expect(exists(planted.directory)).toBe(false)
    const receipt = await store.publish(transfer.id, A, digestOf(bytes))
    await expect(store.readManagedFile(receipt.path, A)).resolves.toEqual(bytes)
  })

  it.each(['input directory', 'meta.json', 'source'] as const)('P11: symlink as %s', async kind => {
    const outside = outsideDirectory()
    const bytes = Buffer.alloc(20, 0x47)
    const id = randomUUID()
    const meta = metaFor(id, bytes, Date.now(), { callerIdentity: B, source: sourceFor(18) })
    const target = plantDownload(outside, { id, bytes, meta })
    const sibling = plantComplete(rootB, B, 19, Buffer.alloc(6, 0x48))
    let link: string
    if (kind === 'input directory') {
      link = downloadDirectory(rootB, id)
      syncFs.symlinkSync(target.directory, link)
    } else if (kind === 'meta.json') {
      const planted = plantDownload(rootB, { id, bytes, meta: 'omit' })
      link = path.join(planted.directory, 'meta.json')
      syncFs.symlinkSync(path.join(target.directory, 'meta.json'), link)
    } else {
      const planted = plantDownload(rootB, { id, bytes, meta, source: 'omit' })
      link = planted.sourcePath
      syncFs.symlinkSync(target.sourcePath, link)
    }

    await expect(store.cleanupExpired()).resolves.toMatchObject({ removedIncomplete: 1 })

    expect(exists(link)).toBe(false)
    expect(exists(downloadDirectory(rootB, id))).toBe(false)
    expect(syncFs.readFileSync(target.sourcePath)).toEqual(bytes)
    expect(exists(path.join(target.directory, 'meta.json'))).toBe(true)
    // Witness: the sweep retained the real sibling copy.
    expect(exists(sibling.directory)).toBe(true)
    expect((await store.debugInventory()).files).toBe(1)
  })

  it('P15: a .gfs-downloads that is a file is removed and the caller can still download', async () => {
    const downloads = path.join(rootB, '.gfs-downloads')
    syncFs.writeFileSync(downloads, 'not a directory', { mode: 0o600 })

    await expect(store.cleanupExpired()).resolves.toMatchObject({ removedIncomplete: 1 })

    expect(exists(downloads)).toBe(false)
    const copy = await completedCopy(store, rootB, B, 20, 9)
    await expect(store.readManagedFile(copy.receipt.path, B)).resolves.toEqual(copy.bytes)
  })

  it('P16: a symlinked caller directory is neither listed nor accepted as a caller root', async () => {
    const outside = outsideDirectory()
    const outsideCaller = path.join(outside, 'caller-x')
    syncFs.mkdirSync(outsideCaller, { mode: 0o700 })
    const hidden = plantComplete(outsideCaller, 'caller-x', 21, Buffer.alloc(10, 0x49))
    const linkedRoot = path.join(hostRoot, 'users', 'caller-x')
    syncFs.symlinkSync(outsideCaller, linkedRoot)
    const real = plantComplete(rootB, B, 22, Buffer.alloc(7, 0x4a))

    await expect(store.cleanupExpired()).resolves.toMatchObject({ removedIncomplete: 0 })
    const inventory = await store.debugInventory()

    // Witness: the real copy is listed and counted.
    expect(inventory.files).toBe(1)
    expect(inventory.byCaller.get(B)).toEqual({ files: 1, bytes: 7 })
    expect(inventory.byCaller.has('caller-x')).toBe(false)
    expect(exists(hidden.sourcePath)).toBe(true)
    expect(exists(real.sourcePath)).toBe(true)
    await expect(startTransfer(store, linkedRoot, 'caller-x', 23, 4)).rejects.toMatchObject({
      code: 'workspace_unavailable',
    })
  })

  it('P17: a hardlinked published source is not reused and is downloaded again', async () => {
    const published = await completedCopy(store, rootB, B, 24, 32)
    const directory = downloadDirectory(rootB, published.receipt.id)
    const link = path.join(outsideDirectory(), 'linked-source')
    syncFs.linkSync(path.join(directory, 'source'), link)
    const altered = Buffer.alloc(32, 0xee)
    syncFs.writeFileSync(link, altered)

    await expect(store.reusableReceipt(B, sourceFor(24), 32)).resolves.toBeUndefined()

    // Witness: the reuse path opened the copy and removed it.
    expect(exists(directory)).toBe(false)
    expect(syncFs.readFileSync(link)).toEqual(altered)
    const again = await completedCopy(store, rootB, B, 24, 32)
    expect(again.receipt.id).not.toBe(published.receipt.id)
  })

  it.each(['expiry sweep', 'failed reuse'] as const)(
    'P18: a caller directory replaced by a symlink after publish is not followed by the %s',
    async trigger => {
      const published = await completedCopy(store, rootB, B, 25, 16)
      const outside = outsideDirectory()
      const decoy = plantDownload(outside, {
        id: published.receipt.id,
        bytes: published.bytes,
        meta: metaFor(published.receipt.id, published.bytes, Date.now(), {
          callerIdentity: B,
          source: sourceFor(25),
        }),
      })
      syncFs.renameSync(rootB, `${rootB}-moved`)
      syncFs.symlinkSync(outside, rootB)
      const failedBefore = await expiryCount('remove_failed')
      const warn = vi.spyOn(logger, 'warn')

      if (trigger === 'expiry sweep') {
        await expect(
          store.cleanupExpired(Date.parse(published.receipt.expiresAt))
        ).resolves.toMatchObject({ removedExpired: 0, removeFailed: 1 })
      } else {
        await expect(store.reusableReceipt(B, sourceFor(25), 16)).resolves.toBeUndefined()
      }

      // Witness: the removal was reached and refused on containment.
      expect(await expiryCount('remove_failed')).toBe(failedBefore + 1)
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ component: 'GfsDownloadStore', code: 'workspace_unavailable' }),
        'GFS download store could not remove a download directory; the next sweep retries it'
      )
      expect(syncFs.readFileSync(decoy.sourcePath)).toEqual(published.bytes)
      expect(exists(path.join(decoy.directory, 'meta.json'))).toBe(true)
    }
  )

  it('P19: a caller directory replaced by a symlink before publish is refused and nothing is written outside', async () => {
    const { transfer, bytes } = await startTransfer(store, rootB, B, 26, 12)
    const outside = outsideDirectory()
    const decoy = downloadDirectory(outside, transfer.id)
    syncFs.mkdirSync(decoy, { recursive: true, mode: 0o700 })
    syncFs.chmodSync(path.dirname(decoy), 0o700)
    syncFs.writeFileSync(path.join(decoy, 'source.partial'), bytes, { mode: 0o600 })
    syncFs.renameSync(rootB, `${rootB}-moved`)
    syncFs.symlinkSync(outside, rootB)

    await expect(store.publish(transfer.id, B, digestOf(bytes))).rejects.toMatchObject({
      code: 'workspace_unavailable',
    })

    // Witness: the partial the decoy offered is still there, unpublished.
    expect(syncFs.readFileSync(path.join(decoy, 'source.partial'))).toEqual(bytes)
    expect(exists(path.join(decoy, 'source'))).toBe(false)
    expect(exists(path.join(decoy, 'meta.json'))).toBe(false)
    await expectNotServed(store, transfer.id, B)
  })
})
