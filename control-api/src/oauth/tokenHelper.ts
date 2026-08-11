import type { DbClient } from '../db.js'
import {
  RecipeNotFoundError,
  type RecipeReader,
  type RecipeWithOAuthClients,
  SecretNotFoundError,
  type SecretReader,
} from './callback.js'
import {
  type ParsedTokenResponse,
  getOAuthProviderAdapter,
  isKnownOAuthProvider,
} from './providers.js'
import { type OAuthGrantKey, getOAuthGrant, upsertOAuthGrant } from './store.js'

/**
 * Fetch the current access token for a grant (user or service), refreshing on
 * demand using the stored refresh token. Refresh tokens never leave
 * control-api; only the freshly-minted access token is returned.
 *
 * Callers: the cookie-authed `POST /sandbox-ui/oauth/token` endpoint for `user`
 * grants (spec §9.9), and the broker route `POST /api/v1/recipe-oauth/token`
 * for `service` grants (Path B, spec §10).
 */

export type GetAccessTokenInput = OAuthGrantKey & {
  /**
   * Require a background-consented grant (per-user broker, SEC-5). Parametrized,
   * NOT pinned to `true`: the recipe background broker passes `true`; the
   * interactive mcp-host live-session path (U1) passes `false` (there IS a live
   * session). Honored for `user` and `shared` grants; ignored for `service`.
   */
  requireBackground?: boolean
}

export interface GetAccessTokenDeps {
  db: DbClient
  recipeReader: RecipeReader
  secretReader: SecretReader
  fetchFn: typeof fetch
  encryptionKey: Buffer
  /** How long before expiry we consider the token "stale" and refresh. Default 60s. */
  refreshBufferMs?: number
  /** Token-exchange timeout. Default 15s. */
  refreshTimeoutMs?: number
}

export type GetAccessTokenResult =
  | { kind: 'ok'; accessToken: string; expiresAt?: Date }
  | { kind: 'no_grant' }
  | { kind: 'recipe_not_found' }
  | { kind: 'unknown_oauth_client' }
  | { kind: 'unsupported_provider'; provider: string }
  | { kind: 'secret_missing'; secret: string }
  | { kind: 'refresh_failed'; status?: number; detail: string }

export async function getAccessToken(
  input: GetAccessTokenInput,
  deps: GetAccessTokenDeps
): Promise<GetAccessTokenResult> {
  const grant = await getOAuthGrant(deps.db, deps.encryptionKey, input)
  if (!grant) return { kind: 'no_grant' }

  const refreshBufferMs = deps.refreshBufferMs ?? 60_000
  const stillValid =
    !grant.accessTokenExpiresAt ||
    grant.accessTokenExpiresAt.getTime() - refreshBufferMs > Date.now()
  if (stillValid) {
    return { kind: 'ok', accessToken: grant.accessToken, expiresAt: grant.accessTokenExpiresAt }
  }

  // Stale → need refresh. Without a refresh token we surface no_grant so the
  // caller treats it as "needs reauth"; the user re-clicks Connect.
  if (!grant.refreshToken) return { kind: 'no_grant' }

  // Resolve recipe + secrets + provider for the refresh exchange.
  let recipe: RecipeWithOAuthClients | null
  try {
    recipe = await deps.recipeReader.read(input.recipeName, input.recipeNamespace)
  } catch (err) {
    if (err instanceof RecipeNotFoundError) return { kind: 'recipe_not_found' }
    throw err
  }
  if (!recipe) return { kind: 'recipe_not_found' }

  const decl = recipe.spec?.oauthClients?.find(c => c.id === input.oauthClientId)
  if (!decl) return { kind: 'unknown_oauth_client' }
  if (!isKnownOAuthProvider(decl.provider)) {
    return { kind: 'unsupported_provider', provider: decl.provider }
  }

  let clientIdSecret: Record<string, string>
  try {
    clientIdSecret = await deps.secretReader.read(decl.clientIdRef.name, input.recipeNamespace)
  } catch (err) {
    if (err instanceof SecretNotFoundError) {
      return { kind: 'secret_missing', secret: decl.clientIdRef.name }
    }
    throw err
  }
  const clientId = clientIdSecret[decl.clientIdRef.key]
  if (!clientId) {
    return { kind: 'secret_missing', secret: `${decl.clientIdRef.name}/${decl.clientIdRef.key}` }
  }

  let clientSecretSecret: Record<string, string>
  try {
    clientSecretSecret = await deps.secretReader.read(
      decl.clientSecretRef.name,
      input.recipeNamespace
    )
  } catch (err) {
    if (err instanceof SecretNotFoundError) {
      return { kind: 'secret_missing', secret: decl.clientSecretRef.name }
    }
    throw err
  }
  const clientSecret = clientSecretSecret[decl.clientSecretRef.key]
  if (!clientSecret) {
    return {
      kind: 'secret_missing',
      secret: `${decl.clientSecretRef.name}/${decl.clientSecretRef.key}`,
    }
  }

  const adapter = getOAuthProviderAdapter(decl.provider)
  let refreshRequest: ReturnType<typeof adapter.buildRefreshRequest>
  try {
    refreshRequest = adapter.buildRefreshRequest({
      refreshToken: grant.refreshToken,
      clientId,
      clientSecret,
    })
  } catch (err) {
    return { kind: 'refresh_failed', detail: (err as Error).message }
  }

  let parsed: ParsedTokenResponse
  try {
    const response = await deps.fetchFn(refreshRequest.url, {
      method: refreshRequest.method,
      headers: refreshRequest.headers,
      body: refreshRequest.body,
      signal: AbortSignal.timeout(deps.refreshTimeoutMs ?? 15_000),
    })
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, 2000)
      return { kind: 'refresh_failed', status: response.status, detail: body }
    }
    parsed = adapter.parseTokenResponse(await response.json())
  } catch (err) {
    return { kind: 'refresh_failed', detail: (err as Error).message }
  }

  // Some providers omit refresh_token on refresh — keep the previous one.
  // Spread `...input` so the grant key (grantKind + owner/identifiers) is carried
  // through verbatim — the refresh re-upserts the SAME row. For `user`/`service`
  // this is ON CONFLICT DO UPDATE (identity columns excluded); for `shared` it
  // is a plain UPDATE by key (see store.ts) that never rewrites
  // `bootstrapped_by_user_id` or the shared identity. Columns outside the key
  // are preserved either way.
  await upsertOAuthGrant(deps.db, deps.encryptionKey, {
    ...input,
    provider: decl.provider,
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken ?? grant.refreshToken,
    accessTokenExpiresInSec: parsed.expiresIn,
  })

  const expiresAt =
    typeof parsed.expiresIn === 'number'
      ? new Date(Date.now() + parsed.expiresIn * 1000)
      : undefined
  return { kind: 'ok', accessToken: parsed.accessToken, expiresAt }
}
