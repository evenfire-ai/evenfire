import { config } from '../../config.js'
import type { K8sGateway } from '../../k8s.js'
import { buildAgentDirectoryEntry } from '../directory/accessReconciliation.js'
import { getTeamAgents, getUserAgents, getUserContexts, listTeams } from '../directory/index.js'

export type ContextMembershipDirectory = {
  getUserContexts: typeof getUserContexts
  getUserAgents: typeof getUserAgents
  listTeams: typeof listTeams
  getTeamAgents: typeof getTeamAgents
}

const defaultDirectory: ContextMembershipDirectory = {
  getUserContexts,
  getUserAgents,
  listTeams,
  getTeamAgents,
}

/**
 * The Contexts a user is a member of for MCP OAuth connect/disconnect (#989).
 *
 * Agent access is authoritative: a user who can use an agent — granted
 * directly (`user_agents`) or through any of their active teams
 * (`team_agents`) — is a member of that agent's `spec.contextRef`. Legacy
 * `user_contexts` rows still count, so existing grants keep working.
 *
 * Teams are not narrowed to the session team: neither the rpc-proxy forward
 * nor the signed OAuth state carries one, and an active team member can
 * already switch to that team and use its agents.
 *
 * Missing Hosts, and Hosts the connectors panel would not list (disabled,
 * terminating, or reported from another namespace — `buildAgentDirectoryEntry`,
 * the producer's own filter), contribute nothing. Directory/Kubernetes errors
 * propagate so an outage is not reported as a membership denial.
 */
export async function getUserMemberContexts(
  gateway: K8sGateway,
  userId: string,
  directory: ContextMembershipDirectory = defaultDirectory
): Promise<{ userId: string; contextIds: string[] }> {
  const [legacy, directAgents, teams] = await Promise.all([
    directory.getUserContexts(userId),
    directory.getUserAgents(userId),
    directory.listTeams(userId, ''),
  ])
  const agentNames = new Set(directAgents.agentNames)
  const teamIds = new Set(
    (Array.isArray(teams.items) ? teams.items : [])
      .map(team => String((team as { id?: unknown }).id ?? ''))
      .filter(Boolean)
  )
  const teamAgents = await Promise.all([...teamIds].map(teamId => directory.getTeamAgents(teamId)))
  for (const grant of teamAgents) {
    for (const agentName of grant.agentNames) agentNames.add(agentName)
  }

  const contextIds = new Set(legacy.contextIds)
  if (agentNames.size > 0) {
    const hosts = (await gateway.listResource('hosts', config.hostsNamespace)) as Array<{
      metadata?: { name?: string }
      spec?: { contextRef?: unknown }
    }>
    for (const host of hosts) {
      const entry = buildAgentDirectoryEntry(host, config.hostsNamespace)
      if (!entry || !agentNames.has(entry.name)) continue
      const contextRef =
        typeof host.spec?.contextRef === 'string' ? host.spec.contextRef.trim() : ''
      if (contextRef) contextIds.add(contextRef)
    }
  }

  return { userId, contextIds: [...contextIds].sort() }
}
