import { config } from '../../config.js'
import type { K8sGateway } from '../../k8s.js'
import type { GrantScope } from '../../oauth/mcpServerOAuthSpec.js'
import { type ContextMembershipDirectory, getUserMemberContexts } from './contextMembership.js'
import { loadAllowedNamesByContext } from './mcpInvocable.js'

/** The server coordinates consent admission needs — all read from the McpServer CR. */
export interface McpOAuthConsentServer {
  name: string
  grantScope: GrantScope
  /** The server's authoritative `spec.contextRef`; undefined if absent. */
  contextRef?: string
}

/**
 * Whether `userId` may start, complete, or revoke OAuth consent for an MCP
 * server (PR #1004). The ONE rule shared by the authorize-URL mint, the
 * disconnect endpoint, and the callback, so the three cannot drift.
 *
 * M = the Contexts the user is a member of (`getUserMemberContexts`: agent
 * access via `user_agents`/`team_agents`, plus legacy `user_contexts`).
 *
 *   - `context` (shared identity): admitted iff `contextRef ∈ M`. A shared
 *     grant lends one credential to everyone in the server's own Context, so a
 *     Context that merely allowlists the server does not qualify.
 *   - `user` (per-user identity): admitted iff some Context in M lists the
 *     server in `spec.mcpServers` — the same allowlist, read by the same
 *     loader, that makes the connectors panel offer the server
 *     (`resolveConnectorsForAgents`). The per-user grant is keyed by the user
 *     alone, so membership of the server's owner Context is irrelevant and is
 *     NOT a fallback.
 *
 * Deliberately NOT `resolveInvocableMcpServersForContexts`: that applies the
 * grant-presence gate, which drops exactly the un-granted servers consent
 * exists to bootstrap.
 *
 * Fail closed: a server without a `contextRef` (CRD-required, so only a
 * malformed CR) is never admitted. Directory/Kubernetes errors propagate so an
 * outage is not reported as a denial.
 */
export async function authorizeMcpOAuthConsent(
  gateway: K8sGateway,
  userId: string,
  server: McpOAuthConsentServer,
  directory?: ContextMembershipDirectory
): Promise<boolean> {
  if (!server.contextRef) return false
  const { contextIds } = await getUserMemberContexts(gateway, userId, directory)
  if (server.grantScope === 'context') return contextIds.includes(server.contextRef)

  if (contextIds.length === 0) return false
  const allowedByContext = await loadAllowedNamesByContext(
    gateway,
    config.mcpServersNamespace,
    new Set(contextIds)
  )
  const name = server.name.trim()
  for (const allowed of allowedByContext.values()) {
    if (allowed.has(name)) return true
  }
  return false
}
