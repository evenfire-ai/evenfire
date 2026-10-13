import type { AgentAccessTarget, ResolvedAgentContexts } from './agentAccessTargets.types'
import { getAgentDisplayName } from './agentName'
import { type HostResource, getContext, updateContext } from './api'
import { buildContextUpdatePayload } from './contextMutation'

/**
 * Agents a connector can be given to. Contexts are an internal detail of each
 * agent, so connector flows select agents and derive the Context from
 * `host.spec.contextRef`. Hosts without a Context cannot hold a connector.
 */
export function agentAccessTargetsFromHosts(hosts: readonly HostResource[]): AgentAccessTarget[] {
  const targets = hosts
    .map(host => {
      const name = host.metadata?.name || ''
      const contextRef = String(host.spec?.contextRef ?? '').trim()
      // The editable display name (`spec.host`), not the slug, so operators can
      // tell agents apart.
      const label = getAgentDisplayName(name, hosts) || name
      return { name, label, description: name, contextRef }
    })
    .filter(target => target.name && target.contextRef)
  // Display names are editable and need not be unique; qualify a shared one with
  // the immutable name so two "Research" agents stay distinguishable.
  const labelCounts = new Map<string, number>()
  for (const target of targets) {
    labelCounts.set(target.label, (labelCounts.get(target.label) ?? 0) + 1)
  }
  return targets
    .map(target =>
      (labelCounts.get(target.label) ?? 0) > 1 && target.label !== target.name
        ? { ...target, label: `${target.label} (${target.name})` }
        : target
    )
    .sort((left, right) => left.label.localeCompare(right.label))
}

export function resolveAgentContextRefs(
  selectedAgentNames: readonly string[],
  targets: readonly AgentAccessTarget[]
): ResolvedAgentContexts {
  const selectedTargets = selectedAgentNames
    .map(agentName => targets.find(target => target.name === agentName))
    .filter((target): target is AgentAccessTarget => Boolean(target))
  return {
    selectedTargets,
    contextRefs: Array.from(new Set(selectedTargets.map(target => target.contextRef))),
  }
}

/**
 * Adds `serverName` to each Context's allowlist with its own loaded
 * resourceVersion (CAS). Returns the labels of the agents whose Context could
 * not be updated, so the caller can report that the connector itself exists.
 */
export async function attachServerToAgentContexts(
  serverName: string,
  contextRefs: readonly string[],
  targets: readonly AgentAccessTarget[]
): Promise<string[]> {
  const failedAgents: string[] = []
  await Promise.all(
    contextRefs.map(async contextRef => {
      try {
        const context = await getContext(contextRef)
        const existingServers = context.spec?.mcpServers ?? []
        if (existingServers.includes(serverName)) return
        await updateContext(
          contextRef,
          buildContextUpdatePayload(context.metadata?.resourceVersion, {
            ...context.spec,
            contextId: context.spec?.contextId ?? contextRef,
            mcpServers: [...existingServers, serverName],
            sharedFileSystems: context.spec?.sharedFileSystems ?? [],
          })
        )
      } catch {
        failedAgents.push(
          ...targets.filter(target => target.contextRef === contextRef).map(target => target.label)
        )
      }
    })
  )
  return failedAgents
}
