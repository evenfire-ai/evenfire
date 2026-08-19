import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigationContext } from '@contexts/NavigationContext'
import { useNotificationsContext } from '@contexts/NotificationsContext'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button, IconButton, Pill, SelectableOption, TextInput } from '@components/Common'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { useAgentsDataController } from '@hooks/domain/useAgentsDataController'
import { useContextsDataController } from '@hooks/domain/useContextsDataController'
import { useMcpServersDataController } from '@hooks/domain/useMcpServersDataController'
import { useTeamsDataController } from '@hooks/domain/useTeamsDataController'
import { useClickOutside } from '@hooks/useClickOutside'
import { notificationKindLabel, notificationPreviewText } from '@/lib/notifications'
import type { AppNotificationKind } from '@/uiTypes'
import type {
  AppHeaderProps,
  SearchEntityResult,
  SearchMemberResult,
  SearchTeamResult,
} from './types'

const FULL_SEARCH_PLACEHOLDER = 'Search teams, contexts, members, agents or connectors...'
const COMPACT_SEARCH_PLACEHOLDER = 'Search workspace...'
const COMPACT_SEARCH_BREAKPOINT = 1220

function formatApprovalTimestamp(value: string, mode: 'relative' | 'absolute'): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return mode === 'relative' ? 'unknown time' : 'unknown deadline'
  }

  if (mode === 'absolute') {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date)
  }

  const deltaMs = date.getTime() - Date.now()
  const deltaMinutes = Math.round(deltaMs / 60_000)
  const absMinutes = Math.abs(deltaMinutes)

  if (absMinutes < 1) return 'just now'
  if (absMinutes < 60) return `${absMinutes}m ${deltaMinutes >= 0 ? 'from now' : 'ago'}`
  const absHours = Math.round(absMinutes / 60)
  if (absHours < 24) return `${absHours}h ${deltaMinutes >= 0 ? 'from now' : 'ago'}`
  const absDays = Math.round(absHours / 24)
  return `${absDays}d ${deltaMinutes >= 0 ? 'from now' : 'ago'}`
}

function resolveNotificationActionText(
  notification: ReturnType<typeof useNotificationsContext>['notifications'][number]
): string {
  const explicit = String(notification.approval?.displayName || '').trim()
  if (explicit) return explicit
  const raw = String(notification.text || '').trim()
  if (!raw) return 'Approval required'
  const sanitized = raw
    .replace(/needs your approval\.?$/i, '')
    .replace(/^approval required for /i, '')
    .trim()
  return sanitized || raw
}

function notificationPillClass(kind: AppNotificationKind): string {
  if (kind === 'approval_required') return 'approval'
  if (kind === 'workflow_completed') return 'workflow'
  if (kind === 'sdk_notification') return 'workflow'
  return 'reply'
}

function notificationPillTone(kind: AppNotificationKind): 'warning' | 'accent' | 'success' {
  if (kind === 'approval_required') return 'warning'
  if (kind === 'workflow_completed') return 'success'
  if (kind === 'sdk_notification') return 'accent'
  return 'accent'
}

function notificationPillLabel(kind: AppNotificationKind): string {
  return notificationKindLabel(kind)
}

export const AppHeader = React.memo(function AppHeader({
  notificationTrayMode = 'overlay',
  notificationTrayReady = true,
  onNotificationTrayOpenChange,
  onShellOverlayOpenChange,
}: AppHeaderProps) {
  const { accessCatalog: agentsAccessCatalog } = useAgentsDataController()
  const { contextIds, contextDisplayById } = useContextsDataController()
  const { globalMcpServers, mcpServersByAgent } = useMcpServersDataController()
  const {
    teams,
    teamMembers,
    teamDirectory,
    loading: teamDirectoryLoading,
    teamDirectoryHydrated,
    currentTeamId,
    ensureHydrated: onEnsureTeamDirectory,
  } = useTeamsDataController()
  const { navItem, handleNavSelect, handleOpenContextDetails, handleOpenTeamDetails } =
    useNavigationContext()
  const {
    notifications,
    unreadNotificationCount,
    notificationActionById,
    pendingApprovals,
    pendingApprovalsLoading,
    pendingApprovalActionId,
    markNotificationsRead: onMarkNotificationsRead,
    clearNotifications: onClearNotifications,
    removeNotification: onRemoveNotification,
    handleOpenNotification: onOpenNotification,
    handleApproveNotification: onApproveNotification,
    handleDenyNotification: onDenyNotification,
    handleRefreshPendingApprovals: onRefreshPendingApprovals,
    handleDecidePendingApproval: onDecidePendingApproval,
  } = useNotificationsContext()

  const onOpenAgents = () => handleNavSelect(DESKTOP_ROUTES.agents)
  const onOpenConnectors = () => handleNavSelect(DESKTOP_ROUTES.connectors)
  const [now, setNow] = useState(Date.now())
  const [searchQuery, setSearchQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [compactSearch, setCompactSearch] = useState(
    () => window.innerWidth <= COMPACT_SEARCH_BREAKPOINT
  )
  const searchRef = useRef<HTMLDivElement | null>(null)
  const notificationsRef = useRef<HTMLDivElement | null>(null)
  const searchDirectoryInFlightRef = useRef(false)
  const searchDirectoryRefreshQueryRef = useRef('')
  const accessCatalog = agentsAccessCatalog
  const notificationTrayUsesDrawer = notificationTrayMode === 'drawer'
  const notificationTrayVisible =
    notificationsOpen && (!notificationTrayUsesDrawer || notificationTrayReady)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const updateCompactSearch = () =>
      setCompactSearch(window.innerWidth <= COMPACT_SEARCH_BREAKPOINT)
    window.addEventListener('resize', updateCompactSearch)
    return () => window.removeEventListener('resize', updateCompactSearch)
  }, [])

  useClickOutside(searchRef, searchOpen, () => setSearchOpen(false))
  useClickOutside(notificationsRef, notificationsOpen, () => setNotificationsOpen(false))

  React.useLayoutEffect(() => {
    onShellOverlayOpenChange?.(searchOpen || (notificationsOpen && !notificationTrayUsesDrawer))
    onNotificationTrayOpenChange?.(notificationsOpen)
  }, [
    notificationTrayUsesDrawer,
    notificationsOpen,
    onNotificationTrayOpenChange,
    onShellOverlayOpenChange,
    searchOpen,
  ])

  useEffect(() => {
    return () => {
      onShellOverlayOpenChange?.(false)
      onNotificationTrayOpenChange?.(false)
    }
  }, [onNotificationTrayOpenChange, onShellOverlayOpenChange])

  useEffect(() => {
    if (!notificationsOpen) return
    void onRefreshPendingApprovals()
  }, [notificationsOpen, onRefreshPendingApprovals])

  useEffect(() => {
    if (!notificationsOpen || unreadNotificationCount === 0) return
    onMarkNotificationsRead()
  }, [notificationsOpen, onMarkNotificationsRead, unreadNotificationCount])

  const normalizedSearch = searchQuery.trim().toLowerCase()
  const hasSearch = normalizedSearch.length > 0

  const teamNameById = useMemo(() => {
    const mapping: Record<string, string> = {}
    for (const team of teams) {
      mapping[team.id] = team.name
    }
    return mapping
  }, [teams])

  const currentTeamName = teamNameById[currentTeamId] || currentTeamId || 'Workspace team'

  const memberInitial = (member: { label: string; email: string }) => {
    const source = member.label || member.email
    return source ? source.charAt(0).toUpperCase() : '?'
  }

  const formatNotificationTime = (timestamp: number) => {
    const elapsedMs = Math.max(0, now - timestamp)
    if (elapsedMs < 60_000) return 'just now'
    if (elapsedMs < 3_600_000) return `${Math.floor(elapsedMs / 60_000)}m ago`
    if (elapsedMs < 86_400_000) return `${Math.floor(elapsedMs / 3_600_000)}h ago`
    return `${Math.floor(elapsedMs / 86_400_000)}d ago`
  }

  const openNotification = (notification: (typeof notifications)[number]) => {
    setNotificationsOpen(false)
    void onOpenNotification(notification)
  }

  const isNestedNotificationAction = (event: React.SyntheticEvent<HTMLDivElement>) => {
    const target = event.target
    if (!(target instanceof Element)) return false
    const interactiveTarget = target.closest(
      'button, a, input, select, textarea, [role="button"], [role="link"]'
    )
    return interactiveTarget !== null && interactiveTarget !== event.currentTarget
  }

  const handleNotificationCardClick = (
    event: React.MouseEvent<HTMLDivElement>,
    notification: (typeof notifications)[number]
  ) => {
    if (notification.kind === 'approval_required') return
    if (isNestedNotificationAction(event)) return
    openNotification(notification)
  }

  const handleNotificationCardKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
    notification: (typeof notifications)[number]
  ) => {
    if (notification.kind === 'approval_required') return
    if (event.key !== 'Enter' && event.key !== ' ') return
    if (isNestedNotificationAction(event)) return
    event.preventDefault()
    openNotification(notification)
  }

  const selectedTeamMembers = useMemo<SearchMemberResult[]>(() => {
    return teamMembers.map(member => ({
      key: `${currentTeamId}:${member.id}`,
      id: member.id,
      label: (member.name || member.email).trim(),
      email: member.email,
      role: member.role,
      teamId: currentTeamId,
      teamName: currentTeamName,
    }))
  }, [currentTeamId, currentTeamName, teamMembers])

  const otherTeamMembers = useMemo<SearchMemberResult[]>(() => {
    const rows: SearchMemberResult[] = []
    for (const team of teams) {
      if (team.id === currentTeamId) continue
      const members = teamDirectory[team.id]?.members || []
      for (const member of members) {
        rows.push({
          key: `${team.id}:${member.id}`,
          id: member.id,
          label: (member.name || member.email).trim(),
          email: member.email,
          role: member.role,
          teamId: team.id,
          teamName: team.name,
        })
      }
    }
    return rows
  }, [currentTeamId, teamDirectory, teams])

  const aggregatedAgents = useMemo<SearchEntityResult[]>(() => {
    const byName = new Map<
      string,
      { fromSelectedScope: boolean; fromUserScope: boolean; teamNames: Set<string> }
    >()
    const add = (
      value: string,
      options: { selectedScope?: boolean; userScope?: boolean; teamName?: string } = {}
    ) => {
      const normalized = value.trim()
      if (!normalized) return
      const current = byName.get(normalized) || {
        fromSelectedScope: false,
        fromUserScope: false,
        teamNames: new Set<string>(),
      }
      if (options.selectedScope) current.fromSelectedScope = true
      if (options.userScope) current.fromUserScope = true
      if (options.teamName) current.teamNames.add(options.teamName)
      byName.set(normalized, current)
    }

    if (accessCatalog) {
      for (const agentName of accessCatalog.agentNames) {
        add(agentName, { selectedScope: true })
      }
      for (const agentName of accessCatalog.userAgentNames) {
        add(agentName, { selectedScope: true, userScope: true })
      }
      for (const agentName of accessCatalog.teamAgentNames) {
        add(agentName, { selectedScope: true, teamName: currentTeamName })
      }
    } else {
      const currentTeamAgents = teamDirectory[currentTeamId]?.agentNames || []
      for (const agentName of currentTeamAgents) {
        add(agentName, { selectedScope: true, teamName: currentTeamName })
      }
    }

    if (!accessCatalog) {
      for (const team of teams) {
        if (team.id === currentTeamId) continue
        const names = teamDirectory[team.id]?.agentNames || []
        for (const agentName of names) {
          add(agentName, { teamName: team.name })
        }
      }
    }

    // Visible name = agent `spec.host` (catalog `agentDisplayByName`, total over
    // catalog agents at the producer). The `?? value` covers cross-team agents
    // added from the team directory (no catalog display source), not a defensive
    // guard on catalog agents — see spec Decision #6.
    const agentDisplayByName = accessCatalog?.agentDisplayByName
    return [...byName.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, details]) => ({
        key: value,
        value,
        display: agentDisplayByName?.[value] ?? value,
        fromSelectedScope: details.fromSelectedScope,
        fromUserScope: details.fromUserScope,
        teamNames: [...details.teamNames].sort((a, b) => a.localeCompare(b)),
      }))
  }, [accessCatalog, currentTeamId, currentTeamName, teamDirectory, teams])

  const filteredSelectedMembers = useMemo(
    () =>
      hasSearch
        ? selectedTeamMembers.filter(
            member =>
              member.label.toLowerCase().includes(normalizedSearch) ||
              member.email.toLowerCase().includes(normalizedSearch) ||
              member.role.toLowerCase().includes(normalizedSearch) ||
              member.teamName.toLowerCase().includes(normalizedSearch)
          )
        : [],
    [hasSearch, selectedTeamMembers, normalizedSearch]
  )
  const filteredOtherMembers = useMemo(
    () =>
      hasSearch
        ? otherTeamMembers.filter(
            member =>
              member.label.toLowerCase().includes(normalizedSearch) ||
              member.email.toLowerCase().includes(normalizedSearch) ||
              member.role.toLowerCase().includes(normalizedSearch) ||
              member.teamName.toLowerCase().includes(normalizedSearch)
          )
        : [],
    [hasSearch, otherTeamMembers, normalizedSearch]
  )
  const filteredMembers = useMemo(
    () =>
      [...filteredSelectedMembers, ...filteredOtherMembers].sort((left, right) => {
        const labelCompare = left.label.localeCompare(right.label)
        if (labelCompare !== 0) return labelCompare
        return left.teamName.localeCompare(right.teamName)
      }),
    [filteredOtherMembers, filteredSelectedMembers]
  )
  const filteredAgents = useMemo(
    () =>
      hasSearch
        ? aggregatedAgents.filter(
            agent =>
              agent.value.toLowerCase().includes(normalizedSearch) ||
              agent.display.toLowerCase().includes(normalizedSearch) ||
              agent.teamNames.some(teamName => teamName.toLowerCase().includes(normalizedSearch))
          )
        : [],
    [aggregatedAgents, hasSearch, normalizedSearch]
  )
  const aggregatedContexts = useMemo<SearchEntityResult[]>(() => {
    const byId = new Map<string, { fromSelectedScope: boolean; teamNames: Set<string> }>()
    const add = (contextId: string, options: { selectedScope?: boolean; teamName?: string }) => {
      const normalized = contextId.trim()
      if (!normalized) return
      const current = byId.get(normalized) || {
        fromSelectedScope: false,
        teamNames: new Set<string>(),
      }
      if (options.selectedScope) current.fromSelectedScope = true
      if (options.teamName) current.teamNames.add(options.teamName)
      byId.set(normalized, current)
    }

    for (const contextId of contextIds) {
      add(contextId, { selectedScope: true })
    }

    if (!contextIds.length) {
      for (const team of teams) {
        const ids = teamDirectory[team.id]?.contextIds || []
        for (const contextId of ids) {
          add(contextId, { teamName: team.name })
        }
      }
    }

    return [...byId.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, details]) => ({
        key: value,
        value,
        // Visible name = context `spec.displayName`; fall back to the id (spec
        // Decision #6) when no display exists OR the display is blank/whitespace-
        // only (an out-of-band write must never render an empty context label).
        display: (contextDisplayById[value] ?? '').trim() || value,
        fromSelectedScope: details.fromSelectedScope,
        fromUserScope: false,
        teamNames: [...details.teamNames].sort((a, b) => a.localeCompare(b)),
      }))
  }, [contextDisplayById, contextIds, teamDirectory, teams])
  const filteredContexts = useMemo(
    () =>
      hasSearch
        ? aggregatedContexts.filter(
            context =>
              context.value.toLowerCase().includes(normalizedSearch) ||
              context.display.toLowerCase().includes(normalizedSearch) ||
              context.teamNames.some(teamName => teamName.toLowerCase().includes(normalizedSearch))
          )
        : [],
    [aggregatedContexts, hasSearch, normalizedSearch]
  )
  const filteredConnectors = useMemo<SearchEntityResult[]>(() => {
    if (!hasSearch) return []
    const connectorsByName = new Map<string, Set<string>>()
    const add = (serverName: string, agentName?: string) => {
      const normalized = serverName.trim()
      if (!normalized) return
      const agents = connectorsByName.get(normalized) || new Set<string>()
      if (agentName) agents.add(agentName)
      connectorsByName.set(normalized, agents)
    }

    for (const server of globalMcpServers) add(server.name)
    for (const [agentName, serverNames] of Object.entries(mcpServersByAgent)) {
      for (const serverName of serverNames) add(String(serverName), agentName)
    }

    return [...connectorsByName.entries()]
      .filter(
        ([serverName, agentNames]) =>
          serverName.toLowerCase().includes(normalizedSearch) ||
          [...agentNames].some(agentName => agentName.toLowerCase().includes(normalizedSearch))
      )
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, agentNames]) => ({
        key: value,
        value,
        // Connectors have no separate display name; the server name is the label.
        display: value,
        fromSelectedScope: true,
        fromUserScope: false,
        teamNames: [...agentNames].sort((a, b) => a.localeCompare(b)),
      }))
  }, [globalMcpServers, hasSearch, mcpServersByAgent, normalizedSearch])
  const filteredTeams = useMemo<SearchTeamResult[]>(
    () =>
      hasSearch
        ? teams
            .filter(team => {
              const members =
                team.id === currentTeamId
                  ? teamMembers.length
                  : (teamDirectory[team.id]?.members || []).length
              return (
                team.name.toLowerCase().includes(normalizedSearch) ||
                String(members).includes(normalizedSearch)
              )
            })
            .map(team => ({
              id: team.id,
              name: team.name,
              memberCount:
                team.id === currentTeamId
                  ? teamMembers.length
                  : (teamDirectory[team.id]?.members || []).length,
            }))
        : [],
    [currentTeamId, hasSearch, normalizedSearch, teamDirectory, teamMembers.length, teams]
  )

  const totalMatches =
    filteredTeams.length +
    filteredMembers.length +
    filteredAgents.length +
    filteredContexts.length +
    filteredConnectors.length
  const pendingApprovalsCount = pendingApprovals.length
  const inboxNotificationCount = notifications.length
  const totalAttentionCount = pendingApprovalsCount + unreadNotificationCount
  const notificationButtonLabel =
    totalAttentionCount === 0
      ? 'Inbox'
      : `${totalAttentionCount} item${totalAttentionCount === 1 ? '' : 's'} in inbox`

  const navigateToSection = (target: 'agents' | 'connectors') => {
    setSearchOpen(false)
    if (target === 'agents') {
      onOpenAgents()
      return
    }
    onOpenConnectors()
  }

  const navigateToTeam = (teamId: string) => {
    setSearchOpen(false)
    handleOpenTeamDetails(teamId)
  }

  const navigateToContext = (contextId: string) => {
    setSearchOpen(false)
    handleOpenContextDetails(contextId)
  }

  useEffect(() => {
    if (!searchOpen || !hasSearch) {
      searchDirectoryRefreshQueryRef.current = ''
      return
    }
    if (teamDirectoryLoading) return
    if (searchDirectoryInFlightRef.current) return
    if (searchDirectoryRefreshQueryRef.current === normalizedSearch) return
    searchDirectoryRefreshQueryRef.current = normalizedSearch
    searchDirectoryInFlightRef.current = true
    void Promise.resolve(onEnsureTeamDirectory())
      .catch(() => undefined)
      .finally(() => {
        searchDirectoryInFlightRef.current = false
      })
  }, [hasSearch, normalizedSearch, onEnsureTeamDirectory, searchOpen, teamDirectoryLoading])

  return (
    <header className="top-bar">
      <div className="header-left">
        <div className="global-search" ref={searchRef}>
          <TextInput
            type="text"
            placeholder={compactSearch ? COMPACT_SEARCH_PLACEHOLDER : FULL_SEARCH_PLACEHOLDER}
            className="search-input"
            aria-label="Search"
            title={FULL_SEARCH_PLACEHOLDER}
            value={searchQuery}
            onChange={event => {
              setSearchQuery(event.target.value)
              setSearchOpen(true)
            }}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                setSearchOpen(false)
              }
            }}
          />
          {searchOpen && hasSearch && (
            <div className="global-search-results">
              <div className="search-results-card">
                <div className="search-results-header-row">
                  <strong>Search Results</strong>
                  <span className="search-results-meta">
                    {totalMatches} match{totalMatches === 1 ? '' : 'es'}
                  </span>
                </div>

                {teamDirectoryLoading && !teamDirectoryHydrated && (
                  <p className="search-results-loading">
                    Loading members and agents from your other teams...
                  </p>
                )}

                {Boolean(filteredTeams.length) && (
                  <section className="search-results-group">
                    <header className="search-results-group-title">Teams</header>
                    <div className="search-results-list">
                      {filteredTeams.map(team => (
                        <SelectableOption
                          key={team.id}
                          className="search-result-item search-result-item-button"
                          onClick={() => navigateToTeam(team.id)}
                          size="sm"
                        >
                          <div className="search-result-main">
                            <strong>{team.name}</strong>
                            <span className="search-result-subline">
                              {team.memberCount} member{team.memberCount === 1 ? '' : 's'}
                            </span>
                          </div>
                          <span className="search-result-tag">Team</span>
                        </SelectableOption>
                      ))}
                    </div>
                  </section>
                )}

                {Boolean(filteredContexts.length) && (
                  <section className="search-results-group">
                    <header className="search-results-group-title">Contexts</header>
                    <div className="search-results-list">
                      {filteredContexts.map(context => (
                        <SelectableOption
                          key={context.key}
                          className="search-result-item search-result-item-button"
                          onClick={() => navigateToContext(context.value)}
                          size="sm"
                        >
                          <div className="search-result-main">
                            <strong>{context.display}</strong>
                            <span className="search-result-subline">
                              {context.teamNames.length
                                ? `Teams: ${context.teamNames.join(', ')}`
                                : 'Access scope'}
                            </span>
                          </div>
                          <span className="search-result-tag">Context</span>
                        </SelectableOption>
                      ))}
                    </div>
                  </section>
                )}

                {Boolean(filteredMembers.length) && (
                  <section className="search-results-group">
                    <header className="search-results-group-title">Members</header>
                    <div className="search-results-list">
                      {filteredMembers.map(member => (
                        <SelectableOption
                          key={member.key}
                          className="search-result-item search-result-item-button"
                          onClick={() => navigateToTeam(member.teamId)}
                          size="sm"
                        >
                          <span className="team-member-initial-avatar">
                            {memberInitial(member)}
                          </span>
                          <div className="search-result-main">
                            <strong>{member.label}</strong>
                            <span className="search-result-subline">
                              {member.email}
                              {member.role && (
                                <>
                                  {' '}
                                  {' · '}
                                  {member.role}
                                </>
                              )}
                            </span>
                          </div>
                          <span className="search-result-tag">{member.teamName}</span>
                        </SelectableOption>
                      ))}
                    </div>
                  </section>
                )}

                {Boolean(filteredAgents.length) && (
                  <section className="search-results-group">
                    <header className="search-results-group-title">Agents</header>
                    <div className="search-results-list">
                      {filteredAgents.map(agent => (
                        <SelectableOption
                          key={agent.key}
                          className="search-result-item search-result-item-button"
                          onClick={() => navigateToSection('agents')}
                          size="sm"
                        >
                          <div className="search-result-main">
                            <strong>{agent.display}</strong>
                            <span className="search-result-subline">
                              {agent.teamNames.length
                                ? `Teams: ${agent.teamNames.join(', ')}`
                                : 'No team mapping'}
                            </span>
                          </div>
                        </SelectableOption>
                      ))}
                    </div>
                  </section>
                )}

                {Boolean(filteredConnectors.length) && (
                  <section className="search-results-group">
                    <header className="search-results-group-title">Connectors</header>
                    <div className="search-results-list">
                      {filteredConnectors.map(connector => (
                        <SelectableOption
                          key={connector.key}
                          className="search-result-item search-result-item-button"
                          onClick={() => navigateToSection('connectors')}
                          size="sm"
                        >
                          <div className="search-result-main">
                            <strong>{connector.value}</strong>
                            <span className="search-result-subline">
                              {connector.teamNames.length
                                ? `Agents: ${connector.teamNames.join(', ')}`
                                : 'Available connector'}
                            </span>
                          </div>
                        </SelectableOption>
                      ))}
                    </div>
                  </section>
                )}

                {!totalMatches && !teamDirectoryLoading && (
                  <p className="search-results-empty">
                    No matches for "{searchQuery.trim()}". Try a member email, team name, context,
                    agent, or connector.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="header-utilities">
        <div className="notification-bell-wrapper" ref={notificationsRef}>
          <IconButton
            className={`notification-bell${totalAttentionCount > 0 ? ' has-attention' : ''}`}
            data-testid="notification-bell"
            aria-label="Notifications and approvals"
            aria-haspopup="dialog"
            aria-expanded={notificationsOpen}
            label="Notifications and approvals"
            title={notificationButtonLabel}
            onClick={() => {
              setNotificationsOpen(open => !open)
              setSearchOpen(false)
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
              />
            </svg>
            {totalAttentionCount > 0 && (
              <span
                className="notification-bell-badge"
                data-testid="notification-bell-badge"
                aria-hidden="true"
              >
                {totalAttentionCount > 9 ? '9+' : totalAttentionCount}
              </span>
            )}
          </IconButton>
          {notificationTrayVisible && (
            <div
              className={`notification-menu${
                notificationTrayUsesDrawer ? ' notification-menu--app-drawer' : ''
              }`}
              role="dialog"
              aria-label="Notifications and approvals"
            >
              <div className="notification-menu-body">
                {pendingApprovalsCount > 0 && (
                  <section className="notification-menu-section">
                    <div className="notification-menu-section-header">
                      <div className="notification-menu-section-heading">
                        <strong>Pending approvals</strong>
                        <span className="notification-menu-section-meta">
                          Approve or deny workflow requests that are waiting on you.
                        </span>
                      </div>
                    </div>
                    <div className="notification-approval-list">
                      {pendingApprovals.map(approval => {
                        const actionInFlight = pendingApprovalActionId === approval.id
                        const msUntilExpiry = new Date(approval.expiresAt).getTime() - Date.now()
                        const isExpired = msUntilExpiry <= 0
                        const isExpiringSoon = !isExpired && msUntilExpiry < 60_000

                        return (
                          <article
                            key={approval.id}
                            data-testid="workflow-approval-card"
                            className={`notification-item${isExpiringSoon ? ' expiring-soon' : ''}${
                              isExpired ? ' expired' : ''
                            }`}
                          >
                            <div className="notification-item-head">
                              <div className="notification-item-title-block">
                                <strong className="notification-item-recipe">
                                  {approval.recipeName}
                                </strong>
                                <span className="notification-item-namespace">
                                  {approval.recipeNamespace}
                                </span>
                              </div>
                              <span className="notification-item-time">
                                Requested{' '}
                                {formatApprovalTimestamp(approval.requestedAt, 'relative')}
                              </span>
                            </div>

                            <p className="notification-item-message">{approval.payload.message}</p>

                            <div className="notification-item-meta">
                              {approval.correlation?.stepId && (
                                <Pill className="notification-item-chip" tone="neutral">
                                  Step: {approval.correlation.stepId}
                                </Pill>
                              )}
                              {approval.target.teamName && (
                                <Pill className="notification-item-chip" tone="neutral">
                                  Team: {approval.target.teamName}
                                </Pill>
                              )}
                              <Pill
                                className="notification-item-chip"
                                tone={isExpired ? 'danger' : isExpiringSoon ? 'warning' : 'neutral'}
                              >
                                {isExpired
                                  ? 'Expired'
                                  : `Expires ${formatApprovalTimestamp(approval.expiresAt, 'absolute')}`}
                              </Pill>
                            </div>

                            <div className="notification-item-actions">
                              {isExpired ? (
                                <span className="notification-item-expired-label">
                                  This approval has expired
                                </span>
                              ) : (
                                <>
                                  <Button
                                    className="approval-action-btn approve"
                                    color="success"
                                    data-testid="workflow-approval-approve"
                                    onClick={() =>
                                      void onDecidePendingApproval(approval.id, 'approve')
                                    }
                                    disabled={actionInFlight}
                                    size="sm"
                                    variant="soft"
                                  >
                                    {actionInFlight ? 'Working...' : 'Approve'}
                                  </Button>
                                  <Button
                                    className="approval-action-btn deny"
                                    color="danger"
                                    data-testid="workflow-approval-deny"
                                    onClick={() =>
                                      void onDecidePendingApproval(approval.id, 'deny')
                                    }
                                    disabled={actionInFlight}
                                    size="sm"
                                    variant="soft"
                                  >
                                    Deny
                                  </Button>
                                </>
                              )}
                            </div>
                          </article>
                        )
                      })}
                    </div>
                  </section>
                )}

                {notifications.length > 0 && (
                  <section className="notification-menu-section">
                    <div className="notification-menu-section-header">
                      <div className="notification-menu-section-heading">
                        <div className="notification-menu-title-row">
                          <strong>Inbox ({inboxNotificationCount})</strong>
                          {pendingApprovalsLoading && (
                            <span
                              className="notification-inline-spinner"
                              aria-label="Refreshing inbox"
                            />
                          )}
                        </div>
                        <span className="notification-menu-section-meta">
                          Updates from agents, workflows, and plugins.
                        </span>
                      </div>
                      <div className="notification-menu-header-actions">
                        <Button
                          className="notification-clear-btn"
                          color="neutral"
                          onClick={onClearNotifications}
                          size="sm"
                          variant="soft"
                        >
                          Clear
                        </Button>
                      </div>
                    </div>
                    <div className="notification-menu-list">
                      {notifications.map(notification => (
                        <div
                          key={notification.id}
                          data-testid="notification-menu-item"
                          className={`notification-menu-item${
                            notification.kind === 'approval_required' ? '' : ' is-clickable'
                          }${notification.read ? '' : ' unread'}`}
                          onClick={event => handleNotificationCardClick(event, notification)}
                          onKeyDown={event => handleNotificationCardKeyDown(event, notification)}
                          role={notification.kind === 'approval_required' ? undefined : 'button'}
                          tabIndex={notification.kind === 'approval_required' ? undefined : 0}
                        >
                          <div className="notification-menu-item-header">
                            <p className="notification-menu-agent">{notification.agentName}</p>
                            <span className="notification-menu-time">
                              {formatNotificationTime(notification.timestamp)}
                            </span>
                          </div>
                          {notification.kind === 'approval_required' ? (
                            <p className="notification-menu-text">
                              {resolveNotificationActionText(notification)}
                            </p>
                          ) : (
                            <div className="notification-menu-text notification-menu-text--markdown">
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {notificationPreviewText(notification.kind, notification.text)}
                              </ReactMarkdown>
                            </div>
                          )}
                          <div className="notification-menu-footer">
                            <Pill
                              className={`notification-pill notification-pill-footer ${notificationPillClass(
                                notification.kind
                              )}`}
                              tone={notificationPillTone(notification.kind)}
                            >
                              {notificationPillLabel(notification.kind)}
                            </Pill>
                            <div className="notification-menu-actions">
                              <IconButton
                                className="notification-delete-btn"
                                color="danger"
                                label="Delete notification"
                                onClick={() => onRemoveNotification(notification.id)}
                                size="sm"
                                title="Delete notification"
                                variant="ghost"
                              >
                                <svg viewBox="0 0 16 16" aria-hidden="true">
                                  <path d="M3.5 4.5h9" />
                                  <path d="M6 4.5V3.6c0-.6.5-1.1 1.1-1.1h1.8c.6 0 1.1.5 1.1 1.1v.9" />
                                  <path d="M5 4.5v8.1c0 .7.6 1.4 1.4 1.4h3.2c.8 0 1.4-.7 1.4-1.4V4.5" />
                                  <path d="M7 7v4.5" />
                                  <path d="M9 7v4.5" />
                                </svg>
                              </IconButton>
                              {notification.kind !== 'approval_required' && (
                                <Button
                                  className="notification-open-btn"
                                  color="primary"
                                  onClick={() => openNotification(notification)}
                                  size="xs"
                                  variant="soft"
                                >
                                  Open
                                </Button>
                              )}
                              {notification.kind === 'approval_required' &&
                                !notification.approvalState && (
                                  <>
                                    <Button
                                      className="notification-action-btn approve"
                                      color="success"
                                      disabled={
                                        Boolean(notificationActionById[notification.id]) ||
                                        !notification.approval
                                      }
                                      onClick={() => {
                                        if (!notification.approval) return
                                        void onApproveNotification(notification)
                                      }}
                                      size="xs"
                                      variant="soft"
                                    >
                                      {notificationActionById[notification.id] === 'approving'
                                        ? 'Approving...'
                                        : 'Approve'}
                                    </Button>
                                    <Button
                                      className="notification-action-btn deny"
                                      color="danger"
                                      disabled={
                                        Boolean(notificationActionById[notification.id]) ||
                                        !notification.approval
                                      }
                                      onClick={() => {
                                        if (!notification.approval) return
                                        void onDenyNotification(notification)
                                      }}
                                      size="xs"
                                      variant="soft"
                                    >
                                      {notificationActionById[notification.id] === 'denying'
                                        ? 'Denying...'
                                        : 'Deny'}
                                    </Button>
                                  </>
                                )}
                              {notification.kind === 'approval_required' &&
                                notification.approvalState && (
                                  <span
                                    className={`notification-action-state ${notification.approvalState}`}
                                  >
                                    {notification.approvalState === 'approved'
                                      ? 'Approved'
                                      : 'Denied'}
                                  </span>
                                )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {!pendingApprovalsLoading && !pendingApprovalsCount && !notifications.length && (
                  <p className="notification-menu-empty">
                    No notifications or pending approvals right now.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  )
})
