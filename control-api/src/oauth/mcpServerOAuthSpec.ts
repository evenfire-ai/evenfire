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
