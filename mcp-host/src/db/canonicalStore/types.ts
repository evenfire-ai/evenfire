import type { FsPort } from './fsPort'

export interface Binding {
  hostUid: string
  pvcUid: string
}
export interface CanonicalIdentity extends Binding {
  storeId: string
  layoutVersion: 1
  createdAt: string
  provenance: string
}
export type Writer = 'canonical-store' | 'layout-precheck'
export type CandidateId = 'C_root' | 'C_ws' | 'C_state' | `C_import:${string}`
export type Phase =
  | 'started'
  | 'snapshotted'
  | 'staged'
  | 'retiring'
  | 'promoted'
  | 'relocating'
  | 'completed'
export const REASON_EXITS = {
  NoCollision: 0,
  InventoryVerified: 0,
  AlreadyCanonical: 0,
  AlreadyLegacy: 0,
  Created: 0,
  SingleCandidate: 0,
  EquivalentCandidates: 0,
  EmptyCandidateRetired: 0,
  Adopted: 0,
  CandidateCorrupt: 2,
  CandidateIncomplete: 2,
  SchemaUnsupported: 2,
  DivergentCandidates: 3,
  ForeignCandidateAfterCanonical: 3,
  ForeignCandidateDuringMigration: 3,
  CandidateChangedDuringMigration: 3,
  FileMoveConflict: 3,
  MigrationInProgress: 3,
  MigrationIdCollision: 3,
  HostUidMismatch: 3,
  PvcUidMismatch: 3,
  MarkerMismatch: 3,
  AdoptFingerprintUnknown: 3,
  AdoptBindingMismatch: 3,
  AdoptReplay: 3,
  AdoptUnauthorized: 3,
  ImageFloorMissing: 4,
  InsufficientSpace: 5,
  WorkspaceEntryCollision: 6,
  SqliteSetSplit: 6,
  SqliteDestinationExists: 6,
  LayoutUnsafe: 7,
  JournalInvalid: 7,
  ManifestTooLarge: 7,
  WriterFenceBusy: 8,
  SourceExportRequired: 8,
  StoreModeUnknown: 8,
  MigrationMaintenanceRequired: 8,
} as const
export type Reason = keyof typeof REASON_EXITS
export class CanonicalStoreError extends Error {
  readonly exitCode: number
  constructor(
    readonly reason: Reason,
    message: string = reason
  ) {
    super(message)
    this.name = 'CanonicalStoreError'
    this.exitCode = REASON_EXITS[reason]
  }
}
export interface InitOutcome {
  outcome: 'ok' | 'blocked'
  reason: Reason
  layoutVersion?: 1
  storeId?: string
  storageContract?: 'legacy-floor' | 'canonical'
  catalogHash?: string
  currentCatalogHash?: string
  manifestHash?: string
  candidateHash?: string
  requestHash?: string
  requestId?: string
  controllerUid?: string
  capabilityId?: string
  migrationId?: string
  databasePath?: 'state/state.db'
  writerFenceRoot?: 'state'
}
export function legacyOutcome(reason: Reason, marker: LegacyLayoutMarker): InitOutcome {
  return {
    outcome: REASON_EXITS[reason] === 0 ? 'ok' : 'blocked',
    reason,
    storageContract: 'legacy-floor',
    layoutVersion: 1,
    migrationId: marker.migrationId,
    databasePath: marker.databasePath,
    writerFenceRoot: marker.writerFenceRoot,
  }
}
export function outcome(reason: Reason, identity?: CanonicalIdentity): InitOutcome {
  return {
    outcome: REASON_EXITS[reason] === 0 ? 'ok' : 'blocked',
    reason,
    ...(identity ? { layoutVersion: identity.layoutVersion, storeId: identity.storeId } : {}),
  }
}
export interface FileFingerprint {
  name: string
  present: boolean
  size: number
  sha256: string | null
}
export interface CatalogInspection {
  schemaVersion: number
  catalogHash: string
  tableHashes: Record<string, string>
  counts: Record<string, number>
  empty: boolean
  identity?: CanonicalIdentity
}
export interface CandidateManifest {
  id: CandidateId
  files: FileFingerprint[]
  sourceHash: string
  inspection?: CatalogInspection
}
export interface MoveOperation {
  kind: 'sqlite' | 'workspace' | 'promotion'
  candidate?: CandidateId
  name: string
  fingerprint: string
  size: number
  identity?: { dev: number; ino: number }
  entries?: number
  state: 'pending' | 'intent' | 'done'
}
export interface NewStoreProvenance {
  kind: 'new-host' | 'verified-empty-sqlite'
  hostUid: string
  pvcUid: string
  maintenanceId: string
}
export interface OperatorMigrationContext {
  kind:
    | 'canonical-migration'
    | 'canonical-new-host-initialization'
    | 'legacy-floor-migration'
    | 'legacy-floor-new-host-initialization'
  storageContract?: 'canonical' | 'legacy-floor'
  requestId: string
  maintenanceId: string
  principal: string
  sourceClass: 'sqlite-pvc' | 'sqlite-external-exported' | 'new-host'
  verifiedManifestHash: string
  requestHash: string
  provisioning?: Binding & { createdAt: string }
}
export interface MigrationJournal extends Binding {
  journalVersion: 1
  migrationId: string
  writer: Writer
  phase: Phase
  candidates: CandidateManifest[]
  manifestHash?: string
  workspace: MoveOperation[]
  operations: MoveOperation[]
  decision?:
    | 'Created'
    | 'SingleCandidate'
    | 'EquivalentCandidates'
    | 'EmptyCandidateRetired'
    | 'Adopted'
  selected?: CandidateId
  variant?: 'keep-existing-state' | 'promote-staging'
  expectedCatalogHash?: string
  stagingSha256?: string
  identity?: CanonicalIdentity
  blockedReason?: Reason
  operator?: OperatorMigrationContext
  allocation?: {
    state: 'intent' | 'done'
    ownerUid: number
    ownerGid: number
    identity?: { dev: number; ino: number }
  }
  provenance?: NewStoreProvenance
  adoption?: {
    request: AdoptionRequest | RecoveryRequest | LegacyAdoptionRequest | LegacyRecoveryRequest
    principal: string
    consumed: true
  }
  recovery?: {
    request: RecoveryRequest | LegacyRecoveryRequest
    principal: string
    selectedCandidate: CandidateId
    previousMarker: FinalMarker | LegacyLayoutMarker
    previousMarkerMove: 'pending' | 'intent' | 'done'
    previousStateMarkerMove?: 'pending' | 'intent' | 'done'
  }
}
export interface FinalMarker extends Binding {
  markerVersion: 1
  layoutVersion: 1
  storeId: string
  migrationId: string
}
export interface LegacyLayoutMarker extends Binding {
  markerVersion: 1
  layoutVersion: 1
  storageContract: 'legacy-floor'
  migrationId: string
  databasePath: 'state/state.db'
  writerFenceRoot: 'state'
}
export interface AdoptionRequest extends Binding {
  storageContract?: 'canonical' | 'legacy-floor'
  schemaVersion: 1
  requestId: string
  maintenanceId: string
  migrationId: string
  manifestHash: string
  candidateHash: string
}
export interface LegacyAdoptionRequest extends AdoptionRequest {
  storageContract: 'legacy-floor'
}
export interface LegacyRecoveryRequest extends LegacyAdoptionRequest {
  expectedMigrationId: string
  expectedCurrentCatalogHash: string
}
export interface LegacyOperatorAuthorization extends OperatorAuthorization {
  kind: 'legacy-floor-adoption'
  storageContract: 'legacy-floor'
}
export interface RecoveryRequest extends AdoptionRequest {
  expectedStoreId: string
  expectedCurrentCatalogHash: string
}
/** Supply only after authenticating an operator and validating the maintenance binding.
 * An annotation, caller-supplied hash, or tenant identity is not this capability. */
export interface OperatorAuthorization extends Binding {
  storageContract?: 'canonical' | 'legacy-floor'
  authorized: true
  principal: string
  maintenanceId: string
  requestId: string
}
export interface WriterFence {
  assertHeld(): void
  close(): void
}
export interface MigrationOptions {
  binding: Binding
  writer?: Writer
  provenance?: NewStoreProvenance
  operator?: OperatorMigrationContext
  fs?: FsPort
  fence?: WriterFence
  timeoutMs?: number
  statfs?: (path: string) => { bsize: number | bigint; bavail: number | bigint }
}
export const LIMITS = Object.freeze({
  maxCandidates: 64,
  maxEntries: 20000,
  maxBytes: 64 * 1024 ** 3,
  maxJournalBytes: 8 * 1024 ** 2,
  timeoutMs: 120000,
})
