import { createHash, randomUUID } from 'node:crypto'
import {
  getActiveEnvKey,
  getActiveLegacyEnvKeyInventory,
  getActiveLegacyEnvKeys,
  getActiveLegacyRestOnlyEnvKey,
} from './config.js'
import { ApiError } from './httpClient.js'
import {
  type MemoryOnlySessionDeadlines,
  isMemoryOnlySessionExpired,
  memoryOnlySessionDeadlines,
  memoryOnlySessionReplacementDeadlines,
} from './memoryOnlySession.js'
import {
  type PendingExternalLogoutCas,
  type PendingExternalLogoutIntent,
  type PendingExternalLogoutMarker,
  isPendingExternalLogoutReadFailure,
  isPendingExternalLogoutWriteFailure,
  isTransientPendingLogoutReadError,
  observePendingExternalLogoutMarker,
  observePendingExternalLogoutRaw,
  pendingExternalLogoutMarkersMatch,
  pendingExternalLogoutOwnership,
} from './pendingExternalLogout.js'
import type { SessionAuthorityRestoreExistingPlan } from './sessionAuthorityAcceptance.js'
import {
  PROFILE_SESSION_AUTHORITY_ENV_KEY,
  type SessionAuthorityCredentialSource,
  type SessionAuthorityProfileSelection,
  SessionAuthorityProjectionIntegrityError,
  type SessionAuthorityRecord,
  SessionAuthorityRecordConflictError,
  SessionAuthorityRecordRepository,
  type SessionAuthorityRecordSnapshot,
} from './sessionAuthorityRecord.js'
import {
  SESSION_CREDENTIAL_SOURCE_ORDER,
  SessionCredentialSourceObservationError,
  isSessionCredentialSourceObservationError,
  planSessionCredentialSourceRead,
  sessionCredentialSourceReadOrder,
} from './sessionCredentialSource.js'
import {
  SessionPersistenceCandidateDeniedError,
  SessionPersistenceJournalAdmissionError,
  isSessionPersistenceCandidateDenied,
  isSessionPersistenceJournalReadFailure,
  observeSessionPersistenceLegacySnapshot,
  readSessionPersistenceJournal,
  sessionPersistenceLegacySnapshotMatches,
} from './sessionPersistenceJournal.js'
import {
  type SessionAuthorityStorageScope,
  type SessionAuthorityTransactionLease,
  type SessionTokenFallbackSnapshot,
  type SessionTokenMutationOptions,
  type SessionTokenMutationSource,
  SessionTokenProviderStateUnknownError,
  type SessionTokenReadAuthority,
  type SessionTokenReadOptions,
  type SessionTokenReadSource,
  type SessionTokenSourceObservation,
  SessionTokenStorageClearError,
  SessionTokenStorageSupersededBeforeWriteError,
  SessionTokenStorageUnavailableBeforeWriteError,
  type StrictSessionTokenClearResult,
  TokenStore,
  focusSessionTokenReadAuthority,
  inspectQualifiedSafeStorageCapability,
  isKeytarCleanupEstablished,
  isSessionTokenFallbackReadFailure,
  isSessionTokenMutationCallbackFailure,
  isSessionTokenReadAuthorityCurrent,
} from './tokenStore.js'
import type { SessionMe } from './types.js'

export type SessionAuthorityAcceptedRestore = {
  status: 'accepted'
  plan: SessionAuthorityRestoreExistingPlan
}

export type SessionAuthorityRestoreSelection =
  | { status: 'absent' }
  | { status: 'denied'; frameMode: 'uninitialized' | 'memory-only' | 'logged-out' }
  | SessionAuthorityAcceptedRestore

function sameAcceptedCredentialSource(
  left: SessionAuthorityCredentialSource,
  right: SessionAuthorityCredentialSource
): boolean {
  return (
    left.format === right.format &&
    left.kind === right.kind &&
    left.envKey === right.envKey &&
    left.accountId === right.accountId &&
    left.sourceRef === right.sourceRef &&
    left.sourceRevision === right.sourceRevision &&
    left.storedValueDigest === right.storedValueDigest &&
    (left.format !== 'v0' ||
      (right.format === 'v0' &&
        JSON.stringify(left.legacyLocator) === JSON.stringify(right.legacyLocator))) &&
    (left.format !== 'v1' || (right.format === 'v1' && left.transactionId === right.transactionId))
  )
}

export type SessionConsumerAcceptanceEvidence = {
  token: string | null
  user: SessionMe | null
  chatBoundScope: {
    environmentKey: string
    userId: string
    teamId: string | null
  } | null
  gfsIdentity: { ownerId: string; teamId: string | null; environmentKey: string } | null
}

export type VerifiedSessionTokenSource = {
  token: string
  source: SessionTokenReadSource
  authority: SessionTokenReadAuthority
}

export type AcceptedSessionTokenSource = {
  selected: VerifiedSessionTokenSource
  envKey: string
  generation: number
}

export type MemoryOnlySessionLease = {
  envKey: string
  volatileSessionId: string
  marker: PendingExternalLogoutMarker
  expiresAt: number
  expiresAtMonotonicMs: number
}

type SessionAuthorityRuntimeOwner = Readonly<{
  token: string | null
  user: SessionMe | null
  generation: number
  acceptedSource: AcceptedSessionTokenSource | undefined
  acceptedAuthoritySource: SessionAuthorityCredentialSource | undefined
  memoryLease: MemoryOnlySessionLease | undefined
  acceptedProjectionMarker: PendingExternalLogoutMarker | undefined
  retiredMemoryCredentialGuard: boolean
}>

export type SessionAuthorityRuntimeOwnerPublication = Readonly<{
  /** Checked before the durable acceptance CAS; no event-loop turn may intervene afterward. */
  isCurrent(): boolean
  /** One non-throwing pointer swap that publishes the complete session/source/lease owner. */
  publish(): undefined
}>

export type MemoryOnlySessionMarker = Omit<PendingExternalLogoutMarker, 'intent'> & {
  intent: Extract<PendingExternalLogoutIntent, { intent: 'memory-only-session' }>
}

type RpcSessionOwner = {
  sessionDigest: string
  envKey: string
  generation: number
  userId: string
  teamId: string | null
  memoryLease: MemoryOnlySessionLease | undefined
}

type RpcCredentialOwnerRecord = {
  owner: RpcSessionOwner
  expiresAtMonotonicMs: number
}

const MAX_TRACKED_RPC_CREDENTIAL_OWNERS = 1024

type PendingRpcCredentialOwnerReservation = { owner: RpcSessionOwner }
type PendingTemporaryCandidateValidation = { owner: RpcSessionOwner }

type SessionRequestOwner = {
  owner: RpcSessionOwner
  credentialDigest: string
  credentialKind: 'session' | 'rpc'
}

type AcceptedSessionRequestContext = {
  kind: 'accepted-session'
  owner: RpcSessionOwner
}

type CandidateSessionRequestContext = {
  kind: 'candidate-session'
  credentialDigest: string
  assertOwnerCurrent: () => void
}

type SessionRequestContext = AcceptedSessionRequestContext | CandidateSessionRequestContext

function credentialDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalSessionTeamId(teamId: string | null | undefined): string | null {
  return String(teamId ?? '').trim() || null
}

export class SessionRequestOwnershipError extends Error {
  constructor() {
    super('The credential is not owned by the current authenticated session')
    this.name = 'SessionRequestOwnershipError'
  }
}

export class SessionRpcCredentialOwnershipCapacityError extends Error {
  constructor() {
    super('RPC credential ownership capacity reached; retry after issued tokens expire')
    this.name = 'SessionRpcCredentialOwnershipCapacityError'
  }
}

export type FreshLoginCredentialWriteAction =
  | { kind: 'secure-preferred' }
  | { kind: 'safe-storage-only' }
  | { kind: 'isolated-development'; retirePendingMarkerAfterWrite: boolean }

export type PendingLogoutLoginPlan = {
  intent: PendingExternalLogoutIntent | null
  marker: PendingExternalLogoutMarker | null
  writeAction: FreshLoginCredentialWriteAction
  retireMarker: boolean
  credentialSource: 'active-keytar' | 'safe-storage' | null
  /** Unresolved prior cleanup cannot be replaced by M without losing its exact source debt. */
  allowMemoryOnlyFallback: boolean
}

/**
 * Coordinator-owned plan for a public password/OAuth login candidate. The acceptance transaction
 * revalidates the authority revision before it creates a denial receipt; this plan carries only
 * the source precedence and the runtime owner observed by the coordinator.
 */
export type FreshSessionAcceptancePlan = {
  envKey: string
  /** Immutable source-namespace snapshot captured by the coordinator for this producer. */
  legacyEnvKeys: readonly string[]
  legacyNamespaceComplete: boolean
  authorityRevision: string | null
  source: 'keytar' | 'safe-storage' | 'memory-only'
  purpose: 'fresh-authentication' | 'authenticated-replacement'
  priorToken: string | null
  priorVolatileSessionId?: string
  volatileSessionId?: string
  expiresAt?: number
  expiresAtMonotonicMs?: number
  memoryOnlyClockEpoch?: number
  generation: number
  ownerToken: string | null
  ownerUser: SessionMe | null
  ownerMemoryLease: MemoryOnlySessionLease | undefined
  expectedMarker: PendingExternalLogoutMarker | null
  token: string
}

export type FreshLoginMarkerPlan =
  | { kind: 'ready'; plan: PendingLogoutLoginPlan }
  | {
      kind: 'cleanup-source'
      marker: PendingExternalLogoutMarker
      source: 'active-keytar' | 'safe-storage'
    }
  | { kind: 'finalize-logout'; marker: PendingExternalLogoutMarker }

export type MalformedMarkerLoginPlan =
  | { kind: 'reject-transient-read' }
  | { kind: 'read-observed-revision' }
  | { kind: 'normalize-observed-bytes'; contentsRevision: string }
  | { kind: 'deny-unverifiable-marker' }

export type RejectedCandidateCleanupPlan =
  | { kind: 'allow' }
  | { kind: 'deny' }
  | { kind: 'fail'; error: unknown }

export type RejectedLoginCandidateRepair = {
  source: 'active-keytar' | 'safe-storage'
  restoreToken: string | null
}

export type LogoutJournalRetirementPlan = { kind: 'skip' } | { kind: 'retire-verified-snapshot' }

export type RestoreMarkerMismatchPlan =
  | { kind: 'superseded' }
  | { kind: 'finalize-logout'; marker: PendingExternalLogoutMarker }

export type RestoreMarkerObservationPlan = { kind: 'continue' } | RestoreMarkerMismatchPlan

export type RejectedLoginMarkerRecoveryPlan =
  | { kind: 'none' }
  | { kind: 'write-logout-intent-if-missing' }
  | { kind: 'replace-observed-logout-intent'; marker: PendingExternalLogoutMarker }
  | { kind: 'preserve-newer-marker' }

export type AcceptedLoginMarkerPlan =
  | { kind: 'preserve'; marker: PendingExternalLogoutMarker | null }
  | { kind: 'apply'; cas: PendingExternalLogoutCas }

export type MarkerRetirementFailurePlan =
  | { kind: 'preserve'; marker: PendingExternalLogoutMarker | null }
  | { kind: 'restore-cleanup-if-missing'; next: PendingExternalLogoutMarker }

export type MarkerCasPlan =
  | { kind: 'create-if-missing'; next: PendingExternalLogoutMarker }
  | {
      kind: 'replace-if-unchanged'
      expected: PendingExternalLogoutMarker
      next: PendingExternalLogoutMarker
    }

export type SessionSourceBindingPlan =
  | { kind: 'retain'; marker: PendingExternalLogoutMarker | null }
  | { kind: 'create-if-missing'; next: PendingExternalLogoutMarker }
  | {
      kind: 'replace-if-unchanged'
      expected: PendingExternalLogoutMarker
      next: PendingExternalLogoutMarker
    }
  | { kind: 'conflict' }

export type SessionSourceCleanupPlan = {
  source: 'active-keytar' | 'safe-storage'
  preserveActiveEnvKey: boolean
  preserveActiveEncryptedToken?: string
}

export type SessionSourceCleanupOutcome = {
  source: 'active-keytar' | 'safe-storage'
  kind: 'verified' | 'incomplete' | 'superseded'
}

export type SessionSourceCleanupEvidence = {
  sourceVerified: boolean
  keytarCleanupSettled: boolean
  fallbackRetirementVerified: boolean
  ownerCurrent: boolean
}

export type PersistenceFailureContext =
  | 'producer-rollback'
  | 'nested-producer-rollback'
  | 'restore-source-observation'
  | 'restore-session-validation'
  | 'source-cleanup'
  | 'marker-inspection'
  | 'marker-cleanup'
  | 'marker-retirement'
  | 'marker-finalization'

export type PersistenceAuthorityFailurePlan =
  | {
      kind: 'transient-read'
      source: 'marker' | 'journal' | 'fallback' | 'keytar' | 'safe-storage'
      action: 'repair-owned-source' | 'preserve-prior-runtime' | 'reject-candidate' | 'defer'
    }
  | {
      kind: 'fail-closed'
      source: 'marker' | 'journal' | 'fallback' | 'keytar' | 'safe-storage' | 'other'
    }
  | {
      kind: 'continue'
      source: 'marker' | 'journal' | 'fallback' | 'keytar' | 'safe-storage' | 'other'
    }
  | { kind: 'ignore' }

export type PendingLogoutFailureDisposition = 'transient' | 'failed-closed' | 'ignored'

export type TeamTransitionMarkerAdmissionPlan =
  | { kind: 'allow' }
  | { kind: 'fail-closed' }
  | { kind: 'reject' }

export type SavedSessionRestorePolicy =
  | 'normal'
  | 'safe-storage-only'
  | 'keytar-active-only'
  | 'deny-all'

export type SavedSessionRestorePlan = {
  policy: SavedSessionRestorePolicy
  pendingCleanupMarker: PendingExternalLogoutMarker | null
  retireMarkerAfterRestore: boolean
}

export type SavedSessionRestoreAction =
  | { kind: 'restore'; plan: SavedSessionRestorePlan }
  | { kind: 'deny'; plan: SavedSessionRestorePlan }
  | {
      kind: 'cleanup-source'
      plan: SavedSessionRestorePlan
      source: 'active-keytar' | 'safe-storage'
    }
  | { kind: 'finalize-logout'; marker: PendingExternalLogoutMarker }

export type MarkerRetirementPlan =
  | { kind: 'preserve'; marker: PendingExternalLogoutMarker | null }
  | { kind: 'retire'; cas: PendingExternalLogoutCas }

export type LogoutStartPlan =
  | { kind: 'retain-memory-only-denial'; marker: PendingExternalLogoutMarker }
  | {
      kind: 'upgrade-cleanup-marker'
      cas: PendingExternalLogoutCas
      next: PendingExternalLogoutMarker
    }
  | { kind: 'clear-first'; marker: PendingExternalLogoutMarker | null }

export type PendingLogoutApplicationPlan =
  | { kind: 'none' }
  | {
      kind: 'cleanup-source'
      marker: PendingExternalLogoutMarker
      source: 'active-keytar' | 'safe-storage'
    }
  | { kind: 'finalize-logout'; marker: PendingExternalLogoutMarker }

export type LogoutClearPlan =
  | { kind: 'ensure-logout-intent'; expectedMarker: PendingExternalLogoutMarker | null }
  | { kind: 'retire-journal-and-marker'; marker: PendingExternalLogoutMarker | null }
  | { kind: 'preserve-observed-marker'; marker: PendingExternalLogoutMarker | null }

export type LogoutFailureMarkerPlan =
  | { kind: 'preserve-existing-logout-intent'; marker: PendingExternalLogoutMarker }
  | { kind: 'write-logout-intent' }
  | { kind: 'superseded' }

export class TemporarySessionEndedError extends Error {
  constructor() {
    super('Session has ended')
    this.name = 'TemporarySessionEndedError'
  }
}

export class TemporarySessionExpiredError extends Error {
  constructor() {
    super('Temporary session expired. Please sign in again.')
    this.name = 'TemporarySessionExpiredError'
  }
}

export class TemporarySessionEnvironmentChangedError extends Error {
  constructor() {
    super('Temporary session belongs to another environment')
    this.name = 'TemporarySessionEnvironmentChangedError'
  }
}

export class TemporarySessionAuthorityUnavailableError extends Error {
  constructor() {
    super('Temporary session authority is unavailable. Please sign in again.')
    this.name = 'TemporarySessionAuthorityUnavailableError'
  }
}

export class TemporarySessionReplacedError extends Error {
  constructor() {
    super('Temporary session was replaced before request dispatch')
    this.name = 'TemporarySessionReplacedError'
  }
}

export class SelectedSessionSourceSupersededError extends SessionTokenStorageSupersededBeforeWriteError {}

export function isMemoryOnlySessionMarker(
  marker: PendingExternalLogoutMarker | null
): marker is MemoryOnlySessionMarker {
  return marker?.intent.intent === 'memory-only-session'
}

export function sessionTokenPublicationSource(
  source: SessionTokenMutationSource,
  token: string,
  authority: SessionTokenReadAuthority
): VerifiedSessionTokenSource {
  return {
    token,
    source: source === 'isolated-plaintext' ? 'historical-plaintext' : source,
    authority,
  }
}

type SessionAuthorityCoordinatorOptions = {
  getTokenStore: () => TokenStore
  getUserDataDirectory: () => string
  reportDeferredLogoutFailure: (error: unknown) => void
  failClosedForPendingLogout: (error: unknown) => Promise<void>
  nowMonotonic?: () => number
}

/**
 * Owns main-process session-source identity and the shared authority checks used by every
 * producer. AppService remains the public facade and supplies effect callbacks, but it does
 * not keep a second copy of source/lease state or a separate persistence queue.
 */
export class SessionAuthorityCoordinator {
  private memoryOnlyClockEpoch = 0
  private runtimeOwner: SessionAuthorityRuntimeOwner = Object.freeze({
    token: null,
    user: null,
    generation: 0,
    acceptedSource: undefined,
    acceptedAuthoritySource: undefined,
    memoryLease: undefined,
    acceptedProjectionMarker: undefined,
    retiredMemoryCredentialGuard: false,
  })
  private persistenceQueue: Promise<void> = Promise.resolve()
  private rpcCredentialOwners = new Map<string, RpcCredentialOwnerRecord>()
  private pendingRpcCredentialOwnerReservations = new Set<PendingRpcCredentialOwnerReservation>()
  private pendingTemporaryCandidateValidations = new Map<
    string,
    PendingTemporaryCandidateValidation
  >()

  private get token(): string | null {
    return this.runtimeOwner.token
  }

  private set token(value: string | null) {
    this.runtimeOwner = Object.freeze({
      ...this.runtimeOwner,
      token: value,
      ...(value === null
        ? { acceptedProjectionMarker: undefined, acceptedAuthoritySource: undefined }
        : {}),
    })
  }

  private get authenticatedUser(): SessionMe | null {
    return this.runtimeOwner.user
  }

  private set authenticatedUser(value: SessionMe | null) {
    this.runtimeOwner = Object.freeze({ ...this.runtimeOwner, user: value })
  }

  private get generation(): number {
    return this.runtimeOwner.generation
  }

  private set generation(value: number) {
    this.runtimeOwner = Object.freeze({ ...this.runtimeOwner, generation: value })
  }

  private get acceptedSource(): AcceptedSessionTokenSource | undefined {
    return this.runtimeOwner.acceptedSource
  }

  private set acceptedSource(value: AcceptedSessionTokenSource | undefined) {
    this.runtimeOwner = Object.freeze({ ...this.runtimeOwner, acceptedSource: value })
  }

  private get acceptedAuthoritySource(): SessionAuthorityCredentialSource | undefined {
    return this.runtimeOwner.acceptedAuthoritySource
  }

  private set acceptedAuthoritySource(value: SessionAuthorityCredentialSource | undefined) {
    this.runtimeOwner = Object.freeze({ ...this.runtimeOwner, acceptedAuthoritySource: value })
  }

  private get memoryLease(): MemoryOnlySessionLease | undefined {
    return this.runtimeOwner.memoryLease
  }

  private set memoryLease(value: MemoryOnlySessionLease | undefined) {
    const retiredMemoryCredentialGuard =
      this.runtimeOwner.retiredMemoryCredentialGuard ||
      Boolean(
        this.runtimeOwner.memoryLease &&
        this.runtimeOwner.memoryLease.volatileSessionId !== value?.volatileSessionId
      )
    this.runtimeOwner = Object.freeze({
      ...this.runtimeOwner,
      memoryLease: value,
      retiredMemoryCredentialGuard,
    })
  }

  private get acceptedProjectionMarker(): PendingExternalLogoutMarker | undefined {
    return this.runtimeOwner.acceptedProjectionMarker
  }

  private set acceptedProjectionMarker(value: PendingExternalLogoutMarker | undefined) {
    this.runtimeOwner = Object.freeze({ ...this.runtimeOwner, acceptedProjectionMarker: value })
  }

  /** Deny unknown credentials after a volatile lease ends, without retaining an unbounded set. */
  private get retiredMemoryCredentialGuard(): boolean {
    return this.runtimeOwner.retiredMemoryCredentialGuard
  }

  private set retiredMemoryCredentialGuard(value: boolean) {
    this.runtimeOwner = Object.freeze({
      ...this.runtimeOwner,
      retiredMemoryCredentialGuard: value,
    })
  }

  constructor(private readonly options: SessionAuthorityCoordinatorOptions) {}

  private get tokenStore(): TokenStore {
    return this.options.getTokenStore()
  }

  /** The coordinator is the single owner of fresh-login K → qualified S selection. */
  async selectFreshPersistentCandidateSource(): Promise<'keytar' | 'safe-storage' | null> {
    const keytar = await this.tokenStore.inspectVersionedKeytarCapability()
    if (keytar === 'available') return 'keytar'

    const safeStorage = inspectQualifiedSafeStorageCapability()
    if (safeStorage === 'unknown') throw new SessionTokenProviderStateUnknownError('safe-storage')
    return safeStorage === 'available' ? 'safe-storage' : null
  }

  /**
   * Select the source and predecessor semantics for a fresh account-authenticated producer.
   * AppService supplies the marker result of its cleanup preflight, but does not select a
   * credential source or decide whether the producer replaces an accepted frame.
   */
  async planFreshSessionAcceptance(input: {
    envKey: string
    token: string
    authenticatedAt: number
    authenticatedAtMonotonic?: number
    memoryOnlyClockEpoch?: number
    pendingLogout: PendingLogoutLoginPlan
    legacyEnvKeys: readonly string[]
    legacyNamespaceComplete?: boolean
  }): Promise<FreshSessionAcceptancePlan> {
    if (!input.token || !input.envKey || getActiveEnvKey() !== input.envKey)
      throw new SessionAuthorityRecordConflictError()
    const legacyEnvKeys = Object.freeze([...input.legacyEnvKeys])

    const owner = {
      generation: this.generation,
      token: this.token,
      user: this.authenticatedUser,
      memoryLease: this.memoryLease,
    }
    const memoryOnlyClockEpoch = input.memoryOnlyClockEpoch ?? this.memoryOnlyClockEpoch
    const expectedMarker = this.inspectPendingLogoutMarker(input.envKey)
    if (!pendingExternalLogoutMarkersMatch(expectedMarker, input.pendingLogout.marker))
      throw new SessionTokenStorageSupersededBeforeWriteError()

    let persistentSource: 'keytar' | 'safe-storage' | null
    if (input.pendingLogout.writeAction.kind === 'safe-storage-only') {
      const capability = inspectQualifiedSafeStorageCapability()
      if (capability === 'unknown') throw new SessionTokenProviderStateUnknownError('safe-storage')
      persistentSource = capability === 'available' ? 'safe-storage' : null
    } else {
      persistentSource = await this.selectFreshPersistentCandidateSource()
    }

    let lease: SessionAuthorityTransactionLease | undefined
    let authorityRevision: string | null = null
    let purpose: FreshSessionAcceptancePlan['purpose'] = 'fresh-authentication'
    let priorVolatileSessionId: string | undefined
    const legacyNamespaceComplete =
      input.legacyNamespaceComplete ?? getActiveLegacyEnvKeyInventory().complete
    try {
      lease = this.tokenStore.beginSessionAuthorityTransaction()
      const observation = await this.tokenStore.runWithSessionAuthorityTransaction(
        lease,
        async () => {
          const storageScope = await this.tokenStore.createSessionAuthorityStorageScope()
          const repository = new SessionAuthorityRecordRepository(
            storageScope,
            input.envKey,
            this.tokenStore,
            lease!
          )
          return repository.observe()
        }
      )
      if (observation.status === 'transient' || observation.status === 'invalid')
        throw observation.error
      if (observation.status === 'observed') {
        authorityRevision = observation.record.revision
        const { frame, marker } = observation.record
        if (frame.mode === 'persistent' && frame.source) {
          purpose =
            frame.source.format === 'v0' ? 'fresh-authentication' : 'authenticated-replacement'
        } else if (frame.mode === 'memory-only') {
          const activeLease = owner.memoryLease
          const leaseOwnsFrame = Boolean(
            activeLease &&
            activeLease.envKey === input.envKey &&
            activeLease.volatileSessionId === frame.volatileSessionId &&
            marker?.intent === 'memory-only-session' &&
            marker.volatileSessionId === frame.volatileSessionId &&
            marker.revision === frame.revision &&
            !this.isMemoryOnlySessionLeaseExpired(activeLease)
          )
          if (leaseOwnsFrame) {
            purpose = 'authenticated-replacement'
            priorVolatileSessionId = frame.volatileSessionId ?? undefined
          }
        } else if (frame.mode === 'logged-out' && marker?.intent !== 'logout-pending') {
          throw new SessionAuthorityRecordConflictError()
        }
      }
    } finally {
      if (lease) this.tokenStore.finishSessionAuthorityTransaction(lease)
    }

    if (!persistentSource && !input.pendingLogout.allowMemoryOnlyFallback)
      throw new Error(
        'Secure credential storage is unavailable while exact cleanup remains pending'
      )

    const source = persistentSource ?? 'memory-only'
    if (
      this.generation !== owner.generation ||
      this.token !== owner.token ||
      this.authenticatedUser !== owner.user ||
      this.memoryLease !== owner.memoryLease ||
      getActiveEnvKey() !== input.envKey ||
      (source === 'memory-only' && memoryOnlyClockEpoch !== this.memoryOnlyClockEpoch) ||
      !pendingExternalLogoutMarkersMatch(
        this.inspectPendingLogoutMarker(input.envKey),
        expectedMarker
      )
    )
      throw new SessionTokenStorageSupersededBeforeWriteError()

    const volatileSessionId = source === 'memory-only' ? randomUUID() : undefined
    return {
      envKey: input.envKey,
      legacyEnvKeys,
      legacyNamespaceComplete,
      authorityRevision,
      source,
      purpose,
      priorToken:
        purpose === 'authenticated-replacement' && !priorVolatileSessionId ? owner.token : null,
      ...(priorVolatileSessionId ? { priorVolatileSessionId } : {}),
      ...(volatileSessionId ? { volatileSessionId } : {}),
      ...(source === 'memory-only'
        ? memoryOnlySessionDeadlines(
            input.token,
            input.authenticatedAt,
            input.authenticatedAtMonotonic ?? this.nowMonotonic()
          )
        : {}),
      ...(source === 'memory-only' ? { memoryOnlyClockEpoch } : {}),
      generation: owner.generation,
      ownerToken: owner.token,
      ownerUser: owner.user,
      ownerMemoryLease: owner.memoryLease,
      expectedMarker,
      token: input.token,
    }
  }

  assertFreshSessionAcceptancePlanCurrent(
    plan: FreshSessionAcceptancePlan,
    logoutInProgress: boolean
  ): void {
    if (plan.ownerMemoryLease && this.isMemoryOnlySessionLeaseExpired(plan.ownerMemoryLease))
      throw new TemporarySessionExpiredError()
    if (plan.source === 'memory-only' && plan.memoryOnlyClockEpoch !== this.memoryOnlyClockEpoch)
      throw new SessionTokenStorageSupersededBeforeWriteError()
    if (
      logoutInProgress ||
      getActiveEnvKey() !== plan.envKey ||
      this.generation !== plan.generation ||
      this.token !== plan.ownerToken ||
      this.authenticatedUser !== plan.ownerUser ||
      this.memoryLease !== plan.ownerMemoryLease ||
      !pendingExternalLogoutMarkersMatch(
        this.inspectPendingLogoutMarker(plan.envKey),
        plan.expectedMarker
      )
    )
      throw new SessionTokenStorageSupersededBeforeWriteError()
  }

  /** Runtime-only fence used after acceptance has staged its marker projection. */
  isFreshSessionAcceptanceRuntimeOwnerCurrent(
    plan: FreshSessionAcceptancePlan,
    logoutInProgress: boolean
  ): boolean {
    return (
      this.isFreshSessionAcceptanceRuntimeOwnerUnchanged(plan, logoutInProgress) &&
      (plan.source !== 'memory-only' || plan.memoryOnlyClockEpoch === this.memoryOnlyClockEpoch) &&
      (!plan.ownerMemoryLease || !this.isMemoryOnlySessionLeaseExpired(plan.ownerMemoryLease))
    )
  }

  /**
   * Identity fence for rollback cleanup. Expiry makes an owner ineligible for restoration, but
   * the exact still-current expired owner must remain distinguishable from a newer producer so
   * AppService can synchronously revoke its stale runtime and consumer bindings.
   */
  isFreshSessionAcceptanceRuntimeOwnerUnchanged(
    plan: FreshSessionAcceptancePlan,
    logoutInProgress: boolean
  ): boolean {
    return (
      !logoutInProgress &&
      getActiveEnvKey() === plan.envKey &&
      this.generation === plan.generation &&
      this.token === plan.ownerToken &&
      this.authenticatedUser === plan.ownerUser &&
      this.memoryLease === plan.ownerMemoryLease
    )
  }

  /**
   * Select the one durable source already accepted for cold restore. This method only plans and
   * pins authority; SessionAuthorityAcceptanceTransaction performs exact-source reads and owns
   * identity/consumer publication. The lease is transferred only for an accepted plan.
   */
  async beginAcceptedSessionRestore(
    envKey: string,
    policy: SavedSessionRestorePolicy = 'normal'
  ): Promise<SessionAuthorityRestoreSelection> {
    const tokenStore = this.tokenStore
    const lease = tokenStore.beginSessionAuthorityTransaction()
    let transferred = false
    try {
      const selection = await tokenStore.runWithSessionAuthorityTransaction(lease, async () => {
        const storageScope = await tokenStore.createSessionAuthorityStorageScope()
        const profileRepository = new SessionAuthorityRecordRepository(
          storageScope,
          PROFILE_SESSION_AUTHORITY_ENV_KEY,
          tokenStore,
          lease
        )
        const profileObservation = profileRepository.observeProfileSelection()
        if (profileObservation.status !== 'observed')
          throw profileObservation.status === 'transient'
            ? profileObservation.error
            : profileObservation.status === 'invalid'
              ? profileObservation.error
              : new Error('Profile session authority recovery is required')
        const profileSelection = profileObservation.selection
        if (!profileSelection || profileSelection.state !== 'active')
          return { status: 'denied' as const, frameMode: 'logged-out' as const }
        if (profileSelection.mode === 'memory-only')
          return { status: 'denied' as const, frameMode: 'memory-only' as const }
        if (profileSelection.envKey !== envKey)
          return { status: 'denied' as const, frameMode: 'logged-out' as const }

        const repository = new SessionAuthorityRecordRepository(
          storageScope,
          envKey,
          tokenStore,
          lease
        )
        const observation = repository.observe()
        if (observation.status === 'absent') return { status: 'absent' as const }
        if (observation.status !== 'observed')
          throw observation.status === 'transient'
            ? observation.error
            : observation.status === 'invalid'
              ? observation.error
              : new Error('Session authority record recovery is required')

        let record = observation.record
        let snapshot = observation.snapshot
        if (record.projectionIntent !== null) {
          const recovered = repository.acceptProfileSelectedCandidate(
            snapshot,
            profileRepository,
            profileObservation.snapshot,
            profileSelection
          )
          if (recovered.status !== 'committed') throw new SessionAuthorityRecordConflictError()
          const refreshed = repository.observe()
          if (refreshed.status !== 'observed')
            throw refreshed.status === 'transient'
              ? refreshed.error
              : refreshed.status === 'invalid'
                ? refreshed.error
                : new SessionAuthorityRecordConflictError()
          record = refreshed.record
          snapshot = refreshed.snapshot
        }
        // A durable projection intent is an unresolved transaction, not an accepted source.
        // Normal startup reconciles it before restore selection, but coordinator callers must
        // independently fail closed rather than relying on that ordering as an authorization.
        if (record.projectionIntent !== null)
          throw new Error('Session authority projection recovery is required')
        if (record.frame.mode !== 'persistent')
          return { status: 'denied' as const, frameMode: record.frame.mode }
        if (record.marker?.intent === 'logout-pending')
          return { status: 'denied' as const, frameMode: 'logged-out' as const }
        const markerObservation = observePendingExternalLogoutRaw(
          this.options.getUserDataDirectory(),
          envKey
        )
        if (
          markerObservation.marker?.intent.intent === 'keytar-cleanup-pending' &&
          markerObservation.marker.revision === null
        )
          throw new SessionAuthorityRecordConflictError()
        const journalDirectory = await tokenStore.getSessionAuthorityStorageRoot()
        const journalObservation = observeSessionPersistenceLegacySnapshot(journalDirectory, envKey)
        if (journalObservation.status !== 'observed') throw journalObservation.error
        const recordedJournalReceipt =
          record.projectionReceipt?.legacyJournalReceipt ?? record.legacyJournalReceipt
        if (
          !recordedJournalReceipt ||
          JSON.stringify(recordedJournalReceipt) !== JSON.stringify(journalObservation.receipt)
        )
          throw new SessionAuthorityRecordConflictError()
        if (record.projectionReceipt) {
          if (
            markerObservation.rawContents !== JSON.stringify(record.projectionReceipt.marker) ||
            record.projectionReceipt.operationId !== record.frame.transactionId ||
            JSON.stringify(record.projectionReceipt.legacyJournalReceipt) !==
              JSON.stringify(recordedJournalReceipt)
          )
            throw new SessionAuthorityRecordConflictError()
        } else if (
          record.frame.source?.format !== 'v0' ||
          markerObservation.marker?.intent.intent === 'acceptance-pending' ||
          markerObservation.marker?.intent.intent === 'logout-pending'
        ) {
          // New V1/M acceptance always has a receipt-bound deny-only marker. The only
          // receipt-less accepted source is an unchanged V0 source pinned by bootstrap. A
          // concurrently published external LP is an independent denial even if the accepted
          // frame has not yet been reconciled to logged-out; never treat its unchanged raw bytes
          // as permission to restore the older V0 credential.
          throw new SessionAuthorityRecordConflictError()
        }
        const source = record.frame.source
        const transactionId = record.frame.transactionId
        if (!source || !transactionId || source.envKey !== envKey)
          throw new SessionAuthorityRecordConflictError()
        // V0 sources belong to the historical Desktop credential namespace. Even when an older
        // authority record still names one, the current client requires a fresh authentication
        // and never reads that selector as a restore fallback.
        if (source.format !== 'v1')
          return { status: 'denied' as const, frameMode: 'logged-out' as const }
        if (
          transactionId !== profileSelection.transactionId ||
          source.accountId !== profileSelection.userId ||
          JSON.stringify(source) !== JSON.stringify(profileSelection.source) ||
          record.projectionReceipt?.baseAuthorityRevision !== profileSelection.authorityRevision
        )
          throw new SessionAuthorityRecordConflictError()
        if (!record.projectionReceipt) {
          const markerIntent = markerObservation.marker?.intent
          const sourceMarker = source.kind === 'keytar' ? 'active-keytar' : 'safe-storage'
          const markerSelectsExactSource =
            markerObservation.rawContents === null ||
            (markerIntent?.intent === 'keytar-cleanup-pending' &&
              markerIntent.credentialSource === sourceMarker)
          if (!markerSelectsExactSource) throw new SessionAuthorityRecordConflictError()
        }
        if (source.kind !== 'keytar' && source.kind !== 'safe-storage')
          throw new SessionAuthorityRecordConflictError()
        const acceptedSourceKind: 'keytar' | 'safe-storage' = source.kind
        if (
          (policy === 'safe-storage-only' && source.kind !== 'safe-storage') ||
          (policy === 'keytar-active-only' && source.kind !== 'keytar') ||
          policy === 'deny-all'
        )
          return { status: 'denied' as const, frameMode: 'logged-out' as const }
        const assertCurrent = () => {
          const current = repository.observe()
          const currentProfile = profileRepository.observeProfileSelection()
          const currentMarker = observePendingExternalLogoutRaw(
            this.options.getUserDataDirectory(),
            envKey
          )
          const currentJournal = observeSessionPersistenceLegacySnapshot(journalDirectory, envKey)
          if (
            current.status !== 'observed' ||
            current.record.revision !== record.revision ||
            current.record.frame.revision !== record.frame.revision ||
            current.record.frame.transactionId !== transactionId ||
            !current.record.frame.source ||
            !sameAcceptedCredentialSource(current.record.frame.source, source) ||
            currentProfile.status !== 'observed' ||
            currentProfile.record.revision !== profileObservation.record.revision ||
            JSON.stringify(currentProfile.selection) !== JSON.stringify(profileSelection) ||
            currentMarker.rawContents !== markerObservation.rawContents ||
            currentMarker.rawDigest !== markerObservation.rawDigest ||
            currentJournal.status !== 'observed' ||
            JSON.stringify(currentJournal.receipt) !== JSON.stringify(recordedJournalReceipt) ||
            !repository.isAcceptedSourceCurrent(snapshot, source, transactionId)
          )
            throw new SessionAuthorityRecordConflictError()
        }
        const assertRestoreAllowed = (_token: string) => {}
        const readExactSource = async (): Promise<string | null> => {
          assertCurrent()
          const authorization = profileRepository.authorizeProfileSelectedSourceRead(
            profileObservation.snapshot
          )
          const token = await tokenStore.readSessionTokenCandidate(
            source,
            transactionId,
            authorization,
            storageScope
          )
          assertCurrent()
          return token
        }
        const plan: SessionAuthorityRestoreExistingPlan = {
          tokenStore,
          lease,
          envKey,
          transactionId,
          source,
          accepted: { record, snapshot, storageScope, repository },
          storageScope,
          repository,
          snapshot,
          profileRepository,
          profileSnapshot: profileObservation.snapshot,
          profileSelection,
          expectedIdentity: {
            userId: profileSelection.userId!,
            teamId: profileSelection.teamId,
          },
          readExactSource,
          assertSourceCurrent: assertCurrent,
          verifyExactSource: async expectedToken => {
            const observed = await readExactSource()
            return observed === expectedToken
          },
          assertRestoreAllowed,
        }
        return { status: 'accepted' as const, plan }
      })
      if (selection.status === 'accepted') transferred = true
      return selection
    } finally {
      if (!transferred) tokenStore.finishSessionAuthorityTransaction(lease)
    }
  }

  /** Return the one durable persistent environment selected for Desktop restart. */
  async getProfileSelectedEnvironmentKey(): Promise<string | null> {
    const tokenStore = this.tokenStore
    const lease = tokenStore.beginSessionAuthorityTransaction()
    try {
      return await tokenStore.runWithSessionAuthorityTransaction(lease, async () => {
        const storageScope = await tokenStore.createSessionAuthorityStorageScope()
        const repository = new SessionAuthorityRecordRepository(
          storageScope,
          PROFILE_SESSION_AUTHORITY_ENV_KEY,
          tokenStore,
          lease
        )
        const observation = repository.observeProfileSelection()
        if (observation.status !== 'observed')
          throw observation.status === 'transient'
            ? observation.error
            : observation.status === 'invalid'
              ? observation.error
              : new Error('Profile session authority recovery is required')
        return observation.selection?.state === 'active' &&
          observation.selection.mode === 'persistent'
          ? observation.selection.envKey
          : null
      })
    } finally {
      tokenStore.finishSessionAuthorityTransaction(lease)
    }
  }

  /**
   * Observe whether an accepted source is selected without reading its bearer. Startup's marker
   * preflight needs only the authority status; the restore-existing transaction later owns the
   * exact source read, identity validation and consumer publication. Release the selection lease
   * here so the preflight cannot leave a restore plan active or start a second restore transaction.
   */
  async inspectAcceptedSessionRestore(
    envKey: string,
    policy: SavedSessionRestorePolicy = 'normal'
  ): Promise<
    | { status: 'absent' }
    | { status: 'denied'; frameMode: 'uninitialized' | 'memory-only' | 'logged-out' }
    | { status: 'accepted' }
  > {
    const selection = await this.beginAcceptedSessionRestore(envKey, policy)
    if (selection.status !== 'accepted') return selection
    this.tokenStore.finishSessionAuthorityTransaction(selection.plan.lease)
    return { status: 'accepted' }
  }

  /**
   * Select and pin one exact active secure V0 source when no authority frame exists yet. This is
   * the legacy bootstrap adapter for restore-existing, not a candidate acceptance path: it never
   * writes or migrates credentials, and after the single source-pin CAS the unified restore
   * transaction owns identity validation and consumer publication.
   */
  async beginLegacySessionRestore(input: {
    envKey: string
    restorePlan: SavedSessionRestorePlan
    legacyEnvKeys: readonly string[]
    legacyNamespaceComplete: boolean
    legacyAliasEnvKey: string
    isRestoreAdmitted: () => boolean
  }): Promise<SessionAuthorityRestoreSelection> {
    const tokenStore = this.tokenStore
    const sourceKinds: readonly ('keytar' | 'safe-storage')[] =
      input.restorePlan.policy === 'safe-storage-only'
        ? ['safe-storage']
        : input.restorePlan.policy === 'keytar-active-only'
          ? ['keytar']
          : input.restorePlan.policy === 'normal'
            ? SESSION_CREDENTIAL_SOURCE_ORDER
            : []
    if (sourceKinds.length === 0) return { status: 'denied', frameMode: 'logged-out' }

    // When the active key is itself the pre-RPC REST-only key, a shared REST origin may make
    // that credential belong to a different RPC environment. Never read or pin that V0 slot
    // unless the complete configured namespace inventory proves it unique.
    if (!input.legacyNamespaceComplete && input.envKey === input.legacyAliasEnvKey)
      return { status: 'denied', frameMode: 'uninitialized' }
    if (
      input.restorePlan.pendingCleanupMarker?.intent.intent === 'keytar-cleanup-pending' &&
      input.restorePlan.pendingCleanupMarker.revision == null
    )
      return { status: 'denied', frameMode: 'uninitialized' }

    const legacyEnvKeys = input.legacyNamespaceComplete
      ? input.legacyEnvKeys
      : input.legacyEnvKeys.filter(key => key !== input.legacyAliasEnvKey)

    const owner = {
      generation: this.sessionGeneration,
      token: this.sessionToken,
      user: this.me,
    }
    const runtimeOwned = () =>
      this.sessionGeneration === owner.generation &&
      this.sessionToken === owner.token &&
      this.me === owner.user &&
      input.isRestoreAdmitted()
    const assertRestoreOwned = () => {
      if (!runtimeOwned()) throw new SessionTokenStorageSupersededBeforeWriteError()
      const currentMarker = this.inspectPendingLogoutMarker(input.envKey)
      const expectedMarker = input.restorePlan.pendingCleanupMarker
      if (
        expectedMarker === null
          ? currentMarker !== null
          : !pendingExternalLogoutMarkersMatch(currentMarker, expectedMarker)
      )
        throw new SessionTokenStorageSupersededBeforeWriteError()
    }

    const lease = tokenStore.beginSessionAuthorityTransaction()
    let transferred = false
    try {
      const plan = await tokenStore.runWithSessionAuthorityTransaction(lease, async () => {
        assertRestoreOwned()
        let selected: VerifiedSessionTokenSource | undefined
        let selectedSourceKind: 'keytar' | 'safe-storage' | undefined
        for (const sourceKind of sourceKinds) {
          const observation = await tokenStore.observeSessionTokenSource(sourceKind, input.envKey, {
            allowLegacyMigration: false,
            legacyEnvKeys,
          })
          assertRestoreOwned()
          const decision = this.planSessionTokenSourceObservation(observation)
          if (decision.kind === 'reject') throw decision.error
          if (decision.kind === 'select' && observation.status === 'present') {
            const token = tokenStore.acceptSessionTokenSourceObservation(observation)
            selected = {
              token,
              source: sourceKind,
              authority: observation.authority as SessionTokenReadAuthority,
            }
            selectedSourceKind = sourceKind
            break
          }
        }
        if (!selected || !selectedSourceKind) return { status: 'absent' as const }

        const journalDirectory = await tokenStore.getSessionAuthorityStorageRoot()
        assertRestoreOwned()
        const assertRestoreAllowed = (token: string) => {
          assertRestoreOwned()
          if (
            isSessionPersistenceCandidateDenied(
              readSessionPersistenceJournal(journalDirectory, input.envKey),
              token
            )
          )
            throw new SessionPersistenceCandidateDeniedError()
        }
        assertRestoreAllowed(selected.token)

        const selectedProof = await tokenStore.observeSelectedLegacySessionCredentialSource(
          selectedSourceKind,
          input.envKey,
          selected.authority,
          legacyEnvKeys
        )
        assertRestoreOwned()
        if (!selectedProof) throw new SessionAuthorityRecordConflictError()

        const storageScope = await tokenStore.createSessionAuthorityStorageScope()
        assertRestoreOwned()
        const repository = new SessionAuthorityRecordRepository(
          storageScope,
          input.envKey,
          tokenStore,
          lease
        )
        const observation = repository.observe()
        if (
          observation.status !== 'absent' &&
          (observation.status !== 'observed' ||
            observation.record.frame.mode !== 'uninitialized' ||
            observation.record.marker !== null ||
            observation.record.candidates.length !== 0 ||
            observation.record.cleanupDebts.length !== 0)
        )
          throw observation.status === 'transient'
            ? observation.error
            : observation.status === 'invalid'
              ? observation.error
              : new SessionAuthorityRecordConflictError()

        // The selected-source proof already contains the fresh opaque observation for this exact
        // V0 resource. Do not rescan and risk substituting a more convenient credential source.
        const exactSource = selectedProof.source
        if (
          exactSource.envKey !== input.envKey ||
          exactSource.kind !== selectedSourceKind ||
          !tokenStore.isLegacySessionCredentialSourceBoundToScope(exactSource, storageScope)
        )
          throw new SessionAuthorityRecordConflictError()

        const assertObservedUninitialized = () => {
          assertRestoreOwned()
          if (
            !isSessionTokenReadAuthorityCurrent(selected!.authority, selected!.source, input.envKey)
          )
            throw new SessionTokenStorageSupersededBeforeWriteError()
          const current = repository.observe()
          if (observation.status === 'absent') {
            if (current.status !== 'absent') throw new SessionAuthorityRecordConflictError()
          } else if (
            current.status !== 'observed' ||
            current.record.revision !== observation.record.revision ||
            current.record.frame.mode !== 'uninitialized' ||
            current.record.marker !== null
          ) {
            throw current.status === 'transient'
              ? current.error
              : current.status === 'invalid'
                ? current.error
                : new SessionAuthorityRecordConflictError()
          }
        }
        assertObservedUninitialized()
        const pinned =
          observation.status === 'absent'
            ? repository.acceptLegacyBootstrapSource(
                observation.snapshot,
                exactSource,
                selectedProof
              )
            : repository.pinVerifiedActiveLegacySource(
                observation.snapshot,
                exactSource,
                selectedProof
              )
        if (pinned.status !== 'committed') throw new SessionAuthorityRecordConflictError()
        const acceptedSnapshot = pinned.snapshot
        const acceptedRecord = pinned.record
        const transactionId = acceptedRecord.frame.transactionId
        if (
          acceptedRecord.frame.mode !== 'persistent' ||
          !transactionId ||
          !acceptedRecord.frame.source ||
          !sameAcceptedCredentialSource(acceptedRecord.frame.source, exactSource)
        )
          throw new SessionAuthorityRecordConflictError()
        const pinnedLegacyJournalReceipt = acceptedRecord.legacyJournalReceipt
        if (!pinnedLegacyJournalReceipt)
          throw new SessionAuthorityProjectionIntegrityError('journal')
        const assertLegacyJournalReceiptCurrent = () => {
          const journal = observeSessionPersistenceLegacySnapshot(journalDirectory, input.envKey)
          if (
            journal.status !== 'observed' ||
            !sessionPersistenceLegacySnapshotMatches(pinnedLegacyJournalReceipt, journal.receipt)
          )
            throw new SessionAuthorityProjectionIntegrityError(
              'journal',
              journal.status === 'observed' ? undefined : journal.error
            )
        }
        const assertCurrent = () => {
          assertRestoreOwned()
          if (
            !isSessionTokenReadAuthorityCurrent(selected!.authority, selected!.source, input.envKey)
          )
            throw new SessionTokenStorageSupersededBeforeWriteError()
          assertLegacyJournalReceiptCurrent()
          const current = repository.observe()
          if (
            current.status !== 'observed' ||
            current.record.revision !== acceptedRecord.revision ||
            current.record.frame.revision !== acceptedRecord.frame.revision ||
            current.record.frame.transactionId !== transactionId ||
            !current.record.frame.source ||
            !sameAcceptedCredentialSource(current.record.frame.source, exactSource) ||
            !repository.isAcceptedSourceCurrent(acceptedSnapshot, exactSource, transactionId)
          )
            throw current.status === 'transient'
              ? current.error
              : current.status === 'invalid'
                ? current.error
                : new SessionAuthorityRecordConflictError()
        }
        assertCurrent()
        const readExactSource = async () => {
          assertCurrent()
          const read = await tokenStore.readObservedLegacySessionCredentialSource(
            exactSource,
            storageScope
          )
          if (read.status === 'unavailable')
            throw new SessionTokenProviderStateUnknownError(selectedSourceKind!)
          if (read.status !== 'present') throw new SessionAuthorityRecordConflictError()
          assertCurrent()
          return read.token
        }
        const pinnedAuthority = {
          record: acceptedRecord,
          snapshot: acceptedSnapshot,
          storageScope,
          repository,
        }
        const acceptedPlan: SessionAuthorityRestoreExistingPlan = {
          tokenStore,
          lease,
          envKey: input.envKey,
          transactionId,
          source: exactSource,
          accepted: pinnedAuthority,
          storageScope,
          repository,
          snapshot: acceptedSnapshot,
          readExactSource,
          assertSourceCurrent: assertCurrent,
          assertRestoreAllowed,
          verifyExactSource: async expectedToken =>
            (await readExactSource()) === expectedToken && expectedToken === selected!.token,
          runtimeSource: selected,
        }
        return { status: 'accepted' as const, plan: acceptedPlan }
      })
      if (plan.status === 'accepted') transferred = true
      return plan
    } finally {
      if (!transferred) tokenStore.finishSessionAuthorityTransaction(lease)
    }
  }

  private canRetainVerifiedPriorSource(selected: VerifiedSessionTokenSource): boolean {
    return (
      selected.source === 'keytar' ||
      selected.source === 'safe-storage' ||
      (selected.source === 'historical-plaintext' && this.isIsolatedDevelopmentStorage())
    )
  }

  advanceSessionGeneration(expectedGeneration = this.generation): number {
    if (this.generation !== expectedGeneration)
      throw new SessionTokenStorageSupersededBeforeWriteError()
    this.generation += 1
    return this.generation
  }

  /** Reserve a no-throw generation publication for the synchronous acceptance commit. */
  reserveSessionGenerationAdvance(expectedGeneration = this.generation): (() => number) | null {
    if (this.generation !== expectedGeneration) return null
    return () => {
      this.generation += 1
      return this.generation
    }
  }

  /**
   * Prepare the single runtime owner snapshot used by an accepted-session publication.
   * The acceptance transaction checks `isCurrent` immediately before its synchronous durable
   * CAS, then calls `publish` in the same turn. Publication only replaces this owner pointer;
   * it does not validate, allocate, invoke callbacks, or perform I/O.
   */
  prepareRuntimeOwnerPublication(input: {
    expectedGeneration: number
    generation: number
    token: string
    user: SessionMe
    acceptedSource: AcceptedSessionTokenSource | undefined
    acceptedAuthoritySource: SessionAuthorityCredentialSource | undefined
    acceptedProjectionMarker: PendingExternalLogoutMarker | undefined
    memoryLease: MemoryOnlySessionLease | undefined
  }): SessionAuthorityRuntimeOwnerPublication | null {
    const before = this.runtimeOwner
    if (
      before.generation !== input.expectedGeneration ||
      input.generation < input.expectedGeneration ||
      input.generation > input.expectedGeneration + 1 ||
      !input.token ||
      !input.user.id
    )
      return null
    const next: SessionAuthorityRuntimeOwner = Object.freeze({
      token: input.token,
      user: input.user,
      generation: input.generation,
      acceptedSource: input.acceptedSource,
      acceptedAuthoritySource: input.acceptedAuthoritySource,
      memoryLease: input.memoryLease,
      acceptedProjectionMarker: input.acceptedProjectionMarker,
      retiredMemoryCredentialGuard:
        before.retiredMemoryCredentialGuard ||
        Boolean(
          before.memoryLease &&
          before.memoryLease.volatileSessionId !== input.memoryLease?.volatileSessionId
        ),
    })
    let published = false
    return Object.freeze({
      isCurrent: () => !published && this.runtimeOwner === before,
      publish: () => {
        // No asynchronous work or user callback can run between the final ownership check,
        // authority CAS, and this pointer swap.
        if (published) return undefined
        published = true
        this.runtimeOwner = next
        return undefined
      },
    })
  }

  get sessionToken(): string | null {
    return this.token
  }

  set sessionToken(value: string | null) {
    this.token = value
    if (value === null) {
      this.acceptedProjectionMarker = undefined
      this.acceptedAuthoritySource = undefined
    }
  }

  get sessionGeneration(): number {
    return this.generation
  }

  get me(): SessionMe | null {
    return this.authenticatedUser
  }

  set me(value: SessionMe | null) {
    this.authenticatedUser = value
  }

  get acceptedSessionSource(): AcceptedSessionTokenSource | undefined {
    return this.acceptedSource
  }

  set acceptedSessionSource(value: AcceptedSessionTokenSource | undefined) {
    this.acceptedSource = value
  }

  get acceptedSessionAuthoritySource(): SessionAuthorityCredentialSource | undefined {
    return this.acceptedAuthoritySource
  }

  get acceptedSessionProjectionMarker(): PendingExternalLogoutMarker | undefined {
    return this.acceptedProjectionMarker
  }

  set acceptedSessionAuthoritySource(value: SessionAuthorityCredentialSource | undefined) {
    this.acceptedAuthoritySource = value
  }

  /** Record the exact deny-only sidecar projected by the accepted V2 authority receipt. */
  setAcceptedProjectionMarker(marker: PendingExternalLogoutMarker | undefined): void {
    this.acceptedProjectionMarker = marker
  }

  get memoryOnlySession(): MemoryOnlySessionLease | undefined {
    return this.memoryLease
  }

  set memoryOnlySession(value: MemoryOnlySessionLease | undefined) {
    const current = this.memoryLease
    if (current && current.volatileSessionId !== value?.volatileSessionId)
      this.retiredMemoryCredentialGuard = true
    this.memoryLease = value
  }

  memoryOnlySessionDeadlines(
    token: string,
    wallNow = Date.now(),
    monotonicNow = this.nowMonotonic()
  ): MemoryOnlySessionDeadlines {
    return memoryOnlySessionDeadlines(token, wallNow, monotonicNow)
  }

  memoryOnlySessionReplacementDeadlines(
    current: MemoryOnlySessionDeadlines,
    token: string,
    wallNow = Date.now(),
    monotonicNow = this.nowMonotonic()
  ): MemoryOnlySessionDeadlines {
    return memoryOnlySessionReplacementDeadlines(current, token, wallNow, monotonicNow)
  }

  isMemoryOnlySessionExpired(
    deadline: number,
    now = Date.now(),
    monotonicDeadline?: number
  ): boolean {
    return isMemoryOnlySessionExpired(deadline, now, monotonicDeadline, this.nowMonotonic())
  }

  isMemoryOnlySessionLeaseExpired(lease: MemoryOnlySessionLease): boolean {
    return this.isMemoryOnlySessionExpired(lease.expiresAt, Date.now(), lease.expiresAtMonotonicMs)
  }

  captureMonotonicNow(): number {
    return this.nowMonotonic()
  }

  captureMemoryOnlyClockEpoch(): number {
    return this.memoryOnlyClockEpoch
  }

  recordSystemSuspend(): void {
    this.memoryOnlyClockEpoch += 1
  }

  memoryOnlySessionRemainingMs(lease: MemoryOnlySessionLease): number {
    return Math.min(lease.expiresAt - Date.now(), lease.expiresAtMonotonicMs - this.nowMonotonic())
  }

  isIsolatedDevelopmentStorage(): boolean {
    return this.tokenStore.isIsolatedDevelopmentStorage()
  }

  captureSessionRequestContext(sessionToken: string): SessionRequestContext {
    return Object.freeze({
      kind: 'accepted-session',
      owner: this.captureRpcCredentialOwner(sessionToken),
    })
  }

  isSessionRequestContextInCurrentLineage(requestContext: unknown, sessionToken: string): boolean {
    if (!requestContext || typeof requestContext !== 'object') return false
    const context = requestContext as SessionRequestContext
    if (context.kind !== 'accepted-session' || !context.owner) return false
    try {
      return this.rpcSessionOwnerLineageMatches(
        context.owner,
        this.captureRpcCredentialOwner(sessionToken)
      )
    } catch {
      return false
    }
  }

  sessionRequestContextsMatchOwner(left: unknown, right: unknown): boolean {
    if (!left || typeof left !== 'object' || !right || typeof right !== 'object') return false
    const leftContext = left as SessionRequestContext
    const rightContext = right as SessionRequestContext
    return (
      leftContext.kind === 'accepted-session' &&
      rightContext.kind === 'accepted-session' &&
      Boolean(leftContext.owner && rightContext.owner) &&
      this.rpcSessionOwnersMatch(leftContext.owner, rightContext.owner)
    )
  }

  createCandidateSessionRequestContext(input: {
    token: string
    envKey: string
    generation: number
    isOwnerCurrent: () => boolean
  }): SessionRequestContext {
    const { token, envKey, generation, isOwnerCurrent } = input
    const assertOwnerCurrent = () => {
      let producerIsCurrent = false
      try {
        producerIsCurrent = isOwnerCurrent()
      } catch {
        producerIsCurrent = false
      }
      if (
        !producerIsCurrent ||
        this.sessionGeneration !== generation ||
        getActiveEnvKey() !== envKey
      ) {
        throw new SessionRequestOwnershipError()
      }
    }
    assertOwnerCurrent()
    return Object.freeze({
      kind: 'candidate-session',
      credentialDigest: credentialDigest(token),
      assertOwnerCurrent,
    })
  }

  assertMemoryOnlySessionCurrent(expected = this.memoryLease): void {
    if (!expected || expected !== this.memoryLease) throw new TemporarySessionEndedError()
    if (this.isMemoryOnlySessionLeaseExpired(expected)) throw new TemporarySessionExpiredError()
    if (getActiveEnvKey() !== expected.envKey) throw new TemporarySessionEnvironmentChangedError()
    const ownership = this.inspectOwnership(
      expected.envKey,
      [expected.marker],
      this.sessionToken !== null && this.me !== null
    )
    if (ownership.status === 'transient') throw ownership.error
    if (ownership.status !== 'owned') throw new TemporarySessionAuthorityUnavailableError()
  }

  private assertMemoryOnlyCandidateMarkerCurrent(expected = this.memoryLease): void {
    if (!expected || expected !== this.memoryLease) throw new TemporarySessionEndedError()
    if (this.isMemoryOnlySessionLeaseExpired(expected)) throw new TemporarySessionExpiredError()
    if (getActiveEnvKey() !== expected.envKey) throw new TemporarySessionEnvironmentChangedError()
    const observation = this.observeMarker(expected.envKey)
    if (observation.status !== 'observed') throw observation.error
    if (!pendingExternalLogoutMarkersMatch(observation.marker, expected.marker))
      throw new TemporarySessionAuthorityUnavailableError()
  }

  assertTemporaryRequestAllowed(
    token: string,
    requestContext?: unknown
  ): SessionRequestOwner | undefined {
    const digest = credentialDigest(token)
    this.pruneExpiredRpcCredentialOwners(this.nowMonotonic())
    if (requestContext !== undefined) {
      if (!requestContext || typeof requestContext !== 'object')
        throw new SessionRequestOwnershipError()
      const context = requestContext as SessionRequestContext
      if (context.kind === 'candidate-session') {
        if (context.credentialDigest !== digest) throw new SessionRequestOwnershipError()
        context.assertOwnerCurrent()
        return undefined
      }
      if (context.kind !== 'accepted-session' || !context.owner)
        throw new SessionRequestOwnershipError()
      return this.assertRequestOwnedByContext(token, digest, context.owner)
    }

    const pendingCandidate = this.pendingTemporaryCandidateValidations.get(digest)
    if (pendingCandidate) {
      this.assertRpcCredentialOwnerCurrent(pendingCandidate.owner)
      return undefined
    }

    if (token === this.sessionToken) {
      if (!this.me) throw new SessionRequestOwnershipError()
      const owner = this.captureRpcCredentialOwner(token)
      return owner.memoryLease
        ? { owner, credentialDigest: digest, credentialKind: 'session' }
        : undefined
    }
    const owner = this.rpcCredentialOwners.get(digest)?.owner
    if (!owner) throw new SessionRequestOwnershipError()
    this.assertRpcCredentialOwnerCurrent(owner)
    return owner.memoryLease
      ? { owner, credentialDigest: digest, credentialKind: 'rpc' }
      : undefined
  }

  private assertRequestOwnedByContext(
    token: string,
    digest: string,
    expectedOwner: RpcSessionOwner
  ): SessionRequestOwner | undefined {
    this.assertRpcCredentialOwnerCurrent(expectedOwner)
    const pendingCandidate = this.pendingTemporaryCandidateValidations.get(digest)
    if (pendingCandidate) {
      if (!this.rpcSessionOwnersMatch(expectedOwner, pendingCandidate.owner))
        throw new SessionRequestOwnershipError()
      this.assertRpcCredentialOwnerCurrent(pendingCandidate.owner)
      return undefined
    }
    if (token === this.sessionToken && this.me) {
      if (expectedOwner.sessionDigest !== digest) throw new SessionRequestOwnershipError()
      return expectedOwner.memoryLease
        ? { owner: expectedOwner, credentialDigest: digest, credentialKind: 'session' }
        : undefined
    }
    const currentOwner = this.rpcCredentialOwners.get(digest)?.owner
    if (!currentOwner || !this.rpcSessionOwnersMatch(expectedOwner, currentOwner))
      throw new SessionRequestOwnershipError()
    this.assertRpcCredentialOwnerCurrent(currentOwner)
    return currentOwner.memoryLease
      ? { owner: currentOwner, credentialDigest: digest, credentialKind: 'rpc' }
      : undefined
  }

  private rpcSessionOwnersMatch(left: RpcSessionOwner, right: RpcSessionOwner): boolean {
    return (
      left.sessionDigest === right.sessionDigest &&
      left.envKey === right.envKey &&
      left.generation === right.generation &&
      left.userId === right.userId &&
      left.teamId === right.teamId &&
      left.memoryLease?.volatileSessionId === right.memoryLease?.volatileSessionId
    )
  }

  private rpcSessionOwnerLineageMatches(left: RpcSessionOwner, right: RpcSessionOwner): boolean {
    return (
      left.envKey === right.envKey &&
      left.generation === right.generation &&
      left.userId === right.userId &&
      left.memoryLease?.volatileSessionId === right.memoryLease?.volatileSessionId
    )
  }

  async withTemporarySessionCandidateValidation<T>(
    acceptedSessionToken: string,
    candidateToken: string,
    validateIdentity: () => Promise<T>
  ): Promise<T> {
    if (!candidateToken || candidateToken === acceptedSessionToken || !this.memoryLease)
      throw new SessionRequestOwnershipError()
    const owner = this.captureRpcCredentialOwner(acceptedSessionToken)
    const digest = credentialDigest(candidateToken)
    if (this.pendingTemporaryCandidateValidations.has(digest))
      throw new SessionRequestOwnershipError()
    const reservation: PendingTemporaryCandidateValidation = { owner }
    this.pendingTemporaryCandidateValidations.set(digest, reservation)
    try {
      this.assertRpcCredentialOwnerCurrent(owner)
      const result = await validateIdentity()
      this.assertRpcCredentialOwnerCurrent(owner)
      return result
    } finally {
      if (this.pendingTemporaryCandidateValidations.get(digest) === reservation)
        this.pendingTemporaryCandidateValidations.delete(digest)
    }
  }

  /** Issue an RPC credential only while its exact session owner remains current. */
  async issueRpcCredential<T extends { token: string; expiresInSeconds: number }>(
    sessionToken: string,
    issue: (bindingKey: string) => Promise<T>,
    readCached?: (bindingKey: string) => T | null
  ): Promise<T> {
    const owner = this.captureRpcCredentialOwner(sessionToken)
    const bindingKey = this.rpcCredentialBindingKey(owner)
    this.pruneExpiredRpcCredentialOwners(this.nowMonotonic())
    this.pruneRpcCredentialOwnersForBinding(owner)

    const currentReservations = [...this.pendingRpcCredentialOwnerReservations].filter(
      reservation =>
        this.rpcCredentialOwnerGroupKey(reservation.owner) ===
        this.rpcCredentialOwnerGroupKey(owner)
    ).length
    if (this.rpcCredentialOwners.size + currentReservations >= MAX_TRACKED_RPC_CREDENTIAL_OWNERS) {
      const cached = readCached?.(bindingKey)
      const cachedOwner = cached && this.rpcCredentialOwners.get(credentialDigest(cached.token))
      if (
        !cached ||
        !cachedOwner ||
        this.rpcCredentialOwnerGroupKey(cachedOwner.owner) !==
          this.rpcCredentialOwnerGroupKey(owner)
      ) {
        if (owner.memoryLease) throw new SessionRpcCredentialOwnershipCapacityError()
        const oldestPersistentOwner = [...this.rpcCredentialOwners].find(
          ([, record]) =>
            !record.owner.memoryLease &&
            this.rpcCredentialOwnerGroupKey(record.owner) === this.rpcCredentialOwnerGroupKey(owner)
        )
        if (!oldestPersistentOwner) throw new SessionRpcCredentialOwnershipCapacityError()
        // Persistent sessions use the current request context as their revocation witness.
        // Keep auxiliary token provenance bounded with FIFO eviction; volatile receipts also
        // drive 401 teardown, so their stricter capacity check remains fail-closed.
        this.rpcCredentialOwners.delete(oldestPersistentOwner[0])
      } else {
        this.assertRpcCredentialOwnerCurrent(cachedOwner.owner)
        return cached
      }
    }
    const reservation = { owner }
    this.pendingRpcCredentialOwnerReservations.add(reservation)
    try {
      const result = await issue(bindingKey)
      this.assertRpcCredentialOwnerCurrent(owner)
      if (!Number.isSafeInteger(result.expiresInSeconds) || result.expiresInSeconds <= 0) {
        throw new SessionRequestOwnershipError()
      }
      const issuedAt = this.nowMonotonic()
      const expiresAtMonotonicMs = issuedAt + result.expiresInSeconds * 1000
      if (!Number.isFinite(expiresAtMonotonicMs)) throw new SessionRequestOwnershipError()
      this.pruneRpcCredentialOwnersForBinding(owner)
      const digest = credentialDigest(result.token)
      const priorRecord = this.rpcCredentialOwners.get(digest)
      this.rpcCredentialOwners.set(digest, {
        owner,
        expiresAtMonotonicMs: priorRecord
          ? Math.min(priorRecord.expiresAtMonotonicMs, expiresAtMonotonicMs)
          : expiresAtMonotonicMs,
      })
      return result
    } finally {
      this.pendingRpcCredentialOwnerReservations.delete(reservation)
    }
  }

  /**
   * Bind a team-scoped RPC credential to the accepted operation owner that
   * requested it. Internal team hops may mint under a temporary team token,
   * then restore the accepted home team before the downstream dispatch.
   */
  bindRpcCredentialToRequestOwner(token: string, requestContext: unknown): void {
    if (!requestContext || typeof requestContext !== 'object')
      throw new SessionRequestOwnershipError()
    const context = requestContext as SessionRequestContext
    if (context.kind !== 'accepted-session' || !context.owner)
      throw new SessionRequestOwnershipError()

    const record = this.rpcCredentialOwners.get(credentialDigest(token))
    if (!record || !this.rpcSessionOwnerLineageMatches(record.owner, context.owner))
      throw new SessionRequestOwnershipError()

    this.assertRpcCredentialOwnerCurrent(context.owner)
    record.owner = context.owner
  }

  clearRpcCredentialOwners(): void {
    if (this.memoryLease) this.retiredMemoryCredentialGuard = true
    this.clearRpcCredentialOwnerRecords()
  }

  /** Clear only RPC provenance tables; the prepared accepted-owner swap owns lease retirement. */
  clearRpcCredentialOwnerRecords(): void {
    this.rpcCredentialOwners.clear()
    this.pendingRpcCredentialOwnerReservations.clear()
  }

  private nowMonotonic(): number {
    return this.options.nowMonotonic?.() ?? performance.now()
  }

  private pruneExpiredRpcCredentialOwners(now: number): void {
    for (const [digest, record] of this.rpcCredentialOwners) {
      if (record.expiresAtMonotonicMs <= now) this.rpcCredentialOwners.delete(digest)
    }
  }

  private pruneRpcCredentialOwnersForBinding(owner: RpcSessionOwner): void {
    const groupKey = this.rpcCredentialOwnerGroupKey(owner)
    for (const [digest, record] of this.rpcCredentialOwners) {
      if (this.rpcCredentialOwnerGroupKey(record.owner) !== groupKey)
        this.rpcCredentialOwners.delete(digest)
    }
  }

  isCurrentMemorySessionTokenRequest(token: string, requestOwner: unknown): boolean {
    const ownership = this.inspectMemorySessionTokenRequest(token, requestOwner)
    return ownership.status === 'current'
  }

  isPrimarySessionRequestOwner(requestOwner: unknown): boolean {
    return (
      requestOwner !== null &&
      typeof requestOwner === 'object' &&
      (requestOwner as SessionRequestOwner).credentialKind === 'session'
    )
  }

  inspectMemorySessionTokenRequest(
    token: string,
    requestOwner: unknown
  ): { status: 'current' | 'stale' } | { status: 'invalid'; error: unknown } {
    const currentLease = this.memoryLease
    if (!currentLease || !requestOwner || typeof requestOwner !== 'object')
      return { status: 'stale' }
    const receipt = requestOwner as SessionRequestOwner
    if (
      (receipt.credentialKind !== 'session' && receipt.credentialKind !== 'rpc') ||
      receipt.credentialDigest !== credentialDigest(token)
    ) {
      return { status: 'stale' }
    }
    const owner = receipt.owner
    if (
      !owner.memoryLease ||
      owner.memoryLease.volatileSessionId !== currentLease.volatileSessionId ||
      owner.envKey !== getActiveEnvKey() ||
      owner.generation !== this.generation ||
      owner.userId !== this.authenticatedUser?.id ||
      owner.sessionDigest !== credentialDigest(this.token ?? '')
    )
      return { status: 'stale' }
    try {
      this.assertMemoryOnlySessionCurrent(currentLease)
      return { status: 'current' }
    } catch (error) {
      return { status: 'invalid', error }
    }
  }

  private captureRpcCredentialOwner(sessionToken: string): RpcSessionOwner {
    if (this.sessionToken !== sessionToken || !this.me) throw new SessionRequestOwnershipError()
    const owner = {
      sessionDigest: credentialDigest(sessionToken),
      envKey: getActiveEnvKey(),
      generation: this.sessionGeneration,
      userId: this.me.id,
      teamId: this.me.teamId ?? null,
      memoryLease: this.memoryLease,
    }
    this.assertRpcCredentialOwnerCurrent(owner)
    return owner
  }

  private rpcCredentialBindingKey(owner: RpcSessionOwner): string {
    return JSON.stringify([
      owner.envKey,
      owner.generation,
      owner.sessionDigest,
      owner.userId,
      owner.teamId,
      owner.memoryLease?.volatileSessionId ?? null,
    ])
  }

  private rpcCredentialOwnerGroupKey(owner: RpcSessionOwner): string {
    return JSON.stringify(
      owner.memoryLease
        ? [owner.envKey, owner.generation, owner.userId, owner.memoryLease.volatileSessionId]
        : [this.rpcCredentialBindingKey(owner)]
    )
  }

  private assertRpcCredentialOwnerCurrent(owner: RpcSessionOwner): void {
    const currentLease = this.memoryLease
    const memoryLeaseMatches = owner.memoryLease
      ? currentLease?.volatileSessionId === owner.memoryLease.volatileSessionId
      : currentLease === undefined
    const sessionTokenMatches =
      this.sessionToken !== null && credentialDigest(this.sessionToken) === owner.sessionDigest
    if (
      !sessionTokenMatches ||
      getActiveEnvKey() !== owner.envKey ||
      this.sessionGeneration !== owner.generation ||
      this.me?.id !== owner.userId ||
      (this.me?.teamId ?? null) !== owner.teamId ||
      !memoryLeaseMatches
    ) {
      throw new SessionRequestOwnershipError()
    }
    if (owner.memoryLease) this.assertMemoryOnlySessionCurrent(currentLease)
  }

  inspectPendingLogoutMarker(envKey: string): PendingExternalLogoutMarker | null {
    const observation = this.observeMarker(envKey)
    if (observation.status !== 'observed') throw observation.error
    return observation.marker
  }

  observeMarker(envKey: string) {
    return observePendingExternalLogoutMarker(this.options.getUserDataDirectory(), envKey)
  }

  inspectOwnership(
    envKey: string,
    expected: readonly (PendingExternalLogoutMarker | null)[],
    runtimeOwned: boolean
  ) {
    return pendingExternalLogoutOwnership(this.observeMarker(envKey), expected, runtimeOwned)
  }

  isTransientPersistenceAuthorityRead(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | null)?.code
    const retryableCode =
      typeof code === 'string' &&
      ['EIO', 'EMFILE', 'ENFILE', 'EAGAIN', 'EBUSY', 'EINTR'].includes(code)
    return (
      isSessionCredentialSourceObservationError(error) ||
      isTransientPendingLogoutReadError(error) ||
      (retryableCode &&
        (isSessionPersistenceJournalReadFailure(error) || isSessionTokenFallbackReadFailure(error)))
    )
  }

  planPersistenceAuthorityFailure(
    error: unknown,
    context: PersistenceFailureContext,
    state: { priorRuntimeAvailable?: boolean; priorRuntimeMatchesCandidate?: boolean } = {}
  ): PersistenceAuthorityFailurePlan {
    const cause = this.unwrapPersistenceAuthorityError(error)
    if (cause instanceof SessionTokenStorageSupersededBeforeWriteError) return { kind: 'ignore' }
    if (cause instanceof SessionAuthorityProjectionIntegrityError) {
      return {
        kind: 'fail-closed',
        source: cause.source === 'authority' ? 'other' : cause.source,
      }
    }

    let source: 'marker' | 'journal' | 'fallback' | 'keytar' | 'safe-storage' | 'other' = 'other'
    if (isSessionCredentialSourceObservationError(cause)) {
      source = cause.source
      const action =
        context === 'nested-producer-rollback'
          ? 'repair-owned-source'
          : context === 'restore-source-observation' && state.priorRuntimeAvailable
            ? 'preserve-prior-runtime'
            : context === 'restore-session-validation' && state.priorRuntimeMatchesCandidate
              ? 'preserve-prior-runtime'
              : context === 'restore-source-observation' || context === 'restore-session-validation'
                ? 'reject-candidate'
                : 'defer'
      return { kind: 'transient-read', source, action }
    }
    const causeCode = (cause as NodeJS.ErrnoException | null)?.code
    const retryableStorageReadCode =
      typeof causeCode === 'string' &&
      ['EIO', 'EMFILE', 'ENFILE', 'EAGAIN', 'EBUSY', 'EINTR'].includes(causeCode)
    if (
      isTransientPendingLogoutReadError(cause) ||
      (retryableStorageReadCode &&
        (isSessionPersistenceJournalReadFailure(cause) || isSessionTokenFallbackReadFailure(cause)))
    ) {
      if (isPendingExternalLogoutReadFailure(cause)) source = 'marker'
      else if (isSessionPersistenceJournalReadFailure(cause)) source = 'journal'
      else if (isSessionTokenFallbackReadFailure(cause)) source = 'fallback'
      if (source !== 'other') {
        const action =
          context === 'nested-producer-rollback'
            ? 'repair-owned-source'
            : context === 'restore-source-observation' && state.priorRuntimeAvailable
              ? 'preserve-prior-runtime'
              : context === 'restore-session-validation' && state.priorRuntimeMatchesCandidate
                ? 'preserve-prior-runtime'
                : context === 'restore-source-observation' ||
                    context === 'restore-session-validation'
                  ? 'reject-candidate'
                  : 'defer'
        return { kind: 'transient-read', source, action }
      }
    }
    if (isPendingExternalLogoutReadFailure(cause)) source = 'marker'
    else if (isSessionPersistenceJournalReadFailure(cause)) source = 'journal'
    else if (isSessionTokenFallbackReadFailure(cause)) source = 'fallback'

    const failClosed =
      context === 'marker-inspection' ||
      context === 'marker-finalization' ||
      (context === 'producer-rollback' && (source === 'marker' || source === 'journal')) ||
      ((context === 'source-cleanup' || context === 'marker-cleanup') && source === 'marker')

    // Retirement historically attempted its own revision-bound repair for marker errors;
    // source cleanup only failed closed for confirmed marker corruption, not journal errors.
    return failClosed ? { kind: 'fail-closed', source } : { kind: 'continue', source }
  }

  unwrapPersistenceAuthorityError(error: unknown): unknown {
    return error instanceof SessionPersistenceJournalAdmissionError &&
      (isPendingExternalLogoutReadFailure(error.cause) ||
        isSessionPersistenceJournalReadFailure(error.cause) ||
        isSessionTokenFallbackReadFailure(error.cause))
      ? error.cause
      : error
  }

  planSourceCleanup(
    source: 'active-keytar' | 'safe-storage',
    expectedToken: string | null
  ): SessionSourceCleanupPlan | null {
    if (!expectedToken) return null
    return source === 'active-keytar'
      ? { source, preserveActiveEnvKey: true }
      : { source, preserveActiveEnvKey: false, preserveActiveEncryptedToken: expectedToken }
  }

  isSourceCleanupOwnerCurrent(input: {
    envKey: string
    generation: number
    selectedSource?: VerifiedSessionTokenSource
    marker?: PendingExternalLogoutMarker
    mayContinue?: () => boolean
  }): boolean {
    return (
      this.sessionGeneration === input.generation &&
      (!input.selectedSource ||
        isSessionTokenReadAuthorityCurrent(
          input.selectedSource.authority,
          input.selectedSource.source,
          input.envKey
        )) &&
      (!input.mayContinue || input.mayContinue()) &&
      (!input.marker ||
        pendingExternalLogoutMarkersMatch(
          this.inspectPendingLogoutMarker(input.envKey),
          input.marker
        ))
    )
  }

  planSourceCleanupOutcome(
    plan: SessionSourceCleanupPlan,
    evidence: SessionSourceCleanupEvidence
  ): SessionSourceCleanupOutcome {
    if (!evidence.ownerCurrent) return { source: plan.source, kind: 'superseded' }
    return {
      source: plan.source,
      kind:
        evidence.sourceVerified &&
        evidence.keytarCleanupSettled &&
        evidence.fallbackRetirementVerified
          ? 'verified'
          : 'incomplete',
    }
  }

  async handlePendingLogoutInspectionFailure(
    error: unknown,
    context: PersistenceFailureContext = 'marker-inspection'
  ): Promise<PendingLogoutFailureDisposition> {
    if (error instanceof SessionTokenStorageSupersededBeforeWriteError) return 'ignored'
    const failure = this.planPersistenceAuthorityFailure(error, context)
    if (failure.kind === 'transient-read') {
      this.reportDeferredLogoutFailureSafely(error)
      return 'transient'
    }
    if (failure.kind === 'fail-closed') {
      await this.options.failClosedForPendingLogout(error)
      return 'failed-closed'
    }
    return 'ignored'
  }

  async clearKeytarForObservedMarker(
    envKey: string,
    marker: PendingExternalLogoutMarker,
    preserveActiveEnvKey: boolean,
    generation = this.sessionGeneration
  ) {
    let inspectionError: unknown
    const mayWrite = () => {
      const observation = this.inspectOwnership(
        envKey,
        [marker],
        this.sessionGeneration === generation && getActiveEnvKey() === envKey
      )
      if (observation.status === 'transient' || observation.status === 'invalid') {
        inspectionError = observation.error
        return false
      }
      return observation.status === 'owned'
    }
    try {
      return await this.tokenStore.clearKeytarSessionTokensStrictly(envKey, {
        legacyEnvKeys: getActiveLegacyEnvKeys(),
        preserveActiveEnvKey,
        mayWrite,
      })
    } catch (error) {
      if (inspectionError !== undefined) throw inspectionError
      throw error
    }
  }

  runSessionPersistence<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.persistenceQueue.then(operation)
    this.persistenceQueue = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }

  requireSessionTokenSourceCurrent(
    selected: VerifiedSessionTokenSource | undefined,
    envKey: string,
    mayContinue: () => boolean
  ): asserts selected is VerifiedSessionTokenSource {
    if (
      !selected ||
      !mayContinue() ||
      !isSessionTokenReadAuthorityCurrent(selected.authority, selected.source, envKey)
    )
      throw new SelectedSessionSourceSupersededError()
  }

  recordAcceptedSessionSource(selected: VerifiedSessionTokenSource, envKey: string): void {
    this.acceptedSource = {
      selected,
      envKey,
      generation: this.sessionGeneration,
    }
  }

  private assertConsumerBindingEvidence(
    envKey: string,
    token: string,
    authenticatedUser: SessionMe | null,
    evidence: SessionConsumerAcceptanceEvidence,
    gfsTeamMustMatch = true
  ): asserts authenticatedUser is SessionMe {
    if (
      !authenticatedUser?.id ||
      evidence.token !== token ||
      evidence.user?.id !== authenticatedUser.id ||
      canonicalSessionTeamId(evidence.user.teamId) !==
        canonicalSessionTeamId(authenticatedUser.teamId) ||
      !evidence.gfsIdentity ||
      evidence.gfsIdentity.ownerId !== authenticatedUser.id ||
      evidence.gfsIdentity.environmentKey !== envKey ||
      (gfsTeamMustMatch &&
        evidence.gfsIdentity.teamId !== canonicalSessionTeamId(authenticatedUser.teamId))
    )
      throw new Error('Authenticated session consumers do not match the acceptance receipt')
    this.assertChatBindingEvidence(envKey, token, authenticatedUser, evidence.chatBoundScope)
  }

  private assertChatBindingEvidence(
    envKey: string,
    token: string,
    authenticatedUser: SessionMe | null,
    chatBoundScope: SessionConsumerAcceptanceEvidence['chatBoundScope'],
    preservedChatTeamId?: string | null
  ): asserts authenticatedUser is SessionMe {
    if (
      !authenticatedUser?.id ||
      getActiveEnvKey() !== envKey ||
      !chatBoundScope ||
      chatBoundScope.userId !== authenticatedUser.id ||
      chatBoundScope.teamId !==
        (preservedChatTeamId === undefined
          ? canonicalSessionTeamId(authenticatedUser.teamId)
          : canonicalSessionTeamId(preservedChatTeamId)) ||
      chatBoundScope.environmentKey !== envKey
    )
      throw new Error('Authenticated ChatStore binding does not match the session receipt')
  }

  captureAcceptedSessionSource(envKey: string): VerifiedSessionTokenSource | undefined {
    const accepted = this.acceptedSource
    return accepted &&
      this.me !== null &&
      accepted.envKey === envKey &&
      accepted.generation === this.sessionGeneration &&
      accepted.selected.token === this.sessionToken
      ? accepted.selected
      : undefined
  }

  priorSessionSource(
    token: string,
    envKey: string,
    source: SessionTokenReadSource | 'default',
    priorPublications: Map<SessionTokenReadSource, VerifiedSessionTokenSource>,
    publications: Map<SessionTokenReadSource, VerifiedSessionTokenSource>,
    accepted: VerifiedSessionTokenSource | undefined
  ): VerifiedSessionTokenSource {
    const kinds: SessionTokenReadSource[] =
      source === 'default' ? [...SESSION_CREDENTIAL_SOURCE_ORDER] : [source]
    for (const kind of kinds) {
      const publication = priorPublications.get(kind) ?? publications.get(kind)
      if (publication && isSessionTokenReadAuthorityCurrent(publication.authority, kind, envKey))
        return { ...publication, token }
    }
    if (accepted?.token === token) {
      const priorKinds =
        source === 'default'
          ? [accepted.source, ...kinds.filter(kind => kind !== accepted.source)]
          : kinds
      for (const kind of priorKinds) {
        const authority = focusSessionTokenReadAuthority(accepted.authority, kind, envKey)
        if (authority && isSessionTokenReadAuthorityCurrent(authority, kind, envKey))
          return { token, source: kind, authority }
      }
    }
    throw new SelectedSessionSourceSupersededError()
  }

  async verifySessionTokenSource(
    selected: VerifiedSessionTokenSource | undefined,
    envKey: string,
    mayContinue: () => boolean
  ): Promise<void> {
    const requireSelected = () =>
      this.requireSessionTokenSourceCurrent(selected, envKey, mayContinue)
    requireSelected()
    let actualSource: SessionTokenReadSource | undefined
    const options = {
      allowLegacyMigration: false,
      onTokenRead: (source: SessionTokenReadSource) => {
        actualSource = source
      },
    }
    const token =
      selected!.source === 'keytar'
        ? await this.readSessionTokenFromSource('active-keytar', envKey, options)
        : selected!.source === 'safe-storage'
          ? await this.readSessionTokenFromSource('safe-storage', envKey, options)
          : await this.readPreferredSessionToken(envKey, options)
    requireSelected()
    if (actualSource !== undefined && actualSource !== selected!.source)
      throw new SelectedSessionSourceSupersededError()
    if (token !== selected!.token || actualSource === undefined)
      throw new Error('Fresh session token could not be verified in its secure store')
  }

  async readVerifiedSessionTokenSource(
    token: string,
    envKey: string,
    source: SessionTokenReadSource | 'default',
    mayContinue: () => boolean,
    original?: VerifiedSessionTokenSource
  ): Promise<VerifiedSessionTokenSource> {
    if (original) {
      if (original.token !== token || (source !== 'default' && original.source !== source))
        throw new SelectedSessionSourceSupersededError()
      await this.verifySessionTokenSource(original, envKey, mayContinue)
      return original
    }
    let selected: VerifiedSessionTokenSource | undefined
    const options = {
      allowLegacyMigration: false,
      onTokenRead: (actualSource: SessionTokenReadSource, authority: SessionTokenReadAuthority) => {
        selected = { token, source: actualSource, authority }
      },
    }
    const actual =
      source === 'keytar'
        ? await this.readSessionTokenFromSource('active-keytar', envKey, options)
        : source === 'safe-storage'
          ? await this.readSessionTokenFromSource('safe-storage', envKey, options)
          : await this.readPreferredSessionToken(envKey, options)
    if (actual !== token || !selected)
      throw new Error('Fresh session token could not be verified in its secure store')
    if (
      !mayContinue() ||
      !isSessionTokenReadAuthorityCurrent(selected.authority, selected.source, envKey)
    )
      throw new SelectedSessionSourceSupersededError()
    return selected
  }

  async readPreferredSessionToken(
    envKey: string,
    options: SessionTokenReadOptions = {}
  ): Promise<string | null> {
    for (const source of sessionCredentialSourceReadOrder(this.isIsolatedDevelopmentStorage())) {
      const observation = await this.tokenStore.observeSessionTokenSource(source, envKey, options)
      const plan = this.planSessionTokenSourceObservation(observation)
      if (plan.kind === 'select' && observation.status === 'present')
        return this.tokenStore.acceptSessionTokenSourceObservation(observation, options)
      if (plan.kind === 'reject') throw plan.error
    }
    // Legacy selectors belong to older Desktop authentication protocols. A missing or invalid
    // V1 source never authorizes reading those selectors in the current client.
    return null
  }

  planSessionTokenSourceObservation(observation: SessionTokenSourceObservation) {
    return planSessionCredentialSourceRead(observation, {
      allowIsolatedDevelopmentPlaintext: this.isIsolatedDevelopmentStorage(),
    })
  }

  readSessionTokenFromSource(
    source: 'active-keytar' | 'safe-storage',
    envKey: string,
    options: SessionTokenReadOptions = {}
  ): Promise<string | null> {
    const credentialSource = source === 'active-keytar' ? 'keytar' : 'safe-storage'
    return this.tokenStore
      .observeSessionTokenSource(credentialSource, envKey, options)
      .then(observation => {
        if (observation.status === 'present')
          return this.tokenStore.acceptSessionTokenSourceObservation(observation, options)
        if (observation.status === 'failed')
          throw new SessionCredentialSourceObservationError(credentialSource)
        return null
      })
  }

  writeSessionTokenToSource(
    source: 'active-keytar' | 'safe-storage' | 'isolated-development',
    token: string,
    envKey: string,
    options: SessionTokenMutationOptions = {}
  ): Promise<void> {
    if (source === 'safe-storage')
      return this.tokenStore.setSafeStorageSessionToken(token, envKey, options)
    if (source === 'active-keytar')
      return this.tokenStore.setSessionToken(token, envKey, {
        ...options,
        requireKeytar: true,
      })
    if (!this.isIsolatedDevelopmentStorage())
      return Promise.reject(new Error('Isolated development storage is not configured'))
    return this.tokenStore.setSessionToken(token, envKey, options)
  }

  restoreActionForMarker(marker: PendingExternalLogoutMarker | null): SavedSessionRestoreAction {
    if (!marker)
      return {
        kind: 'restore',
        plan: { policy: 'normal', pendingCleanupMarker: null, retireMarkerAfterRestore: false },
      }
    const intent = marker.intent
    if (intent.intent === 'memory-only-session')
      return {
        kind: 'deny',
        plan: { policy: 'deny-all', pendingCleanupMarker: marker, retireMarkerAfterRestore: false },
      }
    if (intent.intent === 'keytar-cleanup-pending') {
      return {
        kind: 'deny',
        plan: { policy: 'deny-all', pendingCleanupMarker: marker, retireMarkerAfterRestore: false },
      }
    }
    if (intent.intent === 'acceptance-pending')
      return {
        kind: 'restore',
        plan: { policy: 'normal', pendingCleanupMarker: marker, retireMarkerAfterRestore: false },
      }
    return { kind: 'finalize-logout', marker }
  }

  planPendingLogoutApplication(
    marker: PendingExternalLogoutMarker | null
  ): PendingLogoutApplicationPlan {
    if (!marker) return { kind: 'none' }
    // A validated V2 acceptance receipt may deliberately retain this deny-only compatibility
    // marker. It is not a logout signal and must never trigger destructive cleanup.
    if (marker.intent.intent === 'acceptance-pending') return { kind: 'none' }
    if (marker.intent.intent === 'keytar-cleanup-pending') return { kind: 'none' }
    // A memory-only marker denies restoration of persisted credentials, but is not a logout
    // receipt. Do not delete a saved source unless durable LP records exact cleanup debt.
    if (marker.intent.intent === 'memory-only-session') return { kind: 'none' }
    return { kind: 'finalize-logout', marker }
  }

  planLogoutStart(marker: PendingExternalLogoutMarker | null): LogoutStartPlan {
    if (marker?.intent.intent === 'memory-only-session')
      return { kind: 'retain-memory-only-denial', marker }
    if (marker?.intent.intent === 'keytar-cleanup-pending') {
      const next = this.planLogoutPendingMarker()
      return { kind: 'upgrade-cleanup-marker', cas: { expected: marker, next }, next }
    }
    return { kind: 'clear-first', marker }
  }

  planLogoutPendingMarker(): PendingExternalLogoutMarker {
    return { intent: { intent: 'logout-pending' }, revision: randomUUID() }
  }

  planLogoutAfterCleanup(input: {
    marker: PendingExternalLogoutMarker | null
    markerInspectionFailed: boolean
    clearCompleted: boolean
    journalDisposition: 'not-retired' | 'retired' | 'unavailable'
  }): LogoutClearPlan {
    if (!input.clearCompleted || input.journalDisposition !== 'retired')
      return { kind: 'ensure-logout-intent', expectedMarker: input.marker }
    if (input.markerInspectionFailed)
      return { kind: 'preserve-observed-marker', marker: input.marker }
    return { kind: 'retire-journal-and-marker', marker: input.marker }
  }

  planLogoutFailureMarker(
    observed: PendingExternalLogoutMarker | null,
    current: PendingExternalLogoutMarker | null
  ): LogoutFailureMarkerPlan {
    if (current && (!observed || !pendingExternalLogoutMarkersMatch(current, observed)))
      return { kind: 'superseded' }
    if (current?.intent.intent === 'logout-pending')
      return { kind: 'preserve-existing-logout-intent', marker: current }
    if (current) return { kind: 'superseded' }
    return { kind: 'write-logout-intent' }
  }

  planRejectedLoginPriorSourceRead(input: {
    marker: PendingExternalLogoutMarker | null
    freshTokenUsesSafeStorageOnly: boolean
  }): SessionTokenReadSource | 'default' {
    if (input.marker?.intent.intent === 'keytar-cleanup-pending')
      return input.marker.intent.credentialSource === 'safe-storage' ? 'safe-storage' : 'keytar'
    if (input.marker) return input.freshTokenUsesSafeStorageOnly ? 'safe-storage' : 'keytar'
    return 'default'
  }

  planMalformedMarkerLoginReadFailure(input: {
    error: unknown
    contentsRevision?: string | null
  }): MalformedMarkerLoginPlan {
    if (input.error instanceof SessionAuthorityProjectionIntegrityError)
      return { kind: 'deny-unverifiable-marker' }
    if (isTransientPendingLogoutReadError(input.error)) return { kind: 'reject-transient-read' }
    if (input.contentsRevision) {
      return { kind: 'normalize-observed-bytes', contentsRevision: input.contentsRevision }
    }
    return input.contentsRevision === undefined
      ? { kind: 'read-observed-revision' }
      : { kind: 'deny-unverifiable-marker' }
  }

  planRejectedCandidateCleanup(input: {
    source: 'active-keytar' | 'safe-storage'
    mode: 'rollback-repair' | 'discard-uncommitted'
    observation: ReturnType<SessionAuthorityCoordinator['inspectOwnership']>
    runtimeOwned: boolean
    currentMarker: PendingExternalLogoutMarker | null
  }): RejectedCandidateCleanupPlan {
    if (input.observation.status === 'transient' || input.observation.status === 'invalid')
      return { kind: 'fail', error: input.observation.error }
    if (input.observation.status === 'owned') return { kind: 'allow' }
    if (!input.runtimeOwned) return { kind: 'deny' }
    const marker = input.currentMarker
    if (marker?.intent.intent === 'logout-pending') return { kind: 'allow' }
    if (
      marker?.intent.intent === 'keytar-cleanup-pending' &&
      marker.intent.credentialSource !== input.source
    )
      return { kind: 'allow' }
    if (!marker && input.mode === 'discard-uncommitted') return { kind: 'allow' }
    return { kind: 'deny' }
  }

  planRejectedLoginCandidateRepairs(input: {
    publishedSources: readonly SessionTokenReadSource[]
    marker: PendingExternalLogoutMarker | null
    previousToken: string | null
  }): RejectedLoginCandidateRepair[] {
    const repairs: RejectedLoginCandidateRepair[] = []
    if (input.publishedSources.includes('keytar')) {
      repairs.push({
        source: 'active-keytar',
        restoreToken:
          input.marker?.intent.intent === 'keytar-cleanup-pending' &&
          input.marker.intent.credentialSource === 'safe-storage'
            ? null
            : input.previousToken,
      })
    }
    if (input.publishedSources.includes('safe-storage')) {
      repairs.push({ source: 'safe-storage', restoreToken: input.previousToken })
    }
    return repairs
  }

  planRestoreMarkerMismatch(
    expected: PendingExternalLogoutMarker | null,
    current: PendingExternalLogoutMarker | null
  ): RestoreMarkerMismatchPlan {
    if (
      current?.intent.intent === 'logout-pending' &&
      (!expected || !pendingExternalLogoutMarkersMatch(current, expected))
    )
      return { kind: 'finalize-logout', marker: current }
    return { kind: 'superseded' }
  }

  planLogoutJournalRetirement(input: {
    clearCompleted: boolean
    snapshotAvailable: boolean
  }): LogoutJournalRetirementPlan {
    return input.clearCompleted && input.snapshotAvailable
      ? { kind: 'retire-verified-snapshot' }
      : { kind: 'skip' }
  }

  planLogoutIntentAfterCleanup(
    current: PendingExternalLogoutMarker | null
  ): LogoutFailureMarkerPlan {
    if (current?.intent.intent === 'logout-pending')
      return { kind: 'preserve-existing-logout-intent', marker: current }
    if (current) return { kind: 'superseded' }
    return { kind: 'write-logout-intent' }
  }

  planRejectedLoginMarkerRecovery(input: {
    marker: PendingExternalLogoutMarker | null
    attemptedMarker: PendingExternalLogoutMarker | null
    currentMarker: PendingExternalLogoutMarker | null
    transactionOwned: boolean
  }): RejectedLoginMarkerRecoveryPlan {
    if (!input.transactionOwned || input.marker?.intent.intent !== 'logout-pending')
      return { kind: 'none' }
    if (input.currentMarker === null) return { kind: 'write-logout-intent-if-missing' }
    if (
      pendingExternalLogoutMarkersMatch(input.currentMarker, input.marker) ||
      (input.attemptedMarker !== null &&
        pendingExternalLogoutMarkersMatch(input.currentMarker, input.attemptedMarker))
    )
      return { kind: 'replace-observed-logout-intent', marker: input.currentMarker }
    return { kind: 'preserve-newer-marker' }
  }

  restorePlanAfterCleanup(
    action: Extract<SavedSessionRestoreAction, { kind: 'cleanup-source' }>,
    cleanupVerified: boolean
  ): SavedSessionRestorePlan {
    return { ...action.plan, retireMarkerAfterRestore: cleanupVerified }
  }

  planFreshLogin(marker: PendingExternalLogoutMarker | null): FreshLoginMarkerPlan {
    if (!marker)
      return {
        kind: 'ready',
        plan: {
          intent: null,
          marker: null,
          writeAction: this.isIsolatedDevelopmentStorage()
            ? { kind: 'isolated-development', retirePendingMarkerAfterWrite: false }
            : { kind: 'secure-preferred' },
          retireMarker: false,
          credentialSource: null,
          allowMemoryOnlyFallback: true,
        },
      }
    const intent = marker.intent
    if (
      intent.intent === 'memory-only-session' ||
      intent.intent === 'logout-pending' ||
      intent.intent === 'acceptance-pending'
    )
      return {
        kind: 'ready',
        plan: {
          intent,
          marker,
          writeAction: this.isIsolatedDevelopmentStorage()
            ? { kind: 'isolated-development', retirePendingMarkerAfterWrite: true }
            : { kind: 'secure-preferred' },
          retireMarker: false,
          credentialSource: 'active-keytar',
          allowMemoryOnlyFallback: true,
        },
      }
    if (intent.intent === 'keytar-cleanup-pending')
      return {
        kind: 'ready',
        plan: {
          intent,
          marker,
          writeAction: { kind: 'secure-preferred' },
          retireMarker: false,
          credentialSource: null,
          allowMemoryOnlyFallback: true,
        },
      }
    return { kind: 'finalize-logout', marker }
  }

  planAcceptedLoginMarkerTransition(input: {
    marker: PendingExternalLogoutMarker | null
    canRetirePreviousDebt: boolean
    selectedSource: VerifiedSessionTokenSource | undefined
  }): AcceptedLoginMarkerPlan {
    const { marker, canRetirePreviousDebt, selectedSource } = input
    if (!marker) return { kind: 'preserve', marker: null }
    if (
      canRetirePreviousDebt &&
      this.isIsolatedDevelopmentStorage() &&
      selectedSource?.source === 'historical-plaintext'
    )
      return { kind: 'apply', cas: { expected: marker, next: null } }
    if (
      !selectedSource ||
      (selectedSource.source !== 'keytar' && selectedSource.source !== 'safe-storage')
    )
      return { kind: 'preserve', marker }
    if (canRetirePreviousDebt) return { kind: 'apply', cas: { expected: marker, next: null } }
    const credentialSource = selectedSource.source === 'keytar' ? 'active-keytar' : 'safe-storage'
    return {
      kind: 'apply',
      cas: {
        expected: marker,
        next: this.planCleanupMarkerForSource(credentialSource),
      },
    }
  }

  planMemoryOnlySessionMarker(current: PendingExternalLogoutMarker | null): MarkerCasPlan {
    const next: PendingExternalLogoutMarker = {
      intent: { intent: 'memory-only-session', volatileSessionId: randomUUID() },
      revision: randomUUID(),
    }
    return current
      ? { kind: 'replace-if-unchanged', expected: current, next }
      : { kind: 'create-if-missing', next }
  }

  planMarkerRetirement(
    expected: PendingExternalLogoutMarker,
    current: PendingExternalLogoutMarker | null,
    cleanupVerified: boolean
  ): MarkerRetirementPlan {
    if (!cleanupVerified || !pendingExternalLogoutMarkersMatch(current, expected))
      return { kind: 'preserve', marker: current }
    return { kind: 'retire', cas: { expected, next: null } }
  }

  planMarkerRetirementFailure(
    expected: PendingExternalLogoutMarker,
    current: PendingExternalLogoutMarker | null
  ): MarkerRetirementFailurePlan {
    if (current !== null) return { kind: 'preserve', marker: current }
    if (expected.intent.intent !== 'keytar-cleanup-pending')
      return { kind: 'preserve', marker: null }
    return {
      kind: 'restore-cleanup-if-missing',
      next: this.planCleanupMarkerForSource(expected.intent.credentialSource),
    }
  }

  planTeamTransitionMarkerAdmission(
    marker: PendingExternalLogoutMarker | null,
    envKey: string
  ): TeamTransitionMarkerAdmissionPlan {
    if (!marker) return { kind: 'allow' }
    if (marker.intent.intent === 'logout-pending') return { kind: 'fail-closed' }
    if (marker.intent.intent === 'keytar-cleanup-pending') return { kind: 'allow' }
    if (marker.intent.intent === 'acceptance-pending')
      return this.token !== null &&
        this.authenticatedUser !== null &&
        getActiveEnvKey() === envKey &&
        this.acceptedProjectionMarker !== undefined &&
        pendingExternalLogoutMarkersMatch(this.acceptedProjectionMarker, marker)
        ? { kind: 'allow' }
        : { kind: 'fail-closed' }
    const lease = this.memoryLease
    if (
      lease?.envKey === envKey &&
      lease.volatileSessionId === marker.intent.volatileSessionId &&
      !this.isMemoryOnlySessionLeaseExpired(lease)
    )
      return { kind: 'allow' }
    return { kind: 'fail-closed' }
  }

  planCleanupMarkerForSource(
    source: 'active-keytar' | 'safe-storage'
  ): PendingExternalLogoutMarker {
    return {
      intent: { intent: 'keytar-cleanup-pending', credentialSource: source },
      revision: randomUUID(),
    }
  }

  planSourceBindingAfterFallbackCleanup(
    cleanup: SessionSourceCleanupOutcome,
    currentMarker: PendingExternalLogoutMarker | null
  ): SessionSourceBindingPlan {
    const { source } = cleanup
    if (source === 'safe-storage') {
      if (currentMarker === null)
        return { kind: 'create-if-missing', next: this.planCleanupMarkerForSource(source) }
      return { kind: 'conflict' }
    }

    if (cleanup.kind === 'verified') return { kind: 'retain', marker: currentMarker }
    if (cleanup.kind === 'superseded') return { kind: 'conflict' }
    if (currentMarker === null)
      return { kind: 'create-if-missing', next: this.planCleanupMarkerForSource(source) }
    if (currentMarker.intent.intent !== 'keytar-cleanup-pending') return { kind: 'conflict' }
    if (currentMarker.intent.credentialSource === source)
      return { kind: 'retain', marker: currentMarker }
    return {
      kind: 'replace-if-unchanged',
      expected: currentMarker,
      next: this.planCleanupMarkerForSource(source),
    }
  }

  planVerifiedSafeStorageSourceBinding(
    currentMarker: PendingExternalLogoutMarker | null
  ): SessionSourceBindingPlan {
    return this.planSourceBindingAfterFallbackCleanup(
      { source: 'safe-storage', kind: 'verified' },
      currentMarker
    )
  }

  loginPlanAfterKeytarCleanup(
    marker: PendingExternalLogoutMarker,
    result: {
      keytarAvailable: boolean | null
      keytarDisabled: boolean
      keytarDisposition: StrictSessionTokenClearResult['keytarDisposition']
    }
  ): PendingLogoutLoginPlan {
    if (marker.intent.intent !== 'keytar-cleanup-pending')
      throw new Error('Keytar cleanup login plan requires a cleanup marker')
    const cleanupVerified = isKeytarCleanupEstablished(result.keytarDisposition)
    return {
      intent: marker.intent,
      marker,
      writeAction:
        result.keytarAvailable === true
          ? { kind: 'secure-preferred' }
          : { kind: 'safe-storage-only' },
      retireMarker: cleanupVerified,
      credentialSource:
        marker.intent.credentialSource === 'active-keytar' ? 'active-keytar' : 'safe-storage',
      allowMemoryOnlyFallback: cleanupVerified,
    }
  }

  loginPlanAfterLogoutCleanup(
    marker: PendingExternalLogoutMarker,
    result: {
      keytarAvailable: boolean | null
      keytarDisabled: boolean
      keytarDisposition: StrictSessionTokenClearResult['keytarDisposition']
    }
  ): PendingLogoutLoginPlan {
    const cleanupVerified = isKeytarCleanupEstablished(result.keytarDisposition)
    return {
      intent: marker.intent,
      marker,
      writeAction: result.keytarAvailable
        ? { kind: 'secure-preferred' }
        : result.keytarDisabled
          ? { kind: 'isolated-development', retirePendingMarkerAfterWrite: true }
          : { kind: 'safe-storage-only' },
      retireMarker: cleanupVerified,
      credentialSource: cleanupVerified ? null : 'safe-storage',
      allowMemoryOnlyFallback: cleanupVerified,
    }
  }

  loginPlanAfterCleanupFailure(
    mode: 'keytar-cleanup' | 'logout',
    marker: PendingExternalLogoutMarker,
    envKey: string,
    error: unknown
  ): PendingLogoutLoginPlan | null {
    if (!(error instanceof SessionTokenStorageClearError)) return null
    if (error.canBeReplacedByFreshLoginCredential(envKey))
      return {
        intent: marker.intent,
        marker,
        writeAction: { kind: 'secure-preferred' },
        retireMarker: true,
        credentialSource: 'active-keytar',
        allowMemoryOnlyFallback: false,
      }
    if (error.canUseFreshActiveKeytarCredential(envKey)) {
      this.reportDeferredLogoutFailureSafely(error)
      return {
        intent: marker.intent,
        marker,
        writeAction: { kind: 'secure-preferred' },
        retireMarker: false,
        credentialSource: 'active-keytar',
        allowMemoryOnlyFallback: false,
      }
    }
    if (mode === 'keytar-cleanup' || error.canUseSecureFileFallbackWhileMarkerRemains()) {
      this.reportDeferredLogoutFailureSafely(error)
      return {
        intent: marker.intent,
        marker,
        writeAction: { kind: 'safe-storage-only' },
        retireMarker: false,
        credentialSource: 'safe-storage',
        allowMemoryOnlyFallback: false,
      }
    }
    return null
  }

  async persistRequiredKeytarOrSafeStorage(
    token: string,
    envKey: string,
    mayContinue: () => boolean = () => true,
    credentialPersisted: () => void = () => {},
    encryptedWriteAttempted: () => void = () => {},
    receipt?: {
      keytarUnavailableBeforeWrite: boolean
      onMutationDispatched?: (source: SessionTokenMutationSource, candidateToken: string) => void
      onSourceVerified?: (selected: VerifiedSessionTokenSource) => void
      onMutationSettled?: (
        source: SessionTokenMutationSource,
        authority: SessionTokenReadAuthority
      ) => void
      publications: Map<SessionTokenReadSource, VerifiedSessionTokenSource>
    },
    producerKind: 'fresh-login' | 'team-transition' | 'legacy-import' = 'fresh-login'
  ): Promise<'active-keytar' | 'safe-storage'> {
    const requireCurrentProducer = () => {
      if (!mayContinue()) throw new SessionTokenStorageSupersededBeforeWriteError()
    }
    requireCurrentProducer()
    try {
      await this.tokenStore.setSessionToken(token, envKey, {
        requireKeytar: true,
        mayWrite: mayContinue,
        onMutationDispatched: receipt?.onMutationDispatched,
        onMutationSettled: receipt?.onMutationSettled,
      })
      credentialPersisted()
      requireCurrentProducer()
    } catch (keytarError) {
      if (
        isSessionTokenMutationCallbackFailure(keytarError) ||
        keytarError instanceof SessionPersistenceJournalAdmissionError ||
        keytarError instanceof SessionPersistenceCandidateDeniedError
      )
        throw keytarError
      if (keytarError instanceof SessionTokenStorageSupersededBeforeWriteError) throw keytarError
      // A rejected native write may have reached Keytar. Never mirror it to S merely because
      // the error looks like a locked provider: an older or partially written K value could
      // still become authoritative. S is eligible only when TokenStore proves Keytar was
      // unavailable before dispatch; otherwise the owning producer must repair/fence the exact
      // candidate or choose the approved memory-only path after durable denial.
      if (
        !(keytarError instanceof SessionTokenStorageUnavailableBeforeWriteError) ||
        keytarError.storageSource !== 'keytar'
      )
        throw keytarError
      // A same-session team/hop mutation is source-bound. Provider recovery cannot
      // silently turn an accepted K session into S; only a fresh-auth transaction
      // may choose S after a typed pre-dispatch K-unavailable receipt.
      if (producerKind !== 'fresh-login') throw keytarError
      if (receipt) receipt.keytarUnavailableBeforeWrite = true
      requireCurrentProducer()
      try {
        encryptedWriteAttempted()
        await this.tokenStore.setSafeStorageSessionToken(token, envKey, {
          mayWrite: mayContinue,
          onMutationDispatched: receipt?.onMutationDispatched,
          onMutationSettled: receipt?.onMutationSettled,
        })
        credentialPersisted()
        requireCurrentProducer()
      } catch (fallbackError) {
        if (
          keytarError instanceof SessionTokenStorageUnavailableBeforeWriteError &&
          fallbackError instanceof SessionTokenStorageUnavailableBeforeWriteError
        )
          throw keytarError
        throw fallbackError
      }
      const selected = await this.readVerifiedSessionTokenSource(
        token,
        envKey,
        'safe-storage',
        mayContinue,
        receipt?.publications.get('safe-storage')
      )
      receipt?.onSourceVerified?.(selected)
      requireCurrentProducer()
      this.reportDeferredLogoutFailureSafely(keytarError)
      return 'safe-storage'
    }
    const selected = await this.readVerifiedSessionTokenSource(
      token,
      envKey,
      'keytar',
      mayContinue,
      receipt?.publications.get('keytar')
    )
    receipt?.onSourceVerified?.(selected)
    requireCurrentProducer()
    return 'active-keytar'
  }

  reportDeferredLogoutFailureSafely(error: unknown): void {
    try {
      this.options.reportDeferredLogoutFailure(error)
    } catch {
      // Failure reporting must not permit a pending logout to restore a session.
    }
  }
}
