import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { GfsDownloadStore } from './gfsDownloadStore'
import {
  GfsStoreRecoveryError,
  type GfsStoreRecoveryInput,
  inspectGfsStoreRecovery,
  recoverGfsStoreUnderPhysicalFence,
} from './gfsStoreOperatorRecovery'

let root: string
let callerRoot: string
let stores: GfsDownloadStore[]
const source = {
  kind: 'gfs' as const,
  drive: 'main',
  resourceId: 'a'.repeat(32),
  gfsUri: `gfs://main/${'a'.repeat(32)}`,
  name: 'input.csv',
  version: 7,
}
const OWNER = '11111111-1111-4111-8111-111111111111'
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'gfs-operator-recovery-'))
  callerRoot = path.join(root, 'users', 'caller-a')
  await fs.mkdir(callerRoot, { recursive: true, mode: 0o755 })
  stores = []
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const store of stores)
    await store.close(0).catch(async () => {
      await (
        store as unknown as { writerLease?: { release(): Promise<void> } }
      ).writerLease?.release()
    })
  await fs.rm(root, { recursive: true, force: true })
})
function fresh() {
  const store = new GfsDownloadStore(root)
  stores.push(store)
  return store
}
async function publish(store: GfsDownloadStore, owner?: string, caller = callerRoot) {
  const transfer = await store.createTransfer({
    callerIdentity: 'caller-a',
    callerWorkspacePath: caller,
    source,
    sizeBytes: 7,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    retentionOwnerId: owner,
  })
  await fs.writeFile(path.join(caller, transfer.partialPath), 'fixture')
  return store.publish(
    transfer.id,
    'caller-a',
    createHash('sha256').update('fixture').digest('hex')
  )
}
async function recoveryInput(
  extra: Partial<GfsStoreRecoveryInput> = {}
): Promise<GfsStoreRecoveryInput> {
  const inventory = await inspectGfsStoreRecovery(root)
  return {
    hostRoot: root,
    expectedLedgerSha256: inventory.ledgerSha256,
    expectedWriterFenceSha256: inventory.writerFenceSha256,
    expectedSourceInventorySha256: inventory.sourceInventorySha256,
    settledProcessingLeaseIds: [],
    // This isolated fixture has no Pod or spawned executor. Store connections
    // are explicitly closed first; this callback tests the helper's ordering,
    // never stands in for the separately required real runtime fence.
    withPhysicalFence: operation => operation(async () => undefined),
    ...extra,
  }
}
async function simulateWriterDeath(store: GfsDownloadStore) {
  // No stream or executor was launched by these allocation fixtures; release
  // the actual kernel connection to model loss of the old Host process.
  await (store as unknown as { writerLease: { release(): Promise<void> } }).writerLease.release()
}
async function legacyCopy() {
  const store = fresh()
  await store.initialize()
  const receipt = await publish(store)
  await store.close()
  const storeRoot = path.join(root, '.gfs-download-store')
  // Temporary-fixture conversion to the real legacy format (no v2 database),
  // after the only writer has actually closed. Production state is untouched.
  await fs.unlink(path.join(storeRoot, 'writer-v2.sqlite'))
  await fs.writeFile(
    path.join(storeRoot, 'writer.lock'),
    JSON.stringify({ pid: 123, leaseId: OWNER, acquiredAt: new Date(0).toISOString() }),
    { mode: 0o600 }
  )
  return receipt
}

describe('local GFS operator recovery', () => {
  it('returns source-free opaque selections and never normalizes modes during live inspection', async () => {
    const store = fresh()
    await store.initialize()
    const receipt = await publish(store)
    const sourcePath = path.join(callerRoot, receipt.path)
    await fs.chmod(sourcePath, 0o660)
    const inventory = await inspectGfsStoreRecovery(root)
    expect(inventory.counts).toMatchObject({ files: 1, bytes: 7, sourceFiles: 1 })
    expect(inventory.selections).toEqual({
      processingLeaseIds: [],
      receiptOwnerIds: [],
      removablePartialIds: [],
    })
    expect(JSON.stringify(inventory)).not.toContain('input.csv')
    expect(JSON.stringify(inventory)).not.toContain('caller-a')
    expect(JSON.stringify(inventory)).not.toContain(root)
    expect((await fs.stat(sourcePath)).mode & 0o7777).toBe(0o660)
  })

  it('transitions a fenced legacy store in place and preserves completed copy identity and quota', async () => {
    const receipt = await legacyCopy()
    const markerPath = path.join(root, '.gfs-download-store', 'writer.lock')
    const markerBefore = await fs.stat(markerPath)
    const outcome = await recoverGfsStoreUnderPhysicalFence(await recoveryInput())
    expect(outcome.before.counts).toMatchObject({ files: 1, bytes: 7 })
    expect(outcome.after.counts).toMatchObject({ files: 1, bytes: 7 })
    expect((await fs.stat(markerPath)).ino).toBe(markerBefore.ino)
    await expect(
      fs.open(markerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
    ).rejects.toMatchObject({ code: 'EEXIST' })
    const reopened = fresh()
    await reopened.initialize()
    expect(await reopened.reusableReceipt('caller-a', source, 7)).toMatchObject({
      id: receipt.id,
      sha256: receipt.sha256,
    })
  })

  it('restores only a verified published copy after explicit executor settlement', async () => {
    const store = fresh()
    await store.initialize()
    const receipt = await publish(store)
    const lease = await store.processingLeaseProvider('caller-a').acquireProcessingLease()
    await simulateWriterDeath(store)
    const disabled = fresh()
    await disabled.initialize()
    expect(disabled.isAvailable()).toBe(false)
    expect(disabled.debugRecord(receipt.id)?.state).toBe('quarantined')
    await disabled.close()
    const input = await recoveryInput({ settledProcessingLeaseIds: [lease.leaseId] })
    const result = await recoverGfsStoreUnderPhysicalFence(input)
    expect(result.before.selections.processingLeaseIds).toEqual([lease.leaseId])
    expect(result.after.counts).toMatchObject({ files: 1, bytes: 7, processingLeases: 0 })
    const recovered = fresh()
    await recovered.initialize()
    expect(recovered.isAvailable()).toBe(true)
    expect(await recovered.reusableReceipt('caller-a', source, 7)).toMatchObject({ id: receipt.id })
  })

  it('preserves partial bytes and charge by default, then removes only the exact reviewed settled partial', async () => {
    const store = fresh()
    await store.initialize()
    const transfer = await store.createTransfer({
      callerIdentity: 'caller-a',
      callerWorkspacePath: callerRoot,
      source,
      sizeBytes: 7,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await fs.writeFile(path.join(callerRoot, transfer.partialPath), 'partial')
    await simulateWriterDeath(store)
    const preserved = await recoverGfsStoreUnderPhysicalFence(await recoveryInput())
    expect(preserved.after.counts).toMatchObject({ files: 1, bytes: 7, partialFiles: 1 })
    expect(await fs.readFile(path.join(callerRoot, transfer.partialPath), 'utf8')).toBe('partial')
    const removed = await recoverGfsStoreUnderPhysicalFence(
      await recoveryInput({ removeSettledTransferIds: [transfer.id] })
    )
    expect(removed.after.counts).toMatchObject({ files: 0, bytes: 0, partialFiles: 0 })
    await expect(
      fs.lstat(path.join(callerRoot, path.dirname(transfer.path)))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never selects or deletes a renamed source with missing publication metadata', async () => {
    const store = fresh()
    await store.initialize()
    const receipt = await publish(store)
    const record = store.debugRecord(receipt.id)!
    record.state = 'transferring'
    delete record.sha256
    await store.debugPersist()
    await store.close()
    const inventory = await inspectGfsStoreRecovery(root)
    expect(inventory.selections.removablePartialIds).not.toContain(receipt.id)
    await expect(
      recoverGfsStoreUnderPhysicalFence(
        await recoveryInput({ removeSettledTransferIds: [receipt.id] })
      )
    ).rejects.toMatchObject({ code: 'invalid_selection' })
    expect(await fs.readFile(path.join(callerRoot, receipt.path), 'utf8')).toBe('fixture')
  })

  it.each(['empty-ledger', 'different-cache'] as const)(
    'rejects unjournaled reserved caller caches (%s)',
    async scenario => {
      const store = fresh()
      await store.initialize()
      await publish(store)
      await store.close()
      const ledgerPath = path.join(root, '.gfs-download-store', 'ledger-v1.json')
      if (scenario === 'empty-ledger') {
        await fs.writeFile(ledgerPath, JSON.stringify({ schemaVersion: 1, records: {} }))
      } else {
        const unknown = path.join(root, 'users', 'other-caller', '.gfs-downloads', `input-${OWNER}`)
        await fs.mkdir(unknown, { recursive: true, mode: 0o700 })
        await fs.writeFile(path.join(unknown, 'source.partial'), 'unknown', { mode: 0o600 })
      }
      await expect(inspectGfsStoreRecovery(root)).rejects.toMatchObject({
        code: 'invalid_inventory',
      })
    }
  )

  it('rejects changed snapshot and duplicate, unknown, or completed selections before any transition', async () => {
    const receipt = await legacyCopy()
    const input = await recoveryInput()
    const markerPath = path.join(root, '.gfs-download-store', 'writer.lock')
    const before = await fs.readFile(markerPath, 'utf8')
    for (const extra of [
      { expectedLedgerSha256: '0'.repeat(64) },
      { settledProcessingLeaseIds: [OWNER, OWNER] },
      { terminalReceiptOwnerIds: [OWNER] },
      { removeSettledTransferIds: [receipt.id] },
    ])
      await expect(
        recoverGfsStoreUnderPhysicalFence({ ...input, ...extra })
      ).rejects.toBeInstanceOf(GfsStoreRecoveryError)
    expect(await fs.readFile(markerPath, 'utf8')).toBe(before)
  })

  it('keeps old-binary exclusion and charged state recoverable when the physical fence is lost mid-marker write', async () => {
    const receipt = await legacyCopy()
    const markerPath = path.join(root, '.gfs-download-store', 'writer.lock')
    const input = await recoveryInput({
      withPhysicalFence: operation =>
        operation(async () => {
          if ((await fs.stat(markerPath)).size === 0)
            throw new GfsStoreRecoveryError('snapshot_changed')
        }),
    })
    await expect(recoverGfsStoreUnderPhysicalFence(input)).rejects.toMatchObject({
      code: 'snapshot_changed',
    })
    const databasePath = path.join(root, '.gfs-download-store', 'writer-v2.sqlite')
    const databaseBefore = await fs.stat(databasePath)
    expect((await fs.stat(markerPath)).size).toBe(0)
    await expect(
      fs.open(markerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
    ).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await fs.readFile(path.join(callerRoot, receipt.path), 'utf8')).toBe('fixture')
    const retried = await recoverGfsStoreUnderPhysicalFence(await recoveryInput())
    expect(retried.after.counts).toMatchObject({ files: 1, bytes: 7 })
    expect((await fs.stat(databasePath)).ino).toBe(databaseBefore.ino)
    const reopened = fresh()
    await reopened.initialize()
    expect(reopened.debugUsage().bytes).toBe(7)
  })
})
