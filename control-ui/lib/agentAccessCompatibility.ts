import type { HostResource } from './api'

export type AgentAccessUpdatePlan = {
  agentNames: string[]
  contextIds: string[]
}

/**
 * Applies the authoritative Agent CAS before its legacy Context compatibility
 * write. A stale Agent snapshot must fail before any Context grant can change.
 */
export async function applyAgentAccessCompatibilityUpdate<AgentResult, ContextResult>(options: {
  hosts: readonly HostResource[]
  loadCurrentContextIds: () => Promise<readonly string[]>
  nextGrantedAgentNames: readonly string[]
  updateAgents: (agentNames: string[]) => Promise<AgentResult>
  updateContexts: (contextIds: string[]) => Promise<ContextResult>
}): Promise<[AgentResult, ContextResult]> {
  const agentPlan = planAgentAccessUpdate([], options.nextGrantedAgentNames, options.hosts)
  const updatedAgents = await options.updateAgents(agentPlan.agentNames)
  // Refresh after the Agent CAS. Hidden/unowned Context grants may have been
  // revoked by another admin since this page loaded and must not be restored
  // from the stale UI snapshot.
  const currentContextIds = await options.loadCurrentContextIds()
  const contextPlan = planAgentAccessUpdate(currentContextIds, agentPlan.agentNames, options.hosts)
  const updatedContexts = await options.updateContexts(contextPlan.contextIds)
  return [updatedAgents, updatedContexts]
}

function hostName(host: HostResource): string {
  return String(host.metadata?.name ?? '').trim()
}

// Membership values and Host.spec.contextRef are both Context names, matched exactly as the
// token broker does: an alias or a padded ref must not grant a different Context's Hosts.
function hostContextRef(host: HostResource): string {
  const contextRef = host.spec?.contextRef
  return typeof contextRef === 'string' ? contextRef : ''
}

export function agentNamesForContextAccess(
  assignedContextIds: readonly string[],
  hosts: readonly HostResource[]
): string[] {
  const assigned = new Set(assignedContextIds)

  return hosts
    .filter(host => {
      const contextRef = hostContextRef(host)
      return contextRef !== '' && assigned.has(contextRef)
    })
    .map(hostName)
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))
}

export function effectiveAgentNamesForAccess({
  assignedAgentNames,
  assignedContextIds,
  hosts,
}: {
  assignedAgentNames: readonly string[]
  assignedContextIds: readonly string[]
  hosts: readonly HostResource[]
}): string[] {
  return Array.from(
    new Set([
      ...assignedAgentNames.map(value => value.trim()).filter(Boolean),
      ...agentNamesForContextAccess(assignedContextIds, hosts),
    ])
  ).sort((left, right) => left.localeCompare(right))
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
