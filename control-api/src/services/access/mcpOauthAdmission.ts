import { config } from '../../config.js'
import type { K8sGateway } from '../../k8s.js'
import type { GrantScope } from '../../oauth/mcpServerOAuthSpec.js'
import {
  type ContextRefInput,
  allowedServerNames,
  contextResourceKey,
  loadContextResolution,
  refKey,
} from './contextIdentity.js'
import { type ContextMembershipDirectory, getUserMemberContexts } from './contextMembership.js'

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
 * access via `user_agents`/`team_agents`, plus legacy `user_contexts`). Every
 * reference — each member and the server's own `contextRef` — is resolved to
 * ONE Context resource by `contextIdentity.ts` before any allowlist is read: a
 * Host or McpServer `contextRef` by resource name only (host-context-controller
 * parity), a legacy row also by an unambiguous wire-id alias. An unresolved
 * reference contributes nothing, so another resource's colliding
 * `spec.contextId` can never lend its allowlist or ownership.
 *
 *   - `context` (shared identity): the server's `contextRef` must resolve to a
 *     resource S, and some member must resolve to that same S. A shared grant
 *     lends one credential to everyone in the server's own Context, so a
 *     Context that merely allowlists the server does not qualify.
 *   - `user` (per-user identity): admitted iff some member's resolved Context
 *     lists the server in `spec.mcpServers` — the same allowlist, resolved the
 *     same way, that makes the connectors panel offer the server
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
  const { members } = await getUserMemberContexts(gateway, userId, directory)
  if (members.length === 0) return false

  const serverRef: ContextRefInput = { ref: server.contextRef, origin: 'server' }
  const resolution = await loadContextResolution(gateway, config.mcpServersNamespace, [
    ...members,
    serverRef,
  ])
  const memberResources = members.flatMap(member => {
    const resolved = resolution.get(refKey(member))
    return resolved?.resource ? [resolved.resource] : []
  })

  if (server.grantScope === 'context') {
    const owner = resolution.get(refKey(serverRef))
    if (!owner?.resource) return false
    const ownerKey = contextResourceKey(owner.resource)
    return memberResources.some(resource => contextResourceKey(resource) === ownerKey)
  }

  const name = server.name.trim()
  return memberResources.some(resource => allowedServerNames(resource).has(name))
}
