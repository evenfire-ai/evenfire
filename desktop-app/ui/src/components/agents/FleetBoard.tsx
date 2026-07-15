import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAgentActivityContext } from '@contexts/AgentActivityContext'
import { useAgentChatActionsContext } from '@contexts/AgentChatActionsContext'
import { useNavigationContext } from '@contexts/NavigationContext'
import {
  Button,
  DataTable,
  DataTableFilter,
  EmptyState,
  MenuItem,
  ReferenceTag,
} from '@components/Common'
import { IconAgents } from '@components/SidebarNav/icons'
import { useAgentsDataController } from '@hooks/domain/useAgentsDataController'
import { useMcpServersDataController } from '@hooks/domain/useMcpServersDataController'
import { useTeamsDataController } from '@hooks/domain/useTeamsDataController'
import { clickableRowProps } from '../../lib/clickableRowProps'
import {
  formatMcpServerAcronym,
  formatMcpServerDisplayName,
  formatRelativeTime,
} from '../../lib/format'
import { AGENT_ROUTE_LABELS, AGENT_ROUTE_OPTIONS } from './agentRoutes'

const AGENT_ROUTE_ACTIONS = AGENT_ROUTE_OPTIONS.map(route => ({
  label: AGENT_ROUTE_LABELS[route],
  route,
}))

type AgentScopeFilter = 'all' | 'team' | 'mine'

const AGENT_SCOPE_FILTER_OPTIONS: Array<{ label: string; value: AgentScopeFilter }> = [
  { label: 'All agents', value: 'all' },
  { label: 'My team agents', value: 'team' },
  { label: 'My agents', value: 'mine' },
]

export function FleetBoard() {
  const { agentNames, userAgentNames, teamAgentNames } = useAgentsDataController()
  const {
    teams,
    currentTeamId,
    teamDirectory,
    ensureHydrated: ensureTeamsHydrated,
  } = useTeamsDataController()
  const { agentMcpServerCountByAgent, agentMcpServersByAgent, mcpServerMappingUnavailableMessage } =
    useMcpServersDataController()
  const {
    handleOpenAgentWorkspace: onOpenAgentWorkspace,
    handleOpenTeamDetails: onOpenTeamDetails,
    handleSelectChatAgent: onSelectAgent,
    selectedAgent,
  } = useNavigationContext()
  const { agentLastActiveByAgent } = useAgentActivityContext()
  const { handleCreateChat: onCreateChat } = useAgentChatActionsContext()

  const [agentScopeFilter, setAgentScopeFilter] = useState<AgentScopeFilter>('all')
  const [fleetMenuAgent, setFleetMenuAgent] = useState<string | null>(null)
  const [fleetMenuPosition, setFleetMenuPosition] = useState<{ top: number; left: number } | null>(
    null
  )
  const [pendingCreateChatForAgent, setPendingCreateChatForAgent] = useState<string | null>(null)
  const fleetMenuRef = useRef<HTMLDivElement | null>(null)

  const agentMockDescription =
    'Workspace assistant for operations and support tasks. (Mock description; backend profile connection pending.)'

  // When selectedAgent catches up to the pending agent, create a chat
  useEffect(() => {
    if (!pendingCreateChatForAgent || selectedAgent !== pendingCreateChatForAgent) return
    setPendingCreateChatForAgent(null)
    void Promise.resolve(onCreateChat())
  }, [onCreateChat, pendingCreateChatForAgent, selectedAgent])

  useEffect(() => {
    void ensureTeamsHydrated()
  }, [ensureTeamsHydrated])

  // Fleet menu outside-click + escape + resize/scroll close effect
  useEffect(() => {
    if (!fleetMenuAgent) return
    const handleOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (fleetMenuRef.current?.contains(target)) return
      setFleetMenuAgent(null)
      setFleetMenuPosition(null)
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFleetMenuAgent(null)
        setFleetMenuPosition(null)
      }
    }
    const closeOnViewportChange = () => {
      setFleetMenuAgent(null)
      setFleetMenuPosition(null)
    }
    window.addEventListener('mousedown', handleOutside)
    window.addEventListener('keydown', handleEscape)
    window.addEventListener('resize', closeOnViewportChange)
    window.addEventListener('scroll', closeOnViewportChange, true)
    return () => {
      window.removeEventListener('mousedown', handleOutside)
      window.removeEventListener('keydown', handleEscape)
      window.removeEventListener('resize', closeOnViewportChange)
      window.removeEventListener('scroll', closeOnViewportChange, true)
    }
  }, [fleetMenuAgent])

  const currentTeamName = useMemo(
    () => teams.find(team => team.id === currentTeamId)?.name || 'Workspace team',
    [currentTeamId, teams]
  )

  const teamScopesByAgent = useMemo(() => {
    const scopesByAgent = new Map<string, Array<{ id: string; name: string }>>()
    const addTeamScope = (agentName: string, team: { id: string; name: string }) => {
      const normalizedAgentName = agentName.trim()
      if (!normalizedAgentName || !team.id) return
      const existing = scopesByAgent.get(normalizedAgentName) || []
      if (!existing.some(scope => scope.id === team.id)) {
        existing.push({ id: team.id, name: team.name })
      }
      scopesByAgent.set(normalizedAgentName, existing)
    }

    for (const team of teams) {
      const agentNamesForTeam = teamDirectory[team.id]?.agentNames || []
      for (const agentName of agentNamesForTeam) {
        addTeamScope(agentName, team)
      }
    }

    if (currentTeamId) {
      for (const agentName of teamAgentNames) {
        addTeamScope(agentName, { id: currentTeamId, name: currentTeamName })
      }
    }

    for (const scopes of scopesByAgent.values()) {
      scopes.sort((left, right) => left.name.localeCompare(right.name))
    }

    return scopesByAgent
  }, [currentTeamId, currentTeamName, teamAgentNames, teamDirectory, teams])

  const allFleetAgentNames = useMemo(() => {
    return [...new Set(agentNames.map(agentName => agentName.trim()).filter(Boolean))]
  }, [agentNames])

  const agentFleetRows = useMemo(
    () =>
      [...allFleetAgentNames]
        .sort((a, b) => a.localeCompare(b))
        .map(agent => {
          const userScoped = userAgentNames.includes(agent)
          const teamScopes = teamScopesByAgent.get(agent) || []
          const teamScoped = teamScopes.length > 0
          const mcpServers = Array.from(
            new Set(
              (agentMcpServersByAgent[agent] || [])
                .map(server => String(server.name || '').trim())
                .filter(Boolean)
            )
          ).sort((a, b) => a.localeCompare(b))
          const mcpServerCount = agentMcpServerCountByAgent[agent] ?? null
          const status: 'running' | 'idle' | 'error' =
            mcpServerCount == null ? 'error' : mcpServerCount > 0 ? 'running' : 'idle'
          const statusLabel =
            status === 'running' ? 'Running' : status === 'idle' ? 'Idle' : 'Error'
          const statusDescription =
            status === 'running'
              ? `${mcpServerCount} mapped connector${mcpServerCount === 1 ? '' : 's'}`
              : status === 'idle'
                ? 'No mapped connectors'
                : 'Mapping unavailable'
          return {
            agent,
            status,
            statusLabel,
            statusDescription,
            mcpServers,
            mcpServerCount,
            userScoped,
            teamScoped,
            teamScopes,
            lastActiveLabel: formatRelativeTime(agentLastActiveByAgent[agent] || null),
          }
        }),
    [
      agentLastActiveByAgent,
      agentMcpServerCountByAgent,
      agentMcpServersByAgent,
      allFleetAgentNames,
      teamScopesByAgent,
      userAgentNames,
    ]
  )

  const filteredFleetRows = useMemo(() => {
    if (agentScopeFilter === 'mine') return agentFleetRows.filter(row => row.userScoped)
    if (agentScopeFilter === 'team') return agentFleetRows.filter(row => row.teamScoped)
    return agentFleetRows
  }, [agentScopeFilter, agentFleetRows])

  return (
    <section className="page">
      <div className="page-header">
        <h2>Agents</h2>
        <p className="muted">Create, manage, and monitor your AI agents from one place.</p>
      </div>

      <div className="page-layout">
        <section className="page-card agents-fleet-board-card">
          <section className="agents-table-card">
            {!filteredFleetRows.length ? (
              <EmptyState title="No agents" body="No agents match the selected filter." />
            ) : (
              <DataTable frameless fullBleed className="agents-data-table">
                <thead>
                  <tr>
                    <th className="da-table__col-header" scope="col">
                      Agent name
                    </th>
                    <th className="da-table__col-header" scope="col">
                      <DataTableFilter
                        active={agentScopeFilter !== 'all'}
                        ariaLabel="Filter agents by access"
                        label="Access"
                        options={AGENT_SCOPE_FILTER_OPTIONS}
                        value={agentScopeFilter}
                        variant="icon"
                        onChange={setAgentScopeFilter}
                      />
                    </th>
                    <th className="da-table__col-header" scope="col">
                      Last active
                    </th>
                    <th className="da-table__col-header" scope="col">
                      Connectors
                    </th>
                    <th className="da-table__col-header da-table__col-header--center" scope="col">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredFleetRows.map(row => (
                    <tr
                      key={row.agent}
                      className="da-table__row--clickable agents-table-row-clickable"
                      {...clickableRowProps(() => onOpenAgentWorkspace(row.agent, 'details'), {
                        ariaLabel: `Open details for ${row.agent}`,
                      })}
                    >
                      <td className="da-table__cell">
                        <div className="agent-row-main">
                          <span className="agent-row-icon" aria-hidden="true">
                            <IconAgents />
                          </span>
                          <div className="agent-row-main-copy">
                            <strong>{row.agent}</strong>
                            <span className="agent-row-description" title={agentMockDescription}>
                              {agentMockDescription}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td className="da-table__cell">
                        <div
                          className="agent-row-scope-tags"
                          aria-label={`Access for ${row.agent}`}
                        >
                          {row.userScoped && <ReferenceTag kind="user">My agents</ReferenceTag>}
                          {row.teamScopes.map(team => (
                            <ReferenceTag
                              key={`${row.agent}:${team.id}`}
                              kind="team"
                              onClick={event => {
                                event.stopPropagation()
                                onOpenTeamDetails(team.id)
                              }}
                              title={team.name}
                              aria-label={`Open team ${team.name}`}
                            >
                              {team.name}
                            </ReferenceTag>
                          ))}
                          {!row.userScoped && !row.teamScopes.length && (
                            <span className="agent-table-muted">No access source</span>
                          )}
                        </div>
                      </td>
                      <td className="da-table__cell">
                        <span className="agent-table-muted">{row.lastActiveLabel}</span>
                      </td>
                      <td className="da-table__cell">
                        <button
                          type="button"
                          className="agent-table-mcp-button"
                          onClick={event => {
                            event.stopPropagation()
                            onOpenAgentWorkspace(row.agent, 'mcp-servers')
                          }}
                          onKeyDown={event => event.stopPropagation()}
                          aria-label={`Open connectors for ${row.agent}`}
                        >
                          <span className="agent-table-mcp agent-table-mcp-list">
                            {row.mcpServerCount == null && (
                              <span
                                className="agent-table-mcp-unavailable"
                                title={mcpServerMappingUnavailableMessage}
                              >
                                Unavailable
                              </span>
                            )}
                            {row.mcpServerCount != null && row.mcpServers.length === 0 && (
                              <span className="agent-table-mcp-unavailable">None</span>
                            )}
                            {row.mcpServerCount != null && row.mcpServers.length > 0 && (
                              <>
                                {row.mcpServers.slice(0, 3).map(serverName => (
                                  <span
                                    key={`${row.agent}:${serverName}`}
                                    className="agent-mcp-dot"
                                    title={formatMcpServerDisplayName(serverName)}
                                  >
                                    {formatMcpServerAcronym(serverName)}
                                  </span>
                                ))}
                                {row.mcpServers.length > 3 && (
                                  <span className="agent-table-muted">
                                    +{row.mcpServers.length - 3}
                                  </span>
                                )}
                              </>
                            )}
                          </span>
                        </button>
                      </td>
                      <td className="da-table__cell da-table__cell--center">
                        <div className="agent-table-actions-cell">
                          <Button
                            className="agent-table-row-action"
                            color="neutral"
                            onClick={event => {
                              event.stopPropagation()
                              const trigger = event.currentTarget
                              const rect = trigger.getBoundingClientRect()
                              const menuWidth = 136
                              const menuHeight = 240
                              const edgePadding = 8
                              const openUp =
                                rect.bottom + menuHeight + edgePadding > window.innerHeight
                              const top = openUp ? rect.top - menuHeight - 6 : rect.bottom + 6
                              const left = Math.max(
                                edgePadding,
                                Math.min(
                                  rect.right - menuWidth,
                                  window.innerWidth - menuWidth - edgePadding
                                )
                              )
                              if (fleetMenuAgent === row.agent) {
                                setFleetMenuAgent(null)
                                setFleetMenuPosition(null)
                                return
                              }
                              setFleetMenuAgent(row.agent)
                              setFleetMenuPosition({ top, left })
                            }}
                            onKeyDown={event => event.stopPropagation()}
                            aria-label={`More actions for ${row.agent}`}
                            aria-haspopup="menu"
                            aria-expanded={fleetMenuAgent === row.agent}
                            size="xs"
                            variant="ghost"
                          >
                            ...
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )}
          </section>
          {fleetMenuAgent &&
            fleetMenuPosition &&
            createPortal(
              <div
                ref={fleetMenuRef}
                className="agent-fleet-row-menu"
                role="menu"
                style={{ top: fleetMenuPosition.top, left: fleetMenuPosition.left }}
              >
                <MenuItem
                  className="agent-fleet-row-menu-item"
                  onClick={event => {
                    event.stopPropagation()
                    const agentName = fleetMenuAgent
                    if (!agentName) return
                    setFleetMenuAgent(null)
                    setFleetMenuPosition(null)
                    setPendingCreateChatForAgent(agentName)
                    onSelectAgent(agentName, { selectLatest: false })
                  }}
                >
                  New chat
                </MenuItem>
                <div className="agent-fleet-row-menu-divider" role="separator" />
                {AGENT_ROUTE_ACTIONS.map(action => (
                  <MenuItem
                    key={action.route}
                    className="agent-fleet-row-menu-item"
                    onClick={event => {
                      event.stopPropagation()
                      const agentName = fleetMenuAgent
                      if (!agentName) return
                      setFleetMenuAgent(null)
                      setFleetMenuPosition(null)
                      onOpenAgentWorkspace(agentName, action.route)
                    }}
                  >
                    {action.label}
                  </MenuItem>
                ))}
              </div>,
              document.body
            )}
        </section>
      </div>
    </section>
  )
}
