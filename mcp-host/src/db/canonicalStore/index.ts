export * from './types'
export { nodeFs, type FsPort } from './fsPort'
export { acquireWriterFence } from './writerFence'
export {
  validateCanonicalStore,
  assertNoIncompleteCanonicalMigration,
  assertLegacyLayoutAllowed,
  bootCheck,
  legacyBootCheck,
  validateLegacyStore,
} from './bootGuard'
export { readIdentity, insertIdentity } from './identity'
export {
  inspectCandidate,
  validateSupportedSchema,
  catalogFingerprint,
  type InspectOptions,
  type InspectedCandidate,
} from './inspectCandidate'
export { classifyCandidates } from './classifyCandidates'
export { runMigration, discoverCandidates } from './canonicalStoreInit'
export { layoutPrecheck } from './layoutPrecheck'
export { exportCanonicalStore, type ExportManifest, type ExportOptions } from './export'
export { adoptCanonicalStore } from './adopt'
export {
  FINAL_MARKER,
  LEGACY_MARKER,
  LEGACY_STATE_RECORD,
  MIGRATING_MARKER,
  readLegacyMarker,
  readLegacyStateRecord,
  readJournal,
  manifestHash,
} from './journal'
export {
  discoverBackupSets,
  exportHistoricalBackup,
  type BackupSet,
  type BackupLocation,
  type BackupExportOptions,
} from './backups'
export {
  inspectRecovery,
  beginRecovery,
  inspectLegacyRecovery,
  beginLegacyRecovery,
  validateRecoveryContinuity,
  type RecoveryInspection,
  type LegacyRecoveryInspection,
} from './recovery'
export {
  verifyPreparation,
  verifyCurrent,
  type PhysicalProofOptions,
  type PhysicalStoreProof,
  type PreparationSourceClass,
} from './verification'
