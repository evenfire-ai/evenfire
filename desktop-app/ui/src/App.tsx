import React from 'react'
import {
  AgentActivityProvider,
  AgentChatProviders,
  AuthContext,
  DesktopStateProvider,
  McpRuntimeProvider,
  NavigationContext,
  NotificationsContext,
  WorkspaceActionsProvider,
} from '@contexts/index'
import { AppHeader } from '@components/AppHeader'
import { BootSplash } from '@components/BootSplash'
import { Button, ToastStack } from '@components/Common'
import { ConfirmDialog } from '@components/ConfirmDialog'
import { SidebarNav } from '@components/SidebarNav'
import { DESKTOP_ROUTES, SIDEBAR_COLLAPSED_KEY } from '@constants/navigation'
import { THEME_STORAGE_KEY } from '@constants/theme'
import { useAgentChatActionsValue } from '@hooks/useAgentChatActionsValue'
import { useAppController } from '@hooks/useAppController'
import {
  canProcessSandboxUiDeepLinks,
  resolveSandboxUiDeepLinkApp,
  toActiveSandboxUiApps,
} from '@lib/sandboxUiAppSelection'
import {
  getConversationOriginForAppLaunch,
  getConversationOriginForNavigation,
} from '@lib/sandboxUiConversationOrigin'
import { AgentsPage } from '@pages/AgentsPage'
import { AuthPage } from '@pages/AuthPage'
import { ChatPage } from '@pages/ChatPage'
import { ContextDetailsPage } from '@pages/ContextDetailsPage'
import { ContextsPage } from '@pages/ContextsPage'
import { FilesPage } from '@pages/FilesPage'
import { McpServersPage } from '@pages/McpServersPage'
import { SandboxUiPage } from '@pages/SandboxUiPage'
import type { SandboxUiConversationOrigin } from '@pages/SandboxUiPage.types'
import { SettingsPage } from '@pages/SettingsPage'
import { TeamDetailsPage } from '@pages/TeamDetailsPage'
import { TeamsPage } from '@pages/TeamsPage'
import { UnavailablePage } from '@pages/UnavailablePage'
import { WorkflowsPage } from '@pages/WorkflowsPage'
import type { PendingSandboxUiDeepLink, SandboxUiDeepLinkEnvelope } from '@/App.types'
import type { ActiveSandboxUiApp, NavItem, ThemeMode } from '@/uiTypes'

function getInitialThemeMode(): ThemeMode {
  if (typeof window === 'undefined') return 'dark'
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (saved === 'dark' || saved === 'light') return saved
  } catch {
    // Ignore storage failures in restricted environments.
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function getInitialSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function DesktopUpdateRequiredDialog({
  currentVersion,
  latestVersion,
  onDownload,
}: {
  currentVersion: string
  latestVersion: string
  onDownload: () => void
}) {
  const titleId = React.useId()
  const descriptionId = React.useId()
  const detailsId = React.useId()
  const [detailsOpen, setDetailsOpen] = React.useState(false)

  return (
    <div className="desktop-update-dialog-backdrop" role="presentation">
      <section
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="desktop-update-dialog"
        role="dialog"
      >
        <h3 id={titleId}>Desktop update required</h3>
        <div className="desktop-update-dialog__body" id={descriptionId}>
          <p>
            This workspace requires the latest version of Evenfire Desktop before you can continue.
          </p>
        </div>
        <div className="desktop-update-dialog__actions">
          <Button block onClick={onDownload}>
            Download update
          </Button>
        </div>
        <button
          type="button"
          className="desktop-update-dialog__more-info"
          aria-controls={detailsId}
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen(open => !open)}
        >
          {detailsOpen ? 'Hide info' : 'More info'}
        </button>
        {detailsOpen ? (
          <dl className="desktop-update-dialog__versions" id={detailsId}>
            <div>
              <dt>Installed</dt>
              <dd>{currentVersion}</dd>
            </div>
            <div>
              <dt>Latest</dt>
              <dd>{latestVersion}</dd>
            </div>
          </dl>
        ) : null}
      </section>
    </div>
  )
}

export function App() {
  const vm = useAppController()
  const [themeMode, setThemeMode] = React.useState<ThemeMode>(getInitialThemeMode)
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState<boolean>(
    getInitialSidebarCollapsed
  )
  const [activeSandboxUiApp, setActiveSandboxUiApp] = React.useState<ActiveSandboxUiApp | null>(
    null
  )
  const [sandboxUiConversationOrigin, setSandboxUiConversationOrigin] =
    React.useState<SandboxUiConversationOrigin | null>(null)
  const [sidebarSettingsMenuOpen, setSidebarSettingsMenuOpen] = React.useState(false)
  const [headerShellOverlayOpen, setHeaderShellOverlayOpen] = React.useState(false)
  const [headerNotificationTrayOpen, setHeaderNotificationTrayOpen] = React.useState(false)
  const [notificationDrawerReady, setNotificationDrawerReady] = React.useState(false)
  const [availableSandboxUiApps, setAvailableSandboxUiApps] = React.useState<ActiveSandboxUiApp[]>(
    []
  )
  const [sandboxUiShortcutOpenRequestId, setSandboxUiShortcutOpenRequestId] = React.useState(0)
  const [pendingSandboxUiDeepLinks, setPendingSandboxUiDeepLinks] = React.useState<
    PendingSandboxUiDeepLink[]
  >([])
  const contentPanelRef = React.useRef<HTMLElement | null>(null)
  const activeConversationOriginRef = React.useRef<SandboxUiConversationOrigin | null>(null)
  const processingSandboxUiDeepLinkIdRef = React.useRef<number | null>(null)
  const isAgentChatView =
    (vm.navItem === DESKTOP_ROUTES.agents && Boolean(vm.selectedAgent)) ||
    (vm.navItem === DESKTOP_ROUTES.chat && Boolean(vm.selectedAgent))
  const notificationTrayUsesDrawer = Boolean(activeSandboxUiApp)
  const appNotificationDrawerOpen = notificationTrayUsesDrawer && headerNotificationTrayOpen
  const activeConversationOrigin = React.useMemo<SandboxUiConversationOrigin | null>(() => {
    if (vm.navItem !== DESKTOP_ROUTES.chat || !vm.selectedAgent || !vm.activeChatId) {
      return null
    }
    const conversation =
      vm.chatList.find(chat => chat.id === vm.activeChatId) ??
      vm.latestChatSessions.find(
        chat => chat.agentRef === vm.selectedAgent && chat.id === vm.activeChatId
      )
    return {
      agentName: vm.selectedAgent,
      chatId: vm.activeChatId,
      title: conversation?.title.trim() || 'Conversation',
      teamId: vm.currentTeamId || undefined,
    }
  }, [
    vm.activeChatId,
    vm.chatList,
    vm.currentTeamId,
    vm.latestChatSessions,
    vm.navItem,
    vm.selectedAgent,
  ])
  activeConversationOriginRef.current = activeConversationOrigin

  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', themeMode)
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themeMode)
    } catch {
      // Ignore storage failures in restricted environments.
    }
  }, [themeMode])

  React.useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0')
    } catch {
      // Ignore storage failures in restricted environments.
    }
  }, [sidebarCollapsed])

  React.useEffect(() => {
    if (!vm.isAuthenticated) {
      setAvailableSandboxUiApps([])
      setActiveSandboxUiApp(null)
      setSandboxUiConversationOrigin(null)
      setPendingSandboxUiDeepLinks(current =>
        current.map(item =>
          item.conversationOrigin ? { ...item, conversationOrigin: null } : item
        )
      )
      return
    }

    let cancelled = false
    const load = async (clearOnError: boolean) => {
      try {
        const result = await window.clerum.sandboxUi.listApps()
        if (!cancelled) setAvailableSandboxUiApps(toActiveSandboxUiApps(result.apps))
      } catch {
        if (!cancelled && clearOnError) setAvailableSandboxUiApps([])
      }
    }
    const refreshKeepingCurrentList = () => {
      void load(false)
    }

    void load(true)
    window.addEventListener('focus', refreshKeepingCurrentList)
    const intervalId = window.setInterval(refreshKeepingCurrentList, 30_000)
    return () => {
      cancelled = true
      window.removeEventListener('focus', refreshKeepingCurrentList)
      window.clearInterval(intervalId)
    }
  }, [vm.currentTeamId, vm.isAuthenticated])

  const handleSandboxUiOpening = React.useCallback((app: ActiveSandboxUiApp) => {
    setActiveSandboxUiApp(app)
  }, [])

  const handleSandboxUiClosed = React.useCallback(() => {
    setActiveSandboxUiApp(null)
    setSandboxUiConversationOrigin(null)
    setHeaderShellOverlayOpen(false)
    setSidebarSettingsMenuOpen(false)
  }, [])

  const handleSandboxUiRemoved = React.useCallback(() => {
    setActiveSandboxUiApp(null)
    setSandboxUiConversationOrigin(null)
    setHeaderShellOverlayOpen(false)
    setSidebarSettingsMenuOpen(false)
  }, [])

  const handleSandboxUiBackToConversation = React.useCallback(async () => {
    if (!sandboxUiConversationOrigin) return
    const origin = sandboxUiConversationOrigin
    try {
      if (origin.teamId && origin.teamId !== vm.currentTeamId) {
        await vm.handleEnsureTeamContext({ teamId: origin.teamId })
      }
      setActiveSandboxUiApp(null)
      setSandboxUiConversationOrigin(null)
      setHeaderShellOverlayOpen(false)
      setSidebarSettingsMenuOpen(false)
      vm.handleSelectChatAgent(origin.agentName, {
        selectLatest: false,
        chatId: origin.chatId,
        title: origin.title,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      vm.pushToast(`Could not return to the conversation: ${message}`, 'error')
    }
  }, [
    sandboxUiConversationOrigin,
    vm.currentTeamId,
    vm.handleEnsureTeamContext,
    vm.handleSelectChatAgent,
    vm.pushToast,
  ])

  React.useEffect(() => {
    setNotificationDrawerReady(false)
  }, [activeSandboxUiApp?.appRef, headerNotificationTrayOpen])

  const handleSandboxUiBoundsApplied = React.useCallback(() => {
    if (appNotificationDrawerOpen) setNotificationDrawerReady(true)
  }, [appNotificationDrawerOpen])

  const launchSandboxUiApp = React.useCallback(
    (app: ActiveSandboxUiApp, conversationOrigin: SandboxUiConversationOrigin | null) => {
      setSandboxUiConversationOrigin(conversationOrigin)
      setActiveSandboxUiApp(app)
      vm.handleNavSelect(DESKTOP_ROUTES.apps)
      setSandboxUiShortcutOpenRequestId(value => value + 1)
    },
    [vm.handleNavSelect]
  )

  const handleSidebarNavSelect = React.useCallback(
    (item: NavItem) => {
      setSandboxUiConversationOrigin(
        getConversationOriginForNavigation(item, activeConversationOrigin)
      )
      vm.handleNavSelect(item)
    },
    [activeConversationOrigin, vm.handleNavSelect]
  )

  const handleOpenSandboxUiApp = React.useCallback(
    (app: ActiveSandboxUiApp) => {
      const conversationOrigin = getConversationOriginForAppLaunch(
        vm.navItem,
        activeConversationOrigin,
        sandboxUiConversationOrigin
      )
      launchSandboxUiApp(app, conversationOrigin)
    },
    [activeConversationOrigin, launchSandboxUiApp, sandboxUiConversationOrigin, vm.navItem]
  )

  React.useEffect(() => {
    const enqueue = (link: SandboxUiDeepLinkEnvelope) => {
      setPendingSandboxUiDeepLinks(current => {
        if (current.some(item => item.link.id === link.id)) return current
        return [
          ...current,
          {
            link,
            conversationOrigin: activeConversationOriginRef.current,
          },
        ]
      })
    }
    const unsubscribe = window.clerum.sandboxUi.onDeepLink(enqueue)
    void window.clerum.sandboxUi
      .listPendingDeepLinks()
      .then(result => result.links.forEach(enqueue))
      .catch(() => undefined)
    return unsubscribe
  }, [])

  React.useEffect(() => {
    if (
      !canProcessSandboxUiDeepLinks(
        vm.booting,
        vm.isAuthenticated,
        pendingSandboxUiDeepLinks.length
      )
    ) {
      return
    }
    const pending = pendingSandboxUiDeepLinks[0]
    if (!pending || processingSandboxUiDeepLinkIdRef.current !== null) return
    processingSandboxUiDeepLinkIdRef.current = pending.link.id

    void (async () => {
      try {
        if (pending.link.teamId && pending.link.teamId !== vm.currentTeamId) {
          await vm.handleEnsureTeamContext({ teamId: pending.link.teamId })
        }
        const result = await window.clerum.sandboxUi.listApps()
        const availableApps = toActiveSandboxUiApps(result.apps)
        setAvailableSandboxUiApps(availableApps)
        const resolution = resolveSandboxUiDeepLinkApp(result.apps, pending.link.appRef)
        if (resolution.status === 'unavailable') {
          throw new Error("You don't have access to this app in the linked team")
        }
        if (resolution.status === 'starting') {
          throw new Error(
            `${resolution.label} is still starting up. Try this link again in a moment`
          )
        }
        launchSandboxUiApp(
          {
            ...resolution.app,
            routePath: pending.link.path,
          },
          pending.conversationOrigin
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        vm.pushToast(`Could not open app link: ${message}`, 'error')
      } finally {
        await window.clerum.sandboxUi.acknowledgeDeepLink(pending.link.id).catch(() => undefined)
        setPendingSandboxUiDeepLinks(current =>
          current.filter(item => item.link.id !== pending.link.id)
        )
        processingSandboxUiDeepLinkIdRef.current = null
      }
    })()
  }, [
    launchSandboxUiApp,
    pendingSandboxUiDeepLinks,
    vm.booting,
    vm.currentTeamId,
    vm.handleEnsureTeamContext,
    vm.isAuthenticated,
    vm.pushToast,
  ])

  React.useEffect(() => {
    const handleNewChatShortcut = (event: KeyboardEvent) => {
      const isNewChatShortcut =
        event.key.toLowerCase() === 'n' &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey

      if (!isNewChatShortcut || event.repeat || event.defaultPrevented) return

      event.preventDefault()
      if (activeSandboxUiApp) {
        setActiveSandboxUiApp(null)
        setSandboxUiConversationOrigin(null)
      }
      setHeaderShellOverlayOpen(false)
      setSidebarSettingsMenuOpen(false)

      if (vm.selectedAgent) {
        vm.handleSelectChatAgent(vm.selectedAgent, { selectLatest: false })
        return
      }

      vm.handleNavSelect(DESKTOP_ROUTES.chat)
    }

    window.addEventListener('keydown', handleNewChatShortcut)
    return () => window.removeEventListener('keydown', handleNewChatShortcut)
  }, [activeSandboxUiApp, vm.handleNavSelect, vm.handleSelectChatAgent, vm.selectedAgent])

  const sandboxUiBoundsRefreshKey = `${sidebarCollapsed ? 'collapsed' : 'expanded'}:${
    appNotificationDrawerOpen ? 'notification-drawer-open' : 'notification-drawer-closed'
  }`

  const authValue = React.useMemo(
    () => ({
      booting: vm.booting,
      busy: vm.busy,
      statusText: vm.statusText,
      statusTone: vm.statusTone,
      isAuthenticated: vm.isAuthenticated,
      me: vm.me,
      email: vm.email,
      password: vm.password,
      desktopSetupAuthorizationToken: vm.desktopSetupAuthorizationToken,
      desktopSetupStarted: vm.desktopSetupStarted,
      desktopEnvironmentSetupComplete: vm.desktopEnvironmentSetupComplete,
      runtimeConfigSetupName: vm.runtimeConfigSetupName,
      runtimeConfigSetupExternalRestApiBaseUrl: vm.runtimeConfigSetupExternalRestApiBaseUrl,
      runtimeConfigSetupRpcProxyBaseUrl: vm.runtimeConfigSetupRpcProxyBaseUrl,
      authTransitioning: vm.authTransitioning,
      runtimeConfigState: vm.runtimeConfigState,
      desktopReleaseStatus: vm.desktopReleaseStatus,
      pendingDesktopEnvironmentSetup: vm.pendingDesktopEnvironmentSetup,
      runtimeConfigMissing: vm.runtimeConfigMissing,
      showRuntimeConfigSelector: vm.showRuntimeConfigSelector,
      dependencyHealth: vm.dependencyHealth,
      hasDependencyOutage: vm.hasDependencyOutage,
      setBooting: vm.setBooting,
      setEmail: vm.setEmail,
      setPassword: vm.setPassword,
      setDesktopSetupAuthorizationToken: vm.setDesktopSetupAuthorizationToken,
      setDesktopEnvironmentSetupComplete: vm.setDesktopEnvironmentSetupComplete,
      setPendingDesktopEnvironmentSetup: vm.setPendingDesktopEnvironmentSetup,
      setRuntimeConfigSetupName: vm.setRuntimeConfigSetupName,
      setRuntimeConfigSetupExternalRestApiBaseUrl: vm.setRuntimeConfigSetupExternalRestApiBaseUrl,
      setRuntimeConfigSetupRpcProxyBaseUrl: vm.setRuntimeConfigSetupRpcProxyBaseUrl,
      setStatus: vm.setStatus,
      loadSession: vm.loadSession,
      handlePasswordLogin: vm.handlePasswordLogin,
      handleStartDesktopSetup: vm.handleStartDesktopSetup,
      handleCompleteDesktopSetup: vm.handleCompleteDesktopSetup,
      handleSaveRuntimeConfig: vm.handleSaveRuntimeConfig,
      handleDeleteRuntimeConfig: vm.handleDeleteRuntimeConfig,
      handleSelectRuntimeConfig: vm.handleSelectRuntimeConfig,
      handleClearRuntimeConfigSelection: vm.handleClearRuntimeConfigSelection,
      handleCancelDesktopEnvironmentSetup: vm.handleCancelDesktopEnvironmentSetup,
      handleConfirmDesktopEnvironmentSetup: vm.handleConfirmDesktopEnvironmentSetup,
      handleOpenDesktopRelease: vm.handleOpenDesktopRelease,
      handleLogout: vm.handleLogout,
    }),
    [
      vm.authTransitioning,
      vm.booting,
      vm.busy,
      vm.dependencyHealth,
      vm.desktopEnvironmentSetupComplete,
      vm.desktopReleaseStatus,
      vm.desktopSetupAuthorizationToken,
      vm.desktopSetupStarted,
      vm.email,
      vm.handleCancelDesktopEnvironmentSetup,
      vm.handleCompleteDesktopSetup,
      vm.handleConfirmDesktopEnvironmentSetup,
      vm.handleDeleteRuntimeConfig,
      vm.handleClearRuntimeConfigSelection,
      vm.handleLogout,
      vm.handleOpenDesktopRelease,
      vm.handlePasswordLogin,
      vm.handleSaveRuntimeConfig,
      vm.handleSelectRuntimeConfig,
      vm.handleStartDesktopSetup,
      vm.hasDependencyOutage,
      vm.isAuthenticated,
      vm.loadSession,
      vm.me,
      vm.password,
      vm.pendingDesktopEnvironmentSetup,
      vm.runtimeConfigMissing,
      vm.runtimeConfigSetupExternalRestApiBaseUrl,
      vm.runtimeConfigSetupName,
      vm.runtimeConfigSetupRpcProxyBaseUrl,
      vm.runtimeConfigState,
      vm.setBooting,
      vm.setDesktopSetupAuthorizationToken,
      vm.setDesktopEnvironmentSetupComplete,
      vm.setEmail,
      vm.setPassword,
      vm.setPendingDesktopEnvironmentSetup,
      vm.setRuntimeConfigSetupExternalRestApiBaseUrl,
      vm.setRuntimeConfigSetupName,
      vm.setRuntimeConfigSetupRpcProxyBaseUrl,
      vm.setStatus,
      vm.showRuntimeConfigSelector,
      vm.statusText,
      vm.statusTone,
    ]
  )

  const navValue = React.useMemo(
    () => ({
      navItem: vm.navItem,
      selectedAgent: vm.selectedAgent,
      selectedAgentRoute: vm.selectedAgentRoute,
      selectedContext: vm.selectedContext,
      selectedTeam: vm.selectedTeam,
      handleNavSelect: vm.handleNavSelect,
      handleOpenAgentWorkspace: vm.handleOpenAgentWorkspace,
      handleSelectChatAgent: vm.handleSelectChatAgent,
      handleBackToAgents: vm.handleBackToAgents,
      handleOpenContextDetails: vm.handleOpenContextDetails,
      handleBackToContexts: vm.handleBackToContexts,
      handleOpenTeamDetails: vm.handleOpenTeamDetails,
      handleBackToTeams: vm.handleBackToTeams,
    }),
    [
      vm.handleBackToAgents,
      vm.handleBackToContexts,
      vm.handleBackToTeams,
      vm.handleNavSelect,
      vm.handleOpenAgentWorkspace,
      vm.handleOpenContextDetails,
      vm.handleOpenTeamDetails,
      vm.handleSelectChatAgent,
      vm.navItem,
      vm.selectedAgent,
      vm.selectedAgentRoute,
      vm.selectedContext,
      vm.selectedTeam,
    ]
  )

  const notifValue = React.useMemo(
    () => ({
      notifications: vm.notifications,
      unreadNotificationCount: vm.unreadNotificationCount,
      notificationActionById: vm.notificationActionById,
      pendingApprovals: vm.pendingApprovals,
      pendingApprovalsLoading: vm.pendingApprovalsLoading,
      pendingApprovalActionId: vm.pendingApprovalActionId,
      toasts: vm.toasts,
      markNotificationsRead: vm.markNotificationsRead,
      clearNotifications: vm.clearNotifications,
      removeNotification: vm.removeNotification,
      resolveApprovalNotification: vm.resolveApprovalNotification,
      decideApproval: vm.decideApproval,
      handleOpenNotification: vm.handleOpenNotification,
      handleApproveNotification: vm.handleApproveNotification,
      handleDenyNotification: vm.handleDenyNotification,
      handleRefreshPendingApprovals: vm.handleRefreshPendingApprovals,
      handleDecidePendingApproval: vm.handleDecidePendingApproval,
    }),
    [
      vm.clearNotifications,
      vm.decideApproval,
      vm.handleApproveNotification,
      vm.handleDecidePendingApproval,
      vm.handleDenyNotification,
      vm.handleOpenNotification,
      vm.handleRefreshPendingApprovals,
      vm.markNotificationsRead,
      vm.notificationActionById,
      vm.notifications,
      vm.pendingApprovalActionId,
      vm.pendingApprovals,
      vm.pendingApprovalsLoading,
      vm.removeNotification,
      vm.resolveApprovalNotification,
      vm.toasts,
      vm.unreadNotificationCount,
    ]
  )

  const agentActivityValue = React.useMemo(
    () => ({
      agentLastActiveByAgent: vm.agentLastActiveByAgent,
      selectedAgentActivitySummary: vm.selectedAgentActivitySummary,
    }),
    [vm.agentLastActiveByAgent, vm.selectedAgentActivitySummary]
  )

  // AgentChatContext was split into four cohesive contexts so a change to one
  // slice only re-renders its consumers. Each value memo lists only its own
  // fields, so e.g. a streaming progress tick (thread state) never re-renders the
  // composer/sidebar/workspace/fleet board. The actions value wraps every handler
  // in a stable callback, so it never changes identity — action-only consumers
  // (FleetBoard) stay inert even when a handler's closure deps change.
  const agentChatActionsValue = useAgentChatActionsValue(vm)

  const chatListValue = React.useMemo(
    () => ({
      activeChatId: vm.activeChatId,
      chatList: vm.chatList,
      chatListLoading: vm.chatListLoading,
      latestChatSessions: vm.latestChatSessions,
      latestChatSessionsLoading: vm.latestChatSessionsLoading,
      sessionStateByChatId: vm.sessionStateByChatId,
      sessionStateByChatKey: vm.sessionStateByChatKey,
    }),
    [
      vm.activeChatId,
      vm.chatList,
      vm.chatListLoading,
      vm.latestChatSessions,
      vm.latestChatSessionsLoading,
      vm.sessionStateByChatId,
      vm.sessionStateByChatKey,
    ]
  )

  const chatComposerStateValue = React.useMemo(
    () => ({
      activeChatId: vm.activeChatId,
      composerImageAttachments: vm.composerImageAttachments,
      composerReferenceAttachments: vm.composerReferenceAttachments,
      agentSending: vm.agentSending,
      agentError: vm.agentError,
      failedAgentSend: vm.failedAgentSend,
      activeMessageCount: vm.activeMessages.length,
    }),
    [
      vm.activeChatId,
      vm.composerImageAttachments,
      vm.composerReferenceAttachments,
      vm.agentSending,
      vm.agentError,
      vm.failedAgentSend,
      vm.activeMessages.length,
    ]
  )

  const chatThreadStateValue = React.useMemo(
    () => ({
      activeChatId: vm.activeChatId,
      activeMessages: vm.activeMessages,
      groupedMessages: vm.groupedMessages,
      chatMessagesLoading: vm.chatMessagesLoading,
      activityByMessageId: vm.activityByMessageId,
      progressByMessageId: vm.progressByMessageId,
    }),
    [
      vm.activeChatId,
      vm.activeMessages,
      vm.groupedMessages,
      vm.chatMessagesLoading,
      vm.activityByMessageId,
      vm.progressByMessageId,
    ]
  )

  const mcpRuntimeValue = React.useMemo(
    () => ({
      hostRuntimeStatus: vm.hostRuntimeStatus,
      hostRuntimeLoading: vm.hostRuntimeLoading,
      hostRuntimeError: vm.hostRuntimeError,
      hostRuntimeLastUpdatedAt: vm.hostRuntimeLastUpdatedAt,
      hostRuntimeIsStale: vm.hostRuntimeIsStale,
      activeLlmModel: vm.activeLlmModel,
      activeLlmProvider: vm.activeLlmProvider,
      mcpHealthRefreshing: vm.mcpHealthRefreshing,
      handleRefreshMcpHealth: vm.handleRefreshMcpHealth,
      cancelTask: vm.cancelTask,
    }),
    [
      vm.activeLlmModel,
      vm.activeLlmProvider,
      vm.cancelTask,
      vm.handleRefreshMcpHealth,
      vm.hostRuntimeError,
      vm.hostRuntimeIsStale,
      vm.hostRuntimeLastUpdatedAt,
      vm.hostRuntimeLoading,
      vm.hostRuntimeStatus,
      vm.mcpHealthRefreshing,
    ]
  )

  const desktopStateValue = React.useMemo(
    () => ({
      desktopStatus: vm.desktopStatus,
      desktopError: vm.desktopError,
      desktopAvailable: vm.desktopAvailable,
      handleOpenDesktop: vm.handleOpenDesktop,
    }),
    [vm.desktopAvailable, vm.desktopError, vm.desktopStatus, vm.handleOpenDesktop]
  )

  const workspaceActionsValue = React.useMemo(
    () => ({
      handleRefreshWorkspaceData: vm.handleRefreshWorkspaceData,
    }),
    [vm.handleRefreshWorkspaceData]
  )
  const environmentSetupSuccessDialog = vm.desktopEnvironmentSetupComplete ? (
    <ConfirmDialog
      title="Environment saved"
      body={<p>The desktop environment is ready to use from the login selector.</p>}
      cancelLabel="Close"
      confirmLabel="OK"
      onCancel={() => vm.setDesktopEnvironmentSetupComplete(false)}
      onConfirm={() => vm.setDesktopEnvironmentSetupComplete(false)}
      tone="primary"
    />
  ) : null
  const pendingEnvironmentHost = vm.pendingDesktopEnvironmentSetup
    ? (() => {
        try {
          return new URL(vm.pendingDesktopEnvironmentSetup.externalRestApiBaseUrl).host
        } catch {
          return vm.pendingDesktopEnvironmentSetup.externalRestApiBaseUrl
        }
      })()
    : ''
  const environmentSetupConfirmationDialog = vm.pendingDesktopEnvironmentSetup ? (
    <ConfirmDialog
      title="Add desktop environment?"
      body={
        <>
          <p>
            Profile UI is asking this desktop app to use{' '}
            <strong>{vm.pendingDesktopEnvironmentSetup.appName || 'Evenfire'}</strong>.
          </p>
          <p>Only continue if you trust this External REST API host:</p>
          <p className="auth-environment-confirm-url">
            {vm.pendingDesktopEnvironmentSetup.externalRestApiBaseUrl}
          </p>
          {pendingEnvironmentHost ? <p className="muted">Host: {pendingEnvironmentHost}</p> : null}
        </>
      }
      cancelLabel="Cancel"
      confirmLabel="Add environment"
      onCancel={vm.handleCancelDesktopEnvironmentSetup}
      onConfirm={() => void vm.handleConfirmDesktopEnvironmentSetup()}
      tone="primary"
    />
  ) : null
  const desktopUpdateRequiredDialog =
    vm.isAuthenticated && vm.desktopReleaseStatus?.updateRequired ? (
      <DesktopUpdateRequiredDialog
        currentVersion={vm.desktopReleaseStatus.currentVersion}
        latestVersion={vm.desktopReleaseStatus.latestVersion}
        onDownload={vm.handleOpenDesktopRelease}
      />
    ) : null

  const bootSplashLoading = vm.booting || vm.initialExperienceLoading

  return (
    <AuthContext.Provider value={authValue}>
      <div className="app-root" inert={bootSplashLoading || undefined}>
        {vm.isAuthenticated ? (
          <NavigationContext.Provider value={navValue}>
            <NotificationsContext.Provider value={notifValue}>
              <WorkspaceActionsProvider value={workspaceActionsValue}>
                <AgentActivityProvider value={agentActivityValue}>
                  <AgentChatProviders
                    actions={agentChatActionsValue}
                    chatList={chatListValue}
                    composerState={chatComposerStateValue}
                    threadState={chatThreadStateValue}
                  >
                    <McpRuntimeProvider value={mcpRuntimeValue}>
                      <DesktopStateProvider value={desktopStateValue}>
                        <main className="app-shell">
                          <SidebarNav
                            navItem={
                              vm.navItem === DESKTOP_ROUTES.teamDetails
                                ? DESKTOP_ROUTES.teams
                                : vm.navItem === DESKTOP_ROUTES.contextDetails
                                  ? DESKTOP_ROUTES.contexts
                                  : vm.navItem
                            }
                            activeSandboxUiApp={activeSandboxUiApp}
                            availableSandboxUiApps={availableSandboxUiApps}
                            collapsed={sidebarCollapsed}
                            onCollapsedChange={setSidebarCollapsed}
                            onOpenSandboxUiApp={handleOpenSandboxUiApp}
                            onSettingsMenuOpenChange={setSidebarSettingsMenuOpen}
                            onSelect={handleSidebarNavSelect}
                          />
                          <section className="workspace-layout">
                            <section
                              ref={contentPanelRef}
                              className={`content-panel glass-card${
                                isAgentChatView ? ' content-panel--agent-chat' : ''
                              }${vm.navItem === DESKTOP_ROUTES.settings ? ' content-panel--settings' : ''}${
                                appNotificationDrawerOpen
                                  ? ' content-panel--app-notification-drawer-open'
                                  : ''
                              }`}
                            >
                              <AppHeader
                                notificationTrayMode={
                                  notificationTrayUsesDrawer ? 'drawer' : 'overlay'
                                }
                                notificationTrayReady={notificationDrawerReady}
                                onNotificationTrayOpenChange={setHeaderNotificationTrayOpen}
                                onShellOverlayOpenChange={setHeaderShellOverlayOpen}
                              />
                              <ToastStack items={vm.toasts} />
                              {vm.navItem === DESKTOP_ROUTES.chat && (
                                <ChatPage scrollContainerRef={contentPanelRef} />
                              )}
                              {vm.navItem === DESKTOP_ROUTES.agents && (
                                <AgentsPage scrollContainerRef={contentPanelRef} />
                              )}
                              {vm.navItem === DESKTOP_ROUTES.contexts && <ContextsPage />}
                              {vm.navItem === DESKTOP_ROUTES.files && (
                                <FilesPage pushToast={vm.pushToast} />
                              )}
                              {vm.navItem === DESKTOP_ROUTES.connectors && <McpServersPage />}
                              {vm.navItem === DESKTOP_ROUTES.contextDetails && (
                                <ContextDetailsPage />
                              )}
                              {vm.navItem === DESKTOP_ROUTES.plugins && <WorkflowsPage />}
                              {vm.navItem === DESKTOP_ROUTES.apps && (
                                <SandboxUiPage
                                  boundsRefreshKey={sandboxUiBoundsRefreshKey}
                                  conversationOrigin={sandboxUiConversationOrigin}
                                  currentTeamId={vm.currentTeamId}
                                  headerShellOverlayOpen={headerShellOverlayOpen}
                                  sidebarShellOverlayOpen={sidebarSettingsMenuOpen}
                                  toastShellOverlayOpen={vm.toasts.length > 0}
                                  shortcutApp={activeSandboxUiApp}
                                  shortcutOpenRequestId={sandboxUiShortcutOpenRequestId}
                                  onBackToConversation={handleSandboxUiBackToConversation}
                                  onEmbeddedAppOpening={handleSandboxUiOpening}
                                  onEmbeddedAppBack={handleSandboxUiClosed}
                                  onEmbeddedAppRemoved={handleSandboxUiRemoved}
                                  onEmbedBoundsApplied={handleSandboxUiBoundsApplied}
                                  onNotify={vm.pushToast}
                                />
                              )}
                              {vm.navItem === DESKTOP_ROUTES.settings && (
                                <SettingsPage
                                  notificationSettings={vm.notificationSettings}
                                  desktopNotificationPermission={vm.desktopNotificationPermission}
                                  themeMode={themeMode}
                                  onNotify={vm.pushToast}
                                  onThemeModeChange={setThemeMode}
                                  onNotificationSoundVolumeChange={vm.setNotificationSoundVolume}
                                  onPlayNotificationSoundPreview={vm.playNotificationSoundPreview}
                                  onSaveNotificationSettings={vm.saveNotificationSettings}
                                  channelNotificationPreferences={vm.channelNotificationPreferences}
                                  channelNotificationPreferencesLoading={
                                    vm.channelNotificationPreferencesLoading
                                  }
                                  channelNotificationPreferencesSaving={
                                    vm.channelNotificationPreferencesSaving
                                  }
                                  onSaveChannelNotificationPreferences={
                                    vm.saveChannelNotificationPreferences
                                  }
                                />
                              )}
                              {vm.navItem === DESKTOP_ROUTES.teams && <TeamsPage />}
                              {vm.navItem === DESKTOP_ROUTES.teamDetails && <TeamDetailsPage />}
                            </section>
                          </section>
                        </main>
                        {desktopUpdateRequiredDialog}
                        {environmentSetupConfirmationDialog}
                        {environmentSetupSuccessDialog}
                      </DesktopStateProvider>
                    </McpRuntimeProvider>
                  </AgentChatProviders>
                </AgentActivityProvider>
              </WorkspaceActionsProvider>
            </NotificationsContext.Provider>
          </NavigationContext.Provider>
        ) : (
          <>
            {vm.hasDependencyOutage ? <UnavailablePage /> : <AuthPage />}
            {environmentSetupConfirmationDialog}
            {environmentSetupSuccessDialog}
            <ToastStack items={vm.toasts} />
          </>
        )}
      </div>
      <BootSplash loading={bootSplashLoading} />
    </AuthContext.Provider>
  )
}
