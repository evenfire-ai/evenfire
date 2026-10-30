export type TeamRole = 'admin' | 'inviter' | 'member'
export const TEAM_ROLES: TeamRole[] = ['admin', 'inviter', 'member']

export type RpcScope =
  | 'mcp:servers:list'
  | 'mcp:server:invoke'
  | 'host:health:read'
  | 'host:status:read'
  | 'host:activity:read'
  | 'host:message:invoke'
  | 'host:task:read'
  | 'host:approval:write'
  | 'host:session:read'
  | 'desktop:view'
  | 'sandbox:ui:view'
export type RpcAccessScope = 'team' | 'user'

export type AuthClaims = {
  userId: string
  email: string
  teamId: string
  role: TeamRole
  exp: number
  sessionContract?: 'v2'
  sid?: string
  jti?: string
  sv?: number
  ver?: 2
}

export type ChannelMapping = {
  emails: string[]
  telegramHandles: string[]
  slackUserNames: string[]
  telegramIds: string[]
  discordUserNames: string[]
  whatsappNumbers: string[]
}

/**
 * Per-agent MCP server list returned by the session catalog endpoints.
 * Names only — no URLs or credentials (spec §3.1, §4.1).
 */
export type AgentWithMcpServers = {
  name: string
  /**
   * Human-facing display name for the agent (control-api Host `spec.host`).
   * Optional in the TS contract for back-compat; control-api always emits it
   * (falling back to `name` when `spec.host` is empty). It survives the
   * passthrough as a pure cast at runtime — declaring it here makes it visible
   * to downstream consumers instead of being an undocumented extra field.
   */
  displayName?: string
  contextRef: string | null
  mcpServers: Array<{ name: string }>
}

export type UserAgentsResponse = {
  userId: string
  agentNames: string[]
  agents?: AgentWithMcpServers[]
}

export type TeamAgentsResponse = {
  teamId: string
  agentNames: string[]
  agents?: AgentWithMcpServers[]
}

export type TeamSummary = {
  id: string
  name: string
  role: TeamRole
}

export type TeamMember = {
  id: string
  email: string
  name: string | null
  role: TeamRole
  status: string
}

export type TeamDirectoryEntry = {
  team: TeamSummary
  members: TeamMember[]
  contextIds: string[]
  agentNames: string[]
}

export type TeamDirectoryResult = {
  currentTeamId: string
  truncated?: boolean
  items: TeamDirectoryEntry[]
}
