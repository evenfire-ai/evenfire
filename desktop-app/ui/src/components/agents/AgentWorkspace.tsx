import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useAgentChatActionsContext } from '@contexts/AgentChatActionsContext'
import { useChatListContext } from '@contexts/ChatListContext'
import { useMcpRuntimeContext } from '@contexts/McpRuntimeContext'
import { useNavigationContext } from '@contexts/NavigationContext'
import { DataTable, EmptyState, IconButton, MenuItem, ReferenceTag } from '@components/Common'
import { PageBreadcrumb } from '@components/PageBreadcrumb'
import type { PageBreadcrumbItem } from '@components/PageBreadcrumb/types'
import { ResourceBreadcrumbSwitcher } from '@components/ResourceBreadcrumbSwitcher'
import { IconAgents, IconConnectors, IconContexts } from '@components/SidebarNav/icons'
import { useAgentsDataController } from '@hooks/domain/useAgentsDataController'
import { useContextsDataController } from '@hooks/domain/useContextsDataController'
import { useMcpServersDataController } from '@hooks/domain/useMcpServersDataController'
import { useClickOutside } from '@hooks/useClickOutside'
import type { AgentWorkspaceRoute } from '../../uiTypes'
import { McpServerHealthTable } from '../McpServerHealthTable'
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
    handleOpenContextDetails,
  } = useNavigationContext()
  const { agentNames } = useAgentsDataController()
  const {
    contextIds,
    contextDisplayById,
    loading: contextsLoading,
    error: contextsError,
  } = useContextsDataController()
  const { agentContextByName, agentDisplayByName, selectedAgentMcpServers } =
    useMcpServersDataController({
      selectedAgent,
    })
  const { sessionStateByChatId, activeChatId } = useChatListContext()
  const activeSessionState = activeChatId ? sessionStateByChatId[activeChatId] : undefined
  const { hostRuntimeStatus } = useMcpRuntimeContext()
  const { scrollChatToBottom } = useAgentChatActionsContext()

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
  const visibleContextIds = useMemo(
    () =>
      selectedAgentContext
        ? [
            selectedAgentContext,
            ...contextIds.filter(contextId => contextId !== selectedAgentContext),
          ]
        : contextIds,
    [contextIds, selectedAgentContext]
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
      : selectedAgentRoute === 'contexts'
        ? 'Authorized contexts available to this agent.'
        : selectedAgentRoute === 'shared-files'
          ? 'Agent files available through this agent.'
          : selectedAgentRoute === 'activity'
            ? 'Recent conversations, messages, tool calls, and errors.'
            : 'Workspace status and queue details for this agent.'

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
  // the 3-dots (click → open a sections sub-menu: Details / Connectors /
  // Contexts / Agent Files / Activity, navigating into that agent's workspace
  // without switching the chat). This mirrors the chatAgentRouteMenu pattern.
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

              <McpServerHealthTable
                hostRef={selectedAgent ?? ''}
                mcpServerNames={selectedAgentMcpServerNames}
                status={hostRuntimeStatus}
                now={mcpHealthNow}
                alwaysExpanded
              />
            </section>
          )}

          {!isChatMode && selectedAgentRoute === 'contexts' && (
            <section className="agent-workspace-panel" aria-label="Agent contexts">
              <AgentHero agentName={selectedAgentDisplay} subtitle={routeSubtitle} />

              {contextsLoading && !visibleContextIds.length ? (
                <EmptyState title="Loading" body="Fetching authorized contexts..." />
              ) : contextsError && !visibleContextIds.length ? (
                <div className="composer-error" role="alert">
                  <p className="error-text">{contextsError}</p>
                </div>
              ) : visibleContextIds.length ? (
                <DataTable className="agent-contexts-data-table">
                  <thead>
                    <tr>
                      <th className="da-table__col-header" scope="col">
                        Context
                      </th>
                      <th className="da-table__col-header" scope="col">
                        Scope
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleContextIds.map(contextId => (
                      <tr key={contextId}>
                        <td className="da-table__cell">
                          <ReferenceTag
                            kind="context"
                            onClick={() => handleOpenContextDetails(contextId)}
                            title={contextId}
                            aria-label={`Open context ${contextId}`}
                          >
                            {/* Visible context name (spec.displayName); fall back
                                to the id (Decision #6) when no display exists OR
                                the display is blank/whitespace-only (an out-of-band
                                write must never render an empty context label). */}
                            {(contextDisplayById[contextId] ?? '').trim() || contextId}
                          </ReferenceTag>
                        </td>
                        <td className="da-table__cell">
                          <span className="agent-table-muted">
                            {contextId === selectedAgentContext
                              ? `Mapped to ${selectedAgent}`
                              : 'Available'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
              ) : (
                <EmptyState
                  title="No contexts"
                  body="No contexts are currently mapped to this workspace."
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

          {!isChatMode && selectedAgentRoute === 'details' && (
            <section
              className="agent-workspace-panel agent-details-panel"
              aria-label="Agent details"
            >
              <AgentHero
                agentName={selectedAgentDisplay}
                subtitle="Agent details"
                subtitleTone="eyebrow"
              />

              <div className="agent-details-resource-grid">
                <section className="agent-details-resource" aria-label="Mapped context">
                  <span className="agent-details-resource-icon" aria-hidden="true">
                    <IconContexts />
                  </span>
                  <div className="agent-details-resource-copy">
                    <span className="agent-details-resource-label">Context</span>
                    {selectedAgentContext ? (
                      <ReferenceTag
                        kind="context"
                        onClick={() => onOpenAgentWorkspace(selectedAgent ?? '', 'contexts')}
                        title={selectedAgentContext}
                        aria-label={`Open contexts for ${selectedAgent}`}
                      >
                        {selectedAgentContext}
                      </ReferenceTag>
                    ) : (
                      <span className="agent-table-muted">No mapped context</span>
                    )}
                  </div>
                </section>

                <section className="agent-details-resource" aria-label="Mapped connectors">
                  <span className="agent-details-resource-icon" aria-hidden="true">
                    <IconConnectors />
                  </span>
                  <div className="agent-details-resource-copy">
                    <span className="agent-details-resource-label">
                      Connectors
                      {selectedAgentMcpServerNames.length
                        ? ` · ${selectedAgentMcpServerNames.length}`
                        : ''}
                    </span>
                    {selectedAgentMcpServerNames.length ? (
                      <span className="reference-tag-list">
                        {selectedAgentMcpServerNames.slice(0, 6).map(serverName => (
                          <ReferenceTag
                            key={`${selectedAgent}:${serverName}`}
                            kind="connector"
                            onClick={() => onOpenAgentWorkspace(selectedAgent ?? '', 'mcp-servers')}
                            title={serverName}
                            aria-label={`Open connectors for ${selectedAgent}`}
                          >
                            {serverName}
                          </ReferenceTag>
                        ))}
                      </span>
                    ) : (
                      <span className="agent-table-muted">No mapped connectors</span>
                    )}
                  </div>
                </section>
              </div>
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
