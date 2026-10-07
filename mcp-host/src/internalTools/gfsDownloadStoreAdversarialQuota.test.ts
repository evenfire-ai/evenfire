import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { GfsDownloadStore } from './gfsDownloadStore'
import { GFS_FILE_LIMITS } from './gfsFilePolicy'

/**
 * Adversarial quota/reuse/rollback regression probes.
 *
 * These are mutation-sensitive on purpose: each block fails when its guard is
 * removed from gfsDownloadStore.ts. Pressure eviction is expected, so every
 * denial assertion keeps its targets protected with an explicit receipt owner
 * or a live processing lease; positive blocks assert the earliest-created
 * eligible copy is the one reclaimed.
 */

interface ProbeSource {
  kind: 'gfs'
  drive: string
  resourceId: string
  gfsUri: string
  name: string
  version: number
}

function sourceFor(index: number, version: number): ProbeSource {
  const resourceId = index.toString(16).padStart(32, '0')
  return {
    kind: 'gfs',
    drive: 'main',
    resourceId,
    gfsUri: `gfs://main/${resourceId}`,
    name: `fixture-${index}.bin`,
    version,
  }
}

function future(ms = 60_000): string {
  return new Date(Date.now() + ms).toISOString()
}

const CALLER = 'caller-a'

let hostRoot: string
let callerRoot: string
let store: GfsDownloadStore

async function callerDirectory(host: string, caller: string): Promise<string> {
  const root = path.join(host, 'users', caller)
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  return root
}

async function completedCopy(
  target: GfsDownloadStore,
  root: string,
  caller: string,
  index: number,
  version: number,
  sizeBytes: number,
  retentionOwnerId?: string
) {
  const bytes = Buffer.alloc(sizeBytes, index % 251)
  const transfer = await target.createTransfer({
    callerIdentity: caller,
    callerWorkspacePath: root,
    source: sourceFor(index, version),
    sizeBytes,
    expiresAt: future(),
    ...(retentionOwnerId === undefined ? {} : { retentionOwnerId }),
  })
  await fs.writeFile(path.join(root, transfer.partialPath), bytes)
  return target.publish(transfer.id, caller, createHash('sha256').update(bytes).digest('hex'))
}

async function readLedger(host: string): Promise<{
  records: Record<string, { id: string; state: string; sizeBytes: number }>
  retentionOwners?: Record<string, { ownerId: string; callerIdentity: string; recordIds: string[] }>
}> {
  return JSON.parse(
    await fs.readFile(path.join(host, '.gfs-download-store', 'ledger-v1.json'), 'utf8')
  )
}

async function forceAgeOrder(target: GfsDownloadStore, ids: string[]): Promise<void> {
  const base = Date.now() - 60_000
  for (const [index, id] of ids.entries()) {
    target.debugRecord(id)!.createdAt = new Date(base + index).toISOString()
  }
  await target.debugPersist()
}

async function loadLimitedStore(env: Record<string, string>) {
  const saved = { ...process.env }
  Object.assign(process.env, env)
  vi.resetModules()
  const storeModule = await import('./gfsDownloadStore')
  const policyModule = await import('./gfsFilePolicy')
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return { Store: storeModule.GfsDownloadStore, limits: policyModule.GFS_FILE_LIMITS }
}

/** Host 100 / caller 50 / max 20: the boundary the feasibility plan must respect. */
async function withLimitedStore(
  run: (limited: GfsDownloadStore, host: string) => Promise<void>
): Promise<void> {
  const { Store, limits } = await loadLimitedStore({
    MCP_HOST_GFS_MAX_FILE_BYTES: '20',
    MCP_HOST_GFS_DOWNLOAD_STORAGE_BYTES: '100',
    MCP_HOST_GFS_CALLER_DOWNLOAD_STORAGE_BYTES: '50',
  })
  expect(limits).toMatchObject({ maxFileBytes: 20, storageBytes: 100, callerStorageBytes: 50 })
  const host = await fs.mkdtemp(path.join(tmpdir(), 'gfs-adversarial-limits-'))
  const limited = new Store(host)
  await limited.initialize()
  try {
    await run(limited, host)
  } finally {
    await limited.close(0).catch(() => undefined)
    await fs.rm(host, { recursive: true, force: true })
  }
}

/** caller-a: pinned 20+20+10. caller-b: unpinned 5x10. Host at 100/100. */
async function seedCrossCallerPressure(
  target: GfsDownloadStore,
  host: string,
  pinnedOwner: string
): Promise<{ pinned: string[]; unpinned: string[]; aRoot: string; bRoot: string }> {
  const aRoot = await callerDirectory(host, 'caller-a')
  const bRoot = await callerDirectory(host, 'caller-b')
  const pinned: string[] = []
  const unpinned: string[] = []
  let index = 0
  for (const size of [20, 20, 10]) {
    index += 1
    pinned.push((await completedCopy(target, aRoot, 'caller-a', index, 1, size, pinnedOwner)).id)
  }
  for (let file = 0; file < 5; file += 1) {
    index += 1
    unpinned.push((await completedCopy(target, bRoot, 'caller-b', index, 1, 10)).id)
  }
  return { pinned, unpinned, aRoot, bRoot }
}

beforeEach(async () => {
  hostRoot = await fs.mkdtemp(path.join(tmpdir(), 'gfs-adversarial-quota-'))
  callerRoot = await callerDirectory(hostRoot, CALLER)
  store = new GfsDownloadStore(hostRoot)
  await store.initialize()
})

afterEach(async () => {
  await store.close(0).catch(() => undefined)
  await fs.rm(hostRoot, { recursive: true, force: true })
})

describe('GFS download store adversarial quota', () => {
  it('evicts the earliest-created eligible copy under caller pressure and admits', async () => {
    const size = GFS_FILE_LIMITS.inlineTextBytes + 1
    const receipts = []
    for (let index = 1; index <= GFS_FILE_LIMITS.callerRetainedFiles; index += 1)
      receipts.push(await completedCopy(store, callerRoot, CALLER, index, 1, size))
    const ids = receipts.map(receipt => receipt.id)
    await forceAgeOrder(store, ids)

    const next = await store.createTransfer({
      callerIdentity: CALLER,
      callerWorkspacePath: callerRoot,
      source: sourceFor(90, 1),
      sizeBytes: size,
      expiresAt: future(),
    })

    expect(store.debugRecord(ids[0])).toBeUndefined()
    for (const id of ids.slice(1))
      expect(store.debugRecord(id)).toMatchObject({ state: 'completed' })
    expect(store.debugRecord(next.id)).toMatchObject({ state: 'transferring' })
    expect(store.debugUsage()).toMatchObject({
      files: GFS_FILE_LIMITS.callerRetainedFiles,
      callerFiles: { [CALLER]: GFS_FILE_LIMITS.callerRetainedFiles },
    })
    await expect(
      fs.stat(path.join(callerRoot, path.dirname(receipts[0].path)))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await store.fail(next.id, CALLER)
  })

  it('keeps a protected oldest copy and evicts the next eligible copy', async () => {
    const size = GFS_FILE_LIMITS.inlineTextBytes + 1
    const receipts = []
    for (let index = 1; index <= GFS_FILE_LIMITS.callerRetainedFiles; index += 1)
      receipts.push(
        await completedCopy(
          store,
          callerRoot,
          CALLER,
          index,
          1,
          size,
          index === 1 ? 'oldest-owner' : undefined
        )
      )
    const ids = receipts.map(receipt => receipt.id)
    await forceAgeOrder(store, ids)

    const next = await store.createTransfer({
      callerIdentity: CALLER,
      callerWorkspacePath: callerRoot,
      source: sourceFor(91, 1),
      sizeBytes: size,
      expiresAt: future(),
    })

    expect(store.debugRecord(ids[0])).toMatchObject({ state: 'completed' })
    expect(store.debugRecord(ids[1])).toBeUndefined()
    for (const id of ids.slice(2))
      expect(store.debugRecord(id)).toMatchObject({ state: 'completed' })
    expect(store.debugUsage()).toMatchObject({ files: GFS_FILE_LIMITS.callerRetainedFiles })
    await store.releaseReceiptOwner('oldest-owner', CALLER)
    await store.fail(next.id, CALLER)
  })

  it('denies admission when the host aggregate byte charge cannot be evicted', async () => {
    const receipt = await completedCopy(store, callerRoot, CALLER, 1, 1, 8, 'byte-owner')
    store.debugRecord(receipt.id)!.sizeBytes = GFS_FILE_LIMITS.storageBytes - 1024
    await store.debugPersist()

    // The requesting caller must have zero charges so the caller-first quota
    // check cannot mask the host aggregate guard.
    const otherRoot = await callerDirectory(hostRoot, 'caller-b')
    await expect(
      store.createTransfer({
        callerIdentity: 'caller-b',
        callerWorkspacePath: otherRoot,
        source: sourceFor(2, 1),
        sizeBytes: 4096,
        expiresAt: future(),
      })
    ).rejects.toMatchObject({ code: 'host_quota_exceeded' })
    expect(store.debugRecord(receipt.id)).toMatchObject({ state: 'completed' })
    expect(store.debugUsage()).toMatchObject({ files: 1, callerFiles: { [CALLER]: 1 } })
    expect(Object.keys(store.debugUsage().callerFiles)).toEqual([CALLER])
    await store.releaseReceiptOwner('byte-owner', CALLER)
  })

  it('denies the 65th pinned record at the host retained-file cap', async () => {
    const callers: string[] = []
    for (let callerIndex = 0; callerIndex < 8; callerIndex += 1) {
      const caller = `caller-${callerIndex}`
      const root = await callerDirectory(hostRoot, caller)
      callers.push(caller)
      for (let file = 0; file < GFS_FILE_LIMITS.callerRetainedFiles; file += 1) {
        await completedCopy(store, root, caller, callerIndex * 10 + file, 1, 1, `${caller}-owner`)
      }
    }
    expect(store.debugUsage()).toMatchObject({ files: 64 })

    const freshRoot = await callerDirectory(hostRoot, 'caller-z')
    await expect(
      store.createTransfer({
        callerIdentity: 'caller-z',
        callerWorkspacePath: freshRoot,
        source: sourceFor(999, 1),
        sizeBytes: 1,
        expiresAt: future(),
      })
    ).rejects.toMatchObject({ code: 'host_quota_exceeded' })
    expect(store.debugUsage()).toMatchObject({ files: 64 })
    for (const caller of callers) await store.releaseReceiptOwner(`${caller}-owner`, caller)
    // 64 durable publications at 5 fsyncs each measured 2.2-4.7 s on a loaded
    // host, which leaves no margin inside Vitest's 5 s default.
  }, 30_000)

  it('rolls back charge, owner pins, and active slots when mkdir fails with proven absence', async () => {
    await fs.chmod(callerRoot, 0o500)
    try {
      await expect(
        store.createTransfer({
          callerIdentity: CALLER,
          callerWorkspacePath: callerRoot,
          source: sourceFor(1, 1),
          sizeBytes: 16,
          expiresAt: future(),
          retentionOwnerId: 'rollback-owner',
        })
      ).rejects.toMatchObject({ code: 'storage_write_failed' })
    } finally {
      await fs.chmod(callerRoot, 0o700)
    }

    expect(store.debugUsage()).toEqual({ bytes: 0, files: 0, callerBytes: {}, callerFiles: {} })
    const ledger = await readLedger(hostRoot)
    expect(ledger.records).toEqual({})
    expect(ledger.retentionOwners ?? {}).toEqual({})
    await expect(fs.stat(path.join(callerRoot, '.gfs-downloads'))).rejects.toMatchObject({
      code: 'ENOENT',
    })

    const retry = await store.createTransfer({
      callerIdentity: CALLER,
      callerWorkspacePath: callerRoot,
      source: sourceFor(2, 1),
      sizeBytes: 16,
      expiresAt: future(),
    })
    expect(store.debugRecord(retry.id)).toMatchObject({ state: 'transferring' })
    await store.fail(retry.id, CALLER)
  })

  it('retains the charged record and its owner pin when absence is ambiguous', async () => {
    const cacheRoot = path.join(callerRoot, '.gfs-downloads')
    await fs.mkdir(cacheRoot, { mode: 0o700 })
    await fs.chmod(cacheRoot, 0o777)

    await expect(
      store.createTransfer({
        callerIdentity: CALLER,
        callerWorkspacePath: callerRoot,
        source: sourceFor(1, 1),
        sizeBytes: 16,
        expiresAt: future(),
        retentionOwnerId: 'ambiguous-owner',
      })
    ).rejects.toMatchObject({ code: 'storage_write_failed' })

    const ledger = await readLedger(hostRoot)
    const records = Object.values(ledger.records)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ state: 'cleanup_failed', sizeBytes: 16 })
    expect(ledger.retentionOwners?.['ambiguous-owner']?.recordIds).toEqual([records[0].id])
    expect(store.debugUsage()).toMatchObject({ bytes: 16, files: 1, callerFiles: { [CALLER]: 1 } })

    // Active slots must be released even though the charge stays reserved.
    const secondRoot = await callerDirectory(hostRoot, 'caller-b')
    const thirdRoot = await callerDirectory(hostRoot, 'caller-c')
    const second = await store.createTransfer({
      callerIdentity: 'caller-b',
      callerWorkspacePath: secondRoot,
      source: sourceFor(11, 1),
      sizeBytes: 16,
      expiresAt: future(),
    })
    const third = await store.createTransfer({
      callerIdentity: 'caller-c',
      callerWorkspacePath: thirdRoot,
      source: sourceFor(12, 1),
      sizeBytes: 16,
      expiresAt: future(),
    })
    await store.fail(second.id, 'caller-b')
    await store.fail(third.id, 'caller-c')
    await store.releaseReceiptOwner('ambiguous-owner', CALLER)
  })

  it('reuses only the exact version and size, and the reuse-time pin protects the copy', async () => {
    const receipt = await completedCopy(store, callerRoot, CALLER, 1, 7, 4096)
    await expect(
      store.reusableReceipt(CALLER, sourceFor(1, 7), 4096, { retentionOwnerId: 'reuse-owner' })
    ).resolves.toMatchObject({ id: receipt.id, sizeBytes: 4096, source: sourceFor(1, 7) })
    await expect(store.reusableReceipt(CALLER, sourceFor(1, 8), 4096)).resolves.toBeUndefined()
    await expect(store.reusableReceipt(CALLER, sourceFor(1, 7), 4097)).resolves.toBeUndefined()

    for (let index = 2; index <= GFS_FILE_LIMITS.callerRetainedFiles; index += 1)
      await completedCopy(store, callerRoot, CALLER, index, 1, 4096, 'filler-owner')
    await expect(
      store.createTransfer({
        callerIdentity: CALLER,
        callerWorkspacePath: callerRoot,
        source: sourceFor(50, 1),
        sizeBytes: 4096,
        expiresAt: future(),
      })
    ).rejects.toMatchObject({ code: 'caller_quota_exceeded' })
    expect(store.debugRecord(receipt.id)).toMatchObject({ state: 'completed' })
    await store.releaseReceiptOwner('reuse-owner', CALLER)
    await store.releaseReceiptOwner('filler-owner', CALLER)
  })

  it('protects copies held by a live processing lease from pressure eviction', async () => {
    const size = GFS_FILE_LIMITS.inlineTextBytes + 1
    const receipts = []
    for (let index = 1; index <= GFS_FILE_LIMITS.callerRetainedFiles; index += 1)
      receipts.push(await completedCopy(store, callerRoot, CALLER, index, 1, size))

    const provider = store.processingLeaseProvider(CALLER)
    const lease = await provider.acquireProcessingLease({ durationMs: 60_000 })
    const pressure = {
      callerIdentity: CALLER,
      callerWorkspacePath: callerRoot,
      source: sourceFor(92, 1),
      sizeBytes: size,
      expiresAt: future(),
    }
    await expect(store.createTransfer(pressure)).rejects.toMatchObject({
      code: 'caller_quota_exceeded',
    })
    for (const receipt of receipts)
      expect(store.debugRecord(receipt.id)).toMatchObject({ state: 'completed' })

    await provider.releaseProcessingLease(lease)
    const next = await store.createTransfer(pressure)
    expect(store.debugUsage()).toMatchObject({ files: GFS_FILE_LIMITS.callerRetainedFiles })
    await store.fail(next.id, CALLER)
  })

  it('releases a receipt owner only for the owning caller and then allows eviction', async () => {
    const size = GFS_FILE_LIMITS.inlineTextBytes + 1
    for (let index = 1; index <= GFS_FILE_LIMITS.callerRetainedFiles; index += 1)
      await completedCopy(store, callerRoot, CALLER, index, 1, size, 'release-owner')

    await expect(store.releaseReceiptOwner('release-owner', 'caller-b')).rejects.toMatchObject({
      code: 'caller_mismatch',
    })
    await expect(store.releaseReceiptOwner('missing-owner', CALLER)).resolves.toBeUndefined()
    const pressure = {
      callerIdentity: CALLER,
      callerWorkspacePath: callerRoot,
      source: sourceFor(93, 1),
      sizeBytes: size,
      expiresAt: future(),
    }
    await expect(store.createTransfer(pressure)).rejects.toMatchObject({
      code: 'caller_quota_exceeded',
    })

    await store.releaseReceiptOwner('release-owner', CALLER)
    const next = await store.createTransfer(pressure)
    expect(store.debugUsage()).toMatchObject({ files: GFS_FILE_LIMITS.callerRetainedFiles })
    await store.fail(next.id, CALLER)
  })

  it('fences the host on an inherited executor and adopts a verified inherited pin only after revalidation', async () => {
    const receipt = await completedCopy(store, callerRoot, CALLER, 1, 1, 7)
    await store.close()

    const ledgerPath = path.join(hostRoot, '.gfs-download-store', 'ledger-v1.json')
    const readLedger = async () => JSON.parse(await fs.readFile(ledgerPath, 'utf8'))
    const writeLedger = async (value: unknown) => fs.writeFile(ledgerPath, JSON.stringify(value))
    const foreignSession = '00000000-0000-4000-8000-000000000000'

    // Phase 1: an inherited PROCESSING LEASE is an unknown executor. The Host
    // fences, every managed copy quarantines, and no admission or release runs.
    let ledger = await readLedger()
    ledger.processingLeases = {
      '11111111-1111-4111-8111-111111111111': {
        leaseId: '11111111-1111-4111-8111-111111111111',
        callerIdentity: CALLER,
        recordIds: [receipt.id],
        acquiredAt: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: new Date(Date.now() + GFS_FILE_LIMITS.retentionMs).toISOString(),
        writerSessionId: foreignSession,
      },
    }
    await writeLedger(ledger)

    let reopened = new GfsDownloadStore(hostRoot)
    await reopened.initialize()
    expect(reopened.debugRecord(receipt.id)).toMatchObject({ state: 'quarantined' })
    expect(reopened.isAvailable()).toBe(false)
    expect(reopened.debugUsage()).toMatchObject({ bytes: 7, files: 1 })
    await expect(reopened.reusableReceipt(CALLER, sourceFor(1, 1), 7)).rejects.toMatchObject({
      code: 'download_busy',
    })
    await expect(
      reopened.createTransfer({
        callerIdentity: CALLER,
        callerWorkspacePath: callerRoot,
        source: sourceFor(2, 1),
        sizeBytes: 7,
        expiresAt: future(),
      })
    ).rejects.toMatchObject({ code: 'download_busy' })
    await expect(reopened.releaseReceiptOwner('carry-owner', CALLER)).rejects.toMatchObject({
      code: 'download_busy',
    })
    await reopened.cleanupExpired(Date.now() + GFS_FILE_LIMITS.retentionMs * 10)
    expect(reopened.debugRecord(receipt.id)).toMatchObject({ state: 'quarantined' })
    await reopened.close()

    // Phase 2: even an empty inherited lease fences the Host.
    ledger = await readLedger()
    ledger.processingLeases = {
      '22222222-2222-4222-8222-222222222222': {
        leaseId: '22222222-2222-4222-8222-222222222222',
        callerIdentity: CALLER,
        recordIds: [],
        acquiredAt: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: new Date(Date.now() + GFS_FILE_LIMITS.retentionMs).toISOString(),
        writerSessionId: foreignSession,
      },
    }
    await writeLedger(ledger)
    reopened = new GfsDownloadStore(hostRoot)
    await reopened.initialize()
    expect(reopened.isAvailable()).toBe(false)
    expect(reopened.debugRecord(receipt.id)).toMatchObject({ state: 'quarantined' })
    await reopened.close()

    // Phase 3: receipt-only inherited pins are not executors. Integrity-checked
    // copies stay completed and protective, and a same-caller reuse may adopt
    // the exact owner after version/size/hash validation; other pins survive.
    ledger = await readLedger()
    ledger.processingLeases = {}
    ledger.records[receipt.id].state = 'completed'
    ledger.retentionOwners = {
      'carry-owner': {
        ownerId: 'carry-owner',
        callerIdentity: CALLER,
        writerSessionId: foreignSession,
        recordIds: [receipt.id],
      },
      'other-owner': {
        ownerId: 'other-owner',
        callerIdentity: CALLER,
        writerSessionId: foreignSession,
        recordIds: [receipt.id],
      },
    }
    await writeLedger(ledger)

    reopened = new GfsDownloadStore(hostRoot)
    await reopened.initialize()
    expect(reopened.isAvailable()).toBe(true)
    expect(reopened.debugRecord(receipt.id)).toMatchObject({ state: 'completed' })
    expect((await readLedger()).retentionOwners['carry-owner'].writerSessionId).toBe(foreignSession)

    await expect(
      reopened.reusableReceipt(CALLER, sourceFor(1, 1), 7, { retentionOwnerId: 'carry-owner' })
    ).resolves.toMatchObject({ id: receipt.id })
    const adopted = (await readLedger()).retentionOwners
    expect(adopted['carry-owner'].writerSessionId).not.toBe(foreignSession)
    expect(adopted['other-owner'].writerSessionId).toBe(foreignSession)
    expect(adopted['other-owner'].recordIds).toEqual([receipt.id])

    const fillers = []
    for (let index = 2; index <= GFS_FILE_LIMITS.callerRetainedFiles; index += 1)
      fillers.push(await completedCopy(reopened, callerRoot, CALLER, index, 1, 7, 'filler-owner'))
    await forceAgeOrder(reopened, [receipt.id, ...fillers.map(filler => filler.id)])
    const pressure = {
      callerIdentity: CALLER,
      callerWorkspacePath: callerRoot,
      source: sourceFor(94, 1),
      sizeBytes: 7,
      expiresAt: future(),
    }
    await expect(reopened.createTransfer(pressure)).rejects.toMatchObject({
      code: 'caller_quota_exceeded',
    })
    expect(reopened.debugRecord(receipt.id)).toMatchObject({ state: 'completed' })

    await reopened.releaseReceiptOwner('carry-owner', CALLER)
    await reopened.releaseReceiptOwner('other-owner', CALLER)
    await reopened.releaseReceiptOwner('filler-owner', CALLER)
    const next = await reopened.createTransfer(pressure)
    expect(reopened.debugRecord(receipt.id)).toBeUndefined()
    await reopened.fail(next.id, CALLER)
    await reopened.close()
  })

  it('denies a caller at its own limit without evicting another caller copy', async () => {
    await withLimitedStore(async (limited, host) => {
      const { pinned, unpinned, aRoot } = await seedCrossCallerPressure(limited, host, 'a-owner')
      expect(limited.debugUsage()).toMatchObject({ bytes: 100, files: 8 })

      // caller-a needs 50 more than its own budget allows; no eviction plan can
      // make it admissible, so caller-b copies must survive untouched.
      await expect(
        limited.createTransfer({
          callerIdentity: 'caller-a',
          callerWorkspacePath: aRoot,
          source: sourceFor(500, 1),
          sizeBytes: 20,
          expiresAt: future(),
        })
      ).rejects.toMatchObject({ code: 'caller_quota_exceeded' })

      for (const id of [...pinned, ...unpinned])
        expect(limited.debugRecord(id)).toMatchObject({ state: 'completed' })
      expect(limited.debugUsage()).toMatchObject({ bytes: 100, files: 8 })
      await limited.releaseReceiptOwner('a-owner', 'caller-a')
    })
  })

  it('rejects an invalid retention owner before any reclaim or eviction', async () => {
    await withLimitedStore(async (limited, host) => {
      const { pinned, unpinned, bRoot } = await seedCrossCallerPressure(limited, host, 'a-owner')
      const cRoot = await callerDirectory(host, 'caller-c')

      await expect(
        limited.createTransfer({
          callerIdentity: 'caller-c',
          callerWorkspacePath: cRoot,
          source: sourceFor(600, 1),
          sizeBytes: 20,
          expiresAt: future(),
          retentionOwnerId: '__proto__',
        })
      ).rejects.toMatchObject({ code: 'caller_mismatch' })

      for (const id of [...pinned, ...unpinned])
        expect(limited.debugRecord(id)).toMatchObject({ state: 'completed' })
      expect(limited.debugUsage()).toMatchObject({ bytes: 100, files: 8 })
      const survivor = limited.debugRecord(unpinned[0])!
      await expect(fs.stat(path.join(bRoot, path.dirname(survivor.path)))).resolves.toBeTruthy()
      await limited.releaseReceiptOwner('a-owner', 'caller-a')
    })
  })

  it('evicts the earliest eligible cross-caller copy when the host plan is feasible', async () => {
    await withLimitedStore(async (limited, host) => {
      const receipts = []
      for (let callerIndex = 0; callerIndex < 5; callerIndex += 1) {
        const caller = `caller-${callerIndex}`
        const root = await callerDirectory(host, caller)
        receipts.push(await completedCopy(limited, root, caller, 700 + callerIndex, 1, 20))
      }
      expect(limited.debugUsage()).toMatchObject({ bytes: 100, files: 5 })
      await forceAgeOrder(
        limited,
        receipts.map(receipt => receipt.id)
      )

      const freshRoot = await callerDirectory(host, 'caller-new')
      const next = await limited.createTransfer({
        callerIdentity: 'caller-new',
        callerWorkspacePath: freshRoot,
        source: sourceFor(800, 1),
        sizeBytes: 20,
        expiresAt: future(),
      })

      expect(limited.debugRecord(receipts[0].id)).toBeUndefined()
      for (const receipt of receipts.slice(1))
        expect(limited.debugRecord(receipt.id)).toMatchObject({ state: 'completed' })
      expect(limited.debugUsage()).toMatchObject({ bytes: 100, files: 5 })
      await limited.fail(next.id, 'caller-new')
    })
  })
})
