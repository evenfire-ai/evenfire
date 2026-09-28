import type { DbClient, DbTransactionClient } from '../db.js'
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
  /** Surrogate row id; part of the identity a reclaim must still find unchanged. */
  id: string
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
  /** Saga install token that owns the row during the install; undefined = legacy. */
  installId?: string
  /** metadata.uid of the owning McpServer once bound; undefined = pending/legacy. */
  crUid?: string
  createdAt: Date
  updatedAt: Date
  /**
   * Age of the row (`NOW() - updated_at`) as measured by the database at read
   * time, so the pending-TTL decision never mixes the pod clock with the DB clock
   * that stamped `updated_at`.
   */
  ageMs: number
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
 * Column values that carry the AS credentials of a dynamic client, encrypted and
 * date-normalized identically wherever an install-identity row is written (pending
 * insert / orphan reclaim), so the at-rest shape lives in ONE place (D4).
 */
function encodeCredentialColumns(
  encryptionKey: Buffer,
  input: UpsertDynamicClientInput
): {
  clientSecretEncrypted: string | null
  registrationAccessTokenEncrypted: string | null
  registrationClientUri: string | null
  clientIdIssuedAt: Date | null
  clientSecretExpiresAt: Date | null
} {
  return {
    clientSecretEncrypted: input.clientSecret
      ? encryptOAuthSecret(encryptionKey, input.clientSecret)
      : null,
    registrationAccessTokenEncrypted: input.registrationAccessToken
      ? encryptOAuthSecret(encryptionKey, input.registrationAccessToken)
      : null,
    registrationClientUri: input.registrationClientUri ?? null,
    clientIdIssuedAt: numericDateToDate(input.clientIdIssuedAtSec),
    clientSecretExpiresAt: numericDateToDate(input.clientSecretExpiresAtSec),
  }
}

/**
 * Insert (or replace) the dynamic client for a server CR. Re-registration
 * overwrites in place (INSERT … ON CONFLICT DO UPDATE). `client_secret` and
 * `registration_access_token` are encrypted at rest; a public client stores NULL
 * for the secret.
 *
 * NO production caller: the remote-install saga now claims the name with
 * `insertDynamicClientPending` (ON CONFLICT DO NOTHING) so an install can never
 * clobber a live server's row. This clobbering upsert is retained ONLY as a store
 * primitive exercised by its own unit tests and as a row-seeder for other suites;
 * it must NOT be reintroduced into any install/reclaim path.
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
  id: string | number
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
  install_id: string | null
  cr_uid: string | null
  created_at: Date
  updated_at: Date
  age_ms: number
}

const SELECT_COLUMNS = `id, owner_kind, server_namespace, server_name, issuer, client_id, client_mode,
            client_secret_encrypted, registration_access_token_encrypted,
            registration_client_uri, client_id_issued_at, client_secret_expires_at,
            install_id, cr_uid, created_at, updated_at,
            (EXTRACT(EPOCH FROM (NOW() - updated_at)) * 1000)::float8 AS age_ms`

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
    id: String(row.id),
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
    installId: row.install_id ?? undefined,
    crUid: row.cr_uid ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ageMs: Number(row.age_ms),
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
 * RFC 7592 management handle of a dynamic client: the endpoint and the bearer
 * needed to DELETE it at the AS. Present only when both were persisted.
 */
export interface DynamicClientRegistrationHandle {
  registrationClientUri: string
  registrationAccessToken: string
}

/**
 * How long a `pending` row (install_id set, cr_uid NULL) is treated as an
 * in-flight install before an unfinished saga's row becomes reclaimable. Chosen
 * above the longest possible saga (discovery + probe + DCR + create + attach,
 * each bounded ≤ 15s), so a live install never has its own row reclaimed.
 */
export const PENDING_TTL_MS = 10 * 60_000

/**
 * The three lifetimes an existing `dynamic_clients` row can have at INSERT-conflict
 * or teardown time. `in-use` and `in-progress` belong to someone and must not be
 * touched; `reclaimable` (orphan/legacy) may be taken over.
 */
export type ExistingDynamicClientClass = 'in-use' | 'in-progress' | 'reclaimable'

/**
 * Decide who owns a conflicting `dynamic_clients` row — the one rule for "whose
 * row is this?" (D4). Pure and total; the caller supplies the row's DB-measured
 * age, the pending TTL, and `liveCrUid` (the uid of a live McpServer with this
 * name, when one exists).
 *
 * `liveCrUid` is only meaningful if it was read AFTER the row it is classified
 * with: a CR created and bound between an earlier K8s read and the row read would
 * otherwise make a live install's row look orphaned.
 *
 * A live CR owns the name unconditionally: it covers a bound-live row AND the
 * pre-check→INSERT TOCTOU race where the CR appeared after the pending INSERT.
 * With no live CR, a bound row (cr_uid set) is an orphan of a gone install, a
 * fresh pending row is another saga in flight, an expired pending row is a
 * crashed saga, and a legacy row (both NULL, no live CR) is treated by name as
 * today — all reclaimable except the fresh pending one.
 */
export function classifyExistingDynamicClient(
  row: { installId: string | null; crUid: string | null; ageMs: number },
  ctx: { pendingTtlMs: number; liveCrUid?: string }
): ExistingDynamicClientClass {
  if (ctx.liveCrUid !== undefined) return 'in-use'
  if (row.crUid != null) return 'reclaimable'
  if (row.installId != null) {
    // In-progress iff age is strictly under the TTL; at exactly the TTL the row is
    // expired and reclaimable.
    return row.ageMs < ctx.pendingTtlMs ? 'in-progress' : 'reclaimable'
  }
  return 'reclaimable'
}

/**
 * Claim the name for a new install by inserting a PENDING row (install_id set,
 * cr_uid NULL) with `ON CONFLICT (owner_kind, server_namespace, server_name) DO
 * NOTHING`. Never overwrites an existing row — that is the whole point over
 * `upsertDynamicClient`: a live server's credentials are never clobbered. Returns
 * `{ inserted: false }` on conflict so the caller can classify the existing row.
 */
export async function insertDynamicClientPending(
  db: DbClient,
  encryptionKey: Buffer,
  input: UpsertDynamicClientInput & { installId: string }
): Promise<{ inserted: boolean }> {
  const ownerKind = resolveOwnerKind(input)
  const creds = encodeCredentialColumns(encryptionKey, input)

  const result = await db.query(
    `INSERT INTO dynamic_clients (
       owner_kind, server_namespace, server_name, issuer, client_id, client_mode,
       client_secret_encrypted, registration_access_token_encrypted,
       registration_client_uri, client_id_issued_at, client_secret_expires_at,
       install_id, cr_uid, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL, NOW())
     ON CONFLICT (owner_kind, server_namespace, server_name) DO NOTHING
     RETURNING id`,
    [
      ownerKind,
      input.serverNamespace,
      input.serverName,
      input.issuer,
      input.clientId,
      input.clientMode,
      creds.clientSecretEncrypted,
      creds.registrationAccessTokenEncrypted,
      creds.registrationClientUri,
      creds.clientIdIssuedAt,
      creds.clientSecretExpiresAt,
      input.installId,
    ]
  )
  return { inserted: (result.rowCount ?? 0) > 0 }
}

/**
 * The identity of a `dynamic_clients` row as the caller read and classified it.
 * A reclaim only applies to the row in exactly this state.
 */
export type ObservedDynamicClient = Pick<DynamicClientRow, 'id' | 'installId' | 'crUid'>

/**
 * Take over a row the caller classified `reclaimable` (orphan or legacy) for a
 * new install, atomically. Does NOT classify: the caller did, from `observed` and
 * a live-CR read taken after it. This applies the takeover only if the row still
 * has the observed `id`, `install_id` AND `cr_uid` — one guard, evaluated on the
 * row-locked latest version, so:
 * - a concurrent reclaim that won first changed `install_id` → we lose;
 * - the owner binding its pending row (`cr_uid` NULL → uid) after our read →
 *   we lose, and a live install's client is never overwritten or revoked;
 * - the row deleted (teardown) → 0 rows → we lose (conservative; the operator's
 *   retry goes through the INSERT).
 * Re-classifying under the lock is deliberately absent: it would re-decide with a
 * K8s read that predates the locked version, which is exactly the stale-uid bug.
 *
 * The guard does not compare `updated_at`: every production writer that moves it
 * also changes `id` (INSERT), `install_id` (reclaim) or `cr_uid` (bind), so the
 * observed age can only have grown and an expired pending row stays expired.
 * `upsertDynamicClient` refreshes `updated_at` with identity intact and would break
 * that premise; it has no production caller and must not gain one on this table.
 *
 * Returns the OLD row's RFC 7592 handle (decrypted, when present) so the caller
 * can best-effort revoke the superseded client at the AS.
 *
 * The reclaim is a single statement, so the transaction adds no atomicity; the
 * runner is kept only as the injection point.
 *
 * `runInTransaction` is a REQUIRED injected runner (pass `withTransaction` from
 * db.ts) rather than a default import — this module sits on the config init path
 * (config → tokenHelper → callback → here), so importing db.ts's `withTransaction`
 * value at module top-level would close an init cycle back to `config` and leave
 * it undefined. The injection also lets tests bind the runner to a disposable pool.
 */
export async function reclaimOrphanDynamicClient(
  encryptionKey: Buffer,
  input: {
    key: DynamicClientKey
    newCredentials: UpsertDynamicClientInput
    newInstallId: string
    observed: ObservedDynamicClient
  },
  runInTransaction: <T>(work: (tx: DbTransactionClient) => Promise<T>) => Promise<T>
): Promise<{ reclaimed: boolean; oldHandle?: DynamicClientRegistrationHandle }> {
  const ownerKind = resolveOwnerKind(input.key)
  const creds = encodeCredentialColumns(encryptionKey, input.newCredentials)

  return runInTransaction(async tx => {
    const updated = await tx.query(
      `WITH prev AS (
         SELECT id, registration_client_uri, registration_access_token_encrypted
           FROM dynamic_clients
          WHERE owner_kind = $1 AND server_namespace = $2 AND server_name = $3
            AND id = $13
            AND install_id IS NOT DISTINCT FROM $14
            AND cr_uid IS NOT DISTINCT FROM $15
          FOR UPDATE
       )
       UPDATE dynamic_clients d
          SET issuer = $4,
              client_id = $5,
              client_mode = $6,
              client_secret_encrypted = $7,
              registration_access_token_encrypted = $8,
              registration_client_uri = $9,
              client_id_issued_at = $10,
              client_secret_expires_at = $11,
              install_id = $12,
              cr_uid = NULL,
              updated_at = NOW()
         FROM prev
        WHERE d.id = prev.id
       RETURNING prev.registration_client_uri, prev.registration_access_token_encrypted`,
      [
        ownerKind,
        input.key.serverNamespace,
        input.key.serverName,
        input.newCredentials.issuer,
        input.newCredentials.clientId,
        input.newCredentials.clientMode,
        creds.clientSecretEncrypted,
        creds.registrationAccessTokenEncrypted,
        creds.registrationClientUri,
        creds.clientIdIssuedAt,
        creds.clientSecretExpiresAt,
        input.newInstallId,
        input.observed.id,
        input.observed.installId ?? null,
        input.observed.crUid ?? null,
      ]
    )
    if ((updated.rowCount ?? 0) !== 1) return { reclaimed: false }
    const prev = updated.rows[0] as {
      registration_client_uri: string | null
      registration_access_token_encrypted: string | null
    }

    const oldHandle =
      prev.registration_client_uri && prev.registration_access_token_encrypted
        ? {
            registrationClientUri: prev.registration_client_uri,
            registrationAccessToken: decryptOAuthSecret(
              encryptionKey,
              prev.registration_access_token_encrypted
            ),
          }
        : undefined
    return { reclaimed: true, oldHandle }
  })
}

/**
 * Bind a pending row to the McpServer that was just created: set its `cr_uid`,
 * guarded on `install_id = $installId AND cr_uid IS NULL` so it only ever binds
 * OUR pending row. `{ bound: false }` means the row was reclaimed out from under
 * this saga (TTL expired mid-install) — the caller must not proceed as owner.
 */
export async function bindDynamicClientToResource(
  db: DbClient,
  key: DynamicClientKey,
  installId: string,
  crUid: string
): Promise<{ bound: boolean }> {
  const ownerKind = resolveOwnerKind(key)
  const result = await db.query(
    `UPDATE dynamic_clients
        SET cr_uid = $5, updated_at = NOW()
      WHERE owner_kind = $1 AND server_namespace = $2 AND server_name = $3
        AND install_id = $4 AND cr_uid IS NULL`,
    [ownerKind, key.serverNamespace, key.serverName, installId, crUid]
  )
  return { bound: (result.rowCount ?? 0) === 1 }
}

/**
 * Compensation delete for a saga: removes ONLY the row this install owns
 * (`install_id = $installId`), so a concurrent install/reinstall of the same name
 * that already reclaimed the row is never destroyed. Returns rows removed.
 */
export async function deleteDynamicClientOwnedByInstall(
  db: DbClient,
  key: DynamicClientKey,
  installId: string
): Promise<number> {
  const ownerKind = resolveOwnerKind(key)
  const result = await db.query(
    `DELETE FROM dynamic_clients
      WHERE owner_kind = $1 AND server_namespace = $2 AND server_name = $3
        AND install_id = $4`,
    [ownerKind, key.serverNamespace, key.serverName, installId]
  )
  return result.rowCount ?? 0
}

/**
 * Teardown delete for an uninstall of CR uid `crUid`: removes the row bound to
 * THIS uid, or a legacy row (both columns NULL, from before install identity),
 * and returns its RFC 7592 handle in the SAME statement (`DELETE … RETURNING`) so
 * there is no read→await→delete window in which a concurrent reinstall could slip
 * a new row in. A pending row (reinstall in flight) or a row bound to a DIFFERENT
 * uid (reinstall already complete) does not match and is left intact.
 */
export async function claimDeleteDynamicClientForResource(
  db: DbClient,
  encryptionKey: Buffer,
  key: DynamicClientKey,
  crUid: string
): Promise<{ deleted: boolean; handle?: DynamicClientRegistrationHandle }> {
  const ownerKind = resolveOwnerKind(key)
  const result = await db.query(
    `DELETE FROM dynamic_clients
      WHERE owner_kind = $1 AND server_namespace = $2 AND server_name = $3
        AND (cr_uid = $4 OR (install_id IS NULL AND cr_uid IS NULL))
      RETURNING registration_client_uri, registration_access_token_encrypted`,
    [ownerKind, key.serverNamespace, key.serverName, crUid]
  )
  if (result.rows.length === 0) return { deleted: false }
  const row = result.rows[0] as {
    registration_client_uri: string | null
    registration_access_token_encrypted: string | null
  }
  const handle =
    row.registration_client_uri && row.registration_access_token_encrypted
      ? {
          registrationClientUri: row.registration_client_uri,
          registrationAccessToken: decryptOAuthSecret(
            encryptionKey,
            row.registration_access_token_encrypted
          ),
        }
      : undefined
  return { deleted: true, handle }
}
