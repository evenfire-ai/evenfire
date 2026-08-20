import type { DbClient } from '../db.js'
import { decryptOAuthSecret, encryptOAuthSecret } from '../oauth/encryption.js'

export const CODEX_SUBSCRIPTION_CONNECTION_KEY = 'deployment-default' as const

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
  connectionKey: typeof CODEX_SUBSCRIPTION_CONNECTION_KEY
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
  accountFingerprint: string
  status?: Extract<CodexSubscriptionConnectionStatus, 'connected' | 'reauth_required'>
}

export type CodexSubscriptionSecrets = {
  refreshToken: string
  accessToken: string | null
  accessTokenExpiresAt: Date | null
  credentialRevision: number
}

type SafeConnectionRow = {
  connection_key: string
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
  connection_key,
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
}

export async function getSafeCodexSubscriptionConnection(
  db: DbClient
): Promise<CodexSubscriptionSafeConnection | null> {
  const result = await db.query(
    `SELECT ${SAFE_CONNECTION_COLUMNS}
       FROM codex_subscription_connections
      WHERE connection_key = $1`,
    [CODEX_SUBSCRIPTION_CONNECTION_KEY]
  )
  const row = result.rows[0] as SafeConnectionRow | undefined
  return row ? toSafeConnection(row) : null
}

export async function insertInitialCodexSubscriptionConnection(
  db: DbClient,
  encryptionKey: Buffer,
  input: CodexSubscriptionCredentialWrite
): Promise<CodexSubscriptionSafeConnection> {
  const refreshTokenEncrypted = encryptOAuthSecret(encryptionKey, input.refreshToken)
  const accessTokenEncrypted =
    input.accessToken == null || input.accessToken === ''
      ? null
      : encryptOAuthSecret(encryptionKey, input.accessToken)
  const result = await db.query(
    `INSERT INTO codex_subscription_connections (
       connection_key,
       status,
       refresh_token_encrypted,
       access_token_encrypted,
       access_token_expires_at,
       credential_revision,
       catalog_revision,
       account_fingerprint,
       catalog_status,
       last_auth_at
     ) VALUES ($1, $2, $3, $4, $5, 1, 0, $6, 'never_synced', now())
     RETURNING ${SAFE_CONNECTION_COLUMNS}`,
    [
      CODEX_SUBSCRIPTION_CONNECTION_KEY,
      input.status ?? 'connected',
      refreshTokenEncrypted,
      accessTokenEncrypted,
      input.accessTokenExpiresAt ?? null,
      input.accountFingerprint,
    ]
  )
  return toSafeConnection(result.rows[0] as SafeConnectionRow)
}

export async function rotateCodexSubscriptionCredentials(
  db: DbClient,
  encryptionKey: Buffer,
  expectedRevision: number,
  input: CodexSubscriptionCredentialWrite
): Promise<CodexSubscriptionSafeConnection> {
  const refreshTokenEncrypted = encryptOAuthSecret(encryptionKey, input.refreshToken)
  const accessTokenEncrypted =
    input.accessToken == null || input.accessToken === ''
      ? null
      : encryptOAuthSecret(encryptionKey, input.accessToken)
  const result = await db.query(
    `UPDATE codex_subscription_connections
        SET refresh_token_encrypted = $1,
            access_token_encrypted = $2,
            access_token_expires_at = $3,
            account_fingerprint = $4,
            status = $5,
            credential_revision = credential_revision + 1,
            last_refresh_at = now(),
            last_auth_at = now(),
            revoked_at = NULL,
            updated_at = now()
      WHERE connection_key = $6
        AND credential_revision = $7
      RETURNING ${SAFE_CONNECTION_COLUMNS}`,
    [
      refreshTokenEncrypted,
      accessTokenEncrypted,
      input.accessTokenExpiresAt ?? null,
      input.accountFingerprint,
      input.status ?? 'connected',
      CODEX_SUBSCRIPTION_CONNECTION_KEY,
      expectedRevision,
    ]
  )
  const row = result.rows[0] as SafeConnectionRow | undefined
  if (!row) throw new CodexSubscriptionStaleRevisionError()
  return toSafeConnection(row)
}

export async function revokeCodexSubscriptionConnection(
  db: DbClient
): Promise<CodexSubscriptionSafeConnection | null> {
  const result = await db.query(
    `UPDATE codex_subscription_connections
        SET status = 'revoked',
            refresh_token_encrypted = NULL,
            access_token_encrypted = NULL,
            access_token_expires_at = NULL,
            account_fingerprint = NULL,
            credential_revision = credential_revision + 1,
            refresh_lock_token = NULL,
            refresh_lock_expires_at = NULL,
            revoked_at = now(),
            updated_at = now()
      WHERE connection_key = $1
        AND revoked_at IS NULL
      RETURNING ${SAFE_CONNECTION_COLUMNS}`,
    [CODEX_SUBSCRIPTION_CONNECTION_KEY]
  )
  const row = result.rows[0] as SafeConnectionRow | undefined
  return row ? toSafeConnection(row) : getSafeCodexSubscriptionConnection(db)
}

export async function acquireCodexSubscriptionRefreshLock(
  db: DbClient,
  lockToken: string,
  ttlMs: number
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
    [lockToken, ttlMs, CODEX_SUBSCRIPTION_CONNECTION_KEY]
  )
  return (result.rowCount ?? 0) > 0
}

export async function releaseCodexSubscriptionRefreshLock(
  db: DbClient,
  lockToken: string
): Promise<boolean> {
  const result = await db.query(
    `UPDATE codex_subscription_connections
        SET refresh_lock_token = NULL,
            refresh_lock_expires_at = NULL,
            updated_at = now()
      WHERE connection_key = $1
        AND refresh_lock_token = $2`,
    [CODEX_SUBSCRIPTION_CONNECTION_KEY, lockToken]
  )
  return (result.rowCount ?? 0) > 0
}

export async function loadCodexSubscriptionSecrets(
  db: DbClient,
  encryptionKey: Buffer
): Promise<CodexSubscriptionSecrets | null> {
  const result = await db.query(
    `SELECT refresh_token_encrypted,
            access_token_encrypted,
            access_token_expires_at,
            credential_revision
       FROM codex_subscription_connections
      WHERE connection_key = $1
        AND revoked_at IS NULL`,
    [CODEX_SUBSCRIPTION_CONNECTION_KEY]
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

function toSafeConnection(row: SafeConnectionRow): CodexSubscriptionSafeConnection {
  return {
    connectionKey: CODEX_SUBSCRIPTION_CONNECTION_KEY,
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
