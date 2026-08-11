import {
  RecipeNotFoundError,
  type RecipeReader,
  type RecipeWithOAuthClients,
  SecretNotFoundError,
  type SecretReader,
} from './callback.js'
import { computeCodeChallengeS256, deriveCodeVerifier } from './pkce.js'
import { getOAuthProviderAdapter, isKnownOAuthProvider } from './providers.js'
import { signOAuthState } from './state.js'

/**
 * Build the provider authorize URL for an embed-initiated OAuth flow.
 *
 * The recipe must declare the matching `oauthClientId` under
 * `spec.oauthClients[]`. The recipe is read from K8s so we pick up the
 * recipe-author-supplied scopes; the K8s Secret is read for the real
 * client_id (the provider needs it in the authorize URL).
 *
 * State is signed with the supplied secret and bound to
 * (recipeNamespace, recipeName, userId, oauthClientId) — the callback
 * endpoint re-verifies this on the provider redirect.
 *
 * Spec §9.9.
 */

export interface BuildAuthorizeUrlInput {
  recipeNamespace: string
  recipeName: string
  oauthClientId: string
  /**
   * Authenticated user. For `grantKind: 'user'` this is the end-user the grant
   * will belong to (rpc-proxy decodes the cookie). For `grantKind: 'service'`
   * this is the initiating admin — recorded in the state for audit only.
   */
  userId: string
  /**
   * [SEC-1] Which kind of grant this flow will mint. Required, non-defaulted:
   * the embed `/oauth/authorize-url` path MUST pass `'user'`, the admin connect
   * route passes `'service'`. There is no fall-through default.
   */
  grantKind: 'user' | 'service'
  /**
   * True when this flow captures background (offline) consent. Only ever true
   * on the embed background opt-in; the callback sets the grant's `background`
   * flag iff a refresh token is returned. Default false.
   */
  background?: boolean
  /** Public callback URL the provider will redirect to. */
  redirectUri: string
}

export interface BuildAuthorizeUrlDeps {
  recipeReader: RecipeReader
  secretReader: SecretReader
  stateSecret: string
}

export type BuildAuthorizeUrlResult =
  | { kind: 'ok'; authorizeUrl: string }
  | { kind: 'recipe_not_found' }
  | { kind: 'unknown_oauth_client' }
  | { kind: 'background_access_not_enabled' }
  | { kind: 'unsupported_provider'; provider: string }
  | { kind: 'secret_missing'; secret: string }

export async function buildAuthorizeUrl(
  input: BuildAuthorizeUrlInput,
  deps: BuildAuthorizeUrlDeps
): Promise<BuildAuthorizeUrlResult> {
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

  // [SEC-4] A service grant, or any user flow requesting background (offline)
  // consent, may only be minted for a client the recipe author explicitly opted
  // into background access. Fail closed when the flag is absent — including for
  // recipes that predate the field.
  if (decl.backgroundAccess !== true && (input.grantKind === 'service' || input.background)) {
    return { kind: 'background_access_not_enabled' }
  }

  if (!isKnownOAuthProvider(decl.provider)) {
    return { kind: 'unsupported_provider', provider: decl.provider }
  }
  const adapter = getOAuthProviderAdapter(decl.provider)

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
    return {
      kind: 'secret_missing',
      secret: `${decl.clientIdRef.name}/${decl.clientIdRef.key}`,
    }
  }

  const state = signOAuthState(deps.stateSecret, {
    recipeNamespace: input.recipeNamespace,
    recipeName: input.recipeName,
    userId: input.userId,
    oauthClientId: input.oauthClientId,
    grantKind: input.grantKind,
    background: input.background ?? false,
  })

  // PKCE (DEC-1): derive the verifier deterministically from the signed state,
  // then send its S256 challenge. The callback re-derives the same verifier from
  // the round-tripped state — nothing PKCE-related is stored server-side.
  let codeChallenge: string | undefined
  if (adapter.usesPkce) {
    codeChallenge = computeCodeChallengeS256(deriveCodeVerifier(deps.stateSecret, state))
  }

  const authorizeUrl = adapter.buildAuthorizeUrl({
    clientId,
    redirectUri: input.redirectUri,
    state,
    scopes: decl.scopes ?? [],
    codeChallenge,
  })

  return { kind: 'ok', authorizeUrl }
}
