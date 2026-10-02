import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { nodeFs } from './fsPort'
import { isImportConsumed, readImportManifest } from './imports'
import { inspectCandidate } from './inspectCandidate'
import { atomicJson, readJson } from './journal'
import {
  assertUuid,
  compareBinding,
  exists,
  fingerprints,
  objectHash,
  privateDirectory,
  safePath,
  syncDirectory,
  syncFile,
  validateSqliteSetPaths,
} from './paths'
import { createPrivateScratch } from './privateScratch'
import {
  type Binding,
  CanonicalStoreError,
  type FileFingerprint,
  LIMITS,
  type WriterFence,
} from './types'
import { acquireWriterFence } from './writerFence'

export interface ExportManifest extends Binding {
  schemaVersion: 1
  exportId: string
  maintenanceId: string
  catalogHash: string
  sourceSchemaVersion: number
  sourceStoreId?: string
  files: FileFingerprint[]
}
export interface ExportOptions {
  root: string
  sourcePath: string
  exportId: string
  binding: Binding
  maintenanceId: string
  /** Runtime exports use the already held worker fence after admission has drained. */
  fence?: WriterFence
  timeoutMs?: number
}
/** Export under a held writer fence and maintenance barrier; the fence is never reacquired by a live owner. */
export async function exportCanonicalStore(options: ExportOptions): Promise<ExportManifest> {
  assertUuid(options.exportId)
  if (!options.maintenanceId || options.maintenanceId.length > 256)
    throw new CanonicalStoreError('MigrationMaintenanceRequired')
  const root = path.resolve(options.root)
  safePath(root, root)
  const sourcePath = path.resolve(options.sourcePath)
  safePath(path.dirname(sourcePath), sourcePath)
  const ownedFence = options.fence
    ? undefined
    : acquireWriterFence({
        stateDir: path.join(root, 'state'),
        timeoutMs: options.timeoutMs ?? 1000,
      })
  const fence = options.fence ?? ownedFence!
  let privateStage: ReturnType<typeof createPrivateScratch> | undefined
  let inspectionCopy: Awaited<ReturnType<typeof inspectCandidate>> | undefined
  try {
    fence.assertHeld()
    const bytes = validateSqliteSetPaths(path.dirname(sourcePath), sourcePath)
    const space = fs.statfsSync(root)
    if (BigInt(space.bsize) * BigInt(space.bavail) < BigInt(bytes) * 8n + 16n * 1024n * 1024n)
      throw new CanonicalStoreError('InsufficientSpace')
    const imports = path.join(root, '.canonical-store-import')
    privateDirectory(root, imports)
    const destination = path.join(imports, options.exportId)
    safePath(root, destination, true)
    let existingManifest: ExportManifest | undefined
    if (exists(destination)) {
      const manifest = readImportManifest(root, options.exportId, options.binding)
      compareBinding(manifest, options.binding)
      if (
        manifest.schemaVersion !== 1 ||
        manifest.exportId !== options.exportId ||
        manifest.maintenanceId !== options.maintenanceId ||
        (objectHash(manifest.files) !== objectHash(fingerprints(root, destination)) &&
          !isImportConsumed(root, options.exportId, options.binding, manifest))
      )
        throw new CanonicalStoreError('AdoptBindingMismatch')
      existingManifest = manifest
    }
    const stagingParent = path.join(root, 'state', '.canonical-store', `export-${options.exportId}`)
    privateDirectory(root, stagingParent)
    privateStage = createPrivateScratch(root, stagingParent)
    const staging = privateStage.directory
    const database = path.join(staging, 'state.db')
    const source = new Database(sourcePath, {
      readonly: true,
      fileMustExist: true,
      timeout: options.timeoutMs ?? 1000,
    })
    try {
      const deadline = Date.now() + (options.timeoutMs ?? LIMITS.timeoutMs)
      await source.backup(database, {
        progress() {
          fence.assertHeld()
          if (Date.now() > deadline) throw new CanonicalStoreError('ManifestTooLarge')
          return 128
        },
      })
    } finally {
      source.close()
    }
    fs.chmodSync(database, 0o600)
    fence.assertHeld()
    const inspected = await inspectCandidate(staging, {
      root,
      scratchDir: path.join(stagingParent, 'validation'),
      binding: options.binding,
      fence,
      timeoutMs: options.timeoutMs,
    })
    inspectionCopy = inspected
    const manifest: ExportManifest = {
      schemaVersion: 1,
      exportId: options.exportId,
      ...options.binding,
      maintenanceId: options.maintenanceId,
      catalogHash: inspected.catalogHash,
      sourceSchemaVersion: inspected.schemaVersion,
      files: fingerprints(root, staging),
      ...(inspected.identity ? { sourceStoreId: inspected.identity.storeId } : {}),
    }
    inspected.dispose()
    if (existingManifest) {
      if (
        existingManifest.catalogHash !== manifest.catalogHash ||
        existingManifest.sourceStoreId !== manifest.sourceStoreId
      )
        throw new CanonicalStoreError('CandidateChangedDuringMigration')
      return existingManifest
    }
    atomicJson(root, path.join(staging, 'manifest.json'), manifest)
    syncFile(root, database)
    syncDirectory(root, staging)
    fence.assertHeld()
    safePath(root, destination, true)
    if (exists(destination)) throw new CanonicalStoreError('FileMoveConflict')
    nodeFs.renameSync(staging, destination)
    syncDirectory(root, stagingParent)
    syncDirectory(root, imports)
    return manifest
  } finally {
    try {
      inspectionCopy?.dispose()
      privateStage?.dispose()
    } finally {
      ownedFence?.close()
    }
  }
}
