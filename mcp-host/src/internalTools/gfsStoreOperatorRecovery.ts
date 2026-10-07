import { createHash, randomUUID } from 'node:crypto'
import { type Dir, constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { type GfsDownloadRecord, type StoreLedger, parseLedger } from './gfsDownloadStore'
import { openPrivateStoreObject } from './gfsStorePrivateFiles'
import { GfsStoreWriterLease } from './gfsStoreWriterLease'

export class GfsStoreRecoveryError extends Error {
  constructor(
    readonly code:
      | 'snapshot_changed'
      | 'invalid_inventory'
      | 'invalid_selection'
      | 'storage_write_failed'
  ) {
    super(`GFS store operator recovery failed (${code})`)
  }
}

export interface GfsStoreRecoveryCounts {
  files: number
  bytes: number
  processingLeases: number
  receiptOwners: number
  sourceFiles: number
  partialFiles: number
}

/** Bounded, source-free inventory that is safe to print in the local runbook. */
export interface GfsStoreRecoveryInventory {
  ledgerSha256: string
  writerFenceSha256: string | 'absent'
  sourceInventorySha256: string
  counts: GfsStoreRecoveryCounts
  selections: {
    processingLeaseIds: string[]
    receiptOwnerIds: string[]
    removablePartialIds: string[]
  }
}

export interface GfsStoreRecoveryReceipt {
  before: GfsStoreRecoveryInventory
  after: GfsStoreRecoveryInventory
  settledProcessingLeases: number
  terminalReceiptOwners: number
  removedSettledTransfers: number
}

export interface GfsStoreRecoveryInput {
  hostRoot: string
  expectedLedgerSha256: string
  expectedWriterFenceSha256: string | 'absent'
  expectedSourceInventorySha256: string
  settledProcessingLeaseIds: string[]
  terminalReceiptOwnerIds?: string[]
  removeSettledTransferIds?: string[]
  /**
   * The local operator owns an exclusive runtime/profile fence for this whole
   * callback. assertHeld must prove actual Host/executor physical settlement,
   * including deleted-pod descendants, not a PID/TTL/replica-count inference.
   * No Host RPC, environment flag, or model-supplied provider exposes this API.
   */
  withPhysicalFence(
    operation: (assertHeld: () => Promise<void>) => Promise<GfsStoreRecoveryReceipt>
  ): Promise<GfsStoreRecoveryReceipt>
}

interface FileInventory {
  present: boolean
  sizeBytes?: number
  sha256?: string
}
interface RecordInventory {
  id: string
  source: FileInventory
  partial: FileInventory
}
interface Snapshot {
  root: string
  storeRoot: string
  ledger: StoreLedger
  sources: RecordInventory[]
  inventory: GfsStoreRecoveryInventory
}
const SHA256_RE = /^[0-9a-f]{64}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_OPERATOR_OWNERS = 4096
const MAX_OPERATOR_LEDGER_BYTES = 32 * 1024 * 1024

function hash(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
function within(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function readOwnedFile(filename: string): Promise<Buffer> {
  const handle = await openPrivateStoreObject(filename, 'file', constants.O_RDONLY, false)
  try {
    const before = await handle.stat({ bigint: true })
    if (before.size > BigInt(MAX_OPERATOR_LEDGER_BYTES))
      throw new GfsStoreRecoveryError('invalid_inventory')
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    const named = await fs.lstat(filename, { bigint: true })
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      named.isSymbolicLink()
    )
      throw new GfsStoreRecoveryError('snapshot_changed')
    return bytes
  } finally {
    await handle.close()
  }
}

async function verifyDirectory(directory: string): Promise<void> {
  if ((await fs.realpath(directory)) !== directory)
    throw new GfsStoreRecoveryError('invalid_inventory')
  const handle = await openPrivateStoreObject(directory, 'directory', constants.O_RDONLY, false)
  await handle.close()
}

async function verifyCallerRoot(directory: string): Promise<void> {
  if ((await fs.realpath(directory)) !== directory)
    throw new GfsStoreRecoveryError('invalid_inventory')
  const handle = await fs.open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  )
  try {
    const info = await handle.stat()
    const named = await fs.lstat(directory)
    if (
      !info.isDirectory() ||
      named.isSymbolicLink() ||
      typeof process.getuid !== 'function' ||
      info.uid !== process.getuid() ||
      named.dev !== info.dev ||
      named.ino !== info.ino
    )
      throw new GfsStoreRecoveryError('invalid_inventory')
  } finally {
    await handle.close()
  }
}

async function inventoryFile(
  filename: string,
  assertHeld?: () => Promise<void>
): Promise<FileInventory> {
  let handle: fs.FileHandle
  try {
    handle = await openPrivateStoreObject(filename, 'file', constants.O_RDONLY, false)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { present: false }
    throw error
  }
  try {
    const before = await handle.stat({ bigint: true })
    const digest = createHash('sha256')
    const chunk = Buffer.alloc(64 * 1024)
    let position = 0
    for (;;) {
      await assertHeld?.()
      const read = await handle.read(chunk, 0, chunk.length, position)
      if (read.bytesRead === 0) break
      digest.update(chunk.subarray(0, read.bytesRead))
      position += read.bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const named = await fs.lstat(filename, { bigint: true })
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      named.isSymbolicLink() ||
      BigInt(position) !== before.size
    )
      throw new GfsStoreRecoveryError('snapshot_changed')
    return { present: true, sizeBytes: position, sha256: digest.digest('hex') }
  } finally {
    await handle.close()
  }
}

async function snapshot(hostRoot: string, assertHeld?: () => Promise<void>): Promise<Snapshot> {
  try {
    const requested = path.resolve(hostRoot)
    const hostInfo = await fs.lstat(requested)
    if (!hostInfo.isDirectory() || hostInfo.isSymbolicLink())
      throw new GfsStoreRecoveryError('invalid_inventory')
    const root = await fs.realpath(requested)
    const storeRoot = path.join(root, '.gfs-download-store')
    await verifyDirectory(storeRoot)
    const ledgerBytes = await readOwnedFile(path.join(storeRoot, 'ledger-v1.json'))
    const ledger = parseLedger(ledgerBytes.toString('utf8'))
    if (
      Object.keys(ledger.records).length > 64 ||
      Object.keys(ledger.processingLeases ?? {}).length > MAX_OPERATOR_OWNERS ||
      Object.keys(ledger.retentionOwners ?? {}).length > MAX_OPERATOR_OWNERS ||
      Object.keys(ledger.retentionOwners ?? {}).some(id => !UUID_RE.test(id))
    )
      throw new GfsStoreRecoveryError('invalid_inventory')
    const records = Object.values(ledger.records).sort((left, right) =>
      left.id.localeCompare(right.id)
    )
    const sources: RecordInventory[] = []
    const expectedDirectories = new Map<string, Set<string>>()
    for (const record of records) {
      const directory = path.join(root, record.directory)
      if (!within(directory, root)) throw new GfsStoreRecoveryError('invalid_inventory')
      const cacheRoot = path.dirname(directory)
      const callerRoot = path.dirname(cacheRoot)
      if (path.dirname(callerRoot) !== path.join(root, 'users'))
        throw new GfsStoreRecoveryError('invalid_inventory')
      const expected = expectedDirectories.get(cacheRoot) ?? new Set<string>()
      expected.add(path.basename(directory))
      expectedDirectories.set(cacheRoot, expected)
      try {
        await verifyCallerRoot(path.dirname(cacheRoot))
        await verifyDirectory(cacheRoot)
        await verifyDirectory(directory)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        sources.push({ id: record.id, source: { present: false }, partial: { present: false } })
        continue
      }
      const names = await fs.readdir(directory)
      if (names.some(name => name !== 'source' && name !== 'source.partial'))
        throw new GfsStoreRecoveryError('invalid_inventory')
      sources.push({
        id: record.id,
        source: await inventoryFile(path.join(root, record.hostPath), assertHeld),
        partial: await inventoryFile(path.join(root, `${record.hostPath}.partial`), assertHeld),
      })
    }
    // Census only the reserved cache path under the repository's verified
    // users/<caller> scheme; never open ordinary customer or memory contents.
    const usersRoot = path.join(root, 'users')
    let users: Dir | undefined
    try {
      await verifyCallerRoot(usersRoot)
      users = await fs.opendir(usersRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (users) {
      for await (const entry of users) {
        await assertHeld?.()
        if (!entry.isDirectory() || entry.isSymbolicLink())
          throw new GfsStoreRecoveryError('invalid_inventory')
        const callerRoot = path.join(usersRoot, entry.name)
        await verifyCallerRoot(callerRoot)
        const cacheRoot = path.join(callerRoot, '.gfs-downloads')
        let names: string[]
        try {
          await verifyDirectory(cacheRoot)
          names = await fs.readdir(cacheRoot)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        const expected = expectedDirectories.get(cacheRoot) ?? new Set<string>()
        if (names.some(name => !expected.has(name)))
          throw new GfsStoreRecoveryError('invalid_inventory')
      }
    }
    let writerFenceSha256: string | 'absent' = 'absent'
    try {
      writerFenceSha256 = hash(await readOwnedFile(path.join(storeRoot, 'writer.lock')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    // The journal may have been replaced while the sources were hashed.
    if (hash(await readOwnedFile(path.join(storeRoot, 'ledger-v1.json'))) !== hash(ledgerBytes))
      throw new GfsStoreRecoveryError('snapshot_changed')
    return {
      root,
      storeRoot,
      ledger,
      sources,
      inventory: {
        ledgerSha256: hash(ledgerBytes),
        writerFenceSha256,
        sourceInventorySha256: hash(JSON.stringify(sources)),
        counts: {
          files: records.length,
          bytes: records.reduce((sum, record) => sum + record.sizeBytes, 0),
          processingLeases: Object.keys(ledger.processingLeases ?? {}).length,
          receiptOwners: Object.keys(ledger.retentionOwners ?? {}).length,
          sourceFiles: sources.filter(item => item.source.present).length,
          partialFiles: sources.filter(item => item.partial.present).length,
        },
        selections: {
          processingLeaseIds: Object.keys(ledger.processingLeases ?? {}).sort(),
          receiptOwnerIds: Object.keys(ledger.retentionOwners ?? {}).sort(),
          removablePartialIds: records
            .filter(
              record =>
                record.state !== 'completed' &&
                record.sha256 === undefined &&
                !sources.find(item => item.id === record.id)?.source.present
            )
            .map(record => record.id),
        },
      },
    }
  } catch (error) {
    if (error instanceof GfsStoreRecoveryError) throw error
    throw new GfsStoreRecoveryError('invalid_inventory')
  }
}

/** Read-only; a later transition rejects any ledger, fence or source drift. */
export async function inspectGfsStoreRecovery(
  hostRoot: string
): Promise<GfsStoreRecoveryInventory> {
  return (await snapshot(hostRoot)).inventory
}

function selected(ids: string[], available: Record<string, unknown>): void {
  if (
    !Array.isArray(ids) ||
    new Set(ids).size !== ids.length ||
    ids.some(id => typeof id !== 'string' || !Object.hasOwn(available, id))
  )
    throw new GfsStoreRecoveryError('invalid_selection')
}

async function persist(
  state: Snapshot,
  lease: GfsStoreWriterLease,
  assertHeld: () => Promise<void>
): Promise<void> {
  const ledgerPath = path.join(state.storeRoot, 'ledger-v1.json')
  const temporary = `${ledgerPath}.tmp-${randomUUID()}`
  try {
    await assertHeld()
    await lease.verifyHeld()
    const handle = await fs.open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    )
    try {
      await assertHeld()
      await lease.verifyHeld()
      await handle.writeFile(JSON.stringify(state.ledger))
      await assertHeld()
      await lease.verifyHeld()
      await handle.sync()
    } finally {
      await handle.close()
    }
    await assertHeld()
    await lease.verifyHeld()
    await fs.rename(temporary, ledgerPath)
    const directory = await openPrivateStoreObject(
      state.storeRoot,
      'directory',
      constants.O_RDONLY,
      true,
      assertHeld
    )
    try {
      await assertHeld()
      await lease.verifyHeld()
      await directory.sync()
    } finally {
      await directory.close()
    }
    await assertHeld()
    await lease.verifyHeld()
  } catch (error) {
    // The last journal still charges every uncertain copy. An uncommitted temp
    // is private recovery evidence and is never interpreted as an empty store.
    if (error instanceof GfsStoreRecoveryError) throw error
    throw new GfsStoreRecoveryError('storage_write_failed')
  }
}

/** Narrow local operator transition; caller supplies a real held physical fence. */
export async function recoverGfsStoreUnderPhysicalFence(
  input: GfsStoreRecoveryInput
): Promise<GfsStoreRecoveryReceipt> {
  if (
    !SHA256_RE.test(input.expectedLedgerSha256) ||
    !SHA256_RE.test(input.expectedSourceInventorySha256) ||
    !(
      input.expectedWriterFenceSha256 === 'absent' ||
      SHA256_RE.test(input.expectedWriterFenceSha256)
    )
  )
    throw new GfsStoreRecoveryError('snapshot_changed')
  return input.withPhysicalFence(async assertHeld => {
    await assertHeld()
    const state = await snapshot(input.hostRoot, assertHeld)
    if (
      state.inventory.ledgerSha256 !== input.expectedLedgerSha256 ||
      state.inventory.writerFenceSha256 !== input.expectedWriterFenceSha256 ||
      state.inventory.sourceInventorySha256 !== input.expectedSourceInventorySha256
    )
      throw new GfsStoreRecoveryError('snapshot_changed')
    const executionIds = input.settledProcessingLeaseIds
    const ownerIds = input.terminalReceiptOwnerIds ?? []
    const transferIds = input.removeSettledTransferIds ?? []
    selected(executionIds, state.ledger.processingLeases ?? {})
    selected(ownerIds, state.ledger.retentionOwners ?? {})
    selected(transferIds, state.ledger.records)
    for (const id of transferIds) {
      const record = state.ledger.records[id]
      if (
        record.state === 'completed' ||
        record.sha256 !== undefined ||
        state.sources.find(item => item.id === id)?.source.present ||
        Object.values(state.ledger.processingLeases ?? {}).some(
          lease => !executionIds.includes(lease.leaseId) && lease.recordIds.includes(id)
        ) ||
        Object.values(state.ledger.retentionOwners ?? {}).some(
          owner => !ownerIds.includes(owner.ownerId) && owner.recordIds.includes(id)
        )
      )
        throw new GfsStoreRecoveryError('invalid_selection')
    }
    const writer = new GfsStoreWriterLease(state.storeRoot, false)
    try {
      await writer.acquireForRecovery({
        expectedWriterFenceSha256: input.expectedWriterFenceSha256,
        assertPhysicalFenceHeld: assertHeld,
      })
      // Metadata settlement is durable before deleting a selected partial. A
      // crash before that commit retains every reservation; a crash afterward
      // leaves all remaining bytes charged until deletion is positively proven.
      for (const id of executionIds) delete state.ledger.processingLeases![id]
      for (const id of ownerIds) delete state.ledger.retentionOwners![id]
      for (const record of Object.values(state.ledger.records)) {
        const source = state.sources.find(item => item.id === record.id)?.source
        const published =
          source?.present &&
          source.sizeBytes === record.sizeBytes &&
          source.sha256 === record.sha256 &&
          record.sha256 !== undefined
        record.state =
          Object.keys(state.ledger.processingLeases ?? {}).length === 0 && published
            ? 'completed'
            : 'quarantined'
      }
      await persist(state, writer, assertHeld)
      for (const id of transferIds) {
        const record: GfsDownloadRecord = state.ledger.records[id]
        const directory = path.join(state.root, record.directory)
        await assertHeld()
        await writer.verifyHeld()
        try {
          await verifyCallerRoot(path.dirname(path.dirname(directory)))
          await verifyDirectory(path.dirname(directory))
          await verifyDirectory(directory)
          await assertHeld()
          await writer.verifyHeld()
          await fs.rm(directory, { recursive: true, force: true })
          await fs.lstat(directory)
          throw new GfsStoreRecoveryError('storage_write_failed')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            if (error instanceof GfsStoreRecoveryError) throw error
            throw new GfsStoreRecoveryError('storage_write_failed')
          }
        }
        await assertHeld()
        await writer.verifyHeld()
        delete state.ledger.records[id]
        await persist(state, writer, assertHeld)
      }
      await assertHeld()
      await writer.verifyHeld()
      const after = (await snapshot(input.hostRoot, assertHeld)).inventory
      return {
        before: state.inventory,
        after,
        settledProcessingLeases: executionIds.length,
        terminalReceiptOwners: ownerIds.length,
        removedSettledTransfers: transferIds.length,
      }
    } finally {
      await writer.release()
    }
  })
}
