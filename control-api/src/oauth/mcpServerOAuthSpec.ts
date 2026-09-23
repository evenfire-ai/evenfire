/**
 * Shared reader for an OAuth McpServer's `spec.oauth` declaration.
 *
 * The grant-scope / oauthClientId / contextRef derivation is a security-relevant
 * rule (it decides WHICH grant coordinate governs a server). It is consumed by
 * three seams that must never drift apart (D4):
 *   - the token broker (`routes/mcpOauth.ts`) — the LLM/tool-call rail;
 *   - the rpc-proxy grant-presence gate (`services/access/mcpInvocable.ts`);
 *   - the grant-existence sweep (`routes/mcpOauth.ts`, mini-spec 13) — the
 *     hot-revocation poll.
 * All read the SAME fields the SAME way and derive the SAME `oauth_grants` key
 * (`buildMcpServerGrantKey`), so the rule lives here once.
 */
import type {
  GenericClientRouting,
  OAuthClientDecl,
  RemoteClientRouting,
  ServerOAuthSecretSource,
} from './callback.js'
import type { OAuthGrantKey } from './store.js'

export interface McpServerOAuthDecl {
  id?: unknown
  provider?: unknown
  clientIdRef?: { name?: unknown; key?: unknown }
  clientSecretRef?: { name?: unknown; key?: unknown }
  scopes?: unknown
  backgroundAccess?: unknown
  grantScope?: unknown
  // Remote MCP-OAuth lane (`source:'remote'`, C1.5/C2/C3). Untrusted CR data →
  // every field is validated before use; a malformed remote block fails closed.
  source?: unknown
  clientMode?: unknown
  authorizationEndpoint?: unknown
  tokenEndpoint?: unknown
  resource?: unknown
  bearerInBody?: unknown
  supportsRefresh?: unknown
  issForCallback?: unknown
  // Generic self-hosted lane (`source:'generic'`, DEC-28). Untrusted CR data →
  // every field is validated before use; a malformed generic block fails closed.
  refreshEndpoint?: unknown
  tokenRequestFormat?: unknown
  tokenAuthMethod?: unknown
  scopeSeparator?: unknown
  sendScope?: unknown
  usePkce?: unknown
  includeResponseType?: unknown
  extraAuthorizeParams?: unknown
}

/** Minimal structural shape needed to resolve a server's OAuth grant coordinate. */
export interface McpServerOAuthSpecInput {
  spec?: {
    oauth?: McpServerOAuthDecl
    // `spec.contextRef` is REQUIRED + singular on the CRD ("the context this
    // server belongs to", mcpserver.yaml). It is the AUTHORITATIVE Context of a
    // context-identity server — the shared grant coordinate — never the body.
    contextRef?: unknown
  }
}

export type GrantScope = 'user' | 'context'

export interface ResolvedServerOAuth {
  oauthClientId: string
  grantScope: GrantScope
  /** Authoritative Context of the server (spec.contextRef); undefined if absent. */
  contextRef?: string
}

/**
 * Derive `{ oauthClientId, grantScope, contextRef }` from a McpServer's
 * `spec.oauth`. Returns null when the server carries no usable OAuth id, so
 * callers fail closed. `grantScope` defaults to `'user'` for anything other
 * than the explicit `'context'` sentinel (U1: immutable per server, CEL-guarded).
 */
export function resolveServerOAuth(server: McpServerOAuthSpecInput): ResolvedServerOAuth | null {
  const oauth = server.spec?.oauth
  if (!oauth || typeof oauth.id !== 'string' || oauth.id.length === 0) return null
  const grantScope: GrantScope = oauth.grantScope === 'context' ? 'context' : 'user'
  const contextRef =
    typeof server.spec?.contextRef === 'string' && server.spec.contextRef.length > 0
      ? server.spec.contextRef
      : undefined
  return { oauthClientId: oauth.id, grantScope, contextRef }
}

/** The coordinates the caller supplies to derive an mcp-server grant key. */
export interface McpServerGrantKeyCoords {
  /** McpServer name — reinterpreted as the grant owner's `recipeName`. */
  mcpServerName: string
  /** The mcp-servers namespace — the grant owner's `recipeNamespace`. */
  mcpServersNamespace: string
  /**
   * End-user identity, for `grantScope='user'` servers only. IGNORED for
   * `context` servers, which key by the server's AUTHORITATIVE `contextRef`
   * (server-side), never by any caller-supplied context value.
   */
  userId?: string
}

/**
 * Derive the `oauth_grants` key for an OAuth McpServer by flavor — the SINGLE
 * key derivation shared by the token mint, the rpc-proxy grant-presence gate,
 * the grant-existence sweep, and the end-user disconnect endpoint
 * (`internal/oauth.ts`) — delete (D4: one authority, no drift). Returns null when
 * the coordinate the flavor needs is absent, so every caller decides fail-open
 * vs fail-closed for itself:
 *   - `user`    → needs a non-empty `userId`; null otherwise.
 *   - `context` → keys by the server's AUTHORITATIVE `contextRef` (server-side,
 *                 NEVER a body value); null when the server carries none.
 *
 * It intentionally does NOT read the token or touch the DB — it only maps a
 * resolved OAuth declaration + coordinates to a key.
 */
export function buildMcpServerGrantKey(
  resolved: ResolvedServerOAuth,
  coords: McpServerGrantKeyCoords
): OAuthGrantKey | null {
  if (resolved.grantScope === 'context') {
    // Shared identity is keyed by the server's authoritative Context, decoupled
    // from any caller-supplied userId/contextId (no body-trust).
    if (!resolved.contextRef) return null
    return {
      grantKind: 'shared',
      ownerKind: 'mcpserver',
      recipeNamespace: coords.mcpServersNamespace,
      recipeName: coords.mcpServerName,
      contextId: resolved.contextRef,
      oauthClientId: resolved.oauthClientId,
    }
  }
  if (typeof coords.userId !== 'string' || coords.userId.length === 0) return null
  return {
    grantKind: 'user',
    ownerKind: 'mcpserver',
    recipeNamespace: coords.mcpServersNamespace,
    recipeName: coords.mcpServerName,
    userId: coords.userId,
    oauthClientId: resolved.oauthClientId,
  }
}

/**
 * The `spec.oauth` declaration in the `oauthClients[]`-compatible shape the
 * consent flow (U5: authorize-URL mint + callback) consumes, plus the grant
 * routing. Structurally assignable to `OAuthClientDecl` (`oauth/callback.ts`) so
 * the same broker/refresh machinery stays owner-agnostic.
 */
export interface ResolvedServerOAuthSubject {
  /**
   * The `oauthClients[]`-compatible client decl. For BAKED (no `source`) it is
   * byte-identical to the confidential-K8s shape (id/provider + both refs). For
   * REMOTE (`source:'remote'`) it carries `remote` routing + a `secretSource`
   * discriminator and OMITS `clientSecretRef`/`clientIdRef` unless the mode is
   * pre-registered-confidential (`k8s-secret`).
   */
  decl: OAuthClientDecl
  grantScope: GrantScope
  /** Authoritative Context (spec.contextRef); undefined if absent. */
  contextRef?: string
}

/** Extract + type-validate the remote routing block from an untrusted `spec.oauth`. */
function extractRemoteRouting(oauth: McpServerOAuthDecl): RemoteClientRouting | null {
  const clientMode = oauth.clientMode
  if (clientMode !== 'public' && clientMode !== 'confidential') return null
  const authorizationEndpoint = oauth.authorizationEndpoint
  const tokenEndpoint = oauth.tokenEndpoint
  if (typeof authorizationEndpoint !== 'string' || authorizationEndpoint.length === 0) return null
  if (typeof tokenEndpoint !== 'string' || tokenEndpoint.length === 0) return null
  const resource =
    typeof oauth.resource === 'string' && oauth.resource.length > 0 ? oauth.resource : undefined
  const issForCallback =
    typeof oauth.issForCallback === 'string' && oauth.issForCallback.length > 0
      ? oauth.issForCallback
      : undefined
  return {
    authorizationEndpoint,
    tokenEndpoint,
    resource,
    clientMode,
    bearerInBody: oauth.bearerInBody === true,
    supportsRefresh: oauth.supportsRefresh === true,
    issForCallback,
  }
}

/** Read a nested `{name,key}` ref, returning null unless BOTH are non-empty strings. */
function readRef(
  ref: { name?: unknown; key?: unknown } | undefined
): { name: string; key: string } | null {
  if (!ref || typeof ref.name !== 'string' || typeof ref.key !== 'string') return null
  return { name: ref.name, key: ref.key }
}

/**
 * Classify a remote client's secret source (DEC-18): refs present ⇒ K8s Secret
 * (pre-registered confidential); no refs + confidential ⇒ encrypted DCR store;
 * no refs + public ⇒ no secret.
 */
function resolveRemoteSecretSource(
  oauth: McpServerOAuthDecl,
  clientMode: 'public' | 'confidential'
): ServerOAuthSecretSource {
  const clientIdRef = readRef(oauth.clientIdRef)
  const clientSecretRef = readRef(oauth.clientSecretRef)
  if (clientIdRef && clientSecretRef) {
    return { kind: 'k8s-secret', clientIdRef, clientSecretRef }
  }
  return clientMode === 'confidential' ? { kind: 'dcr-store' } : { kind: 'public' }
}

/** Read the optional `extraAuthorizeParams` map, keeping only string-valued keys. */
function extractExtraAuthorizeParams(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Extract + type-validate the generic routing block from an untrusted `spec.oauth`
 * (DEC-28). The three wire enums (`tokenRequestFormat`/`tokenAuthMethod`/
 * `scopeSeparator`) fail closed to null when malformed; the booleans read as
 * `=== true` (absent ⇒ false), mirroring the remote block's boolean handling.
 */
function extractGenericRouting(oauth: McpServerOAuthDecl): GenericClientRouting | null {
  const authorizationEndpoint = oauth.authorizationEndpoint
  const tokenEndpoint = oauth.tokenEndpoint
  if (typeof authorizationEndpoint !== 'string' || authorizationEndpoint.length === 0) return null
  if (typeof tokenEndpoint !== 'string' || tokenEndpoint.length === 0) return null
  const tokenRequestFormat = oauth.tokenRequestFormat
  if (tokenRequestFormat !== 'form' && tokenRequestFormat !== 'json') return null
  const tokenAuthMethod = oauth.tokenAuthMethod
  if (tokenAuthMethod !== 'body' && tokenAuthMethod !== 'basic') return null
  const scopeSeparator = oauth.scopeSeparator
  if (scopeSeparator !== 'space' && scopeSeparator !== 'comma') return null
  const refreshEndpoint =
    typeof oauth.refreshEndpoint === 'string' && oauth.refreshEndpoint.length > 0
      ? oauth.refreshEndpoint
      : undefined
  const resource =
    typeof oauth.resource === 'string' && oauth.resource.length > 0 ? oauth.resource : undefined
  return {
    authorizationEndpoint,
    tokenEndpoint,
    refreshEndpoint,
    resource,
    tokenRequestFormat,
    tokenAuthMethod,
    scopeSeparator,
    sendScope: oauth.sendScope === true,
    usePkce: oauth.usePkce === true,
    includeResponseType: oauth.includeResponseType === true,
    supportsRefresh: oauth.supportsRefresh === true,
    extraAuthorizeParams: extractExtraAuthorizeParams(oauth.extraAuthorizeParams),
  }
}

/**
 * Classify a generic client's secret source (DEC-28): NEITHER ref ⇒ public (no
 * secret; `client_id` IS `oauth.id`); BOTH refs ⇒ k8s-secret (reuse the shared
 * shape). Exactly one ref is a half-declared config ⇒ null (fail closed), never
 * silently treated as public.
 */
function resolveGenericSecretSource(oauth: McpServerOAuthDecl): ServerOAuthSecretSource | null {
  const clientIdRef = readRef(oauth.clientIdRef)
  const clientSecretRef = readRef(oauth.clientSecretRef)
  if (clientIdRef && clientSecretRef) {
    return { kind: 'k8s-secret', clientIdRef, clientSecretRef }
  }
  if (clientIdRef || clientSecretRef) return null
  return { kind: 'public' }
}

function normalizeScopes(scopes: unknown): string[] | undefined {
  return Array.isArray(scopes)
    ? scopes.filter((s): s is string => typeof s === 'string')
    : undefined
}

/**
 * Resolve a McpServer's full OAuth subject (decl + grant routing) for the U5
 * consent flow. Returns null when the server carries no usable OAuth
 * declaration (missing id/provider/clientIdRef/clientSecretRef) so callers fail
 * closed. Same field-reading rule as {@link resolveServerOAuth} — kept here so
 * the authorize-URL minter and the callback never drift (D4).
 *
 * Two lanes (C4/DEC-23), keyed uniformly by `oauth.id` (the install backfills it
 * for every remote mode, so the grant coordinate is uniform):
 *   - BAKED (no `source`): behaves EXACTLY as before — confidential-K8s, both
 *     refs required, `provider` required; returns the same decl shape. A public
 *     baked mcp-server is still not representable, so nothing reachable changes.
 *   - REMOTE (`source:'remote'`): `provider` is NOT required (no baked adapter);
 *     the decl carries `remote` routing + a `secretSource` discriminator and
 *     drops `clientSecretRef`/`clientIdRef` unless the mode is
 *     pre-registered-confidential. Stays PURE/synchronous — the caller reads the
 *     secret (K8s Secret or `getDynamicClient`) per `secretSource`.
 */
export function resolveServerOAuthSubject(
  server: McpServerOAuthSpecInput
): ResolvedServerOAuthSubject | null {
  const oauth = server.spec?.oauth
  if (!oauth || typeof oauth.id !== 'string' || oauth.id.length === 0) return null
  const grantScope: GrantScope = oauth.grantScope === 'context' ? 'context' : 'user'
  const contextRef =
    typeof server.spec?.contextRef === 'string' && server.spec.contextRef.length > 0
      ? server.spec.contextRef
      : undefined

  // ─── Remote lane (`source:'remote'`) ─────────────────────────────────────
  if (oauth.source === 'remote') {
    const remote = extractRemoteRouting(oauth)
    if (!remote) return null
    const secretSource = resolveRemoteSecretSource(oauth, remote.clientMode)
    const decl: OAuthClientDecl = {
      id: oauth.id,
      // No baked provider on the remote lane; exchange/refresh/authorize branch on
      // `remote` before any provider-adapter lookup. `'remote'` is the persisted /
      // displayed label.
      provider: 'remote',
      scopes: normalizeScopes(oauth.scopes),
      backgroundAccess: oauth.backgroundAccess === true,
      remote,
      secretSource,
    }
    if (secretSource.kind === 'k8s-secret') {
      decl.clientIdRef = secretSource.clientIdRef
      decl.clientSecretRef = secretSource.clientSecretRef
    }
    return { decl, grantScope, contextRef }
  }

  // ─── Generic self-hosted lane (`source:'generic'`, DEC-28) ────────────────
  if (oauth.source === 'generic') {
    const generic = extractGenericRouting(oauth)
    if (!generic) return null
    const secretSource = resolveGenericSecretSource(oauth)
    if (!secretSource) return null
    const decl: OAuthClientDecl = {
      id: oauth.id,
      // No baked provider on the generic lane; exchange/refresh/authorize branch on
      // `generic` before any provider-adapter lookup. `'generic'` is the persisted /
      // displayed label only — it NEVER reaches ADAPTERS/KNOWN_OAUTH_PROVIDERS.
      provider: 'generic',
      scopes: normalizeScopes(oauth.scopes),
      backgroundAccess: oauth.backgroundAccess === true,
      generic,
      secretSource,
    }
    if (secretSource.kind === 'k8s-secret') {
      decl.clientIdRef = secretSource.clientIdRef
      decl.clientSecretRef = secretSource.clientSecretRef
    }
    return { decl, grantScope, contextRef }
  }

  // ─── Baked lane (byte-identical to before) ───────────────────────────────
  if (typeof oauth.provider !== 'string' || oauth.provider.length === 0) return null
  const clientIdRef = readRef(oauth.clientIdRef)
  const clientSecretRef = readRef(oauth.clientSecretRef)
  if (!clientIdRef || !clientSecretRef) return null
  return {
    decl: {
      id: oauth.id,
      provider: oauth.provider,
      clientIdRef,
      clientSecretRef,
      scopes: normalizeScopes(oauth.scopes),
      backgroundAccess: oauth.backgroundAccess === true,
    },
    grantScope,
    contextRef,
  }
}
