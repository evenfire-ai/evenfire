import type {
  ConnectorAccessPrincipal,
  ConnectorAccessSummary,
  ConnectorAccessSummaryMap,
  ConnectorAgentBinding,
  ConnectorAgentTarget,
  ServerRef,
} from '@components/McpServerTable.types'
import type { ContextResource, ContextSpec, HostResource, McpServerResource } from './api'
import { getAgentTeams, getAgentUsers, updateContext } from './api'
import { mergeAccessSummaries, sortAccessPrincipals } from './connectorAccess'
import { connectorContextAssignmentError } from './connectorOAuthAccess'
import { contextAliases, contextForAlias, contextResourceName } from './contextIdentity'
import { buildContextUpdatePayload, contextMutationError } from './contextMutation'

export type ConnectorAccessState = {
  contexts: ContextResource[]
  agentTargets: ConnectorAgentTarget[]
  bindingsByConnectorName: Record<string, ConnectorAgentBinding[]>
  accessByConnectorKey: ConnectorAccessSummaryMap
  warning: string
}

function resourceName(resource: { metadata?: { name?: string } }): string {
  return resource.metadata?.name || 'unknown'
}

function resourceNamespace(resource: { metadata?: { namespace?: string } }): string {
  return resource.metadata?.namespace || 'default'
}

export function connectorResourceKey(connector: McpServerResource): string {
  return `${resourceNamespace(connector)}/${resourceName(connector)}`
}

function getContextRef(resource: { spec?: Record<string, unknown> }): string {
  const contextRef = resource.spec?.contextRef
  return typeof contextRef === 'string' ? contextRef.trim() : ''
}

function contextSpec(context: ContextResource): ContextSpec {
  const name = contextResourceName(context)
  return {
    contextId: context.spec?.contextId || name,
    description: context.spec?.description,
    mcpServers: Array.isArray(context.spec?.mcpServers) ? context.spec.mcpServers : [],
    sharedFileSystems: context.spec?.sharedFileSystems ?? [],
  }
}

export function connectorAgentTargetsFromHosts(
  hosts: readonly HostResource[]
): ConnectorAgentTarget[] {
  return hosts
    .map(host => {
      const name = resourceName(host)
      const displayName =
        String((host.spec as { host?: string } | undefined)?.host || '').trim() || name
      return { name, label: displayName, contextRef: getContextRef(host) }
    })
    .filter(target => target.contextRef && target.name !== 'unknown')
    .sort((left, right) => left.label.localeCompare(right.label))
}

export function connectorAgentBindingsFromContexts(
  contexts: readonly ContextResource[],
  agentTargets: readonly ConnectorAgentTarget[]
): Record<string, ConnectorAgentBinding[]> {
  const bindings: Record<string, ConnectorAgentBinding[]> = {}
  for (const context of contexts) {
    const contextName = contextResourceName(context)
    const aliases = new Set(contextAliases(context))
    const agents = agentTargets
      .filter(target => aliases.has(target.contextRef))
      .map(target => ({ id: target.name, label: target.label }))
    if (!contextName || agents.length === 0) continue

    for (const connectorName of context.spec?.mcpServers ?? []) {
      const list = bindings[connectorName] ?? []
      list.push({ contextRef: contextName, agents: sortAccessPrincipals(agents) })
      bindings[connectorName] = list
    }
  }
  for (const list of Object.values(bindings)) {
    list.sort((left, right) =>
      (left.agents[0]?.label ?? '').localeCompare(right.agents[0]?.label ?? '')
    )
  }
  return bindings
}

async function loadAgentAccess(
  agentName: string
): Promise<readonly [ConnectorAccessSummary, boolean]> {
  const [usersResult, teamsResult] = await Promise.allSettled([
    getAgentUsers(agentName),
    getAgentTeams(agentName),
  ])
  const accessLoadFailed = usersResult.status === 'rejected' || teamsResult.status === 'rejected'
  const users =
    usersResult.status === 'fulfilled'
      ? sortAccessPrincipals(
          (usersResult.value.items ?? []).map(user => ({
            id: user.id,
            label: user.displayName || user.name || user.email || user.id,
          }))
        )
      : []
  const teams =
    teamsResult.status === 'fulfilled'
      ? sortAccessPrincipals(
          (teamsResult.value.items ?? []).map(team => ({
            id: team.id,
            label: team.name || team.id,
          }))
        )
      : []

  return [{ agents: [], users, teams }, accessLoadFailed] as const
}

export async function loadConnectorAccessState(
  connectors: readonly McpServerResource[],
  contexts: readonly ContextResource[],
  hosts: readonly HostResource[]
): Promise<ConnectorAccessState> {
  const agentTargets = connectorAgentTargetsFromHosts(hosts)
  const bindingsByConnectorName = connectorAgentBindingsFromContexts(contexts, agentTargets)
  const managedAgentNames = [
    ...new Set(
      Object.values(bindingsByConnectorName)
        .flat()
        .flatMap(binding => binding.agents.map(agent => agent.id))
    ),
  ]
  const accessResults = await Promise.all(
    managedAgentNames.map(async agentName => [agentName, await loadAgentAccess(agentName)] as const)
  )
  const accessByAgent = new Map(
    accessResults.map(([agentName, [summary]]) => [agentName, summary] as const)
  )
  const accessLoadFailed = accessResults.some(([, [, failed]]) => failed)
  const accessByConnectorKey = connectors.reduce<ConnectorAccessSummaryMap>((result, connector) => {
    const name = resourceName(connector)
    const bindings = bindingsByConnectorName[name] ?? []
    const bindingAgentNames = bindings.flatMap(binding => binding.agents.map(agent => agent.id))
    if (bindingAgentNames.length === 0) return result

    const merged = mergeAccessSummaries(
      bindingAgentNames.map(
        agentName => accessByAgent.get(agentName) ?? { agents: [], users: [], teams: [] }
      )
    )
    const bindingAgents = bindings.flatMap(binding => binding.agents)
    const seenAgentIds = new Set(
      [...bindingAgents, ...merged.agents].map(principal => principal.id)
    )
    const agents = [
      ...bindingAgents,
      ...merged.agents.filter(principal => !seenAgentIds.has(principal.id)),
    ]
    result[connectorResourceKey(connector)] = {
      ...merged,
      agents: sortAccessPrincipals([...new Map(agents.map(agent => [agent.id, agent])).values()]),
    }
    return result
  }, {})

  return {
    contexts: [...contexts],
    agentTargets,
    bindingsByConnectorName,
    accessByConnectorKey,
    warning: accessLoadFailed
      ? 'Some connector access data could not be loaded. User or team access may be incomplete.'
      : '',
  }
}

export async function addConnectorToAgentContexts(
  server: ServerRef,
  agents: readonly Pick<ConnectorAgentTarget, 'name' | 'contextRef'>[],
  contexts: readonly ContextResource[],
  connectorSpec: { contextRef?: unknown; oauth?: unknown } | undefined
): Promise<void> {
  const contextRefs = [...new Set(agents.map(agent => agent.contextRef))]
  const oauthScopeError = connectorContextAssignmentError(connectorSpec, contextRefs)
  if (oauthScopeError) throw new Error(oauthScopeError)

  const resolvedTargets = contextRefs.map(contextRef => contextForAlias(contexts, contextRef))
  if (resolvedTargets.some(target => !target)) {
    throw new Error(
      'One or more selected agents could not be resolved. Please refresh and try again.'
    )
  }
  const targets = Array.from(
    new Map(
      resolvedTargets.map(
        target => [contextResourceName(target as ContextResource), target] as const
      )
    ).values()
  ) as ContextResource[]

  await Promise.all(
    targets.map(context => {
      const spec = contextSpec(context)
      return updateContext(
        contextResourceName(context),
        buildContextUpdatePayload(context.metadata?.resourceVersion, {
          ...spec,
          mcpServers: Array.from(new Set([...spec.mcpServers, server.name])),
        })
      )
    })
  )
}

export async function removeConnectorFromAgentContext(
  serverName: string,
  binding: ConnectorAgentBinding,
  contexts: readonly ContextResource[]
): Promise<void> {
  const target = contextForAlias(contexts, binding.contextRef)
  if (!target) {
    throw new Error('This agent’s connector set could not be loaded. Please refresh and try again.')
  }

  const spec = contextSpec(target)
  await updateContext(
    contextResourceName(target),
    buildContextUpdatePayload(target.metadata?.resourceVersion, {
      ...spec,
      mcpServers: spec.mcpServers.filter(name => name !== serverName),
    })
  )
}

export function connectorAccessMutationError(error: unknown, fallback: string): string {
  if ((error as { status?: unknown } | null)?.status === 409) {
    return 'This connector’s access changed since it was loaded. Reload the page and try again.'
  }
  if (error instanceof Error && /required version is unavailable/i.test(error.message)) {
    return 'This connector’s access is missing a server version. Reload the page and try again.'
  }
  return contextMutationError(error, fallback)
}

export function connectorUserAndTeamAccess(
  connector: McpServerResource,
  state: ConnectorAccessState
): { users: ConnectorAccessPrincipal[]; teams: ConnectorAccessPrincipal[] } {
  const summary = state.accessByConnectorKey[connectorResourceKey(connector)]
  return { users: summary?.users ?? [], teams: summary?.teams ?? [] }
}
