import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SearchOutlined } from '@ant-design/icons'
import { useNavigationContext } from '@contexts/NavigationContext'
import { useNotificationsContext } from '@contexts/NotificationsContext'
import {
  Badge,
  Button,
  Card,
  Drawer,
  Empty,
  Flex,
  Input,
  type InputRef,
  Listy,
  Popover,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { IconChat } from '@components/SidebarNav/icons'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { useAgentsDataController } from '@hooks/domain/useAgentsDataController'
import { useMcpServersDataController } from '@hooks/domain/useMcpServersDataController'
import { useSearchPluginsAppsController } from '@hooks/domain/useSearchPluginsAppsController'
import { useTeamsDataController } from '@hooks/domain/useTeamsDataController'
import { useClickOutside } from '@hooks/useClickOutside'
import { notificationKindLabel, notificationPreviewText } from '@/lib/notifications'
import type { AppNotificationKind } from '@/uiTypes'
import type {
  HeaderActionsProps,
  SearchAppResult,
  SearchEntityResult,
  SearchPluginResult,
} from './types'

const SEARCH_PLACEHOLDER = 'Search'
const SEARCH_RESULTS_PROMPT = 'Search agents, connectors, plugins or apps...'

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

function notificationPillTone(kind: AppNotificationKind): 'warning' | 'accent' | 'success' {
  if (kind === 'approval_required') return 'warning'
  if (kind === 'workflow_completed') return 'success'
  if (kind === 'sdk_notification') return 'accent'
  return 'accent'
}

function notificationPillLabel(kind: AppNotificationKind): string {
  return notificationKindLabel(kind)
}

export const HeaderActions = React.memo(function HeaderActions({
  placement = 'default',
  searchFocusRequestId = 0,
  notificationOpenRequestId = 0,
  notificationTrayMode = 'overlay',
  notificationTrayReady = true,
  notificationTrayLeft = null,
  onNotificationTrayOpenChange,
  onShellOverlayOpenChange,
  drawerAvailable = false,
  chatDrawerOpen = false,
  onToggleChatDrawer,
}: HeaderActionsProps) {
  const { accessCatalog: agentsAccessCatalog, loading: agentsCatalogLoading } =
    useAgentsDataController()
  const { globalMcpServers, mcpServersByAgent } = useMcpServersDataController()
  const {
    teams,
    teamDirectory,
    loading: teamDirectoryLoading,
    teamDirectoryHydrated,
    currentTeamId,
    ensureHydrated: onEnsureTeamDirectory,
  } = useTeamsDataController()
  const {
    plugins: searchPlugins,
    apps: searchApps,
    loading: pluginsAppsLoading,
    ensureLoaded: ensurePluginsAppsLoaded,
  } = useSearchPluginsAppsController()
  const { handleNavSelect } = useNavigationContext()
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
  const [notificationTraySettled, setNotificationTraySettled] = useState(false)
  const searchRef = useRef<HTMLElement | null>(null)
  const searchInputRef = useRef<InputRef | null>(null)
  const notificationsRef = useRef<HTMLDivElement | null>(null)
  const searchDirectoryInFlightRef = useRef(false)
  const searchDirectoryRefreshQueryRef = useRef('')
  const accessCatalog = agentsAccessCatalog
  const notificationTrayUsesDrawer = notificationTrayMode === 'drawer'
  const notificationTrayVisible =
    notificationsOpen && (!notificationTrayUsesDrawer || notificationTrayReady)
  const titlebarPlacement = placement === 'titlebar'

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useClickOutside(searchRef, searchOpen, () => setSearchOpen(false))
  useClickOutside(notificationsRef, notificationsOpen, () => setNotificationsOpen(false))

  useEffect(() => {
    if (searchFocusRequestId <= 0) return
    setNotificationsOpen(false)
    setSearchOpen(true)
    searchInputRef.current?.focus()
  }, [searchFocusRequestId])

  useEffect(() => {
    if (notificationOpenRequestId <= 0) return
    setSearchOpen(false)
    setNotificationsOpen(true)
  }, [notificationOpenRequestId])

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
    if (!notificationsOpen) {
      setNotificationTraySettled(false)
      return
    }
    let cancelled = false
    setNotificationTraySettled(false)
    void onRefreshPendingApprovals().finally(() => {
      if (!cancelled) setNotificationTraySettled(true)
    })
    return () => {
      cancelled = true
    }
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

  // Visible name for a notification's agent: the catalog display name
  // (spec.host) with the raw identifier as fallback. Pseudo-agents that are
  // not catalog agents ('Workflows', recipe names) pass through untouched.
  const notificationAgentDisplay = useCallback(
    (agentName: string): string => {
      const map = accessCatalog?.agentDisplayByName
      return (map && map[agentName]) || agentName
    },
    [accessCatalog]
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
  const filteredPlugins = useMemo<SearchPluginResult[]>(
    () =>
      hasSearch
        ? searchPlugins
            .filter(
              plugin =>
                plugin.name.toLowerCase().includes(normalizedSearch) ||
                plugin.namespace.toLowerCase().includes(normalizedSearch)
            )
            .sort((left, right) => left.name.localeCompare(right.name))
            .map(plugin => ({
              key: `${plugin.namespace}/${plugin.name}`,
              name: plugin.name,
              namespace: plugin.namespace,
              status: plugin.status ?? null,
            }))
        : [],
    [hasSearch, normalizedSearch, searchPlugins]
  )
  const filteredApps = useMemo<SearchAppResult[]>(() => {
    if (!hasSearch) return []
    return searchApps
      .map(app => ({
        key: app.appRef,
        appRef: app.appRef,
        label: (app.title ?? '').trim() || app.appRef,
        description: (app.description ?? '').trim() || null,
        ready: app.ready,
      }))
      .filter(
        app =>
          app.label.toLowerCase().includes(normalizedSearch) ||
          app.appRef.toLowerCase().includes(normalizedSearch) ||
          (app.description?.toLowerCase().includes(normalizedSearch) ?? false)
      )
      .sort((left, right) => left.label.localeCompare(right.label))
  }, [hasSearch, normalizedSearch, searchApps])

  const totalMatches =
    filteredAgents.length + filteredConnectors.length + filteredPlugins.length + filteredApps.length
  const pendingApprovalsCount = pendingApprovals.length
  const inboxNotificationCount = notifications.length
  const totalAttentionCount = pendingApprovalsCount + unreadNotificationCount
  const showNotificationTrayEmpty =
    notificationTraySettled &&
    !pendingApprovalsLoading &&
    !pendingApprovalsCount &&
    !notifications.length
  const notificationButtonLabel =
    totalAttentionCount === 0
      ? 'Inbox'
      : `${totalAttentionCount} item${totalAttentionCount === 1 ? '' : 's'} in inbox`

  const navigateToSection = (target: 'agents' | 'connectors' | 'plugins' | 'apps') => {
    setSearchOpen(false)
    if (target === 'agents') {
      onOpenAgents()
      return
    }
    if (target === 'connectors') {
      onOpenConnectors()
      return
    }
    handleNavSelect(target === 'plugins' ? DESKTOP_ROUTES.plugins : DESKTOP_ROUTES.apps)
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

  useEffect(() => {
    if (!searchOpen || !hasSearch) return
    void ensurePluginsAppsLoaded()
  }, [ensurePluginsAppsLoaded, hasSearch, searchOpen])

  const searchResultsContent = (
    <Card
      id="global-search-results"
      aria-label="Search results"
      role="region"
      size="small"
      styles={{ body: { maxHeight: 'min(68vh, 560px)', overflowY: 'auto' } }}
    >
      <Flex vertical gap="small">
        {hasSearch ? (
          <Flex align="center" justify="space-between">
            <Typography.Text strong>Search Results</Typography.Text>
            <Typography.Text type="secondary">
              {totalMatches} match{totalMatches === 1 ? '' : 'es'}
            </Typography.Text>
          </Flex>
        ) : (
          <Typography.Text type="secondary">{SEARCH_RESULTS_PROMPT}</Typography.Text>
        )}

        {teamDirectoryLoading && !teamDirectoryHydrated && (
          <Flex align="center" gap="small" role="status">
            <Spin size="small" />
            <Typography.Text type="secondary">
              Loading agents from your other teams...
            </Typography.Text>
          </Flex>
        )}

        {pluginsAppsLoading && !searchPlugins.length && !searchApps.length && (
          <Flex align="center" gap="small" role="status">
            <Spin size="small" />
            <Typography.Text type="secondary">Loading plugins and apps...</Typography.Text>
          </Flex>
        )}

        {filteredAgents.length > 0 && (
          <section aria-label="Agents">
            <Typography.Text strong type="secondary">
              Agents
            </Typography.Text>
            <Listy
              items={filteredAgents}
              itemRender={agent => (
                <Button
                  block
                  htmlType="button"
                  onClick={() => navigateToSection('agents')}
                  type="text"
                >
                  <Flex align="center" flex="1" justify="space-between">
                    <Flex vertical align="start">
                      <Typography.Text strong>{agent.display}</Typography.Text>
                      <Typography.Text type="secondary">
                        {agent.teamNames.length
                          ? `Teams: ${agent.teamNames.join(', ')}`
                          : 'No team mapping'}
                      </Typography.Text>
                    </Flex>
                  </Flex>
                </Button>
              )}
              rowKey="key"
            />
          </section>
        )}

        {filteredConnectors.length > 0 && (
          <section aria-label="Connectors">
            <Typography.Text strong type="secondary">
              Connectors
            </Typography.Text>
            <Listy
              items={filteredConnectors}
              itemRender={connector => (
                <Button
                  block
                  htmlType="button"
                  onClick={() => navigateToSection('connectors')}
                  type="text"
                >
                  <Flex vertical align="start">
                    <Typography.Text strong>{connector.value}</Typography.Text>
                    <Typography.Text type="secondary">
                      {connector.teamNames.length
                        ? `Agents: ${connector.teamNames.join(', ')}`
                        : 'Available connector'}
                    </Typography.Text>
                  </Flex>
                </Button>
              )}
              rowKey="key"
            />
          </section>
        )}

        {filteredPlugins.length > 0 && (
          <section aria-label="Plugins">
            <Typography.Text strong type="secondary">
              Plugins
            </Typography.Text>
            <Listy
              items={filteredPlugins}
              itemRender={plugin => (
                <Button
                  block
                  htmlType="button"
                  onClick={() => navigateToSection('plugins')}
                  type="text"
                >
                  <Flex align="center" flex="1" justify="space-between">
                    <Flex vertical align="start">
                      <Typography.Text strong>{plugin.name}</Typography.Text>
                      <Typography.Text type="secondary">
                        {plugin.namespace} · {plugin.status ?? 'Status unknown'}
                      </Typography.Text>
                    </Flex>
                    <Tag>Plugin</Tag>
                  </Flex>
                </Button>
              )}
              rowKey="key"
            />
          </section>
        )}

        {filteredApps.length > 0 && (
          <section aria-label="Apps">
            <Typography.Text strong type="secondary">
              Apps
            </Typography.Text>
            <Listy
              items={filteredApps}
              itemRender={app => (
                <Button
                  block
                  htmlType="button"
                  onClick={() => navigateToSection('apps')}
                  type="text"
                >
                  <Flex align="center" flex="1" justify="space-between">
                    <Flex vertical align="start">
                      <Typography.Text strong>{app.label}</Typography.Text>
                      <Typography.Text type="secondary">
                        {app.description ? `${app.description} · ` : ''}
                        {app.ready ? 'Ready' : 'Starting up'}
                      </Typography.Text>
                    </Flex>
                    <Tag>App</Tag>
                  </Flex>
                </Button>
              )}
              rowKey="key"
            />
          </section>
        )}

        {hasSearch && !totalMatches && !teamDirectoryLoading && !pluginsAppsLoading && (
          <Empty
            description={`No matches for "${searchQuery.trim()}". Try an agent, connector, plugin, or app.`}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        )}
      </Flex>
    </Card>
  )

  const notificationBell = (
    <Badge
      count={totalAttentionCount}
      data-testid={totalAttentionCount > 0 ? 'notification-bell-badge' : undefined}
      overflowCount={9}
      title={null}
    >
      <Button
        className={`notification-bell${titlebarPlacement ? ' notification-bell--titlebar' : ''}${
          totalAttentionCount > 0 ? ' has-attention' : ''
        }`}
        htmlType="button"
        shape="circle"
        size="small"
        type="text"
        data-testid="notification-bell"
        aria-label="Notifications and approvals"
        aria-haspopup="dialog"
        aria-expanded={notificationsOpen}
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
          width={titlebarPlacement ? 16 : 18}
          height={titlebarPlacement ? 16 : 18}
          strokeWidth={titlebarPlacement ? '2.25' : '2'}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
          />
        </svg>
      </Button>
    </Badge>
  )

  const notificationTrayContent = (
    <Card
      aria-hidden={!notificationTrayVisible}
      aria-label={notificationTrayVisible ? 'Notifications and approvals' : undefined}
      role={notificationTrayVisible ? 'dialog' : undefined}
      size="small"
    >
      <Flex vertical gap="middle">
        {pendingApprovalsCount > 0 && (
          <section aria-label="Pending approvals">
            <Flex vertical gap="small">
              <Typography.Text strong>Pending approvals</Typography.Text>
              <Typography.Text type="secondary">
                Approve or deny workflow requests that are waiting on you.
              </Typography.Text>
              <Listy
                items={pendingApprovals}
                itemRender={approval => {
                  const actionInFlight = pendingApprovalActionId === approval.id
                  const msUntilExpiry = new Date(approval.expiresAt).getTime() - Date.now()
                  const isExpired = msUntilExpiry <= 0
                  const isExpiringSoon = !isExpired && msUntilExpiry < 60_000

                  return (
                    <Card data-testid="workflow-approval-card" size="small">
                      <Flex align="start" justify="space-between" wrap>
                        <Flex vertical>
                          <Typography.Text strong>{approval.recipeName}</Typography.Text>
                          <Typography.Text type="secondary">
                            {approval.recipeNamespace}
                          </Typography.Text>
                        </Flex>
                        <Typography.Text type="secondary">
                          Requested {formatApprovalTimestamp(approval.requestedAt, 'relative')}
                        </Typography.Text>
                      </Flex>

                      <Typography.Paragraph>{approval.payload.message}</Typography.Paragraph>

                      <Flex gap="small" wrap>
                        {approval.correlation?.stepId && (
                          <Tag>Step: {approval.correlation.stepId}</Tag>
                        )}
                        {approval.target.teamName && <Tag>Team: {approval.target.teamName}</Tag>}
                        <Tag color={isExpired ? 'error' : isExpiringSoon ? 'warning' : undefined}>
                          {isExpired
                            ? 'Expired'
                            : `Expires ${formatApprovalTimestamp(approval.expiresAt, 'absolute')}`}
                        </Tag>
                      </Flex>

                      <Flex align="center" gap="small" wrap>
                        {isExpired ? (
                          <Typography.Text type="danger">This approval has expired</Typography.Text>
                        ) : (
                          <>
                            <Button
                              data-testid="workflow-approval-approve"
                              disabled={actionInFlight}
                              htmlType="button"
                              onClick={() => void onDecidePendingApproval(approval.id, 'approve')}
                              size="small"
                              type="primary"
                            >
                              {actionInFlight ? 'Working...' : 'Approve'}
                            </Button>
                            <Button
                              data-testid="workflow-approval-deny"
                              danger
                              disabled={actionInFlight}
                              htmlType="button"
                              onClick={() => void onDecidePendingApproval(approval.id, 'deny')}
                              size="small"
                            >
                              Deny
                            </Button>
                          </>
                        )}
                      </Flex>
                    </Card>
                  )
                }}
                rowKey="id"
              />
            </Flex>
          </section>
        )}

        {notifications.length > 0 && (
          <section aria-label="Inbox">
            <Flex align="start" justify="space-between" wrap>
              <Flex vertical>
                <Flex align="center" gap="small">
                  <Typography.Text strong>Inbox ({inboxNotificationCount})</Typography.Text>
                  {pendingApprovalsLoading && (
                    <span aria-label="Refreshing inbox" role="status">
                      <Spin size="small" />
                    </span>
                  )}
                </Flex>
                <Typography.Text type="secondary">
                  Updates from agents, workflows, and plugins.
                </Typography.Text>
              </Flex>
              <Button htmlType="button" onClick={onClearNotifications} size="small">
                Clear
              </Button>
            </Flex>
            <Listy
              items={notifications}
              itemRender={notification => {
                const clickable = notification.kind !== 'approval_required'
                const pillTone = notificationPillTone(notification.kind)

                return (
                  <Card
                    data-testid="notification-menu-item"
                    onClick={event => handleNotificationCardClick(event, notification)}
                    onKeyDown={event => handleNotificationCardKeyDown(event, notification)}
                    role={clickable ? 'button' : undefined}
                    size="small"
                    tabIndex={clickable ? 0 : undefined}
                  >
                    <Flex align="start" justify="space-between" wrap>
                      {agentsCatalogLoading ? (
                        <span aria-label="Loading agent name" role="status">
                          <Spin size="small" />
                        </span>
                      ) : (
                        <Typography.Text strong data-testid="notification-agent">
                          {notificationAgentDisplay(notification.agentName)}
                        </Typography.Text>
                      )}
                      <Typography.Text type="secondary">
                        {formatNotificationTime(notification.timestamp)}
                      </Typography.Text>
                    </Flex>
                    {notification.kind === 'approval_required' ? (
                      <Typography.Paragraph>
                        {resolveNotificationActionText(notification)}
                      </Typography.Paragraph>
                    ) : (
                      <div>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {notificationPreviewText(notification.kind, notification.text)}
                        </ReactMarkdown>
                      </div>
                    )}
                    <Flex align="center" justify="space-between" wrap>
                      <Tag
                        color={pillTone === 'accent' ? 'blue' : pillTone}
                        data-testid="notification-kind"
                      >
                        {notificationPillLabel(notification.kind)}
                      </Tag>
                      <Space wrap>
                        <Button
                          aria-label="Delete notification"
                          className="notification-delete-btn"
                          htmlType="button"
                          onClick={() => onRemoveNotification(notification.id)}
                          size="small"
                          title="Delete notification"
                          type="text"
                        >
                          <svg
                            viewBox="0 0 16 16"
                            width={13}
                            height={13}
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={1.4}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M3.5 4.5h9" />
                            <path d="M6 4.5V3.6c0-.6.5-1.1 1.1-1.1h1.8c.6 0 1.1.5 1.1 1.1v.9" />
                            <path d="M5 4.5v8.1c0 .7.6 1.4 1.4 1.4h3.2c.8 0 1.4-.7 1.4-1.4V4.5" />
                            <path d="M7 7v4.5" />
                            <path d="M9 7v4.5" />
                          </svg>
                        </Button>
                        {clickable && (
                          <Button
                            htmlType="button"
                            onClick={() => openNotification(notification)}
                            size="small"
                          >
                            Open
                          </Button>
                        )}
                        {notification.kind === 'approval_required' &&
                          !notification.approvalState && (
                            <>
                              <Button
                                disabled={
                                  Boolean(notificationActionById[notification.id]) ||
                                  !notification.approval
                                }
                                htmlType="button"
                                onClick={() => {
                                  if (!notification.approval) return
                                  void onApproveNotification(notification)
                                }}
                                size="small"
                                type="primary"
                              >
                                {notificationActionById[notification.id] === 'approving'
                                  ? 'Approving...'
                                  : 'Approve'}
                              </Button>
                              <Button
                                danger
                                disabled={
                                  Boolean(notificationActionById[notification.id]) ||
                                  !notification.approval
                                }
                                htmlType="button"
                                onClick={() => {
                                  if (!notification.approval) return
                                  void onDenyNotification(notification)
                                }}
                                size="small"
                              >
                                {notificationActionById[notification.id] === 'denying'
                                  ? 'Denying...'
                                  : 'Deny'}
                              </Button>
                            </>
                          )}
                        {notification.kind === 'approval_required' &&
                          notification.approvalState && (
                            <Typography.Text
                              type={
                                notification.approvalState === 'approved' ? 'success' : 'danger'
                              }
                            >
                              {notification.approvalState === 'approved' ? 'Approved' : 'Denied'}
                            </Typography.Text>
                          )}
                      </Space>
                    </Flex>
                  </Card>
                )
              }}
              rowKey="id"
            />
          </section>
        )}

        {showNotificationTrayEmpty && (
          <Empty
            description="No notifications or pending approvals right now."
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        )}
      </Flex>
    </Card>
  )

  return (
    <Flex
      align="center"
      className="top-bar"
      component={titlebarPlacement ? 'div' : 'header'}
      gap="small"
      justify="flex-end"
      wrap={false}
    >
      <Flex
        align="center"
        className="header-left"
        data-testid="header-left"
        flex={titlebarPlacement ? '1 1 auto' : '0 0 auto'}
        justify={titlebarPlacement ? 'flex-end' : undefined}
      >
        <Flex
          align="center"
          className={`global-search${titlebarPlacement ? ' global-search--titlebar' : ''}${
            searchOpen ? ' is-open' : ''
          }`}
          data-titlebar-pointer-owner={titlebarPlacement ? 'true' : undefined}
          flex={titlebarPlacement ? '0 1 auto' : '0 0 auto'}
          ref={searchRef}
        >
          <Popover
            content={searchResultsContent}
            getPopupContainer={() => searchRef.current ?? document.body}
            onOpenChange={setSearchOpen}
            open={searchOpen}
            placement="bottomRight"
            trigger={[]}
          >
            <Input
              ref={searchInputRef}
              type="text"
              size="small"
              placeholder={SEARCH_PLACEHOLDER}
              prefix={titlebarPlacement ? <SearchOutlined aria-hidden="true" /> : undefined}
              aria-label="Search"
              aria-controls="global-search-results"
              aria-expanded={searchOpen}
              title={SEARCH_PLACEHOLDER}
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
          </Popover>
        </Flex>
      </Flex>

      {/* Chat-drawer toggle (mini-spec 04a §C/R3): between the search and the
          bell. Ghost style like the bell (`--titlebar` variant). On chat tabs
          (`!drawerAvailable`) the chat IS the content, so the interactive button
          is gone — but an inert, same-size placeholder holds its slot so hiding
          the toggle doesn't reflow the search pill and bell sideways. */}
      {onToggleChatDrawer ? (
        drawerAvailable ? (
          <Button
            className="chat-drawer-toggle"
            htmlType="button"
            shape="circle"
            size="small"
            type="text"
            data-testid="chat-drawer-toggle"
            aria-label={chatDrawerOpen ? 'Close chat drawer' : 'Open chat drawer'}
            aria-pressed={chatDrawerOpen}
            title={chatDrawerOpen ? 'Close chat drawer' : 'Open chat drawer'}
            onClick={onToggleChatDrawer}
          >
            <IconChat aria-hidden="true" />
          </Button>
        ) : (
          <Button
            aria-hidden="true"
            className="chat-drawer-toggle--placeholder"
            disabled
            htmlType="button"
            shape="circle"
            size="small"
            tabIndex={-1}
            type="text"
            data-testid="chat-drawer-toggle-placeholder"
          />
        )
      ) : null}

      <Flex align="center" data-testid="header-utilities" flex="0 0 auto">
        <div
          className="notification-bell-wrapper"
          data-titlebar-pointer-owner={titlebarPlacement ? 'true' : undefined}
          ref={notificationsRef}
        >
          {notificationTrayUsesDrawer ? (
            <>
              {notificationBell}
              {notificationTrayVisible && (
                <Drawer
                  autoFocus={false}
                  closable={false}
                  getContainer={false}
                  keyboard={false}
                  mask={false}
                  onClose={() => setNotificationsOpen(false)}
                  open
                  placement="right"
                  rootStyle={{ position: 'fixed' }}
                  styles={{
                    wrapper: {
                      top: 'calc(var(--window-titlebar-height) + var(--space-2))',
                      right: 'var(--space-4)',
                      bottom: 'var(--space-4)',
                      left: notificationTrayLeft === null ? undefined : notificationTrayLeft,
                      width:
                        notificationTrayLeft === null
                          ? 'var(--app-notification-drawer-width)'
                          : 'auto',
                    },
                  }}
                >
                  {notificationTrayContent}
                </Drawer>
              )}
            </>
          ) : (
            <Popover
              content={notificationTrayContent}
              destroyOnHidden
              fresh
              getPopupContainer={() => notificationsRef.current ?? document.body}
              onOpenChange={setNotificationsOpen}
              open={notificationTrayVisible}
              placement="bottomRight"
              trigger={[]}
            >
              {notificationBell}
            </Popover>
          )}
        </div>
      </Flex>
    </Flex>
  )
})
