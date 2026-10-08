/**
 * Adversarial round of the GFS download store: caller identity across
 * channels, transient I/O that is not corruption, stranded trash, eviction and
 * undo failures, and the retirement/expiry/recency edge cases. Faults are
 * injected through a pass-through `node:fs/promises` seam; every case runs on
 * a real temporary directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as syncFs from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { callerDirectory, completedCopy, sourceFor } from '../__tests__/fixtures/gfsStoreTestKit'
import { deriveUserKey } from '../workspace/userKey'
import { GfsDownloadStore } from './gfsDownloadStore'

type FsOperation = 'open' | 'lstat' | 'rename' | 'rm' | 'readdir'
/** A fault returns the errno to throw for this call, or undefined to pass through. */
type Fault = (target: string) => string | undefined

const { faults } = vi.hoisted(() => ({
  faults: new Map<string, (target: string) => string | undefined>(),
}))

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: injected`) as NodeJS.ErrnoException
  error.code = code
  return error
}

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof fs>()
  const wrap =
    <F extends (...args: never[]) => unknown>(operation: string, real: F) =>
    (...args: Parameters<F>) => {
      const code = faults.get(operation)?.(String(args[0]))
      if (code !== undefined) return Promise.reject(errnoError(code))
      return real(...args)
    }
  return {
    ...actual,
    open: wrap('open', actual.open),
    lstat: wrap('lstat', actual.lstat),
    rename: wrap('rename', actual.rename),
    rm: wrap('rm', actual.rm),
    readdir: wrap('readdir', actual.readdir),
  }
})

function injectFault(operation: FsOperation, fault: Fault): void {
  faults.set(operation, fault)
}

let hostRoot: string
const stores: GfsDownloadStore[] = []

async function openStore(): Promise<GfsDownloadStore> {
  const opened = new GfsDownloadStore(hostRoot)
  stores.push(opened)
  await opened.initialize()
  return opened
}

beforeEach(() => {
  faults.clear()
  hostRoot = syncFs.mkdtempSync(path.join(tmpdir(), 'gfs-store-adversarial-'))
})

afterEach(async () => {
  faults.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const opened of stores.splice(0)) await opened.close(0)
  await fs.rm(hostRoot, { recursive: true, force: true })
})

describe('GFS download store adversarial round: caller identity (ADV-1)', () => {
  const SENDER = 'same-sender'
  const KEY_A = deriveUserKey(SENDER, 'channel-a')
  const KEY_B = deriveUserKey(SENDER, 'channel-b')

  it('two channels with the same sender never see each other’s copy', async () => {
    expect(KEY_A).not.toBe(KEY_B)
    const store = await openStore()
    const rootA = callerDirectory(hostRoot, KEY_A)
    const rootB = callerDirectory(hostRoot, KEY_B)
    const published = await completedCopy(store, rootA, KEY_A, 1, 64)

    // Witness: the owner's reuse and read hit the published copy.
    await expect(store.reusableReceipt(KEY_A, sourceFor(1), 64)).resolves.toMatchObject({
      id: published.receipt.id,
    })
    await expect(store.readManagedFile(published.receipt.path, KEY_A)).resolves.toEqual(
      published.bytes
    )

    // The other channel's caller: no reuse, and the foreign id reads exactly
    // like an id that never existed.
    await expect(store.reusableReceipt(KEY_B, sourceFor(1), 64)).resolves.toBeUndefined()
    const missing = `.gfs-downloads/input-${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/source`
    const foreign = await store.readManagedFile(published.receipt.path, KEY_B).catch(e => e)
    const nonexistent = await store.readManagedFile(missing, KEY_B).catch(e => e)
    expect(foreign).toMatchObject({ code: 'download_missing' })
    expect(nonexistent).toMatchObject({ code: 'download_missing' })
    expect(String(foreign)).toBe(String(nonexistent))

    // B downloads its own copy into its own root.
    const own = await completedCopy(store, rootB, KEY_B, 1, 64)
    expect(own.receipt.id).not.toBe(published.receipt.id)
    expect(syncFs.existsSync(path.join(rootB, own.receipt.path))).toBe(true)
  })

  it('refuses an identity that is not the caller root’s key', async () => {
    const store = await openStore()
    const rootA = callerDirectory(hostRoot, KEY_A)
    const admission = {
      callerWorkspacePath: rootA,
      source: sourceFor(2),
      sizeBytes: 8,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    await expect(
      store.createTransfer({ ...admission, callerIdentity: SENDER })
    ).rejects.toMatchObject({ code: 'caller_mismatch' })
    await expect(
      store.createTransfer({ ...admission, callerIdentity: KEY_B })
    ).rejects.toMatchObject({ code: 'caller_mismatch' })
    // Witness: the root's own key is admitted.
    await expect(
      store.createTransfer({ ...admission, callerIdentity: KEY_A })
    ).resolves.toMatchObject({ sizeBytes: 8 })
  })
})

describe('GFS download store adversarial round: caller root shape (F9)', () => {
  it.each([
    ['the Host root', (host: string) => host],
    ['the users directory', (host: string) => path.join(host, 'users')],
    ['a directory inside a caller root', (host: string) => path.join(host, 'users', 'k', 'nested')],
    ['a directory outside users', (host: string) => path.join(host, 'other', 'k')],
  ])('refuses %s as a caller root', async (_label, rootOf) => {
    const store = await openStore()
    const root = rootOf(hostRoot)
    syncFs.mkdirSync(root, { recursive: true, mode: 0o700 })
    await expect(
      store.createTransfer({
        callerIdentity: path.basename(root),
        callerWorkspacePath: root,
        source: sourceFor(3),
        sizeBytes: 8,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
    ).rejects.toMatchObject({ code: 'workspace_unavailable' })
    // Witness: `users/<key>` itself is admitted.
    const valid = callerDirectory(hostRoot, 'k')
    await expect(
      store.createTransfer({
        callerIdentity: 'k',
        callerWorkspacePath: valid,
        source: sourceFor(3),
        sizeBytes: 8,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
    ).resolves.toMatchObject({ sizeBytes: 8 })
  })
})
