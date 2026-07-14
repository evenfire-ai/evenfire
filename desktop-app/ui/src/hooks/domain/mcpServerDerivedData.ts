import type { AccessCatalog } from '../../../../src/types'
import type { ScopedMcpServer } from '../../uiTypes'
import { hasOwnKey, normalizeScopedMcpServerMap } from './helpers'

const EMPTY_STRING_LIST: string[] = []
const EMPTY_AGENT_CONTEXT_BY_NAME: Record<string, string | null> = {}
const EMPTY_MCP_SERVERS_BY_AGENT: Record<string, string[]> = {}
const EMPTY_MCP_SERVERS_BY_SCOPE: Record<string, ScopedMcpServer[]> = {}
const EMPTY_MCP_SERVER_COUNTS: Record<string, number | null> = {}

type McpServerDerivedData = {
  scopedAgentMcpServersByAgent: Record<string, ScopedMcpServer[]>
  agentMcpServersByAgent: Record<string, ScopedMcpServer[]>
  contextMcpServersByContext: Record<string, ScopedMcpServer[]>
  derivedContextMcpServersByContext: Record<string, ScopedMcpServer[]>
  agentMcpServerCountByAgent: Record<string, number | null>
}

type CachedByPreviewAvailability = {
  available?: McpServerDerivedData
  unavailable?: McpServerDerivedData
}

const EMPTY_DERIVED_DATA: McpServerDerivedData = {
  scopedAgentMcpServersByAgent: EMPTY_MCP_SERVERS_BY_SCOPE,
  agentMcpServersByAgent: EMPTY_MCP_SERVERS_BY_SCOPE,
  contextMcpServersByContext: EMPTY_MCP_SERVERS_BY_SCOPE,
  derivedContextMcpServersByContext: EMPTY_MCP_SERVERS_BY_SCOPE,
  agentMcpServerCountByAgent: EMPTY_MCP_SERVER_COUNTS,
}

const derivedDataCache = new WeakMap<
  AccessCatalog,
  WeakMap<readonly ScopedMcpServer[], CachedByPreviewAvailability>
>()

function buildDerivedContextMcpServersByContext(
  catalog: AccessCatalog
): Record<string, ScopedMcpServer[]> {
  const grouped = new Map<string, Set<string>>()
  for (const [agentName, contextRefRaw] of Object.entries(
    catalog.agentContextByName ?? EMPTY_AGENT_CONTEXT_BY_NAME
  )) {
    const contextRef =
      typeof contextRefRaw === 'string' && contextRefRaw.trim().length > 0
        ? contextRefRaw.trim()
        : ''
    if (!contextRef) continue
    const serverNames = (catalog.mcpServersByAgent?.[agentName] || [])
      .map(name => String(name || '').trim())
      .filter(Boolean)
    if (!serverNames.length) continue
    const current = grouped.get(contextRef) || new Set<string>()
    for (const serverName of serverNames) {
      current.add(serverName)
    }
    grouped.set(contextRef, current)
  }

  const result: Record<string, ScopedMcpServer[]> = {}
  for (const [contextRef, serverNames] of grouped.entries()) {
    result[contextRef] = [...serverNames].sort((a, b) => a.localeCompare(b)).map(name => ({ name }))
  }
  return result
}

function buildAgentMcpServerCountByAgent(
  catalog: AccessCatalog,
  agentMcpServersByAgent: Record<string, ScopedMcpServer[]>
): Record<string, number | null> {
  const counts: Record<string, number | null> = {}
  for (const agentName of catalog.agentNames ?? EMPTY_STRING_LIST) {
    if (hasOwnKey(agentMcpServersByAgent, agentName)) {
      counts[agentName] = (agentMcpServersByAgent[agentName] || []).length
      continue
    }
    counts[agentName] = null
  }
  return counts
}

function buildEffectiveAgentMcpServersByAgent(
  catalog: AccessCatalog,
  scopedAgentMcpServersByAgent: Record<string, ScopedMcpServer[]>,
  globalMcpServers: readonly ScopedMcpServer[],
  hasGlobalMcpPreview: boolean
): Record<string, ScopedMcpServer[]> {
  const effective: Record<string, ScopedMcpServer[]> = {}
  for (const agentName of catalog.agentNames ?? EMPTY_STRING_LIST) {
    if (hasOwnKey(scopedAgentMcpServersByAgent, agentName)) {
      effective[agentName] = scopedAgentMcpServersByAgent[agentName] || []
      continue
    }
    if (hasGlobalMcpPreview) {
      effective[agentName] = [...globalMcpServers]
    }
  }
  return effective
}

function buildMcpServerDerivedData(
  catalog: AccessCatalog,
  globalMcpServers: readonly ScopedMcpServer[],
  hasGlobalMcpPreview: boolean
): McpServerDerivedData {
  const scopedAgentMcpServersByAgent = normalizeScopedMcpServerMap(catalog.agentMcpServers)
  const agentMcpServersByAgent = buildEffectiveAgentMcpServersByAgent(
    catalog,
    scopedAgentMcpServersByAgent,
    globalMcpServers,
    hasGlobalMcpPreview
  )
  const contextMcpServersByContext = normalizeScopedMcpServerMap(catalog.contextMcpServers)
  return {
    scopedAgentMcpServersByAgent,
    agentMcpServersByAgent,
    contextMcpServersByContext,
    derivedContextMcpServersByContext: buildDerivedContextMcpServersByContext(catalog),
    agentMcpServerCountByAgent: buildAgentMcpServerCountByAgent(catalog, agentMcpServersByAgent),
  }
}

export function getMcpServerDerivedData(
  catalog: AccessCatalog | null | undefined,
  globalMcpServers: readonly ScopedMcpServer[],
  hasGlobalMcpPreview: boolean
): McpServerDerivedData {
  if (!catalog) return EMPTY_DERIVED_DATA

  let catalogCache = derivedDataCache.get(catalog)
  if (!catalogCache) {
    catalogCache = new WeakMap<readonly ScopedMcpServer[], CachedByPreviewAvailability>()
    derivedDataCache.set(catalog, catalogCache)
  }

  let previewCache = catalogCache.get(globalMcpServers)
  if (!previewCache) {
    previewCache = {}
    catalogCache.set(globalMcpServers, previewCache)
  }

  const cacheKey = hasGlobalMcpPreview ? 'available' : 'unavailable'
  const cached = previewCache[cacheKey]
  if (cached) return cached

  const next = buildMcpServerDerivedData(catalog, globalMcpServers, hasGlobalMcpPreview)
  previewCache[cacheKey] = next
  return next
}
