export const SIDEBAR_COLLAPSED_KEY = 'clerum.ui.sidebarCollapsed'
export const SIDEBAR_SESSION_PREVIEW_LIMIT = 5

export const DESKTOP_ROUTES = {
  chat: 'chat',
  apps: 'sandbox-ui',
  plugins: 'workflows',
  agents: 'agents',
  connectors: 'mcp-servers',
  contexts: 'contexts',
  contextDetails: 'context-details',
  teams: 'teams',
  teamDetails: 'team-details',
  files: 'files',
  settings: 'settings',
} as const

export type DesktopRoute = (typeof DESKTOP_ROUTES)[keyof typeof DESKTOP_ROUTES]

export const AGENT_WORKSPACE_ROUTES = {
  details: 'details',
  connectors: 'mcp-servers',
  contexts: 'contexts',
  sharedFiles: 'shared-files',
  activity: 'activity',
} as const

export type AgentWorkspaceRoute =
  (typeof AGENT_WORKSPACE_ROUTES)[keyof typeof AGENT_WORKSPACE_ROUTES]
