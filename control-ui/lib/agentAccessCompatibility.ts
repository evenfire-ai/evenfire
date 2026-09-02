import type { ContextResource, HostResource } from './api'
import { contextAliases, contextForAlias, contextResourceName } from './contextIdentity'

export type AgentAccessUpdatePlan = {
  agentNames: string[]
  contextIds: string[]
}

/**
 * Applies the authoritative Agent CAS before its legacy Context compatibility
 * write. A stale Agent snapshot must fail before any Context grant can change.
 */
export async function applyAgentAccessCompatibilityUpdate<AgentResult, ContextResult>(options: {
  contexts: readonly ContextResource[]
  hosts: readonly HostResource[]
  loadCurrentContextIds: () => Promise<readonly string[]>
  nextGrantedAgentNames: readonly string[]
  updateAgents: (agentNames: string[]) => Promise<AgentResult>
  updateContexts: (contextIds: string[]) => Promise<ContextResult>
}): Promise<[AgentResult, ContextResult]> {
  const agentPlan = planAgentAccessUpdate(
    [],
    options.nextGrantedAgentNames,
    options.hosts,
    options.contexts
  )
  const updatedAgents = await options.updateAgents(agentPlan.agentNames)
  // Refresh after the Agent CAS. Hidden/unowned Context grants may have been
  // revoked by another admin since this page loaded and must not be restored
  // from the stale UI snapshot.
  const currentContextIds = await options.loadCurrentContextIds()
  const contextPlan = planAgentAccessUpdate(
    currentContextIds,
    agentPlan.agentNames,
    options.hosts,
    options.contexts
  )
  const updatedContexts = await options.updateContexts(contextPlan.contextIds)
  return [updatedAgents, updatedContexts]
}

function hostName(host: HostResource): string {
  return String(host.metadata?.name ?? '').trim()
}

function hostContextRef(host: HostResource): string {
  return String(host.spec?.contextRef ?? '').trim()
}

export function agentNamesForContextAccess(
  assignedContextIds: readonly string[],
  hosts: readonly HostResource[],
  contexts: readonly ContextResource[]
): string[] {
  const assignedResourceNames = new Set(
    assignedContextIds.map(contextId => {
      const context = contextForAlias(contexts, contextId)
      return context ? contextResourceName(context) : contextId.trim()
    })
  )

  return hosts
    .filter(host => {
      const contextRef = hostContextRef(host)
      const context = contextForAlias(contexts, contextRef)
      const resourceName = context ? contextResourceName(context) : contextRef
      return assignedResourceNames.has(resourceName)
    })
    .map(hostName)
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))
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
  hosts: readonly HostResource[],
  contexts: readonly ContextResource[] = []
): AgentAccessUpdatePlan {
  const normalizedAgents = Array.from(
    new Set(nextGrantedAgentNames.map(value => value.trim()).filter(Boolean))
  ).sort((left, right) => left.localeCompare(right))
  const ownedContextIds = new Set(
    hosts.flatMap(host => {
      const ref = hostContextRef(host)
      const context = contextForAlias(contexts, ref)
      return context ? contextAliases(context) : [ref]
    })
  )
  const preservedUnownedContextIds = assignedContextIds.filter(
    contextId => contextId && !ownedContextIds.has(contextId)
  )
  const hostByName = new Map(
    hosts.map(host => [hostName(host), host] as const).filter(([name]) => Boolean(name))
  )
  const selectedAgentContextIds = normalizedAgents
    .map(agentName => hostByName.get(agentName))
    .map(host => {
      const ref = host ? hostContextRef(host) : ''
      const context = contextForAlias(contexts, ref)
      return context ? contextResourceName(context) : ref
    })
    .filter(Boolean)

  return {
    agentNames: normalizedAgents,
    contextIds: Array.from(
      new Set([...preservedUnownedContextIds, ...selectedAgentContextIds])
    ).sort((left, right) => left.localeCompare(right)),
  }
}
