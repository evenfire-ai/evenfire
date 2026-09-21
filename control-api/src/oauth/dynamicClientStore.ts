import type { DbClient } from '../db.js'
import { decryptOAuthSecret, encryptOAuthSecret } from './encryption.js'

/**
 * Store for DCR (RFC 7591) dynamic clients — sibling of `store.ts` (spec 02 C2,
 * D-5, DEC-18). When an Authorization Server supports neither a pre-registered
 * client nor CIMD, control-api registers a client dynamically and persists its
 * credentials here with the same at-rest guarantees as `oauth_grants`.
 *
 * Every function takes `(db, encryptionKey, input)` (or `(db, key)` for the
 * key-only delete): the store owns no pool and no key. The `client_secret` and
 * the RFC 7592 `registration_access_token` are AES-256-GCM encrypted with
 * `encryptOAuthSecret` and never stored or returned in the clear except through
 * an explicit decrypt on read. `client_id` is the AS's public assignment and is
 * stored (and mirrored to `spec.oauth.id`) in plaintext by design.
 *
 * Keyed per-server-CR: `(owner_kind, server_namespace, server_name)` mirror the
 * pre-registered `${serverName}-oauth-client` Secret coordinates and
 * `oauth_grants` — the untrusted AS never names the primary key (DEC-18).
 */

/**
 * Identifies one `dynamic_clients` row. `ownerKind` defaults to `'mcpserver'`
 * (mirrors `resolveOwnerKind` in store.ts); remote OAuth servers are the only
 * dynamic-client owners today.
 */
export interface DynamicClientKey {
  ownerKind?: 'mcpserver'
  serverNamespace: string
  serverName: string
}

/** Resolve the owner domain of a key, defaulting to the mcpserver domain. */
function resolveOwnerKind(input: { ownerKind?: 'mcpserver' }): 'mcpserver' {
  return input.ownerKind ?? 'mcpserver'
}

/** One decrypted row of `dynamic_clients`. */
export interface DynamicClientRow {
  ownerKind: 'mcpserver'
  serverNamespace: string
  serverName: string
  issuer: string
  /** AS-assigned public client identifier (never encrypted). */
  clientId: string
  clientMode: 'public' | 'confidential'
  /** Plaintext client secret; undefined for a public client or when absent. */
  clientSecret?: string
  /** Plaintext RFC 7592 registration-management bearer; undefined when absent. */
  registrationAccessToken?: string
  /** RFC 7592 management endpoint; undefined when the AS returned none. */
  registrationClientUri?: string
  clientIdIssuedAt?: Date
  /** RFC 7591; null (non-expiring) is mapped to undefined. */
  clientSecretExpiresAt?: Date
  createdAt: Date
  updatedAt: Date
}

export type UpsertDynamicClientInput = DynamicClientKey & {
  issuer: string
  clientId: string
  clientMode: 'public' | 'confidential'
  /** Encrypted before storage; omit for a public client. */
  clientSecret?: string
  /** Encrypted before storage; omit when the AS returned none. */
  registrationAccessToken?: string
  registrationClientUri?: string
  /** RFC 7591 NumericDate (epoch seconds); absent → NULL. */
  clientIdIssuedAtSec?: number
  /** RFC 7591 NumericDate (epoch seconds); 0/absent (non-expiring) → NULL. */
  clientSecretExpiresAtSec?: number
}

/**
 * RFC 7591 NumericDate (absolute epoch seconds) → Date. `0` means "does not
 * expire" (RFC 7591 §3.2.1) and, like an absent value, maps to NULL.
 */
function numericDateToDate(seconds: number | undefined): Date | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null
  return new Date(seconds * 1000)
}

/**
 * Insert (or replace) the dynamic client for a server CR. Re-registration
 * overwrites in place (INSERT … ON CONFLICT DO UPDATE), which is also the only
 * rotation path in C2 — there is no dedicated rotate fn (no caller; avoids dead
 * code, DEC-18). `client_secret` and `registration_access_token` are encrypted
 * at rest; a public client stores NULL for the secret.
 */
export async function upsertDynamicClient(
  db: DbClient,
  encryptionKey: Buffer,
  input: UpsertDynamicClientInput
): Promise<void> {
  const ownerKind = resolveOwnerKind(input)
  const clientSecretEncrypted = input.clientSecret
    ? encryptOAuthSecret(encryptionKey, input.clientSecret)
    : null
  const registrationAccessTokenEncrypted = input.registrationAccessToken
    ? encryptOAuthSecret(encryptionKey, input.registrationAccessToken)
    : null

  await db.query(
    `INSERT INTO dynamic_clients (
       owner_kind, server_namespace, server_name, issuer, client_id, client_mode,
       client_secret_encrypted, registration_access_token_encrypted,
       registration_client_uri, client_id_issued_at, client_secret_expires_at,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
     ON CONFLICT (owner_kind, server_namespace, server_name)
     DO UPDATE SET
       issuer = EXCLUDED.issuer,
       client_id = EXCLUDED.client_id,
       client_mode = EXCLUDED.client_mode,
       client_secret_encrypted = EXCLUDED.client_secret_encrypted,
       registration_access_token_encrypted = EXCLUDED.registration_access_token_encrypted,
       registration_client_uri = EXCLUDED.registration_client_uri,
       client_id_issued_at = EXCLUDED.client_id_issued_at,
       client_secret_expires_at = EXCLUDED.client_secret_expires_at,
       updated_at = NOW()`,
    [
      ownerKind,
      input.serverNamespace,
      input.serverName,
      input.issuer,
      input.clientId,
      input.clientMode,
      clientSecretEncrypted,
      registrationAccessTokenEncrypted,
      input.registrationClientUri ?? null,
      numericDateToDate(input.clientIdIssuedAtSec),
      numericDateToDate(input.clientSecretExpiresAtSec),
    ]
  )
}

interface DynamicClientDbRow {
  owner_kind: 'mcpserver'
  server_namespace: string
  server_name: string
  issuer: string
  client_id: string
  client_mode: 'public' | 'confidential'
  client_secret_encrypted: string | null
  registration_access_token_encrypted: string | null
  registration_client_uri: string | null
  client_id_issued_at: Date | null
  client_secret_expires_at: Date | null
  created_at: Date
  updated_at: Date
}

const SELECT_COLUMNS = `owner_kind, server_namespace, server_name, issuer, client_id, client_mode,
            client_secret_encrypted, registration_access_token_encrypted,
            registration_client_uri, client_id_issued_at, client_secret_expires_at,
            created_at, updated_at`

/** Read one dynamic client, decrypting its secret and registration token. */
export async function getDynamicClient(
  db: DbClient,
  encryptionKey: Buffer,
  key: DynamicClientKey
): Promise<DynamicClientRow | null> {
  const ownerKind = resolveOwnerKind(key)
  const result = await db.query(
    `SELECT ${SELECT_COLUMNS}
       FROM dynamic_clients
      WHERE owner_kind = $1 AND server_namespace = $2 AND server_name = $3`,
    [ownerKind, key.serverNamespace, key.serverName]
  )
  if (result.rows.length === 0) return null
  const row = result.rows[0] as DynamicClientDbRow
  return {
    ownerKind: row.owner_kind,
    serverNamespace: row.server_namespace,
    serverName: row.server_name,
    issuer: row.issuer,
    clientId: row.client_id,
    clientMode: row.client_mode,
    clientSecret: row.client_secret_encrypted
      ? decryptOAuthSecret(encryptionKey, row.client_secret_encrypted)
      : undefined,
    registrationAccessToken: row.registration_access_token_encrypted
      ? decryptOAuthSecret(encryptionKey, row.registration_access_token_encrypted)
      : undefined,
    registrationClientUri: row.registration_client_uri ?? undefined,
    clientIdIssuedAt: row.client_id_issued_at ?? undefined,
    clientSecretExpiresAt: row.client_secret_expires_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Metadata-only view of a `dynamic_clients` row whose confidential secret is at
 * or near expiry — enough for the DCR lifecycle decision (§5) without touching
 * any encrypted material.
 */
export interface ExpiringDynamicClient {
  serverNamespace: string
  serverName: string
  clientMode: 'confidential'
  /** Non-null by construction (the enumeration filters out NULL expiry). */
  clientSecretExpiresAt: Date
}

/**
 * Enumerate confidential dynamic clients whose `client_secret_expires_at` is at
 * or before `now + withinMs` (mini-spec L §5). METADATA-ONLY: it never decrypts
 * the secret or the registration token, so it needs no `encryptionKey`.
 *
 * The filter already realizes the §5 table's structure: `public` and
 * non-expiring rows are excluded (C1/C2), healthy rows fall outside `withinMs`
 * (C3), and the returned set covers BOTH expiring (C4, `now < exp`) and expired
 * (C5, `exp ≤ now`) — the caller splits them with `classifyDcrSecretDecision`.
 */
export async function listExpiringDynamicClients(
  db: DbClient,
  opts: { withinMs: number }
): Promise<ExpiringDynamicClient[]> {
  const result = await db.query(
    `SELECT server_namespace, server_name, client_mode, client_secret_expires_at
       FROM dynamic_clients
      WHERE client_mode = 'confidential'
        AND client_secret_expires_at IS NOT NULL
        AND client_secret_expires_at <= NOW() + ($1::bigint * INTERVAL '1 millisecond')
      ORDER BY server_namespace, server_name`,
    [opts.withinMs]
  )
  return result.rows.map(r => {
    const row = r as {
      server_namespace: string
      server_name: string
      client_mode: 'confidential'
      client_secret_expires_at: Date
    }
    return {
      serverNamespace: row.server_namespace,
      serverName: row.server_name,
      clientMode: row.client_mode,
      clientSecretExpiresAt: row.client_secret_expires_at,
    }
  })
}

/**
 * Hard-delete the dynamic client for a server CR (idempotent). Returns the
 * number of rows removed so a caller can audit whether anything was revoked
 * (0 ⇒ already gone). Mirrors `deleteOAuthGrant`.
 */
export async function deleteDynamicClient(db: DbClient, key: DynamicClientKey): Promise<number> {
  const ownerKind = resolveOwnerKind(key)
  const result = await db.query(
    `DELETE FROM dynamic_clients
      WHERE owner_kind = $1 AND server_namespace = $2 AND server_name = $3`,
    [ownerKind, key.serverNamespace, key.serverName]
  )
  return result.rowCount ?? 0
}
