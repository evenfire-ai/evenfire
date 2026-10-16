import { getActiveEnvKey, getActiveLegacyEnvKeys } from './config.js'
import {
  isMemoryOnlySessionExpired,
  memoryOnlySessionDeadline,
  memoryOnlySessionReplacementDeadline,
} from './memoryOnlySession.js'
import {
  type PendingExternalLogoutIntent,
  type PendingExternalLogoutMarker,
  isPendingExternalLogoutReadFailure,
  isTransientPendingLogoutReadError,
  observePendingExternalLogoutMarker,
  pendingExternalLogoutMarkersMatch,
  pendingExternalLogoutOwnership,
} from './pendingExternalLogout.js'
import {
  SessionPersistenceCandidateDeniedError,
  SessionPersistenceJournalAdmissionError,
  SessionPersistenceProducer,
  isSessionPersistenceJournalReadFailure,
} from './sessionPersistenceJournal.js'
import {
  type SessionTokenFallbackSnapshot,
  type SessionTokenMutationOptions,
  type SessionTokenMutationSource,
  type SessionTokenReadAuthority,
  type SessionTokenReadOptions,
  type SessionTokenReadSource,
  SessionTokenStorageClearError,
  SessionTokenStorageSupersededBeforeWriteError,
  SessionTokenStorageUnavailableBeforeWriteError,
  TokenStore,
  focusSessionTokenReadAuthority,
  isSessionTokenFallbackReadFailure,
  isSessionTokenMutationCallbackFailure,
  isSessionTokenReadAuthorityCurrent,
} from './tokenStore.js'
import type { SessionMe } from './types.js'

export type SessionPersistenceSourceReceipt = {
  envKey: string
  marker: PendingExternalLogoutMarker | null
  credentialSource: 'active-keytar' | 'safe-storage' | 'isolated-development'
  fallbackSnapshot?: SessionTokenFallbackSnapshot
  producer: SessionPersistenceProducer
  owner: { generation: number; token: string | null }
  selectedSource: VerifiedSessionTokenSource
  publications: Map<SessionTokenReadSource, VerifiedSessionTokenSource>
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
}

export type MemoryOnlySessionMarker = Omit<PendingExternalLogoutMarker, 'intent'> & {
  intent: Extract<PendingExternalLogoutIntent, { intent: 'memory-only-session' }>
}

export type PendingLogoutLoginPlan = {
  intent: PendingExternalLogoutIntent | null
  marker: PendingExternalLogoutMarker | null
  writeKeytar: boolean
  requireSafeStorage: boolean
  retireMarker: boolean
  credentialSource: 'active-keytar' | 'safe-storage' | null
}

export type TeamSessionPersistencePlan = {
  cleanupSource: 'active-keytar' | 'safe-storage' | null
  initialRollbackSource: 'active-keytar' | 'safe-storage' | null
  persistedSource: 'active-keytar' | 'safe-storage' | 'isolated-development'
}

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

export type PersistentSessionReceipt = SessionPersistenceSourceReceipt & {
  mode: 'persistent'
  token: string
  generation: number
}

export type TemporarySessionReceipt = {
  mode: 'temporary'
  envKey: string
  volatileSessionId: string
  marker: PendingExternalLogoutMarker
  token: string
  generation: number
  expiresAt: number
  previousToken: string
  previousMe: SessionMe
  previousLease: MemoryOnlySessionLease
}

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

export type SessionPersistenceReceipt = PersistentSessionReceipt | TemporarySessionReceipt

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

export function canAdmitMemoryOnlyAfterStorageFailure(error: unknown): boolean {
  const failures = error instanceof AggregateError ? error.errors : [error]
  return !failures.some(
    failure =>
      failure instanceof SessionTokenStorageSupersededBeforeWriteError ||
      failure instanceof SessionPersistenceJournalAdmissionError ||
      failure instanceof SessionPersistenceCandidateDeniedError ||
      isSessionTokenFallbackReadFailure(failure) ||
      isSessionTokenMutationCallbackFailure(failure) ||
      isPendingExternalLogoutReadFailure(failure) ||
      isSessionPersistenceJournalReadFailure(failure) ||
      isTransientPendingLogoutReadError(failure)
  )
}

type SessionAuthorityCoordinatorOptions = {
  getTokenStore: () => TokenStore
  getUserDataDirectory: () => string
  reportDeferredLogoutFailure: (error: unknown) => void
  failClosedForPendingLogout: (error: unknown) => Promise<void>
}

/**
 * Owns main-process session-source identity and the shared authority checks used by every
 * producer. AppService remains the public facade and supplies effect callbacks, but it does
 * not keep a second copy of source/lease state or a separate persistence queue.
 */
export class SessionAuthorityCoordinator {
  private token: string | null = null
  private authenticatedUser: SessionMe | null = null
  private generation = 0
  private acceptedSource: AcceptedSessionTokenSource | undefined
  private memoryLease: MemoryOnlySessionLease | undefined
  private persistenceQueue: Promise<void> = Promise.resolve()

  constructor(private readonly options: SessionAuthorityCoordinatorOptions) {}

  private get tokenStore(): TokenStore {
    return this.options.getTokenStore()
  }

  get sessionToken(): string | null {
    return this.token
  }

  set sessionToken(value: string | null) {
    this.token = value
  }

  get sessionGeneration(): number {
    return this.generation
  }

  set sessionGeneration(value: number) {
    this.generation = value
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

  get memoryOnlySession(): MemoryOnlySessionLease | undefined {
    return this.memoryLease
  }

  set memoryOnlySession(value: MemoryOnlySessionLease | undefined) {
    this.memoryLease = value
  }

  memoryOnlySessionDeadline(token: string, now = Date.now()): number {
    return memoryOnlySessionDeadline(token, now)
  }

  memoryOnlySessionReplacementDeadline(
    currentDeadline: number,
    token: string,
    now = Date.now()
  ): number {
    return memoryOnlySessionReplacementDeadline(currentDeadline, token, now)
  }

  isMemoryOnlySessionExpired(deadline: number, now = Date.now()): boolean {
    return isMemoryOnlySessionExpired(deadline, now)
  }

  isIsolatedDevelopmentStorage(): boolean {
    return this.tokenStore.isIsolatedDevelopmentStorage()
  }

  assertMemoryOnlySessionCurrent(expected = this.memoryLease): void {
    if (!expected || expected !== this.memoryLease) throw new TemporarySessionEndedError()
    if (isMemoryOnlySessionExpired(expected.expiresAt)) throw new TemporarySessionExpiredError()
    if (getActiveEnvKey() !== expected.envKey) throw new TemporarySessionEnvironmentChangedError()
    const ownership = this.inspectOwnership(
      expected.envKey,
      [expected.marker],
      this.sessionToken !== null && this.me !== null
    )
    if (ownership.status === 'transient') throw ownership.error
    if (ownership.status !== 'owned') throw new TemporarySessionAuthorityUnavailableError()
  }

  assertTemporaryRequestAllowed(token: string): void {
    const lease = this.memoryLease
    if (!lease) return
    this.assertMemoryOnlySessionCurrent(lease)
    if (token !== this.sessionToken) throw new TemporarySessionReplacedError()
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
    return (
      isTransientPendingLogoutReadError(error) &&
      (isPendingExternalLogoutReadFailure(error) ||
        isSessionPersistenceJournalReadFailure(error) ||
        isSessionTokenFallbackReadFailure(error))
    )
  }

  unwrapPersistenceAuthorityError(error: unknown): unknown {
    return error instanceof SessionPersistenceJournalAdmissionError &&
      (isPendingExternalLogoutReadFailure(error.cause) ||
        isSessionPersistenceJournalReadFailure(error.cause) ||
        isSessionTokenFallbackReadFailure(error.cause))
      ? error.cause
      : error
  }

  async handlePendingLogoutInspectionFailure(error: unknown): Promise<void> {
    if (error instanceof SessionTokenStorageSupersededBeforeWriteError) return
    if (this.isTransientPersistenceAuthorityRead(error))
      this.reportDeferredLogoutFailureSafely(error)
    else await this.options.failClosedForPendingLogout(error)
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

  async retireRepairedPersistenceProducer(producer: SessionPersistenceProducer): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        producer.repaired()
        return
      } catch (error) {
        if (this.isTransientPersistenceAuthorityRead(error) && attempt < 2) continue
        await this.handlePendingLogoutInspectionFailure(error)
        return
      }
    }
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
      source === 'default' ? ['keytar', 'safe-storage', 'historical-plaintext'] : [source]
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
        ? await this.tokenStore.getKeytarSessionToken(envKey, options)
        : selected!.source === 'safe-storage'
          ? await this.tokenStore.getSafeStorageSessionToken(envKey, options)
          : await this.tokenStore.getSessionToken(envKey, options)
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
        ? await this.tokenStore.getKeytarSessionToken(envKey, options)
        : source === 'safe-storage'
          ? await this.tokenStore.getSafeStorageSessionToken(envKey, options)
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
    return this.tokenStore.getSessionToken(envKey, {
      ...options,
      sourceOrder: ['keytar', 'safe-storage', 'historical-plaintext'],
    })
  }

  readSessionTokenFromSource(
    source: 'active-keytar' | 'safe-storage',
    envKey: string,
    options: SessionTokenReadOptions = {}
  ): Promise<string | null> {
    return source === 'active-keytar'
      ? this.tokenStore.getKeytarSessionToken(envKey, options)
      : this.tokenStore.getSafeStorageSessionToken(envKey, options)
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

  requireSessionPersistenceReceipt(
    receipt: SessionPersistenceReceipt | SessionPersistenceSourceReceipt
  ): void {
    if ('mode' in receipt && receipt.mode === 'temporary') {
      this.assertMemoryOnlySessionCurrent()
      const lease = this.memoryLease
      if (
        !lease ||
        this.sessionGeneration !== receipt.generation ||
        this.sessionToken !== receipt.token ||
        lease.volatileSessionId !== receipt.volatileSessionId ||
        !pendingExternalLogoutMarkersMatch(lease.marker, receipt.marker)
      )
        throw new SessionTokenStorageSupersededBeforeWriteError()
      return
    }
    const persistent = 'mode' in receipt ? receipt : { ...receipt, mode: 'persistent' as const }
    this.requireSessionTokenSourceCurrent(persistent.selectedSource, persistent.envKey, () => {
      const observation = this.inspectOwnership(
        persistent.envKey,
        [persistent.marker],
        getActiveEnvKey() === persistent.envKey &&
          this.sessionToken === persistent.owner.token &&
          this.sessionGeneration === persistent.owner.generation
      )
      if (observation.status === 'transient' || observation.status === 'invalid')
        throw observation.error
      return observation.status === 'owned'
    })
  }

  async verifySessionPersistenceReceipt(
    receipt: SessionPersistenceReceipt | SessionPersistenceSourceReceipt
  ): Promise<void> {
    if ('mode' in receipt && receipt.mode === 'temporary') {
      this.requireSessionPersistenceReceipt(receipt)
      return
    }
    const persistent = 'mode' in receipt ? receipt : { ...receipt, mode: 'persistent' as const }
    await this.verifySessionTokenSource(persistent.selectedSource, persistent.envKey, () => {
      this.requireSessionPersistenceReceipt(receipt)
      return true
    })
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
      const source = intent.credentialSource
      return {
        kind: 'cleanup-source',
        source,
        plan: {
          policy: source === 'active-keytar' ? 'keytar-active-only' : 'safe-storage-only',
          pendingCleanupMarker: marker,
          retireMarkerAfterRestore: false,
        },
      }
    }
    return { kind: 'finalize-logout', marker }
  }

  restorePlanAfterCleanup(
    action: Extract<SavedSessionRestoreAction, { kind: 'cleanup-source' }>,
    cleanupVerified: boolean
  ): SavedSessionRestorePlan {
    return { ...action.plan, retireMarkerAfterRestore: cleanupVerified }
  }

  planFreshLogin(marker: PendingExternalLogoutMarker | null): PendingLogoutLoginPlan | null {
    if (!marker)
      return {
        intent: null,
        marker: null,
        writeKeytar: false,
        requireSafeStorage: false,
        retireMarker: false,
        credentialSource: null,
      }
    const intent = marker.intent
    if (intent.intent === 'memory-only-session' || intent.intent === 'logout-pending')
      return {
        intent,
        marker,
        writeKeytar: true,
        requireSafeStorage: false,
        retireMarker: false,
        credentialSource: 'active-keytar',
      }
    return null
  }

  planTeamSessionPersistence(
    marker: PendingExternalLogoutMarker | null,
    isolatedDevelopment: boolean
  ): TeamSessionPersistencePlan {
    const cleanupSource =
      marker?.intent.intent === 'keytar-cleanup-pending' ? marker.intent.credentialSource : null
    return {
      cleanupSource,
      initialRollbackSource: cleanupSource,
      persistedSource:
        cleanupSource ?? (isolatedDevelopment ? 'isolated-development' : 'active-keytar'),
    }
  }

  loginPlanAfterKeytarCleanup(
    marker: PendingExternalLogoutMarker,
    result: { keytarAvailable: boolean | null; keytarDisabled: boolean }
  ): PendingLogoutLoginPlan {
    if (marker.intent.intent !== 'keytar-cleanup-pending')
      throw new Error('Keytar cleanup login plan requires a cleanup marker')
    const cleanupVerified = result.keytarAvailable || result.keytarDisabled
    return {
      intent: marker.intent,
      marker,
      writeKeytar: result.keytarAvailable === true,
      requireSafeStorage: !result.keytarAvailable,
      retireMarker: cleanupVerified,
      credentialSource:
        marker.intent.credentialSource === 'active-keytar' ? 'active-keytar' : 'safe-storage',
    }
  }

  loginPlanAfterLogoutCleanup(
    marker: PendingExternalLogoutMarker,
    result: { keytarAvailable: boolean | null; keytarDisabled: boolean }
  ): PendingLogoutLoginPlan {
    const cleanupVerified = result.keytarAvailable || result.keytarDisabled
    return {
      intent: marker.intent,
      marker,
      writeKeytar: result.keytarAvailable === true,
      requireSafeStorage: !result.keytarAvailable && !result.keytarDisabled,
      retireMarker: cleanupVerified,
      credentialSource: cleanupVerified ? null : 'safe-storage',
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
        writeKeytar: true,
        requireSafeStorage: false,
        retireMarker: true,
        credentialSource: 'active-keytar',
      }
    if (error.canUseFreshActiveKeytarCredential(envKey)) {
      this.reportDeferredLogoutFailureSafely(error)
      return {
        intent: marker.intent,
        marker,
        writeKeytar: true,
        requireSafeStorage: false,
        retireMarker: false,
        credentialSource: 'active-keytar',
      }
    }
    if (mode === 'keytar-cleanup' || error.canUseSecureFileFallbackWhileMarkerRemains()) {
      this.reportDeferredLogoutFailureSafely(error)
      return {
        intent: marker.intent,
        marker,
        writeKeytar: false,
        requireSafeStorage: true,
        retireMarker: false,
        credentialSource: 'safe-storage',
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
    }
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
      if (
        receipt &&
        keytarError instanceof SessionTokenStorageUnavailableBeforeWriteError &&
        keytarError.storageSource === 'keytar'
      )
        receipt.keytarUnavailableBeforeWrite = true
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

  createPersistenceProducer(
    directory: string,
    envKey: string,
    marker: PendingExternalLogoutMarker | null,
    requireOwnership: () => void,
    freshAuthentication: boolean,
    priorToken?: string | null,
    requireRuntimeOwnership?: () => void
  ): SessionPersistenceProducer {
    return new SessionPersistenceProducer(
      directory,
      envKey,
      marker,
      requireOwnership,
      error => this.reportDeferredLogoutFailureSafely(error),
      freshAuthentication,
      priorToken,
      requireRuntimeOwnership
    )
  }

  prepareCandidate(
    producer: SessionPersistenceProducer,
    source: SessionTokenMutationSource,
    token: string
  ): void {
    producer.prepare(source, token)
  }

  preparePriorRepair(
    producer: SessionPersistenceProducer,
    source: SessionTokenMutationSource,
    token: string,
    priorToken: string
  ): void {
    producer.preparePriorRepair(source, token, priorToken)
  }

  declarePlannedMarker(
    producer: SessionPersistenceProducer,
    marker: PendingExternalLogoutMarker | null
  ): void {
    producer.declareMarker(marker)
  }

  assertCandidateMayAuthenticate(producer: SessionPersistenceProducer, token: string): void {
    producer.assertMayAuthenticate(token)
  }

  acceptCandidate(producer: SessionPersistenceProducer, token: string): void {
    producer.accept(token)
  }
}
