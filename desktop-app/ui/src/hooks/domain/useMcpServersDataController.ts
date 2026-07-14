import { useCallback, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AccessCatalog } from '../../../../src/types'
import type { ContextMcpServerDetail, ScopedMcpServer } from '../../uiTypes'
import { hasOwnKey, normalizeGlobalMcpServerList } from './helpers'
import { getMcpServerDerivedData } from './mcpServerDerivedData'
import { desktopQueryKeys } from './queryKeys'

const EMPTY_STRING_LIST: string[] = []
const EMPTY_AGENT_CONTEXT_BY_NAME: Record<string, string | null> = {}
const EMPTY_MCP_SERVERS_BY_AGENT: Record<string, string[]> = {}
const EMPTY_GLOBAL_MCP_SERVERS: ScopedMcpServer[] = []
const EMPTY_CONTEXT_SERVER_DETAILS: ContextMcpServerDetail[] = []

type UseMcpServersDataControllerParams = {
  selectedAgent?: string | null
  selectedContext?: string | null
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hostRefsFromCatalog(catalog: AccessCatalog | null | undefined): string[] {
  return Array.from(
    new Set((catalog?.agentNames || []).map(hostRef => hostRef.trim()).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b))
}

export function useMcpServersDataController(params: UseMcpServersDataControllerParams = {}) {
  const selectedAgent = params.selectedAgent ?? null
  const selectedContext = params.selectedContext ?? null
  const queryClient = useQueryClient()
  const catalogQuery = useQuery({
    queryKey: desktopQueryKeys.accessCatalog,
    queryFn: () => window.clerum.access.refreshCatalog(),
    enabled: false,
  })
  const hostRefs = useMemo(() => hostRefsFromCatalog(catalogQuery.data), [catalogQuery.data])

  const previewQuery = useQuery({
    queryKey: desktopQueryKeys.mcpServersPreview(hostRefs),
    queryFn: async () => {
      if (!hostRefs.length) return EMPTY_GLOBAL_MCP_SERVERS
      const result = await window.clerum.rpc.listServers(hostRefs)
      return normalizeGlobalMcpServerList(result.servers)
    },
    enabled: false,
  })

  const refreshPreviewForCatalog = useCallback(
    async (catalog: AccessCatalog) => {
      const nextHostRefs = hostRefsFromCatalog(catalog)
      try {
        await queryClient.fetchQuery({
          queryKey: desktopQueryKeys.mcpServersPreview(nextHostRefs),
          queryFn: async () => {
            if (!nextHostRefs.length) return EMPTY_GLOBAL_MCP_SERVERS
            const result = await window.clerum.rpc.listServers(nextHostRefs)
            return normalizeGlobalMcpServerList(result.servers)
          },
          staleTime: 0,
        })
      } catch {
        // Query state already records the error for consumers.
      }
    },
    [queryClient]
  )

  const refreshWithCatalog = useCallback(
    async (catalogInput: AccessCatalog | Promise<AccessCatalog>) => {
      try {
        const catalog = await queryClient.fetchQuery({
          queryKey: desktopQueryKeys.accessCatalog,
          queryFn: () => Promise.resolve(catalogInput),
          staleTime: 0,
        })
        await refreshPreviewForCatalog(catalog)
      } catch {
        // Query state already records the error for consumers.
      }
    },
    [queryClient, refreshPreviewForCatalog]
  )

  const refresh = useCallback(async () => {
    try {
      const catalog = await queryClient.fetchQuery({
        queryKey: desktopQueryKeys.accessCatalog,
        queryFn: () => window.clerum.access.refreshCatalog(),
        staleTime: 0,
      })
      await refreshPreviewForCatalog(catalog)
    } catch {
      // Query state already records the error for consumers.
    }
  }, [queryClient, refreshPreviewForCatalog])

  const reset = useCallback(() => {
    queryClient.removeQueries({ queryKey: desktopQueryKeys.accessCatalog })
    queryClient.removeQueries({ queryKey: ['desktop-app', 'mcp-servers-preview'] })
  }, [queryClient])

  const globalMcpServersError = previewQuery.error ? toErrorMessage(previewQuery.error) : null
  const globalMcpServersHydrated =
    Boolean(catalogQuery.data) &&
    (!hostRefs.length || previewQuery.status === 'success' || previewQuery.status === 'error')
  const globalMcpServers = previewQuery.data ?? EMPTY_GLOBAL_MCP_SERVERS
  const error = catalogQuery.error
    ? toErrorMessage(catalogQuery.error)
    : globalMcpServersError
      ? `Connector preview list failed: ${globalMcpServersError}`
      : null

  const hasGlobalMcpPreview = useMemo(
    () => globalMcpServersHydrated && !globalMcpServersError,
    [globalMcpServersError, globalMcpServersHydrated]
  )

  const {
    scopedAgentMcpServersByAgent,
    agentMcpServersByAgent,
    contextMcpServersByContext,
    derivedContextMcpServersByContext,
    agentMcpServerCountByAgent,
  } = useMemo(
    () => getMcpServerDerivedData(catalogQuery.data, globalMcpServers, hasGlobalMcpPreview),
    [catalogQuery.data, globalMcpServers, hasGlobalMcpPreview]
  )

  const selectedAgentMcpServerMappingAvailable = useMemo(() => {
    if (!selectedAgent) return false
    return hasOwnKey(scopedAgentMcpServersByAgent, selectedAgent) || hasGlobalMcpPreview
  }, [hasGlobalMcpPreview, scopedAgentMcpServersByAgent, selectedAgent])

  const selectedContextMcpServerMappingAvailable = useMemo(() => {
    if (!selectedContext) return false
    return (
      hasOwnKey(contextMcpServersByContext, selectedContext) ||
      hasOwnKey(derivedContextMcpServersByContext, selectedContext) ||
      hasGlobalMcpPreview
    )
  }, [
    contextMcpServersByContext,
    derivedContextMcpServersByContext,
    hasGlobalMcpPreview,
    selectedContext,
  ])

  const selectedAgentMcpServers = useMemo(() => {
    if (!selectedAgentMcpServerMappingAvailable || !selectedAgent) return EMPTY_GLOBAL_MCP_SERVERS
    if (hasOwnKey(scopedAgentMcpServersByAgent, selectedAgent)) {
      return scopedAgentMcpServersByAgent[selectedAgent] || EMPTY_GLOBAL_MCP_SERVERS
    }
    return globalMcpServers
  }, [
    globalMcpServers,
    scopedAgentMcpServersByAgent,
    selectedAgent,
    selectedAgentMcpServerMappingAvailable,
  ])

  const selectedContextMcpServers = useMemo(() => {
    if (!selectedContextMcpServerMappingAvailable || !selectedContext)
      return EMPTY_GLOBAL_MCP_SERVERS
    if (hasOwnKey(contextMcpServersByContext, selectedContext)) {
      return contextMcpServersByContext[selectedContext] || EMPTY_GLOBAL_MCP_SERVERS
    }
    if (hasOwnKey(derivedContextMcpServersByContext, selectedContext)) {
      return derivedContextMcpServersByContext[selectedContext] || EMPTY_GLOBAL_MCP_SERVERS
    }
    return globalMcpServers
  }, [
    contextMcpServersByContext,
    derivedContextMcpServersByContext,
    globalMcpServers,
    selectedContext,
    selectedContextMcpServerMappingAvailable,
  ])

  const selectedContextMcpServerDetails = useMemo(() => {
    if (!selectedContext || !selectedContextMcpServers.length) return EMPTY_CONTEXT_SERVER_DETAILS
    const agentContextByName = catalogQuery.data?.agentContextByName ?? EMPTY_AGENT_CONTEXT_BY_NAME
    const mcpServersByAgent = catalogQuery.data?.mcpServersByAgent ?? EMPTY_MCP_SERVERS_BY_AGENT
    const contextAgentNames = Object.entries(agentContextByName)
      .filter(([, contextRef]) => String(contextRef || '').trim() === selectedContext)
      .map(([agentName]) => agentName)
      .sort((a, b) => a.localeCompare(b))

    const globalUrlByName = new Map<string, string>()
    for (const server of globalMcpServers) {
      if (server.url) {
        globalUrlByName.set(server.name, server.url)
      }
    }

    let mappingSource: 'workspace-preview' | 'context-map' | 'agent-derived' = 'workspace-preview'
    if (hasOwnKey(contextMcpServersByContext, selectedContext)) {
      mappingSource = 'context-map'
    } else if (hasOwnKey(derivedContextMcpServersByContext, selectedContext)) {
      mappingSource = 'agent-derived'
    }

    return selectedContextMcpServers.map(server => {
      const mappedAgents = contextAgentNames.filter(agentName =>
        (mcpServersByAgent[agentName] || []).includes(server.name)
      )
      const url = server.url || globalUrlByName.get(server.name)
      return {
        name: server.name,
        ...(url ? { url } : {}),
        mappedAgentCount: mappedAgents.length,
        mappedAgents,
        mappingSource,
      }
    })
  }, [
    catalogQuery.data?.agentContextByName,
    catalogQuery.data?.mcpServersByAgent,
    contextMcpServersByContext,
    derivedContextMcpServersByContext,
    globalMcpServers,
    selectedContext,
    selectedContextMcpServers,
  ])

  const selectedAgentMcpServersUnscoped = useMemo(() => {
    if (!selectedAgent) return false
    return !hasOwnKey(scopedAgentMcpServersByAgent, selectedAgent) && hasGlobalMcpPreview
  }, [hasGlobalMcpPreview, scopedAgentMcpServersByAgent, selectedAgent])

  const selectedContextMcpServersUnscoped = useMemo(() => {
    if (!selectedContext) return false
    return (
      !hasOwnKey(contextMcpServersByContext, selectedContext) &&
      !hasOwnKey(derivedContextMcpServersByContext, selectedContext) &&
      hasGlobalMcpPreview
    )
  }, [
    contextMcpServersByContext,
    derivedContextMcpServersByContext,
    hasGlobalMcpPreview,
    selectedContext,
  ])

  const mcpServerMappingUnavailableMessage = hasGlobalMcpPreview
    ? globalMcpServers.length === 0
      ? 'Scoped connector mapping is unavailable, and the current `/api/v1/rpc/servers` response returned 0 servers for this workspace token.'
      : 'Scoped connector mapping is unavailable from the current access catalog. Showing an unscoped preview list for this workspace.'
    : globalMcpServersError
      ? `Scoped connector mapping is unavailable and connector preview listing failed: ${globalMcpServersError}`
      : 'Connector mapping is not available from the current desktop access catalog response.'

  return useMemo(
    () => ({
      loading:
        catalogQuery.fetchStatus === 'fetching' ||
        catalogQuery.status === 'pending' ||
        previewQuery.fetchStatus === 'fetching',
      error,
      accessCatalog: catalogQuery.data ?? null,
      agentNames: catalogQuery.data?.agentNames ?? EMPTY_STRING_LIST,
      agentContextByName: catalogQuery.data?.agentContextByName ?? EMPTY_AGENT_CONTEXT_BY_NAME,
      mcpServersByAgent: catalogQuery.data?.mcpServersByAgent ?? EMPTY_MCP_SERVERS_BY_AGENT,
      agentMcpServersByAgent,
      globalMcpServers,
      mcpServerMappingUnavailableMessage,
      agentMcpServerCountByAgent,
      selectedAgentMcpServers,
      selectedAgentMcpServerMappingAvailable,
      selectedAgentMcpServersUnscoped,
      selectedContextMcpServers,
      selectedContextMcpServerDetails,
      selectedContextMcpServerMappingAvailable,
      selectedContextMcpServersUnscoped,
      globalMcpServersHydrated,
      globalMcpServersError,
      refresh,
      refreshWithCatalog,
      reset,
    }),
    [
      catalogQuery.data,
      catalogQuery.fetchStatus,
      catalogQuery.status,
      error,
      agentMcpServerCountByAgent,
      agentMcpServersByAgent,
      globalMcpServersError,
      globalMcpServersHydrated,
      globalMcpServers,
      mcpServerMappingUnavailableMessage,
      previewQuery.fetchStatus,
      refresh,
      refreshWithCatalog,
      reset,
      selectedAgentMcpServerMappingAvailable,
      selectedAgentMcpServers,
      selectedAgentMcpServersUnscoped,
      selectedContextMcpServerDetails,
      selectedContextMcpServerMappingAvailable,
      selectedContextMcpServers,
      selectedContextMcpServersUnscoped,
    ]
  )
}
