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
import { GfsImagePreview } from '@components/GfsImagePreview'
import { PluginConsentModal } from '@components/PluginConsentModal'
import type { PluginConsentRequest } from '@components/PluginConsentModal/types'
import { SidebarNav } from '@components/SidebarNav'
import { DESKTOP_ROUTES, SIDEBAR_COLLAPSED_KEY } from '@constants/navigation'
import { THEME_STORAGE_KEY } from '@constants/theme'
import { useAgentChatActionsValue } from '@hooks/useAgentChatActionsValue'
import { useAppController } from '@hooks/useAppController'
import { gfsImagePreviewMimeType } from '@lib/gfsImagePreview'
import {
  canProcessSandboxUiDeepLinks,
  resolveSandboxUiDeepLinkApp,
  toActiveSandboxUiApps,
} from '@lib/sandboxUiAppSelection'
import {
  getConversationOriginForAppLaunch,
  getConversationOriginForNavigation,
} from '@lib/sandboxUiConversationOrigin'
import {
  MAX_SANDBOX_UI_DEEP_LINK_RETRY_ATTEMPTS,
  confirmPendingSandboxUiDeepLink,
  deferPendingSandboxUiDeepLink,
  enqueuePendingSandboxUiDeepLink,
  failPendingSandboxUiDeepLink,
  isPendingSandboxUiDeepLinkAwaitingConfirmation,
  isPendingSandboxUiDeepLinkStale,
  removePendingSandboxUiDeepLink,
  resetPendingSandboxUiDeepLinkFailure,
  shouldPurgeSandboxUiDeepLinks,
} from '@lib/sandboxUiDeepLinkState'
import { AgentsPage } from '@pages/AgentsPage'
import { AuthPage } from '@pages/AuthPage'
import { ChatPage } from '@pages/ChatPage'
import { ContextDetailsPage } from '@pages/ContextDetailsPage'
import { ContextsPage } from '@pages/ContextsPage'
import { FilesPage } from '@pages/FilesPage'
import { McpServersPage } from '@pages/McpServersPage'
import { SandboxUiPage } from '@pages/SandboxUiPage'
import type {
  SandboxUiConversationOrigin,
  SandboxUiShortcutOpenResult,
} from '@pages/SandboxUiPage.types'
import { SettingsPage } from '@pages/SettingsPage'
import { TeamDetailsPage } from '@pages/TeamDetailsPage'
import { TeamsPage } from '@pages/TeamsPage'
import { UnavailablePage } from '@pages/UnavailablePage'
import { WorkflowsPage } from '@pages/WorkflowsPage'
import type { PendingSandboxUiDeepLink, SandboxUiDeepLinkEnvelope } from '@/App.types'
import type { ActiveSandboxUiApp, NavItem, ThemeMode } from '@/uiTypes'

type PendingSandboxUiDeepLinkLaunch = {
  linkId: number
  requestId: number
  generation: number
  originalTeamId: string
  linkTeamId?: string
  switchedTeam: boolean
  conversationOrigin: SandboxUiConversationOrigin | null
}

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
  const [sandboxUiDeepLinkRetryTick, setSandboxUiDeepLinkRetryTick] = React.useState(0)
  const contentPanelRef = React.useRef<HTMLElement | null>(null)
  const activeConversationOriginRef = React.useRef<SandboxUiConversationOrigin | null>(null)
  const processingSandboxUiDeepLinkIdRef = React.useRef<number | null>(null)
  const launchingSandboxUiDeepLinkRef = React.useRef<PendingSandboxUiDeepLinkLaunch | null>(null)
  const pendingSandboxUiDeepLinksRef = React.useRef<PendingSandboxUiDeepLink[]>([])
  const sandboxUiDeepLinkIdentityRef = React.useRef<string | null | undefined>(undefined)
  const sandboxUiDeepLinkGenerationRef = React.useRef(0)
  const sandboxUiShortcutOpenRequestIdRef = React.useRef(0)
  const bootSplashLoading = vm.booting || vm.initialExperienceLoading
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

  /**
   * Plugin permission prompts (spec §9). Main hides the plugin's
   * `WebContentsView` before pushing the request and restores it once the user
   * answers, so the plugin can neither fake the prompt nor paint over it. The
   * prompt is centered over — and its backdrop scoped to — the plugin's embed
   * rect, not the whole window; the rest of the trusted app chrome stays visible.
   */
  const [pluginConsentPrompt, setPluginConsentPrompt] = React.useState<PluginConsentRequest | null>(
    null
  )

  React.useEffect(() => {
    const offRequested = window.clerum.pluginSdk?.onConsentRequested?.(request => {
      setPluginConsentPrompt(request)
    })
    const offCancelled = window.clerum.pluginSdk?.onConsentCancelled?.(({ promptId }) => {
      // Main withdrew the prompt (timeout, or the plugin was closed under it).
      setPluginConsentPrompt(current => (current?.promptId === promptId ? null : current))
    })
    return () => {
      offRequested?.()
      offCancelled?.()
    }
  }, [])

  /**
   * A plugin asked to show a shared file — either through `clerum.gfs.open()` or
   * by the user activating a `gfs://` link it rendered. Main has already
   * resolved it with the user's session, so this only decides where it goes:
   * images get a preview over the plugin, everything else hands off to Files.
   */
  const [pluginGfsPreview, setPluginGfsPreview] = React.useState<{
    gfsUri: string
    name: string
    bytes: number
    mimeType: string
  } | null>(null)
  const [pendingGfsUri, setPendingGfsUri] = React.useState<string | null>(null)

  React.useEffect(() => {
    const off = window.clerum.pluginSdk?.onOpenGfsResource?.(resource => {
      const mimeType = resource.kind === 'file' ? gfsImagePreviewMimeType(resource.name) : null
      if (mimeType) {
        // The embed's WebContentsView paints above renderer DOM, so it has to be
        // hidden for the overlay to be visible at all.
        void window.clerum.sandboxUi.setVisible(false).catch(() => undefined)
        setPluginGfsPreview({
          gfsUri: resource.gfsUri,
          name: resource.name,
          bytes: resource.bytes ?? 0,
          mimeType,
        })
        return
      }
      // Folders and non-previewable files belong in the full browser, where the
      // user gets breadcrumbs, download, and sharing.
      setPendingGfsUri(resource.gfsUri)
      vm.handleNavSelect(DESKTOP_ROUTES.files)
    })
    return () => off?.()
  }, [vm.handleNavSelect])

  const closePluginGfsPreview = React.useCallback(() => {
    setPluginGfsPreview(null)
    void window.clerum.sandboxUi.setVisible(true).catch(() => undefined)
  }, [])

  const resolvePluginConsent = React.useCallback((promptId: string, allowed: string[]) => {
    setPluginConsentPrompt(current => (current?.promptId === promptId ? null : current))
    void window.clerum.pluginSdk?.resolveConsent?.(promptId, allowed)?.catch?.(() => undefined)
  }, [])

  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', themeMode)
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themeMode)
    } catch {
      // Ignore storage failures in restricted environments.
    }
    // Mirror into the main process so `theme.read` and the `theme.changed`
    // event can answer for plugin embeds, which have no access to this
    // renderer's localStorage. The renderer stays the writer; main only keeps
    // the last value it was told.
    void window.clerum.pluginSdk?.setTheme?.(themeMode)?.catch?.(() => undefined)
  }, [themeMode])

  React.useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0')
    } catch {
      // Ignore storage failures in restricted environments.
    }
  }, [sidebarCollapsed])

  React.useEffect(() => {
    void window.clerum.app.rendererReady().catch(error => {
      console.warn('[Desktop] Could not signal renderer readiness:', error)
    })
  }, [])

  React.useEffect(() => {
    if (!vm.isAuthenticated) {
      setAvailableSandboxUiApps([])
      setActiveSandboxUiApp(null)
      setSandboxUiConversationOrigin(null)
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

  React.useEffect(() => {
    const identity = vm.authenticatedPrincipalIdentity
    const previousIdentity = sandboxUiDeepLinkIdentityRef.current
    sandboxUiDeepLinkIdentityRef.current = identity
    if (!shouldPurgeSandboxUiDeepLinks(previousIdentity, identity)) return

    pendingSandboxUiDeepLinksRef.current = []
    setPendingSandboxUiDeepLinks([])
    processingSandboxUiDeepLinkIdRef.current = null
    launchingSandboxUiDeepLinkRef.current = null
    sandboxUiDeepLinkGenerationRef.current += 1
    void window.clerum.sandboxUi.clearPendingDeepLinks().catch(error => {
      console.warn('[Desktop] Could not clear stale app deep links:', error)
    })
  }, [vm.authenticatedPrincipalIdentity])

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
    let refreshWarning: string | null = null
    try {
      if (origin.teamId && origin.teamId !== vm.getCurrentTeamId()) {
        await vm.handleEnsureTeamContext({ teamId: origin.teamId })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!origin.teamId || vm.getCurrentTeamId() !== origin.teamId) {
        vm.pushToast(`Could not return to the conversation: ${message}`, 'error')
        throw err
      }
      // The authoritative switch completed but its follow-up refresh failed.
      // Keep the page aligned with the live team and surface the refresh problem.
      refreshWarning = message
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
    if (refreshWarning) {
      vm.pushToast(
        `Returned to the conversation, but team data did not refresh: ${refreshWarning}`,
        'warn'
      )
    }
  }, [
    sandboxUiConversationOrigin,
    vm.getCurrentTeamId,
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
      const requestId = sandboxUiShortcutOpenRequestIdRef.current + 1
      sandboxUiShortcutOpenRequestIdRef.current = requestId
      setSandboxUiConversationOrigin(conversationOrigin)
      setActiveSandboxUiApp(app)
      vm.handleNavSelect(DESKTOP_ROUTES.apps)
      setSandboxUiShortcutOpenRequestId(requestId)
      return requestId
    },
    [vm.handleNavSelect]
  )

  const handleSidebarNavSelect = React.useCallback(
    (item: NavItem) => {
      setSandboxUiConversationOrigin(
        getConversationOriginForNavigation(
          item,
          activeConversationOrigin,
          sandboxUiConversationOrigin
        )
      )
      vm.handleNavSelect(item)
    },
    [activeConversationOrigin, sandboxUiConversationOrigin, vm.handleNavSelect]
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

  const setPendingSandboxUiDeepLinkState = React.useCallback((next: PendingSandboxUiDeepLink[]) => {
    pendingSandboxUiDeepLinksRef.current = next
    setPendingSandboxUiDeepLinks(next)
  }, [])

  const clearSandboxUiDeepLinkProcessing = React.useCallback((linkId?: number) => {
    if (linkId === undefined || processingSandboxUiDeepLinkIdRef.current === linkId) {
      processingSandboxUiDeepLinkIdRef.current = null
    }
    if (linkId === undefined || launchingSandboxUiDeepLinkRef.current?.linkId === linkId) {
      launchingSandboxUiDeepLinkRef.current = null
    }
  }, [])

  const acknowledgeSandboxUiDeepLink = React.useCallback(
    async (linkId: number) => {
      const next = removePendingSandboxUiDeepLink(pendingSandboxUiDeepLinksRef.current, linkId)
      setPendingSandboxUiDeepLinkState(next)
      clearSandboxUiDeepLinkProcessing(linkId)
      try {
        await window.clerum.sandboxUi.acknowledgeDeepLink(linkId)
      } catch (error) {
        console.warn('[Desktop] Could not acknowledge app deep link:', error)
      }
    },
    [clearSandboxUiDeepLinkProcessing, setPendingSandboxUiDeepLinkState]
  )

  const deferSandboxUiDeepLink = React.useCallback(
    (pending: PendingSandboxUiDeepLink, message: string, tone: 'info' | 'error' = 'error') => {
      clearSandboxUiDeepLinkProcessing(pending.link.id)
      if ((pending.retryCount ?? 0) >= MAX_SANDBOX_UI_DEEP_LINK_RETRY_ATTEMPTS) {
        const next = failPendingSandboxUiDeepLink(
          pendingSandboxUiDeepLinksRef.current,
          pending.link.id,
          message
        )
        setPendingSandboxUiDeepLinkState(next)
        vm.pushToast(`Could not open app link: ${message}`, 'error')
        return
      }
      const next = deferPendingSandboxUiDeepLink(
        pendingSandboxUiDeepLinksRef.current,
        pending.link.id,
        Date.now()
      )
      setPendingSandboxUiDeepLinkState(next)
      vm.pushToast(message, tone)
    },
    [clearSandboxUiDeepLinkProcessing, setPendingSandboxUiDeepLinkState, vm.pushToast]
  )

  const restoreSandboxUiDeepLinkTeam = React.useCallback(
    async (context: PendingSandboxUiDeepLinkLaunch) => {
      if (
        !context.switchedTeam ||
        !context.originalTeamId ||
        !context.linkTeamId ||
        vm.getCurrentTeamId() !== context.linkTeamId ||
        context.generation !== sandboxUiDeepLinkGenerationRef.current
      ) {
        return
      }
      try {
        await vm.handleEnsureTeamContext({ teamId: context.originalTeamId, announce: true })
        const origin = context.conversationOrigin
        if (origin && (!origin.teamId || origin.teamId === context.originalTeamId)) {
          vm.handleSelectChatAgent(origin.agentName, {
            selectLatest: false,
            chatId: origin.chatId,
            title: origin.title,
          })
        }
      } catch (rollbackError) {
        const message =
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        vm.pushToast(`Could not restore the previous team: ${message}`, 'error')
      }
    },
    [vm.getCurrentTeamId, vm.handleEnsureTeamContext, vm.handleSelectChatAgent, vm.pushToast]
  )

  const closeActiveSandboxUiEmbedForHandoff = React.useCallback(async () => {
    if (!activeSandboxUiApp) return
    await window.clerum.sandboxUi.close()
    handleSandboxUiClosed()
  }, [activeSandboxUiApp, handleSandboxUiClosed])

  React.useEffect(() => {
    const enqueue = (link: SandboxUiDeepLinkEnvelope) => {
      const next = enqueuePendingSandboxUiDeepLink(
        pendingSandboxUiDeepLinksRef.current,
        link,
        activeConversationOriginRef.current,
        sandboxUiDeepLinkIdentityRef.current ?? null
      )
      setPendingSandboxUiDeepLinkState(next)
    }
    const unsubscribe = window.clerum.sandboxUi.onDeepLink(enqueue)
    const listGeneration = sandboxUiDeepLinkGenerationRef.current
    void window.clerum.sandboxUi
      .listPendingDeepLinks()
      .then(result => {
        if (listGeneration !== sandboxUiDeepLinkGenerationRef.current) return
        result.links.forEach(enqueue)
      })
      .catch(() => undefined)
    return unsubscribe
  }, [setPendingSandboxUiDeepLinkState])

  React.useEffect(() => {
    if (
      !canProcessSandboxUiDeepLinks(
        bootSplashLoading,
        vm.isAuthenticated,
        pendingSandboxUiDeepLinks.length
      )
    ) {
      return
    }
    const currentIdentity = vm.authenticatedPrincipalIdentity
    if (!currentIdentity) return
    let stalePending: PendingSandboxUiDeepLink | null = null
    const now = Date.now()
    const pending = pendingSandboxUiDeepLinksRef.current.find(item => {
      if (isPendingSandboxUiDeepLinkStale(item, currentIdentity)) {
        stalePending = item
        return false
      }
      if (isPendingSandboxUiDeepLinkAwaitingConfirmation(item, currentIdentity)) return false
      if (item.failedMessage) return false
      if (item.nextRetryAt && item.nextRetryAt > now) return false
      return true
    })
    if (stalePending) {
      void acknowledgeSandboxUiDeepLink(stalePending.link.id)
      return
    }
    if (!pending || processingSandboxUiDeepLinkIdRef.current !== null) return
    processingSandboxUiDeepLinkIdRef.current = pending.link.id
    const processingGeneration = sandboxUiDeepLinkGenerationRef.current

    void (async () => {
      const originalTeamId = vm.getCurrentTeamId()
      let switchedTeam = false
      try {
        if (processingGeneration !== sandboxUiDeepLinkGenerationRef.current) return
        if (pending.link.teamId && pending.link.teamId !== vm.getCurrentTeamId()) {
          await closeActiveSandboxUiEmbedForHandoff()
          try {
            switchedTeam = await vm.handleEnsureTeamContext({
              teamId: pending.link.teamId,
              announce: true,
            })
          } catch (error) {
            switchedTeam =
              originalTeamId !== pending.link.teamId &&
              vm.getCurrentTeamId() === pending.link.teamId
            throw error
          }
        }
        if (processingGeneration !== sandboxUiDeepLinkGenerationRef.current) return
        const result = await window.clerum.sandboxUi.listApps()
        if (processingGeneration !== sandboxUiDeepLinkGenerationRef.current) return
        const availableApps = toActiveSandboxUiApps(result.apps)
        setAvailableSandboxUiApps(availableApps)
        const resolution = resolveSandboxUiDeepLinkApp(result.apps, pending.link.appRef)
        if (resolution.status === 'unavailable') {
          throw new Error("You don't have access to this app in the linked team")
        }
        if (resolution.status === 'starting') {
          const launchContext: PendingSandboxUiDeepLinkLaunch = {
            linkId: pending.link.id,
            requestId: 0,
            generation: processingGeneration,
            originalTeamId,
            linkTeamId: pending.link.teamId,
            switchedTeam,
            conversationOrigin: pending.conversationOrigin,
          }
          await restoreSandboxUiDeepLinkTeam(launchContext)
          deferSandboxUiDeepLink(
            pending,
            `${resolution.label} is still starting up. This link will retry shortly.`,
            'info'
          )
          return
        }
        const requestId = launchSandboxUiApp(
          {
            ...resolution.app,
            ...(pending.link.path ? { routePath: pending.link.path } : {}),
          },
          pending.conversationOrigin ?? sandboxUiConversationOrigin
        )
        launchingSandboxUiDeepLinkRef.current = {
          linkId: pending.link.id,
          requestId,
          generation: processingGeneration,
          originalTeamId,
          linkTeamId: pending.link.teamId,
          switchedTeam,
          conversationOrigin: pending.conversationOrigin,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        vm.pushToast(`Could not open app link: ${message}`, 'error')
        if (
          processingGeneration !== sandboxUiDeepLinkGenerationRef.current ||
          processingSandboxUiDeepLinkIdRef.current !== pending.link.id
        ) {
          return
        }
        await restoreSandboxUiDeepLinkTeam({
          linkId: pending.link.id,
          requestId: 0,
          generation: processingGeneration,
          originalTeamId,
          linkTeamId: pending.link.teamId,
          switchedTeam,
          conversationOrigin: pending.conversationOrigin,
        })
        await acknowledgeSandboxUiDeepLink(pending.link.id)
      }
    })()
  }, [
    acknowledgeSandboxUiDeepLink,
    activeSandboxUiApp,
    bootSplashLoading,
    closeActiveSandboxUiEmbedForHandoff,
    deferSandboxUiDeepLink,
    launchSandboxUiApp,
    pendingSandboxUiDeepLinks,
    restoreSandboxUiDeepLinkTeam,
    sandboxUiConversationOrigin,
    sandboxUiDeepLinkRetryTick,
    vm.authenticatedPrincipalIdentity,
    vm.getCurrentTeamId,
    vm.handleEnsureTeamContext,
    vm.isAuthenticated,
    vm.pushToast,
  ])

  React.useEffect(() => {
    const now = Date.now()
    const retryAt = pendingSandboxUiDeepLinks
      .map(item => (item.failedMessage ? undefined : item.nextRetryAt))
      .filter((value): value is number => typeof value === 'number' && value > now)
      .sort((left, right) => left - right)[0]
    if (!retryAt) return
    const timeoutId = window.setTimeout(() => {
      setSandboxUiDeepLinkRetryTick(value => value + 1)
    }, retryAt - now)
    return () => window.clearTimeout(timeoutId)
  }, [pendingSandboxUiDeepLinks, sandboxUiDeepLinkRetryTick])

  const handleSandboxUiShortcutOpenResult = React.useCallback(
    async (requestId: number, result: SandboxUiShortcutOpenResult) => {
      const launch = launchingSandboxUiDeepLinkRef.current
      if (!launch || launch.requestId !== requestId) return
      if (launch.generation !== sandboxUiDeepLinkGenerationRef.current) {
        clearSandboxUiDeepLinkProcessing(launch.linkId)
        return
      }
      const pending = pendingSandboxUiDeepLinksRef.current.find(
        item => item.link.id === launch.linkId
      )
      if (!pending) {
        clearSandboxUiDeepLinkProcessing(launch.linkId)
        return
      }
      if (result.status === 'mounted') {
        await acknowledgeSandboxUiDeepLink(launch.linkId)
        return
      }
      await restoreSandboxUiDeepLinkTeam(launch)
      deferSandboxUiDeepLink(pending, result.message || 'The native app view did not mount')
    },
    [
      acknowledgeSandboxUiDeepLink,
      clearSandboxUiDeepLinkProcessing,
      deferSandboxUiDeepLink,
      restoreSandboxUiDeepLinkTeam,
    ]
  )

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

  const pendingSandboxUiConfirmation = vm.authenticatedPrincipalIdentity
    ? pendingSandboxUiDeepLinks.find(item =>
        isPendingSandboxUiDeepLinkAwaitingConfirmation(item, vm.authenticatedPrincipalIdentity)
      )
    : null
  const failedSandboxUiDeepLink = vm.authenticatedPrincipalIdentity
    ? pendingSandboxUiDeepLinks.find(item => item.failedMessage)
    : null

  const handleConfirmSandboxUiDeepLink = React.useCallback(() => {
    const identity = vm.authenticatedPrincipalIdentity
    const pending = pendingSandboxUiDeepLinksRef.current.find(item =>
      identity ? isPendingSandboxUiDeepLinkAwaitingConfirmation(item, identity) : false
    )
    if (!identity || !pending) return
    const next = confirmPendingSandboxUiDeepLink(
      pendingSandboxUiDeepLinksRef.current,
      pending.link.id,
      identity
    )
    setPendingSandboxUiDeepLinkState(next)
  }, [setPendingSandboxUiDeepLinkState, vm.authenticatedPrincipalIdentity])

  const handleDismissSandboxUiDeepLink = React.useCallback(() => {
    const identity = vm.authenticatedPrincipalIdentity
    const pending = pendingSandboxUiDeepLinksRef.current.find(item =>
      identity ? isPendingSandboxUiDeepLinkAwaitingConfirmation(item, identity) : false
    )
    if (!pending) return
    void acknowledgeSandboxUiDeepLink(pending.link.id)
  }, [acknowledgeSandboxUiDeepLink, vm.authenticatedPrincipalIdentity])

  const handleRetryFailedSandboxUiDeepLink = React.useCallback(() => {
    const pending = pendingSandboxUiDeepLinksRef.current.find(item => item.failedMessage)
    if (!pending) return
    const next = resetPendingSandboxUiDeepLinkFailure(
      pendingSandboxUiDeepLinksRef.current,
      pending.link.id
    )
    setPendingSandboxUiDeepLinkState(next)
    setSandboxUiDeepLinkRetryTick(value => value + 1)
  }, [setPendingSandboxUiDeepLinkState])

  const handleDismissFailedSandboxUiDeepLink = React.useCallback(() => {
    const pending = pendingSandboxUiDeepLinksRef.current.find(item => item.failedMessage)
    if (!pending) return
    void acknowledgeSandboxUiDeepLink(pending.link.id)
  }, [acknowledgeSandboxUiDeepLink])

  const sandboxUiDeepLinkDialog = pendingSandboxUiConfirmation ? (
    <ConfirmDialog
      title="Open app link?"
      body={<p>Open {pendingSandboxUiConfirmation.link.appRef} in this desktop session.</p>}
      cancelLabel="Dismiss"
      confirmLabel="Open"
      onCancel={handleDismissSandboxUiDeepLink}
      onConfirm={handleConfirmSandboxUiDeepLink}
      tone="primary"
    />
  ) : failedSandboxUiDeepLink ? (
    <ConfirmDialog
      title="App link could not be opened"
      body={
        <p>
          {failedSandboxUiDeepLink.failedMessage ||
            'The app link could not be opened in the native view.'}
        </p>
      }
      cancelLabel="Dismiss"
      confirmLabel="Retry"
      onCancel={handleDismissFailedSandboxUiDeepLink}
      onConfirm={handleRetryFailedSandboxUiDeepLink}
      tone="primary"
    />
  ) : null

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
      chatListMoreLoading: vm.chatListMoreLoading,
      chatListHasMoreRemoteSessions: vm.chatListHasMoreRemoteSessions,
      latestChatSessions: vm.latestChatSessions,
      latestChatSessionsLoading: vm.latestChatSessionsLoading,
      loadMoreChatSessions: vm.loadMoreChatSessions,
      sessionStateByChatId: vm.sessionStateByChatId,
      sessionStateByChatKey: vm.sessionStateByChatKey,
    }),
    [
      vm.activeChatId,
      vm.chatList,
      vm.chatListLoading,
      vm.chatListMoreLoading,
      vm.chatListHasMoreRemoteSessions,
      vm.latestChatSessions,
      vm.latestChatSessionsLoading,
      vm.loadMoreChatSessions,
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
      hasOlderMessages: vm.hasOlderMessages,
      olderMessagesLoading: vm.olderMessagesLoading,
      handleLoadOlderMessages: vm.handleLoadOlderMessages,
      activityByMessageId: vm.activityByMessageId,
      progressByMessageId: vm.progressByMessageId,
    }),
    [
      vm.activeChatId,
      vm.activeMessages,
      vm.groupedMessages,
      vm.chatMessagesLoading,
      vm.hasOlderMessages,
      vm.olderMessagesLoading,
      vm.handleLoadOlderMessages,
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
                                <FilesPage
                                  pushToast={vm.pushToast}
                                  pendingGfsUri={pendingGfsUri}
                                  onPendingGfsUriHandled={() => setPendingGfsUri(null)}
                                />
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
                                  onShortcutOpenResult={handleSandboxUiShortcutOpenResult}
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
                        {sandboxUiDeepLinkDialog}
                        {pluginConsentPrompt ? (
                          <PluginConsentModal
                            request={pluginConsentPrompt}
                            onResolve={resolvePluginConsent}
                          />
                        ) : null}
                        {pluginGfsPreview ? (
                          <GfsImagePreview
                            byteLength={pluginGfsPreview.bytes}
                            fileName={pluginGfsPreview.name}
                            gfsUri={pluginGfsPreview.gfsUri}
                            mimeType={pluginGfsPreview.mimeType}
                            onClose={closePluginGfsPreview}
                          />
                        ) : null}
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
