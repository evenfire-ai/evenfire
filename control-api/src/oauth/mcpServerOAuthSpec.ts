/**
 * Shared reader for an OAuth McpServer's `spec.oauth` declaration.
 *
 * The grant-scope / oauthClientId / contextRef derivation is a security-relevant
 * rule (it decides WHICH grant coordinate governs a server). It is consumed by
 * two seams that must never drift apart (D4):
 *   - the token broker (`routes/mcpOauth.ts`) — the LLM/tool-call rail;
 *   - the rpc-proxy grant-presence gate (`services/access/mcpInvocable.ts`).
 * Both read the SAME fields the SAME way, so the rule lives here once.
 */
import type { GetOAuthGrantInput } from './store.js'

export interface McpServerOAuthDecl {
  id?: unknown
  provider?: unknown
  clientIdRef?: { name?: unknown; key?: unknown }
  clientSecretRef?: { name?: unknown; key?: unknown }
  scopes?: unknown
  backgroundAccess?: unknown
  grantScope?: unknown
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

/**
 * Build the `oauth_grants` key for an OAuth mcp-server, BY FLAVOR — the single
 * construction shared by every seam that touches a server's grant row (D4/F2):
 *   - the rpc-proxy grant-presence gate (`computeGrantPresence`) — read;
 *   - the end-user disconnect endpoint (`internal/oauth.ts`) — delete.
 * Keeping the key derivation here (next to `resolveServerOAuth`) means the two
 * never drift, and a `grantScope` we don't recognize fails closed in ONE place.
 *
 * - `user`    → per-user key `(mcpserver, ns, server, userId, oauthClientId)`.
 * - `context` → shared key `(mcpserver, ns, server, contextRef, oauthClientId)`,
 *   `user_id NULL`; the `contextId` is the server's AUTHORITATIVE `spec.contextRef`
 *   (resolved server-side), NEVER a caller-supplied value.
 *
 * Returns null (fail-closed) when the key cannot be built:
 *   - a `context`-scope server without a `contextRef`, or
 *   - an unrecognized `grantScope`.
 * A null return must be treated as "cannot act on this grant" — never as a
 * broad/blind delete.
 */
export function buildMcpServerGrantKey(
  resolved: Pick<ResolvedServerOAuth, 'grantScope' | 'oauthClientId' | 'contextRef'>,
  coords: { namespace: string; serverName: string; userId: string }
): GetOAuthGrantInput | null {
  if (resolved.grantScope === 'user') {
    return {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: coords.namespace,
      recipeName: coords.serverName,
      userId: coords.userId,
      oauthClientId: resolved.oauthClientId,
    }
  }
  if (resolved.grantScope === 'context') {
    // fail-closed: a context-identity server MUST carry its authoritative Context.
    if (!resolved.contextRef) return null
    return {
      grantKind: 'shared',
      ownerKind: 'mcpserver',
      recipeNamespace: coords.namespace,
      recipeName: coords.serverName,
      contextId: resolved.contextRef,
      oauthClientId: resolved.oauthClientId,
    }
  }
  // Unknown grantScope → fail-closed.
  return null
}

/**
 * The `spec.oauth` declaration in the `oauthClients[]`-compatible shape the
 * consent flow (U5: authorize-URL mint + callback) consumes, plus the grant
 * routing. Structurally assignable to `OAuthClientDecl` (`oauth/callback.ts`) so
 * the same broker/refresh machinery stays owner-agnostic.
 */
export interface ResolvedServerOAuthSubject {
  decl: {
    id: string
    provider: string
    clientIdRef: { name: string; key: string }
    clientSecretRef: { name: string; key: string }
    scopes?: string[]
    backgroundAccess?: boolean
  }
  grantScope: GrantScope
  /** Authoritative Context (spec.contextRef); undefined if absent. */
  contextRef?: string
}

/**
 * Resolve a McpServer's full OAuth subject (decl + grant routing) for the U5
 * consent flow. Returns null when the server carries no usable OAuth
 * declaration (missing id/provider/clientIdRef/clientSecretRef) so callers fail
 * closed. Same field-reading rule as {@link resolveServerOAuth} — kept here so
 * the authorize-URL minter and the callback never drift (D4).
 */
export function resolveServerOAuthSubject(
  server: McpServerOAuthSpecInput
): ResolvedServerOAuthSubject | null {
  const oauth = server.spec?.oauth
  if (!oauth || typeof oauth.id !== 'string' || oauth.id.length === 0) return null
  if (typeof oauth.provider !== 'string' || oauth.provider.length === 0) return null
  const clientIdRef = oauth.clientIdRef
  const clientSecretRef = oauth.clientSecretRef
  if (
    !clientIdRef ||
    typeof clientIdRef.name !== 'string' ||
    typeof clientIdRef.key !== 'string' ||
    !clientSecretRef ||
    typeof clientSecretRef.name !== 'string' ||
    typeof clientSecretRef.key !== 'string'
  ) {
    return null
  }
  const grantScope: GrantScope = oauth.grantScope === 'context' ? 'context' : 'user'
  const contextRef =
    typeof server.spec?.contextRef === 'string' && server.spec.contextRef.length > 0
      ? server.spec.contextRef
      : undefined
  return {
    decl: {
      id: oauth.id,
      provider: oauth.provider,
      clientIdRef: { name: clientIdRef.name, key: clientIdRef.key },
      clientSecretRef: { name: clientSecretRef.name, key: clientSecretRef.key },
      scopes: Array.isArray(oauth.scopes)
        ? oauth.scopes.filter((s): s is string => typeof s === 'string')
        : undefined,
      backgroundAccess: oauth.backgroundAccess === true,
    },
    grantScope,
    contextRef,
  }
}
