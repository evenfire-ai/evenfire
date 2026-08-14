export const desktopQueryKeys = {
  all: ['desktop-app'] as const,
  accessCatalog: ['desktop-app', 'access-catalog'] as const,
  mcpServersPreview: (hostRefs: string[]) =>
    ['desktop-app', 'mcp-servers-preview', ...hostRefs] as const,
  teamsDirectory: ['desktop-app', 'teams-directory'] as const,
  myAgents: ['desktop-app', 'my-agents'] as const,
  sandboxApps: ['desktop-app', 'sandbox-apps'] as const,
  workflows: ['desktop-app', 'workflows'] as const,
  workflowSelection: ['desktop-app', 'workflow-selection'] as const,
  workflowDetail: (namespace: string, name: string) =>
    ['desktop-app', 'workflow-detail', namespace, name] as const,
  workflowRuns: (namespace: string, name: string, limit: number) =>
    ['desktop-app', 'workflow-runs', namespace, name, String(limit)] as const,
  sharedFilesList: (contextId: string) =>
    ['desktop-app', 'shared-files', 'list', contextId] as const,
  sharedFilesDirectory: (contextId: string, filesystemName: string, path: string) =>
    ['desktop-app', 'shared-files', 'directory', contextId, filesystemName, path] as const,
  gfsRoot: ['desktop-app', 'gfs'] as const,
  gfsAccessible: (sessionScope: string, drive: string) =>
    ['desktop-app', 'gfs', sessionScope, 'accessible', drive] as const,
  gfsChildren: (sessionScope: string, resourceId: string, drive: string) =>
    ['desktop-app', 'gfs', sessionScope, 'children', drive, resourceId] as const,
  gfsAffordances: (sessionScope: string, resourceId: string, drive: string) =>
    ['desktop-app', 'gfs', sessionScope, 'affordances', drive, resourceId] as const,
  pluginGrants: ['desktop-app', 'plugin-sdk', 'grants'] as const,
  pluginActivity: (limit: number) =>
    ['desktop-app', 'plugin-sdk', 'activity', String(limit)] as const,
}
