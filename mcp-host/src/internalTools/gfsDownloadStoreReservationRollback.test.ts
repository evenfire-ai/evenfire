import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { GfsImageSource } from '../visualInput/policy'
import { GfsDownloadStore } from './gfsDownloadStore'

/**
 * The reservation persist in createTransfer is the only durable write before a
 * transfer is exposed. When it fails, the in-memory record and the retention
 * owner roll back, so no later persist (close() included) writes a phantom
 * reservation that the next boot would quarantine and keep charged to quota.
 */

const source: GfsImageSource = {
  kind: 'gfs',
  drive: 'main',
  resourceId: 'a'.repeat(32),
  gfsUri: `gfs://main/${'a'.repeat(32)}`,
  name: 'input.csv',
  version: 7,
}
const otherSource: GfsImageSource = {
  ...source,
  resourceId: 'b'.repeat(32),
  gfsUri: `gfs://main/${'b'.repeat(32)}`,
  name: 'other.csv',
}
const OWNER_ID = '55555555-5555-4555-8555-555555555555'

let root: string
let callerRoot: string
let store: GfsDownloadStore

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'gfs-reservation-rollback-'))
  callerRoot = path.join(root, 'users', 'caller-a')
  await fs.mkdir(callerRoot, { recursive: true, mode: 0o700 })
  store = new GfsDownloadStore(root)
  await store.initialize()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await store.close(0).catch(() => undefined)
  await fs.rm(root, { recursive: true, force: true })
})

async function ledgerOnDisk(): Promise<{
  records: Record<string, unknown>
  retentionOwners?: Record<string, { recordIds: string[] }>
}> {
  return JSON.parse(
    await fs.readFile(path.join(root, '.gfs-download-store', 'ledger-v1.json'), 'utf8')
  )
}

function privateLedger(): {
  records: Record<string, unknown>
  retentionOwners?: Record<string, { recordIds: string[] }>
} {
  return (store as unknown as { ledger: ReturnType<typeof privateLedger> }).ledger
}

function failNextPersist() {
  return vi
    .spyOn(store as unknown as { persist: () => Promise<void> }, 'persist')
    .mockRejectedValueOnce(new Error('reservation unavailable'))
}

describe('createTransfer reservation persist failure', () => {
  it('rolls back the reservation and a new retention owner, and close() persists no phantom record', async () => {
    const before = await ledgerOnDisk()
    const persist = failNextPersist()
    await expect(
      store.createTransfer({
        callerIdentity: 'caller-a',
        callerWorkspacePath: callerRoot,
        source,
        sizeBytes: 7,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        retentionOwnerId: OWNER_ID,
      })
    ).rejects.toThrow('reservation unavailable')
    // Witness: the rejection came from the reservation persist itself.
    expect(persist).toHaveBeenCalledOnce()
    expect(store.debugUsage()).toMatchObject({ bytes: 0, files: 0 })
    expect(privateLedger().records).toEqual({})
    expect(privateLedger().retentionOwners?.[OWNER_ID]).toBeUndefined()
    expect(await ledgerOnDisk()).toEqual(before)
    await expect(fs.lstat(path.join(callerRoot, '.gfs-downloads'))).rejects.toMatchObject({
      code: 'ENOENT',
    })

    await store.close(0)
    const closed = await ledgerOnDisk()
    expect(closed.records).toEqual({})
    expect(closed.retentionOwners?.[OWNER_ID]).toBeUndefined()
  })

  it('restores an existing retention owner and close() persists only the published record', async () => {
    const transfer = await store.createTransfer({
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      source,
      sizeBytes: 7,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      retentionOwnerId: OWNER_ID,
    })
    await fs.writeFile(path.join(callerRoot, transfer.partialPath), 'fixture')
    const published = await store.publish(
      transfer.id,
      'caller-a',
      createHash('sha256').update('fixture').digest('hex')
    )
    const ownerBefore = structuredClone(privateLedger().retentionOwners?.[OWNER_ID])
    expect(ownerBefore?.recordIds).toEqual([published.id])
    const before = await ledgerOnDisk()

    const persist = failNextPersist()
    await expect(
      store.createTransfer({
        callerIdentity: 'caller-a',
        callerWorkspacePath: callerRoot,
        source: otherSource,
        sizeBytes: 7,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        retentionOwnerId: OWNER_ID,
      })
    ).rejects.toThrow('reservation unavailable')
    expect(persist).toHaveBeenCalledOnce()
    expect(store.debugUsage()).toMatchObject({ bytes: 7, files: 1 })
    expect(Object.keys(privateLedger().records)).toEqual([published.id])
    expect(privateLedger().retentionOwners?.[OWNER_ID]).toEqual(ownerBefore)
    expect(await ledgerOnDisk()).toEqual(before)
    expect(await fs.readdir(path.join(callerRoot, '.gfs-downloads'))).toEqual([
      path.basename(path.dirname(published.path)),
    ])

    await store.releaseReceiptOwner(OWNER_ID, 'caller-a')
    await store.close(0)
    const closed = await ledgerOnDisk()
    expect(Object.keys(closed.records)).toEqual([published.id])
    expect(closed.retentionOwners?.[OWNER_ID]).toBeUndefined()
  })
})
