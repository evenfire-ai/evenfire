import * as fs from 'node:fs'
import * as path from 'node:path'
import { discoverBackupSets } from './backups'
import { validateCanonicalStore, validateLegacyStore } from './bootGuard'
import { verifyBootstrapReceipt } from './bootstrapReceipt'
import { workspaceManifest } from './canonicalStoreInit'
import { classifyCandidates } from './classifyCandidates'
import { isImportConsumed, readImportManifest } from './imports'
import { inspectCandidate } from './inspectCandidate'
import {
  FINAL_MARKER,
  LEGACY_MARKER,
  MIGRATING_MARKER,
  manifestHash,
  readJournal,
  readJson,
  readMarker,
  validateJournal,
} from './journal'
import {
  SQLITE_FILES,
  assertUuid,
  candidateDirectory,
  exists,
  fingerprints,
  objectHash,
  operationDirectory,
  safePath,
} from './paths'
import {
  type Binding,
  type CandidateId,
  type CandidateManifest,
  CanonicalStoreError,
  LIMITS,
  type WriterFence,
} from './types'
import { acquireWriterFence } from './writerFence'

export type PreparationSourceClass =
  | 'sqlite-pvc'
  | 'sqlite-external-exported'
  | 'new-host'
  | 'memory'
  | 'unknown'
export interface PhysicalProofOptions {
  root: string
  binding: Binding
  maintenanceId: string
  scratchRoot: string
  exportId?: string
  expectedManifestHash?: string
  fence?: WriterFence
  storageContract?: 'canonical' | 'legacy-floor'
}
export interface PhysicalStoreProof extends Binding {
  storageContract?: 'canonical' | 'legacy-floor'
  layoutVersion?: 1
  databasePath?: 'state/state.db'
  writerFenceRoot?: 'state'
  proofVersion: 1
  outcome: 'ok'
  reason: 'NoCollision' | 'InventoryVerified'
  candidateDisposition?: 'divergent'
  maintenanceId: string
  sourceClass: PreparationSourceClass
  manifestHash: string
  sourceHash?: string
  catalogHash?: string
  schemaVersion?: number
  exportId?: string
  migrationId?: string
  storeId?: string
  currentCatalogHash?: string
  candidateHash?: string
  sourceSnapshotHash?: string
  backupSnapshotHash?: string
  sourcePodUid?: string
  bootstrapRequestId?: string
  closedWitnessHash?: string
  runtimeClosureHash?: string
}
function validateOptions(options: PhysicalProofOptions): void {
  safePath(options.root, options.root)
  safePath(options.scratchRoot, options.scratchRoot)
  if (!options.maintenanceId || options.maintenanceId.length > 256)
    throw new CanonicalStoreError('MigrationMaintenanceRequired')
  if (options.expectedManifestHash && !/^[0-9a-f]{64}$/.test(options.expectedManifestHash))
    throw new CanonicalStoreError('AdoptBindingMismatch')
}
function proofBase(options: PhysicalProofOptions, sourceClass: PreparationSourceClass) {
  return {
    proofVersion: 1 as const,
    outcome: 'ok' as const,
    reason: 'NoCollision' as const,
    ...options.binding,
    maintenanceId: options.maintenanceId,
    sourceClass,
    ...(options.storageContract ? { storageContract: options.storageContract } : {}),
  }
}
function pvcCandidates(root: string): CandidateId[] {
  const ids: CandidateId[] = []
  for (const id of ['C_state', 'C_root', 'C_ws'] as const) {
    const directory = candidateDirectory(root, id)
    if (!exists(directory)) continue
    safePath(root, directory)
    if (!fs.statSync(directory).isDirectory()) throw new CanonicalStoreError('LayoutUnsafe')
    const files = fingerprints(root, directory)
    if (!files[0].present && files.some(file => file.present))
      throw new CanonicalStoreError('CandidateIncomplete')
    if (files[0].present) ids.push(id)
  }
  return ids
}
async function inspectPhysical(directory: string, options: PhysicalProofOptions) {
  return inspectCandidate(directory, {
    root: options.root,
    scratchRoot: options.scratchRoot,
    scratchDir: path.join(options.scratchRoot, '.canonical-store-verification'),
    binding: options.binding,
    live: true,
  })
}
/** Physical data verification only: the controller separately proves fresh authority, writer shutdown and newly-provisioned status. */
export async function verifyPreparation(
  sourceClass: PreparationSourceClass,
  options: PhysicalProofOptions
): Promise<PhysicalStoreProof> {
  validateOptions(options)
  if (sourceClass === 'memory') throw new CanonicalStoreError('SourceExportRequired')
  if (sourceClass === 'unknown') throw new CanonicalStoreError('StoreModeUnknown')
  if (!['sqlite-pvc', 'sqlite-external-exported', 'new-host'].includes(sourceClass))
    throw new CanonicalStoreError('StoreModeUnknown')
  if (
    readJournal(options.root, options.binding) ||
    exists(path.join(options.root, MIGRATING_MARKER))
  )
    throw new CanonicalStoreError('MigrationInProgress')
  if (sourceClass === 'sqlite-external-exported') {
    if (!options.exportId) throw new CanonicalStoreError('SourceExportRequired')
    assertUuid(options.exportId)
    const manifest = readImportManifest(options.root, options.exportId, options.binding)
    if (
      manifest.maintenanceId !== options.maintenanceId ||
      isImportConsumed(options.root, options.exportId, options.binding, manifest, true)
    )
      throw new CanonicalStoreError('AdoptBindingMismatch')
    const directory = candidateDirectory(options.root, `C_import:${options.exportId}`)
    const before = fingerprints(options.root, directory)
    if (objectHash(before) !== objectHash(manifest.files))
      throw new CanonicalStoreError('CandidateChangedDuringMigration')
    const inspected = await inspectPhysical(directory, options)
    try {
      if (options.storageContract === 'legacy-floor' && inspected.identity)
        throw new Error('CanonicalStoreLayoutRollback')
      const measured = objectHash(manifest)
      if (
        inspected.catalogHash !== manifest.catalogHash ||
        (manifest.sourceStoreId !== undefined &&
          inspected.identity?.storeId !== manifest.sourceStoreId) ||
        (options.expectedManifestHash && options.expectedManifestHash !== measured) ||
        objectHash(fingerprints(options.root, directory)) !== objectHash(before)
      ) {
        throw new CanonicalStoreError('CandidateChangedDuringMigration')
      }
      const bootstrap = await verifyBootstrapReceipt({
        root: options.root,
        scratchRoot: options.scratchRoot,
        binding: options.binding,
        exportId: options.exportId,
        maintenanceId: options.maintenanceId,
        manifestHash: measured,
        catalogHash: inspected.catalogHash,
      })
      return {
        ...proofBase(options, sourceClass),
        manifestHash: measured,
        sourceHash: objectHash(manifest.files),
        sourceSnapshotHash: bootstrap.sourceSnapshotHash,
        backupSnapshotHash: bootstrap.backupSnapshotHash,
        sourcePodUid: bootstrap.sourcePodUid,
        bootstrapRequestId: bootstrap.requestId,
        closedWitnessHash: bootstrap.closedWitnessHash,
        runtimeClosureHash: bootstrap.runtimeClosureHash,
        catalogHash: inspected.catalogHash,
        schemaVersion: inspected.schemaVersion,
        exportId: options.exportId,
      }
    } finally {
      inspected.dispose()
    }
  }
  const ids = pvcCandidates(options.root)
  const imports = path.join(options.root, '.canonical-store-import')
  if (exists(imports) && fs.readdirSync(imports).length !== 0)
    throw new CanonicalStoreError('SourceExportRequired')
  if (sourceClass === 'new-host') {
    if (
      ids.length !== 0 ||
      discoverBackupSets(options.root).length !== 0 ||
      exists(path.join(options.root, FINAL_MARKER)) ||
      exists(path.join(options.root, LEGACY_MARKER))
    )
      throw new CanonicalStoreError('SourceExportRequired')
    const records = path.join(options.root, 'state', '.canonical-store')
    if (
      exists(records) &&
      fs
        .readdirSync(records)
        .some(
          name =>
            /^[0-9a-f-]{36}$/i.test(name) ||
            name === 'journal.json' ||
            name === 'legacy-layout.json'
        )
    )
      throw new CanonicalStoreError('SourceExportRequired')
    const measured = objectHash({ candidates: [], backups: [], imports: [] })
    if (options.expectedManifestHash && measured !== options.expectedManifestHash)
      throw new CanonicalStoreError('AdoptBindingMismatch')
    return { ...proofBase(options, sourceClass), manifestHash: measured }
  }
  if (ids.length === 0) throw new CanonicalStoreError('SourceExportRequired')
  if (ids.length > LIMITS.maxCandidates) throw new CanonicalStoreError('ManifestTooLarge')
  const candidates: CandidateManifest[] = []
  for (const id of ids) {
    const directory = candidateDirectory(options.root, id)
    const files = fingerprints(options.root, directory)
    const inspected = await inspectPhysical(directory, options)
    try {
      if (options.storageContract === 'legacy-floor' && inspected.identity)
        throw new Error('CanonicalStoreLayoutRollback')
      if (objectHash(fingerprints(options.root, directory)) !== objectHash(files))
        throw new CanonicalStoreError('CandidateChangedDuringMigration')
      candidates.push({
        id,
        files,
        sourceHash: objectHash(files),
        inspection: {
          schemaVersion: inspected.schemaVersion,
          catalogHash: inspected.catalogHash,
          tableHashes: inspected.tableHashes,
          counts: inspected.counts,
          empty: inspected.empty,
          ...(inspected.identity ? { identity: inspected.identity } : {}),
        },
      })
    } finally {
      inspected.dispose()
    }
  }
  const measured = manifestHash({ candidates, workspace: workspaceManifest(options.root) })
  if (options.expectedManifestHash && measured !== options.expectedManifestHash)
    throw new CanonicalStoreError('AdoptBindingMismatch')
  for (const candidate of candidates) {
    if (
      objectHash(fingerprints(options.root, candidateDirectory(options.root, candidate.id))) !==
      candidate.sourceHash
    )
      throw new CanonicalStoreError('CandidateChangedDuringMigration')
  }
  let selected: CandidateId
  try {
    selected = classifyCandidates(candidates).selected
  } catch (error) {
    if (!(error instanceof CanonicalStoreError) || error.reason !== 'DivergentCandidates')
      throw error
    // Preparation authenticates an exact intact inventory. Selection remains blocked in the mutator's durable journal.
    return {
      ...proofBase(options, sourceClass),
      reason: 'InventoryVerified',
      candidateDisposition: 'divergent',
      manifestHash: measured,
    }
  }
  const selectedCandidate = candidates.find(candidate => candidate.id === selected)!
  return {
    ...proofBase(options, sourceClass),
    manifestHash: measured,
    sourceHash: selectedCandidate.sourceHash,
    catalogHash: selectedCandidate.inspection!.catalogHash,
    schemaVersion: selectedCandidate.inspection!.schemaVersion,
  }
}
/** Read the current accepted catalog under the actual runtime fence, or after separately verified writer shutdown. */
export async function verifyCurrent(options: PhysicalProofOptions): Promise<PhysicalStoreProof> {
  validateOptions(options)
  const own = options.fence
    ? undefined
    : acquireWriterFence({ stateDir: path.join(options.root, 'state'), requireExisting: true })
  const fence = options.fence ?? own!
  try {
    fence.assertHeld()
    const floor = options.storageContract === 'legacy-floor'
    const identity = floor
      ? undefined
      : validateCanonicalStore({
          root: options.root,
          stateDir: path.join(options.root, 'state'),
          binding: options.binding,
        })
    const marker = floor
      ? validateLegacyStore({
          root: options.root,
          stateDir: path.join(options.root, 'state'),
          binding: options.binding,
        })
      : readMarker(options.root, options.binding)!
    const journal = validateJournal(
      readJson(
        options.root,
        path.join(operationDirectory(options.root, marker.migrationId), 'journal.json')
      ),
      options.binding
    )
    if (
      journal.phase !== 'completed' ||
      journal.writer !== (floor ? 'layout-precheck' : 'canonical-store') ||
      (floor ? journal.identity !== undefined : journal.identity?.storeId !== identity!.storeId) ||
      journal.migrationId !== marker.migrationId ||
      (options.expectedManifestHash && journal.manifestHash !== options.expectedManifestHash)
    )
      throw new CanonicalStoreError('AdoptBindingMismatch')
    const inspected = await inspectCandidate(path.join(options.root, 'state'), {
      root: options.root,
      scratchRoot: options.scratchRoot,
      scratchDir: path.join(options.scratchRoot, '.canonical-store-verification'),
      binding: options.binding,
      fence,
    })
    try {
      fence.assertHeld()
      const candidate = journal.candidates.find(candidate => candidate.id === journal.selected)
      return {
        ...proofBase(options, 'sqlite-pvc'),
        migrationId: marker.migrationId,
        ...(floor
          ? {
              storageContract: 'legacy-floor' as const,
              layoutVersion: 1 as const,
              databasePath: 'state/state.db' as const,
              writerFenceRoot: 'state' as const,
            }
          : { storeId: identity!.storeId }),
        manifestHash: journal.manifestHash!,
        catalogHash: inspected.catalogHash,
        currentCatalogHash: inspected.catalogHash,
        ...(candidate ? { candidateHash: candidate.sourceHash } : {}),
      }
    } finally {
      inspected.dispose()
    }
  } finally {
    own?.close()
  }
}
