import type { DbClient } from '../db.js'
import { decryptOAuthSecret, encryptOAuthSecret } from '../oauth/encryption.js'

export type CodexSubscriptionOAuthFlow = 'browser' | 'device'
export type CodexSubscriptionOAuthIntent = 'connect' | 'reconnect' | 'replace'
export type CodexSubscriptionOAuthStateStatus = 'pending' | 'consumed' | 'expired' | 'cancelled'

export type CodexSubscriptionOAuthSafeState = {
  state: string
  flow: CodexSubscriptionOAuthFlow
  intent: CodexSubscriptionOAuthIntent
  status: CodexSubscriptionOAuthStateStatus
  expiresAt: Date
  consumedAt: Date | null
  cancelledAt: Date | null
  createdAt: Date
}

export type CodexSubscriptionOAuthStateWrite = {
  state: string
  flow: CodexSubscriptionOAuthFlow
  intent: CodexSubscriptionOAuthIntent
  pkceVerifier?: string
  /** Encrypted Codex device handle JSON: { deviceAuthId, userCode }. */
  deviceCode?: string
  expiresAt: Date
}

export type CodexSubscriptionConsumedOAuthState = {
  safe: CodexSubscriptionOAuthSafeState
  pkceVerifier?: string
  deviceCode?: string
}

type SafeOAuthStateRow = {
  state: string
  flow: CodexSubscriptionOAuthFlow
  intent: CodexSubscriptionOAuthIntent
  status: CodexSubscriptionOAuthStateStatus
  expires_at: Date | string
  consumed_at: Date | string | null
  cancelled_at: Date | string | null
  created_at: Date | string
}

type ConsumedOAuthStateRow = SafeOAuthStateRow & {
  pkce_verifier_encrypted: string | null
  device_code_encrypted: string | null
}

const SAFE_OAUTH_STATE_COLUMNS = `
  state,
  flow,
  intent,
  status,
  expires_at,
  consumed_at,
  cancelled_at,
  created_at
`

export async function applyCodexSubscriptionOAuthStateSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS codex_subscription_oauth_states (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      state TEXT NOT NULL,
      flow TEXT NOT NULL CHECK (flow IN ('browser', 'device')),
      intent TEXT NOT NULL CHECK (intent IN ('connect', 'reconnect', 'replace')),
      pkce_verifier_encrypted TEXT,
      device_code_encrypted TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'expired', 'cancelled')),
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT codex_subscription_oauth_states_state_unique UNIQUE (state),
      CONSTRAINT codex_subscription_oauth_states_flow_secrets CHECK (
        (flow = 'browser' AND pkce_verifier_encrypted IS NOT NULL)
        OR (flow = 'device' AND device_code_encrypted IS NOT NULL)
      ),
      CONSTRAINT codex_subscription_oauth_states_lifecycle CHECK (
        (status = 'pending' AND consumed_at IS NULL AND cancelled_at IS NULL)
        OR (status = 'consumed' AND consumed_at IS NOT NULL AND cancelled_at IS NULL)
        OR (status = 'cancelled' AND cancelled_at IS NOT NULL AND consumed_at IS NULL)
        OR (status = 'expired' AND consumed_at IS NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS codex_subscription_oauth_states_pending_expiry_idx
      ON codex_subscription_oauth_states (expires_at)
      WHERE status = 'pending';

    REVOKE ALL PRIVILEGES ON TABLE codex_subscription_oauth_states FROM PUBLIC;
    REVOKE ALL PRIVILEGES ON TABLE codex_subscription_oauth_states
      FROM trace_maintenance_runtime, workflow_recipes_runtime;
    GRANT SELECT, INSERT, UPDATE ON TABLE codex_subscription_oauth_states TO control_api_runtime;
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE codex_subscription_oauth_states FROM control_api_runtime;
  `)
}

export async function insertCodexSubscriptionOAuthState(
  db: DbClient,
  encryptionKey: Buffer,
  input: CodexSubscriptionOAuthStateWrite
): Promise<CodexSubscriptionOAuthSafeState> {
  if (input.flow === 'browser' && !input.pkceVerifier) {
    throw new Error('browser OAuth state requires a PKCE verifier')
  }
  if (input.flow === 'device' && !input.deviceCode) {
    throw new Error('device OAuth state requires a device code')
  }
  const result = await db.query(
    `INSERT INTO codex_subscription_oauth_states (
       state,
       flow,
       intent,
       pkce_verifier_encrypted,
       device_code_encrypted,
       status,
       expires_at
     ) VALUES ($1, $2, $3, $4, $5, 'pending', $6)
     RETURNING ${SAFE_OAUTH_STATE_COLUMNS}`,
    [
      input.state,
      input.flow,
      input.intent,
      input.pkceVerifier ? encryptOAuthSecret(encryptionKey, input.pkceVerifier) : null,
      input.deviceCode ? encryptOAuthSecret(encryptionKey, input.deviceCode) : null,
      input.expiresAt,
    ]
  )
  return toSafeOAuthState(result.rows[0] as SafeOAuthStateRow)
}

export async function peekPendingCodexSubscriptionOAuthState(
  db: DbClient,
  encryptionKey: Buffer,
  state: string
): Promise<CodexSubscriptionConsumedOAuthState | null> {
  const result = await db.query(
    `SELECT ${SAFE_OAUTH_STATE_COLUMNS},
            pkce_verifier_encrypted,
            device_code_encrypted
       FROM codex_subscription_oauth_states
      WHERE state = $1
        AND status = 'pending'
        AND expires_at > now()`,
    [state]
  )
  const row = result.rows[0] as ConsumedOAuthStateRow | undefined
  if (!row) return null
  return toConsumedOAuthState(row, encryptionKey)
}

export async function expireCodexSubscriptionOAuthState(
  db: DbClient,
  state: string
): Promise<boolean> {
  const result = await db.query(
    `UPDATE codex_subscription_oauth_states
        SET status = 'expired'
      WHERE state = $1
        AND status = 'pending'`,
    [state]
  )
  return (result.rowCount ?? 0) > 0
}

function toConsumedOAuthState(
  row: ConsumedOAuthStateRow,
  encryptionKey: Buffer
): CodexSubscriptionConsumedOAuthState {
  return {
    safe: toSafeOAuthState(row),
    pkceVerifier: row.pkce_verifier_encrypted
      ? decryptOAuthSecret(encryptionKey, row.pkce_verifier_encrypted)
      : undefined,
    deviceCode: row.device_code_encrypted
      ? decryptOAuthSecret(encryptionKey, row.device_code_encrypted)
      : undefined,
  }
}

export async function consumeCodexSubscriptionOAuthState(
  db: DbClient,
  encryptionKey: Buffer,
  state: string
): Promise<CodexSubscriptionConsumedOAuthState | null> {
  const result = await db.query(
    `UPDATE codex_subscription_oauth_states
        SET status = 'consumed',
            consumed_at = now()
      WHERE state = $1
        AND status = 'pending'
        AND expires_at > now()
      RETURNING ${SAFE_OAUTH_STATE_COLUMNS},
                pkce_verifier_encrypted,
                device_code_encrypted`,
    [state]
  )
  const row = result.rows[0] as ConsumedOAuthStateRow | undefined
  if (!row) return null
  return toConsumedOAuthState(row, encryptionKey)
}

export async function cancelCodexSubscriptionOAuthState(
  db: DbClient,
  state: string
): Promise<boolean> {
  const result = await db.query(
    `UPDATE codex_subscription_oauth_states
        SET status = 'cancelled',
            cancelled_at = now()
      WHERE state = $1
        AND status = 'pending'`,
    [state]
  )
  return (result.rowCount ?? 0) > 0
}

function toSafeOAuthState(row: SafeOAuthStateRow): CodexSubscriptionOAuthSafeState {
  return {
    state: row.state,
    flow: row.flow,
    intent: row.intent,
    status: row.status,
    expiresAt: asDate(row.expires_at) ?? new Date(0),
    consumedAt: asDate(row.consumed_at),
    cancelledAt: asDate(row.cancelled_at),
    createdAt: asDate(row.created_at) ?? new Date(0),
  }
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null
  return value instanceof Date ? value : new Date(value)
}
