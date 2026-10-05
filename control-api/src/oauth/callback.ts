import type { DbClient } from '../db.js'
import type { PinnedTransport } from '../http/pinnedFetch.js'
import { pinnedFetch } from '../http/pinnedFetch.js'
import type { DnsResolver } from '../http/validateMcpServerSpec.js'
import { rootLogger } from '../observability/logger.js'
import { getDynamicClient } from './dynamicClientStore.js'
import {
  type RemoteOAuthSpecIncoherence,
  RemoteOAuthSpecIncoherentError,
} from './mcpServerOAuthSpec.js'
import { buildPerServerRedirectUri, resolvePerServerRegistration } from './perServerRegistration.js'
import { deriveCodeVerifier } from './pkce.js'
import {
  type GenericAdapterConfig,
  type OAuthProvider,
  type ParsedTokenResponse,
  buildAdapterFromConfig,
  buildRemoteTokenRequest,
  getOAuthProviderAdapter,
  isKnownOAuthProvider,
  parseRemoteTokenResponse,
} from './providers.js'
import { resolveExactRecipeOAuthClient } from './recipeOAuthClient.js'
import {
  InvalidRemoteRedirectUriInputError,
  REMOTE_CALLBACK_CLIENT_SEGMENT,
  buildRemoteRedirectUri,
  remoteCallbackVariant,
} from './remoteCallback.js'
import type { OAuthMcpStateClaims } from './state.js'
import { signOAuthState, verifyOAuthStateSignature } from './state.js'
import { bootstrapSharedOAuthGrant, setUserGrantBackground, upsertOAuthGrant } from './store.js'

// Reserved last URL segment of the shared remote OAuth callback. Defined in
// `remoteCallback.ts` (the single redirect-URI builder); re-exported for the existing
// importers of this module.
export { REMOTE_CALLBACK_CLIENT_SEGMENT }

const log = rootLogger.child({ module: 'oauth-callback' })

/**
 * Discriminator for WHERE an mcp-server's OAuth client credentials live
 * (DEC-18). Present only on a `source:'remote'` subject; baked/recipe decls read
 * their K8s Secret via `clientIdRef`/`clientSecretRef` directly and carry none.
 *   - `k8s-secret` → pre-registered confidential: read the named Secret.
 *   - `dcr-store`  → DCR-confidential: read the encrypted `dynamic_clients` row.
 *   - `public`     → CIMD/DCR-public: no secret; `client_id` IS `oauth.id`.
 */
export type ServerOAuthSecretSource =
  | {
      kind: 'k8s-secret'
      clientIdRef: { name: string; key: string }
      clientSecretRef: { name: string; key: string }
    }
  | { kind: 'dcr-store' }
  | { kind: 'public' }

/**
 * Remote MCP-OAuth routing pinned on the CR at install (C1.5/C2/C3). Present only
 * for a `source:'remote'` client; drives the discovery-derived exchange/refresh/
 * authorize instead of a baked provider adapter. All endpoints are attacker-
 * controlled (discovery-derived) ⇒ every fetch through them is IP-pinned (DEC-17).
 */
export interface RemoteClientRouting {
  authorizationEndpoint: string
  tokenEndpoint: string
  /** RFC 8707 resource indicator, echoed in authorize + token/refresh. */
  resource?: string
  clientMode: 'public' | 'confidential'
  /** D-8: token in the body vs Authorization header (mcp-host concern; carried for parity). */
  bearerInBody: boolean
  /** D-8: fail-closed — false ⇒ NEVER attempt a refresh. */
  supportsRefresh: boolean
  /** RFC 9207 issuer to validate the callback `iss` against, when advertised. */
  issForCallback?: string
  /**
   * The pinned AS issuer. Without RFC 9207 an AS may still send `iss`; when it does,
   * it must match this value rather than being ignored.
   */
  issuer?: string
}

/**
 * Generic self-hosted OAuth routing pinned on the CR (`source:'generic'`, DEC-28).
 * Present only for a `source:'generic'` client; drives a KNOB-configured
 * exchange/refresh/authorize via `buildAdapterFromConfig` instead of a baked
 * provider adapter. Like the remote lane, the operator-supplied endpoints are
 * attacker-influenced ⇒ every token/refresh POST is IP-pinned (DEC-17). Extends
 * the pure wire knobs (`GenericAdapterConfig`, single source of truth in
 * providers.ts) with the fail-closed `supportsRefresh` flag (D-8).
 */
export interface GenericClientRouting extends GenericAdapterConfig {
  /** D-8: fail-closed — false ⇒ NEVER attempt a refresh. */
  supportsRefresh: boolean
}

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
  /**
   * Confidential-client id reference. Optional (C4/DEC-23): a remote PUBLIC or
   * DCR client has no K8s ref — its `client_id` is `oauth.id` (`decl.id`) or the
   * encrypted `dynamic_clients` row. Baked/recipe decls always carry it; the
   * baked paths guard fail-closed if it is somehow absent (unreachable there).
   */
  clientIdRef?: { name: string; key: string }
  /**
   * Confidential-client secret reference. Optional (E-19.2): a PUBLIC OAuth
   * client declares no secret, so the callback reads only the client_id Secret
   * and the token POST omits `client_secret`. When present, the confidential
   * path is byte-identical to before.
   */
  clientSecretRef?: { name: string; key: string }
  scopes?: string[]
  /**
   * Path B — when true, this client may be connected as a recipe-scoped
   * `service` grant for background workloads. The CRD OpenAPI field + admission
   * validation land in phase 3; this reader type tolerates its absence (a
   * recipe predating the field reads as `undefined` → fail closed).
   */
  backgroundAccess?: boolean
  /**
   * Remote MCP-OAuth routing (`source:'remote'`). Present ⇒ the discovery-derived
   * lane: exchange/refresh/authorize use the pinned endpoints + `secretSource`
   * instead of a baked provider adapter. Absent ⇒ baked/recipe (byte-identical).
   */
  remote?: RemoteClientRouting
  /**
   * Generic self-hosted OAuth routing (`source:'generic'`, DEC-28). Present ⇒ the
   * knob-configured lane: exchange/refresh/authorize use the pinned endpoints +
   * `buildAdapterFromConfig` + `secretSource` instead of a baked provider adapter.
   * Mutually exclusive with `remote`. Absent ⇒ baked/recipe (byte-identical).
   */
  generic?: GenericClientRouting
  /**
   * Where the remote/generic client credentials live (DEC-18). Present alongside
   * `remote` or `generic`; absent ⇒ the legacy K8s `clientIdRef`/`clientSecretRef`
   * path. For the generic lane it is `public` (no refs) or `k8s-secret` (both refs).
   */
  secretSource?: ServerOAuthSecretSource
}

export interface RecipeWithOAuthClients {
  /** `uid` is set for an McpServer owner: the installation its grants are sealed with. */
  metadata?: { name?: string; namespace?: string; uid?: string }
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

/**
 * An OAuth McpServer subject, resolved for the U5 callback / authorize-URL
 * paths. Unlike {@link OwnerDeclReader} (which flattens a server to the
 * owner-agnostic `oauthClients` shape for the refresh path), this carries the
 * extra routing the consent flow needs:
 *   - `namespace` — the mcp-servers namespace the server + its Secrets live in;
 *     also the grant owner coordinate. Kept on the subject so the pure callback
 *     never imports config.
 *   - `grantScope` — `'user'` → per-user grant `(server, userId)`;
 *     `'context'` → shared grant `(server, contextRef)` (U6 governance).
 *   - `contextRef` — the AUTHORITATIVE Context (`spec.contextRef`), the shared
 *     grant coordinate. NEVER taken from the state or a body param.
 */
export interface McpServerOAuthSubject {
  namespace: string
  decl: OAuthClientDecl
  grantScope: 'user' | 'context'
  contextRef?: string
  /**
   * metadata.uid of the McpServer CR the subject was read from. The callback seals
   * the grant it writes with it and fences the DCR credential read by it; the
   * authorize-url mint carries it too but never persists a grant. Absent only when
   * the CR carried no uid.
   */
  crUid?: string
}

export interface McpServerOAuthReader {
  /**
   * Resolve an OAuth McpServer by name from the mcp-servers namespace. Returns
   * null when the server does not exist or is not a usable OAuth server, so
   * callers fail closed. May throw {@link RecipeNotFoundError} for a hard 404, or
   * {@link RemoteOAuthSpecIncoherentError} for a remote spec the runtime cannot honor.
   */
  read(mcpServerName: string): Promise<McpServerOAuthSubject | null>
}

export class SecretNotFoundError extends Error {}
export class RecipeNotFoundError extends Error {}

/**
 * Which callback URL the provider redirected to. Decided by the route from the path
 * shape alone; the handler then checks it against the signed state and the CR.
 *
 *   - `client`            — `/oauth-callback/<oauthClientId>` (recipe, baked, generic).
 *   - `remote-shared`     — `/oauth-callback/remote`: every remote server whose AS
 *                           returns RFC 9207 `iss`, which is what binds the code there.
 *   - `remote-per-server` — `/oauth-callback/remote/<serverName>[/<installNonce>]`: a
 *                           remote server whose AS does not return `iss`, where the URI
 *                           itself is the binding. Both segments are already validated.
 *
 * The remote kinds carry an origin, not a URI: the redirect URI replayed on the token
 * exchange is rebuilt from the signed state and the CR once they have been checked,
 * never from the request path.
 */
export type CallbackTarget =
  | {
      kind: 'client'
      id: string
      /** Public URL registered for this client; replayed on the token POST. */
      redirectUri: string
    }
  | {
      kind: 'remote-shared'
      /** Origin of the shared callback (the configured base URL, else the request Host). */
      origin: string
    }
  | {
      kind: 'remote-per-server'
      serverName: string
      installNonce?: string
      /** The configured public origin; null when none is configured (fails closed). */
      origin: string | null
    }

export interface CallbackInput {
  target: CallbackTarget
  /** OAuth `code` query parameter from the provider redirect. */
  code: string
  /** Signed state value (we re-verify before doing anything). */
  state: string
  /**
   * RFC 9207 `iss` exactly as parsed from the query (`req.query.iss`): a string, an
   * array when repeated, an object for bracket syntax, or undefined. Kept raw because
   * the two remote variants read it differently: the shared callback treats anything
   * but a string as absent, while the per-server callback rejects a malformed value
   * instead of letting it pass as "no iss". Ignored on the `client` target.
   */
  iss?: unknown
}

export interface CallbackDeps {
  db: DbClient
  recipeReader: RecipeReader
  secretReader: SecretReader
  /**
   * Resolver for OAuth McpServer subjects (U5). Required to process an
   * mcp-subject state; when absent, an mcp state fails closed
   * (`server_not_found`). Recipe callbacks never touch it.
   */
  mcpServerReader?: McpServerOAuthReader
  /**
   * Resolve the Contexts a user is a member of (via `user_contexts`). Required
   * ONLY for the shared-identity mcp bootstrap (`grantScope='context'`): a
   * shared grant plants a team credential for everyone in the Context, so the
   * consenting user MUST be a member first. Injected so the pure callback stays
   * testable; the route wires the real `getUserContexts`. When absent on a
   * shared-context path, that path fails closed (`context_membership_denied`).
   * The per-user path never touches it (its key IS the user).
   */
  userContextsReader?: (userId: string) => Promise<{ contextIds: string[] }>
  /**
   * Injectable for tests; defaults to globalThis.fetch in production wiring.
   * BAKED lane ONLY — the remote lane (`source:'remote'`) never uses it (DEC-17):
   * its endpoint is discovery-derived, so it goes through the IP-pinned
   * `pinnedFetch` to close the DNS-rebinding TOCTOU (H2).
   */
  fetchFn: typeof fetch
  /** HMAC secret used to sign / verify state. */
  stateSecret: string
  /** AES-256-GCM key used to encrypt refresh tokens at rest. */
  encryptionKey: Buffer
  /** Optional override for token-exchange request timeout. Default 15s. */
  tokenRequestTimeoutMs?: number
  /**
   * Remote lane only: injectable DNS resolver + pinned transport for
   * `pinnedFetch`. Production leaves both undefined (real resolve + real
   * `node:https`); tests inject to assert `connectedIP === validatedIP`.
   */
  resolveDns?: DnsResolver
  pinnedTransport?: PinnedTransport
}

/**
 * Provider label persisted / displayed. `'remote'` for the discovery-derived lane,
 * `'generic'` for the knob-configured self-hosted lane (DEC-28).
 */
export type GrantProviderLabel = OAuthProvider | 'remote' | 'generic'

export type CallbackResult =
  | {
      kind: 'ok'
      provider: GrantProviderLabel
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
      /**
       * Subject that consented. Absent (undefined) for the recipe subject — the
       * recipe deep-link is FROZEN and carries no `source`. Set to `'mcp'` for an
       * OAuth McpServer subject so the route appends `&source=mcp` to the return
       * deep-link (U5).
       */
      source?: 'mcp'
      /**
       * The consented mcp-server's name — present only on the `source:'mcp'`
       * path. Comes from the signed state (authoritative), never a body param.
       * The route forwards it into the deep-link (`&mcpServerName=…`) so the
       * desktop can correlate which suspended task to resume under concurrent
       * suspensions.
       */
      mcpServerName?: string
    }
  | { kind: 'invalid_state'; reason: string }
  /**
   * RFC 9207 authorization-server mix-up defence: the callback `iss` did not
   * match the AS issuer pinned on the remote server (`issForCallback`), or was
   * absent when one was advertised. Fail closed BEFORE the single-use code is
   * exchanged. No value fields — the issuer strings are NEVER echoed back.
   */
  | { kind: 'issuer_mismatch' }
  /**
   * RFC 9207 mix-up defence, absence case: a remote subject reached the SHARED
   * remote callback but no issuer was pinned at install (`issForCallback` absent),
   * so the callback cannot attribute the code to an authorization server. Fail
   * closed BEFORE the single-use code is exchanged. No value fields.
   */
  | { kind: 'issuer_binding_required' }
  /**
   * A per-server remote callback with no usable configured public origin: its redirect
   * URI cannot be rebuilt byte-for-byte, so the code is not exchanged.
   */
  | { kind: 'callback_base_url_unconfigured' }
  | { kind: 'unknown_oauth_client' }
  | { kind: 'recipe_not_found' }
  /** mcp subject: the McpServer named in the signed state does not exist / is not OAuth. */
  | { kind: 'server_not_found' }
  /**
   * mcp subject with `grantScope='context'` but no authoritative `spec.contextRef`
   * — the shared grant coordinate is unresolvable, so there is nothing safe to
   * persist. Fail closed (mini-spec 05 §2).
   */
  | { kind: 'server_missing_context' }
  /**
   * mcp subject with `grantScope='context'` where the consenting (signed) user
   * is NOT a member of the server's Context. A shared grant lends a team-wide
   * credential, so a non-member must not be able to bootstrap it. Fail closed →
   * 403, no persist.
   */
  | { kind: 'context_membership_denied' }
  /**
   * mcp subject whose remote `spec.oauth` the runtime cannot honor (public client
   * with secret refs, or bearerInBody). Fail closed BEFORE the code is exchanged.
   */
  | { kind: 'remote_oauth_spec_incoherent'; reason: RemoteOAuthSpecIncoherence }
  | { kind: 'secret_missing'; secret: string }
  | { kind: 'unsupported_provider'; provider: string }
  | { kind: 'provider_token_exchange_failed'; status: number; body: string }
  | { kind: 'provider_response_invalid'; detail: string }

const BINDING_MISMATCH = { kind: 'invalid_state', reason: 'binding_mismatch' } as const

/**
 * Run the full callback flow. Pure relative to its `CallbackDeps` so tests
 * inject stub readers / fetch / db.
 */
export async function handleOAuthCallback(
  input: CallbackInput,
  deps: CallbackDeps
): Promise<CallbackResult> {
  // ─── 1. Verify state signature, recover binding from the claims ───────
  // The callback URL no longer carries the subject coordinates — they are
  // recovered from the signed, unforgeable state. Whatever the URL does carry is
  // cross-checked against the claims: the subject identity itself needs no such
  // check (the HMAC guarantees it), but the URL is where the AS delivered the code,
  // and on the per-server remote callback that location IS the mix-up defence.
  const verified = verifyOAuthStateSignature(deps.stateSecret, input.state)
  if (verified.kind !== 'ok') {
    return { kind: 'invalid_state', reason: verified.kind }
  }
  const claims = verified.claims
  const target = input.target

  if (claims.subjectKind === 'mcp') {
    // `/oauth-callback/<id>`: the segment must be the signed client id.
    if (target.kind === 'client' && claims.oauthClientId !== target.id) return BINDING_MISMATCH
    // `/remote/<serverName>/…`: a code delivered to one server's URI must never be
    // attributed to another, and this is decided before the CR the state names is even
    // read — an AS that redirects to `a` with `b`'s state learns nothing about `b`.
    if (target.kind === 'remote-per-server' && claims.mcpServerName !== target.serverName) {
      return BINDING_MISMATCH
    }
    return handleMcpOAuthCallback(claims, input, deps)
  }

  // Recipe subject. The per-server URI only exists for remote mcp servers. A recipe
  // client may legitimately be named `remote` (operator-authored id), so the shared
  // path keeps the segment==id rule for it, over the same bytes it always used.
  let recipeRedirectUri: string
  let segmentId: string
  if (target.kind === 'client') {
    segmentId = target.id
    recipeRedirectUri = target.redirectUri
  } else if (target.kind === 'remote-shared') {
    segmentId = REMOTE_CALLBACK_CLIENT_SEGMENT
    recipeRedirectUri = buildRemoteRedirectUri({ origin: target.origin, variant: 'shared' })
  } else {
    return BINDING_MISMATCH
  }
  if (claims.oauthClientId !== segmentId) return BINDING_MISMATCH

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

  const clientDecl = resolveExactRecipeOAuthClient(recipe, oauthClientId)
  if (!clientDecl) return { kind: 'unknown_oauth_client' }

  // ─── 3-4. Read secrets + exchange code ────────────────────────────────
  const exchanged = await exchangeAuthCode(
    clientDecl,
    recipeNamespace,
    undefined,
    { code: input.code, state: input.state, redirectUri: recipeRedirectUri },
    deps
  )
  if (exchanged.kind !== 'ok') return exchanged
  const { provider, parsed } = exchanged

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

/**
 * mcp-subject callback (U5). The signed state binds the initiating `userId` and
 * the `mcpServerName`; the server's OAuth declaration + grant-scope routing are
 * recovered fresh from the CR (authoritative), NOT from the state or any body.
 *
 * Persistence connects to the U1 store primitives (no reimplementation):
 *   - `grantScope='user'`    → `upsertOAuthGrant` `(mcpserver, ns, name, userId)`.
 *   - `grantScope='context'` → `bootstrapSharedOAuthGrant` `(mcpserver, ns, name,
 *     spec.contextRef)`, bootstrapper = the signed `userId` (first-consent wins;
 *     U6 governance). The Context comes from the AUTHORITATIVE `spec.contextRef`,
 *     never the state — so no context field is (or needs to be) bound into the
 *     mcp state in v1.
 */
async function handleMcpOAuthCallback(
  claims: OAuthMcpStateClaims,
  input: CallbackInput,
  deps: CallbackDeps
): Promise<CallbackResult> {
  // Fail closed: an mcp state cannot be processed without an mcp reader wired.
  if (!deps.mcpServerReader) return { kind: 'server_not_found' }

  let subject: McpServerOAuthSubject | null
  try {
    subject = await deps.mcpServerReader.read(claims.mcpServerName)
  } catch (err) {
    if (err instanceof RecipeNotFoundError) return { kind: 'server_not_found' }
    if (err instanceof RemoteOAuthSpecIncoherentError) {
      return { kind: 'remote_oauth_spec_incoherent', reason: err.reason }
    }
    throw err
  }
  if (!subject) return { kind: 'server_not_found' }

  // Defence in depth: the resolved server's declared oauthClient must match the
  // client id bound in the signed state. Checked against `claims.oauthClientId`
  // because on the remote callbacks the URL carries no client id at all.
  if (subject.decl.id !== claims.oauthClientId) return BINDING_MISMATCH

  // The callback URL must be the one this server's lane registers, in both
  // directions: remote servers only ever register a remote URI, and the remote
  // URIs waive the segment==id rule on the strength of checks (issuer, per-server
  // binding) that only exist for remote servers. A baked/generic server that owns
  // the reserved id, or a remote server reached through `/oauth-callback/<id>`,
  // fails closed instead of leaving the AS's own redirect_uri comparison — which
  // the generic lane cannot rely on — as the only binding.
  const target = input.target
  const remote = subject.decl.remote
  const reachedOnRemoteUri = target.kind !== 'client'
  if (reachedOnRemoteUri !== Boolean(remote)) return BINDING_MISMATCH

  let redirectUri: string
  if (target.kind === 'client') {
    redirectUri = target.redirectUri
  } else if (target.kind === 'remote-shared') {
    const rejected = checkSharedCallbackIssuer(remote as RemoteClientRouting, input.iss)
    if (rejected) return rejected
    redirectUri = buildRemoteRedirectUri({ origin: target.origin, variant: 'shared' })
  } else {
    const perServer = await checkPerServerCallback(
      subject,
      claims.mcpServerName,
      target,
      input.iss,
      deps.db
    )
    if (perServer.kind !== 'ok') return perServer
    redirectUri = perServer.redirectUri
  }

  // ─── Membership guards run BEFORE the token exchange (R3-L1) ──────────────
  // These guards depend only on the signed claims + the resolved subject
  // (`subject.contextRef`, `deps.userContextsReader`, `claims.userId`) — never
  // on the token. Running them first means a user removed from the Context
  // during the ~600s mint→callback window fails here instead of first driving
  // `exchangeAuthCode`, which burns the single-use auth-code against the
  // provider and yields a real token only to discard it at a 403. The mint is
  // still the primary gate, so this is not exploitable head-on; it just avoids
  // the pointless exchange + code burn. Persistence (below) stays after the
  // exchange, unchanged.
  //
  // `contextRef` is set iff this is a context-scoped grant that passed the
  // membership guard; the persistence dispatch below keys off it (non-undefined
  // ⇒ shared bootstrap), which also re-narrows it to `string` without a `!`.
  let contextRef: string | undefined
  if (subject.grantScope === 'context') {
    // Shared identity — the coordinate is the server's authoritative contextRef.
    // Without it there is nothing safe to key the grant on: fail closed.
    if (!subject.contextRef) return { kind: 'server_missing_context' }
    // Defence in depth: a shared grant lends a team-wide credential to every
    // member of the Context, so the consenting (signed) user must be a member
    // of that Context before we let them bootstrap it. Fail closed when the
    // membership reader is unwired or the user is not a member — NEVER persist.
    if (!deps.userContextsReader) return { kind: 'context_membership_denied' }
    const { contextIds } = await deps.userContextsReader(claims.userId)
    if (!contextIds.includes(subject.contextRef)) {
      return { kind: 'context_membership_denied' }
    }
    contextRef = subject.contextRef
  }

  const exchanged = await exchangeAuthCode(
    subject.decl,
    subject.namespace,
    { name: claims.mcpServerName, crUid: subject.crUid },
    { code: input.code, state: input.state, redirectUri },
    deps
  )
  if (exchanged.kind !== 'ok') return exchanged
  const { provider, parsed } = exchanged

  if (contextRef !== undefined) {
    // Context-scoped grant, membership already verified above.
    await bootstrapSharedOAuthGrant(deps.db, deps.encryptionKey, {
      ownerKind: 'mcpserver',
      recipeNamespace: subject.namespace,
      recipeName: claims.mcpServerName,
      contextId: contextRef,
      // Grant coordinate = the resolved client id (`oauth.id`), NEVER the URL: the
      // remote callbacks carry no client id in it. `subject.decl.id ===
      // claims.oauthClientId` (checked above), and it matches what the token broker
      // keys by (`resolveServerOAuth`, D4).
      oauthClientId: subject.decl.id,
      // Bootstrapper = the signed initiator. Audit-only, first-wins on conflict.
      bootstrappedByUserId: claims.userId,
      provider,
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      accessTokenExpiresInSec: parsed.expiresIn,
      // Seal to this installation so a same-name reinstall's teardown never purges it.
      crUid: subject.crUid,
    })
  } else {
    await upsertOAuthGrant(deps.db, deps.encryptionKey, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: subject.namespace,
      recipeName: claims.mcpServerName,
      userId: claims.userId,
      // See the shared-grant branch: coordinate is `oauth.id`, not the URL segment.
      oauthClientId: subject.decl.id,
      provider,
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      accessTokenExpiresInSec: parsed.expiresIn,
      // Seal to this installation so a same-name reinstall's teardown never purges it.
      crUid: subject.crUid,
    })
  }

  return {
    kind: 'ok',
    provider,
    userId: claims.userId,
    grantKind: claims.grantKind,
    // mcp interactive consent never captures background; the broker resolves
    // tokens JIT against a live session.
    backgroundRequested: false,
    backgroundEnabled: false,
    source: 'mcp',
    // Authoritative — from the signed state, never a body param. Lets the
    // desktop correlate which suspended task to resume.
    mcpServerName: claims.mcpServerName,
  }
}

/**
 * RFC 9207 check of the shared remote callback. The shared URI carries no per-server
 * binding, so `iss` is the only thing that attributes a code to the AS that minted it:
 * pinned at discovery (`issForCallback`) and required to match exactly, before the
 * single-use code is exchanged.
 *
 * Fails closed when the server pinned no issuer. The shared callback serves every
 * remote server, so whether the check runs must not depend on the resolved AS's own
 * metadata: a malicious installed AS that omitted `iss` could otherwise relay the user
 * to an honest AS sharing this redirect/state/PKCE and have the honest code attributed
 * to itself. Such a server belongs on its per-server URI instead.
 */
function checkSharedCallbackIssuer(
  remote: RemoteClientRouting,
  rawIss: unknown
): { kind: 'issuer_binding_required' } | { kind: 'issuer_mismatch' } | null {
  const expectedIss = remote.issForCallback
  if (typeof expectedIss !== 'string' || expectedIss.length === 0) {
    return { kind: 'issuer_binding_required' }
  }
  // Anything but a string (repeated or bracketed parameter) reads as absent, and
  // absent never matches a pinned issuer.
  const iss = typeof rawIss === 'string' ? rawIss : undefined
  return iss === expectedIss ? null : { kind: 'issuer_mismatch' }
}

type PerServerCheckResult =
  | { kind: 'ok'; redirectUri: string }
  | { kind: 'invalid_state'; reason: 'binding_mismatch' }
  | { kind: 'issuer_mismatch' }
  | { kind: 'callback_base_url_unconfigured' }

/**
 * Checks of the per-server remote callback (`/remote/<serverName>[/<installNonce>]`),
 * for an AS that does not return RFC 9207 `iss`. The server name was already matched
 * to the signed state before the CR was read; here:
 *
 *   1. the CR must use the per-server variant — a server whose AS returns `iss` is
 *      bound by it on the shared callback and must never be reachable here;
 *   2. the URI must be the one this installation registered: for DCR, the nonce of the
 *      row bound to this CR; for pre-registered, no nonce (the mode comes from the CR);
 *   3. an `iss` the AS sends anyway must be the pinned issuer — but it cannot be
 *      required, which is why this variant exists;
 *   4. the redirect URI for the exchange is rebuilt from the signed server name and the
 *      stored registration, not from the request path.
 */
async function checkPerServerCallback(
  subject: McpServerOAuthSubject,
  serverName: string,
  target: Extract<CallbackTarget, { kind: 'remote-per-server' }>,
  rawIss: unknown,
  db: DbClient
): Promise<PerServerCheckResult> {
  const remote = subject.decl.remote as RemoteClientRouting
  if (remoteCallbackVariant(remote) !== 'per-server') return BINDING_MISMATCH

  const registration = await resolvePerServerRegistration(db, subject, serverName)
  if (!registration) return BINDING_MISMATCH
  const expectedNonce = registration.mode === 'dcr' ? registration.installNonce : undefined
  if (target.installNonce !== expectedNonce) return BINDING_MISMATCH

  const issRejection = perServerIssRejection(rawIss, remote.issuer)
  if (issRejection) {
    // Only the server and the reason: the query also carries `code` and `state`,
    // which the log redaction does not cover.
    log.warn({ serverName, reason: issRejection }, 'per-server oauth callback iss rejected')
    return { kind: 'issuer_mismatch' }
  }

  if (target.origin === null) return { kind: 'callback_base_url_unconfigured' }
  try {
    return {
      kind: 'ok',
      redirectUri: buildPerServerRedirectUri(target.origin, serverName, registration),
    }
  } catch (err) {
    if (err instanceof InvalidRemoteRedirectUriInputError) {
      return { kind: 'callback_base_url_unconfigured' }
    }
    throw err
  }
}

/**
 * Validate an `iss` the AS sent on a per-server callback. Absent is fine; a present
 * value must be a single non-empty string equal to the pinned issuer. A repeated,
 * bracketed or empty parameter is rejected rather than read as absent, so an attacker
 * who can append to the query cannot turn a wrong issuer into "no issuer".
 */
function perServerIssRejection(
  rawIss: unknown,
  pinnedIssuer: string | undefined
): 'iss_malformed' | 'iss_mismatch' | null {
  if (rawIss === undefined) return null
  if (typeof rawIss !== 'string' || rawIss.length === 0) return 'iss_malformed'
  return rawIss === pinnedIssuer ? null : 'iss_mismatch'
}

/** The authorization-code grant a callback redeems, with the redirect URI to replay. */
interface AuthCodeGrant {
  code: string
  state: string
  redirectUri: string
}

type ExchangeAuthCodeResult =
  | { kind: 'ok'; provider: GrantProviderLabel; parsed: ParsedTokenResponse }
  | { kind: 'unknown_oauth_client' }
  | { kind: 'secret_missing'; secret: string }
  | { kind: 'unsupported_provider'; provider: string }
  | { kind: 'provider_token_exchange_failed'; status: number; body: string }
  | { kind: 'provider_response_invalid'; detail: string }

/**
 * Read the (clientId, clientSecret) Secrets for a declaration, then exchange the
 * auth code with the provider. Shared verbatim by the recipe and mcp callbacks
 * so the token-exchange rule lives once (D4). The recipe path's observable
 * result kinds and ordering are unchanged.
 */
async function exchangeAuthCode(
  decl: OAuthClientDecl,
  secretNamespace: string,
  /** mcp-server owner (dynamic-client coordinate + installation); undefined for the recipe lane. */
  owner: RemoteCredentialOwner | undefined,
  grant: AuthCodeGrant,
  deps: CallbackDeps
): Promise<ExchangeAuthCodeResult> {
  // Remote lane (`source:'remote'`): discovery-derived endpoint ⇒ IP-pinned POST
  // (DEC-17), public token client, credentials per `secretSource`. Byte-identical
  // baked path is below (unchanged).
  if (decl.remote) {
    return exchangeRemoteAuthCode(decl, secretNamespace, owner, grant, deps)
  }

  // Generic self-hosted lane (`source:'generic'`): knob-configured request over
  // the same IP-pinned POST (DEC-17). Credentials per `secretSource` (public or
  // k8s-secret). Baked path is below (unchanged).
  if (decl.generic) {
    return exchangeGenericAuthCode(decl, secretNamespace, owner, grant, deps)
  }

  // Baked/recipe lane. clientIdRef is always present here (remote is the only
  // decl that omits it); guard fail-closed rather than dereference undefined.
  if (!decl.clientIdRef) {
    return { kind: 'secret_missing', secret: `${decl.id}/client_id` }
  }
  const clientIdRef = decl.clientIdRef
  let clientIdSecret: Record<string, string>
  try {
    clientIdSecret = await deps.secretReader.read(clientIdRef.name, secretNamespace)
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

  // Public client (E-19.2): no clientSecretRef ⇒ skip the second Secret read and
  // exchange without a client_secret. When a ref is present the confidential
  // path is unchanged (same read, same fail-closed on missing Secret/key).
  let clientSecret: string | undefined
  if (decl.clientSecretRef) {
    let clientSecretSecret: Record<string, string>
    try {
      clientSecretSecret = await deps.secretReader.read(decl.clientSecretRef.name, secretNamespace)
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

  const provider = decl.provider
  if (!isKnownOAuthProvider(provider)) {
    return { kind: 'unsupported_provider', provider }
  }
  const adapter = getOAuthProviderAdapter(provider)
  // PKCE (DEC-1): re-derive the verifier from the EXACT round-tripped state
  // string — the same signed value the authorize URL derived its challenge from.
  const codeVerifier = adapter.usesPkce
    ? deriveCodeVerifier(deps.stateSecret, grant.state)
    : undefined

  try {
    // Build INSIDE the try: a confidential-only baked adapter (notion/monday/
    // clickup) throws when handed a public (secret-less) decl. Keeping the build
    // inside the catch turns that into a typed `provider_response_invalid` (fail
    // closed, no token) instead of an opaque 500 — symmetric with tokenHelper's
    // wrapped `buildRefreshRequest`.
    const tokenRequest = adapter.buildTokenRequest({
      code: grant.code,
      clientId,
      clientSecret,
      redirectUri: grant.redirectUri,
      codeVerifier,
    })
    const response = await deps.fetchFn(tokenRequest.url, {
      method: tokenRequest.method,
      headers: tokenRequest.headers,
      body: tokenRequest.body,
      signal: AbortSignal.timeout(deps.tokenRequestTimeoutMs ?? 15_000),
    })
    if (!response.ok) {
      const body = await safeReadText(response)
      return { kind: 'provider_token_exchange_failed', status: response.status, body }
    }
    const responseJson = await response.json()
    return { kind: 'ok', provider, parsed: adapter.parseTokenResponse(responseJson) }
  } catch (err) {
    return { kind: 'provider_response_invalid', detail: (err as Error).message }
  }
}

/**
 * Remote-lane auth-code exchange (`source:'remote'`). Discovery-derived token
 * endpoint ⇒ IP-pinned POST (DEC-17, closes the H2 DNS-rebinding TOCTOU). Public
 * token client with credentials resolved per `secretSource`. Always PKCE S256.
 */
async function exchangeRemoteAuthCode(
  decl: OAuthClientDecl,
  secretNamespace: string,
  owner: RemoteCredentialOwner | undefined,
  grant: AuthCodeGrant,
  deps: CallbackDeps
): Promise<ExchangeAuthCodeResult> {
  // `decl.remote` presence is the branch guard in the caller.
  const remote = decl.remote as RemoteClientRouting
  const credResult = await resolveRemoteClientCredential(decl, secretNamespace, owner, deps)
  if (!credResult.ok) return { kind: 'secret_missing', secret: credResult.secret }

  // PKCE (DEC-1 / §6 #3): the remote lane is ALWAYS S256 — re-derive the verifier
  // from the exact round-tripped state, same as the baked PKCE adapters.
  const codeVerifier = deriveCodeVerifier(deps.stateSecret, grant.state)
  const tokenRequest = buildRemoteTokenRequest(
    remote.tokenEndpoint,
    {
      code: grant.code,
      clientId: credResult.cred.clientId,
      clientSecret: credResult.cred.clientSecret,
      redirectUri: grant.redirectUri,
      codeVerifier,
    },
    remote.resource
  )
  const posted = await postRemoteTokenForm(
    remote.tokenEndpoint,
    'spec.oauth.tokenEndpoint',
    tokenRequest,
    {
      resolveDns: deps.resolveDns,
      pinnedTransport: deps.pinnedTransport,
      timeoutMs: deps.tokenRequestTimeoutMs,
    }
  )
  if (!posted.ok) {
    if (typeof posted.status === 'number') {
      return { kind: 'provider_token_exchange_failed', status: posted.status, body: posted.detail }
    }
    return { kind: 'provider_response_invalid', detail: posted.detail }
  }
  try {
    return {
      kind: 'ok',
      provider: 'remote',
      parsed: parseRemoteTokenResponse(JSON.parse(posted.bodyText)),
    }
  } catch (err) {
    return { kind: 'provider_response_invalid', detail: (err as Error).message }
  }
}

/**
 * Generic-lane auth-code exchange (`source:'generic'`, DEC-28). Operator-pinned
 * token endpoint ⇒ IP-pinned POST (DEC-17). The request is composed from the CR
 * knobs via `buildAdapterFromConfig`; credentials come from `secretSource`
 * (public ⇒ no `client_secret`; k8s-secret ⇒ both read from the named Secret).
 * PKCE is gated on the `usePkce` knob.
 */
async function exchangeGenericAuthCode(
  decl: OAuthClientDecl,
  secretNamespace: string,
  owner: RemoteCredentialOwner | undefined,
  grant: AuthCodeGrant,
  deps: CallbackDeps
): Promise<ExchangeAuthCodeResult> {
  // `decl.generic` presence is the branch guard in the caller.
  const generic = decl.generic as GenericClientRouting
  const credResult = await resolveRemoteClientCredential(decl, secretNamespace, owner, deps)
  if (!credResult.ok) return { kind: 'secret_missing', secret: credResult.secret }

  const adapter = buildAdapterFromConfig(generic)
  // PKCE gated on the knob: re-derive the verifier from the exact round-tripped
  // state (the authorize URL derived its challenge from the same value).
  const codeVerifier = generic.usePkce
    ? deriveCodeVerifier(deps.stateSecret, grant.state)
    : undefined

  let tokenRequest: ReturnType<typeof adapter.buildTokenRequest>
  try {
    // The build can throw (e.g. tokenAuthMethod=basic on a secret-less client) —
    // turn that into a typed fail-closed result, never an opaque 500.
    tokenRequest = adapter.buildTokenRequest({
      code: grant.code,
      clientId: credResult.cred.clientId,
      clientSecret: credResult.cred.clientSecret,
      redirectUri: grant.redirectUri,
      codeVerifier,
    })
  } catch (err) {
    return { kind: 'provider_response_invalid', detail: (err as Error).message }
  }

  const posted = await postRemoteTokenForm(
    tokenRequest.url,
    'spec.oauth.tokenEndpoint',
    tokenRequest,
    {
      resolveDns: deps.resolveDns,
      pinnedTransport: deps.pinnedTransport,
      timeoutMs: deps.tokenRequestTimeoutMs,
    }
  )
  if (!posted.ok) {
    if (typeof posted.status === 'number') {
      return { kind: 'provider_token_exchange_failed', status: posted.status, body: posted.detail }
    }
    return { kind: 'provider_response_invalid', detail: posted.detail }
  }
  try {
    return {
      kind: 'ok',
      provider: 'generic',
      parsed: adapter.parseTokenResponse(JSON.parse(posted.bodyText)),
    }
  } catch (err) {
    return { kind: 'provider_response_invalid', detail: (err as Error).message }
  }
}

/** Resolved remote client credentials for a token/refresh POST. */
export interface RemoteClientCredential {
  clientId: string
  /** Absent for a public client. */
  clientSecret?: string
}

export type RemoteCredentialResult =
  | { ok: true; cred: RemoteClientCredential }
  | { ok: false; secret: string }

/** The McpServer whose `dynamic_clients` row holds a DCR client's credentials. */
export interface RemoteCredentialOwner {
  /** McpServer name — the `dynamic_clients` coordinate. */
  name: string
  /** metadata.uid of the live CR; undefined when the reader saw none. */
  crUid: string | undefined
}

/**
 * Resolve the remote client's `(clientId, clientSecret)` from the `secretSource`
 * discriminator (DEC-18) — the SINGLE place the three remote secret sources are
 * read, shared by the exchange (here) and the refresh (`tokenHelper.ts`) so the
 * two never drift (D4). Never logs or returns secret material on the error path
 * (names only). `owner` locates the `dynamic_clients` row (DCR only).
 *
 * A DCR row is used only when it is not yet bound (`cr_uid` NULL — pending
 * between the CR create and the bind, or legacy) or bound to `owner.crUid`. A row
 * bound to another uid belongs to a gone installation of the same name and is
 * treated as absent. The check lives here rather than in `getDynamicClient`
 * because the install saga must still see every row to classify and reclaim it.
 */
export async function resolveRemoteClientCredential(
  decl: OAuthClientDecl,
  secretNamespace: string,
  owner: RemoteCredentialOwner | undefined,
  deps: { db: DbClient; encryptionKey: Buffer; secretReader: SecretReader }
): Promise<RemoteCredentialResult> {
  const source = decl.secretSource
  // A remote decl always carries a secretSource; fail closed if it somehow does not.
  if (!source) return { ok: false, secret: `${decl.id}/secret_source_missing` }
  if (source.kind === 'public') {
    // CIMD/DCR-public: the public client_id IS `oauth.id`; no secret.
    return { ok: true, cred: { clientId: decl.id } }
  }
  if (source.kind === 'dcr-store') {
    if (!owner) return { ok: false, secret: `dynamic_clients/${decl.id}` }
    const row = await getDynamicClient(deps.db, deps.encryptionKey, {
      serverNamespace: secretNamespace,
      serverName: owner.name,
    })
    if (!row || (row.crUid !== undefined && row.crUid !== owner.crUid)) {
      return { ok: false, secret: `dynamic_clients/${owner.name}` }
    }
    if (!row.clientSecret) {
      return { ok: false, secret: `dynamic_clients/${owner.name}/client_secret` }
    }
    return { ok: true, cred: { clientId: row.clientId, clientSecret: row.clientSecret } }
  }
  // k8s-secret: pre-registered confidential — read both keys from the named Secret.
  const { clientIdRef, clientSecretRef } = source
  let idSecret: Record<string, string>
  try {
    idSecret = await deps.secretReader.read(clientIdRef.name, secretNamespace)
  } catch (err) {
    if (err instanceof SecretNotFoundError) return { ok: false, secret: clientIdRef.name }
    throw err
  }
  const clientId = idSecret[clientIdRef.key]
  if (!clientId) return { ok: false, secret: `${clientIdRef.name}/${clientIdRef.key}` }
  let secSecret: Record<string, string>
  try {
    secSecret = await deps.secretReader.read(clientSecretRef.name, secretNamespace)
  } catch (err) {
    if (err instanceof SecretNotFoundError) return { ok: false, secret: clientSecretRef.name }
    throw err
  }
  const clientSecret = secSecret[clientSecretRef.key]
  if (!clientSecret) return { ok: false, secret: `${clientSecretRef.name}/${clientSecretRef.key}` }
  return { ok: true, cred: { clientId, clientSecret } }
}

export type RemotePostResult =
  | { ok: true; bodyText: string }
  | { ok: false; status?: number; detail: string }

/**
 * POST a token/refresh request to a discovery-derived (remote) or operator-pinned
 * (generic) endpoint through the IP-pinned `pinnedFetch` (DEC-17). Body-agnostic:
 * the builder owns the `content-type` (`application/x-www-form-urlencoded` for the
 * remote/baked and generic form path, `application/json` for a generic
 * `tokenRequestFormat:'json'` server); this helper only adds `content-length` (the
 * pinned `node:https` transport needs an explicit length rather than chunked) from
 * `Buffer.byteLength` of the builder's body. Any pin-level
 * failure (kernel-rejected, transport, non-identity encoding) is a fail-closed
 * `ok:false` with a NAME-only detail — never secret material. Shared by exchange
 * + refresh (D4).
 */
export async function postRemoteTokenForm(
  url: string,
  field: string,
  tokenRequest: { headers: Record<string, string>; body: string },
  deps: { resolveDns?: DnsResolver; pinnedTransport?: PinnedTransport; timeoutMs?: number }
): Promise<RemotePostResult> {
  const headers = {
    ...tokenRequest.headers,
    'content-length': String(Buffer.byteLength(tokenRequest.body)),
  }
  const result = await pinnedFetch(url, field, {
    method: 'POST',
    headers,
    body: tokenRequest.body,
    resolveDns: deps.resolveDns,
    transport: deps.pinnedTransport,
    timeoutMs: deps.timeoutMs ?? 15_000,
  })
  if (!result.ok) return { ok: false, detail: result.error.kind }
  const { status, bodyText } = result.response
  if (status < 200 || status >= 300) return { ok: false, status, detail: bodyText.slice(0, 2000) }
  return { ok: true, bodyText }
}

// ─── helpers ──────────────────────────────────────────────────────────────

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 2000)
  } catch {
    return ''
  }
}

// Re-export for the route layer's convenience.
export { signOAuthState }
