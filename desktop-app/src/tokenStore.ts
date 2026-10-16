import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

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
  /** Conditional rejection cleanup only; availability is not publication ownership. */
  sourceAuthorityVerified?: boolean
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

export class SessionTokenStorageSupersededBeforeWriteError extends Error {
  constructor() {
    super('Session-token mutation was superseded before storage dispatch')
    this.name = 'SessionTokenStorageSupersededBeforeWriteError'
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

export type SessionTokenReadSource = 'keytar' | 'safe-storage' | 'historical-plaintext'
declare const readAuthorityBrand: unique symbol
/** Process-local publication identity; not a credential or authentication grant. */
export type SessionTokenReadAuthority = { readonly [readAuthorityBrand]: true }
export type SessionTokenReadOptions = SessionTokenMutationOptions & {
  legacyEnvKeys?: readonly string[]
  /** Source order selected by the main-process session authority coordinator. */
  sourceOrder?: readonly SessionTokenReadSource[]
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

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  if (process.platform !== 'win32') return false
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EISDIR' || code === 'EPERM' || code === 'EINVAL' || code === 'ENOTSUP'
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    handle = await fs.open(directoryPath, 'r')
    await handle.sync()
  } catch (error) {
    if (!isUnsupportedDirectorySyncError(error)) throw error
  } finally {
    await handle?.close()
  }
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
  options: SessionTokenMutationOptions = {}
): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    assertMutationOwnership(options)
    handle = await fs.open(temporaryPath, 'w', 0o600)
    assertMutationOwnership(options)
    await handle.writeFile(value)
    await handle.sync()
    await handle.close()
    handle = null
    assertMutationOwnership(options)
    assertMigrationPublicationOwnership(options)
    assertCandidateOrigin(options)
    notifyMutationDispatch(options, source, candidateToken)
    const completePublication = beginSourcePublication(fileResource(filePath))
    let failed = false
    let primaryFailure: unknown
    try {
      await fs.rename(temporaryPath, filePath)
      await syncDirectory(path.dirname(filePath))
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
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

export class TokenStore {
  private readonly pendingOperations = new Set<Promise<unknown>>()
  private admissionClosed = false

  private trackOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.admissionClosed) {
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

  /** Wait for active Keytar work and any storage fallback it triggers. */
  async prepareForQuit(): Promise<void> {
    this.closeAdmission()
    while (this.pendingOperations.size > 0) {
      await Promise.allSettled([...this.pendingOperations])
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
    if (actual !== declared) throw new Error('Isolated token storage directory mismatch')
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
   * Read the session token for `envKey`. Falls back keytar → safeStorage file,
   * optional older env-key aliases, then does a one-time best-effort migration
   * of the pre-per-env GLOBAL slot into this environment's slot.
   *
   * The legacy env-key aliases are explicit caller-provided upgrade paths, such
   * as REST-only `resolveEnvKey(rest)` → REST+RPC `resolveEnvKey(rest, rpc)`.
   * When one is found, it is copied to the new slot and deleted from the old
   * slot so it cannot be read into another runtime boundary later.
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
    return this.trackOperation(async () => {
      assertEnvKey(envKey)
      if (this.isolatedUserDataPath !== undefined) await this.verifiedStorageBase()
      const file = await this.encryptedFilePath(envKey)
      const scope = await this.readAuthorityScope(envKey, options)
      const selected = await this.readFileSelection(file, 'safe-storage', scope).catch(error => {
        if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null
        throw error
      })
      return selected?.token
        ? reportSelectedSessionToken(selected.token, 'safe-storage', options, selected.authority)
        : null
    })
  }

  /** Read only the active Keytar account, without legacy migration or file fallback. */
  async getKeytarSessionToken(
    envKey: string,
    options: SessionTokenReadOptions = {}
  ): Promise<string | null> {
    return this.trackOperation(async () => {
      assertEnvKey(envKey)
      if (this.isolatedUserDataPath !== undefined) {
        await this.verifiedStorageBase()
        return null
      }
      const scopePromise = this.readAuthorityScope(envKey, options)
      return accessKeytarAccount(accountFor(envKey), async () => {
        const scope = await scopePromise
        const keytar = await loadKeytar()
        if (!keytar) return null
        let token: string | null
        try {
          token = await keytar.getPassword(SERVICE, accountFor(envKey))
        } catch {
          return null
        }
        return token
          ? reportSelectedSessionToken(
              token,
              'keytar',
              options,
              captureReadAuthority(scope, nativeResource(accountFor(envKey)))
            )
          : null
      })
    })
  }

  private async getSessionTokenOnce(
    envKey: string,
    options: SessionTokenReadOptions
  ): Promise<string | null> {
    assertEnvKey(envKey)
    assertMutationOwnership(options)
    const sourceOrder = options.sourceOrder ?? ['keytar', 'safe-storage', 'historical-plaintext']
    if (this.isolatedUserDataPath !== undefined) await this.verifiedStorageBase()
    const account = accountFor(envKey)
    const scopePromise = this.readAuthorityScope(envKey, options)
    const { keytar, stored, authority } =
      this.isolatedUserDataPath === undefined
        ? await accessKeytarAccount(account, async () => {
            const scope = await scopePromise
            const keytar = await loadKeytar()
            try {
              const stored = keytar ? await keytar.getPassword(SERVICE, account) : null
              return {
                keytar,
                stored,
                authority: captureReadAuthority(
                  scope,
                  stored ? nativeResource(account) : undefined
                ),
              }
            } catch (error) {
              rethrowSuperseded(error)
              // Packaged builds can fail keychain access depending on host policies.
              return { keytar, stored: null, authority: captureReadAuthority(scope) }
            }
          })
        : { keytar: null, stored: null, authority: captureReadAuthority(await scopePromise) }
    if (sourceOrder.includes('keytar') && stored && authority)
      return reportSelectedSessionToken(stored, 'keytar', options, authority)

    let encryptedSelection: { token: string; authority: SessionTokenReadAuthority } | null = null
    if (sourceOrder.includes('safe-storage') && isQualifiedSafeStorageAvailable()) {
      try {
        const file = await this.encryptedFilePath(envKey)
        encryptedSelection = await this.readFileSelection(file, 'safe-storage', await scopePromise)
      } catch (error) {
        if (isSessionTokenFallbackReadFailure(error)) throw error
        // File may not exist yet.
      }
    }
    if (encryptedSelection)
      return reportSelectedSessionToken(
        encryptedSelection.token,
        'safe-storage',
        options,
        encryptedSelection.authority
      )

    // Retain historical plaintext read compatibility. New production writes
    // require secure storage; only explicit isolated development may write it.
    let plaintextSelection: { token: string; authority: SessionTokenReadAuthority } | null = null
    if (sourceOrder.includes('historical-plaintext')) {
      try {
        const file = await this.plainFilePath(envKey)
        plaintextSelection = await this.readFileSelection(
          file,
          'historical-plaintext',
          await scopePromise
        )
      } catch (error) {
        if (isSessionTokenFallbackReadFailure(error)) throw error
        // No per-env plain-text token — fall through to legacy migration.
      }
    }
    if (plaintextSelection)
      return reportSelectedSessionToken(
        plaintextSelection.token,
        'historical-plaintext',
        options,
        plaintextSelection.authority
      )

    if (options.allowLegacyMigration === false) return null

    const scope = readAuthorities.get(authority!)!
    const targets = [
      ...(this.isolatedUserDataPath === undefined ? [nativeResource(account)] : []),
      fileResource(path.join(scope.storageBase, `session-token-${envKey}.enc`)),
      fileResource(path.join(scope.storageBase, `session-token-${envKey}.json`)),
    ]
    const migration = migrationOptions(options, authority!, targets)
    const migratedScopedToken = await this.migrateLegacyEnvToken(
      envKey,
      options.legacyEnvKeys ?? [],
      keytar,
      migration
    )
    if (migratedScopedToken) return migratedScopedToken

    if (this.isolatedUserDataPath === undefined) {
      return this.migrateLegacyGlobalToken(envKey, keytar, migration)
    }
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
          await fs.unlink(filePath)
          await syncDirectory(path.dirname(filePath))
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
              fsSync.unlinkSync(filePath)
            }
            // Also flush verified absence when retrying a previous failed sync.
            await syncDirectory(storageBase)
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
            fsSync.unlinkSync(file)
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
            throw error
          } finally {
            if (descriptor !== undefined) fsSync.closeSync(descriptor)
          }
          await syncDirectory(path.dirname(file))
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
              fsSync.unlinkSync(file)
              await syncDirectory(path.dirname(file))
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
    }
  }
}
