import type { DbClient } from '../db.js'
import { decryptOAuthSecret, encryptOAuthSecret } from './encryption.js'

/**
 * Identifies one `oauth_grants` row.
 *
 * - `user` grant — owned by a specific end-user (the embed Connect flow).
 *   Keyed by `(recipeNamespace, recipeName, userId, oauthClientId)` and
 *   governed by the `oauth_grants_unique` constraint.
 * - `service` grant — owned by the recipe itself (the admin "connect for the
 *   recipe" flow, Path B). `user_id` is NULL; keyed by
 *   `(recipeNamespace, recipeName, oauthClientId)` and governed by the
 *   `oauth_grants_service_unique` partial index.
 *
 * `grantKind` is required on every call so each site declares intent — there
 * is no implicit default.
 */
export type OAuthGrantKey =
  | {
      grantKind: 'user'
      recipeNamespace: string
      recipeName: string
      userId: string
      oauthClientId: string
    }
  | {
      grantKind: 'service'
      recipeNamespace: string
      recipeName: string
      oauthClientId: string
    }

/**
 * One row of `oauth_grants`. New grants of the same key replace the old.
 */
export interface OAuthGrantRow {
  grantKind: 'user' | 'service'
  recipeNamespace: string
  recipeName: string
  /** Present only for `user` grants; NULL/absent for `service` grants. */
  userId?: string
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
 * Insert or update an oauth_grants row, encrypting access + refresh tokens
 * at rest with the supplied AES-256-GCM key.
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

  if (input.grantKind === 'user') {
    await db.query(
      `INSERT INTO oauth_grants (
         recipe_namespace, recipe_name, user_id, oauth_client_id, grant_kind,
         provider, access_token_encrypted, refresh_token_encrypted,
         access_token_expires_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'user', $5, $6, $7, $8, NOW())
       ON CONFLICT (recipe_namespace, recipe_name, user_id, oauth_client_id)
       DO UPDATE SET
         provider = EXCLUDED.provider,
         access_token_encrypted = EXCLUDED.access_token_encrypted,
         refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
         access_token_expires_at = EXCLUDED.access_token_expires_at,
         updated_at = NOW()`,
      [
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

  await db.query(
    `INSERT INTO oauth_grants (
       recipe_namespace, recipe_name, user_id, oauth_client_id, grant_kind,
       provider, access_token_encrypted, refresh_token_encrypted,
       access_token_expires_at, updated_at
     ) VALUES ($1, $2, NULL, $3, 'service', $4, $5, $6, $7, NOW())
     ON CONFLICT (recipe_namespace, recipe_name, oauth_client_id) WHERE grant_kind = 'service'
     DO UPDATE SET
       provider = EXCLUDED.provider,
       access_token_encrypted = EXCLUDED.access_token_encrypted,
       refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
       access_token_expires_at = EXCLUDED.access_token_expires_at,
       updated_at = NOW()`,
    [
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

export type GetOAuthGrantInput = OAuthGrantKey & {
  /** User grants only: require background=true (per-user broker, SEC-5). Ignored for service. */
  requireBackground?: boolean
}

const SELECT_COLUMNS = `recipe_namespace, recipe_name, user_id, oauth_client_id, grant_kind,
            provider, access_token_encrypted, refresh_token_encrypted,
            access_token_expires_at, updated_at, background`

interface OAuthGrantDbRow {
  recipe_namespace: string
  recipe_name: string
  user_id: string | null
  oauth_client_id: string
  grant_kind: 'user' | 'service'
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
  const result =
    input.grantKind === 'user'
      ? await db.query(
          `SELECT ${SELECT_COLUMNS}
           FROM oauth_grants
           WHERE recipe_namespace = $1 AND recipe_name = $2
             AND user_id = $3 AND oauth_client_id = $4 AND grant_kind = 'user'${
               input.requireBackground ? ' AND background = true' : ''
             }`,
          [input.recipeNamespace, input.recipeName, input.userId, input.oauthClientId]
        )
      : await db.query(
          `SELECT ${SELECT_COLUMNS}
           FROM oauth_grants
           WHERE recipe_namespace = $1 AND recipe_name = $2
             AND user_id IS NULL AND oauth_client_id = $3 AND grant_kind = 'service'`,
          [input.recipeNamespace, input.recipeName, input.oauthClientId]
        )
  if (result.rows.length === 0) return null
  const row = result.rows[0] as OAuthGrantDbRow
  return {
    grantKind: row.grant_kind,
    recipeNamespace: row.recipe_namespace,
    recipeName: row.recipe_name,
    userId: row.user_id ?? undefined,
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
  const result =
    input.grantKind === 'user'
      ? await db.query(
          `SELECT 1 FROM oauth_grants
           WHERE recipe_namespace = $1 AND recipe_name = $2
             AND user_id = $3 AND oauth_client_id = $4 AND grant_kind = 'user'${
               input.requireBackground ? ' AND background = true' : ''
             }
           LIMIT 1`,
          [input.recipeNamespace, input.recipeName, input.userId, input.oauthClientId]
        )
      : await db.query(
          `SELECT 1 FROM oauth_grants
           WHERE recipe_namespace = $1 AND recipe_name = $2
             AND user_id IS NULL AND oauth_client_id = $3 AND grant_kind = 'service'
           LIMIT 1`,
          [input.recipeNamespace, input.recipeName, input.oauthClientId]
        )
  return result.rows.length > 0
}

export async function deleteOAuthGrant(db: DbClient, input: GetOAuthGrantInput): Promise<void> {
  if (input.grantKind === 'user') {
    await db.query(
      `DELETE FROM oauth_grants
       WHERE recipe_namespace = $1 AND recipe_name = $2
         AND user_id = $3 AND oauth_client_id = $4 AND grant_kind = 'user'`,
      [input.recipeNamespace, input.recipeName, input.userId, input.oauthClientId]
    )
    return
  }
  await db.query(
    `DELETE FROM oauth_grants
     WHERE recipe_namespace = $1 AND recipe_name = $2
       AND user_id IS NULL AND oauth_client_id = $3 AND grant_kind = 'service'`,
    [input.recipeNamespace, input.recipeName, input.oauthClientId]
  )
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
  await db.query(
    `UPDATE oauth_grants SET background = $5, updated_at = NOW()
     WHERE recipe_namespace = $1 AND recipe_name = $2
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
     WHERE user_id = $1 AND grant_kind = 'user'
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
     WHERE recipe_namespace = $1 AND recipe_name = $2 AND oauth_client_id = $3 AND grant_kind = 'user'
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
     WHERE recipe_namespace = $1 AND recipe_name = $2 AND oauth_client_id = $3
       AND grant_kind = 'user' AND background = true
     ORDER BY user_id`,
    [key.recipeNamespace, key.recipeName, key.oauthClientId]
  )
  return result.rows.map(r => (r as { user_id: string }).user_id)
}
