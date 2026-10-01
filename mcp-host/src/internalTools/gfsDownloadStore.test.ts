import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
})
