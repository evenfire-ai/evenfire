import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useAgentChatActionsContext } from '@contexts/AgentChatActionsContext'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext/types'
import { useAuthContext } from '@contexts/AuthContext'
import { useChatListContext } from '@contexts/ChatListContext'
import { useNavigationContext } from '@contexts/NavigationContext'
import { Button, IconButton, MenuItem, NavItem as NavItemControl } from '@components/Common'
import { ConfirmDialog } from '@components/ConfirmDialog'
import { ChatStateBadge } from '@components/agents/ChatStateBadge'
import { DESKTOP_ROUTES, SIDEBAR_SESSION_PREVIEW_LIMIT } from '@constants/navigation'
import { useClickOutside } from '@hooks/useClickOutside'
import { formatDesktopAppVersionTooltip, useDesktopAppInfo } from '@hooks/useDesktopAppInfo'
import type { NavItem } from '@/uiTypes'
import {
  IconAgents,
  IconAttachFile,
  IconChat,
  IconChevronRight,
  IconConnectors,
  IconContexts,
  IconData,
  IconMoreHorizontal,
  IconNewChat,
  IconSandboxUi,
  IconSettings,
  IconTeams,
  IconWorkflows,
} from './icons'
import type { SidebarNavProps } from './types'

const MOBILE_SIDEBAR_QUERY = '(max-width: 900px)'
const MOBILE_SIDEBAR_OPEN_CLASS = 'mobile-sidebar-open'
const SESSION_KEY_SEPARATOR = '\u001f'

function isMobileSidebarViewport() {
  return typeof window !== 'undefined' && window.matchMedia(MOBILE_SIDEBAR_QUERY).matches
}

export function SidebarNav({
  navItem,
  collapsed,
  activeSandboxUiApp,
  availableSandboxUiApps,
  onCollapsedChange,
  onOpenSandboxUiApp,
  onSettingsMenuOpenChange,
  onSelect,
}: SidebarNavProps) {
  const { busy, me, handleLogout: onLogout } = useAuthContext()
  const { activeChatId, latestChatSessions, latestChatSessionsLoading, sessionStateByChatKey } =
    useChatListContext()
  const {
    handleRenameChatForAgent: onRenameChatForAgent,
    handleDeleteChatForAgent: onDeleteChatForAgent,
  } = useAgentChatActionsContext()
  const { selectedAgent, handleSelectChatAgent: onSelectChatAgent } = useNavigationContext()
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [dataSubmenuOpen, setDataSubmenuOpen] = useState(false)
  const [chatSessionsOpen, setChatSessionsOpen] = useState(true)
  const [appsOpen, setAppsOpen] = useState(true)
  const [sessionMenuId, setSessionMenuId] = useState<string | null>(null)
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
  const [sessionRenameValue, setSessionRenameValue] = useState('')
  const [pendingDeleteSession, setPendingDeleteSession] = useState<{
    agentRef: string
    chatId: string
    title: string
  } | null>(null)
  const desktopAppInfo = useDesktopAppInfo()
  const desktopVersionTooltip = formatDesktopAppVersionTooltip(desktopAppInfo)
  const sidebarRef = useRef<HTMLElement | null>(null)
  const settingsMenuRef = useRef<HTMLDivElement | null>(null)
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null)
  const sessionsRef = useRef<HTMLDivElement | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const updateSettingsMenuOpen = React.useCallback(
    (open: boolean) => {
      setSettingsMenuOpen(open)
      onSettingsMenuOpenChange?.(open)
    },
    [onSettingsMenuOpenChange]
  )

  useClickOutside(settingsMenuRef, settingsMenuOpen, () => {
    updateSettingsMenuOpen(false)
    setDataSubmenuOpen(false)
  })
  useClickOutside(sidebarRef, mobileMenuOpen, () => setMobileMenuOpen(false))
  useClickOutside(sessionsRef, Boolean(sessionMenuId), () => setSessionMenuId(null))

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
    document.body.classList.toggle(MOBILE_SIDEBAR_OPEN_CLASS, mobileMenuOpen)
    return () => {
      document.body.classList.remove(MOBILE_SIDEBAR_OPEN_CLASS)
    }
  }, [mobileMenuOpen])

  const primaryItems: Array<{ id: NavItem; label: string; testId: string; icon: React.ReactNode }> =
    useMemo(
      () => [
        {
          id: DESKTOP_ROUTES.chat,
          label: 'Chat',
          testId: 'nav-chat',
          icon: <IconChat />,
        },
        {
          id: DESKTOP_ROUTES.apps,
          label: 'Apps',
          testId: 'nav-sandbox-ui',
          icon: <IconSandboxUi />,
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
        id: DESKTOP_ROUTES.plugins,
        label: 'Plugins',
        testId: 'nav-workflows',
        icon: <IconWorkflows />,
      },
      {
        id: DESKTOP_ROUTES.agents,
        label: 'Agents',
        testId: 'nav-agents',
        icon: <IconAgents />,
      },
      {
        id: DESKTOP_ROUTES.contexts,
        label: 'Contexts',
        testId: 'nav-contexts',
        icon: <IconContexts />,
      },
      {
        id: DESKTOP_ROUTES.teams,
        label: 'Teams',
        testId: 'nav-teams',
        icon: <IconTeams />,
      },
      {
        id: DESKTOP_ROUTES.connectors,
        label: 'Connectors',
        testId: 'nav-mcp-servers',
        icon: <IconConnectors />,
      },
    ],
    []
  )

  const dataMenuActive =
    dataRouteItems.some(item => item.id === navItem) ||
    navItem === DESKTOP_ROUTES.contextDetails ||
    navItem === DESKTOP_ROUTES.teamDetails
  const settingsMenuActive = navItem === DESKTOP_ROUTES.settings || dataMenuActive
  const visibleLatestChatSessions = useMemo(
    () => latestChatSessions.slice(0, SIDEBAR_SESSION_PREVIEW_LIMIT),
    [latestChatSessions]
  )
  const latestSessionsToggleVisible = latestChatSessions.length > SIDEBAR_SESSION_PREVIEW_LIMIT

  const handleSelect = (item: NavItem) => {
    onSelect(item)
    setMobileMenuOpen(false)
    updateSettingsMenuOpen(false)
    setDataSubmenuOpen(false)
    setSessionMenuId(null)
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
    if (isMobileSidebarViewport()) {
      setMobileMenuOpen(open => !open)
      updateSettingsMenuOpen(false)
      setDataSubmenuOpen(false)
      return
    }
    handleSelect(DESKTOP_ROUTES.chat)
  }

  const closeSettingsMenuWithFocus = () => {
    updateSettingsMenuOpen(false)
    setDataSubmenuOpen(false)
    settingsTriggerRef.current?.focus()
  }

  const handleSettingsMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !settingsMenuOpen) return
    event.preventDefault()
    event.stopPropagation()
    closeSettingsMenuWithFocus()
  }

  return (
    <>
      <aside
        ref={sidebarRef}
        className={`left-nav glass-card ${collapsed ? 'collapsed' : ''}${
          mobileMenuOpen ? ' mobile-open' : ''
        }`}
      >
        <button
          type="button"
          className="sidebar-mobile-backdrop"
          aria-label="Close navigation menu"
          onClick={() => {
            setMobileMenuOpen(false)
            updateSettingsMenuOpen(false)
            setDataSubmenuOpen(false)
          }}
        />
        <div className="sidebar-logo">
          <button
            type="button"
            className="sidebar-logo-link"
            onClick={handleLogoClick}
            aria-label={isMobileSidebarViewport() ? 'Open navigation menu' : 'Go to Chat'}
            aria-expanded={mobileMenuOpen}
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
            <span className="sidebar-mobile-menu-indicator" aria-hidden="true">
              <svg viewBox="0 0 16 16">
                <path d="m4.5 6 3.5 3.5L11.5 6" />
              </svg>
            </span>
          </button>
          <IconButton
            type="button"
            className="sidebar-collapse-toggle"
            label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => onCollapsedChange(!collapsed)}
            variant="ghost"
          >
            <svg
              className={`sidebar-collapse-icon${collapsed ? ' expanded' : ''}`}
              viewBox="0 0 16 16"
              aria-hidden="true"
            >
              <path d="m10 3-5 5 5 5" />
            </svg>
          </IconButton>
        </div>

        <div className="sidebar-menu-surface">
          <nav className="nav-links">
            {primaryItems.map(item => (
              <React.Fragment key={item.id}>
                <div
                  className={`nav-link nav-link--with-toggle${
                    item.id === DESKTOP_ROUTES.chat && !collapsed ? ' nav-link--with-new-chat' : ''
                  } ${navItem === item.id ? 'active' : ''}`}
                  title={collapsed ? item.label : undefined}
                  data-tooltip={item.label}
                >
                  <NavItemControl
                    data-testid={item.testId}
                    className="nav-link-main"
                    onClick={() => handleSelect(item.id)}
                    aria-label={item.label}
                    leadingIcon={item.icon}
                    trailingIcon={
                      <span className="nav-tooltip" role="tooltip">
                        {item.label}
                      </span>
                    }
                  >
                    {item.label}
                  </NavItemControl>
                  {item.id === DESKTOP_ROUTES.chat && !collapsed && (
                    <IconButton
                      className="nav-link-new-chat"
                      label="New chat"
                      title="New chat"
                      data-testid="nav-new-chat"
                      onClick={event => {
                        event.stopPropagation()
                        handleSelect(DESKTOP_ROUTES.chat)
                      }}
                      variant="ghost"
                    >
                      <IconNewChat />
                    </IconButton>
                  )}
                  <IconButton
                    className="nav-link-session-toggle"
                    label={
                      item.id === DESKTOP_ROUTES.chat
                        ? chatSessionsOpen
                          ? 'Collapse chat sessions'
                          : 'Expand chat sessions'
                        : appsOpen
                          ? 'Collapse apps'
                          : 'Expand apps'
                    }
                    aria-expanded={item.id === DESKTOP_ROUTES.chat ? chatSessionsOpen : appsOpen}
                    onClick={event => {
                      event.stopPropagation()
                      if (item.id === DESKTOP_ROUTES.chat) {
                        setChatSessionsOpen(open => !open)
                        setSessionMenuId(null)
                      } else {
                        setAppsOpen(open => !open)
                      }
                    }}
                    variant="ghost"
                  >
                    <IconChevronRight
                      className={
                        (item.id === DESKTOP_ROUTES.chat ? chatSessionsOpen : appsOpen)
                          ? 'expanded'
                          : ''
                      }
                    />
                  </IconButton>
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
                                className={`nav-latest-session${isActive ? ' active' : ''}`}
                                title={collapsed ? session.title : undefined}
                              >
                                {isRenaming ? (
                                  <div className="nav-latest-session__main nav-latest-session__main--editing">
                                    <input
                                      ref={renameInputRef}
                                      className="nav-latest-session__rename-input"
                                      aria-label="Rename session"
                                      value={sessionRenameValue}
                                      onChange={event => setSessionRenameValue(event.target.value)}
                                      onClick={event => event.stopPropagation()}
                                      onBlur={() => {
                                        void commitSessionRename()
                                      }}
                                      onKeyDown={event => {
                                        if (event.key === 'Enter') {
                                          event.preventDefault()
                                          void commitSessionRename()
                                        }
                                        if (event.key === 'Escape') {
                                          event.preventDefault()
                                          cancelSessionRename()
                                        }
                                      }}
                                    />
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    className="nav-latest-session__main"
                                    aria-label={`Open ${session.title}`}
                                    onClick={() => {
                                      onSelectChatAgent(session.agentRef, {
                                        selectLatest: false,
                                        chatId: session.id,
                                        isRemote: session.remote === true,
                                        title: session.title,
                                      })
                                      setMobileMenuOpen(false)
                                      setSessionMenuId(null)
                                    }}
                                  >
                                    <span className="nav-latest-session__copy">
                                      <span className="nav-latest-session__title">
                                        {session.title}
                                      </span>
                                      <span className="nav-latest-session__agent">
                                        {session.agentRef}
                                      </span>
                                    </span>
                                  </button>
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
                                <IconButton
                                  className="nav-latest-session__menu-button"
                                  label={`Session options for ${session.title}`}
                                  aria-haspopup="menu"
                                  aria-expanded={isMenuOpen}
                                  onClick={event => {
                                    event.stopPropagation()
                                    setSessionMenuId(isMenuOpen ? null : sessionKey)
                                  }}
                                  variant="ghost"
                                >
                                  <IconMoreHorizontal />
                                </IconButton>
                                {isMenuOpen && (
                                  <div className="nav-latest-session__menu" role="menu">
                                    <MenuItem
                                      role="menuitem"
                                      onClick={() => startSessionRename(session)}
                                    >
                                      Rename
                                    </MenuItem>
                                    <MenuItem
                                      role="menuitem"
                                      color="danger"
                                      className="danger"
                                      onClick={() => {
                                        setSessionMenuId(null)
                                        setPendingDeleteSession({
                                          agentRef: session.agentRef,
                                          chatId: session.id,
                                          title: session.title,
                                        })
                                      }}
                                    >
                                      Delete
                                    </MenuItem>
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                        {latestSessionsToggleVisible && (
                          <Button
                            className="nav-latest-sessions__toggle"
                            onClick={() => handleSelect(DESKTOP_ROUTES.chat)}
                            color="neutral"
                            size="xs"
                            variant="text"
                          >
                            Show all
                          </Button>
                        )}
                      </>
                    ) : null}
                  </div>
                )}

                {item.id === DESKTOP_ROUTES.apps &&
                  !collapsed &&
                  appsOpen &&
                  availableSandboxUiApps.length > 0 && (
                    <div className="nav-available-apps">
                      {availableSandboxUiApps.map(app => {
                        const isActive = activeSandboxUiApp?.appRef === app.appRef
                        return (
                          <button
                            key={app.appRef}
                            type="button"
                            className={`nav-available-app${isActive ? ' active' : ''}`}
                            aria-label={`Open ${app.label}`}
                            onClick={() => {
                              onOpenSandboxUiApp(app)
                              setMobileMenuOpen(false)
                            }}
                          >
                            <span className="nav-available-app__label">{app.label}</span>
                          </button>
                        )
                      })}
                    </div>
                  )}
              </React.Fragment>
            ))}

            <div
              className={`nav-link${navItem === DESKTOP_ROUTES.files ? ' active' : ''}`}
              title={collapsed ? 'Files' : undefined}
              data-tooltip="Files"
            >
              <NavItemControl
                data-testid="nav-files"
                className="nav-link-main"
                onClick={() => handleSelect(DESKTOP_ROUTES.files)}
                aria-label="Files"
                leadingIcon={<IconAttachFile />}
                trailingIcon={
                  <span className="nav-tooltip" role="tooltip">
                    Files
                  </span>
                }
              >
                Files
              </NavItemControl>
            </div>
          </nav>

          <div className="sidebar-footer">
            <div
              className="sidebar-settings-menu-wrapper"
              ref={settingsMenuRef}
              onKeyDown={handleSettingsMenuKeyDown}
            >
              <NavItemControl
                ref={settingsTriggerRef}
                data-testid="nav-settings-menu"
                active={settingsMenuActive}
                className={`nav-link sidebar-settings-trigger${settingsMenuOpen ? ' open' : ''}`}
                onClick={() => {
                  updateSettingsMenuOpen(!settingsMenuOpen)
                  setDataSubmenuOpen(false)
                }}
                aria-haspopup="menu"
                aria-expanded={settingsMenuOpen}
                title={collapsed ? 'Settings' : undefined}
                data-tooltip="Settings"
                leadingIcon={<IconSettings />}
                trailingIcon={
                  <>
                    <span className="sidebar-settings-chevron" aria-hidden="true">
                      <svg viewBox="0 0 16 16">
                        <path d="m4.5 6 3.5 3.5L11.5 6" />
                      </svg>
                    </span>
                    <span className="nav-tooltip" role="tooltip">
                      Settings
                    </span>
                  </>
                }
              >
                Settings
              </NavItemControl>

              {settingsMenuOpen && (
                <div className="sidebar-settings-menu" role="menu">
                  <div className="sidebar-settings-profile" aria-label="Signed in account">
                    <div className="sidebar-settings-profile-avatar" aria-hidden="true">
                      <span>{initials}</span>
                    </div>
                    <div className="sidebar-settings-profile-copy">
                      <p className="sidebar-settings-profile-name" data-testid="user-display-name">
                        {displayName}
                      </p>
                      <p className="sidebar-settings-profile-email">{email || 'No email'}</p>
                    </div>
                  </div>

                  <div
                    className={`sidebar-settings-menu-item-wrapper sidebar-settings-menu-item-wrapper--data${
                      dataSubmenuOpen ? ' is-open' : ''
                    }`}
                  >
                    <MenuItem
                      data-testid="nav-data-menu"
                      active={dataMenuActive}
                      className="sidebar-settings-menu-item sidebar-settings-route"
                      onClick={() => setDataSubmenuOpen(open => !open)}
                      role="menuitem"
                      aria-haspopup="menu"
                      aria-expanded={dataSubmenuOpen}
                      leadingIcon={<IconData />}
                      trailingIcon={
                        <span className="sidebar-settings-menu-arrow" aria-hidden="true">
                          <svg viewBox="0 0 16 16">
                            <path d="m6 4.5 3.5 3.5L6 11.5" />
                          </svg>
                        </span>
                      }
                    >
                      Resources
                    </MenuItem>
                    <div className="sidebar-data-submenu" role="menu" aria-label="Resources">
                      {dataRouteItems.map(item => (
                        <MenuItem
                          key={item.id}
                          data-testid={item.testId}
                          active={
                            navItem === item.id ||
                            (item.id === DESKTOP_ROUTES.contexts &&
                              navItem === DESKTOP_ROUTES.contextDetails) ||
                            (item.id === DESKTOP_ROUTES.teams &&
                              navItem === DESKTOP_ROUTES.teamDetails)
                          }
                          className="sidebar-settings-menu-item sidebar-settings-route"
                          onClick={() => handleSelect(item.id)}
                          role="menuitem"
                          leadingIcon={item.icon}
                        >
                          {item.label}
                        </MenuItem>
                      ))}
                    </div>
                  </div>

                  <MenuItem
                    data-testid="nav-settings"
                    active={navItem === DESKTOP_ROUTES.settings}
                    className="sidebar-settings-menu-item sidebar-settings-route"
                    onClick={() => handleSelect(DESKTOP_ROUTES.settings)}
                    role="menuitem"
                    leadingIcon={<IconSettings />}
                  >
                    Settings
                  </MenuItem>

                  <MenuItem
                    data-testid="logout-btn"
                    className="sidebar-settings-menu-item sidebar-settings-route logout-link"
                    color="danger"
                    onClick={() => {
                      updateSettingsMenuOpen(false)
                      setMobileMenuOpen(false)
                      setDataSubmenuOpen(false)
                      onLogout()
                    }}
                    disabled={busy}
                    role="menuitem"
                    leadingIcon={
                      <svg
                        className="logout-icon"
                        width="16"
                        height="16"
                        viewBox="0 0 16 16"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                        aria-hidden="true"
                      >
                        <path
                          d="M5.5 3H10.5C11.3284 3 12 3.67157 12 4.5V11.5C12 12.3284 11.3284 13 10.5 13H5.5"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <path
                          d="M8 8L12 8"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <path
                          d="M6.5 6L4 8L6.5 10"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    }
                  >
                    Logout
                  </MenuItem>
                </div>
              )}
            </div>
          </div>
        </div>
      </aside>
      {pendingDeleteSession ? (
        <ConfirmDialog
          title="Delete session?"
          body={
            <>
              Delete <strong>{pendingDeleteSession.title}</strong>? Messages cannot be recovered.
            </>
          }
          confirmLabel="Delete"
          tone="danger"
          onCancel={() => setPendingDeleteSession(null)}
          onConfirm={() => {
            void onDeleteChatForAgent(pendingDeleteSession.agentRef, pendingDeleteSession.chatId)
            setPendingDeleteSession(null)
          }}
        />
      ) : null}
    </>
  )
}
