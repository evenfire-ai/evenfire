import { config } from '../../config.js'
import { pool, withTransaction } from '../../db.js'
import {
  decryptOAuthSecret,
  deriveOAuthEncryptionKey,
  encryptOAuthSecret,
} from '../../oauth/encryption.js'
import { identityProviderError } from './errors.js'
import type {
  IdentityProvider,
  IdentityProviderSetupSession,
  IdentityProviderSetupStatus,
} from './types.js'

type SetupRow = {
  id: string
  provider: IdentityProvider
  status: IdentityProviderSetupStatus
  current_step: number
  draft: unknown
  client_secret_encrypted: string | null
  connection_id: string | null
  execution: unknown
  created_at: Date
  updated_at: Date
}

function encryptionKey(): Buffer {
  return deriveOAuthEncryptionKey(config.oauthEncryptionKey)
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function setupFromRow(row: SetupRow): IdentityProviderSetupSession {
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    currentStep: row.current_step,
    draft: objectValue(row.draft),
    hasClientSecret: Boolean(row.client_secret_encrypted),
    connectionId: row.connection_id,
    execution: objectValue(row.execution),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

const SETUP_COLUMNS = `id, provider, status, current_step, draft, client_secret_encrypted,
  connection_id, execution, created_at, updated_at`

export async function getActiveIdentityProviderSetup(
  provider: IdentityProvider
): Promise<IdentityProviderSetupSession | null> {
  const result = await pool.query(
    `SELECT ${SETUP_COLUMNS}
       FROM identity_provider_setup_sessions
      WHERE provider = $1
        AND status IN ('draft', 'authorizing', 'configuring', 'importing')
      ORDER BY updated_at DESC
      LIMIT 1`,
    [provider]
  )
  const row = result.rows[0] as SetupRow | undefined
  return row ? setupFromRow(row) : null
}

export async function getIdentityProviderSetupById(
  setupId: string
): Promise<IdentityProviderSetupSession | null> {
  const result = await pool.query(
    `SELECT ${SETUP_COLUMNS}
       FROM identity_provider_setup_sessions
      WHERE id = $1
      LIMIT 1`,
    [setupId]
  )
  const row = result.rows[0] as SetupRow | undefined
  return row ? setupFromRow(row) : null
}

export async function createIdentityProviderSetup(input: {
  provider: IdentityProvider
  adminUserId: string
  initialDraft: Record<string, unknown>
  connectionId?: string | null
  currentStep?: number
  status?: IdentityProviderSetupStatus
  replaceActive?: boolean
}): Promise<IdentityProviderSetupSession> {
  return withTransaction(async db => {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('identity-provider-setup:' || $1))`, [
      input.provider,
    ])
    if (input.replaceActive) {
      await db.query(
        `UPDATE identity_provider_setup_sessions
            SET status = 'cancelled', updated_at = NOW()
          WHERE provider = $1
            AND status IN ('draft', 'authorizing', 'configuring', 'importing')
            AND (import_lock_token IS NULL OR import_lock_expires_at < NOW())`,
        [input.provider]
      )
      const stillActive = await db.query(
        `SELECT id
           FROM identity_provider_setup_sessions
          WHERE provider = $1
            AND status IN ('draft', 'authorizing', 'configuring', 'importing')
          LIMIT 1`,
        [input.provider]
      )
      if ((stillActive.rowCount ?? 0) > 0) {
        throw identityProviderError(409, 'Microsoft import is currently running')
      }
    }
    const result = await db.query(
      `INSERT INTO identity_provider_setup_sessions(
         provider, draft, created_by_admin_id, connection_id, current_step, status
       )
       VALUES($1, $2::jsonb, $3, $4, $5, $6)
       ON CONFLICT (provider)
         WHERE status IN ('draft', 'authorizing', 'configuring', 'importing')
       DO UPDATE SET updated_at = NOW()
       RETURNING ${SETUP_COLUMNS}`,
      [
        input.provider,
        JSON.stringify(input.initialDraft),
        input.adminUserId,
        input.connectionId || null,
        input.currentStep || 1,
        input.status || 'draft',
      ]
    )
    return setupFromRow(result.rows[0] as SetupRow)
  })
}

export async function updateIdentityProviderSetup(input: {
  setupId: string
  currentStep?: number
  draft?: Record<string, unknown>
  status?: IdentityProviderSetupStatus
  execution?: Record<string, unknown>
}): Promise<IdentityProviderSetupSession | null> {
  const currentStep = Math.max(1, Math.min(9, Number(input.currentStep || 1)))
  const result = await pool.query(
    `UPDATE identity_provider_setup_sessions
        SET current_step = CASE WHEN $2::boolean THEN $3 ELSE current_step END,
            draft = CASE WHEN $4::boolean THEN $5::jsonb ELSE draft END,
            status = COALESCE($6, status),
            execution = CASE WHEN $7::boolean THEN $8::jsonb ELSE execution END,
            updated_at = NOW()
      WHERE id = $1
        AND status IN ('draft', 'authorizing', 'configuring', 'importing')
    RETURNING ${SETUP_COLUMNS}`,
    [
      input.setupId,
      input.currentStep !== undefined,
      currentStep,
      input.draft !== undefined,
      JSON.stringify(input.draft || {}),
      input.status || null,
      input.execution !== undefined,
      JSON.stringify(input.execution || {}),
    ]
  )
  const row = result.rows[0] as SetupRow | undefined
  return row ? setupFromRow(row) : null
}

export async function saveIdentityProviderSetupSecret(
  setupId: string,
  clientSecret: string
): Promise<IdentityProviderSetupSession | null> {
  const normalized = clientSecret.trim()
  if (!normalized) throw identityProviderError(400, 'Client secret value is required')
  const result = await pool.query(
    `UPDATE identity_provider_setup_sessions
        SET client_secret_encrypted = $2,
            updated_at = NOW()
      WHERE id = $1
        AND status IN ('draft', 'authorizing', 'configuring')
    RETURNING ${SETUP_COLUMNS}`,
    [setupId, encryptOAuthSecret(encryptionKey(), normalized)]
  )
  const row = result.rows[0] as SetupRow | undefined
  return row ? setupFromRow(row) : null
}

export async function loadIdentityProviderSetupSecret(setupId: string): Promise<string | null> {
  const result = await pool.query(
    `SELECT client_secret_encrypted
       FROM identity_provider_setup_sessions
      WHERE id = $1
        AND status IN ('draft', 'authorizing', 'configuring')
      LIMIT 1`,
    [setupId]
  )
  const encrypted = String(
    (result.rows[0] as { client_secret_encrypted?: string } | undefined)?.client_secret_encrypted ||
      ''
  )
  return encrypted ? decryptOAuthSecret(encryptionKey(), encrypted) : null
}

export async function attachConnectionToIdentityProviderSetup(
  setupId: string,
  connectionId: string
): Promise<void> {
  await pool.query(
    `UPDATE identity_provider_setup_sessions
        SET connection_id = $2,
            status = 'authorizing',
            current_step = GREATEST(current_step, 6),
            updated_at = NOW()
      WHERE id = $1`,
    [setupId, connectionId]
  )
}

export async function markIdentityProviderSetupAuthorized(connectionId: string): Promise<void> {
  await pool.query(
    `UPDATE identity_provider_setup_sessions
        SET status = 'configuring',
            current_step = GREATEST(current_step, 6),
            updated_at = NOW()
      WHERE connection_id = $1
        AND status IN ('draft', 'authorizing', 'configuring')`,
    [connectionId]
  )
}
