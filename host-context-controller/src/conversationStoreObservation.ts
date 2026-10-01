/**
 * Canonical conversation-store observation contracts (#825).
 *
 * Pure, reconciler-state-free helpers shared by the HCC wiring and tests:
 * init termination-message parsing/coherence, the exact owner chain
 * HostUID -> DeploymentUID -> ReplicaSetUID -> PodUID, binding pins, the
 * deduplication key for init attempts, the stable storage-contract
 * templateRevision hash, operation request semantics, and the fail-closed
 * physical-evidence verifier contract.
 */
import * as k8s from '@kubernetes/client-node'
import * as crypto from 'crypto'
import type {
  ConversationStoreRequest,
  ConversationStoreStorageContract,
  HostConversationStoreStatus,
} from './types'

/**
 * Closed reason -> exit-code map. MUST stay in sync with the CLI's
 * REASON_EXITS table (mcp-host/src/db/canonicalStore/types.ts); HCC cannot
 * import runtime-package code, so the map is duplicated deliberately and this
 * comment is the coupling contract.
 */
export const CANONICAL_STORE_REASON_EXITS = {
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

export type CanonicalStoreCliReason = keyof typeof CANONICAL_STORE_REASON_EXITS

/** HCC-side classifications beyond the CLI's own closed reason map. */
export type ConversationStoreObservationReason =
  | CanonicalStoreCliReason
  | 'InitOutcomeMismatch'
  | 'InitFailedUnclassified'

export interface ConversationStoreInitOutcome {
  outcome: 'ok' | 'blocked'
  reason: CanonicalStoreCliReason
  storageContract?: ConversationStoreStorageContract
  layoutVersion?: number
  storeId?: string
  migrationId?: string
  catalogHash?: string
  databasePath?: 'state/state.db'
  writerFenceRoot?: 'state'
}

export interface VerifiedConversationStoreOutcome {
  valid: boolean
  reason: ConversationStoreObservationReason
  parsed?: ConversationStoreInitOutcome
}

/**
 * Parse and verify the single-line JSON termination message against the exit
 * code. The CLI contract (#825 section 5.4.1) requires exit/reason/outcome
 * coherence; incoherence is InitOutcomeMismatch and unknown data is
 * InitFailedUnclassified. Only the LAST terminated attempt of the init
 * container is authoritative.
 */
export function verifyConversationStoreInitOutcome(
  rawMessage: string | undefined,
  exitCode: number | undefined
): VerifiedConversationStoreOutcome {
  if (
    rawMessage === undefined ||
    rawMessage.trim() === '' ||
    Buffer.byteLength(rawMessage, 'utf8') > 4096 ||
    exitCode === undefined
  ) {
    return { valid: false, reason: 'InitFailedUnclassified' }
  }
  const lines = rawMessage.split('\n').filter(line => line.trim() !== '')
  if (lines.length !== 1) {
    return { valid: false, reason: 'InitFailedUnclassified' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(lines[0])
  } catch {
    return { valid: false, reason: 'InitFailedUnclassified' }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { valid: false, reason: 'InitFailedUnclassified' }
  }
  const candidate = parsed as Partial<ConversationStoreInitOutcome>
  if (
    (candidate.outcome !== 'ok' && candidate.outcome !== 'blocked') ||
    typeof candidate.reason !== 'string' ||
    !Object.hasOwn(CANONICAL_STORE_REASON_EXITS, candidate.reason)
  ) {
    return { valid: false, reason: 'InitFailedUnclassified' }
  }
  const reason = candidate.reason as CanonicalStoreCliReason
  if (candidate.layoutVersion !== undefined && candidate.layoutVersion !== 1) {
    return { valid: false, reason: 'InitOutcomeMismatch' }
  }
  if (
    candidate.storeId !== undefined &&
    (typeof candidate.storeId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(candidate.storeId))
  ) {
    return { valid: false, reason: 'InitOutcomeMismatch' }
  }
  if (
    candidate.storageContract !== undefined &&
    candidate.storageContract !== 'canonical' &&
    candidate.storageContract !== 'legacy-floor'
  )
    return { valid: false, reason: 'InitOutcomeMismatch' }
  if (candidate.storageContract === 'legacy-floor' && candidate.storeId !== undefined)
    return { valid: false, reason: 'InitOutcomeMismatch' }
  const expectedExit = CANONICAL_STORE_REASON_EXITS[reason]
  const expectedOutcome = expectedExit === 0 ? 'ok' : 'blocked'
  if (
    exitCode !== undefined &&
    (exitCode !== expectedExit || candidate.outcome !== expectedOutcome)
  ) {
    return { valid: false, reason: 'InitOutcomeMismatch' }
  }
  if (exitCode === undefined && candidate.outcome !== expectedOutcome) {
    return { valid: false, reason: 'InitOutcomeMismatch' }
  }
  return {
    valid: true,
    reason,
    parsed: candidate as ConversationStoreInitOutcome,
  }
}

/** True when the verified outcome establishes the canonical identity. */
export function isCanonicalSuccessOutcome(outcome: ConversationStoreInitOutcome): boolean {
  return (
    outcome.outcome === 'ok' &&
    outcome.storageContract !== 'legacy-floor' &&
    outcome.layoutVersion === 1 &&
    typeof outcome.storeId === 'string' &&
    outcome.storeId.length > 0 &&
    CANONICAL_STORE_REASON_EXITS[outcome.reason] === 0 &&
    outcome.reason !== 'NoCollision'
  )
}

export function isLegacyFloorSuccessOutcome(outcome: ConversationStoreInitOutcome): boolean {
  return (
    outcome.outcome === 'ok' &&
    outcome.storageContract === 'legacy-floor' &&
    outcome.layoutVersion === 1 &&
    outcome.storeId === undefined &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      outcome.migrationId ?? ''
    ) &&
    outcome.databasePath === 'state/state.db' &&
    outcome.writerFenceRoot === 'state' &&
    CANONICAL_STORE_REASON_EXITS[outcome.reason] === 0
  )
}

/**
 * Dedup key for an observed init attempt (#825): the exact pod, container,
 * restart count and finish time. The observation only reads terminated
 * attempts (lastState included by construction), so a retry that produces a
 * new restartCount/finishedAt is a NEW attempt while a relist that re-delivers
 * the same attempt is counted once.
 */
export function conversationStoreAttemptKey(
  podUid: string,
  containerName: string,
  restartCount: number,
  finishedAt: string | undefined
): string {
  return `${podUid}\u0000${containerName}\u0000${restartCount}\u0000${finishedAt ?? ''}`
}

export interface OwnerChainInput {
  hostUid: string
  deployment: k8s.V1Deployment
  replicaSets: k8s.V1ReplicaSet[]
  pods: k8s.V1Pod[]
}

export interface OwnerChainPod {
  pod: k8s.V1Pod
  replicaSet: k8s.V1ReplicaSet
}

function controlledBy(obj: k8s.V1ReplicaSet | k8s.V1Pod, ownerUid: string): boolean {
  return (
    obj.metadata?.ownerReferences?.some(ref => ref.uid === ownerUid && ref.controller === true) ??
    false
  )
}

/**
 * Resolve the EXACT owner chain HostUID -> DeploymentUID -> ReplicaSetUID ->
 * PodUID (#825). The Deployment must carry the HostUID annotation and its own
 * UID; only ReplicaSets controlled by that Deployment UID and Pods controlled
 * by one of those ReplicaSet UIDs are admitted. Anything else (foreign RS,
 * orphan Pod, stale annotation) is rejected rather than guessed.
 */
export function resolveConversationStoreOwnerChain(
  input: OwnerChainInput
): { ok: true; pods: OwnerChainPod[] } | { ok: false; reason: string } {
  const deploymentUid = input.deployment.metadata?.uid
  if (!deploymentUid) return { ok: false, reason: 'deployment has no UID' }
  if (input.deployment.metadata?.annotations?.['clerum.io/host-uid'] !== input.hostUid) {
    return { ok: false, reason: 'deployment HostUID annotation mismatch' }
  }
  const ownedReplicaSets = input.replicaSets.filter(rs => controlledBy(rs, deploymentUid))
  if (ownedReplicaSets.length === 0) {
    return { ok: false, reason: 'no ReplicaSet owned by the Deployment' }
  }
  const ownedByUid = new Map(ownedReplicaSets.map(rs => [rs.metadata?.uid ?? '', rs]))
  const pods: OwnerChainPod[] = []
  for (const pod of input.pods) {
    const ownerUid = pod.metadata?.ownerReferences?.find(ref => ref.controller === true)?.uid
    const replicaSet = ownerUid !== undefined ? ownedByUid.get(ownerUid) : undefined
    if (replicaSet !== undefined && pod.metadata?.uid) {
      pods.push({ pod, replicaSet })
    }
  }
  return { ok: true, pods }
}

/**
 * Binding pins (#825): the observed init container must carry the exact
 * HostUID/PVCUID env it was migrated under. A Pod from a different binding is
 * never accepted as evidence for this Host's store.
 */
export function conversationStoreInitBindingMatches(
  container: k8s.V1Container,
  hostUid: string,
  pvcUid: string
): boolean {
  const env = Object.fromEntries((container.env ?? []).map(v => [v.name, v.value]))
  return env.CLERUM_HOST_UID === hostUid && env.CLERUM_PVC_UID === pvcUid
}

/** Inputs to the stable storage-contract revision hash (#825). */
export interface ConversationStoreTemplateContract {
  storageContract?: ConversationStoreStorageContract
  contextMounts?: Array<{ name: string; mountPath: string; subPath?: string; readOnly?: boolean }>
  sourceEnvironment?: Array<{ name: string; valueFrom?: k8s.V1EnvVarSource }>
  image: string
  layoutVersion: 1
  workspaceSubPath: string
  stateSubPath: string
  stateMountPath: string
  sessionStore: string
  sessionDbDir: string
  canonicalRequired: string
  hostUid: string
  pvcUid: string
  initImage: string
  initCommand: string[]
  initArgs: string[]
  effectiveMode?: 'stateful' | 'stateless' | 'desktop'
  workspaceMountPath?: string
  lifecycleContract?: string
  initEnv?: Array<{ name: string; value?: string }>
}

/**
 * Compute the storage-contract templateRevision (#825): a stable sha256 over
 * everything that determines the on-disk identity and access path — effective
 * image, layout version, workspace/state subPath mounts, the session-store env
 * contract, the HostUID/PVCUID binding, and the init contract (CLI path +
 * migrate args).
 *
 * EXCLUDED BY DESIGN (documented whitelist): runtime-token secret refs and
 * values, runtime-token-revision and guardrails pod annotations, gateway URLs,
 * and context-mount env. Those are ephemeral credentials/configuration that
 * must renew without changing the storage contract or replaying
 * first-preparation. Transferring image authority is prevented because the
 * effective image IS included; only credential churn is excluded.
 */
export function computeConversationStoreTemplateRevision(
  contract: ConversationStoreTemplateContract
): string {
  const sorted = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sorted)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, sorted(entry)])
          )
        : value
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(sorted(contract)))
    .digest('hex')
}

/** Full immutable request identity includes the authenticated principal and all validated pins. */
export function computeConversationStoreRequestHash(request: ConversationStoreRequest): string {
  const sorted = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sorted)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, sorted(entry)])
          )
        : value
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(sorted(request)))
    .digest('hex')
}

/** Maintenance phases in which an adoption request may execute (#825). */
const ADOPTABLE_MAINTENANCE_PHASES = new Set(['fenced', 'migrating', 'failed'])

export interface ConversationStoreOperationSemanticsInput {
  operation: 'maintenance' | 'prepare' | 'adopt' | 'release'
  storageContract?: ConversationStoreStorageContract
  floorMigrationId?: string
  hasExpectedMigrationId?: boolean
  maintenancePhase: string | undefined
  layoutStoreId: string | undefined
  hasMigrationId: boolean
  hasManifestHash: boolean
  hasCandidateHash: boolean
  hasExpectedStoreId: boolean
  hasExpectedCurrentCatalogHash: boolean
}

/**
 * Closed operation semantics (#825): maintenance establishes quiescing;
 * prepare is request-lifecycle-only during same-bound quiescing (physical
 * evidence is a separate fail-closed verifier, never an ACK body); adoption
 * requires fenced/migrating/failed maintenance with migration/manifest/
 * candidate pins, and the expectedStoreId/expectedCurrentCatalogHash pair
 * exactly when a canonical layout already has a storeId; release requires
 * completed maintenance with complete pins.
 */
export function validateConversationStoreOperationSemantics(
  input: ConversationStoreOperationSemanticsInput
): { valid: true } | { valid: false; reason: string } {
  if (input.operation === 'adopt') {
    if (!input.maintenancePhase || !ADOPTABLE_MAINTENANCE_PHASES.has(input.maintenancePhase)) {
      return {
        valid: false,
        reason: 'adoption requires maintenance in fenced, migrating or failed state',
      }
    }
    if (!input.hasMigrationId || !input.hasManifestHash || !input.hasCandidateHash) {
      return {
        valid: false,
        reason: 'adoption requires migrationId, manifestHash and candidateHash pins',
      }
    }
    const floor = input.storageContract === 'legacy-floor'
    const hasIdentity = floor ? !!input.hasExpectedMigrationId : input.hasExpectedStoreId
    const currentIdentity = floor ? input.floorMigrationId : input.layoutStoreId
    if ((floor && input.hasExpectedStoreId) || (!floor && input.hasExpectedMigrationId))
      return { valid: false, reason: 'expected identity does not match storage contract' }
    const paired = hasIdentity && input.hasExpectedCurrentCatalogHash
    const neither = !hasIdentity && !input.hasExpectedCurrentCatalogHash
    if (!paired && !neither) {
      return {
        valid: false,
        reason: 'expectedStoreId and expectedCurrentCatalogHash must be paired',
      }
    }
    if (currentIdentity !== undefined && !hasIdentity) {
      return {
        valid: false,
        reason:
          'recovery against an existing canonical store requires the complete expected identity pair',
      }
    }
    if (currentIdentity === undefined && hasIdentity) {
      return {
        valid: false,
        reason: 'expected identity pair must not be fabricated before a canonical store exists',
      }
    }
    return { valid: true }
  }
  if (input.operation === 'release') {
    if (input.maintenancePhase !== 'completed') {
      return { valid: false, reason: 'release requires completed maintenance' }
    }
    const floor = input.storageContract === 'legacy-floor'
    if (
      (floor
        ? !input.hasExpectedMigrationId || input.hasExpectedStoreId
        : !input.hasExpectedStoreId || input.hasExpectedMigrationId) ||
      !input.hasExpectedCurrentCatalogHash
    ) {
      return { valid: false, reason: 'release requires current store identity and catalog pins' }
    }
    return { valid: true }
  }
  if (
    input.operation === 'prepare' &&
    !['quiescing', 'fenced', 'failed', 'migrating'].includes(input.maintenancePhase ?? '')
  ) {
    return { valid: false, reason: 'prepare requires active bound maintenance' }
  }
  return { valid: true }
}

/** Status-only operation progress is dispatchable; clocks and display readiness are not work. */
export function conversationStoreDispatchKey(
  store: HostConversationStoreStatus | undefined
): string {
  if (!store) return ''
  const without = <T extends object>(
    value: T | undefined,
    key: string
  ): Omit<T, keyof T> | undefined => {
    if (!value) return undefined
    const result = { ...value } as Record<string, unknown>
    delete result[key]
    return result as Omit<T, keyof T>
  }
  const maintenance = without(store.maintenance, 'updatedAt') as Record<string, unknown> | undefined
  if (maintenance) delete maintenance.startedAt
  const projection = {
    request: store.request,
    requestResult: without(store.requestResult, 'updatedAt'),
    maintenance,
    preparation: without(store.preparation, 'preparedAt'),
    layout: without(store.layout, 'committedAt'),
    compatibility: without(store.compatibility, 'establishedAt'),
    execution: without(store.execution, 'createdAt'),
    operationOutcome: store.operationOutcome,
    writerProof: without(store.writerProof, 'verifiedAt'),
    // Native PVC creation time is provenance, not an observation clock.
    provisioning: store.provisioning,
    provisioningIntent: without(store.provisioningIntent, 'recordedAt'),
    completion: store.completion,
  }
  const sorted = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sorted)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, sorted(entry)])
          )
        : value
  const key = JSON.stringify(sorted(projection))
  return key === '{}' ? '' : key
}
