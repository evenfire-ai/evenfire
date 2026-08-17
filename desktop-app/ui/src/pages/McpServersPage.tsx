import { useMemo } from 'react'
import { DataTable, EmptyState, ReferenceTag } from '@components/Common'
import { formatMcpServerDisplayName } from '@lib/format'
import type { ScopedMcpServer } from '@/uiTypes'
import { useNavigationContext } from '../contexts/NavigationContext'
import { useMcpServersDataController } from '../hooks/domain/useMcpServersDataController'

export function McpServersPage() {
  const {
    agentNames,
    agentDisplayByName,
    mcpServersByAgent,
    agentContextByName,
    globalMcpServers,
    mcpServerMappingUnavailableMessage,
    loading,
    error,
  } = useMcpServersDataController()
  const { handleOpenAgentWorkspace, handleOpenContextDetails } = useNavigationContext()

  const globalByName = useMemo(() => {
    const index = new Map<string, ScopedMcpServer>()
    for (const server of globalMcpServers) {
      index.set(server.name, server)
    }
    return index
  }, [globalMcpServers])

  const serverRows = useMemo(() => {
    const rowsByServer = new Map<
      string,
      {
        agents: Set<string>
        contexts: Set<string>
        serverName: string
        url?: string
      }
    >()

    for (const agentName of agentNames) {
      const servers = Array.from(
        new Set(
          (mcpServersByAgent[agentName] || [])
            .map(name => String(name || '').trim())
            .filter(Boolean)
        )
      ).sort((a, b) => a.localeCompare(b))
      if (!servers.length) continue

      const contextRefRaw = agentContextByName[agentName]
      const contextId =
        typeof contextRefRaw === 'string' && contextRefRaw.trim().length > 0
          ? contextRefRaw.trim()
          : 'Unassigned context'

      for (const serverName of servers) {
        const globalServer = globalByName.get(serverName)
        const existing = rowsByServer.get(serverName)
        if (existing) {
          existing.agents.add(agentName)
          existing.contexts.add(contextId)
          if (!existing.url && globalServer?.url) existing.url = globalServer.url
          continue
        }
        rowsByServer.set(serverName, {
          agents: new Set([agentName]),
          contexts: new Set([contextId]),
          serverName,
          ...(globalServer?.url ? { url: globalServer.url } : {}),
        })
      }
    }

    return [...rowsByServer.values()]
      .map(row => ({
        agents: [...row.agents].sort((a, b) => a.localeCompare(b)),
        contexts: [...row.contexts].sort((a, b) => {
          if (a === 'Unassigned context') return 1
          if (b === 'Unassigned context') return -1
          return a.localeCompare(b)
        }),
        serverName: row.serverName,
        url: row.url,
      }))
      .sort((a, b) => a.serverName.localeCompare(b.serverName))
  }, [agentContextByName, agentNames, globalByName, mcpServersByAgent])

  return (
    <section className="page">
      <div className="page-header">
        <h2>Connectors</h2>
        <p className="muted">Connectors mapped across available agents and contexts.</p>
      </div>

      <div className="page-layout">
        <section className="page-card mcp-servers-board-card">
          {loading && serverRows.length === 0 ? (
            <EmptyState title="Loading" body="Fetching connector inventory..." />
          ) : error && serverRows.length === 0 ? (
            <div className="composer-error" role="alert">
              <p className="error-text">{error}</p>
            </div>
          ) : serverRows.length === 0 ? (
            <EmptyState title="No connectors" body={mcpServerMappingUnavailableMessage} />
          ) : (
            <DataTable frameless fullBleed className="mcp-servers-data-table">
              <thead>
                <tr>
                  <th className="da-table__col-header" scope="col">
                    Server
                  </th>
                  <th className="da-table__col-header" scope="col">
                    Contexts
                  </th>
                  <th className="da-table__col-header" scope="col">
                    Agents
                  </th>
                </tr>
              </thead>
              <tbody>
                {serverRows.map(row => (
                  <tr key={row.serverName}>
                    <td className="da-table__cell">
                      <span className="mcp-servers-server-cell">
                        {formatMcpServerDisplayName(row.serverName)}
                      </span>
                      {row.url ? <code className="mcp-servers-url-inline">{row.url}</code> : null}
                    </td>
                    <td className="da-table__cell">
                      <span className="reference-tag-list">
                        {row.contexts.map(contextId => (
                          <ReferenceTag
                            key={`${row.serverName}:${contextId}`}
                            kind="context"
                            title={contextId}
                            aria-label={`Open context ${contextId}`}
                            disabled={contextId === 'Unassigned context'}
                            onClick={() => {
                              if (contextId === 'Unassigned context') return
                              handleOpenContextDetails(contextId)
                            }}
                          >
                            {contextId}
                          </ReferenceTag>
                        ))}
                      </span>
                    </td>
                    <td className="da-table__cell">
                      <span className="reference-tag-list">
                        {row.agents.map(agentName => (
                          <ReferenceTag
                            key={`${row.serverName}:${agentName}`}
                            kind="agent"
                            onClick={() => handleOpenAgentWorkspace(agentName)}
                            title={agentName}
                            aria-label={`Open agent ${agentName}`}
                          >
                            {/* Visible agent name (spec.host) read directly from
                                the producer-total map — no fallback (Decision #6). */}
                            {agentDisplayByName[agentName]}
                          </ReferenceTag>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </section>
      </div>
    </section>
  )
}
