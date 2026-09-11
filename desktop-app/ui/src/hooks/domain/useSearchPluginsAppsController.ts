import { useCallback, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { SandboxUiApp, WorkflowRecipeListResult } from '../../../../src/types'
import { summarizeWorkflowResource } from '../../lib/workflows'
import type { WorkflowSummary } from '../../workflows.types'
import { desktopQueryKeys } from './queryKeys'

const EMPTY_PLUGINS: WorkflowSummary[] = []
const EMPTY_APPS: SandboxUiApp[] = []

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useSearchPluginsAppsController() {
  const queryClient = useQueryClient()

  const workflowsQuery = useQuery({
    queryKey: desktopQueryKeys.workflows,
    queryFn: () => window.clerum.workflows.list() as Promise<WorkflowRecipeListResult>,
    enabled: false,
  })

  const appsQuery = useQuery({
    queryKey: desktopQueryKeys.sandboxApps,
    queryFn: () => window.clerum.sandboxUi.listApps(),
    enabled: false,
  })

  const ensureLoaded = useCallback(async () => {
    await Promise.all([
      queryClient
        .fetchQuery({
          queryKey: desktopQueryKeys.workflows,
          queryFn: () => window.clerum.workflows.list() as Promise<WorkflowRecipeListResult>,
          staleTime: 0,
        })
        .catch(() => undefined),
      queryClient
        .fetchQuery({
          queryKey: desktopQueryKeys.sandboxApps,
          queryFn: () => window.clerum.sandboxUi.listApps(),
          staleTime: 0,
        })
        .catch(() => undefined),
    ])
  }, [queryClient])

  const plugins = useMemo(() => {
    const items = Array.isArray(workflowsQuery.data?.items) ? workflowsQuery.data.items : []
    if (!items.length) return EMPTY_PLUGINS
    return items.map(item => summarizeWorkflowResource(item))
  }, [workflowsQuery.data])

  const apps = useMemo(() => appsQuery.data?.apps ?? EMPTY_APPS, [appsQuery.data])

  return useMemo(
    () => ({
      loading:
        workflowsQuery.fetchStatus === 'fetching' ||
        workflowsQuery.status === 'pending' ||
        appsQuery.fetchStatus === 'fetching' ||
        appsQuery.status === 'pending',
      error:
        workflowsQuery.error || appsQuery.error
          ? toErrorMessage(workflowsQuery.error ?? appsQuery.error)
          : null,
      plugins,
      apps,
      ensureLoaded,
    }),
    [
      apps,
      appsQuery.error,
      appsQuery.fetchStatus,
      appsQuery.status,
      ensureLoaded,
      plugins,
      workflowsQuery.error,
      workflowsQuery.fetchStatus,
      workflowsQuery.status,
    ]
  )
}
