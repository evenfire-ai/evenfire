/**
 * Restart behaviour of the filesystem GFS download store: a volume written by
 * the ledger store of the pre-#1028 image (fixture shapes from dev 74e0d81d9)
 * never blocks admission, and a volume written by this store is swept but its
 * copies are never reused or served after a restart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  type DevFenceShape,
  type DevStoreShape,
  buildDevStore,
} from '../__tests__/fixtures/devGfsStoreFixture'
import {
  callerDirectory,
  completedCopy,
  downloadDirectory,
  exists,
  expiryCount,
  sourceFor,
} from '../__tests__/fixtures/gfsStoreTestKit'
import { logger } from '../logger'
import { isProtectedWorkspacePath } from '../workspace/protectedPaths'
import { GfsDownloadStore } from './gfsDownloadStore'

const { renameFailure, rmFailure } = vi.hoisted(() => ({
  /** `target` is a Host-root entry name; the store renames it by its real path. */
  renameFailure: { target: undefined as string | undefined, injected: 0 },
  /** `prefix` is a Host-root entry name prefix the next `rm` refuses once. */
  rmFailure: { prefix: undefined as string | undefined, injected: 0 },
}))
// Pass-through `rename` and `rm`: R3 makes the retirement rename of the legacy
// store fail once and R5 the removal of the retired tree, as a busy mount or a
// read-only Host root would.
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (...values: Parameters<typeof actual.rename>) => {
      if (
        renameFailure.target !== undefined &&
        String(values[0]).endsWith(`${path.sep}${renameFailure.target}`)
      ) {
        renameFailure.target = undefined
        renameFailure.injected += 1
        throw Object.assign(new Error('simulated rename failure'), { code: 'EACCES' })
      }
      return actual.rename(...values)
    },
    rm: async (...values: Parameters<typeof actual.rm>) => {
      if (
        rmFailure.prefix !== undefined &&
        path.basename(String(values[0])).startsWith(rmFailure.prefix)
      ) {
        rmFailure.prefix = undefined
        rmFailure.injected += 1
        throw Object.assign(new Error('simulated rm failure'), { code: 'EACCES' })
      }
      return actual.rm(...values)
    },
  }
})

const CALLER = 'caller-a'
const RETIRED_PREFIX = '.gfs-download-store.retired-'
const RETIREMENT_MESSAGE = 'Retired the pre-#1028 GFS download store'
const INPUT_RE = /^input-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

let hostRoot: string
const stores: GfsDownloadStore[] = []

async function open(): Promise<GfsDownloadStore> {
  const store = new GfsDownloadStore(hostRoot)
  stores.push(store)
  await store.initialize()
  return store
}

type LogCall = [Record<string, unknown>, string]

function startupLines(info: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return (info.mock.calls as LogCall[])
    .filter(([, message]) => message === 'GFS download store initialized')
    .map(([fields]) => fields)
}

function lastStartupLine(info: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const lines = startupLines(info)
  if (lines.length === 0) throw new Error('the store logged no startup line')
  return lines[lines.length - 1]!
}

function retirementWarnings(warn: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return (warn.mock.calls as LogCall[])
    .filter(([, message]) => message === RETIREMENT_MESSAGE)
    .map(([fields]) => fields)
}

async function hostRootEntries(): Promise<string[]> {
  return (await fs.readdir(hostRoot)).sort()
}

beforeEach(async () => {
  hostRoot = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'gfs-store-restart-')))
})

afterEach(async () => {
  renameFailure.target = undefined
  renameFailure.injected = 0
  rmFailure.prefix = undefined
  rmFailure.injected = 0
  for (const store of stores.splice(0)) await store.close()
  vi.restoreAllMocks()
  await fs.rm(hostRoot, { recursive: true, force: true })
})

describe('GFS download store restart', () => {
  it.each([
    ['v2 fence with a matching device', { ledger: 'records', fence: 'v2-matching' }],
    ['v2 fence with another device', { ledger: 'records', fence: 'v2-mismatched-device' }],
    ['v2 fence without a device', { ledger: 'records', fence: 'v2-no-device' }],
    ['v3 fence', { ledger: 'records', fence: 'v3' }],
    ['ledger without a fence', { ledger: 'records', fence: 'none' }],
    [
      'live processing lease of a crashed Host',
      { ledger: 'processingLeasesEmpty', fence: 'v2-matching', lease: 'live' },
    ],
  ] as Array<[string, Pick<DevStoreShape, 'ledger' | 'fence' | 'lease'>]>)(
    'R1: restarting on a volume written by the dev store never blocks admission: %s',
    async (_label, shape) => {
      const dev = await buildDevStore(hostRoot, {
        ...shape,
        sqlite: (shape.fence as DevFenceShape) !== 'none',
        userDirs: ['completed', 'transferring-partial'],
      })
      // Witness: the old store directory is on disk before the start.
      expect(exists(dev.storeRoot)).toBe(true)
      const warn = vi.spyOn(logger, 'warn')
      const info = vi.spyOn(logger, 'info')
      const retired = await expiryCount('retired_legacy_store')

      const store = await open()

      expect(store.isAvailable()).toBe(true)
      const retirements = retirementWarnings(warn)
      expect(retirements).toHaveLength(1)
      expect(retirements[0]).toMatchObject({ component: 'GfsDownloadStore' })
      expect(retirements[0]!.files as number).toBeGreaterThan(0)
      expect(retirements[0]!.bytes as number).toBeGreaterThan(0)
      expect(lastStartupLine(info)).toMatchObject({
        retiredLegacyStore: true,
        removedIncomplete: 2,
      })
      expect(await expiryCount('retired_legacy_store')).toBe(retired + 1)
      expect(exists(dev.storeRoot)).toBe(false)
      expect((await hostRootEntries()).filter(name => name.startsWith(RETIRED_PREFIX))).toEqual([])
      const { receipt, bytes } = await completedCopy(
        store,
        dev.callerRoot,
        dev.callerIdentity,
        1,
        64
      )
      await expect(store.readManagedFile(receipt.path, dev.callerIdentity)).resolves.toEqual(bytes)
    }
  )

  it('R2: dev user directories of every state are removed at startup and do not count against quota', async () => {
    const dev = await buildDevStore(hostRoot, {
      ledger: 'records',
      fence: 'v2-matching',
      sqlite: true,
      userDirs: ['completed', 'transferring-partial', 'quarantined', 'missing', 'orphan-partial'],
    })
    // Witness: every dev directory and its bytes are on disk before the start.
    expect(dev.userDirectories).toHaveLength(5)
    expect(dev.userBytes).toBeGreaterThan(0)
    for (const directory of dev.userDirectories) expect(exists(directory)).toBe(true)
    const info = vi.spyOn(logger, 'info')

    const store = await open()

    expect(lastStartupLine(info)).toMatchObject({
      removedIncomplete: 5,
      retainedCompleted: 0,
      retainedBytes: 0,
      adopted: 0,
    })
    for (const directory of dev.userDirectories) expect(exists(directory)).toBe(false)
    expect(await store.debugInventory()).toMatchObject({ bytes: 0, files: 0 })
    const { bytes } = await completedCopy(store, dev.callerRoot, dev.callerIdentity, 2, 64)
    expect(await store.debugInventory()).toMatchObject({ bytes: bytes.byteLength, files: 1 })
  })

  it('R3: a failed retirement is logged, the store is available and the next sweep retires it', async () => {
    const dev = await buildDevStore(hostRoot, {
      ledger: 'records',
      fence: 'v2-matching',
      sqlite: true,
      userDirs: [],
    })
    const warn = vi.spyOn(logger, 'warn')
    const removeFailed = await expiryCount('remove_failed')
    renameFailure.target = '.gfs-download-store'

    const store = await open()

    // Witness: the retirement rename was attempted and failed exactly once.
    expect(renameFailure.injected).toBe(1)
    expect(warn).toHaveBeenCalledWith(
      { component: 'GfsDownloadStore', code: 'EACCES', step: 'rename' },
      expect.stringContaining('could not retire')
    )
    expect(await expiryCount('remove_failed')).toBe(removeFailed + 1)
    expect(store.isAvailable()).toBe(true)
    expect(retirementWarnings(warn)).toEqual([])
    expect(exists(dev.storeRoot)).toBe(true)
    const root = callerDirectory(hostRoot, CALLER)
    const { receipt, bytes } = await completedCopy(store, root, CALLER, 3, 64)
    await expect(store.readManagedFile(receipt.path, CALLER)).resolves.toEqual(bytes)

    // The hourly sweep retries without a restart.
    await expect(store.cleanupExpired()).resolves.toMatchObject({ removeFailed: 0 })

    expect(retirementWarnings(warn)).toHaveLength(1)
    expect(exists(dev.storeRoot)).toBe(false)
    expect(await hostRootEntries()).toEqual(['users'])
  })

  it('R4: after startup the volume has no store directory and only valid input directories', async () => {
    const dev = await buildDevStore(hostRoot, {
      ledger: 'records',
      fence: 'v2-matching',
      sqlite: true,
      userDirs: ['completed', 'transferring-partial', 'quarantined', 'missing', 'orphan-partial'],
    })
    const store = await open()
    const published = await completedCopy(store, dev.callerRoot, dev.callerIdentity, 7, 64)
    await completedCopy(store, callerDirectory(hostRoot, CALLER), CALLER, 8, 64)

    expect(await hostRootEntries()).toEqual(['users'])
    let directories = 0
    for (const user of await fs.readdir(path.join(hostRoot, 'users'))) {
      const downloads = path.join(hostRoot, 'users', user, '.gfs-downloads')
      if (!exists(downloads)) continue
      for (const name of await fs.readdir(downloads)) {
        directories += 1
        expect(name).toMatch(INPUT_RE)
        const directory = path.join(downloads, name)
        expect((await fs.readdir(directory)).sort()).toEqual(['meta.json', 'source'])
        const meta = JSON.parse(await fs.readFile(path.join(directory, 'meta.json'), 'utf8'))
        expect(meta).toMatchObject({ schemaVersion: 1, id: name.slice('input-'.length) })
        const source = await fs.lstat(path.join(directory, 'source'))
        expect(source.isFile()).toBe(true)
        expect(source.size).toBe(meta.sizeBytes)
      }
    }
    // Witness: the predicate walked both published downloads.
    expect(directories).toBe(2)
    expect(exists(downloadDirectory(dev.callerRoot, published.receipt.id))).toBe(true)
  })

  it('R5: a retired directory left by a failed removal is removed by the next sweep and is protected meanwhile', async () => {
    const dev = await buildDevStore(hostRoot, {
      ledger: 'records',
      fence: 'v2-matching',
      sqlite: true,
      userDirs: [],
    })
    const warn = vi.spyOn(logger, 'warn')
    const removeFailed = await expiryCount('remove_failed')
    rmFailure.prefix = RETIRED_PREFIX

    const store = await open()

    // Witness: the old store was renamed and the removal of the renamed tree failed once.
    expect(rmFailure.injected).toBe(1)
    expect(retirementWarnings(warn)).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(
      { component: 'GfsDownloadStore', code: 'EACCES', step: 'remove' },
      expect.stringContaining('could not retire')
    )
    expect(await expiryCount('remove_failed')).toBe(removeFailed + 1)
    expect(store.isAvailable()).toBe(true)
    expect(exists(dev.storeRoot)).toBe(false)
    const leftovers = (await hostRootEntries()).filter(name => name.startsWith(RETIRED_PREFIX))
    expect(leftovers).toHaveLength(1)
    expect(isProtectedWorkspacePath(`${leftovers[0]}/ledger-v1.json`)).toBe(true)

    await expect(store.cleanupExpired()).resolves.toMatchObject({ removeFailed: 0 })

    expect(await hostRootEntries()).toEqual(['users'])
  })

  it('R6: a retired directory left by an earlier start is removed at startup and is protected meanwhile', async () => {
    const leftover = `${RETIRED_PREFIX}00000000-0000-4000-8000-000000000000`
    await fs.mkdir(path.join(hostRoot, leftover), { mode: 0o700 })
    await fs.writeFile(path.join(hostRoot, leftover, 'ledger-v1.json'), '{}', { mode: 0o600 })
    expect(isProtectedWorkspacePath(`${leftover}/ledger-v1.json`)).toBe(true)
    expect(isProtectedWorkspacePath(leftover)).toBe(true)
    // Witness: the check is a prefix match, not a blanket refusal.
    expect(isProtectedWorkspacePath('.gfs-download-storex/ledger-v1.json')).toBe(false)
    const info = vi.spyOn(logger, 'info')
    const removeFailed = await expiryCount('remove_failed')

    const store = await open()

    expect(store.isAvailable()).toBe(true)
    // Nothing named .gfs-download-store was found, so nothing was retired this start.
    expect(lastStartupLine(info)).toMatchObject({ retiredLegacyStore: false })
    expect(await expiryCount('remove_failed')).toBe(removeFailed)
    expect(exists(path.join(hostRoot, leftover))).toBe(false)
    expect(await hostRootEntries()).toEqual([])
  })

  it('R7: restarting with copies left by this design keeps them for accounting and does not reuse them', async () => {
    const root = callerDirectory(hostRoot, CALLER)
    const first = await open()
    const { receipt, bytes } = await completedCopy(first, root, CALLER, 9, 64)
    // Witness: before the restart the copy is reused and served.
    await expect(first.reusableReceipt(CALLER, sourceFor(9), bytes.byteLength)).resolves.toEqual(
      receipt
    )
    await first.close()
    const info = vi.spyOn(logger, 'info')

    const second = await open()

    expect(lastStartupLine(info)).toMatchObject({
      retiredLegacyStore: false,
      removedIncomplete: 0,
      retainedCompleted: 1,
      retainedBytes: bytes.byteLength,
      adopted: 1,
    })
    expect(await second.debugInventory()).toMatchObject({ bytes: bytes.byteLength, files: 1 })
    await expect(
      second.reusableReceipt(CALLER, sourceFor(9), bytes.byteLength)
    ).resolves.toBeUndefined()
    await expect(second.readManagedFile(receipt.path, CALLER)).rejects.toMatchObject({
      code: 'download_missing',
    })
    expect(exists(downloadDirectory(root, receipt.id))).toBe(true)
  })

  it('R8: after a restart the same file downloads again under a new id that is reused and served', async () => {
    const root = callerDirectory(hostRoot, CALLER)
    const first = await open()
    const before = await completedCopy(first, root, CALLER, 10, 64)
    await first.close()

    const second = await open()
    const after = await completedCopy(second, root, CALLER, 10, 64)

    expect(after.receipt.id).not.toBe(before.receipt.id)
    await expect(second.readManagedFile(after.receipt.path, CALLER)).resolves.toEqual(after.bytes)
    await expect(second.reusableReceipt(CALLER, sourceFor(10), 64)).resolves.toEqual(after.receipt)
    // The adopted copy still counts until it expires or is evicted.
    expect(await second.debugInventory()).toMatchObject({ bytes: 128, files: 2 })
  })
})
