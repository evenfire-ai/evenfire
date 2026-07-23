import type { AgentWorkspaceRoute } from '../../uiTypes'

// Temporary UI-only gate. Restore every Agent Files entry point by flipping
// this to true; the route, views, handlers, and APIs remain untouched.
export const SHOW_AGENT_FILES_UI = false

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
  ...(SHOW_AGENT_FILES_UI ? (['shared-files'] as AgentWorkspaceRoute[]) : []),
  'activity',
]
