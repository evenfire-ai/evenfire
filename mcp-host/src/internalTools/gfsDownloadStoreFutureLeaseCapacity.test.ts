import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { GfsDownloadStore } from './gfsDownloadStore'

const { statfsBoundary } = vi.hoisted(() => ({ statfsBoundary: vi.fn() }))
// Capacity is a deterministic filesystem boundary. Directory/file effects and
// their physical allocation remain real in each isolated temporary store.
vi.mock('node:fs/promises', async original => ({
  ...(await original<typeof fs>()),
  statfs: statfsBoundary,
}))
const MARGIN = 16 * 1024 * 1024
const source = {
  kind: 'gfs' as const,
  drive: 'main',
  resourceId: 'a'.repeat(32),
  gfsUri: `gfs://main/${'a'.repeat(32)}`,
  name: 'input.csv',
  version: 7,
}
let nativeFs: typeof fs
let roots: string[]
let stores: GfsDownloadStore[]
let children: ChildProcess[]
beforeEach(async () => {
  nativeFs = await vi.importActual<typeof fs>('node:fs/promises')
  statfsBoundary.mockImplementation(nativeFs.statfs)
  roots = []
  stores = []
  children = []
})
afterEach(async () => {
  vi.restoreAllMocks()
  statfsBoundary.mockImplementation(nativeFs.statfs)
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null)
      await new Promise<void>(resolve => {
        child.once('exit', () => resolve())
        child.kill('SIGKILL')
      })
  for (const store of stores)
    await store.close(0).catch(async () => {
      await (
        store as unknown as { writerLease?: { release(): Promise<void> } }
      ).writerLease?.release()
    })
  for (const root of roots) await nativeFs.rm(root, { recursive: true, force: true })
})
async function setup(extra: Record<string, string> = {}) {
  const keys = {
    MCP_HOST_GFS_MAX_FILE_BYTES: '20',
    MCP_HOST_GFS_DOWNLOAD_STORAGE_BYTES: '100',
    MCP_HOST_GFS_CALLER_DOWNLOAD_STORAGE_BYTES: '50',
    ...extra,
  }
  const previous = new Map(Object.keys(keys).map(key => [key, process.env[key]]))
  Object.assign(process.env, keys)
  vi.resetModules()
  const { GfsDownloadStore: Store } = await import('./gfsDownloadStore')
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const root = await nativeFs.mkdtemp(path.join(tmpdir(), 'gfs-future-capacity-'))
  roots.push(root)
  const store = new Store(root)
  stores.push(store)
  await store.initialize()
  return { root, store }
}
async function caller(root: string, identity: string) {
  const directory = path.join(root, 'users', identity)
  await nativeFs.mkdir(directory, { recursive: true, mode: 0o700 })
  return directory
}
async function copy(
  store: GfsDownloadStore,
  callerRoot: string,
  identity: string,
  bytes = 7,
  owner?: string
) {
  const transfer = await store.createTransfer({
    callerIdentity: identity,
    callerWorkspacePath: callerRoot,
    source,
    sizeBytes: bytes,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    retentionOwnerId: owner,
  })
  const body = Buffer.alloc(bytes, 65)
  await nativeFs.writeFile(path.join(callerRoot, transfer.partialPath), body)
  return store.publish(transfer.id, identity, createHash('sha256').update(body).digest('hex'))
}
async function capacity(root: string, bytes: number) {
  const observed = await nativeFs.statfs(root, { bigint: true })
  statfsBoundary.mockResolvedValue({
    ...observed,
    bsize: 4096n,
    bavail: BigInt(Math.floor(bytes / 4096)),
  })
}
async function ledger(root: string) {
  return JSON.parse(
    await nativeFs.readFile(path.join(root, '.gfs-download-store', 'ledger-v1.json'), 'utf8')
  )
}
async function executor(callerRoot: string) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const fs=require('node:fs');process.send({ready:true});process.on('message',m=>{try{process.send({body:fs.readFileSync(m.path,'utf8')})}catch(e){process.send({error:e.code})}})`,
    ],
    { cwd: callerRoot, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
  )
  children.push(child)
  await new Promise(resolve => child.once('message', resolve))
  return child
}
async function readFromExecutor(child: ChildProcess, filename: string) {
  return new Promise<any>(resolve => {
    child.once('message', resolve)
    child.send({ path: filename })
  })
}
async function settleExecutor(child: ChildProcess) {
  await new Promise<void>(resolve => {
    child.once('exit', () => resolve())
    child.kill('SIGTERM')
  })
}

describe('future execution protection and whole admission capacity', () => {
  it('protects a future published copy through an already-running empty lease and owner release', async () => {
    const { root, store } = await setup({ MCP_HOST_GFS_CALLER_DOWNLOAD_MAX_FILES: '1' })
    const callerRoot = await caller(root, 'caller-a')
    const provider = store.processingLeaseProvider('caller-a')
    const lease = await provider.acquireProcessingLease({ durationMs: 500 })
    const child = await executor(callerRoot)
    const receipt = await copy(store, callerRoot, 'caller-a', 7, 'future-owner')
    await store.releaseReceiptOwner('future-owner', 'caller-a')
    await expect(
      store.createTransfer({
        callerIdentity: 'caller-a',
        callerWorkspacePath: callerRoot,
        source,
        sizeBytes: 7,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
    ).rejects.toMatchObject({ code: 'caller_quota_exceeded' })
    expect((await ledger(root)).processingLeases[lease.leaseId].recordIds).toContain(receipt.id)
    expect(await readFromExecutor(child, path.join(callerRoot, receipt.path))).toEqual({
      body: 'AAAAAAA',
    })
    await store.cleanupExpired(
      Math.max(Date.parse(lease.expiresAt), Date.parse(receipt.expiresAt)) + 1
    )
    expect(store.debugUsage().files).toBe(1)
    await expect(store.close(0)).rejects.toMatchObject({ code: 'download_busy' })
    await settleExecutor(child)
    await provider.releaseProcessingLease(lease)
  })

  it('settles a protected failed producer without freeing its bytes or occupying the active slot', async () => {
    const { root, store } = await setup()
    const callerRoot = await caller(root, 'caller-a')
    const provider = store.processingLeaseProvider('caller-a')
    const lease = await provider.acquireProcessingLease()
    const transfer = await store.createTransfer({
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      source,
      sizeBytes: 7,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      retentionOwnerId: 'failed-owner',
    })
    await nativeFs.writeFile(path.join(callerRoot, transfer.partialPath), 'partial')
    await store.fail(transfer.id, 'caller-a')
    expect(store.debugRecord(transfer.id)).toMatchObject({ state: 'cleanup_failed', sizeBytes: 7 })
    expect(store.debugUsage().files).toBe(1)
    await store.releaseReceiptOwner('failed-owner', 'caller-a')
    expect(await nativeFs.readFile(path.join(callerRoot, transfer.partialPath), 'utf8')).toBe(
      'partial'
    )
    const next = await store.createTransfer({
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      source,
      sizeBytes: 7,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await store.fail(next.id, 'caller-a')
    await provider.releaseProcessingLease(lease)
    expect(store.debugUsage().files).toBe(0)
    await store.close(0)
  })

  it('covers an already-transferring path when a new execution lease is admitted', async () => {
    const { root, store } = await setup()
    const callerRoot = await caller(root, 'caller-a')
    const transfer = await store.createTransfer({
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      source,
      sizeBytes: 7,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await nativeFs.writeFile(path.join(callerRoot, transfer.partialPath), 'partial')
    const provider = store.processingLeaseProvider('caller-a')
    const lease = await provider.acquireProcessingLease()
    expect((await ledger(root)).processingLeases[lease.leaseId].recordIds).toContain(transfer.id)
    await store.fail(transfer.id, 'caller-a')
    expect(await nativeFs.readFile(path.join(callerRoot, transfer.partialPath), 'utf8')).toBe(
      'partial'
    )
    await provider.releaseProcessingLease(lease)
    expect(store.debugUsage().files).toBe(0)
  })

  it('rolls back future lease references when reservation persistence fails before exposure', async () => {
    const { root, store } = await setup()
    const callerRoot = await caller(root, 'caller-a')
    const provider = store.processingLeaseProvider('caller-a')
    const lease = await provider.acquireProcessingLease()
    const before = await ledger(root)
    // Inject a failure before the real journal producer starts; no directory,
    // record ID or consumer path has been physically exposed.
    vi.spyOn(store as unknown as { persist(): Promise<void> }, 'persist').mockRejectedValueOnce(
      new Error('reservation unavailable')
    )
    await expect(
      store.createTransfer({
        callerIdentity: 'caller-a',
        callerWorkspacePath: callerRoot,
        source,
        sizeBytes: 7,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        retentionOwnerId: 'unpublished-owner',
      })
    ).rejects.toThrow('reservation unavailable')
    expect(store.debugUsage().files).toBe(0)
    expect(await ledger(root)).toEqual(before)
    await expect(nativeFs.lstat(path.join(callerRoot, '.gfs-downloads'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    const privateStore = store as unknown as {
      ledger: { processingLeases: Record<string, { recordIds: string[] }> }
    }
    expect(privateStore.ledger.processingLeases[lease.leaseId].recordIds).toEqual([])
    await provider.releaseProcessingLease(lease)
  })

  it('settles cancelled publication while a preexisting executor retains its partial protection', async () => {
    const { root, store } = await setup()
    const callerRoot = await caller(root, 'caller-a')
    const provider = store.processingLeaseProvider('caller-a')
    const lease = await provider.acquireProcessingLease()
    const transfer = await store.createTransfer({
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      source,
      sizeBytes: 7,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await nativeFs.writeFile(path.join(callerRoot, transfer.partialPath), 'partial')
    const controller = new AbortController()
    controller.abort()
    await expect(
      store.publish(transfer.id, 'caller-a', createHash('sha256').update('partial').digest('hex'), {
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: 'publication_cancelled' })
    await store.fail(transfer.id, 'caller-a')
    expect(store.debugRecord(transfer.id)).toMatchObject({ state: 'cleanup_failed', sizeBytes: 7 })
    expect((await ledger(root)).processingLeases[lease.leaseId].recordIds).toContain(transfer.id)
    await expect(store.close(0)).rejects.toMatchObject({ code: 'download_busy' })
    await provider.releaseProcessingLease(lease)
    expect(store.debugUsage().files).toBe(0)
    await store.close(0)
  })

  it('rejects impossible physical margin before evicting another caller at a logical quota boundary', async () => {
    const { root, store } = await setup()
    const otherRoot = await caller(root, 'caller-b')
    const receipts = []
    for (let index = 0; index < 5; index++)
      receipts.push(await copy(store, otherRoot, 'caller-b', 10))
    const requestRoot = await caller(root, 'caller-a')
    // Add durable, protected charges to make aggregate 100 while requester has room.
    for (const identity of ['caller-c', 'caller-d', 'caller-e', 'caller-f', 'caller-g'])
      await copy(store, await caller(root, identity), identity, 10, `${identity}-owner`)
    await capacity(root, 0)
    await expect(
      store.createTransfer({
        callerIdentity: 'caller-a',
        callerWorkspacePath: requestRoot,
        source,
        sizeBytes: 20,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
    ).rejects.toMatchObject({ code: 'host_quota_exceeded' })
    expect(store.debugUsage()).toMatchObject({ bytes: 100, files: 10 })
    for (const receipt of receipts) expect(store.debugRecord(receipt.id)).toBeDefined()
    for (const identity of ['caller-c', 'caller-d', 'caller-e', 'caller-f', 'caller-g'])
      await store.releaseReceiptOwner(`${identity}-owner`, identity)
  })

  it('keeps all default-cap small copies when current physical capacity is zero', async () => {
    const { root, store } = await setup({
      MCP_HOST_GFS_MAX_FILE_BYTES: '1024',
      MCP_HOST_GFS_DOWNLOAD_STORAGE_BYTES: String(1024 * 1024),
      MCP_HOST_GFS_CALLER_DOWNLOAD_STORAGE_BYTES: String(128 * 1024),
    })
    const receipts = []
    for (let index = 0; index < 8; index++) {
      const identity = `caller-${index}`
      const directory = await caller(root, identity)
      for (let file = 0; file < 8; file++) receipts.push(await copy(store, directory, identity, 1))
    }
    await capacity(root, 0)
    await expect(
      store.createTransfer({
        callerIdentity: 'caller-new',
        callerWorkspacePath: await caller(root, 'caller-new'),
        source,
        sizeBytes: 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
    ).rejects.toMatchObject({ code: 'host_quota_exceeded' })
    expect(store.debugUsage().files).toBe(64)
    for (const receipt of receipts) expect(store.debugRecord(receipt.id)).toBeDefined()
  })

  it('respects pending active reservations before any cache-pressure effect', async () => {
    const { root, store } = await setup({ MCP_HOST_GFS_CALLER_DOWNLOAD_MAX_FILES: '1' })
    const cachedRoot = await caller(root, 'caller-a')
    const receipt = await copy(store, cachedRoot, 'caller-a', 7)
    const active = await store.createTransfer({
      callerIdentity: 'caller-b',
      callerWorkspacePath: await caller(root, 'caller-b'),
      source,
      sizeBytes: 7,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await capacity(root, MARGIN + 4096)
    await expect(
      store.createTransfer({
        callerIdentity: 'caller-a',
        callerWorkspacePath: cachedRoot,
        source,
        sizeBytes: 7,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
    ).rejects.toMatchObject({ code: 'host_quota_exceeded' })
    expect(store.debugRecord(receipt.id)).toBeDefined()
    await store.fail(active.id, 'caller-b')
  })

  it('never credits sparse apparent bytes as available physical capacity', async () => {
    const bytes = 16 * 1024 * 1024
    const { root, store } = await setup({
      MCP_HOST_GFS_MAX_FILE_BYTES: String(bytes),
      MCP_HOST_GFS_DOWNLOAD_STORAGE_BYTES: String(bytes * 4),
      MCP_HOST_GFS_CALLER_DOWNLOAD_STORAGE_BYTES: String(bytes * 2),
      MCP_HOST_GFS_CALLER_DOWNLOAD_MAX_FILES: '1',
    })
    const callerRoot = await caller(root, 'caller-a')
    const transfer = await store.createTransfer({
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      source,
      sizeBytes: bytes,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const handle = await nativeFs.open(path.join(callerRoot, transfer.partialPath), 'r+')
    await handle.truncate(bytes)
    await handle.close()
    const sparse = await nativeFs.stat(path.join(callerRoot, transfer.partialPath))
    expect(sparse.blocks * 512).toBeLessThan(sparse.size)
    const receipt = await store.publish(
      transfer.id,
      'caller-a',
      createHash('sha256').update(Buffer.alloc(bytes)).digest('hex')
    )
    await capacity(root, 0)
    await expect(
      store.createTransfer({
        callerIdentity: 'caller-a',
        callerWorkspacePath: callerRoot,
        source,
        sizeBytes: 7,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
    ).rejects.toMatchObject({ code: 'host_quota_exceeded' })
    expect(store.debugRecord(receipt.id)).toBeDefined()
    expect((await nativeFs.stat(path.join(callerRoot, receipt.path))).size).toBe(bytes)
  })

  it('refuses admission if real capacity changes after a positively settled victim', async () => {
    const { root, store } = await setup({ MCP_HOST_GFS_CALLER_DOWNLOAD_MAX_FILES: '1' })
    const callerRoot = await caller(root, 'caller-a')
    const receipt = await copy(store, callerRoot, 'caller-a', 7)
    const directory = path.join(callerRoot, path.dirname(receipt.path))
    const observed = await nativeFs.statfs(root, { bigint: true })
    statfsBoundary.mockImplementation(async () => {
      try {
        await nativeFs.lstat(directory)
        return observed
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return { ...observed, bavail: 0n }
      }
    })
    await expect(
      store.createTransfer({
        callerIdentity: 'caller-a',
        callerWorkspacePath: callerRoot,
        source,
        sizeBytes: 7,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
    ).rejects.toMatchObject({ code: 'host_quota_exceeded' })
    expect(store.debugUsage().files).toBe(0)
    await expect(nativeFs.lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reclaims logical quota and admits when real physical capacity is already sufficient', async () => {
    const { root, store } = await setup({ MCP_HOST_GFS_CALLER_DOWNLOAD_MAX_FILES: '1' })
    const callerRoot = await caller(root, 'caller-a')
    const receipt = await copy(store, callerRoot, 'caller-a', 7)
    const before = await nativeFs.statfs(root, { bigint: true })
    expect(before.bavail * before.bsize).toBeGreaterThan(BigInt(MARGIN + 4096))
    const next = await store.createTransfer({
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      source,
      sizeBytes: 7,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    expect(store.debugRecord(receipt.id)).toBeUndefined()
    await expect(
      nativeFs.lstat(path.join(callerRoot, path.dirname(receipt.path)))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(store.debugRecord(next.id)).toBeDefined()
    await store.fail(next.id, 'caller-a')
  })
})
