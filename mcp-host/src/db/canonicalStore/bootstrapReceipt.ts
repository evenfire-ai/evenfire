import * as fs from 'node:fs'
import * as path from 'node:path'
import { inspectCandidate } from './inspectCandidate'
import { readJson } from './journal'
import {
  SQLITE_FILES,
  assertUuid,
  compareBinding,
  fileHash,
  fingerprints,
  objectHash,
  safePath,
} from './paths'
import { type Binding, CanonicalStoreError, type FileFingerprint, LIMITS } from './types'

export interface BootstrapReceipt extends Binding {
  receiptVersion: 1
  exportId: string
  requestId: string
  maintenanceId: string
  sourcePodUid: string
  sourceMode: 'sqlite'
  manifestHash: string
  catalogHash: string
  sourceSchemaVersion: number
  sourceFiles: FileFingerprint[]
  sourceSnapshotHash: string
  sourceBackups: Array<{ name: string; size: number; sha256: string }>
  backupSnapshotHash: string
  closedWriter: {
    pid: number
    startTimeTicks: string
    uid: 1001
    argvHash: string
    executable: string
    script: string
    mainSha256: string
  }
  closedWitnessHash: string
  runtimeClosureHash: string
}
function hash(value: unknown): void {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    throw new CanonicalStoreError('JournalInvalid')
}
/** Only retained physical bytes are proven here. Process/FD/supervisor closure must be freshly verified in the source Pod. */
export async function verifyBootstrapReceipt(options: {
  root: string
  scratchRoot: string
  binding: Binding
  exportId: string
  maintenanceId: string
  manifestHash: string
  catalogHash: string
}): Promise<BootstrapReceipt> {
  assertUuid(options.exportId)
  const directory = path.join(options.root, '.canonical-store-bootstrap', options.exportId)
  const receipt = readJson(options.root, path.join(directory, 'receipt.json')) as BootstrapReceipt
  const allowed = [
    'receiptVersion',
    'exportId',
    'requestId',
    'maintenanceId',
    'hostUid',
    'pvcUid',
    'sourcePodUid',
    'sourceMode',
    'manifestHash',
    'catalogHash',
    'sourceSchemaVersion',
    'sourceFiles',
    'sourceSnapshotHash',
    'sourceBackups',
    'backupSnapshotHash',
    'closedWriter',
    'closedWitnessHash',
    'runtimeClosureHash',
  ]
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    Object.keys(receipt).some(key => !allowed.includes(key))
  )
    throw new CanonicalStoreError('JournalInvalid')
  compareBinding(receipt, options.binding)
  assertUuid(receipt.exportId)
  assertUuid(receipt.requestId)
  assertUuid(receipt.sourcePodUid)
  if (
    receipt.receiptVersion !== 1 ||
    receipt.exportId !== options.exportId ||
    receipt.maintenanceId !== options.maintenanceId ||
    receipt.sourceMode !== 'sqlite' ||
    receipt.manifestHash !== options.manifestHash ||
    receipt.catalogHash !== options.catalogHash ||
    !Number.isSafeInteger(receipt.sourceSchemaVersion) ||
    receipt.sourceSchemaVersion < 1 ||
    !Array.isArray(receipt.sourceFiles) ||
    receipt.sourceFiles.length !== SQLITE_FILES.length ||
    !Array.isArray(receipt.sourceBackups) ||
    receipt.sourceBackups.length > LIMITS.maxCandidates * SQLITE_FILES.length
  )
    throw new CanonicalStoreError('AdoptBindingMismatch')
  for (const value of [
    receipt.manifestHash,
    receipt.catalogHash,
    receipt.sourceSnapshotHash,
    receipt.backupSnapshotHash,
    receipt.closedWitnessHash,
    receipt.runtimeClosureHash,
  ])
    hash(value)
  for (let index = 0; index < receipt.sourceFiles.length; index++) {
    const file = receipt.sourceFiles[index]
    if (
      !file ||
      Object.keys(file).some(key => !['name', 'present', 'size', 'sha256'].includes(key)) ||
      file.name !== SQLITE_FILES[index] ||
      typeof file.present !== 'boolean' ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > LIMITS.maxBytes ||
      (!file.present && (file.size !== 0 || file.sha256 !== null))
    )
      throw new CanonicalStoreError('JournalInvalid')
    if (file.present) hash(file.sha256)
  }
  if (
    objectHash(receipt.sourceFiles) !== receipt.sourceSnapshotHash ||
    objectHash(receipt.sourceBackups) !== receipt.backupSnapshotHash
  )
    throw new CanonicalStoreError('JournalInvalid')
  const sources = path.join(directory, 'sources')
  if (objectHash(fingerprints(options.root, sources)) !== receipt.sourceSnapshotHash)
    throw new CanonicalStoreError('CandidateChangedDuringMigration')
  const backups = path.join(directory, 'backups')
  safePath(options.root, backups)
  const names = fs.readdirSync(backups).sort()
  if (objectHash(names) !== objectHash(receipt.sourceBackups.map(file => file.name)))
    throw new CanonicalStoreError('CandidateChangedDuringMigration')
  for (const file of receipt.sourceBackups) {
    if (
      !file ||
      Object.keys(file).some(key => !['name', 'size', 'sha256'].includes(key)) ||
      !/^state\.db(?:-wal|-shm|-journal)?\.pre-[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.bak$/.test(
        file.name
      ) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > LIMITS.maxBytes
    )
      throw new CanonicalStoreError('JournalInvalid')
    hash(file.sha256)
    const target = path.join(backups, file.name)
    safePath(options.root, target)
    if (fs.statSync(target).size !== file.size || fileHash(options.root, target) !== file.sha256)
      throw new CanonicalStoreError('CandidateChangedDuringMigration')
  }
  const inspected = await inspectCandidate(sources, {
    root: options.root,
    scratchRoot: options.scratchRoot,
    scratchDir: path.join(options.scratchRoot, '.canonical-store-bootstrap-verification'),
    binding: options.binding,
    live: true,
  })
  try {
    if (
      inspected.catalogHash !== receipt.catalogHash ||
      inspected.schemaVersion !== receipt.sourceSchemaVersion ||
      objectHash(fingerprints(options.root, sources)) !== receipt.sourceSnapshotHash
    )
      throw new CanonicalStoreError('CandidateChangedDuringMigration')
  } finally {
    inspected.dispose()
  }
  return receipt
}
