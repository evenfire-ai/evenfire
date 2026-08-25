import { randomBytes } from 'node:crypto'
import type { DbClient } from '../db.js'
import { decryptOAuthSecret, encryptOAuthSecret } from '../oauth/encryption.js'

export const CODEX_SUBSCRIPTION_CONNECTION_KEY = 'deployment-default' as const
/** Fail-closed Host sentinel. Not a grant row; never maps to deployment-default. */
export const CODEX_UNASSIGNED_CONNECTION_KEY = 'unassigned' as const

const CONNECTION_KEY_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export function isCodexUnassignedConnectionKey(value?: string | null): boolean {
  return typeof value === 'string' && value.trim() === CODEX_UNASSIGNED_CONNECTION_KEY
}

/**
 * Host spec reader. Empty/missing is `unassigned`, never the reserved grant.
 * Only an explicit connectionRef may spend a ChatGPT subscription.
 */
export function readHostCodexConnectionRef(value?: string | null): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) return CODEX_UNASSIGNED_CONNECTION_KEY
  return trimmed
}

/** Grant-row key. Empty aliases the reserved OAuth/DB row, not a Host spec field. */
export function normalizeCodexConnectionKey(value?: string | null): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (isCodexUnassignedConnectionKey(trimmed)) return CODEX_UNASSIGNED_CONNECTION_KEY
  return trimmed || CODEX_SUBSCRIPTION_CONNECTION_KEY
}

export function assertCodexConnectionKey(value: string): string {
  const key = value.trim()
  if (!CONNECTION_KEY_RE.test(key) || isCodexUnassignedConnectionKey(key)) {
    throw new CodexSubscriptionInvalidConnectionKeyError(key)
  }
  return key
}

export function generateCodexConnectionKey(): string {
  return `codex-${randomBytes(8).toString('hex')}`
}

export class CodexSubscriptionInvalidConnectionKeyError extends Error {
  readonly code = 'invalid_connection_key'

  constructor(key: string) {
    super(`Codex subscription connection key is invalid: ${key}`)
    this.name = 'CodexSubscriptionInvalidConnectionKeyError'
  }
}

export class CodexSubscriptionFingerprintConflictError extends Error {
  readonly code = 'fingerprint_in_use'

  constructor() {
    super('A live Codex subscription already uses this ChatGPT account')
    this.name = 'CodexSubscriptionFingerprintConflictError'
  }
}

export type CodexSubscriptionConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reauth_required'
  | 'revoked'

export type CodexSubscriptionCatalogStatus =
  | 'never_synced'
  | 'ready'
  | 'auth-rejected'
  | 'unavailable'

export type CodexSubscriptionSafeConnection = {
  id: string
  connectionKey: string
  displayName: string
  createdBy: string | null
  status: CodexSubscriptionConnectionStatus
  credentialRevision: number
  catalogRevision: number
  accountFingerprint: string | null
  catalogStatus: CodexSubscriptionCatalogStatus
  catalogSyncedAt: Date | null
  lastRefreshAt: Date | null
  lastAuthAt: Date | null
  refreshLockHeld: boolean
  revokedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type CodexSubscriptionCredentialWrite = {
  refreshToken: string
  accessToken?: string | null
  accessTokenExpiresAt?: Date | null
  chatgptAccountId?: string | null
  accountFingerprint: string
  status?: Extract<CodexSubscriptionConnectionStatus, 'connected' | 'reauth_required'>
}

export type CodexSubscriptionSecrets = {
  refreshToken: string
  accessToken: string | null
  accessTokenExpiresAt: Date | null
  chatgptAccountId: string | null
  credentialRevision: number
}

type SafeConnectionRow = {
  id: string
  connection_key: string
  display_name: string | null
  created_by: string | null
  status: CodexSubscriptionConnectionStatus
  credential_revision: string | number
  catalog_revision: string | number
  account_fingerprint: string | null
  catalog_status: CodexSubscriptionCatalogStatus
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

export class CodexSubscriptionStaleRevisionError extends Error {
  readonly code = 'codex_subscription_stale_revision'

  constructor() {
    super('Codex subscription credential revision is stale')
    this.name = 'CodexSubscriptionStaleRevisionError'
  }
}

export async function applyCodexSubscriptionConnectionSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS codex_subscription_connections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      connection_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'disconnected', 'connecting', 'connected', 'reauth_required', 'revoked'
      )),
      refresh_token_encrypted TEXT,
      access_token_encrypted TEXT,
      access_token_expires_at TIMESTAMPTZ,
      credential_revision BIGINT NOT NULL DEFAULT 1
        CHECK (credential_revision >= 1),
      catalog_revision BIGINT NOT NULL DEFAULT 0
        CHECK (catalog_revision >= 0),
      account_fingerprint TEXT,
      catalog_status TEXT NOT NULL DEFAULT 'never_synced'
        CHECK (catalog_status IN ('never_synced', 'ready', 'auth-rejected', 'unavailable')),
      catalog_synced_at TIMESTAMPTZ,
      last_refresh_at TIMESTAMPTZ,
      last_auth_at TIMESTAMPTZ,
      refresh_lock_token TEXT,
      refresh_lock_expires_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT codex_subscription_connections_key_check
        CHECK (connection_key = 'deployment-default'),
      CONSTRAINT codex_subscription_connections_connection_key_unique
        UNIQUE (connection_key),
      CONSTRAINT codex_subscription_connections_ciphertext_when_connected
        CHECK (
          status NOT IN ('connected', 'reauth_required')
          OR (
            refresh_token_encrypted IS NOT NULL
            AND account_fingerprint IS NOT NULL
          )
        )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS codex_subscription_connections_active_key
      ON codex_subscription_connections (connection_key)
      WHERE revoked_at IS NULL;

    REVOKE ALL PRIVILEGES ON TABLE codex_subscription_connections FROM PUBLIC;
    REVOKE ALL PRIVILEGES ON TABLE codex_subscription_connections
      FROM trace_maintenance_runtime, workflow_recipes_runtime;
    GRANT SELECT, INSERT, UPDATE ON TABLE codex_subscription_connections TO control_api_runtime;
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE codex_subscription_connections FROM control_api_runtime;
  `)
  await applyCodexChatgptAccountIdSchema(db)
}

export async function applyCodexChatgptAccountIdSchema(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE codex_subscription_connections
      ADD COLUMN IF NOT EXISTS chatgpt_account_id_encrypted TEXT
  `)
}

export async function applyCodexMultiConnectionSchema(db: DbClient): Promise<void> {
  await db.query(`
    ALTER TABLE codex_subscription_connections
      DROP CONSTRAINT IF EXISTS codex_subscription_connections_key_check;

    ALTER TABLE codex_subscription_connections
      ADD COLUMN IF NOT EXISTS display_name TEXT;

    ALTER TABLE codex_subscription_connections
      ADD COLUMN IF NOT EXISTS created_by TEXT;

    UPDATE codex_subscription_connections
       SET display_name = COALESCE(NULLIF(display_name, ''), 'Default deployment')
     WHERE connection_key = '${CODEX_SUBSCRIPTION_CONNECTION_KEY}'
       AND display_name IS NULL;

    ALTER TABLE codex_subscription_oauth_states
      ADD COLUMN IF NOT EXISTS connection_key TEXT;

    UPDATE codex_subscription_oauth_states
       SET connection_key = '${CODEX_SUBSCRIPTION_CONNECTION_KEY}'
     WHERE connection_key IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS codex_subscription_connections_active_fingerprint
      ON codex_subscription_connections (account_fingerprint)
      WHERE revoked_at IS NULL AND account_fingerprint IS NOT NULL;
  `)
}

export async function getSafeCodexSubscriptionConnection(
  db: DbClient,
  connectionKey: string = CODEX_SUBSCRIPTION_CONNECTION_KEY
): Promise<CodexSubscriptionSafeConnection | null> {
  const result = await db.query(
    `SELECT ${SAFE_CONNECTION_COLUMNS}
       FROM codex_subscription_connections
      WHERE connection_key = $1`,
    [normalizeCodexConnectionKey(connectionKey)]
  )
  const row = result.rows[0] as SafeConnectionRow | undefined
  return row ? toSafeConnection(row) : null
}

export async function getSafeCodexSubscriptionConnectionById(
  db: DbClient,
  connectionId: string
): Promise<CodexSubscriptionSafeConnection | null> {
  const result = await db.query(
    `SELECT ${SAFE_CONNECTION_COLUMNS}
       FROM codex_subscription_connections
      WHERE id = $1`,
    [connectionId]
  )
  const row = result.rows[0] as SafeConnectionRow | undefined
  return row ? toSafeConnection(row) : null
}

export async function listSafeCodexSubscriptionConnections(
  db: DbClient
): Promise<CodexSubscriptionSafeConnection[]> {
  const result = await db.query(
    `SELECT ${SAFE_CONNECTION_COLUMNS}
       FROM codex_subscription_connections
      ORDER BY created_at ASC, connection_key ASC`
  )
  return (result.rows as SafeConnectionRow[]).map(toSafeConnection)
}

export async function createNamedCodexSubscriptionConnection(
  db: DbClient,
  input: { connectionKey: string; displayName: string; createdBy?: string | null }
): Promise<CodexSubscriptionSafeConnection> {
  const connectionKey = assertCodexConnectionKey(input.connectionKey)
  const displayName = input.displayName.trim() || connectionKey
  const result = await db.query(
    `INSERT INTO codex_subscription_connections (
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

export async function insertInitialCodexSubscriptionConnection(
  db: DbClient,
  encryptionKey: Buffer,
  input: CodexSubscriptionCredentialWrite,
  connectionKey: string = CODEX_SUBSCRIPTION_CONNECTION_KEY
): Promise<CodexSubscriptionSafeConnection> {
  const key = assertCodexConnectionKey(normalizeCodexConnectionKey(connectionKey))
  const refreshTokenEncrypted = encryptOAuthSecret(encryptionKey, input.refreshToken)
  const accessTokenEncrypted =
    input.accessToken == null || input.accessToken === ''
      ? null
      : encryptOAuthSecret(encryptionKey, input.accessToken)
  const chatgptAccountIdEncrypted = encryptOptionalSecret(encryptionKey, input.chatgptAccountId)
  try {
    const result = await db.query(
      `INSERT INTO codex_subscription_connections (
         connection_key,
         display_name,
         status,
         refresh_token_encrypted,
         access_token_encrypted,
         access_token_expires_at,
         chatgpt_account_id_encrypted,
         credential_revision,
         catalog_revision,
         account_fingerprint,
         catalog_status,
         last_auth_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 0, $8, 'never_synced', now())
       RETURNING ${SAFE_CONNECTION_COLUMNS}`,
      [
        key,
        key === CODEX_SUBSCRIPTION_CONNECTION_KEY ? 'Default deployment' : key,
        input.status ?? 'connected',
        refreshTokenEncrypted,
        accessTokenEncrypted,
        input.accessTokenExpiresAt ?? null,
        chatgptAccountIdEncrypted,
        input.accountFingerprint,
      ]
    )
    return toSafeConnection(result.rows[0] as SafeConnectionRow)
  } catch (err) {
    throw remapFingerprintConflict(err)
  }
}

export async function rotateCodexSubscriptionCredentials(
  db: DbClient,
  encryptionKey: Buffer,
  expectedRevision: number,
  input: CodexSubscriptionCredentialWrite,
  connectionKey: string = CODEX_SUBSCRIPTION_CONNECTION_KEY
): Promise<CodexSubscriptionSafeConnection> {
  const refreshTokenEncrypted = encryptOAuthSecret(encryptionKey, input.refreshToken)
  const accessTokenEncrypted =
    input.accessToken == null || input.accessToken === ''
      ? null
      : encryptOAuthSecret(encryptionKey, input.accessToken)
  const chatgptAccountIdEncrypted = encryptOptionalSecret(encryptionKey, input.chatgptAccountId)
  try {
    const result = await db.query(
      `UPDATE codex_subscription_connections
          SET refresh_token_encrypted = $1,
              access_token_encrypted = $2,
              access_token_expires_at = $3,
              chatgpt_account_id_encrypted = COALESCE($4, chatgpt_account_id_encrypted),
              account_fingerprint = $5,
              status = $6,
              credential_revision = credential_revision + 1,
              last_refresh_at = now(),
              last_auth_at = now(),
              updated_at = now()
        WHERE connection_key = $7
          AND credential_revision = $8
          AND revoked_at IS NULL
        RETURNING ${SAFE_CONNECTION_COLUMNS}`,
      [
        refreshTokenEncrypted,
        accessTokenEncrypted,
        input.accessTokenExpiresAt ?? null,
        chatgptAccountIdEncrypted,
        input.accountFingerprint,
        input.status ?? 'connected',
        normalizeCodexConnectionKey(connectionKey),
        expectedRevision,
      ]
    )
    const row = result.rows[0] as SafeConnectionRow | undefined
    if (!row) throw new CodexSubscriptionStaleRevisionError()
    return toSafeConnection(row)
  } catch (err) {
    throw remapFingerprintConflict(err)
  }
}

export async function revokeCodexSubscriptionConnection(
  db: DbClient,
  connectionKey: string = CODEX_SUBSCRIPTION_CONNECTION_KEY
): Promise<CodexSubscriptionSafeConnection | null> {
  const key = normalizeCodexConnectionKey(connectionKey)
  const result = await db.query(
    `UPDATE codex_subscription_connections
        SET status = 'revoked',
            refresh_token_encrypted = NULL,
            access_token_encrypted = NULL,
            access_token_expires_at = NULL,
            chatgpt_account_id_encrypted = NULL,
            catalog_status = 'never_synced',
            credential_revision = credential_revision + 1,
            refresh_lock_token = NULL,
            refresh_lock_expires_at = NULL,
            revoked_at = now(),
            updated_at = now()
      WHERE connection_key = $1
        AND revoked_at IS NULL
      RETURNING ${SAFE_CONNECTION_COLUMNS}`,
    [key]
  )
  const row = result.rows[0] as SafeConnectionRow | undefined
  if (!row) return getSafeCodexSubscriptionConnection(db, key)
  await db.query(
    `UPDATE codex_catalog_models
        SET enabled = false,
            stale = true
      WHERE connection_id = $1`,
    [row.id]
  )
  return toSafeConnection(row)
}

export async function acquireCodexSubscriptionRefreshLock(
  db: DbClient,
  lockToken: string,
  ttlMs: number,
  connectionKey: string = CODEX_SUBSCRIPTION_CONNECTION_KEY
): Promise<boolean> {
  const result = await db.query(
    `UPDATE codex_subscription_connections
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
    [lockToken, ttlMs, normalizeCodexConnectionKey(connectionKey)]
  )
  return (result.rowCount ?? 0) > 0
}

export async function releaseCodexSubscriptionRefreshLock(
  db: DbClient,
  lockToken: string,
  connectionKey: string = CODEX_SUBSCRIPTION_CONNECTION_KEY
): Promise<boolean> {
  const result = await db.query(
    `UPDATE codex_subscription_connections
        SET refresh_lock_token = NULL,
            refresh_lock_expires_at = NULL,
            updated_at = now()
      WHERE connection_key = $1
        AND refresh_lock_token = $2`,
    [normalizeCodexConnectionKey(connectionKey), lockToken]
  )
  return (result.rowCount ?? 0) > 0
}

export async function loadCodexSubscriptionSecrets(
  db: DbClient,
  encryptionKey: Buffer,
  connectionKey: string = CODEX_SUBSCRIPTION_CONNECTION_KEY
): Promise<CodexSubscriptionSecrets | null> {
  const result = await db.query(
    `SELECT refresh_token_encrypted,
            access_token_encrypted,
            access_token_expires_at,
            chatgpt_account_id_encrypted,
            credential_revision
       FROM codex_subscription_connections
      WHERE connection_key = $1
        AND revoked_at IS NULL`,
    [normalizeCodexConnectionKey(connectionKey)]
  )
  const row = result.rows[0] as
    | {
        refresh_token_encrypted: string | null
        access_token_encrypted: string | null
        access_token_expires_at: Date | string | null
        chatgpt_account_id_encrypted: string | null
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
    chatgptAccountId: row.chatgpt_account_id_encrypted
      ? decryptOAuthSecret(encryptionKey, row.chatgpt_account_id_encrypted)
      : null,
    credentialRevision: Number(row.credential_revision),
  }
}

export async function updateCodexAccessTokenInPlace(
  db: DbClient,
  encryptionKey: Buffer,
  expectedRevision: number,
  input: {
    accessToken: string
    accessTokenExpiresAt?: Date | null
    refreshToken?: string | null
    chatgptAccountId?: string | null
  },
  connectionKey: string = CODEX_SUBSCRIPTION_CONNECTION_KEY
): Promise<CodexSubscriptionSafeConnection> {
  const result = await db.query(
    `UPDATE codex_subscription_connections
        SET access_token_encrypted = $1,
            access_token_expires_at = $2,
            refresh_token_encrypted = COALESCE($3, refresh_token_encrypted),
            chatgpt_account_id_encrypted = COALESCE($4, chatgpt_account_id_encrypted),
            last_refresh_at = now(),
            updated_at = now()
      WHERE connection_key = $5
        AND credential_revision = $6
        AND revoked_at IS NULL
      RETURNING ${SAFE_CONNECTION_COLUMNS}`,
    [
      encryptOAuthSecret(encryptionKey, input.accessToken),
      input.accessTokenExpiresAt ?? null,
      encryptOptionalSecret(encryptionKey, input.refreshToken),
      encryptOptionalSecret(encryptionKey, input.chatgptAccountId),
      normalizeCodexConnectionKey(connectionKey),
      expectedRevision,
    ]
  )
  const row = result.rows[0] as SafeConnectionRow | undefined
  if (!row) throw new CodexSubscriptionStaleRevisionError()
  return toSafeConnection(row)
}

export async function persistCodexChatgptAccountId(
  db: DbClient,
  encryptionKey: Buffer,
  chatgptAccountId: string,
  connectionKey: string = CODEX_SUBSCRIPTION_CONNECTION_KEY
): Promise<void> {
  await db.query(
    `UPDATE codex_subscription_connections
        SET chatgpt_account_id_encrypted = $1,
            updated_at = now()
      WHERE connection_key = $2
        AND revoked_at IS NULL
        AND chatgpt_account_id_encrypted IS NULL`,
    [
      encryptOAuthSecret(encryptionKey, chatgptAccountId),
      normalizeCodexConnectionKey(connectionKey),
    ]
  )
}

function encryptOptionalSecret(
  encryptionKey: Buffer,
  value: string | null | undefined
): string | null {
  if (value == null || value === '') return null
  return encryptOAuthSecret(encryptionKey, value)
}

export async function recordCodexCatalogOutcome(
  db: DbClient,
  input: {
    catalogStatus: CodexSubscriptionCatalogStatus
    connectionStatus?: CodexSubscriptionConnectionStatus
    expectedCredentialRevision: number
    expectedCatalogRevision: number
    connectionKey?: string
  }
): Promise<CodexSubscriptionSafeConnection | null> {
  const result = await db.query(
    `UPDATE codex_subscription_connections
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
      normalizeCodexConnectionKey(input.connectionKey),
      input.expectedCredentialRevision,
      input.expectedCatalogRevision,
    ]
  )
  const row = result.rows[0] as SafeConnectionRow | undefined
  return row ? toSafeConnection(row) : null
}

function remapFingerprintConflict(err: unknown): never | Error {
  const conflict = err as { code?: string; constraint?: string } | null
  if (
    conflict?.code === '23505' &&
    conflict.constraint === 'codex_subscription_connections_active_fingerprint'
  ) {
    return new CodexSubscriptionFingerprintConflictError()
  }
  throw err
}

function toSafeConnection(row: SafeConnectionRow): CodexSubscriptionSafeConnection {
  return {
    id: String(row.id),
    connectionKey: row.connection_key,
    displayName: row.display_name?.trim() || row.connection_key,
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
