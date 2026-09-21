import type { DbClient } from '../db.js'
import { decryptOAuthSecret, encryptOAuthSecret } from './encryption.js'

/**
 * Owner domain of a grant. `recipe_namespace`/`recipe_name` are reinterpreted
 * as the owner's coordinates:
 * - `recipe` (default) — the historical WorkflowRecipe owner (recipe ns/name).
 * - `mcpserver` — a McpServer owner (server ns/name); OAuth mcp-servers (U1).
 *
 * The column is called `owner_kind` and defaults to `'recipe'` so every row
 * that predates the generalization keeps its meaning. Callers that omit
 * `ownerKind` read/write the `'recipe'` domain — the recipe flows are unchanged.
 */
export type OAuthOwnerKind = 'recipe' | 'mcpserver'

/**
 * Identifies one `oauth_grants` row.
 *
 * - `user` grant — owned by a specific end-user. Keyed by
 *   `(ownerKind, recipeNamespace, recipeName, userId, oauthClientId)` and
 *   governed by the `oauth_grants_unique` constraint. This is per-user identity:
 *   the recipe embed Connect flow, and OAuth mcp-servers with
 *   `grantScope='user'`.
 * - `service` grant — owned by the recipe itself (the admin "connect for the
 *   recipe" flow, Path B). `user_id` is NULL; keyed by
 *   `(recipeNamespace, recipeName, oauthClientId)` and governed by the
 *   `oauth_grants_service_unique` partial index.
 * - `shared` grant — one shared identity per `(server, context)` for an OAuth
 *   mcp-server with `grantScope='context'` (U1 data model; exercised by U6).
 *   `user_id` is NULL; `context_id` is the coordinate that replaces `user_id`
 *   in the key. Keyed by `(ownerKind, recipeNamespace, recipeName, contextId,
 *   oauthClientId)` and governed by the `oauth_grants_shared_unique` partial
 *   index. `bootstrapped_by_user_id` records who first authorized the shared
 *   identity — audit only, OUTSIDE the key and never touched on refresh.
 *
 * `grantKind` is required on every call so each site declares intent — there
 * is no implicit default.
 */
export type OAuthGrantKey =
  | {
      grantKind: 'user'
      /** Owner domain; omit for the historical recipe domain (defaults to `'recipe'`). */
      ownerKind?: OAuthOwnerKind
      recipeNamespace: string
      recipeName: string
      userId: string
      oauthClientId: string
    }
  | {
      grantKind: 'service'
      /** Owner domain; omit for the historical recipe domain (defaults to `'recipe'`). */
      ownerKind?: OAuthOwnerKind
      recipeNamespace: string
      recipeName: string
      oauthClientId: string
    }
  | {
      grantKind: 'shared'
      /** Shared grants always belong to an mcp-server owner. */
      ownerKind: 'mcpserver'
      recipeNamespace: string
      recipeName: string
      contextId: string
      oauthClientId: string
    }

/** Resolve the owner domain of a key, defaulting to the recipe domain. */
export function resolveOwnerKind(input: { ownerKind?: OAuthOwnerKind }): OAuthOwnerKind {
  return input.ownerKind ?? 'recipe'
}

/**
 * One row of `oauth_grants`. New grants of the same key replace the old.
 */
export interface OAuthGrantRow {
  grantKind: 'user' | 'service' | 'shared'
  ownerKind: OAuthOwnerKind
  recipeNamespace: string
  recipeName: string
  /** Present only for `user` grants; NULL/absent for `service`/`shared` grants. */
  userId?: string
  /** Present only for `shared` grants; the Context the shared identity belongs to. */
  contextId?: string
  /** Present only for `shared` grants; who first authorized the shared identity (audit). */
  bootstrappedByUserId?: string
  oauthClientId: string
  /** Provider-side identifier (salesforce, slack, ...) — denormalised for audit. */
  provider: string
  /** Plaintext access token; never persisted in the clear. */
  accessToken: string
  /** Plaintext refresh token, if the provider issued one. */
  refreshToken?: string
  /** When the access token expires (provider-supplied; null if not provided). */
  accessTokenExpiresAt?: Date
  /** When the row was last refreshed. */
  updatedAt: Date
  /** True when the user consented to a background workload using this grant. */
  background: boolean
}

export type UpsertOAuthGrantInput = OAuthGrantKey & {
  provider: string
  accessToken: string
  refreshToken?: string
  /** Seconds until access token expires; null if provider didn't supply expires_in. */
  accessTokenExpiresInSec?: number
}

/**
 * Insert (or replace) an oauth_grants row for the ALTA/CONSENT path only —
 * `user` and `service` grants, encrypting access + refresh tokens at rest with
 * the supplied AES-256-GCM key. This is an `INSERT … ON CONFLICT DO UPDATE`, so
 * it MAY create the row. Token refresh must NOT go through here (it would
 * resurrect a concurrently-deleted grant, R1-B1) — use
 * {@link refreshOAuthGrantTokens}. Shared grants are bootstrapped via
 * {@link bootstrapSharedOAuthGrant} and never inserted here.
 */
export async function upsertOAuthGrant(
  db: DbClient,
  encryptionKey: Buffer,
  input: UpsertOAuthGrantInput
): Promise<void> {
  const accessTokenEncrypted = encryptOAuthSecret(encryptionKey, input.accessToken)
  const refreshTokenEncrypted = input.refreshToken
    ? encryptOAuthSecret(encryptionKey, input.refreshToken)
    : null
  const accessTokenExpiresAt =
    typeof input.accessTokenExpiresInSec === 'number'
      ? new Date(Date.now() + input.accessTokenExpiresInSec * 1000)
      : null

  const ownerKind = resolveOwnerKind(input)

  if (input.grantKind === 'user') {
    await db.query(
      `INSERT INTO oauth_grants (
         owner_kind, recipe_namespace, recipe_name, user_id, oauth_client_id, grant_kind,
         provider, access_token_encrypted, refresh_token_encrypted,
         access_token_expires_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'user', $6, $7, $8, $9, NOW())
       ON CONFLICT (owner_kind, recipe_namespace, recipe_name, user_id, oauth_client_id)
       DO UPDATE SET
         provider = EXCLUDED.provider,
         access_token_encrypted = EXCLUDED.access_token_encrypted,
         refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
         access_token_expires_at = EXCLUDED.access_token_expires_at,
         updated_at = NOW()`,
      [
        ownerKind,
        input.recipeNamespace,
        input.recipeName,
        input.userId,
        input.oauthClientId,
        input.provider,
        accessTokenEncrypted,
        refreshTokenEncrypted,
        accessTokenExpiresAt,
      ]
    )
    return
  }

  if (input.grantKind === 'shared') {
    // A shared grant is NEVER inserted through this path: first consent goes
    // through `bootstrapSharedOAuthGrant` (first-wins tokens AND bootstrapper),
    // and token refresh goes through `refreshOAuthGrantTokens` (UPDATE by key).
    // Reaching here means a caller mis-routed a shared grant into the
    // consent/insert path — fail loudly rather than mint one against the
    // service INSERT below.
    throw new Error('upsertOAuthGrant does not handle shared grants')
  }

  await db.query(
    `INSERT INTO oauth_grants (
       owner_kind, recipe_namespace, recipe_name, user_id, oauth_client_id, grant_kind,
       provider, access_token_encrypted, refresh_token_encrypted,
       access_token_expires_at, updated_at
     ) VALUES ($1, $2, $3, NULL, $4, 'service', $5, $6, $7, $8, NOW())
     ON CONFLICT (recipe_namespace, recipe_name, oauth_client_id) WHERE grant_kind = 'service'
     DO UPDATE SET
       provider = EXCLUDED.provider,
       access_token_encrypted = EXCLUDED.access_token_encrypted,
       refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
       access_token_expires_at = EXCLUDED.access_token_expires_at,
       updated_at = NOW()`,
    [
      ownerKind,
      input.recipeNamespace,
      input.recipeName,
      input.oauthClientId,
      input.provider,
      accessTokenEncrypted,
      refreshTokenEncrypted,
      accessTokenExpiresAt,
    ]
  )
}

export type RefreshOAuthGrantTokensInput = OAuthGrantKey & {
  provider: string
  accessToken: string
  refreshToken?: string
  /** Seconds until access token expires; null if provider didn't supply expires_in. */
  accessTokenExpiresInSec?: number
}

/**
 * Persist refreshed tokens onto an EXISTING grant row — an UPDATE keyed by the
 * grant's own coordinates, for every flavor (`user`/`service`/`shared`) — and
 * report whether a row was actually touched.
 *
 * Distinct from {@link upsertOAuthGrant} on purpose (R1-B1). The consent/alta
 * path inserts, but refresh must NEVER resurrect a row that was concurrently
 * deleted: a disconnect (DELETE) can land between the token read
 * (`getOAuthGrant`) and this write. An `INSERT … ON CONFLICT` would recreate the
 * deleted grant with fresh tokens; an UPDATE by key touches 0 rows once the row
 * is gone, and the caller surfaces that as "needs reauth" rather than silently
 * re-granting.
 *
 * The `shared` branch is the former `upsertOAuthGrant` "Refresh path ONLY"
 * UPDATE, folded here (D4) so the refresh UPDATE lives in exactly one place: a
 * plain UPDATE by key that never rewrites the team identity or the
 * `bootstrapped_by_user_id` audit column (mini-spec 05 §3).
 *
 * Returns `{ updated }` — `false` when no row matched (the grant was deleted in
 * the refresh window).
 */
export async function refreshOAuthGrantTokens(
  db: DbClient,
  encryptionKey: Buffer,
  input: RefreshOAuthGrantTokensInput
): Promise<{ updated: boolean }> {
  const accessTokenEncrypted = encryptOAuthSecret(encryptionKey, input.accessToken)
  const refreshTokenEncrypted = input.refreshToken
    ? encryptOAuthSecret(encryptionKey, input.refreshToken)
    : null
  const accessTokenExpiresAt =
    typeof input.accessTokenExpiresInSec === 'number'
      ? new Date(Date.now() + input.accessTokenExpiresInSec * 1000)
      : null

  const ownerKind = resolveOwnerKind(input)

  if (input.grantKind === 'user') {
    const result = await db.query(
      `UPDATE oauth_grants
          SET provider = $6,
              access_token_encrypted = $7,
              refresh_token_encrypted = $8,
              access_token_expires_at = $9,
              updated_at = NOW()
        WHERE owner_kind = $1 AND recipe_namespace = $2 AND recipe_name = $3
          AND user_id = $4 AND oauth_client_id = $5 AND grant_kind = 'user'
        RETURNING id`,
      [
        ownerKind,
        input.recipeNamespace,
        input.recipeName,
        input.userId,
        input.oauthClientId,
        input.provider,
        accessTokenEncrypted,
        refreshTokenEncrypted,
        accessTokenExpiresAt,
      ]
    )
    return { updated: (result.rowCount ?? 0) > 0 }
  }

  if (input.grantKind === 'shared') {
    const result = await db.query(
      `UPDATE oauth_grants
          SET provider = $6,
              access_token_encrypted = $7,
              refresh_token_encrypted = $8,
              access_token_expires_at = $9,
              updated_at = NOW()
        WHERE owner_kind = $1 AND recipe_namespace = $2 AND recipe_name = $3
          AND context_id = $4 AND oauth_client_id = $5 AND grant_kind = 'shared'
        RETURNING id`,
      [
        ownerKind,
        input.recipeNamespace,
        input.recipeName,
        input.contextId,
        input.oauthClientId,
        input.provider,
        accessTokenEncrypted,
        refreshTokenEncrypted,
        accessTokenExpiresAt,
      ]
    )
    return { updated: (result.rowCount ?? 0) > 0 }
  }

  const result = await db.query(
    `UPDATE oauth_grants
        SET provider = $5,
            access_token_encrypted = $6,
            refresh_token_encrypted = $7,
            access_token_expires_at = $8,
            updated_at = NOW()
      WHERE owner_kind = $1 AND recipe_namespace = $2 AND recipe_name = $3
        AND user_id IS NULL AND oauth_client_id = $4 AND grant_kind = 'service'
      RETURNING id`,
    [
      ownerKind,
      input.recipeNamespace,
      input.recipeName,
      input.oauthClientId,
      input.provider,
      accessTokenEncrypted,
      refreshTokenEncrypted,
      accessTokenExpiresAt,
    ]
  )
  return { updated: (result.rowCount ?? 0) > 0 }
}

/**
 * Bootstrap a `shared` (context-identity) grant: the FIRST member to authorize
 * an OAuth mcp-server with `grantScope='context'` lends their provider identity
 * to the whole Context.
 *
 * INSERT … ON CONFLICT DO NOTHING — first-wins tokens AND bootstrapper. If a
 * concurrent second member also completes consent (both minted an authorize URL
 * inside the state TTL), their row is a no-op: they inherit the team's grant,
 * and `bootstrapped_by_user_id` keeps pointing at whoever landed first
 * (mini-spec 05 §3). Distinct from the refresh path (`upsertOAuthGrant` above)
 * on purpose: conflating them would let the last completer silently overwrite
 * the team identity and the audit trail.
 *
 * Returns `{ inserted }` so the caller can tell "you bootstrapped the team" from
 * "you joined an existing team identity".
 */
export type BootstrapSharedOAuthGrantInput = {
  ownerKind: 'mcpserver'
  recipeNamespace: string
  recipeName: string
  contextId: string
  oauthClientId: string
  /** Who authorized the shared identity (audit; from signed state claims, never a body param). */
  bootstrappedByUserId: string
  provider: string
  accessToken: string
  refreshToken?: string
  accessTokenExpiresInSec?: number
}

export async function bootstrapSharedOAuthGrant(
  db: DbClient,
  encryptionKey: Buffer,
  input: BootstrapSharedOAuthGrantInput
): Promise<{ inserted: boolean }> {
  const accessTokenEncrypted = encryptOAuthSecret(encryptionKey, input.accessToken)
  const refreshTokenEncrypted = input.refreshToken
    ? encryptOAuthSecret(encryptionKey, input.refreshToken)
    : null
  const accessTokenExpiresAt =
    typeof input.accessTokenExpiresInSec === 'number'
      ? new Date(Date.now() + input.accessTokenExpiresInSec * 1000)
      : null

  const result = await db.query(
    `INSERT INTO oauth_grants (
       owner_kind, recipe_namespace, recipe_name, user_id, context_id,
       oauth_client_id, grant_kind, bootstrapped_by_user_id,
       provider, access_token_encrypted, refresh_token_encrypted,
       access_token_expires_at, updated_at
     ) VALUES ($1, $2, $3, NULL, $4, $5, 'shared', $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (owner_kind, recipe_namespace, recipe_name, context_id, oauth_client_id)
       WHERE grant_kind = 'shared'
     DO NOTHING
     RETURNING id`,
    [
      input.ownerKind,
      input.recipeNamespace,
      input.recipeName,
      input.contextId,
      input.oauthClientId,
      input.bootstrappedByUserId,
      input.provider,
      accessTokenEncrypted,
      refreshTokenEncrypted,
      accessTokenExpiresAt,
    ]
  )
  return { inserted: (result.rowCount ?? 0) > 0 }
}

export type GetOAuthGrantInput = OAuthGrantKey & {
  /** User grants only: require background=true (per-user broker, SEC-5). Ignored for service. */
  requireBackground?: boolean
}

const SELECT_COLUMNS = `owner_kind, recipe_namespace, recipe_name, user_id, context_id,
            bootstrapped_by_user_id, oauth_client_id, grant_kind,
            provider, access_token_encrypted, refresh_token_encrypted,
            access_token_expires_at, updated_at, background`

interface OAuthGrantDbRow {
  owner_kind: OAuthOwnerKind
  recipe_namespace: string
  recipe_name: string
  user_id: string | null
  context_id: string | null
  bootstrapped_by_user_id: string | null
  oauth_client_id: string
  grant_kind: 'user' | 'service' | 'shared'
  provider: string
  access_token_encrypted: string
  refresh_token_encrypted: string | null
  access_token_expires_at: Date | null
  updated_at: Date
  background: boolean
}

/**
 * Read one grant row, decrypting tokens. Returns null when no row exists.
 */
export async function getOAuthGrant(
  db: DbClient,
  encryptionKey: Buffer,
  input: GetOAuthGrantInput
): Promise<OAuthGrantRow | null> {
  const ownerKind = resolveOwnerKind(input)
  const result =
    input.grantKind === 'user'
      ? await db.query(
          `SELECT ${SELECT_COLUMNS}
           FROM oauth_grants
           WHERE owner_kind = $1 AND recipe_namespace = $2 AND recipe_name = $3
             AND user_id = $4 AND oauth_client_id = $5 AND grant_kind = 'user'${
               input.requireBackground ? ' AND background = true' : ''
             }`,
          [ownerKind, input.recipeNamespace, input.recipeName, input.userId, input.oauthClientId]
        )
      : input.grantKind === 'shared'
        ? await db.query(
            `SELECT ${SELECT_COLUMNS}
             FROM oauth_grants
             WHERE owner_kind = $1 AND recipe_namespace = $2 AND recipe_name = $3
               AND user_id IS NULL AND context_id = $4 AND oauth_client_id = $5
               AND grant_kind = 'shared'${input.requireBackground ? ' AND background = true' : ''}`,
            [
              ownerKind,
              input.recipeNamespace,
              input.recipeName,
              input.contextId,
              input.oauthClientId,
            ]
          )
        : await db.query(
            `SELECT ${SELECT_COLUMNS}
             FROM oauth_grants
             WHERE owner_kind = $1 AND recipe_namespace = $2 AND recipe_name = $3
               AND user_id IS NULL AND oauth_client_id = $4 AND grant_kind = 'service'`,
            [ownerKind, input.recipeNamespace, input.recipeName, input.oauthClientId]
          )
  if (result.rows.length === 0) return null
  const row = result.rows[0] as OAuthGrantDbRow
  return {
    grantKind: row.grant_kind,
    ownerKind: row.owner_kind,
    recipeNamespace: row.recipe_namespace,
    recipeName: row.recipe_name,
    userId: row.user_id ?? undefined,
    contextId: row.context_id ?? undefined,
    bootstrappedByUserId: row.bootstrapped_by_user_id ?? undefined,
    oauthClientId: row.oauth_client_id,
    provider: row.provider,
    accessToken: decryptOAuthSecret(encryptionKey, row.access_token_encrypted),
    refreshToken: row.refresh_token_encrypted
      ? decryptOAuthSecret(encryptionKey, row.refresh_token_encrypted)
      : undefined,
    accessTokenExpiresAt: row.access_token_expires_at ?? undefined,
    updatedAt: row.updated_at,
    background: row.background,
  }
}

/**
 * Existence check without decrypting tokens — for status endpoints that only
 * need to know whether a grant is connected.
 */
export async function oauthGrantExists(db: DbClient, input: GetOAuthGrantInput): Promise<boolean> {
  const ownerKind = resolveOwnerKind(input)
  const result =
    input.grantKind === 'user'
      ? await db.query(
          `SELECT 1 FROM oauth_grants
           WHERE owner_kind = $1 AND recipe_namespace = $2 AND recipe_name = $3
             AND user_id = $4 AND oauth_client_id = $5 AND grant_kind = 'user'${
               input.requireBackground ? ' AND background = true' : ''
             }
           LIMIT 1`,
          [ownerKind, input.recipeNamespace, input.recipeName, input.userId, input.oauthClientId]
        )
      : input.grantKind === 'shared'
        ? await db.query(
            `SELECT 1 FROM oauth_grants
             WHERE owner_kind = $1 AND recipe_namespace = $2 AND recipe_name = $3
               AND user_id IS NULL AND context_id = $4 AND oauth_client_id = $5
               AND grant_kind = 'shared'${input.requireBackground ? ' AND background = true' : ''}
             LIMIT 1`,
            [
              ownerKind,
              input.recipeNamespace,
              input.recipeName,
              input.contextId,
              input.oauthClientId,
            ]
          )
        : await db.query(
            `SELECT 1 FROM oauth_grants
             WHERE owner_kind = $1 AND recipe_namespace = $2 AND recipe_name = $3
               AND user_id IS NULL AND oauth_client_id = $4 AND grant_kind = 'service'
             LIMIT 1`,
            [ownerKind, input.recipeNamespace, input.recipeName, input.oauthClientId]
          )
  return result.rows.length > 0
}

/**
 * Delete a grant row by its flavored key. Returns the number of rows deleted so
 * callers can audit "did this actually revoke something" (0 ⇒ the grant was
 * already gone; the endpoint stays idempotent either way).
 */
export async function deleteOAuthGrant(db: DbClient, input: GetOAuthGrantInput): Promise<number> {
  const ownerKind = resolveOwnerKind(input)
  if (input.grantKind === 'user') {
    const result = await db.query(
      `DELETE FROM oauth_grants
       WHERE owner_kind = $1 AND recipe_namespace = $2 AND recipe_name = $3
         AND user_id = $4 AND oauth_client_id = $5 AND grant_kind = 'user'`,
      [ownerKind, input.recipeNamespace, input.recipeName, input.userId, input.oauthClientId]
    )
    return result.rowCount ?? 0
  }
  if (input.grantKind === 'shared') {
    const result = await db.query(
      `DELETE FROM oauth_grants
       WHERE owner_kind = $1 AND recipe_namespace = $2 AND recipe_name = $3
         AND user_id IS NULL AND context_id = $4 AND oauth_client_id = $5 AND grant_kind = 'shared'`,
      [ownerKind, input.recipeNamespace, input.recipeName, input.contextId, input.oauthClientId]
    )
    return result.rowCount ?? 0
  }
  const result = await db.query(
    `DELETE FROM oauth_grants
     WHERE owner_kind = $1 AND recipe_namespace = $2 AND recipe_name = $3
       AND user_id IS NULL AND oauth_client_id = $4 AND grant_kind = 'service'`,
    [ownerKind, input.recipeNamespace, input.recipeName, input.oauthClientId]
  )
  return result.rowCount ?? 0
}

/**
 * Purge EVERY oauth_grants row owned by one McpServer — server teardown only
 * (called from the CR uninstall). Deletes across all flavors (user/service/shared),
 * all users, all contexts, all client ids for the server coordinate. Returns the
 * row count deleted (0 ⇒ the server had none; idempotent).
 *
 * NOT the per-user revocation path (deleteOAuthGrant): that removes ONE user's grant
 * by full key and must never cascade to other users or to dynamic_clients. This one
 * is the opposite — a full wipe scoped to the server, run only when the server CR is
 * being deleted.
 */
export async function deleteOAuthGrantsForServer(
  db: DbClient,
  coords: { recipeNamespace: string; recipeName: string }
): Promise<number> {
  // `owner_kind = 'mcpserver'` is load-bearing: it must never touch recipe-domain
  // grants that share a name coordinate. No user_id / context_id / oauth_client_id /
  // grant_kind filter — the wipe is intentionally all-flavors.
  const result = await db.query(
    `DELETE FROM oauth_grants
     WHERE owner_kind = 'mcpserver' AND recipe_namespace = $1 AND recipe_name = $2`,
    [coords.recipeNamespace, coords.recipeName]
  )
  return result.rowCount ?? 0
}

/**
 * Set (or clear) the background-consent flag on a user grant. Separate from
 * upsertOAuthGrant so the refresh-on-demand re-upsert never disturbs consent.
 */
export async function setUserGrantBackground(
  db: DbClient,
  key: { recipeNamespace: string; recipeName: string; userId: string; oauthClientId: string },
  background: boolean
): Promise<void> {
  // Recipe-domain user grants only (Profile UI "background consent"). OAuth
  // mcp-server grants live under owner_kind='mcpserver'; their background
  // handling, if any, is future work — keep this scoped so the two never mix.
  await db.query(
    `UPDATE oauth_grants SET background = $5, updated_at = NOW()
     WHERE owner_kind = 'recipe' AND recipe_namespace = $1 AND recipe_name = $2
       AND user_id = $3 AND oauth_client_id = $4 AND grant_kind = 'user'`,
    [key.recipeNamespace, key.recipeName, key.userId, key.oauthClientId, background]
  )
}

export interface UserGrantSummary {
  recipeNamespace: string
  recipeName: string
  oauthClientId: string
  provider: string
  background: boolean
  updatedAt: Date
}

/** All of a user's grants across recipes (for the Profile UI "Connected accounts" list). */
export async function listUserOAuthGrants(
  db: DbClient,
  userId: string
): Promise<UserGrantSummary[]> {
  const result = await db.query(
    `SELECT recipe_namespace, recipe_name, oauth_client_id, provider, background, updated_at
     FROM oauth_grants
     WHERE owner_kind = 'recipe' AND user_id = $1 AND grant_kind = 'user'
     ORDER BY recipe_name, oauth_client_id`,
    [userId]
  )
  return result.rows.map(r => {
    const row = r as {
      recipe_namespace: string
      recipe_name: string
      oauth_client_id: string
      provider: string
      background: boolean
      updated_at: Date
    }
    return {
      recipeNamespace: row.recipe_namespace,
      recipeName: row.recipe_name,
      oauthClientId: row.oauth_client_id,
      provider: row.provider,
      background: row.background,
      updatedAt: row.updated_at,
    }
  })
}

/** All user grants for one (recipe, client) — admin oversight (read-only). */
export async function listUserGrantsForClient(
  db: DbClient,
  key: { recipeNamespace: string; recipeName: string; oauthClientId: string }
): Promise<{ userId: string; background: boolean; updatedAt: Date }[]> {
  const result = await db.query(
    `SELECT user_id, background, updated_at
     FROM oauth_grants
     WHERE owner_kind = 'recipe' AND recipe_namespace = $1 AND recipe_name = $2
       AND oauth_client_id = $3 AND grant_kind = 'user'
     ORDER BY user_id`,
    [key.recipeNamespace, key.recipeName, key.oauthClientId]
  )
  return result.rows.map(r => {
    const row = r as { user_id: string; background: boolean; updated_at: Date }
    return { userId: row.user_id, background: row.background, updatedAt: row.updated_at }
  })
}

/**
 * List the userIds with a background-consented user grant for (recipe, client).
 * SEC-6: scoped to one recipe + client; returns opaque platform user ids only.
 */
export async function listBackgroundUserGrants(
  db: DbClient,
  key: { recipeNamespace: string; recipeName: string; oauthClientId: string }
): Promise<string[]> {
  const result = await db.query(
    `SELECT user_id FROM oauth_grants
     WHERE owner_kind = 'recipe' AND recipe_namespace = $1 AND recipe_name = $2
       AND oauth_client_id = $3 AND grant_kind = 'user' AND background = true
     ORDER BY user_id`,
    [key.recipeNamespace, key.recipeName, key.oauthClientId]
  )
  return result.rows.map(r => (r as { user_id: string }).user_id)
}

/**
 * Buffers (milliseconds) that define the proactive window on the token's life:
 * a grant is a proactive-refresh candidate while
 * `now + reactiveBufferMs < access_token_expires_at ≤ now + proactiveBufferMs`.
 * `proactiveBufferMs` = Bp, `reactiveBufferMs` = Br (Bp > Br, config invariant).
 */
export interface ProactiveWindow {
  proactiveBufferMs: number
  reactiveBufferMs: number
}

interface RemoteGrantWindowDbRow {
  owner_kind: OAuthOwnerKind
  recipe_namespace: string
  recipe_name: string
  user_id: string | null
  context_id: string | null
  oauth_client_id: string
  grant_kind: 'user' | 'service' | 'shared'
}

/**
 * Reconstruct the flavored {@link OAuthGrantKey} for an mcpserver-owned remote
 * grant enumerated by {@link listRemoteGrantsInProactiveWindow}. The enumeration
 * filter admits only `shared` and background `user` grants, so those are the only
 * two flavors handled; a `service`/unexpected row throws (fail loud, never mint a
 * malformed key).
 */
function remoteGrantKeyFromRow(row: RemoteGrantWindowDbRow): OAuthGrantKey {
  if (row.grant_kind === 'user') {
    if (!row.user_id) throw new Error('remote user grant row missing user_id')
    return {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: row.recipe_namespace,
      recipeName: row.recipe_name,
      userId: row.user_id,
      oauthClientId: row.oauth_client_id,
    }
  }
  if (row.grant_kind === 'shared') {
    if (!row.context_id) throw new Error('remote shared grant row missing context_id')
    return {
      grantKind: 'shared',
      ownerKind: 'mcpserver',
      recipeNamespace: row.recipe_namespace,
      recipeName: row.recipe_name,
      contextId: row.context_id,
      oauthClientId: row.oauth_client_id,
    }
  }
  throw new Error(`unexpected grant_kind for remote proactive candidate: ${row.grant_kind}`)
}

/**
 * Enumerate the mcpserver-owned REMOTE grants whose access token sits inside the
 * proactive window (mini-spec L §6.3). A snapshot SELECT with NO lock — the cron
 * re-claims each row under `FOR UPDATE SKIP LOCKED` in its own short transaction
 * ({@link claimRemoteGrantForRefresh}) so no pool connection is pinned across the
 * refresh POSTs.
 *
 * Filter (§4 eligibility + window): `provider='remote'`, non-null expiry in
 * `(now+Br, now+Bp]`, and `grant_kind='shared' OR (grant_kind='user' AND
 * background=true)` (SEC-5: unattended use only — non-background user grants are
 * excluded here as a first line of defense, `requireBackground:true` being the
 * second). Returns the flavored keys; tokens are never read.
 */
export async function listRemoteGrantsInProactiveWindow(
  db: DbClient,
  window: ProactiveWindow
): Promise<OAuthGrantKey[]> {
  const result = await db.query(
    `SELECT owner_kind, recipe_namespace, recipe_name, user_id, context_id,
            oauth_client_id, grant_kind
       FROM oauth_grants
      WHERE owner_kind = 'mcpserver'
        AND provider = 'remote'
        AND access_token_expires_at IS NOT NULL
        AND access_token_expires_at > NOW() + ($1::bigint * INTERVAL '1 millisecond')
        AND access_token_expires_at <= NOW() + ($2::bigint * INTERVAL '1 millisecond')
        AND (grant_kind = 'shared' OR (grant_kind = 'user' AND background = true))
      ORDER BY recipe_namespace, recipe_name, oauth_client_id, grant_kind,
               user_id NULLS FIRST, context_id NULLS FIRST`,
    [window.reactiveBufferMs, window.proactiveBufferMs]
  )
  return result.rows.map(r => remoteGrantKeyFromRow(r as RemoteGrantWindowDbRow))
}

/**
 * Claim one enumerated grant for proactive refresh inside an open transaction
 * (mini-spec L §6.3). Runs `SELECT 1 … FOR UPDATE SKIP LOCKED` keyed by the exact
 * grant coordinate AND re-checks the proactive window, so a row another replica
 * already holds, or one the reactive path renewed out of the window since the
 * snapshot, is skipped (returns `false`). On `true` the caller holds the row lock
 * for the rest of the transaction and MUST run the refresh UPDATE on the SAME
 * `txClient` so it lands under this lock.
 *
 * `txClient` MUST be a client inside an open transaction (BEGIN issued); the lock
 * only survives until COMMIT/ROLLBACK.
 */
export async function claimRemoteGrantForRefresh(
  txClient: DbClient,
  key: OAuthGrantKey,
  window: ProactiveWindow
): Promise<boolean> {
  const ownerKind = resolveOwnerKind(key)
  // The window buffers are the FIRST two params ($1 = reactive, $2 = proactive)
  // of every branch so the window predicate is byte-identical across flavors and
  // needs no string surgery. The flavor's key params follow from $3.
  const windowPredicate = `access_token_expires_at IS NOT NULL
        AND access_token_expires_at > NOW() + ($1::bigint * INTERVAL '1 millisecond')
        AND access_token_expires_at <= NOW() + ($2::bigint * INTERVAL '1 millisecond')`
  const windowParams = [window.reactiveBufferMs, window.proactiveBufferMs]

  if (key.grantKind === 'user') {
    const result = await txClient.query(
      `SELECT 1 FROM oauth_grants
        WHERE ${windowPredicate}
          AND owner_kind = $3 AND recipe_namespace = $4 AND recipe_name = $5
          AND user_id = $6 AND oauth_client_id = $7 AND grant_kind = 'user'
        FOR UPDATE SKIP LOCKED`,
      [
        ...windowParams,
        ownerKind,
        key.recipeNamespace,
        key.recipeName,
        key.userId,
        key.oauthClientId,
      ]
    )
    return (result.rowCount ?? 0) > 0
  }

  if (key.grantKind === 'shared') {
    const result = await txClient.query(
      `SELECT 1 FROM oauth_grants
        WHERE ${windowPredicate}
          AND owner_kind = $3 AND recipe_namespace = $4 AND recipe_name = $5
          AND user_id IS NULL AND context_id = $6 AND oauth_client_id = $7
          AND grant_kind = 'shared'
        FOR UPDATE SKIP LOCKED`,
      [
        ...windowParams,
        ownerKind,
        key.recipeNamespace,
        key.recipeName,
        key.contextId,
        key.oauthClientId,
      ]
    )
    return (result.rowCount ?? 0) > 0
  }

  const result = await txClient.query(
    `SELECT 1 FROM oauth_grants
      WHERE ${windowPredicate}
        AND owner_kind = $3 AND recipe_namespace = $4 AND recipe_name = $5
        AND user_id IS NULL AND oauth_client_id = $6 AND grant_kind = 'service'
      FOR UPDATE SKIP LOCKED`,
    [...windowParams, ownerKind, key.recipeNamespace, key.recipeName, key.oauthClientId]
  )
  return (result.rowCount ?? 0) > 0
}
