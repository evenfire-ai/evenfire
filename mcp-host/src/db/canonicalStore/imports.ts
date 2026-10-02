import * as path from 'node:path'
import type { ExportManifest } from './export'
import { readJson, validateJournal } from './journal'
import {
  assertUuid,
  candidateKey,
  compareBinding,
  exists,
  fingerprints,
  objectHash,
  operationDirectory,
} from './paths'
import { type Binding, type CandidateId, CanonicalStoreError } from './types'

export interface ImportConsumption extends Binding {
  consumptionVersion: 1
  exportId: string
  migrationId: string
  sourceHash: string
}
export function readImportManifest(root: string, id: string, binding: Binding): ExportManifest {
  assertUuid(id)
  const directory = path.join(root, '.canonical-store-import', id)
  const file = path.join(directory, 'manifest.json')
  if (!exists(file)) throw new CanonicalStoreError('SourceExportRequired')
  const manifest = readJson(root, file) as ExportManifest
  compareBinding(manifest, binding)
  if (
    manifest.schemaVersion !== 1 ||
    manifest.exportId !== id ||
    !manifest.maintenanceId ||
    !/^[0-9a-f]{64}$/.test(manifest.catalogHash) ||
    !Number.isSafeInteger(manifest.sourceSchemaVersion) ||
    !Array.isArray(manifest.files) ||
    Object.keys(manifest).some(
      key =>
        ![
          'schemaVersion',
          'exportId',
          'hostUid',
          'pvcUid',
          'maintenanceId',
          'catalogHash',
          'sourceSchemaVersion',
          'sourceStoreId',
          'files',
        ].includes(key)
    )
  ) {
    throw new CanonicalStoreError('JournalInvalid')
  }
  if (manifest.sourceStoreId !== undefined) assertUuid(manifest.sourceStoreId)
  return manifest
}
/** Consumed imports retain their manifest and original bytes in the completed migration's retired set. */
export function isImportConsumed(
  root: string,
  id: string,
  binding: Binding,
  manifest: ExportManifest,
  metadataOnly = false
): boolean {
  const file = path.join(root, '.canonical-store-import', id, 'consumed.json')
  if (!exists(file)) return false
  const receipt = readJson(root, file) as ImportConsumption
  compareBinding(receipt, binding)
  assertUuid(receipt.migrationId)
  const expected: ImportConsumption = {
    consumptionVersion: 1,
    ...binding,
    exportId: id,
    migrationId: receipt.migrationId,
    sourceHash: objectHash(manifest.files),
  }
  if (objectHash(receipt) !== objectHash(expected)) throw new CanonicalStoreError('JournalInvalid')
  const journal = validateJournal(
    readJson(root, path.join(operationDirectory(root, receipt.migrationId), 'journal.json')),
    binding
  )
  const candidateId: CandidateId = `C_import:${id}`
  const candidate = journal.candidates.find(candidate => candidate.id === candidateId)
  if (journal.phase !== 'completed' || !candidate || candidate.sourceHash !== receipt.sourceHash)
    throw new CanonicalStoreError('JournalInvalid')
  const retired = path.join(
    operationDirectory(root, receipt.migrationId),
    'retired',
    candidateKey(candidateId)
  )
  if (!metadataOnly && objectHash(fingerprints(root, retired)) !== receipt.sourceHash)
    throw new CanonicalStoreError('JournalInvalid')
  return true
}
