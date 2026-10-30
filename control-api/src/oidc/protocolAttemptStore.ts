import { createHash, randomUUID } from 'node:crypto'
import type { DbClient } from '../db.js'
import {
  decryptAes256Gcm,
  deriveOAuthEncryptionKey,
  encryptAes256Gcm,
} from '../oauth/encryption.js'

export const OIDC_PROTOCOL_ATTEMPT_TTL_MS = 10 * 60 * 1000
const ATTEMPT_PURPOSE = 'identity-proof-v1'
const ENVELOPE_VERSION = 'v1'

export type OidcProtocolAttemptBinding = Readonly<{
  registrationId: string
  configurationGeneration: string
  issuer: string
  clientId: string
  redirectUri: string
  responseMode: 'query'
}>

export type OidcProtocolAttemptWrite = OidcProtocolAttemptBinding &
  Readonly<{
    state: string
    pkceVerifier: string
    nonce: string
    expiresAt: Date
  }>

export type ClaimedOidcProtocolAttempt = OidcProtocolAttemptBinding &
  Readonly<{
    id: string
    pkceVerifier: string
    nonce: string
    createdAt: Date
    expiresAt: Date
  }>

type ClaimedRow = {
  id: string
  registration_id: string
  configuration_generation: string
  issuer: string
  client_id: string
  redirect_uri: string
  response_mode: 'query'
  pkce_verifier_encrypted: string
  nonce_encrypted: string
  created_at: Date | string
  expires_at: Date | string
}

function aad(attemptId: string, field: 'pkce-verifier' | 'nonce'): Buffer {
  return Buffer.from(`${ENVELOPE_VERSION}:${ATTEMPT_PURPOSE}:${attemptId}:${field}`, 'utf8')
}

function encryptAttemptSecret(
  key: Buffer,
  attemptId: string,
  field: 'pkce-verifier' | 'nonce',
  plaintext: string
): string {
  const encrypted = encryptAes256Gcm(key, Buffer.from(plaintext, 'utf8'), aad(attemptId, field))
  return `${ENVELOPE_VERSION}.${encrypted.nonce.toString('base64url')}.${encrypted.ciphertext.toString('base64url')}`
}

function decryptAttemptSecret(
  key: Buffer,
  attemptId: string,
  field: 'pkce-verifier' | 'nonce',
  value: string
): string {
  const [version, nonceValue, ciphertextValue, extra] = value.split('.')
  if (version !== ENVELOPE_VERSION || !nonceValue || !ciphertextValue || extra !== undefined) {
    throw new Error('Malformed OIDC attempt secret envelope')
  }
  const nonce = Buffer.from(nonceValue, 'base64url')
  const ciphertext = Buffer.from(ciphertextValue, 'base64url')
  if (nonce.length !== 12 || ciphertext.length < 17) {
    throw new Error('Malformed OIDC attempt secret envelope')
  }
  return decryptAes256Gcm(key, { nonce, ciphertext }, aad(attemptId, field)).toString('utf8')
}

export async function applyOidcProtocolAttemptSchema(db: Pick<DbClient, 'query'>): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS oidc_protocol_attempts (
      id UUID PRIMARY KEY,
      state_hash TEXT NOT NULL UNIQUE CHECK (state_hash ~ '^[0-9a-f]{64}$'),
      registration_id TEXT NOT NULL,
      configuration_generation TEXT NOT NULL,
      issuer TEXT NOT NULL,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      response_mode TEXT NOT NULL CHECK (response_mode = 'query'),
      purpose TEXT NOT NULL CHECK (purpose = '${ATTEMPT_PURPOSE}'),
      pkce_verifier_encrypted TEXT,
      nonce_encrypted TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'redeeming', 'completed', 'failed', 'cancelled')),
      expires_at TIMESTAMPTZ NOT NULL,
      claimed_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT oidc_protocol_attempts_lifecycle CHECK (
        (status = 'pending' AND claimed_at IS NULL AND finished_at IS NULL
          AND pkce_verifier_encrypted IS NOT NULL AND nonce_encrypted IS NOT NULL)
        OR (status = 'redeeming' AND claimed_at IS NOT NULL AND finished_at IS NULL
          AND pkce_verifier_encrypted IS NULL AND nonce_encrypted IS NULL)
        OR (status IN ('completed', 'failed') AND claimed_at IS NOT NULL AND finished_at IS NOT NULL
          AND pkce_verifier_encrypted IS NULL AND nonce_encrypted IS NULL)
        OR (status = 'cancelled' AND claimed_at IS NULL AND finished_at IS NOT NULL
          AND pkce_verifier_encrypted IS NULL AND nonce_encrypted IS NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS oidc_protocol_attempts_pending_expiry_idx
      ON oidc_protocol_attempts (expires_at)
      WHERE status = 'pending';

    REVOKE ALL PRIVILEGES ON TABLE oidc_protocol_attempts FROM PUBLIC;
    REVOKE ALL PRIVILEGES ON TABLE oidc_protocol_attempts
      FROM trace_maintenance_runtime, workflow_recipes_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE oidc_protocol_attempts TO control_api_runtime;
    REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE oidc_protocol_attempts FROM control_api_runtime;
  `)
}

export async function applyOidcProtocolAttemptExpiryIndexMigration(
  db: Pick<DbClient, 'query'>
): Promise<void> {
  const table = await db.query(
    `SELECT to_regclass('public.oidc_protocol_attempts')::text AS relation`
  )
  const relation = table.rows[0] as { relation?: string | null } | undefined
  if (!relation?.relation) return

  await db.query(`
    CREATE INDEX IF NOT EXISTS oidc_protocol_attempts_expiry_idx
      ON public.oidc_protocol_attempts (expires_at, id);
    DROP INDEX IF EXISTS public.oidc_protocol_attempts_pending_expiry_idx;
  `)
}

export async function insertOidcProtocolAttempt(
  db: Pick<DbClient, 'query'>,
  encryptionKeyHex: string,
  input: OidcProtocolAttemptWrite
): Promise<{ id: string; expiresAt: Date }> {
  if (!input.state || !input.pkceVerifier || !input.nonce) {
    throw new Error('OIDC protocol attempt requires state, PKCE verifier, and nonce')
  }
  const key = deriveOAuthEncryptionKey(encryptionKeyHex)
  const id = randomUUID()
  const stateHash = createHash('sha256').update(input.state, 'utf8').digest('hex')

  // The one-day grace and 100-row batch are technical storage defaults, not auth policy.
  await db.query(
    `WITH expired_attempts AS (
       SELECT id
         FROM oidc_protocol_attempts
        WHERE expires_at < now() - INTERVAL '1 day'
          AND status IN ('pending', 'redeeming', 'completed', 'failed', 'cancelled')
        ORDER BY expires_at, id
        LIMIT 100
        FOR UPDATE SKIP LOCKED
     )
     DELETE FROM oidc_protocol_attempts AS attempt
      USING expired_attempts
      WHERE attempt.id = expired_attempts.id`
  )
  const result = await db.query(
    `INSERT INTO oidc_protocol_attempts (
       id, state_hash, registration_id, configuration_generation, issuer, client_id,
       redirect_uri, response_mode, purpose, pkce_verifier_encrypted,
       nonce_encrypted, status, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12)
     RETURNING id, expires_at`,
    [
      id,
      stateHash,
      input.registrationId,
      input.configurationGeneration,
      input.issuer,
      input.clientId,
      input.redirectUri,
      input.responseMode,
      ATTEMPT_PURPOSE,
      encryptAttemptSecret(key, id, 'pkce-verifier', input.pkceVerifier),
      encryptAttemptSecret(key, id, 'nonce', input.nonce),
      input.expiresAt,
    ]
  )
  const row = result.rows[0] as { id: string; expires_at: Date | string } | undefined
  if (!row) throw new Error('OIDC protocol attempt was not persisted')
  return { id: row.id, expiresAt: asDate(row.expires_at) }
}

/** Atomic pending→redeeming claim. A state can be successfully claimed once. */
export async function claimOidcProtocolAttempt(
  db: Pick<DbClient, 'query'>,
  encryptionKeyHex: string,
  state: string,
  binding: OidcProtocolAttemptBinding
): Promise<ClaimedOidcProtocolAttempt | null> {
  if (!state || state.length > 512) return null
  const stateHash = createHash('sha256').update(state, 'utf8').digest('hex')
  const result = await db.query(
    `WITH candidate AS (
       SELECT id, pkce_verifier_encrypted, nonce_encrypted
         FROM oidc_protocol_attempts
        WHERE state_hash = $1
          AND status = 'pending'
          AND expires_at > now()
          AND registration_id = $2
          AND configuration_generation = $3
          AND issuer = $4
          AND client_id = $5
          AND redirect_uri = $6
          AND response_mode = $7
          AND purpose = $8
        FOR UPDATE
     ), claimed AS (
       UPDATE oidc_protocol_attempts AS attempt
          SET status = 'redeeming',
              claimed_at = now(),
              pkce_verifier_encrypted = NULL,
              nonce_encrypted = NULL
         FROM candidate
        WHERE attempt.id = candidate.id
        RETURNING attempt.id, attempt.registration_id, attempt.configuration_generation,
                  attempt.issuer, attempt.client_id, attempt.redirect_uri,
                  attempt.response_mode, attempt.created_at, attempt.expires_at,
                  candidate.pkce_verifier_encrypted, candidate.nonce_encrypted
     )
     SELECT * FROM claimed`,
    [
      stateHash,
      binding.registrationId,
      binding.configurationGeneration,
      binding.issuer,
      binding.clientId,
      binding.redirectUri,
      binding.responseMode,
      ATTEMPT_PURPOSE,
    ]
  )
  const row = result.rows[0] as ClaimedRow | undefined
  if (!row) return null
  const key = deriveOAuthEncryptionKey(encryptionKeyHex)
  return {
    id: row.id,
    registrationId: row.registration_id,
    configurationGeneration: row.configuration_generation,
    issuer: row.issuer,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    responseMode: row.response_mode,
    pkceVerifier: decryptAttemptSecret(key, row.id, 'pkce-verifier', row.pkce_verifier_encrypted),
    nonce: decryptAttemptSecret(key, row.id, 'nonce', row.nonce_encrypted),
    createdAt: asDate(row.created_at),
    expiresAt: asDate(row.expires_at),
  }
}

export async function finishOidcProtocolAttempt(
  db: Pick<DbClient, 'query'>,
  attemptId: string,
  result: 'completed' | 'failed'
): Promise<boolean> {
  const response = await db.query(
    `UPDATE oidc_protocol_attempts
        SET status = $2,
            finished_at = now()
      WHERE id = $1
        AND status = 'redeeming'
        AND pkce_verifier_encrypted IS NULL
        AND nonce_encrypted IS NULL`,
    [attemptId, result]
  )
  return (response.rowCount ?? 0) === 1
}

export async function cancelOidcProtocolAttempt(
  db: Pick<DbClient, 'query'>,
  state: string,
  binding: OidcProtocolAttemptBinding
): Promise<boolean> {
  if (!state || state.length > 512) return false
  const stateHash = createHash('sha256').update(state, 'utf8').digest('hex')
  const result = await db.query(
    `UPDATE oidc_protocol_attempts
        SET status = 'cancelled',
            finished_at = now(),
            pkce_verifier_encrypted = NULL,
            nonce_encrypted = NULL
      WHERE state_hash = $1
        AND status = 'pending'
        AND registration_id = $2
        AND configuration_generation = $3
        AND issuer = $4
        AND client_id = $5
        AND redirect_uri = $6
        AND response_mode = $7
        AND purpose = $8`,
    [
      stateHash,
      binding.registrationId,
      binding.configurationGeneration,
      binding.issuer,
      binding.clientId,
      binding.redirectUri,
      binding.responseMode,
      ATTEMPT_PURPOSE,
    ]
  )
  return (result.rowCount ?? 0) === 1
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}
