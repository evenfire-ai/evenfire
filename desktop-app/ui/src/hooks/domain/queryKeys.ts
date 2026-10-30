export function isGfsSessionGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function hasGfsSessionGeneration(
  key: readonly unknown[],
  generation: number | null
): boolean {
  const qualifier = key[key.length - 1]
  return Boolean(
    qualifier &&
    typeof qualifier === 'object' &&
    !Array.isArray(qualifier) &&
    (qualifier as { sessionGeneration?: unknown }).sessionGeneration === generation
  )
}

export function isGfsSessionAuthorityCurrent(
  capturedScope: string | null,
  capturedGeneration: number | null,
  liveScope: string | null,
  liveGeneration: number | null
): boolean {
  return Boolean(
    capturedScope &&
    capturedScope === liveScope &&
    isGfsSessionGeneration(capturedGeneration) &&
    capturedGeneration === liveGeneration
  )
}

function withGfsSessionGeneration<T extends readonly unknown[]>(
  key: T,
  sessionGeneration?: number | null
) {
  return sessionGeneration === undefined ? key : ([...key, { sessionGeneration }] as const)
}

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
  // Session-authority revoked flag, SHARED across every GFS controller mount
  // (sidebar tree, FilesPage, FilePreviewPage) via the query cache. Kept OUTSIDE
  // the `gfsRoot` prefix on purpose: the fail-closed purge removes everything
  // under `gfsRoot`, and the revoked flag must survive that purge (it is set in
  // the same turn). Keyed by sessionScope so a user/team/env switch reads fresh.
  gfsAccessState: (sessionScope: string, generation?: number | null) =>
    withGfsSessionGeneration(['desktop-app', 'gfs-access', sessionScope] as const, generation),
  gfsAccessible: (sessionScope: string, drive: string, generation?: number | null) =>
    withGfsSessionGeneration(
      ['desktop-app', 'gfs', sessionScope, 'accessible', drive] as const,
      generation
    ),
  gfsChildren: (
    sessionScope: string,
    resourceId: string,
    drive: string,
    generation?: number | null
  ) =>
    withGfsSessionGeneration(
      ['desktop-app', 'gfs', sessionScope, 'children', drive, resourceId] as const,
      generation
    ),
  gfsAffordances: (
    sessionScope: string,
    resourceId: string,
    drive: string,
    generation?: number | null
  ) =>
    withGfsSessionGeneration(
      ['desktop-app', 'gfs', sessionScope, 'affordances', drive, resourceId] as const,
      generation
    ),
  gfsGrants: (
    sessionScope: string,
    resourceId: string,
    drive: string,
    generation?: number | null
  ) =>
    withGfsSessionGeneration(
      ['desktop-app', 'gfs', sessionScope, 'grants', drive, resourceId] as const,
      generation
    ),
  gfsShares: (
    sessionScope: string,
    resourceId: string,
    drive: string,
    generation?: number | null
  ) =>
    withGfsSessionGeneration(
      ['desktop-app', 'gfs', sessionScope, 'shares', drive, resourceId] as const,
      generation
    ),
  gfsInheritedAccess: (
    sessionScope: string,
    resourceId: string,
    drive: string,
    generation?: number | null
  ) =>
    withGfsSessionGeneration(
      ['desktop-app', 'gfs', sessionScope, 'inherited-access', drive, resourceId] as const,
      generation
    ),
  // Open GFS locations, SHARED across every controller mount (the sidebar
  // tree, FilesPage, FilePreviewPage) via the query cache: each mount
  // publishes the resource it has open together with the ancestry it
  // observed, so a move committed by ONE surface can tell that it changes
  // what ANOTHER surface's open Share/Manage dialog inherits. Kept OUTSIDE
  // the `gfsRoot` prefix on purpose: the fail-closed purge removes
  // everything under `gfsRoot`, and the registry must survive that purge
  // (the mounts republish it as their access state settles).
  gfsOpenLocations: (sessionScope: string) =>
    ['desktop-app', 'gfs-open-locations', sessionScope] as const,
  // Proactive connectors panel (spec 11 U2). Invalidated on connect/disconnect
  // completion (U3/U4) so the tri-state re-reads the authoritative grant store.
  connectors: ['desktop-app', 'connectors'] as const,
  pluginGrants: ['desktop-app', 'plugin-sdk', 'grants'] as const,
  pluginActivity: (limit: number) =>
    ['desktop-app', 'plugin-sdk', 'activity', String(limit)] as const,
}
