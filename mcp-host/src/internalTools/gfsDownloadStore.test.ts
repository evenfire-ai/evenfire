import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { ShellTool } from '../core/tools/shell'
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
  await store.close(0).catch(async () => {
    // Fixture consumers are settled by test teardown, even for negative paths.
    await (
      store as unknown as { writerLease?: { release(): Promise<void> } }
    ).writerLease?.release()
  })
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
        retentionOwnerId: 'quota-fixture-task',
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
    await store.releaseReceiptOwner('quota-fixture-task', 'caller-a')
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

  it('releases a failed transfer whose directory is already absent', async () => {
    const transfer = await store.createTransfer({
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      source,
      sizeBytes: 1024,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    // Crash-after-rm analogue: the directory is gone while the durable charge
    // and its ledger entry remain.
    await fs.rm(path.join(callerRoot, path.dirname(transfer.path)), {
      recursive: true,
      force: true,
    })

    await store.fail(transfer.id, 'caller-a')

    expect(store.debugRecord(transfer.id)).toBeUndefined()
    expect(store.debugUsage()).toEqual({ bytes: 0, files: 0, callerBytes: {}, callerFiles: {} })
  })

  it('keeps the charge when absence cannot be proven at lstat', async () => {
    const transfer = await store.createTransfer({
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      source,
      sizeBytes: 7,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await fs.writeFile(path.join(callerRoot, `${transfer.path}.partial`), 'fixture')
    await store.publish(
      transfer.id,
      'caller-a',
      createHash('sha256').update('fixture').digest('hex')
    )
    const record = store.debugRecord(transfer.id)!
    record.expiresAt = new Date(Date.now() - 1).toISOString()
    await store.debugPersist()
    // A regular file where the download directory belongs makes lstat fail with
    // ENOTDIR. Only ENOENT proves absence; this must stay charged.
    await fs.rm(path.join(callerRoot, '.gfs-downloads'), { recursive: true, force: true })
    await fs.writeFile(path.join(callerRoot, '.gfs-downloads'), 'not-a-directory')

    await store.cleanupExpired()

    expect(store.debugRecord(transfer.id)).toMatchObject({ state: 'cleanup_failed' })
    expect(store.debugUsage()).toEqual({
      bytes: 7,
      files: 1,
      callerBytes: { 'caller-a': 7 },
      callerFiles: { 'caller-a': 1 },
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

  it('fails closed on an existing zero-byte ledger and keeps the retained source', async () => {
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
    await store.close()

    const ledgerPath = path.join(hostRoot, '.gfs-download-store', 'ledger-v1.json')
    await fs.writeFile(ledgerPath, '')

    const reopened = new GfsDownloadStore(hostRoot)
    await expect(reopened.initialize()).rejects.toMatchObject({
      code: 'corrupt_store_ledger',
    })
    // The unreadable ledger and the retained source must survive untouched.
    expect(await fs.readFile(ledgerPath, 'utf8')).toBe('')
    expect(await fs.readFile(path.join(callerRoot, receipt.path), 'utf8')).toBe('fixture')
  })

  it('fails closed on an array-shaped persisted ledger and keeps the retained source', async () => {
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
    await store.close()

    const ledgerPath = path.join(hostRoot, '.gfs-download-store', 'ledger-v1.json')
    // `typeof [] === 'object'` and Object.entries([]) is empty, so an array-shaped
    // records map reads as an empty ledger unless it is rejected explicitly.
    const persisted = JSON.stringify({ schemaVersion: 1, records: [] })
    await fs.writeFile(ledgerPath, persisted)

    const reopened = new GfsDownloadStore(hostRoot)
    await expect(reopened.initialize()).rejects.toMatchObject({
      code: 'corrupt_store_ledger',
    })
    expect(await fs.readFile(ledgerPath, 'utf8')).toBe(persisted)
    expect(await fs.readFile(path.join(callerRoot, receipt.path), 'utf8')).toBe('fixture')
  })

  it('rejects an existing store whose durable ledger is missing', async () => {
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
    await store.close()

    const ledgerPath = path.join(hostRoot, '.gfs-download-store', 'ledger-v1.json')
    await fs.rm(ledgerPath)

    // The directory already existed with no durable ledger: unknown state, not
    // a fresh store. Reject without recreating the ledger or touching sources.
    await expect(new GfsDownloadStore(hostRoot).initialize()).rejects.toMatchObject({
      code: 'corrupt_store_ledger',
    })
    await expect(fs.stat(ledgerPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(path.join(callerRoot, receipt.path), 'utf8')).toBe('fixture')
    // A retry must fail on state, not on a writer lease leaked by the failure.
    await expect(new GfsDownloadStore(hostRoot).initialize()).rejects.toMatchObject({
      code: 'corrupt_store_ledger',
    })
  })

  it('rejects a preexisting store directory that has no durable ledger', async () => {
    const isolatedRoot = await fs.mkdtemp(path.join(tmpdir(), 'gfs-store-existing-'))
    const isolatedStoreRoot = path.join(isolatedRoot, '.gfs-download-store')
    await fs.mkdir(isolatedStoreRoot, { mode: 0o700 })
    try {
      await expect(new GfsDownloadStore(isolatedRoot).initialize()).rejects.toMatchObject({
        code: 'corrupt_store_ledger',
      })
      expect(await fs.readdir(isolatedStoreRoot)).not.toContain('ledger-v1.json')
    } finally {
      await fs.rm(isolatedRoot, { recursive: true, force: true })
    }
  })

  it('rejects an array-shaped processingLeases map and keeps the retained source', async () => {
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
    await store.close()

    const ledgerPath = path.join(hostRoot, '.gfs-download-store', 'ledger-v1.json')
    const persisted = JSON.parse(await fs.readFile(ledgerPath, 'utf8')) as {
      processingLeases?: unknown
    }
    persisted.processingLeases = []
    const rewritten = JSON.stringify(persisted)
    await fs.writeFile(ledgerPath, rewritten)

    await expect(new GfsDownloadStore(hostRoot).initialize()).rejects.toMatchObject({
      code: 'corrupt_store_ledger',
    })
    expect(await fs.readFile(ledgerPath, 'utf8')).toBe(rewritten)
    expect(await fs.readFile(path.join(callerRoot, receipt.path), 'utf8')).toBe('fixture')
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

    // Force an unproven absence: a regular file where the download directory
    // belongs makes lstat fail with ENOTDIR, so the charge must stay reserved.
    await fs.rm(path.join(callerRoot, '.gfs-downloads'), { recursive: true, force: true })
    await fs.writeFile(path.join(callerRoot, '.gfs-downloads'), 'not-a-directory')
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
    const sourceInfo = await fs.stat(path.join(callerRoot, receipt.path))
    let readBytes = 0
    const originalRead = prototype.read
    vi.spyOn(prototype, 'read').mockImplementation(async function (
      this: fs.FileHandle,
      ...values: unknown[]
    ) {
      const info = await this.stat()
      if (!grown && info.isFile() && info.ino === sourceInfo.ino) {
        grown = true
        // Mutate immediately after the reader admitted the original size, so
        // the bounded EOF probe must detect growth before returning its bytes.
        await fs.appendFile(path.join(callerRoot, receipt.path), 'X'.repeat(64))
      }
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

describe('S6: expiry and admission without processing-lease exemptions (#1019)', () => {
  async function publishFixture(
    expiresAt = new Date(Date.now() + 60_000).toISOString(),
    retentionOwnerId?: string
  ) {
    const transfer = await store.createTransfer({
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      source,
      sizeBytes: 7,
      expiresAt,
      retentionOwnerId,
    })
    await fs.writeFile(path.join(callerRoot, transfer.partialPath), 'fixture')
    return store.publish(
      transfer.id,
      'caller-a',
      createHash('sha256').update('fixture').digest('hex')
    )
  }

  // Store behaviour only: this shell has no store reference, so the test shows
  // that expiry is unaffected by a shell run that read the copy. Decoupling of
  // the shell from the store is proven by the TaskExecutor-level X3-TE test.
  it('removes an expired record even after a shell read it: expiry is unaffected by the shell run', async () => {
    const receipt = await publishFixture()
    const shell = new ShellTool(callerRoot, 5_000, ['PATH'], () => ({}), undefined, true)
    const read = await shell.execute({ command: `cat ${JSON.stringify(receipt.path)}` })
    expect(read.is_error).toBe(false)
    expect(read.content).toContain('fixture')
    await store.cleanupExpired(Date.parse(receipt.expiresAt) + 1)
    expect(store.debugRecord(receipt.id)).toBeUndefined()
    await expect(fs.lstat(path.join(callerRoot, path.dirname(receipt.path)))).rejects.toMatchObject(
      { code: 'ENOENT' }
    )
    expect(store.debugUsage()).toMatchObject({ bytes: 0, files: 0 })
  })

  it('keeps an expired record only while a retention owner holds it', async () => {
    const receipt = await publishFixture(undefined, 'waiting-approval-task')
    await store.cleanupExpired(Date.parse(receipt.expiresAt) + 1)
    expect(store.debugRecord(receipt.id)).toBeDefined()
    expect(await fs.readFile(path.join(callerRoot, receipt.path), 'utf8')).toBe('fixture')
    await store.releaseReceiptOwner('waiting-approval-task', 'caller-a')
    await store.cleanupExpired(Date.parse(receipt.expiresAt) + 1)
    expect(store.debugRecord(receipt.id)).toBeUndefined()
  })

  it('fences a transfer whose caller validation completes after shutdown', async () => {
    const receipt = await publishFixture()
    let resume!: () => void
    let entered!: () => void
    const barrier = new Promise<void>(resolve => {
      resume = resolve
    })
    const waiting = new Promise<void>(resolve => {
      entered = resolve
    })
    const validatingStore = store as unknown as {
      validateCallerRoot: (root: string) => Promise<string>
    }
    const validate = validatingStore.validateCallerRoot.bind(store)
    vi.spyOn(validatingStore, 'validateCallerRoot').mockImplementationOnce(async root => {
      const validated = await validate(root)
      entered()
      await barrier
      return validated
    })
    const outcome = Promise.allSettled([
      store.createTransfer({
        callerIdentity: 'caller-a',
        callerWorkspacePath: callerRoot,
        source,
        sizeBytes: 7,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ])
    await waiting
    await store.close()
    resume()

    const [result] = await outcome
    expect(result!.status).toBe('rejected')
    if (result!.status === 'rejected')
      expect(result!.reason).toMatchObject({ code: 'workspace_unavailable' })
    expect(await fs.readdir(path.join(callerRoot, '.gfs-downloads'))).toEqual([
      path.basename(path.dirname(receipt.path)),
    ])
    const restarted = new GfsDownloadStore(hostRoot)
    await restarted.initialize()
    expect(restarted.debugUsage().bytes).toBe(7)
    await restarted.close()
  })

  it('keeps another caller admissible while one caller has an expired record', async () => {
    const expired = await publishFixture()
    const callerBRoot = path.join(hostRoot, 'users', 'caller-b')
    await fs.mkdir(callerBRoot, { recursive: true, mode: 0o700 })
    // Caller B's expiry is derived from caller A's, so the mocked clock below
    // is strictly before it however fast the fixtures run.
    const callerBTransfer = await store.createTransfer({
      callerIdentity: 'caller-b',
      callerWorkspacePath: callerBRoot,
      source,
      sizeBytes: 7,
      expiresAt: new Date(Date.parse(expired.expiresAt) + 60_000).toISOString(),
    })
    await fs.writeFile(path.join(callerBRoot, callerBTransfer.partialPath), 'fixture')
    const callerBReceipt = await store.publish(
      callerBTransfer.id,
      'caller-b',
      createHash('sha256').update('fixture').digest('hex')
    )
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expired.expiresAt) + 1)

    await store.cleanupExpired()
    expect(store.debugRecord(expired.id)).toBeUndefined()
    expect(store.isAvailable()).toBe(true)
    expect(await store.reusableReceipt('caller-b', source, 7)).toMatchObject({
      id: callerBReceipt.id,
    })
  })

  it('rechecks failed-transfer ownership after a queued publication', async () => {
    const transfer = await store.createTransfer({
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      source,
      sizeBytes: 7,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await fs.writeFile(path.join(callerRoot, transfer.partialPath), 'fixture')
    const persistedStore = store as unknown as { persist: () => Promise<void> }
    const persist = persistedStore.persist.bind(store)
    let resume!: () => void
    let entered!: () => void
    const barrier = new Promise<void>(resolve => {
      resume = resolve
    })
    const waiting = new Promise<void>(resolve => {
      entered = resolve
    })
    vi.spyOn(persistedStore, 'persist').mockImplementationOnce(async () => {
      await persist()
      entered()
      await barrier
    })
    const published = store.publish(
      transfer.id,
      'caller-a',
      createHash('sha256').update('fixture').digest('hex')
    )
    await waiting
    const failed = expect(store.fail(transfer.id, 'caller-a')).rejects.toMatchObject({
      code: 'download_busy',
    })
    resume()
    const receipt = await published
    await failed
    expect(store.debugRecord(receipt.id)).toMatchObject({ state: 'completed' })
    expect(await fs.readFile(path.join(callerRoot, receipt.path), 'utf8')).toBe('fixture')
    const ledger = JSON.parse(
      await fs.readFile(path.join(hostRoot, '.gfs-download-store', 'ledger-v1.json'), 'utf8')
    )
    expect(ledger.records[receipt.id].state).toBe('completed')
    expect(ledger).not.toHaveProperty('processingLeases')
  })
})
