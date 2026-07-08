import { useCallback, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AccessCatalog } from '../../../../src/types'
import { desktopQueryKeys } from './queryKeys'

const EMPTY_STRING_LIST: string[] = []
const EMPTY_AGENT_CONTEXT_BY_NAME: Record<string, string | null> = {}
const EMPTY_AGENT_PROVIDER_BY_NAME: Record<string, string | null> = {}
const EMPTY_MCP_SERVERS_BY_AGENT: Record<string, string[]> = {}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useAgentsDataController() {
  const queryClient = useQueryClient()
  const catalogQuery = useQuery({
    queryKey: desktopQueryKeys.accessCatalog,
    queryFn: () => window.clerum.access.refreshCatalog(),
    enabled: false,
  })

  const refreshWithCatalog = useCallback(
    async (catalogInput: AccessCatalog | Promise<AccessCatalog>) => {
      try {
        await queryClient.fetchQuery({
          queryKey: desktopQueryKeys.accessCatalog,
          queryFn: () => Promise.resolve(catalogInput),
          staleTime: 0,
        })
      } catch {
        // Query state already records the error for consumers.
      }
    },
    [queryClient]
  )

  const refresh = useCallback(async () => {
    try {
      await queryClient.fetchQuery({
        queryKey: desktopQueryKeys.accessCatalog,
        queryFn: () => window.clerum.access.refreshCatalog(),
        staleTime: 0,
      })
    } catch {
      // Query state already records the error for consumers.
    }
  }, [queryClient])

  const reset = useCallback(() => {
    queryClient.removeQueries({ queryKey: desktopQueryKeys.accessCatalog })
  }, [queryClient])

  return useMemo(
    () => ({
      loading: catalogQuery.fetchStatus === 'fetching' || catalogQuery.status === 'pending',
      error: catalogQuery.error ? toErrorMessage(catalogQuery.error) : null,
      accessCatalog: catalogQuery.data ?? null,
      agentNames: catalogQuery.data?.agentNames ?? EMPTY_STRING_LIST,
      userAgentNames: catalogQuery.data?.userAgentNames ?? EMPTY_STRING_LIST,
      teamAgentNames: catalogQuery.data?.teamAgentNames ?? EMPTY_STRING_LIST,
      mcpServersByAgent: catalogQuery.data?.mcpServersByAgent ?? EMPTY_MCP_SERVERS_BY_AGENT,
      agentContextByName: catalogQuery.data?.agentContextByName ?? EMPTY_AGENT_CONTEXT_BY_NAME,
      agentProviderByName: catalogQuery.data?.agentProviderByName ?? EMPTY_AGENT_PROVIDER_BY_NAME,
      refresh,
      refreshWithCatalog,
      reset,
    }),
    [
      catalogQuery.data,
      catalogQuery.error,
      catalogQuery.fetchStatus,
      catalogQuery.status,
      refresh,
      refreshWithCatalog,
      reset,
    ]
  )
}
