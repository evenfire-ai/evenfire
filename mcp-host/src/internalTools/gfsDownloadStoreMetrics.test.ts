import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { register } from 'prom-client'
import { GfsDownloadStore } from './gfsDownloadStore'

let root: string
let callerRoot: string
let store: GfsDownloadStore
const source = {
  kind: 'gfs' as const,
  drive: 'main',
  resourceId: 'a'.repeat(32),
  gfsUri: `gfs://main/${'a'.repeat(32)}`,
  name: 'input.csv',
  version: 7,
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'gfs-store-metrics-'))
  callerRoot = path.join(root, 'users', 'caller-a')
  await fs.mkdir(callerRoot, { recursive: true, mode: 0o700 })
  store = new GfsDownloadStore(root)
  await store.initialize()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await store.close(0).catch(async () => {
    await (
      store as unknown as { writerLease?: { release(): Promise<void> } }
    ).writerLease?.release()
  })
  await fs.rm(root, { recursive: true, force: true })
})
async function metric(name: string, labels: Record<string, string>): Promise<number> {
  const data = await register.getSingleMetric(name)!.get()
  return (
    data.values.find(value =>
      Object.entries(labels).every(([key, expected]) => value.labels[key] === expected)
    )?.value ?? 0
  )
}
async function completed() {
  const transfer = await store.createTransfer({
    callerIdentity: 'caller-a',
    callerWorkspacePath: callerRoot,
    source,
    sizeBytes: 7,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  await fs.writeFile(path.join(callerRoot, transfer.partialPath), 'fixture')
  return store.publish(
    transfer.id,
    'caller-a',
    createHash('sha256').update('fixture').digest('hex')
  )
}

describe('GFS store decision metrics', () => {
  it('records the actual caller concurrency rejection with fixed labels', async () => {
    const name = 'clerum_gfs_download_quota_total'
    const labels = { scope: 'caller', reason: 'active_downloads' }
    const before = await metric(name, labels)
    const input = {
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      source,
      sizeBytes: 7,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    const transfer = await store.createTransfer(input)
    await expect(store.createTransfer(input)).rejects.toMatchObject({ code: 'download_busy' })
    expect(await metric(name, labels)).toBe(before + 1)
    await store.fail(transfer.id, 'caller-a')
  })

  it.each(['removed', 'failed'] as const)(
    'records actual expired-directory cleanup (%s)',
    async outcome => {
      const receipt = await completed()
      const name = 'clerum_gfs_download_expiry_total'
      const labels = { outcome: outcome === 'removed' ? 'expired_removed' : 'cleanup_failed' }
      const before = await metric(name, labels)
      if (outcome === 'failed') {
        await fs.rm(path.join(callerRoot, '.gfs-downloads'), { recursive: true, force: true })
        await fs.writeFile(path.join(callerRoot, '.gfs-downloads'), 'not-a-directory')
      }
      await store.cleanupExpired(Date.parse(receipt.expiresAt) + 1)
      expect(await metric(name, labels)).toBe(before + 1)
      expect(store.debugUsage().bytes).toBe(outcome === 'removed' ? 0 : 7)
    }
  )

  it('records a failed sweep while retaining the uncertain durable charge', async () => {
    const receipt = await completed()
    const name = 'clerum_gfs_download_expiry_total'
    const labels = { outcome: 'sweep_failed' }
    const before = await metric(name, labels)
    vi.spyOn(store as unknown as { persist(): Promise<void> }, 'persist').mockRejectedValueOnce(
      new Error('journal unavailable')
    )
    await expect(store.cleanupExpired(Date.parse(receipt.expiresAt) + 1)).rejects.toThrow(
      'journal unavailable'
    )
    expect(await metric(name, labels)).toBe(before + 1)
    expect(store.debugUsage().bytes).toBe(7)
  })
})
