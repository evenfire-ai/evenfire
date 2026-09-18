import type { DbClient } from '../db.js'
import { decryptOAuthSecret, encryptOAuthSecret } from '../oauth/encryption.js'
import {
  generateGrokConnectionKey,
  assertGrokConnectionKey as parseGrokConnectionKey,
} from './grokSubscriptionSchema.js'

export { generateGrokConnectionKey }

/** Fail-closed Host sentinel. Not a grant row; never maps to deployment-default. */
export const GROK_UNASSIGNED_CONNECTION_KEY = 'unassigned' as const
export const GROK_RESERVED_DEPLOYMENT_DEFAULT_KEY = 'deployment-default' as const

export const GROK_CONNECTION_REF_ANNOTATION = 'clerum.io/subscription-connection-ref' as const

export function isGrokUnassignedConnectionKey(value?: string | null): boolean {
  return typeof value === 'string' && value.trim() === GROK_UNASSIGNED_CONNECTION_KEY
}

/**
 * Host spec reader. Empty/missing is `unassigned`. Grok never aliases empty
 * to `deployment-default`.
 */
export function readHostGrokConnectionRef(value?: string | null): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) return GROK_UNASSIGNED_CONNECTION_KEY
  return trimmed
}

export class GrokSubscriptionInvalidConnectionKeyError extends Error {
  readonly code = 'invalid_connection_key'

  constructor(key: string) {
    super(`Grok subscription connection key is invalid: ${key}`)
    this.name = 'GrokSubscriptionInvalidConnectionKeyError'
  }
}

export function assertGrokConnectionKey(value: string): string {
  try {
    return parseGrokConnectionKey(value)
  } catch {
    throw new GrokSubscriptionInvalidConnectionKeyError(value.trim())
  }
}

export class GrokSubscriptionFingerprintConflictError extends Error {
  readonly code = 'fingerprint_in_use'

  constructor() {
    super('A live Grok subscription already uses this account')
    this.name = 'GrokSubscriptionFingerprintConflictError'
  }
}

/**
 * A write lost the connection_key uniqueness race: another writer created the
 * key first, or the key is a revoked tombstone (revocation is terminal per key
 * since migration 0113_grok_subscription_terminal_connection_key). Callers
 * re-read with
 * `getGrokSubscriptionConnectionIncludingRevoked` to tell the two apart.
 */
export class GrokSubscriptionConnectionKeyConflictError extends Error {
  readonly code = 'connection_key_conflict'

  constructor() {
    super('Grok subscription connection key is already taken')
    this.name = 'GrokSubscriptionConnectionKeyConflictError'
  }
}

const CONNECTION_KEY_UNIQUE_CONSTRAINTS: ReadonlySet<string> = new Set([
  'grok_subscription_connections_key_unique',
  // Pre-0113 live-only index name.
  'grok_subscription_connections_active_key',
])

export class GrokSubscriptionStaleRevisionError extends Error {
  readonly code = 'grok_subscription_stale_revision'

  constructor() {
    super('Grok subscription credential revision is stale')
    this.name = 'GrokSubscriptionStaleRevisionError'
  }
}

export type GrokSubscriptionConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reauth_required'
  | 'revoked'

export type GrokSubscriptionCatalogStatus =
  | 'never_synced'
  | 'ready'
  | 'auth-rejected'
  | 'unavailable'

export type GrokSubscriptionSafeConnection = {
  id: string
  connectionKey: string
  displayName: string
  defaultModel: string | null
  createdBy: string | null
  status: GrokSubscriptionConnectionStatus
  credentialRevision: number
  catalogRevision: number
  accountFingerprint: string | null
  catalogStatus: GrokSubscriptionCatalogStatus
  catalogSyncedAt: Date | null
  lastRefreshAt: Date | null
  lastAuthAt: Date | null
  refreshLockHeld: boolean
  revokedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type GrokSubscriptionCredentialWrite = {
  refreshToken: string
  accessToken?: string | null
  accessTokenExpiresAt?: Date | null
  accountFingerprint: string
  status?: Extract<GrokSubscriptionConnectionStatus, 'connected' | 'reauth_required'>
}

export type GrokSubscriptionSecrets = {
  refreshToken: string
  accessToken: string | null
  accessTokenExpiresAt: Date | null
  credentialRevision: number
}

type SafeConnectionRow = {
  id: string
  connection_key: string
  display_name: string | null
  default_model: string | null
  created_by: string | null
  status: GrokSubscriptionConnectionStatus
  credential_revision: string | number
  catalog_revision: string | number
  account_fingerprint: string | null
  catalog_status: GrokSubscriptionCatalogStatus
  catalog_synced_at: Date | string | null
  last_refresh_at: Date | string | null
  last_auth_at: Date | string | null
  refresh_lock_token: string | null
  refresh_lock_expires_at: Date | string | null
  revoked_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

const SAFE_CONNECTION_COLUMNS = `
  id,
  connection_key,
  display_name,
  default_model,
  created_by,
  status,
  credential_revision,
  catalog_revision,
  account_fingerprint,
  catalog_status,
  catalog_synced_at,
  last_refresh_at,
  last_auth_at,
  refresh_lock_token,
  refresh_lock_expires_at,
  revoked_at,
  created_at,
  updated_at
`

export async function getSafeGrokSubscriptionConnection(
  db: DbClient,
  connectionKey: string
): Promise<GrokSubscriptionSafeConnection | null> {
  const key = assertGrokConnectionKey(connectionKey)
  const result = await db.query(
    `SELECT ${SAFE_CONNECTION_COLUMNS}
       FROM grok_subscription_connections
      WHERE connection_key = $1
        AND revoked_at IS NULL`,
    [key]
  )
  const row = result.rows[0] as SafeConnectionRow | undefined
  return row ? toSafeConnection(row) : null
}

/**
 * Lifecycle lookup that also returns revoked tombstones. Use it wherever a
 * decision must respect revocation (OAuth start/completion); the live-only
 * getter above reports a revoked key as simply absent.
 */
export async function getGrokSubscriptionConnectionIncludingRevoked(
  db: DbClient,
  connectionKey: string
): Promise<GrokSubscriptionSafeConnection | null> {
  const key = assertGrokConnectionKey(connectionKey)
  const result = await db.query(
    `SELECT ${SAFE_CONNECTION_COLUMNS}
       FROM grok_subscription_connections
      WHERE connection_key = $1
      ORDER BY revoked_at DESC NULLS FIRST, created_at DESC
      LIMIT 1`,
    [key]
  )
  const row = result.rows[0] as SafeConnectionRow | undefined
  return row ? toSafeConnection(row) : null
}

export async function getSafeGrokSubscriptionConnectionById(
  db: DbClient,
  connectionId: string
): Promise<GrokSubscriptionSafeConnection | null> {
  const result = await db.query(
    `SELECT ${SAFE_CONNECTION_COLUMNS}
       FROM grok_subscription_connections
      WHERE id = $1`,
    [connectionId]
  )
  const row = result.rows[0] as SafeConnectionRow | undefined
  return row ? toSafeConnection(row) : null
}

export async function listSafeGrokSubscriptionConnections(
  db: DbClient
): Promise<GrokSubscriptionSafeConnection[]> {
  const result = await db.query(
    `SELECT ${SAFE_CONNECTION_COLUMNS}
       FROM grok_subscription_connections
      ORDER BY created_at ASC, connection_key ASC`
  )
  return (result.rows as SafeConnectionRow[]).map(toSafeConnection)
}

export async function listLiveGrokSubscriptionConnections(
  db: DbClient
): Promise<GrokSubscriptionSafeConnection[]> {
  const result = await db.query(
    `SELECT ${SAFE_CONNECTION_COLUMNS}
       FROM grok_subscription_connections
      WHERE revoked_at IS NULL
      ORDER BY created_at ASC, connection_key ASC`
  )
  return (result.rows as SafeConnectionRow[]).map(toSafeConnection)
}

export async function createNamedGrokSubscriptionConnection(
  db: DbClient,
  input: { connectionKey: string; displayName: string; createdBy?: string | null }
): Promise<GrokSubscriptionSafeConnection> {
  const connectionKey = assertGrokConnectionKey(input.connectionKey)
  const displayName = input.displayName.trim() || connectionKey
  const result = await db.query(
    `INSERT INTO grok_subscription_connections (
       connection_key,
       display_name,
       created_by,
       status,
       credential_revision,
       catalog_revision,
       catalog_status
     ) VALUES ($1, $2, $3, 'disconnected', 1, 0, 'never_synced')
     RETURNING ${SAFE_CONNECTION_COLUMNS}`,
    [connectionKey, displayName, input.createdBy ?? null]
  )
  return toSafeConnection(result.rows[0] as SafeConnectionRow)
}

export async function insertInitialGrokSubscriptionConnection(
  db: DbClient,
  encryptionKey: Buffer,
  input: GrokSubscriptionCredentialWrite,
  connectionKey: string
): Promise<GrokSubscriptionSafeConnection> {
  const key = assertGrokConnectionKey(connectionKey)
  const refreshTokenEncrypted = encryptOAuthSecret(encryptionKey, input.refreshToken)
  const accessTokenEncrypted =
    input.accessToken == null || input.accessToken === ''
      ? null
      : encryptOAuthSecret(encryptionKey, input.accessToken)
  try {
    const result = await db.query(
      `INSERT INTO grok_subscription_connections (
         connection_key,
         display_name,
         status,
         refresh_token_encrypted,
         access_token_encrypted,
         access_token_expires_at,
         credential_revision,
         catalog_revision,
         account_fingerprint,
         catalog_status,
         last_auth_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 1, 0, $7, 'never_synced', now())
       RETURNING ${SAFE_CONNECTION_COLUMNS}`,
      [
        key,
        key,
        input.status ?? 'connected',
        refreshTokenEncrypted,
        accessTokenEncrypted,
        input.accessTokenExpiresAt ?? null,
        input.accountFingerprint,
      ]
    )
    return toSafeConnection(result.rows[0] as SafeConnectionRow)
  } catch (err) {
    throw remapUniqueConflict(err)
  }
}

export async function rotateGrokSubscriptionCredentials(
  db: DbClient,
  encryptionKey: Buffer,
  expectedRevision: number,
  input: GrokSubscriptionCredentialWrite,
  connectionKey: string
): Promise<GrokSubscriptionSafeConnection> {
  const key = assertGrokConnectionKey(connectionKey)
  const refreshTokenEncrypted = encryptOAuthSecret(encryptionKey, input.refreshToken)
  const accessTokenEncrypted =
    input.accessToken == null || input.accessToken === ''
      ? null
      : encryptOAuthSecret(encryptionKey, input.accessToken)
  try {
    const result = await db.query(
      `UPDATE grok_subscription_connections
          SET refresh_token_encrypted = $1,
              access_token_encrypted = $2,
              access_token_expires_at = $3,
              account_fingerprint = $4,
              status = $5,
              credential_revision = credential_revision + 1,
              last_refresh_at = now(),
              last_auth_at = now(),
              updated_at = now()
        WHERE connection_key = $6
          AND credential_revision = $7
          AND revoked_at IS NULL
        RETURNING ${SAFE_CONNECTION_COLUMNS}`,
      [
        refreshTokenEncrypted,
        accessTokenEncrypted,
        input.accessTokenExpiresAt ?? null,
        input.accountFingerprint,
        input.status ?? 'connected',
        key,
        expectedRevision,
      ]
    )
    const row = result.rows[0] as SafeConnectionRow | undefined
    if (!row) throw new GrokSubscriptionStaleRevisionError()
    return toSafeConnection(row)
  } catch (err) {
    throw remapUniqueConflict(err)
  }
}

/**
 * Persist a rotated refresh ciphertext before any fallible post-processing.
 * Fenced on the live refresh lock and credential_revision; does not bump
 * revision (issued tickets bind that integer).
 */
export async function persistGrokRefreshCiphertextFirst(
  db: DbClient,
  encryptionKey: Buffer,
  input: {
    connectionKey: string
    expectedRevision: number
    lockToken: string
    refreshToken: string
  }
): Promise<GrokSubscriptionSafeConnection> {
  const key = assertGrokConnectionKey(input.connectionKey)
  const result = await db.query(
    `UPDATE grok_subscription_connections
        SET refresh_token_encrypted = $1,
            last_refresh_at = now(),
            updated_at = now()
      WHERE connection_key = $2
        AND credential_revision = $3
        AND refresh_lock_token = $4
        AND refresh_lock_expires_at IS NOT NULL
        AND refresh_lock_expires_at > now()
        AND revoked_at IS NULL
      RETURNING ${SAFE_CONNECTION_COLUMNS}`,
    [
      encryptOAuthSecret(encryptionKey, input.refreshToken),
      key,
      input.expectedRevision,
      input.lockToken,
    ]
  )
  const row = result.rows[0] as SafeConnectionRow | undefined
  if (!row) throw new GrokSubscriptionStaleRevisionError()
  return toSafeConnection(row)
}

export async function markGrokRefreshSubjectMismatch(
  db: DbClient,
  connectionKey: string,
  expectedRevision: number
): Promise<GrokSubscriptionSafeConnection | null> {
  const key = assertGrokConnectionKey(connectionKey)
  const result = await db.query(
    `UPDATE grok_subscription_connections
        SET status = 'reauth_required',
            updated_at = now()
      WHERE connection_key = $1
        AND credential_revision = $2
        AND revoked_at IS NULL
      RETURNING ${SAFE_CONNECTION_COLUMNS}`,
    [key, expectedRevision]
  )
  const row = result.rows[0] as SafeConnectionRow | undefined
  return row ? toSafeConnection(row) : null
}

/**
 * Revoke the live grant for a key and invalidate every pending OAuth device
 * state for that key in ONE statement (data-modifying CTEs share a snapshot and
 * commit atomically), so no earlier authorization work can complete against a
 * revoked key. Pending states are cancelled even when the key has no live row.
 * The terminal tombstone plus the full connection_key unique index (0113) is
 * the backstop for a completion that consumed its state before the revoke.
 */
export async function revokeGrokSubscriptionConnection(
  db: DbClient,
  connectionKey: string
): Promise<GrokSubscriptionSafeConnection | null> {
  const key = assertGrokConnectionKey(connectionKey)
  const result = await db.query(
    `WITH cancelled_states AS (
       UPDATE grok_subscription_oauth_states
          SET status = 'cancelled',
              cancelled_at = now()
        WHERE connection_key = $1
          AND status = 'pending'
        RETURNING 1
     ),
     revoked AS (
       UPDATE grok_subscription_connections
          SET status = 'revoked',
              refresh_token_encrypted = NULL,
              access_token_encrypted = NULL,
              access_token_expires_at = NULL,
              catalog_status = 'never_synced',
              credential_revision = credential_revision + 1,
              refresh_lock_token = NULL,
              refresh_lock_expires_at = NULL,
              revoked_at = now(),
              updated_at = now()
        WHERE connection_key = $1
          AND revoked_at IS NULL
        RETURNING ${SAFE_CONNECTION_COLUMNS}
     ),
     disabled_models AS (
       UPDATE grok_catalog_models
          SET enabled = false,
              stale = true
        WHERE connection_id IN (SELECT id FROM revoked)
        RETURNING 1
     )
     SELECT ${SAFE_CONNECTION_COLUMNS}
       FROM revoked`,
    [key]
  )
  const row = result.rows[0] as SafeConnectionRow | undefined
  if (!row) return getSafeGrokSubscriptionConnection(db, key)
  return toSafeConnection(row)
}

export async function acquireGrokSubscriptionRefreshLock(
  db: DbClient,
  lockToken: string,
  ttlMs: number,
  connectionKey: string
): Promise<boolean> {
  const key = assertGrokConnectionKey(connectionKey)
  const result = await db.query(
    `UPDATE grok_subscription_connections
        SET refresh_lock_token = $1,
            refresh_lock_expires_at = now() + ($2 * interval '1 millisecond'),
            updated_at = now()
      WHERE connection_key = $3
        AND revoked_at IS NULL
        AND (
          refresh_lock_token IS NULL
          OR refresh_lock_expires_at IS NULL
          OR refresh_lock_expires_at <= now()
        )
      RETURNING refresh_lock_token`,
    [lockToken, ttlMs, key]
  )
  return (result.rowCount ?? 0) > 0
}

export async function releaseGrokSubscriptionRefreshLock(
  db: DbClient,
  lockToken: string,
  connectionKey: string
): Promise<boolean> {
  const key = assertGrokConnectionKey(connectionKey)
  const result = await db.query(
    `UPDATE grok_subscription_connections
        SET refresh_lock_token = NULL,
            refresh_lock_expires_at = NULL,
            updated_at = now()
      WHERE connection_key = $1
        AND refresh_lock_token = $2`,
    [key, lockToken]
  )
  return (result.rowCount ?? 0) > 0
}

export async function loadGrokSubscriptionSecrets(
  db: DbClient,
  encryptionKey: Buffer,
  connectionKey: string
): Promise<GrokSubscriptionSecrets | null> {
  const key = assertGrokConnectionKey(connectionKey)
  const result = await db.query(
    `SELECT refresh_token_encrypted,
            access_token_encrypted,
            access_token_expires_at,
            credential_revision
       FROM grok_subscription_connections
      WHERE connection_key = $1
        AND revoked_at IS NULL`,
    [key]
  )
  const row = result.rows[0] as
    | {
        refresh_token_encrypted: string | null
        access_token_encrypted: string | null
        access_token_expires_at: Date | string | null
        credential_revision: string | number
      }
    | undefined
  if (!row?.refresh_token_encrypted) return null
  return {
    refreshToken: decryptOAuthSecret(encryptionKey, row.refresh_token_encrypted),
    accessToken: row.access_token_encrypted
      ? decryptOAuthSecret(encryptionKey, row.access_token_encrypted)
      : null,
    accessTokenExpiresAt: asDate(row.access_token_expires_at),
    credentialRevision: Number(row.credential_revision),
  }
}

export async function updateGrokAccessTokenInPlace(
  db: DbClient,
  encryptionKey: Buffer,
  expectedRevision: number,
  input: {
    accessToken: string
    accessTokenExpiresAt?: Date | null
  },
  connectionKey: string,
  lockToken?: string
): Promise<GrokSubscriptionSafeConnection> {
  const key = assertGrokConnectionKey(connectionKey)
  const params: unknown[] = [
    encryptOAuthSecret(encryptionKey, input.accessToken),
    input.accessTokenExpiresAt ?? null,
    key,
    expectedRevision,
  ]
  const lockFence = lockToken
    ? `AND refresh_lock_token = $5
        AND refresh_lock_expires_at IS NOT NULL
        AND refresh_lock_expires_at > now()`
    : ''
  if (lockToken) params.push(lockToken)
  const result = await db.query(
    `UPDATE grok_subscription_connections
        SET access_token_encrypted = $1,
            access_token_expires_at = $2,
            last_refresh_at = now(),
            updated_at = now()
      WHERE connection_key = $3
        AND credential_revision = $4
        AND revoked_at IS NULL
        ${lockFence}
      RETURNING ${SAFE_CONNECTION_COLUMNS}`,
    params
  )
  const row = result.rows[0] as SafeConnectionRow | undefined
  if (!row) throw new GrokSubscriptionStaleRevisionError()
  return toSafeConnection(row)
}

export async function recordGrokCatalogOutcome(
  db: DbClient,
  input: {
    catalogStatus: GrokSubscriptionCatalogStatus
    connectionStatus?: GrokSubscriptionConnectionStatus
    expectedCredentialRevision: number
    expectedCatalogRevision: number
    connectionKey: string
  }
): Promise<GrokSubscriptionSafeConnection | null> {
  const key = assertGrokConnectionKey(input.connectionKey)
  const result = await db.query(
    `UPDATE grok_subscription_connections
        SET catalog_status = $1,
            status = COALESCE($2, status),
            catalog_revision = catalog_revision + 1,
            catalog_synced_at = now(),
            updated_at = now()
      WHERE connection_key = $3
        AND credential_revision = $4
        AND catalog_revision = $5
      RETURNING ${SAFE_CONNECTION_COLUMNS}`,
    [
      input.catalogStatus,
      input.connectionStatus ?? null,
      key,
      input.expectedCredentialRevision,
      input.expectedCatalogRevision,
    ]
  )
  const row = result.rows[0] as SafeConnectionRow | undefined
  return row ? toSafeConnection(row) : null
}

export async function updateGrokSubscriptionConnectionMetadata(
  db: DbClient,
  connectionKey: string,
  patch: { displayName?: string; defaultModel?: string | null }
): Promise<GrokSubscriptionSafeConnection | null> {
  const key = assertGrokConnectionKey(connectionKey)
  const sets: string[] = ['updated_at = now()']
  const values: unknown[] = []
  if (typeof patch.displayName === 'string') {
    values.push(patch.displayName.trim() || key)
    sets.push(`display_name = $${values.length}`)
  }
  if (patch.defaultModel !== undefined) {
    const next = typeof patch.defaultModel === 'string' ? patch.defaultModel.trim() : ''
    values.push(next || null)
    sets.push(`default_model = $${values.length}`)
  }
  if (values.length === 0) {
    return getSafeGrokSubscriptionConnection(db, key)
  }
  values.push(key)
  const result = await db.query(
    `UPDATE grok_subscription_connections
        SET ${sets.join(', ')}
      WHERE connection_key = $${values.length}
        AND revoked_at IS NULL
      RETURNING ${SAFE_CONNECTION_COLUMNS}`,
    values
  )
  const row = result.rows[0] as SafeConnectionRow | undefined
  return row ? toSafeConnection(row) : null
}

function remapUniqueConflict(err: unknown): unknown {
  const conflict = err as { code?: string; constraint?: string } | null
  if (conflict?.code === '23505') {
    if (conflict.constraint === 'grok_subscription_connections_active_fingerprint') {
      return new GrokSubscriptionFingerprintConflictError()
    }
    if (conflict.constraint && CONNECTION_KEY_UNIQUE_CONSTRAINTS.has(conflict.constraint)) {
      return new GrokSubscriptionConnectionKeyConflictError()
    }
  }
  return err
}

function toSafeConnection(row: SafeConnectionRow): GrokSubscriptionSafeConnection {
  return {
    id: String(row.id),
    connectionKey: row.connection_key,
    displayName: row.display_name?.trim() || row.connection_key,
    defaultModel: row.default_model?.trim() || null,
    createdBy: row.created_by,
    status: row.status,
    credentialRevision: Number(row.credential_revision),
    catalogRevision: Number(row.catalog_revision),
    accountFingerprint: row.account_fingerprint,
    catalogStatus: row.catalog_status,
    catalogSyncedAt: asDate(row.catalog_synced_at),
    lastRefreshAt: asDate(row.last_refresh_at),
    lastAuthAt: asDate(row.last_auth_at),
    refreshLockHeld: isLockHeld(row.refresh_lock_token, row.refresh_lock_expires_at),
    revokedAt: asDate(row.revoked_at),
    createdAt: asDate(row.created_at) ?? new Date(0),
    updatedAt: asDate(row.updated_at) ?? new Date(0),
  }
}

function isLockHeld(token: string | null, expiresAt: Date | string | null): boolean {
  if (!token) return false
  const expires = asDate(expiresAt)
  return expires !== null && expires.getTime() > Date.now()
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null
  return value instanceof Date ? value : new Date(value)
}
