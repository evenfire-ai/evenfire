import { pool } from '../../db.js'
import { bulkSetLinkedItems } from '../../shared/generics.js'

export async function setUserAgents(userId: string, agentNames: string[]) {
  const result = await bulkSetLinkedItems(
    'user_agents',
    'user_id',
    userId,
    'agent_name',
    agentNames
  )
  return { userId, agentNames: result.items }
}

/**
 * Replace the full set of users authorized to invoke a given agent.
 * Inverse of setUserAgents — manages user_agents from the agent's perspective.
 * Used when creating or editing a Host CRD and selecting its authorized users.
 */
export async function setAgentUsers(agentName: string, userIds: string[]) {
  const result = await bulkSetLinkedItems(
    'user_agents',
    'agent_name',
    agentName,
    'user_id',
    userIds
  )
  return { agentName, userIds: result.items }
}

export async function getUserAgents(userId: string) {
  const result = await pool.query(
    `SELECT agent_name
       FROM user_agents
      WHERE user_id = $1
   ORDER BY agent_name ASC`,
    [userId]
  )
  return {
    userId,
    agentNames: result.rows.map(row => String((row as { agent_name: string }).agent_name)),
  }
}

export async function listUsersByAgent(agentName: string) {
  const resolvedAgentName = agentName.trim()
  if (!resolvedAgentName) return []

  const result = await pool.query(
    `SELECT u.id, u.email, u.name, p.display_name
       FROM user_agents ua
       JOIN users u ON u.id = ua.user_id
  LEFT JOIN profiles p ON p.user_id = u.id
      WHERE ua.agent_name = $1
   ORDER BY u.email ASC`,
    [resolvedAgentName]
  )

  return result.rows.map(row => ({
    id: String((row as { id: string }).id),
    email: String((row as { email: string }).email),
    name: ((row as { name?: string | null }).name ?? null) as string | null,
    displayName: ((row as { display_name?: string | null }).display_name ?? null) as string | null,
  }))
}

export async function setTeamAgents(teamId: string, agentNames: string[]) {
  const result = await bulkSetLinkedItems(
    'team_agents',
    'team_id',
    teamId,
    'agent_name',
    agentNames
  )
  return { teamId, agentNames: result.items }
}

/**
 * Replace the full set of teams authorized to invoke a given agent.
 * Inverse of setTeamAgents — manages team_agents from the agent's perspective.
 * Used when creating or editing a Host CRD and selecting its authorized teams.
 */
export async function setAgentTeams(agentName: string, teamIds: string[]) {
  const result = await bulkSetLinkedItems(
    'team_agents',
    'agent_name',
    agentName,
    'team_id',
    teamIds
  )
  return { agentName, teamIds: result.items }
}

export async function getTeamAgents(teamId: string) {
  const result = await pool.query(
    `SELECT agent_name
       FROM team_agents
      WHERE team_id = $1
   ORDER BY agent_name ASC`,
    [teamId]
  )
  return {
    teamId,
    agentNames: result.rows.map(row => String((row as { agent_name: string }).agent_name)),
  }
}

export async function listTeamAgentsByTeam() {
  const result = await pool.query(
    `SELECT team_id, agent_name
       FROM team_agents
   ORDER BY team_id ASC, agent_name ASC`
  )
  const byTeam: Record<string, string[]> = {}
  for (const row of result.rows) {
    const teamId = String((row as { team_id: string }).team_id)
    const agentName = String((row as { agent_name: string }).agent_name)
    if (!byTeam[teamId]) byTeam[teamId] = []
    byTeam[teamId].push(agentName)
  }
  return byTeam
}

export async function listTeamsByAgent(agentName: string) {
  const resolvedAgentName = agentName.trim()
  if (!resolvedAgentName) return []

  const result = await pool.query(
    `SELECT t.id, t.name
       FROM team_agents ta
       JOIN teams t ON t.id = ta.team_id
      WHERE ta.agent_name = $1
   ORDER BY t.name ASC`,
    [resolvedAgentName]
  )

  return result.rows.map(row => ({
    id: String((row as { id: string }).id),
    name: String((row as { name: string }).name),
  }))
}
