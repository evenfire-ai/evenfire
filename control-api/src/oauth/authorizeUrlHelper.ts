import {
  type McpServerOAuthReader,
  type McpServerOAuthSubject,
  type OAuthClientDecl,
  RecipeNotFoundError,
  type RecipeReader,
  type RecipeWithOAuthClients,
  SecretNotFoundError,
  type SecretReader,
} from './callback.js'
import { computeCodeChallengeS256, deriveCodeVerifier } from './pkce.js'
import { getOAuthProviderAdapter, isKnownOAuthProvider } from './providers.js'
import { type SignStateInput, signOAuthState } from './state.js'

/**
 * Build the provider authorize URL for an OAuth flow initiated on behalf of a
 * subject: a WorkflowRecipe (embed/admin Connect) or an OAuth McpServer (U5
 * reactive consent).
 *
 * The subject must declare the matching `oauthClientId` (recipe:
 * `spec.oauthClients[]`; mcp-server: `spec.oauth.id`). The subject is read from
 * K8s so we pick up the author-supplied scopes; the K8s Secret is read for the
 * real client_id (the provider needs it in the authorize URL).
 *
 * State is signed with the supplied secret and bound to the subject
 * (recipe: (ns, name, userId, oauthClientId); mcp: (mcpServerName, userId,
 * oauthClientId)) — the callback endpoint re-verifies this on the redirect.
 *
 * Spec §9.9 (recipe) · §U5 (mcp).
 */

interface BuildAuthorizeUrlCommonInput {
  oauthClientId: string
  /**
   * Authenticated user. For `grantKind: 'user'` this is the end-user the grant
   * will belong to (rpc-proxy decodes the session). For `grantKind: 'service'`
   * this is the initiating admin — recorded in the state for audit only. For an
   * mcp subject it is the initiating user (per-user grant owner, or shared-grant
   * bootstrapper resolved on the callback).
   */
  userId: string
  /**
   * [SEC-1] Which kind of grant this flow will mint. Required, non-defaulted:
   * the embed `/oauth/authorize-url` path MUST pass `'user'`, the admin connect
   * route passes `'service'`, the mcp path passes `'user'`. No fall-through.
   */
  grantKind: 'user' | 'service'
  /**
   * True when this flow captures background (offline) consent. Only ever true
   * on the embed background opt-in; the callback sets the grant's `background`
   * flag iff a refresh token is returned. Default false. (Never true for mcp.)
   */
  background?: boolean
  /** Public callback URL the provider will redirect to. */
  redirectUri: string
}

export type BuildAuthorizeUrlInput =
  | (BuildAuthorizeUrlCommonInput & {
      subjectKind?: 'recipe'
      recipeNamespace: string
      recipeName: string
    })
  | (BuildAuthorizeUrlCommonInput & {
      subjectKind: 'mcp'
      mcpServerName: string
    })

export interface BuildAuthorizeUrlDeps {
  recipeReader: RecipeReader
  /**
   * Resolver for OAuth McpServer subjects (U5). Required to build an mcp-subject
   * authorize URL; absent for pure recipe wiring.
   */
  mcpServerReader?: McpServerOAuthReader
  secretReader: SecretReader
  stateSecret: string
}

export type BuildAuthorizeUrlResult =
  | { kind: 'ok'; authorizeUrl: string }
  | { kind: 'recipe_not_found' }
  /** mcp subject: the McpServer named in the request does not exist / is not OAuth. */
  | { kind: 'server_not_found' }
  | { kind: 'unknown_oauth_client' }
  | { kind: 'background_access_not_enabled' }
  | { kind: 'unsupported_provider'; provider: string }
  | { kind: 'secret_missing'; secret: string }

export async function buildAuthorizeUrl(
  input: BuildAuthorizeUrlInput,
  deps: BuildAuthorizeUrlDeps
): Promise<BuildAuthorizeUrlResult> {
  if (input.subjectKind === 'mcp') {
    // ─── mcp subject (U5) ────────────────────────────────────────────────
    if (!deps.mcpServerReader) return { kind: 'server_not_found' }
    let subject: McpServerOAuthSubject | null
    try {
      subject = await deps.mcpServerReader.read(input.mcpServerName)
    } catch (err) {
      if (err instanceof RecipeNotFoundError) return { kind: 'server_not_found' }
      throw err
    }
    if (!subject) return { kind: 'server_not_found' }

    const decl = subject.decl
    if (decl.id !== input.oauthClientId) return { kind: 'unknown_oauth_client' }

    // The state binds the initiating user + the server; grant-scope routing is
    // resolved authoritatively on the callback, so the mcp state is per-user
    // shaped regardless of grantScope (context binding is authoritative via
    // spec.contextRef, not carried here).
    return mintAuthorizeUrl(decl, subject.namespace, input, deps, {
      subjectKind: 'mcp',
      mcpServerName: input.mcpServerName,
      userId: input.userId,
      oauthClientId: input.oauthClientId,
      grantKind: input.grantKind,
      background: input.background ?? false,
    })
  }

  // ─── recipe subject (unchanged) ──────────────────────────────────────────
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

  return mintAuthorizeUrl(decl, input.recipeNamespace, input, deps, {
    recipeNamespace: input.recipeNamespace,
    recipeName: input.recipeName,
    userId: input.userId,
    oauthClientId: input.oauthClientId,
    grantKind: input.grantKind,
    background: input.background ?? false,
  })
}

/**
 * Shared tail for both subjects: background gate, provider check, client_id
 * Secret read, state signing (subject-specific `stateInput`), PKCE challenge,
 * and the provider authorize URL. Signing is the ONLY subject-specific input —
 * the recipe `stateInput` reproduces the pre-U5 signed shape byte-for-byte.
 */
async function mintAuthorizeUrl(
  decl: OAuthClientDecl,
  secretNamespace: string,
  input: BuildAuthorizeUrlInput,
  deps: BuildAuthorizeUrlDeps,
  stateInput: SignStateInput
): Promise<BuildAuthorizeUrlResult> {
  // [SEC-4] A service grant, or any user flow requesting background (offline)
  // consent, may only be minted for a client whose author explicitly opted into
  // background access. Fail closed when the flag is absent. For the mcp path
  // (grantKind 'user', background false) this is a no-op.
  if (decl.backgroundAccess !== true && (input.grantKind === 'service' || input.background)) {
    return { kind: 'background_access_not_enabled' }
  }

  if (!isKnownOAuthProvider(decl.provider)) {
    return { kind: 'unsupported_provider', provider: decl.provider }
  }
  const adapter = getOAuthProviderAdapter(decl.provider)

  let clientIdSecret: Record<string, string>
  try {
    clientIdSecret = await deps.secretReader.read(decl.clientIdRef.name, secretNamespace)
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

  const state = signOAuthState(deps.stateSecret, stateInput)

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
