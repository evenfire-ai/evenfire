import type { DbClient } from '../db.js'
import { decryptOAuthSecret, encryptOAuthSecret } from '../oauth/encryption.js'
import { assertGrokConnectionKey } from './grokSubscriptionConnection.js'

export type GrokSubscriptionOAuthFlow = 'device'
export type GrokSubscriptionOAuthIntent = 'connect' | 'reconnect' | 'replace'
export type GrokSubscriptionOAuthStateStatus = 'pending' | 'consumed' | 'expired' | 'cancelled'

export type GrokSubscriptionOAuthSafeState = {
  state: string
  flow: GrokSubscriptionOAuthFlow
  intent: GrokSubscriptionOAuthIntent
  status: GrokSubscriptionOAuthStateStatus
  connectionKey: string
  expiresAt: Date
  consumedAt: Date | null
  cancelledAt: Date | null
  createdAt: Date
}

export type GrokSubscriptionOAuthStateWrite = {
  state: string
  intent: GrokSubscriptionOAuthIntent
  deviceCode: string
  expiresAt: Date
  connectionKey: string
}

export type GrokSubscriptionConsumedOAuthState = {
  safe: GrokSubscriptionOAuthSafeState
  deviceCode?: string
}

type SafeOAuthStateRow = {
  state: string
  flow: GrokSubscriptionOAuthFlow
  intent: GrokSubscriptionOAuthIntent
  status: GrokSubscriptionOAuthStateStatus
  connection_key: string
  expires_at: Date | string
  consumed_at: Date | string | null
  cancelled_at: Date | string | null
  created_at: Date | string
}

type ConsumedOAuthStateRow = SafeOAuthStateRow & {
  device_code_encrypted: string | null
}

const SAFE_OAUTH_STATE_COLUMNS = `
  state,
  flow,
  intent,
  status,
  connection_key,
  expires_at,
  consumed_at,
  cancelled_at,
  created_at
`

export async function insertGrokSubscriptionOAuthState(
  db: DbClient,
  encryptionKey: Buffer,
  input: GrokSubscriptionOAuthStateWrite
): Promise<GrokSubscriptionOAuthSafeState> {
  if (!input.deviceCode) {
    throw new Error('device OAuth state requires a device code')
  }
  const connectionKey = assertGrokConnectionKey(input.connectionKey)
  const result = await db.query(
    `INSERT INTO grok_subscription_oauth_states (
       state,
       flow,
       intent,
       device_code_encrypted,
       status,
       expires_at,
       connection_key
     ) VALUES ($1, 'device', $2, $3, 'pending', $4, $5)
     RETURNING ${SAFE_OAUTH_STATE_COLUMNS}`,
    [
      input.state,
      input.intent,
      encryptOAuthSecret(encryptionKey, input.deviceCode),
      input.expiresAt,
      connectionKey,
    ]
  )
  return toSafeOAuthState(result.rows[0] as SafeOAuthStateRow)
}

export async function peekPendingGrokSubscriptionOAuthState(
  db: DbClient,
  encryptionKey: Buffer,
  state: string
): Promise<GrokSubscriptionConsumedOAuthState | null> {
  const result = await db.query(
    `SELECT ${SAFE_OAUTH_STATE_COLUMNS},
            device_code_encrypted
       FROM grok_subscription_oauth_states
      WHERE state = $1
        AND status = 'pending'
        AND expires_at > now()`,
    [state]
  )
  const row = result.rows[0] as ConsumedOAuthStateRow | undefined
  if (!row) return null
  return toConsumedOAuthState(row, encryptionKey)
}

export async function expireGrokSubscriptionOAuthState(
  db: DbClient,
  state: string
): Promise<boolean> {
  const result = await db.query(
    `UPDATE grok_subscription_oauth_states
        SET status = 'expired'
      WHERE state = $1
        AND status = 'pending'`,
    [state]
  )
  return (result.rowCount ?? 0) > 0
}

export async function consumeGrokSubscriptionOAuthState(
  db: DbClient,
  encryptionKey: Buffer,
  state: string
): Promise<GrokSubscriptionConsumedOAuthState | null> {
  const result = await db.query(
    `UPDATE grok_subscription_oauth_states
        SET status = 'consumed',
            consumed_at = now()
      WHERE state = $1
        AND status = 'pending'
        AND expires_at > now()
      RETURNING ${SAFE_OAUTH_STATE_COLUMNS},
                device_code_encrypted`,
    [state]
  )
  const row = result.rows[0] as ConsumedOAuthStateRow | undefined
  if (!row) return null
  return toConsumedOAuthState(row, encryptionKey)
}

export async function cancelGrokSubscriptionOAuthState(
  db: DbClient,
  state: string
): Promise<boolean> {
  const result = await db.query(
    `UPDATE grok_subscription_oauth_states
        SET status = 'cancelled',
            cancelled_at = now()
      WHERE state = $1
        AND status = 'pending'`,
    [state]
  )
  return (result.rowCount ?? 0) > 0
}

function toConsumedOAuthState(
  row: ConsumedOAuthStateRow,
  encryptionKey: Buffer
): GrokSubscriptionConsumedOAuthState {
  return {
    safe: toSafeOAuthState(row),
    deviceCode: row.device_code_encrypted
      ? decryptOAuthSecret(encryptionKey, row.device_code_encrypted)
      : undefined,
  }
}

function toSafeOAuthState(row: SafeOAuthStateRow): GrokSubscriptionOAuthSafeState {
  return {
    state: row.state,
    flow: row.flow,
    intent: row.intent,
    status: row.status,
    connectionKey: assertGrokConnectionKey(row.connection_key),
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
