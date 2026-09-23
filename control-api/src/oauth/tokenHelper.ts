import type { DbClient } from '../db.js'
import type { PinnedTransport } from '../http/pinnedFetch.js'
import type { DnsResolver } from '../http/validateMcpServerSpec.js'
import {
  type OAuthClientDecl,
  RecipeNotFoundError,
  type RecipeReader,
  type RecipeWithOAuthClients,
  SecretNotFoundError,
  type SecretReader,
  postRemoteTokenForm,
  resolveRemoteClientCredential,
} from './callback.js'
import {
  type ParsedTokenResponse,
  buildAdapterFromConfig,
  buildRemoteRefreshRequest,
  getOAuthProviderAdapter,
  isKnownOAuthProvider,
  parseRemoteTokenResponse,
} from './providers.js'
import { type OAuthGrantKey, getOAuthGrant, refreshOAuthGrantTokens } from './store.js'

/**
 * Fetch the current access token for a grant (user or service), refreshing on
 * demand using the stored refresh token. Refresh tokens never leave
 * control-api; only the freshly-minted access token is returned.
 *
 * Callers: the cookie-authed `POST /sandbox-ui/oauth/token` endpoint for `user`
 * grants (spec §9.9), and the broker route `POST /api/v1/recipe-oauth/token`
 * for `service` grants (Path B, spec §10).
 */

/**
 * Reactive refresh buffer (Br): a stored access token is treated as stale, and
 * refreshed on demand, once it is within this window of expiry. The default when
 * a caller passes no `refreshBufferMs`. Exported so the proactive buffer (Bp) can
 * be validated `Bp > Br` at config load (mini-spec L §3) against the SAME source
 * of truth the reactive path uses — never a re-typed literal.
 */
export const REACTIVE_REFRESH_BUFFER_MS = 60_000

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
  /**
   * Remote lane only: injectable DNS resolver + pinned transport for the
   * IP-pinned refresh POST (DEC-17). Production leaves both undefined (real
   * resolve + `node:https`); the baked lane never touches them (keeps `fetchFn`).
   */
  resolveDns?: DnsResolver
  pinnedTransport?: PinnedTransport
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

  const refreshBufferMs = deps.refreshBufferMs ?? REACTIVE_REFRESH_BUFFER_MS
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

  // Remote lane (`source:'remote'`): discovery-derived refresh over the IP-pinned
  // transport (DEC-17), public token client, credentials per `secretSource`. The
  // baked provider-adapter path is below (unchanged).
  if (decl.remote) {
    // no-refresh derived from pinned metadata (D-8, fail-closed): the AS never
    // advertised `refresh_token`, so treat as "needs reauth" rather than POST a
    // refresh — surfaces `connect_required` in mcp-host. Derived from the flag,
    // NOT heuristically from token presence.
    if (!decl.remote.supportsRefresh) return { kind: 'no_grant' }
    return refreshRemoteGrant(grant.refreshToken, decl, input, deps)
  }

  // Generic self-hosted lane (`source:'generic'`, DEC-28): same fail-closed
  // no-refresh gate (D-8) and IP-pinned refresh POST (DEC-17) as the remote lane,
  // but the request is composed from the CR knobs (`buildAdapterFromConfig`).
  if (decl.generic) {
    if (!decl.generic.supportsRefresh) return { kind: 'no_grant' }
    return refreshGenericGrant(grant.refreshToken, decl, input, deps)
  }

  if (!isKnownOAuthProvider(decl.provider)) {
    return { kind: 'unsupported_provider', provider: decl.provider }
  }

  // Baked/recipe lane: clientIdRef always present (only remote omits it).
  if (!decl.clientIdRef) {
    return { kind: 'secret_missing', secret: `${decl.id}/client_id` }
  }
  const clientIdRef = decl.clientIdRef

  let clientIdSecret: Record<string, string>
  try {
    clientIdSecret = await deps.secretReader.read(clientIdRef.name, input.recipeNamespace)
  } catch (err) {
    if (err instanceof SecretNotFoundError) {
      return { kind: 'secret_missing', secret: clientIdRef.name }
    }
    throw err
  }
  const clientId = clientIdSecret[clientIdRef.key]
  if (!clientId) {
    return { kind: 'secret_missing', secret: `${clientIdRef.name}/${clientIdRef.key}` }
  }

  // Public client (E-19.2): no clientSecretRef ⇒ refresh without a client_secret.
  // When a ref is present the confidential path is unchanged.
  let clientSecret: string | undefined
  if (decl.clientSecretRef) {
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
    clientSecret = clientSecretSecret[decl.clientSecretRef.key]
    if (!clientSecret) {
      return {
        kind: 'secret_missing',
        secret: `${decl.clientSecretRef.name}/${decl.clientSecretRef.key}`,
      }
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
  // Persist via `refreshOAuthGrantTokens` (UPDATE by key), NOT an upsert. The
  // grant row was read above, but a concurrent disconnect (DELETE) can land
  // between that read and this write; an `INSERT … ON CONFLICT` would RESURRECT
  // the deleted grant with fresh tokens (R1-B1), whereas an UPDATE touches 0
  // rows once the row is gone. Spread `...input` so the grant key
  // (grantKind + owner/identifiers) targets the SAME row verbatim; for `shared`
  // the UPDATE never rewrites `bootstrapped_by_user_id` or the shared identity.
  const refreshed = await refreshOAuthGrantTokens(deps.db, deps.encryptionKey, {
    ...input,
    provider: decl.provider,
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken ?? grant.refreshToken,
    accessTokenExpiresInSec: parsed.expiresIn,
  })
  // 0 rows ⇒ the grant was deleted during the refresh window. Surface it as
  // "needs reauth" (no_grant) rather than return a token for a revoked grant —
  // and crucially do NOT recreate the row.
  if (!refreshed.updated) return { kind: 'no_grant' }

  const expiresAt =
    typeof parsed.expiresIn === 'number'
      ? new Date(Date.now() + parsed.expiresIn * 1000)
      : undefined
  return { kind: 'ok', accessToken: parsed.accessToken, expiresAt }
}

/**
 * Remote-lane refresh (`source:'remote'`, `supportsRefresh:true`). Public token
 * client, credentials per `secretSource`, IP-pinned POST to the discovery-derived
 * token endpoint (DEC-17). Persists via the SAME `refreshOAuthGrantTokens` UPDATE
 * (never resurrects a concurrently-deleted grant). `refreshToken` is already
 * narrowed non-null by the caller.
 */
async function refreshRemoteGrant(
  refreshToken: string,
  decl: OAuthClientDecl,
  input: GetAccessTokenInput,
  deps: GetAccessTokenDeps
): Promise<GetAccessTokenResult> {
  const remote = decl.remote
  if (!remote) return { kind: 'no_grant' }
  const credResult = await resolveRemoteClientCredential(
    decl,
    input.recipeNamespace,
    input.recipeName,
    {
      db: deps.db,
      encryptionKey: deps.encryptionKey,
      secretReader: deps.secretReader,
    }
  )
  if (!credResult.ok) return { kind: 'secret_missing', secret: credResult.secret }

  const refreshRequest = buildRemoteRefreshRequest(
    remote.tokenEndpoint,
    {
      refreshToken,
      clientId: credResult.cred.clientId,
      clientSecret: credResult.cred.clientSecret,
    },
    remote.resource
  )
  const posted = await postRemoteTokenForm(
    remote.tokenEndpoint,
    'spec.oauth.tokenEndpoint',
    refreshRequest,
    {
      resolveDns: deps.resolveDns,
      pinnedTransport: deps.pinnedTransport,
      timeoutMs: deps.refreshTimeoutMs,
    }
  )
  if (!posted.ok) return { kind: 'refresh_failed', status: posted.status, detail: posted.detail }

  let parsed: ParsedTokenResponse
  try {
    parsed = parseRemoteTokenResponse(JSON.parse(posted.bodyText))
  } catch (err) {
    return { kind: 'refresh_failed', detail: (err as Error).message }
  }

  const refreshed = await refreshOAuthGrantTokens(deps.db, deps.encryptionKey, {
    ...input,
    provider: 'remote',
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken ?? refreshToken,
    accessTokenExpiresInSec: parsed.expiresIn,
  })
  if (!refreshed.updated) return { kind: 'no_grant' }

  const expiresAt =
    typeof parsed.expiresIn === 'number'
      ? new Date(Date.now() + parsed.expiresIn * 1000)
      : undefined
  return { kind: 'ok', accessToken: parsed.accessToken, expiresAt }
}

/**
 * Generic-lane refresh (`source:'generic'`, `supportsRefresh:true`, DEC-28). The
 * refresh request is composed from the CR knobs (`buildAdapterFromConfig`),
 * credentials come from `secretSource` (public/k8s-secret), and the POST is
 * IP-pinned to the pinned `refreshEndpoint` (defaulting to `tokenEndpoint`,
 * DEC-17). Persists via the SAME `refreshOAuthGrantTokens` UPDATE (never
 * resurrects a concurrently-deleted grant). `refreshToken` is already narrowed
 * non-null by the caller.
 */
async function refreshGenericGrant(
  refreshToken: string,
  decl: OAuthClientDecl,
  input: GetAccessTokenInput,
  deps: GetAccessTokenDeps
): Promise<GetAccessTokenResult> {
  const generic = decl.generic
  if (!generic) return { kind: 'no_grant' }
  const credResult = await resolveRemoteClientCredential(
    decl,
    input.recipeNamespace,
    input.recipeName,
    {
      db: deps.db,
      encryptionKey: deps.encryptionKey,
      secretReader: deps.secretReader,
    }
  )
  if (!credResult.ok) return { kind: 'secret_missing', secret: credResult.secret }

  const adapter = buildAdapterFromConfig(generic)
  let refreshRequest: ReturnType<typeof adapter.buildRefreshRequest>
  try {
    // The build can throw (tokenAuthMethod=basic without a secret); wrap it into a
    // typed fail-closed result rather than an opaque 500 (symmetric with baked).
    refreshRequest = adapter.buildRefreshRequest({
      refreshToken,
      clientId: credResult.cred.clientId,
      clientSecret: credResult.cred.clientSecret,
    })
  } catch (err) {
    return { kind: 'refresh_failed', detail: (err as Error).message }
  }

  const posted = await postRemoteTokenForm(
    refreshRequest.url,
    'spec.oauth.refreshEndpoint',
    refreshRequest,
    {
      resolveDns: deps.resolveDns,
      pinnedTransport: deps.pinnedTransport,
      timeoutMs: deps.refreshTimeoutMs,
    }
  )
  if (!posted.ok) return { kind: 'refresh_failed', status: posted.status, detail: posted.detail }

  let parsed: ParsedTokenResponse
  try {
    parsed = adapter.parseTokenResponse(JSON.parse(posted.bodyText))
  } catch (err) {
    return { kind: 'refresh_failed', detail: (err as Error).message }
  }

  const refreshed = await refreshOAuthGrantTokens(deps.db, deps.encryptionKey, {
    ...input,
    provider: 'generic',
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken ?? refreshToken,
    accessTokenExpiresInSec: parsed.expiresIn,
  })
  if (!refreshed.updated) return { kind: 'no_grant' }

  const expiresAt =
    typeof parsed.expiresIn === 'number'
      ? new Date(Date.now() + parsed.expiresIn * 1000)
      : undefined
  return { kind: 'ok', accessToken: parsed.accessToken, expiresAt }
}
