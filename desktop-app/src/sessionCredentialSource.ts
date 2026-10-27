import { createHash } from 'node:crypto'

/** One canonical production source precedence used only after the coordinator requests a read. */
export const SESSION_CREDENTIAL_SOURCE_ORDER = ['keytar', 'safe-storage'] as const
export type SessionCredentialSourceKind =
  | (typeof SESSION_CREDENTIAL_SOURCE_ORDER)[number]
  | 'historical-plaintext'

export function sessionCredentialSourceReadOrder(
  allowIsolatedDevelopmentPlaintext: boolean
): SessionCredentialSourceKind[] {
  return allowIsolatedDevelopmentPlaintext
    ? [...SESSION_CREDENTIAL_SOURCE_ORDER, 'historical-plaintext']
    : [...SESSION_CREDENTIAL_SOURCE_ORDER]
}

export type SessionCredentialSourceObservation =
  | {
      source: SessionCredentialSourceKind
      status: 'present'
      token: string
      authority: object
    }
  | { source: SessionCredentialSourceKind; status: 'absent' }
  | {
      source: SessionCredentialSourceKind
      status: 'unavailable'
      reason: 'provider-missing' | 'provider-unqualified' | 'isolated-development'
    }
  | {
      source: SessionCredentialSourceKind
      status: 'failed'
      error: unknown
      fallbackReadFailure: boolean
    }

export type SessionCredentialSourceReadPlan =
  | { kind: 'select' }
  | { kind: 'continue' }
  | { kind: 'reject'; error: unknown }

export class HistoricalSessionCredentialRequiresLoginError extends Error {
  constructor() {
    super('Historical plaintext session credentials require fresh account authentication')
    this.name = 'HistoricalSessionCredentialRequiresLoginError'
  }
}

/** A failed source read is uncertainty, not evidence that the credential is absent. */
export class SessionCredentialSourceObservationError extends Error {
  constructor(readonly source: 'keytar' | 'safe-storage') {
    super('Session credential source could not be verified')
    this.name = 'SessionCredentialSourceObservationError'
  }
}

export function isSessionCredentialSourceObservationError(
  error: unknown
): error is SessionCredentialSourceObservationError {
  return error instanceof SessionCredentialSourceObservationError
}

/** Shared dispatch contract; production never accepts historical plaintext as authentication. */
export function planSessionCredentialSourceRead(
  observation: SessionCredentialSourceObservation,
  options: { allowIsolatedDevelopmentPlaintext?: boolean } = {}
): SessionCredentialSourceReadPlan {
  if (observation.status === 'present') {
    if (observation.source === 'historical-plaintext' && !options.allowIsolatedDevelopmentPlaintext)
      return { kind: 'reject', error: new HistoricalSessionCredentialRequiresLoginError() }
    return { kind: 'select' }
  }
  if (observation.status !== 'failed') return { kind: 'continue' }
  // A failed observation is not proof that the source is absent. In particular, a locked or
  // transiently failing Keytar must not expose a lower-precedence credential while its value is
  // unknown. Definitive provider absence is represented by `unavailable` and may continue.
  if (observation.source === 'historical-plaintext')
    return { kind: 'reject', error: observation.error }
  return { kind: 'reject', error: new SessionCredentialSourceObservationError(observation.source) }
}

export type SessionAuthorityDigestIdentity = {
  sourceKind: 'keytar' | 'safe-storage' | 'historical-plaintext'
  sourceRef: string
  envKey: string
  accountId: string | null
}

export type LegacySessionCredentialLocatorIdentity =
  | { kind: 'keytar-account'; account: string }
  | { kind: 'safe-storage-file' | 'plaintext-file'; envKey: string | null }

/**
 * Give a legacy source a restart-stable identity for its exact storage location.
 * The source value is deliberately excluded: `storedValueDigest` binds the identity
 * to the observed bytes, so replacing a credential at the same path is a new source.
 */
export function legacySessionCredentialSourceRef(
  storageRoot: string,
  rootIdentity: { dev: number; ino: number; uid: number | null },
  envKey: string,
  sourceKind: SessionAuthorityDigestIdentity['sourceKind'],
  locator: LegacySessionCredentialLocatorIdentity
): string {
  if (!storageRoot || !ENV_KEY.test(envKey))
    throw new Error('Legacy session credential source location is invalid')

  const location =
    locator.kind === 'keytar-account'
      ? ['keytar-account', locator.account]
      : [locator.kind, locator.envKey]
  const bytes = createHash('sha256')
    .update('evenfire-legacy-session-source-v1\0', 'utf8')
    .update(
      JSON.stringify([
        storageRoot,
        rootIdentity.dev,
        rootIdentity.ino,
        rootIdentity.uid,
        envKey,
        sourceKind,
        location,
      ]),
      'utf8'
    )
    .digest()
    .subarray(0, 16)
  // Format the truncated SHA-256 value as an RFC 4122 UUID-shaped stable identifier.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ENV_KEY = /^[a-z0-9_]+-[0-9a-f]{12}$/

/** Bind a digest to the selected source identity and the exact persisted bytes, never the bearer. */
export function digestSessionAuthoritySource(
  identity: SessionAuthorityDigestIdentity,
  value: string | Buffer
): string {
  if (
    !UUID.test(identity.sourceRef) ||
    !ENV_KEY.test(identity.envKey) ||
    (identity.accountId !== null && (!identity.accountId || identity.accountId.length > 256))
  )
    throw new Error('Session authority source digest identity is invalid')

  return createHash('sha256')
    .update('evenfire-session-source-v1\0', 'utf8')
    .update(identity.sourceKind, 'utf8')
    .update('\0', 'utf8')
    .update(identity.sourceRef, 'utf8')
    .update('\0', 'utf8')
    .update(identity.envKey, 'utf8')
    .update('\0', 'utf8')
    .update(identity.accountId ?? '', 'utf8')
    .update('\0', 'utf8')
    .update(value)
    .digest('hex')
}
