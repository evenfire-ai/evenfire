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
import { ChatDrawer } from '@components/ChatDrawer'
import { ChatLocalSearch } from '@components/ChatLocalSearch'
import { ChatSwitcher } from '@components/ChatSwitcher'
import { ChatViewWorkspace } from '@components/ChatViewWorkspace'
import { CommandPalette } from '@components/CommandPalette'
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
import type { ChatLocalMatch } from '@lib/chatLocalSearch'
import { buildLoadedChatSemanticModels } from '@lib/chatMessageSemantics'
import {
  activeChatViewTab,
  addBlankChatViewTab,
  closeChatViewTab,
  createChatViewTabsState,
  cycleChatViewTab,
  focusBlankChatViewTab,
  openPersistedChatViewTab,
  selectChatViewTab,
  selectChatViewTabAt,
  selectLastChatViewTab,
} from '@lib/chatViewTabs'
import type { ChatViewTab } from '@lib/chatViewTabs.types'
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
  findPendingSandboxUiDeepLinkAwaitingConfirmation,
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
import {
  type DesktopCommandId,
  getDesktopCommand,
  isDesktopCommandEligible,
  platformFromNavigator,
} from '../../src/desktopCommands'

type PendingSandboxUiDeepLinkLaunch = {
  linkId: number
  requestId: number
  generation: number
  originalTeamId: string
  linkTeamId?: string
  switchedTeam: boolean
  conversationOrigin: SandboxUiConversationOrigin | null
}

const TRANSIENT_TEAM_CONTEXT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])

const SANDBOX_UI_DEEP_LINK_MANUAL_TEAM_CHANGE_MESSAGE =
  'App link paused because you switched teams. Retry to open it from the current team, or dismiss it.'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Unknown error')
}

function hasBlockingDesktopDialog(): boolean {
  return Boolean(
    document.querySelector('[role="dialog"][aria-modal="true"], .da-plugin-consent[role="dialog"]')
  )
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const record = error as { code?: unknown; cause?: { code?: unknown } }
  return String(record.code || record.cause?.code || '').toUpperCase()
}

function isTransientSandboxUiTeamContextError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase()
  if (
    /\b(400|401|403|404)\b/.test(message) ||
    message.includes('access denied') ||
    message.includes('authenticat') ||
    message.includes('forbidden') ||
    message.includes('not a member') ||
    message.includes('permission') ||
    message.includes('select a team') ||
    message.includes('teamid is required') ||
    message.includes('validation')
  ) {
    return false
  }

  const code = errorCode(error)
  if (TRANSIENT_TEAM_CONTEXT_ERROR_CODES.has(code)) return true

  return (
    message.includes('connection refused') ||
    message.includes('connection reset') ||
    message.includes('fetch failed') ||
    message.includes('network error') ||
    message.includes('socket hang up') ||
    message.includes('temporarily unavailable') ||
    message.includes('timed out') ||
    message.includes('timeout')
  )
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
  const [sandboxUiMounted, setSandboxUiMounted] = React.useState(false)
  const [sandboxUiConversationOrigin, setSandboxUiConversationOrigin] =
    React.useState<SandboxUiConversationOrigin | null>(null)
  const [sidebarSettingsMenuOpen, setSidebarSettingsMenuOpen] = React.useState(false)
  const [headerShellOverlayOpen, setHeaderShellOverlayOpen] = React.useState(false)
  const [headerNotificationTrayOpen, setHeaderNotificationTrayOpen] = React.useState(false)
  const [notificationDrawerReady, setNotificationDrawerReady] = React.useState(false)
  const [chatDrawerOpen, setChatDrawerOpen] = React.useState(false)
  const [chatDrawerReady, setChatDrawerReady] = React.useState(false)
  const [chatSwitcherFocusRequestId, setChatSwitcherFocusRequestId] = React.useState(0)
  const [availableSandboxUiApps, setAvailableSandboxUiApps] = React.useState<ActiveSandboxUiApp[]>(
    []
  )
  const [sandboxUiShortcutOpenRequestId, setSandboxUiShortcutOpenRequestId] = React.useState(0)
  const [pendingSandboxUiDeepLinks, setPendingSandboxUiDeepLinks] = React.useState<
    PendingSandboxUiDeepLink[]
  >([])
  const [sandboxUiDeepLinkRetryTick, setSandboxUiDeepLinkRetryTick] = React.useState(0)
  const nextChatTabSequenceRef = React.useRef(2)
  const [chatViewTabs, setChatViewTabs] = React.useState(() =>
    createChatViewTabsState('chat-tab-1')
  )
  const chatViewTabsRef = React.useRef(chatViewTabs)
  const chatDrawerRef = React.useRef<HTMLElement | null>(null)
  // Mirrors `chatDrawerVisible` so the chat-tab handlers (which run from stable
  // callbacks) can tell whether a reveal should target the in-app drawer or the
  // full-screen chat route without re-binding on every render.
  const chatDrawerVisibleRef = React.useRef(false)
  // Mirrors `chatDrawerAvailable` (app live on the apps route): whenever the app
  // is in the foreground, "new chat" must open a blank tab in the drawer instead
  // of tearing the live embed down — even when the drawer is currently closed.
  const chatDrawerAvailableRef = React.useRef(false)
  // Set when `chat.switcher` fires with the drawer still closed: the switcher is
  // not mounted yet, so we open the drawer and defer the focus bump until its
  // column commits.
  const pendingChatSwitcherFocusRef = React.useRef(false)
  // Mirror of the app's originating conversation so the drawer can be seeded
  // from it inside stable callbacks.
  const sandboxUiConversationOriginRef = React.useRef<SandboxUiConversationOrigin | null>(null)
  sandboxUiConversationOriginRef.current = sandboxUiConversationOrigin
  const [composerFocusRequestId, setComposerFocusRequestId] = React.useState(0)
  const [globalSearchFocusRequestId, setGlobalSearchFocusRequestId] = React.useState(0)
  const [notificationOpenRequestId, setNotificationOpenRequestId] = React.useState(0)
  const [sidebarToggleRequestId, setSidebarToggleRequestId] = React.useState(0)
  const [chatLocalSearchOpen, setChatLocalSearchOpen] = React.useState(false)
  const [chatLocalSearchState, setChatLocalSearchState] = React.useState<{
    query: string
    currentMatch: ChatLocalMatch | null
  }>({ query: '', currentMatch: null })
  const [sandboxLocalSearchRequestId, setSandboxLocalSearchRequestId] = React.useState(0)
  const [sandboxActionRequest, setSandboxActionRequest] = React.useState<{
    id: number
    action: 'refresh' | 'back-to-apps' | 'back-to-conversation'
  } | null>(null)
  const [commandPaletteOpen, setCommandPaletteOpen] = React.useState(false)
  const [commandPaletteReturnToSandbox, setCommandPaletteReturnToSandbox] = React.useState(false)
  const [settingsShortcutsRequestId, setSettingsShortcutsRequestId] = React.useState(0)
  const chatLocalSearchPreviousFocusRef = React.useRef<HTMLElement | null>(null)
  const contentPanelRef = React.useRef<HTMLElement | null>(null)
  const activeConversationOriginRef = React.useRef<SandboxUiConversationOrigin | null>(null)
  const processingSandboxUiDeepLinkIdRef = React.useRef<number | null>(null)
  const launchingSandboxUiDeepLinkRef = React.useRef<PendingSandboxUiDeepLinkLaunch | null>(null)
  const pendingSandboxUiDeepLinksRef = React.useRef<PendingSandboxUiDeepLink[]>([])
  const sandboxUiDeepLinkRestoreTeamByIdRef = React.useRef(new Map<number, string>())
  const sandboxUiDeepLinkIdentityRef = React.useRef<string | null | undefined>(undefined)
  const sandboxUiDeepLinkGenerationRef = React.useRef(0)
  const sandboxUiShortcutOpenRequestIdRef = React.useRef(0)
  chatViewTabsRef.current = chatViewTabs

  const nextChatTabId = React.useCallback(() => `chat-tab-${nextChatTabSequenceRef.current++}`, [])

  const leaveSandboxForChat = React.useCallback(() => {
    setActiveSandboxUiApp(null)
    setSandboxUiMounted(false)
    setSandboxUiConversationOrigin(null)
    setHeaderShellOverlayOpen(false)
    setSidebarSettingsMenuOpen(false)
  }, [])

  const revealChatViewTab = React.useCallback(
    (tab: ChatViewTab, inDrawer = chatDrawerVisibleRef.current) => {
      if (inDrawer) {
        // Swap the shared <ChatPage>'s conversation in place, keeping the live
        // app mounted and the `apps` route active. A blank tab with no agent
        // simply shows the empty composer — there is nothing to navigate to.
        if (tab.agentRef) {
          vm.handleSelectChatAgent(
            tab.agentRef,
            tab.chatId
              ? { chatId: tab.chatId, title: tab.title, selectLatest: false, keepNavItem: true }
              : { selectLatest: false, keepNavItem: true }
          )
        }
        return
      }
      leaveSandboxForChat()
      if (tab.agentRef) {
        vm.handleSelectChatAgent(
          tab.agentRef,
          tab.chatId
            ? { chatId: tab.chatId, title: tab.title, selectLatest: false }
            : { selectLatest: false }
        )
      } else {
        vm.handleNavSelect(DESKTOP_ROUTES.chat)
      }
    },
    [leaveSandboxForChat, vm.handleNavSelect, vm.handleSelectChatAgent]
  )

  const handleSelectChatViewTab = React.useCallback(
    (id: string) => {
      const state = selectChatViewTab(chatViewTabsRef.current, id)
      if (state === chatViewTabsRef.current) return
      setChatViewTabs(state)
      revealChatViewTab(activeChatViewTab(state))
    },
    [revealChatViewTab]
  )

  const handleCloseChatViewTab = React.useCallback(
    (id: string) => {
      const current = chatViewTabsRef.current
      const wasActive = current.activeTabId === id
      const next = closeChatViewTab(current, id, nextChatTabId())
      if (next === current) return
      setChatViewTabs(next)
      if (wasActive) revealChatViewTab(activeChatViewTab(next))
    },
    [nextChatTabId, revealChatViewTab]
  )

  const handleNewChatViewTab = React.useCallback(() => {
    const next = addBlankChatViewTab(chatViewTabsRef.current, nextChatTabId(), vm.selectedAgent)
    setChatViewTabs(next)
    if (chatDrawerAvailableRef.current) {
      // App in foreground: open the blank chat in the drawer, never tear the
      // live embed down (spec §5.3). Opens the drawer if it was closed.
      setChatDrawerOpen(true)
      revealChatViewTab(activeChatViewTab(next), true)
    } else {
      revealChatViewTab(activeChatViewTab(next))
    }
    setComposerFocusRequestId(value => value + 1)
  }, [nextChatTabId, revealChatViewTab, vm.selectedAgent])

  const openChatDrawer = React.useCallback(() => {
    setChatDrawerOpen(true)
    // Seed the drawer from the conversation the app was opened from, if any, so
    // "open the drawer" brings that chat back in place — no destroy-and-
    // reconstitute round-trip. Otherwise reveal whatever tab is already active.
    const origin = sandboxUiConversationOriginRef.current
    let next = chatViewTabsRef.current
    if (origin) {
      next = openPersistedChatViewTab(next, {
        id: nextChatTabId(),
        agentRef: origin.agentName,
        chatId: origin.chatId,
        title: origin.title,
      })
      setChatViewTabs(next)
    }
    // The ref still reads `false` until the next render commits the open state,
    // so reveal explicitly in-drawer to swap the shared <ChatPage> in place.
    revealChatViewTab(activeChatViewTab(next), true)
    setComposerFocusRequestId(value => value + 1)
  }, [nextChatTabId, revealChatViewTab])

  const closeChatDrawer = React.useCallback(() => {
    setChatDrawerOpen(false)
  }, [])

  const toggleChatDrawer = React.useCallback(() => {
    if (chatDrawerVisibleRef.current) {
      closeChatDrawer()
    } else {
      openChatDrawer()
    }
  }, [closeChatDrawer, openChatDrawer])

  const closeChatLocalSearch = React.useCallback((restoreFocus = true) => {
    setChatLocalSearchOpen(false)
    setChatLocalSearchState({ query: '', currentMatch: null })
    if (!restoreFocus) return
    const previous = chatLocalSearchPreviousFocusRef.current
    requestAnimationFrame(() => {
      if (previous?.isConnected) previous.focus()
    })
  }, [])

  const handleChatLocalSearchStateChange = React.useCallback(
    (query: string, currentMatch: ChatLocalMatch | null) => {
      setChatLocalSearchState(previous =>
        previous.query === query &&
        previous.currentMatch?.messageId === currentMatch?.messageId &&
        previous.currentMatch?.occurrence === currentMatch?.occurrence
          ? previous
          : { query, currentMatch }
      )
    },
    []
  )

  const handleSelectChatAgentWithTabs = React.useCallback(
    (
      agentName: string,
      options: { selectLatest?: boolean; chatId?: string; isRemote?: boolean; title?: string } = {}
    ) => {
      const chatId = String(options.chatId || '').trim()
      const next = chatId
        ? openPersistedChatViewTab(chatViewTabsRef.current, {
            id: nextChatTabId(),
            agentRef: agentName,
            chatId,
            title: options.title,
          })
        : focusBlankChatViewTab(chatViewTabsRef.current, nextChatTabId(), agentName)
      setChatViewTabs(next)
      // While the drawer is visible, agent selection (sidebar picker, ChatPage's
      // auto-select) must swap the drawer's chat in place instead of navigating
      // to the full-screen chat route and tearing the live app down.
      vm.handleSelectChatAgent(
        agentName,
        chatDrawerVisibleRef.current ? { ...options, keepNavItem: true } : options
      )
    },
    [nextChatTabId, vm.handleSelectChatAgent]
  )
  const bootSplashLoading = vm.booting || vm.initialExperienceLoading
  const isAgentChatView =
    (vm.navItem === DESKTOP_ROUTES.agents && Boolean(vm.selectedAgent)) ||
    (vm.navItem === DESKTOP_ROUTES.chat && Boolean(vm.selectedAgent))
  const notificationTrayUsesDrawer = Boolean(activeSandboxUiApp)
  const appNotificationDrawerOpen = notificationTrayUsesDrawer && headerNotificationTrayOpen
  // The chat drawer coexists with the live app only on the `apps` route. It is
  // an orthogonal boolean axis over the shared `chatViewTabs`/<ChatPage> — never
  // a second tab store, never a foreground/background precedence module.
  const chatDrawerAvailable = vm.navItem === DESKTOP_ROUTES.apps && Boolean(activeSandboxUiApp)
  const chatDrawerVisible = chatDrawerAvailable && chatDrawerOpen
  chatDrawerVisibleRef.current = chatDrawerVisible
  chatDrawerAvailableRef.current = chatDrawerAvailable
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
    sandboxUiDeepLinkRestoreTeamByIdRef.current.clear()
    sandboxUiDeepLinkGenerationRef.current += 1
    void window.clerum.sandboxUi.clearPendingDeepLinks().catch(error => {
      console.warn('[Desktop] Could not clear stale app deep links:', error)
    })
  }, [vm.authenticatedPrincipalIdentity])

  const handleSandboxUiOpening = React.useCallback((app: ActiveSandboxUiApp) => {
    setSandboxUiMounted(false)
    setActiveSandboxUiApp(app)
  }, [])

  const handleSandboxUiMounted = React.useCallback(() => {
    setSandboxUiMounted(true)
  }, [])

  const handleSandboxUiClosed = React.useCallback(() => {
    setActiveSandboxUiApp(null)
    setSandboxUiMounted(false)
    setSandboxUiConversationOrigin(null)
    setHeaderShellOverlayOpen(false)
    setSidebarSettingsMenuOpen(false)
  }, [])

  const handleSandboxUiRemoved = React.useCallback(() => {
    setActiveSandboxUiApp(null)
    setSandboxUiMounted(false)
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

  // Re-arm the chat drawer's anti-flash gate whenever it (re)opens or the app
  // changes, so its DOM is revealed only after the embed finishes shrinking.
  React.useEffect(() => {
    setChatDrawerReady(false)
  }, [activeSandboxUiApp?.appRef, chatDrawerVisible])

  // Once the drawer becomes visible after a `chat.switcher` on a closed drawer,
  // the switcher is mounted — bump its focus request so it opens the dropdown.
  React.useEffect(() => {
    if (chatDrawerVisible && pendingChatSwitcherFocusRef.current) {
      pendingChatSwitcherFocusRef.current = false
      setChatSwitcherFocusRequestId(value => value + 1)
    }
  }, [chatDrawerVisible])

  const handleSandboxUiBoundsApplied = React.useCallback(() => {
    if (appNotificationDrawerOpen) setNotificationDrawerReady(true)
    if (chatDrawerVisible) setChatDrawerReady(true)
  }, [appNotificationDrawerOpen, chatDrawerVisible])

  const launchSandboxUiApp = React.useCallback(
    (app: ActiveSandboxUiApp, conversationOrigin: SandboxUiConversationOrigin | null) => {
      const requestId = sandboxUiShortcutOpenRequestIdRef.current + 1
      sandboxUiShortcutOpenRequestIdRef.current = requestId
      setSandboxUiMounted(false)
      setSandboxUiConversationOrigin(conversationOrigin)
      setActiveSandboxUiApp(app)
      vm.handleNavSelect(DESKTOP_ROUTES.apps)
      setSandboxUiShortcutOpenRequestId(requestId)
      if (conversationOrigin) {
        // Opened from a chat: bring that conversation straight into the drawer
        // instead of the destroy-and-reconstitute round-trip. The embed stays
        // live; `keepNavItem` (via revealChatViewTab in-drawer) records a pending
        // selection that survives the `apps` route change and loads the chat.
        setChatDrawerOpen(true)
        const next = openPersistedChatViewTab(chatViewTabsRef.current, {
          id: nextChatTabId(),
          agentRef: conversationOrigin.agentName,
          chatId: conversationOrigin.chatId,
          title: conversationOrigin.title,
        })
        setChatViewTabs(next)
        revealChatViewTab(activeChatViewTab(next), true)
      }
      return requestId
    },
    [nextChatTabId, revealChatViewTab, vm.handleNavSelect]
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
      sandboxUiDeepLinkRestoreTeamByIdRef.current.delete(linkId)
      try {
        await window.clerum.sandboxUi.acknowledgeDeepLink(linkId)
      } catch (error) {
        console.warn('[Desktop] Could not acknowledge app deep link:', error)
      }
    },
    [clearSandboxUiDeepLinkProcessing, setPendingSandboxUiDeepLinkState]
  )

  const deferSandboxUiDeepLink = React.useCallback(
    (
      pending: PendingSandboxUiDeepLink,
      message: string,
      tone: 'info' | 'error' = 'error'
    ): boolean => {
      clearSandboxUiDeepLinkProcessing(pending.link.id)
      if ((pending.retryCount ?? 0) >= MAX_SANDBOX_UI_DEEP_LINK_RETRY_ATTEMPTS) {
        const next = failPendingSandboxUiDeepLink(
          pendingSandboxUiDeepLinksRef.current,
          pending.link.id,
          message
        )
        setPendingSandboxUiDeepLinkState(next)
        vm.pushToast(`Could not open app link: ${message}`, 'error')
        return true
      }
      const next = deferPendingSandboxUiDeepLink(
        pendingSandboxUiDeepLinksRef.current,
        pending.link.id,
        Date.now()
      )
      setPendingSandboxUiDeepLinkState(next)
      vm.pushToast(message, tone)
      return false
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

  const deferSandboxUiDeepLinkUntilTerminal = React.useCallback(
    async (
      pending: PendingSandboxUiDeepLink,
      message: string,
      launchContext: PendingSandboxUiDeepLinkLaunch,
      tone: 'info' | 'error' = 'error'
    ) => {
      if (deferSandboxUiDeepLink(pending, message, tone)) {
        await restoreSandboxUiDeepLinkTeam(launchContext)
      }
    },
    [deferSandboxUiDeepLink, restoreSandboxUiDeepLinkTeam]
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
      const restoreTeamId = sandboxUiDeepLinkRestoreTeamByIdRef.current.get(pending.link.id)
      const originalTeamId = restoreTeamId ?? vm.getCurrentTeamId()
      let switchedTeam = Boolean(
        restoreTeamId && pending.link.teamId && restoreTeamId !== pending.link.teamId
      )
      const currentTeamId = vm.getCurrentTeamId()
      try {
        if (processingGeneration !== sandboxUiDeepLinkGenerationRef.current) return
        if (
          restoreTeamId &&
          pending.retryCount &&
          pending.link.teamId &&
          currentTeamId !== pending.link.teamId
        ) {
          sandboxUiDeepLinkRestoreTeamByIdRef.current.delete(pending.link.id)
          clearSandboxUiDeepLinkProcessing(pending.link.id)
          const next = failPendingSandboxUiDeepLink(
            pendingSandboxUiDeepLinksRef.current,
            pending.link.id,
            SANDBOX_UI_DEEP_LINK_MANUAL_TEAM_CHANGE_MESSAGE
          )
          setPendingSandboxUiDeepLinkState(next)
          vm.pushToast(
            `Could not open app link: ${SANDBOX_UI_DEEP_LINK_MANUAL_TEAM_CHANGE_MESSAGE}`,
            'error'
          )
          return
        }
        if (pending.link.teamId && pending.link.teamId !== currentTeamId) {
          await closeActiveSandboxUiEmbedForHandoff()
          try {
            const didSwitchTeam = await vm.handleEnsureTeamContext({
              teamId: pending.link.teamId,
              announce: true,
            })
            switchedTeam = switchedTeam || didSwitchTeam
            if (switchedTeam && originalTeamId !== pending.link.teamId) {
              sandboxUiDeepLinkRestoreTeamByIdRef.current.set(pending.link.id, originalTeamId)
            }
          } catch (error) {
            switchedTeam =
              switchedTeam ||
              (originalTeamId !== pending.link.teamId &&
                vm.getCurrentTeamId() === pending.link.teamId)
            if (switchedTeam && originalTeamId !== pending.link.teamId) {
              sandboxUiDeepLinkRestoreTeamByIdRef.current.set(pending.link.id, originalTeamId)
            }
            if (isTransientSandboxUiTeamContextError(error)) {
              const launchContext: PendingSandboxUiDeepLinkLaunch = {
                linkId: pending.link.id,
                requestId: 0,
                generation: processingGeneration,
                originalTeamId,
                linkTeamId: pending.link.teamId,
                switchedTeam,
                conversationOrigin: pending.conversationOrigin,
              }
              await deferSandboxUiDeepLinkUntilTerminal(
                pending,
                `Could not switch to the linked team yet: ${errorMessage(
                  error
                )}. This link will retry shortly.`,
                launchContext,
                'info'
              )
              return
            }
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
          await deferSandboxUiDeepLinkUntilTerminal(
            pending,
            `${resolution.label} is still starting up. This link will retry shortly.`,
            launchContext,
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
    clearSandboxUiDeepLinkProcessing,
    deferSandboxUiDeepLinkUntilTerminal,
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
    setPendingSandboxUiDeepLinkState,
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
      await deferSandboxUiDeepLinkUntilTerminal(
        pending,
        result.message || 'The native app view did not mount',
        launch
      )
    },
    [
      acknowledgeSandboxUiDeepLink,
      clearSandboxUiDeepLinkProcessing,
      deferSandboxUiDeepLinkUntilTerminal,
    ]
  )

  React.useEffect(() => {
    if (vm.navItem !== DESKTOP_ROUTES.chat || !vm.selectedAgent) return
    if (!vm.activeChatId) {
      setChatViewTabs(state =>
        focusBlankChatViewTab(state, nextChatTabId(), vm.selectedAgent as string)
      )
      return
    }
    const conversation =
      vm.chatList.find(chat => chat.id === vm.activeChatId) ??
      vm.latestChatSessions.find(
        chat => chat.agentRef === vm.selectedAgent && chat.id === vm.activeChatId
      )
    setChatViewTabs(state =>
      openPersistedChatViewTab(state, {
        id: nextChatTabId(),
        agentRef: vm.selectedAgent as string,
        chatId: vm.activeChatId as string,
        title: conversation?.title,
      })
    )
  }, [
    nextChatTabId,
    vm.activeChatId,
    vm.chatList,
    vm.latestChatSessions,
    vm.navItem,
    vm.selectedAgent,
  ])

  React.useEffect(() => {
    nextChatTabSequenceRef.current = 2
    setChatViewTabs(createChatViewTabsState('chat-tab-1'))
    setComposerFocusRequestId(0)
    setGlobalSearchFocusRequestId(0)
    setNotificationOpenRequestId(0)
    setSidebarToggleRequestId(0)
    setChatLocalSearchOpen(false)
    setSandboxLocalSearchRequestId(0)
    setSandboxActionRequest(null)
    setSandboxUiMounted(false)
    setCommandPaletteOpen(false)
    setCommandPaletteReturnToSandbox(false)
    setSettingsShortcutsRequestId(0)
    setChatDrawerOpen(false)
    setChatSwitcherFocusRequestId(0)
  }, [vm.authenticatedPrincipalIdentity])

  const desktopCommandContext = React.useMemo(
    () => ({
      tabCount: chatViewTabs.tabs.length,
      searchableContent:
        (vm.navItem === DESKTOP_ROUTES.apps && Boolean(activeSandboxUiApp)) ||
        (vm.navItem === DESKTOP_ROUTES.chat && Boolean(vm.activeChatId)),
      composerAvailable:
        vm.navItem === DESKTOP_ROUTES.chat &&
        Boolean(activeChatViewTab(chatViewTabs).agentRef) &&
        vm.hostRuntimeStatus?.degraded?.reason !== 'llm_key_missing',
      appMounted:
        vm.navItem === DESKTOP_ROUTES.apps && Boolean(activeSandboxUiApp) && sandboxUiMounted,
      conversationOriginAvailable:
        vm.navItem === DESKTOP_ROUTES.apps &&
        Boolean(activeSandboxUiApp) &&
        sandboxUiMounted &&
        Boolean(sandboxUiConversationOrigin),
      applicationBusy: vm.busy,
    }),
    [
      activeSandboxUiApp,
      chatViewTabs,
      sandboxUiConversationOrigin,
      sandboxUiMounted,
      vm.activeChatId,
      vm.busy,
      vm.hostRuntimeStatus,
      vm.navItem,
    ]
  )

  const isCommandEligible = React.useCallback(
    (commandId: DesktopCommandId) =>
      isDesktopCommandEligible(getDesktopCommand(commandId), desktopCommandContext),
    [desktopCommandContext]
  )

  const closeCommandPalette = React.useCallback(() => {
    const returnToSandbox = commandPaletteReturnToSandbox
    setCommandPaletteOpen(false)
    setCommandPaletteReturnToSandbox(false)
    if (returnToSandbox) {
      requestAnimationFrame(() => {
        void window.clerum.sandboxUi.focusActive().catch(() => undefined)
      })
    }
  }, [commandPaletteReturnToSandbox])

  const executeDesktopCommand = React.useCallback(
    (
      commandId: DesktopCommandId,
      origin: 'shortcut-host' | 'shortcut-sandbox' | 'palette' = 'shortcut-host'
    ) => {
      if (!vm.isAuthenticated) return
      if (origin !== 'palette' && commandPaletteOpen) {
        if (commandId === 'commands.open') closeCommandPalette()
        return
      }
      const command = getDesktopCommand(commandId)
      if (origin !== 'palette' && hasBlockingDesktopDialog()) return
      const state = chatViewTabsRef.current
      if (!isDesktopCommandEligible(command, desktopCommandContext)) return
      if (commandId === 'commands.open') {
        closeChatLocalSearch(false)
        if (origin === 'palette') {
          setCommandPaletteOpen(false)
          setCommandPaletteReturnToSandbox(false)
        } else {
          setCommandPaletteReturnToSandbox(origin === 'shortcut-sandbox')
          setCommandPaletteOpen(true)
        }
        return
      }
      if (origin === 'palette') {
        setCommandPaletteOpen(false)
        setCommandPaletteReturnToSandbox(false)
      }
      if (commandId === 'settings.shortcuts') {
        closeChatLocalSearch(false)
        setCommandPaletteOpen(false)
        vm.handleNavSelect(DESKTOP_ROUTES.settings)
        setSettingsShortcutsRequestId(value => value + 1)
        return
      }
      if (commandId === 'settings.open') {
        closeChatLocalSearch(false)
        handleSidebarNavSelect(DESKTOP_ROUTES.settings)
        return
      }
      if (commandId === 'auth.logout') {
        void vm.handleLogout()
        return
      }
      if (
        commandId === 'navigate.chat' ||
        commandId === 'navigate.apps' ||
        commandId === 'navigate.agents'
      ) {
        const route =
          commandId === 'navigate.chat'
            ? DESKTOP_ROUTES.chat
            : commandId === 'navigate.apps'
              ? DESKTOP_ROUTES.apps
              : DESKTOP_ROUTES.agents
        handleSidebarNavSelect(route)
        return
      }
      if (commandId === 'notifications.open') {
        setNotificationOpenRequestId(value => value + 1)
        return
      }
      if (
        commandId === 'navigate.plugins' ||
        commandId === 'navigate.contexts' ||
        commandId === 'navigate.teams' ||
        commandId === 'navigate.connectors' ||
        commandId === 'navigate.files'
      ) {
        const routes = {
          'navigate.plugins': DESKTOP_ROUTES.plugins,
          'navigate.contexts': DESKTOP_ROUTES.contexts,
          'navigate.teams': DESKTOP_ROUTES.teams,
          'navigate.connectors': DESKTOP_ROUTES.connectors,
          'navigate.files': DESKTOP_ROUTES.files,
        } as const
        handleSidebarNavSelect(routes[commandId])
        return
      }
      if (commandId === 'sidebar.toggle') {
        setSidebarToggleRequestId(value => value + 1)
        return
      }
      if (
        commandId === 'app.refresh' ||
        commandId === 'app.backToApps' ||
        commandId === 'app.backToConversation'
      ) {
        const action =
          commandId === 'app.refresh'
            ? 'refresh'
            : commandId === 'app.backToApps'
              ? 'back-to-apps'
              : 'back-to-conversation'
        setSandboxActionRequest(previous => ({ id: (previous?.id ?? 0) + 1, action }))
        return
      }
      if (commandId === 'chat.newTab') {
        closeChatLocalSearch(false)
        handleNewChatViewTab()
        return
      }
      if (commandId === 'chat.switcher') {
        closeChatLocalSearch(false)
        if (chatDrawerVisibleRef.current) {
          setChatSwitcherFocusRequestId(value => value + 1)
        } else {
          // Open the drawer first; the deferred-focus effect opens the switcher
          // once the switcher's column has mounted.
          pendingChatSwitcherFocusRef.current = true
          openChatDrawer()
        }
        return
      }
      if (commandId === 'chat.closeTab') {
        closeChatLocalSearch(false)
        handleCloseChatViewTab(state.activeTabId)
        return
      }
      if (command.eligibility === 'tab-index' && command.tabIndex !== undefined) {
        const next = selectChatViewTabAt(state, command.tabIndex)
        if (next !== state) {
          setChatViewTabs(next)
          revealChatViewTab(activeChatViewTab(next))
        }
        return
      }
      if (commandId === 'tabs.selectLast') {
        const next = selectLastChatViewTab(state)
        setChatViewTabs(next)
        revealChatViewTab(activeChatViewTab(next))
        return
      }
      if (commandId === 'tabs.next' || commandId === 'tabs.previous') {
        if (state.tabs.length < 2) return
        const next = cycleChatViewTab(state, commandId === 'tabs.next' ? 'next' : 'previous')
        setChatViewTabs(next)
        revealChatViewTab(activeChatViewTab(next))
        return
      }
      if (commandId === 'composer.focus') {
        closeChatLocalSearch(false)
        revealChatViewTab(activeChatViewTab(state))
        setComposerFocusRequestId(value => value + 1)
        return
      }
      if (commandId === 'search.open') {
        closeChatLocalSearch(false)
        setGlobalSearchFocusRequestId(value => value + 1)
        return
      }
      if (commandId === 'search.current') {
        if (activeSandboxUiApp && sandboxUiMounted && vm.navItem === DESKTOP_ROUTES.apps) {
          closeChatLocalSearch(false)
          setSandboxLocalSearchRequestId(value => value + 1)
        } else if (vm.navItem === DESKTOP_ROUTES.chat && vm.activeChatId) {
          chatLocalSearchPreviousFocusRef.current = document.activeElement as HTMLElement | null
          setChatLocalSearchOpen(true)
        }
      }
    },
    [
      activeSandboxUiApp,
      closeChatLocalSearch,
      closeCommandPalette,
      commandPaletteOpen,
      desktopCommandContext,
      handleCloseChatViewTab,
      handleNewChatViewTab,
      handleSidebarNavSelect,
      openChatDrawer,
      revealChatViewTab,
      sandboxUiMounted,
      vm.activeChatId,
      vm.handleNavSelect,
      vm.handleLogout,
      vm.isAuthenticated,
      vm.navItem,
    ]
  )

  React.useEffect(() => {
    if (!window.clerum.shortcuts) return undefined
    return window.clerum.shortcuts.onCommand((commandId, source) =>
      executeDesktopCommand(commandId, source === 'sandbox' ? 'shortcut-sandbox' : 'shortcut-host')
    )
  }, [executeDesktopCommand])

  const sandboxUiBoundsRefreshKey = `${sidebarCollapsed ? 'collapsed' : 'expanded'}:${
    appNotificationDrawerOpen ? 'notification-drawer-open' : 'notification-drawer-closed'
  }:${chatDrawerVisible ? 'chat-drawer-open' : 'chat-drawer-closed'}`

  const pendingSandboxUiConfirmation =
    findPendingSandboxUiDeepLinkAwaitingConfirmation(
      pendingSandboxUiDeepLinks,
      vm.authenticatedPrincipalIdentity
    ) ?? null
  const failedSandboxUiDeepLink = vm.authenticatedPrincipalIdentity
    ? pendingSandboxUiDeepLinks.find(item => item.failedMessage)
    : null

  const handleConfirmSandboxUiDeepLink = React.useCallback(() => {
    const identity = vm.authenticatedPrincipalIdentity
    const pending = findPendingSandboxUiDeepLinkAwaitingConfirmation(
      pendingSandboxUiDeepLinksRef.current,
      identity
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
    const pending = findPendingSandboxUiDeepLinkAwaitingConfirmation(
      pendingSandboxUiDeepLinksRef.current,
      identity
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
      backendSwitchHint: vm.backendSwitchHint,
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
      handleSwitchLoginBackend: vm.handleSwitchLoginBackend,
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
      vm.backendSwitchHint,
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
      vm.handleSwitchLoginBackend,
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
      handleSelectChatAgent: handleSelectChatAgentWithTabs,
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
      handleSelectChatAgentWithTabs,
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
      composerFocusRequestId,
    }),
    [
      vm.activeChatId,
      vm.composerImageAttachments,
      vm.composerReferenceAttachments,
      vm.agentSending,
      vm.agentError,
      vm.failedAgentSend,
      vm.activeMessages.length,
      composerFocusRequestId,
    ]
  )

  const chatSemanticModels = React.useMemo(
    () => buildLoadedChatSemanticModels(vm.activeMessages),
    [vm.activeMessages]
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
      localSearchQuery: chatLocalSearchOpen ? chatLocalSearchState.query : '',
      localSearchCurrentMatch: chatLocalSearchOpen ? chatLocalSearchState.currentMatch : null,
      semanticModelsByMessageId: new Map(
        chatSemanticModels.map(model => [model.messageId, model] as const)
      ),
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
      chatLocalSearchOpen,
      chatLocalSearchState,
      chatSemanticModels,
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
                            onNewChat={handleNewChatViewTab}
                            onOpenSandboxUiApp={handleOpenSandboxUiApp}
                            onSettingsMenuOpenChange={setSidebarSettingsMenuOpen}
                            onSelect={handleSidebarNavSelect}
                            toggleRequestId={sidebarToggleRequestId}
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
                              }${chatDrawerVisible ? ' content-panel--chat-drawer-open' : ''}`}
                            >
                              <AppHeader
                                searchFocusRequestId={globalSearchFocusRequestId}
                                notificationOpenRequestId={notificationOpenRequestId}
                                notificationTrayMode={
                                  notificationTrayUsesDrawer ? 'drawer' : 'overlay'
                                }
                                notificationTrayReady={notificationDrawerReady}
                                onNotificationTrayOpenChange={setHeaderNotificationTrayOpen}
                                onShellOverlayOpenChange={setHeaderShellOverlayOpen}
                              />
                              <ToastStack items={vm.toasts} />
                              {vm.navItem === DESKTOP_ROUTES.chat && (
                                <ChatViewWorkspace
                                  activeTabId={chatViewTabs.activeTabId}
                                  localSearch={
                                    chatLocalSearchOpen ? (
                                      <ChatLocalSearch
                                        models={chatSemanticModels}
                                        onClose={closeChatLocalSearch}
                                        onSearchStateChange={handleChatLocalSearchStateChange}
                                      />
                                    ) : null
                                  }
                                  onClose={handleCloseChatViewTab}
                                  onSelect={handleSelectChatViewTab}
                                  surfaceId="chat-view-panel"
                                  tabs={chatViewTabs.tabs}
                                >
                                  <ChatPage scrollContainerRef={contentPanelRef} />
                                </ChatViewWorkspace>
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
                                <>
                                  <SandboxUiPage
                                    boundsRefreshKey={sandboxUiBoundsRefreshKey}
                                    actionRequest={sandboxActionRequest}
                                    conversationOrigin={sandboxUiConversationOrigin}
                                    currentTeamId={vm.currentTeamId}
                                    headerShellOverlayOpen={
                                      headerShellOverlayOpen || commandPaletteOpen
                                    }
                                    sidebarShellOverlayOpen={sidebarSettingsMenuOpen}
                                    toastShellOverlayOpen={vm.toasts.length > 0}
                                    shortcutApp={activeSandboxUiApp}
                                    shortcutOpenRequestId={sandboxUiShortcutOpenRequestId}
                                    localSearchRequestId={sandboxLocalSearchRequestId}
                                    chatDrawerOpen={chatDrawerVisible}
                                    onToggleChatDrawer={toggleChatDrawer}
                                    onBackToConversation={handleSandboxUiBackToConversation}
                                    onEmbeddedAppOpening={handleSandboxUiOpening}
                                    onEmbeddedAppMounted={handleSandboxUiMounted}
                                    onEmbeddedAppBack={handleSandboxUiClosed}
                                    onEmbeddedAppRemoved={handleSandboxUiRemoved}
                                    onEmbedBoundsApplied={handleSandboxUiBoundsApplied}
                                    onNotify={vm.pushToast}
                                    onShortcutOpenResult={handleSandboxUiShortcutOpenResult}
                                  />
                                  {chatDrawerVisible && (
                                    <ChatDrawer
                                      header={
                                        <ChatSwitcher
                                          tabs={chatViewTabs.tabs}
                                          activeTabId={chatViewTabs.activeTabId}
                                          onSelect={handleSelectChatViewTab}
                                          onNewChat={handleNewChatViewTab}
                                          focusRequestId={chatSwitcherFocusRequestId}
                                        />
                                      }
                                      onNewChat={handleNewChatViewTab}
                                      onClose={closeChatDrawer}
                                      containerRef={chatDrawerRef}
                                      ready={chatDrawerReady}
                                    >
                                      <ChatPage scrollContainerRef={chatDrawerRef} />
                                    </ChatDrawer>
                                  )}
                                </>
                              )}
                              {vm.navItem === DESKTOP_ROUTES.settings && (
                                <SettingsPage
                                  shortcutsFocusRequestId={settingsShortcutsRequestId}
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
                        {commandPaletteOpen ? (
                          <CommandPalette
                            platform={platformFromNavigator(navigator.platform)}
                            isEligible={isCommandEligible}
                            onClose={closeCommandPalette}
                            onExecute={commandId => executeDesktopCommand(commandId, 'palette')}
                            restorePreviousFocus={!commandPaletteReturnToSandbox}
                          />
                        ) : null}
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
