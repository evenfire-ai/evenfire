import { SHOW_AGENT_FILES_UI } from '@constants/agentFeatures'
import type { AgentWorkspaceRoute } from '../../uiTypes'

export const AGENT_ROUTE_LABELS: Record<AgentWorkspaceRoute, string> = {
  'mcp-servers': 'Connectors',
  members: 'Members',
  'shared-files': 'Agent Files',
  activity: 'Activity',
}

export const AGENT_ROUTE_OPTIONS: AgentWorkspaceRoute[] = [
  'mcp-servers',
  'members',
  ...(SHOW_AGENT_FILES_UI ? (['shared-files'] as AgentWorkspaceRoute[]) : []),
  'activity',
]
