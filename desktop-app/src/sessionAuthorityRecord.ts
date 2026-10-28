import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  type PendingExternalLogoutRawObservation,
  observePendingExternalLogoutRaw,
} from './pendingExternalLogout.js'
import {
  createSessionAuthorityFileDurablySync,
  renameSessionAuthorityFileDurablySync,
  retireSessionCredentialFileDurablySync,
} from './sessionAuthorityDurableFileOps.js'
import { digestSessionAuthoritySource } from './sessionCredentialSource.js'
import {
  observeSessionPersistenceLegacySnapshot,
  sessionPersistenceLegacySnapshotMatches,
} from './sessionPersistenceJournal.js'
import type {
  LegacySessionCredentialSourceInventory,
  SelectedLegacySessionCredentialSource,
  SessionAuthorityStorageScope,
  SessionAuthorityTransactionLease,
  TokenStore,
} from './tokenStore.js'
import { SessionAuthorityFileMutationError } from './windowsSessionAuthorityFileOps.js'

export { digestSessionAuthoritySource } from './sessionCredentialSource.js'

const RECORD_VERSION = 2
const RECOVERY_VERSION = 2
const MUTATION_VERSION = 1
const MAX_BYTES = 256 * 1024
const MAX_MUTATION_FENCE_BYTES = MAX_BYTES * 2 + 16 * 1024
const MAX_RECEIPTS = 128
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/i
const ENV_KEY = /^[a-z0-9_]+-[0-9a-f]{12}$/
const TRANSIENT_CODES = new Set(['EMFILE', 'ENFILE', 'EAGAIN', 'EBUSY', 'EINTR', 'EIO'])

/** Reserved V2 repository key for the one profile-wide Desktop session selector. */
export const PROFILE_SESSION_AUTHORITY_ENV_KEY = 'profile_active_session-977000000000'

export type SessionAuthorityLegacyLocator =
  | { kind: 'keytar-account'; account: string }
  | { kind: 'safe-storage-file'; envKey: string | null }
  | { kind: 'plaintext-file'; envKey: string | null }

type SessionAuthoritySourceIdentity = {
  envKey: string
  sourceRef: string
  storedValueDigest: string
}

export type SessionAuthorityCredentialSource = SessionAuthoritySourceIdentity &
  (
    | {
        kind: 'keytar' | 'safe-storage'
        format: 'v1'
        transactionId: string
        accountId: string
        sourceRevision: string
      }
    | {
        kind: 'keytar' | 'safe-storage' | 'historical-plaintext'
        format: 'v0'
        accountId: string | null
        sourceRevision: null
        legacyLocator: SessionAuthorityLegacyLocator
      }
  )

export type SessionAuthorityMarker =
  | { intent: 'logout-pending'; revision: string }
  | { intent: 'memory-only-session'; revision: string; volatileSessionId: string }
  | {
      intent: 'keytar-cleanup-pending'
      revision: string
      credentialSource: 'active-keytar' | 'safe-storage'
    }

export type SessionAuthorityFrame = {
  revision: string
  envKey: string
  mode: 'uninitialized' | 'persistent' | 'memory-only' | 'logged-out'
  transactionId: string | null
  source: SessionAuthorityCredentialSource | null
  volatileSessionId: string | null
  denyUnframedSources: true
  recoveryId: string | null
}

export type SessionAuthorityCandidate = {
  transactionId: string
  candidateHash: string
  accountId: string
  sourceKind: 'keytar' | 'safe-storage' | 'memory-only'
  sourceRef: string
  sourceRevision: string
  observedFrameRevision: string
  observedMarkerRevision: string | null
  /** Exact external marker precondition captured before candidate publication. */
  observedExternalMarker: {
    kind: PendingExternalLogoutRawObservation['kind']
    revision: string | null
    digest: string
  }
  /** Content-addressed V0 journal snapshot observed before candidate publication. */
  observedLegacyJournal: Pick<
    SessionAuthorityLegacyJournalReceipt,
    'schemaVersion' | 'revision' | 'byteLength' | 'digest'
  >
  priorSource: SessionAuthorityCredentialSource | null
  phase: 'denied' | 'writing' | 'published' | 'verified' | 'cleanup-pending'
  publishedSource: SessionAuthorityCredentialSource | null
  volatileSessionId: string | null
}

export type SessionAuthorityCleanupDebt = {
  id: string
  source: SessionAuthorityCredentialSource
  supersedingFrameRevision: string
}

export type SessionAuthorityQuarantine = {
  id: string
  digest: string | null
  locator: string
}

export type SessionAuthorityLegacyJournalReceipt = {
  schemaVersion: 0 | 1
  revision: string
  byteLength: number
  digest: string
  denials: Array<{ producer: string; candidateHash: string }>
}

export type SessionAuthorityProjectionIntent = {
  operationId: string
  candidateTransactionId: string
  baseAuthorityRevision: string
  baseAuthorityDigest: string
  expectedFrameRevision: string
  ownerEpoch: number
  beforeMarkerContents: string | null
  beforeMarkerKind: 'absent' | 'legacy-unrevisioned' | 'revisioned'
  beforeMarkerDigest: string
  beforeMarkerRevision: string | null
  stagedMarker: import('./pendingExternalLogout.js').AcceptancePendingMarker
  legacyJournalReceipt: SessionAuthorityLegacyJournalReceipt
}

export type SessionAuthorityProjectionReceipt = {
  operationId: string
  baseAuthorityRevision: string
  baseAuthorityDigest: string
  marker: import('./pendingExternalLogout.js').AcceptancePendingMarker
  legacyJournalReceipt: SessionAuthorityLegacyJournalReceipt
}

/** Exact external LP image committed with the logged-out frame and selected-source debt. */
export type SessionAuthorityLogoutReceipt = {
  operationId: string
  baseAuthorityRevision: string
  baseAuthorityDigest: string
  projectionKind: 'marker' | 'record-only'
  markerRevision: string | null
  markerDigest: string | null
  /** Exact external-marker preimage when the V2 record itself is the logout fence. */
  priorMarker: {
    kind: PendingExternalLogoutRawObservation['kind']
    revision: string | null
    digest: string
  } | null
  cleanupDebtIds: string[]
}

/** One durable profile-wide selector; per-environment records are never restore authority alone. */
export type SessionAuthorityProfileSelection = {
  revision: string
  state: 'active' | 'signed-out'
  mode: 'persistent' | 'memory-only' | 'signed-out'
  sessionGeneration: number
  envKey: string | null
  userId: string | null
  teamId: string | null
  source: SessionAuthorityCredentialSource | null
  authorityRevision: string | null
  transactionId: string | null
  volatileSessionId: string | null
}

export type SessionAuthorityRecord = {
  version: typeof RECORD_VERSION
  envKey: string
  revision: string
  marker: SessionAuthorityMarker | null
  frame: SessionAuthorityFrame
  /** Monotonic producer fence; retained as a tombstone when the active candidate is retired. */
  latestCandidateTransactionId: string | null
  candidates: SessionAuthorityCandidate[]
  cleanupDebts: SessionAuthorityCleanupDebt[]
  quarantines: SessionAuthorityQuarantine[]
  legacyJournalReceipt: SessionAuthorityLegacyJournalReceipt | null
  projectionIntent: SessionAuthorityProjectionIntent | null
  projectionReceipt: SessionAuthorityProjectionReceipt | null
  logoutReceipt: SessionAuthorityLogoutReceipt | null
  /** Present only on the reserved profile-wide record; absent old V2 records fail closed as none. */
  profileSelection?: SessionAuthorityProfileSelection | null
}

/** Pure acceptance interlock shared by the durable repository and policy property tests. */
export function canAcceptSessionAuthorityCandidate(
  record: SessionAuthorityRecord,
  transactionId: string,
  freshAuthentication = false
): boolean {
  const candidate = record.candidates.find(item => item.transactionId === transactionId)
  if (
    !candidate ||
    record.latestCandidateTransactionId !== transactionId ||
    candidate.phase !== 'verified' ||
    candidate.observedFrameRevision !== record.frame.revision ||
    candidate.observedMarkerRevision !== (record.marker?.revision ?? null) ||
    candidate.sourceRef === record.frame.source?.sourceRef ||
    record.cleanupDebts.some(debt => debt.source.sourceRef === candidate.sourceRef)
  )
    return false

  // A durable logout fence can only be replaced by a producer that has just completed account
  // authentication. Restore, team transition and recovery candidates must not turn LP into an
  // authenticated session. The candidate's observed marker/frame revisions make this permission
  // conditional on that exact logout state remaining current.
  if (
    record.frame.mode === 'logged-out' &&
    (!freshAuthentication ||
      candidate.priorSource !== null ||
      record.marker?.intent !== 'logout-pending')
  )
    return false
  if (
    freshAuthentication &&
    record.frame.mode !== 'uninitialized' &&
    record.frame.mode !== 'logged-out' &&
    !(
      record.frame.mode === 'memory-only' &&
      record.frame.source === null &&
      record.marker?.intent === 'memory-only-session' &&
      record.marker.volatileSessionId === record.frame.volatileSessionId &&
      record.marker.revision === record.frame.revision &&
      candidate.priorSource === null
    ) &&
    !(
      record.frame.mode === 'persistent' &&
      record.frame.source?.format === 'v0' &&
      record.frame.source.kind === 'historical-plaintext' &&
      sourceKey(candidate.priorSource) === sourceKey(record.frame.source)
    )
  )
    return false

  if (candidate.priorSource?.format === 'v0' && record.frame.mode === 'uninitialized')
    return record.frame.source === null
  return sourceKey(candidate.priorSource) === sourceKey(record.frame.source)
}

export type SessionAuthorityRecordSnapshot = {
  readonly __sessionAuthorityRecordSnapshot: unique symbol
}

type FileIdentity = { dev: number; ino: number; mode: number; size: number; mtimeMs: number }
type SnapshotContents = {
  directory: string
  envKey: string
  path: string
  bytes: string | null
  identity: FileIdentity | null
  record: SessionAuthorityRecord | null
}
type MutationFence = {
  id: string
  envKey: string
  expectedDigest: string | null
  nextDigest: string
  expectedIdentity: FileIdentity | null
  before: SessionAuthorityRecord | null
  next: SessionAuthorityRecord
}

const snapshots = new WeakMap<SessionAuthorityRecordSnapshot, SnapshotContents>()

export type SessionAuthorityRecordObservation =
  | { status: 'absent'; snapshot: SessionAuthorityRecordSnapshot }
  | {
      status: 'observed'
      record: SessionAuthorityRecord
      snapshot: SessionAuthorityRecordSnapshot
    }
  | { status: 'transient'; error: unknown }
  | {
      status: 'invalid'
      error: Error
      rawDigest: string | null
      pathKind: 'regular' | 'symlink' | 'other' | 'missing'
    }
  | { status: 'recovery-fenced'; recoveryId: string }

type SessionAuthorityProfileSelectionObservation =
  | {
      status: 'observed'
      selection: SessionAuthorityProfileSelection | null
      record: SessionAuthorityRecord
      snapshot: SessionAuthorityRecordSnapshot
    }
  | Extract<
      SessionAuthorityRecordObservation,
      { status: 'absent' | 'transient' | 'invalid' | 'recovery-fenced' }
    >

export type SessionAuthorityCasResult =
  | {
      status: 'committed'
      record: SessionAuthorityRecord
      snapshot: SessionAuthorityRecordSnapshot
    }
  | { status: 'indeterminate'; recoveryId: string }
  | { status: 'superseded' }

export type SessionAuthorityAcceptance =
  | {
      mode: 'persistent'
      source: SessionAuthorityCredentialSource
      markerIntent: null | {
        intent: 'keytar-cleanup-pending'
        credentialSource: 'active-keytar' | 'safe-storage'
      }
    }
  | {
      mode: 'memory-only'
      volatileSessionId: string
    }

export type SessionAuthorityAbsenceEvidence =
  | {
      kind: 'source-absent'
      transactionId: string | null
      source: SessionAuthorityCredentialSource
      outcome: 'deleted' | 'already-absent'
    }
  | {
      kind: 'candidate-slot-absent'
      candidate: Pick<
        SessionAuthorityCandidate,
        | 'transactionId'
        | 'candidateHash'
        | 'sourceKind'
        | 'sourceRef'
        | 'sourceRevision'
        | 'accountId'
      > & { envKey: string }
    }

declare const sessionAuthorityStorageAuthorizationBrand: unique symbol
export type SessionAuthorityStorageAuthorization = {
  readonly [sessionAuthorityStorageAuthorizationBrand]: never
}

declare const candidatePublicationLeaseBrand: unique symbol
export type SessionAuthorityCandidatePublicationLease = {
  readonly [candidatePublicationLeaseBrand]: never
}

declare const credentialReadAuthorizationBrand: unique symbol
export type SessionAuthorityCredentialReadAuthorization = {
  readonly [credentialReadAuthorizationBrand]: never
}

type CleanupAuthorizationContents = {
  repository: SessionAuthorityRecordRepository
  tokenStore: object
  storageScope: SessionAuthorityStorageScope
  envKey: string
  recordRevision: string
  purpose: 'candidate-write' | 'source-delete' | 'candidate-cleanup'
  consumed: boolean
  publicationAttemptId?: string
  cleanupDebtId?: string
  source?: SessionAuthorityCredentialSource
  candidate?: Pick<
    SessionAuthorityCandidate,
    'transactionId' | 'candidateHash' | 'sourceKind' | 'sourceRef' | 'sourceRevision' | 'accountId'
  > & { envKey: string }
}

const cleanupAuthorizations = new WeakMap<object, CleanupAuthorizationContents>()
type CandidatePublicationLeaseContents = {
  repository: SessionAuthorityRecordRepository
  tokenStore: object
  storageScope: SessionAuthorityStorageScope
  envKey: string
  transactionId: string
  attemptId: string
  frameRevision: string
  markerRevision: string | null
  candidateHash: string
  sourceKind: 'keytar' | 'safe-storage'
  sourceRef: string
  sourceRevision: string
  accountId: string
}
const candidatePublicationLeases = new WeakMap<object, CandidatePublicationLeaseContents>()
const activeCandidatePublications = new WeakMap<object, Map<string, string>>()
type CredentialReadAuthorizationContents = {
  repository: SessionAuthorityRecordRepository
  tokenStore: object
  storageScope: SessionAuthorityStorageScope
  envKey: string
  transactionId: string
  recordRevision: string
  purpose: 'candidate' | 'accepted' | 'profile-selected'
  source: SessionAuthorityCredentialSource
  reading: boolean
}
const credentialReadAuthorizations = new WeakMap<object, CredentialReadAuthorizationContents>()

function candidatePublicationKey(envKey: string, transactionId: string): string {
  return `${envKey}\0${transactionId}`
}

function activeCandidatePublicationMap(tokenStore: object): Map<string, string> {
  let active = activeCandidatePublications.get(tokenStore)
  if (!active) {
    active = new Map()
    activeCandidatePublications.set(tokenStore, active)
  }
  return active
}

/**
 * Consume one exact cleanup capability minted only after the authority repository durably
 * proves that the named source is unselected (or that the candidate is cleanup-fenced).
 */
export function consumeSessionAuthorityStorageAuthorization(
  authorization: unknown,
  tokenStore: object,
  storageScope: SessionAuthorityStorageScope,
  expected:
    | {
        purpose: 'candidate-write'
        candidate: NonNullable<CleanupAuthorizationContents['candidate']>
      }
    | { purpose: 'source-delete'; source: SessionAuthorityCredentialSource }
    | {
        purpose: 'candidate-cleanup'
        candidate: NonNullable<CleanupAuthorizationContents['candidate']>
      }
): boolean {
  if (typeof authorization !== 'object' || authorization === null) return false
  const issued = cleanupAuthorizations.get(authorization)
  if (
    !issued ||
    issued.consumed ||
    issued.tokenStore !== tokenStore ||
    issued.storageScope !== storageScope ||
    issued.purpose !== expected.purpose
  )
    return false
  if (expected.purpose === 'candidate-write') {
    const attemptKey = candidatePublicationKey(
      expected.candidate.envKey,
      expected.candidate.transactionId
    )
    if (
      issued.publicationAttemptId === undefined ||
      activeCandidatePublicationMap(tokenStore).get(attemptKey) !== issued.publicationAttemptId
    )
      return false
  }
  if (expected.purpose === 'source-delete') {
    if (!issued.source || sourceKey(issued.source) !== sourceKey(expected.source)) return false
  } else if (!issued.candidate || !sameCandidateIdentity(issued.candidate, expected.candidate)) {
    return false
  }
  if (!issued.repository.isCleanupAuthorizationCurrent(issued)) return false
  issued.consumed = true
  return true
}

/** Recheck a consumed one-use storage capability at the actual native/file mutation boundary. */
export function revalidateSessionAuthorityStorageAuthorization(
  authorization: unknown,
  tokenStore: object,
  storageScope: SessionAuthorityStorageScope
): boolean {
  if (typeof authorization !== 'object' || authorization === null) return false
  const issued = cleanupAuthorizations.get(authorization)
  return Boolean(
    issued?.consumed &&
    issued.tokenStore === tokenStore &&
    issued.storageScope === storageScope &&
    issued.repository.isCleanupAuthorizationCurrent(issued)
  )
}

/** Retire a consumed capability when its TokenStore operation has finished. */
export function finishSessionAuthorityStorageAuthorization(authorization: unknown): void {
  if (typeof authorization === 'object' && authorization !== null)
    cleanupAuthorizations.delete(authorization)
}

/** Begin one bearer read only while its exact repository revision remains authoritative. */
export function beginSessionAuthorityCredentialRead(
  authorization: unknown,
  tokenStore: object,
  storageScope: SessionAuthorityStorageScope,
  source: SessionAuthorityCredentialSource,
  transactionId: string
): boolean {
  if (typeof authorization !== 'object' || authorization === null) return false
  const issued = credentialReadAuthorizations.get(authorization)
  if (
    !issued ||
    issued.tokenStore !== tokenStore ||
    issued.storageScope !== storageScope ||
    issued.envKey !== source.envKey ||
    issued.transactionId !== transactionId ||
    sourceKey(issued.source) !== sourceKey(source) ||
    issued.source.format !== 'v1' ||
    issued.source.transactionId !== transactionId ||
    issued.reading ||
    !credentialReadAuthorizationIsCurrent(issued)
  )
    return false
  issued.reading = true
  return true
}

/** Recheck authority after the native/file read, then consume the one-use capability. */
export function finishSessionAuthorityCredentialRead(
  authorization: unknown,
  tokenStore: object,
  storageScope: SessionAuthorityStorageScope
): boolean {
  if (typeof authorization !== 'object' || authorization === null) return false
  const issued = credentialReadAuthorizations.get(authorization)
  if (!issued || issued.tokenStore !== tokenStore || issued.storageScope !== storageScope)
    return false
  credentialReadAuthorizations.delete(authorization)
  return issued.reading && credentialReadAuthorizationIsCurrent(issued)
}

export function cancelSessionAuthorityCredentialRead(
  authorization: unknown,
  tokenStore: object,
  storageScope: SessionAuthorityStorageScope
): void {
  if (typeof authorization !== 'object' || authorization === null) return
  const issued = credentialReadAuthorizations.get(authorization)
  if (issued?.tokenStore === tokenStore && issued.storageScope === storageScope)
    credentialReadAuthorizations.delete(authorization)
}

/** Recheck the durable writing receipt immediately before/after a native or file mutation. */
export function isSessionAuthorityCandidatePublicationCurrent(
  lease: unknown,
  tokenStore: object,
  storageScope: SessionAuthorityStorageScope,
  expected: {
    transactionId: string
    candidateHash: string
    sourceKind: 'keytar' | 'safe-storage'
    sourceRef: string
    sourceRevision: string
    accountId: string
    envKey: string
  }
): boolean {
  if (typeof lease !== 'object' || lease === null) return false
  const issued = candidatePublicationLeases.get(lease)
  if (
    !issued ||
    issued.tokenStore !== tokenStore ||
    issued.storageScope !== storageScope ||
    issued.envKey !== expected.envKey ||
    issued.transactionId !== expected.transactionId ||
    issued.candidateHash !== expected.candidateHash ||
    issued.sourceKind !== expected.sourceKind ||
    issued.sourceRef !== expected.sourceRef ||
    issued.sourceRevision !== expected.sourceRevision ||
    issued.accountId !== expected.accountId ||
    activeCandidatePublicationMap(tokenStore).get(
      candidatePublicationKey(expected.envKey, expected.transactionId)
    ) !== issued.attemptId
  )
    return false
  const observation = issued.repository.observe()
  if (observation.status !== 'observed') return false
  const candidate = observation.record.candidates.find(
    item => item.transactionId === expected.transactionId
  )
  return (
    observation.record.frame.revision === issued.frameRevision &&
    (observation.record.marker?.revision ?? null) === issued.markerRevision &&
    candidate?.phase === 'writing' &&
    observation.record.latestCandidateTransactionId === expected.transactionId &&
    candidate.candidateHash === expected.candidateHash &&
    candidate.sourceKind === expected.sourceKind &&
    candidate.sourceRef === expected.sourceRef &&
    candidate.sourceRevision === expected.sourceRevision &&
    candidate.accountId === expected.accountId &&
    candidate.observedFrameRevision === issued.frameRevision &&
    candidate.observedMarkerRevision === issued.markerRevision
  )
}

function credentialReadAuthorizationIsCurrent(
  issued: CredentialReadAuthorizationContents
): boolean {
  const observation = issued.repository.observe()
  if (
    observation.status !== 'observed' ||
    observation.record.revision !== issued.recordRevision ||
    (issued.purpose !== 'profile-selected' && observation.record.envKey !== issued.envKey) ||
    (issued.purpose === 'profile-selected' &&
      observation.record.envKey !== PROFILE_SESSION_AUTHORITY_ENV_KEY)
  )
    return false
  if (issued.purpose === 'profile-selected') {
    const selection = observation.record.profileSelection
    return Boolean(
      selection?.state === 'active' &&
      selection.mode === 'persistent' &&
      selection.envKey === issued.envKey &&
      selection.transactionId === issued.transactionId &&
      selection.source &&
      sourceKey(selection.source) === sourceKey(issued.source)
    )
  }
  if (issued.purpose === 'candidate') {
    const candidate = observation.record.candidates.find(
      item => item.transactionId === issued.transactionId
    )
    return (
      observation.record.latestCandidateTransactionId === issued.transactionId &&
      (candidate?.phase === 'published' || candidate?.phase === 'verified') &&
      candidate.observedFrameRevision === observation.record.frame.revision &&
      candidate.observedMarkerRevision === (observation.record.marker?.revision ?? null) &&
      candidate.publishedSource !== null &&
      sourceKey(candidate.publishedSource) === sourceKey(issued.source)
    )
  }
  return (
    observation.record.frame.mode === 'persistent' &&
    observation.record.frame.transactionId === issued.transactionId &&
    sourceKey(observation.record.frame.source) === sourceKey(issued.source) &&
    observation.record.marker?.intent !== 'logout-pending' &&
    observation.record.marker?.intent !== 'memory-only-session'
  )
}

function issueCredentialReadAuthorization(
  contents: Omit<CredentialReadAuthorizationContents, 'reading'>
): SessionAuthorityCredentialReadAuthorization {
  const authorization = Object.freeze({}) as SessionAuthorityCredentialReadAuthorization
  credentialReadAuthorizations.set(authorization as object, { ...contents, reading: false })
  return authorization
}

function sameCandidateIdentity(
  left: NonNullable<CleanupAuthorizationContents['candidate']>,
  right: NonNullable<CleanupAuthorizationContents['candidate']>
): boolean {
  return (
    left.transactionId === right.transactionId &&
    left.candidateHash === right.candidateHash &&
    left.sourceKind === right.sourceKind &&
    left.sourceRef === right.sourceRef &&
    left.sourceRevision === right.sourceRevision &&
    left.accountId === right.accountId &&
    left.envKey === right.envKey
  )
}

function issueCleanupAuthorization(contents: Omit<CleanupAuthorizationContents, 'consumed'>) {
  const authorization = Object.freeze({}) as SessionAuthorityStorageAuthorization
  cleanupAuthorizations.set(authorization as object, { ...contents, consumed: false })
  return authorization
}

function issueCandidatePublicationLease(
  contents: CandidatePublicationLeaseContents
): SessionAuthorityCandidatePublicationLease {
  const lease = Object.freeze({}) as SessionAuthorityCandidatePublicationLease
  candidatePublicationLeases.set(lease as object, contents)
  return lease
}
function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function authorityPath(directory: string, envKey: string): string {
  if (!path.isAbsolute(directory) || !ENV_KEY.test(envKey)) {
    throw new Error('Session authority record requires a valid absolute storage scope')
  }
  return path.join(directory, `session-authority-${digest(envKey)}`)
}

function recoveryPath(directory: string, envKey: string): string {
  return path.join(directory, `session-authority-recovery-${digest(envKey)}`)
}

function mutationPath(directory: string, envKey: string): string {
  return path.join(directory, `session-authority-mutation-${digest(envKey)}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function validSource(value: unknown, envKey: string): value is SessionAuthorityCredentialSource {
  if (!isRecord(value)) return false
  if (
    !(
      value.kind === 'keytar' ||
      value.kind === 'safe-storage' ||
      value.kind === 'historical-plaintext'
    ) ||
    value.envKey !== envKey ||
    typeof value.sourceRef !== 'string' ||
    !UUID.test(value.sourceRef) ||
    typeof value.storedValueDigest !== 'string' ||
    !HASH.test(value.storedValueDigest)
  )
    return false

  if (value.format === 'v1') {
    return (
      value.kind !== 'historical-plaintext' &&
      typeof value.transactionId === 'string' &&
      UUID.test(value.transactionId) &&
      typeof value.accountId === 'string' &&
      value.accountId.length > 0 &&
      value.accountId.length <= 256 &&
      typeof value.sourceRevision === 'string' &&
      UUID.test(value.sourceRevision) &&
      exactKeys(value, [
        'kind',
        'format',
        'transactionId',
        'envKey',
        'accountId',
        'sourceRef',
        'sourceRevision',
        'storedValueDigest',
      ])
    )
  }

  if (value.format !== 'v0' || value.sourceRevision !== null) return false
  const accountValid =
    value.accountId === null ||
    (typeof value.accountId === 'string' &&
      value.accountId.length > 0 &&
      value.accountId.length <= 256)
  const locator = value.legacyLocator
  if (!accountValid || !isRecord(locator)) return false
  const legacyKeytarAccount =
    typeof locator.account === 'string' &&
    (locator.account === 'session-token' ||
      /^session-token::[a-z0-9_]+-[0-9a-f]{12}$/.test(locator.account))
  const locatorValid =
    value.kind === 'keytar'
      ? locator.kind === 'keytar-account' &&
        legacyKeytarAccount &&
        exactKeys(locator, ['kind', 'account'])
      : value.kind === 'safe-storage'
        ? locator.kind === 'safe-storage-file' &&
          (locator.envKey === null ||
            (typeof locator.envKey === 'string' && ENV_KEY.test(locator.envKey))) &&
          exactKeys(locator, ['kind', 'envKey'])
        : locator.kind === 'plaintext-file' &&
          (locator.envKey === null ||
            (typeof locator.envKey === 'string' && ENV_KEY.test(locator.envKey))) &&
          exactKeys(locator, ['kind', 'envKey'])
  return (
    locatorValid &&
    exactKeys(value, [
      'kind',
      'format',
      'envKey',
      'accountId',
      'sourceRef',
      'sourceRevision',
      'storedValueDigest',
      'legacyLocator',
    ])
  )
}

function validMarker(value: unknown): value is SessionAuthorityMarker | null {
  if (value === null) return true
  if (!isRecord(value) || typeof value.revision !== 'string' || !UUID.test(value.revision))
    return false
  if (value.intent === 'logout-pending') return exactKeys(value, ['intent', 'revision'])
  if (value.intent === 'memory-only-session') {
    return (
      typeof value.volatileSessionId === 'string' &&
      UUID.test(value.volatileSessionId) &&
      exactKeys(value, ['intent', 'revision', 'volatileSessionId'])
    )
  }
  return (
    value.intent === 'keytar-cleanup-pending' &&
    (value.credentialSource === 'active-keytar' || value.credentialSource === 'safe-storage') &&
    exactKeys(value, ['intent', 'revision', 'credentialSource'])
  )
}

function validFrame(value: unknown, envKey: string): value is SessionAuthorityFrame {
  if (!isRecord(value)) return false
  if (
    typeof value.revision !== 'string' ||
    !UUID.test(value.revision) ||
    value.envKey !== envKey ||
    !['uninitialized', 'persistent', 'memory-only', 'logged-out'].includes(String(value.mode)) ||
    !(
      value.transactionId === null ||
      (typeof value.transactionId === 'string' && UUID.test(value.transactionId))
    ) ||
    value.denyUnframedSources !== true ||
    !(
      value.recoveryId === null ||
      (typeof value.recoveryId === 'string' && UUID.test(value.recoveryId))
    )
  )
    return false

  const sourceValid = value.source === null || validSource(value.source, envKey)
  if (!sourceValid) return false
  const source = value.source as SessionAuthorityCredentialSource | null
  if (value.mode === 'persistent' && value.source === null) return false
  if (value.mode === 'persistent') {
    if (
      source?.kind === 'historical-plaintext' ||
      value.transactionId === null ||
      (source?.format === 'v1' &&
        (source.sourceRevision === null || source.transactionId !== value.transactionId)) ||
      (source?.format === 'v0' &&
        (source.sourceRevision !== null ||
          (source.kind !== 'keytar' && source.kind !== 'safe-storage')))
    )
      return false
  }
  if (value.mode !== 'persistent' && value.source !== null) return false
  if (
    value.mode === 'memory-only' &&
    (!(typeof value.volatileSessionId === 'string' && UUID.test(value.volatileSessionId)) ||
      value.transactionId === null)
  )
    return false
  if (
    (value.mode === 'logged-out' || value.mode === 'uninitialized') &&
    value.transactionId !== null
  )
    return false
  if (value.mode !== 'memory-only' && value.volatileSessionId !== null) return false

  return exactKeys(value, [
    'revision',
    'envKey',
    'mode',
    'transactionId',
    'source',
    'volatileSessionId',
    'denyUnframedSources',
    'recoveryId',
  ])
}

function validCandidate(value: unknown, envKey: string): value is SessionAuthorityCandidate {
  if (!isRecord(value)) return false
  const externalMarker = value.observedExternalMarker
  const legacyJournal = value.observedLegacyJournal
  return (
    typeof value.transactionId === 'string' &&
    UUID.test(value.transactionId) &&
    typeof value.candidateHash === 'string' &&
    HASH.test(value.candidateHash) &&
    typeof value.accountId === 'string' &&
    value.accountId.length > 0 &&
    value.accountId.length <= 256 &&
    ['keytar', 'safe-storage', 'memory-only'].includes(String(value.sourceKind)) &&
    typeof value.sourceRef === 'string' &&
    UUID.test(value.sourceRef) &&
    typeof value.sourceRevision === 'string' &&
    UUID.test(value.sourceRevision) &&
    typeof value.observedFrameRevision === 'string' &&
    UUID.test(value.observedFrameRevision) &&
    (value.observedMarkerRevision === null ||
      (typeof value.observedMarkerRevision === 'string' &&
        UUID.test(value.observedMarkerRevision))) &&
    isRecord(externalMarker) &&
    ['absent', 'legacy-unrevisioned', 'revisioned'].includes(String(externalMarker.kind)) &&
    (externalMarker.revision === null ||
      (typeof externalMarker.revision === 'string' && UUID.test(externalMarker.revision))) &&
    (externalMarker.kind === 'revisioned'
      ? externalMarker.revision !== null
      : externalMarker.revision === null) &&
    typeof externalMarker.digest === 'string' &&
    HASH.test(externalMarker.digest) &&
    exactKeys(externalMarker, ['kind', 'revision', 'digest']) &&
    isRecord(legacyJournal) &&
    (legacyJournal.schemaVersion === 0 || legacyJournal.schemaVersion === 1) &&
    typeof legacyJournal.revision === 'string' &&
    /^v0-sha256:[0-9a-f]{64}$/.test(legacyJournal.revision) &&
    Number.isSafeInteger(legacyJournal.byteLength) &&
    (legacyJournal.byteLength as number) >= 0 &&
    (legacyJournal.byteLength as number) <= 128 * 1024 &&
    typeof legacyJournal.digest === 'string' &&
    HASH.test(legacyJournal.digest) &&
    legacyJournal.revision === `v0-sha256:${legacyJournal.digest}` &&
    exactKeys(legacyJournal, ['schemaVersion', 'revision', 'byteLength', 'digest']) &&
    (value.priorSource === null || validSource(value.priorSource, envKey)) &&
    ['denied', 'writing', 'published', 'verified', 'cleanup-pending'].includes(
      String(value.phase)
    ) &&
    (value.publishedSource === null || validSource(value.publishedSource, envKey)) &&
    (value.publishedSource === null ||
      (value.publishedSource.kind === value.sourceKind &&
        value.publishedSource.format === 'v1' &&
        value.publishedSource.sourceRevision !== null &&
        value.publishedSource.accountId === value.accountId &&
        value.publishedSource.envKey === envKey &&
        value.publishedSource.transactionId === value.transactionId &&
        value.publishedSource.sourceRef === value.sourceRef &&
        value.publishedSource.sourceRevision === value.sourceRevision)) &&
    (value.sourceKind === 'memory-only'
      ? value.publishedSource === null &&
        value.phase !== 'writing' &&
        value.phase !== 'published' &&
        value.phase !== 'cleanup-pending'
      : value.phase === 'denied'
        ? value.publishedSource === null
        : value.phase === 'cleanup-pending' || value.phase === 'writing'
          ? true
          : value.publishedSource !== null) &&
    (value.volatileSessionId === null ||
      (typeof value.volatileSessionId === 'string' && UUID.test(value.volatileSessionId))) &&
    (value.sourceKind !== 'memory-only' || value.volatileSessionId !== null) &&
    (value.sourceKind === 'memory-only' || value.volatileSessionId === null) &&
    (value.publishedSource === null || value.publishedSource.sourceRef === value.sourceRef) &&
    exactKeys(value, [
      'transactionId',
      'candidateHash',
      'accountId',
      'sourceKind',
      'sourceRef',
      'sourceRevision',
      'observedFrameRevision',
      'observedMarkerRevision',
      'observedExternalMarker',
      'observedLegacyJournal',
      'priorSource',
      'phase',
      'publishedSource',
      'volatileSessionId',
    ])
  )
}

function validLegacyJournalReceipt(value: unknown): value is SessionAuthorityLegacyJournalReceipt {
  if (!isRecord(value)) return false
  if (
    (value.schemaVersion !== 0 && value.schemaVersion !== 1) ||
    typeof value.revision !== 'string' ||
    !/^v0-sha256:[0-9a-f]{64}$/.test(value.revision) ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) < 0 ||
    (value.byteLength as number) > 128 * 1024 ||
    typeof value.digest !== 'string' ||
    !HASH.test(value.digest) ||
    value.revision !== `v0-sha256:${value.digest}` ||
    !Array.isArray(value.denials) ||
    value.denials.length > 128 ||
    !exactKeys(value, ['schemaVersion', 'revision', 'byteLength', 'digest', 'denials'])
  )
    return false
  const identities = new Set<string>()
  for (const denial of value.denials) {
    if (
      !isRecord(denial) ||
      typeof denial.producer !== 'string' ||
      !UUID.test(denial.producer) ||
      typeof denial.candidateHash !== 'string' ||
      !HASH.test(denial.candidateHash) ||
      !exactKeys(denial, ['producer', 'candidateHash'])
    )
      return false
    const identity = `${denial.producer}:${denial.candidateHash}`
    if (identities.has(identity)) return false
    identities.add(identity)
  }
  return value.schemaVersion !== 0 || (value.byteLength === 0 && value.denials.length === 0)
}

function validAcceptancePendingMarker(
  value: unknown
): value is import('./pendingExternalLogout.js').AcceptancePendingMarker {
  if (!isRecord(value)) return false
  return (
    value.version === 2 &&
    value.intent === 'acceptance-pending' &&
    value.purpose === 'candidate-acceptance' &&
    typeof value.operationId === 'string' &&
    UUID.test(value.operationId) &&
    typeof value.revision === 'string' &&
    UUID.test(value.revision) &&
    (value.expectedAuthorityRevision === null ||
      (typeof value.expectedAuthorityRevision === 'string' &&
        UUID.test(value.expectedAuthorityRevision))) &&
    typeof value.expectedAuthorityDigest === 'string' &&
    HASH.test(value.expectedAuthorityDigest) &&
    ['absent', 'legacy-unrevisioned', 'revisioned'].includes(String(value.priorMarkerKind)) &&
    typeof value.priorMarkerDigest === 'string' &&
    HASH.test(value.priorMarkerDigest) &&
    (value.priorMarkerRevision === null ||
      (typeof value.priorMarkerRevision === 'string' && UUID.test(value.priorMarkerRevision))) &&
    exactKeys(value, [
      'version',
      'intent',
      'purpose',
      'operationId',
      'revision',
      'expectedAuthorityRevision',
      'expectedAuthorityDigest',
      'priorMarkerKind',
      'priorMarkerDigest',
      'priorMarkerRevision',
    ])
  )
}

function validProjectionIntent(value: unknown): value is SessionAuthorityProjectionIntent {
  if (!isRecord(value)) return false
  const absentDigest = digest('session-marker:absent:v1')
  const beforeDigest =
    value.beforeMarkerContents === null
      ? absentDigest
      : typeof value.beforeMarkerContents === 'string'
        ? digest(value.beforeMarkerContents)
        : null
  return (
    typeof value.operationId === 'string' &&
    UUID.test(value.operationId) &&
    typeof value.candidateTransactionId === 'string' &&
    UUID.test(value.candidateTransactionId) &&
    typeof value.baseAuthorityRevision === 'string' &&
    UUID.test(value.baseAuthorityRevision) &&
    typeof value.baseAuthorityDigest === 'string' &&
    HASH.test(value.baseAuthorityDigest) &&
    typeof value.expectedFrameRevision === 'string' &&
    UUID.test(value.expectedFrameRevision) &&
    Number.isSafeInteger(value.ownerEpoch) &&
    (value.ownerEpoch as number) >= 0 &&
    (value.beforeMarkerContents === null ||
      (typeof value.beforeMarkerContents === 'string' &&
        Buffer.byteLength(value.beforeMarkerContents) <= 8192)) &&
    ['absent', 'legacy-unrevisioned', 'revisioned'].includes(String(value.beforeMarkerKind)) &&
    typeof value.beforeMarkerDigest === 'string' &&
    HASH.test(value.beforeMarkerDigest) &&
    beforeDigest === value.beforeMarkerDigest &&
    (value.beforeMarkerRevision === null ||
      (typeof value.beforeMarkerRevision === 'string' && UUID.test(value.beforeMarkerRevision))) &&
    validAcceptancePendingMarker(value.stagedMarker) &&
    value.stagedMarker.operationId === value.operationId &&
    value.stagedMarker.expectedAuthorityRevision === value.baseAuthorityRevision &&
    value.stagedMarker.expectedAuthorityDigest === value.baseAuthorityDigest &&
    value.stagedMarker.priorMarkerKind === value.beforeMarkerKind &&
    value.stagedMarker.priorMarkerDigest === value.beforeMarkerDigest &&
    value.stagedMarker.priorMarkerRevision === value.beforeMarkerRevision &&
    validLegacyJournalReceipt(value.legacyJournalReceipt) &&
    exactKeys(value, [
      'operationId',
      'candidateTransactionId',
      'baseAuthorityRevision',
      'baseAuthorityDigest',
      'expectedFrameRevision',
      'ownerEpoch',
      'beforeMarkerContents',
      'beforeMarkerKind',
      'beforeMarkerDigest',
      'beforeMarkerRevision',
      'stagedMarker',
      'legacyJournalReceipt',
    ])
  )
}

function validProjectionReceipt(value: unknown): value is SessionAuthorityProjectionReceipt {
  if (!isRecord(value)) return false
  return (
    typeof value.operationId === 'string' &&
    UUID.test(value.operationId) &&
    typeof value.baseAuthorityRevision === 'string' &&
    UUID.test(value.baseAuthorityRevision) &&
    typeof value.baseAuthorityDigest === 'string' &&
    HASH.test(value.baseAuthorityDigest) &&
    validAcceptancePendingMarker(value.marker) &&
    value.marker.operationId === value.operationId &&
    value.marker.expectedAuthorityRevision === value.baseAuthorityRevision &&
    value.marker.expectedAuthorityDigest === value.baseAuthorityDigest &&
    validLegacyJournalReceipt(value.legacyJournalReceipt) &&
    exactKeys(value, [
      'operationId',
      'baseAuthorityRevision',
      'baseAuthorityDigest',
      'marker',
      'legacyJournalReceipt',
    ])
  )
}

function validLogoutReceipt(value: unknown): value is SessionAuthorityLogoutReceipt {
  if (!isRecord(value)) return false
  const validPriorMarker =
    isRecord(value.priorMarker) &&
    ['absent', 'legacy-unrevisioned', 'revisioned'].includes(String(value.priorMarker.kind)) &&
    (value.priorMarker.revision === null ||
      (typeof value.priorMarker.revision === 'string' && UUID.test(value.priorMarker.revision))) &&
    typeof value.priorMarker.digest === 'string' &&
    HASH.test(value.priorMarker.digest) &&
    (value.priorMarker.kind !== 'absent' || value.priorMarker.revision === null) &&
    (value.priorMarker.kind !== 'legacy-unrevisioned' || value.priorMarker.revision === null) &&
    (value.priorMarker.kind !== 'revisioned' || typeof value.priorMarker.revision === 'string') &&
    exactKeys(value.priorMarker, ['kind', 'revision', 'digest'])
  const projectionValid =
    value.projectionKind === 'marker'
      ? typeof value.markerRevision === 'string' &&
        UUID.test(value.markerRevision) &&
        typeof value.markerDigest === 'string' &&
        HASH.test(value.markerDigest) &&
        value.priorMarker === null
      : value.projectionKind === 'record-only' &&
        value.markerRevision === null &&
        value.markerDigest === null &&
        validPriorMarker
  if (
    typeof value.operationId !== 'string' ||
    !UUID.test(value.operationId) ||
    typeof value.baseAuthorityRevision !== 'string' ||
    !UUID.test(value.baseAuthorityRevision) ||
    typeof value.baseAuthorityDigest !== 'string' ||
    !HASH.test(value.baseAuthorityDigest) ||
    !projectionValid ||
    !Array.isArray(value.cleanupDebtIds) ||
    value.cleanupDebtIds.length > MAX_RECEIPTS ||
    !value.cleanupDebtIds.every(id => typeof id === 'string' && UUID.test(id)) ||
    new Set(value.cleanupDebtIds).size !== value.cleanupDebtIds.length ||
    !exactKeys(value, [
      'operationId',
      'baseAuthorityRevision',
      'baseAuthorityDigest',
      'projectionKind',
      'markerRevision',
      'markerDigest',
      'priorMarker',
      'cleanupDebtIds',
    ])
  )
    return false
  return true
}

function validProfileSelection(value: unknown): value is SessionAuthorityProfileSelection {
  if (!isRecord(value)) return false
  const commonValid =
    typeof value.revision === 'string' &&
    UUID.test(value.revision) &&
    Number.isSafeInteger(value.sessionGeneration) &&
    (value.sessionGeneration as number) >= 0
  if (value.state === 'signed-out') {
    return (
      commonValid &&
      value.mode === 'signed-out' &&
      value.envKey === null &&
      value.userId === null &&
      value.teamId === null &&
      value.source === null &&
      value.authorityRevision === null &&
      value.transactionId === null &&
      value.volatileSessionId === null &&
      exactKeys(value, [
        'revision',
        'state',
        'mode',
        'sessionGeneration',
        'envKey',
        'userId',
        'teamId',
        'source',
        'authorityRevision',
        'transactionId',
        'volatileSessionId',
      ])
    )
  }
  if (
    !commonValid ||
    value.state !== 'active' ||
    !['persistent', 'memory-only'].includes(String(value.mode)) ||
    typeof value.envKey !== 'string' ||
    !ENV_KEY.test(value.envKey) ||
    typeof value.userId !== 'string' ||
    value.userId.length === 0 ||
    value.userId.length > 256 ||
    !(value.teamId === null || (typeof value.teamId === 'string' && value.teamId.length <= 256)) ||
    typeof value.authorityRevision !== 'string' ||
    !UUID.test(value.authorityRevision) ||
    typeof value.transactionId !== 'string' ||
    !UUID.test(value.transactionId)
  )
    return false
  if (value.mode === 'persistent') {
    return (
      isRecord(value.source) &&
      validSource(value.source, value.envKey) &&
      value.source.format === 'v1' &&
      value.source.accountId === value.userId &&
      value.source.transactionId === value.transactionId &&
      value.volatileSessionId === null &&
      exactKeys(value, [
        'revision',
        'state',
        'mode',
        'sessionGeneration',
        'envKey',
        'userId',
        'teamId',
        'source',
        'authorityRevision',
        'transactionId',
        'volatileSessionId',
      ])
    )
  }
  return (
    value.source === null &&
    typeof value.volatileSessionId === 'string' &&
    UUID.test(value.volatileSessionId) &&
    exactKeys(value, [
      'revision',
      'state',
      'mode',
      'sessionGeneration',
      'envKey',
      'userId',
      'teamId',
      'source',
      'authorityRevision',
      'transactionId',
      'volatileSessionId',
    ])
  )
}

function validateRecord(value: unknown, envKey: string): SessionAuthorityRecord {
  if (!isRecord(value)) throw new Error('Session authority record is not an object')
  if (
    value.version !== RECORD_VERSION ||
    value.envKey !== envKey ||
    typeof value.revision !== 'string' ||
    !UUID.test(value.revision) ||
    !validMarker(value.marker) ||
    !validFrame(value.frame, envKey) ||
    !Array.isArray(value.candidates) ||
    (value.latestCandidateTransactionId !== null &&
      (typeof value.latestCandidateTransactionId !== 'string' ||
        !UUID.test(value.latestCandidateTransactionId))) ||
    value.candidates.length > MAX_RECEIPTS ||
    !Array.isArray(value.cleanupDebts) ||
    value.cleanupDebts.length > MAX_RECEIPTS ||
    !Array.isArray(value.quarantines) ||
    value.quarantines.length > MAX_RECEIPTS ||
    !(
      value.legacyJournalReceipt === null || validLegacyJournalReceipt(value.legacyJournalReceipt)
    ) ||
    !(value.projectionIntent === null || validProjectionIntent(value.projectionIntent)) ||
    !(value.projectionReceipt === null || validProjectionReceipt(value.projectionReceipt)) ||
    !(value.logoutReceipt === null || validLogoutReceipt(value.logoutReceipt)) ||
    !(
      value.profileSelection === undefined ||
      value.profileSelection === null ||
      validProfileSelection(value.profileSelection)
    ) ||
    !exactKeys(value, [
      'version',
      'envKey',
      'revision',
      'marker',
      'frame',
      'latestCandidateTransactionId',
      'candidates',
      'cleanupDebts',
      'quarantines',
      'legacyJournalReceipt',
      'projectionIntent',
      'projectionReceipt',
      'logoutReceipt',
      'profileSelection',
    ])
  )
    throw new Error('Session authority record has an invalid bounded schema')

  if (!value.candidates.every(item => validCandidate(item, envKey)))
    throw new Error('Session authority record contains an invalid producer receipt')
  const frame = value.frame as SessionAuthorityFrame
  const transactions = new Set<string>()
  for (const item of value.candidates as SessionAuthorityCandidate[]) {
    if (transactions.has(item.transactionId)) throw new Error('Duplicate session producer receipt')
    transactions.add(item.transactionId)
  }
  for (const item of value.cleanupDebts) {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      !UUID.test(item.id) ||
      !validSource(item.source, envKey) ||
      typeof item.supersedingFrameRevision !== 'string' ||
      !UUID.test(item.supersedingFrameRevision) ||
      !exactKeys(item, ['id', 'source', 'supersedingFrameRevision'])
    )
      throw new Error('Session authority record contains an invalid cleanup debt')
  }
  const cleanupIds = new Set<string>()
  const cleanupSources = new Set<string>()
  const cleanupSourceRefs = new Set<string>()
  const cleanupSourcesByRef = new Map<string, SessionAuthorityCredentialSource>()
  for (const item of value.cleanupDebts as SessionAuthorityCleanupDebt[]) {
    const key = sourceKey(item.source)
    if (
      cleanupIds.has(item.id) ||
      cleanupSources.has(key) ||
      cleanupSourceRefs.has(item.source.sourceRef) ||
      frame.source?.sourceRef === item.source.sourceRef
    )
      throw new Error('Session authority record contains duplicate cleanup debt')
    cleanupIds.add(item.id)
    cleanupSources.add(key)
    cleanupSourceRefs.add(item.source.sourceRef)
    cleanupSourcesByRef.set(item.source.sourceRef, item.source)
  }
  const reservedSourceRefs = new Set(cleanupSourceRefs)
  if (frame.source) reservedSourceRefs.add(frame.source.sourceRef)
  for (const item of value.candidates as SessionAuthorityCandidate[]) {
    if (item.priorSource) reservedSourceRefs.add(item.priorSource.sourceRef)
  }
  const candidateSourceRefs = new Set<string>()
  for (const item of value.candidates as SessionAuthorityCandidate[]) {
    const matchingCleanupSource = cleanupSourcesByRef.get(item.sourceRef)
    const candidateDebtIsExact =
      matchingCleanupSource !== undefined &&
      item.publishedSource !== null &&
      sourceKey(matchingCleanupSource) === sourceKey(item.publishedSource)
    if (
      candidateSourceRefs.has(item.sourceRef) ||
      item.priorSource?.sourceRef === item.sourceRef ||
      (reservedSourceRefs.has(item.sourceRef) && !candidateDebtIsExact)
    )
      throw new Error('Session authority record contains a duplicate candidate source reference')
    candidateSourceRefs.add(item.sourceRef)
  }
  if (
    frame.source &&
    (value.cleanupDebts as SessionAuthorityCleanupDebt[]).some(
      debt => sourceKey(debt.source) === sourceKey(frame.source!)
    )
  )
    throw new Error('Selected session source cannot also be cleanup debt')
  if (value.marker && value.marker.revision !== value.frame.revision)
    throw new Error('Session authority marker and frame revisions do not match')
  if (value.frame.mode === 'memory-only' && value.marker?.intent !== 'memory-only-session')
    throw new Error('Memory-only authority requires its volatile-session marker')
  if (
    value.frame.mode === 'memory-only' &&
    value.marker?.intent === 'memory-only-session' &&
    value.frame.volatileSessionId !== value.marker.volatileSessionId
  )
    throw new Error('Memory-only marker and frame lease identities do not match')
  if (value.frame.mode !== 'memory-only' && value.marker?.intent === 'memory-only-session')
    throw new Error('Volatile-session marker has no matching memory-only frame')
  if (value.frame.mode === 'logged-out' && value.marker?.intent !== 'logout-pending')
    throw new Error('Logged-out authority requires a durable logout marker')
  if (value.logoutReceipt !== null && value.frame.mode !== 'logged-out')
    throw new Error('Logout projection receipt requires logged-out authority')
  if (value.frame.mode === 'uninitialized' && value.marker !== null)
    throw new Error('Uninitialized authority cannot inherit a logout or session marker')
  if (
    value.marker?.intent === 'keytar-cleanup-pending' &&
    (value.frame.mode !== 'persistent' ||
      (value.marker.credentialSource === 'active-keytar' &&
        value.frame.source?.kind !== 'keytar') ||
      (value.marker.credentialSource === 'safe-storage' &&
        value.frame.source?.kind !== 'safe-storage'))
  )
    throw new Error('Cleanup-pending marker must match its selected persistent source')
  for (const item of value.quarantines) {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      !UUID.test(item.id) ||
      !(item.digest === null || (typeof item.digest === 'string' && HASH.test(item.digest))) ||
      typeof item.locator !== 'string' ||
      !/^session-authority-corrupt-[0-9a-f-]{36}$/.test(item.locator) ||
      !exactKeys(item, ['id', 'digest', 'locator'])
    )
      throw new Error('Session authority record contains an invalid quarantine receipt')
  }
  const quarantineIds = new Set<string>()
  const quarantinePaths = new Set<string>()
  for (const item of value.quarantines as SessionAuthorityQuarantine[]) {
    if (quarantineIds.has(item.id) || quarantinePaths.has(item.locator))
      throw new Error('Session authority record contains duplicate quarantine receipts')
    quarantineIds.add(item.id)
    quarantinePaths.add(item.locator)
  }
  if (
    value.candidates.length + value.cleanupDebts.length + (frame.source === null ? 0 : 1) >
    MAX_RECEIPTS
  )
    throw new Error('Session authority record exceeds its receipt capacity')
  if (value.marker?.intent === 'logout-pending' && value.frame.mode !== 'logged-out')
    throw new Error('Logout-pending marker requires logged-out authority')
  if (value.projectionIntent !== null) {
    const intent = value.projectionIntent as SessionAuthorityProjectionIntent
    const candidate = (value.candidates as SessionAuthorityCandidate[]).find(
      item => item.transactionId === intent.candidateTransactionId
    )
    if (
      value.frame.revision !== intent.expectedFrameRevision ||
      (candidate?.phase !== 'verified' && candidate?.phase !== 'cleanup-pending') ||
      value.latestCandidateTransactionId !== candidate.transactionId ||
      intent.stagedMarker.operationId !== candidate.transactionId
    )
      throw new Error('Projection intent is not bound to the current denied candidate')
  }
  if (value.projectionReceipt !== null) {
    const receipt = value.projectionReceipt as SessionAuthorityProjectionReceipt
    if (
      value.frame.transactionId !== receipt.operationId ||
      value.legacyJournalReceipt === null ||
      JSON.stringify(value.legacyJournalReceipt) !== JSON.stringify(receipt.legacyJournalReceipt)
    )
      throw new Error('Accepted projection receipt is not bound to the selected frame')
  }
  if (value.logoutReceipt !== null) {
    const receipt = value.logoutReceipt as SessionAuthorityLogoutReceipt
    if (
      value.frame.mode !== 'logged-out' ||
      value.marker?.intent !== 'logout-pending' ||
      receipt.cleanupDebtIds.some(
        id => !(value.cleanupDebts as SessionAuthorityCleanupDebt[]).some(debt => debt.id === id)
      )
    )
      throw new Error('Logout receipt is not bound to its logged-out frame and exact cleanup debt')
  }
  return value as unknown as SessionAuthorityRecord
}

function identityOf(stat: fs.Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs }
}

function sameIdentity(left: FileIdentity | null, right: FileIdentity | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.mode === right.mode &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs)
  )
}

function sameObjectIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  )
}

function transient(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && TRANSIENT_CODES.has(code)
}

function readFile(
  file: string,
  maxBytes = MAX_BYTES
): {
  bytes: string | null
  identity: FileIdentity | null
  pathKind: 'regular' | 'symlink' | 'other' | 'missing'
} {
  let descriptor: number | undefined
  let inspected: fs.Stats | null = null
  try {
    const before = (inspected = fs.lstatSync(file))
    if (before.isSymbolicLink())
      return { bytes: null, identity: identityOf(before), pathKind: 'symlink' }
    if (!before.isFile()) return { bytes: null, identity: identityOf(before), pathKind: 'other' }
    const flags =
      fs.constants.O_RDONLY |
      fs.constants.O_NONBLOCK |
      (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW)
    descriptor = fs.openSync(file, flags)
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile()) return { bytes: null, identity: identityOf(stat), pathKind: 'other' }
    if (!sameObjectIdentity(identityOf(before), identityOf(stat)))
      throw Object.assign(new Error('Session authority record changed before it was opened'), {
        code: 'EAGAIN',
      })
    if (stat.size > maxBytes)
      return { bytes: null, identity: identityOf(stat), pathKind: 'regular' }
    const bytes = fs.readFileSync(descriptor, 'utf8')
    const after = fs.fstatSync(descriptor)
    if (!sameIdentity(identityOf(stat), identityOf(after))) {
      throw Object.assign(new Error('Session authority record changed while it was read'), {
        code: 'EAGAIN',
      })
    }
    return { bytes, identity: identityOf(stat), pathKind: 'regular' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' && inspected === null)
      return { bytes: null, identity: null, pathKind: 'missing' }
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
      throw Object.assign(new Error('Session authority record disappeared while it was opened'), {
        code: 'EAGAIN',
      })
    if ((error as NodeJS.ErrnoException)?.code === 'EACCES' && inspected) {
      return {
        bytes: null,
        identity: identityOf(inspected),
        pathKind: inspected.isFile() ? 'regular' : inspected.isSymbolicLink() ? 'symlink' : 'other',
      }
    }
    throw error
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function writeAtomic(
  file: string,
  expected: string | null,
  expectedIdentity: FileIdentity | null,
  contents: string
): boolean {
  const directory = path.dirname(file)
  const temporary = `${file}.${randomUUID()}.tmp`
  let descriptor: number | undefined
  let publicationAttempted = false
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const directoryStat = fs.lstatSync(directory)
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
      throw new Error('Session authority storage directory is not a real directory')
    const current = readFile(file)
    if (current.pathKind !== 'missing' && current.bytes === null) return false
    if (current.bytes !== expected || !sameIdentity(current.identity, expectedIdentity))
      return false
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, contents, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    const beforeRename = readFile(file)
    if (beforeRename.pathKind !== 'missing' && beforeRename.bytes === null) return false
    if (beforeRename.bytes !== expected || !sameIdentity(beforeRename.identity, expectedIdentity))
      return false
    publicationAttempted = true
    renameSessionAuthorityFileDurablySync(temporary, file, expected !== null)
    return true
  } catch (error) {
    if (!publicationAttempted) throw new SessionAuthorityRecordWriteNotPublishedError(error)
    throw error
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try {
      fs.unlinkSync(temporary)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        // Preserve the primary durable-write result; orphaned temp files are never authority.
      }
    }
  }
}

/** The record's active pathname was not replaced; only the unselected temporary write failed. */
class SessionAuthorityRecordWriteNotPublishedError extends Error {
  constructor(cause: unknown) {
    super('Session authority record was not published', { cause })
    this.name = 'SessionAuthorityRecordWriteNotPublishedError'
  }
}

function initialRecord(envKey: string): SessionAuthorityRecord {
  const revision = randomUUID()
  return {
    version: RECORD_VERSION,
    envKey,
    revision,
    // An absent authority record is not evidence that the user logged out. It is a bootstrap
    // state: only a private, exact-source V0 migration or a fresh-auth candidate may proceed.
    marker: null,
    frame: {
      revision,
      envKey,
      mode: 'uninitialized',
      transactionId: null,
      source: null,
      volatileSessionId: null,
      denyUnframedSources: true,
      recoveryId: null,
    },
    latestCandidateTransactionId: null,
    candidates: [],
    cleanupDebts: [],
    quarantines: [],
    legacyJournalReceipt: null,
    projectionIntent: null,
    projectionReceipt: null,
    logoutReceipt: null,
    profileSelection: null,
  }
}

function sourceKey(source: SessionAuthorityCredentialSource | null): string {
  if (!source) return 'none'
  const locator =
    source.format === 'v0'
      ? source.legacyLocator.kind === 'keytar-account'
        ? ['keytar-account', source.legacyLocator.account]
        : [source.legacyLocator.kind, source.legacyLocator.envKey]
      : null
  return JSON.stringify([
    source.kind,
    source.format,
    source.format === 'v1' ? source.transactionId : null,
    source.envKey,
    source.accountId,
    source.sourceRef,
    source.sourceRevision,
    source.storedValueDigest,
    locator,
  ])
}

export function sameLogoutMarkerPreimage(
  prior: NonNullable<SessionAuthorityLogoutReceipt['priorMarker']>,
  observed: PendingExternalLogoutRawObservation
): boolean {
  return (
    prior.kind === observed.kind &&
    prior.revision === (observed.marker?.revision ?? null) &&
    prior.digest === observed.rawDigest
  )
}

export class SessionAuthorityRecordCapacityError extends Error {
  constructor() {
    super('Session authority receipt capacity is full; unresolved denials cannot be discarded')
    this.name = 'SessionAuthorityRecordCapacityError'
  }
}

export class SessionAuthorityRecordConflictError extends Error {
  constructor() {
    super('Session authority transaction no longer owns the observed frame')
    this.name = 'SessionAuthorityRecordConflictError'
  }
}

/** A cleanup permit became stale before TokenStore reached the source mutation boundary. */
export class SessionAuthorityStorageAuthorizationError extends Error {
  constructor() {
    super('Candidate cleanup requires a repository-issued exact source permit')
    this.name = 'SessionAuthorityStorageAuthorizationError'
  }
}

/** A durable V2 acceptance receipt no longer matches its required sidecar projection. */
export class SessionAuthorityProjectionIntegrityError extends Error {
  constructor(
    readonly source: 'authority' | 'marker' | 'journal',
    cause?: unknown
  ) {
    super(`Session authority ${source} projection is missing, changed, or unverifiable`, { cause })
    this.name = 'SessionAuthorityProjectionIntegrityError'
  }
}

/** Unshipped authority prototypes and future schemas are never absence or repairable corruption. */
export class SessionAuthorityUnsupportedRecordVersionError extends Error {
  constructor(readonly observedVersion: unknown) {
    super(
      'Session authority record version is unsupported; preserve it and require explicit recovery'
    )
    this.name = 'SessionAuthorityUnsupportedRecordVersionError'
  }
}

class SessionAuthorityMutationIndeterminateError extends Error {
  constructor(
    readonly recoveryId: string,
    options?: ErrorOptions
  ) {
    super('Session authority mutation outcome is indeterminate', options)
    this.name = 'SessionAuthorityMutationIndeterminateError'
  }
}

/**
 * One atomic, bounded authority document for marker, accepted source and candidate/debt receipts.
 * Producer acceptance is coordinated by SessionAuthorityAcceptanceTransaction, which owns the
 * staged-source read, acceptance CAS, and synchronous publication boundary.
 */
export class SessionAuthorityRecordRepository {
  private readonly directory: string
  private readonly file: string
  private readonly recoveryFile: string
  private readonly mutationFile: string
  private indeterminateMutationId: string | null = null
  /** Fresh-auth permission is scoped to this process and is never part of the V1 disk schema. */
  private readonly freshAuthenticationCandidates = new Set<string>()

  constructor(
    private readonly storageScope: SessionAuthorityStorageScope,
    private readonly envKey: string,
    private readonly tokenStore: TokenStore,
    private readonly transactionLease?: SessionAuthorityTransactionLease
  ) {
    this.directory = tokenStore.resolveSessionAuthorityStorageDirectory(storageScope)
    this.file = authorityPath(this.directory, envKey)
    this.recoveryFile = recoveryPath(this.directory, envKey)
    this.mutationFile = mutationPath(this.directory, envKey)
    this.assertStorageScopeCurrent()
  }

  /** Validate a one-use storage permit against the latest durable owner at each mutation edge. */
  isCleanupAuthorizationCurrent(authorization: CleanupAuthorizationContents): boolean {
    if (
      authorization.repository !== this ||
      authorization.tokenStore !== this.tokenStore ||
      authorization.storageScope !== this.storageScope ||
      authorization.envKey !== this.envKey
    )
      return false
    const observation = this.observe()
    if (
      observation.status !== 'observed' ||
      observation.record.revision !== authorization.recordRevision ||
      observation.record.envKey !== authorization.envKey
    )
      return false
    const record = observation.record

    if (authorization.purpose === 'candidate-write') {
      const candidate = authorization.candidate
        ? record.candidates.find(
            item => item.transactionId === authorization.candidate?.transactionId
          )
        : undefined
      return Boolean(
        candidate &&
        authorization.candidate &&
        sameCandidateIdentity(
          {
            ...authorization.candidate,
            envKey: authorization.envKey,
          },
          {
            transactionId: candidate.transactionId,
            candidateHash: candidate.candidateHash,
            sourceKind: candidate.sourceKind,
            sourceRef: candidate.sourceRef,
            sourceRevision: candidate.sourceRevision,
            accountId: candidate.accountId,
            envKey: authorization.envKey,
          }
        ) &&
        candidate.phase === 'writing' &&
        record.latestCandidateTransactionId === candidate.transactionId &&
        candidate.observedFrameRevision === record.frame.revision &&
        candidate.observedMarkerRevision === (record.marker?.revision ?? null) &&
        record.frame.source?.sourceRef !== candidate.sourceRef
      )
    }

    if (authorization.purpose === 'candidate-cleanup') {
      const candidate = authorization.candidate
        ? record.candidates.find(
            item => item.transactionId === authorization.candidate?.transactionId
          )
        : undefined
      return Boolean(
        candidate &&
        authorization.candidate &&
        sameCandidateIdentity(
          { ...authorization.candidate, envKey: authorization.envKey },
          {
            transactionId: candidate.transactionId,
            candidateHash: candidate.candidateHash,
            sourceKind: candidate.sourceKind,
            sourceRef: candidate.sourceRef,
            sourceRevision: candidate.sourceRevision,
            accountId: candidate.accountId,
            envKey: authorization.envKey,
          }
        ) &&
        candidate.phase === 'cleanup-pending' &&
        record.frame.source?.sourceRef !== candidate.sourceRef &&
        this.isGloballyUnselectedSourceRef(candidate.sourceRef)
      )
    }

    if (
      !authorization.source ||
      record.frame.source?.sourceRef === authorization.source.sourceRef ||
      !this.isGloballyUnselectedSourceRef(authorization.source.sourceRef)
    )
      return false
    if (authorization.cleanupDebtId) {
      const debt = record.cleanupDebts.find(item => item.id === authorization.cleanupDebtId)
      return Boolean(debt && sourceKey(debt.source) === sourceKey(authorization.source))
    }
    const candidate = authorization.candidate
      ? record.candidates.find(
          item => item.transactionId === authorization.candidate?.transactionId
        )
      : undefined
    return Boolean(
      candidate &&
      authorization.candidate &&
      sameCandidateIdentity(
        { ...authorization.candidate, envKey: authorization.envKey },
        {
          transactionId: candidate.transactionId,
          candidateHash: candidate.candidateHash,
          sourceKind: candidate.sourceKind,
          sourceRef: candidate.sourceRef,
          sourceRevision: candidate.sourceRevision,
          accountId: candidate.accountId,
          envKey: authorization.envKey,
        }
      ) &&
      candidate.phase === 'cleanup-pending' &&
      candidate.publishedSource !== null &&
      sourceKey(candidate.publishedSource) === sourceKey(authorization.source)
    )
  }

  observe(): SessionAuthorityRecordObservation {
    try {
      if (this.indeterminateMutationId)
        return { status: 'recovery-fenced', recoveryId: this.indeterminateMutationId }
      this.assertStorageScopeCurrent()
      const recovery = this.readRecoveryFence()
      if (recovery) return { status: 'recovery-fenced', recoveryId: recovery.id }
      const mutation = this.readMutationFence()
      if (mutation) return { status: 'recovery-fenced', recoveryId: mutation.id }
      const read = readFile(this.file)
      if (read.pathKind === 'missing') return this.snapshot(null, null, null)
      if (read.bytes === null) {
        return {
          status: 'invalid',
          error: new Error('Session authority record is not a bounded regular file'),
          rawDigest: null,
          pathKind: read.pathKind,
        }
      }
      if (process.platform !== 'win32' && (read.identity!.mode & 0o077) !== 0) {
        return {
          status: 'invalid',
          error: new Error('Session authority record permissions are not private'),
          rawDigest: digest(read.bytes),
          pathKind: 'regular',
        }
      }
      let record: SessionAuthorityRecord
      try {
        const parsed: unknown = JSON.parse(read.bytes)
        if (isRecord(parsed) && parsed.version !== RECORD_VERSION) {
          throw new SessionAuthorityUnsupportedRecordVersionError(parsed.version)
        }
        record = validateRecord(parsed, this.envKey)
      } catch (error) {
        return {
          status: 'invalid',
          error:
            error instanceof SessionAuthorityUnsupportedRecordVersionError
              ? error
              : new Error('Session authority record is malformed or unsupported'),
          rawDigest: digest(read.bytes),
          pathKind: 'regular',
        }
      }
      this.assertStorageScopeCurrent()
      return this.snapshot(read.bytes, read.identity, record)
    } catch (error) {
      if (transient(error)) return { status: 'transient', error }
      return {
        status: 'invalid',
        error: new Error('Session authority record cannot be safely inspected'),
        rawDigest: null,
        pathKind: 'other',
      }
    }
  }

  /** A global selector observation is part of source-deletion authority, not cleanup planning. */
  private isGloballyUnselectedSourceRef(sourceRef: string): boolean {
    try {
      const profileRepository = new SessionAuthorityRecordRepository(
        this.storageScope,
        PROFILE_SESSION_AUTHORITY_ENV_KEY,
        this.tokenStore
      )
      // Cleanup is destructive authority. This single read must not initialize a missing
      // selector and turn absence into proof that this source is unselected.
      const profile = profileRepository.observeExistingProfileSelection()
      return (
        profile.status === 'observed' &&
        !(
          profile.selection?.state === 'active' && profile.selection.source?.sourceRef === sourceRef
        )
      )
    } catch {
      // An unreadable or invalid global selector cannot authorize destructive cleanup.
      return false
    }
  }

  initialize(snapshot: SessionAuthorityRecordSnapshot): SessionAuthorityCasResult {
    const captured = this.requireSnapshot(snapshot)
    if (captured.bytes !== null || captured.record !== null) return { status: 'superseded' }
    const record = initialRecord(this.envKey)
    return this.commit(snapshot, record)
  }

  /** Read the profile-wide selection from its reserved V2 authority repository. */
  observeProfileSelection(): Exclude<
    SessionAuthorityProfileSelectionObservation,
    { status: 'absent' }
  > {
    if (this.envKey !== PROFILE_SESSION_AUTHORITY_ENV_KEY)
      throw new Error('Profile selection requires the reserved session authority repository')
    let observation = this.observe()
    if (observation.status === 'absent') {
      const initialized = this.initialize(observation.snapshot)
      if (initialized.status === 'indeterminate')
        return {
          status: 'recovery-fenced',
          recoveryId: initialized.recoveryId,
        }
      observation = this.observe()
    }
    if (observation.status === 'absent')
      return {
        status: 'invalid',
        error: new Error('Profile session authority could not be initialized'),
        rawDigest: null,
        pathKind: 'missing',
      }
    const profile = this.profileSelectionObservation(observation)
    if (profile.status === 'absent')
      return {
        status: 'invalid',
        error: new Error('Profile session authority could not be initialized'),
        rawDigest: null,
        pathKind: 'missing',
      }
    return profile
  }

  /** Observe a profile selector without initializing it; absence is not cleanup permission. */
  observeExistingProfileSelection(): SessionAuthorityProfileSelectionObservation {
    if (this.envKey !== PROFILE_SESSION_AUTHORITY_ENV_KEY)
      throw new Error('Profile selection requires the reserved session authority repository')
    return this.profileSelectionObservation(this.observe())
  }

  private profileSelectionObservation(
    observation: SessionAuthorityRecordObservation
  ): SessionAuthorityProfileSelectionObservation {
    if (observation.status !== 'observed') return observation
    if (
      observation.record.frame.mode !== 'uninitialized' ||
      observation.record.frame.source !== null ||
      observation.record.candidates.length !== 0 ||
      observation.record.cleanupDebts.length !== 0 ||
      observation.record.projectionIntent !== null ||
      observation.record.projectionReceipt !== null ||
      observation.record.logoutReceipt !== null
    )
      return {
        status: 'invalid',
        error: new Error('Profile selection repository contains session authority state'),
        rawDigest: null,
        pathKind: 'other',
      }
    return {
      status: 'observed',
      selection: observation.record.profileSelection ?? null,
      record: observation.record,
      snapshot: observation.snapshot,
    }
  }

  /** CAS the single accepted environment using the same V2 mutation fence and durable write. */
  compareAndSetProfileSelection(
    snapshot: SessionAuthorityRecordSnapshot,
    expectedSelectionRevision: string | null,
    selection: SessionAuthorityProfileSelection
  ): SessionAuthorityCasResult {
    if (
      this.envKey !== PROFILE_SESSION_AUTHORITY_ENV_KEY ||
      !validProfileSelection(selection) ||
      (selection.state === 'active' &&
        selection.mode === 'memory-only' &&
        selection.source !== null)
    )
      throw new SessionAuthorityRecordConflictError()
    const current = this.requireCurrentRecord(snapshot)
    if (
      current.frame.mode !== 'uninitialized' ||
      current.frame.source !== null ||
      (current.profileSelection?.revision ?? null) !== expectedSelectionRevision ||
      selection.sessionGeneration !== (current.profileSelection?.sessionGeneration ?? 0) + 1
    )
      return { status: 'superseded' }
    return this.commit(snapshot, this.next(current, { profileSelection: selection }))
  }

  isProfileSelectionCurrent(
    snapshot: SessionAuthorityRecordSnapshot,
    selection: SessionAuthorityProfileSelection
  ): boolean {
    if (this.envKey !== PROFILE_SESSION_AUTHORITY_ENV_KEY) return false
    try {
      return (
        JSON.stringify(this.requireCurrentRecord(snapshot).profileSelection) ===
        JSON.stringify(selection)
      )
    } catch {
      return false
    }
  }

  /**
   * Durably record the recovery intent before the compatibility marker is projected. The marker
   * binds the exact authority before-image; it cannot authorize a credential on its own.
   */
  prepareAcceptanceProjection(
    snapshot: SessionAuthorityRecordSnapshot,
    transactionId: string,
    input: {
      ownerEpoch: number
      beforeMarker: import('./pendingExternalLogout.js').PendingExternalLogoutRawObservation
      legacyJournalReceipt: SessionAuthorityLegacyJournalReceipt
    }
  ): {
    result: SessionAuthorityCasResult
    stagedMarker: import('./pendingExternalLogout.js').AcceptancePendingMarker
    intent: SessionAuthorityProjectionIntent
  } {
    const current = this.requireCurrentRecord(snapshot)
    const candidate = current.candidates.find(item => item.transactionId === transactionId)
    if (
      current.projectionIntent !== null ||
      !candidate ||
      current.latestCandidateTransactionId !== transactionId ||
      candidate.phase !== 'verified' ||
      candidate.observedFrameRevision !== current.frame.revision ||
      input.beforeMarker.rawDigest.length !== 64 ||
      !Number.isSafeInteger(input.ownerEpoch) ||
      input.ownerEpoch < 0 ||
      !validLegacyJournalReceipt(input.legacyJournalReceipt) ||
      (current.legacyJournalReceipt !== null &&
        JSON.stringify(current.legacyJournalReceipt) !==
          JSON.stringify(input.legacyJournalReceipt)) ||
      input.legacyJournalReceipt.denials.some(
        denial => denial.candidateHash === candidate.candidateHash
      )
    )
      throw new SessionAuthorityRecordConflictError()

    const captured = this.requireSnapshot(snapshot)
    const baseAuthorityDigest = digest(captured.bytes ?? 'session-authority:absent:v2')
    const stagedMarker: import('./pendingExternalLogout.js').AcceptancePendingMarker = {
      version: 2,
      intent: 'acceptance-pending',
      purpose: 'candidate-acceptance',
      operationId: transactionId,
      revision: randomUUID(),
      expectedAuthorityRevision: current.revision,
      expectedAuthorityDigest: baseAuthorityDigest,
      priorMarkerKind: input.beforeMarker.kind,
      priorMarkerDigest: input.beforeMarker.rawDigest,
      priorMarkerRevision: input.beforeMarker.marker?.revision ?? null,
    }
    const intent: SessionAuthorityProjectionIntent = {
      operationId: transactionId,
      candidateTransactionId: transactionId,
      baseAuthorityRevision: current.revision,
      baseAuthorityDigest,
      expectedFrameRevision: current.frame.revision,
      ownerEpoch: input.ownerEpoch,
      beforeMarkerContents: input.beforeMarker.rawContents,
      beforeMarkerKind: input.beforeMarker.kind,
      beforeMarkerDigest: input.beforeMarker.rawDigest,
      beforeMarkerRevision: input.beforeMarker.marker?.revision ?? null,
      stagedMarker,
      legacyJournalReceipt: JSON.parse(
        JSON.stringify(input.legacyJournalReceipt)
      ) as SessionAuthorityLegacyJournalReceipt,
    }
    const result = this.commit(snapshot, this.next(current, { projectionIntent: intent }))
    if (result.status !== 'committed') throw new SessionAuthorityRecordConflictError()
    return { result, stagedMarker, intent }
  }

  /** Drop an uncommitted projection intent only after its marker before-image is verified. */
  clearAcceptanceProjectionIntent(
    snapshot: SessionAuthorityRecordSnapshot,
    transactionId: string
  ): SessionAuthorityCasResult {
    const current = this.requireCurrentRecord(snapshot)
    if (current.projectionIntent?.candidateTransactionId !== transactionId)
      return { status: 'superseded' }
    const candidate = current.candidates.find(item => item.transactionId === transactionId)
    if (!candidate || candidate.phase !== 'verified')
      throw new SessionAuthorityRecordConflictError()
    if (candidate.sourceKind === 'memory-only') {
      return this.commit(
        snapshot,
        this.next(current, {
          projectionIntent: null,
          candidates: current.candidates.filter(item => item.transactionId !== transactionId),
          latestCandidateTransactionId:
            current.latestCandidateTransactionId === transactionId
              ? null
              : current.latestCandidateTransactionId,
        })
      )
    }
    if (!candidate.publishedSource || candidate.publishedSource.format !== 'v1')
      throw new SessionAuthorityRecordConflictError()
    return this.commit(
      snapshot,
      this.next(current, {
        projectionIntent: null,
        candidates: current.candidates.map(item =>
          item.transactionId === transactionId
            ? { ...item, phase: 'cleanup-pending' as const }
            : item
        ),
      })
    )
  }

  /** Exact raw digest of the authority bytes observed by this repository snapshot. */
  digestSnapshot(snapshot: SessionAuthorityRecordSnapshot): string {
    const captured = this.requireSnapshot(snapshot)
    return digest(captured.bytes ?? 'session-authority:absent:v2')
  }

  /**
   * Accept one exact secure V0 source when no authority record has ever been published. This
   * bootstrap CAS pins the existing bytes; it does not create a candidate slot or rewrite them.
   */
  acceptLegacyBootstrapSource(
    snapshot: SessionAuthorityRecordSnapshot,
    source: SessionAuthorityCredentialSource,
    observation: SelectedLegacySessionCredentialSource
  ): SessionAuthorityCasResult {
    const captured = this.requireSnapshot(snapshot)
    if (
      captured.bytes !== null ||
      captured.record !== null ||
      source.format !== 'v0' ||
      (source.kind !== 'keytar' && source.kind !== 'safe-storage') ||
      !this.tokenStore.isLegacySessionCredentialSourceBoundToScope(source, this.storageScope) ||
      !this.tokenStore.consumeSelectedLegacyPriorSourceObservation(
        observation,
        source,
        this.envKey,
        this.storageScope
      )
    )
      throw new SessionAuthorityRecordConflictError()

    const transactionId = randomUUID()
    const revision = randomUUID()
    const journal = observeSessionPersistenceLegacySnapshot(
      this.tokenStore.resolveSessionAuthorityStorageScope(this.storageScope),
      this.envKey
    )
    if (journal.status !== 'observed') throw journal.error
    const record = initialRecord(this.envKey)
    record.revision = revision
    record.legacyJournalReceipt = journal.receipt
    record.frame = {
      revision,
      envKey: this.envKey,
      mode: 'persistent',
      transactionId,
      source: JSON.parse(JSON.stringify(source)) as SessionAuthorityCredentialSource,
      volatileSessionId: null,
      denyUnframedSources: true,
      recoveryId: null,
    }
    return this.commit(snapshot, record)
  }

  /**
   * Pin the exact V0 source that already owns the active authenticated runtime before a
   * replacement candidate is dispatched. This is not a credential migration or a new write:
   * it makes the verified legacy source explicit so a rejected candidate cannot displace it.
   */
  pinVerifiedActiveLegacySource(
    snapshot: SessionAuthorityRecordSnapshot,
    source: SessionAuthorityCredentialSource,
    observation: LegacySessionCredentialSourceInventory | SelectedLegacySessionCredentialSource
  ): SessionAuthorityCasResult {
    const current = this.requireCurrentRecord(snapshot)
    if (
      current.frame.mode !== 'uninitialized' ||
      current.frame.source !== null ||
      current.marker !== null ||
      current.candidates.length !== 0 ||
      current.cleanupDebts.length !== 0 ||
      source.format !== 'v0' ||
      (source.kind !== 'keytar' && source.kind !== 'safe-storage') ||
      !this.tokenStore.isLegacySessionCredentialSourceBoundToScope(source, this.storageScope) ||
      !('inventory' in observation
        ? this.tokenStore.consumeSelectedLegacyPriorSourceObservation(
            observation,
            source,
            this.envKey,
            this.storageScope
          )
        : this.tokenStore.consumeLegacyPriorSourceObservation(
            observation,
            source,
            this.envKey,
            this.storageScope
          ))
    )
      throw new SessionAuthorityRecordConflictError()

    const transactionId = randomUUID()
    const revision = randomUUID()
    const journal = observeSessionPersistenceLegacySnapshot(
      this.tokenStore.resolveSessionAuthorityStorageScope(this.storageScope),
      this.envKey
    )
    if (journal.status !== 'observed') throw journal.error
    const frame: SessionAuthorityFrame = {
      revision,
      envKey: this.envKey,
      mode: 'persistent',
      transactionId,
      source: JSON.parse(JSON.stringify(source)) as SessionAuthorityCredentialSource,
      volatileSessionId: null,
      denyUnframedSources: true,
      recoveryId: current.frame.recoveryId,
    }
    return this.commit(
      snapshot,
      this.next(current, { frame, marker: null, legacyJournalReceipt: journal.receipt })
    )
  }

  prepareCandidate(
    snapshot: SessionAuthorityRecordSnapshot,
    input: {
      transactionId: string
      candidateHash: string
      accountId: string
      sourceKind: SessionAuthorityCandidate['sourceKind']
      userDataDirectory: string
      externalMarkerObservation: PendingExternalLogoutRawObservation
      sourceRef?: string
      sourceRevision?: string
      volatileSessionId?: string
      priorVolatileSessionId?: string
      purpose?: 'authenticated-replacement' | 'fresh-authentication'
      /** Exact prior selected source, or explicit verified absence. */
      priorSource: SessionAuthorityCredentialSource | null
      /** Required when there is no durable frame-selected source yet. */
      priorSourceObservation?: LegacySessionCredentialSourceInventory
    }
  ): SessionAuthorityCasResult {
    const current = this.requireCurrentRecord(snapshot)
    if (current.projectionIntent !== null) throw new SessionAuthorityRecordConflictError()
    const journal = observeSessionPersistenceLegacySnapshot(
      this.tokenStore.resolveSessionAuthorityStorageScope(this.storageScope),
      this.envKey
    )
    if (journal.status !== 'observed') throw journal.error
    const externalMarker = this.tokenStore.observeSessionAuthorityMarkerRaw(
      this.storageScope,
      input.userDataDirectory,
      this.envKey
    )
    if (
      externalMarker.kind !== input.externalMarkerObservation.kind ||
      externalMarker.rawDigest !== input.externalMarkerObservation.rawDigest ||
      externalMarker.rawContents !== input.externalMarkerObservation.rawContents ||
      externalMarker.marker?.revision !== input.externalMarkerObservation.marker?.revision
    )
      throw new SessionAuthorityRecordConflictError()
    if (
      (current.legacyJournalReceipt !== null &&
        !sessionPersistenceLegacySnapshotMatches(current.legacyJournalReceipt, journal.receipt)) ||
      (current.legacyJournalReceipt === null &&
        current.frame.mode !== 'uninitialized' &&
        current.frame.mode !== 'logged-out') ||
      journal.receipt.denials.some(denial => denial.candidateHash === input.candidateHash)
    )
      throw new SessionAuthorityRecordConflictError()
    // A persistent candidate stays at `denied` only until beginCandidatePublication durably moves
    // it to `writing`, before issuing any TokenStore write capability. A newer producer therefore
    // supersedes denied candidates that provably never had a source slot to publish. Keep every
    // writing/published/verified/cleanup-pending receipt: those may represent an uncertain or
    // completed source write and require exact recovery. Memory-only candidates never publish a
    // bearer source and are likewise superseded outright. Acceptance still requires membership
    // plus latest-producer ownership, so an older producer cannot pass its final CAS after this.
    const retainedCandidates = current.candidates.filter(
      candidate =>
        candidate.sourceKind !== 'memory-only' &&
        (candidate.phase !== 'denied' ||
          activeCandidatePublicationMap(this.tokenStore).has(
            candidatePublicationKey(this.envKey, candidate.transactionId)
          ))
    )
    if (
      retainedCandidates.length +
        current.cleanupDebts.length +
        (current.frame.source === null ? 0 : 1) >=
      MAX_RECEIPTS
    )
      throw new SessionAuthorityRecordCapacityError()
    const transactionId = input.transactionId
    const sourceRef = input.sourceRef ?? randomUUID()
    const sourceRevision = input.sourceRevision ?? randomUUID()
    if (
      !UUID.test(transactionId) ||
      !HASH.test(input.candidateHash) ||
      !input.accountId ||
      input.accountId.length > 256
    )
      throw new Error('Session candidate requires transaction, account and credential identity')
    if (current.candidates.some(item => item.transactionId === transactionId))
      throw new Error('Session candidate transaction already exists')
    const priorSource = input.priorSource
    const purpose = input.purpose ?? 'authenticated-replacement'
    const bootstrapHasNoSelectedSource =
      current.frame.mode === 'uninitialized' &&
      current.frame.source === null &&
      current.marker === null &&
      priorSource === null &&
      input.priorSourceObservation === undefined
    const logoutAllowsFreshAuthentication =
      purpose === 'fresh-authentication' &&
      current.frame.mode === 'logged-out' &&
      current.frame.source === null &&
      current.marker?.intent === 'logout-pending' &&
      priorSource === null &&
      input.priorSourceObservation === undefined
    const activeMemoryOnlyReplacement =
      purpose === 'authenticated-replacement' &&
      current.frame.mode === 'memory-only' &&
      input.priorVolatileSessionId !== undefined &&
      current.frame.volatileSessionId === input.priorVolatileSessionId &&
      current.marker?.intent === 'memory-only-session' &&
      current.marker.volatileSessionId === input.priorVolatileSessionId &&
      current.marker.revision === current.frame.revision &&
      priorSource === null &&
      input.priorSourceObservation === undefined
    const freshAuthenticationFromMemoryOnly =
      purpose === 'fresh-authentication' &&
      current.frame.mode === 'memory-only' &&
      current.frame.source === null &&
      current.marker?.intent === 'memory-only-session' &&
      current.marker.volatileSessionId === current.frame.volatileSessionId &&
      current.marker.revision === current.frame.revision &&
      priorSource === null &&
      (input.priorSourceObservation === undefined ||
        this.tokenStore.consumeLegacyPriorSourceObservation(
          input.priorSourceObservation,
          null,
          this.envKey,
          this.storageScope
        ))
    const freshAuthenticationReplacesLegacySource =
      purpose === 'fresh-authentication' &&
      current.frame.mode === 'persistent' &&
      current.frame.source?.format === 'v0' &&
      priorSource === null
    const uninitializedAllowsFreshAuthentication =
      purpose === 'fresh-authentication' && bootstrapHasNoSelectedSource
    if (
      (purpose === 'fresh-authentication' &&
        !logoutAllowsFreshAuthentication &&
        !freshAuthenticationFromMemoryOnly &&
        !freshAuthenticationReplacesLegacySource &&
        !uninitializedAllowsFreshAuthentication) ||
      (purpose === 'authenticated-replacement' && current.frame.mode === 'logged-out')
    )
      throw new SessionAuthorityRecordConflictError()
    if (
      (current.frame.source &&
        sourceKey(priorSource) !== sourceKey(current.frame.source) &&
        !freshAuthenticationReplacesLegacySource) ||
      (!current.frame.source &&
        (priorSource?.format === 'v1' ||
          (!bootstrapHasNoSelectedSource &&
            !logoutAllowsFreshAuthentication &&
            !activeMemoryOnlyReplacement &&
            !freshAuthenticationFromMemoryOnly &&
            !this.tokenStore.consumeLegacyPriorSourceObservation(
              input.priorSourceObservation,
              priorSource,
              this.envKey,
              this.storageScope
            )))) ||
      (priorSource?.format === 'v0' &&
        !this.tokenStore.isLegacySessionCredentialSourceBoundToScope(
          priorSource,
          this.storageScope
        ))
    )
      throw new SessionAuthorityRecordConflictError()
    const candidate: SessionAuthorityCandidate = {
      transactionId,
      candidateHash: input.candidateHash,
      accountId: input.accountId,
      sourceKind: input.sourceKind,
      sourceRef,
      sourceRevision,
      observedFrameRevision: current.frame.revision,
      observedMarkerRevision: current.marker?.revision ?? null,
      observedExternalMarker: {
        kind: externalMarker.kind,
        revision: externalMarker.marker?.revision ?? null,
        digest: externalMarker.rawDigest,
      },
      observedLegacyJournal: {
        schemaVersion: journal.receipt.schemaVersion,
        revision: journal.receipt.revision,
        byteLength: journal.receipt.byteLength,
        digest: journal.receipt.digest,
      },
      priorSource,
      phase: 'denied',
      publishedSource: null,
      volatileSessionId:
        input.sourceKind === 'memory-only' ? (input.volatileSessionId ?? randomUUID()) : null,
    }
    const result = this.commit(
      snapshot,
      this.next(current, {
        latestCandidateTransactionId: transactionId,
        candidates: [...retainedCandidates, candidate],
        // Bind the exact validated legacy denial snapshot with the candidate denial, before any
        // TokenStore publication capability can be issued. The immutable V0 journal is never
        // compacted by V2; a later phase must prove this exact content-addressed receipt still
        // matches before it stages the sidecar projection or accepts the candidate.
        legacyJournalReceipt: journal.receipt,
      })
    )
    if (result.status === 'committed' && purpose === 'fresh-authentication')
      this.freshAuthenticationCandidates.add(transactionId)
    return result
  }

  /**
   * Prove both the staged-intent and accepted-record representations fit before a candidate
   * source write is authorized. Source digests and generated UUIDs have fixed serialized widths,
   * so a valid placeholder digest gives the exact byte size without persisting bearer material.
   */
  preflightCandidateAcceptanceCapacity(
    snapshot: SessionAuthorityRecordSnapshot,
    transactionId: string,
    input: {
      ownerEpoch: number
      beforeMarker: import('./pendingExternalLogout.js').PendingExternalLogoutRawObservation
    }
  ): void {
    const current = this.requireCurrentRecord(snapshot)
    const candidate = current.candidates.find(item => item.transactionId === transactionId)
    const journalReceipt = current.legacyJournalReceipt
    if (
      !candidate ||
      current.latestCandidateTransactionId !== transactionId ||
      candidate.phase !== 'denied' ||
      current.projectionIntent !== null ||
      !journalReceipt ||
      !validLegacyJournalReceipt(journalReceipt) ||
      journalReceipt.denials.some(denial => denial.candidateHash === candidate.candidateHash) ||
      input.beforeMarker.rawDigest.length !== 64 ||
      !Number.isSafeInteger(input.ownerEpoch) ||
      input.ownerEpoch < 0
    )
      throw new SessionAuthorityRecordConflictError()

    const captured = this.requireSnapshot(snapshot)
    const baseAuthorityDigest = digest(captured.bytes ?? 'session-authority:absent:v2')
    const stagedMarker: import('./pendingExternalLogout.js').AcceptancePendingMarker = {
      version: 2,
      intent: 'acceptance-pending',
      purpose: 'candidate-acceptance',
      operationId: transactionId,
      revision: randomUUID(),
      expectedAuthorityRevision: current.revision,
      expectedAuthorityDigest: baseAuthorityDigest,
      priorMarkerKind: input.beforeMarker.kind,
      priorMarkerDigest: input.beforeMarker.rawDigest,
      priorMarkerRevision: input.beforeMarker.marker?.revision ?? null,
    }
    const intent: SessionAuthorityProjectionIntent = {
      operationId: transactionId,
      candidateTransactionId: transactionId,
      baseAuthorityRevision: current.revision,
      baseAuthorityDigest,
      expectedFrameRevision: current.frame.revision,
      ownerEpoch: input.ownerEpoch,
      beforeMarkerContents: input.beforeMarker.rawContents,
      beforeMarkerKind: input.beforeMarker.kind,
      beforeMarkerDigest: input.beforeMarker.rawDigest,
      beforeMarkerRevision: input.beforeMarker.marker?.revision ?? null,
      stagedMarker,
      legacyJournalReceipt: JSON.parse(
        JSON.stringify(journalReceipt)
      ) as SessionAuthorityLegacyJournalReceipt,
    }

    const publishedSource: SessionAuthorityCredentialSource | null =
      candidate.sourceKind === 'memory-only'
        ? null
        : {
            kind: candidate.sourceKind,
            format: 'v1',
            transactionId: candidate.transactionId,
            envKey: this.envKey,
            accountId: candidate.accountId,
            sourceRef: candidate.sourceRef,
            sourceRevision: candidate.sourceRevision,
            storedValueDigest: '0'.repeat(64),
          }
    const stagedCandidates = current.candidates.map(item =>
      item.transactionId === transactionId
        ? { ...item, phase: 'verified' as const, publishedSource }
        : item
    )
    const stagedRecord = this.next(current, {
      candidates: stagedCandidates,
      projectionIntent: intent,
    })
    this.assertRecordFits(stagedRecord)

    const frameRevision = randomUUID()
    const cleanupDebts = [...current.cleanupDebts]
    if (
      candidate.priorSource &&
      sourceKey(candidate.priorSource) !== sourceKey(publishedSource) &&
      !cleanupDebts.some(debt => sourceKey(debt.source) === sourceKey(candidate.priorSource!))
    ) {
      cleanupDebts.push({
        id: randomUUID(),
        source: candidate.priorSource,
        supersedingFrameRevision: frameRevision,
      })
    }
    const mode = candidate.sourceKind === 'memory-only' ? 'memory-only' : 'persistent'
    const acceptedFrame: SessionAuthorityFrame = {
      revision: frameRevision,
      envKey: this.envKey,
      mode,
      transactionId,
      source: publishedSource,
      volatileSessionId: mode === 'memory-only' ? candidate.volatileSessionId : null,
      denyUnframedSources: true,
      recoveryId: current.frame.recoveryId,
    }
    const marker: SessionAuthorityMarker | null =
      mode === 'memory-only'
        ? {
            intent: 'memory-only-session',
            revision: frameRevision,
            volatileSessionId: candidate.volatileSessionId!,
          }
        : null
    const acceptedRecord = this.next(stagedRecord, {
      marker,
      frame: acceptedFrame,
      latestCandidateTransactionId: null,
      candidates: current.candidates.filter(item => item.transactionId !== transactionId),
      cleanupDebts,
      legacyJournalReceipt: journalReceipt,
      projectionIntent: null,
      projectionReceipt: {
        operationId: intent.operationId,
        baseAuthorityRevision: intent.baseAuthorityRevision,
        baseAuthorityDigest: intent.baseAuthorityDigest,
        marker: intent.stagedMarker,
        legacyJournalReceipt: JSON.parse(
          JSON.stringify(intent.legacyJournalReceipt)
        ) as SessionAuthorityLegacyJournalReceipt,
      },
      logoutReceipt: null,
    })
    this.assertRecordFits(acceptedRecord)
  }

  /** Durably reserve one source publication before issuing any TokenStore write capability. */
  beginCandidatePublication(
    snapshot: SessionAuthorityRecordSnapshot,
    transactionId: string
  ):
    | {
        status: 'ready'
        snapshot: SessionAuthorityRecordSnapshot
        record: SessionAuthorityRecord
        authorization: SessionAuthorityStorageAuthorization
        lease: SessionAuthorityCandidatePublicationLease
      }
    | { status: 'in-flight' }
    | { status: 'indeterminate'; recoveryId: string }
    | { status: 'superseded' } {
    const current = this.requireCurrentRecord(snapshot)
    const candidate = current.candidates.find(item => item.transactionId === transactionId)
    if (
      !candidate ||
      current.latestCandidateTransactionId !== transactionId ||
      candidate.sourceKind === 'memory-only' ||
      candidate.phase !== 'denied' ||
      current.frame.source?.sourceRef === candidate.sourceRef
    )
      throw new Error('Token publication requires an unpublished owned persistent candidate')
    const key = candidatePublicationKey(this.envKey, transactionId)
    const active = activeCandidatePublicationMap(this.tokenStore)
    if (active.has(key)) return { status: 'in-flight' }
    const attemptId = randomUUID()
    active.set(key, attemptId)
    try {
      const candidates = current.candidates.map(item =>
        item.transactionId === transactionId ? { ...item, phase: 'writing' as const } : item
      )
      const result = this.commit(snapshot, this.next(current, { candidates }))
      if (result.status !== 'committed') {
        active.delete(key)
        return result
      }
      const identity = {
        transactionId: candidate.transactionId,
        candidateHash: candidate.candidateHash,
        sourceKind: candidate.sourceKind,
        sourceRef: candidate.sourceRef,
        sourceRevision: candidate.sourceRevision,
        accountId: candidate.accountId,
        envKey: this.envKey,
      }
      return {
        status: 'ready',
        snapshot: result.snapshot,
        record: result.record,
        authorization: issueCleanupAuthorization({
          repository: this,
          tokenStore: this.tokenStore,
          storageScope: this.storageScope,
          envKey: this.envKey,
          recordRevision: result.record.revision,
          purpose: 'candidate-write',
          publicationAttemptId: attemptId,
          candidate: identity,
        }),
        lease: issueCandidatePublicationLease({
          repository: this,
          tokenStore: this.tokenStore,
          storageScope: this.storageScope,
          envKey: this.envKey,
          transactionId,
          attemptId,
          frameRevision: candidate.observedFrameRevision,
          markerRevision: candidate.observedMarkerRevision,
          candidateHash: candidate.candidateHash,
          sourceKind: candidate.sourceKind,
          sourceRef: candidate.sourceRef,
          sourceRevision: candidate.sourceRevision,
          accountId: candidate.accountId,
        }),
      }
    } catch (error) {
      active.delete(key)
      throw error
    }
  }

  async markCandidatePublished(
    snapshot: SessionAuthorityRecordSnapshot,
    transactionId: string,
    publicationReceipt: unknown,
    lease: SessionAuthorityCandidatePublicationLease
  ): Promise<SessionAuthorityCasResult> {
    const attempt = this.requireCandidatePublicationLease(transactionId, lease)
    try {
      const current = this.requireCurrentRecord(snapshot)
      const candidate = current.candidates.find(item => item.transactionId === transactionId)
      if (
        !candidate ||
        current.latestCandidateTransactionId !== transactionId ||
        candidate.sourceKind === 'memory-only' ||
        candidate.phase !== 'writing'
      )
        throw new Error('Persistent publication does not match an active candidate write')
      const source = await this.tokenStore.consumeSessionTokenCandidatePublicationReceipt(
        publicationReceipt,
        this.storageScope,
        {
          transactionId: candidate.transactionId,
          candidateHash: candidate.candidateHash,
          sourceKind: candidate.sourceKind,
          sourceRef: candidate.sourceRef,
          sourceRevision: candidate.sourceRevision,
          envKey: this.envKey,
          accountId: candidate.accountId,
        }
      )
      if (
        !source ||
        source.sourceRef !== candidate.sourceRef ||
        source.sourceRevision !== candidate.sourceRevision ||
        source.transactionId !== candidate.transactionId ||
        source.envKey !== this.envKey ||
        source.kind !== candidate.sourceKind ||
        source.accountId !== candidate.accountId ||
        source.format !== 'v1'
      )
        throw new Error('Published source lacks a matching TokenStore durable-write receipt')
      const stillCurrent = this.requireCurrentRecord(snapshot)
      if (stillCurrent.revision !== current.revision)
        throw new SessionAuthorityRecordConflictError()
      const candidates = current.candidates.map(item =>
        item.transactionId === transactionId
          ? { ...item, phase: 'published' as const, publishedSource: source }
          : item
      )
      return this.commit(snapshot, this.next(current, { candidates }))
    } finally {
      this.releaseCandidatePublicationLease(attempt, lease)
    }
  }

  /**
   * Release a settled failed/uncertain TokenStore write. The durable candidate remains denied in
   * `writing` until exact inspection/discard proves its slot absent; it is never accepted here.
   */
  releaseCandidatePublication(
    transactionId: string,
    lease: SessionAuthorityCandidatePublicationLease
  ): void {
    const attempt =
      typeof lease === 'object' && lease !== null
        ? candidatePublicationLeases.get(lease as object)
        : undefined
    if (
      !attempt ||
      attempt.repository !== this ||
      attempt.tokenStore !== this.tokenStore ||
      attempt.storageScope !== this.storageScope ||
      attempt.envKey !== this.envKey ||
      attempt.transactionId !== transactionId
    )
      throw new Error('Candidate publication lease is stale or belongs to another transaction')
    this.releaseCandidatePublicationLease(attempt, lease)
  }

  /** Mint one source-bound read capability for an exact published, still-unaccepted candidate. */
  authorizeCandidateSourceRead(
    snapshot: SessionAuthorityRecordSnapshot,
    transactionId: string
  ): SessionAuthorityCredentialReadAuthorization {
    const current = this.requireCurrentRecord(snapshot)
    const candidate = current.candidates.find(item => item.transactionId === transactionId)
    if (
      !candidate ||
      (candidate.phase !== 'published' && candidate.phase !== 'verified') ||
      current.latestCandidateTransactionId !== transactionId ||
      candidate.observedFrameRevision !== current.frame.revision ||
      candidate.observedMarkerRevision !== (current.marker?.revision ?? null) ||
      !candidate.publishedSource ||
      candidate.publishedSource.format !== 'v1' ||
      candidate.publishedSource.transactionId !== transactionId ||
      candidate.publishedSource.sourceRef !== candidate.sourceRef ||
      candidate.publishedSource.sourceRevision !== candidate.sourceRevision ||
      candidate.publishedSource.accountId !== candidate.accountId ||
      candidate.publishedSource.envKey !== this.envKey ||
      (current.marker?.intent === 'logout-pending' &&
        (!this.freshAuthenticationCandidates.has(transactionId) ||
          current.frame.mode !== 'logged-out'))
    )
      throw new SessionAuthorityRecordConflictError()
    return issueCredentialReadAuthorization({
      repository: this,
      tokenStore: this.tokenStore,
      storageScope: this.storageScope,
      envKey: this.envKey,
      transactionId,
      recordRevision: current.revision,
      purpose: 'candidate',
      source: JSON.parse(JSON.stringify(candidate.publishedSource)),
    })
  }

  /** Mint one source-bound read capability only for the exact persistent frame currently selected. */
  authorizeAcceptedSourceRead(
    snapshot: SessionAuthorityRecordSnapshot
  ): SessionAuthorityCredentialReadAuthorization {
    const current = this.requireCurrentRecord(snapshot)
    const source = current.frame.source
    if (
      current.frame.mode !== 'persistent' ||
      !source ||
      (source.format === 'v1' && source.transactionId !== current.frame.transactionId) ||
      current.marker?.intent === 'logout-pending' ||
      current.marker?.intent === 'memory-only-session'
    )
      throw new SessionAuthorityRecordConflictError()
    return issueCredentialReadAuthorization({
      repository: this,
      tokenStore: this.tokenStore,
      storageScope: this.storageScope,
      envKey: this.envKey,
      transactionId: current.frame.transactionId!,
      recordRevision: current.revision,
      purpose: 'accepted',
      source: JSON.parse(JSON.stringify(source)),
    })
  }

  /** Mint a read capability only for the one persistent source selected profile-wide. */
  authorizeProfileSelectedSourceRead(
    snapshot: SessionAuthorityRecordSnapshot
  ): SessionAuthorityCredentialReadAuthorization {
    if (this.envKey !== PROFILE_SESSION_AUTHORITY_ENV_KEY)
      throw new Error('Profile-selected source reads require the reserved authority repository')
    const current = this.requireCurrentRecord(snapshot)
    const selection = current.profileSelection
    if (
      selection?.state !== 'active' ||
      selection.mode !== 'persistent' ||
      !selection.source ||
      selection.source.format !== 'v1' ||
      selection.source.transactionId !== selection.transactionId
    )
      throw new SessionAuthorityRecordConflictError()
    return issueCredentialReadAuthorization({
      repository: this,
      tokenStore: this.tokenStore,
      storageScope: this.storageScope,
      envKey: selection.envKey!,
      transactionId: selection.transactionId!,
      recordRevision: current.revision,
      purpose: 'profile-selected',
      source: JSON.parse(JSON.stringify(selection.source)) as SessionAuthorityCredentialSource,
    })
  }

  /** Recheck a completed exact-source read before the caller releases its token to authentication. */
  isAcceptedSourceCurrent(
    snapshot: SessionAuthorityRecordSnapshot,
    source: SessionAuthorityCredentialSource,
    transactionId: string
  ): boolean {
    const captured = this.requireSnapshot(snapshot)
    const observation = this.observe()
    return Boolean(
      observation.status === 'observed' &&
      captured.record?.revision === observation.record.revision &&
      observation.record.frame.mode === 'persistent' &&
      observation.record.frame.transactionId === transactionId &&
      sourceKey(observation.record.frame.source) === sourceKey(source) &&
      observation.record.marker?.intent !== 'logout-pending' &&
      observation.record.marker?.intent !== 'memory-only-session'
    )
  }

  verifyCandidate(
    snapshot: SessionAuthorityRecordSnapshot,
    transactionId: string
  ): SessionAuthorityCasResult {
    const current = this.requireCurrentRecord(snapshot)
    const candidate = current.candidates.find(item => item.transactionId === transactionId)
    if (
      !candidate ||
      current.latestCandidateTransactionId !== transactionId ||
      candidate.observedFrameRevision !== current.frame.revision ||
      candidate.observedMarkerRevision !== (current.marker?.revision ?? null)
    )
      throw new SessionAuthorityRecordConflictError()
    if (candidate.sourceKind === 'memory-only') {
      if (candidate.publishedSource !== null)
        throw new Error('Memory-only candidates cannot publish a bearer source')
    } else if (
      candidate.phase !== 'published' ||
      !candidate.publishedSource ||
      candidate.publishedSource.format !== 'v1' ||
      candidate.publishedSource.transactionId !== candidate.transactionId ||
      candidate.publishedSource.sourceRef !== candidate.sourceRef ||
      candidate.publishedSource.sourceRevision !== candidate.sourceRevision ||
      candidate.publishedSource.accountId !== candidate.accountId ||
      candidate.publishedSource.envKey !== this.envKey
    ) {
      throw new Error('Candidate source lacks exact TokenStore publication verification')
    }
    const candidates = current.candidates.map(item =>
      item.transactionId === transactionId ? { ...item, phase: 'verified' as const } : item
    )
    return this.commit(snapshot, this.next(current, { candidates }))
  }

  /** Commit the exact verified candidate as the accepted source or volatile session. */
  acceptCandidate(
    snapshot: SessionAuthorityRecordSnapshot,
    transactionId: string,
    acceptance: SessionAuthorityAcceptance
  ): SessionAuthorityCasResult {
    const current = this.requireCurrentRecord(snapshot)
    const candidate = current.candidates.find(item => item.transactionId === transactionId)
    const freshAuthentication = this.freshAuthenticationCandidates.has(transactionId)
    if (
      !candidate ||
      current.projectionIntent?.candidateTransactionId !== transactionId ||
      !canAcceptSessionAuthorityCandidate(current, transactionId, freshAuthentication)
    )
      throw new SessionAuthorityRecordConflictError()
    const projectionReceipt: SessionAuthorityProjectionReceipt = {
      operationId: current.projectionIntent.operationId,
      baseAuthorityRevision: current.projectionIntent.baseAuthorityRevision,
      baseAuthorityDigest: current.projectionIntent.baseAuthorityDigest,
      marker: current.projectionIntent.stagedMarker,
      legacyJournalReceipt: current.projectionIntent.legacyJournalReceipt,
    }

    let markerIntent: 'none' | 'keytar-cleanup-pending'
    let mode: SessionAuthorityFrame['mode']
    let source: SessionAuthorityCredentialSource | null
    let volatileSessionId: string | null
    if (acceptance.mode === 'persistent') {
      if (
        candidate.sourceKind === 'memory-only' ||
        acceptance.source.format !== 'v1' ||
        !candidate.publishedSource ||
        sourceKey(candidate.publishedSource) !== sourceKey(acceptance.source) ||
        acceptance.source.transactionId !== candidate.transactionId ||
        acceptance.source.sourceRef !== candidate.sourceRef ||
        acceptance.source.accountId !== candidate.accountId
      )
        throw new Error('Persistent acceptance does not match verified candidate source')
      mode = 'persistent'
      source = acceptance.source
      volatileSessionId = null
      markerIntent = acceptance.markerIntent?.intent ?? 'none'
    } else {
      if (
        candidate.sourceKind !== 'memory-only' ||
        candidate.volatileSessionId !== acceptance.volatileSessionId
      )
        throw new Error('Memory-only acceptance does not match its volatile candidate')
      mode = 'memory-only'
      source = null
      volatileSessionId = acceptance.volatileSessionId
      markerIntent = 'none'
    }

    const frameRevision = randomUUID()
    const cleanupDebts = [...current.cleanupDebts]
    if (
      candidate.priorSource &&
      sourceKey(candidate.priorSource) !== sourceKey(source) &&
      !cleanupDebts.some(debt => sourceKey(debt.source) === sourceKey(candidate.priorSource!))
    ) {
      cleanupDebts.push({
        id: randomUUID(),
        source: candidate.priorSource,
        supersedingFrameRevision: frameRevision,
      })
    }
    const frame: SessionAuthorityFrame = {
      revision: frameRevision,
      envKey: this.envKey,
      mode,
      transactionId,
      source,
      volatileSessionId,
      denyUnframedSources: true,
      recoveryId: current.frame.recoveryId,
    }
    const marker: SessionAuthorityMarker | null =
      mode === 'memory-only'
        ? {
            intent: 'memory-only-session',
            revision: frameRevision,
            volatileSessionId: volatileSessionId!,
          }
        : markerIntent === 'keytar-cleanup-pending'
          ? {
              intent: 'keytar-cleanup-pending',
              revision: frameRevision,
              credentialSource: (
                acceptance as Extract<SessionAuthorityAcceptance, { mode: 'persistent' }>
              ).markerIntent!.credentialSource,
            }
          : null
    const record = this.next(current, {
      marker,
      frame,
      latestCandidateTransactionId: null,
      candidates: current.candidates.filter(item => item.transactionId !== transactionId),
      cleanupDebts,
      legacyJournalReceipt: current.projectionIntent.legacyJournalReceipt,
      projectionIntent: null,
      projectionReceipt,
      logoutReceipt: null,
    })
    const result = this.commit(snapshot, record)
    if (result.status === 'committed') this.freshAuthenticationCandidates.delete(transactionId)
    return result
  }

  /**
   * Finish the per-environment projection after a durable profile selector won its CAS.
   * The profile record is the acceptance authority; this recovery only materializes the
   * matching candidate into the environment-local receipt after rechecking that selector.
   */
  acceptProfileSelectedCandidate(
    snapshot: SessionAuthorityRecordSnapshot,
    profileRepository: SessionAuthorityRecordRepository,
    profileSnapshot: SessionAuthorityRecordSnapshot,
    selection: SessionAuthorityProfileSelection
  ): SessionAuthorityCasResult {
    const profile = profileRepository.observeProfileSelection()
    if (
      profile.status !== 'observed' ||
      !profileRepository.isProfileSelectionCurrent(profileSnapshot, selection) ||
      JSON.stringify(profile.selection) !== JSON.stringify(selection) ||
      selection.state !== 'active' ||
      selection.mode !== 'persistent' ||
      selection.envKey !== this.envKey ||
      !selection.source ||
      selection.source.format !== 'v1' ||
      selection.authorityRevision === null
    )
      throw new SessionAuthorityRecordConflictError()

    const current = this.requireCurrentRecord(snapshot)
    const candidate = current.candidates.find(
      item => item.transactionId === selection.transactionId
    )
    if (
      !candidate ||
      current.latestCandidateTransactionId !== selection.transactionId ||
      current.projectionIntent?.candidateTransactionId !== selection.transactionId ||
      current.projectionIntent.baseAuthorityRevision !== selection.authorityRevision ||
      candidate.phase !== 'verified' ||
      candidate.accountId !== selection.userId ||
      !candidate.publishedSource ||
      sourceKey(candidate.publishedSource) !== sourceKey(selection.source) ||
      candidate.observedFrameRevision !== current.frame.revision ||
      candidate.observedMarkerRevision !== (current.marker?.revision ?? null)
    )
      throw new SessionAuthorityRecordConflictError()

    // Only the globally selected, already identity-verified candidate can reconstruct the
    // ephemeral fresh-authentication permission after a crash.
    if (current.frame.mode === 'logged-out')
      this.freshAuthenticationCandidates.add(selection.transactionId!)
    return this.acceptCandidate(snapshot, selection.transactionId!, {
      mode: 'persistent',
      source: selection.source,
      markerIntent: null,
    })
  }

  commitLogout(
    snapshot: SessionAuthorityRecordSnapshot,
    expectedMarkerRevision: string | null,
    externalLogout: { operationId: string; markerRevision: string; markerDigest: string }
  ): SessionAuthorityCasResult {
    const current = this.requireCurrentRecord(snapshot)
    const captured = this.requireSnapshot(snapshot)
    if ((current.marker?.revision ?? null) !== expectedMarkerRevision)
      return { status: 'superseded' }
    if (
      !UUID.test(externalLogout.operationId) ||
      !UUID.test(externalLogout.markerRevision) ||
      !HASH.test(externalLogout.markerDigest)
    )
      throw new SessionAuthorityRecordConflictError()
    if (
      current.frame.source &&
      current.cleanupDebts.length + current.candidates.length >= MAX_RECEIPTS
    )
      throw new SessionAuthorityRecordCapacityError()
    const revision = randomUUID()
    const frame: SessionAuthorityFrame = {
      revision,
      envKey: this.envKey,
      mode: 'logged-out',
      transactionId: null,
      source: null,
      volatileSessionId: null,
      denyUnframedSources: true,
      recoveryId: current.frame.recoveryId,
    }
    const cleanupDebts = [...current.cleanupDebts]
    if (current.frame.source) {
      cleanupDebts.push({
        id: randomUUID(),
        source: current.frame.source,
        supersedingFrameRevision: revision,
      })
    }
    const logoutReceipt: SessionAuthorityLogoutReceipt = {
      operationId: externalLogout.operationId,
      baseAuthorityRevision: current.revision,
      baseAuthorityDigest: digest(captured.bytes ?? 'session-authority:absent:v2'),
      projectionKind: 'marker',
      markerRevision: externalLogout.markerRevision,
      markerDigest: externalLogout.markerDigest,
      priorMarker: null,
      cleanupDebtIds: cleanupDebts.map(debt => debt.id),
    }
    const marker: SessionAuthorityMarker = { intent: 'logout-pending', revision }
    const candidates = current.candidates.map(candidate =>
      candidate.sourceKind !== 'memory-only' &&
      (candidate.phase === 'writing' ||
        candidate.phase === 'published' ||
        candidate.phase === 'verified')
        ? { ...candidate, phase: 'cleanup-pending' as const }
        : candidate
    )
    const result = this.commit(
      snapshot,
      this.next(current, {
        marker,
        frame,
        latestCandidateTransactionId: null,
        cleanupDebts,
        candidates,
        projectionIntent: null,
        projectionReceipt: null,
        logoutReceipt,
      })
    )
    if (result.status === 'committed' || result.status === 'indeterminate') {
      for (const candidate of current.candidates)
        activeCandidatePublicationMap(this.tokenStore).delete(
          candidatePublicationKey(this.envKey, candidate.transactionId)
        )
    }
    return result
  }

  /**
   * Commit a durable logged-out frame when the legacy sidecar cannot be written. The receipt
   * binds the exact sidecar preimage, while this repository's own durable CAS is the denial.
   * Startup must retain denial if that preimage changes and may project the sidecar later.
   */
  commitLogoutRecordOnly(
    snapshot: SessionAuthorityRecordSnapshot,
    expectedMarkerRevision: string | null,
    priorMarker: PendingExternalLogoutRawObservation,
    operationId: string
  ): SessionAuthorityCasResult {
    const current = this.requireCurrentRecord(snapshot)
    const captured = this.requireSnapshot(snapshot)
    if ((current.marker?.revision ?? null) !== expectedMarkerRevision)
      return { status: 'superseded' }
    if (!UUID.test(operationId)) throw new SessionAuthorityRecordConflictError()
    if (
      current.frame.source &&
      current.cleanupDebts.length + current.candidates.length >= MAX_RECEIPTS
    )
      throw new SessionAuthorityRecordCapacityError()
    const revision = randomUUID()
    const frame: SessionAuthorityFrame = {
      revision,
      envKey: this.envKey,
      mode: 'logged-out',
      transactionId: null,
      source: null,
      volatileSessionId: null,
      denyUnframedSources: true,
      recoveryId: current.frame.recoveryId,
    }
    const cleanupDebts = [...current.cleanupDebts]
    if (current.frame.source) {
      cleanupDebts.push({
        id: randomUUID(),
        source: current.frame.source,
        supersedingFrameRevision: revision,
      })
    }
    const logoutReceipt: SessionAuthorityLogoutReceipt = {
      operationId,
      baseAuthorityRevision: current.revision,
      baseAuthorityDigest: digest(captured.bytes ?? 'session-authority:absent:v2'),
      projectionKind: 'record-only',
      markerRevision: null,
      markerDigest: null,
      priorMarker: {
        kind: priorMarker.kind,
        revision: priorMarker.marker?.revision ?? null,
        digest: priorMarker.rawDigest,
      },
      cleanupDebtIds: cleanupDebts.map(debt => debt.id),
    }
    const candidates = current.candidates.map(candidate =>
      candidate.sourceKind !== 'memory-only' &&
      (candidate.phase === 'writing' ||
        candidate.phase === 'published' ||
        candidate.phase === 'verified')
        ? { ...candidate, phase: 'cleanup-pending' as const }
        : candidate
    )
    const result = this.commit(
      snapshot,
      this.next(current, {
        marker: { intent: 'logout-pending', revision },
        frame,
        latestCandidateTransactionId: null,
        cleanupDebts,
        candidates,
        projectionIntent: null,
        projectionReceipt: null,
        logoutReceipt,
      })
    )
    if (result.status === 'committed' || result.status === 'indeterminate') {
      for (const candidate of current.candidates)
        activeCandidatePublicationMap(this.tokenStore).delete(
          candidatePublicationKey(this.envKey, candidate.transactionId)
        )
    }
    return result
  }

  /** Bind a record-only logout fence to a sidecar LP after marker storage recovers. */
  bindRecordOnlyLogoutToMarker(
    snapshot: SessionAuthorityRecordSnapshot,
    priorMarker: PendingExternalLogoutRawObservation,
    externalLogout: { markerRevision: string; markerDigest: string }
  ): SessionAuthorityCasResult {
    const current = this.requireCurrentRecord(snapshot)
    const receipt = current.logoutReceipt
    if (
      current.frame.mode !== 'logged-out' ||
      current.marker?.intent !== 'logout-pending' ||
      !receipt ||
      receipt.projectionKind !== 'record-only' ||
      !receipt.priorMarker ||
      !sameLogoutMarkerPreimage(receipt.priorMarker, priorMarker) ||
      !UUID.test(externalLogout.markerRevision) ||
      !HASH.test(externalLogout.markerDigest)
    )
      throw new SessionAuthorityRecordConflictError()
    return this.commit(
      snapshot,
      this.next(current, {
        logoutReceipt: {
          ...receipt,
          projectionKind: 'marker',
          markerRevision: externalLogout.markerRevision,
          markerDigest: externalLogout.markerDigest,
          priorMarker: null,
        },
      })
    )
  }

  /**
   * Establish a V2 logout fence for a complete unframed V0 inventory. This is the recovery
   * boundary used after LP has been durably projected first for historical plaintext or an
   * unqualified safeStorage backend. No source is deleted here; every observed V0 source becomes
   * an exact cleanup debt bound to this logged-out frame and immutable journal snapshot.
   */
  commitUnframedLegacyLogoutFence(
    snapshot: SessionAuthorityRecordSnapshot,
    input: {
      operationId: string
      markerRevision: string
      markerDigest: string
      legacyJournalReceipt: SessionAuthorityLegacyJournalReceipt
      sources: readonly SessionAuthorityCredentialSource[]
    }
  ): SessionAuthorityCasResult {
    const current = this.requireCurrentRecord(snapshot)
    const captured = this.requireSnapshot(snapshot)
    if (
      current.frame.mode !== 'uninitialized' ||
      current.frame.source !== null ||
      current.marker !== null ||
      current.cleanupDebts.length !== 0 ||
      current.projectionReceipt !== null ||
      current.logoutReceipt !== null ||
      (current.latestCandidateTransactionId !== null &&
        !current.candidates.some(
          candidate => candidate.transactionId === current.latestCandidateTransactionId
        )) ||
      (current.projectionIntent !== null &&
        !current.candidates.some(
          candidate => candidate.transactionId === current.projectionIntent?.candidateTransactionId
        )) ||
      (current.projectionIntent !== null &&
        JSON.stringify(current.projectionIntent.legacyJournalReceipt) !==
          JSON.stringify(input.legacyJournalReceipt)) ||
      (current.legacyJournalReceipt !== null &&
        JSON.stringify(current.legacyJournalReceipt) !==
          JSON.stringify(input.legacyJournalReceipt)) ||
      !UUID.test(input.operationId) ||
      !UUID.test(input.markerRevision) ||
      !HASH.test(input.markerDigest) ||
      !validLegacyJournalReceipt(input.legacyJournalReceipt) ||
      input.sources.length + current.candidates.length > MAX_RECEIPTS ||
      input.sources.some(
        source =>
          source.format !== 'v0' ||
          source.envKey !== this.envKey ||
          !validSource(source, this.envKey) ||
          !this.tokenStore.isLegacySessionCredentialSourceBoundToScope(source, this.storageScope)
      )
    )
      throw new SessionAuthorityRecordConflictError()

    const sourceKeys = input.sources.map(sourceKey)
    const sourceRefs = input.sources.map(source => source.sourceRef)
    if (
      new Set(sourceKeys).size !== sourceKeys.length ||
      new Set(sourceRefs).size !== sourceRefs.length
    )
      throw new SessionAuthorityRecordConflictError()

    const revision = randomUUID()
    const frame: SessionAuthorityFrame = {
      revision,
      envKey: this.envKey,
      mode: 'logged-out',
      transactionId: null,
      source: null,
      volatileSessionId: null,
      denyUnframedSources: true,
      recoveryId: current.frame.recoveryId,
    }
    const cleanupDebts = input.sources.map(source => ({
      id: randomUUID(),
      source: JSON.parse(JSON.stringify(source)) as SessionAuthorityCredentialSource,
      supersedingFrameRevision: revision,
    }))
    const marker: SessionAuthorityMarker = { intent: 'logout-pending', revision }
    const candidates = current.candidates.map(candidate =>
      candidate.sourceKind !== 'memory-only' &&
      (candidate.phase === 'writing' ||
        candidate.phase === 'published' ||
        candidate.phase === 'verified')
        ? { ...candidate, phase: 'cleanup-pending' as const }
        : candidate
    )
    const logoutReceipt: SessionAuthorityLogoutReceipt = {
      operationId: input.operationId,
      baseAuthorityRevision: current.revision,
      baseAuthorityDigest: digest(captured.bytes ?? 'session-authority:absent:v2'),
      projectionKind: 'marker',
      markerRevision: input.markerRevision,
      markerDigest: input.markerDigest,
      priorMarker: null,
      cleanupDebtIds: cleanupDebts.map(debt => debt.id),
    }
    const result = this.commit(
      snapshot,
      this.next(current, {
        marker,
        frame,
        candidates,
        cleanupDebts,
        legacyJournalReceipt: JSON.parse(
          JSON.stringify(input.legacyJournalReceipt)
        ) as SessionAuthorityLegacyJournalReceipt,
        latestCandidateTransactionId: null,
        projectionIntent: null,
        projectionReceipt: null,
        logoutReceipt,
      })
    )
    if (result.status === 'committed' || result.status === 'indeterminate') {
      for (const candidate of current.candidates)
        activeCandidatePublicationMap(this.tokenStore).delete(
          candidatePublicationKey(this.envKey, candidate.transactionId)
        )
    }
    return result
  }

  /**
   * Mint a one-use TokenStore capability only for a durable exact-source cleanup debt. The
   * authority validator reserves every debt sourceRef, so no later accepted frame can select it.
   */
  authorizeCleanupDebt(
    snapshot: SessionAuthorityRecordSnapshot,
    debtId: string
  ): SessionAuthorityStorageAuthorization {
    const current = this.requireCurrentAuthorizationRecord(snapshot)
    const debt = current.cleanupDebts.find(item => item.id === debtId)
    if (
      !debt ||
      sourceKey(current.frame.source) === sourceKey(debt.source) ||
      !this.isGloballyUnselectedSourceRef(debt.source.sourceRef) ||
      (debt.source.format === 'v0' &&
        (debt.source.envKey !== this.envKey ||
          !this.tokenStore.isLegacySessionCredentialSourceBoundToScope(
            debt.source,
            this.storageScope
          )))
    )
      throw new Error('Cleanup authority requires an exact durable unselected source debt')
    return issueCleanupAuthorization({
      repository: this,
      tokenStore: this.tokenStore,
      storageScope: this.storageScope,
      envKey: this.envKey,
      recordRevision: current.revision,
      purpose: 'source-delete',
      cleanupDebtId: debt.id,
      source: JSON.parse(JSON.stringify(debt.source)) as SessionAuthorityCredentialSource,
    })
  }

  /** True only while this TokenStore owns a live publication lease for a retained candidate. */
  hasActiveCandidatePublication(record: SessionAuthorityRecord): boolean {
    const active = activeCandidatePublicationMap(this.tokenStore)
    return record.candidates.some(candidate =>
      active.has(candidatePublicationKey(this.envKey, candidate.transactionId))
    )
  }

  /**
   * Durably fence a rejected persistent candidate before TokenStore inspects or deletes its slot.
   * A cleanup-pending candidate cannot be verified or accepted, including after a process crash.
   */
  claimRejectedCandidateCleanup(
    snapshot: SessionAuthorityRecordSnapshot,
    transactionId: string
  ):
    | {
        status: 'claimed'
        record: SessionAuthorityRecord
        snapshot: SessionAuthorityRecordSnapshot
        authorization: SessionAuthorityStorageAuthorization
      }
    | { status: 'indeterminate'; recoveryId: string }
    | { status: 'superseded' }
    | { status: 'in-flight' } {
    const current = this.requireCurrentRecord(snapshot)
    const candidate = current.candidates.find(item => item.transactionId === transactionId)
    if (candidate && !this.isGloballyUnselectedSourceRef(candidate.sourceRef))
      return { status: 'superseded' }
    if (
      candidate &&
      activeCandidatePublicationMap(this.tokenStore).has(
        candidatePublicationKey(this.envKey, transactionId)
      )
    )
      return { status: 'in-flight' }
    if (
      !candidate ||
      candidate.sourceKind === 'memory-only' ||
      current.frame.source?.sourceRef === candidate.sourceRef
    )
      throw new Error(
        'Candidate cleanup claim does not identify an unselected persistent candidate'
      )
    let result: SessionAuthorityCasResult
    if (candidate.phase === 'cleanup-pending') {
      result = { status: 'committed', record: current, snapshot }
    } else {
      const candidates = current.candidates.map(item =>
        item.transactionId === transactionId ? { ...item, phase: 'cleanup-pending' as const } : item
      )
      result = this.commit(snapshot, this.next(current, { candidates }))
    }
    if (result.status !== 'committed') return result
    const authorizedRecord = this.requireCurrentAuthorizationRecord(result.snapshot)
    const claimed = authorizedRecord.candidates.find(item => item.transactionId === transactionId)
    if (!claimed || claimed.phase !== 'cleanup-pending')
      throw new Error('Durable candidate cleanup fence was not retained')
    const candidateIdentity = {
      transactionId: claimed.transactionId,
      candidateHash: claimed.candidateHash,
      sourceKind: claimed.sourceKind,
      sourceRef: claimed.sourceRef,
      sourceRevision: claimed.sourceRevision,
      accountId: claimed.accountId,
      envKey: this.envKey,
    }
    return {
      status: 'claimed',
      record: authorizedRecord,
      snapshot: result.snapshot,
      authorization: issueCleanupAuthorization({
        repository: this,
        tokenStore: this.tokenStore,
        storageScope: this.storageScope,
        envKey: this.envKey,
        recordRevision: authorizedRecord.revision,
        purpose: 'candidate-cleanup',
        candidate: candidateIdentity,
      }),
    }
  }

  /** Issue exact-source deletion authority only after the rejected candidate is durably fenced. */
  authorizeRejectedCandidateSourceCleanup(
    snapshot: SessionAuthorityRecordSnapshot,
    transactionId: string
  ): SessionAuthorityStorageAuthorization {
    const current = this.requireCurrentAuthorizationRecord(snapshot)
    const candidate = current.candidates.find(item => item.transactionId === transactionId)
    const source = candidate?.publishedSource
    if (
      !candidate ||
      candidate.phase !== 'cleanup-pending' ||
      !source ||
      source.format !== 'v1' ||
      sourceKey(current.frame.source) === sourceKey(source) ||
      !this.isGloballyUnselectedSourceRef(source.sourceRef)
    )
      throw new Error('Rejected source cleanup requires a durable unselected candidate fence')
    return issueCleanupAuthorization({
      repository: this,
      tokenStore: this.tokenStore,
      storageScope: this.storageScope,
      envKey: this.envKey,
      recordRevision: current.revision,
      purpose: 'source-delete',
      candidate: {
        transactionId: candidate.transactionId,
        candidateHash: candidate.candidateHash,
        sourceKind: candidate.sourceKind,
        sourceRef: candidate.sourceRef,
        sourceRevision: candidate.sourceRevision,
        accountId: candidate.accountId,
        envKey: this.envKey,
      },
      source: JSON.parse(JSON.stringify(source)) as SessionAuthorityCredentialSource,
    })
  }

  retireCleanupDebt(
    snapshot: SessionAuthorityRecordSnapshot,
    debtId: string,
    proof: unknown
  ): SessionAuthorityCasResult {
    const evidence = this.tokenStore.resolveAbsenceProof(proof, this.storageScope)
    if (!evidence || evidence.kind !== 'source-absent')
      throw new Error('Cleanup completion lacks TokenStore proof of exact source absence')
    const profileRepository = new SessionAuthorityRecordRepository(
      this.storageScope,
      PROFILE_SESSION_AUTHORITY_ENV_KEY,
      this.tokenStore
    )
    let currentSnapshot = snapshot
    let current = this.requireCurrentRecord(currentSnapshot)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const debt = current.cleanupDebts.find(item => item.id === debtId)
      if (!debt) return { status: 'superseded' }
      if (
        evidence.transactionId !== (debt.source.format === 'v1' ? debt.source.transactionId : null)
      )
        throw new Error('Cleanup proof transaction does not match exact source debt')
      if (sourceKey(evidence.source) !== sourceKey(debt.source))
        throw new Error('Cleanup proof source does not match exact source debt')
      // Do not let completion bookkeeping mutate the authority frame while a candidate
      // publication lease is live. The exact physical deletion has already happened; retaining
      // its receipt until acceptance resolves is safe and avoids invalidating that lease.
      if (this.hasActiveCandidatePublication(current)) return { status: 'superseded' }
      const profile = profileRepository.observeProfileSelection()
      const globallyUnselected =
        profile.status === 'observed' &&
        profile.selection !== null &&
        (profile.selection.state === 'signed-out' ||
          (profile.selection.state === 'active' &&
            (profile.selection.envKey !== this.envKey ||
              !profile.selection.source ||
              sourceKey(profile.selection.source) !== sourceKey(debt.source))))
      if (
        !canRetireSessionAuthorityCleanupDebt(current.frame.source, debt, evidence.source) &&
        !globallyUnselected
      )
        throw new Error('Cleanup source is still selected by local and profile authority')
      const result = this.commit(
        currentSnapshot,
        this.next(current, {
          cleanupDebts: current.cleanupDebts.filter(item => item.id !== debtId),
          logoutReceipt: current.logoutReceipt
            ? {
                ...current.logoutReceipt,
                cleanupDebtIds: current.logoutReceipt.cleanupDebtIds.filter(id => id !== debtId),
              }
            : null,
        })
      )
      if (result.status !== 'superseded') return result
      const latest = this.observe()
      if (latest.status !== 'observed')
        throw latest.status === 'transient'
          ? latest.error
          : new SessionAuthorityRecordConflictError()
      currentSnapshot = latest.snapshot
      current = latest.record
    }
    return { status: 'superseded' }
  }

  retireProvenUnpublishedCandidate(
    snapshot: SessionAuthorityRecordSnapshot,
    transactionId: string,
    proof: unknown
  ): SessionAuthorityCasResult {
    const current = this.requireCurrentRecord(snapshot)
    const candidate = current.candidates.find(item => item.transactionId === transactionId)
    const evidence = this.tokenStore.resolveAbsenceProof(proof, this.storageScope)
    if (
      !candidate ||
      candidate.phase !== 'cleanup-pending' ||
      candidate.sourceKind === 'memory-only' ||
      !evidence ||
      evidence.kind !== 'candidate-slot-absent' ||
      evidence.candidate.transactionId !== candidate.transactionId ||
      evidence.candidate.candidateHash !== candidate.candidateHash ||
      evidence.candidate.sourceKind !== candidate.sourceKind ||
      evidence.candidate.sourceRef !== candidate.sourceRef ||
      evidence.candidate.sourceRevision !== candidate.sourceRevision ||
      evidence.candidate.envKey !== this.envKey ||
      evidence.candidate.accountId !== candidate.accountId ||
      current.frame.source?.sourceRef === candidate.sourceRef
    )
      throw new Error('Candidate cannot be retired without exact proof that its slot is absent')
    return this.commit(
      snapshot,
      this.next(current, {
        candidates: current.candidates.filter(item => item.transactionId !== transactionId),
      })
    )
  }

  /**
   * Retire an aborted acceptance intent only after its exact persistent candidate slot is proven
   * absent. Memory-only candidates have no bearer slot and are retired with the same CAS that
   * removes the intent. This keeps denial retirement and abort completion indivisible.
   */
  completeAbortedAcceptanceProjection(
    snapshot: SessionAuthorityRecordSnapshot,
    transactionId: string,
    proof?: unknown
  ): SessionAuthorityCasResult {
    const current = this.requireCurrentRecord(snapshot)
    const intent = current.projectionIntent
    const candidate = current.candidates.find(item => item.transactionId === transactionId)
    if (
      !intent ||
      intent.candidateTransactionId !== transactionId ||
      !candidate ||
      current.frame.revision !== intent.expectedFrameRevision ||
      current.frame.source?.sourceRef === candidate.sourceRef
    )
      throw new SessionAuthorityRecordConflictError()

    if (candidate.sourceKind === 'memory-only') {
      if (
        candidate.phase !== 'verified' ||
        proof !== undefined ||
        candidate.publishedSource !== null
      )
        throw new SessionAuthorityRecordConflictError()
    } else {
      const evidence = this.tokenStore.resolveAbsenceProof(proof, this.storageScope)
      if (
        candidate.phase !== 'cleanup-pending' ||
        !evidence ||
        evidence.kind !== 'candidate-slot-absent' ||
        evidence.candidate.transactionId !== candidate.transactionId ||
        evidence.candidate.candidateHash !== candidate.candidateHash ||
        evidence.candidate.sourceKind !== candidate.sourceKind ||
        evidence.candidate.sourceRef !== candidate.sourceRef ||
        evidence.candidate.sourceRevision !== candidate.sourceRevision ||
        evidence.candidate.envKey !== this.envKey ||
        evidence.candidate.accountId !== candidate.accountId
      )
        throw new SessionAuthorityRecordConflictError()
    }

    return this.commit(
      snapshot,
      this.next(current, {
        projectionIntent: null,
        candidates: current.candidates.filter(item => item.transactionId !== transactionId),
        latestCandidateTransactionId:
          current.latestCandidateTransactionId === transactionId
            ? null
            : current.latestCandidateTransactionId,
      })
    )
  }

  /**
   * Retire a denied candidate that never received TokenStore publication authority.
   * `beginCandidatePublication` commits `writing` before minting that authority, so an exact
   * current-record CAS on `denied` proves no candidate slot could have been written. This path is
   * intentionally distinct from cleanup-pending retirement, which requires TokenStore absence
   * evidence after a possibly dispatched write.
   */
  retireNeverDispatchedCandidate(
    snapshot: SessionAuthorityRecordSnapshot,
    transactionId: string
  ): SessionAuthorityCasResult {
    const current = this.requireCurrentRecord(snapshot)
    const candidate = current.candidates.find(item => item.transactionId === transactionId)
    if (!candidate) return { status: 'superseded' }
    if (
      candidate.phase !== 'denied' ||
      activeCandidatePublicationMap(this.tokenStore).has(
        candidatePublicationKey(this.envKey, transactionId)
      )
    )
      return { status: 'superseded' }
    return this.commit(
      snapshot,
      this.next(current, {
        candidates: current.candidates.filter(item => item.transactionId !== transactionId),
        latestCandidateTransactionId:
          current.latestCandidateTransactionId === transactionId
            ? null
            : current.latestCandidateTransactionId,
      })
    )
  }

  /** Retire a pre-intent M candidate only when its schema proves it never had a bearer slot. */
  retireUnacceptedMemoryCandidate(
    snapshot: SessionAuthorityRecordSnapshot,
    transactionId: string
  ): SessionAuthorityCasResult {
    const current = this.requireCurrentRecord(snapshot)
    const candidate = current.candidates.find(item => item.transactionId === transactionId)
    if (
      current.projectionIntent !== null ||
      !candidate ||
      candidate.sourceKind !== 'memory-only' ||
      candidate.phase !== 'verified' ||
      candidate.publishedSource !== null ||
      candidate.volatileSessionId === null ||
      current.frame.transactionId === transactionId
    )
      throw new SessionAuthorityRecordConflictError()
    return this.commit(
      snapshot,
      this.next(current, {
        candidates: current.candidates.filter(item => item.transactionId !== transactionId),
        latestCandidateTransactionId:
          current.latestCandidateTransactionId === transactionId
            ? null
            : current.latestCandidateTransactionId,
      })
    )
  }

  /** Reclaim a rejected, previously published slot only after TokenStore verified exact absence. */
  retireRejectedCandidateAfterCleanup(
    snapshot: SessionAuthorityRecordSnapshot,
    transactionId: string,
    proof: unknown
  ): SessionAuthorityCasResult {
    const current = this.requireCurrentRecord(snapshot)
    const candidate = current.candidates.find(item => item.transactionId === transactionId)
    const publishedSource = candidate?.publishedSource
    const evidence = this.tokenStore.resolveAbsenceProof(proof, this.storageScope)
    if (
      !candidate ||
      candidate.phase !== 'cleanup-pending' ||
      !publishedSource ||
      publishedSource.format !== 'v1' ||
      !evidence ||
      evidence.kind !== 'source-absent' ||
      evidence.transactionId !== publishedSource?.transactionId ||
      evidence.source.sourceRef !== candidate.sourceRef ||
      sourceKey(evidence.source) !== sourceKey(publishedSource) ||
      evidence.source.storedValueDigest !== publishedSource.storedValueDigest ||
      sourceKey(current.frame.source) === sourceKey(publishedSource)
    )
      throw new Error('Rejected candidate cannot retire without exact published-source absence')
    return this.commit(
      snapshot,
      this.next(current, {
        candidates: current.candidates.filter(item => item.transactionId !== transactionId),
      })
    )
  }

  /**
   * Recover a readable malformed/permission-invalid record without interpreting it as empty.
   * A durable fence is written first. The invalid file is preserved by rename and a deny-all
   * LP frame is installed before the fence is removed. Uninspectable transient reads are refused.
   */
  recoverInvalid(
    observation: Extract<SessionAuthorityRecordObservation, { status: 'invalid' }>
  ): string {
    return this.tokenStore.runSessionAuthorityRecordMutation(
      () => this.recoverInvalidUnderAdmission(observation),
      this.transactionLease
    )
  }

  private recoverInvalidUnderAdmission(
    observation: Extract<SessionAuthorityRecordObservation, { status: 'invalid' }>
  ): string {
    this.assertStorageScopeCurrent()
    if (observation.error instanceof SessionAuthorityUnsupportedRecordVersionError)
      throw observation.error
    let pendingRecovery: ReturnType<SessionAuthorityRecordRepository['readRecoveryFence']>
    try {
      pendingRecovery = this.readRecoveryFence()
    } catch (error) {
      if (transient(error)) throw error
      const id = this.recoverInvalidRecoveryFence()
      const afterFenceRecovery = this.observe()
      if (afterFenceRecovery.status === 'invalid')
        return this.recoverInvalidUnderAdmission(afterFenceRecovery)
      return id
    }
    if (pendingRecovery) throw new Error('A session authority recovery fence must be resumed first')
    let pendingMutation: MutationFence | null
    try {
      pendingMutation = this.readMutationFence()
    } catch (error) {
      if (transient(error)) throw error
      return this.recoverInvalidMutationFence()
    }
    if (pendingMutation) throw new Error('A session authority mutation fence must be resumed first')
    const current = readFile(this.file)
    if (current.pathKind !== observation.pathKind) throw new SessionAuthorityRecordConflictError()
    if (
      observation.rawDigest !== null &&
      (current.bytes === null || digest(current.bytes) !== observation.rawDigest)
    )
      throw new SessionAuthorityRecordConflictError()
    if (
      process.platform !== 'win32' &&
      current.pathKind === 'regular' &&
      current.bytes !== null &&
      current.identity !== null &&
      (current.identity.mode & 0o077) !== 0
    ) {
      let readableRecord: SessionAuthorityRecord | null = null
      try {
        readableRecord = validateRecord(JSON.parse(current.bytes), this.envKey)
      } catch {
        // Malformed contents continue through quarantine recovery without losing ambiguity.
      }
      if (readableRecord) return this.repairOversharedRecordPermissions(current, readableRecord)
    }
    let authorityIsInvalid = current.pathKind !== 'regular' || current.bytes === null
    if (current.pathKind === 'regular' && current.bytes !== null && current.identity) {
      if (process.platform !== 'win32' && (current.identity.mode & 0o077) !== 0) {
        authorityIsInvalid = true
      } else {
        try {
          validateRecord(JSON.parse(current.bytes), this.envKey)
          authorityIsInvalid = false
        } catch {
          authorityIsInvalid = true
        }
      }
    }
    if (!authorityIsInvalid)
      throw new Error('Only an invalid authority record may enter corruption recovery')
    const id = randomUUID()
    const raw = this.readRawForRecovery(observation)
    this.writeRecoveryFence(id, 'authority', raw)
    this.resumeRecoveryUnderAdmission()
    return id
  }

  private repairOversharedRecordPermissions(
    observedRecord: ReturnType<typeof readFile>,
    record: SessionAuthorityRecord
  ): string {
    const originalIdentity = observedRecord.identity
    const originalBytes = observedRecord.bytes
    if (
      process.platform === 'win32' ||
      observedRecord.pathKind !== 'regular' ||
      originalIdentity === null ||
      originalBytes === null
    )
      throw new SessionAuthorityRecordConflictError()
    let descriptor: number | undefined
    try {
      const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
      descriptor = fs.openSync(this.file, flags)
      const opened = fs.fstatSync(descriptor)
      if (
        !opened.isFile() ||
        !sameObjectIdentity(originalIdentity, identityOf(opened)) ||
        (typeof process.getuid === 'function' && opened.uid !== process.getuid())
      )
        throw new SessionAuthorityRecordConflictError()
      const bytes = fs.readFileSync(descriptor, 'utf8')
      if (bytes !== originalBytes) throw new SessionAuthorityRecordConflictError()
      fs.fchmodSync(descriptor, 0o600)
      fs.fsyncSync(descriptor)
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
    }
    const repaired = readFile(this.file)
    if (
      repaired.pathKind !== 'regular' ||
      repaired.bytes !== originalBytes ||
      repaired.identity === null ||
      !sameObjectIdentity(originalIdentity, repaired.identity) ||
      (repaired.identity.mode & 0o077) !== 0
    )
      throw new SessionAuthorityRecordConflictError()
    return record.revision
  }

  /** Resume only the exact recovery protected by its already-durable deny fence. */
  resumeRecovery(): string {
    return this.tokenStore.runSessionAuthorityRecordMutation(
      () => this.resumeRecoveryUnderAdmission(),
      this.transactionLease
    )
  }

  private resumeRecoveryUnderAdmission(): string {
    this.assertStorageScopeCurrent()
    const fence = this.readRecoveryFence()
    if (!fence) {
      const mutation = this.readMutationFence()
      if (mutation) return this.resumeMutationRecovery(mutation)
      if (this.indeterminateMutationId) {
        const recoveryId = this.indeterminateMutationId
        // Retry the idempotent durable retirement. Windows uses a write-through rename of the
        // active fence before best-effort removal of its non-authoritative retired name.
        try {
          retireSessionCredentialFileDurablySync(this.mutationFile)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        this.indeterminateMutationId = null
        return recoveryId
      }
      throw new Error('No session authority recovery is pending')
    }
    if (fence.target === 'mutation') return this.resumeCorruptMutationRecovery(fence)
    const quarantineLocator = `session-authority-corrupt-${fence.id}`
    const quarantinePath = path.join(this.directory, quarantineLocator)
    const publishedAuthority = readFile(this.file)
    if (publishedAuthority.bytes !== null) {
      try {
        const publishedRecord = validateRecord(JSON.parse(publishedAuthority.bytes), this.envKey)
        const publishedQuarantine = publishedRecord.quarantines.find(
          item =>
            item.id === fence.id &&
            item.digest === fence.digest &&
            item.locator === quarantineLocator
        )
        if (
          publishedRecord.frame.recoveryId === fence.id &&
          publishedRecord.frame.denyUnframedSources &&
          publishedRecord.frame.mode === 'logged-out' &&
          publishedRecord.frame.source === null &&
          publishedRecord.marker?.intent === 'logout-pending' &&
          publishedRecord.marker.revision === publishedRecord.frame.revision &&
          publishedQuarantine
        ) {
          this.verifyQuarantine(quarantinePath, fence)
          retireSessionCredentialFileDurablySync(this.recoveryFile)
          return fence.id
        }
      } catch (error) {
        if (transient(error)) throw error
        if (error instanceof SessionAuthorityRecordConflictError) throw error
        // Continue only through the exact original-inode path below; arbitrary valid records
        // are never treated as completed recovery.
      }
    }
    let currentPath: fs.Stats | null = null
    try {
      currentPath = fs.lstatSync(this.file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
    if (currentPath) {
      if (!sameIdentity(fence.identity, identityOf(currentPath)))
        throw new SessionAuthorityRecordConflictError()
      try {
        fs.lstatSync(quarantinePath)
        throw new SessionAuthorityRecordConflictError()
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
      }
      renameSessionAuthorityFileDurablySync(this.file, quarantinePath, false)
      if (currentPath.isFile()) fs.chmodSync(quarantinePath, 0o600)
    }
    this.verifyQuarantine(quarantinePath, fence)
    let record: SessionAuthorityRecord
    const authority = readFile(this.file)
    if (authority.pathKind === 'missing') {
      record = initialRecord(this.envKey)
      const revision = randomUUID()
      record.revision = revision
      record.marker = { intent: 'logout-pending', revision }
      record.frame = {
        revision,
        envKey: this.envKey,
        mode: 'logged-out',
        transactionId: null,
        source: null,
        volatileSessionId: null,
        denyUnframedSources: true,
        recoveryId: fence.id,
      }
      record.quarantines = [{ id: fence.id, digest: fence.digest, locator: quarantineLocator }]
      if (!writeAtomic(this.file, null, null, JSON.stringify(record)))
        throw new SessionAuthorityRecordConflictError()
    } else {
      if (authority.bytes === null)
        throw new Error('Recovery target is still not a safe regular file')
      record = validateRecord(JSON.parse(authority.bytes), this.envKey)
      if (
        record.frame.recoveryId !== fence.id ||
        !record.frame.denyUnframedSources ||
        record.frame.mode !== 'logged-out' ||
        record.frame.source !== null ||
        record.marker?.intent !== 'logout-pending' ||
        record.marker.revision !== record.frame.revision
      )
        throw new SessionAuthorityRecordConflictError()
    }
    retireSessionCredentialFileDurablySync(this.recoveryFile)
    return fence.id
  }

  private recoverInvalidMutationFence(): string {
    const current = readFile(this.mutationFile, MAX_MUTATION_FENCE_BYTES)
    if (current.pathKind === 'missing' || current.identity === null)
      throw new SessionAuthorityRecordConflictError()
    const raw = {
      identity: current.identity,
      digest:
        current.bytes !== null
          ? digest(current.bytes)
          : current.pathKind === 'symlink'
            ? digest(fs.readlinkSync(this.mutationFile))
            : null,
    }
    const id = randomUUID()
    this.writeRecoveryFence(id, 'mutation', raw)
    this.resumeRecoveryUnderAdmission()
    const afterMutationRecovery = this.observe()
    if (afterMutationRecovery.status === 'invalid')
      return this.recoverInvalidUnderAdmission(afterMutationRecovery)
    return id
  }

  private recoverInvalidRecoveryFence(): string {
    const currentFence = readFile(this.recoveryFile, 4096)
    if (currentFence.pathKind === 'missing' || currentFence.identity === null)
      throw new SessionAuthorityRecordConflictError()
    const fenceDigest =
      currentFence.bytes !== null
        ? digest(currentFence.bytes)
        : currentFence.pathKind === 'symlink'
          ? digest(fs.readlinkSync(this.recoveryFile))
          : null

    const authority = readFile(this.file)
    // The damaged recovery fence is currently the only independent deny barrier. If the
    // authority file is present but cannot be inspected, do not remove that barrier: it may
    // become readable later as an older accepted frame. Retry recovery once it can be safely
    // replaced by LP or the existing deny state can be verified.
    if (authority.pathKind !== 'missing' && authority.bytes === null)
      throw new Error('Session authority must be inspectable before recovery-fence repair')
    let existing: SessionAuthorityRecord | null = null
    if (authority.bytes !== null) {
      try {
        existing = validateRecord(JSON.parse(authority.bytes), this.envKey)
      } catch {
        // The invalid authority itself remains an independent denial until its own recovery.
      }
    }
    const priorId = existing?.frame.recoveryId
    const priorQuarantine = existing?.quarantines.find(
      item =>
        item.id === priorId &&
        item.digest === fenceDigest &&
        item.locator === `session-authority-corrupt-${priorId}`
    )
    const id = priorQuarantine && priorId ? priorId : randomUUID()
    const locator = `session-authority-corrupt-${id}`
    const quarantinePath = path.join(this.directory, locator)

    if (authority.bytes !== null) {
      if (existing) {
        const revision = randomUUID()
        const cleanupDebts = existing.cleanupDebts.map(debt => ({
          ...debt,
          supersedingFrameRevision: revision,
        }))
        if (existing.frame.source) {
          const debt = cleanupDebts.find(
            item => sourceKey(item.source) === sourceKey(existing.frame.source)
          )
          if (debt) debt.supersedingFrameRevision = revision
          else
            cleanupDebts.push({
              id: randomUUID(),
              source: existing.frame.source,
              supersedingFrameRevision: revision,
            })
        }
        const quarantines = priorQuarantine
          ? [...existing.quarantines]
          : [
              ...existing.quarantines.filter(item => item.id !== id),
              { id, digest: fenceDigest, locator },
            ]
        const denied = validateRecord(
          {
            ...existing,
            revision,
            marker: { intent: 'logout-pending', revision },
            frame: {
              revision,
              envKey: this.envKey,
              mode: 'logged-out',
              transactionId: null,
              source: null,
              volatileSessionId: null,
              denyUnframedSources: true,
              recoveryId: id,
            },
            cleanupDebts,
            quarantines,
            projectionIntent: null,
            projectionReceipt: null,
            logoutReceipt: null,
          },
          this.envKey
        )
        const deniedBytes = JSON.stringify(denied)
        if (!writeAtomic(this.file, authority.bytes, authority.identity, deniedBytes))
          throw new SessionAuthorityRecordConflictError()
        const readBack = readFile(this.file)
        if (readBack.bytes !== deniedBytes) throw new SessionAuthorityRecordConflictError()
      }
    } else if (authority.pathKind === 'missing') {
      const initial = initialRecord(this.envKey)
      const revision = randomUUID()
      const denied = validateRecord(
        {
          ...initial,
          revision,
          marker: { intent: 'logout-pending', revision },
          frame: {
            ...initial.frame,
            revision,
            mode: 'logged-out',
            recoveryId: id,
          },
          quarantines: [{ id, digest: fenceDigest, locator }],
        },
        this.envKey
      )
      if (!writeAtomic(this.file, null, null, JSON.stringify(denied)))
        throw new SessionAuthorityRecordConflictError()
    }

    let fenceStat: fs.Stats
    try {
      fenceStat = fs.lstatSync(this.recoveryFile)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        // A crash after the LP write and quarantine rename is already a complete safe recovery.
        return id
      }
      throw error
    }
    if (!sameIdentity(currentFence.identity, identityOf(fenceStat)))
      throw new SessionAuthorityRecordConflictError()
    try {
      fs.lstatSync(quarantinePath)
      throw new SessionAuthorityRecordConflictError()
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
    renameSessionAuthorityFileDurablySync(this.recoveryFile, quarantinePath, false)
    if (fenceStat.isFile()) fs.chmodSync(quarantinePath, 0o600)
    this.verifyQuarantine(
      quarantinePath,
      { id, digest: fenceDigest, identity: currentFence.identity },
      4096
    )
    return id
  }

  private writeRecoveryFence(
    id: string,
    target: 'authority' | 'mutation',
    raw: { identity: FileIdentity | null; digest: string | null }
  ): void {
    if (!raw.identity) throw new SessionAuthorityRecordConflictError()
    if (readFile(this.recoveryFile).pathKind !== 'missing')
      throw new Error('Another session authority recovery is already fenced')
    const contents = JSON.stringify({
      version: RECOVERY_VERSION,
      id,
      target,
      envKey: this.envKey,
      digest: raw.digest,
      identity: raw.identity,
    })
    // Non-replacing same-directory publication preserves O_EXCL ownership while allowing the
    // native Windows write-through path to establish the active recovery name durably.
    createSessionAuthorityFileDurablySync(this.recoveryFile, contents)
  }

  private resumeCorruptMutationRecovery(fence: {
    id: string
    target: 'authority' | 'mutation'
    digest: string | null
    identity: FileIdentity
  }): string {
    const locator = `session-authority-corrupt-${fence.id}`
    const quarantinePath = path.join(this.directory, locator)
    let current: fs.Stats | null = null
    try {
      current = fs.lstatSync(this.mutationFile)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
    if (current) {
      if (!sameIdentity(fence.identity, identityOf(current)))
        throw new SessionAuthorityRecordConflictError()
      try {
        fs.lstatSync(quarantinePath)
        throw new SessionAuthorityRecordConflictError()
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
      }
      renameSessionAuthorityFileDurablySync(this.mutationFile, quarantinePath, false)
      if (current.isFile()) fs.chmodSync(quarantinePath, 0o600)
    }
    this.verifyQuarantine(quarantinePath, fence, MAX_MUTATION_FENCE_BYTES)

    const authority = readFile(this.file)
    if (authority.pathKind !== 'missing' && authority.bytes === null)
      throw new Error('Session authority must be inspectable before mutation-fence repair')
    if (authority.pathKind === 'missing') {
      const initial = initialRecord(this.envKey)
      const revision = randomUUID()
      const record = validateRecord(
        {
          ...initial,
          revision,
          marker: { intent: 'logout-pending', revision },
          frame: {
            ...initial.frame,
            revision,
            mode: 'logged-out',
            recoveryId: fence.id,
          },
          quarantines: [{ id: fence.id, digest: fence.digest, locator }],
        },
        this.envKey
      )
      if (!writeAtomic(this.file, null, null, JSON.stringify(record)))
        throw new SessionAuthorityRecordConflictError()
    } else if (authority.bytes === null) {
      // The authority remains invalid after the damaged mutation fence is quarantined. Removing
      // this now-unneeded fence exposes that invalid observation so normal authority recovery can
      // preserve it and install LP; it never turns the record into absence.
      this.finishRecoveryFence(fence.id)
      return fence.id
    } else {
      let currentRecord: SessionAuthorityRecord
      try {
        currentRecord = validateRecord(JSON.parse(authority.bytes), this.envKey)
      } catch {
        this.finishRecoveryFence(fence.id)
        return fence.id
      }
      if (
        currentRecord.frame.recoveryId === fence.id &&
        currentRecord.frame.mode === 'logged-out' &&
        currentRecord.marker?.intent === 'logout-pending' &&
        currentRecord.marker.revision === currentRecord.frame.revision
      ) {
        this.finishRecoveryFence(fence.id)
        return fence.id
      }

      const revision = randomUUID()
      const cleanupDebts = currentRecord.cleanupDebts.map(debt => ({
        ...debt,
        supersedingFrameRevision: revision,
      }))
      if (currentRecord.frame.source) {
        const existing = cleanupDebts.find(
          debt => sourceKey(debt.source) === sourceKey(currentRecord.frame.source)
        )
        if (!existing) {
          cleanupDebts.push({
            id: randomUUID(),
            source: currentRecord.frame.source,
            supersedingFrameRevision: revision,
          })
        }
      }
      const quarantines = currentRecord.quarantines.filter(item => item.id !== fence.id)
      quarantines.push({ id: fence.id, digest: fence.digest, locator })
      const recovered = validateRecord(
        {
          ...currentRecord,
          revision,
          marker: { intent: 'logout-pending', revision },
          frame: {
            revision,
            envKey: this.envKey,
            mode: 'logged-out',
            transactionId: null,
            source: null,
            volatileSessionId: null,
            denyUnframedSources: true,
            recoveryId: fence.id,
          },
          cleanupDebts,
          quarantines,
          projectionIntent: null,
          projectionReceipt: null,
          logoutReceipt: null,
        },
        this.envKey
      )
      if (!writeAtomic(this.file, authority.bytes, authority.identity, JSON.stringify(recovered)))
        throw new SessionAuthorityRecordConflictError()
    }
    this.finishRecoveryFence(fence.id)
    return fence.id
  }

  private finishRecoveryFence(id: string): void {
    const current = this.readRecoveryFence()
    if (!current || current.id !== id) throw new SessionAuthorityRecordConflictError()
    retireSessionCredentialFileDurablySync(this.recoveryFile)
  }

  /**
   * Reconcile an interrupted CAS only when the active image is its exact before/next image.
   * Re-publish an exact `next` image through the platform durability primitive before retiring
   * the fence; unknown, torn, or foreign authority bytes remain fail-closed under quarantine.
   */
  private resumeMutationRecovery(fence: MutationFence): string {
    const locator = `session-authority-corrupt-${fence.id}`
    const quarantinePath = path.join(this.directory, locator)
    const existing = readFile(this.file)
    let currentStats: fs.Stats | null = null
    try {
      currentStats = fs.lstatSync(this.file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }

    // The write-ahead fence records the only two authority images this mutation may have
    // published. Classify those exact images before falling back to deny-all quarantine:
    // - exact `before`: the replacement did not publish, so preserve the accepted owner and let
    //   normal orphan-candidate reconciliation deny/clean only the candidate;
    // - exact `next`: the replacement survived restart and is the committed CAS result. Higher-
    //   level startup reconciliation still validates its marker/journal projection before any
    //   credential can be restored.
    // A valid-but-different record, torn bytes, or unreadable image is not either outcome.
    const currentIdentityMatchesPath = Boolean(
      currentStats &&
      existing.pathKind === 'regular' &&
      existing.identity &&
      currentStats.isFile() &&
      sameIdentity(identityOf(currentStats), existing.identity)
    )
    const exactBefore =
      fence.before === null && fence.expectedDigest === null && fence.expectedIdentity === null
        ? existing.pathKind === 'missing' && existing.bytes === null && existing.identity === null
        : fence.before !== null &&
          fence.expectedDigest !== null &&
          fence.expectedIdentity !== null &&
          currentIdentityMatchesPath &&
          existing.bytes !== null &&
          digest(existing.bytes) === fence.expectedDigest &&
          sameIdentity(existing.identity, fence.expectedIdentity)
    const exactStagedLogout =
      exactBefore &&
      fence.next.frame.mode === 'logged-out' &&
      fence.next.logoutReceipt !== null &&
      (() => {
        this.assertStorageScopeCurrent()
        const storageRoot = this.tokenStore.resolveSessionAuthorityStorageScope(this.storageScope)
        const marker = observePendingExternalLogoutRaw(storageRoot, this.envKey, () =>
          this.assertStorageScopeCurrent()
        )
        const receipt = fence.next.logoutReceipt!
        return receipt.projectionKind === 'record-only'
          ? receipt.priorMarker !== null && sameLogoutMarkerPreimage(receipt.priorMarker, marker)
          : marker.marker?.intent.intent === 'logout-pending' &&
              marker.marker.revision === receipt.markerRevision &&
              marker.rawDigest === receipt.markerDigest
      })()
    if (exactBefore && !exactStagedLogout) {
      this.clearMutationFence(fence.id)
      return fence.id
    }

    let exactNext = false
    if (
      currentIdentityMatchesPath &&
      existing.bytes !== null &&
      digest(existing.bytes) === fence.nextDigest
    ) {
      try {
        const current = validateRecord(JSON.parse(existing.bytes), this.envKey)
        exactNext = JSON.stringify(current) === JSON.stringify(fence.next)
      } catch {
        exactNext = false
      }
    }
    if (exactNext || exactStagedLogout) {
      const expected = JSON.stringify(fence.next)
      if (!writeAtomic(this.file, existing.bytes, existing.identity, expected))
        throw new SessionAuthorityRecordConflictError()
      const durableNext = readFile(this.file)
      if (durableNext.pathKind !== 'regular' || durableNext.bytes !== expected)
        throw new SessionAuthorityRecordConflictError()
      this.clearMutationFence(fence.id)
      return fence.id
    }

    if (existing.bytes !== null) {
      try {
        const current = validateRecord(JSON.parse(existing.bytes), this.envKey)
        if (
          current.frame.recoveryId === fence.id &&
          current.frame.mode === 'logged-out' &&
          current.marker?.intent === 'logout-pending' &&
          current.marker.revision === current.frame.revision
        ) {
          this.clearMutationFence(fence.id)
          return fence.id
        }
      } catch {
        // A partially written/foreign record under the durable fence is quarantined below.
      }
    }

    let quarantineDigest: string | null = null
    if (currentStats) {
      if (existing.identity && !sameIdentity(identityOf(currentStats), existing.identity))
        throw new SessionAuthorityRecordConflictError()
      if (currentStats.isFile() && existing.bytes !== null)
        quarantineDigest = digest(existing.bytes)
      else if (currentStats.isSymbolicLink()) quarantineDigest = digest(fs.readlinkSync(this.file))
      try {
        fs.lstatSync(quarantinePath)
        throw new SessionAuthorityRecordConflictError()
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
      }
      renameSessionAuthorityFileDurablySync(this.file, quarantinePath, false)
      if (currentStats.isFile()) fs.chmodSync(quarantinePath, 0o600)
      this.verifyQuarantine(
        quarantinePath,
        { id: fence.id, digest: quarantineDigest, identity: identityOf(currentStats) },
        MAX_BYTES
      )
    } else {
      try {
        fs.lstatSync(quarantinePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
      }
    }

    const allRecords = [fence.before, fence.next].filter(
      (value): value is SessionAuthorityRecord => value !== null
    )
    const candidatesByTransaction = new Map<string, SessionAuthorityCandidate>()
    for (const record of allRecords) {
      for (const candidate of record.candidates)
        candidatesByTransaction.set(candidate.transactionId, candidate)
    }
    const allCandidateReceipts = [...candidatesByTransaction.values()]
    const priorQuarantines = new Map<string, SessionAuthorityQuarantine>()
    for (const record of allRecords) {
      for (const quarantine of record.quarantines) priorQuarantines.set(quarantine.id, quarantine)
    }
    if (currentStats || fs.existsSync(quarantinePath)) {
      priorQuarantines.set(fence.id, {
        id: fence.id,
        digest: quarantineDigest,
        locator,
      })
    }

    const debtBySource = new Map<string, SessionAuthorityCleanupDebt>()
    for (const record of allRecords) {
      for (const debt of record.cleanupDebts) debtBySource.set(sourceKey(debt.source), debt)
      if (record.frame.source) {
        debtBySource.set(sourceKey(record.frame.source), {
          id: randomUUID(),
          source: record.frame.source,
          supersedingFrameRevision: fence.id,
        })
      }
      for (const candidate of record.candidates) {
        if (candidate.publishedSource) {
          debtBySource.set(sourceKey(candidate.publishedSource), {
            id: randomUUID(),
            source: candidate.publishedSource,
            supersedingFrameRevision: fence.id,
          })
        }
      }
    }
    const revision = randomUUID()
    const cleanupDebts = [...debtBySource.values()].map(debt => ({
      ...debt,
      supersedingFrameRevision: revision,
    }))
    // Under LP recovery, an exact cleanup debt is the durable denial for a published candidate's
    // source. Retaining both representations would count the same published source twice and can
    // make recovery exceed the bounded receipt capacity even when both WAL records were valid.
    // Keep unpublished candidate denials, whose source has no exact cleanup debt to carry them.
    const cleanupSourceKeys = new Set(cleanupDebts.map(debt => sourceKey(debt.source)))
    const candidateReceipts = allCandidateReceipts.filter(
      candidate =>
        !candidate.publishedSource || !cleanupSourceKeys.has(sourceKey(candidate.publishedSource))
    )
    const quarantines = [...priorQuarantines.values()]
    if (
      candidateReceipts.length + cleanupDebts.length > MAX_RECEIPTS ||
      quarantines.length > MAX_RECEIPTS
    )
      throw new SessionAuthorityRecordCapacityError()

    const recovered: SessionAuthorityRecord = {
      version: RECORD_VERSION,
      envKey: this.envKey,
      revision,
      marker: { intent: 'logout-pending', revision },
      frame: {
        revision,
        envKey: this.envKey,
        mode: 'logged-out',
        transactionId: null,
        source: null,
        volatileSessionId: null,
        denyUnframedSources: true,
        recoveryId: fence.id,
      },
      latestCandidateTransactionId: null,
      candidates: candidateReceipts,
      cleanupDebts,
      quarantines,
      legacyJournalReceipt: null,
      projectionIntent: null,
      projectionReceipt: null,
      logoutReceipt: null,
    }
    const validated = validateRecord(recovered, this.envKey)
    if (existing.pathKind === 'missing') {
      if (!writeAtomic(this.file, null, null, JSON.stringify(validated)))
        throw new SessionAuthorityRecordConflictError()
    } else if (currentStats) {
      if (!writeAtomic(this.file, null, null, JSON.stringify(validated)))
        throw new SessionAuthorityRecordConflictError()
    } else {
      throw new SessionAuthorityRecordConflictError()
    }
    this.clearMutationFence(fence.id)
    return fence.id
  }

  private verifyQuarantine(
    quarantinePath: string,
    fence: { id: string; digest: string | null; identity: FileIdentity },
    maxBytes = MAX_BYTES
  ): void {
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(quarantinePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
        throw new Error('Corrupt authority source was not preserved in quarantine')
      throw error
    }
    if (!sameObjectIdentity(fence.identity, identityOf(stat)))
      throw new SessionAuthorityRecordConflictError()
    if (stat.isFile()) {
      const preserved = readFile(quarantinePath, maxBytes)
      if (
        preserved.identity === null ||
        !sameObjectIdentity(fence.identity, preserved.identity) ||
        (preserved.bytes === null
          ? fence.digest !== null
          : fence.digest !== null && digest(preserved.bytes) !== fence.digest)
      )
        throw new SessionAuthorityRecordConflictError()
    } else if (stat.isSymbolicLink()) {
      if (fence.digest !== digest(fs.readlinkSync(quarantinePath)))
        throw new SessionAuthorityRecordConflictError()
    }
  }

  private readRawForRecovery(
    observation: Extract<SessionAuthorityRecordObservation, { status: 'invalid' }>
  ): { identity: FileIdentity | null; digest: string | null } {
    if (observation.pathKind === 'missing')
      throw new Error('Missing record needs no corruption recovery')
    const current = fs.lstatSync(this.file)
    const identity = identityOf(current)
    if (observation.pathKind === 'regular' && current.isFile()) {
      const read = readFile(this.file)
      if (!sameIdentity(identity, read.identity)) throw new SessionAuthorityRecordConflictError()
      if (
        observation.rawDigest !== null &&
        (read.bytes === null || digest(read.bytes) !== observation.rawDigest)
      )
        throw new SessionAuthorityRecordConflictError()
      if (read.bytes === null) return { identity, digest: null }
      return { identity, digest: digest(read.bytes) }
    }
    // Preserve a symlink or other path object itself without following it.
    return {
      identity,
      digest: current.isSymbolicLink() ? digest(fs.readlinkSync(this.file)) : null,
    }
  }

  private readRecoveryFence(): {
    id: string
    target: 'authority' | 'mutation'
    digest: string | null
    identity: FileIdentity
  } | null {
    try {
      const read = readFile(this.recoveryFile)
      if (read.pathKind === 'missing') return null
      if (read.pathKind !== 'regular' || read.bytes === null || read.identity!.size > 4096)
        throw new Error('Session authority recovery fence is invalid')
      if (process.platform !== 'win32' && (read.identity!.mode & 0o077) !== 0)
        throw new Error('Session authority recovery fence permissions are not private')
      const parsed = JSON.parse(read.bytes) as Record<string, unknown>
      if (
        parsed.version !== RECOVERY_VERSION ||
        parsed.envKey !== this.envKey ||
        (parsed.target !== 'authority' && parsed.target !== 'mutation') ||
        typeof parsed.id !== 'string' ||
        !UUID.test(parsed.id) ||
        !(
          parsed.digest === null ||
          (typeof parsed.digest === 'string' && HASH.test(parsed.digest))
        ) ||
        !isRecord(parsed.identity) ||
        typeof parsed.identity.dev !== 'number' ||
        typeof parsed.identity.ino !== 'number' ||
        typeof parsed.identity.mode !== 'number' ||
        typeof parsed.identity.size !== 'number' ||
        typeof parsed.identity.mtimeMs !== 'number' ||
        !exactKeys(parsed, ['version', 'id', 'target', 'envKey', 'digest', 'identity']) ||
        !exactKeys(parsed.identity, ['dev', 'ino', 'mode', 'size', 'mtimeMs'])
      )
        throw new Error('Session authority recovery fence is invalid')
      return {
        id: parsed.id,
        target: parsed.target,
        digest: parsed.digest as string | null,
        identity: parsed.identity as FileIdentity,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw error
    }
  }

  private readMutationFence(): MutationFence | null {
    try {
      const read = readFile(this.mutationFile, MAX_MUTATION_FENCE_BYTES)
      if (read.pathKind === 'missing') return null
      if (
        read.pathKind !== 'regular' ||
        read.bytes === null ||
        Buffer.byteLength(read.bytes) > MAX_MUTATION_FENCE_BYTES
      )
        throw new Error('Session authority mutation fence is invalid')
      if (process.platform !== 'win32' && (read.identity!.mode & 0o077) !== 0)
        throw new Error('Session authority mutation fence permissions are not private')
      const parsed = JSON.parse(read.bytes) as Record<string, unknown>
      if (
        parsed.version !== MUTATION_VERSION ||
        parsed.envKey !== this.envKey ||
        typeof parsed.id !== 'string' ||
        !UUID.test(parsed.id) ||
        !(
          parsed.expectedDigest === null ||
          (typeof parsed.expectedDigest === 'string' && HASH.test(parsed.expectedDigest))
        ) ||
        !(
          parsed.beforeRecordDigest === null ||
          (typeof parsed.beforeRecordDigest === 'string' && HASH.test(parsed.beforeRecordDigest))
        ) ||
        typeof parsed.nextDigest !== 'string' ||
        !HASH.test(parsed.nextDigest) ||
        !exactKeys(parsed, [
          'version',
          'id',
          'envKey',
          'expectedDigest',
          'beforeRecordDigest',
          'nextDigest',
          'expectedIdentity',
          'before',
          'next',
        ])
      )
        throw new Error('Session authority mutation fence is invalid')

      let expectedIdentity: FileIdentity | null = null
      if (parsed.expectedIdentity !== null) {
        if (
          !isRecord(parsed.expectedIdentity) ||
          typeof parsed.expectedIdentity.dev !== 'number' ||
          typeof parsed.expectedIdentity.ino !== 'number' ||
          typeof parsed.expectedIdentity.mode !== 'number' ||
          typeof parsed.expectedIdentity.size !== 'number' ||
          typeof parsed.expectedIdentity.mtimeMs !== 'number' ||
          !exactKeys(parsed.expectedIdentity, ['dev', 'ino', 'mode', 'size', 'mtimeMs'])
        )
          throw new Error('Session authority mutation fence identity is invalid')
        expectedIdentity = parsed.expectedIdentity as FileIdentity
      } else if (parsed.expectedDigest !== null) {
        throw new Error('Mutation fence digest has no observed file identity')
      }

      const before = parsed.before === null ? null : validateRecord(parsed.before, this.envKey)
      const next = validateRecord(parsed.next, this.envKey)
      if (
        (before === null) !== (parsed.expectedDigest === null) ||
        (expectedIdentity === null) !== (parsed.expectedDigest === null) ||
        (before === null) !== (parsed.beforeRecordDigest === null) ||
        (before !== null && digest(JSON.stringify(before)) !== parsed.beforeRecordDigest) ||
        digest(JSON.stringify(next)) !== parsed.nextDigest
      )
        throw new Error('Session authority mutation fence record digest is invalid')
      return {
        id: parsed.id,
        envKey: this.envKey,
        expectedDigest: parsed.expectedDigest as string | null,
        nextDigest: parsed.nextDigest,
        expectedIdentity,
        before,
        next,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw error
    }
  }

  private writeMutationFence(
    captured: SnapshotContents,
    next: SessionAuthorityRecord,
    nextBytes: string
  ): string {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const directoryStat = fs.lstatSync(this.directory)
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
      throw new Error('Session authority storage directory is not a real directory')
    if (readFile(this.mutationFile).pathKind !== 'missing')
      throw new Error('Another authority mutation is fenced for recovery')
    const id = randomUUID()
    const contents = JSON.stringify({
      version: MUTATION_VERSION,
      id,
      envKey: this.envKey,
      expectedDigest: captured.bytes === null ? null : digest(captured.bytes),
      beforeRecordDigest: captured.record === null ? null : digest(JSON.stringify(captured.record)),
      nextDigest: digest(nextBytes),
      expectedIdentity: captured.identity,
      before: captured.record,
      next,
    })
    if (Buffer.byteLength(contents) > MAX_MUTATION_FENCE_BYTES)
      throw new SessionAuthorityRecordCapacityError()
    try {
      // Non-replacing write-through publication is the cross-process claim. Concurrent writers
      // cannot replace an existing fence after both observed absence.
      createSessionAuthorityFileDurablySync(this.mutationFile, contents)
      return id
    } catch (error) {
      if (error instanceof SessionAuthorityFileMutationError && error.outcome === 'indeterminate') {
        this.indeterminateMutationId = id
        throw new SessionAuthorityMutationIndeterminateError(id, { cause: error })
      }
      throw error
    }
  }

  private clearMutationFence(id: string): void {
    try {
      const fence = this.readMutationFence()
      if (!fence || fence.id !== id) throw new SessionAuthorityRecordConflictError()
      // Do not acknowledge a CAS until the active recovery-fence name has been durably retired.
      retireSessionCredentialFileDurablySync(this.mutationFile)
      if (this.indeterminateMutationId === id) this.indeterminateMutationId = null
    } catch (error) {
      this.indeterminateMutationId = id
      throw new SessionAuthorityMutationIndeterminateError(id, { cause: error })
    }
  }

  private snapshot(
    bytes: string | null,
    identity: FileIdentity | null,
    record: SessionAuthorityRecord | null
  ): SessionAuthorityRecordObservation {
    const snapshot = {} as SessionAuthorityRecordSnapshot
    const privateRecord = record === null ? null : cloneRecord(record)
    snapshots.set(snapshot, {
      directory: this.directory,
      envKey: this.envKey,
      path: this.file,
      bytes,
      identity,
      record: privateRecord,
    })
    return record
      ? { status: 'observed', record: cloneRecord(record), snapshot }
      : { status: 'absent', snapshot }
  }

  private requireCandidatePublicationLease(
    transactionId: string,
    lease: SessionAuthorityCandidatePublicationLease
  ) {
    const attempt =
      typeof lease === 'object' && lease !== null
        ? candidatePublicationLeases.get(lease as object)
        : undefined
    if (
      !attempt ||
      attempt.repository !== this ||
      attempt.tokenStore !== this.tokenStore ||
      attempt.storageScope !== this.storageScope ||
      attempt.envKey !== this.envKey ||
      attempt.transactionId !== transactionId ||
      activeCandidatePublicationMap(this.tokenStore).get(
        candidatePublicationKey(this.envKey, transactionId)
      ) !== attempt.attemptId
    )
      throw new Error('Candidate publication lease is stale or belongs to another transaction')
    return attempt
  }

  private releaseCandidatePublicationLease(
    attempt: { transactionId: string; attemptId: string },
    lease: SessionAuthorityCandidatePublicationLease
  ): void {
    const active = activeCandidatePublicationMap(this.tokenStore)
    const key = candidatePublicationKey(this.envKey, attempt.transactionId)
    if (active.get(key) === attempt.attemptId) active.delete(key)
    candidatePublicationLeases.delete(lease as object)
  }

  private requireSnapshot(snapshot: SessionAuthorityRecordSnapshot): SnapshotContents {
    this.assertStorageScopeCurrent()
    const captured = snapshots.get(snapshot)
    if (!captured || captured.path !== this.file || captured.envKey !== this.envKey)
      throw new Error('Session authority snapshot belongs to another repository')
    return captured
  }

  private requireCurrentAuthorizationRecord(
    snapshot: SessionAuthorityRecordSnapshot
  ): SessionAuthorityRecord {
    const captured = this.requireSnapshot(snapshot)
    const latest = this.observe()
    if (
      !captured.record ||
      latest.status !== 'observed' ||
      latest.record.revision !== captured.record.revision
    )
      throw new SessionAuthorityRecordConflictError()
    return latest.record
  }

  private assertRecordFits(record: SessionAuthorityRecord): void {
    const validated = validateRecord(record, this.envKey)
    if (Buffer.byteLength(JSON.stringify(validated)) > MAX_BYTES)
      throw new SessionAuthorityRecordCapacityError()
  }

  private requireCurrentRecord(snapshot: SessionAuthorityRecordSnapshot): SessionAuthorityRecord {
    const captured = this.requireSnapshot(snapshot)
    if (!captured.record) throw new Error('Session authority record must be initialized first')
    return captured.record
  }

  private next(
    current: SessionAuthorityRecord,
    updates: Partial<Omit<SessionAuthorityRecord, 'version' | 'envKey' | 'revision'>>
  ): SessionAuthorityRecord {
    return {
      ...current,
      ...updates,
      revision: randomUUID(),
    }
  }

  private commit(
    snapshot: SessionAuthorityRecordSnapshot,
    next: SessionAuthorityRecord
  ): SessionAuthorityCasResult {
    const result = this.tokenStore.runSessionAuthorityRecordMutation(
      () => this.commitUnderAdmission(snapshot, next),
      this.transactionLease
    )
    if (result.status === 'committed') {
      const retained = new Set(result.record.candidates.map(candidate => candidate.transactionId))
      for (const transactionId of this.freshAuthenticationCandidates) {
        if (!retained.has(transactionId)) this.freshAuthenticationCandidates.delete(transactionId)
      }
    }
    return result
  }

  private commitUnderAdmission(
    snapshot: SessionAuthorityRecordSnapshot,
    next: SessionAuthorityRecord
  ): SessionAuthorityCasResult {
    const captured = this.requireSnapshot(snapshot)
    const validated = validateRecord(next, this.envKey)
    const contents = JSON.stringify(validated)
    if (Buffer.byteLength(contents) > MAX_BYTES) throw new SessionAuthorityRecordCapacityError()
    let fenceId: string
    try {
      fenceId = this.writeMutationFence(captured, validated, contents)
    } catch (error) {
      if (error instanceof SessionAuthorityMutationIndeterminateError) {
        const resolved = this.resolveIndeterminateMutationOutcome(
          error.recoveryId,
          captured,
          validated
        )
        if (resolved) return resolved
        return { status: 'indeterminate', recoveryId: error.recoveryId }
      }
      throw error
    }
    try {
      if (!writeAtomic(this.file, captured.bytes, captured.identity, contents)) {
        this.clearMutationFence(fenceId)
        return { status: 'superseded' }
      }
      const readBack = readFile(this.file)
      if (readBack.pathKind !== 'regular' || readBack.bytes !== contents)
        throw new Error('Session authority commit did not verify after durable replacement')
      this.clearMutationFence(fenceId)
      const verified = this.observe()
      if (verified.status === 'observed' && verified.record.revision === validated.revision)
        return { status: 'committed', record: verified.record, snapshot: verified.snapshot }
      if (verified.status === 'observed' || verified.status === 'absent')
        return { status: 'superseded' }
      throw new Error('Session authority commit cannot verify its post-fence state')
    } catch (error) {
      if (error instanceof SessionAuthorityMutationIndeterminateError) {
        const resolved = this.resolveIndeterminateMutationOutcome(
          error.recoveryId,
          captured,
          validated
        )
        if (resolved) return resolved
        return { status: 'indeterminate', recoveryId: error.recoveryId }
      }
      if (error instanceof SessionAuthorityRecordWriteNotPublishedError) {
        // A pre-replacement failure is safe to reject without converting the accepted `before`
        // frame into LP, but only after re-reading the active record and proving its exact
        // bytes/inode are unchanged. The write-ahead fence remains until that comparison and its
        // own durable retirement both succeed. If either observation is uncertain, recovery
        // retains the conservative deny fence below.
        try {
          const after = readFile(this.file)
          const beforeIsStillAuthoritative =
            captured.bytes === null
              ? after.pathKind === 'missing' && after.bytes === null && after.identity === null
              : after.pathKind === 'regular' &&
                after.bytes === captured.bytes &&
                sameIdentity(after.identity, captured.identity)
          if (beforeIsStillAuthoritative) {
            this.clearMutationFence(fenceId)
            return { status: 'superseded' }
          }
        } catch {
          // Preserve the fence whenever current ownership or durable retirement cannot be proven.
        }
      }
      const resolved = this.resolveIndeterminateMutationOutcome(fenceId, captured, validated)
      if (resolved) return resolved
      this.indeterminateMutationId = fenceId
      return { status: 'indeterminate', recoveryId: fenceId }
    }
  }

  /**
   * Resolve only this mutation's exact before/next images while its transaction lease still owns
   * the synchronous record lane. An exact next image is re-published through the platform's
   * durability primitive before it can be returned as committed; an exact before image is a
   * losing CAS. Unknown bytes, a foreign fence, failed durability, or a newer recovery fence
   * remain indeterminate.
   */
  private resolveIndeterminateMutationOutcome(
    id: string,
    captured: SnapshotContents,
    next: SessionAuthorityRecord
  ): SessionAuthorityCasResult | null {
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const fence = this.readMutationFence()
        if (fence) {
          if (fence.id !== id) return null
          const active = readFile(this.file)
          const exactBefore =
            fence.before === null && fence.expectedDigest === null
              ? active.pathKind === 'missing' && active.bytes === null && active.identity === null
              : fence.before !== null &&
                fence.expectedDigest !== null &&
                fence.expectedIdentity !== null &&
                active.pathKind === 'regular' &&
                active.bytes !== null &&
                digest(active.bytes) === fence.expectedDigest &&
                sameIdentity(active.identity, fence.expectedIdentity)
          let exactNext = false
          if (
            active.pathKind === 'regular' &&
            active.bytes !== null &&
            digest(active.bytes) === fence.nextDigest
          ) {
            try {
              exactNext =
                JSON.stringify(validateRecord(JSON.parse(active.bytes), this.envKey)) ===
                JSON.stringify(fence.next)
            } catch {
              exactNext = false
            }
          }
          if (!exactBefore && !exactNext) return null
          this.resumeMutationRecovery(fence)
        } else {
          if (this.indeterminateMutationId !== id || this.readRecoveryFence()) return null
          this.resumeRecoveryUnderAdmission()
        }

        if (this.indeterminateMutationId === id) continue
        const observation = this.observe()
        if (observation.status === 'observed') {
          if (
            observation.record.revision === next.revision &&
            JSON.stringify(observation.record) === JSON.stringify(next)
          )
            return {
              status: 'committed',
              record: observation.record,
              snapshot: observation.snapshot,
            }
          if (
            captured.record !== null &&
            observation.record.revision === captured.record.revision &&
            JSON.stringify(observation.record) === JSON.stringify(captured.record)
          )
            return { status: 'superseded' }
        } else if (observation.status === 'absent' && captured.bytes === null) {
          return { status: 'superseded' }
        }
        return null
      }
    } catch {
      // An unverified image or a second durability failure is still indeterminate.
    }
    return null
  }

  private assertStorageScopeCurrent(): void {
    this.tokenStore.assertSessionAuthorityStorageScopeCurrentSync(this.storageScope)
  }
}

/** Pure cleanup-debt compaction rule shared by the repository property tests. */
export function canRetireSessionAuthorityCleanupDebt(
  currentSource: SessionAuthorityCredentialSource | null,
  debt: SessionAuthorityCleanupDebt,
  sourceAbsent: SessionAuthorityCredentialSource
): boolean {
  return (
    sourceKey(sourceAbsent) === sourceKey(debt.source) &&
    sourceKey(currentSource) !== sourceKey(debt.source)
  )
}

function cloneRecord(record: SessionAuthorityRecord): SessionAuthorityRecord {
  return JSON.parse(JSON.stringify(record)) as SessionAuthorityRecord
}
