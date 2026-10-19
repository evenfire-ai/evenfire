import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useAgentChatActionsContext } from '@contexts/AgentChatActionsContext'
import { useAuthContext } from '@contexts/AuthContext'
import { useChatListContext } from '@contexts/ChatListContext'
import { useMcpRuntimeContext } from '@contexts/McpRuntimeContext'
import { useNavigationContext } from '@contexts/NavigationContext'
import { DataTable, EmptyState, IconButton, MenuItem, StatusBanner } from '@components/Common'
import { PageBreadcrumb } from '@components/PageBreadcrumb'
import type { PageBreadcrumbItem } from '@components/PageBreadcrumb/types'
import { ResourceBreadcrumbSwitcher } from '@components/ResourceBreadcrumbSwitcher'
import { IconAgents } from '@components/SidebarNav/icons'
import { useAgentsDataController } from '@hooks/domain/useAgentsDataController'
import {
  type ConnectorActionInput,
  isActionableConnector,
  useConnectorsController,
} from '@hooks/domain/useConnectorsController'
import { useContextsDataController } from '@hooks/domain/useContextsDataController'
import { useMcpServersDataController } from '@hooks/domain/useMcpServersDataController'
import { useTeamsDataController } from '@hooks/domain/useTeamsDataController'
import { useClickOutside } from '@hooks/useClickOutside'
import { deriveConnectorRows } from '@lib/connectorRows'
import { deriveScopedMembers } from '@lib/scopedMembers'
import type { ScopedMemberContextDetails, ScopedMemberTeamRow } from '@lib/scopedMembers.types'
import type { AgentWorkspaceRoute } from '../../uiTypes'
import { McpServerHealthTable } from '../McpServerHealthTable'
import type { McpServerConnectorAction } from '../McpServerHealthTable.types'
import { SharedFilesTab } from '../SharedFilesTab'
import { ActivityDashboard } from './ActivityDashboard'
import { AgentTitleSelector } from './AgentTitleSelector'
import { ChatThread } from './ChatThread'
import { ComposerPanel } from './ComposerPanel'
import { ContextWindowIndicator } from './ContextWindowIndicator'
import { FallbackBadge } from './FallbackBadge'
import { SessionTokensIndicator } from './SessionTokensIndicator'
import { AGENT_ROUTE_LABELS, AGENT_ROUTE_OPTIONS } from './agentRoutes'

const CHAT_SCROLL_TO_BOTTOM_SHOW_DELAY_MS = 250

type AgentWorkspaceMode = 'agents' | 'chat'

type AgentWorkspaceProps = {
  mode?: AgentWorkspaceMode
  scrollContainerRef: RefObject<HTMLElement | null>
}

function AgentHero({
  agentName,
  subtitle,
  subtitleTone = 'body',
}: {
  agentName: string | null
  subtitle: string
  subtitleTone?: 'body' | 'eyebrow'
}) {
  return (
    <div className="agent-details-hero agent-details-hero--flush">
      <span className="agent-details-avatar" aria-hidden="true">
        <IconAgents />
      </span>
      <div className="agent-details-identity">
        <strong className="agent-details-name">{agentName || 'Agent'}</strong>
        <span
          className={
            subtitleTone === 'eyebrow' ? 'agent-details-eyebrow' : 'agent-details-subtitle'
          }
        >
          {subtitle}
        </span>
      </div>
    </div>
  )
}

export function AgentWorkspace({ mode = 'agents', scrollContainerRef }: AgentWorkspaceProps) {
  const {
    selectedAgent,
    selectedAgentRoute,
    handleBackToAgents: onBackToAgents,
    handleOpenAgentWorkspace: onOpenAgentWorkspace,
    handleSelectChatAgent: onSelectChatAgent,
  } = useNavigationContext()
  const { agentNames } = useAgentsDataController()
  const { me } = useAuthContext()
  const {
    accessCatalog,
    loading: contextsLoading,
    error: contextsError,
  } = useContextsDataController()
  const {
    teams,
    currentTeamId,
    teamMembers,
    teamDirectory,
    ensureHydrated: ensureTeamsHydrated,
    loading: teamsLoading,
    error: teamsError,
  } = useTeamsDataController()
  const { agentContextByName, agentDisplayByName, selectedAgentMcpServers } =
    useMcpServersDataController({
      selectedAgent,
    })
  const { sessionStateByChatId, activeChatId } = useChatListContext()
  const activeSessionState = activeChatId ? sessionStateByChatId[activeChatId] : undefined
  const { hostRuntimeStatus } = useMcpRuntimeContext()
  const { scrollChatToBottom } = useAgentChatActionsContext()
  // Connectors action controller (spec §5.E). Its own observer over the shared,
  // app-coordinated `connectors` query cache — same pattern McpServersPage uses.
  // `pendingKey`/`authorize`/`disconnect` MUST come from this same instance so
  // the busy spinner and the action stay paired.
  const {
    agents: connectorAgents,
    pendingKey: connectorPendingKey,
    actionError: connectorActionError,
    authorize: authorizeConnector,
    disconnect: disconnectConnector,
  } = useConnectorsController()

  const [chatScrollNavVisible, setChatScrollNavVisible] = useState(true)
  const [scrollToBottomChatId, setScrollToBottomChatId] = useState<string | null>(null)
  const [delayedScrollToBottomChatId, setDelayedScrollToBottomChatId] = useState<string | null>(
    null
  )
  const [chatAgentRouteMenuOpen, setChatAgentRouteMenuOpen] = useState(false)
  const chatAgentRouteMenuRef = useRef<HTMLSpanElement | null>(null)

  const mcpHealthNow = undefined

  const handleScrollPositionChange = useCallback(
    (isScrolledAwayFromBottom: boolean) => {
      setScrollToBottomChatId(isScrolledAwayFromBottom ? activeChatId : null)
    },
    [activeChatId]
  )

  const showScrollToBottom = Boolean(activeChatId) && scrollToBottomChatId === activeChatId
  const showDelayedScrollToBottom =
    Boolean(activeChatId) && delayedScrollToBottomChatId === activeChatId

  useEffect(() => {
    if (!showScrollToBottom) {
      setDelayedScrollToBottomChatId(null)
      return
    }

    const chatId = activeChatId
    const timeoutId = window.setTimeout(
      () => setDelayedScrollToBottomChatId(chatId),
      CHAT_SCROLL_TO_BOTTOM_SHOW_DELAY_MS
    )
    return () => window.clearTimeout(timeoutId)
  }, [activeChatId, showScrollToBottom])

  useClickOutside(chatAgentRouteMenuRef, chatAgentRouteMenuOpen, () =>
    setChatAgentRouteMenuOpen(false)
  )

  const selectedAgentMcpServerNames = selectedAgent
    ? selectedAgentMcpServers.map(server => server.name)
    : []

  // OAuth Authorize/Disconnect actions for THIS agent's connectors, keyed by
  // mcp-server name so the health table can join them onto its rows. Reuse the
  // shared `deriveConnectorRows` fold (one row per (connector, agent), canonical
  // status stamped) filtered to `selectedAgent`, keeping only actionable
  // (oauth-governed) connectors — a `no_oauth` row is Secret-managed and has no
  // button. Busy is anchored to the GRANT (`pendingKey === grantKey`) so a shared
  // grant shows every sibling busy, exactly like McpServersPage.
  //
  // Join invariant: the button surfaces on the health table's rows, which are the
  // agent's MAPPED mcp-servers (`selectedAgentMcpServers`). Mapping is independent
  // of authorization, so a mapped-but-unauthorized oauth server (`requires_setup`)
  // still has a health row and therefore an Authorize button — the case this fix
  // restores. A connector that `listConnectors` reports but the catalog does not
  // map to this agent is intentionally NOT this agent's connector and shows no row
  // here. The only gap is transient: while the catalog is mid-hydration
  // (`selectedAgentMcpServerMappingAvailable` false) there are no rows and thus no
  // buttons, which self-heals once the post-auth bootstrap populates the catalog.
  const connectorActionsByName = useMemo(() => {
    if (!selectedAgent) return undefined
    const map = new Map<string, McpServerConnectorAction>()
    for (const row of deriveConnectorRows(connectorAgents)) {
      if (row.agentName !== selectedAgent) continue
      if (!isActionableConnector(row.connector)) continue
      const actionInput: ConnectorActionInput = {
        agentName: row.agentName,
        contextRef: row.contextRef,
        connector: row.connector,
      }
      map.set(row.connector.name, {
        actionInput,
        authorized: row.connector.status === 'authorized',
        busy: connectorPendingKey === row.grantKey,
      })
    }
    return map
  }, [connectorAgents, selectedAgent, connectorPendingKey])
  const selectedAgentContext = selectedAgent
    ? String(agentContextByName[selectedAgent] || '').trim()
    : ''
  // Visible agent name (spec.host) for the workspace hero title. `selectedAgent`
  // is always a catalog agent, so `agentDisplayByName` is total over it — the
  // single sanctioned fallback (Decision #6) keeps the id if a display is
  // missing. Display-only: lookups/actions keep using `selectedAgent`.
  const selectedAgentDisplay = selectedAgent
    ? (agentDisplayByName[selectedAgent] ?? selectedAgent)
    : null

  // Members tab (spec §5.C). The context detail the projection needs is
  // reachable from the same app-coordinated caches AgentWorkspace already reads:
  //  - availableToUser/availableToTeam/userId derive from the access catalog
  //    (useContextsDataController) given the agent's contextRef;
  //  - the mapped teams and their members come from the team directory
  //    (useTeamsDataController).
  // No new fetch/IPC — this is a pure projection over cached data (deriveScopedMembers).
  const agentContextRef = selectedAgentContext || null
  const memberContextDetails = useMemo<ScopedMemberContextDetails>(() => {
    if (!agentContextRef || !accessCatalog) return null
    return {
      availableToUser: accessCatalog.userContextIds.includes(agentContextRef),
      availableToTeam: accessCatalog.teamContextIds.includes(agentContextRef),
      userId: accessCatalog.userId,
    }
  }, [accessCatalog, agentContextRef])
  const currentTeam = useMemo(
    () => teams.find(team => team.id === currentTeamId) ?? null,
    [teams, currentTeamId]
  )
  const memberTeamRows = useMemo<ScopedMemberTeamRow[]>(() => {
    if (!agentContextRef) return []
    const rowsByTeamId = new Map<string, ScopedMemberTeamRow>()
    // Iterate teams alphabetically by name so members list in a stable,
    // human-friendly order — parity with the previous ContextDetailsPage panel,
    // which sorted contextTeamRows by team.name. deriveScopedMembers preserves
    // insertion order, so the ordering guarantee lives here at the call site.
    const teamsByName = [...teams].sort((a, b) => a.name.localeCompare(b.name))
    for (const team of teamsByName) {
      const entry = teamDirectory[team.id]
      if (!entry?.contextIds.includes(agentContextRef)) continue
      rowsByTeamId.set(team.id, { members: entry.members || [] })
    }
    if (memberContextDetails?.availableToTeam && currentTeam && !rowsByTeamId.has(currentTeam.id)) {
      rowsByTeamId.set(currentTeam.id, { members: teamMembers })
    }
    return [...rowsByTeamId.values()]
  }, [
    agentContextRef,
    currentTeam,
    memberContextDetails?.availableToTeam,
    teamDirectory,
    teamMembers,
    teams,
  ])
  const scopedMembers = useMemo(
    () => deriveScopedMembers(memberContextDetails, memberTeamRows, me),
    [memberContextDetails, memberTeamRows, me]
  )

  const isChatMode = mode === 'chat'
  const isChatScrollNavMode = isChatMode && Boolean(activeChatId)
  const rootBreadcrumbLabel = mode === 'chat' ? 'Chat' : 'Agents'
  const rootBreadcrumbItem: PageBreadcrumbItem =
    mode === 'chat' && selectedAgent
      ? {
          label: rootBreadcrumbLabel,
          onClick: () => onSelectChatAgent(selectedAgent, { selectLatest: false }),
          className: 'page-breadcrumb-link--plain-action',
        }
      : { label: rootBreadcrumbLabel }
  const routeSubtitle =
    selectedAgentRoute === 'mcp-servers'
      ? 'Connector health and mappings for this agent.'
      : selectedAgentRoute === 'members'
        ? 'People with access to this agent through its context.'
        : selectedAgentRoute === 'shared-files'
          ? 'Agent files available through this agent.'
          : 'Recent conversations, messages, tool calls, and errors.'

  const agentOptions = useMemo(
    // id stays the identifier (drives selection/matching); label shows the
    // display name (spec.host) with the single sanctioned fallback (Decision #6).
    () =>
      agentNames.map(agentName => ({
        id: agentName,
        label: agentDisplayByName[agentName] ?? agentName,
      })),
    [agentNames, agentDisplayByName]
  )
  const routeOptions = useMemo(
    () => AGENT_ROUTE_OPTIONS.map(route => ({ id: route, label: AGENT_ROUTE_LABELS[route] })),
    []
  )

  // Agent selector dropdown for the new-chat greeting title row. Each row has two
  // targets: the agent NAME (click → start/switch a chat with that agent) and
  // the 3-dots (click → open a sections sub-menu: Connectors / Members /
  // Agent Files / Activity, navigating into that agent's workspace without
  // switching the chat). This mirrors the chatAgentRouteMenu pattern.
  const agentSwitcherLabel = (
    <AgentTitleSelector
      ariaLabel={isChatMode ? 'Switch chat agent' : 'Switch agent'}
      emptyLabel="No agents"
      options={agentOptions}
      selectedId={selectedAgent ?? ''}
      selectedLabel={selectedAgentDisplay ?? ''}
      onSelectAgent={agentName => {
        if (isChatMode) {
          onSelectChatAgent(agentName, { selectLatest: false })
          return
        }
        onOpenAgentWorkspace(agentName, selectedAgentRoute)
      }}
      onOpenRoute={(agentName, route) => {
        onOpenAgentWorkspace(agentName, route)
      }}
    />
  )

  const routeSwitcherLabel = (
    <ResourceBreadcrumbSwitcher
      ariaLabel="Switch agent section"
      emptyLabel="No sections"
      options={routeOptions}
      selectedId={selectedAgentRoute}
      selectedLabel={AGENT_ROUTE_LABELS[selectedAgentRoute]}
      onSelect={route => {
        if (selectedAgent) {
          onOpenAgentWorkspace(selectedAgent, route as AgentWorkspaceRoute)
        }
      }}
    />
  )

  const chatAgentRouteMenu = isChatMode && selectedAgent && (
    <span className="agent-workspace-agent-route-menu" ref={chatAgentRouteMenuRef}>
      <IconButton
        className="agent-workspace-agent-route-trigger"
        color="neutral"
        label={`Open ${selectedAgent} options`}
        size="xs"
        variant="ghost"
        aria-haspopup="menu"
        aria-expanded={chatAgentRouteMenuOpen}
        onClick={() => setChatAgentRouteMenuOpen(open => !open)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <circle cx="3.5" cy="8" r="1.2" />
          <circle cx="8" cy="8" r="1.2" />
          <circle cx="12.5" cy="8" r="1.2" />
        </svg>
      </IconButton>
      {chatAgentRouteMenuOpen && (
        <span className="agent-workspace-agent-route-menu-panel" role="menu">
          {AGENT_ROUTE_OPTIONS.map(route => (
            <MenuItem
              key={route}
              className="agent-workspace-agent-route-menu-item"
              onClick={() => {
                setChatAgentRouteMenuOpen(false)
                onOpenAgentWorkspace(selectedAgent, route)
              }}
              role="menuitem"
            >
              {AGENT_ROUTE_LABELS[route]}
            </MenuItem>
          ))}
        </span>
      )}
    </span>
  )

  // Chat-mode breadcrumb agent label. The agent NAME always shows. The route
  // (sections) 3-dots menu shows ONLY inside an active conversation — the
  // new-chat landing keeps its own agent selector (with 3-dots) in the title
  // row, so the breadcrumb there shows only the root "Chat" item.
  const agentBreadcrumbLabel = isChatMode ? (
    <span className="agent-workspace-agent-breadcrumb-actions">
      {selectedAgentDisplay || 'Agent'}
      {isChatMode && activeChatId ? chatAgentRouteMenu : null}
    </span>
  ) : (
    selectedAgentDisplay || 'Agent'
  )
  const agentBreadcrumbItem: PageBreadcrumbItem =
    mode === 'agents' && selectedAgent
      ? {
          label: agentBreadcrumbLabel,
          onClick: () => onSelectChatAgent(selectedAgent),
        }
      : {
          label: agentBreadcrumbLabel,
        }

  useEffect(() => {
    setChatScrollNavVisible(true)
    setChatAgentRouteMenuOpen(false)
  }, [selectedAgent])

  // The Members tab reads the team directory (see memberTeamRows). It is an
  // app-coordinated query, so a deep-link straight into the Members tab may
  // arrive before the post-paint bootstrap hydrated it — ensure it once here.
  useEffect(() => {
    if (!isChatMode && selectedAgentRoute === 'members') {
      void ensureTeamsHydrated()
    }
  }, [ensureTeamsHydrated, isChatMode, selectedAgentRoute])

  useEffect(() => {
    if (!isChatScrollNavMode) {
      setChatScrollNavVisible(true)
      return
    }

    const contentPanel = scrollContainerRef.current
    if (!contentPanel) return

    let lastScrollTop = contentPanel.scrollTop
    const onScroll = () => {
      const nextScrollTop = contentPanel.scrollTop
      const scrollDelta = nextScrollTop - lastScrollTop
      const nearTop = nextScrollTop <= 24

      if (nearTop) {
        setChatScrollNavVisible(true)
      } else if (scrollDelta > 4) {
        setChatScrollNavVisible(false)
      } else if (scrollDelta < -2) {
        setChatScrollNavVisible(true)
      }

      lastScrollTop = nextScrollTop
    }

    contentPanel.addEventListener('scroll', onScroll, { passive: true })
    return () => contentPanel.removeEventListener('scroll', onScroll)
  }, [isChatScrollNavMode, scrollContainerRef])

  return (
    <section
      className={`agent-page${isChatScrollNavMode ? ' agent-page--chat-scroll-nav' : ''}${
        chatScrollNavVisible ? ' chat-scroll-nav-visible' : ''
      }`}
    >
      <div className="agent-workspace-shell page-card">
        <div className="agent-chat-nav-stack">
          <div className="agent-workspace-head">
            <div className="agent-workspace-head-row">
              <div className="agent-workspace-heading-stack">
                <PageBreadcrumb
                  ariaLabel={mode === 'chat' ? 'Chat breadcrumb' : 'Agent breadcrumb'}
                  items={[
                    ...(mode === 'agents'
                      ? [{ label: rootBreadcrumbLabel, onClick: onBackToAgents }]
                      : [rootBreadcrumbItem]),
                    // Chat-mode breadcrumb rules:
                    //  - New-chat landing (no active chat): the agent selector
                    //    lives in the title row, so the breadcrumb shows ONLY the
                    //    root "Chat" item — no agent name, no dots.
                    //  - Active conversation: breadcrumb = root "Chat" + the agent
                    //    NAME plus the 3-dots route menu (see agentBreadcrumbLabel)
                    //    so the user can jump to Details / Connectors / etc.
                    //    without leaving the session.
                    ...(mode === 'chat' && !activeChatId ? [] : [agentBreadcrumbItem]),
                    ...(mode === 'agents'
                      ? [
                          {
                            label: routeSwitcherLabel,
                          },
                        ]
                      : []),
                  ]}
                />
                {isChatMode && activeChatId && (
                  <div className="agent-chat-indicators-row">
                    {activeSessionState?.tokens && (
                      <SessionTokensIndicator tokens={activeSessionState.tokens} />
                    )}
                    {selectedAgent && (
                      <ContextWindowIndicator
                        agentRef={selectedAgent}
                        chatId={activeChatId}
                        turnSignal={activeSessionState?.tokens?.input}
                      />
                    )}
                    <FallbackBadge servedBy={hostRuntimeStatus?.servedBy} />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div
          className={`agent-workspace-body-slot${
            isChatMode && activeChatId ? ' agent-workspace-body-slot--session' : ''
          }`}
        >
          {!isChatMode && selectedAgentRoute === 'mcp-servers' && (
            <section className="agent-mcp-panel" aria-label="Agent connectors">
              <AgentHero agentName={selectedAgentDisplay} subtitle={routeSubtitle} />

              {/* Parity with McpServersPage: the controller never rejects and
                  records any write failure in `actionError`, so both mounts of
                  it must surface that error — otherwise a failed
                  authorize/disconnect from this panel is silent (R1-B1). */}
              {connectorActionError ? (
                <StatusBanner tone="error">{connectorActionError}</StatusBanner>
              ) : null}

              <McpServerHealthTable
                hostRef={selectedAgent ?? ''}
                mcpServerNames={selectedAgentMcpServerNames}
                status={hostRuntimeStatus}
                now={mcpHealthNow}
                alwaysExpanded
                connectorActions={connectorActionsByName}
                onAuthorize={input => {
                  // Failures surface via `connectorActionError`; the hook never
                  // rejects, so there is nothing to catch here.
                  void authorizeConnector(input)
                }}
                onDisconnect={input => {
                  void disconnectConnector(input)
                }}
              />
            </section>
          )}

          {!isChatMode && selectedAgentRoute === 'members' && (
            <section className="agent-workspace-panel" aria-label="Agent members">
              <AgentHero agentName={selectedAgentDisplay} subtitle={routeSubtitle} />

              {(contextsError || teamsError) && !scopedMembers.length ? (
                // Error before loading/content: a failed access-catalog or team
                // directory read otherwise rendered a permanent "No members".
                <StatusBanner tone="error">{contextsError ?? teamsError}</StatusBanner>
              ) : (contextsLoading || teamsLoading) && !scopedMembers.length ? (
                <EmptyState title="Loading" body="Fetching members…" />
              ) : scopedMembers.length ? (
                <DataTable className="agent-members-data-table">
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
              ) : (
                <EmptyState
                  title="No members"
                  body="No members are available for this agent in the current API scope."
                />
              )}
            </section>
          )}

          {!isChatMode && selectedAgentRoute === 'shared-files' && (
            <section className="agent-workspace-panel" aria-label="Agent files">
              <AgentHero agentName={selectedAgentDisplay} subtitle={routeSubtitle} />

              {selectedAgentContext ? (
                <SharedFilesTab contextId={selectedAgentContext} />
              ) : (
                <EmptyState
                  title="No agent files"
                  body="No context is currently mapped to this agent."
                />
              )}
            </section>
          )}

          {!isChatMode && selectedAgentRoute === 'activity' && (
            <section className="agent-workspace-panel" aria-label="Agent activity">
              <AgentHero agentName={selectedAgentDisplay} subtitle={routeSubtitle} />

              <ActivityDashboard />
            </section>
          )}

          {isChatMode && !activeChatId && (
            <div className="agent-workspace-new-chat">
              <div className="agent-workspace-greeting-row">
                <h2 className="agent-workspace-greeting">Start a new conversation with:</h2>
                {agentSwitcherLabel}
              </div>
              <ComposerPanel inline />
            </div>
          )}
          {isChatMode && (
            <div className="chat-thread-container">
              <ChatThread onScrollPositionChange={handleScrollPositionChange} />
              {showDelayedScrollToBottom && (
                <div className="chat-scroll-to-bottom">
                  <IconButton
                    className="chat-scroll-to-bottom-button"
                    color="neutral"
                    label="Scroll to latest messages"
                    onClick={scrollChatToBottom}
                    size="sm"
                    variant="solid"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path d="M12 4v14" />
                      <path d="m6 12 6 6 6-6" />
                    </svg>
                  </IconButton>
                </div>
              )}
            </div>
          )}
          {isChatMode && activeChatId && (
            <div className="agent-chat-composer-dock">
              {activeSessionState?.offlineMode || activeSessionState?.syncing ? (
                <div
                  className={`agent-chat-sync-indicator${
                    activeSessionState.offlineMode ? ' agent-chat-sync-indicator--offline' : ''
                  }`}
                  role="status"
                  aria-live="polite"
                >
                  <span className="agent-chat-sync-indicator-dot" aria-hidden="true" />
                  {activeSessionState.offlineMode ? 'Offline — showing cached chat' : 'Syncing…'}
                </div>
              ) : null}
              <ComposerPanel />
            </div>
          )}
        </div>

        {hostRuntimeStatus?.degraded?.reason === 'llm_key_missing' ? (
          <div className="degraded-banner" role="alert" data-testid="host-degraded-banner">
            <strong>This agent is degraded.</strong> {hostRuntimeStatus.degraded.message}{' '}
            <span>
              Open the Control UI &rarr; LLM Secrets tab and ensure <code>{selectedAgent}</code>
              &rsquo;s referenced Secret has the matching provider key. The agent will recover
              within a second.
            </span>
          </div>
        ) : null}
      </div>
    </section>
  )
}
