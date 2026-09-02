import type { HostResource } from './api'

export type AgentAccessUpdatePlan = {
  agentNames: string[]
  contextIds: string[]
}

/**
 * Applies the authoritative Agent CAS before its legacy Context compatibility
 * write. A stale Agent snapshot must fail before any Context grant can change.
 */
export async function applyAgentAccessCompatibilityUpdate<AgentResult, ContextResult>(
  updateAgents: () => Promise<AgentResult>,
  updateContexts: () => Promise<ContextResult>
): Promise<[AgentResult, ContextResult]> {
  const updatedAgents = await updateAgents()
  const updatedContexts = await updateContexts()
  return [updatedAgents, updatedContexts]
}

function hostName(host: HostResource): string {
  return String(host.metadata?.name ?? '').trim()
}

function hostContextRef(host: HostResource): string {
  return String(host.spec?.contextRef ?? '').trim()
}

/**
 * Plans the compatibility payload for an Agent-centric access update.
 *
 * Context mappings remain a runtime compatibility write, but the UI no longer
 * manages arbitrary Contexts. Preserve only unowned scopes that were already
 * assigned, then derive every Host-owned scope from the requested Agent set.
 * Never copy unrelated unowned scopes from the global Context inventory.
 */
export function planAgentAccessUpdate(
  assignedContextIds: readonly string[],
  nextGrantedAgentNames: readonly string[],
  hosts: readonly HostResource[]
): AgentAccessUpdatePlan {
  const normalizedAgents = Array.from(
    new Set(nextGrantedAgentNames.map(value => value.trim()).filter(Boolean))
  ).sort((left, right) => left.localeCompare(right))
  const ownedContextIds = new Set(hosts.map(hostContextRef).filter(Boolean))
  const preservedUnownedContextIds = assignedContextIds.filter(
    contextId => contextId && !ownedContextIds.has(contextId)
  )
  const hostByName = new Map(
    hosts.map(host => [hostName(host), host] as const).filter(([name]) => Boolean(name))
  )
  const selectedAgentContextIds = normalizedAgents
    .map(agentName => hostByName.get(agentName))
    .map(host => (host ? hostContextRef(host) : ''))
    .filter(Boolean)

  return {
    agentNames: normalizedAgents,
    contextIds: Array.from(
      new Set([...preservedUnownedContextIds, ...selectedAgentContextIds])
    ).sort((left, right) => left.localeCompare(right)),
  }
}
