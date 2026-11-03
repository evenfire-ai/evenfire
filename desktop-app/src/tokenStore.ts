import { app, safeStorage } from 'electron'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  type AcceptancePendingMarker,
  type PendingExternalLogoutCas,
  type PendingExternalLogoutRawObservation,
  applyPendingExternalLogoutCas,
  applyPendingExternalLogoutRawCas,
  observePendingExternalLogoutRaw,
  restoreAcceptanceMarkerBeforeImage,
  stageAcceptancePendingMarker,
} from './pendingExternalLogout.js'
import {
  renameSessionAuthorityFileDurablySync,
  retireSessionCredentialFileDurablySync,
} from './sessionAuthorityDurableFileOps.js'
import {
  SessionAuthorityStorageAuthorizationError,
  beginSessionAuthorityCredentialRead,
  cancelSessionAuthorityCredentialRead,
  consumeSessionAuthorityStorageAuthorization,
  finishSessionAuthorityCredentialRead,
  finishSessionAuthorityStorageAuthorization,
  isSessionAuthorityCandidatePublicationCurrent,
  revalidateSessionAuthorityStorageAuthorization,
} from './sessionAuthorityRecord.js'
import {
  type SessionAuthorityAbsenceEvidence,
  type SessionAuthorityCandidatePublicationLease,
  type SessionAuthorityCredentialReadAuthorization,
  type SessionAuthorityCredentialSource,
  type SessionAuthorityLegacyLocator,
  type SessionAuthorityStorageAuthorization,
} from './sessionAuthorityRecord.js'
import {
  digestSessionAuthoritySource,
  legacySessionCredentialSourceRef,
} from './sessionCredentialSource.js'
import {
  type SessionCredentialSourceKind,
  type SessionCredentialSourceObservation,
  planSessionCredentialSourceRead,
  sessionCredentialSourceReadOrder,
} from './sessionCredentialSource.js'
import {
  type WindowsSessionAuthorityAclEvidence,
  provisionWindowsSessionAuthorityDirectory,
  verifyWindowsSessionAuthorityDirectory,
} from './windowsSessionAuthorityAcl.js'

const SERVICE = 'Evenfire'
const QUALIFIED_LINUX_SAFE_STORAGE_BACKENDS = new Set([
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6',
])

/** `isEncryptionAvailable()` alone accepts Electron's insecure Linux basic_text backend. */
export function isQualifiedSafeStorageAvailable(
  platform: NodeJS.Platform = process.platform
): boolean {
  if (!app?.isReady() || !safeStorage.isEncryptionAvailable()) return false
  if (platform !== 'linux') return platform === 'darwin' || platform === 'win32'
  const backend = (
    safeStorage as typeof safeStorage & { getSelectedStorageBackend?: () => string }
  ).getSelectedStorageBackend?.()
  return typeof backend === 'string' && QUALIFIED_LINUX_SAFE_STORAGE_BACKENDS.has(backend)
}

export type ProviderCapability = 'available' | 'unavailable' | 'unknown'

export function inspectQualifiedSafeStorageCapability(
  platform: NodeJS.Platform = process.platform
): ProviderCapability {
  try {
    if (!app?.isReady()) return 'unknown'
    if (!safeStorage.isEncryptionAvailable()) return 'unavailable'
    if (platform !== 'linux')
      return platform === 'darwin' || platform === 'win32' ? 'available' : 'unknown'
    const getBackend = (
      safeStorage as typeof safeStorage & { getSelectedStorageBackend?: () => string }
    ).getSelectedStorageBackend
    if (!getBackend) return 'unknown'
    const backend = getBackend()
    if (QUALIFIED_LINUX_SAFE_STORAGE_BACKENDS.has(backend)) return 'available'
    if (backend === 'basic_text') return 'unavailable'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Return true only when Electron explicitly reports Linux's unprotected basic_text backend. */
export function isInsecureBasicTextSafeStorageBackend(
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== 'linux' || !app?.isReady()) return false
  try {
    const getBackend = (
      safeStorage as typeof safeStorage & { getSelectedStorageBackend?: () => string }
    ).getSelectedStorageBackend
    return getBackend?.() === 'basic_text'
  } catch {
    return false
  }
}
/**
 * Legacy single global slot (pre per-environment scoping). Read once for a
 * best-effort migration into the active environment's slot, then deleted.
 */
const LEGACY_ACCOUNT = 'session-token'

/**
 * Exact shape emitted by `resolveEnvKey` (config.ts): a `[a-z0-9_]` slug, a
 * `-` separator, and a 12-hex sha256 suffix. Every call site feeds `envKey`
 * straight into keychain account names and on-disk file names, so validate the
 * shape before interpolating — defense in depth mirroring the
 * `assertSafeFilesystemSegment` guard in chatStore/chatStoreBinding. Today all callers
 * pass sanitized `getActiveEnvKey()` output, so a mismatch signals a bug (or a
 * tampered value), never a normal input.
 */
const ENV_KEY_SHAPE = /^[a-z0-9_]+-[0-9a-f]{12}$/
const SOURCE_UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type SessionTokenEnvelopeV1 = {
  format: 'evenfire-session-token'
  version: 1
  transactionId: string
  sourceRef: string
  sourceRevision: string
  envKey: string
  accountId: string
  sessionToken: string
}
type VersionedSessionCredentialSource = Extract<SessionAuthorityCredentialSource, { format: 'v1' }>

export type LegacySessionCredentialSourceObservation = {
  sources: SessionAuthorityCredentialSource[]
  candidates: LegacySessionCredentialSourceCandidate[]
  /** False means at least one legacy source family could not be observed. */
  complete: boolean
  unavailableSources: Array<'keytar'>
}

declare const legacySourceInventoryBrand: unique symbol
export type LegacySessionCredentialSourceInventory = LegacySessionCredentialSourceObservation & {
  readonly [legacySourceInventoryBrand]: never
}

export type LegacySessionCredentialSourceCandidate = {
  /** Legacy environment slot inspected; null identifies the pre-scoping global slot. */
  scopeEnvKey: string | null
  source: Extract<SessionAuthorityCredentialSource, { format: 'v0' }>
}

declare const selectedLegacyCredentialProofBrand: unique symbol
/** Exact V0 source selected by a real TokenStore read, not inferred from token equality. */
export type SelectedLegacySessionCredentialSource = {
  readonly source: Extract<SessionAuthorityCredentialSource, { format: 'v0' }>
  readonly inventory: LegacySessionCredentialSourceInventory
  readonly [selectedLegacyCredentialProofBrand]: never
}

export type LegacySessionCredentialReadResult =
  | { status: 'present'; token: string }
  | { status: 'absent' | 'unavailable' | 'changed' }

export type SessionTokenCandidateCleanupResult = 'deleted' | 'already-absent' | 'different-value'

declare const sessionTokenAbsenceProofBrand: unique symbol
export type SessionTokenAbsenceProof = {
  readonly [sessionTokenAbsenceProofBrand]: never
}

declare const sessionAuthorityStorageScopeBrand: unique symbol
export type SessionAuthorityStorageScope = {
  readonly [sessionAuthorityStorageScopeBrand]: never
}

declare const sessionAuthorityTransactionLeaseBrand: unique symbol
export type SessionAuthorityTransactionLease = {
  readonly [sessionAuthorityTransactionLeaseBrand]: never
}

type SessionAuthorityTransactionLeaseContents = {
  issuer: object
  completion: Promise<void>
  finish: () => void
  active: boolean
}
const sessionAuthorityTransactionLeases = new WeakMap<
  object,
  SessionAuthorityTransactionLeaseContents
>()

declare const sessionTokenCandidatePublicationReceiptBrand: unique symbol
export type SessionTokenCandidatePublicationReceipt = {
  readonly [sessionTokenCandidatePublicationReceiptBrand]: never
  /** Exact source descriptor for diagnostics/tests; only the opaque receipt is acceptance proof. */
  readonly source: SessionAuthorityCredentialSource
}

type StorageRootIdentity = { dev: number; ino: number; uid: number | null }
type SessionAuthorityDirectoryIdentity = { dev: number; ino: number }
type CandidatePublicationContents = {
  issuer: object
  storageRoot: string
  rootIdentity: StorageRootIdentity
  transactionId: string
  candidateHash: string
  source: SessionAuthorityCredentialSource
}

const absenceProofs = new WeakMap<
  object,
  {
    issuer: object
    storageRoot: string
    rootIdentity: StorageRootIdentity
    evidence: SessionAuthorityAbsenceEvidence
  }
>()
const candidatePublicationReceipts = new WeakMap<object, CandidatePublicationContents>()
const legacyCredentialObservations = new WeakMap<
  object,
  { issuer: object; storageRoot: string; rootIdentity: StorageRootIdentity }
>()
const legacySourceInventories = new WeakMap<
  object,
  {
    issuer: object
    storageRoot: string
    rootIdentity: StorageRootIdentity
    envKey: string
    candidates: readonly LegacySessionCredentialSourceCandidate[]
    complete: boolean
    consumed: boolean
  }
>()
const authorityStorageScopes = new WeakMap<
  object,
  {
    issuer: object
    storageRoot: string
    rootIdentity: StorageRootIdentity
    authorityDirectory: string
    authorityDirectoryIdentity: SessionAuthorityDirectoryIdentity
    windowsAclEvidence?: WindowsSessionAuthorityAclEvidence
  }
>()

function issueAbsenceProof(
  issuer: object,
  storageRoot: string,
  rootIdentity: StorageRootIdentity,
  evidence: SessionAuthorityAbsenceEvidence
): SessionTokenAbsenceProof {
  const proof = Object.freeze({}) as SessionTokenAbsenceProof
  absenceProofs.set(proof, {
    issuer,
    storageRoot,
    rootIdentity,
    evidence: JSON.parse(JSON.stringify(evidence)) as SessionAuthorityAbsenceEvidence,
  })
  return proof
}

function storageRootIdentity(stat: fsSync.Stats): StorageRootIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    uid: typeof stat.uid === 'number' ? stat.uid : null,
  }
}

function sameStorageRootIdentity(left: StorageRootIdentity, right: StorageRootIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
}

/** Windows realpath APIs may return distinct long-name aliases for the same directory. */
function sameStorageRootPath(left: string, right: string): boolean {
  if (process.platform !== 'win32') return left === right
  try {
    const leftStat = fsSync.lstatSync(left)
    const rightStat = fsSync.lstatSync(right)
    return (
      leftStat.isDirectory() &&
      !leftStat.isSymbolicLink() &&
      rightStat.isDirectory() &&
      !rightStat.isSymbolicLink() &&
      sameStorageRootIdentity(storageRootIdentity(leftStat), storageRootIdentity(rightStat))
    )
  } catch {
    return false
  }
}

/** Resolve only proofs issued by TokenStore after its exact native/file operation completed. */
function resolveSessionTokenAbsenceProof(
  proof: unknown,
  issuer: object,
  storageScope: SessionAuthorityStorageScope
): SessionAuthorityAbsenceEvidence | null {
  if (typeof proof !== 'object' || proof === null) return null
  const issued = absenceProofs.get(proof)
  const scope = authorityStorageScopes.get(storageScope as object)
  if (
    !issued ||
    issued.issuer !== issuer ||
    !scope ||
    scope.issuer !== issuer ||
    scope.storageRoot !== issued.storageRoot ||
    !sameStorageRootIdentity(scope.rootIdentity, issued.rootIdentity)
  )
    return null
  absenceProofs.delete(proof)
  return JSON.parse(JSON.stringify(issued.evidence)) as SessionAuthorityAbsenceEvidence
}

export type SessionTokenCandidateIdentity = {
  transactionId: string
  sourceRef: string
  sourceRevision: string
  envKey: string
  accountId: string
  candidateHash: string
  source: 'keytar' | 'safe-storage'
}

function candidateAccountFor(envKey: string, sourceRef: string): string {
  assertEnvKey(envKey)
  if (!SOURCE_UUID_SHAPE.test(sourceRef)) throw new Error('Invalid session source reference')
  return `session-v1:${sourceRef}`
}

function candidateFilePath(storageBase: string, envKey: string, sourceRef: string): string {
  assertEnvKey(envKey)
  if (!SOURCE_UUID_SHAPE.test(sourceRef)) throw new Error('Invalid session source reference')
  return path.join(storageBase, 'sessions', `session-v1-${sourceRef}.enc`)
}

async function ensureVersionedSessionDirectory(
  storageBase: string,
  assertRootCurrent: () => void = () => undefined
): Promise<string> {
  const root = await fs.realpath(storageBase)
  assertRootCurrent()
  const directory = path.join(root, 'sessions')
  let alreadyExisted = true
  try {
    await fs.lstat(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    alreadyExisted = false
  }
  assertRootCurrent()
  if (!alreadyExisted && process.platform === 'win32')
    throw new Error('Windows session authority directory must be ACL-provisioned before use')
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  assertRootCurrent()
  if (!alreadyExisted) await syncDirectory(root)
  const before = await fs.lstat(directory)
  assertRootCurrent()
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    (typeof process.getuid === 'function' && before.uid !== process.getuid())
  )
    throw new Error('Versioned session storage directory is not an owned real directory')
  if ((before.mode & 0o077) !== 0) {
    assertRootCurrent()
    await fs.chmod(directory, 0o700)
  }
  const after = await fs.lstat(directory)
  assertRootCurrent()
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    (after.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && after.uid !== process.getuid())
  )
    throw new Error('Versioned session storage directory failed privacy verification')
  const resolvedDirectory = await fs.realpath(directory)
  assertRootCurrent()
  if (resolvedDirectory !== directory)
    throw new Error('Versioned session storage directory failed privacy verification')
  return directory
}

function assertVersionedSessionPlatform(): void {
  if (!['darwin', 'linux', 'win32'].includes(process.platform))
    throw new Error('Versioned session authority storage is unsupported on this platform')
}

function sameWindowsAuthorityIdentity(
  left: WindowsSessionAuthorityAclEvidence,
  right: WindowsSessionAuthorityAclEvidence
): boolean {
  return (
    left.userSid === right.userSid &&
    left.rootIdentity === right.rootIdentity &&
    left.authorityIdentity === right.authorityIdentity
  )
}

function parseSessionTokenEnvelopeV1(
  value: string,
  expected: Pick<
    SessionTokenEnvelopeV1,
    'transactionId' | 'sourceRef' | 'sourceRevision' | 'envKey' | 'accountId'
  >
): SessionTokenEnvelopeV1 {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Versioned session credential envelope is malformed')
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(',') !==
      'accountId,envKey,format,sessionToken,sourceRef,sourceRevision,transactionId,version'
  )
    throw new Error('Versioned session credential envelope has an invalid shape')
  const envelope = parsed as SessionTokenEnvelopeV1
  if (
    envelope.version !== 1 ||
    envelope.format !== 'evenfire-session-token' ||
    envelope.transactionId !== expected.transactionId ||
    envelope.sourceRef !== expected.sourceRef ||
    envelope.sourceRevision !== expected.sourceRevision ||
    envelope.envKey !== expected.envKey ||
    envelope.accountId !== expected.accountId ||
    typeof envelope.sessionToken !== 'string' ||
    envelope.sessionToken.length === 0
  )
    throw new Error('Versioned session credential envelope does not match its authority receipt')
  // V1 bytes are part of the source receipt and must have exactly one representation. This also
  // rejects duplicate JSON keys (which JSON.parse otherwise silently collapses), reordered
  // fields, whitespace variants and alternative escaping before any authority decision.
  const canonical = JSON.stringify({
    format: envelope.format,
    version: envelope.version,
    transactionId: envelope.transactionId,
    sourceRef: envelope.sourceRef,
    sourceRevision: envelope.sourceRevision,
    envKey: envelope.envKey,
    accountId: envelope.accountId,
    sessionToken: envelope.sessionToken,
  })
  if (canonical !== value)
    throw new Error('Versioned session credential envelope is not canonically encoded')
  return envelope
}

function assertEnvKey(envKey: string): void {
  if (!ENV_KEY_SHAPE.test(envKey)) {
    throw new Error('Invalid envKey: unexpected shape')
  }
}

/**
 * Per-environment keychain account (spec §5.2). Each environment stores/reads
 * its OWN session token, so switching clusters never leaks env A's token into
 * env B. `envKey` is the stable, filesystem/keychain-safe key from
 * `resolveEnvKey`.
 */
function accountFor(envKey: string): string {
  const key = String(envKey || '').trim()
  return key ? `${LEGACY_ACCOUNT}::${key}` : LEGACY_ACCOUNT
}

type KeytarModule = {
  getPassword: (service: string, account: string) => Promise<string | null>
  setPassword: (service: string, account: string, password: string) => Promise<void>
  deletePassword: (service: string, account: string) => Promise<boolean>
}

function isKeytarModule(value: unknown): value is KeytarModule {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<KeytarModule>
  return (
    typeof candidate.getPassword === 'function' &&
    typeof candidate.setPassword === 'function' &&
    typeof candidate.deletePassword === 'function'
  )
}

export type TokenStoreOptions = {
  /**
   * Unpackaged development-isolation contract. The constructor only validates
   * the declared path; every operation verifies the process and actual ready
   * Electron userData directory before touching files. Isolated storage never
   * uses keytar or the shared home-directory fallback.
   */
  isolatedUserDataPath?: string
}

export class SessionTokenStorageClearError extends AggregateError {
  constructor(
    errors: readonly unknown[],
    private readonly failedKeytarAccounts: readonly string[],
    private readonly failedFileCount: number
  ) {
    super(errors, 'Failed to clear session token storage')
    this.name = 'SessionTokenStorageClearError'
  }

  canBeReplacedByFreshLoginCredential(envKey: string): boolean {
    return (
      this.failedKeytarAccounts.length === 1 &&
      this.failedKeytarAccounts[0] === accountFor(envKey) &&
      this.failedFileCount === 0
    )
  }

  canUseSecureFileFallbackWhileMarkerRemains(): boolean {
    return this.failedKeytarAccounts.length > 0 && this.failedFileCount === 0
  }

  canUseFreshActiveKeytarCredential(envKey: string): boolean {
    return (
      this.failedKeytarAccounts.length > 0 &&
      !this.failedKeytarAccounts.includes(accountFor(envKey)) &&
      this.failedFileCount === 0
    )
  }
}

export type StrictSessionTokenClearResult = {
  keytarAvailable: boolean
  /** True when this isolated store is guaranteed never to use a Keytar account. */
  keytarDisabled: boolean
  /** One authoritative classification used by coordinator cleanup decisions. */
  keytarDisposition: 'available' | 'disabled' | 'unavailable'
  /** Conditional rejection cleanup only; availability is not publication ownership. */
  sourceAuthorityVerified?: boolean
}

export function isKeytarCleanupEstablished(
  disposition: StrictSessionTokenClearResult['keytarDisposition']
): boolean {
  return disposition === 'available' || disposition === 'disabled'
}

function keytarClearDisposition(
  keytarAvailable: boolean,
  keytarDisabled: boolean
): StrictSessionTokenClearResult['keytarDisposition'] {
  if (keytarDisabled) return 'disabled'
  return keytarAvailable ? 'available' : 'unavailable'
}

/** Required secure store was unavailable: this API dispatched no credential publication. */
export class SessionTokenStorageUnavailableBeforeWriteError extends Error {
  constructor(readonly storageSource: 'keytar' | 'safe-storage' = 'keytar') {
    super(
      storageSource === 'keytar'
        ? 'Keytar is unavailable during session-token replacement'
        : 'Electron safeStorage is unavailable for session-token fallback'
    )
    this.name = 'SessionTokenStorageUnavailableBeforeWriteError'
  }
}

/** A selected credential source could not be inspected or cleaned; this is not evidence of absence. */
export class SessionTokenSourceUnavailableError extends Error {
  constructor(readonly storageSource: 'keytar' | 'safe-storage') {
    super('The selected session credential source is unavailable')
    this.name = 'SessionTokenSourceUnavailableError'
  }
}

export class SessionTokenProviderStateUnknownError extends Error {
  constructor(readonly storageSource: 'keytar' | 'safe-storage') {
    super('The selected session credential provider state is unknown')
    this.name = 'SessionTokenProviderStateUnknownError'
  }
}

export class SessionAuthorityStorageScopeUnavailableError extends Error {
  constructor() {
    super('Electron is not ready to establish a session authority storage root')
    this.name = 'SessionAuthorityStorageScopeUnavailableError'
  }
}

export class SessionTokenStorageSupersededBeforeWriteError extends Error {
  constructor() {
    super('Session-token mutation was superseded before storage dispatch')
    this.name = 'SessionTokenStorageSupersededBeforeWriteError'
  }
}

/** A candidate write settled after logout or a newer producer revoked its durable owner lease. */
export class SessionTokenCandidatePublicationSupersededError extends Error {
  constructor(readonly mayHavePublished: true) {
    super('Session candidate publication was superseded after storage dispatch')
    this.name = 'SessionTokenCandidatePublicationSupersededError'
  }
}

export type SessionTokenMutationSource = 'keytar' | 'safe-storage' | 'isolated-plaintext'

export type SessionTokenMutationOptions = {
  mayWrite?: () => boolean
  /** Conditional repair only: retain the original candidate's publication identity. */
  candidateAuthority?: SessionTokenReadAuthority
  /** Attempted publication, not persistence or durability success. */
  onMutationDispatched?: (source: SessionTokenMutationSource, candidateToken: string) => void
  /** Own write/repair identity after settlement, including partial failure; not durability proof. */
  onMutationSettled?: (
    source: SessionTokenMutationSource,
    authority: SessionTokenReadAuthority
  ) => void
}

export type SessionTokenReadSource = SessionCredentialSourceKind
export type SessionTokenSourceObservation = SessionCredentialSourceObservation
declare const readAuthorityBrand: unique symbol
/** Process-local publication identity; not a credential or authentication grant. */
export type SessionTokenReadAuthority = { readonly [readAuthorityBrand]: true }
export type SessionTokenReadOptions = SessionTokenMutationOptions & {
  legacyEnvKeys?: readonly string[]
  /** Verification-only selection: never write or retire a legacy credential. */
  allowLegacyMigration?: boolean
  /** Selected active read or completed migration source; authentication still requires verification. */
  onTokenRead?: (source: SessionTokenReadSource, authority: SessionTokenReadAuthority) => void
}

type SourcePublication = { revision: string | null; inFlight: boolean }
type ReadAuthorityScope = { envKey: string; storageBase: string; resources: readonly string[] }
type ReadAuthorityContents = ReadAuthorityScope & {
  observations: ReadonlyMap<string, Readonly<SourcePublication>>
  selectedResource?: string
}
const sourcePublications = new Map<string, SourcePublication>()
const readAuthorities = new WeakMap<SessionTokenReadAuthority, ReadAuthorityContents>()
const selectedLegacyCredentialProofs = new WeakMap<
  object,
  {
    issuer: object
    envKey: string
    source: Extract<SessionAuthorityCredentialSource, { format: 'v0' }>
    inventory: LegacySessionCredentialSourceInventory
    authority: SessionTokenReadAuthority
    selectedResource: string
    consumed: boolean
  }
>()
const nativeResource = (account: string) => `native:${SERVICE}:${account}`
const fileResource = (filePath: string) => `file:${filePath}`

type SourcePublicationCompletion = (() => void) & { publication: SourcePublication }
function beginSourcePublication(resource: string): SourcePublicationCompletion {
  const publication = { revision: randomUUID(), inFlight: true }
  sourcePublications.set(resource, publication)
  return Object.assign(
    () => {
      publication.inFlight = false
    },
    { publication }
  )
}

async function publishSourceMutation<T>(
  resource: string,
  operation: () => Promise<T>,
  options: SessionTokenMutationOptions = {},
  source: SessionTokenMutationSource = 'keytar',
  reportCandidateSettlement = true
): Promise<T> {
  const complete = beginSourcePublication(resource)
  let primaryFailure: unknown
  let failed = false
  try {
    return await operation()
  } catch (error) {
    failed = true
    primaryFailure = error
    throw error
  } finally {
    complete()
    settleOwnSourcePublication(
      options,
      resource,
      complete.publication,
      source,
      failed,
      primaryFailure,
      reportCandidateSettlement
    )
  }
}

function captureReadAuthority(
  scope: ReadAuthorityScope,
  selectedResource?: string
): SessionTokenReadAuthority {
  const authority = Object.freeze({}) as SessionTokenReadAuthority
  readAuthorities.set(authority, {
    ...scope,
    selectedResource,
    observations: new Map(
      scope.resources.map(resource => [
        resource,
        Object.freeze({
          ...(sourcePublications.get(resource) ?? { revision: null, inFlight: false }),
        }),
      ])
    ),
  })
  return authority
}

function hasReadAuthority(
  authority: SessionTokenReadAuthority | undefined,
  resource: string
): boolean {
  const observed = authority && readAuthorities.get(authority)?.observations.get(resource)
  const current = sourcePublications.get(resource) ?? { revision: null, inFlight: false }
  return Boolean(
    observed && !observed.inFlight && !current.inFlight && observed.revision === current.revision
  )
}

function hasCandidateAuthority(
  authority: SessionTokenReadAuthority | undefined,
  envKey: string,
  resource: string
): boolean {
  if (!authority) return true
  const contents = readAuthorities.get(authority)
  return Boolean(
    contents &&
    contents.envKey === envKey &&
    contents.selectedResource &&
    hasReadAuthority(authority, contents.selectedResource) &&
    hasReadAuthority(authority, resource)
  )
}

function activeAuthorityResource(
  contents: ReadAuthorityContents | undefined,
  source: SessionTokenReadSource,
  envKey: string
): string | undefined {
  if (
    !ENV_KEY_SHAPE.test(envKey) ||
    !contents ||
    contents.envKey !== envKey ||
    !path.isAbsolute(contents.storageBase)
  )
    return undefined
  const selectedResource =
    source === 'keytar'
      ? nativeResource(accountFor(envKey))
      : source === 'safe-storage' || source === 'historical-plaintext'
        ? fileResource(
            path.join(
              contents.storageBase,
              `session-token-${envKey}.${source === 'safe-storage' ? 'enc' : 'json'}`
            )
          )
        : undefined
  return selectedResource &&
    contents.resources.includes(selectedResource) &&
    contents.observations.has(selectedResource)
    ? selectedResource
    : undefined
}

/** Pure publication check; selected token and authentication must still be verified by the caller. */
export function isSessionTokenReadAuthorityCurrent(
  authority: SessionTokenReadAuthority | undefined,
  source: SessionTokenReadSource,
  envKey: string
): boolean {
  if (!authority) return false
  const contents = readAuthorities.get(authority)
  const selectedResource = activeAuthorityResource(contents, source, envKey)
  return Boolean(
    selectedResource &&
    contents?.selectedResource === selectedResource &&
    hasReadAuthority(authority, selectedResource)
  )
}

/** Focus original observations only; current publication and exact token still require verification. */
export function focusSessionTokenReadAuthority(
  authority: SessionTokenReadAuthority | undefined,
  source: SessionTokenReadSource,
  envKey: string
): SessionTokenReadAuthority | undefined {
  if (!authority) return undefined
  const selectedResource = activeAuthorityResource(readAuthorities.get(authority), source, envKey)
  return selectedResource ? selectAuthorityResource(authority, selectedResource) : undefined
}

function replaceAuthorityResource(
  authority: SessionTokenReadAuthority,
  resource: string,
  publication?: Readonly<SourcePublication>
): SessionTokenReadAuthority {
  const current = readAuthorities.get(authority)
  if (!current) throw new Error('Session-token read authority is invalid')
  const updated = Object.freeze({}) as SessionTokenReadAuthority
  const observations = new Map(current.observations)
  observations.set(
    resource,
    Object.freeze({
      ...(publication ?? sourcePublications.get(resource) ?? { revision: null, inFlight: false }),
    })
  )
  readAuthorities.set(updated, { ...current, observations })
  return updated
}

function selectAuthorityResource(
  authority: SessionTokenReadAuthority,
  selectedResource: string
): SessionTokenReadAuthority {
  const contents = readAuthorities.get(authority)
  if (!contents) throw new Error('Session-token read authority is invalid')
  const selected = Object.freeze({}) as SessionTokenReadAuthority
  readAuthorities.set(selected, { ...contents, selectedResource })
  return selected
}

type MigrationAuthority = {
  current: SessionTokenReadAuthority
  targets: readonly string[]
  selectedSource?: string
}
const migrationAuthorities = new WeakMap<SessionTokenMutationOptions, MigrationAuthority>()
const mutationAuthorities = new WeakMap<SessionTokenMutationOptions, SessionTokenReadAuthority>()

function advanceOwnMigrationPublication(
  options: SessionTokenMutationOptions,
  resource: string,
  publication?: Readonly<SourcePublication>
): void {
  const migration = migrationAuthorities.get(options)
  if (migration)
    migration.current = replaceAuthorityResource(migration.current, resource, publication)
}

function settleOwnSourcePublication(
  options: SessionTokenMutationOptions,
  resource: string,
  publication: Readonly<SourcePublication>,
  source: SessionTokenMutationSource,
  failed: boolean,
  primaryFailure: unknown,
  reportCandidateSettlement = true
): void {
  advanceOwnMigrationPublication(options, resource, publication)
  let authority = migrationAuthorities.get(options)?.current ?? mutationAuthorities.get(options)
  if (authority) {
    authority = replaceAuthorityResource(authority, resource, publication)
    mutationAuthorities.set(options, authority)
  }
  if (!reportCandidateSettlement || !options.onMutationSettled) return
  try {
    if (!authority) throw new Error('Session-token publication authority is unavailable')
    options.onMutationSettled(source, selectAuthorityResource(authority, resource))
  } catch (error) {
    const failure = failed ? primaryFailure : error
    const branded =
      failure !== null && (typeof failure === 'object' || typeof failure === 'function')
        ? failure
        : new Error('Session-token publication reporting failed')
    mutationCallbackFailures.add(branded)
    throw branded
  }
}

function selectMigrationSource(options: SessionTokenMigrationOptions, resource: string): void {
  const migration = migrationAuthorities.get(options)!
  migration.current = replaceAuthorityResource(migration.current, resource)
  migration.selectedSource = resource
}

function assertMigrationPublicationOwnership(options: SessionTokenMutationOptions): void {
  const migration = migrationAuthorities.get(options)
  if (
    migration &&
    [...migration.targets, ...(migration.selectedSource ? [migration.selectedSource] : [])].some(
      resource => !hasReadAuthority(migration.current, resource)
    )
  )
    throw new SessionTokenStorageSupersededBeforeWriteError()
}

type SessionTokenSelection = { token: string; source: SessionTokenMutationSource }
declare const fallbackSnapshotBrand: unique symbol
export type SessionTokenFallbackSnapshot = { readonly [fallbackSnapshotBrand]: true }
type FallbackSnapshotContents = {
  storageBase: string
  activeEncryptedFilePath: string
  files: readonly { filePath: string; bytes: Buffer | null }[]
}
const fallbackSnapshots = new WeakMap<SessionTokenFallbackSnapshot, FallbackSnapshotContents>()
const mutationCallbackFailures = new WeakSet<object>()
const fallbackReadFailures = new WeakSet<object>()

/** Only the shared regular-file inspection may provide this read-origin receipt. */
export function isSessionTokenFallbackReadFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && fallbackReadFailures.has(error)
}

export function isSessionTokenMutationCallbackFailure(error: unknown): boolean {
  return (
    error !== null &&
    (typeof error === 'object' || typeof error === 'function') &&
    mutationCallbackFailures.has(error)
  )
}

function notifyMutationDispatch(
  options: SessionTokenMutationOptions,
  source: SessionTokenMutationSource,
  candidateToken: string
): void {
  try {
    options.onMutationDispatched?.(source, candidateToken)
  } catch (error) {
    // Preserve object identity without changing frozen errors. Foreign primitive
    // values must not become diagnostic text or expose the candidate's contents.
    const failure =
      error !== null && (typeof error === 'object' || typeof error === 'function')
        ? error
        : new Error('Session-token mutation admission callback failed')
    mutationCallbackFailures.add(failure)
    throw failure
  }
}
type SessionTokenMigrationOptions = SessionTokenReadOptions & {
  mutationObserver: { failed: boolean; error: unknown }
}

function migrationOptions(
  options: SessionTokenReadOptions,
  authority: SessionTokenReadAuthority,
  targets: readonly string[]
): SessionTokenMigrationOptions {
  const mutationObserver = { failed: false, error: undefined as unknown }
  const migration = {
    ...options,
    mutationObserver,
    onMutationDispatched: (source: SessionTokenMutationSource, candidateToken: string) => {
      try {
        options.onMutationDispatched?.(source, candidateToken)
      } catch (error) {
        mutationObserver.failed = true
        mutationObserver.error = error
        throw error
      }
    },
  }
  migrationAuthorities.set(migration, { current: authority, targets })
  return migration
}

function rethrowMigrationError(error: unknown, options: SessionTokenMigrationOptions): void {
  if (isSessionTokenMutationCallbackFailure(error) || isSessionTokenFallbackReadFailure(error))
    throw error
  if (options.mutationObserver.failed) throw options.mutationObserver.error
  rethrowSuperseded(error)
}

function reportSelectedSessionToken(
  token: string,
  source: SessionTokenMutationSource | 'historical-plaintext',
  options: SessionTokenReadOptions,
  authority: SessionTokenReadAuthority
): string {
  if (token)
    options.onTokenRead?.(
      source === 'isolated-plaintext' ? 'historical-plaintext' : source,
      authority
    )
  return token
}

function assertMutationOwnership(options: SessionTokenMutationOptions): void {
  if (options.mayWrite && !options.mayWrite()) {
    throw new SessionTokenStorageSupersededBeforeWriteError()
  }
}

function assertCandidateOrigin(options: SessionTokenMutationOptions): void {
  if (!options.candidateAuthority) return
  const contents = readAuthorities.get(options.candidateAuthority)
  if (
    !contents?.selectedResource ||
    !hasReadAuthority(options.candidateAuthority, contents.selectedResource)
  )
    throw new SessionTokenStorageSupersededBeforeWriteError()
}

function rethrowSuperseded(error: unknown): void {
  if (error instanceof SessionTokenStorageSupersededBeforeWriteError) throw error
}

let keytarImportInFlight: Promise<KeytarModule | null> | undefined
let versionedKeytarImportInFlight: Promise<KeytarModule | null> | undefined

export function isMissingKeytarModule(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  const message = error instanceof Error ? error.message : ''
  return (
    (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') &&
    /(?:package|module) ['"]keytar['"]/.test(message)
  )
}

async function loadVersionedKeytar(): Promise<KeytarModule | null> {
  if (versionedKeytarImportInFlight) return versionedKeytarImportInFlight
  const pending = (async () => {
    try {
      const mod = await import('keytar')
      if (isKeytarModule(mod)) return mod
      const defaultExport = (mod as { default?: unknown }).default
      if (isKeytarModule(defaultExport)) return defaultExport
      throw new SessionTokenProviderStateUnknownError('keytar')
    } catch (error) {
      if (error instanceof SessionTokenProviderStateUnknownError) throw error
      if (isMissingKeytarModule(error)) return null
      throw new SessionTokenProviderStateUnknownError('keytar')
    }
  })()
  versionedKeytarImportInFlight = pending
  try {
    return await pending
  } finally {
    if (versionedKeytarImportInFlight === pending) versionedKeytarImportInFlight = undefined
  }
}

function requireQualifiedSafeStorage(
  storageSource: 'safe-storage',
  operation: 'write' | 'read'
): void {
  const capability = inspectQualifiedSafeStorageCapability()
  if (capability === 'unknown') throw new SessionTokenProviderStateUnknownError(storageSource)
  if (capability === 'unavailable') {
    if (operation === 'write')
      throw new SessionTokenStorageUnavailableBeforeWriteError(storageSource)
    throw new SessionTokenSourceUnavailableError(storageSource)
  }
}

function loadKeytar(): Promise<KeytarModule | null> {
  if (keytarImportInFlight) return keytarImportInFlight
  const pending = loadKeytarOnce()
  keytarImportInFlight = pending
  void pending.then(() => {
    if (keytarImportInFlight === pending) keytarImportInFlight = undefined
  })
  return pending
}

async function loadKeytarOnce(): Promise<KeytarModule | null> {
  try {
    const mod = await import('keytar')
    if (isKeytarModule(mod)) {
      return mod
    }
    const defaultExport = (mod as { default?: unknown }).default
    if (isKeytarModule(defaultExport)) {
      return defaultExport
    }
    return null
  } catch {
    return null
  }
}

async function realPath(value: string): Promise<string> {
  return fs.realpath(value)
}

async function resolvedStorageBase(): Promise<string> {
  const base = app?.isReady() ? app.getPath('userData') : path.join(os.homedir(), '.evenfire')
  await fs.mkdir(base, { recursive: true })
  return base
}

async function encryptedFilePath(envKey: string): Promise<string> {
  const key = String(envKey || '').trim()
  const name = key ? `session-token-${key}.enc` : 'session-token.enc'
  return path.join(await resolvedStorageBase(), name)
}

/** Historical plaintext reads and explicitly isolated development writes only. */
async function plainFilePath(envKey: string): Promise<string> {
  const key = String(envKey || '').trim()
  const name = key ? `session-token-${key}.json` : 'session-token.json'
  return path.join(await resolvedStorageBase(), name)
}

/** Legacy pre-per-env safeStorage file (global slot). */
async function legacyEncryptedFilePath(): Promise<string> {
  return path.join(await resolvedStorageBase(), 'session-token.enc')
}

/** Legacy plain-text fallback file (global slot). */
async function legacyFilePath(): Promise<string> {
  return path.join(await resolvedStorageBase(), 'session-token.json')
}

async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === 'win32')
    throw Object.assign(
      new Error('Windows session files require a native write-through namespace operation'),
      { code: 'ENOTSUP' }
    )
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    handle = await fs.open(directoryPath, 'r')
    await handle.sync()
  } finally {
    await handle?.close()
  }
}

async function retireTokenFileDurably(filePath: string): Promise<void> {
  if (process.platform === 'win32') {
    retireSessionCredentialFileDurablySync(filePath)
    return
  }
  // Preserve the established synchronous source-compare/unlink boundary; only the parent
  // directory flush is asynchronous. Windows uses the native write-through retirement lane.
  fsSync.unlinkSync(filePath)
  await syncDirectory(path.dirname(filePath))
}

const tokenFileMutations = new Map<string, Promise<void>>()
const keytarAccountOperations = new Map<string, Promise<void>>()

/** Native access is ordered across stores by the exact OS-keychain account. */
function accessKeytarAccount<T>(account: string, operation: () => Promise<T>): Promise<T> {
  const key = `${SERVICE}\0${account}`
  const pending = (keytarAccountOperations.get(key) ?? Promise.resolve()).then(operation)
  const settled = pending.then(
    () => undefined,
    () => undefined
  )
  keytarAccountOperations.set(key, settled)
  void settled.then(() => {
    if (keytarAccountOperations.get(key) === settled) keytarAccountOperations.delete(key)
  })
  return pending
}

/** Verify requested cleanup in-lane; conditional mode preserves different native values. */
function clearKeytarAccountStrictly(
  account: string,
  keytarPromise: Promise<KeytarModule | null>,
  options: SessionTokenMutationOptions & {
    onlyIfMatches?: string
    readAuthority?: SessionTokenReadAuthority
    onAuthorityLost?: () => void
  } = {}
): Promise<boolean> {
  return accessKeytarAccount(account, async () => {
    const keytar = await keytarPromise
    assertMutationOwnership(options)
    if (!keytar) return false
    if (options.onlyIfMatches !== undefined) {
      if (!hasReadAuthority(options.readAuthority, nativeResource(account))) {
        options.onAuthorityLost?.()
        return true
      }
      const current = await keytar.getPassword(SERVICE, account)
      assertMutationOwnership(options)
      if (current !== options.onlyIfMatches) return true
    }
    await publishSourceMutation(nativeResource(account), () =>
      keytar.deletePassword(SERVICE, account)
    )
    assertMutationOwnership(options)
    const remaining = await keytar.getPassword(SERVICE, account)
    assertMutationOwnership(options)
    if (
      remaining !== null &&
      (options.onlyIfMatches === undefined || remaining === options.onlyIfMatches)
    )
      throw new Error('Native session token remains after deletion')
    return true
  })
}

function mutateTokenFile<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  return mutateTokenFiles([filePath], operation)
}

/** Reserve every represented path before waiting; disjoint paths remain independent. */
function mutateTokenFiles<T>(
  filePaths: readonly string[],
  operation: () => Promise<T>
): Promise<T> {
  const paths = Array.from(new Set(filePaths))
  const predecessors = paths.map(filePath => tokenFileMutations.get(filePath) ?? Promise.resolve())
  const pending = Promise.all(predecessors).then(operation)
  const settled = pending.then(
    () => undefined,
    () => undefined
  )
  for (const filePath of paths) tokenFileMutations.set(filePath, settled)
  void settled.then(() => {
    for (const filePath of paths)
      if (tokenFileMutations.get(filePath) === settled) tokenFileMutations.delete(filePath)
  })
  return pending
}

function readRegularFallbackFile(filePath: string): Buffer | null {
  let descriptor: number | undefined
  let primaryFailure = false
  try {
    const flags =
      process.platform === 'win32'
        ? fsSync.constants.O_RDONLY
        : fsSync.constants.O_RDONLY | fsSync.constants.O_NONBLOCK | fsSync.constants.O_NOFOLLOW
    descriptor = fsSync.openSync(filePath, flags)
    if (
      !fsSync.fstatSync(descriptor).isFile() ||
      (process.platform === 'win32' && !fsSync.lstatSync(filePath).isFile())
    )
      throw new Error('Session-token fallback is not a regular file')
    return fsSync.readFileSync(descriptor)
  } catch (error) {
    primaryFailure = true
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') {
      if (process.platform === 'win32') {
        try {
          if (!fsSync.lstatSync(filePath).isFile())
            throw new Error('Session-token fallback is not a regular file')
        } catch (inspectionError) {
          if ((inspectionError as NodeJS.ErrnoException)?.code === 'ENOENT') return null
          if (typeof inspectionError === 'object' && inspectionError !== null)
            fallbackReadFailures.add(inspectionError)
          throw inspectionError
        }
      }
      return null
    }
    if (code === 'ELOOP') {
      const invalid = new Error('Session-token fallback is not a regular file')
      fallbackReadFailures.add(invalid)
      throw invalid
    }
    if (typeof error === 'object' && error !== null) fallbackReadFailures.add(error)
    throw error
  } finally {
    if (descriptor !== undefined) {
      try {
        fsSync.closeSync(descriptor)
      } catch (error) {
        if (!primaryFailure) {
          if (typeof error === 'object' && error !== null) fallbackReadFailures.add(error)
          throw error
        }
      }
    }
  }
}

async function writeTokenFileAtomic(
  filePath: string,
  value: string | Uint8Array,
  source: Exclude<SessionTokenMutationSource, 'keytar'>,
  candidateToken: string,
  options: SessionTokenMutationOptions = {}
): Promise<void> {
  return mutateTokenFile(filePath, () =>
    writeTokenFileAtomicOnce(filePath, value, source, candidateToken, options)
  )
}

async function writeTokenFileAtomicOnce(
  filePath: string,
  value: string | Uint8Array,
  source: Exclude<SessionTokenMutationSource, 'keytar'>,
  candidateToken: string,
  options: SessionTokenMutationOptions = {},
  assertStorageRootCurrent: () => void = () => undefined,
  noReplace = false
): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    assertStorageRootCurrent()
    assertMutationOwnership(options)
    handle = await fs.open(temporaryPath, 'w', 0o600)
    assertStorageRootCurrent()
    assertMutationOwnership(options)
    await handle.writeFile(value)
    assertStorageRootCurrent()
    await handle.sync()
    assertStorageRootCurrent()
    await handle.close()
    handle = null
    assertMutationOwnership(options)
    assertMigrationPublicationOwnership(options)
    assertCandidateOrigin(options)
    assertStorageRootCurrent()
    notifyMutationDispatch(options, source, candidateToken)
    const completePublication = beginSourcePublication(fileResource(filePath))
    let failed = false
    let primaryFailure: unknown
    try {
      if (process.platform === 'win32') {
        renameSessionAuthorityFileDurablySync(temporaryPath, filePath, !noReplace)
      } else {
        await fs.rename(temporaryPath, filePath)
        await syncDirectory(path.dirname(filePath))
      }
      assertStorageRootCurrent()
    } catch (error) {
      failed = true
      primaryFailure = error
      throw error
    } finally {
      completePublication()
      settleOwnSourcePublication(
        options,
        fileResource(filePath),
        completePublication.publication,
        source,
        failed,
        primaryFailure
      )
    }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    try {
      assertStorageRootCurrent()
      await fs.rm(temporaryPath, { force: true })
    } catch {
      // Do not follow a replaced userData path while cleaning a temporary publication.
    }
    throw error
  }
}

export class TokenStore {
  private readonly pendingOperations = new Set<Promise<unknown>>()
  private readonly activeAuthorityTransactions = new Map<object, Promise<void>>()
  private readonly proofAuthority = Object.freeze({})
  private readonly authorityTransactionContext =
    new AsyncLocalStorage<SessionAuthorityTransactionLease>()
  private admissionClosed = false

  private trackOperation<T>(operation: () => Promise<T>): Promise<T> {
    const lease = this.authorityTransactionContext.getStore()
    const issuedLease = lease && sessionAuthorityTransactionLeases.get(lease as object)
    const admittedTransaction = issuedLease?.issuer === this.proofAuthority && issuedLease.active
    if (this.admissionClosed && !admittedTransaction) {
      return Promise.reject(new Error('Application is shutting down'))
    }

    const pending = Promise.resolve().then(operation)
    this.pendingOperations.add(pending)
    void pending.then(
      () => this.pendingOperations.delete(pending),
      () => this.pendingOperations.delete(pending)
    )
    return pending
  }

  /** Stop accepting new credential operations for the current quit attempt. */
  private closeAdmission(): void {
    this.admissionClosed = true
  }

  /** Reopen credential operations when Electron cancels the current quit attempt. */
  reopenAdmission(): void {
    this.admissionClosed = false
  }

  /** Reserve producer ownership across asynchronous persistence and consumer preparation. */
  beginSessionAuthorityTransaction(): SessionAuthorityTransactionLease {
    if (this.admissionClosed) throw new Error('Application is shutting down')
    let finish!: () => void
    const completion = new Promise<void>(resolve => {
      finish = resolve
    })
    const lease = Object.freeze({}) as SessionAuthorityTransactionLease
    sessionAuthorityTransactionLeases.set(lease as object, {
      issuer: this.proofAuthority,
      completion,
      finish,
      active: true,
    })
    this.activeAuthorityTransactions.set(lease as object, completion)
    return lease
  }

  /** Complete an admitted session transaction after acceptance or exact rollback settles. */
  finishSessionAuthorityTransaction(lease: SessionAuthorityTransactionLease): void {
    const issued = sessionAuthorityTransactionLeases.get(lease as object)
    if (!issued || issued.issuer !== this.proofAuthority || !issued.active)
      throw new Error('Session authority transaction lease is invalid or already finished')
    issued.active = false
    this.activeAuthorityTransactions.delete(lease as object)
    issued.finish()
  }

  /** Preserve an admitted producer's ownership context through its async storage operations. */
  runWithSessionAuthorityTransaction<T>(
    lease: SessionAuthorityTransactionLease,
    operation: () => T
  ): T {
    const issued = sessionAuthorityTransactionLeases.get(lease as object)
    if (!issued || issued.issuer !== this.proofAuthority || !issued.active)
      throw new Error('Session authority transaction lease is invalid or already finished')
    return this.authorityTransactionContext.run(lease, operation)
  }

  /** Execute one synchronous authority-record mutation under quit admission and drain. */
  runSessionAuthorityRecordMutation<T>(
    operation: () => T,
    lease?: SessionAuthorityTransactionLease
  ): T {
    if (lease !== undefined) {
      const issued = sessionAuthorityTransactionLeases.get(lease as object)
      if (!issued || issued.issuer !== this.proofAuthority || !issued.active)
        throw new Error('Session authority transaction lease is invalid or already finished')
      return operation()
    }
    const admitted = this.beginSessionAuthorityTransaction()
    try {
      return operation()
    } finally {
      this.finishSessionAuthorityTransaction(admitted)
    }
  }

  /** Wait for active session transactions, Keytar work and any storage fallback they trigger. */
  async prepareForQuit(): Promise<void> {
    this.closeAdmission()
    while (this.pendingOperations.size > 0 || this.activeAuthorityTransactions.size > 0) {
      await Promise.allSettled([
        ...this.pendingOperations,
        ...this.activeAuthorityTransactions.values(),
      ])
    }
  }

  private readonly isolatedUserDataPath: string | undefined

  constructor(options: TokenStoreOptions = {}) {
    const isolatedUserDataPath = options.isolatedUserDataPath
    if (
      isolatedUserDataPath !== undefined &&
      (!isolatedUserDataPath || !path.isAbsolute(isolatedUserDataPath))
    ) {
      throw new Error('Isolated token storage requires an absolute userData path')
    }
    this.isolatedUserDataPath = isolatedUserDataPath
  }

  /**
   * Probe whether Keytar can currently service a read without touching a credential slot.
   * A successful module import alone is not enough: locked/declined OS stores must not be
   * selected as the first-login source. The unique probe account is read-only and contains no
   * credential data. Unexpected module shapes remain unknown rather than being called absent.
   */
  async inspectVersionedKeytarCapability(): Promise<ProviderCapability> {
    return this.trackOperation(async () => {
      if (this.isolatedUserDataPath !== undefined) return 'unavailable'
      let keytar: KeytarModule | null
      try {
        keytar = await loadVersionedKeytar()
      } catch {
        return 'unknown'
      }
      if (!keytar) return 'unavailable'
      const account = `session-v1-capability-probe:${randomUUID()}`
      try {
        await accessKeytarAccount(account, () => keytar!.getPassword(SERVICE, account))
        return 'available'
      } catch (error) {
        // A read-only probe can select a fallback only when the OS explicitly reports access
        // denial. Other native errors may be transient and cannot authorize provider fallback
        // or memory admission.
        const code = (error as NodeJS.ErrnoException | null)?.code
        return code === 'EACCES' || code === 'EPERM' ? 'unavailable' : 'unknown'
      }
    })
  }

  /** Repository capability: only opaque proof objects bound to this verified storage root resolve. */
  resolveAbsenceProof(
    proof: unknown,
    storageScope?: SessionAuthorityStorageScope
  ): SessionAuthorityAbsenceEvidence | null {
    if (!storageScope) return null
    return resolveSessionTokenAbsenceProof(proof, this.proofAuthority, storageScope)
  }

  /** Consume a source receipt only when it matches the exact denied transaction and this root. */
  async consumeSessionTokenCandidatePublicationReceipt(
    receipt: unknown,
    storageScope: SessionAuthorityStorageScope,
    expected: {
      transactionId: string
      candidateHash: string
      sourceKind: 'keytar' | 'safe-storage'
      sourceRef: string
      sourceRevision: string
      envKey: string
      accountId: string
    }
  ): Promise<SessionAuthorityCredentialSource | null> {
    if (typeof receipt !== 'object' || receipt === null) return null
    const issued = candidatePublicationReceipts.get(receipt)
    const authorityScope = await this.assertSessionAuthorityStorageScopeCurrent(storageScope)
    if (
      !issued ||
      issued.issuer !== this.proofAuthority ||
      issued.storageRoot !== authorityScope.storageRoot ||
      !sameStorageRootIdentity(issued.rootIdentity, authorityScope.rootIdentity) ||
      issued.transactionId !== expected.transactionId ||
      issued.candidateHash !== expected.candidateHash ||
      issued.source.kind !== expected.sourceKind ||
      issued.source.sourceRef !== expected.sourceRef ||
      issued.source.sourceRevision !== expected.sourceRevision ||
      issued.source.envKey !== expected.envKey ||
      issued.source.accountId !== expected.accountId
    )
      return null
    const currentScope = await this.assertSessionAuthorityStorageScopeCurrent(storageScope)
    if (
      currentScope.storageRoot !== issued.storageRoot ||
      !sameStorageRootIdentity(currentScope.rootIdentity, issued.rootIdentity)
    )
      return null
    candidatePublicationReceipts.delete(receipt)
    return JSON.parse(JSON.stringify(issued.source)) as SessionAuthorityCredentialSource
  }

  /** Issue a private capability bound to this TokenStore and canonical Electron userData root. */
  async createSessionAuthorityStorageScope(): Promise<SessionAuthorityStorageScope> {
    return this.trackOperation(() => this.createSessionAuthorityStorageScopeOnce())
  }

  /** Internal variant for work already admitted by a public TokenStore operation. */
  private async createSessionAuthorityStorageScopeOnce(): Promise<SessionAuthorityStorageScope> {
    assertVersionedSessionPlatform()
    if (!app?.isReady()) throw new SessionAuthorityStorageScopeUnavailableError()
    const storageRoot = await fs.realpath(await this.verifiedStorageBase())
    let rootStat = await fs.lstat(storageRoot)
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      (process.platform !== 'win32' &&
        typeof process.getuid === 'function' &&
        rootStat.uid !== process.getuid())
    )
      throw new Error('Session authority root is not an owned canonical directory')
    if (process.platform !== 'win32' && (rootStat.mode & 0o077) !== 0) {
      await fs.chmod(storageRoot, 0o700)
      rootStat = await fs.lstat(storageRoot)
    }
    if (process.platform !== 'win32' && (rootStat.mode & 0o077) !== 0)
      throw new Error('Session authority root failed privacy verification')
    const authorityDirectory = path.join(storageRoot, 'sessions')
    let windowsAclEvidence: WindowsSessionAuthorityAclEvidence | undefined
    if (process.platform === 'win32') {
      windowsAclEvidence = provisionWindowsSessionAuthorityDirectory(
        storageRoot,
        authorityDirectory
      )
    } else {
      await ensureVersionedSessionDirectory(storageRoot)
    }
    const currentRootStat = await fs.lstat(storageRoot)
    if (
      !currentRootStat.isDirectory() ||
      currentRootStat.isSymbolicLink() ||
      !sameStorageRootIdentity(storageRootIdentity(currentRootStat), storageRootIdentity(rootStat))
    )
      throw new Error('Session authority root changed while its platform permissions were secured')
    const authorityDirectoryStat = await fs.lstat(authorityDirectory)
    if (
      !authorityDirectoryStat.isDirectory() ||
      authorityDirectoryStat.isSymbolicLink() ||
      (process.platform !== 'win32' && (authorityDirectoryStat.mode & 0o077) !== 0) ||
      (process.platform !== 'win32' &&
        typeof process.getuid === 'function' &&
        authorityDirectoryStat.uid !== process.getuid())
    )
      throw new Error('Session authority directory failed platform privacy verification')
    if (process.platform === 'win32') {
      const verifiedWindowsEvidence = verifyWindowsSessionAuthorityDirectory(
        storageRoot,
        authorityDirectory
      )
      if (
        !windowsAclEvidence ||
        !sameWindowsAuthorityIdentity(windowsAclEvidence, verifiedWindowsEvidence)
      )
        throw new Error('Windows session authority directory changed during ACL verification')
      windowsAclEvidence = verifiedWindowsEvidence
    }
    const scope = Object.freeze({}) as SessionAuthorityStorageScope
    authorityStorageScopes.set(scope as object, {
      issuer: this.proofAuthority,
      storageRoot,
      rootIdentity: storageRootIdentity(currentRootStat),
      authorityDirectory,
      authorityDirectoryIdentity: {
        dev: authorityDirectoryStat.dev,
        ino: authorityDirectoryStat.ino,
      },
      ...(windowsAclEvidence ? { windowsAclEvidence } : {}),
    })
    return scope
  }

  /** Resolve only a storage scope issued by this exact TokenStore instance. */
  resolveSessionAuthorityStorageScope(scope: SessionAuthorityStorageScope): string {
    const issued = authorityStorageScopes.get(scope as object)
    if (!issued || issued.issuer !== this.proofAuthority)
      throw new Error('Session authority storage scope belongs to another TokenStore')
    this.assertSessionAuthorityStorageScopeCurrentSync(scope)
    return issued.storageRoot
  }

  /** Resolve the protected directory that owns authority, recovery, quarantine, and source slots. */
  resolveSessionAuthorityStorageDirectory(scope: SessionAuthorityStorageScope): string {
    const issued = authorityStorageScopes.get(scope as object)
    if (!issued || issued.issuer !== this.proofAuthority)
      throw new Error('Session authority storage scope belongs to another TokenStore')
    this.assertSessionAuthorityStorageScopeCurrentSync(scope)
    return issued.authorityDirectory
  }

  /** Observe a compatibility marker only within the exact TokenStore-issued userData scope. */
  observeSessionAuthorityMarkerRaw(
    scope: SessionAuthorityStorageScope,
    userDataDirectory: string,
    envKey: string
  ): PendingExternalLogoutRawObservation {
    const storageRoot = this.resolveSessionAuthorityStorageScope(scope)
    const assertCurrent = () =>
      this.assertSessionAuthorityMarkerScopeCurrentSync(scope, userDataDirectory, storageRoot)
    assertCurrent()
    const observed = observePendingExternalLogoutRaw(storageRoot, envKey, assertCurrent)
    assertCurrent()
    return observed
  }

  /** Stage a compatibility marker with scope checks around every filesystem effect/read-back. */
  stageSessionAuthorityMarker(
    scope: SessionAuthorityStorageScope,
    userDataDirectory: string,
    envKey: string,
    expected: PendingExternalLogoutRawObservation,
    marker: AcceptancePendingMarker
  ): AcceptancePendingMarker | null {
    const storageRoot = this.resolveSessionAuthorityStorageScope(scope)
    const assertCurrent = () =>
      this.assertSessionAuthorityMarkerScopeCurrentSync(scope, userDataDirectory, storageRoot)
    assertCurrent()
    const staged = stageAcceptancePendingMarker(
      storageRoot,
      envKey,
      expected,
      marker,
      assertCurrent
    )
    assertCurrent()
    return staged
  }

  /** Restore only the exact captured marker image while the same root identity remains current. */
  restoreSessionAuthorityMarkerBeforeImage(
    scope: SessionAuthorityStorageScope,
    userDataDirectory: string,
    envKey: string,
    stagedDigest: string,
    beforeImage: PendingExternalLogoutRawObservation
  ): boolean {
    const storageRoot = this.resolveSessionAuthorityStorageScope(scope)
    const assertCurrent = () =>
      this.assertSessionAuthorityMarkerScopeCurrentSync(scope, userDataDirectory, storageRoot)
    assertCurrent()
    const restored = restoreAcceptanceMarkerBeforeImage(
      storageRoot,
      envKey,
      stagedDigest,
      beforeImage,
      assertCurrent
    )
    assertCurrent()
    return restored
  }

  /** Apply a planned LP/marker CAS while every read, write, and read-back remains scope-bound. */
  applySessionAuthorityMarkerCas(
    scope: SessionAuthorityStorageScope,
    userDataDirectory: string,
    envKey: string,
    cas: PendingExternalLogoutCas
  ): boolean {
    const storageRoot = this.resolveSessionAuthorityStorageScope(scope)
    const assertCurrent = () =>
      this.assertSessionAuthorityMarkerScopeCurrentSync(scope, userDataDirectory, storageRoot)
    assertCurrent()
    const applied = applyPendingExternalLogoutCas(storageRoot, envKey, cas, assertCurrent)
    assertCurrent()
    return applied
  }

  /** Apply an LP transition against the exact marker bytes observed by the caller. */
  applySessionAuthorityMarkerRawCas(
    scope: SessionAuthorityStorageScope,
    userDataDirectory: string,
    envKey: string,
    expected: PendingExternalLogoutRawObservation,
    next: import('./pendingExternalLogout.js').PendingExternalLogoutMarker
  ): boolean {
    const storageRoot = this.resolveSessionAuthorityStorageScope(scope)
    const assertCurrent = () =>
      this.assertSessionAuthorityMarkerScopeCurrentSync(scope, userDataDirectory, storageRoot)
    assertCurrent()
    const applied = applyPendingExternalLogoutRawCas(
      storageRoot,
      envKey,
      expected,
      next,
      assertCurrent
    )
    assertCurrent()
    return applied
  }

  assertSessionAuthorityMarkerScopeCurrentSync(
    scope: SessionAuthorityStorageScope,
    userDataDirectory: string,
    expectedRoot: string
  ): void {
    this.assertSessionAuthorityStorageScopeCurrentSync(scope)
    if (!sameStorageRootPath(fsSync.realpathSync(userDataDirectory), expectedRoot))
      throw new Error('Session authority marker root changed after its scope was captured')
  }

  /** Revalidate a repository scope synchronously before its journal performs filesystem I/O. */
  assertSessionAuthorityStorageScopeCurrentSync(scope: SessionAuthorityStorageScope): void {
    const issued = this.requireSessionAuthorityStorageScope(scope)
    if (!app?.isReady()) throw new SessionAuthorityStorageScopeUnavailableError()
    const configuredRoot = app.getPath('userData')
    if (this.isolatedUserDataPath !== undefined) {
      if (app.isPackaged) throw new Error('Isolated token storage requires an unpackaged process')
      const actual = fsSync.realpathSync(configuredRoot)
      const declared = fsSync.realpathSync(this.isolatedUserDataPath)
      if (!sameStorageRootPath(actual, declared))
        throw new Error('Isolated token storage directory mismatch')
    }
    const currentRoot = fsSync.realpathSync(configuredRoot)
    if (!sameStorageRootPath(currentRoot, issued.storageRoot))
      throw new Error('Session authority storage root changed after it was captured')
    const currentStat = fsSync.lstatSync(currentRoot)
    if (
      !currentStat.isDirectory() ||
      currentStat.isSymbolicLink() ||
      (process.platform !== 'win32' &&
        typeof process.getuid === 'function' &&
        currentStat.uid !== process.getuid()) ||
      (process.platform !== 'win32' && (currentStat.mode & 0o077) !== 0) ||
      !sameStorageRootIdentity(storageRootIdentity(currentStat), issued.rootIdentity)
    )
      throw new Error('Session authority storage root identity changed after it was captured')
    const currentAuthorityDirectory = fsSync.lstatSync(issued.authorityDirectory)
    if (
      !currentAuthorityDirectory.isDirectory() ||
      currentAuthorityDirectory.isSymbolicLink() ||
      (process.platform !== 'win32' && (currentAuthorityDirectory.mode & 0o077) !== 0) ||
      (process.platform !== 'win32' &&
        typeof process.getuid === 'function' &&
        currentAuthorityDirectory.uid !== process.getuid()) ||
      currentAuthorityDirectory.dev !== issued.authorityDirectoryIdentity.dev ||
      currentAuthorityDirectory.ino !== issued.authorityDirectoryIdentity.ino
    )
      throw new Error('Session authority directory identity changed after it was captured')
    if (process.platform === 'win32') {
      if (!issued.windowsAclEvidence)
        throw new Error('Windows session authority scope lacks native ACL evidence')
      const currentEvidence = verifyWindowsSessionAuthorityDirectory(
        issued.storageRoot,
        issued.authorityDirectory
      )
      if (!sameWindowsAuthorityIdentity(issued.windowsAclEvidence, currentEvidence))
        throw new Error('Windows session authority ACL identity changed after it was captured')
    } else if (issued.windowsAclEvidence) {
      throw new Error('Windows session authority evidence cannot be reused on another platform')
    }
  }

  private requireSessionAuthorityStorageScope(
    scope: SessionAuthorityStorageScope
  ): NonNullable<ReturnType<typeof authorityStorageScopes.get>> {
    const issued = authorityStorageScopes.get(scope as object)
    if (!issued || issued.issuer !== this.proofAuthority)
      throw new Error('Session authority storage scope belongs to another TokenStore')
    return issued
  }

  private async assertSessionAuthorityStorageScopeCurrent(
    scope: SessionAuthorityStorageScope
  ): Promise<NonNullable<ReturnType<typeof authorityStorageScopes.get>>> {
    const issued = this.requireSessionAuthorityStorageScope(scope)
    await this.verifiedStorageBase()
    this.assertSessionAuthorityStorageScopeCurrentSync(scope)
    return issued
  }

  /** Return the verified canonical root captured by this TokenStore's authority capability. */
  async getSessionAuthorityStorageRoot(): Promise<string> {
    return fs.realpath(await this.verifiedStorageBase())
  }

  /** Observe exact legacy source identities without returning stored token content. */
  async observeLegacySessionCredentialSources(
    envKey: string,
    authorityScope: SessionAuthorityStorageScope,
    legacyEnvKeys: readonly string[] = []
  ): Promise<LegacySessionCredentialSourceInventory> {
    return this.trackOperation(async () => {
      assertEnvKey(envKey)
      const legacyKeys = Array.from(
        new Set(
          legacyEnvKeys.map(key => String(key || '').trim()).filter(key => key && key !== envKey)
        )
      )
      for (const key of legacyKeys) assertEnvKey(key)
      const authority = await this.assertSessionAuthorityStorageScopeCurrent(authorityScope)
      const sources: SessionAuthorityCredentialSource[] = []
      const candidates: LegacySessionCredentialSourceCandidate[] = []
      const unavailableSources: LegacySessionCredentialSourceObservation['unavailableSources'] = []
      const makeSource = (
        kind: 'keytar' | 'safe-storage' | 'historical-plaintext',
        accountId: string | null,
        legacyLocator: SessionAuthorityLegacyLocator,
        value: string | Buffer,
        scopeEnvKey: string | null
      ): SessionAuthorityCredentialSource => {
        const sourceRef = legacySessionCredentialSourceRef(
          authority.storageRoot,
          authority.rootIdentity,
          envKey,
          kind,
          legacyLocator
        )
        const exactSource: SessionAuthorityCredentialSource = Object.freeze({
          kind,
          format: 'v0',
          envKey,
          accountId,
          sourceRef,
          sourceRevision: null,
          storedValueDigest: digestSessionAuthoritySource(
            { sourceKind: kind, sourceRef, envKey, accountId },
            value
          ),
          legacyLocator: Object.freeze(legacyLocator),
        })
        legacyCredentialObservations.set(exactSource as object, {
          issuer: this.proofAuthority,
          storageRoot: authority.storageRoot,
          rootIdentity: authority.rootIdentity,
        })
        candidates.push({
          scopeEnvKey,
          source: exactSource as Extract<SessionAuthorityCredentialSource, { format: 'v0' }>,
        })
        return exactSource
      }

      if (this.isolatedUserDataPath === undefined) {
        let keytar: KeytarModule | null
        try {
          keytar = await loadVersionedKeytar()
        } catch (error) {
          if (!(error instanceof SessionTokenProviderStateUnknownError)) throw error
          keytar = null
        }
        if (!keytar) {
          // A missing module does not prove an old Keytar account is absent: a previous
          // installation may have written one. Callers must preserve deny-unframed authority
          // and may not retire source cleanup debt from this incomplete observation.
          unavailableSources.push('keytar')
        } else {
          const accountCandidates = [
            ...[envKey, ...legacyKeys].map(key => ({ envKey: key, account: accountFor(key) })),
            { envKey: null, account: LEGACY_ACCOUNT },
          ]
          const seenAccounts = new Set<string>()
          for (const candidate of accountCandidates) {
            const { account, envKey: scopeEnvKey } = candidate
            if (seenAccounts.has(account)) continue
            seenAccounts.add(account)
            let stored: string | null
            try {
              stored = await accessKeytarAccount(account, () =>
                keytar.getPassword(SERVICE, account)
              )
            } catch (error) {
              const code = (error as NodeJS.ErrnoException | null)?.code
              if (code !== 'EACCES' && code !== 'EPERM') throw error
              unavailableSources.push('keytar')
              break
            }
            if (stored !== null)
              sources.push(
                makeSource('keytar', null, { kind: 'keytar-account', account }, stored, scopeEnvKey)
              )
          }
        }
      }

      const storageRoot = authority.storageRoot
      const fileScopes: Array<string | null> = [envKey, ...legacyKeys]
      if (this.isolatedUserDataPath === undefined) fileScopes.push(null)
      const fileSources = fileScopes.flatMap(scopeEnvKey => [
        {
          kind: 'safe-storage' as const,
          envKey: scopeEnvKey,
          file:
            scopeEnvKey === null
              ? path.join(storageRoot, 'session-token.enc')
              : path.join(storageRoot, `session-token-${scopeEnvKey}.enc`),
        },
        {
          kind: 'historical-plaintext' as const,
          envKey: scopeEnvKey,
          file:
            scopeEnvKey === null
              ? path.join(storageRoot, 'session-token.json')
              : path.join(storageRoot, `session-token-${scopeEnvKey}.json`),
        },
      ])
      for (const candidate of fileSources) {
        const stored = await mutateTokenFile(candidate.file, async () =>
          readRegularFallbackFile(candidate.file)
        )
        if (stored !== null)
          sources.push(
            makeSource(
              candidate.kind,
              null,
              candidate.kind === 'safe-storage'
                ? { kind: 'safe-storage-file', envKey: candidate.envKey }
                : { kind: 'plaintext-file', envKey: candidate.envKey },
              stored,
              candidate.envKey
            )
          )
      }
      await this.assertSessionAuthorityStorageScopeCurrent(authorityScope)
      const observation = Object.freeze({
        sources,
        candidates,
        complete: unavailableSources.length === 0,
        unavailableSources,
      }) as LegacySessionCredentialSourceInventory
      legacySourceInventories.set(observation as object, {
        issuer: this.proofAuthority,
        storageRoot: authority.storageRoot,
        rootIdentity: authority.rootIdentity,
        envKey,
        candidates,
        complete: unavailableSources.length === 0,
        consumed: false,
      })
      return observation
    })
  }

  /**
   * Consume two complete observations only when every legacy source identity and stored-byte
   * digest is unchanged. The returned V0 descriptors contain no bearer values and can be used
   * only as exact cleanup debt after a durable logout fence.
   */
  consumeUnchangedLegacySessionCredentialInventories(
    beforeObservation: LegacySessionCredentialSourceInventory,
    afterObservation: LegacySessionCredentialSourceInventory,
    envKey: string,
    authorityScope: SessionAuthorityStorageScope
  ): readonly SessionAuthorityCredentialSource[] | null {
    const before = legacySourceInventories.get(beforeObservation as object)
    const after = legacySourceInventories.get(afterObservation as object)
    const scope = authorityStorageScopes.get(authorityScope as object)
    this.assertSessionAuthorityStorageScopeCurrentSync(authorityScope)
    if (
      beforeObservation === afterObservation ||
      !before ||
      !after ||
      !scope ||
      before.consumed ||
      after.consumed ||
      !before.complete ||
      !after.complete ||
      before.issuer !== this.proofAuthority ||
      after.issuer !== this.proofAuthority ||
      scope.issuer !== this.proofAuthority ||
      before.envKey !== envKey ||
      after.envKey !== envKey ||
      before.storageRoot !== scope.storageRoot ||
      after.storageRoot !== scope.storageRoot ||
      !sameStorageRootIdentity(before.rootIdentity, scope.rootIdentity) ||
      !sameStorageRootIdentity(after.rootIdentity, scope.rootIdentity)
    )
      return null

    const describe = (candidates: readonly LegacySessionCredentialSourceCandidate[]): string[] =>
      candidates
        .map(({ scopeEnvKey, source }) =>
          JSON.stringify([
            scopeEnvKey,
            source.kind,
            source.format,
            source.envKey,
            source.accountId,
            source.sourceRef,
            source.sourceRevision,
            source.storedValueDigest,
            source.legacyLocator,
          ])
        )
        .sort()

    if (JSON.stringify(describe(before.candidates)) !== JSON.stringify(describe(after.candidates)))
      return null

    const sources = after.candidates.map(candidate => candidate.source)
    if (
      sources.some(
        source =>
          source.format !== 'v0' ||
          !legacyCredentialObservations.has(source as object) ||
          !this.isLegacySessionCredentialSourceBoundToScope(source, authorityScope)
      ) ||
      new Set(sources.map(source => source.sourceRef)).size !== sources.length
    )
      return null

    before.consumed = true
    after.consumed = true
    return Object.freeze(sources.slice())
  }

  /**
   * Bind a real legacy restore selection to the exact active V0 source object. This is narrower
   * than an inventory scan: the opaque read authority proves which native account/file the
   * provider selected, while the fresh inventory and digest check prove the bytes still match.
   */
  async observeSelectedLegacySessionCredentialSource(
    sourceKind: 'keytar' | 'safe-storage',
    envKey: string,
    readAuthority: SessionTokenReadAuthority,
    legacyEnvKeys: readonly string[] = []
  ): Promise<SelectedLegacySessionCredentialSource | null> {
    return this.trackOperation(async () => {
      assertEnvKey(envKey)
      const authority = readAuthorities.get(readAuthority)
      const selectedResource = authority?.selectedResource
      const expectedResource = activeAuthorityResource(authority, sourceKind, envKey)
      if (
        !selectedResource ||
        selectedResource !== expectedResource ||
        !isSessionTokenReadAuthorityCurrent(readAuthority, sourceKind, envKey)
      )
        return null

      const storageScope = await this.createSessionAuthorityStorageScopeOnce()
      const inventory = await this.observeLegacySessionCredentialSources(
        envKey,
        storageScope,
        legacyEnvKeys
      )
      const matches = inventory.candidates.filter(candidate => {
        const source = candidate.source
        const observation = legacyCredentialObservations.get(source as object)
        if (
          candidate.scopeEnvKey !== envKey ||
          source.kind !== sourceKind ||
          !observation ||
          observation.storageRoot !==
            authorityStorageScopes.get(storageScope as object)?.storageRoot ||
          !this.isLegacySessionCredentialSourceBoundToScope(source, storageScope) ||
          this.legacyCredentialResource(source, storageScope) === null
        )
          return false
        const locator = source.legacyLocator
        if (source.kind === 'keytar')
          return (
            locator.kind === 'keytar-account' &&
            locator.account === accountFor(envKey) &&
            nativeResource(locator.account) === selectedResource
          )
        if (locator.kind !== 'safe-storage-file' || locator.envKey !== envKey) return false
        // Read authorities intentionally retain the exact path used by the read. The V0
        // inventory is rooted at realpath(userData); compare the selected capability to
        // its lexical storage path while separately requiring the canonical inventory root.
        return (
          fileResource(path.join(authority.storageBase, `session-token-${envKey}.enc`)) ===
          selectedResource
        )
      })
      if (matches.length !== 1) {
        return null
      }
      const selected = matches[0]!.source
      const current = await this.readObservedLegacySessionCredentialSource(selected, storageScope)
      if (
        current.status !== 'present' ||
        !isSessionTokenReadAuthorityCurrent(readAuthority, sourceKind, envKey)
      )
        return null

      const proof = Object.freeze({
        source: selected,
        inventory,
      }) as SelectedLegacySessionCredentialSource
      selectedLegacyCredentialProofs.set(proof as object, {
        issuer: this.proofAuthority,
        envKey,
        source: selected,
        inventory,
        authority: readAuthority,
        selectedResource,
        consumed: false,
      })
      return proof
    })
  }

  /** Consume a one-use proof that a restore read selected this exact V0 resource. */
  consumeSelectedLegacyPriorSourceObservation(
    observation: unknown,
    source: SessionAuthorityCredentialSource,
    envKey: string,
    authorityScope: SessionAuthorityStorageScope
  ): boolean {
    if (typeof observation !== 'object' || observation === null || source.format !== 'v0')
      return false
    const proof = selectedLegacyCredentialProofs.get(observation)
    const inventory = proof && legacySourceInventories.get(proof.inventory as object)
    const scope = authorityStorageScopes.get(authorityScope as object)
    const readAuthority = proof && readAuthorities.get(proof.authority)
    if (
      !proof ||
      proof.consumed ||
      proof.issuer !== this.proofAuthority ||
      proof.envKey !== envKey ||
      proof.source !== source ||
      !inventory ||
      inventory.consumed ||
      inventory.issuer !== this.proofAuthority ||
      inventory.envKey !== envKey ||
      !scope ||
      scope.issuer !== this.proofAuthority ||
      inventory.storageRoot !== scope.storageRoot ||
      !sameStorageRootIdentity(inventory.rootIdentity, scope.rootIdentity) ||
      !this.isLegacySessionCredentialSourceBoundToScope(source, authorityScope) ||
      !readAuthority ||
      readAuthority.selectedResource !== proof.selectedResource ||
      this.legacyCredentialResource(source, authorityScope) === null ||
      activeAuthorityResource(readAuthority, source.kind as 'keytar' | 'safe-storage', envKey) !==
        proof.selectedResource ||
      !isSessionTokenReadAuthorityCurrent(
        proof.authority,
        source.kind as 'keytar' | 'safe-storage',
        envKey
      )
    )
      return false
    const exactCandidate = inventory.candidates.some(
      candidate => candidate.scopeEnvKey === envKey && candidate.source === source
    )
    if (!exactCandidate) return false
    proof.consumed = true
    inventory.consumed = true
    return true
  }

  /** Consume proof that the exact selected legacy source (or no source) was observed completely. */
  consumeLegacyPriorSourceObservation(
    observation: unknown,
    source: SessionAuthorityCredentialSource | null,
    envKey: string,
    authorityScope: SessionAuthorityStorageScope
  ): boolean {
    if (typeof observation !== 'object' || observation === null) return false
    const inventory = legacySourceInventories.get(observation)
    const scope = authorityStorageScopes.get(authorityScope as object)
    if (
      !inventory ||
      inventory.consumed ||
      !inventory.complete ||
      inventory.issuer !== this.proofAuthority ||
      !scope ||
      scope.issuer !== this.proofAuthority ||
      inventory.storageRoot !== scope.storageRoot ||
      !sameStorageRootIdentity(inventory.rootIdentity, scope.rootIdentity) ||
      inventory.envKey !== envKey
    )
      return false
    const possible = inventory.candidates.filter(
      candidate => candidate.scopeEnvKey === envKey || candidate.scopeEnvKey === null
    )
    const matches =
      source === null
        ? possible.length === 0
        : possible.some(candidate => candidate.source === source)
    if (!matches) return false
    inventory.consumed = true
    return true
  }

  /** True only for the exact legacy source object observed by this store within this root. */
  isObservedLegacySessionCredentialSource(
    source: SessionAuthorityCredentialSource,
    authorityScope: SessionAuthorityStorageScope
  ): boolean {
    if (source.format !== 'v0') return false
    const issued = legacyCredentialObservations.get(source as object)
    const scope = authorityStorageScopes.get(authorityScope as object)
    if (
      !issued ||
      !scope ||
      issued.issuer !== this.proofAuthority ||
      scope.issuer !== this.proofAuthority ||
      issued.storageRoot !== scope.storageRoot ||
      !sameStorageRootIdentity(issued.rootIdentity, scope.rootIdentity)
    )
      return false
    return this.isLegacySessionCredentialSourceBoundToScope(source, authorityScope)
  }

  /**
   * Validate a durable legacy receipt against this exact storage root. Unlike the observation
   * proof above, this survives process restart; it does not itself authorize a read or mutation.
   */
  isLegacySessionCredentialSourceBoundToScope(
    source: SessionAuthorityCredentialSource,
    authorityScope: SessionAuthorityStorageScope
  ): boolean {
    if (
      source.format !== 'v0' ||
      source.sourceRevision !== null ||
      source.accountId !== null ||
      !ENV_KEY_SHAPE.test(source.envKey) ||
      !SOURCE_UUID_SHAPE.test(source.sourceRef) ||
      !/^[0-9a-f]{64}$/i.test(source.storedValueDigest)
    )
      return false

    const scope = authorityStorageScopes.get(authorityScope as object)
    if (!scope || scope.issuer !== this.proofAuthority) return false
    const locator = source.legacyLocator
    if (source.kind === 'keytar') {
      if (
        locator.kind !== 'keytar-account' ||
        (locator.account !== LEGACY_ACCOUNT &&
          !/^session-token::[a-z0-9_]+-[0-9a-f]{12}$/.test(locator.account))
      )
        return false
    } else if (
      (source.kind === 'safe-storage' && locator.kind !== 'safe-storage-file') ||
      (source.kind === 'historical-plaintext' && locator.kind !== 'plaintext-file') ||
      locator.kind === 'keytar-account' ||
      (locator.envKey !== null && !ENV_KEY_SHAPE.test(locator.envKey))
    ) {
      return false
    }

    const expectedSourceRef = legacySessionCredentialSourceRef(
      scope.storageRoot,
      scope.rootIdentity,
      source.envKey,
      source.kind,
      locator
    )
    if (source.sourceRef !== expectedSourceRef) return false
    this.assertSessionAuthorityStorageScopeCurrentSync(authorityScope)
    return true
  }

  /**
   * Read a durable, authority-selected V0 source by its recorded locator and digest. This is for
   * restore-existing only: it does not inventory sibling providers or select a fallback.
   */
  async readBoundLegacySessionCredentialSource(
    source: Extract<SessionAuthorityCredentialSource, { format: 'v0' }>,
    authorityScope: SessionAuthorityStorageScope
  ): Promise<LegacySessionCredentialReadResult> {
    return this.trackOperation(() =>
      this.readLegacySessionCredentialSourceOnce(source, authorityScope)
    )
  }

  /** Read one exact observed v0 source; this method never selects or falls back to another. */
  async readObservedLegacySessionCredentialSource(
    source: Extract<SessionAuthorityCredentialSource, { format: 'v0' }>,
    authorityScope: SessionAuthorityStorageScope
  ): Promise<LegacySessionCredentialReadResult> {
    return this.trackOperation(async () => {
      if (!this.isObservedLegacySessionCredentialSource(source, authorityScope))
        return { status: 'changed' }
      return this.readLegacySessionCredentialSourceOnce(source, authorityScope)
    })
  }

  private async readLegacySessionCredentialSourceOnce(
    source: Extract<SessionAuthorityCredentialSource, { format: 'v0' }>,
    authorityScope: SessionAuthorityStorageScope
  ): Promise<LegacySessionCredentialReadResult> {
    if (source.kind !== 'keytar' && source.kind !== 'safe-storage') return { status: 'changed' }
    const sourceResource = this.legacyCredentialResource(source, authorityScope)
    if (!sourceResource) return { status: 'changed' }
    const matches = (value: string | Buffer) =>
      digestSessionAuthoritySource(
        {
          sourceKind: source.kind,
          sourceRef: source.sourceRef,
          envKey: source.envKey,
          accountId: source.accountId,
        },
        value
      ) === source.storedValueDigest

    if (source.kind === 'keytar') {
      if (this.isolatedUserDataPath !== undefined) return { status: 'unavailable' }
      const locator = source.legacyLocator
      if (locator.kind !== 'keytar-account') return { status: 'changed' }
      const keytar = await loadVersionedKeytar()
      if (!keytar) return { status: 'unavailable' }
      return accessKeytarAccount(locator.account, async () => {
        this.assertSessionAuthorityStorageScopeCurrentSync(authorityScope)
        const token = await keytar.getPassword(SERVICE, locator.account)
        this.assertSessionAuthorityStorageScopeCurrentSync(authorityScope)
        if (token === null) return { status: 'absent' }
        return matches(token) ? { status: 'present', token } : { status: 'changed' }
      })
    }

    const locator = source.legacyLocator
    if (locator.kind !== 'safe-storage-file' || !isQualifiedSafeStorageAvailable())
      return { status: locator.kind === 'safe-storage-file' ? 'unavailable' : 'changed' }
    const file = sourceResource.slice('file:'.length)
    return mutateTokenFile(file, async () => {
      this.assertSessionAuthorityStorageScopeCurrentSync(authorityScope)
      const bytes = readRegularFallbackFile(file)
      if (bytes === null) return { status: 'absent' as const }
      if (!matches(bytes)) return { status: 'changed' as const }
      const token = safeStorage.decryptString(bytes)
      this.assertSessionAuthorityStorageScopeCurrentSync(authorityScope)
      if (typeof token !== 'string' || !token) return { status: 'changed' as const }
      return { status: 'present' as const, token }
    })
  }

  /** Retire only the exact source whose observation the coordinator selected for migration. */
  async retireObservedLegacySessionCredentialSource(
    source: Extract<SessionAuthorityCredentialSource, { format: 'v0' }>,
    token: string,
    authorityScope: SessionAuthorityStorageScope,
    options: SessionTokenMutationOptions = {}
  ): Promise<SessionTokenCandidateCleanupResult> {
    return this.trackOperation(async () => {
      if (!this.isObservedLegacySessionCredentialSource(source, authorityScope))
        return 'different-value'
      const sourceResource = this.legacyCredentialResource(source, authorityScope)
      if (!sourceResource) return 'different-value'
      const matchesStoredValue = (value: string | Buffer) =>
        digestSessionAuthoritySource(
          {
            sourceKind: source.kind,
            sourceRef: source.sourceRef,
            envKey: source.envKey,
            accountId: source.accountId,
          },
          value
        ) === source.storedValueDigest

      assertMutationOwnership(options)
      if (source.kind === 'keytar') {
        if (this.isolatedUserDataPath !== undefined)
          throw new SessionTokenSourceUnavailableError('keytar')
        const locator = source.legacyLocator
        if (locator.kind !== 'keytar-account') return 'different-value'
        const keytar = await loadVersionedKeytar()
        if (!keytar) throw new SessionTokenSourceUnavailableError('keytar')
        return accessKeytarAccount(locator.account, () =>
          publishSourceMutation(
            sourceResource,
            async () => {
              assertMutationOwnership(options)
              const current = await keytar.getPassword(SERVICE, locator.account)
              if (current === null) return 'already-absent' as const
              if (current !== token || !matchesStoredValue(current))
                return 'different-value' as const
              assertMutationOwnership(options)
              await keytar.deletePassword(SERVICE, locator.account)
              const remaining = await keytar.getPassword(SERVICE, locator.account)
              if (remaining !== null) throw new Error('Selected legacy Keytar credential remains')
              return 'deleted' as const
            },
            {},
            'keytar',
            false
          )
        )
      }

      const locator = source.legacyLocator
      const isSafeStorage = source.kind === 'safe-storage'
      if (
        (isSafeStorage && locator.kind !== 'safe-storage-file') ||
        (!isSafeStorage && locator.kind !== 'plaintext-file')
      )
        return 'different-value'
      if (isSafeStorage && !isQualifiedSafeStorageAvailable())
        throw new SessionTokenSourceUnavailableError('safe-storage')
      const file = sourceResource.slice('file:'.length)
      return mutateTokenFile(file, async () =>
        publishSourceMutation(
          sourceResource,
          async () => {
            assertMutationOwnership(options)
            const bytes = readRegularFallbackFile(file)
            if (bytes === null) return 'already-absent' as const
            if (!matchesStoredValue(bytes)) return 'different-value' as const
            const storedToken = isSafeStorage
              ? safeStorage.decryptString(bytes)
              : (JSON.parse(bytes.toString('utf8')) as { token?: unknown })?.token
            if (storedToken !== token) return 'different-value' as const
            assertMutationOwnership(options)
            await retireTokenFileDurably(file)
            if (readRegularFallbackFile(file) !== null)
              throw new Error('Selected legacy file credential remains after retirement')
            return 'deleted' as const
          },
          {},
          isSafeStorage ? 'safe-storage' : 'isolated-plaintext',
          false
        )
      )
    })
  }

  private legacyCredentialResource(
    source: Extract<SessionAuthorityCredentialSource, { format: 'v0' }>,
    authorityScope: SessionAuthorityStorageScope
  ): string | null {
    const scope = authorityStorageScopes.get(authorityScope as object)
    if (
      !scope ||
      scope.issuer !== this.proofAuthority ||
      !this.isLegacySessionCredentialSourceBoundToScope(source, authorityScope)
    )
      return null
    if (source.kind === 'keytar') {
      const locator = source.legacyLocator
      if (locator.kind !== 'keytar-account') return null
      return nativeResource(locator.account)
    }
    const locator = source.legacyLocator
    if (locator.kind === 'keytar-account') return null
    const file =
      source.kind === 'safe-storage'
        ? locator.envKey === null
          ? path.join(scope.storageRoot, 'session-token.enc')
          : path.join(scope.storageRoot, `session-token-${locator.envKey}.enc`)
        : locator.envKey === null
          ? path.join(scope.storageRoot, 'session-token.json')
          : path.join(scope.storageRoot, `session-token-${locator.envKey}.json`)
    return fileResource(file)
  }

  /** Explicit configuration only; actual operations still verify the isolated boundary. */
  isIsolatedDevelopmentStorage(): boolean {
    return this.isolatedUserDataPath !== undefined
  }

  private async verifiedStorageBase(): Promise<string> {
    if (this.isolatedUserDataPath === undefined) return resolvedStorageBase()
    if (app?.isPackaged) throw new Error('Isolated token storage requires an unpackaged process')
    if (!app?.isReady()) throw new Error('Isolated token storage requires Electron readiness')
    const actual = await realPath(app.getPath('userData'))
    const declared = await realPath(this.isolatedUserDataPath)
    if (!sameStorageRootPath(actual, declared))
      throw new Error('Isolated token storage directory mismatch')
    await fs.mkdir(actual, { recursive: true })
    return actual
  }

  private async encryptedFilePath(envKey: string): Promise<string> {
    const key = String(envKey || '').trim()
    const name = key ? `session-token-${key}.enc` : 'session-token.enc'
    return path.join(await this.verifiedStorageBase(), name)
  }

  private async plainFilePath(envKey: string): Promise<string> {
    const key = String(envKey || '').trim()
    const name = key ? `session-token-${key}.json` : 'session-token.json'
    return path.join(await this.verifiedStorageBase(), name)
  }

  private async readAuthorityScope(
    envKey: string,
    options: Pick<SessionTokenReadOptions, 'legacyEnvKeys'>
  ): Promise<ReadAuthorityScope> {
    const storageBase =
      this.isolatedUserDataPath === undefined
        ? app?.isReady()
          ? app.getPath('userData')
          : path.join(os.homedir(), '.evenfire')
        : await this.verifiedStorageBase()
    const keys = Array.from(
      new Set([
        envKey,
        ...(options.legacyEnvKeys ?? []).map(key => String(key || '').trim()).filter(Boolean),
      ])
    )
    for (const key of keys) assertEnvKey(key)
    const resources = keys.flatMap(key => [
      fileResource(path.join(storageBase, `session-token-${key}.enc`)),
      fileResource(path.join(storageBase, `session-token-${key}.json`)),
    ])
    if (this.isolatedUserDataPath === undefined) {
      resources.push(
        ...keys.map(key => nativeResource(accountFor(key))),
        nativeResource(LEGACY_ACCOUNT),
        fileResource(path.join(storageBase, 'session-token.enc')),
        fileResource(path.join(storageBase, 'session-token.json'))
      )
    }
    return { envKey, storageBase, resources }
  }

  private async prepareMutationAuthority<T extends SessionTokenMutationOptions>(
    envKey: string,
    options: T
  ): Promise<T> {
    if (
      !options.onMutationSettled ||
      migrationAuthorities.has(options) ||
      mutationAuthorities.has(options)
    )
      return options
    const scope = await this.readAuthorityScope(envKey, {})
    const prepared = { ...options }
    mutationAuthorities.set(prepared, captureReadAuthority(scope))
    return prepared
  }

  private async readFileSelection(
    filePath: string,
    source: Exclude<SessionTokenReadSource, 'keytar'>,
    scope: ReadAuthorityScope
  ): Promise<{ token: string; authority: SessionTokenReadAuthority } | null> {
    return mutateTokenFile(filePath, async () => {
      const bytes = readRegularFallbackFile(filePath)
      if (bytes === null) return null
      let token: unknown
      if (source === 'safe-storage') {
        if (!isQualifiedSafeStorageAvailable())
          throw new Error('Electron safeStorage is unavailable for session-token recovery')
        token = safeStorage.decryptString(bytes)
      } else {
        const data = JSON.parse(bytes.toString('utf8')) as { token?: unknown }
        token = data?.token
      }
      if (typeof token !== 'string' || (source === 'historical-plaintext' && !token)) return null
      return { token, authority: captureReadAuthority(scope, fileResource(filePath)) }
    })
  }

  /**
   * Read exactly one credential source without selecting a fallback. The session authority
   * coordinator consumes this typed observation and decides whether another source may be read.
   */
  async observeSessionTokenSource(
    source: SessionTokenReadSource,
    envKey: string,
    options: SessionTokenReadOptions = {}
  ): Promise<SessionTokenSourceObservation> {
    return this.trackOperation(() => this.observeSessionTokenSourceOnce(source, envKey, options))
  }

  private async observeSessionTokenSourceOnce(
    source: SessionTokenReadSource,
    envKey: string,
    options: SessionTokenReadOptions
  ): Promise<SessionTokenSourceObservation> {
    assertEnvKey(envKey)
    assertMutationOwnership(options)
    if (source === 'keytar' && this.isolatedUserDataPath !== undefined)
      return { source, status: 'unavailable', reason: 'isolated-development' }
    if (source === 'safe-storage' && !isQualifiedSafeStorageAvailable())
      return { source, status: 'unavailable', reason: 'provider-unqualified' }

    try {
      if (source === 'keytar') {
        const account = accountFor(envKey)
        const scopePromise = this.readAuthorityScope(envKey, options)
        return await accessKeytarAccount(account, async () => {
          const scope = await scopePromise
          const keytar = await loadKeytar()
          if (!keytar) return { source, status: 'unavailable', reason: 'provider-missing' }
          try {
            const token = await keytar.getPassword(SERVICE, account)
            return token
              ? {
                  source,
                  status: 'present',
                  token,
                  authority: captureReadAuthority(scope, nativeResource(account)),
                }
              : { source, status: 'absent' }
          } catch (error) {
            rethrowSuperseded(error)
            return {
              source,
              status: 'failed',
              error,
              fallbackReadFailure: isSessionTokenFallbackReadFailure(error),
            }
          }
        })
      }

      const scope = await this.readAuthorityScope(envKey, options)
      const file =
        source === 'safe-storage'
          ? await this.encryptedFilePath(envKey)
          : await this.plainFilePath(envKey)
      const selected = await this.readFileSelection(file, source, scope)
      return selected
        ? { source, status: 'present', token: selected.token, authority: selected.authority }
        : { source, status: 'absent' }
    } catch (error) {
      rethrowSuperseded(error)
      return {
        source,
        status: 'failed',
        error,
        fallbackReadFailure: isSessionTokenFallbackReadFailure(error),
      }
    }
  }

  /** Report an observation only after the coordinator has selected it as authoritative. */
  acceptSessionTokenSourceObservation(
    observation: Extract<SessionTokenSourceObservation, { status: 'present' }>,
    options: SessionTokenReadOptions = {}
  ): string {
    return reportSelectedSessionToken(
      observation.token,
      observation.source,
      options,
      observation.authority as SessionTokenReadAuthority
    )
  }

  private async reportCompletedMigration(
    token: string,
    source: SessionTokenMutationSource,
    envKey: string,
    options: SessionTokenMigrationOptions
  ): Promise<string> {
    const migration = migrationAuthorities.get(options)!
    const scope = readAuthorities.get(migration.current)!
    const resource =
      source === 'keytar'
        ? nativeResource(accountFor(envKey))
        : fileResource(
            path.join(
              scope.storageBase,
              `session-token-${envKey}.${source === 'safe-storage' ? 'enc' : 'json'}`
            )
          )
    const verify = () => {
      assertMutationOwnership(options)
      if (!hasReadAuthority(migration.current, resource))
        throw new SessionTokenStorageSupersededBeforeWriteError()
    }
    let current: string | null
    let selectedAuthority: SessionTokenReadAuthority | undefined
    if (source === 'keytar') {
      current = await accessKeytarAccount(accountFor(envKey), async () => {
        verify()
        const keytar = await loadKeytar()
        const stored = keytar ? await keytar.getPassword(SERVICE, accountFor(envKey)) : null
        verify()
        if (stored === token)
          selectedAuthority = selectAuthorityResource(migration.current, resource)
        return stored
      })
    } else {
      const file =
        source === 'safe-storage'
          ? await this.encryptedFilePath(envKey)
          : await this.plainFilePath(envKey)
      current = await mutateTokenFile(file, async () => {
        verify()
        const bytes = readRegularFallbackFile(file)
        if (bytes === null) return null
        const stored =
          source === 'safe-storage'
            ? safeStorage.decryptString(bytes)
            : (JSON.parse(bytes.toString('utf8')) as { token?: unknown })?.token
        verify()
        if (stored === token)
          selectedAuthority = selectAuthorityResource(migration.current, resource)
        return typeof stored === 'string' ? stored : null
      })
    }
    if (current !== token || !selectedAuthority)
      throw new Error('Migrated session token changed before source verification')
    return reportSelectedSessionToken(token, source, options, selectedAuthority)
  }

  /**
   * Compatibility persistence reader for storage-contract tests and non-auth diagnostics. Runtime
   * authentication must use SessionAuthorityCoordinator.readPreferredSessionToken so source
   * selection and acceptance remain under the main-process session authority owner. This adapter
   * follows the shared source-order plan and performs only the explicitly requested legacy
   * migration after active sources have been observed.
   *
   * Legacy env-key aliases are explicit caller-provided upgrade paths, such as
   * REST-only `resolveEnvKey(rest)` → REST+RPC `resolveEnvKey(rest, rpc)`. When one is found, it is
   * copied to the new slot and deleted from the old slot so it cannot be read into another runtime.
   */
  async getSessionToken(
    envKey: string,
    options: SessionTokenReadOptions = {}
  ): Promise<string | null> {
    return this.trackOperation(() => this.getSessionTokenOnce(envKey, options))
  }

  /** Read only the current encrypted safeStorage file, bypassing Keytar and all plaintext files. */
  async getSafeStorageSessionToken(
    envKey: string,
    options: SessionTokenReadOptions = {}
  ): Promise<string | null> {
    const observation = await this.observeSessionTokenSource('safe-storage', envKey, options)
    if (observation.status === 'failed') throw observation.error
    if (observation.status !== 'present') return null
    return this.acceptSessionTokenSourceObservation(observation, options)
  }

  /** Read only the active Keytar account, without legacy migration or file fallback. */
  async getKeytarSessionToken(
    envKey: string,
    options: SessionTokenReadOptions = {}
  ): Promise<string | null> {
    const observation = await this.observeSessionTokenSource('keytar', envKey, options)
    if (observation.status === 'failed') throw observation.error
    if (observation.status !== 'present') return null
    return this.acceptSessionTokenSourceObservation(observation, options)
  }

  private async getSessionTokenOnce(
    envKey: string,
    options: SessionTokenReadOptions
  ): Promise<string | null> {
    assertEnvKey(envKey)
    assertMutationOwnership(options)
    if (this.isolatedUserDataPath !== undefined) await this.verifiedStorageBase()
    const storageScope = await this.readAuthorityScope(envKey, options)
    const migrationAuthority = captureReadAuthority(storageScope)
    for (const source of sessionCredentialSourceReadOrder(
      this.isolatedUserDataPath !== undefined
    )) {
      const observation = await this.observeSessionTokenSourceOnce(source, envKey, options)
      const plan = planSessionCredentialSourceRead(observation, {
        allowIsolatedDevelopmentPlaintext: this.isolatedUserDataPath !== undefined,
      })
      if (plan.kind === 'select' && observation.status === 'present')
        return this.acceptSessionTokenSourceObservation(observation, options)
      if (plan.kind === 'reject') throw plan.error
    }

    if (options.allowLegacyMigration === false) return null
    return this.migrateLegacySessionTokenOnce(envKey, options, migrationAuthority)
  }

  /** Perform only the legacy alias/global migration after the coordinator found no active source. */
  async migrateLegacySessionToken(
    envKey: string,
    options: SessionTokenReadOptions = {}
  ): Promise<string | null> {
    return this.trackOperation(async () => {
      assertEnvKey(envKey)
      assertMutationOwnership(options)
      if (this.isolatedUserDataPath !== undefined) await this.verifiedStorageBase()
      const storageScope = await this.readAuthorityScope(envKey, options)
      const authority = captureReadAuthority(storageScope)
      return this.migrateLegacySessionTokenOnce(envKey, options, authority)
    })
  }

  private async migrateLegacySessionTokenOnce(
    envKey: string,
    options: SessionTokenReadOptions,
    authority: SessionTokenReadAuthority
  ): Promise<string | null> {
    if (options.allowLegacyMigration === false) return null
    const scope = readAuthorities.get(authority)!
    const targets = [
      ...(this.isolatedUserDataPath === undefined ? [nativeResource(accountFor(envKey))] : []),
      fileResource(path.join(scope.storageBase, `session-token-${envKey}.enc`)),
      fileResource(path.join(scope.storageBase, `session-token-${envKey}.json`)),
    ]
    const migration = migrationOptions(options, authority, targets)
    const keytar = this.isolatedUserDataPath === undefined ? await loadKeytar() : null
    const migratedScopedToken = await this.migrateLegacyEnvToken(
      envKey,
      options.legacyEnvKeys ?? [],
      keytar,
      migration
    )
    if (migratedScopedToken) return migratedScopedToken

    if (this.isolatedUserDataPath === undefined)
      return this.migrateLegacyGlobalToken(envKey, keytar, migration)
    return null
  }

  private async readMigrationNativeSource(
    account: string,
    keytar: KeytarModule,
    options: SessionTokenMigrationOptions
  ): Promise<string | null> {
    return accessKeytarAccount(account, async () => {
      const token = await keytar.getPassword(SERVICE, account)
      if (token) selectMigrationSource(options, nativeResource(account))
      return token
    })
  }

  private async readMigrationFileSource(
    filePath: string,
    source: 'safe-storage' | 'historical-plaintext',
    options: SessionTokenMigrationOptions
  ): Promise<string | null> {
    return mutateTokenFile(filePath, async () => {
      const bytes = readRegularFallbackFile(filePath)
      if (bytes === null) return null
      const token =
        source === 'safe-storage'
          ? safeStorage.decryptString(bytes)
          : (JSON.parse(bytes.toString('utf8')) as { token?: unknown })?.token
      if (typeof token !== 'string' || !token) return null
      selectMigrationSource(options, fileResource(filePath))
      return token
    })
  }

  private async retireMigrationNativeSource(
    account: string,
    token: string,
    keytar: KeytarModule,
    options: SessionTokenMigrationOptions
  ): Promise<void> {
    return accessKeytarAccount(account, async () => {
      const resource = nativeResource(account)
      assertMutationOwnership(options)
      const migration = migrationAuthorities.get(options)!
      if (!hasReadAuthority(migration.current, resource)) return
      const current = await keytar.getPassword(SERVICE, account)
      assertMutationOwnership(options)
      if (current !== token || !hasReadAuthority(migration.current, resource)) return
      await publishSourceMutation(
        resource,
        () => keytar.deletePassword(SERVICE, account),
        options,
        'keytar',
        false
      )
      assertMutationOwnership(options)
    })
  }

  private async retireMigrationFileSource(
    filePath: string,
    token: string,
    source: 'safe-storage' | 'historical-plaintext',
    options: SessionTokenMigrationOptions
  ): Promise<void> {
    return mutateTokenFile(filePath, async () => {
      assertMutationOwnership(options)
      const resource = fileResource(filePath)
      const migration = migrationAuthorities.get(options)!
      if (!hasReadAuthority(migration.current, resource)) return
      const bytes = readRegularFallbackFile(filePath)
      if (bytes === null) return
      const current =
        source === 'safe-storage'
          ? safeStorage.decryptString(bytes)
          : (JSON.parse(bytes.toString('utf8')) as { token?: unknown })?.token
      if (current !== token) return
      assertMutationOwnership(options)
      await publishSourceMutation(
        resource,
        async () => {
          await retireTokenFileDurably(filePath)
        },
        options,
        source === 'safe-storage' ? 'safe-storage' : 'isolated-plaintext',
        false
      )
    })
  }

  /** One migration policy serves configured aliases and the pre-scoping global slot. */
  private async migrateLegacyCandidates(
    envKey: string,
    candidates: readonly { account: string; encrypted: string; plaintext: string }[],
    keytar: KeytarModule | null,
    options: SessionTokenMigrationOptions
  ): Promise<string | null> {
    for (const candidate of candidates) {
      let selected: SessionTokenSelection | undefined
      if (keytar) {
        try {
          const token = await this.readMigrationNativeSource(candidate.account, keytar, options)
          if (token) {
            const source = await this.setSessionTokenOnce(token, envKey, options)
            await this.retireMigrationNativeSource(candidate.account, token, keytar, options).catch(
              error => rethrowMigrationError(error, options)
            )
            selected = { token, source }
          }
        } catch (error) {
          rethrowMigrationError(error, options)
        }
      }
      if (selected)
        return this.reportCompletedMigration(selected.token, selected.source, envKey, options)

      if (isQualifiedSafeStorageAvailable()) {
        try {
          const token = await this.readMigrationFileSource(
            candidate.encrypted,
            'safe-storage',
            options
          )
          if (token) {
            const source = await this.setSessionTokenOnce(token, envKey, options)
            await this.retireMigrationFileSource(
              candidate.encrypted,
              token,
              'safe-storage',
              options
            ).catch(error => rethrowMigrationError(error, options))
            selected = { token, source }
          }
        } catch (error) {
          rethrowMigrationError(error, options)
        }
      }
      if (selected)
        return this.reportCompletedMigration(selected.token, selected.source, envKey, options)

      // Plaintext is a narrowly isolated unpackaged-development format. Production readers must
      // require fresh authentication instead of importing it into a secure provider, since that
      // would silently convert an unverified historical credential into an authoritative one.
      if (this.isolatedUserDataPath !== undefined) {
        try {
          const token = await this.readMigrationFileSource(
            candidate.plaintext,
            'historical-plaintext',
            options
          )
          if (token) {
            const source = await this.setSessionTokenOnce(token, envKey, options)
            await this.retireMigrationFileSource(
              candidate.plaintext,
              token,
              'historical-plaintext',
              options
            ).catch(error => rethrowMigrationError(error, options))
            selected = { token, source }
          }
        } catch (error) {
          rethrowMigrationError(error, options)
        }
        if (selected)
          return this.reportCompletedMigration(selected.token, selected.source, envKey, options)
      }
    }
    return null
  }

  private async migrateLegacyEnvToken(
    envKey: string,
    legacyEnvKeys: readonly string[],
    keytar: KeytarModule | null,
    options: SessionTokenMigrationOptions
  ): Promise<string | null> {
    const keys = Array.from(
      new Set(
        legacyEnvKeys.map(key => String(key || '').trim()).filter(key => key && key !== envKey)
      )
    )
    const candidates: { account: string; encrypted: string; plaintext: string }[] = []
    for (const key of keys) {
      assertEnvKey(key)
      candidates.push({
        account: accountFor(key),
        encrypted: await this.encryptedFilePath(key),
        plaintext: await this.plainFilePath(key),
      })
    }
    return this.migrateLegacyCandidates(envKey, candidates, keytar, options)
  }

  private async migrateLegacyGlobalToken(
    envKey: string,
    keytar: KeytarModule | null,
    options: SessionTokenMigrationOptions
  ): Promise<string | null> {
    return this.migrateLegacyCandidates(
      envKey,
      [
        {
          account: LEGACY_ACCOUNT,
          encrypted: await legacyEncryptedFilePath(),
          plaintext: await legacyFilePath(),
        },
      ],
      keytar,
      options
    )
  }

  async setSessionToken(
    token: string,
    envKey: string,
    options: { requireKeytar?: boolean } & SessionTokenMutationOptions = {}
  ): Promise<void> {
    return this.trackOperation(async () => {
      await this.setSessionTokenOnce(token, envKey, options)
    })
  }

  /** Persist only through safeStorage, bypassing Keytar and the plaintext fallback. */
  async setSafeStorageSessionToken(
    token: string,
    envKey: string,
    options: SessionTokenMutationOptions = {}
  ): Promise<void> {
    return this.trackOperation(async () => {
      assertEnvKey(envKey)
      if (this.isolatedUserDataPath !== undefined) await this.verifiedStorageBase()
      if (!isQualifiedSafeStorageAvailable()) {
        throw new SessionTokenStorageUnavailableBeforeWriteError('safe-storage')
      }
      options = await this.prepareMutationAuthority(envKey, options)
      await writeTokenFileAtomic(
        await this.encryptedFilePath(envKey),
        safeStorage.encryptString(token),
        'safe-storage',
        token,
        options
      )
    })
  }

  /**
   * Write one immutable V1 candidate slot. This is storage machinery only: the returned source
   * descriptor is not accepted authority, and restore never scans or reads candidate slots.
   */
  async writeSessionTokenCandidate(input: {
    authorization: SessionAuthorityStorageAuthorization
    publicationLease: SessionAuthorityCandidatePublicationLease
    token: string
    envKey: string
    accountId: string
    transactionId: string
    sourceRef: string
    sourceRevision: string
    source: 'keytar' | 'safe-storage'
    authorityScope: SessionAuthorityStorageScope
  }): Promise<SessionTokenCandidatePublicationReceipt> {
    return this.trackOperation(async () => {
      assertVersionedSessionPlatform()
      assertEnvKey(input.envKey)
      const authorityScope = input.authorityScope
      const storageScope = await this.assertSessionAuthorityStorageScopeCurrent(authorityScope)
      try {
        if (
          !input.token ||
          !input.accountId ||
          input.accountId.length > 256 ||
          !SOURCE_UUID_SHAPE.test(input.transactionId) ||
          !SOURCE_UUID_SHAPE.test(input.sourceRef) ||
          !SOURCE_UUID_SHAPE.test(input.sourceRevision)
        )
          throw new Error('Versioned session candidate has invalid transaction metadata')
        if (
          !consumeSessionAuthorityStorageAuthorization(input.authorization, this, authorityScope, {
            purpose: 'candidate-write',
            candidate: {
              transactionId: input.transactionId,
              candidateHash: createHash('sha256').update(input.token).digest('hex'),
              sourceKind: input.source,
              sourceRef: input.sourceRef,
              sourceRevision: input.sourceRevision,
              accountId: input.accountId,
              envKey: input.envKey,
            },
          })
        )
          throw new Error('Candidate write requires a repository-issued publication permit')
        const publicationIdentity = {
          transactionId: input.transactionId,
          candidateHash: createHash('sha256').update(input.token).digest('hex'),
          sourceKind: input.source,
          sourceRef: input.sourceRef,
          sourceRevision: input.sourceRevision,
          accountId: input.accountId,
          envKey: input.envKey,
        }
        const requireCurrentPublication = (mayHavePublished: boolean): void => {
          if (
            !revalidateSessionAuthorityStorageAuthorization(
              input.authorization,
              this,
              authorityScope
            ) ||
            !isSessionAuthorityCandidatePublicationCurrent(
              input.publicationLease,
              this,
              authorityScope,
              publicationIdentity
            )
          ) {
            if (mayHavePublished) throw new SessionTokenCandidatePublicationSupersededError(true)
            throw new SessionTokenStorageSupersededBeforeWriteError()
          }
        }
        requireCurrentPublication(false)

        const envelope: SessionTokenEnvelopeV1 = {
          // `format` identifies the persisted envelope family; `version` is its schema revision.
          format: 'evenfire-session-token',
          version: 1,
          transactionId: input.transactionId,
          sourceRef: input.sourceRef,
          sourceRevision: input.sourceRevision,
          envKey: input.envKey,
          accountId: input.accountId,
          sessionToken: input.token,
        }
        const serialized = JSON.stringify(envelope)
        let exactStoredValue: string | Buffer | undefined

        if (input.source === 'keytar') {
          if (this.isolatedUserDataPath !== undefined)
            throw new SessionTokenStorageUnavailableBeforeWriteError('keytar')
          const account = candidateAccountFor(input.envKey, input.sourceRef)
          await accessKeytarAccount(account, async () => {
            const keytar = await loadVersionedKeytar()
            if (!keytar) throw new SessionTokenStorageUnavailableBeforeWriteError('keytar')
            const existing = await keytar.getPassword(SERVICE, account)
            if (existing !== null && existing !== serialized)
              throw new Error('Versioned Keytar candidate slot is already occupied')
            if (existing === null) {
              requireCurrentPublication(false)
              await keytar.setPassword(SERVICE, account, serialized)
              requireCurrentPublication(true)
            }
            const readBack = existing ?? (await keytar.getPassword(SERVICE, account))
            if (readBack !== serialized)
              throw new Error('Versioned Keytar candidate failed exact read-back verification')
            parseSessionTokenEnvelopeV1(readBack, envelope)
            exactStoredValue = readBack
          })
        } else {
          if (this.isolatedUserDataPath !== undefined) await this.verifiedStorageBase()
          requireQualifiedSafeStorage('safe-storage', 'write')
          const storageBase = storageScope.storageRoot
          await ensureVersionedSessionDirectory(storageBase, () =>
            this.assertSessionAuthorityStorageScopeCurrentSync(authorityScope)
          )
          const file = candidateFilePath(storageBase, input.envKey, input.sourceRef)
          const encrypted = safeStorage.encryptString(serialized)
          requireQualifiedSafeStorage('safe-storage', 'write')
          exactStoredValue = await mutateTokenFile(file, async () => {
            this.assertSessionAuthorityStorageScopeCurrentSync(authorityScope)
            const existing = readRegularFallbackFile(file)
            if (existing) {
              requireQualifiedSafeStorage('safe-storage', 'read')
              // safeStorage ciphertext may use a fresh nonce on every call. A retry for the same
              // immutable sourceRef therefore validates the existing authenticated envelope, not
              // equality with ciphertext generated by this retry.
              const existingEnvelope = parseSessionTokenEnvelopeV1(
                safeStorage.decryptString(existing),
                envelope
              )
              if (existingEnvelope.sessionToken !== input.token)
                throw new Error('already-published candidate does not match the retry token')
            } else {
              requireCurrentPublication(false)
              await writeTokenFileAtomicOnce(
                file,
                encrypted,
                'safe-storage',
                input.token,
                {},
                () => this.assertSessionAuthorityStorageScopeCurrentSync(authorityScope),
                true
              )
              requireCurrentPublication(true)
            }
            this.assertSessionAuthorityStorageScopeCurrentSync(authorityScope)
            const readBack = existing ?? readRegularFallbackFile(file)
            if (!readBack || (!existing && !readBack.equals(encrypted)))
              throw new Error('Versioned safeStorage candidate failed exact ciphertext read-back')
            requireQualifiedSafeStorage('safe-storage', 'read')
            const readBackEnvelope = parseSessionTokenEnvelopeV1(
              safeStorage.decryptString(readBack),
              envelope
            )
            if (readBackEnvelope.sessionToken !== input.token)
              throw new Error('verified candidate does not match the requested token')
            this.assertSessionAuthorityStorageScopeCurrentSync(authorityScope)
            return readBack
          })
        }

        if (exactStoredValue === undefined)
          throw new Error('Versioned session candidate did not produce an exact stored value')
        requireCurrentPublication(true)

        const source: SessionAuthorityCredentialSource = {
          kind: input.source,
          format: 'v1',
          transactionId: input.transactionId,
          envKey: input.envKey,
          accountId: input.accountId,
          sourceRef: input.sourceRef,
          sourceRevision: input.sourceRevision,
          storedValueDigest: digestSessionAuthoritySource(
            {
              sourceKind: input.source,
              sourceRef: input.sourceRef,
              envKey: input.envKey,
              accountId: input.accountId,
            },
            exactStoredValue
          ),
        }
        const verifiedScope = await this.assertSessionAuthorityStorageScopeCurrent(authorityScope)
        if (
          verifiedScope.storageRoot !== storageScope.storageRoot ||
          !sameStorageRootIdentity(verifiedScope.rootIdentity, storageScope.rootIdentity)
        )
          throw new Error('Session authority storage root changed during candidate publication')
        const receipt = Object.freeze({
          source: JSON.parse(JSON.stringify(source)) as SessionAuthorityCredentialSource,
        }) as SessionTokenCandidatePublicationReceipt
        candidatePublicationReceipts.set(receipt as object, {
          issuer: this.proofAuthority,
          storageRoot: storageScope.storageRoot,
          rootIdentity: storageScope.rootIdentity,
          transactionId: input.transactionId,
          candidateHash: createHash('sha256').update(input.token).digest('hex'),
          source,
        })
        return receipt
      } finally {
        finishSessionAuthorityStorageAuthorization(input.authorization)
      }
    })
  }

  /** Read only the exact V1 candidate named by its source descriptor; never fall back or scan. */
  async readSessionTokenCandidate(
    source: SessionAuthorityCredentialSource,
    transactionId: string,
    authorization: SessionAuthorityCredentialReadAuthorization,
    authorityScope: SessionAuthorityStorageScope
  ): Promise<string | null> {
    return this.trackOperation(async () => {
      assertVersionedSessionPlatform()
      const scope = authorityScope
      const storageScope = await this.assertSessionAuthorityStorageScopeCurrent(scope)
      if (
        source.format !== 'v1' ||
        (source.kind !== 'keytar' && source.kind !== 'safe-storage') ||
        !SOURCE_UUID_SHAPE.test(transactionId) ||
        source.transactionId !== transactionId ||
        !SOURCE_UUID_SHAPE.test(source.sourceRef) ||
        !source.sourceRevision ||
        !SOURCE_UUID_SHAPE.test(source.sourceRevision)
      )
        throw new Error('Invalid versioned session source descriptor')
      assertEnvKey(source.envKey)
      if (!beginSessionAuthorityCredentialRead(authorization, this, scope, source, transactionId))
        throw new Error('Session source read requires current repository authority')
      const expected = {
        version: 1 as const,
        transactionId,
        sourceRef: source.sourceRef,
        sourceRevision: source.sourceRevision,
        envKey: source.envKey,
        accountId: source.accountId,
        sessionToken: '',
      }

      try {
        let token: string | null
        if (source.kind === 'keytar') {
          if (this.isolatedUserDataPath !== undefined)
            throw new SessionTokenSourceUnavailableError('keytar')
          const account = candidateAccountFor(source.envKey, source.sourceRef)
          token = await accessKeytarAccount(account, async () => {
            const keytar = await loadVersionedKeytar()
            if (!keytar) throw new SessionTokenSourceUnavailableError('keytar')
            const stored = await keytar.getPassword(SERVICE, account)
            if (stored === null) return null
            if (
              digestSessionAuthoritySource(
                {
                  sourceKind: source.kind,
                  sourceRef: source.sourceRef,
                  envKey: source.envKey,
                  accountId: source.accountId,
                },
                stored
              ) !== source.storedValueDigest
            )
              throw new Error('Versioned Keytar source digest does not match its authority receipt')
            return parseSessionTokenEnvelopeV1(stored, expected).sessionToken
          })
        } else {
          if (this.isolatedUserDataPath !== undefined) await this.verifiedStorageBase()
          requireQualifiedSafeStorage('safe-storage', 'read')
          const storageBase = storageScope.storageRoot
          await ensureVersionedSessionDirectory(storageBase, () =>
            this.assertSessionAuthorityStorageScopeCurrentSync(scope)
          )
          const file = candidateFilePath(storageBase, source.envKey, source.sourceRef)
          token = await mutateTokenFile(file, async () => {
            this.assertSessionAuthorityStorageScopeCurrentSync(scope)
            const stored = readRegularFallbackFile(file)
            if (!stored) return null
            if (
              digestSessionAuthoritySource(
                {
                  sourceKind: source.kind,
                  sourceRef: source.sourceRef,
                  envKey: source.envKey,
                  accountId: source.accountId,
                },
                stored
              ) !== source.storedValueDigest
            )
              throw new Error(
                'Versioned safeStorage source digest does not match its authority receipt'
              )
            requireQualifiedSafeStorage('safe-storage', 'read')
            return parseSessionTokenEnvelopeV1(safeStorage.decryptString(stored), expected)
              .sessionToken
          })
        }
        await this.assertSessionAuthorityStorageScopeCurrent(scope)
        if (!finishSessionAuthorityCredentialRead(authorization, this, scope))
          throw new Error('Session source authority changed during credential read')
        return token
      } catch (error) {
        cancelSessionAuthorityCredentialRead(authorization, this, scope)
        throw error
      }
    })
  }

  /**
   * Delete only the exact unselected V1 slot. The caller must hold the authority coordinator's
   * source-ownership lane for the entire operation; TokenStore additionally serializes the exact
   * native account or file resource and drains it on quit.
   */
  async deleteSessionTokenCandidateIfUnselected(
    source: VersionedSessionCredentialSource,
    authorization: SessionAuthorityStorageAuthorization,
    authorityScope?: SessionAuthorityStorageScope
  ): Promise<SessionTokenCandidateCleanupResult> {
    return this.trackOperation(async () => {
      const scope = authorityScope ?? (await this.createSessionAuthorityStorageScopeOnce())
      try {
        if (
          !consumeSessionAuthorityStorageAuthorization(authorization, this, scope, {
            purpose: 'source-delete',
            source,
          })
        )
          throw new SessionAuthorityStorageAuthorizationError()
        return await this.deleteSessionTokenCandidateIfUnselectedOnce(source, scope, authorization)
      } finally {
        finishSessionAuthorityStorageAuthorization(authorization)
      }
    })
  }

  /**
   * Exact cleanup operation for authority-receipt retirement. A caller-provided result string is
   * not evidence; only the opaque proof returned here can be resolved by the authority repository.
   */
  async deleteSessionTokenCandidateIfUnselectedWithProof(
    source: VersionedSessionCredentialSource,
    authorization: SessionAuthorityStorageAuthorization,
    authorityScope?: SessionAuthorityStorageScope
  ): Promise<{ outcome: SessionTokenCandidateCleanupResult; proof?: SessionTokenAbsenceProof }> {
    return this.deleteSessionCredentialSourceIfUnselectedWithProof(
      source,
      authorization,
      authorityScope
    )
  }

  /** Delete one exact V1 or observed historical source and issue source-specific absence proof. */
  async deleteSessionCredentialSourceIfUnselectedWithProof(
    source: SessionAuthorityCredentialSource,
    authorization: SessionAuthorityStorageAuthorization,
    authorityScope?: SessionAuthorityStorageScope
  ): Promise<{ outcome: SessionTokenCandidateCleanupResult; proof?: SessionTokenAbsenceProof }> {
    return this.trackOperation(async () => {
      const scope = authorityScope ?? (await this.createSessionAuthorityStorageScopeOnce())
      try {
        if (
          !consumeSessionAuthorityStorageAuthorization(authorization, this, scope, {
            purpose: 'source-delete',
            source,
          })
        )
          throw new SessionAuthorityStorageAuthorizationError()
        const outcome =
          source.format === 'v1'
            ? await this.deleteSessionTokenCandidateIfUnselectedOnce(source, scope, authorization)
            : await this.deleteObservedLegacySessionCredentialSourceOnce(
                source,
                scope,
                authorization
              )
        if (outcome === 'different-value') return { outcome }
        const storageScope = await this.assertSessionAuthorityStorageScopeCurrent(scope)
        return {
          outcome,
          proof: issueAbsenceProof(
            this.proofAuthority,
            storageScope.storageRoot,
            storageScope.rootIdentity,
            {
              kind: 'source-absent',
              transactionId: source.format === 'v1' ? source.transactionId : null,
              source,
              outcome,
            }
          ),
        }
      } finally {
        finishSessionAuthorityStorageAuthorization(authorization)
      }
    })
  }

  private async deleteObservedLegacySessionCredentialSourceOnce(
    source: Extract<SessionAuthorityCredentialSource, { format: 'v0' }>,
    authorityScope: SessionAuthorityStorageScope,
    authorization: SessionAuthorityStorageAuthorization
  ): Promise<SessionTokenCandidateCleanupResult> {
    if (
      !SOURCE_UUID_SHAPE.test(source.sourceRef) ||
      !/^[0-9a-f]{64}$/i.test(source.storedValueDigest) ||
      !ENV_KEY_SHAPE.test(source.envKey) ||
      !this.isLegacySessionCredentialSourceBoundToScope(source, authorityScope)
    )
      throw new Error('Invalid legacy session source descriptor')
    const storageScope = await this.assertSessionAuthorityStorageScopeCurrent(authorityScope)
    const matchesObservedValue = (value: string | Buffer): boolean =>
      digestSessionAuthoritySource(
        {
          sourceKind: source.kind,
          sourceRef: source.sourceRef,
          envKey: source.envKey,
          accountId: source.accountId,
        },
        value
      ) === source.storedValueDigest

    if (source.kind === 'keytar') {
      const locator = source.legacyLocator
      if (
        locator.kind !== 'keytar-account' ||
        (locator.account !== LEGACY_ACCOUNT &&
          !/^session-token::[a-z0-9_]+-[0-9a-f]{12}$/.test(locator.account)) ||
        this.isolatedUserDataPath !== undefined
      )
        throw new Error('Legacy Keytar cleanup locator is not an allowed exact source')
      const keytar = await loadVersionedKeytar()
      if (!keytar) throw new SessionTokenSourceUnavailableError('keytar')
      const outcome = await accessKeytarAccount(locator.account, async () => {
        if (!revalidateSessionAuthorityStorageAuthorization(authorization, this, authorityScope))
          throw new Error('Legacy source cleanup authority changed before inspection')
        const current = await keytar.getPassword(SERVICE, locator.account)
        if (!revalidateSessionAuthorityStorageAuthorization(authorization, this, authorityScope))
          throw new Error('Legacy source cleanup authority changed after inspection')
        if (current === null) return 'already-absent'
        if (!matchesObservedValue(current)) return 'different-value'
        if (!revalidateSessionAuthorityStorageAuthorization(authorization, this, authorityScope))
          throw new Error('Legacy source cleanup authority changed before deletion')
        await keytar.deletePassword(SERVICE, locator.account)
        const remaining = await keytar.getPassword(SERVICE, locator.account)
        if (remaining !== null)
          throw new Error('Legacy Keytar credential remains after exact deletion')
        return 'deleted'
      })
      await this.assertSessionAuthorityStorageScopeCurrent(authorityScope)
      return outcome
    }

    const locator = source.legacyLocator
    const isSafeStorage = source.kind === 'safe-storage'
    if (
      (isSafeStorage && locator.kind !== 'safe-storage-file') ||
      (!isSafeStorage && locator.kind !== 'plaintext-file') ||
      (locator.kind !== 'keytar-account' &&
        locator.envKey !== null &&
        !ENV_KEY_SHAPE.test(locator.envKey))
    )
      throw new Error('Legacy file cleanup locator is not an allowed exact source')
    if (locator.kind === 'keytar-account')
      throw new Error('Legacy file cleanup cannot use a Keytar locator')
    const locatorEnvKey = locator.envKey
    if (this.isolatedUserDataPath !== undefined && locatorEnvKey === null)
      throw new Error('Isolated development storage cannot address a global legacy credential')
    const filename = isSafeStorage ? 'session-token.enc' : 'session-token.json'
    const file = path.join(
      storageScope.storageRoot,
      locatorEnvKey === null
        ? filename
        : `session-token-${locatorEnvKey}.${isSafeStorage ? 'enc' : 'json'}`
    )
    const outcome = await mutateTokenFile(file, async () => {
      this.assertSessionAuthorityStorageScopeCurrentSync(authorityScope)
      if (!revalidateSessionAuthorityStorageAuthorization(authorization, this, authorityScope))
        throw new Error('Legacy source cleanup authority changed before inspection')
      const current = readRegularFallbackFile(file)
      if (!revalidateSessionAuthorityStorageAuthorization(authorization, this, authorityScope))
        throw new Error('Legacy source cleanup authority changed after inspection')
      if (current === null) return 'already-absent'
      if (!matchesObservedValue(current)) return 'different-value'
      // The operation may have waited behind an earlier mutation. Revalidate its root identity
      // inside the lane and immediately before destructive filesystem mutation.
      this.assertSessionAuthorityStorageScopeCurrentSync(authorityScope)
      if (!revalidateSessionAuthorityStorageAuthorization(authorization, this, authorityScope))
        throw new Error('Legacy source cleanup authority changed before deletion')
      await retireTokenFileDurably(file)
      this.assertSessionAuthorityStorageScopeCurrentSync(authorityScope)
      if (readRegularFallbackFile(file) !== null)
        throw new Error('Legacy credential remains after exact file deletion')
      return 'deleted'
    })
    await this.assertSessionAuthorityStorageScopeCurrent(authorityScope)
    return outcome
  }

  /** Prove that a denied candidate's unique native/file slot is absent under both owner lanes. */
  async confirmSessionTokenCandidateSlotAbsent(
    candidate: SessionTokenCandidateIdentity,
    authorization: SessionAuthorityStorageAuthorization,
    authorityScope?: SessionAuthorityStorageScope
  ): Promise<{ outcome: 'absent' | 'present'; proof?: SessionTokenAbsenceProof }> {
    return this.trackOperation(async () => {
      const scope = authorityScope ?? (await this.createSessionAuthorityStorageScopeOnce())
      try {
        if (
          !consumeSessionAuthorityStorageAuthorization(authorization, this, scope, {
            purpose: 'candidate-cleanup',
            candidate: {
              transactionId: candidate.transactionId,
              candidateHash: candidate.candidateHash,
              sourceKind: candidate.source,
              sourceRef: candidate.sourceRef,
              sourceRevision: candidate.sourceRevision,
              accountId: candidate.accountId,
              envKey: candidate.envKey,
            },
          })
        )
          throw new Error('Candidate inspection requires a repository-issued cleanup permit')
        const inspected = await this.inspectUnacceptedSessionTokenCandidateOnce(
          candidate,
          scope,
          authorization
        )
        if (!revalidateSessionAuthorityStorageAuthorization(authorization, this, scope))
          throw new Error('Candidate cleanup authority changed after inspection')
        if (inspected !== null) return { outcome: 'present' as const }
        const storageScope = await this.assertSessionAuthorityStorageScopeCurrent(scope)
        return {
          outcome: 'absent' as const,
          proof: issueAbsenceProof(
            this.proofAuthority,
            storageScope.storageRoot,
            storageScope.rootIdentity,
            {
              kind: 'candidate-slot-absent',
              candidate: {
                transactionId: candidate.transactionId,
                candidateHash: candidate.candidateHash,
                sourceKind: candidate.source,
                sourceRef: candidate.sourceRef,
                sourceRevision: candidate.sourceRevision,
                envKey: candidate.envKey,
                accountId: candidate.accountId,
              },
            }
          ),
        }
      } finally {
        finishSessionAuthorityStorageAuthorization(authorization)
      }
    })
  }

  private async deleteSessionTokenCandidateIfUnselectedOnce(
    source: VersionedSessionCredentialSource,
    authorityScope: SessionAuthorityStorageScope,
    authorization: SessionAuthorityStorageAuthorization
  ): Promise<SessionTokenCandidateCleanupResult> {
    assertVersionedSessionPlatform()
    const storageScope = await this.assertSessionAuthorityStorageScopeCurrent(authorityScope)
    if (
      source.format !== 'v1' ||
      (source.kind !== 'keytar' && source.kind !== 'safe-storage') ||
      !SOURCE_UUID_SHAPE.test(source.transactionId) ||
      !SOURCE_UUID_SHAPE.test(source.sourceRef) ||
      typeof source.sourceRevision !== 'string' ||
      !SOURCE_UUID_SHAPE.test(source.sourceRevision) ||
      !/^[0-9a-f]{64}$/i.test(source.storedValueDigest)
    )
      throw new Error('Invalid versioned session source descriptor')
    assertEnvKey(source.envKey)
    const expected = {
      version: 1 as const,
      transactionId: source.transactionId,
      sourceRef: source.sourceRef,
      sourceRevision: source.sourceRevision,
      envKey: source.envKey,
      accountId: source.accountId,
      sessionToken: '',
    }

    if (source.kind === 'keytar') {
      if (this.isolatedUserDataPath !== undefined)
        throw new SessionTokenSourceUnavailableError('keytar')
      const account = candidateAccountFor(source.envKey, source.sourceRef)
      const outcome = await accessKeytarAccount(account, async () => {
        const keytar = await loadVersionedKeytar()
        if (!keytar) throw new SessionTokenSourceUnavailableError('keytar')
        if (!revalidateSessionAuthorityStorageAuthorization(authorization, this, authorityScope))
          throw new Error('Session source cleanup authority changed before inspection')
        const current = await keytar.getPassword(SERVICE, account)
        if (!revalidateSessionAuthorityStorageAuthorization(authorization, this, authorityScope))
          throw new Error('Session source cleanup authority changed after inspection')
        if (current === null) return 'already-absent'
        if (
          digestSessionAuthoritySource(
            {
              sourceKind: source.kind,
              sourceRef: source.sourceRef,
              envKey: source.envKey,
              accountId: source.accountId,
            },
            current
          ) !== source.storedValueDigest
        )
          return 'different-value'
        parseSessionTokenEnvelopeV1(current, expected)
        if (!revalidateSessionAuthorityStorageAuthorization(authorization, this, authorityScope))
          throw new Error('Session source cleanup authority changed before deletion')
        await keytar.deletePassword(SERVICE, account)
        const remaining = await keytar.getPassword(SERVICE, account)
        if (remaining !== null)
          throw new Error('Versioned Keytar candidate remains after exact deletion')
        return 'deleted'
      })
      await this.assertSessionAuthorityStorageScopeCurrent(authorityScope)
      return outcome
    }

    if (this.isolatedUserDataPath !== undefined) await this.verifiedStorageBase()
    const storageBase = storageScope.storageRoot
    await ensureVersionedSessionDirectory(storageBase, () =>
      this.assertSessionAuthorityStorageScopeCurrentSync(authorityScope)
    )
    const file = candidateFilePath(storageBase, source.envKey, source.sourceRef)
    const outcome = await mutateTokenFile(file, async () => {
      this.assertSessionAuthorityStorageScopeCurrentSync(authorityScope)
      if (!revalidateSessionAuthorityStorageAuthorization(authorization, this, authorityScope))
        throw new Error('Session source cleanup authority changed before inspection')
      const current = readRegularFallbackFile(file)
      if (!revalidateSessionAuthorityStorageAuthorization(authorization, this, authorityScope))
        throw new Error('Session source cleanup authority changed after inspection')
      if (current === null) return 'already-absent'
      if (
        digestSessionAuthoritySource(
          {
            sourceKind: source.kind,
            sourceRef: source.sourceRef,
            envKey: source.envKey,
            accountId: source.accountId,
          },
          current
        ) !== source.storedValueDigest
      )
        return 'different-value'
      requireQualifiedSafeStorage('safe-storage', 'read')
      parseSessionTokenEnvelopeV1(safeStorage.decryptString(current), expected)
      this.assertSessionAuthorityStorageScopeCurrentSync(authorityScope)
      if (!revalidateSessionAuthorityStorageAuthorization(authorization, this, authorityScope))
        throw new Error('Session source cleanup authority changed before deletion')
      await retireTokenFileDurably(file)
      // `syncDirectory` yields. The configured root may have been replaced while it was pending;
      // do not inspect a same-named file in that replacement root or issue absence evidence for it.
      this.assertSessionAuthorityStorageScopeCurrentSync(authorityScope)
      if (readRegularFallbackFile(file) !== null)
        throw new Error('Versioned safeStorage candidate remains after exact deletion')
      return 'deleted'
    })
    await this.assertSessionAuthorityStorageScopeCurrent(authorityScope)
    return outcome
  }

  /**
   * Reconcile a write that rejected after native/file dispatch before it returned a descriptor.
   * Only the exact transaction-owned envelope can be converted to a deletion receipt; unreadable,
   * changed or mismatched slots remain denied for later recovery.
   */
  async discardUnacceptedSessionTokenCandidate(
    candidate: SessionTokenCandidateIdentity,
    authorization: SessionAuthorityStorageAuthorization,
    authorityScope?: SessionAuthorityStorageScope
  ): Promise<SessionTokenCandidateCleanupResult> {
    return this.trackOperation(async () => {
      const scope = authorityScope ?? (await this.createSessionAuthorityStorageScopeOnce())
      try {
        if (
          !consumeSessionAuthorityStorageAuthorization(authorization, this, scope, {
            purpose: 'candidate-cleanup',
            candidate: {
              transactionId: candidate.transactionId,
              candidateHash: candidate.candidateHash,
              sourceKind: candidate.source,
              sourceRef: candidate.sourceRef,
              sourceRevision: candidate.sourceRevision,
              accountId: candidate.accountId,
              envKey: candidate.envKey,
            },
          })
        )
          throw new Error('Candidate discard requires a repository-issued cleanup permit')
        const source = await this.inspectUnacceptedSessionTokenCandidateOnce(
          candidate,
          scope,
          authorization
        )
        if (!revalidateSessionAuthorityStorageAuthorization(authorization, this, scope))
          throw new Error('Candidate cleanup authority changed after inspection')
        if (source === null) return 'already-absent'
        if (source === 'different-value') return 'different-value'
        return await this.deleteSessionTokenCandidateIfUnselectedOnce(source, scope, authorization)
      } finally {
        finishSessionAuthorityStorageAuthorization(authorization)
      }
    })
  }

  private async inspectUnacceptedSessionTokenCandidateOnce(
    candidate: SessionTokenCandidateIdentity,
    authorityScope: SessionAuthorityStorageScope,
    authorization: SessionAuthorityStorageAuthorization
  ): Promise<VersionedSessionCredentialSource | 'different-value' | null> {
    return (async () => {
      assertVersionedSessionPlatform()
      const storageScope = await this.assertSessionAuthorityStorageScopeCurrent(authorityScope)
      if (
        !candidate.accountId ||
        candidate.accountId.length > 256 ||
        !/^[0-9a-f]{64}$/i.test(candidate.candidateHash) ||
        !SOURCE_UUID_SHAPE.test(candidate.transactionId) ||
        !SOURCE_UUID_SHAPE.test(candidate.sourceRef) ||
        !SOURCE_UUID_SHAPE.test(candidate.sourceRevision)
      )
        throw new Error('Invalid unaccepted session candidate identity')
      assertEnvKey(candidate.envKey)
      const expected = {
        version: 1 as const,
        transactionId: candidate.transactionId,
        sourceRef: candidate.sourceRef,
        sourceRevision: candidate.sourceRevision,
        envKey: candidate.envKey,
        accountId: candidate.accountId,
        sessionToken: '',
      }
      const sourceDescriptor = (stored: string | Buffer): VersionedSessionCredentialSource => ({
        kind: candidate.source,
        format: 'v1',
        transactionId: candidate.transactionId,
        envKey: candidate.envKey,
        accountId: candidate.accountId,
        sourceRef: candidate.sourceRef,
        sourceRevision: candidate.sourceRevision,
        storedValueDigest: digestSessionAuthoritySource(
          {
            sourceKind: candidate.source,
            sourceRef: candidate.sourceRef,
            envKey: candidate.envKey,
            accountId: candidate.accountId,
          },
          stored
        ),
      })
      const matchesCandidate = (serialized: string): boolean => {
        const envelope = parseSessionTokenEnvelopeV1(serialized, expected)
        return (
          createHash('sha256').update(envelope.sessionToken).digest('hex') ===
          candidate.candidateHash
        )
      }

      if (candidate.source === 'keytar') {
        if (this.isolatedUserDataPath !== undefined)
          throw new SessionTokenSourceUnavailableError('keytar')
        const account = candidateAccountFor(candidate.envKey, candidate.sourceRef)
        const source = await accessKeytarAccount(account, async () => {
          const keytar = await loadVersionedKeytar()
          if (!keytar) throw new SessionTokenSourceUnavailableError('keytar')
          if (!revalidateSessionAuthorityStorageAuthorization(authorization, this, authorityScope))
            throw new Error('Candidate cleanup authority changed before inspection')
          const current = await keytar.getPassword(SERVICE, account)
          if (!revalidateSessionAuthorityStorageAuthorization(authorization, this, authorityScope))
            throw new Error('Candidate cleanup authority changed after inspection')
          if (current === null) return null
          try {
            if (!matchesCandidate(current)) return 'different-value'
          } catch {
            return 'different-value'
          }
          return sourceDescriptor(current)
        })
        await this.assertSessionAuthorityStorageScopeCurrent(authorityScope)
        return source
      }

      if (this.isolatedUserDataPath !== undefined) await this.verifiedStorageBase()
      requireQualifiedSafeStorage('safe-storage', 'read')
      const storageBase = storageScope.storageRoot
      await ensureVersionedSessionDirectory(storageBase, () =>
        this.assertSessionAuthorityStorageScopeCurrentSync(authorityScope)
      )
      const file = candidateFilePath(storageBase, candidate.envKey, candidate.sourceRef)
      const source = await mutateTokenFile(file, async () => {
        this.assertSessionAuthorityStorageScopeCurrentSync(authorityScope)
        if (!revalidateSessionAuthorityStorageAuthorization(authorization, this, authorityScope))
          throw new Error('Candidate cleanup authority changed before inspection')
        const current = readRegularFallbackFile(file)
        if (!revalidateSessionAuthorityStorageAuthorization(authorization, this, authorityScope))
          throw new Error('Candidate cleanup authority changed after inspection')
        if (current === null) return null
        requireQualifiedSafeStorage('safe-storage', 'read')
        try {
          if (!matchesCandidate(safeStorage.decryptString(current))) return 'different-value'
        } catch {
          return 'different-value'
        }
        return sourceDescriptor(current)
      })
      await this.assertSessionAuthorityStorageScopeCurrent(authorityScope)
      return source
    })()
  }

  /** Opaque observation of every supported fallback path; never an authentication grant. */
  async snapshotSessionTokenFallbackFiles(
    envKey: string,
    options: { legacyEnvKeys?: readonly string[] } & SessionTokenMutationOptions = {}
  ): Promise<SessionTokenFallbackSnapshot> {
    return this.trackOperation(async () => {
      assertEnvKey(envKey)
      assertMutationOwnership(options)
      const envKeys = Array.from(
        new Set([
          envKey,
          ...(options.legacyEnvKeys ?? []).map(key => String(key || '').trim()).filter(Boolean),
        ])
      )
      for (const key of envKeys) assertEnvKey(key)
      const storageBase = await this.verifiedStorageBase()
      assertMutationOwnership(options)
      const filePaths = envKeys.flatMap(key => [
        path.join(storageBase, `session-token-${key}.enc`),
        path.join(storageBase, `session-token-${key}.json`),
      ])
      if (this.isolatedUserDataPath === undefined)
        filePaths.push(
          path.join(storageBase, 'session-token.enc'),
          path.join(storageBase, 'session-token.json')
        )
      const files = await mutateTokenFiles(filePaths, async () => {
        const observed: { filePath: string; bytes: Buffer | null }[] = []
        for (const filePath of filePaths) {
          assertMutationOwnership(options)
          observed.push({ filePath, bytes: readRegularFallbackFile(filePath) })
        }
        return observed
      })
      assertMutationOwnership(options)
      const snapshot = Object.freeze({}) as SessionTokenFallbackSnapshot
      fallbackSnapshots.set(snapshot, {
        storageBase,
        activeEncryptedFilePath: path.join(storageBase, `session-token-${envKey}.enc`),
        files,
      })
      return snapshot
    })
  }

  /**
   * Full mode verifies topology absence, except a verified encrypted authority.
   * onlyIfMatches instead verifies retirement of matching observed rejected values.
   */
  async retireSessionTokenFallbackFilesIfUnchanged(
    snapshot: SessionTokenFallbackSnapshot,
    options: SessionTokenMutationOptions & {
      preserveActiveEncryptedToken?: string
      onlyIfMatches?: string
      readAuthority?: SessionTokenReadAuthority
    } = {}
  ): Promise<boolean> {
    return this.trackOperation(async () => {
      assertMutationOwnership(options)
      if (
        options.onlyIfMatches !== undefined &&
        (typeof options.onlyIfMatches !== 'string' || options.onlyIfMatches.length === 0)
      )
        throw new Error('Conditional fallback cleanup requires a nonempty rejected token')
      if (options.onlyIfMatches !== undefined && options.preserveActiveEncryptedToken !== undefined)
        throw new Error('Conditional rejection cleanup cannot preserve an encrypted authority')
      const observed = fallbackSnapshots.get(snapshot)
      if (!observed) throw new Error('Invalid session-token fallback snapshot')
      const storageBase = await this.verifiedStorageBase()
      if (options.onlyIfMatches !== undefined) {
        const authority = options.readAuthority && readAuthorities.get(options.readAuthority)
        if (!authority || authority.storageBase !== storageBase)
          throw new Error('Conditional fallback cleanup requires original read authority')
      }
      assertMutationOwnership(options)
      if (storageBase !== observed.storageBase)
        throw new Error('Session-token fallback snapshot storage directory changed')
      return mutateTokenFiles(
        observed.files.map(({ filePath }) => filePath),
        async () => {
          const hasEncryptedAuthority = (): boolean => {
            assertMutationOwnership(options)
            const encrypted = readRegularFallbackFile(observed.activeEncryptedFilePath)
            if (encrypted === null) return false
            if (!isQualifiedSafeStorageAvailable()) {
              throw new Error(
                'Electron safeStorage is unavailable for session-token fallback retirement'
              )
            }
            return safeStorage.decryptString(encrypted) === options.preserveActiveEncryptedToken
          }
          const preserveEncrypted = options.preserveActiveEncryptedToken !== undefined
          const matchesRejectedToken = (filePath: string, bytes: Buffer): boolean => {
            if (options.onlyIfMatches === undefined) return true
            let token: unknown
            if (filePath.endsWith('.enc')) {
              if (!isQualifiedSafeStorageAvailable())
                throw new Error(
                  'Electron safeStorage is unavailable for conditional fallback cleanup'
                )
              token = safeStorage.decryptString(bytes)
            } else {
              try {
                const data = JSON.parse(bytes.toString('utf8')) as { token?: unknown }
                token = data?.token
              } catch {
                throw new Error('Session-token fallback has an invalid producer format')
              }
            }
            if (typeof token !== 'string' || token.length === 0)
              throw new Error('Session-token fallback has an invalid producer format')
            return token === options.onlyIfMatches
          }
          // A source-bound caller can preserve its own verified publication even
          // when the observation preceded that write. No other path gains authority.
          if (preserveEncrypted && !hasEncryptedAuthority()) return false
          let complete = true
          const matchingPaths: string[] = []
          for (const { filePath, bytes } of observed.files) {
            assertMutationOwnership(options)
            if (preserveEncrypted && filePath === observed.activeEncryptedFilePath) continue
            if (
              options.onlyIfMatches !== undefined &&
              !hasReadAuthority(options.readAuthority, fileResource(filePath))
            ) {
              complete = false
              continue
            }
            const current = readRegularFallbackFile(filePath)
            if (current === null) continue
            if (bytes === null || !current.equals(bytes)) {
              complete = false
              continue
            }
            if (!matchesRejectedToken(filePath, current)) continue
            matchingPaths.push(filePath)
          }
          const publications: (() => void)[] = []
          try {
            for (const filePath of matchingPaths) {
              assertMutationOwnership(options)
              // Raw compare/unlink cannot reacquire a path held by this complete group.
              publications.push(beginSourcePublication(fileResource(filePath)))
              await retireTokenFileDurably(filePath)
            }
            // Also flush verified absence when retrying a previous failed POSIX sync. Windows
            // source retirement uses a write-through rename for each exact file above.
            if (process.platform !== 'win32') await syncDirectory(storageBase)
            assertMutationOwnership(options)
            for (const { filePath, bytes } of observed.files) {
              assertMutationOwnership(options)
              if (preserveEncrypted && filePath === observed.activeEncryptedFilePath) continue
              const remaining = readRegularFallbackFile(filePath)
              if (remaining === null) continue
              if (
                options.onlyIfMatches === undefined ||
                bytes === null ||
                !remaining.equals(bytes) ||
                matchesRejectedToken(filePath, remaining)
              )
                complete = false
            }
            if (preserveEncrypted && !hasEncryptedAuthority()) return false
            return complete
          } finally {
            for (const completePublication of publications) completePublication()
          }
        }
      )
    })
  }

  /** Remove only this rejected attempt's encrypted token; never clear another source. */
  async discardSafeStorageSessionTokenIfMatches(
    token: string,
    envKey: string,
    options: SessionTokenMutationOptions = {}
  ): Promise<boolean> {
    return this.trackOperation(async () => {
      assertEnvKey(envKey)
      assertMutationOwnership(options)
      const file = await this.encryptedFilePath(envKey)
      return mutateTokenFile(file, async () => {
        assertMutationOwnership(options)
        let completePublication: (() => void) | undefined
        try {
          let descriptor: number | undefined
          try {
            const flags =
              process.platform === 'win32'
                ? fsSync.constants.O_RDONLY
                : fsSync.constants.O_RDONLY |
                  fsSync.constants.O_NONBLOCK |
                  fsSync.constants.O_NOFOLLOW
            descriptor = fsSync.openSync(file, flags)
            if (!fsSync.fstatSync(descriptor).isFile()) {
              throw new Error('Encrypted session token is not a regular file')
            }
            if (process.platform === 'win32' && !fsSync.lstatSync(file).isFile()) {
              throw new Error('Encrypted session token is not a regular file')
            }
            const encrypted = fsSync.readFileSync(descriptor)
            if (safeStorage.decryptString(encrypted) !== token) return false
            assertMutationOwnership(options)
            // No await between inspection and unlink: another main-process producer
            // cannot replace the compared file during this conditional deletion.
            completePublication = beginSourcePublication(fileResource(file))
            await retireTokenFileDurably(file)
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
            throw error
          } finally {
            if (descriptor !== undefined) fsSync.closeSync(descriptor)
          }
          return true
        } finally {
          completePublication?.()
        }
      })
    })
  }

  /** Repair only the rejected candidate, never an independently replaced native value. */
  async repairKeytarSessionTokenIfMatches(
    attemptedToken: string,
    previousToken: string | null,
    envKey: string,
    options: SessionTokenMutationOptions & { candidateAuthority?: SessionTokenReadAuthority } = {}
  ): Promise<boolean> {
    return this.trackOperation(async () => {
      assertEnvKey(envKey)
      assertMutationOwnership(options)
      if (this.isolatedUserDataPath !== undefined) {
        await this.verifiedStorageBase()
        throw new SessionTokenStorageUnavailableBeforeWriteError()
      }
      const account = accountFor(envKey)
      return accessKeytarAccount(account, async () => {
        if (!hasCandidateAuthority(options.candidateAuthority, envKey, nativeResource(account)))
          return false
        options = await this.prepareMutationAuthority(envKey, options)
        const keytar = await loadKeytar()
        if (!keytar) throw new SessionTokenStorageUnavailableBeforeWriteError()
        assertMutationOwnership(options)
        const current = await keytar.getPassword(SERVICE, account)
        assertMutationOwnership(options)
        if (!hasCandidateAuthority(options.candidateAuthority, envKey, nativeResource(account)))
          return false
        if (current !== attemptedToken) return false
        if (previousToken === null) {
          await publishSourceMutation(
            nativeResource(account),
            async () => {
              await keytar.deletePassword(SERVICE, account)
              assertMutationOwnership(options)
              const remaining = await keytar.getPassword(SERVICE, account)
              assertMutationOwnership(options)
              if (remaining !== null)
                throw new Error('Native session token remains after conditional deletion')
            },
            options
          )
          return true
        }
        notifyMutationDispatch(options, 'keytar', previousToken)
        await publishSourceMutation(
          nativeResource(account),
          () => keytar.setPassword(SERVICE, account, previousToken),
          options
        )
        return true
      })
    })
  }

  /** File repair compares and replaces inside the same complete mutation lane. */
  async repairSafeStorageSessionTokenIfMatches(
    attemptedToken: string,
    previousToken: string | null,
    envKey: string,
    options: SessionTokenMutationOptions & {
      createIfAbsent?: boolean
      candidateAuthority?: SessionTokenReadAuthority
    } = {}
  ): Promise<boolean> {
    return this.trackOperation(async () => {
      assertEnvKey(envKey)
      assertMutationOwnership(options)
      const file = await this.encryptedFilePath(envKey)
      return mutateTokenFile(file, async () => {
        assertMutationOwnership(options)
        if (!hasCandidateAuthority(options.candidateAuthority, envKey, fileResource(file)))
          return false
        options = await this.prepareMutationAuthority(envKey, options)
        if (!hasCandidateAuthority(options.candidateAuthority, envKey, fileResource(file)))
          return false
        let descriptor: number | undefined
        let createMissing = false
        try {
          const flags =
            process.platform === 'win32'
              ? fsSync.constants.O_RDONLY
              : fsSync.constants.O_RDONLY |
                fsSync.constants.O_NONBLOCK |
                fsSync.constants.O_NOFOLLOW
          descriptor = fsSync.openSync(file, flags)
          if (
            !fsSync.fstatSync(descriptor).isFile() ||
            (process.platform === 'win32' && !fsSync.lstatSync(file).isFile())
          ) {
            throw new Error('Encrypted session token is not a regular file')
          }
          if (!isQualifiedSafeStorageAvailable()) {
            throw new SessionTokenStorageUnavailableBeforeWriteError('safe-storage')
          }
          if (safeStorage.decryptString(fsSync.readFileSync(descriptor)) !== attemptedToken)
            return false
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' || descriptor !== undefined)
            throw error
          if (process.platform === 'win32') {
            try {
              if (!fsSync.lstatSync(file).isFile())
                throw new Error('Encrypted session token is not a regular file')
              // A newly present regular file is not verified absence.
              return false
            } catch (inspectionError) {
              if ((inspectionError as NodeJS.ErrnoException)?.code !== 'ENOENT')
                throw inspectionError
            }
          }
          if (!options.createIfAbsent || previousToken === null) return false
          createMissing = true
        } finally {
          if (descriptor !== undefined) fsSync.closeSync(descriptor)
        }
        assertMutationOwnership(options)
        if (createMissing && !isQualifiedSafeStorageAvailable())
          throw new SessionTokenStorageUnavailableBeforeWriteError('safe-storage')
        if (previousToken === null) {
          await publishSourceMutation(
            fileResource(file),
            async () => {
              await retireTokenFileDurably(file)
            },
            options,
            'safe-storage'
          )
        } else {
          await writeTokenFileAtomicOnce(
            file,
            safeStorage.encryptString(previousToken),
            'safe-storage',
            previousToken,
            options
          )
          if (createMissing) {
            const written = readRegularFallbackFile(file)
            if (written === null || safeStorage.decryptString(written) !== previousToken)
              throw new Error(
                'Prior encrypted session could not be verified after conditional creation'
              )
            assertMutationOwnership(options)
          }
        }
        return true
      })
    })
  }

  private async setSessionTokenOnce(
    token: string,
    envKey: string,
    options: { requireKeytar?: boolean } & SessionTokenMutationOptions = {}
  ): Promise<SessionTokenMutationSource> {
    assertEnvKey(envKey)
    assertMutationOwnership(options)
    if (this.isolatedUserDataPath !== undefined) await this.verifiedStorageBase()
    const account = accountFor(envKey)
    let nativeWriteAttempted = false
    let nativeWriteFailure: unknown
    if (this.isolatedUserDataPath === undefined) {
      const savedInKeytar = await accessKeytarAccount(account, async () => {
        const keytar = await loadKeytar()
        if (!keytar) {
          assertMutationOwnership(options)
          if (options.requireKeytar) throw new SessionTokenStorageUnavailableBeforeWriteError()
          return false
        }
        options = await this.prepareMutationAuthority(envKey, options)
        assertMutationOwnership(options)
        assertMigrationPublicationOwnership(options)
        nativeWriteAttempted = true
        notifyMutationDispatch(options, 'keytar', token)
        try {
          await publishSourceMutation(
            nativeResource(account),
            () => keytar.setPassword(SERVICE, account, token),
            options
          )
          return true
        } catch (error) {
          if (isSessionTokenMutationCallbackFailure(error)) throw error
          rethrowSuperseded(error)
          nativeWriteFailure = error
          if (options.requireKeytar) {
            throw new AggregateError([error], 'Failed to replace session token in Keytar')
          }
          // Fall through to file storage when keychain writes fail.
          return false
        }
      })
      if (savedInKeytar) return 'keytar'
    } else if (options.requireKeytar) {
      throw new SessionTokenStorageUnavailableBeforeWriteError()
    }

    options = await this.prepareMutationAuthority(envKey, options)
    if (isQualifiedSafeStorageAvailable()) {
      const file = await this.encryptedFilePath(envKey)
      await writeTokenFileAtomic(
        file,
        safeStorage.encryptString(token),
        'safe-storage',
        token,
        options
      )
      return 'safe-storage'
    }

    if (this.isolatedUserDataPath === undefined) {
      const unavailable = new SessionTokenStorageUnavailableBeforeWriteError('safe-storage')
      if (nativeWriteAttempted) {
        throw new AggregateError(
          [nativeWriteFailure, unavailable],
          'Failed to persist session token in secure storage'
        )
      }
      throw unavailable
    }
    const file = await this.plainFilePath(envKey)
    await writeTokenFileAtomic(
      file,
      JSON.stringify({ token }),
      'isolated-plaintext',
      token,
      options
    )
    return 'isolated-plaintext'
  }

  async clearSessionToken(
    envKey: string,
    options: {
      legacyEnvKeys?: readonly string[]
      clearLegacyGlobalSlot?: boolean
    } & SessionTokenMutationOptions = {}
  ): Promise<void> {
    return this.trackOperation(async () => {
      await this.clearSessionTokenOnce(envKey, options)
    })
  }

  async clearSessionTokenStrictly(
    envKey: string,
    options: { legacyEnvKeys?: readonly string[] } & SessionTokenMutationOptions = {}
  ): Promise<StrictSessionTokenClearResult> {
    return this.trackOperation(() =>
      this.clearSessionTokenOnce(envKey, { ...options, throwOnStorageError: true })
    )
  }

  /** Clean native accounts only; onlyIfMatches preserves every different value. */
  async clearKeytarSessionTokensStrictly(
    envKey: string,
    options: {
      legacyEnvKeys?: readonly string[]
      preserveActiveEnvKey?: boolean
      onlyIfMatches?: string
      readAuthority?: SessionTokenReadAuthority
    } & SessionTokenMutationOptions = {}
  ): Promise<StrictSessionTokenClearResult> {
    return this.trackOperation(async () => {
      assertEnvKey(envKey)
      assertMutationOwnership(options)
      if (
        options.onlyIfMatches !== undefined &&
        (typeof options.onlyIfMatches !== 'string' || options.onlyIfMatches.length === 0)
      )
        throw new Error('Conditional native cleanup requires a nonempty rejected token')
      if (options.onlyIfMatches !== undefined) {
        const authority = options.readAuthority && readAuthorities.get(options.readAuthority)
        if (!authority || authority.envKey !== envKey)
          throw new Error('Conditional native cleanup requires original read authority')
      }
      if (this.isolatedUserDataPath !== undefined) {
        await this.verifiedStorageBase()
        return {
          keytarAvailable: false,
          keytarDisabled: true,
          keytarDisposition: 'disabled',
          ...(options.onlyIfMatches !== undefined ? { sourceAuthorityVerified: true } : {}),
        }
      }
      const legacyEnvKeys = Array.from(
        new Set(
          (options.legacyEnvKeys ?? [])
            .map(key => String(key || '').trim())
            .filter(key => key && key !== envKey)
        )
      )
      for (const legacyEnvKey of legacyEnvKeys) assertEnvKey(legacyEnvKey)
      const keytarPromise = loadKeytar()
      let keytarAvailable = false
      let sourceAuthorityVerified = true

      const failedKeytarAccounts: string[] = []
      const errors: unknown[] = []
      const scopedEnvKeys = options.preserveActiveEnvKey
        ? legacyEnvKeys
        : [envKey, ...legacyEnvKeys]
      for (const account of [...scopedEnvKeys.map(accountFor), LEGACY_ACCOUNT]) {
        try {
          keytarAvailable =
            (await clearKeytarAccountStrictly(account, keytarPromise, {
              ...options,
              onAuthorityLost: () => {
                sourceAuthorityVerified = false
              },
            })) || keytarAvailable
        } catch (error) {
          rethrowSuperseded(error)
          failedKeytarAccounts.push(account)
          errors.push(error)
        }
      }
      if (errors.length > 0) {
        throw new SessionTokenStorageClearError(errors, failedKeytarAccounts, 0)
      }
      return {
        keytarAvailable,
        keytarDisabled: false,
        keytarDisposition: keytarClearDisposition(keytarAvailable, false),
        ...(options.onlyIfMatches !== undefined
          ? { sourceAuthorityVerified: sourceAuthorityVerified && keytarAvailable }
          : {}),
      }
    })
  }

  private async clearSessionTokenOnce(
    envKey: string,
    options: {
      legacyEnvKeys?: readonly string[]
      clearLegacyGlobalSlot?: boolean
      throwOnStorageError?: boolean
    } & SessionTokenMutationOptions
  ): Promise<StrictSessionTokenClearResult> {
    assertEnvKey(envKey)
    assertMutationOwnership(options)
    if (this.isolatedUserDataPath !== undefined) await this.verifiedStorageBase()
    assertMutationOwnership(options)
    const legacyEnvKeys = Array.from(
      new Set(
        (options.legacyEnvKeys ?? [])
          .map(key => String(key || '').trim())
          .filter(key => key && key !== envKey)
      )
    )
    for (const legacyEnvKey of legacyEnvKeys) assertEnvKey(legacyEnvKey)
    const scopedEnvKeys = [envKey, ...legacyEnvKeys]
    const keytarPromise = this.isolatedUserDataPath === undefined ? loadKeytar() : null
    let keytarAvailable = false
    const storageErrors: unknown[] = []
    const failedKeytarAccounts: string[] = []
    let failedFileCount = 0
    if (keytarPromise) {
      const deleteKeychainPassword = async (account: string) => {
        try {
          keytarAvailable =
            (await clearKeytarAccountStrictly(account, keytarPromise, options)) || keytarAvailable
        } catch (error) {
          rethrowSuperseded(error)
          // Keychain cleanup is best-effort; continue through the scoped files.
          if (options.throwOnStorageError) {
            storageErrors.push(error)
            failedKeytarAccounts.push(account)
          }
        }
      }
      for (const scopedEnvKey of scopedEnvKeys) {
        await deleteKeychainPassword(accountFor(scopedEnvKey))
      }
      if (options.clearLegacyGlobalSlot !== false) {
        // Best-effort cleanup of the legacy global slot so it can't be migrated
        // into another environment later.
        await deleteKeychainPassword(LEGACY_ACCOUNT)
      }
    }
    // Always clean up file-based storage regardless of keychain result,
    // since prior versions may have written both stores.
    const filePaths = scopedEnvKeys.flatMap(scopedEnvKey => [
      this.encryptedFilePath(scopedEnvKey),
      this.plainFilePath(scopedEnvKey),
    ])
    if (this.isolatedUserDataPath === undefined && options.clearLegacyGlobalSlot !== false) {
      filePaths.push(legacyEncryptedFilePath(), legacyFilePath())
    }
    const fileSettlements = await Promise.allSettled(
      filePaths.map(async filePath => {
        try {
          const resolvedFilePath = await filePath
          await mutateTokenFile(resolvedFilePath, () => {
            assertMutationOwnership(options)
            return publishSourceMutation(fileResource(resolvedFilePath), () =>
              fs.unlink(resolvedFilePath)
            )
          })
        } catch (error) {
          rethrowSuperseded(error)
          const code = (error as NodeJS.ErrnoException | undefined)?.code
          if (options.throwOnStorageError && code !== 'ENOENT') {
            storageErrors.push(error)
            failedFileCount += 1
          }
        }
      })
    )
    // A guarded sibling rejection does not release this accepted operation's
    // ownership of callbacks already queued in another file lane.
    for (const result of fileSettlements) {
      if (result.status === 'rejected') throw result.reason
    }
    if (options.throwOnStorageError && storageErrors.length > 0) {
      throw new SessionTokenStorageClearError(storageErrors, failedKeytarAccounts, failedFileCount)
    }
    return {
      keytarAvailable,
      keytarDisabled: this.isolatedUserDataPath !== undefined,
      keytarDisposition: keytarClearDisposition(
        keytarAvailable,
        this.isolatedUserDataPath !== undefined
      ),
    }
  }
}
