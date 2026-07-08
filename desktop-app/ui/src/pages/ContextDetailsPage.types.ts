import type { TeamMember, TeamSummary } from '../../../src/types'
import type { ContextMcpServerDetail, ScopedMcpServer } from '../uiTypes'

export type ContextScope = 'shared' | 'user' | 'team' | 'unknown'
export type ContextTab = 'agents' | 'mcp-servers' | 'teams' | 'members' | 'shared-files'

export type ContextDetails = {
  id: string
  availableToUser: boolean
  availableToTeam: boolean
  totalContexts: number
  userId: string
  teamId: string
} | null

export type ContextDetailsPageProps = {
  contextIds: string[]
  selectedContext: string | null
  selectedContextDetails: ContextDetails
  userContextIds: string[]
  teamContextIds: string[]
  agentNames: string[]
  userAgentNames: string[]
  teamAgentNames: string[]
  teams: TeamSummary[]
  currentTeamId: string
  teamMembers: TeamMember[]
  meName?: string | null
  meEmail?: string | null
  selectedContextMcpServers: ScopedMcpServer[]
  selectedContextMcpServerDetails: ContextMcpServerDetail[]
  selectedContextMcpServerMappingAvailable: boolean
  selectedContextMcpServersUnscoped: boolean
  mcpServerMappingUnavailableMessage: string
  onBackToContexts: () => void
  onOpenContextDetails: (id: string) => void
  onOpenTeamDetails: (id: string) => void
  onOpenAgentWorkspace: (agentName: string) => void
}
