import type { DbClient } from '../db.js'
import {
  type OAuthProvider,
  type ParsedTokenResponse,
  getOAuthProviderAdapter,
} from './providers.js'
import { signOAuthState, verifyOAuthStateSignature } from './state.js'
import { setUserGrantBackground, upsertOAuthGrant } from './store.js'

/**
 * End-to-end handler for the auth-code OAuth callback. Independent of Express
 * so we can unit-test it with stubs for K8s + DB + fetch. The route handler
 * (`routes/external/oauthCallback.ts`) is a thin parse-params + delegate.
 *
 * Spec §9.9 / Decision 20.
 */

export interface OAuthClientDecl {
  id: string
  provider: string
  clientIdRef: { name: string; key: string }
  clientSecretRef: { name: string; key: string }
  scopes?: string[]
  /**
   * Path B — when true, this client may be connected as a recipe-scoped
   * `service` grant for background workloads. The CRD OpenAPI field + admission
   * validation land in phase 3; this reader type tolerates its absence (a
   * recipe predating the field reads as `undefined` → fail closed).
   */
  backgroundAccess?: boolean
}

export interface RecipeWithOAuthClients {
  metadata?: { name?: string; namespace?: string }
  spec?: { oauthClients?: OAuthClientDecl[] }
}

export interface SecretReader {
  /**
   * Read a Kubernetes Secret in the given namespace, returning a map of
   * key → plaintext value. Caller handles 404s by mapping to a thrown
   * `SecretNotFoundError`.
   */
  read(name: string, namespace: string): Promise<Record<string, string>>
}

export interface RecipeReader {
  read(name: string, namespace: string): Promise<RecipeWithOAuthClients | null>
}

/**
 * Structural alias of {@link RecipeReader} for the generalized owner model (U1).
 *
 * An owner declaration reader resolves a grant owner — a WorkflowRecipe, or an
 * OAuth McpServer — to the same `{ spec: { oauthClients: [...] } }` shape the
 * broker + refresh path already consume. The McpServer variant normalizes its
 * single `spec.oauth` object into a one-element `oauthClients` array so the
 * downstream code (`getAccessToken`) stays owner-agnostic. It is deliberately a
 * plain alias (single method `read(name, namespace)`) so it can be injected
 * per-router with a minimal blast radius — `tokenHelper.ts` and `state.ts` are
 * untouched. (Generalizing `OAuthStateClaims` is U5, not here.)
 */
export type OwnerDeclReader = RecipeReader

export class SecretNotFoundError extends Error {}
export class RecipeNotFoundError extends Error {}

export interface CallbackInput {
  /**
   * oauthClientId from the callback URL path. The (recipeNamespace, recipeName)
   * are no longer carried in the URL — they are recovered from the signed state
   * — but this id rides the stable path and is cross-checked against the claims
   * for defence in depth.
   */
  oauthClientId: string
  /** OAuth `code` query parameter from the provider redirect. */
  code: string
  /** Signed state value (we re-verify before doing anything). */
  state: string
  /** Public URL we registered with the provider; included in the token POST. */
  redirectUri: string
}

export interface CallbackDeps {
  db: DbClient
  recipeReader: RecipeReader
  secretReader: SecretReader
  /** Injectable for tests; defaults to globalThis.fetch in production wiring. */
  fetchFn: typeof fetch
  /** HMAC secret used to sign / verify state. */
  stateSecret: string
  /** AES-256-GCM key used to encrypt refresh tokens at rest. */
  encryptionKey: Buffer
  /** Optional override for token-exchange request timeout. Default 15s. */
  tokenRequestTimeoutMs?: number
}

export type CallbackResult =
  | {
      kind: 'ok'
      provider: OAuthProvider
      userId: string
      grantKind: 'user' | 'service'
      /** Whether the user explicitly requested background access in this flow. */
      backgroundRequested: boolean
      /**
       * Whether background access was successfully enabled — true only when
       * `backgroundRequested` is true AND the provider returned a refresh token.
       * When false and backgroundRequested is true, the user reconnected but the
       * provider did not issue a refresh token, so background access could not be
       * established.
       */
      backgroundEnabled: boolean
    }
  | { kind: 'invalid_state'; reason: string }
  | { kind: 'unknown_oauth_client' }
  | { kind: 'recipe_not_found' }
  | { kind: 'secret_missing'; secret: string }
  | { kind: 'unsupported_provider'; provider: string }
  | { kind: 'provider_token_exchange_failed'; status: number; body: string }
  | { kind: 'provider_response_invalid'; detail: string }

/**
 * Run the full callback flow. Pure relative to its `CallbackDeps` so tests
 * inject stub readers / fetch / db.
 */
export async function handleOAuthCallback(
  input: CallbackInput,
  deps: CallbackDeps
): Promise<CallbackResult> {
  // ─── 1. Verify state signature, recover binding from the claims ───────
  // The callback URL no longer carries (recipeNamespace, recipeName) — they are
  // recovered from the signed, unforgeable state. The oauthClientId still rides
  // the stable URL path, so cross-check it against the claims for defence in
  // depth. The recipe identity itself needs no such check: the HMAC guarantees
  // it, and both authorize-url minters only ever sign sandbox-namespace states.
  const verified = verifyOAuthStateSignature(deps.stateSecret, input.state)
  if (verified.kind !== 'ok') {
    return { kind: 'invalid_state', reason: verified.kind }
  }
  const claims = verified.claims
  if (claims.oauthClientId !== input.oauthClientId) {
    return { kind: 'invalid_state', reason: 'binding_mismatch' }
  }
  const recipeNamespace = claims.recipeNamespace
  const recipeName = claims.recipeName
  const oauthClientId = claims.oauthClientId
  const userId = claims.userId
  // `grantKind` comes ONLY from the signed state — the admin connect route is
  // the sole minter of `service` states (SEC-1). For `service`, `userId` is the
  // initiating admin: used for audit, never written to the grant.
  const grantKind = claims.grantKind

  // ─── 2. Look up the OAuthClientDef on the recipe ──────────────────────
  let recipe: RecipeWithOAuthClients | null
  try {
    recipe = await deps.recipeReader.read(recipeName, recipeNamespace)
  } catch (err) {
    if (err instanceof RecipeNotFoundError) return { kind: 'recipe_not_found' }
    throw err
  }
  if (!recipe) return { kind: 'recipe_not_found' }

  const clientDecl = recipe.spec?.oauthClients?.find(c => c.id === oauthClientId)
  if (!clientDecl) return { kind: 'unknown_oauth_client' }

  // ─── 3. Read clientId + clientSecret from K8s Secrets ─────────────────
  let clientIdSecret: Record<string, string>
  try {
    clientIdSecret = await deps.secretReader.read(clientDecl.clientIdRef.name, recipeNamespace)
  } catch (err) {
    if (err instanceof SecretNotFoundError) {
      return { kind: 'secret_missing', secret: clientDecl.clientIdRef.name }
    }
    throw err
  }
  const clientId = clientIdSecret[clientDecl.clientIdRef.key]
  if (!clientId)
    return {
      kind: 'secret_missing',
      secret: `${clientDecl.clientIdRef.name}/${clientDecl.clientIdRef.key}`,
    }

  let clientSecretSecret: Record<string, string>
  try {
    clientSecretSecret = await deps.secretReader.read(
      clientDecl.clientSecretRef.name,
      recipeNamespace
    )
  } catch (err) {
    if (err instanceof SecretNotFoundError) {
      return { kind: 'secret_missing', secret: clientDecl.clientSecretRef.name }
    }
    throw err
  }
  const clientSecret = clientSecretSecret[clientDecl.clientSecretRef.key]
  if (!clientSecret) {
    return {
      kind: 'secret_missing',
      secret: `${clientDecl.clientSecretRef.name}/${clientDecl.clientSecretRef.key}`,
    }
  }

  // ─── 4. Exchange code with provider ───────────────────────────────────
  const provider = clientDecl.provider
  if (!isKnownProvider(provider)) {
    return { kind: 'unsupported_provider', provider }
  }
  const adapter = getOAuthProviderAdapter(provider)
  const tokenRequest = adapter.buildTokenRequest({
    code: input.code,
    clientId,
    clientSecret,
    redirectUri: input.redirectUri,
  })

  let parsed: ParsedTokenResponse
  try {
    const response = await deps.fetchFn(tokenRequest.url, {
      method: tokenRequest.method,
      headers: tokenRequest.headers,
      body: tokenRequest.body,
      signal: AbortSignal.timeout(deps.tokenRequestTimeoutMs ?? 15_000),
    })
    if (!response.ok) {
      const body = await safeReadText(response)
      return {
        kind: 'provider_token_exchange_failed',
        status: response.status,
        body,
      }
    }
    const responseJson = await response.json()
    parsed = adapter.parseTokenResponse(responseJson)
  } catch (err) {
    return { kind: 'provider_response_invalid', detail: (err as Error).message }
  }

  // ─── 5. Encrypt + persist ─────────────────────────────────────────────
  // A `service` grant is recipe-owned: no `userId` column. A `user` grant
  // belongs to the connecting end-user.
  const backgroundRequested = claims.background
  let backgroundEnabled = false
  if (grantKind === 'service') {
    await upsertOAuthGrant(deps.db, deps.encryptionKey, {
      grantKind: 'service',
      recipeNamespace: recipeNamespace,
      recipeName: recipeName,
      oauthClientId: oauthClientId,
      provider,
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      accessTokenExpiresInSec: parsed.expiresIn,
    })
  } else {
    await upsertOAuthGrant(deps.db, deps.encryptionKey, {
      grantKind: 'user',
      recipeNamespace: recipeNamespace,
      recipeName: recipeName,
      userId,
      oauthClientId: oauthClientId,
      provider,
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      accessTokenExpiresInSec: parsed.expiresIn,
    })
    // Background consent: only enable when the provider actually returned a
    // refresh token — without one the broker could not sustain access. A plain
    // (non-background) connect never touches the flag, so re-connecting does
    // not silently revoke a prior background grant.
    //
    // NOTE — the reverse direction is also intentional: an interactive
    // (non-background) reconnect intentionally preserves any existing
    // background=true grant. The only downgrade paths are an explicit
    // user-initiated revoke (DELETE /external/oauth/grants/…) or an admin
    // force-revoke — both delete the row entirely.
    if (backgroundRequested && parsed.refreshToken) {
      await setUserGrantBackground(
        deps.db,
        {
          recipeNamespace: recipeNamespace,
          recipeName: recipeName,
          userId,
          oauthClientId: oauthClientId,
        },
        true
      )
      backgroundEnabled = true
    }
  }

  return { kind: 'ok', provider, userId, grantKind, backgroundRequested, backgroundEnabled }
}

// ─── helpers ──────────────────────────────────────────────────────────────

const KNOWN_PROVIDERS: ReadonlySet<OAuthProvider> = new Set([
  'salesforce',
  'slack',
  'notion',
  'microsoft-graph',
  'google',
])

function isKnownProvider(value: string): value is OAuthProvider {
  return KNOWN_PROVIDERS.has(value as OAuthProvider)
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 2000)
  } catch {
    return ''
  }
}

// Re-export for the route layer's convenience.
export { signOAuthState }
