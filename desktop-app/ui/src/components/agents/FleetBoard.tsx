import { useEffect, useMemo, useState } from 'react'
import { useAgentActivityContext } from '@contexts/AgentActivityContext'
import { useAgentChatActionsContext } from '@contexts/AgentChatActionsContext'
import { useNavigationContext } from '@contexts/NavigationContext'
import { Button as AntButton, Dropdown, Empty, Flex, Select, Table, Tag, Typography } from 'antd'
import type { MenuProps, TableColumnsType } from 'antd'
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

type AgentFleetRow = {
  agent: string
  display: string
  status: 'running' | 'idle' | 'error'
  statusLabel: string
  statusDescription: string
  mcpServers: string[]
  mcpServerCount: number | null
  userScoped: boolean
  teamScoped: boolean
  teamScopes: Array<{ id: string; name: string }>
  lastActiveLabel: string
}

const AGENT_SCOPE_FILTER_OPTIONS: Array<{ label: string; value: AgentScopeFilter }> = [
  { label: 'All agents', value: 'all' },
  { label: 'My team agents', value: 'team' },
  { label: 'My agents', value: 'mine' },
]

export function FleetBoard() {
  const { agentNames, agentDisplayByName, userAgentNames, teamAgentNames } =
    useAgentsDataController()
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
    handleSelectChatAgent: onSelectAgent,
    selectedAgent,
  } = useNavigationContext()
  const { agentLastActiveByAgent } = useAgentActivityContext()
  const { handleCreateChat: onCreateChat } = useAgentChatActionsContext()

  const [agentScopeFilter, setAgentScopeFilter] = useState<AgentScopeFilter>('all')
  const [fleetMenuAgent, setFleetMenuAgent] = useState<string | null>(null)
  const [pendingCreateChatForAgent, setPendingCreateChatForAgent] = useState<string | null>(null)

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

  // Ant Design Dropdown owns outside-click and Escape behavior. Preserve the
  // prior close-on-viewport-change lifecycle for the open row menu.
  useEffect(() => {
    if (!fleetMenuAgent) return
    const closeOnViewportChange = () => {
      setFleetMenuAgent(null)
    }
    window.addEventListener('resize', closeOnViewportChange)
    window.addEventListener('scroll', closeOnViewportChange, true)
    return () => {
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

  const agentFleetRows = useMemo<AgentFleetRow[]>(
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
          // Visible name = agent `spec.host` display name; total over catalog
          // agents at the producer, so the identifier is only a fallback
          // (Decision #6 parity with the rest of the desktop surfaces).
          const display = agentDisplayByName[agent] ?? agent
          return {
            agent,
            display,
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
      agentDisplayByName,
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

  const fleetMenuItems: MenuProps['items'] = [
    { key: 'new-chat', label: 'New chat' },
    { type: 'divider' },
    ...AGENT_ROUTE_ACTIONS.map(action => ({
      key: `route:${action.route}`,
      label: action.label,
    })),
  ]

  const handleFleetMenuAction = (agentName: string, key: string) => {
    setFleetMenuAgent(null)
    if (key === 'new-chat') {
      setPendingCreateChatForAgent(agentName)
      onSelectAgent(agentName, { selectLatest: false })
      return
    }
    const route = key.startsWith('route:') ? key.slice('route:'.length) : ''
    if (AGENT_ROUTE_OPTIONS.includes(route as (typeof AGENT_ROUTE_OPTIONS)[number])) {
      onOpenAgentWorkspace(agentName, route as (typeof AGENT_ROUTE_OPTIONS)[number])
    }
  }

  const columns: TableColumnsType<AgentFleetRow> = [
    {
      key: 'agent',
      title: 'Agent name',
      render: (_value, row) => (
        <Flex align="center" gap="small" className="agent-row-main">
          <span className="agent-row-icon" aria-hidden="true">
            <IconAgents width={15} height={15} />
          </span>
          <Flex vertical className="agent-row-main-copy">
            <Typography.Text strong>{row.display}</Typography.Text>
            {row.display !== row.agent ? (
              <Typography.Text className="agent-row-description" title={row.agent} type="secondary">
                {row.agent}
              </Typography.Text>
            ) : null}
            <Typography.Text
              className="agent-row-description"
              title={agentMockDescription}
              type="secondary"
            >
              {agentMockDescription}
            </Typography.Text>
          </Flex>
        </Flex>
      ),
    },
    {
      key: 'access',
      title: (
        <Flex align="center" justify="space-between" gap="small">
          <span>Access</span>
          <Select<AgentScopeFilter>
            aria-label="Filter agents by access"
            size="small"
            value={agentScopeFilter}
            options={AGENT_SCOPE_FILTER_OPTIONS}
            onChange={setAgentScopeFilter}
          />
        </Flex>
      ),
      render: (_value, row) => (
        <Flex wrap gap="small" aria-label={`Access for ${row.display}`}>
          {row.userScoped ? <Tag color="blue">My agents</Tag> : null}
          {row.teamScopes.map(team => (
            <Tag key={`${row.agent}:${team.id}`} color="green" title={team.name}>
              {team.name}
            </Tag>
          ))}
          {!row.userScoped && !row.teamScopes.length ? (
            <Typography.Text type="secondary">No access source</Typography.Text>
          ) : null}
        </Flex>
      ),
    },
    {
      key: 'last-active',
      title: 'Last active',
      render: (_value, row) => (
        <Typography.Text type="secondary">{row.lastActiveLabel}</Typography.Text>
      ),
    },
    {
      key: 'connectors',
      title: 'Connectors',
      render: (_value, row) => (
        <AntButton
          htmlType="button"
          type="text"
          size="small"
          onClick={event => {
            event.stopPropagation()
            onOpenAgentWorkspace(row.agent, 'mcp-servers')
          }}
          onKeyDown={event => event.stopPropagation()}
          aria-label={`Open connectors for ${row.display}`}
        >
          <Flex align="center" gap="small" wrap>
            {row.mcpServerCount == null ? (
              <Typography.Text title={mcpServerMappingUnavailableMessage} type="secondary">
                Unavailable
              </Typography.Text>
            ) : row.mcpServers.length === 0 ? (
              <Typography.Text type="secondary">None</Typography.Text>
            ) : (
              <>
                {row.mcpServers.slice(0, 3).map(serverName => (
                  <Tag
                    key={`${row.agent}:${serverName}`}
                    title={formatMcpServerDisplayName(serverName)}
                  >
                    {formatMcpServerAcronym(serverName)}
                  </Tag>
                ))}
                {row.mcpServers.length > 3 ? (
                  <Typography.Text type="secondary">+{row.mcpServers.length - 3}</Typography.Text>
                ) : null}
              </>
            )}
          </Flex>
        </AntButton>
      ),
    },
    {
      key: 'actions',
      title: 'Actions',
      align: 'center',
      render: (_value, row) => (
        <Dropdown
          trigger={['click']}
          placement="bottomRight"
          open={fleetMenuAgent === row.agent}
          menu={{
            items: fleetMenuItems,
            onClick: ({ key, domEvent }) => {
              domEvent.stopPropagation()
              handleFleetMenuAction(row.agent, key)
            },
          }}
          onOpenChange={open => setFleetMenuAgent(open ? row.agent : null)}
        >
          <AntButton
            htmlType="button"
            type="text"
            size="small"
            onClick={event => event.stopPropagation()}
            onKeyDown={event => event.stopPropagation()}
            aria-label={`More actions for ${row.display}`}
            aria-haspopup="menu"
            aria-expanded={fleetMenuAgent === row.agent}
          >
            ...
          </AntButton>
        </Dropdown>
      ),
    },
  ]

  return (
    <section className="page">
      <div className="page-header">
        <h2>Agents</h2>
        <p className="muted">Create, manage, and monitor your AI agents from one place.</p>
      </div>

      <div className="page-layout">
        <section className="page-card agents-fleet-board-card">
          <section>
            {!filteredFleetRows.length ? (
              <Empty description="No agents match the selected filter." />
            ) : (
              <Table<AgentFleetRow>
                columns={columns}
                dataSource={filteredFleetRows}
                rowKey="agent"
                size="small"
                pagination={false}
                rowClassName="agents-table-row-clickable"
                onRow={row => ({
                  ...clickableRowProps(() => onOpenAgentWorkspace(row.agent, 'mcp-servers'), {
                    ariaLabel: `Open agent ${row.display}`,
                  }),
                })}
              />
            )}
          </section>
        </section>
      </div>
    </section>
  )
}
