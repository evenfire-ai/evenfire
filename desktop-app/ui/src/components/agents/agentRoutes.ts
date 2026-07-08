import type { AgentWorkspaceRoute } from '../../uiTypes'

export const AGENT_ROUTE_LABELS: Record<AgentWorkspaceRoute, string> = {
  details: 'Details',
  'mcp-servers': 'Connectors',
  contexts: 'Contexts',
  'shared-files': 'Agent Files',
  activity: 'Activity',
}

export const AGENT_ROUTE_OPTIONS: AgentWorkspaceRoute[] = [
  'details',
  'mcp-servers',
  'contexts',
  'shared-files',
  'activity',
]
