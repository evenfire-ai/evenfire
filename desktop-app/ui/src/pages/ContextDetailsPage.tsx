import { useEffect, useMemo, useState } from 'react'
import { Button, DataTable, EmptyState, Pill, ReferenceTag, TabButton } from '@components/Common'
import { PageBreadcrumb } from '@components/PageBreadcrumb'
import { ResourceBreadcrumbSwitcher } from '@components/ResourceBreadcrumbSwitcher'
import { scopeCaption, statusPresentation } from '@lib/connectorPresentation'
import { deriveConnectorRows } from '@lib/connectorRows'
import { SharedFilesTab } from '../components/SharedFilesTab'
import { useAuthContext } from '../contexts/AuthContext'
import { useNavigationContext } from '../contexts/NavigationContext'
import {
  type ConnectorActionInput,
  isActionableConnector,
  useConnectorsController,
} from '../hooks/domain/useConnectorsController'
import { useContextsDataController } from '../hooks/domain/useContextsDataController'
import { useMcpServersDataController } from '../hooks/domain/useMcpServersDataController'
import { useTeamsDataController } from '../hooks/domain/useTeamsDataController'
import { clickableRowProps } from '../lib/clickableRowProps'
import type { ContextTab } from './ContextDetailsPage.types'

export function ContextDetailsPage() {
  const { me } = useAuthContext()
  const { accessCatalog: contextsAccessCatalog } = useContextsDataController()
  const {
    selectedContext,
    selectedContextTab,
    handleBackToContexts,
    handleOpenContextDetails,
    handleOpenTeamDetails,
    handleOpenAgentWorkspace,
  } = useNavigationContext()
  const {
    agentNames,
    agentDisplayByName,
    agentContextByName,
    mcpServersByAgent,
    accessCatalog: mcpAccessCatalog,
    selectedContextMcpServers,
    selectedContextMcpServerDetails,
    selectedContextMcpServerMappingAvailable,
    selectedContextMcpServersUnscoped,
    globalMcpServers,
    mcpServerMappingUnavailableMessage,
  } = useMcpServersDataController({ selectedContext })
  const { teams, currentTeamId, teamMembers, teamDirectory } = useTeamsDataController()
  // Same app-coordinated query as the top-level Connectors panel (shared
  // queryKey → reads cache, no second fetch). We overlay its tri-state grant +
  // Authorize/Disconnect onto the context's connector rows via the SAME
  // controller (D4: single action/confirmation path, not a re-implementation).
  const {
    agents: connectorAgents,
    pendingKey: connectorPendingKey,
    authorize: authorizeConnector,
    disconnect: disconnectConnector,
  } = useConnectorsController()

  // Land on the tab the navigation requested (defaults to 'agents'); re-sync
  // when either the context or the requested tab changes so a deep-link to the
  // same context but a different tab still switches.
  const [activeTab, setActiveTab] = useState<ContextTab>(selectedContextTab ?? 'agents')

  useEffect(() => {
    setActiveTab(selectedContextTab ?? 'agents')
  }, [selectedContext, selectedContextTab])

  const selectedContextDetails = useMemo(() => {
    if (!selectedContext || !contextsAccessCatalog) return null
    return {
      id: selectedContext,
      availableToUser: contextsAccessCatalog.userContextIds.includes(selectedContext),
      availableToTeam: contextsAccessCatalog.teamContextIds.includes(selectedContext),
      totalContexts: contextsAccessCatalog.contextIds.length,
      userId: contextsAccessCatalog.userId,
      teamId: contextsAccessCatalog.teamId || 'none',
    }
  }, [contextsAccessCatalog, selectedContext])

  const selectedContextName = selectedContext || 'Context details'
  const contextOptions = useMemo(() => {
    const optionsById = new Map<string, string>()
    for (const contextId of contextsAccessCatalog?.contextIds || []) {
      optionsById.set(contextId, contextId)
    }
    for (const entry of Object.values(teamDirectory)) {
      for (const contextId of entry.contextIds || []) {
        optionsById.set(contextId, contextId)
      }
    }
    return [...optionsById.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, label]) => ({ id, label }))
  }, [contextsAccessCatalog?.contextIds, teamDirectory])
  const selectedRow = useMemo(() => {
    if (!selectedContextDetails) return null
    return {
      id: selectedContextDetails.id,
      availableToUser: selectedContextDetails.availableToUser,
      availableToTeam: selectedContextDetails.availableToTeam,
    }
  }, [selectedContextDetails])

  const currentTeam = useMemo(
    () => teams.find(team => team.id === currentTeamId) ?? null,
    [teams, currentTeamId]
  )

  const contextTeamRows = useMemo(() => {
    if (!selectedContext) return []
    const hasAgentContextMap = Object.keys(agentContextByName).length > 0
    const scopedAgentNamesForTeam = (names: string[], contextIds: string[]) => {
      const uniqueNames = [...new Set(names || [])]
      if (!hasAgentContextMap) return uniqueNames
      const onlySelectedContext = contextIds.length === 1 && contextIds[0] === selectedContext
      return uniqueNames.filter(agentName => {
        const mappedContext = String(agentContextByName[agentName] || '').trim()
        if (mappedContext) return mappedContext === selectedContext
        return onlySelectedContext
      })
    }
    const rowsByTeamId = new Map<
      string,
      {
        agentNames: string[]
        members: typeof teamMembers
        team: (typeof teams)[number]
      }
    >()

    for (const team of teams) {
      const entry = teamDirectory[team.id]
      if (!entry?.contextIds.includes(selectedContext)) continue
      rowsByTeamId.set(team.id, {
        agentNames: scopedAgentNamesForTeam(entry.agentNames || [], entry.contextIds || []).sort(
          (a, b) => a.localeCompare(b)
        ),
        members: entry.members || [],
        team,
      })
    }

    if (
      selectedContextDetails?.availableToTeam &&
      currentTeam &&
      !rowsByTeamId.has(currentTeam.id)
    ) {
      rowsByTeamId.set(currentTeam.id, {
        agentNames: scopedAgentNamesForTeam(mcpAccessCatalog?.teamAgentNames || [], [
          selectedContext,
        ]).sort((a, b) => a.localeCompare(b)),
        members: teamMembers,
        team: currentTeam,
      })
    }

    return [...rowsByTeamId.values()].sort((left, right) =>
      left.team.name.localeCompare(right.team.name)
    )
  }, [
    agentContextByName,
    currentTeam,
    mcpAccessCatalog?.teamAgentNames,
    selectedContext,
    selectedContextDetails?.availableToTeam,
    teamDirectory,
    teamMembers,
    teams,
  ])

  const scopedAgents = useMemo(() => {
    if (!selectedContext) return []
    const rowsByAgentName = new Map<
      string,
      {
        connectors: string[]
        name: string
        teams: Array<{ id: string; name: string }>
      }
    >()

    const ensureAgent = (name: string) => {
      const agentName = name.trim()
      if (!agentName) return null
      const existing = rowsByAgentName.get(agentName)
      if (existing) return existing
      const row = {
        connectors: [...new Set(mcpServersByAgent[agentName] || [])].sort((a, b) =>
          a.localeCompare(b)
        ),
        name: agentName,
        teams: [],
      }
      rowsByAgentName.set(agentName, row)
      return row
    }

    for (const name of agentNames) {
      if (String(agentContextByName[name] || '').trim() === selectedContext) {
        ensureAgent(name)
      }
    }

    for (const teamRow of contextTeamRows) {
      for (const agentName of teamRow.agentNames) {
        const row = ensureAgent(agentName)
        if (!row || row.teams.some(team => team.id === teamRow.team.id)) continue
        row.teams.push({ id: teamRow.team.id, name: teamRow.team.name })
      }
    }

    return [...rowsByAgentName.values()]
      .map(row => ({
        ...row,
        teams: row.teams.sort((left, right) => left.name.localeCompare(right.name)),
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }, [agentContextByName, agentNames, contextTeamRows, mcpServersByAgent, selectedContext])

  const scopedAgentNames = useMemo(() => scopedAgents.map(agent => agent.name), [scopedAgents])

  const scopedMembers = useMemo(() => {
    if (!selectedContextDetails) return []
    const rows: Array<{ id: string; label: string; secondary?: string; role: string }> = []

    if (selectedContextDetails.availableToUser) {
      rows.push({
        id: selectedContextDetails.userId,
        label: me?.name || me?.email || selectedContextDetails.userId,
        secondary: me?.name && me?.email ? me.email : undefined,
        role: 'user',
      })
    }

    if (selectedContextDetails.availableToTeam) {
      for (const teamRow of contextTeamRows) {
        for (const member of teamRow.members) {
          rows.push({
            id: member.id,
            label: member.name || member.email,
            secondary: member.name ? member.email : undefined,
            role: member.role,
          })
        }
      }
    }

    const deduped = new Map<
      string,
      { id: string; label: string; secondary?: string; role: string }
    >()
    for (const item of rows) {
      if (!deduped.has(item.id)) deduped.set(item.id, item)
    }
    return [...deduped.values()]
  }, [contextTeamRows, me, selectedContextDetails])

  const hasContextCatalogMcpMap = useMemo(() => {
    if (!selectedContext || !mcpAccessCatalog?.contextMcpServers) return false
    return Object.prototype.hasOwnProperty.call(mcpAccessCatalog.contextMcpServers, selectedContext)
  }, [mcpAccessCatalog, selectedContext])

  const hasDerivedContextMcpMap = useMemo(() => {
    if (!selectedContext) return false
    for (const agentName of scopedAgentNames) {
      if ((mcpServersByAgent[agentName] || []).length > 0) return true
    }
    return false
  }, [mcpServersByAgent, scopedAgentNames, selectedContext])

  const contextMcpServerDetails = useMemo(() => {
    const detailsByName = new Map(
      selectedContextMcpServerDetails.map(server => [server.name, server])
    )
    const serverNames = new Set(detailsByName.keys())
    for (const agentName of scopedAgentNames) {
      for (const serverName of mcpServersByAgent[agentName] || []) {
        serverNames.add(serverName)
      }
    }
    for (const server of selectedContextMcpServers) {
      serverNames.add(server.name)
    }

    const selectedUrlByName = new Map(
      selectedContextMcpServers.map(server => [server.name, server.url || ''])
    )
    const globalUrlByName = new Map(globalMcpServers.map(server => [server.name, server.url || '']))

    return [...serverNames]
      .sort((left, right) => left.localeCompare(right))
      .map(serverName => {
        const existing = detailsByName.get(serverName)
        const mappedAgents = new Set(existing?.mappedAgents || [])
        for (const agentName of scopedAgentNames) {
          if ((mcpServersByAgent[agentName] || []).includes(serverName)) {
            mappedAgents.add(agentName)
          }
        }
        const mappedAgentNames = [...mappedAgents].sort((left, right) => left.localeCompare(right))
        const url =
          existing?.url || selectedUrlByName.get(serverName) || globalUrlByName.get(serverName)
        return {
          name: serverName,
          ...(url ? { url } : {}),
          mappedAgentCount: Math.max(existing?.mappedAgentCount || 0, mappedAgentNames.length),
          mappedAgents: mappedAgentNames,
          mappingSource:
            existing?.mappingSource ||
            (mappedAgentNames.length ? 'agent-derived' : 'workspace-preview'),
        }
      })
  }, [
    globalMcpServers,
    mcpServersByAgent,
    scopedAgentNames,
    selectedContextMcpServerDetails,
    selectedContextMcpServers,
  ])

  const contextMcpServerMappingAvailable =
    selectedContextMcpServerMappingAvailable || contextMcpServerDetails.length > 0

  // Read-model rows for THIS context only, indexed by server name so each table
  // row can look up its grant/actions. Empty (no status/actions) when the
  // connectors query is not yet cached — graceful degrade, never a fetch.
  const connectorRowByName = useMemo(() => {
    const rows = deriveConnectorRows(
      connectorAgents.filter(agent => agent.contextRef === selectedContext)
    )
    return new Map(rows.map(row => [row.connector.name, row]))
  }, [connectorAgents, selectedContext])

  const contextMcpUnavailableBody = useMemo(() => {
    if (!selectedContext) return mcpServerMappingUnavailableMessage
    if (selectedContextMcpServersUnscoped) {
      return `No context-scoped mapping was found for "${selectedContext}". The workspace preview is unscoped, so it cannot confirm which connectors belong to this context.`
    }
    const missingSources: string[] = []
    if (!hasContextCatalogMcpMap) {
      missingSources.push('catalog contextMcpServers entry')
    }
    if (!hasDerivedContextMcpMap) {
      missingSources.push('agent-derived context mapping')
    }
    if (!missingSources.length) {
      return mcpServerMappingUnavailableMessage
    }
    return `No context-scoped MCP mapping is available for "${selectedContext}". Missing source(s): ${missingSources.join(', ')}.`
  }, [
    hasContextCatalogMcpMap,
    hasDerivedContextMcpMap,
    mcpServerMappingUnavailableMessage,
    selectedContext,
    selectedContextMcpServersUnscoped,
  ])

  const contextMcpNoServersBody = useMemo(() => {
    if (!selectedContext) return 'No connectors are currently mapped to this context.'
    if (selectedContextMcpServersUnscoped) {
      return `The workspace MCP preview returned ${globalMcpServers.length} server(s), but none can be safely assigned to "${selectedContext}" from scoped data.`
    }
    return `No connectors are currently mapped to "${selectedContext}".`
  }, [globalMcpServers.length, selectedContext, selectedContextMcpServersUnscoped])

  if (!selectedContext || !selectedRow || !selectedContextDetails) {
    return (
      <section className="page context-detail-page">
        <PageBreadcrumb
          ariaLabel="Context breadcrumb"
          items={[
            { label: 'Contexts', onClick: handleBackToContexts },
            { label: selectedContextName, onClick: handleBackToContexts },
          ]}
        />
        <div className="page-header">
          <h2>{selectedContextName}</h2>
          <p className="muted">Agents, teams, and members mapped to this context.</p>
        </div>
        <section className="teams-detail-page-card">
          <EmptyState
            title="Context not found"
            body="This context is not available in your workspace scope."
          />
        </section>
      </section>
    )
  }

  return (
    <section className="page context-detail-page">
      <PageBreadcrumb
        ariaLabel="Context breadcrumb"
        items={[
          { label: 'Contexts', onClick: handleBackToContexts },
          {
            label: (
              <ResourceBreadcrumbSwitcher
                ariaLabel="Switch context"
                emptyLabel="No contexts"
                options={contextOptions}
                selectedId={selectedRow.id}
                selectedLabel={selectedRow.id}
                onSelect={handleOpenContextDetails}
              />
            ),
          },
        ]}
      />

      <section className="teams-detail-page-card">
        <div className="page-card__header">
          <div>
            <h3>{selectedRow.id}</h3>
            <p className="muted">
              Review context details, agents, teams, and members from the available API scope.
            </p>
          </div>
        </div>

        <nav className="page-tabs context-tabs" aria-label="Context sections">
          <TabButton
            active={activeTab === 'agents'}
            className="context-tab"
            onClick={() => setActiveTab('agents')}
          >
            Agents
          </TabButton>
          <TabButton
            active={activeTab === 'mcp-servers'}
            className="context-tab"
            onClick={() => setActiveTab('mcp-servers')}
          >
            Connectors
          </TabButton>
          <TabButton
            active={activeTab === 'teams'}
            className="context-tab"
            onClick={() => setActiveTab('teams')}
          >
            Teams
          </TabButton>
          <TabButton
            active={activeTab === 'members'}
            className="context-tab"
            onClick={() => setActiveTab('members')}
          >
            Members
          </TabButton>
          <TabButton
            active={activeTab === 'shared-files'}
            className="context-tab"
            onClick={() => setActiveTab('shared-files')}
          >
            Agent Files
          </TabButton>
        </nav>

        {activeTab === 'agents' && (
          <div className="context-resource-list">
            {!scopedAgents.length && (
              <EmptyState title="No agents" body="No agents are mapped to this context." />
            )}
            {!!scopedAgents.length && (
              <DataTable className="context-agents-data-table">
                <thead>
                  <tr>
                    <th className="da-table__col-header" scope="col">
                      Agent
                    </th>
                    <th className="da-table__col-header" scope="col">
                      Teams
                    </th>
                    <th className="da-table__col-header" scope="col">
                      Connectors
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {scopedAgents.map(agent => (
                    <tr
                      key={agent.name}
                      className="da-table__row--clickable"
                      {...clickableRowProps(() => handleOpenAgentWorkspace(agent.name), {
                        ariaLabel: `Open agent ${agent.name}`,
                      })}
                    >
                      <td className="da-table__cell">
                        <span className="context-id-cell">
                          {/* Visible agent name (spec.host). The catalog map is
                              total only over catalog agents; scopedAgents also
                              carries cross-team agents added from the team
                              directory (no catalog display source), so fall back
                              to the identifier for those — not the Decision #6
                              `|| name` guard. */}
                          <strong>{agentDisplayByName[agent.name] ?? agent.name}</strong>
                        </span>
                      </td>
                      <td className="da-table__cell">
                        {agent.teams.length ? (
                          <span className="reference-tag-list">
                            {agent.teams.map(team => (
                              <ReferenceTag
                                key={`${agent.name}:${team.id}`}
                                kind="team"
                                onClick={event => {
                                  event.stopPropagation()
                                  handleOpenTeamDetails(team.id)
                                }}
                                title={team.name}
                                aria-label={`Open team ${team.name}`}
                              >
                                {team.name}
                              </ReferenceTag>
                            ))}
                          </span>
                        ) : (
                          <span className="agent-table-muted">-</span>
                        )}
                      </td>
                      <td className="da-table__cell">
                        {agent.connectors.length ? (
                          <span className="reference-tag-list">
                            {agent.connectors.map(serverName => (
                              <ReferenceTag
                                key={`${agent.name}:${serverName}`}
                                kind="connector"
                                onClick={event => {
                                  event.stopPropagation()
                                  handleOpenAgentWorkspace(agent.name, 'mcp-servers')
                                }}
                                title={serverName}
                                aria-label={`Open ${serverName} connectors for agent ${agent.name}`}
                              >
                                {serverName}
                              </ReferenceTag>
                            ))}
                          </span>
                        ) : (
                          <span className="agent-table-muted">None</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )}
          </div>
        )}

        {activeTab === 'mcp-servers' && (
          <div className="context-resource-list">
            {selectedContextMcpServersUnscoped && (
              <p className="muted">
                Preview mode: this list is not yet filtered by the selected context.
              </p>
            )}
            {!contextMcpServerMappingAvailable && (
              <EmptyState title="Connector mapping unavailable" body={contextMcpUnavailableBody} />
            )}
            {contextMcpServerMappingAvailable && !contextMcpServerDetails.length && (
              <EmptyState title="No connectors" body={contextMcpNoServersBody} />
            )}
            {contextMcpServerMappingAvailable && contextMcpServerDetails.length > 0 && (
              <DataTable className="context-mcp-servers-data-table">
                <thead>
                  <tr>
                    <th className="da-table__col-header" scope="col">
                      Server
                    </th>
                    <th className="da-table__col-header da-table__col-header--center" scope="col">
                      Agents
                    </th>
                    <th className="da-table__col-header" scope="col">
                      Mapped agent names
                    </th>
                    <th className="da-table__col-header" scope="col">
                      Status
                    </th>
                    <th className="da-table__col-header da-table__col-header--right" scope="col">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {contextMcpServerDetails.map(server => {
                    // Overlay the shared read-model onto this mapping row. No
                    // match (or query not cached) → no status/actions, degrade
                    // to a muted dash rather than fabricating a grant.
                    const connectorRow = connectorRowByName.get(server.name)
                    const connector = connectorRow?.connector
                    const presentation = connector ? statusPresentation(connector.status) : null
                    const caption = connector ? scopeCaption(connector) : null
                    const busy = connectorRow ? connectorPendingKey === connectorRow.key : false
                    // Same action contract as the top-level panel: mint under
                    // the row's representative agent for THIS context.
                    const actionInput: ConnectorActionInput | null = connectorRow
                      ? {
                          agentName: connectorRow.representativeAgent,
                          contextRef: connectorRow.contextRef,
                          connector: connectorRow.connector,
                        }
                      : null
                    const actionable = Boolean(
                      connector && isActionableConnector(connector) && actionInput
                    )
                    return (
                      <tr key={server.name}>
                        <td className="da-table__cell">
                          <span className="context-mcp-server-name">{server.name}</span>
                        </td>
                        <td className="da-table__cell da-table__cell--center">
                          <span className="context-mcp-count">{server.mappedAgentCount}</span>
                        </td>
                        <td className="da-table__cell">
                          {server.mappedAgents.length > 0 ? (
                            <span className="reference-tag-list">
                              {server.mappedAgents.map(agentName => (
                                <ReferenceTag
                                  key={`${server.name}:${agentName}`}
                                  kind="agent"
                                  onClick={() => handleOpenAgentWorkspace(agentName, 'mcp-servers')}
                                  title={agentName}
                                  aria-label={`Open connectors for agent ${agentName}`}
                                >
                                  {/* Visible agent name (spec.host). mappedAgents
                                      can include cross-team agents (from scoped
                                      context detail sources) absent from the
                                      catalog map, so fall back to the identifier
                                      for those — not the Decision #6 `|| name`
                                      guard. */}
                                  {agentDisplayByName[agentName] ?? agentName}
                                </ReferenceTag>
                              ))}
                            </span>
                          ) : (
                            <span className="context-mcp-agent-list">-</span>
                          )}
                        </td>
                        <td className="da-table__cell">
                          {presentation ? (
                            <Pill tone={presentation.tone} size="sm" title={caption ?? undefined}>
                              {presentation.label}
                            </Pill>
                          ) : (
                            <span className="agent-table-muted">—</span>
                          )}
                        </td>
                        <td className="da-table__cell da-table__cell--right">
                          {actionable && actionInput ? (
                            connector?.status === 'authorized' ? (
                              <Button
                                color="danger"
                                disabled={busy}
                                loading={busy}
                                onClick={event => {
                                  event.stopPropagation()
                                  disconnectConnector(actionInput).catch(() => undefined)
                                }}
                                size="sm"
                                variant="ghost"
                              >
                                Disconnect
                              </Button>
                            ) : (
                              <Button
                                color="primary"
                                disabled={busy}
                                loading={busy}
                                onClick={event => {
                                  event.stopPropagation()
                                  authorizeConnector(actionInput).catch(() => undefined)
                                }}
                                size="sm"
                                variant="soft"
                              >
                                Authorize
                              </Button>
                            )
                          ) : (
                            <span className="agent-table-muted">—</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </DataTable>
            )}
          </div>
        )}

        {activeTab === 'teams' && (
          <div className="context-resource-list">
            {!contextTeamRows.length && (
              <EmptyState
                title="No team access"
                body="No team is mapped to this context in this API scope."
              />
            )}
            {contextTeamRows.length > 0 && (
              <DataTable className="context-teams-data-table">
                <thead>
                  <tr>
                    <th className="da-table__col-header" scope="col">
                      Team
                    </th>
                    <th className="da-table__col-header da-table__col-header--center" scope="col">
                      Role
                    </th>
                    <th className="da-table__col-header da-table__col-header--center" scope="col">
                      Context Access
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {contextTeamRows.map(row => (
                    <tr
                      key={row.team.id}
                      className="da-table__row--clickable"
                      {...clickableRowProps(() => handleOpenTeamDetails(row.team.id), {
                        ariaLabel: `Open team ${row.team.name}`,
                      })}
                    >
                      <td className="da-table__cell">
                        <ReferenceTag kind="team" title={row.team.name}>
                          {row.team.name}
                        </ReferenceTag>
                      </td>
                      <td className="da-table__cell da-table__cell--center">
                        <span className="context-scope-badge context-scope-team">
                          {row.team.role}
                        </span>
                      </td>
                      <td className="da-table__cell da-table__cell--center">
                        <span className="context-access-pill allowed">Allowed</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )}
          </div>
        )}

        {activeTab === 'shared-files' && (
          <div className="context-resource-list">
            <SharedFilesTab contextId={selectedRow.id} />
          </div>
        )}

        {activeTab === 'members' && (
          <div className="context-resource-list">
            {!scopedMembers.length && (
              <EmptyState
                title="No members"
                body="No members are mapped in the available API scope for this context."
              />
            )}
            {scopedMembers.length > 0 && (
              <DataTable className="context-members-data-table">
                <thead>
                  <tr>
                    <th className="da-table__col-header" scope="col">
                      Member
                    </th>
                    <th className="da-table__col-header" scope="col">
                      Email
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {scopedMembers.map(member => (
                    <tr key={member.id}>
                      <td className="da-table__cell">
                        <span className="context-members-name">{member.label}</span>
                      </td>
                      <td className="da-table__cell">
                        <span className="context-members-email">{member.secondary || '-'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )}
          </div>
        )}
      </section>
    </section>
  )
}
