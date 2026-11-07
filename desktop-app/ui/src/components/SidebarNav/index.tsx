import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  type QueuedChatDelete,
  useAgentChatActionsContext,
} from '@contexts/AgentChatActionsContext'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext/types'
import { useAuthContext } from '@contexts/AuthContext'
import { useChatListContext } from '@contexts/ChatListContext'
import { useNavigationContext } from '@contexts/NavigationContext'
import {
  Avatar,
  Button,
  Dropdown,
  Flex,
  Input,
  type InputRef,
  type MenuProps,
  Modal,
  Typography,
} from 'antd'
import { ChatStateBadge } from '@components/agents/ChatStateBadge'
import { DESKTOP_ROUTES, SIDEBAR_SESSION_PREVIEW_LIMIT } from '@constants/navigation'
import { useClickOutside } from '@hooks/useClickOutside'
import { formatDesktopAppVersionTooltip, useDesktopAppInfo } from '@hooks/useDesktopAppInfo'
import type { NavItem } from '@/uiTypes'
import { FileExplorerTree } from './FileExplorerTree'
import {
  IconAgents,
  IconChat,
  IconChevronRight,
  IconConnectors,
  IconHardDrive,
  IconMoreHorizontal,
  IconNewChat,
  IconSandboxUi,
  IconSettings,
  IconWorkflows,
} from './icons'
import type { SidebarNavProps } from './types'

const COMPACT_SIDEBAR_OPEN_CLASS = 'compact-sidebar-open'
const SESSION_KEY_SEPARATOR = '\u001f'

export function SidebarNav({
  navItem,
  collapsed,
  compactMode,
  compactMenuOpen,
  onCompactMenuOpenChange,
  resize,
  activeSandboxUiApp,
  availableSandboxUiApps,
  onCollapsedChange,
  onNewChat,
  onOpenSandboxUiApp,
  onSettingsMenuOpenChange,
  onSelect,
  onOpenFilesSection,
  onOpenPreviewSection,
  pushToast,
  toggleRequestId = 0,
}: SidebarNavProps) {
  const isCollapsed = collapsed && !compactMode
  const { busy, me, handleLogout: onLogout } = useAuthContext()
  const { activeChatId, latestChatSessions, latestChatSessionsLoading, sessionStateByChatKey } =
    useChatListContext()
  const {
    captureChatDeleteFence,
    handleRenameChatForAgent: onRenameChatForAgent,
    handleDeleteChatForAgent: onDeleteChatForAgent,
  } = useAgentChatActionsContext()
  const { selectedAgent, handleSelectChatAgent: onSelectChatAgent } = useNavigationContext()
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
  const [chatSessionsOpen, setChatSessionsOpen] = useState(true)
  const [appsOpen, setAppsOpen] = useState(true)
  // Collapsed by default: opening it triggers the "Shared with me" discovery
  // fetch, so it stays inert until the user reaches for the file tree.
  const [filesExplorerOpen, setFilesExplorerOpen] = useState(false)
  const [sessionMenuId, setSessionMenuId] = useState<string | null>(null)
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
  const [sessionRenameValue, setSessionRenameValue] = useState('')
  const [pendingDeleteSession, setPendingDeleteSession] = useState<{
    agentRef: string
    chatId: string
    title: string
    deletion: QueuedChatDelete
  } | null>(null)
  const settingsMenuOpenRef = useRef(false)
  const lastToggleRequestIdRef = useRef(0)
  const desktopAppInfo = useDesktopAppInfo()
  const desktopVersionTooltip = formatDesktopAppVersionTooltip(desktopAppInfo)
  const sidebarRef = useRef<HTMLElement | null>(null)
  const settingsMenuRef = useRef<HTMLDivElement | null>(null)
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null)
  const sessionsRef = useRef<HTMLDivElement | null>(null)
  const renameInputRef = useRef<InputRef | null>(null)
  const updateSettingsMenuOpen = React.useCallback(
    (open: boolean) => {
      if (settingsMenuOpenRef.current === open) return
      settingsMenuOpenRef.current = open
      setSettingsMenuOpen(open)
      onSettingsMenuOpenChange?.(open)
    },
    [onSettingsMenuOpenChange]
  )
  const closeCompactMenu = React.useCallback(
    (closeFocus?: 'preserve-destination-focus') => {
      updateSettingsMenuOpen(false)
      onCompactMenuOpenChange(false, closeFocus)
    },
    [onCompactMenuOpenChange, updateSettingsMenuOpen]
  )
  const previousCompactModeRef = useRef(compactMode)

  useEffect(() => {
    if (compactMode && !previousCompactModeRef.current && !compactMenuOpen) {
      updateSettingsMenuOpen(false)
    }
    if (!compactMode && previousCompactModeRef.current) {
      updateSettingsMenuOpen(false)
    }
    previousCompactModeRef.current = compactMode
  }, [compactMenuOpen, compactMode, updateSettingsMenuOpen])

  const requestDeleteSession = React.useCallback(
    async (session: { agentRef: string; id: string; title: string }) => {
      setSessionMenuId(null)
      try {
        const deletion = await captureChatDeleteFence(session.agentRef)
        setPendingDeleteSession({
          agentRef: session.agentRef,
          chatId: session.id,
          title: session.title,
          deletion,
        })
      } catch {
        // captureChatDeleteFence reports the failure through the shared chat toast.
      }
    },
    [captureChatDeleteFence, pushToast]
  )

  useClickOutside(settingsMenuRef, settingsMenuOpen, () => {
    updateSettingsMenuOpen(false)
  })
  useClickOutside(sessionsRef, Boolean(sessionMenuId), () => setSessionMenuId(null))

  useEffect(() => {
    if (toggleRequestId <= lastToggleRequestIdRef.current) return
    lastToggleRequestIdRef.current = toggleRequestId
    if (compactMode && compactMenuOpen) closeCompactMenu()
    else if (compactMode) onCompactMenuOpenChange(true)
    else onCollapsedChange(!collapsed)
  }, [
    collapsed,
    compactMenuOpen,
    compactMode,
    closeCompactMenu,
    onCollapsedChange,
    onCompactMenuOpenChange,
    toggleRequestId,
  ])

  const email = me?.email
  const displayName = me?.name || email?.split('@')[0] || 'Unknown'
  const initials = useMemo(() => {
    const fullName = me?.name?.trim() || ''
    if (fullName) {
      const parts = fullName.split(/\s+/).filter(Boolean)
      if (parts.length >= 2) {
        const first = parts[0] || ''
        const last = parts[parts.length - 1] || ''
        return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase()
      }
      return fullName.slice(0, 2).toUpperCase()
    }
    const local = email?.split('@')[0]?.trim() || ''
    return (local.slice(0, 2) || '?').toUpperCase()
  }, [email, me?.name])

  useEffect(() => {
    return () => {
      onSettingsMenuOpenChange?.(false)
    }
  }, [onSettingsMenuOpenChange])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const previousOverflow = document.body.style.overflow
    document.body.classList.toggle(COMPACT_SIDEBAR_OPEN_CLASS, compactMenuOpen)
    if (compactMenuOpen) document.body.style.overflow = 'hidden'
    return () => {
      document.body.classList.remove(COMPACT_SIDEBAR_OPEN_CLASS)
      document.body.style.overflow = previousOverflow
    }
  }, [compactMenuOpen])

  useEffect(() => {
    if (!compactMenuOpen) return undefined
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeCompactMenu()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [closeCompactMenu, compactMenuOpen])

  const primaryItems: Array<{ id: NavItem; label: string; testId: string; icon: React.ReactNode }> =
    useMemo(
      () => [
        {
          id: DESKTOP_ROUTES.chat,
          label: 'Chat',
          testId: 'nav-chat',
          icon: (
            <span className="nav-icon">
              <IconChat aria-hidden="true" width={16} height={16} />
            </span>
          ),
        },
        {
          id: DESKTOP_ROUTES.apps,
          label: 'Apps',
          testId: 'nav-sandbox-ui',
          icon: (
            <span className="nav-icon">
              <IconSandboxUi aria-hidden="true" width={16} height={16} />
            </span>
          ),
        },
      ],
      []
    )

  const dataRouteItems: Array<{
    id: NavItem
    label: string
    testId: string
    icon: React.ReactNode
  }> = useMemo(
    () => [
      {
        id: DESKTOP_ROUTES.agents,
        label: 'Agents',
        testId: 'nav-agents',
        icon: (
          <span className="nav-icon">
            <IconAgents aria-hidden="true" width={16} height={16} />
          </span>
        ),
      },
      {
        id: DESKTOP_ROUTES.connectors,
        label: 'Connectors',
        testId: 'nav-mcp-servers',
        icon: (
          <span className="nav-icon">
            <IconConnectors aria-hidden="true" width={16} height={16} />
          </span>
        ),
      },
      {
        id: DESKTOP_ROUTES.plugins,
        label: 'Plugins',
        testId: 'nav-workflows',
        icon: (
          <span className="nav-icon">
            <IconWorkflows aria-hidden="true" width={16} height={16} />
          </span>
        ),
      },
    ],
    []
  )

  const dataMenuActive = dataRouteItems.some(item => item.id === navItem)
  const settingsMenuActive = navItem === DESKTOP_ROUTES.settings || dataMenuActive
  const visibleLatestChatSessions = useMemo(
    () => latestChatSessions.slice(0, SIDEBAR_SESSION_PREVIEW_LIMIT),
    [latestChatSessions]
  )
  const latestSessionsToggleVisible = latestChatSessions.length > SIDEBAR_SESSION_PREVIEW_LIMIT

  const handleSelect = (item: NavItem) => {
    onSelect(item)
    closeCompactMenu()
    setSessionMenuId(null)
  }

  const handleFilesNavSelect = () => {
    handleSelect(DESKTOP_ROUTES.files)
    // The Files label doubles as the explorer's reveal: activating it both
    // focuses the files tab and exposes the tree. It only ever expands —
    // collapsing stays the chevron's job, so a second click never hides the
    // tree the user just opened. Skip the reveal while the sidebar is
    // collapsed: the tree cannot render there, so the flag would have no
    // visible effect and only defer its discovery fetch to a later expand.
    if (!isCollapsed) setFilesExplorerOpen(true)
  }

  const startSessionRename = (session: (typeof latestChatSessions)[number]) => {
    setSessionMenuId(null)
    setRenamingSessionId(`${session.agentRef}${SESSION_KEY_SEPARATOR}${session.id}`)
    setSessionRenameValue(session.title)
  }

  const cancelSessionRename = () => {
    setRenamingSessionId(null)
    setSessionRenameValue('')
  }

  const commitSessionRename = async () => {
    if (!renamingSessionId) return
    const [agentRef, chatId] = renamingSessionId.split(SESSION_KEY_SEPARATOR)
    const nextTitle = sessionRenameValue.trim()
    const session = latestChatSessions.find(
      item => item.agentRef === agentRef && item.id === chatId
    )
    cancelSessionRename()
    if (!agentRef || !chatId || !nextTitle || nextTitle === session?.title) return
    await onRenameChatForAgent(agentRef, chatId, nextTitle)
  }

  useEffect(() => {
    if (!renamingSessionId || !renameInputRef.current) return
    renameInputRef.current.focus()
    renameInputRef.current.select()
  }, [renamingSessionId])

  const handleLogoClick = () => {
    handleSelect(DESKTOP_ROUTES.chat)
  }

  const closeSettingsMenuWithFocus = () => {
    updateSettingsMenuOpen(false)
    settingsTriggerRef.current?.focus()
  }

  const handleSettingsMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !settingsMenuOpen) return
    event.preventDefault()
    event.stopPropagation()
    closeSettingsMenuWithFocus()
  }

  const settingsMenuItems: MenuProps['items'] = [
    ...dataRouteItems.map(item => ({
      key: item.id,
      label: item.label,
      icon: item.icon,
      'data-testid': item.testId,
    })),
    {
      key: DESKTOP_ROUTES.settings,
      label: 'Settings',
      icon: (
        <span className="nav-icon">
          <IconSettings aria-hidden="true" width={16} height={16} />
        </span>
      ),
      'data-testid': 'nav-settings',
    },
    { type: 'divider', key: 'account-actions-divider' },
    {
      key: 'logout',
      label: 'Logout',
      icon: (
        <svg
          className="logout-icon"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M5.5 3H10.5C11.3284 3 12 3.67157 12 4.5V11.5C12 12.3284 11.3284 13 10.5 13H5.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M8 8L12 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <path
            d="M6.5 6L4 8L6.5 10"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      danger: true,
      disabled: busy,
      'data-testid': 'logout-btn',
    },
  ]

  const handleSettingsMenuClick: NonNullable<MenuProps['onClick']> = ({ key }) => {
    if (key === 'logout') {
      closeCompactMenu()
      onLogout()
      return
    }
    handleSelect(key as NavItem)
  }

  return (
    <>
      <aside
        ref={sidebarRef}
        id="desktop-sidebar-navigation"
        aria-hidden={compactMode && !compactMenuOpen ? true : undefined}
        inert={compactMode && !compactMenuOpen ? true : undefined}
        className={`left-nav glass-card ${isCollapsed ? 'collapsed' : ''}${
          compactMenuOpen ? ' compact-open' : ''
        }`}
      >
        <Button
          htmlType="button"
          type="text"
          className="sidebar-mobile-backdrop"
          aria-label="Close navigation menu"
          onClick={() => {
            closeCompactMenu()
          }}
        />
        <div className="sidebar-logo">
          <Button
            htmlType="button"
            type="text"
            className="sidebar-logo-link"
            onClick={handleLogoClick}
            aria-label="Go to Chat"
            title={desktopVersionTooltip}
          >
            <img className="sidebar-logo-mark" src="./logo.svg" alt="" aria-hidden="true" />
            <img
              className="sidebar-logo-lockup sidebar-logo-lockup--light"
              src="./logotype-light.svg"
              alt=""
              aria-hidden="true"
            />
            <img
              className="sidebar-logo-lockup sidebar-logo-lockup--dark"
              src="./logotype-dark.svg"
              alt="Evenfire"
            />
          </Button>
          <Button
            htmlType="button"
            type="text"
            shape="circle"
            className="sidebar-compact-close"
            aria-label="Close navigation menu"
            title="Close navigation menu"
            onClick={() => closeCompactMenu()}
            icon={
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="m4 4 8 8M12 4l-8 8" />
              </svg>
            }
          />
          <Button
            htmlType="button"
            type="text"
            size="small"
            shape="circle"
            className="sidebar-collapse-toggle"
            aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            icon={
              <svg
                className={`sidebar-collapse-icon${isCollapsed ? ' expanded' : ''}`}
                viewBox="0 0 16 16"
                aria-hidden="true"
              >
                <path d="m10 3-5 5 5 5" />
              </svg>
            }
            onClick={() => onCollapsedChange(!collapsed)}
          />
        </div>

        {!isCollapsed && !compactMode && resize ? (
          <div
            aria-label="Resize sidebar"
            aria-orientation="vertical"
            aria-valuemax={resize.maxWidth}
            aria-valuemin={192}
            aria-valuenow={resize.width}
            className="sidebar-resize-handle"
            onKeyDown={resize.onKeyDown}
            onLostPointerCapture={resize.onLostPointerCapture}
            onPointerCancel={resize.onPointerCancel}
            onPointerDown={resize.onPointerDown}
            onPointerMove={resize.onPointerMove}
            onPointerUp={resize.onPointerUp}
            role="separator"
            tabIndex={0}
          />
        ) : null}

        <div className="sidebar-menu-surface">
          <nav className="nav-links">
            {primaryItems.map(item => (
              <React.Fragment key={item.id}>
                <div
                  className={`nav-link nav-link--with-toggle${
                    item.id === DESKTOP_ROUTES.chat && !isCollapsed
                      ? ' nav-link--with-new-chat'
                      : ''
                  } ${navItem === item.id ? 'active' : ''}`}
                  title={isCollapsed ? item.label : undefined}
                  data-tooltip={item.label}
                >
                  <Button
                    htmlType="button"
                    type="text"
                    block
                    data-testid={item.testId}
                    className="nav-link-main"
                    onClick={() => handleSelect(item.id)}
                    aria-label={item.label}
                    aria-current={navItem === item.id ? 'page' : undefined}
                    title={isCollapsed ? item.label : undefined}
                    icon={item.icon}
                  >
                    {isCollapsed ? null : item.label}
                  </Button>
                  {item.id === DESKTOP_ROUTES.chat && !isCollapsed && (
                    <Button
                      htmlType="button"
                      type="text"
                      size="small"
                      shape="circle"
                      className="nav-link-new-chat"
                      aria-label="New chat"
                      title="New chat"
                      data-testid="nav-new-chat"
                      icon={<IconNewChat aria-hidden="true" width={16} height={16} />}
                      onClick={event => {
                        event.stopPropagation()
                        onNewChat()
                        closeCompactMenu('preserve-destination-focus')
                      }}
                    />
                  )}
                  <Button
                    htmlType="button"
                    type="text"
                    size="small"
                    shape="circle"
                    className="nav-link-session-toggle"
                    aria-label={
                      item.id === DESKTOP_ROUTES.chat
                        ? chatSessionsOpen
                          ? 'Collapse chat sessions'
                          : 'Expand chat sessions'
                        : appsOpen
                          ? 'Collapse apps'
                          : 'Expand apps'
                    }
                    aria-expanded={item.id === DESKTOP_ROUTES.chat ? chatSessionsOpen : appsOpen}
                    title={
                      item.id === DESKTOP_ROUTES.chat
                        ? chatSessionsOpen
                          ? 'Collapse chat sessions'
                          : 'Expand chat sessions'
                        : appsOpen
                          ? 'Collapse apps'
                          : 'Expand apps'
                    }
                    icon={
                      <IconChevronRight
                        aria-hidden="true"
                        className={
                          (item.id === DESKTOP_ROUTES.chat ? chatSessionsOpen : appsOpen)
                            ? 'expanded'
                            : ''
                        }
                      />
                    }
                    onClick={event => {
                      event.stopPropagation()
                      if (item.id === DESKTOP_ROUTES.chat) {
                        setChatSessionsOpen(open => !open)
                        setSessionMenuId(null)
                      } else {
                        setAppsOpen(open => !open)
                      }
                    }}
                  />
                </div>

                {item.id === DESKTOP_ROUTES.chat && chatSessionsOpen && (
                  <div className="nav-latest-sessions" ref={sessionsRef}>
                    {latestChatSessionsLoading && !latestChatSessions.length ? (
                      <span className="nav-latest-sessions__empty">Loading sessions...</span>
                    ) : latestChatSessions.length ? (
                      <>
                        <div className="nav-latest-sessions__list">
                          {visibleLatestChatSessions.map(session => {
                            const sessionKey = `${session.agentRef}${SESSION_KEY_SEPARATOR}${session.id}`
                            const isActive =
                              navItem === DESKTOP_ROUTES.chat &&
                              selectedAgent === session.agentRef &&
                              activeChatId === session.id
                            const isMenuOpen = sessionMenuId === sessionKey
                            const isRenaming = renamingSessionId === sessionKey
                            return (
                              <div
                                key={sessionKey}
                                data-testid="latest-session-row"
                                data-agent-ref={session.agentRef}
                                data-chat-id={session.id}
                                aria-current={isActive ? 'true' : undefined}
                                className={`nav-latest-session${isActive ? ' active' : ''}`}
                                title={isCollapsed ? session.title : undefined}
                              >
                                {isRenaming ? (
                                  <div className="nav-latest-session__main nav-latest-session__main--editing">
                                    <Input
                                      ref={renameInputRef}
                                      className="nav-latest-session__rename-input"
                                      aria-label="Rename session"
                                      value={sessionRenameValue}
                                      onChange={event => setSessionRenameValue(event.target.value)}
                                      onClick={event => event.stopPropagation()}
                                      onBlur={() => {
                                        void commitSessionRename()
                                      }}
                                      onPressEnter={event => {
                                        event.preventDefault()
                                        void commitSessionRename()
                                      }}
                                      onKeyDown={event => {
                                        if (event.key === 'Escape') {
                                          event.preventDefault()
                                          cancelSessionRename()
                                        }
                                      }}
                                    />
                                  </div>
                                ) : (
                                  <Button
                                    htmlType="button"
                                    type="text"
                                    block
                                    className="nav-latest-session__main"
                                    aria-label={`Open ${session.title}`}
                                    onClick={() => {
                                      onSelectChatAgent(session.agentRef, {
                                        selectLatest: false,
                                        chatId: session.id,
                                        isRemote: session.remote === true,
                                        title: session.title,
                                      })
                                      closeCompactMenu()
                                      setSessionMenuId(null)
                                    }}
                                  >
                                    <span className="nav-latest-session__copy">
                                      <Typography.Text className="nav-latest-session__title">
                                        {session.title}
                                      </Typography.Text>
                                      <Typography.Text
                                        className="nav-latest-session__agent"
                                        type="secondary"
                                      >
                                        {session.agentRef}
                                      </Typography.Text>
                                    </span>
                                  </Button>
                                )}
                                {/* Badge cell always holds grid column 3. */}
                                <span className="nav-latest-session__badge">
                                  {!isRenaming && (
                                    <ChatStateBadge
                                      sessionState={
                                        sessionStateByChatKey[
                                          makeTaskKey(session.agentRef, session.id)
                                        ]
                                      }
                                      unreadTerminal={session.unreadTerminal === true}
                                    />
                                  )}
                                </span>
                                <Dropdown
                                  destroyOnHidden
                                  getPopupContainer={trigger =>
                                    trigger.parentElement ?? document.body
                                  }
                                  menu={{
                                    items: [
                                      { key: 'rename', label: 'Rename' },
                                      { key: 'delete', label: 'Delete', danger: true },
                                    ],
                                    onClick: ({ key }) => {
                                      if (key === 'rename') startSessionRename(session)
                                      if (key === 'delete') void requestDeleteSession(session)
                                    },
                                  }}
                                  onOpenChange={open => setSessionMenuId(open ? sessionKey : null)}
                                  open={isMenuOpen}
                                  placement="bottomRight"
                                  trigger={['click']}
                                >
                                  <Button
                                    htmlType="button"
                                    type="text"
                                    size="small"
                                    shape="circle"
                                    className="nav-latest-session__menu-button"
                                    aria-label={`Session options for ${session.title}`}
                                    aria-haspopup="menu"
                                    aria-expanded={isMenuOpen}
                                    title={`Session options for ${session.title}`}
                                    icon={<IconMoreHorizontal aria-hidden="true" />}
                                    onClick={event => event.stopPropagation()}
                                  />
                                </Dropdown>
                              </div>
                            )
                          })}
                        </div>
                        {latestSessionsToggleVisible && (
                          <Button
                            htmlType="button"
                            className="nav-latest-sessions__toggle"
                            onClick={() => handleSelect(DESKTOP_ROUTES.chat)}
                            size="small"
                            type="link"
                          >
                            Show all
                          </Button>
                        )}
                      </>
                    ) : null}
                  </div>
                )}

                {item.id === DESKTOP_ROUTES.apps &&
                  !isCollapsed &&
                  appsOpen &&
                  availableSandboxUiApps.length > 0 && (
                    <div className="nav-available-apps">
                      {availableSandboxUiApps.map(app => {
                        const isActive = activeSandboxUiApp?.appRef === app.appRef
                        return (
                          <Button
                            key={app.appRef}
                            htmlType="button"
                            type="text"
                            block
                            className={`nav-available-app${isActive ? ' active' : ''}`}
                            aria-label={`Open ${app.label}`}
                            aria-current={isActive ? 'page' : undefined}
                            onClick={() => {
                              onOpenSandboxUiApp(app)
                              closeCompactMenu()
                            }}
                          >
                            <span className="nav-available-app__label">{app.label}</span>
                          </Button>
                        )
                      })}
                    </div>
                  )}
              </React.Fragment>
            ))}

            <div
              className={`nav-link nav-link--with-toggle${
                navItem === DESKTOP_ROUTES.files ? ' active' : ''
              }`}
              title={isCollapsed ? 'Files' : undefined}
              data-tooltip="Files"
            >
              <Button
                htmlType="button"
                type="text"
                block
                data-testid="nav-files"
                className="nav-link-main"
                onClick={handleFilesNavSelect}
                aria-label="Files"
                aria-current={navItem === DESKTOP_ROUTES.files ? 'page' : undefined}
                title={collapsed ? 'EvenDrive' : undefined}
                icon={
                  <span className="nav-icon">
                    <IconHardDrive aria-hidden="true" width={16} height={16} />
                  </span>
                }
              >
                {collapsed ? null : 'EvenDrive'}
              </Button>
              <Button
                htmlType="button"
                type="text"
                size="small"
                shape="circle"
                className="nav-link-session-toggle"
                aria-label={filesExplorerOpen ? 'Collapse file explorer' : 'Expand file explorer'}
                aria-expanded={filesExplorerOpen}
                title={filesExplorerOpen ? 'Collapse file explorer' : 'Expand file explorer'}
                data-testid="nav-files-explorer-toggle"
                icon={
                  <IconChevronRight
                    aria-hidden="true"
                    className={filesExplorerOpen ? 'expanded' : ''}
                  />
                }
                onClick={event => {
                  event.stopPropagation()
                  setFilesExplorerOpen(open => !open)
                }}
              />
            </div>

            {!isCollapsed && filesExplorerOpen && (
              <div className="nav-file-explorer">
                <FileExplorerTree
                  onOpenFolder={uri => {
                    onOpenFilesSection(uri)
                    closeCompactMenu()
                  }}
                  onOpenPreview={preview => {
                    onOpenPreviewSection(preview)
                    closeCompactMenu()
                  }}
                  pushToast={pushToast}
                />
              </div>
            )}
          </nav>

          <div className="sidebar-footer">
            <div
              className="sidebar-settings-menu-wrapper"
              ref={settingsMenuRef}
              onKeyDownCapture={handleSettingsMenuKeyDown}
            >
              <Dropdown
                destroyOnHidden
                getPopupContainer={() => settingsMenuRef.current ?? document.body}
                menu={{
                  items: settingsMenuItems,
                  className: 'sidebar-settings-antd-menu',
                  onClick: handleSettingsMenuClick,
                  selectable: true,
                  selectedKeys: [navItem],
                }}
                onOpenChange={updateSettingsMenuOpen}
                open={settingsMenuOpen}
                placement={compactMode ? 'bottomLeft' : 'topLeft'}
                popupRender={menu => (
                  <Flex vertical gap="small">
                    <div className="sidebar-settings-profile" aria-label="Signed in account">
                      <Avatar className="sidebar-settings-profile-avatar" size="small">
                        {initials}
                      </Avatar>
                      <Flex vertical className="sidebar-settings-profile-copy">
                        <Typography.Text
                          className="sidebar-settings-profile-name"
                          data-testid="user-display-name"
                          strong
                        >
                          {displayName}
                        </Typography.Text>
                        <Typography.Text
                          className="sidebar-settings-profile-email"
                          type="secondary"
                        >
                          {email || 'No email'}
                        </Typography.Text>
                      </Flex>
                    </div>
                    {menu}
                  </Flex>
                )}
                trigger={['click']}
              >
                <Button
                  ref={settingsTriggerRef}
                  htmlType="button"
                  type="text"
                  block
                  data-testid="nav-settings-menu"
                  className={`nav-link sidebar-settings-trigger${settingsMenuOpen ? ' open' : ''}${
                    settingsMenuActive ? ' active' : ''
                  }`}
                  onClick={event => event.stopPropagation()}
                  aria-current={settingsMenuActive ? 'page' : undefined}
                  aria-haspopup="menu"
                  aria-expanded={settingsMenuOpen}
                  title={collapsed ? 'Settings' : undefined}
                  data-tooltip="Settings"
                  icon={
                    <span className="nav-icon">
                      <IconSettings aria-hidden="true" width={16} height={16} />
                    </span>
                  }
                >
                  <span className="nav-link-label">Settings</span>
                  <span className="sidebar-settings-chevron" aria-hidden="true">
                    <svg viewBox="0 0 16 16">
                      <path d="m4.5 6 3.5 3.5L11.5 6" />
                    </svg>
                  </span>
                </Button>
              </Dropdown>
            </div>
          </div>
        </div>
      </aside>
      {pendingDeleteSession ? (
        <Modal
          open
          title="Delete session?"
          okText="Delete"
          cancelText="Cancel"
          okButtonProps={{ danger: true }}
          cancelButtonProps={{ autoFocus: true }}
          onCancel={() => setPendingDeleteSession(null)}
          onOk={() => {
            void onDeleteChatForAgent(
              pendingDeleteSession.agentRef,
              pendingDeleteSession.chatId,
              pendingDeleteSession.deletion
            )
            setPendingDeleteSession(null)
          }}
        >
          <Typography.Text>
            Delete <Typography.Text strong>{pendingDeleteSession.title}</Typography.Text>? Messages
            cannot be recovered.
          </Typography.Text>
        </Modal>
      ) : null}
    </>
  )
}
