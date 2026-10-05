import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { GfsImageSource } from '../visualInput/policy'
import { GfsDownloadStore } from './gfsDownloadStore'

const source: GfsImageSource = {
  kind: 'gfs',
  drive: 'main',
  resourceId: '0123456789abcdef0123456789abcdef',
  gfsUri: 'gfs://main/0123456789abcdef0123456789abcdef',
  name: 'input.csv',
  version: 7,
}

describe('GfsDownloadStore processing leases', () => {
  let hostRoot: string
  let callerRoot: string
  let store: GfsDownloadStore

  beforeEach(() => {
    hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gfs-processing-lease-'))
    callerRoot = path.join(hostRoot, 'users', 'caller-a')
    fs.mkdirSync(callerRoot, { recursive: true, mode: 0o700 })
    store = new GfsDownloadStore(hostRoot)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(hostRoot, { recursive: true, force: true })
  })

  async function publishFixture(expiresAt = new Date(Date.now() + 60_000).toISOString()) {
    await store.initialize()
    const bytes = Buffer.from('fixture')
    const transfer = await store.createTransfer({
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      source,
      sizeBytes: bytes.byteLength,
      expiresAt,
    })
    fs.writeFileSync(path.join(callerRoot, transfer.partialPath), bytes)
    return store.publish(transfer.id, 'caller-a', createHash('sha256').update(bytes).digest('hex'))
  }

  it('acquires and releases a caller-bound durable lease', async () => {
    const receipt = await publishFixture()
    const provider = store.processingLeaseProvider('caller-a')
    const lease = await provider.acquireProcessingLease({ durationMs: 60_000 })

    expect(lease.leaseId).toMatch(/^[0-9a-f-]{36}$/)
    expect(lease.expiresAt).toBeDefined()
    await provider.releaseProcessingLease(lease)
    expect(store.debugRecord(receipt.id)).toBeDefined()
  })

  it('rejects release by another caller', async () => {
    await publishFixture()
    const lease = await store.processingLeaseProvider('caller-a').acquireProcessingLease()
    await expect(
      store.processingLeaseProvider('caller-b').releaseProcessingLease(lease)
    ).rejects.toMatchObject({ code: 'caller_mismatch' })
  })

  it('rejects a new lease for an expired retained file before cleanup', async () => {
    const receipt = await publishFixture()
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(receipt.expiresAt))

    await expect(
      store.processingLeaseProvider('caller-a').acquireProcessingLease()
    ).rejects.toMatchObject({ code: 'download_expired' })
    expect(fs.existsSync(path.join(callerRoot, receipt.path))).toBe(true)
    expect(store.debugRecord(receipt.id)).toBeDefined()

    await store.cleanupExpired()
    const lease = await store.processingLeaseProvider('caller-a').acquireProcessingLease()
    await store.processingLeaseProvider('caller-a').releaseProcessingLease(lease)
    await store.close()
  })

  it('rejects a new lease after expiry while preserving an admitted execution', async () => {
    const receipt = await publishFixture()
    const provider = store.processingLeaseProvider('caller-a')
    const admitted = await provider.acquireProcessingLease()
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(receipt.expiresAt) + 1)

    await expect(provider.acquireProcessingLease()).rejects.toMatchObject({
      code: 'download_expired',
    })
    await store.cleanupExpired()
    expect(fs.existsSync(path.join(callerRoot, receipt.path))).toBe(true)
    expect(store.debugRecord(receipt.id)).toBeDefined()

    await provider.releaseProcessingLease(admitted)
    await store.cleanupExpired()
    expect(store.debugRecord(receipt.id)).toBeUndefined()
    await store.close()
  })

  it('recovers admission when an expired record has no directory left to clean', async () => {
    const receipt = await publishFixture()
    // Crash-after-rm analogue: the directory is gone while the ledger entry and
    // its charge remain. Cleanup must reconcile them, not strand them.
    fs.rmSync(path.join(callerRoot, path.dirname(receipt.path)), { recursive: true, force: true })
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(receipt.expiresAt) + 1)

    await expect(
      store.processingLeaseProvider('caller-a').acquireProcessingLease()
    ).rejects.toMatchObject({ code: 'download_expired' })

    await store.cleanupExpired()

    expect(store.debugRecord(receipt.id)).toBeUndefined()
    expect(store.debugUsage()).toEqual({ bytes: 0, files: 0, callerBytes: {}, callerFiles: {} })

    const lease = await store.processingLeaseProvider('caller-a').acquireProcessingLease()
    await store.processingLeaseProvider('caller-a').releaseProcessingLease(lease)
    await store.close()
  })

  it('keeps another caller admissible while one caller has an expired record', async () => {
    const expired = await publishFixture()
    const callerBRoot = path.join(hostRoot, 'users', 'caller-b')
    fs.mkdirSync(callerBRoot, { recursive: true, mode: 0o700 })
    const callerBTransfer = await store.createTransfer({
      callerIdentity: 'caller-b',
      callerWorkspacePath: callerBRoot,
      source,
      sizeBytes: 7,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    fs.writeFileSync(path.join(callerBRoot, callerBTransfer.partialPath), Buffer.from('fixture'))
    await store.publish(
      callerBTransfer.id,
      'caller-b',
      createHash('sha256').update('fixture').digest('hex')
    )
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expired.expiresAt) + 1)

    await expect(
      store.processingLeaseProvider('caller-a').acquireProcessingLease()
    ).rejects.toMatchObject({ code: 'download_expired' })

    const providerB = store.processingLeaseProvider('caller-b')
    const leaseB = await providerB.acquireProcessingLease()
    await providerB.releaseProcessingLease(leaseB)
    await store.close()
  })

  it('protects an expired download from cleanup while leased', async () => {
    const receipt = await publishFixture()
    const lease = await store
      .processingLeaseProvider('caller-a')
      .acquireProcessingLease({ durationMs: 60_000 })

    await store.cleanupExpired(Date.parse(receipt.expiresAt) + 1)
    expect(store.debugRecord(receipt.id)).toBeDefined()

    await store.processingLeaseProvider('caller-a').releaseProcessingLease(lease)
    await store.cleanupExpired(Date.parse(receipt.expiresAt) + 1)
    expect(store.debugRecord(receipt.id)).toBeUndefined()
  })

  it('recovers a lease conservatively after a store restart', async () => {
    const receipt = await publishFixture(new Date(Date.now() + 250).toISOString())
    const lease = await store
      .processingLeaseProvider('caller-a')
      .acquireProcessingLease({ durationMs: 1_000 })
    await expect(store.close(10)).rejects.toMatchObject({ code: 'download_busy' })
    ;(
      store as unknown as {
        liveProcessingLeases: Set<string>
      }
    ).liveProcessingLeases.delete(lease.leaseId)
    await store.close()
    await new Promise(resolve => setTimeout(resolve, 300))

    const restarted = new GfsDownloadStore(hostRoot)
    await restarted.initialize()
    await restarted.cleanupExpired(Date.parse(receipt.expiresAt) + 1)
    expect(restarted.debugRecord(receipt.id)).toBeDefined()

    await new Promise(resolve => setTimeout(resolve, 1_000))
    await restarted.cleanupExpired(Date.parse(lease.expiresAt) + 1)
    expect(restarted.debugRecord(receipt.id)).toBeUndefined()
    await restarted.close()
  })

  it('retains protection when lease release persistence fails', async () => {
    const receipt = await publishFixture()
    const provider = store.processingLeaseProvider('caller-a')
    const lease = await provider.acquireProcessingLease({ durationMs: 60_000 })
    vi.spyOn(store as unknown as { persist: () => Promise<void> }, 'persist').mockRejectedValueOnce(
      new Error('disk unavailable')
    )

    await expect(provider.releaseProcessingLease(lease)).rejects.toThrow()
    await store.cleanupExpired(Date.parse(receipt.expiresAt) + 1)
    expect(store.debugRecord(receipt.id)).toBeDefined()

    vi.restoreAllMocks()
    await provider.releaseProcessingLease(lease)
    await store.cleanupExpired(Date.parse(receipt.expiresAt) + 1)
    expect(store.debugRecord(receipt.id)).toBeUndefined()
  })
})
