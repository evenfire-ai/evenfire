import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { GfsImageSource } from '../visualInput/policy'
import { GfsDownloadStore } from './gfsDownloadStore'
import { GFS_FILE_LIMITS } from './gfsFilePolicy'

const source: GfsImageSource = {
  kind: 'gfs',
  drive: 'main',
  resourceId: 'a'.repeat(32),
  gfsUri: `gfs://main/${'a'.repeat(32)}`,
  name: 'input.csv',
  version: 7,
}

let hostRoot: string
let callerRoot: string
let store: GfsDownloadStore

beforeEach(async () => {
  hostRoot = await fs.mkdtemp(path.join(tmpdir(), 'gfs-download-store-'))
  callerRoot = path.join(hostRoot, 'users', 'caller-a')
  await fs.mkdir(callerRoot, { recursive: true, mode: 0o700 })
  store = new GfsDownloadStore(hostRoot)
  await store.initialize()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await store.close().catch(() => undefined)
  await fs.rm(hostRoot, { recursive: true, force: true })
})

describe('GFS download store', () => {
  it('creates a caller-relative transfer and publishes an exact completed record', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const transfer = await store.createTransfer({
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      source,
      sizeBytes: 7,
      expiresAt,
    })

    expect(transfer.path).toMatch(/^\.gfs-downloads\/input-[a-f0-9-]+\/source$/)
    expect(path.isAbsolute(transfer.path)).toBe(false)
    expect(await fs.realpath(path.dirname(path.join(callerRoot, transfer.path)))).toBe(
      await fs.realpath(
        path.join(callerRoot, '.gfs-downloads', path.basename(path.dirname(transfer.path)))
      )
    )
    expect((await fs.stat(path.join(callerRoot, `${transfer.path}.partial`))).mode & 0o777).toBe(
      0o600
    )

    await fs.writeFile(path.join(callerRoot, `${transfer.path}.partial`), 'fixture')
    const receipt = await store.publish(
      transfer.id,
      'caller-a',
      createHash('sha256').update('fixture').digest('hex')
    )

    expect(receipt).toMatchObject({
      source,
      path: transfer.path,
      sizeBytes: 7,
      sha256: createHash('sha256').update('fixture').digest('hex'),
      expiresAt,
    })
    await expect(fs.stat(path.join(callerRoot, `${transfer.path}.partial`))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect((await fs.stat(path.join(callerRoot, transfer.path))).mode & 0o777).toBe(0o600)
  })

  it('binds receipts to the caller and fails closed on expiry or missing bytes', async () => {
    const transfer = await store.createTransfer({
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      source,
      sizeBytes: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await fs.writeFile(path.join(callerRoot, `${transfer.path}.partial`), 'x')
    const receipt = await store.publish(
      transfer.id,
      'caller-a',
      createHash('sha256').update('x').digest('hex')
    )

    await expect(store.inspect(receipt.path, 'caller-b')).rejects.toMatchObject({
      code: 'caller_mismatch',
    })
    await expect(store.inspect(receipt.path, 'caller-a')).resolves.toMatchObject({
      id: transfer.id,
    })

    await fs.writeFile(path.join(callerRoot, receipt.path), 'y')
    await expect(store.inspect(receipt.path, 'caller-a')).rejects.toMatchObject({
      code: 'download_missing',
    })
    await fs.writeFile(path.join(callerRoot, receipt.path), 'x')
    await expect(store.inspect(receipt.path, 'caller-a')).resolves.toMatchObject({
      id: transfer.id,
    })

    const record = store.debugRecord(transfer.id)!
    record.expiresAt = new Date(Date.now() - 1).toISOString()
    await store.debugPersist()
    await expect(store.inspect(receipt.path, 'caller-a')).rejects.toMatchObject({
      code: 'download_expired',
    })

    await fs.unlink(path.join(callerRoot, receipt.path))
    record.expiresAt = new Date(Date.now() + 60_000).toISOString()
    await store.debugPersist()
    await expect(store.inspect(receipt.path, 'caller-a')).rejects.toMatchObject({
      code: 'download_missing',
    })
  })

  it('enforces caller and aggregate byte/file quotas from the durable ledger', async () => {
    await expect(
      store.createTransfer({
        callerIdentity: 'caller-a',
        callerWorkspacePath: callerRoot,
        source,
        sizeBytes: GFS_FILE_LIMITS.maxFileBytes + 1,
        expiresAt: new Date().toISOString(),
      })
    ).rejects.toMatchObject({ code: 'host_quota_exceeded' })

    const bytes = Buffer.alloc(1024)
    for (let index = 0; index < GFS_FILE_LIMITS.callerRetainedFiles; index += 1) {
      const transfer = await store.createTransfer({
        callerIdentity: 'caller-a',
        callerWorkspacePath: callerRoot,
        source,
        sizeBytes: 1024,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      await fs.writeFile(path.join(callerRoot, transfer.partialPath), bytes)
      await store.publish(transfer.id, 'caller-a', createHash('sha256').update(bytes).digest('hex'))
    }

    await expect(
      store.createTransfer({
        callerIdentity: 'caller-a',
        callerWorkspacePath: callerRoot,
        source,
        sizeBytes: 1024,
        expiresAt: new Date().toISOString(),
      })
    ).rejects.toMatchObject({ code: 'caller_quota_exceeded' })
    expect(store.debugUsage()).toMatchObject({
      bytes: GFS_FILE_LIMITS.callerRetainedFiles * 1024,
      files: GFS_FILE_LIMITS.callerRetainedFiles,
      callerBytes: { 'caller-a': GFS_FILE_LIMITS.callerRetainedFiles * 1024 },
      callerFiles: { 'caller-a': GFS_FILE_LIMITS.callerRetainedFiles },
    })
  })

  it('reconstructs completed charges after process restart', async () => {
    const transfer = await store.createTransfer({
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      source,
      sizeBytes: 1024,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await fs.writeFile(path.join(callerRoot, transfer.partialPath), Buffer.alloc(1024))
    await store.publish(
      transfer.id,
      'caller-a',
      createHash('sha256').update(Buffer.alloc(1024)).digest('hex')
    )

    await store.close()
    const reopened = new GfsDownloadStore(hostRoot)
    await reopened.initialize()
    expect(reopened.debugUsage()).toEqual({
      bytes: 1024,
      files: 1,
      callerBytes: { 'caller-a': 1024 },
      callerFiles: { 'caller-a': 1 },
    })

    reopened.debugRecord(transfer.id)!.sizeBytes = GFS_FILE_LIMITS.callerStorageBytes - 512
    await reopened.debugPersist()
    await expect(
      reopened.createTransfer({
        callerIdentity: 'caller-a',
        callerWorkspacePath: callerRoot,
        source,
        sizeBytes: 1024,
        expiresAt: new Date().toISOString(),
      })
    ).rejects.toMatchObject({ code: 'caller_quota_exceeded' })
    await reopened.close()
  })

  it('releases a failed transfer when its exact directory is removed', async () => {
    const transfer = await store.createTransfer({
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      source,
      sizeBytes: 1024,
      expiresAt: new Date().toISOString(),
    })
    await store.fail(transfer.id, 'caller-a')
    expect(store.debugUsage()).toEqual({ bytes: 0, files: 0, callerBytes: {}, callerFiles: {} })
    await expect(fs.stat(path.join(callerRoot, transfer.path))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('reserves active-transfer slots atomically per caller and Host', async () => {
    const first = await store.createTransfer({
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      source,
      sizeBytes: 1,
      expiresAt: new Date().toISOString(),
    })

    await expect(
      store.createTransfer({
        callerIdentity: 'caller-a',
        callerWorkspacePath: callerRoot,
        source,
        sizeBytes: 1,
        expiresAt: new Date().toISOString(),
      })
    ).rejects.toMatchObject({ code: 'download_busy' })

    const callerBRoot = path.join(hostRoot, 'users', 'caller-b')
    await fs.mkdir(callerBRoot, { recursive: true, mode: 0o700 })
    const second = await store.createTransfer({
      callerIdentity: 'caller-b',
      callerWorkspacePath: callerBRoot,
      source,
      sizeBytes: 1,
      expiresAt: new Date().toISOString(),
    })

    const callerCRoot = path.join(hostRoot, 'users', 'caller-c')
    await fs.mkdir(callerCRoot, { recursive: true, mode: 0o700 })
    await expect(
      store.createTransfer({
        callerIdentity: 'caller-c',
        callerWorkspacePath: callerCRoot,
        source,
        sizeBytes: 1,
        expiresAt: new Date().toISOString(),
      })
    ).rejects.toMatchObject({ code: 'download_busy' })

    await store.fail(first.id, 'caller-a')
    await store.fail(second.id, 'caller-b')
    await store.createTransfer({
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      source,
      sizeBytes: 1,
      expiresAt: new Date().toISOString(),
    })
  })

  it('rejects a second live writer and accepts initialization after close', async () => {
    const second = new GfsDownloadStore(hostRoot)
    await expect(second.initialize()).rejects.toMatchObject({ code: 'writer_locked' })
    await store.close()
    await second.initialize()
    await second.close()
  })

  it('fails closed on a corrupt durable ledger', async () => {
    await store.close()
    await fs.writeFile(path.join(hostRoot, '.gfs-download-store', 'ledger-v1.json'), '{bad')
    const reopened = new GfsDownloadStore(hostRoot)
    await expect(reopened.initialize()).rejects.toMatchObject({
      code: 'corrupt_store_ledger',
    })
  })
  it('does not commit a publication released after abort and keeps failed cleanup reserved', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const transfer = await store.createTransfer({
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      source,
      sizeBytes: 7,
      expiresAt,
    })
    await fs.writeFile(path.join(callerRoot, `${transfer.path}.partial`), 'fixture')
    const sha256 = createHash('sha256').update('fixture').digest('hex')
    const probe = await fs.open(path.join(callerRoot, 'probe'), 'w')
    const prototype = Object.getPrototypeOf(probe) as fs.FileHandle
    await probe.close()
    const controller = new AbortController()
    let releaseRead!: () => void
    const readBlocked = new Promise<void>(resolve => {
      releaseRead = resolve
    })
    let readEntered!: () => void
    const readStarted = new Promise<void>(resolve => {
      readEntered = resolve
    })
    let heldRead = false
    const originalRead = prototype.read
    vi.spyOn(prototype, 'read').mockImplementation(async function (
      this: fs.FileHandle,
      ...values: unknown[]
    ) {
      const info = await this.stat()
      if (!heldRead && info.isFile() && info.size === 7) {
        heldRead = true
        readEntered()
        await readBlocked
      }
      return originalRead.apply(this, values as never)
    })

    const pending = store.publish(transfer.id, 'caller-a', sha256, { signal: controller.signal })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'publication_cancelled' })
    await readStarted
    controller.abort()
    releaseRead()
    await rejected
    expect(store.debugRecord(transfer.id)).toMatchObject({ state: 'transferring' })
    expect(store.debugRecord(transfer.id)?.sha256).toBeUndefined()
    vi.restoreAllMocks()

    const directory = path.dirname(path.join(callerRoot, transfer.path))
    await fs.rm(directory, { recursive: true, force: true })
    await expect(store.fail(transfer.id, 'caller-a')).rejects.toMatchObject({
      code: 'storage_write_failed',
    })
    expect(store.debugRecord(transfer.id)).toMatchObject({
      state: 'cleanup_failed',
      sizeBytes: 7,
    })
    expect(store.debugUsage()).toMatchObject({ bytes: 7, files: 1 })
  })

  it('rejects a managed file that grows after its size check without reading the extra body', async () => {
    const transfer = await store.createTransfer({
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      source,
      sizeBytes: 7,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await fs.writeFile(path.join(callerRoot, `${transfer.path}.partial`), 'fixture')
    const receipt = await store.publish(
      transfer.id,
      'caller-a',
      createHash('sha256').update('fixture').digest('hex')
    )
    await expect(store.readManagedFile(receipt.path, 'caller-a')).resolves.toEqual(
      Buffer.from('fixture')
    )

    const probe = await fs.open(path.join(callerRoot, 'probe'), 'w')
    const prototype = Object.getPrototypeOf(probe) as fs.FileHandle
    await probe.close()
    let grown = false
    const originalStat = prototype.stat
    vi.spyOn(prototype, 'stat').mockImplementation(async function (this: fs.FileHandle) {
      const info = await originalStat.call(this)
      if (!grown && info.isFile() && info.size === 7) {
        grown = true
        await fs.appendFile(path.join(callerRoot, receipt.path), 'X'.repeat(64))
      }
      return info
    })
    let readBytes = 0
    const originalRead = prototype.read
    vi.spyOn(prototype, 'read').mockImplementation(async function (
      this: fs.FileHandle,
      ...values: unknown[]
    ) {
      const result = await originalRead.apply(this, values as never)
      readBytes += result.bytesRead
      return result
    })

    await expect(store.readManagedFile(receipt.path, 'caller-a')).rejects.toMatchObject({
      code: 'download_missing',
    })
    expect(grown).toBe(true)
    expect(readBytes).toBe(receipt.sizeBytes + 1)
  })

  it.each([
    ['temporary journal sync', 'abort'],
    ['temporary journal sync', 'deadline'],
    ['committed journal directory sync', 'abort'],
    ['committed journal directory sync', 'deadline'],
  ] as const)(
    'keeps publication unreadable during cancellation at %s (%s)',
    async (phase, cancellation) => {
      const transfer = await store.createTransfer({
        callerIdentity: 'caller-a',
        callerWorkspacePath: callerRoot,
        source,
        sizeBytes: 7,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      await fs.writeFile(path.join(callerRoot, `${transfer.path}.partial`), 'fixture')
      const ledgerDirectory = path.join(hostRoot, '.gfs-download-store')
      const directoryInfo = await fs.stat(ledgerDirectory)
      const probe = await fs.open(path.join(callerRoot, 'probe'), 'w')
      const prototype = Object.getPrototypeOf(probe) as fs.FileHandle
      await probe.close()
      let release!: () => void
      const blocked = new Promise<void>(resolve => {
        release = resolve
      })
      let entered!: () => void
      const started = new Promise<void>(resolve => {
        entered = resolve
      })
      let held = false
      const originalSync = prototype.sync
      vi.spyOn(prototype, 'sync').mockImplementation(async function (this: fs.FileHandle) {
        const info = await this.stat()
        const atBoundary =
          phase === 'temporary journal sync'
            ? info.isFile() && info.size > 7
            : info.isDirectory() && info.ino === directoryInfo.ino
        if (!held && atBoundary && store.debugRecord(transfer.id)?.state === 'completed') {
          held = true
          entered()
          await blocked
        }
        return originalSync.call(this)
      })
      const controller = new AbortController()
      let now = Date.now()
      const deadlineMs = now + 1000
      if (cancellation === 'deadline') vi.spyOn(Date, 'now').mockImplementation(() => now)
      const pending = store.publish(
        transfer.id,
        'caller-a',
        createHash('sha256').update('fixture').digest('hex'),
        { signal: controller.signal, deadlineMs }
      )
      const rejected = expect(pending).rejects.toMatchObject({ code: 'publication_cancelled' })
      await started
      if (cancellation === 'abort') controller.abort()
      else now = deadlineMs
      release()
      await rejected

      expect(store.debugRecord(transfer.id)).toMatchObject({ state: 'transferring' })
      expect(store.debugRecord(transfer.id)?.sha256).toBeUndefined()
      await expect(store.readManagedFile(transfer.path, 'caller-a')).rejects.toMatchObject({
        code: 'download_missing',
      })
      const ledger = JSON.parse(
        await fs.readFile(path.join(ledgerDirectory, 'ledger-v1.json'), 'utf8')
      )
      expect(ledger.records[transfer.id].state).toBe('transferring')
      expect(ledger.records[transfer.id].sha256).toBeUndefined()
      expect((await fs.readdir(ledgerDirectory)).filter(name => name.includes('.tmp-'))).toEqual([])
      expect(store.debugUsage()).toMatchObject({ bytes: 7, files: 1 })
      await store.fail(transfer.id, 'caller-a')
      expect(store.debugUsage()).toMatchObject({ bytes: 0, files: 0 })
    }
  )
})
