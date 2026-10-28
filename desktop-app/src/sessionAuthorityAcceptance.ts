import { createHash, randomUUID } from 'node:crypto'
import {
  type AcceptancePendingMarker,
  type PendingExternalLogoutMarker,
  type PendingExternalLogoutRawObservation,
  acceptancePendingExternalMarker,
  isTransientPendingLogoutReadError,
} from './pendingExternalLogout.js'
import {
  SessionAuthorityCoordinator,
  type VerifiedSessionTokenSource,
} from './sessionAuthorityCoordinator.js'
import {
  PROFILE_SESSION_AUTHORITY_ENV_KEY,
  type SessionAuthorityCandidate,
  type SessionAuthorityCredentialSource,
  type SessionAuthorityLegacyJournalReceipt,
  type SessionAuthorityProfileSelection,
  SessionAuthorityProjectionIntegrityError,
  type SessionAuthorityRecord,
  SessionAuthorityRecordConflictError,
  SessionAuthorityRecordRepository,
  type SessionAuthorityRecordSnapshot,
  SessionAuthorityStorageAuthorizationError,
  digestSessionAuthoritySource,
  sameLogoutMarkerPreimage,
} from './sessionAuthorityRecord.js'
import {
  observeSessionPersistenceLegacySnapshot,
  sessionPersistenceLegacySnapshotMatches,
} from './sessionPersistenceJournal.js'
import type {
  LegacySessionCredentialSourceInventory,
  SelectedLegacySessionCredentialSource,
  SessionAuthorityStorageScope,
  SessionAuthorityTransactionLease,
  SessionTokenReadAuthority,
  TokenStore,
} from './tokenStore.js'
import { isInsecureBasicTextSafeStorageBackend } from './tokenStore.js'

export type SessionAuthorityRestoreExistingPlan = {
  tokenStore: TokenStore
  lease: SessionAuthorityTransactionLease
  envKey: string
  transactionId: string
  source: SessionAuthorityCredentialSource
  accepted: SessionAuthorityAcceptedRecord
  storageScope: SessionAuthorityStorageScope
  repository: SessionAuthorityRecordRepository
  snapshot: SessionAuthorityRecordSnapshot
  profileRepository?: SessionAuthorityRecordRepository
  profileSnapshot?: SessionAuthorityRecordSnapshot
  profileSelection?: SessionAuthorityProfileSelection
  readExactSource(): Promise<string | null>
  assertSourceCurrent(): void
  verifyExactSource(token: string): Promise<boolean>
  expectedIdentity?: { userId: string; teamId: string | null }
  assertRestoreAllowed?(token: string): void
  runtimeSource?: VerifiedSessionTokenSource
}

export type SessionAuthorityPersistentSourceKind = 'keytar' | 'safe-storage'

export type SessionAuthorityAcceptedRecord = {
  record: SessionAuthorityRecord
  snapshot: SessionAuthorityRecordSnapshot
  storageScope: SessionAuthorityStorageScope
  repository: SessionAuthorityRecordRepository
}

/** Prepared before authority acceptance; publish performs only reserved same-turn state swaps. */
export type SessionAuthorityPublicationReservation = Readonly<{
  isCurrent(): boolean
  /** `undefined` return excludes async or value-producing publication callbacks at compile time. */
  publish(accepted: SessionAuthorityAcceptedRecord): undefined
}>

/** Transaction-derived permission to restore consumers after a rejected candidate. */
export type SessionAuthorityRollbackAuthorization = Readonly<{
  canRestorePriorConsumers: boolean
}>

export type SessionAuthorityAcceptedSource = {
  accepted: SessionAuthorityAcceptedRecord
  token: string
}

export type SessionAuthoritySourceSelection =
  | { status: 'absent' }
  | { status: 'denied'; frameMode: 'uninitialized' | 'memory-only' | 'logged-out' }
  | { status: 'accepted'; session: SessionAuthorityAcceptedSource }

/** Non-retryable authority states which make the current runtime unsafe to retain on logout. */
export class SessionAuthorityLogoutPreflightError extends Error {
  constructor(
    readonly disposition: 'invalid-authority' | 'recovery-fenced',
    cause?: unknown
  ) {
    super(
      disposition === 'invalid-authority'
        ? 'Session authority is invalid; logout requires recovery'
        : 'Session authority recovery is required before logout',
      { cause }
    )
    this.name = 'SessionAuthorityLogoutPreflightError'
  }
}

// A second AppService/TokenStore instance in the same process must not mistake an in-flight
// candidate (between awaits, before projection intent) for crash residue. The key is storage
// identity + environment + transaction, not bearer bytes or TokenStore object identity.
const activeAcceptanceTransactions = new Set<string>()

function acceptanceActivityKey(
  tokenStore: TokenStore,
  storageScope: SessionAuthorityStorageScope,
  envKey: string,
  transactionId: string
): string {
  return JSON.stringify([
    tokenStore.resolveSessionAuthorityStorageScope(storageScope),
    envKey,
    transactionId,
  ])
}

function sameCandidateMarkerObservation(
  candidate: SessionAuthorityRecord['candidates'][number],
  marker: PendingExternalLogoutRawObservation
): boolean {
  return (
    candidate.observedExternalMarker.kind === marker.kind &&
    candidate.observedExternalMarker.revision === (marker.marker?.revision ?? null) &&
    candidate.observedExternalMarker.digest === marker.rawDigest
  )
}

function sameCandidateJournalObservation(
  candidate: SessionAuthorityRecord['candidates'][number],
  receipt: SessionAuthorityLegacyJournalReceipt
): boolean {
  return (
    candidate.observedLegacyJournal.schemaVersion === receipt.schemaVersion &&
    candidate.observedLegacyJournal.revision === receipt.revision &&
    candidate.observedLegacyJournal.byteLength === receipt.byteLength &&
    candidate.observedLegacyJournal.digest === receipt.digest
  )
}

function logoutReceiptBindsMarker(
  receipt: NonNullable<SessionAuthorityRecord['logoutReceipt']>,
  marker: PendingExternalLogoutRawObservation
): boolean {
  if (receipt.projectionKind === 'record-only')
    return receipt.priorMarker !== null && sameLogoutMarkerPreimage(receipt.priorMarker, marker)
  return (
    marker.marker?.intent.intent === 'logout-pending' &&
    marker.marker.revision === receipt.markerRevision &&
    marker.rawDigest === receipt.markerDigest
  )
}

/**
 * Fallible effects which must be staged before a candidate can become authoritative.
 * The acceptance transaction owns their ordering and rollback; callers provide only the
 * producer-specific identity and consumer operations.
 */
export type SessionAuthorityAcceptanceEffects<TIdentity, TConsumers> = {
  assertOwned(): void | Promise<void>
  /** Synchronous check of the coordinator's producer generation and lease identity. */
  isProducerStillCurrent(): boolean
  /** Synchronous check that the prior authenticated consumer scope still belongs to this owner. */
  isPriorConsumerOwnerCurrent(): boolean
  verifyIdentity(): Promise<TIdentity>
  prepareConsumers(identity: TIdentity): Promise<TConsumers>
  consumersReady(consumers: TConsumers): boolean
  isStillOwned(identity: TIdentity, consumers: TConsumers): boolean
  /** Reserve the synchronous, non-throwing runtime/consumer swap before authority acceptance. */
  preparePublication(
    identity: TIdentity,
    consumers: TConsumers
  ): SessionAuthorityPublicationReservation
  afterAcceptance?(
    accepted: SessionAuthorityAcceptedRecord,
    identity: TIdentity,
    consumers: TConsumers
  ): Promise<void>
  /** Report exact rollback/recovery failures without replacing the original producer error. */
  onRollbackFailure?(error: unknown): void
  /** Synchronously revoke any prior runtime owner when the final authority CAS is indeterminate. */
  onAcceptanceIndeterminate(): void
  /** Fail closed if a supposedly non-throwing publication callback violates its contract. */
  onAcceptancePublicationFailure?(): void
  discardConsumers(consumers: TConsumers): void
  /** Synchronous only: the transaction revalidates durable ownership immediately beforehand. */
  rollbackBeforeAcceptance(authorization: SessionAuthorityRollbackAuthorization): void
}

export type SessionAuthorityRestoreEffects<TIdentity, TConsumers> = {
  assertOwned(): void | Promise<void>
  verifyIdentity(): Promise<TIdentity>
  onRestoreRejected?(error: unknown, selectedToken: string): void | Promise<void>
  prepareConsumers(identity: TIdentity): Promise<TConsumers>
  consumersReady(consumers: TConsumers): boolean
  isStillOwned(identity: TIdentity, consumers: TConsumers): boolean
  /** Reserve the synchronous, non-throwing publication of an already accepted owner. */
  preparePublication(
    accepted: SessionAuthorityAcceptedRecord,
    identity: TIdentity,
    consumers: TConsumers
  ): SessionAuthorityPublicationReservation
  afterPublication?(identity: TIdentity, consumers: TConsumers): Promise<void> | void
  discardConsumers(consumers: TConsumers): void
  /** Revoke any partially published runtime state if the reserved callback throws. */
  onPublicationFailure?(): void
  rollbackBeforeAcceptance(): Promise<void> | void
}

function sameCredentialSource(
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

type CandidateTransactionInput = {
  tokenStore: TokenStore
  userDataDirectory: string
  envKey: string
  /** Explicitly observed pre-RPC namespaces that older supported readers may still use. */
  legacyEnvKeys?: readonly string[]
  /** False when another configured profile shares an unenumerable pre-RPC namespace. */
  legacyNamespaceComplete?: boolean
  token: string
  accountId: string
  source: SessionAuthorityPersistentSourceKind | 'memory-only'
  priorToken: string | null
  priorVolatileSessionId?: string
  expectedAuthorityRevision?: string | null
  purpose?: 'authenticated-replacement' | 'fresh-authentication'
  priorSourceKind?: SessionAuthorityPersistentSourceKind
  priorSelectedLegacySource?: SelectedLegacySessionCredentialSource
  volatileSessionId?: string
  ownerEpoch: number
}

function committed<T extends { status: string }>(
  result: T
): asserts result is T & {
  status: 'committed'
  record: SessionAuthorityRecord
  snapshot: SessionAuthorityRecordSnapshot
} {
  if (result.status !== 'committed') throw new SessionAuthorityRecordConflictError()
}

async function cleanAbortedProjectionCandidate(
  tokenStore: TokenStore,
  storageScope: SessionAuthorityStorageScope,
  repository: SessionAuthorityRecordRepository,
  envKey: string,
  transactionId: string,
  assertRecoveryStillCurrent?: () => void
): Promise<void> {
  assertRecoveryStillCurrent?.()
  let observed = repository.observe()
  if (observed.status !== 'observed')
    throw observed.status === 'transient'
      ? observed.error
      : new SessionAuthorityRecordConflictError()
  let candidate = observed.record.candidates.find(item => item.transactionId === transactionId)
  if (!candidate) return
  if (candidate.sourceKind === 'memory-only') throw new SessionAuthorityRecordConflictError()
  if (candidate.phase === 'denied') {
    const retired = repository.retireNeverDispatchedCandidate(observed.snapshot, transactionId)
    committed(retired)
    return
  }
  if (
    candidate.phase !== 'writing' &&
    candidate.phase !== 'published' &&
    candidate.phase !== 'verified' &&
    candidate.phase !== 'cleanup-pending'
  )
    throw new SessionAuthorityRecordConflictError()

  const claim = repository.claimRejectedCandidateCleanup(observed.snapshot, transactionId)
  if (claim.status !== 'claimed') throw new SessionAuthorityRecordConflictError()
  const identity = {
    transactionId: candidate.transactionId,
    candidateHash: candidate.candidateHash,
    sourceRef: candidate.sourceRef,
    sourceRevision: candidate.sourceRevision,
    accountId: candidate.accountId,
    envKey,
    source: candidate.sourceKind,
  }
  assertRecoveryStillCurrent?.()
  await tokenStore.discardUnacceptedSessionTokenCandidate(
    identity,
    claim.authorization,
    storageScope
  )
  assertRecoveryStillCurrent?.()

  observed = repository.observe()
  if (observed.status !== 'observed')
    throw observed.status === 'transient'
      ? observed.error
      : new SessionAuthorityRecordConflictError()
  candidate = observed.record.candidates.find(item => item.transactionId === transactionId)
  if (!candidate || candidate.phase !== 'cleanup-pending') return
  const proofClaim = repository.claimRejectedCandidateCleanup(observed.snapshot, transactionId)
  if (proofClaim.status !== 'claimed') throw new SessionAuthorityRecordConflictError()
  assertRecoveryStillCurrent?.()
  const absent = await tokenStore.confirmSessionTokenCandidateSlotAbsent(
    identity,
    proofClaim.authorization,
    storageScope
  )
  if (absent.outcome !== 'absent' || !absent.proof) throw new SessionAuthorityRecordConflictError()
  assertRecoveryStillCurrent?.()
  const latest = repository.observe()
  if (latest.status !== 'observed')
    throw latest.status === 'transient' ? latest.error : new SessionAuthorityRecordConflictError()
  assertRecoveryStillCurrent?.()
  const retired =
    latest.record.projectionIntent?.candidateTransactionId === transactionId
      ? repository.completeAbortedAcceptanceProjection(latest.snapshot, transactionId, absent.proof)
      : repository.retireProvenUnpublishedCandidate(latest.snapshot, transactionId, absent.proof)
  committed(retired)
}

function isDurablyUnselectedCandidateForDeferredCleanup(
  record: SessionAuthorityRecord,
  candidate: SessionAuthorityCandidate | undefined
): boolean {
  return Boolean(
    candidate &&
    record.projectionIntent === null &&
    (candidate.phase === 'denied' || candidate.phase === 'cleanup-pending') &&
    candidate.sourceRef !== record.frame.source?.sourceRef &&
    candidate.transactionId !== record.frame.transactionId
  )
}

async function reconcileOrphanCandidates(
  tokenStore: TokenStore,
  envKey: string,
  storageScope: SessionAuthorityStorageScope,
  repository: SessionAuthorityRecordRepository,
  observeProjectionMarker: () => PendingExternalLogoutRawObservation,
  observeLegacyJournal: () => ReturnType<typeof observeSessionPersistenceLegacySnapshot>
): Promise<void> {
  let observation = repository.observe()
  if (observation.status !== 'observed')
    throw observation.status === 'transient'
      ? observation.error
      : new SessionAuthorityRecordConflictError()
  if (observation.record.projectionIntent !== null) throw new SessionAuthorityRecordConflictError()
  if (observation.record.candidates.length === 0) return

  const record = observation.record
  const marker = observeProjectionMarker()
  const journal = observeLegacyJournal()
  if (journal.status !== 'observed') throw journal.error
  if (
    record.legacyJournalReceipt === null ||
    !sessionPersistenceLegacySnapshotMatches(record.legacyJournalReceipt, journal.receipt)
  )
    throw new SessionAuthorityProjectionIntegrityError('journal')

  const currentProjectionIsBound =
    (record.projectionReceipt !== null &&
      marker.rawContents === JSON.stringify(record.projectionReceipt.marker) &&
      sessionPersistenceLegacySnapshotMatches(
        record.projectionReceipt.legacyJournalReceipt,
        journal.receipt
      )) ||
    (record.logoutReceipt !== null && logoutReceiptBindsMarker(record.logoutReceipt, marker))

  // Orphan cleanup is permitted only under a validated current sidecar projection. If the
  // candidate was created against the still-current frame, its own captured preconditions must
  // match exactly. A later accepted/logout frame may supersede those before-images only when its
  // own durable receipt binds the current marker and immutable journal snapshot.
  for (const candidate of record.candidates) {
    if (!sameCandidateJournalObservation(candidate, journal.receipt))
      throw new SessionAuthorityProjectionIntegrityError('journal')
    if (candidate.observedFrameRevision === record.frame.revision) {
      if (!sameCandidateMarkerObservation(candidate, marker))
        throw new SessionAuthorityProjectionIntegrityError('marker')
    } else if (
      !currentProjectionIsBound ||
      record.latestCandidateTransactionId === candidate.transactionId
    ) {
      throw new SessionAuthorityRecordConflictError()
    }
  }
  if (
    marker.marker?.intent.intent === 'acceptance-pending' &&
    (!record.projectionReceipt ||
      marker.rawContents !== JSON.stringify(record.projectionReceipt.marker))
  )
    throw new SessionAuthorityProjectionIntegrityError('marker')

  for (const candidate of [...record.candidates]) {
    const activityKey = acceptanceActivityKey(
      tokenStore,
      storageScope,
      envKey,
      candidate.transactionId
    )
    if (activeAcceptanceTransactions.has(activityKey)) continue

    const assertOrphanRecoveryCurrent = () => {
      const current = repository.observe()
      if (
        current.status !== 'observed' ||
        current.record.frame.revision !== record.frame.revision ||
        current.record.projectionIntent !== null
      )
        throw current.status === 'transient'
          ? current.error
          : new SessionAuthorityRecordConflictError()
      const currentCandidate = current.record.candidates.find(
        item => item.transactionId === candidate.transactionId
      )
      if (!currentCandidate || current.record.frame.source?.sourceRef === candidate.sourceRef)
        throw new SessionAuthorityRecordConflictError()
      const currentMarker = observeProjectionMarker()
      const currentJournal = observeLegacyJournal()
      if (currentJournal.status !== 'observed') throw currentJournal.error
      if (
        !current.record.legacyJournalReceipt ||
        !sessionPersistenceLegacySnapshotMatches(
          current.record.legacyJournalReceipt,
          currentJournal.receipt
        ) ||
        !sameCandidateJournalObservation(currentCandidate, currentJournal.receipt)
      )
        throw new SessionAuthorityProjectionIntegrityError('journal')
      const currentProjectionIsBound =
        (current.record.projectionReceipt !== null &&
          currentMarker.rawContents === JSON.stringify(current.record.projectionReceipt.marker) &&
          sessionPersistenceLegacySnapshotMatches(
            current.record.projectionReceipt.legacyJournalReceipt,
            currentJournal.receipt
          )) ||
        (current.record.logoutReceipt !== null &&
          logoutReceiptBindsMarker(current.record.logoutReceipt, currentMarker))
      if (currentCandidate.observedFrameRevision === current.record.frame.revision) {
        if (!sameCandidateMarkerObservation(currentCandidate, currentMarker))
          throw new SessionAuthorityProjectionIntegrityError('marker')
      } else if (
        !currentProjectionIsBound ||
        current.record.latestCandidateTransactionId === candidate.transactionId
      ) {
        throw new SessionAuthorityRecordConflictError()
      }
      if (
        currentMarker.marker?.intent.intent === 'acceptance-pending' &&
        (!current.record.projectionReceipt ||
          currentMarker.rawContents !== JSON.stringify(current.record.projectionReceipt.marker))
      )
        throw new SessionAuthorityProjectionIntegrityError('marker')
    }

    observation = repository.observe()
    if (
      observation.status !== 'observed' ||
      observation.record.frame.revision !== record.frame.revision ||
      observation.record.projectionIntent !== null
    )
      throw observation.status === 'transient'
        ? observation.error
        : new SessionAuthorityRecordConflictError()
    const currentCandidate = observation.record.candidates.find(
      item => item.transactionId === candidate.transactionId
    )
    if (!currentCandidate) continue
    if (currentCandidate.phase === 'denied') {
      assertOrphanRecoveryCurrent()
      committed(
        repository.retireNeverDispatchedCandidate(observation.snapshot, candidate.transactionId)
      )
      continue
    }
    if (currentCandidate.sourceKind === 'memory-only') {
      assertOrphanRecoveryCurrent()
      committed(
        repository.retireUnacceptedMemoryCandidate(observation.snapshot, candidate.transactionId)
      )
      continue
    }
    try {
      await cleanAbortedProjectionCandidate(
        tokenStore,
        storageScope,
        repository,
        envKey,
        candidate.transactionId,
        assertOrphanRecoveryCurrent
      )
    } catch (error) {
      // Exact cleanup can remain pending without displacing the frame-selected source. The
      // candidate stays denied and its unique sourceRef is never eligible for restore; permit
      // only this durable state to coexist with restoring the still-verified accepted frame.
      const current = repository.observe()
      if (
        current.status !== 'observed' ||
        current.record.frame.revision !== record.frame.revision ||
        !isDurablyUnselectedCandidateForDeferredCleanup(
          current.record,
          current.record.candidates.find(item => item.transactionId === candidate.transactionId)
        )
      )
        throw error
    }
  }

  // A cleanup attempt can yield to logout or another accepted producer. Re-read the canonical
  // frame and sidecars before allowing restore to proceed; otherwise leave the process signed out.
  const settled = repository.observe()
  if (settled.status !== 'observed')
    throw settled.status === 'transient' ? settled.error : new SessionAuthorityRecordConflictError()
  if (settled.record.frame.revision !== record.frame.revision)
    throw new SessionAuthorityRecordConflictError()
  const unresolvedOrphans = settled.record.candidates.filter(candidate => {
    if (
      activeAcceptanceTransactions.has(
        acceptanceActivityKey(tokenStore, storageScope, envKey, candidate.transactionId)
      )
    )
      return false
    return !isDurablyUnselectedCandidateForDeferredCleanup(settled.record, candidate)
  })
  if (unresolvedOrphans.length > 0) throw new SessionAuthorityRecordConflictError()
  const settledMarker = observeProjectionMarker()
  const settledJournal = observeLegacyJournal()
  if (settledJournal.status !== 'observed') throw settledJournal.error
  if (
    !settled.record.legacyJournalReceipt ||
    !sessionPersistenceLegacySnapshotMatches(
      settled.record.legacyJournalReceipt,
      settledJournal.receipt
    )
  )
    throw new SessionAuthorityProjectionIntegrityError('journal')
  if (settled.record.projectionReceipt) {
    if (settledMarker.rawContents !== JSON.stringify(settled.record.projectionReceipt.marker))
      throw new SessionAuthorityProjectionIntegrityError('marker')
  } else if (settled.record.logoutReceipt) {
    if (!logoutReceiptBindsMarker(settled.record.logoutReceipt, settledMarker))
      throw new SessionAuthorityProjectionIntegrityError('marker')
  } else if (settled.record.frame.mode === 'uninitialized' && settledMarker.kind !== 'absent') {
    throw new SessionAuthorityProjectionIntegrityError('marker')
  }
}

async function reconcileAcceptanceProjection(
  tokenStore: TokenStore,
  userDataDirectory: string,
  envKey: string,
  storageScope: SessionAuthorityStorageScope,
  repository: SessionAuthorityRecordRepository,
  legacyEnvKeys: readonly string[] = [],
  ownerTransactionId?: string,
  legacyNamespaceComplete = false
): Promise<void> {
  const scopedStorageRoot = tokenStore.resolveSessionAuthorityStorageScope(storageScope)
  const assertStorageScopeCurrent = () => {
    tokenStore.assertSessionAuthorityMarkerScopeCurrentSync(
      storageScope,
      userDataDirectory,
      scopedStorageRoot
    )
  }
  const observeLegacyJournal = () => {
    assertStorageScopeCurrent()
    return observeSessionPersistenceLegacySnapshot(scopedStorageRoot, envKey)
  }
  const observeProjectionMarker = (integrityRequired = true) => {
    try {
      return tokenStore.observeSessionAuthorityMarkerRaw(storageScope, userDataDirectory, envKey)
    } catch (error) {
      // Preserve retryable observation failures as transient. Only confirmed malformed or
      // unverifiable bytes become an integrity denial; an I/O exception is never evidence of
      // corruption or absence.
      if (isTransientPendingLogoutReadError(error)) throw error
      if (integrityRequired) throw new SessionAuthorityProjectionIntegrityError('marker', error)
      throw error
    }
  }
  const reconcileUnframedLegacyLogout = async (
    authoritySnapshot: SessionAuthorityRecordSnapshot,
    beforeMarker: PendingExternalLogoutRawObservation,
    beforeInventory: LegacySessionCredentialSourceInventory
  ): Promise<boolean> => {
    if (beforeMarker.marker?.intent.intent === 'acceptance-pending')
      throw new SessionAuthorityProjectionIntegrityError('marker')
    const alreadyDenied = beforeMarker.marker?.intent.intent === 'logout-pending'
    const containsHistoricalPlaintext = beforeInventory.sources.some(
      source => source.format === 'v0' && source.kind === 'historical-plaintext'
    )
    const containsBasicTextSafeStorage =
      isInsecureBasicTextSafeStorageBackend() &&
      beforeInventory.sources.some(
        source => source.format === 'v0' && source.kind === 'safe-storage'
      )
    if (!alreadyDenied && !containsHistoricalPlaintext && !containsBasicTextSafeStorage)
      return false

    // Publish the legacy-compatible denial before recording exact debt. A crash from here
    // through the V2 frame commit remains signed out and retries observation on next startup.
    let deniedMarker = beforeMarker
    if (
      deniedMarker.marker?.intent.intent !== 'logout-pending' ||
      deniedMarker.marker.revision === null
    ) {
      const nextMarker = { intent: { intent: 'logout-pending' as const }, revision: randomUUID() }
      assertStorageScopeCurrent()
      if (
        !tokenStore.applySessionAuthorityMarkerRawCas(
          storageScope,
          userDataDirectory,
          envKey,
          deniedMarker,
          nextMarker
        )
      )
        throw new SessionAuthorityRecordConflictError()
      deniedMarker = observeProjectionMarker()
      if (
        deniedMarker.marker?.intent.intent !== 'logout-pending' ||
        deniedMarker.marker.revision !== nextMarker.revision
      )
        throw new SessionAuthorityProjectionIntegrityError('marker')
    }
    if (!beforeInventory.complete || !legacyNamespaceComplete)
      throw new Error('Legacy credentials cannot be fenced without a complete source inventory')

    const journalBefore = observeLegacyJournal()
    if (journalBefore.status !== 'observed') throw journalBefore.error
    const afterInventory = await tokenStore.observeLegacySessionCredentialSources(
      envKey,
      storageScope,
      [...legacyEnvKeys]
    )
    const afterMarker = observeProjectionMarker()
    const journalAfter = observeLegacyJournal()
    if (journalAfter.status !== 'observed') throw journalAfter.error
    if (
      afterMarker.marker?.intent.intent !== 'logout-pending' ||
      afterMarker.marker.revision !== deniedMarker.marker?.revision ||
      afterMarker.rawContents !== deniedMarker.rawContents ||
      afterMarker.rawDigest !== deniedMarker.rawDigest ||
      !sessionPersistenceLegacySnapshotMatches(journalBefore.receipt, journalAfter.receipt)
    )
      throw new SessionAuthorityRecordConflictError()
    const exactSources = tokenStore.consumeUnchangedLegacySessionCredentialInventories(
      beforeInventory,
      afterInventory,
      envKey,
      storageScope
    )
    if (!exactSources) throw new SessionAuthorityRecordConflictError()

    let current = repository.observe()
    if (current.status === 'absent') {
      committed(repository.initialize(authoritySnapshot))
      current = repository.observe()
    }
    if (
      current.status !== 'observed' ||
      current.record.frame.mode !== 'uninitialized' ||
      current.record.frame.source !== null ||
      current.record.marker !== null ||
      current.record.cleanupDebts.length !== 0 ||
      current.record.projectionReceipt !== null ||
      current.record.logoutReceipt !== null ||
      (current.record.latestCandidateTransactionId !== null &&
        !current.record.candidates.some(
          candidate => candidate.transactionId === current.record.latestCandidateTransactionId
        )) ||
      (current.record.projectionIntent !== null &&
        !current.record.candidates.some(
          candidate =>
            candidate.transactionId === current.record.projectionIntent?.candidateTransactionId
        ))
    )
      throw new SessionAuthorityRecordConflictError()

    const fenced = repository.commitUnframedLegacyLogoutFence(current.snapshot, {
      operationId: randomUUID(),
      markerRevision: afterMarker.marker.revision!,
      markerDigest: afterMarker.rawDigest,
      legacyJournalReceipt: journalAfter.receipt,
      sources: exactSources,
    })
    committed(fenced)
    const verifiedRecord = repository.observe()
    const verifiedMarker = observeProjectionMarker()
    const verifiedJournal = observeLegacyJournal()
    if (
      verifiedRecord.status !== 'observed' ||
      verifiedRecord.record.frame.mode !== 'logged-out' ||
      verifiedRecord.record.logoutReceipt?.markerRevision !== afterMarker.marker.revision ||
      verifiedRecord.record.logoutReceipt?.markerDigest !== afterMarker.rawDigest ||
      verifiedMarker.rawContents !== afterMarker.rawContents ||
      verifiedMarker.rawDigest !== afterMarker.rawDigest ||
      verifiedJournal.status !== 'observed' ||
      !sessionPersistenceLegacySnapshotMatches(journalAfter.receipt, verifiedJournal.receipt)
    )
      throw new SessionAuthorityProjectionIntegrityError('authority')
    return true
  }
  let observation = repository.observe()
  if (observation.status === 'recovery-fenced') {
    repository.resumeRecovery()
    observation = repository.observe()
  }
  if (observation.status === 'absent') {
    // No V2 frame means this client has no accepted persistent session. Historical credential
    // selectors belong to older Desktop protocols and are neither inventoried nor imported.
    return
  }
  if (observation.status === 'transient' || observation.status === 'invalid')
    throw observation.error
  if (observation.status !== 'observed') throw new SessionAuthorityRecordConflictError()

  let record = observation.record
  if (
    record.frame.mode === 'uninitialized' &&
    record.projectionIntent === null &&
    record.projectionReceipt === null &&
    record.logoutReceipt === null &&
    record.candidates.length === 0
  ) {
    // An uninitialized V2 frame is not authority to inspect historical token stores.
    return
  }
  const intent = record.projectionIntent
  if (intent) {
    // The profile selector is the acceptance linearization point. If a process crashed after
    // that CAS but before promoting the environment-local projection, do not unwind the selected
    // candidate as abandoned work. Leave its exact receipt intact for restore to finish below.
    const profileRepository = new SessionAuthorityRecordRepository(
      storageScope,
      PROFILE_SESSION_AUTHORITY_ENV_KEY,
      tokenStore
    )
    const profile = profileRepository.observeProfileSelection()
    if (profile.status !== 'observed')
      throw profile.status === 'transient'
        ? profile.error
        : new SessionAuthorityRecordConflictError()
    const selectedCandidate = record.candidates.find(
      candidate => candidate.transactionId === intent.candidateTransactionId
    )
    if (
      profile.selection?.state === 'active' &&
      profile.selection.mode === 'persistent' &&
      profile.selection.envKey === envKey &&
      profile.selection.transactionId === intent.candidateTransactionId &&
      profile.selection.authorityRevision === intent.baseAuthorityRevision &&
      selectedCandidate?.phase === 'verified' &&
      selectedCandidate.accountId === profile.selection.userId &&
      selectedCandidate.publishedSource !== null &&
      JSON.stringify(selectedCandidate.publishedSource) === JSON.stringify(profile.selection.source)
    )
      return
  }
  const markerAtEntry = observeProjectionMarker()
  const intentOwnsMarkerImage = Boolean(
    intent &&
    (markerAtEntry.rawContents === JSON.stringify(intent.stagedMarker) ||
      (markerAtEntry.rawContents === intent.beforeMarkerContents &&
        markerAtEntry.rawDigest === intent.beforeMarkerDigest &&
        markerAtEntry.kind === intent.beforeMarkerKind))
  )
  const logoutMarkerWasDurablySuperseded =
    markerAtEntry.marker?.intent.intent === 'logout-pending' &&
    (record.frame.mode !== 'logged-out' || Boolean(intent && !intentOwnsMarkerImage))
  const logoutReceiptMatchesMarker =
    record.logoutReceipt !== null && logoutReceiptBindsMarker(record.logoutReceipt, markerAtEntry)
  const acceptedProjectionMatchesMarker =
    record.projectionReceipt !== null &&
    markerAtEntry.rawContents === JSON.stringify(record.projectionReceipt.marker)

  // A logout marker racing the first candidate has no V2 source to debt. Historical credential
  // selectors are outside this protocol and are deliberately left untouched.
  if (
    record.frame.mode === 'uninitialized' &&
    markerAtEntry.marker?.intent.intent === 'logout-pending'
  ) {
    return
  }

  if (
    record.frame.mode === 'logged-out' &&
    record.logoutReceipt?.projectionKind === 'record-only'
  ) {
    // A durable V2 denial is authoritative even if the legacy sidecar failed to publish during
    // logout. On restart, bind the sidecar only from the exact preimage captured by that record;
    // any intervening change remains fail-closed and cannot restore the previous source.
    if (!logoutReceiptBindsMarker(record.logoutReceipt, markerAtEntry))
      throw new SessionAuthorityProjectionIntegrityError('marker')
    const markerRevision = randomUUID()
    const marker: PendingExternalLogoutMarker = {
      intent: { intent: 'logout-pending' },
      revision: markerRevision,
    }
    assertStorageScopeCurrent()
    if (
      !tokenStore.applySessionAuthorityMarkerCas(storageScope, userDataDirectory, envKey, {
        expected: markerAtEntry.marker,
        next: marker,
      })
    )
      throw new SessionAuthorityRecordConflictError()
    const projectedMarker = observeProjectionMarker()
    if (
      projectedMarker.marker?.intent.intent !== 'logout-pending' ||
      projectedMarker.marker.revision !== markerRevision ||
      projectedMarker.rawContents !==
        JSON.stringify({
          version: 1,
          revision: markerRevision,
          intent: 'logout-pending',
        })
    )
      throw new SessionAuthorityProjectionIntegrityError('marker')
    const bound = repository.bindRecordOnlyLogoutToMarker(observation.snapshot, markerAtEntry, {
      markerRevision,
      markerDigest: projectedMarker.rawDigest,
    })
    committed(bound)
    return
  }

  if (
    logoutMarkerWasDurablySuperseded ||
    (record.frame.mode === 'logged-out' &&
      markerAtEntry.marker?.intent.intent === 'logout-pending' &&
      !logoutReceiptMatchesMarker) ||
    (record.projectionIntent === null &&
      record.frame.mode !== 'logged-out' &&
      record.projectionReceipt !== null &&
      !acceptedProjectionMatchesMarker &&
      markerAtEntry.marker?.intent.intent === 'logout-pending')
  ) {
    let durableMarker = markerAtEntry
    if (durableMarker.marker?.intent.intent !== 'logout-pending')
      throw new SessionAuthorityProjectionIntegrityError('marker')
    if (durableMarker.marker.revision === null) {
      const revision = randomUUID()
      assertStorageScopeCurrent()
      if (
        !tokenStore.applySessionAuthorityMarkerCas(storageScope, userDataDirectory, envKey, {
          expected: durableMarker.marker,
          next: { intent: { intent: 'logout-pending' }, revision },
        })
      )
        throw new SessionAuthorityRecordConflictError()
      durableMarker = observeProjectionMarker()
      if (
        durableMarker.marker?.intent.intent !== 'logout-pending' ||
        durableMarker.marker.revision !== revision
      )
        throw new SessionAuthorityProjectionIntegrityError('marker')
    }
    const logout = repository.commitLogout(observation.snapshot, record.marker?.revision ?? null, {
      operationId: randomUUID(),
      markerRevision: durableMarker.marker.revision!,
      markerDigest: durableMarker.rawDigest,
    })
    committed(logout)
    return
  }

  if (record.logoutReceipt && !logoutReceiptMatchesMarker)
    throw new SessionAuthorityProjectionIntegrityError('marker')
  if (
    intent &&
    ownerTransactionId !== intent.candidateTransactionId &&
    activeAcceptanceTransactions.has(
      acceptanceActivityKey(tokenStore, storageScope, envKey, intent.candidateTransactionId)
    )
  ) {
    // A durable intent with a live same-process owner is not crash residue. Another preflight
    // may observe it, but must not restore its marker before-image or retire its candidate.
    // The owning transaction can still pass its ID from explicit rejection to unwind itself.
    return
  }
  if (intent) {
    const journal = observeLegacyJournal()
    if (journal.status !== 'observed') throw journal.error
    if (!sessionPersistenceLegacySnapshotMatches(intent.legacyJournalReceipt, journal.receipt))
      throw new SessionAuthorityProjectionIntegrityError('journal')

    const marker = observeProjectionMarker()
    const stagedContents = JSON.stringify(intent.stagedMarker)
    if (marker.rawContents === stagedContents) {
      const stagedDigest = createHash('sha256').update(stagedContents).digest('hex')
      assertStorageScopeCurrent()
      if (
        !tokenStore.restoreSessionAuthorityMarkerBeforeImage(
          storageScope,
          userDataDirectory,
          envKey,
          stagedDigest,
          {
            rawContents: intent.beforeMarkerContents,
            rawDigest: intent.beforeMarkerDigest,
            kind: intent.beforeMarkerKind,
            marker: null,
          }
        )
      )
        throw new SessionAuthorityProjectionIntegrityError('marker')
    } else if (
      marker.rawContents !== intent.beforeMarkerContents ||
      marker.rawDigest !== intent.beforeMarkerDigest ||
      marker.kind !== intent.beforeMarkerKind
    ) {
      // A different marker is an independent newer denial. Never restore the before-image over it.
      throw new SessionAuthorityProjectionIntegrityError('marker')
    }

    assertStorageScopeCurrent()
    const repairedMarker = observeProjectionMarker()
    if (
      repairedMarker.rawContents !== intent.beforeMarkerContents ||
      repairedMarker.rawDigest !== intent.beforeMarkerDigest ||
      repairedMarker.kind !== intent.beforeMarkerKind
    )
      throw new SessionAuthorityProjectionIntegrityError('marker')
    observation = repository.observe()
    if (
      observation.status !== 'observed' ||
      observation.record.revision !== record.revision ||
      observation.record.projectionIntent?.operationId !== intent.operationId ||
      observation.record.frame.revision !== intent.expectedFrameRevision
    )
      throw new SessionAuthorityRecordConflictError()
    const candidate = record.candidates.find(
      item => item.transactionId === intent.candidateTransactionId
    )
    if (!candidate) throw new SessionAuthorityRecordConflictError()
    if (candidate.sourceKind === 'memory-only') {
      const completed = repository.completeAbortedAcceptanceProjection(
        observation.snapshot,
        intent.candidateTransactionId
      )
      committed(completed)
      record = completed.record
    } else {
      // Keep the durable intent and candidate denial until exact slot absence is proved. The
      // final CAS retires both together; a crash while cleaning simply retries this lane.
      await cleanAbortedProjectionCandidate(
        tokenStore,
        storageScope,
        repository,
        envKey,
        intent.candidateTransactionId
      )
      const completed = repository.observe()
      if (completed.status !== 'observed')
        throw completed.status === 'transient'
          ? completed.error
          : new SessionAuthorityRecordConflictError()
      if (completed.record.projectionIntent?.operationId === intent.operationId)
        throw new SessionAuthorityRecordConflictError()
      record = completed.record
    }
    observation = repository.observe()
    if (observation.status !== 'observed')
      throw observation.status === 'transient'
        ? observation.error
        : new SessionAuthorityRecordConflictError()
    record = observation.record
  }

  if (record.projectionReceipt) {
    const marker = observeProjectionMarker()
    const journal = observeLegacyJournal()
    if (marker.rawContents !== JSON.stringify(record.projectionReceipt.marker))
      throw new SessionAuthorityProjectionIntegrityError('marker')
    if (journal.status !== 'observed') throw journal.error
    if (
      !sessionPersistenceLegacySnapshotMatches(
        record.projectionReceipt.legacyJournalReceipt,
        journal.receipt
      )
    )
      throw new SessionAuthorityProjectionIntegrityError('journal')
  }

  await reconcileOrphanCandidates(
    tokenStore,
    envKey,
    storageScope,
    repository,
    observeProjectionMarker,
    observeLegacyJournal
  )
  const settled = repository.observe()
  if (settled.status !== 'observed')
    throw settled.status === 'transient' ? settled.error : new SessionAuthorityRecordConflictError()
  if (
    settled.record.frame.mode === 'uninitialized' &&
    settled.record.projectionIntent === null &&
    settled.record.projectionReceipt === null &&
    settled.record.logoutReceipt === null &&
    settled.record.candidates.length === 0
  ) {
    // Leave legacy storage unchanged; only V1 sources can become authority in this client.
  }
}

/**
 * One producer-owned candidate transaction. It persists only into a unique V1 slot and leaves
 * the selected prior source untouched until the record CAS accepts the candidate.
 */
export class SessionAuthorityAcceptanceTransaction {
  readonly transactionId: string
  readonly candidateHash: string
  private snapshot: SessionAuthorityRecordSnapshot
  private recordValue: SessionAuthorityRecord | null
  private source: SessionAuthorityCredentialSource | null = null
  private publicationLease:
    | import('./sessionAuthorityRecord.js').SessionAuthorityCandidatePublicationLease
    | null = null
  private publicationAuthorization:
    | import('./sessionAuthorityRecord.js').SessionAuthorityStorageAuthorization
    | null = null
  private accepted = false
  private acceptanceOutcomeIndeterminate = false
  /** A committed or uncertain profile CAS forbids rejected-candidate source cleanup. */
  private profileSelectionMayHaveCommitted = false
  private closed = false
  private priorSource: SessionAuthorityCredentialSource | null = null
  private restoredToken: string | null = null
  private projectionBeforeImage: PendingExternalLogoutRawObservation | null = null
  private projectionMarker: AcceptancePendingMarker | null = null
  private legacyJournalDirectory: string | null = null
  private activeCandidateKey: string | null = null
  private readonly initialFrame: SessionAuthorityRecord['frame'] | null
  private readonly initialLegacyJournalReceipt: SessionAuthorityLegacyJournalReceipt | null

  private constructor(
    private readonly input: CandidateTransactionInput,
    private readonly lease: SessionAuthorityTransactionLease,
    readonly storageScope: SessionAuthorityStorageScope,
    readonly repository: SessionAuthorityRecordRepository,
    snapshot: SessionAuthorityRecordSnapshot,
    record: SessionAuthorityRecord | null,
    private readonly profileRepository?: SessionAuthorityRecordRepository,
    private profileSnapshot?: SessionAuthorityRecordSnapshot,
    private readonly priorProfileSelection?: SessionAuthorityProfileSelection | null,
    transactionId: string = randomUUID(),
    private readonly restoreExistingPlan?: SessionAuthorityRestoreExistingPlan
  ) {
    this.transactionId = transactionId
    this.snapshot = snapshot
    this.recordValue = record
    this.initialFrame = record?.frame ?? null
    this.initialLegacyJournalReceipt = record?.legacyJournalReceipt ?? null
    this.candidateHash = createHash('sha256').update(input.token).digest('hex')
  }

  static async begin(
    input: CandidateTransactionInput
  ): Promise<SessionAuthorityAcceptanceTransaction> {
    if (!input.token || !input.accountId || !input.envKey)
      throw new Error('A session candidate requires token, account and environment identity')
    const normalizedInput: CandidateTransactionInput = {
      ...input,
      purpose: input.purpose ?? 'authenticated-replacement',
    }
    const lease = normalizedInput.tokenStore.beginSessionAuthorityTransaction()
    try {
      return await normalizedInput.tokenStore.runWithSessionAuthorityTransaction(
        lease,
        async () => {
          const storageScope = await normalizedInput.tokenStore.createSessionAuthorityStorageScope()
          const repository = new SessionAuthorityRecordRepository(
            storageScope,
            normalizedInput.envKey,
            normalizedInput.tokenStore,
            lease
          )
          await reconcileAcceptanceProjection(
            normalizedInput.tokenStore,
            normalizedInput.userDataDirectory,
            normalizedInput.envKey,
            storageScope,
            repository,
            normalizedInput.legacyEnvKeys,
            undefined,
            normalizedInput.legacyNamespaceComplete ?? false
          )
          let observation = repository.observe()
          if (normalizedInput.expectedAuthorityRevision !== undefined) {
            const observedRevision =
              observation.status === 'observed' ? observation.record.revision : null
            if (observedRevision !== normalizedInput.expectedAuthorityRevision)
              throw new SessionAuthorityRecordConflictError()
          }
          if (observation.status === 'absent') {
            committed(repository.initialize(observation.snapshot))
            observation = repository.observe()
          }
          if (observation.status !== 'observed')
            throw observation.status === 'transient'
              ? observation.error
              : observation.status === 'invalid'
                ? observation.error
                : new Error('Session authority record could not be initialized')

          const profileRepository = new SessionAuthorityRecordRepository(
            storageScope,
            PROFILE_SESSION_AUTHORITY_ENV_KEY,
            normalizedInput.tokenStore,
            lease
          )
          const profileObservation = profileRepository.observeProfileSelection()
          if (profileObservation.status !== 'observed')
            throw profileObservation.status === 'transient'
              ? profileObservation.error
              : profileObservation.status === 'invalid'
                ? profileObservation.error
                : new Error('Profile session authority recovery is required')

          const transaction = new SessionAuthorityAcceptanceTransaction(
            normalizedInput,
            lease,
            storageScope,
            repository,
            observation.snapshot,
            observation.record,
            profileRepository,
            profileObservation.snapshot,
            profileObservation.selection
          )
          try {
            await transaction.preparePriorSource()
            transaction.markCandidateActive()
            return transaction
          } catch (error) {
            // `preparePriorSource` may have durably recorded a denial before discovering that
            // the exact journal/marker/complete-transition capacity cannot be proven. No
            // TokenStore write capability has been issued yet, so retire only that exact
            // never-dispatched denial and preserve the selected source and imported V0 snapshot.
            transaction.retireUndispatchedCandidate()
            throw error
          }
        }
      )
    } catch (error) {
      normalizedInput.tokenStore.finishSessionAuthorityTransaction(lease)
      throw error
    }
  }

  /** Reconcile authority and sidecars before startup or login interprets marker policy. */
  static async reconcilePendingAcceptanceProjection(
    tokenStore: TokenStore,
    userDataDirectory: string,
    envKey: string,
    legacyEnvKeys: readonly string[] = [],
    legacyNamespaceComplete = false
  ): Promise<void> {
    const lease = tokenStore.beginSessionAuthorityTransaction()
    try {
      await tokenStore.runWithSessionAuthorityTransaction(lease, async () => {
        const storageScope = await tokenStore.createSessionAuthorityStorageScope()
        const repository = new SessionAuthorityRecordRepository(
          storageScope,
          envKey,
          tokenStore,
          lease
        )
        await reconcileAcceptanceProjection(
          tokenStore,
          userDataDirectory,
          envKey,
          storageScope,
          repository,
          legacyEnvKeys,
          undefined,
          legacyNamespaceComplete
        )
      })
    } finally {
      tokenStore.finishSessionAuthorityTransaction(lease)
    }
  }

  /** Pin and load only a coordinator-selected, already accepted source for cold restore. */
  static async beginRestoreExisting(
    plan: SessionAuthorityRestoreExistingPlan
  ): Promise<SessionAuthorityAcceptanceTransaction> {
    if (!plan.profileRepository || !plan.profileSnapshot || !plan.profileSelection)
      throw new SessionAuthorityRecordConflictError()
    try {
      return await plan.tokenStore.runWithSessionAuthorityTransaction(plan.lease, async () => {
        plan.assertSourceCurrent()
        const token = await plan.readExactSource()
        if (!token) throw new SessionAuthorityRecordConflictError()
        plan.assertSourceCurrent()
        if (!(await plan.verifyExactSource(token))) throw new SessionAuthorityRecordConflictError()
        plan.assertSourceCurrent()
        const input: CandidateTransactionInput = {
          tokenStore: plan.tokenStore,
          userDataDirectory: '',
          envKey: plan.envKey,
          token,
          accountId: plan.source.accountId ?? 'pinned-v0-restore',
          source: plan.source.kind === 'safe-storage' ? 'safe-storage' : 'keytar',
          priorToken: token,
          ownerEpoch: 0,
        }
        const transaction = new SessionAuthorityAcceptanceTransaction(
          input,
          plan.lease,
          plan.storageScope,
          plan.repository,
          plan.snapshot,
          plan.accepted.record,
          plan.profileRepository,
          plan.profileSnapshot,
          plan.profileSelection,
          plan.transactionId,
          plan
        )
        transaction.restoredToken = token
        return transaction
      })
    } catch (error) {
      plan.tokenStore.finishSessionAuthorityTransaction(plan.lease)
      throw error
    }
  }

  get sessionToken(): string {
    if (!this.restoreExistingPlan || this.restoredToken === null)
      throw new Error('This transaction has no pinned restore-existing credential')
    return this.restoredToken
  }

  /** Restore an existing authority receipt without candidate publication or another CAS. */
  async executeRestoreExisting<TIdentity extends { id: string }, TConsumers>(
    effects: SessionAuthorityRestoreEffects<TIdentity, TConsumers>
  ): Promise<{ accepted: SessionAuthorityAcceptedRecord; identity: TIdentity }> {
    const plan = this.restoreExistingPlan
    if (!plan) throw new Error('Candidate acceptance transaction cannot execute a restore')
    let consumers: TConsumers | undefined
    let identity: TIdentity | undefined
    try {
      await effects.assertOwned()
      plan.assertSourceCurrent()
      plan.assertRestoreAllowed?.(this.sessionToken)

      identity = await effects.verifyIdentity()
      await effects.assertOwned()
      if (
        plan.expectedIdentity &&
        (identity.id !== plan.expectedIdentity.userId ||
          (String((identity as { teamId?: unknown }).teamId || '').trim() || null) !==
            plan.expectedIdentity.teamId)
      )
        throw new SessionAuthorityRecordConflictError()
      if (plan.source.accountId !== null && identity.id !== plan.source.accountId)
        throw new SessionAuthorityRecordConflictError()
      if (!(await plan.verifyExactSource(this.sessionToken)))
        throw new SessionAuthorityRecordConflictError()
      plan.assertRestoreAllowed?.(this.sessionToken)
      plan.assertSourceCurrent()

      consumers = await effects.prepareConsumers(identity)
      await effects.assertOwned()
      if (!(await plan.verifyExactSource(this.sessionToken)))
        throw new SessionAuthorityRecordConflictError()
      plan.assertRestoreAllowed?.(this.sessionToken)
      plan.assertSourceCurrent()
      if (!effects.consumersReady(consumers) || !effects.isStillOwned(identity, consumers))
        throw new SessionAuthorityRecordConflictError()
      plan.assertRestoreAllowed?.(this.sessionToken)

      const accepted = plan.accepted
      const publication = effects.preparePublication(accepted, identity, consumers)
      // The reservation is prepared only after every awaited validation and source check.
      // No asynchronous work may occur between this final synchronous owner check and commit.
      plan.assertSourceCurrent()
      plan.assertRestoreAllowed?.(this.sessionToken)
      if (
        !effects.consumersReady(consumers) ||
        !effects.isStillOwned(identity, consumers) ||
        !publication.isCurrent()
      )
        throw new SessionAuthorityRecordConflictError()
      try {
        publication.publish(accepted)
      } catch (error) {
        try {
          effects.onPublicationFailure?.()
        } catch {
          // The authority remains selected; any partial runtime publication must fail closed.
        }
        throw new Error('Accepted session runtime publication failed', { cause: error })
      }
      this.accepted = true
      try {
        await effects.afterPublication?.(identity!, consumers!)
      } catch {
        // Stream restart/notification work is post-publication and cannot undo accepted auth.
      }
      return { accepted, identity }
    } catch (error) {
      if (!this.accepted) {
        if (consumers !== undefined) effects.discardConsumers(consumers)
        await effects.rollbackBeforeAcceptance()
        await effects.onRestoreRejected?.(error, this.sessionToken)
      }
      throw error
    } finally {
      await this.close()
    }
  }

  get currentRecord(): SessionAuthorityRecord {
    return this.record
  }

  private get record(): SessionAuthorityRecord {
    if (!this.recordValue)
      throw new Error('Candidate authority is unavailable to a restore-existing transaction')
    return this.recordValue
  }

  private set record(value: SessionAuthorityRecord) {
    this.recordValue = value
  }

  get priorCredentialSource(): SessionAuthorityCredentialSource | null {
    return this.priorSource
  }

  get priorSourceCleanupPending(): boolean {
    if (!this.priorSource) return false
    return this.record.cleanupDebts.some(debt =>
      sameCredentialSource(debt.source, this.priorSource!)
    )
  }

  get candidateIdentity() {
    this.assertCandidateMode()
    const candidate = this.record.candidates.find(item => item.transactionId === this.transactionId)
    if (!candidate)
      throw new Error('Session candidate is no longer present in its authority record')
    if (candidate.sourceKind === 'memory-only')
      throw new Error('A memory-only candidate has no persisted TokenStore source identity')
    return {
      transactionId: candidate.transactionId,
      candidateHash: candidate.candidateHash,
      source: candidate.sourceKind,
      sourceRef: candidate.sourceRef,
      sourceRevision: candidate.sourceRevision,
      accountId: candidate.accountId,
      envKey: this.input.envKey,
    }
  }

  /** Exact source receipt that this candidate will select if its acceptance CAS wins. */
  get candidateAuthoritySource(): SessionAuthorityCredentialSource | null {
    this.assertCandidateMode()
    return this.source
  }

  get volatileSessionId(): string | null {
    this.assertCandidateMode()
    return (
      this.record.candidates.find(item => item.transactionId === this.transactionId)
        ?.volatileSessionId ?? null
    )
  }

  async publishAndVerify(
    onCleanupFailure?: (error: unknown) => void
  ): Promise<SessionAuthorityCredentialSource | null> {
    this.assertCandidateMode()
    return this.run(async () => {
      await this.assertAcceptancePreflightCurrent()
      if (this.input.source === 'memory-only') {
        const verified = this.repository.verifyCandidate(this.snapshot, this.transactionId)
        committed(verified)
        this.snapshot = verified.snapshot
        this.record = verified.record
        return null
      }
      const publication = this.repository.beginCandidatePublication(
        this.snapshot,
        this.transactionId
      )
      if (publication.status !== 'ready') throw new SessionAuthorityRecordConflictError()
      this.snapshot = publication.snapshot
      this.record = publication.record
      this.publicationLease = publication.lease
      this.publicationAuthorization = publication.authorization

      try {
        const receipt = await this.input.tokenStore.writeSessionTokenCandidate({
          authorization: publication.authorization,
          publicationLease: publication.lease,
          token: this.input.token,
          envKey: this.input.envKey,
          accountId: this.input.accountId,
          transactionId: this.transactionId,
          sourceRef: this.candidateIdentity.sourceRef,
          sourceRevision: this.candidateIdentity.sourceRevision,
          source: this.input.source,
          authorityScope: this.storageScope,
        })
        const published = await this.repository.markCandidatePublished(
          this.snapshot,
          this.transactionId,
          receipt,
          publication.lease
        )
        committed(published)
        this.snapshot = published.snapshot
        this.record = published.record
        this.publicationLease = null
        this.publicationAuthorization = null
        const verified = this.repository.verifyCandidate(this.snapshot, this.transactionId)
        committed(verified)
        this.snapshot = verified.snapshot
        this.record = verified.record
        const candidate = this.record.candidates.find(
          item => item.transactionId === this.transactionId
        )
        if (!candidate?.publishedSource) throw new Error('Verified candidate source is missing')
        const readAuthorization = this.repository.authorizeCandidateSourceRead(
          this.snapshot,
          this.transactionId
        )
        const readBack = await this.input.tokenStore.readSessionTokenCandidate(
          candidate.publishedSource,
          this.transactionId,
          readAuthorization,
          this.storageScope
        )
        if (readBack !== this.input.token)
          throw new Error('Session candidate read-back does not match the candidate token')
        this.source = candidate.publishedSource
        return candidate.publishedSource
      } catch (error) {
        if (this.publicationLease) {
          this.repository.releaseCandidatePublication(this.transactionId, this.publicationLease)
          this.publicationLease = null
          this.publicationAuthorization = null
        }
        try {
          await this.cleanupRejectedCandidate()
        } catch (cleanupError) {
          try {
            onCleanupFailure?.(cleanupError)
          } catch {
            // Reporting a cleanup failure must not replace the candidate publication error.
          }
        }
        throw error
      }
    })
  }

  /**
   * Run the complete persistent-candidate lifecycle. Source publication/read-back, identity
   * validation, gated consumer preparation, ownership revalidation, the durable acceptance CAS,
   * synchronous runtime publication, and exact candidate rollback have one owner here.
   */
  async execute<TIdentity, TConsumers>(
    effects: SessionAuthorityAcceptanceEffects<TIdentity, TConsumers>
  ): Promise<{ accepted: SessionAuthorityAcceptedRecord; identity: TIdentity }> {
    this.assertCandidateMode()
    let consumers: TConsumers | undefined
    let identity: TIdentity | undefined
    let acceptedRecord: SessionAuthorityAcceptedRecord | undefined
    const reportRollbackFailure = (error: unknown) => {
      try {
        effects.onRollbackFailure?.(error)
      } catch {
        // Diagnostic reporting must not change the authentication result.
      }
    }
    try {
      await effects.assertOwned()
      await this.publishAndVerify(reportRollbackFailure)
      await effects.assertOwned()

      identity = await effects.verifyIdentity()
      await effects.assertOwned()

      consumers = await effects.prepareConsumers(identity)
      await effects.assertOwned()
      if (!effects.consumersReady(consumers)) throw new SessionAuthorityRecordConflictError()

      // The compatibility marker and journal receipt are prepared before the final authority
      // CAS. Publication preparation may still fail here; once the CAS commits, the reserved
      // callback must be synchronous and must not perform another persistence operation.
      await this.prepareAcceptanceProjection(() => effects.isStillOwned(identity!, consumers!))
      const publication = effects.preparePublication(identity, consumers)

      acceptedRecord = await this.acceptAndPublish(
        publication,
        identity,
        () => effects.isStillOwned(identity!, consumers!) && effects.consumersReady(consumers!),
        () => {
          try {
            effects.onAcceptancePublicationFailure?.()
          } catch (failure) {
            reportRollbackFailure(failure)
          }
          try {
            effects.discardConsumers(consumers!)
          } catch (failure) {
            reportRollbackFailure(failure)
          }
        }
      )
      // Publication is the acceptance boundary. Best-effort retirement/notification work after
      // it must not turn an already accepted session into a rejected login result.
      try {
        await effects.afterAcceptance?.(acceptedRecord, identity!, consumers!)
      } catch {
        // Post-publication cleanup and notifications cannot reverse accepted authentication.
      }
      return { accepted: acceptedRecord, identity }
    } catch (error) {
      if (!this.accepted) {
        // The profile CAS can select this candidate before its local authority projection
        // finishes. If either CAS committed or may have committed, revoke the prior in-process
        // owner before asynchronous cleanup can yield to consumers.
        if (this.acceptanceOutcomeIndeterminate || this.profileSelectionMayHaveCommitted) {
          try {
            effects.onAcceptanceIndeterminate()
          } catch (failure) {
            reportRollbackFailure(failure)
          }
        }
        if (consumers !== undefined) effects.discardConsumers(consumers)
        if (!this.profileSelectionMayHaveCommitted) {
          await this.reject().catch(reportRollbackFailure)
          await this.authorizePriorConsumerRollback(effects.assertOwned)
          let rollbackCallbackAttempted = false
          try {
            // The ownership assertion above may itself await. Therefore it is only a preflight:
            // exact runtime and durable ownership are checked again in this synchronous section,
            // and the rollback effect runs in the same turn as those final observations. No
            // competing producer can commit LP between the final marker read and consumer restore.
            // A transient preflight read is not itself proof that the prior owner changed; the
            // synchronous exact-frame, journal, marker, and runtime-owner checks decide that.
            this.input.tokenStore.runWithSessionAuthorityTransaction(this.lease, () => {
              // Candidate consumers can be superseded independently from the prior accepted
              // owner's scope. A team-hop candidate losing its staged chat generation must not
              // erase the still-selected prior source; rollback is instead gated by the exact
              // prior runtime owner and scope, plus the durable frame/journal/marker checks below.
              const preparedOwnerStillCurrent =
                effects.isProducerStillCurrent() && effects.isPriorConsumerOwnerCurrent()
              const authorization =
                this.authorizePriorConsumerRollbackSynchronously(preparedOwnerStillCurrent)
              rollbackCallbackAttempted = true
              effects.rollbackBeforeAcceptance(authorization)
            })
          } catch (failure) {
            reportRollbackFailure(failure)
            if (!rollbackCallbackAttempted) {
              try {
                effects.rollbackBeforeAcceptance({ canRestorePriorConsumers: false })
              } catch (rollbackFailure) {
                reportRollbackFailure(rollbackFailure)
              }
            }
          }
        }
      }
      throw error
    } finally {
      await this.close()
    }
  }

  /**
   * A rejected candidate may restore its prior runtime only while the exact accepted frame,
   * marker before-image and legacy-journal snapshot remain current. Any transient, invalid, LP,
   * or changed observation denies restoration; local generation equality alone is insufficient.
   */
  private async authorizePriorConsumerRollback(
    assertOwned: SessionAuthorityAcceptanceEffects<unknown, unknown>['assertOwned']
  ): Promise<boolean> {
    try {
      await assertOwned()
      return true
    } catch {
      // The check is an async preflight only. A failure can be transient; the transaction
      // performs a fresh, synchronous exact-owner check immediately before rollback.
      return false
    }
  }

  /**
   * Revalidate the prior accepted owner synchronously immediately before the caller's
   * non-throwing rollback publication. Keep marker observation last so no await or fallible
   * operation separates a newer deny-only marker from the consumer decision.
   */
  private authorizePriorConsumerRollbackSynchronously(
    producerStillOwned: boolean
  ): SessionAuthorityRollbackAuthorization {
    const denied = { canRestorePriorConsumers: false } as const
    if (
      !producerStillOwned ||
      !this.initialFrame ||
      !this.projectionBeforeImage ||
      !this.legacyJournalDirectory ||
      !this.initialLegacyJournalReceipt
    )
      return denied

    // A single transient read is not proof that the accepted prior owner changed. Reobserve
    // the complete receipt synchronously once while the same authority mutation lease is held.
    // This preserves A after a rejected B when the second observation verifies A, while a
    // concurrently published LP or any changed frame/journal/marker still denies restoration.
    // Repeated transient or invalid observations remain fail-closed.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const current = this.repository.observe()
        if (current.status === 'transient') {
          if (attempt === 0 && isTransientPendingLogoutReadError(current.error)) continue
          return denied
        }
        if (
          current.status !== 'observed' ||
          JSON.stringify(current.record.frame) !== JSON.stringify(this.initialFrame) ||
          current.record.frame.transactionId === this.transactionId
        )
          return denied

        const journal = observeSessionPersistenceLegacySnapshot(
          this.legacyJournalDirectory,
          this.input.envKey
        )
        if (journal.status === 'transient') {
          if (attempt === 0 && isTransientPendingLogoutReadError(journal.error)) continue
          return denied
        }
        if (
          journal.status !== 'observed' ||
          !sessionPersistenceLegacySnapshotMatches(
            this.initialLegacyJournalReceipt,
            journal.receipt
          )
        )
          return denied

        const marker = this.input.tokenStore.observeSessionAuthorityMarkerRaw(
          this.storageScope,
          this.input.userDataDirectory,
          this.input.envKey
        )
        if (
          marker.kind !== this.projectionBeforeImage.kind ||
          marker.rawContents !== this.projectionBeforeImage.rawContents ||
          marker.rawDigest !== this.projectionBeforeImage.rawDigest
        )
          return denied

        return { canRestorePriorConsumers: true }
      } catch (error) {
        if (attempt === 0 && isTransientPendingLogoutReadError(error)) continue
        return denied
      }
    }
    return denied
  }

  /** Commit the source CAS and publish prepared consumers synchronously in the same turn. */
  private async acceptAndPublish(
    publication: SessionAuthorityPublicationReservation,
    identity: unknown,
    isStillOwned: () => boolean,
    onPublicationFailure: () => void
  ): Promise<SessionAuthorityAcceptedRecord> {
    this.assertCandidateMode()
    if (!this.projectionMarker) await this.prepareAcceptanceProjection(isStillOwned)
    return this.run(() => {
      if (!this.source && this.input.source !== 'memory-only')
        throw new Error('A persistent candidate must be published and verified before accept')
      // Recheck producer and staged-consumer ownership inside the serialized authority lane,
      // immediately before the synchronous durable CAS. No await separates this check from
      // the CAS or the caller's synchronous publication callback.
      if (!isStillOwned() || !publication.isCurrent() || !this.acceptanceProjectionStillCurrent())
        throw new SessionAuthorityRecordConflictError()
      const candidate = this.record.candidates.find(
        item => item.transactionId === this.transactionId
      )
      const identityRecord = identity as { id?: unknown; teamId?: unknown }
      const userId =
        typeof identityRecord?.id === 'string' ? identityRecord.id : this.input.accountId
      const teamId =
        typeof identityRecord?.teamId === 'string' && identityRecord.teamId.length > 0
          ? identityRecord.teamId
          : null
      if (
        !this.profileRepository ||
        !this.profileSnapshot ||
        this.priorProfileSelection === undefined ||
        userId !== this.input.accountId
      )
        throw new SessionAuthorityRecordConflictError()
      const selection: SessionAuthorityProfileSelection = {
        revision: randomUUID(),
        state: 'active',
        mode: this.input.source === 'memory-only' ? 'memory-only' : 'persistent',
        sessionGeneration: (this.priorProfileSelection?.sessionGeneration ?? 0) + 1,
        envKey: this.input.envKey,
        userId,
        teamId,
        source: this.input.source === 'memory-only' ? null : this.source,
        // The projection's base revision is stable across the crash window before the
        // per-environment acceptance CAS and is retained in its acceptance receipt afterward.
        authorityRevision:
          this.record.projectionIntent?.baseAuthorityRevision ?? this.record.revision,
        transactionId: this.transactionId,
        volatileSessionId:
          this.input.source === 'memory-only' ? (candidate?.volatileSessionId ?? null) : null,
      }
      const profileResult = this.profileRepository.compareAndSetProfileSelection(
        this.profileSnapshot,
        this.priorProfileSelection?.revision ?? null,
        selection
      )
      if (profileResult.status === 'indeterminate') {
        this.profileSelectionMayHaveCommitted = true
        this.acceptanceOutcomeIndeterminate = true
        throw new SessionAuthorityRecordConflictError()
      }
      committed(profileResult)
      this.profileSelectionMayHaveCommitted = true
      this.profileSnapshot = profileResult.snapshot
      const profileAccepted = {
        record: profileResult.record,
        snapshot: profileResult.snapshot,
        storageScope: this.storageScope,
        repository: this.profileRepository,
      }
      let accepted = {
        record: this.record,
        snapshot: this.snapshot,
        storageScope: this.storageScope,
        repository: this.repository,
      }
      // The profile selector is the single active-session CAS. Per-environment records remain
      // exact source receipts and may be promoted after that boundary; a crash before promotion
      // still restores only the source selected by the profile record.
      try {
        const localResult =
          this.input.source === 'memory-only'
            ? this.repository.acceptCandidate(this.snapshot, this.transactionId, {
                mode: 'memory-only',
                volatileSessionId: candidate?.volatileSessionId ?? '',
              })
            : this.repository.acceptCandidate(this.snapshot, this.transactionId, {
                mode: 'persistent',
                source: this.source!,
                markerIntent: null,
              })
        if (localResult.status === 'committed') {
          this.snapshot = localResult.snapshot
          this.record = localResult.record
          accepted = {
            record: localResult.record,
            snapshot: localResult.snapshot,
            storageScope: this.storageScope,
            repository: this.repository,
          }
        }
      } catch {
        // The global selector already committed the candidate. A stale local receipt cannot
        // undo that decision; the exact selected source remains recoverable from the profile CAS.
        accepted = profileAccepted
      }

      // Do not publish from a stale storage scope or an unlinked local candidate. If the local
      // projection failed, the global selector may still recover it after restart, but only
      // while both durable records prove the same exact transaction and source.
      const currentProfile = this.profileRepository.observeProfileSelection()
      const currentLocal = this.repository.observe()
      const selectedCurrent =
        currentProfile.status === 'observed' &&
        JSON.stringify(currentProfile.selection) === JSON.stringify(selection)
      const localProjectionCurrent =
        currentLocal.status === 'observed' &&
        ((currentLocal.record.frame.mode === selection.mode &&
          currentLocal.record.frame.transactionId === this.transactionId &&
          JSON.stringify(currentLocal.record.frame.source) === JSON.stringify(selection.source) &&
          (selection.mode !== 'memory-only' ||
            currentLocal.record.frame.volatileSessionId === selection.volatileSessionId) &&
          currentLocal.record.projectionReceipt?.baseAuthorityRevision ===
            selection.authorityRevision) ||
          (currentLocal.record.projectionIntent?.candidateTransactionId === this.transactionId &&
            currentLocal.record.projectionIntent.baseAuthorityRevision ===
              selection.authorityRevision &&
            currentLocal.record.candidates.some(
              item =>
                item.transactionId === this.transactionId &&
                item.phase === 'verified' &&
                JSON.stringify(item.publishedSource) === JSON.stringify(selection.source)
            )))
      if (!selectedCurrent || !localProjectionCurrent) {
        this.acceptanceOutcomeIndeterminate = true
        throw new SessionAuthorityRecordConflictError()
      }
      this.accepted = true
      try {
        publication.publish(accepted)
      } catch (error) {
        onPublicationFailure()
        throw new Error('Accepted session runtime publication failed', { cause: error })
      }
      return accepted
    })
  }

  /** Exact marker image staged before the final CAS; runtime memory leases pin this receipt. */
  get stagedAcceptanceMarker(): PendingExternalLogoutMarker | null {
    const marker = this.projectionMarker
    if (!marker) return null
    return acceptancePendingExternalMarker(marker)
  }

  private async prepareAcceptanceProjection(isStillOwned: () => boolean): Promise<void> {
    if (this.projectionMarker) return
    const userDataDirectory = this.input.userDataDirectory
    if (!userDataDirectory || !this.projectionBeforeImage || !this.legacyJournalDirectory)
      throw new SessionAuthorityRecordConflictError()
    const journalObservation = observeSessionPersistenceLegacySnapshot(
      this.legacyJournalDirectory,
      this.input.envKey
    )
    if (journalObservation.status !== 'observed') throw journalObservation.error
    const beforeMarker = this.input.tokenStore.observeSessionAuthorityMarkerRaw(
      this.storageScope,
      userDataDirectory,
      this.input.envKey
    )
    const legacyJournalReceipt = this.record.legacyJournalReceipt
    if (
      !legacyJournalReceipt ||
      !sessionPersistenceLegacySnapshotMatches(legacyJournalReceipt, journalObservation.receipt) ||
      beforeMarker.rawContents !== this.projectionBeforeImage.rawContents ||
      beforeMarker.rawDigest !== this.projectionBeforeImage.rawDigest ||
      beforeMarker.kind !== this.projectionBeforeImage.kind
    )
      throw new SessionAuthorityRecordConflictError()
    if (!isStillOwned()) throw new SessionAuthorityRecordConflictError()
    const prepared = this.repository.prepareAcceptanceProjection(
      this.snapshot,
      this.transactionId,
      {
        ownerEpoch: this.input.ownerEpoch,
        beforeMarker,
        legacyJournalReceipt,
      }
    )
    committed(prepared.result)
    this.snapshot = prepared.result.snapshot
    this.record = prepared.result.record
    this.projectionBeforeImage = beforeMarker
    const marker = this.input.tokenStore.stageSessionAuthorityMarker(
      this.storageScope,
      userDataDirectory,
      this.input.envKey,
      beforeMarker,
      prepared.stagedMarker
    )
    if (!marker) throw new SessionAuthorityRecordConflictError()
    this.projectionMarker = marker
  }

  private acceptanceProjectionStillCurrent(): boolean {
    if (!this.projectionMarker) return false
    const marker = this.input.tokenStore.observeSessionAuthorityMarkerRaw(
      this.storageScope,
      this.input.userDataDirectory,
      this.input.envKey
    )
    if (
      marker.marker?.intent.intent !== 'acceptance-pending' ||
      marker.rawContents !== JSON.stringify(this.projectionMarker)
    )
      return false
    if (!this.legacyJournalDirectory) return false
    const journal = observeSessionPersistenceLegacySnapshot(
      this.legacyJournalDirectory,
      this.input.envKey
    )
    if (journal.status !== 'observed') return false
    const intent = this.record.projectionIntent
    return Boolean(
      intent &&
      intent.candidateTransactionId === this.transactionId &&
      sessionPersistenceLegacySnapshotMatches(intent.legacyJournalReceipt, journal.receipt)
    )
  }

  private async assertAcceptancePreflightCurrent(): Promise<void> {
    if (!this.projectionBeforeImage || !this.legacyJournalDirectory)
      throw new SessionAuthorityRecordConflictError()
    const marker = this.input.tokenStore.observeSessionAuthorityMarkerRaw(
      this.storageScope,
      this.input.userDataDirectory,
      this.input.envKey
    )
    const journal = observeSessionPersistenceLegacySnapshot(
      this.legacyJournalDirectory,
      this.input.envKey
    )
    const receipt = this.record.legacyJournalReceipt
    if (journal.status !== 'observed') throw journal.error
    if (
      !receipt ||
      !sessionPersistenceLegacySnapshotMatches(receipt, journal.receipt) ||
      marker.rawContents !== this.projectionBeforeImage.rawContents ||
      marker.rawDigest !== this.projectionBeforeImage.rawDigest ||
      marker.kind !== this.projectionBeforeImage.kind
    )
      throw new SessionAuthorityRecordConflictError()
  }

  private retireUndispatchedCandidate(): void {
    try {
      const observation = this.repository.observe()
      if (observation.status !== 'observed') return
      const candidate = observation.record.candidates.find(
        item => item.transactionId === this.transactionId
      )
      if (!candidate || candidate.phase !== 'denied') return
      const retired = this.repository.retireNeverDispatchedCandidate(
        observation.snapshot,
        this.transactionId
      )
      if (retired.status === 'committed') {
        this.snapshot = retired.snapshot
        this.recordValue = retired.record
      }
    } catch {
      // A failed denial-retirement CAS keeps the candidate denied. It cannot authorize a source,
      // and preserving that denial is safer than masking the original pre-dispatch failure.
    }
  }

  async cleanSupersededSources(): Promise<void> {
    this.assertCandidateMode()
    const supersededSource = this.priorSource
    if (!supersededSource) return
    await this.run(async () => {
      for (const debt of [...this.record.cleanupDebts].filter(item =>
        sameCredentialSource(item.source, supersededSource)
      )) {
        const current = this.requireObservedRecord()
        const liveDebt = current.cleanupDebts.find(item => item.id === debt.id)
        if (!liveDebt) {
          this.record = current
          continue
        }
        const authorization = this.repository.authorizeCleanupDebt(this.snapshot, debt.id)
        const deletion =
          await this.input.tokenStore.deleteSessionCredentialSourceIfUnselectedWithProof(
            debt.source,
            authorization,
            this.storageScope
          )
        if (!deletion.proof) continue
        const retired = this.repository.retireCleanupDebt(this.snapshot, debt.id, deletion.proof)
        if (retired.status === 'committed') {
          this.snapshot = retired.snapshot
          this.record = retired.record
        } else if (retired.status === 'indeterminate') {
          throw new Error('Session source cleanup retirement is indeterminate')
        } else {
          throw new SessionAuthorityRecordConflictError()
        }
      }
    })
  }

  async reject(): Promise<void> {
    this.assertCandidateMode()
    if (this.accepted || this.closed || this.profileSelectionMayHaveCommitted) return
    await this.run(async () => {
      await reconcileAcceptanceProjection(
        this.input.tokenStore,
        this.input.userDataDirectory,
        this.input.envKey,
        this.storageScope,
        this.repository,
        this.input.legacyEnvKeys,
        this.transactionId,
        this.input.legacyNamespaceComplete ?? false
      )
      await this.cleanupRejectedCandidate()
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.activeCandidateKey) {
      activeAcceptanceTransactions.delete(this.activeCandidateKey)
      this.activeCandidateKey = null
    }
    this.input.tokenStore.finishSessionAuthorityTransaction(this.lease)
  }

  private markCandidateActive(): void {
    this.activeCandidateKey = acceptanceActivityKey(
      this.input.tokenStore,
      this.storageScope,
      this.input.envKey,
      this.transactionId
    )
    activeAcceptanceTransactions.add(this.activeCandidateKey)
  }

  private async preparePriorSource(): Promise<void> {
    const current = this.record
    if (current.frame.mode === 'logged-out' || current.marker?.intent === 'logout-pending') {
      if (
        this.input.purpose !== 'fresh-authentication' ||
        (current.frame.mode !== 'logged-out' && current.frame.mode !== 'uninitialized') ||
        this.input.priorToken !== null
      )
        throw new Error('Only fresh account authentication may replace a durable logout fence')
    }

    let priorSource: SessionAuthorityCredentialSource | null = null
    if (current.frame.mode === 'memory-only') {
      const validMemoryFrame =
        Boolean(current.frame.volatileSessionId) &&
        current.marker?.intent === 'memory-only-session' &&
        current.marker.volatileSessionId === current.frame.volatileSessionId &&
        current.marker.revision === current.frame.revision
      const ownsPriorRuntimeLease =
        this.input.purpose === 'authenticated-replacement' &&
        this.input.priorVolatileSessionId === current.frame.volatileSessionId
      const explicitlyReauthenticatingAfterRestart =
        this.input.purpose === 'fresh-authentication' && this.input.priorToken === null
      if (!validMemoryFrame || (!ownsPriorRuntimeLease && !explicitlyReauthenticatingAfterRestart))
        throw new SessionAuthorityRecordConflictError()
    } else if (
      current.frame.mode === 'persistent' &&
      current.frame.source?.format === 'v0' &&
      this.input.purpose === 'fresh-authentication' &&
      this.input.priorToken === null
    ) {
      // Replace a historical authority only after fresh authentication. Never open its credential
      // selector, and do not create cleanup debt for bytes this protocol does not own.
    } else if (
      this.input.source === 'memory-only' &&
      this.input.purpose === 'authenticated-replacement' &&
      current.frame.mode === 'persistent' &&
      current.frame.transactionId !== null &&
      current.frame.source?.format === 'v1'
    ) {
      // The accepted V1 frame is sufficient to fence its exact source when a session moves to M.
      priorSource = current.frame.source
    } else if (current.frame.source?.format === 'v1') {
      const acceptedTransactionId = current.frame.transactionId
      if (!acceptedTransactionId || current.frame.source.envKey !== this.input.envKey)
        throw new SessionAuthorityRecordConflictError()
      const authorization = this.repository.authorizeAcceptedSourceRead(this.snapshot)
      const token = await this.input.tokenStore.readSessionTokenCandidate(
        current.frame.source,
        current.frame.source.transactionId,
        authorization,
        this.storageScope
      )
      if (token !== this.input.priorToken && this.input.priorToken !== null)
        throw new SessionAuthorityRecordConflictError()
      if (this.input.priorToken === null && this.input.purpose !== 'authenticated-replacement')
        throw new SessionAuthorityRecordConflictError()
      priorSource = current.frame.source
    } else if (
      this.input.purpose === 'fresh-authentication' &&
      current.frame.mode === 'logged-out' &&
      current.marker?.intent === 'logout-pending' &&
      this.input.priorToken === null
    ) {
      // A new V1 login replaces only the signed-out authority frame; old credential bytes remain
      // outside the current protocol and are never rediscovered as a prior source.
    } else if (
      current.frame.mode === 'uninitialized' &&
      current.frame.source === null &&
      this.input.priorToken === null
    ) {
      // Fresh authentication establishes the first V1 authority without inspecting legacy stores.
    } else if (
      this.input.source === 'memory-only' &&
      current.frame.mode === 'uninitialized' &&
      current.frame.source === null &&
      current.marker === null &&
      this.input.volatileSessionId !== undefined
    ) {
      // M never reads or writes a persistent bearer.
    } else {
      // A legacy runtime has no accepted V1 source proof and cannot be carried into this protocol.
      throw new SessionAuthorityRecordConflictError()
    }

    this.projectionBeforeImage = this.input.tokenStore.observeSessionAuthorityMarkerRaw(
      this.storageScope,
      this.input.userDataDirectory,
      this.input.envKey
    )
    const prepared = this.repository.prepareCandidate(this.snapshot, {
      transactionId: this.transactionId,
      candidateHash: this.candidateHash,
      accountId: this.input.accountId,
      sourceKind: this.input.source,
      userDataDirectory: this.input.userDataDirectory,
      externalMarkerObservation: this.projectionBeforeImage,
      ...(this.input.volatileSessionId ? { volatileSessionId: this.input.volatileSessionId } : {}),
      ...(this.input.priorVolatileSessionId
        ? { priorVolatileSessionId: this.input.priorVolatileSessionId }
        : {}),
      purpose: this.input.purpose,
      priorSource,
    })
    committed(prepared)
    this.snapshot = prepared.snapshot
    this.record = prepared.record
    this.priorSource = priorSource
    this.legacyJournalDirectory = this.input.tokenStore.resolveSessionAuthorityStorageScope(
      this.storageScope
    )
    const journal = observeSessionPersistenceLegacySnapshot(
      this.legacyJournalDirectory,
      this.input.envKey
    )
    if (
      journal.status !== 'observed' ||
      !this.record.legacyJournalReceipt ||
      !sessionPersistenceLegacySnapshotMatches(this.record.legacyJournalReceipt, journal.receipt)
    )
      throw journal.status === 'observed'
        ? new SessionAuthorityRecordConflictError()
        : journal.error
    this.repository.preflightCandidateAcceptanceCapacity(this.snapshot, this.transactionId, {
      ownerEpoch: this.input.ownerEpoch,
      beforeMarker: this.projectionBeforeImage,
    })
  }

  private async cleanupRejectedCandidate(): Promise<void> {
    let observation = this.repository.observe()
    if (observation.status !== 'observed') return
    this.snapshot = observation.snapshot
    this.record = observation.record
    const candidate = this.record.candidates.find(item => item.transactionId === this.transactionId)
    if (!candidate) return
    if (candidate.phase === 'denied') {
      // The repository's exact CAS proves no write capability was issued. A stale or uncertain
      // publication is never retired here; beginCandidatePublication records `writing` first.
      const retired = this.repository.retireNeverDispatchedCandidate(
        this.snapshot,
        this.transactionId
      )
      if (retired.status === 'committed') {
        this.snapshot = retired.snapshot
        this.record = retired.record
      }
      return
    }
    if (candidate.sourceKind === 'memory-only') {
      return
    }
    const claim = this.repository.claimRejectedCandidateCleanup(this.snapshot, this.transactionId)
    if (claim.status !== 'claimed') return
    this.snapshot = claim.snapshot
    this.record = claim.record
    const identity = this.candidateIdentity
    await this.input.tokenStore.discardUnacceptedSessionTokenCandidate(
      identity,
      claim.authorization,
      this.storageScope
    )
    observation = this.repository.observe()
    if (observation.status !== 'observed') return
    this.snapshot = observation.snapshot
    this.record = observation.record
    const proofClaim = this.repository.claimRejectedCandidateCleanup(
      this.snapshot,
      this.transactionId
    )
    if (proofClaim.status !== 'claimed') return
    const absent = await this.input.tokenStore.confirmSessionTokenCandidateSlotAbsent(
      identity,
      proofClaim.authorization,
      this.storageScope
    )
    if (absent.outcome !== 'absent' || !absent.proof) return
    const retired = this.repository.retireProvenUnpublishedCandidate(
      proofClaim.snapshot,
      this.transactionId,
      absent.proof
    )
    if (retired.status === 'committed') {
      this.snapshot = retired.snapshot
      this.record = retired.record
    }
  }

  private requireObservedRecord(): SessionAuthorityRecord {
    const observation = this.repository.observe()
    if (observation.status !== 'observed')
      throw observation.status === 'transient'
        ? observation.error
        : observation.status === 'invalid'
          ? observation.error
          : new SessionAuthorityRecordConflictError()
    if (observation.record.revision !== this.record.revision)
      throw new SessionAuthorityRecordConflictError()
    this.snapshot = observation.snapshot
    return observation.record
  }

  private run<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Session authority transaction is closed'))
    return Promise.resolve(
      this.input.tokenStore.runWithSessionAuthorityTransaction(this.lease, operation)
    )
  }

  private assertCandidateMode(): void {
    if (this.restoreExistingPlan)
      throw new Error('Restore-existing transaction cannot mutate candidate authority')
  }
}

/** @deprecated Test-only compatibility name; production producers use the unified transaction. */
export { SessionAuthorityAcceptanceTransaction as SessionAuthorityCandidateTransaction }

/**
 * Producer-owned logout over the currently selected authority frame. The durable record CAS is
 * the sign-out boundary; deleting selected source bytes is deferred to the exact cleanup debt.
 */
export class SessionAuthorityLogoutTransaction {
  private closed = false
  private logoutCleanupDebtIds: string[] = []
  /**
   * Set as soon as the LP CAS succeeds or has an uncertain outcome. It is an in-memory,
   * deny-only witness: no subsequent marker observation is allowed to erase the possibility
   * that another reader can already see a durable logout intent.
   */
  private logoutMarkerAttempt: {
    beforeImage: PendingExternalLogoutRawObservation
  } | null = null
  readonly operationId = randomUUID()

  private constructor(
    private readonly tokenStore: TokenStore,
    private readonly lease: SessionAuthorityTransactionLease,
    private readonly userDataDirectory: string,
    readonly storageScope: SessionAuthorityStorageScope,
    readonly repository: SessionAuthorityRecordRepository,
    private snapshot: SessionAuthorityRecordSnapshot,
    private record: SessionAuthorityRecord,
    private readonly markerBeforeImage: PendingExternalLogoutRawObservation,
    private readonly alreadyCommitted = false,
    private readonly profileRepository?: SessionAuthorityRecordRepository,
    private profileSnapshot?: SessionAuthorityRecordSnapshot,
    private readonly priorProfileSelection?: SessionAuthorityProfileSelection | null
  ) {}

  static async begin(input: {
    tokenStore: TokenStore
    userDataDirectory: string
    envKey: string
    expectedToken: string | null
    legacyEnvKeys?: readonly string[]
    legacyNamespaceComplete?: boolean
    isStillOwned?: () => boolean
    /** Exact accepted V0 source captured by the current restore/runtime owner. */
    expectedAuthoritySource?: SessionAuthorityCredentialSource
    expectedVolatileSessionId?: string
    cleanupOnly?: boolean
    /** Synchronously revoke the in-process runtime once unframed LP is durably staged. */
    onLogoutIntentStaged?: () => void
  }): Promise<SessionAuthorityLogoutTransaction | null> {
    const lease = input.tokenStore.beginSessionAuthorityTransaction()
    let transferred = false
    try {
      const transaction = await input.tokenStore.runWithSessionAuthorityTransaction(
        lease,
        async () => {
          const storageScope = await input.tokenStore.createSessionAuthorityStorageScope()
          const repository = new SessionAuthorityRecordRepository(
            storageScope,
            input.envKey,
            input.tokenStore,
            lease
          )
          const profileRepository = new SessionAuthorityRecordRepository(
            storageScope,
            PROFILE_SESSION_AUTHORITY_ENV_KEY,
            input.tokenStore,
            lease
          )
          const profileObservation = profileRepository.observeProfileSelection()
          if (profileObservation.status !== 'observed')
            throw profileObservation.status === 'transient'
              ? profileObservation.error
              : profileObservation.status === 'invalid'
                ? profileObservation.error
                : new SessionAuthorityRecordConflictError()
          const markerBeforeImage = input.tokenStore.observeSessionAuthorityMarkerRaw(
            storageScope,
            input.userDataDirectory,
            input.envKey
          )
          const observation = repository.observe()
          if (observation.status === 'absent') {
            if (input.cleanupOnly) return null
            return await this.beginUnframedLogout(
              input,
              lease,
              storageScope,
              repository,
              observation.snapshot,
              undefined,
              profileRepository,
              profileObservation.snapshot,
              profileObservation.selection
            )
          }
          if (observation.status !== 'observed') {
            if (observation.status === 'transient') throw observation.error
            if (observation.status === 'invalid')
              throw new SessionAuthorityLogoutPreflightError('invalid-authority', observation.error)
            throw new SessionAuthorityLogoutPreflightError('recovery-fenced')
          }

          const { record, snapshot } = observation
          const selectedProfile = profileObservation.selection
          const observedLogoutRecovery =
            markerBeforeImage.marker?.intent.intent === 'logout-pending' &&
            markerBeforeImage.marker.revision !== null &&
            selectedProfile?.state === 'active' &&
            selectedProfile.envKey === input.envKey &&
            selectedProfile.transactionId === record.frame.transactionId &&
            selectedProfile.mode === record.frame.mode &&
            JSON.stringify(selectedProfile.source) === JSON.stringify(record.frame.source) &&
            ((record.frame.mode === 'persistent' &&
              record.frame.source !== null &&
              input.expectedAuthoritySource !== undefined &&
              sameCredentialSource(record.frame.source, input.expectedAuthoritySource) &&
              repository.isAcceptedSourceCurrent(
                snapshot,
                record.frame.source,
                record.frame.transactionId ?? ''
              )) ||
              (record.frame.mode === 'memory-only' &&
                input.expectedVolatileSessionId !== undefined &&
                input.expectedVolatileSessionId === record.frame.volatileSessionId))
          if (record.frame.mode === 'uninitialized') {
            if (input.cleanupOnly) return null
            if (
              record.projectionIntent !== null ||
              record.projectionReceipt !== null ||
              record.logoutReceipt !== null ||
              record.candidates.length !== 0 ||
              record.cleanupDebts.length !== 0 ||
              record.frame.source !== null
            )
              throw new SessionAuthorityRecordConflictError()
            return await this.beginUnframedLogout(
              input,
              lease,
              storageScope,
              repository,
              snapshot,
              markerBeforeImage,
              profileRepository,
              profileObservation.snapshot,
              profileObservation.selection
            )
          }
          if (input.cleanupOnly) {
            const receipt = record.logoutReceipt
            if (
              record.frame.mode !== 'logged-out' ||
              record.marker?.intent !== 'logout-pending' ||
              !receipt ||
              !logoutReceiptBindsMarker(receipt, markerBeforeImage)
            )
              return null
            const transaction = new SessionAuthorityLogoutTransaction(
              input.tokenStore,
              lease,
              input.userDataDirectory,
              storageScope,
              repository,
              snapshot,
              record,
              markerBeforeImage,
              true,
              profileRepository,
              profileObservation.snapshot,
              profileObservation.selection
            )
            transaction.logoutCleanupDebtIds = receipt.cleanupDebtIds.filter(id =>
              record.cleanupDebts.some(debt => debt.id === id)
            )
            return transaction
          }
          if (record.frame.mode === 'logged-out') throw new SessionAuthorityRecordConflictError()

          if (record.projectionReceipt) {
            if (
              markerBeforeImage.rawContents !== JSON.stringify(record.projectionReceipt.marker) &&
              !observedLogoutRecovery
            )
              throw new SessionAuthorityProjectionIntegrityError('marker')
          } else if (
            (record.marker === null && markerBeforeImage.marker !== null) ||
            (record.marker !== null &&
              (markerBeforeImage.marker?.revision !== record.marker.revision ||
                JSON.stringify(markerBeforeImage.marker.intent) !==
                  JSON.stringify(record.marker)) &&
              !observedLogoutRecovery)
          ) {
            throw new SessionAuthorityProjectionIntegrityError('marker')
          }

          if (record.frame.mode === 'memory-only') {
            if (
              !input.expectedVolatileSessionId ||
              input.expectedVolatileSessionId !== record.frame.volatileSessionId ||
              record.marker?.intent !== 'memory-only-session' ||
              record.marker.volatileSessionId !== input.expectedVolatileSessionId
            )
              throw new SessionAuthorityRecordConflictError()
          } else {
            if (!record.frame.source || !record.frame.transactionId)
              throw new SessionAuthorityRecordConflictError()
            const source = record.frame.source
            // A normal logout pairs the in-memory token with this exact receipt. Recovery after
            // an already durable LP has no surviving bearer owner; the immutable accepted source
            // receipt is then the only permitted cleanup authority.
            const sourceMatchesRuntimeOwner =
              input.expectedAuthoritySource !== undefined &&
              sameCredentialSource(source, input.expectedAuthoritySource)
            // Logout authorization is established by the already accepted authority frame, not
            // by a fresh native credential read. A locked Keytar must not prevent the durable
            // LP+exact-source-debt transaction that makes local sign-out safe. The runtime owner
            // atomically pairs its token with this exact accepted source descriptor. V1's digest
            // covers the stored secure-storage envelope, so it cannot be recomputed from the
            // plaintext runtime token. The acceptance transaction already verified that envelope
            // before publishing this paired owner. V0 receipts likewise require exact descriptor
            // ownership and never trigger a new source selection here.
            if (
              !sourceMatchesRuntimeOwner ||
              !repository.isAcceptedSourceCurrent(snapshot, source, record.frame.transactionId)
            )
              throw new SessionAuthorityRecordConflictError()
          }

          if (
            selectedProfile?.state !== 'active' ||
            selectedProfile.envKey !== input.envKey ||
            selectedProfile.transactionId !== record.frame.transactionId ||
            selectedProfile.mode !== record.frame.mode ||
            JSON.stringify(selectedProfile.source) !== JSON.stringify(record.frame.source)
          )
            throw new SessionAuthorityRecordConflictError()

          return new SessionAuthorityLogoutTransaction(
            input.tokenStore,
            lease,
            input.userDataDirectory,
            storageScope,
            repository,
            snapshot,
            record,
            markerBeforeImage,
            false,
            profileRepository,
            profileObservation.snapshot,
            profileObservation.selection
          )
        }
      )
      if (!transaction) return null
      transferred = true
      return transaction
    } finally {
      if (!transferred) input.tokenStore.finishSessionAuthorityTransaction(lease)
    }
  }

  private static async beginUnframedLogout(
    input: {
      tokenStore: TokenStore
      userDataDirectory: string
      envKey: string
      legacyEnvKeys?: readonly string[]
      legacyNamespaceComplete?: boolean
      cleanupOnly?: boolean
      onLogoutIntentStaged?: () => void
    },
    lease: SessionAuthorityTransactionLease,
    storageScope: SessionAuthorityStorageScope,
    repository: SessionAuthorityRecordRepository,
    snapshot: SessionAuthorityRecordSnapshot,
    observedMarker?: PendingExternalLogoutRawObservation,
    profileRepository?: SessionAuthorityRecordRepository,
    profileSnapshot?: SessionAuthorityRecordSnapshot,
    priorProfileSelection?: SessionAuthorityProfileSelection | null
  ): Promise<SessionAuthorityLogoutTransaction> {
    if (input.cleanupOnly) throw new SessionAuthorityRecordConflictError()
    let marker =
      observedMarker ??
      input.tokenStore.observeSessionAuthorityMarkerRaw(
        storageScope,
        input.userDataDirectory,
        input.envKey
      )
    if (marker.marker?.intent.intent === 'acceptance-pending')
      throw new SessionAuthorityProjectionIntegrityError('marker')

    if (marker.marker?.intent.intent !== 'logout-pending' || marker.marker.revision === null) {
      const nextMarker = { intent: { intent: 'logout-pending' as const }, revision: randomUUID() }
      if (
        !input.tokenStore.applySessionAuthorityMarkerRawCas(
          storageScope,
          input.userDataDirectory,
          input.envKey,
          marker,
          nextMarker
        )
      )
        throw new SessionAuthorityRecordConflictError()
      marker = input.tokenStore.observeSessionAuthorityMarkerRaw(
        storageScope,
        input.userDataDirectory,
        input.envKey
      )
      if (
        marker.marker?.intent.intent !== 'logout-pending' ||
        marker.marker.revision !== nextMarker.revision
      )
        throw new SessionAuthorityProjectionIntegrityError('marker')
    }

    // The LP is a deny-only fence until the complete source inventory, immutable V0 journal
    // snapshot, and exact-source debt all make it into a verified V2 logged-out frame. Revoking
    // this runtime now prevents requests from continuing while that reconciliation awaits I/O.
    input.onLogoutIntentStaged?.()
    await reconcileAcceptanceProjection(
      input.tokenStore,
      input.userDataDirectory,
      input.envKey,
      storageScope,
      repository,
      input.legacyEnvKeys,
      undefined,
      input.legacyNamespaceComplete ?? false
    )

    const settled = repository.observe()
    const verifiedMarker = input.tokenStore.observeSessionAuthorityMarkerRaw(
      storageScope,
      input.userDataDirectory,
      input.envKey
    )
    if (
      settled.status !== 'observed' ||
      settled.record.frame.mode !== 'logged-out' ||
      !settled.record.logoutReceipt ||
      !logoutReceiptBindsMarker(settled.record.logoutReceipt, marker) ||
      verifiedMarker.rawContents !== marker.rawContents ||
      verifiedMarker.rawDigest !== marker.rawDigest
    )
      throw new SessionAuthorityProjectionIntegrityError('authority')

    return new SessionAuthorityLogoutTransaction(
      input.tokenStore,
      lease,
      input.userDataDirectory,
      storageScope,
      repository,
      settled.snapshot,
      settled.record,
      verifiedMarker,
      true,
      profileRepository,
      profileSnapshot,
      priorProfileSelection
    )
  }

  commit(isStillOwned: () => boolean): Promise<SessionAuthorityRecord> {
    return this.run(async () => {
      if (!isStillOwned()) throw new SessionAuthorityRecordConflictError()
      const current = this.repository.observe()
      if (current.status !== 'observed')
        throw current.status === 'transient'
          ? current.error
          : current.status === 'invalid'
            ? current.error
            : new SessionAuthorityRecordConflictError()
      if (current.record.revision !== this.record.revision)
        throw new SessionAuthorityRecordConflictError()
      const priorCleanupDebtIds = new Set(current.record.cleanupDebts.map(debt => debt.id))
      const currentMarker = this.tokenStore.observeSessionAuthorityMarkerRaw(
        this.storageScope,
        this.userDataDirectory,
        this.record.envKey
      )
      if (
        currentMarker.rawContents !== this.markerBeforeImage.rawContents ||
        currentMarker.rawDigest !== this.markerBeforeImage.rawDigest ||
        currentMarker.kind !== this.markerBeforeImage.kind
      )
        throw new SessionAuthorityRecordConflictError()

      if (this.alreadyCommitted) {
        if (
          current.record.frame.mode !== 'logged-out' ||
          !current.record.logoutReceipt ||
          !logoutReceiptBindsMarker(current.record.logoutReceipt, currentMarker)
        )
          throw new SessionAuthorityRecordConflictError()
        this.snapshot = current.snapshot
        this.record = current.record
        this.commitProfileSignedOutIfStillSelected()
        return current.record
      }

      const markerRevision = randomUUID()
      const nextMarker: PendingExternalLogoutMarker = {
        intent: { intent: 'logout-pending' },
        revision: markerRevision,
      }
      let projected: PendingExternalLogoutRawObservation
      let markerCasLost = false
      try {
        const applied = this.tokenStore.applySessionAuthorityMarkerCas(
          this.storageScope,
          this.userDataDirectory,
          this.record.envKey,
          { expected: this.markerBeforeImage.marker, next: nextMarker }
        )
        if (!applied) {
          markerCasLost = true
          throw new SessionAuthorityRecordConflictError()
        }
        this.logoutMarkerAttempt = { beforeImage: this.markerBeforeImage }
        projected = this.tokenStore.observeSessionAuthorityMarkerRaw(
          this.storageScope,
          this.userDataDirectory,
          this.record.envKey
        )
      } catch (error) {
        this.logoutMarkerAttempt = { beforeImage: this.markerBeforeImage }
        const observed = this.tokenStore.observeSessionAuthorityMarkerRaw(
          this.storageScope,
          this.userDataDirectory,
          this.record.envKey
        )
        if (
          observed.marker?.intent.intent === 'logout-pending' &&
          observed.marker.revision === markerRevision &&
          observed.rawContents ===
            JSON.stringify({ version: 1, revision: markerRevision, intent: 'logout-pending' })
        ) {
          // A sidecar writer may publish successfully and then report a durability error. Its
          // exact read-back is enough to proceed through the normal projected receipt path.
          projected = observed
        } else if (
          !markerCasLost &&
          sameLogoutMarkerPreimage(
            {
              kind: this.markerBeforeImage.kind,
              revision: this.markerBeforeImage.marker?.revision ?? null,
              digest: this.markerBeforeImage.rawDigest,
            },
            observed
          )
        ) {
          // If the legacy sidecar is provably unchanged, the protected V2 record can independently
          // commit LP plus exact source debt. This is durable logout, not a claim that sidecar
          // publication or physical credential cleanup succeeded.
          if (!isStillOwned()) throw new SessionAuthorityRecordConflictError()
          const result = this.repository.commitLogoutRecordOnly(
            this.snapshot,
            this.record.marker?.revision ?? null,
            this.markerBeforeImage,
            this.operationId
          )
          committed(result)
          this.snapshot = result.snapshot
          this.record = result.record
          this.logoutCleanupDebtIds = result.record.cleanupDebts
            .filter(debt => !priorCleanupDebtIds.has(debt.id))
            .map(debt => debt.id)
          this.commitProfileSignedOutIfStillSelected()
          return result.record
        } else {
          throw error
        }
      }
      if (
        projected.marker?.intent.intent !== 'logout-pending' ||
        projected.marker.revision !== markerRevision ||
        projected.rawContents !==
          JSON.stringify({ version: 1, revision: markerRevision, intent: 'logout-pending' })
      )
        throw new SessionAuthorityProjectionIntegrityError('marker')
      const markerDigest = projected.rawDigest

      const result = this.repository.commitLogout(
        this.snapshot,
        current.record.marker?.revision ?? null,
        {
          operationId: this.operationId,
          markerRevision,
          markerDigest,
        }
      )
      committed(result)
      this.snapshot = result.snapshot
      this.record = result.record
      this.logoutCleanupDebtIds = result.record.cleanupDebts
        .filter(debt => !priorCleanupDebtIds.has(debt.id))
        .map(debt => debt.id)
      this.commitProfileSignedOutIfStillSelected()
      return result.record
    })
  }

  /**
   * Retire the profile-wide selector only after this environment's exact logged-out frame and
   * source debt are durable. A crash before this CAS remains fail-closed because restore also
   * requires the per-environment accepted frame; a newer profile selection wins unchanged.
   */
  private commitProfileSignedOutIfStillSelected(): void {
    const selected = this.priorProfileSelection
    if (
      !this.profileRepository ||
      !this.profileSnapshot ||
      selected?.state !== 'active' ||
      selected.envKey !== this.record.envKey
    )
      return
    const current = this.profileRepository.observeProfileSelection()
    if (current.status !== 'observed')
      throw current.status === 'transient'
        ? current.error
        : new SessionAuthorityRecordConflictError()
    if (JSON.stringify(current.selection) !== JSON.stringify(selected)) return
    const signedOutSelection: SessionAuthorityProfileSelection = {
      revision: randomUUID(),
      state: 'signed-out',
      mode: 'signed-out',
      sessionGeneration: selected.sessionGeneration + 1,
      envKey: null,
      userId: null,
      teamId: null,
      source: null,
      authorityRevision: null,
      transactionId: null,
      volatileSessionId: null,
    }
    const result = this.profileRepository.compareAndSetProfileSelection(
      current.snapshot,
      selected.revision,
      signedOutSelection
    )
    if (result.status === 'indeterminate') {
      const reread = this.profileRepository.observeProfileSelection()
      if (
        reread.status !== 'observed' ||
        JSON.stringify(reread.selection) !== JSON.stringify(signedOutSelection)
      )
        throw new SessionAuthorityRecordConflictError()
      this.profileSnapshot = reread.snapshot
      return
    }
    if (result.status === 'committed') {
      committed(result)
      this.profileSnapshot = result.snapshot
    }
    // A lost CAS means a newer accepted/signed-out profile owner won. This transaction retains
    // authority only for its completed local logout and exact cleanup debt.
  }

  /**
   * A failed logout may preserve the old runtime only when a read proves the marker is still
   * exactly the before-image. Any LP, changed marker, or unreadable marker fails closed. This
   * includes a CAS loss to a newer process's LP, not only this transaction's own revision.
   */
  requiresFailClosedAfterLogoutFailure(): boolean {
    // A newer writer can publish LP after begin() captured this transaction's marker image but
    // before commit() reaches its own CAS preflight. The absence of a local CAS attempt is not
    // evidence that the durable marker stayed unchanged.
    const beforeImage = this.logoutMarkerAttempt?.beforeImage ?? this.markerBeforeImage
    try {
      const currentMarker = this.tokenStore.observeSessionAuthorityMarkerRaw(
        this.storageScope,
        this.userDataDirectory,
        this.record.envKey
      )
      if (currentMarker.marker?.intent.intent === 'logout-pending') return true
      const stillBeforeImage =
        currentMarker.rawContents === beforeImage.rawContents &&
        currentMarker.rawDigest === beforeImage.rawDigest &&
        currentMarker.kind === beforeImage.kind
      return !stillBeforeImage
    } catch {
      return true
    }
  }

  async cleanExactSourceDebts(): Promise<void> {
    await this.run(async () => {
      for (const debtId of this.logoutCleanupDebtIds) {
        const current = this.repository.observe()
        if (current.status !== 'observed')
          throw current.status === 'transient'
            ? current.error
            : current.status === 'invalid'
              ? current.error
              : new SessionAuthorityRecordConflictError()
        this.snapshot = current.snapshot
        this.record = current.record
        const liveDebt = current.record.cleanupDebts.find(item => item.id === debtId)
        if (!liveDebt) continue
        if (this.repository.hasActiveCandidatePublication(current.record)) continue
        let authorization = this.repository.authorizeCleanupDebt(this.snapshot, debtId)
        let deletion: Awaited<
          ReturnType<TokenStore['deleteSessionCredentialSourceIfUnselectedWithProof']>
        >
        try {
          deletion = await this.tokenStore.deleteSessionCredentialSourceIfUnselectedWithProof(
            liveDebt.source,
            authorization,
            this.storageScope
          )
        } catch (error) {
          // A concurrent acceptance can stale the one-use permit before TokenStore reaches the
          // native mutation boundary. Reissue authority only for the same still-unselected debt;
          // this retry performs the single physical deletion attempt.
          if (!(error instanceof SessionAuthorityStorageAuthorizationError)) throw error
          const latest = this.repository.observe()
          if (latest.status !== 'observed')
            throw latest.status === 'transient'
              ? latest.error
              : new SessionAuthorityRecordConflictError()
          this.snapshot = latest.snapshot
          this.record = latest.record
          const latestDebt = latest.record.cleanupDebts.find(item => item.id === debtId)
          if (!latestDebt) continue
          if (!sameCredentialSource(latestDebt.source, liveDebt.source))
            throw new SessionAuthorityRecordConflictError()
          authorization = this.repository.authorizeCleanupDebt(this.snapshot, debtId)
          deletion = await this.tokenStore.deleteSessionCredentialSourceIfUnselectedWithProof(
            latestDebt.source,
            authorization,
            this.storageScope
          )
        }
        if (!deletion.proof) continue
        // Do not mutate the selected authority record while another candidate is publishing.
        // The exact source deletion is already proven; keeping the receipt is safe until that
        // candidate resolves and avoids invalidating its publication lease.
        const retirement = this.repository.retireCleanupDebt(this.snapshot, debtId, deletion.proof)
        if (retirement.status === 'committed') {
          committed(retirement)
          this.snapshot = retirement.snapshot
          this.record = retirement.record
        } else if (retirement.status === 'superseded') {
          const latest = this.repository.observe()
          if (latest.status !== 'observed')
            throw latest.status === 'transient'
              ? latest.error
              : new SessionAuthorityRecordConflictError()
          this.snapshot = latest.snapshot
          this.record = latest.record
          const publicationPending = this.repository.hasActiveCandidatePublication(latest.record)
          if (latest.record.cleanupDebts.some(item => item.id === debtId) && !publicationPending)
            throw new SessionAuthorityRecordConflictError()
        } else {
          throw new SessionAuthorityRecordConflictError()
        }
      }
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.tokenStore.finishSessionAuthorityTransaction(this.lease)
  }

  private run<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Session authority transaction is closed'))
    return Promise.resolve(
      this.tokenStore.runWithSessionAuthorityTransaction(this.lease, operation)
    )
  }
}

export async function readSessionAuthoritySourceSelection(input: {
  tokenStore: TokenStore
  envKey: string
  coordinator?: SessionAuthorityCoordinator
  policy?: import('./sessionAuthorityCoordinator.js').SavedSessionRestorePolicy
}): Promise<SessionAuthoritySourceSelection> {
  let coordinator = input.coordinator
  if (!coordinator) {
    // The marker and authority files share Electron's canonical userData root. Resolve it from
    // the same TokenStore instead of constructing a coordinator with an empty placeholder path;
    // restore must compare the exact marker receipt before trusting a selected source.
    const userDataDirectory = await input.tokenStore.getSessionAuthorityStorageRoot()
    coordinator = new SessionAuthorityCoordinator({
      getTokenStore: () => input.tokenStore,
      getUserDataDirectory: () => userDataDirectory,
      reportDeferredLogoutFailure: () => {},
      failClosedForPendingLogout: async () => {},
    })
  }
  const selection = await coordinator.beginAcceptedSessionRestore(input.envKey, input.policy)
  if (selection.status !== 'accepted') return selection
  if (!selection.plan.accepted) throw new SessionAuthorityRecordConflictError()
  let transaction: SessionAuthorityAcceptanceTransaction | undefined
  try {
    transaction = await SessionAuthorityAcceptanceTransaction.beginRestoreExisting(selection.plan)
    return {
      status: 'accepted',
      session: { accepted: selection.plan.accepted, token: transaction.sessionToken },
    }
  } finally {
    await transaction?.close()
  }
}

export async function readAcceptedSessionAuthoritySource(input: {
  tokenStore: TokenStore
  envKey: string
}): Promise<SessionAuthorityAcceptedSource | null> {
  const selection = await readSessionAuthoritySourceSelection(input)
  return selection.status === 'accepted' ? selection.session : null
}
