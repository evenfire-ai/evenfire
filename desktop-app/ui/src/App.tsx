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
import { RightRailShell } from '@components/RightRailShell'
import { SidebarNav } from '@components/SidebarNav'
import { TitlebarActionsPortal, WindowTitleBar } from '@components/WindowTitleBar'
import { WorkspaceTabStrip } from '@components/WorkspaceTabStrip'
import { DESKTOP_ROUTES, SIDEBAR_COLLAPSED_KEY } from '@constants/navigation'
import { THEME_STORAGE_KEY } from '@constants/theme'
import { useAgentChatActionsValue } from '@hooks/useAgentChatActionsValue'
import { useAppController } from '@hooks/useAppController'
import {
  CHAT_DRAWER_DOM_FLOOR,
  CHAT_DRAWER_EMBED_FLOOR,
  useChatDrawerResize,
} from '@hooks/useChatDrawerResize'
import { useWindowFocusBridge } from '@hooks/useWindowFocusBridge'
import type { ChatLocalMatch } from '@lib/chatLocalSearch'
import { buildLoadedChatSemanticModels } from '@lib/chatMessageSemantics'
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
import {
  activeWorkspaceTab,
  closeWorkspaceTab,
  createWorkspaceTabsState,
  cycleWorkspaceTab,
  newChatTab,
  openAppTab,
  reconcileWorkspaceChatTab,
  selectLastWorkspaceTab,
  selectWorkspaceTab,
  selectWorkspaceTabAt,
  setAppTabSavedRoutePath,
} from '@lib/workspaceTabs'
import type { WorkspaceTab } from '@lib/workspaceTabs.types'
import { AgentsPage } from '@pages/AgentsPage'
import { AuthPage } from '@pages/AuthPage'
import { ChatPage } from '@pages/ChatPage'
import { FilesPage } from '@pages/FilesPage'
import { McpServersPage } from '@pages/McpServersPage'
import { OnboardingPage } from '@pages/OnboardingPage'
import { SandboxUiPage } from '@pages/SandboxUiPage'
import type {
  SandboxUiConversationOrigin,
  SandboxUiShortcutOpenResult,
} from '@pages/SandboxUiPage.types'
import { SettingsPage } from '@pages/SettingsPage'
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
  // Electron never fires `visibilitychange` on OS-window switching; bridge
  // DOM focus/blur so focus-aware query revalidation actually runs.
  useWindowFocusBridge()
  const [themeMode, setThemeMode] = React.useState<ThemeMode>(getInitialThemeMode)
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState<boolean>(
    getInitialSidebarCollapsed
  )
  const sidebarCollapsedRef = React.useRef(sidebarCollapsed)
  sidebarCollapsedRef.current = sidebarCollapsed
  // When opening an app auto-collapses the sidebar, this remembers the user's
  // prior state so closing the app can restore it. `null` = no app-driven
  // collapse is in effect (no app open, or the user has since taken manual
  // control of the sidebar while an app was open).
  const sidebarCollapsedBeforeAppRef = React.useRef<boolean | null>(null)
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
  const [notificationTrayLeft, setNotificationTrayLeft] = React.useState<number | null>(null)
  const [chatDrawerOpen, setChatDrawerOpen] = React.useState(false)
  const [chatDrawerReady, setChatDrawerReady] = React.useState(false)
  // Measured top of the embed slot, published as `--chat-drawer-top` so the fixed
  // drawer follows the app content down when the sandbox-ui header wraps (narrow
  // window). 0 means "not measured yet" -> the CSS fallback (64px) applies.
  const [chatDrawerEmbedTop, setChatDrawerEmbedTop] = React.useState<number | null>(null)
  const [chatSwitcherFocusRequestId, setChatSwitcherFocusRequestId] = React.useState(0)
  const [availableSandboxUiApps, setAvailableSandboxUiApps] = React.useState<ActiveSandboxUiApp[]>(
    []
  )
  const [sandboxUiShortcutOpenRequestId, setSandboxUiShortcutOpenRequestId] = React.useState(0)
  const [pendingSandboxUiDeepLinks, setPendingSandboxUiDeepLinks] = React.useState<
    PendingSandboxUiDeepLink[]
  >([])
  const [sandboxUiDeepLinkRetryTick, setSandboxUiDeepLinkRetryTick] = React.useState(0)
  // The universal tab store lives in the controller (single writer; `vm.navItem`
  // is its projection). App composes the strip/reveal/reconcile over it.
  const workspaceTabs = vm.workspaceTabs
  const setWorkspaceTabs = vm.setWorkspaceTabs
  const nextChatTabId = vm.nextWorkspaceTabId
  const workspaceTabsRef = React.useRef(workspaceTabs)
  const chatDrawerRef = React.useRef<HTMLElement | null>(null)
  // Mirrors `chatDrawerVisible` so the chat-tab handlers (which run from stable
  // callbacks) can tell whether a reveal should target the in-app drawer or the
  // full-screen chat route without re-binding on every render.
  const chatDrawerVisibleRef = React.useRef(false)
  // Mirrors `chatDrawerDivertable`: the drawer is a VALID surface to divert a
  // gesture into only when the app is live AND the panel is wide enough to render
  // it. Below the minimum width the drawer is suppressed, so "new chat" /
  // notification gestures must fall back to the full-screen chat route instead of
  // landing in a hidden drawer (an unreachable chat). Read from stable callbacks,
  // hence a ref.
  const chatDrawerDivertableRef = React.useRef(false)
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
  const [titlebarActionsRoot, setTitlebarActionsRoot] = React.useState<HTMLDivElement | null>(null)
  const [titlebarLeadingRoot, setTitlebarLeadingRoot] = React.useState<HTMLDivElement | null>(null)
  const [chatLocalSearchOpen, setChatLocalSearchOpen] = React.useState(false)
  const [chatLocalSearchState, setChatLocalSearchState] = React.useState<{
    query: string
    currentMatch: ChatLocalMatch | null
  }>({ query: '', currentMatch: null })
  const [sandboxLocalSearchRequestId, setSandboxLocalSearchRequestId] = React.useState(0)
  const [sandboxActionRequest, setSandboxActionRequest] = React.useState<{
    id: number
    action: 'refresh' | 'back-to-apps'
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
  // Relaunches a backgrounded app tab through the live-app machinery. A ref so
  // `revealWorkspaceTab` (defined above `launchSandboxUiApp`) can call it without
  // a TDZ on the launch callback.
  const relaunchSandboxUiAppRef = React.useRef<
    ((app: ActiveSandboxUiApp, tabId: string) => void) | null
  >(null)
  // Id of the app tab whose native embed is currently live in the main process
  // (mini-spec 05 §3). The store governs the embed lifecycle: when the active
  // app tab changes, this ref tells the deactivation effect which OUTGOING tab
  // to persist the route onto. `null` = no embed is live (also the reconciled
  // state after an UNsolicited close — crash/quit/GC — so a later tab switch
  // does not persist or re-close a dead embed).
  const liveSandboxUiTabIdRef = React.useRef<string | null>(null)
  workspaceTabsRef.current = workspaceTabs

  const leaveSandboxForChat = React.useCallback(() => {
    setActiveSandboxUiApp(null)
    setSandboxUiMounted(false)
    setSandboxUiConversationOrigin(null)
    setHeaderShellOverlayOpen(false)
    setSidebarSettingsMenuOpen(false)
  }, [])

  // Load the CONTENT of a workspace tab once it is (about to be) active — the
  // universal reveal seam. It never selects the tab itself (the store already
  // owns identity/active). Chat tabs delegate to `handleSelectChatAgent` (the
  // pending-selection machine, §4 — never reimplemented); app tabs relaunch
  // through the existing embed machinery (store→embed, closes as today on the
  // next deactivation via the SandboxUiPage unmount cleanup — the single close
  // path, §9); DOM tabs (files/settings) render from the derived `navItem`, so
  // this only tears down any lingering app embed.
  const revealWorkspaceTab = React.useCallback(
    (tab: WorkspaceTab | undefined, inDrawer = chatDrawerVisibleRef.current) => {
      if (!tab || tab.kind === 'files' || tab.kind === 'settings') {
        if (!inDrawer) leaveSandboxForChat()
        return
      }
      if (tab.kind === 'app') {
        const app = availableSandboxUiApps.find(candidate => candidate.appRef === tab.app?.appRef)
        // Transient-empty survivability (mini-spec 05): when the app can't be
        // resolved (registry reconciling / periodic refresh emptied the list),
        // leave the tab intact and do nothing destructive — it recovers when the
        // list repopulates (the picker / no-embed state, never a tab destroy).
        if (app) {
          // Restore the route persisted on deactivation (§3). `savedRoutePath`
          // lives on the tab, not the app; thread it onto the launch so the
          // embed re-mounts where the user left off (undefined → default path).
          const savedRoutePath = tab.app?.savedRoutePath
          relaunchSandboxUiAppRef.current?.(
            savedRoutePath !== undefined ? { ...app, routePath: savedRoutePath } : app,
            tab.id
          )
        }
        return
      }
      const agentRef = tab.chat?.agentRef ?? null
      const chatId = tab.chat?.chatId ?? null
      if (inDrawer) {
        // Swap the shared <ChatPage>'s conversation in place, keeping the live
        // app mounted and the `apps` route active. A blank tab with no agent
        // simply shows the empty composer — there is nothing to navigate to.
        if (agentRef) {
          vm.handleSelectChatAgent(
            agentRef,
            chatId
              ? { chatId, title: tab.title, selectLatest: false, keepNavItem: true }
              : { selectLatest: false, keepNavItem: true }
          )
        }
        return
      }
      // R4 (mini-spec 04a §D): revealing a chat tab full-screen collapses the
      // drawer BEFORE the chat shows. Effective visibility already drops this
      // commit because `drawerAvailable` goes false once a chat tab is active;
      // clearing the open INTENT here keeps the drawer from silently re-opening
      // when the user later returns to a non-chat tab (going to a chat is an
      // explicit focus change; R5's "intact" only spans non-chat ↔ non-chat).
      setChatDrawerOpen(false)
      leaveSandboxForChat()
      if (agentRef) {
        vm.handleSelectChatAgent(
          agentRef,
          chatId ? { chatId, title: tab.title, selectLatest: false } : { selectLatest: false }
        )
      } else {
        vm.handleNavSelect(DESKTOP_ROUTES.chat)
      }
    },
    [availableSandboxUiApps, leaveSandboxForChat, vm.handleNavSelect, vm.handleSelectChatAgent]
  )

  // Global strip selection: activate the tab (so `navItem` derives this commit),
  // then reveal its content.
  const handleSelectWorkspaceTab = React.useCallback(
    (id: string) => {
      const tab = workspaceTabsRef.current.tabs.find(candidate => candidate.id === id)
      if (!tab) return
      vm.clearAppsPicker()
      setWorkspaceTabs(state => selectWorkspaceTab(state, id))
      revealWorkspaceTab(tab, false)
    },
    [revealWorkspaceTab, setWorkspaceTabs, vm.clearAppsPicker]
  )

  // Drawer switcher selection: reveal the chat IN the drawer (keepNavItem), never
  // stealing focus from the active app tab.
  const handleSelectDrawerChatTab = React.useCallback(
    (id: string) => {
      const tab = workspaceTabsRef.current.tabs.find(
        candidate => candidate.id === id && candidate.kind === 'chat'
      )
      if (tab) revealWorkspaceTab(tab, true)
    },
    [revealWorkspaceTab]
  )

  const handleCloseWorkspaceTab = React.useCallback(
    (id: string) => {
      const current = workspaceTabsRef.current
      const wasActive = current.activeTabId === id
      const next = closeWorkspaceTab(current, id)
      if (next === current) return
      vm.clearAppsPicker()
      setWorkspaceTabs(next)
      // Closing the active tab activates a neighbor (or empties the workspace,
      // §5). Reveal it so its content follows the strip.
      if (wasActive) revealWorkspaceTab(activeWorkspaceTab(next), false)
    },
    [revealWorkspaceTab, setWorkspaceTabs, vm.clearAppsPicker]
  )

  const handleNewWorkspaceChatTab = React.useCallback(() => {
    vm.clearAppsPicker()
    const agentRef = vm.selectedAgent
    if (chatDrawerDivertableRef.current) {
      // Drawer is a valid surface (app live, panel wide enough): open the blank
      // chat in the drawer without tearing the live embed down.
      setChatDrawerOpen(true)
      if (agentRef) {
        vm.handleSelectChatAgent(agentRef, { selectLatest: false, keepNavItem: true })
      }
      // With no agent yet there is nothing to seed, so this INTENTIONALLY writes
      // nothing to the store — opening/focusing the drawer is the whole action
      // (equivalent to the old blank-seed). Do not "fix" this to always append.
    } else {
      // No divertable drawer: full-screen chat route so the new chat is reachable.
      leaveSandboxForChat()
      if (agentRef) {
        vm.handleSelectChatAgent(agentRef, { selectLatest: false })
      } else {
        setWorkspaceTabs(state => newChatTab(state, nextChatTabId(), null))
      }
    }
    setComposerFocusRequestId(value => value + 1)
  }, [
    leaveSandboxForChat,
    nextChatTabId,
    setWorkspaceTabs,
    vm.clearAppsPicker,
    vm.handleSelectChatAgent,
    vm.selectedAgent,
  ])

  const openChatDrawer = React.useCallback(() => {
    setChatDrawerOpen(true)
    // Seed the drawer from the conversation the app was opened from ONLY when
    // there is no real chat to return to yet. Once a real conversation is active
    // in the drawer — the user launched from a chat, or switched to one via the
    // switcher — reopening must preserve that last-viewed chat, not jump back to
    // the origin. The drawer's current chat is the controller's
    // (selectedAgent, activeChatId), not the store's active tab (which is the app
    // tab). The reconcile effect adds the chat tab to the switcher.
    const origin = sandboxUiConversationOriginRef.current
    const hasActiveChat = Boolean(vm.selectedAgent && vm.activeChatId)
    if (origin && !hasActiveChat) {
      vm.handleSelectChatAgent(origin.agentName, {
        chatId: origin.chatId,
        title: origin.title,
        selectLatest: false,
        keepNavItem: true,
      })
    } else if (vm.selectedAgent) {
      // Re-reveal the current drawer chat in place.
      vm.handleSelectChatAgent(vm.selectedAgent, {
        ...(vm.activeChatId ? { chatId: vm.activeChatId } : {}),
        selectLatest: false,
        keepNavItem: true,
      })
    }
    setComposerFocusRequestId(value => value + 1)
  }, [vm.activeChatId, vm.handleSelectChatAgent, vm.selectedAgent])

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

  const expandChatDrawerToFullScreen = React.useCallback(() => {
    // Ejects the drawer's active conversation into the full-screen chat route:
    // tear the live embed down and navigate to chat. The drawer's chat is the
    // controller's (selectedAgent, activeChatId). Reset the open intent so a
    // stale `chatDrawerOpen` doesn't linger now that the drawer is gone (a later
    // app launch from a chat re-sets it explicitly).
    leaveSandboxForChat()
    if (vm.selectedAgent) {
      vm.handleSelectChatAgent(vm.selectedAgent, {
        ...(vm.activeChatId ? { chatId: vm.activeChatId } : {}),
        selectLatest: false,
      })
    } else {
      vm.handleNavSelect(DESKTOP_ROUTES.chat)
    }
    setChatDrawerOpen(false)
    setComposerFocusRequestId(value => value + 1)
  }, [
    leaveSandboxForChat,
    vm.activeChatId,
    vm.handleNavSelect,
    vm.handleSelectChatAgent,
    vm.selectedAgent,
  ])

  // minispec 04 approach C: while the app embed is live, an "open conversation"
  // gesture (notification / approval) must surface the chat IN the drawer — open
  // the drawer and pass `keepNavItem` so the vm swaps the shared <ChatPage>
  // without ejecting to the full-screen chat route. App owns both the embed-live
  // signal and the drawer-open state, so the wrap lives here. Only open the drawer
  // for notifications that ACTUALLY surface in it: `handleOpenNotification` routes
  // `workflow_completed`/`sdk_notification` elsewhere, and a cross-team
  // agent-conversation ejects to full-screen (a team switch tears the embed down).
  // Opening the drawer for those would flash it and leave `chatDrawerOpen` stuck.
  const handleOpenNotificationInDrawer = React.useCallback(
    (...args: Parameters<typeof vm.handleOpenNotification>) => {
      const [notification, options] = args
      const surfacesInDrawer =
        chatDrawerDivertableRef.current &&
        notification.kind !== 'workflow_completed' &&
        notification.kind !== 'sdk_notification' &&
        // Mirror the controller's `if (!targetAgent) return`: an agent-less
        // conversation notification has nothing to load, so it never surfaces —
        // opening the drawer for it would leave it up with a blank composer.
        String(notification.agentName || '').trim() !== '' &&
        (!notification.teamId || notification.teamId === vm.getCurrentTeamId())
      if (surfacesInDrawer) {
        setChatDrawerOpen(true)
        return vm.handleOpenNotification(notification, { keepNavItem: true })
      }
      return vm.handleOpenNotification(notification, options)
    },
    [vm.getCurrentTeamId, vm.handleOpenNotification]
  )

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
      // The controller's handleSelectChatAgent owns the tab store now (it
      // activates the matching chat tab so `navItem` derives to `chat` in the
      // same commit). This wrapper only adds drawer-awareness: while the drawer
      // is visible, selection swaps the drawer's chat in place (`keepNavItem`)
      // instead of navigating to full-screen and tearing the live app down.
      vm.clearAppsPicker()
      vm.handleSelectChatAgent(
        agentName,
        chatDrawerVisibleRef.current ? { ...options, keepNavItem: true } : options
      )
    },
    [vm.clearAppsPicker, vm.handleSelectChatAgent]
  )
  const bootSplashLoading = vm.booting || vm.initialExperienceLoading
  const isAgentChatView =
    (vm.navItem === DESKTOP_ROUTES.agents && Boolean(vm.selectedAgent)) ||
    (vm.navItem === DESKTOP_ROUTES.chat && Boolean(vm.selectedAgent))
  // Universal drawer availability (R2, mini-spec 04a §D): the chat drawer is
  // available over ANY non-chat tab (app, files, settings), never on a chat tab
  // (the chat is already the tab's content). An empty workspace (no active tab)
  // maps to the chat home, so it is not available there either. It is an
  // orthogonal boolean axis over the universal store's chat sub-slice /
  // <ChatPage> — never a second tab store, never a foreground/background module.
  const drawerAvailable =
    vm.activeWorkspaceTab !== undefined && vm.activeWorkspaceTab.kind !== 'chat'
  // The drawer coexists with a NATIVE app embed only on the live `apps` route.
  // This narrower predicate keeps the embed-specific machinery (anti-flash
  // bounds gate, embed-measured top, wider content floor) scoped to app tabs; on
  // DOM tabs (files/settings/apps-picker) there is no embed to ack or measure.
  const drawerHasEmbed = vm.navItem === DESKTOP_ROUTES.apps && Boolean(activeSandboxUiApp)
  // Intention (what the user asked for) is kept separate from effective
  // visibility. `chatDrawerDesired` is the user's open intent on a drawer-capable
  // tab; below the minimum panel width the drawer can't coexist with the content
  // so it is SUPPRESSED — hidden without clearing the intent — and reappears on
  // re-widen. A manual close flips `chatDrawerOpen`, so it stays closed. The
  // resize hook measures the panel while the drawer is DESIRED (not only while
  // visible) so it can observe the re-widen; `panelTooNarrow` comes from that
  // measurement, and visibility derives from it — no dependency cycle with the
  // hook's `active` input, which is the desire alone.
  const chatDrawerDesired = drawerAvailable && chatDrawerOpen
  // Per-kind content floor (§A3): app tabs reserve the embed's legible floor; DOM
  // tabs reserve a smaller floor, so a chat+DOM split survives narrower windows.
  const drawerContentFloor = drawerHasEmbed ? CHAT_DRAWER_EMBED_FLOOR : CHAT_DRAWER_DOM_FLOOR
  // Session-only drawer sizing (always docked beside the tab content). Width is
  // not persisted by design; it resets to the default each launch.
  const chatDrawerResize = useChatDrawerResize(
    contentPanelRef,
    chatDrawerDesired,
    drawerContentFloor
  )
  const chatDrawerVisible = chatDrawerDesired && !chatDrawerResize.panelTooNarrow
  // Can a gesture be diverted INTO the drawer right now? Only if it is a valid
  // surface: drawer available AND wide enough to render. Kept SEPARATE from the
  // hook's `active` input on purpose — folding `!panelTooNarrow` into
  // `drawerAvailable` or `chatDrawerDesired` would stop the ResizeObserver from
  // observing the re-widen, turning "suppressed" into "never returns".
  const chatDrawerDivertable = drawerAvailable && !chatDrawerResize.panelTooNarrow
  chatDrawerVisibleRef.current = chatDrawerVisible
  chatDrawerDivertableRef.current = chatDrawerDivertable
  // Effective ready gate (§A2): app tabs wait for the embed's bounds ack
  // (`chatDrawerReady`, flipped by handleSandboxUiBoundsApplied); DOM tabs are
  // ready the moment they are visible — no native view paints over them and the
  // drawer + content layout in the same frame. Derived (NOT an effect) so a DOM
  // tab is ready in the SAME commit as visibility: no post-paint flip, no
  // flicker, and never the "inert forever" trap where a DOM tab waits for a
  // bounds ack that never arrives.
  const drawerReady = drawerHasEmbed ? chatDrawerReady : chatDrawerVisible
  // The rail follows the embed's measured header top only on app tabs; DOM tabs
  // pass null so the shell uses its static CSS fallback (§A2 — never consume an
  // embed measurement that will not arrive on a DOM tab).
  const drawerRailTop = drawerHasEmbed ? chatDrawerEmbedTop : null
  // The notification tray's drawer form occupies the same fixed right-rail rect
  // as the chat drawer, so it only takes drawer form when the chat drawer is NOT
  // visible; while the chat drawer is up it reverts to its popover/overlay form
  // (the existing shell-overlay freeze covers that case) to avoid two stacked
  // drawers fighting for the same rect. AppHeader's tray open-state is its own
  // internal `notificationsOpen`, so flipping the mode never closes an open tray.
  const notificationTrayUsesDrawer = Boolean(activeSandboxUiApp) && !chatDrawerVisible
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
   * Plugin permission prompts. Main hides the plugin's
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

  // Persist only user-driven sidebar changes. Auto-collapse on app open (and the
  // restore on close) is ephemeral and must not overwrite the saved preference.
  const handleSidebarCollapsedChange = React.useCallback((next: boolean) => {
    // The user took manual control: their choice wins for the rest of the app
    // session, and closing the app must not override it.
    sidebarCollapsedBeforeAppRef.current = null
    setSidebarCollapsed(next)
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0')
    } catch {
      // Ignore storage failures in restricted environments.
    }
  }, [])

  // Opening an app collapses the sidebar to hand the app more workspace; closing
  // it restores whatever the sidebar was before — unless the user manually
  // toggled the sidebar while the app was open, in which case their choice
  // stands (see handleSidebarCollapsedChange). Keyed on the open/closed edge so
  // switching directly between apps neither re-collapses nor re-remembers.
  const isSandboxUiAppOpen = Boolean(activeSandboxUiApp)
  React.useEffect(() => {
    if (isSandboxUiAppOpen) {
      if (sidebarCollapsedBeforeAppRef.current === null) {
        sidebarCollapsedBeforeAppRef.current = sidebarCollapsedRef.current
        setSidebarCollapsed(true)
      }
      return
    }
    if (sidebarCollapsedBeforeAppRef.current !== null) {
      setSidebarCollapsed(sidebarCollapsedBeforeAppRef.current)
      sidebarCollapsedBeforeAppRef.current = null
    }
  }, [isSandboxUiAppOpen])

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
    // Arm the store's embed-liveness ref on EVERY open, however it was launched
    // (store launch, deep link, relaunch, or the in-page picker grid opening the
    // embed directly without changing the active tab). The deactivation effect
    // otherwise only arms it on an active-tab CHANGE, so an embed re-mounted
    // WITHIN the still-active app tab — after a back-to-apps / unsolicited
    // onClosed cleared the ref — would never be tracked and would leak (the
    // native view paints over the next tab). Guard on `null` so this never
    // clobbers the OUTGOING id the effect still needs on an app→app switch
    // (ref stays the old tab; the effect reads it, then re-points to the new one).
    if (liveSandboxUiTabIdRef.current === null) {
      const active = activeWorkspaceTab(workspaceTabsRef.current)
      if (active?.kind === 'app') liveSandboxUiTabIdRef.current = active.id
    }
  }, [])

  const handleSandboxUiMounted = React.useCallback(() => {
    setSandboxUiMounted(true)
  }, [])

  const handleSandboxUiClosed = React.useCallback(() => {
    // Unsolicited close (crash / quit / partition GC) or an explicit back-to-apps
    // teardown from SandboxUiPage: the embed is already gone, so reconcile the
    // store's view of the live embed to "not mounted" (§3). The app TAB stays in
    // the store and recovers on reactivation; only the liveness bookkeeping is
    // cleared so the deactivation effect won't re-close a dead embed.
    liveSandboxUiTabIdRef.current = null
    setActiveSandboxUiApp(null)
    setSandboxUiMounted(false)
    setSandboxUiConversationOrigin(null)
    setHeaderShellOverlayOpen(false)
    setSidebarSettingsMenuOpen(false)
  }, [])

  const handleSandboxUiRemoved = React.useCallback(() => {
    liveSandboxUiTabIdRef.current = null
    setActiveSandboxUiApp(null)
    setSandboxUiMounted(false)
    setSandboxUiConversationOrigin(null)
    setHeaderShellOverlayOpen(false)
    setSidebarSettingsMenuOpen(false)
  }, [])

  React.useEffect(() => {
    setNotificationDrawerReady(false)
  }, [activeSandboxUiApp?.appRef, headerNotificationTrayOpen])

  // Re-arm the chat drawer's anti-flash gate whenever it (re)opens or the app
  // changes, so its DOM is revealed only after the embed finishes shrinking.
  React.useEffect(() => {
    setChatDrawerReady(false)
  }, [activeSandboxUiApp?.appRef, chatDrawerVisible])

  // Once the drawer becomes visible AND ready after a `chat.switcher` on a closed
  // drawer, the switcher is mounted and no longer `inert` — bump its focus request
  // so it opens the dropdown and moves focus onto it. Gating on `chatDrawerReady`
  // (not just visibility) is required: the drawer subtree is `inert` from mount
  // until the embed acks its shrunk bounds, and a `focus()` fired while inert is a
  // silent no-op, so bumping on visibility alone would open the switcher unfocused.
  React.useEffect(() => {
    if (chatDrawerVisible && drawerReady && pendingChatSwitcherFocusRef.current) {
      pendingChatSwitcherFocusRef.current = false
      setChatSwitcherFocusRequestId(value => value + 1)
    }
  }, [chatDrawerVisible, drawerReady])

  const handleSandboxUiBoundsApplied = React.useCallback(() => {
    if (appNotificationDrawerOpen) setNotificationDrawerReady(true)
    if (chatDrawerVisible) setChatDrawerReady(true)
  }, [appNotificationDrawerOpen, chatDrawerVisible])

  const launchSandboxUiApp = React.useCallback(
    (
      app: ActiveSandboxUiApp,
      conversationOrigin: SandboxUiConversationOrigin | null,
      existingTabId?: string
    ) => {
      const requestId = sandboxUiShortcutOpenRequestIdRef.current + 1
      sandboxUiShortcutOpenRequestIdRef.current = requestId
      setSandboxUiMounted(false)
      setSandboxUiConversationOrigin(conversationOrigin)
      setActiveSandboxUiApp(app)
      // Store→embed: activate the app tab (a new one, or the backgrounded one on
      // relaunch). Its `kind:'app'` derives `navItem` to the Apps route this
      // commit and clears the instance-less picker residual.
      vm.clearAppsPicker()
      setWorkspaceTabs(state =>
        existingTabId
          ? selectWorkspaceTab(state, existingTabId)
          : openAppTab(state, { id: nextChatTabId(), appRef: app.appRef, title: app.label })
      )
      setSandboxUiShortcutOpenRequestId(requestId)
      if (conversationOrigin) {
        // Opened from a chat: bring that conversation straight into the drawer
        // instead of the destroy-and-reconstitute round-trip. The embed stays
        // live; `keepNavItem` records a pending selection that survives the
        // `apps` route change and loads the chat. The reconcile effect adds the
        // chat tab to the switcher.
        setChatDrawerOpen(true)
        vm.handleSelectChatAgent(conversationOrigin.agentName, {
          chatId: conversationOrigin.chatId,
          title: conversationOrigin.title,
          selectLatest: false,
          keepNavItem: true,
        })
      }
      return requestId
    },
    [nextChatTabId, setWorkspaceTabs, vm.clearAppsPicker, vm.handleSelectChatAgent]
  )
  relaunchSandboxUiAppRef.current = (app, tabId) => {
    launchSandboxUiApp(app, null, tabId)
  }

  // Store-governed embed lifecycle (mini-spec 05 §3, replaces the old
  // SandboxUiPage unmount-cleanup close). The live embed belongs to whichever
  // app tab is active; when that changes, the OUTGOING app's route is persisted
  // and the embed is closed — UNLESS another app tab is taking over, in which
  // case the incoming `open()` replaces the embed in the driver (one-at-a-time,
  // guarded by `mountGeneration`), so a redundant `close()` here would risk
  // closing the freshly-opened view. This effect is the single SOLICITED
  // `close()` emitter for deactivation.
  const activeSandboxUiTabId =
    !vm.appsPickerActive && vm.activeWorkspaceTab?.kind === 'app' ? vm.activeWorkspaceTab.id : null
  React.useEffect(() => {
    const outgoingTabId = liveSandboxUiTabIdRef.current
    if (outgoingTabId === activeSandboxUiTabId) return
    liveSandboxUiTabIdRef.current = activeSandboxUiTabId
    if (outgoingTabId === null) return
    const replacedByAnotherApp = activeSandboxUiTabId !== null
    if (!replacedByAnotherApp) {
      // Deactivating to a non-app surface (chat/files/settings via strip, sidebar
      // nav, or closing the tab): drop the embed's React state now so anything
      // gated on a live app (sidebar auto-collapse, drawer-with-embed) reacts in
      // this commit. On an app→app switch the incoming launch already owns this
      // state, so leave it. This restores the reset the removed unmount cleanup
      // used to do for paths that never call `leaveSandboxForChat` (sidebar nav).
      setActiveSandboxUiApp(null)
      setSandboxUiMounted(false)
    }
    // Read optimistically, persist, then close in a microtask — the visual tab
    // switch (already committed above) must not block on the IPC (§4). A read
    // failure (out-of-prefix throw, destroyed webContents → null) falls back to
    // the default route rather than blocking the switch.
    //
    // app→app ordering: the incoming `open()` is dispatched by SandboxUiPage's
    // child effect (the shortcut-open effect), which runs BEFORE this parent
    // effect AND gates its `open()` IPC behind `waitForEmbedSlotRect` (an rAF
    // loop). This parent effect's `getLocation()` invoke below is dispatched
    // synchronously here — after `open()` STARTED but before its rAF resolves —
    // so `getLocation` reaches main (and reads the still-live outgoing view)
    // strictly before `open()` tears it down. i.e. the read is captured before
    // the incoming open, not merely "usually first".
    void (async () => {
      let routePath: string | undefined
      try {
        const location = await window.clerum.sandboxUi.getLocation()
        routePath = location?.routePath
      } catch {
        routePath = undefined
      }
      // No-op when the outgoing tab was closed (§3: closing a tab does not save).
      setWorkspaceTabs(state => setAppTabSavedRoutePath(state, outgoingTabId, routePath))
      if (replacedByAnotherApp) return
      try {
        await window.clerum.sandboxUi.close()
      } catch {
        // Idempotent: an unsolicited close may have torn it down already.
      }
    })()
  }, [activeSandboxUiTabId, setWorkspaceTabs])

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
    // §3 consistency: persist the outgoing app tab's route before tearing the
    // embed down for a deep-link handoff, so returning to that tab restores
    // where the user was rather than the default/stale route. Same read-then-
    // close as the deactivation effect (try/catch → undefined on failure); read
    // BEFORE `close()` destroys the webContents. `handleSandboxUiClosed` clears
    // the ref, so snapshot the outgoing tab id first.
    const outgoingTabId = liveSandboxUiTabIdRef.current
    if (outgoingTabId !== null) {
      let routePath: string | undefined
      try {
        const location = await window.clerum.sandboxUi.getLocation()
        routePath = location?.routePath
      } catch {
        routePath = undefined
      }
      setWorkspaceTabs(state => setAppTabSavedRoutePath(state, outgoingTabId, routePath))
    }
    await window.clerum.sandboxUi.close()
    handleSandboxUiClosed()
  }, [activeSandboxUiApp, handleSandboxUiClosed, setWorkspaceTabs])

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

  // Reconcile the chat sub-slice of the universal store from the vm's displayed
  // chat. Runs for the full-screen chat route AND whenever the drawer is visible,
  // so any path that moves `vm.activeChatId` — the ChatThread session list, an
  // opened notification, auto-select, resume — keeps the strip / drawer switcher
  // in sync. `reconcileWorkspaceChatTab` is idempotent (returns the same
  // reference when already aligned), so this never ping-pongs with the reveal
  // paths and never drives a chat switch itself.
  React.useEffect(() => {
    if ((vm.navItem !== DESKTOP_ROUTES.chat && !chatDrawerVisible) || !vm.selectedAgent) return
    const conversation = vm.activeChatId
      ? (vm.chatList.find(chat => chat.id === vm.activeChatId) ??
        vm.latestChatSessions.find(
          chat => chat.agentRef === vm.selectedAgent && chat.id === vm.activeChatId
        ))
      : undefined
    const active = {
      agentRef: vm.selectedAgent as string,
      chatId: vm.activeChatId ?? null,
      title: conversation?.title,
    }
    setWorkspaceTabs(state => {
      const reconciled = reconcileWorkspaceChatTab(state, active, nextChatTabId())
      if (reconciled === state) return state
      // Drawer mode: the active tab is the app tab. Keep the chat tab reconcile
      // created/aligned (so the switcher lists it) but DON'T let it steal the
      // active slot — activating a chat tab would flip navItem to chat and tear
      // the embed down.
      const current = activeWorkspaceTab(state)
      if (current && current.kind !== 'chat') {
        // Drawer mode: keep the app tab active. When reconcile only moved
        // `activeTabId` (the tab list is unchanged), return `state` unchanged so
        // the idempotent same-reference bail this effect relies on still holds —
        // rebuilding an equal object would force one extra render per change.
        return reconciled.tabs === state.tabs
          ? state
          : { tabs: reconciled.tabs, activeTabId: state.activeTabId }
      }
      return reconciled
    })
  }, [
    chatDrawerVisible,
    nextChatTabId,
    setWorkspaceTabs,
    vm.activeChatId,
    vm.chatList,
    vm.latestChatSessions,
    vm.navItem,
    vm.selectedAgent,
  ])

  // Reset ephemeral UI + the workspace store when the authenticated principal
  // CHANGES (team switch / re-login), not on the initial mount — the controller
  // already seeds a fresh store there, and resetting on mount would clobber the
  // derived route before the first paint.
  const previousPrincipalIdentityRef = React.useRef<string | null | undefined>(undefined)
  React.useEffect(() => {
    const previousIdentity = previousPrincipalIdentityRef.current
    previousPrincipalIdentityRef.current = vm.authenticatedPrincipalIdentity
    if (previousIdentity === undefined) return
    setWorkspaceTabs(createWorkspaceTabsState('chat-tab-1'))
    vm.clearAppsPicker()
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
      tabCount: workspaceTabs.tabs.length,
      searchableContent:
        (vm.navItem === DESKTOP_ROUTES.apps && Boolean(activeSandboxUiApp)) ||
        (vm.navItem === DESKTOP_ROUTES.chat && Boolean(vm.activeChatId)),
      composerAvailable:
        // The drawer surfaces the same live composer as the full-screen chat
        // route, so `composer.focus` must be eligible there too — not only when
        // `navItem === chat`. On the chat route the active chat tab's agent gates
        // it; in the drawer it is the controller's selected agent (the app tab is
        // active, so the store's active tab is not a chat).
        (vm.navItem === DESKTOP_ROUTES.chat || chatDrawerVisible) &&
        Boolean(
          chatDrawerVisible
            ? vm.selectedAgent
            : (activeWorkspaceTab(workspaceTabs)?.chat?.agentRef ?? null)
        ) &&
        vm.hostRuntimeStatus?.degraded?.reason !== 'llm_key_missing',
      appMounted:
        vm.navItem === DESKTOP_ROUTES.apps && Boolean(activeSandboxUiApp) && sandboxUiMounted,
      applicationBusy: vm.busy,
    }),
    [
      activeSandboxUiApp,
      chatDrawerVisible,
      sandboxUiMounted,
      vm.activeChatId,
      vm.busy,
      vm.hostRuntimeStatus,
      vm.navItem,
      vm.selectedAgent,
      workspaceTabs,
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
      const state = workspaceTabsRef.current
      if (!isDesktopCommandEligible(command, desktopCommandContext)) return
      // Universal tab commands: activate a tab then reveal its content (chat load
      // / app relaunch / DOM route). `tabs.*` cycle over ALL tabs; `chat.*` are
      // chat-specific.
      const selectAndReveal = (next: typeof state) => {
        if (next === state) return
        vm.clearAppsPicker()
        setWorkspaceTabs(next)
        revealWorkspaceTab(activeWorkspaceTab(next), false)
      }
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
        commandId === 'navigate.connectors' ||
        commandId === 'navigate.files'
      ) {
        const routes = {
          'navigate.plugins': DESKTOP_ROUTES.plugins,
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
      if (commandId === 'app.refresh' || commandId === 'app.backToApps') {
        const action = commandId === 'app.refresh' ? 'refresh' : 'back-to-apps'
        setSandboxActionRequest(previous => ({ id: (previous?.id ?? 0) + 1, action }))
        return
      }
      if (commandId === 'chat.newTab') {
        closeChatLocalSearch(false)
        handleNewWorkspaceChatTab()
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
        if (state.activeTabId) handleCloseWorkspaceTab(state.activeTabId)
        return
      }
      if (command.eligibility === 'tab-index' && command.tabIndex !== undefined) {
        selectAndReveal(selectWorkspaceTabAt(state, command.tabIndex))
        return
      }
      if (commandId === 'tabs.selectLast') {
        selectAndReveal(selectLastWorkspaceTab(state))
        return
      }
      if (commandId === 'tabs.next' || commandId === 'tabs.previous') {
        if (state.tabs.length < 2) return
        selectAndReveal(cycleWorkspaceTab(state, commandId === 'tabs.next' ? 'next' : 'previous'))
        return
      }
      if (commandId === 'composer.focus') {
        closeChatLocalSearch(false)
        if (chatDrawerVisibleRef.current) {
          // In the drawer the active workspace tab is the app tab; the composer
          // belongs to the drawer's chat (selectedAgent, activeChatId). Reveal it
          // in place so focus lands on the drawer's live composer.
          if (vm.selectedAgent) {
            vm.handleSelectChatAgent(vm.selectedAgent, {
              ...(vm.activeChatId ? { chatId: vm.activeChatId } : {}),
              selectLatest: false,
              keepNavItem: true,
            })
          }
        } else {
          revealWorkspaceTab(activeWorkspaceTab(state), false)
        }
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
      handleCloseWorkspaceTab,
      handleNewWorkspaceChatTab,
      handleSidebarNavSelect,
      openChatDrawer,
      revealWorkspaceTab,
      sandboxUiMounted,
      setWorkspaceTabs,
      vm.activeChatId,
      vm.clearAppsPicker,
      vm.handleNavSelect,
      vm.handleLogout,
      vm.handleSelectChatAgent,
      vm.isAuthenticated,
      vm.navItem,
      vm.selectedAgent,
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
      handleNavSelect: vm.handleNavSelect,
      handleOpenAgentWorkspace: vm.handleOpenAgentWorkspace,
      handleSelectChatAgent: handleSelectChatAgentWithTabs,
      handleBackToAgents: vm.handleBackToAgents,
    }),
    [
      vm.handleBackToAgents,
      vm.handleNavSelect,
      vm.handleOpenAgentWorkspace,
      handleSelectChatAgentWithTabs,
      vm.navItem,
      vm.selectedAgent,
      vm.selectedAgentRoute,
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
      handleOpenNotification: handleOpenNotificationInDrawer,
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
      handleOpenNotificationInDrawer,
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
  // The drawer switcher is chat-only: the chat sub-slice of the universal store.
  // Its "current" chat is the controller's (selectedAgent, activeChatId) — NOT
  // the store's active tab, which is the app tab while the drawer is open.
  const chatWorkspaceTabs = React.useMemo(
    () => workspaceTabs.tabs.filter((tab): tab is WorkspaceTab => tab.kind === 'chat'),
    [workspaceTabs.tabs]
  )
  const drawerActiveChatTabId =
    chatWorkspaceTabs.find(
      tab =>
        (tab.chat?.agentRef ?? null) === vm.selectedAgent &&
        (tab.chat?.chatId ?? null) === (vm.activeChatId ?? null)
    )?.id ?? null

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
      <div className="app-frame" data-sidebar-collapsed={sidebarCollapsed || undefined}>
        <WindowTitleBar actionsRef={setTitlebarActionsRoot} leadingRef={setTitlebarLeadingRoot} />
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
                              navItem={vm.navItem}
                              activeSandboxUiApp={activeSandboxUiApp}
                              availableSandboxUiApps={availableSandboxUiApps}
                              collapsed={sidebarCollapsed}
                              onCollapsedChange={handleSidebarCollapsedChange}
                              onNewChat={handleNewWorkspaceChatTab}
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
                                }${vm.navItem === DESKTOP_ROUTES.settings ? ' content-panel--settings' : ''} content-panel--titlebar-actions${
                                  appNotificationDrawerOpen
                                    ? ' content-panel--app-notification-drawer-open'
                                    : ''
                                }${chatDrawerVisible ? ' content-panel--chat-drawer-open' : ''}`}
                                style={
                                  chatDrawerVisible
                                    ? // Only `--chat-drawer-width` lives here now: it feeds the
                                      // universal tab-area gutter (`--app-header-utilities-width`).
                                      // The rail's top/width are published by the RightRailShell
                                      // itself (`--rail-*`), not inherited from the panel.
                                      { '--chat-drawer-width': `${chatDrawerResize.width}px` }
                                    : undefined
                                }
                              >
                                {/* Every route mounts the command-center header in the
                                    window title bar via the same portal — the search
                                    pill and notification bell live in the title bar on
                                    all routes, never floating inline over the panel. */}
                                <TitlebarActionsPortal container={titlebarActionsRoot}>
                                  <AppHeader
                                    placement="titlebar"
                                    searchFocusRequestId={globalSearchFocusRequestId}
                                    notificationOpenRequestId={notificationOpenRequestId}
                                    notificationTrayMode={
                                      notificationTrayUsesDrawer ? 'drawer' : 'overlay'
                                    }
                                    notificationTrayReady={notificationDrawerReady}
                                    notificationTrayLeft={
                                      notificationTrayUsesDrawer ? notificationTrayLeft : null
                                    }
                                    onNotificationTrayOpenChange={setHeaderNotificationTrayOpen}
                                    onShellOverlayOpenChange={setHeaderShellOverlayOpen}
                                    drawerAvailable={drawerAvailable}
                                    chatDrawerOpen={chatDrawerVisible}
                                    onToggleChatDrawer={toggleChatDrawer}
                                  />
                                </TitlebarActionsPortal>
                                <ToastStack items={vm.toasts} />
                                {/* Single global strip: driven by the universal
                                    store, visible on every route above the
                                    per-kind seam so any tab is reachable from any
                                    tab. Hidden only when the workspace is empty. */}
                                {workspaceTabs.tabs.length > 0 && (
                                  <WorkspaceTabStrip
                                    tabs={workspaceTabs.tabs}
                                    activeTabId={
                                      vm.appsPickerActive ? null : workspaceTabs.activeTabId
                                    }
                                    onClose={handleCloseWorkspaceTab}
                                    onSelect={handleSelectWorkspaceTab}
                                    panelId={
                                      vm.navItem === DESKTOP_ROUTES.chat
                                        ? 'chat-view-panel'
                                        : undefined
                                    }
                                  />
                                )}
                                {vm.navItem === DESKTOP_ROUTES.chat &&
                                  (workspaceTabs.tabs.length === 0 ? (
                                    <section className="chat-view-workspace" aria-label="Home">
                                      <div className="chat-view-surface">
                                        <div className="workspace-home-empty">
                                          <h2>Nothing open</h2>
                                          <Button onClick={handleNewWorkspaceChatTab}>
                                            New chat
                                          </Button>
                                          <p className="muted">
                                            or open something from the sidebar
                                          </p>
                                        </div>
                                      </div>
                                    </section>
                                  ) : (
                                    <ChatViewWorkspace
                                      localSearch={
                                        chatLocalSearchOpen ? (
                                          <ChatLocalSearch
                                            models={chatSemanticModels}
                                            onClose={closeChatLocalSearch}
                                            onSearchStateChange={handleChatLocalSearchStateChange}
                                          />
                                        ) : null
                                      }
                                      surfaceId="chat-view-panel"
                                    >
                                      <ChatPage scrollContainerRef={contentPanelRef} />
                                    </ChatViewWorkspace>
                                  ))}
                                {vm.navItem === DESKTOP_ROUTES.agents && (
                                  <AgentsPage scrollContainerRef={contentPanelRef} />
                                )}
                                {vm.navItem === DESKTOP_ROUTES.files && (
                                  <FilesPage
                                    pushToast={vm.pushToast}
                                    pendingGfsUri={pendingGfsUri}
                                    onPendingGfsUriHandled={() => setPendingGfsUri(null)}
                                  />
                                )}
                                {vm.navItem === DESKTOP_ROUTES.connectors && <McpServersPage />}
                                {vm.navItem === DESKTOP_ROUTES.plugins && <WorkflowsPage />}
                                {vm.navItem === DESKTOP_ROUTES.apps && (
                                  <SandboxUiPage
                                    boundsRefreshKey={sandboxUiBoundsRefreshKey}
                                    actionRequest={sandboxActionRequest}
                                    currentTeamId={vm.currentTeamId}
                                    headerShellOverlayOpen={
                                      headerShellOverlayOpen || commandPaletteOpen
                                    }
                                    sidebarShellOverlayOpen={sidebarSettingsMenuOpen}
                                    toastShellOverlayOpen={vm.toasts.length > 0}
                                    deepLinkShellOverlayOpen={sandboxUiDeepLinkDialog !== null}
                                    shortcutApp={activeSandboxUiApp}
                                    shortcutOpenRequestId={sandboxUiShortcutOpenRequestId}
                                    localSearchRequestId={sandboxLocalSearchRequestId}
                                    titlebarLeadingContainer={titlebarLeadingRoot}
                                    onEmbeddedAppOpening={handleSandboxUiOpening}
                                    onEmbeddedAppMounted={handleSandboxUiMounted}
                                    onEmbeddedAppBack={handleSandboxUiClosed}
                                    onEmbeddedAppRemoved={handleSandboxUiRemoved}
                                    onEmbedBoundsApplied={handleSandboxUiBoundsApplied}
                                    onEmbedSlotTopChange={setChatDrawerEmbedTop}
                                    onEmbedSlotRightChange={setNotificationTrayLeft}
                                    onNotify={vm.pushToast}
                                    onShortcutOpenResult={handleSandboxUiShortcutOpenResult}
                                  />
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
                                    channelNotificationPreferences={
                                      vm.channelNotificationPreferences
                                    }
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
                              </section>
                              {/* Universal chat drawer (mini-spec 04a §B/§D):
                                  mounted at the workspace-layout level (a sibling
                                  of the content panel), not inside the apps block,
                                  so it persists across ANY non-chat tab (R5). It
                                  fills the shared right-rail shell; the tab area
                                  between the sidebar and this rail shrinks via the
                                  universal gutter. Single global <ChatPage>/
                                  ChatSwitcher — no duplicated tab state or
                                  streams. */}
                              {chatDrawerVisible && (
                                <RightRailShell
                                  occupant="chat-drawer"
                                  width={chatDrawerResize.width}
                                  top={drawerRailTop}
                                >
                                  <ChatDrawer
                                    header={
                                      <ChatSwitcher
                                        tabs={chatWorkspaceTabs}
                                        activeTabId={drawerActiveChatTabId}
                                        onSelect={handleSelectDrawerChatTab}
                                        onNewChat={handleNewWorkspaceChatTab}
                                        focusRequestId={chatSwitcherFocusRequestId}
                                      />
                                    }
                                    onNewChat={handleNewWorkspaceChatTab}
                                    onExpandFullScreen={expandChatDrawerToFullScreen}
                                    onToggle={toggleChatDrawer}
                                    containerRef={chatDrawerRef}
                                    ready={drawerReady}
                                    onResizeHandleMouseDown={
                                      chatDrawerResize.onResizeHandleMouseDown
                                    }
                                    onResizeHandleKeyDown={chatDrawerResize.onResizeHandleKeyDown}
                                    width={chatDrawerResize.width}
                                    resizing={chatDrawerResize.isResizing}
                                  >
                                    <ChatPage scrollContainerRef={chatDrawerRef} />
                                  </ChatDrawer>
                                </RightRailShell>
                              )}
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
              {vm.unauthenticatedView === 'outage' ? (
                <UnavailablePage />
              ) : vm.unauthenticatedView === 'onboarding' ? (
                <OnboardingPage onboarding={vm.onboarding} />
              ) : (
                <AuthPage />
              )}
              {environmentSetupConfirmationDialog}
              {environmentSetupSuccessDialog}
              <ToastStack items={vm.toasts} />
            </>
          )}
        </div>
      </div>
      <BootSplash loading={bootSplashLoading} />
    </AuthContext.Provider>
  )
}
