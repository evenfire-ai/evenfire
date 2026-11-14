import {
  BrowserWindow,
  IpcMainEvent,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  powerMonitor,
} from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { AppService, type SessionPreclearNotice } from './appService.js'
import { routeClerumOauthCompleted } from './clerumDeepLink.js'
import {
  config,
  getActiveEnvKey,
  getDesktopRuntimeConfigState,
  hydrateDesktopRuntimeConfig,
} from './config.js'
import { installDesktopTextContextMenus } from './desktopTextContextMenu.js'
import {
  type DevIsolationPlan,
  devIsolationRuntimePolicy,
  formatDevIsolationLogLine,
  publicDevIsolationRecord,
  resolveDevIsolation,
  verifyDevIsolationRuntime,
} from './devIsolation.js'
import { createEvenfireDeepLinkRouter } from './evenfireDeepLinkRouter.js'
import { GFS_RESOURCE_DEEP_LINK_HOST, parseGfsResourceDeepLink } from './gfsDeepLinks.js'
import {
  GfsResourceDeepLinkQueue,
  GfsUserNavigationGeneration,
  createLogoutWithGfsResourceDeepLinkClear,
} from './gfsResourceDeepLinkQueue.js'
import {
  assertTrustedSender,
  registerDeepLinkAcknowledgmentHandlers,
  registerIpcHandlers,
} from './ipc.js'
import { mainWindowRoundedCorners } from './mainWindowChrome.js'
import { createMainWindowCoordinator, createRetryableInitializer } from './mainWindowCoordinator.js'
import { wireMainWindowRendererReadiness } from './mainWindowReadiness.js'
import { McpOauthCompletionQueue } from './mcpOauthCompletionQueue.js'
import { initPluginSdkRuntime } from './pluginSdkRuntime.js'
import { collectInitialProtocolUrls, shouldRegisterOsProtocols } from './protocolLaunchArgs.js'
import { SandboxUiDeepLinkQueue } from './sandboxUiDeepLinkQueue.js'
import {
  CLERUM_OAUTH_PROTOCOL,
  SANDBOX_UI_DEEP_LINK_HOST,
  SANDBOX_UI_DEEP_LINK_PROTOCOL,
  parseSandboxUiDeepLink,
} from './sandboxUiDeepLinks.js'
import { shouldAcceptSandboxUiProtocolLink } from './sandboxUiProtocolWindowPolicy.js'
import { notifySandboxUiHostResumed } from './sandboxUiSessionRefresh.js'
import { wireHostDesktopShortcutRouting } from './shortcutRouter.js'
import { installAdaptiveSystemIcon, resolveSystemIconPath } from './systemIcon.js'
import { TokenStore } from './tokenStore.js'
import type { SessionAuthorityBinding } from './types.js'

const EVENFIRE_APP_NAME = 'Evenfire'
const EVENFIRE_APP_ID = 'ai.evenfire.desktop'

/**
 * Dev isolation is opt-in and fail-closed. A launch that asked for an isolated
 * instance must never continue into the shared user profile or the machine-wide
 * OS protocol handler, so an unhonourable request aborts here — before
 * `registerCustomProtocols()` can touch the default handler.
 */
const devIsolation = resolveDevIsolation(process.env, process.argv, app.isPackaged)
if (devIsolation.mode === 'refused') {
  console.error(`[Desktop] Dev isolation refused: ${devIsolation.code}: ${devIsolation.message}`)
  process.exit(1)
}
const devIsolationPlan: DevIsolationPlan | null =
  devIsolation.mode === 'isolated' ? devIsolation.plan : null
const devIsolationPolicy = devIsolationRuntimePolicy(devIsolationPlan)

process.title = devIsolationPolicy.appName ?? EVENFIRE_APP_NAME
app.setName(devIsolationPolicy.appName ?? EVENFIRE_APP_NAME)
app.setAppUserModelId(EVENFIRE_APP_ID)

// Prevent crash on EPIPE when stdout/stderr pipe is broken (e.g., parent terminal closed)
process.stdout?.on?.('error', () => {})
process.stderr?.on?.('error', () => {})

let mainWindow: BrowserWindow | null = null
let forceFreshRendererAfterSessionClear = false
let sessionTransitionRevealPending = false
let pendingSessionClearedNotifications = 0
let pendingMarkdownDraftLossNotification = false
let currentRendererDocumentEpoch: string | null = null
let currentRendererReadyChallenge: string | null = null
let currentRendererSessionViewReceipt: {
  documentEpoch: string
  receiptId: string
  sessionGeneration: number
  authenticated: boolean
  userId: string | null
  teamId: string | null
  authorityBinding: SessionAuthorityBinding
} | null = null
const sessionPreclearRendererLost = new Set<number>()
const activeSessionPreclearTransitions = new Set<number>()
type SessionRecoveryDialogState = { attemptsRemaining: number; retryAvailable: boolean }
const activeSessionRecoveryDialogs = new Map<
  number,
  {
    state: SessionRecoveryDialogState | null
    wake: ((state: SessionRecoveryDialogState | null) => void) | null
    terminal: boolean
  }
>()
function finishSessionRecoveryDialog(notice: Pick<SessionPreclearNotice, 'transitionId'>): void {
  const current = activeSessionRecoveryDialogs.get(notice.transitionId)
  if (!current) return
  current.terminal = true
  current.wake?.(null)
  current.wake = null
}
function showSessionRecoveryDialog(
  notice: SessionPreclearNotice,
  state: SessionRecoveryDialogState
): void {
  if (activeSessionRecoveryDialogs.has(notice.transitionId)) {
    const existing = activeSessionRecoveryDialogs.get(notice.transitionId)!
    existing.state = state
    existing.wake?.(state)
    existing.wake = null
    return
  }
  const recovery: {
    state: SessionRecoveryDialogState | null
    wake: ((state: SessionRecoveryDialogState | null) => void) | null
    terminal: boolean
  } = { state, wake: null, terminal: false }
  activeSessionRecoveryDialogs.set(notice.transitionId, recovery)
  void (async () => {
    try {
      while (!recovery.terminal) {
        const canRetry = recovery.state?.retryAvailable === true
        const displayedActions = canRetry ? (['Retry', 'Exit'] as const) : (['Exit'] as const)
        const result = await dialog.showMessageBox({
          type: 'warning',
          title: 'Session could not be verified',
          message:
            'Evenfire could not confirm that this session is still current. The window will stay hidden until the session is verified.',
          detail: canRetry
            ? `You can retry the check (${recovery.state?.attemptsRemaining ?? 0} attempts remain) or exit.\n\nNo Markdown draft will be recovered after exiting.`
            : 'An authority check is still unresolved or this recovery has no attempts left. Retry may become available after an outstanding check settles; you can exit now. No Markdown draft will be recovered after exiting.',
          buttons: [...displayedActions],
          defaultId: canRetry ? 0 : 0,
          cancelId: canRetry ? 1 : 0,
          noLink: true,
        })
        if (recovery.terminal) break
        const selectedAction = displayedActions[result.response] ?? 'Exit'
        if (selectedAction === 'Exit') {
          recovery.terminal = true
          appService.exitSessionPreclearRecovery(notice)
          app.quit()
          break
        }
        recovery.state = null
        if (!appService.retrySessionPreclearRecovery(notice)) {
          recovery.state = {
            attemptsRemaining: 0,
            retryAvailable: false,
          }
          continue
        }
        recovery.state = await new Promise<SessionRecoveryDialogState | null>(resolve => {
          recovery.wake = resolve
        })
      }
    } finally {
      activeSessionRecoveryDialogs.delete(notice.transitionId)
    }
  })()
}
const reloadHiddenRendererAfterSessionTransition = () => {
  const window = mainWindow
  if (!forceFreshRendererAfterSessionClear || !window || window.isDestroyed()) return
  forceFreshRendererAfterSessionClear = false
  sessionTransitionRevealPending = true
  mainWindowRendererReady = false
  currentRendererReadyChallenge = null
  currentRendererSessionViewReceipt = null
  window.webContents.reload()
}
const sandboxUiDeepLinkQueue = new SandboxUiDeepLinkQueue()
const appService = new AppService({
  ...(devIsolationPlan
    ? { tokenStore: new TokenStore({ isolatedUserDataPath: devIsolationPlan.userDataDir }) }
    : {}),
  onSandboxUiSessionInvalidated: () => {
    const appDeepLinkMinimumId = sandboxUiDeepLinkQueue.clear()
    const gfsDeepLinkMinimumId = gfsResourceDeepLinkQueue.clear()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sandboxUi:sessionInvalidated', {
        sessionGeneration: appService.getSessionGeneration(),
        appDeepLinkMinimumId,
        gfsDeepLinkMinimumId,
      })
    }
  },
  onSessionCleared: () => {
    for (const transitionId of activeSessionRecoveryDialogs.keys()) {
      finishSessionRecoveryDialog({ transitionId })
    }
    activeSessionPreclearTransitions.clear()
    sessionPreclearRendererLost.clear()
    pendingMarkdownDraftLossNotification = false
    // Keep the previous authenticated React tree hidden until a fresh renderer
    // installs its session-cleared listener and reads the cleared main session.
    pendingSessionClearedNotifications += 1
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
    retireCurrentMarkdownRendererDocument()
    forceFreshRendererAfterSessionClear = true
    reloadHiddenRendererAfterSessionTransition()
  },
  onSessionPreclear: notice => {
    const window = mainWindow
    if (!window || window.isDestroyed()) return false
    // Hide synchronously at the main-process reservation point, before a queued
    // renderer commit can paint and before the notice/any await.
    window.hide()
    activeSessionPreclearTransitions.add(notice.transitionId)
    if (window.webContents.isDestroyed() || window.webContents.isLoading()) {
      sessionPreclearRendererLost.add(notice.transitionId)
      return false
    }
    window.webContents.send('auth:sessionWillClear', notice)
    return true
  },
  onSessionPreclearTimeout: () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
  },
  onSessionPreclearRecoveryRequired: (notice, state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
    showSessionRecoveryDialog(notice, state)
  },
  onSessionPreclearAuthorityChanging: () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide()
      currentRendererSessionViewReceipt = null
    }
  },
  onSessionPreclearAuthorityChanged: notice => {
    const window = mainWindow
    if (!window || window.isDestroyed()) return
    window.hide()
    activeSessionPreclearTransitions.add(notice.transitionId)
    retireCurrentMarkdownRendererDocument()
    forceFreshRendererAfterSessionClear = true
    reloadHiddenRendererAfterSessionTransition()
  },
  onSessionPreclearAwaitingReceipt: (notice, state) => {
    showSessionRecoveryDialog(notice, state)
  },
  onSessionPreclearReceiptCommitted: notice => {
    finishSessionRecoveryDialog(notice)
    activeSessionPreclearTransitions.delete(notice.transitionId)
    sessionPreclearRendererLost.delete(notice.transitionId)
  },
  onSessionPreclearCancelled: notice => {
    finishSessionRecoveryDialog(notice)
    activeSessionPreclearTransitions.delete(notice.transitionId)
    if (sessionPreclearRendererLost.delete(notice.transitionId)) {
      pendingMarkdownDraftLossNotification = true
      forceFreshRendererAfterSessionClear = true
      reloadHiddenRendererAfterSessionTransition()
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('auth:sessionClearCancelled', notice)
      mainWindow.show()
    }
  },
  onSessionPreclearRetired: notice => {
    finishSessionRecoveryDialog(notice)
    activeSessionPreclearTransitions.delete(notice.transitionId)
    if (sessionPreclearRendererLost.delete(notice.transitionId)) {
      pendingMarkdownDraftLossNotification = true
    }
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.hide()
    retireCurrentMarkdownRendererDocument()
    forceFreshRendererAfterSessionClear = true
    reloadHiddenRendererAfterSessionTransition()
  },
})
function retireCurrentMarkdownRendererDocument(): void {
  const window = mainWindow
  if (window && currentRendererDocumentEpoch) {
    appService.retireMarkdownTabCloseDocument(window.webContents.id, currentRendererDocumentEpoch)
  }
  currentRendererDocumentEpoch = null
  currentRendererReadyChallenge = null
  currentRendererSessionViewReceipt = null
}
const gfsResourceDeepLinkQueue = new GfsResourceDeepLinkQueue()
const gfsUserNavigationGeneration = new GfsUserNavigationGeneration()
const logoutAndClearGfsResourceDeepLinks = createLogoutWithGfsResourceDeepLinkClear(
  gfsResourceDeepLinkQueue,
  () => appService.logout()
)
registerDeepLinkAcknowledgmentHandlers(appService, () => mainWindow, {
  appQueue: sandboxUiDeepLinkQueue,
  gfsQueue: gfsResourceDeepLinkQueue,
  navigation: gfsUserNavigationGeneration,
})
// U5: deliver mcp-oauth completions to the renderer, or queue them when the
// renderer is not yet ready (cold start), draining after `app:rendererReady`.
const mcpOauthCompletionQueue = new McpOauthCompletionQueue(completion => {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindowRendererReady) {
    mainWindow.webContents.send('rpc:mcpOauthCompleted', completion)
    return true
  }
  return false
})
let mainWindowLifecycleReady = false
let mainWindowRendererReady = false
let appWindowVisibilityWired = false
const appServiceInitializer = createRetryableInitializer(() => appService.initialize())
const DESKTOP_SETUP_PROTOCOL = SANDBOX_UI_DEEP_LINK_PROTOCOL.replace(/:$/, '')
const CLERUM_PROTOCOL = CLERUM_OAUTH_PROTOCOL.replace(/:$/, '')

function systemIconAssetsDirectory(): string {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '../assets')
}

function wireAdaptiveSystemIcon(): void {
  installAdaptiveSystemIcon({
    assetsDirectory: systemIconAssetsDirectory(),
    getAllWindows: () => BrowserWindow.getAllWindows(),
    onThemeUpdated: listener => {
      nativeTheme.on('updated', listener)
    },
    onWindowCreated: listener => {
      app.on('browser-window-created', (_event, window) => listener(window))
    },
    platform: process.platform,
    setDockIcon: app.dock ? icon => app.dock?.setIcon(icon) : undefined,
    shouldUseDarkColors: () => nativeTheme.shouldUseDarkColors,
  })
}

/** True when the window is actually on-screen (not hidden/minimized). Drives the
 *  D.5b T4 nudge copy — `document.visibilityState` doesn't detect minimize on macOS. */
function isWindowVisible(win: BrowserWindow | null): boolean {
  return Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized())
}

/**
 * Chromium renderer focus is not the same thing as application focus: a
 * WebContentsView can own the active document while the Evenfire window still
 * owns the user's attention. Keep notification policy on the native Electron
 * window state instead of asking the parent renderer who currently owns DOM
 * focus.
 */
function isAppFocused(): boolean {
  return BrowserWindow.getAllWindows().some(win => !win.isDestroyed() && win.isFocused())
}

function windowState(win: BrowserWindow | null): { visible: boolean; focused: boolean } {
  return { visible: isWindowVisible(win), focused: isAppFocused() }
}

function sameSessionAuthorityBinding(
  left: SessionAuthorityBinding,
  right: SessionAuthorityBinding
): boolean {
  return (
    left.environmentKey === right.environmentKey &&
    left.restBaseUrl === right.restBaseUrl &&
    left.rpcBaseUrl === right.rpcBaseUrl
  )
}

type WindowControlsState = { maximized: boolean; fullscreen: boolean }

function windowControlsState(win: BrowserWindow | null): WindowControlsState {
  return { maximized: Boolean(win?.isMaximized()), fullscreen: Boolean(win?.isFullScreen()) }
}

function emitWindowControlsState(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.webContents.send('window:controlsState', windowControlsState(win))
}

/**
 * GAP-D1 (spec-v2 §4.5-4): after the OS sleeps/resumes (or the screen locks and
 * unlocks), open SSE sockets are typically dead but neither the tracker watchdog
 * nor the bridge reconnect has noticed yet. Broadcast a `system:resume` tick so
 * the renderer reconciles every chat with an in-flight task and re-attaches dead
 * streams — the 30s watchdog stays as a slower safety net. No payload: the
 * renderer decides which chats to reconcile from its own FSM. Registered once,
 * app-wide (not per-window); `send` is a no-op when the webContents is gone.
 * The sandbox UI session loop gets the same tick: a cookie that expired during
 * sleep is re-minted now instead of whenever its timer catches up.
 */
function wirePowerMonitor(): void {
  const emit = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('system:resume')
    }
  }
  powerMonitor.on('resume', emit)
  powerMonitor.on('unlock-screen', emit)
  powerMonitor.on('resume', notifySandboxUiHostResumed)
  powerMonitor.on('unlock-screen', notifySandboxUiHostResumed)
}

/** Push native window state to the renderer on every visibility/focus change. */
function wireWindowVisibility(win: BrowserWindow): void {
  const emit = () => {
    if (win.isDestroyed()) return
    win.webContents.send('window:visibility', windowState(win))
  }
  win.on('show', emit)
  win.on('hide', emit)
  win.on('minimize', emit)
  win.on('restore', emit)
}

function wireWindowControls(win: BrowserWindow): void {
  const emit = () => emitWindowControlsState(win)
  win.on('maximize', emit)
  win.on('unmaximize', emit)
  win.on('enter-full-screen', emit)
  win.on('leave-full-screen', emit)
  win.on('restore', emit)
}

/**
 * App-level focus events are process-scoped. Register them once so closing and
 * recreating the main window cannot accumulate listeners that retain a
 * destroyed WebContents instance.
 */
function wireAppWindowVisibility(): void {
  if (appWindowVisibilityWired) return
  appWindowVisibilityWired = true
  const emit = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('window:visibility', windowState(mainWindow))
  }
  app.on('browser-window-focus', emit)
  app.on('browser-window-blur', emit)
}

ipcMain.handle('window:getVisibility', event => {
  // Same trusted-sender invariant as every handler in ipc.ts (defense in depth,
  // even for a read-only boolean getter).
  assertTrustedSender(event)
  return windowState(mainWindow)
})

ipcMain.handle('window:getControlsState', event => {
  assertTrustedSender(event)
  return windowControlsState(mainWindow)
})

ipcMain.handle('window:minimize', event => {
  assertTrustedSender(event)
  mainWindow?.minimize()
})

ipcMain.handle('window:toggleMaximize', event => {
  assertTrustedSender(event)
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isFullScreen()) {
    mainWindow.setFullScreen(false)
  } else if (mainWindow.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow.maximize()
  }
  emitWindowControlsState(mainWindow)
})

ipcMain.handle('window:close', event => {
  assertTrustedSender(event)
  mainWindow?.close()
})

ipcMain.handle('app:rendererReady', (event, payload: unknown) => {
  assertTrustedSender(event)
  if (!mainWindow || event.sender !== mainWindow.webContents) return
  if (
    event.senderFrame !== event.sender.mainFrame ||
    !currentRendererDocumentEpoch ||
    !currentRendererReadyChallenge ||
    !payload ||
    typeof payload !== 'object'
  )
    return
  mainWindowRendererReady = true
  if ((payload as Record<string, unknown>).challenge !== currentRendererReadyChallenge) {
    mainWindowRendererReady = false
    return
  }
  currentRendererReadyChallenge = null
  if (!appService.beginMarkdownTabCloseDocument(event.sender.id, currentRendererDocumentEpoch)) {
    mainWindowRendererReady = false
    return
  }
  while (pendingSessionClearedNotifications > 0) {
    pendingSessionClearedNotifications -= 1
    mainWindow.webContents.send('auth:sessionCleared')
  }
  emitWindowControlsState(mainWindow)
  evenfireDeepLinkRouter.drainPending()
  // U5: flush mcp-oauth completions that arrived before the renderer installed
  // its listener (cold start). The onMcpOauthCompleted listener is registered by
  // useAppController's effect, which runs before App's rendererReady effect, so
  // it is guaranteed installed by the time this handshake fires.
  mcpOauthCompletionQueue.drain()
  return {
    documentEpoch: currentRendererDocumentEpoch,
    sessionTransitionRevealPending,
  }
})

ipcMain.handle('auth:getRendererSessionView', async event => {
  assertTrustedSender(event)
  const window = mainWindow
  const documentEpoch = currentRendererDocumentEpoch
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== event.sender.mainFrame ||
    !mainWindowRendererReady ||
    !documentEpoch
  )
    return null
  const preclearReceiptReady = await appService.waitForSessionPreclearRendererReceipt()
  if (!preclearReceiptReady) return null
  if (
    mainWindow !== window ||
    currentRendererDocumentEpoch !== documentEpoch ||
    event.senderFrame !== event.sender.mainFrame ||
    !mainWindowRendererReady
  )
    return null
  const state = await appService.getSessionState()
  if (
    mainWindow !== window ||
    currentRendererDocumentEpoch !== documentEpoch ||
    event.senderFrame !== event.sender.mainFrame ||
    !state.authorityBinding ||
    !appService.isSessionAuthorityBindingCurrent(state.authorityBinding)
  )
    return null
  const receiptId = randomUUID()
  currentRendererSessionViewReceipt = {
    documentEpoch,
    receiptId,
    sessionGeneration: state.sessionGeneration ?? appService.getSessionGeneration(),
    authenticated: state.authenticated,
    userId: state.me?.id ?? null,
    teamId: state.me?.teamId ?? null,
    authorityBinding: state.authorityBinding,
  }
  return { documentEpoch, receiptId, state }
})

ipcMain.handle('auth:commitRendererSessionView', async (event, payload: unknown) => {
  assertTrustedSender(event)
  const window = mainWindow
  const receipt = currentRendererSessionViewReceipt
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== event.sender.mainFrame ||
    !receipt ||
    !payload ||
    typeof payload !== 'object' ||
    (payload as Record<string, unknown>).documentEpoch !== receipt.documentEpoch ||
    (payload as Record<string, unknown>).receiptId !== receipt.receiptId ||
    currentRendererDocumentEpoch !== receipt.documentEpoch
  )
    return false
  const state = await appService.getSessionState()
  if (
    mainWindow !== window ||
    currentRendererSessionViewReceipt !== receipt ||
    currentRendererDocumentEpoch !== receipt.documentEpoch ||
    event.senderFrame !== event.sender.mainFrame ||
    state.sessionGeneration !== receipt.sessionGeneration ||
    state.authenticated !== receipt.authenticated ||
    (state.me?.id ?? null) !== receipt.userId ||
    (state.me?.teamId ?? null) !== receipt.teamId ||
    !state.authorityBinding ||
    !appService.isSessionAuthorityBindingCurrent(state.authorityBinding) ||
    !sameSessionAuthorityBinding(state.authorityBinding, receipt.authorityBinding)
  )
    return false
  if (!appService.completeSessionPreclearRendererReceipt(state.authorityBinding)) return false
  currentRendererSessionViewReceipt = null
  if (sessionTransitionRevealPending && !forceFreshRendererAfterSessionClear) {
    sessionTransitionRevealPending = false
    if (pendingMarkdownDraftLossNotification) {
      pendingMarkdownDraftLossNotification = false
      window.webContents.send('auth:markdownDraftLost')
    }
    window.show()
  }
  return true
})

ipcMain.handle('sandboxUi:listPendingDeepLinks', event => {
  assertTrustedSender(event)
  return { links: sandboxUiDeepLinkQueue.list() }
})

ipcMain.handle('sandboxUi:clearPendingDeepLinks', event => {
  assertTrustedSender(event)
  sandboxUiDeepLinkQueue.clear()
})

ipcMain.handle('gfs:listPendingDeepLinks', event => {
  assertTrustedSender(event)
  return { links: gfsResourceDeepLinkQueue.list() }
})

function isTrustedGfsNavigationSender(event: IpcMainEvent): boolean {
  try {
    assertTrustedSender(event)
  } catch {
    return false
  }
  return Boolean(mainWindow && event.sender === mainWindow.webContents)
}

ipcMain.on('gfs:getUserNavigationGeneration', event => {
  if (!isTrustedGfsNavigationSender(event)) {
    event.returnValue = null
    return
  }
  event.returnValue = gfsUserNavigationGeneration.current()
})

ipcMain.on('gfs:advanceUserNavigationGeneration', event => {
  if (!isTrustedGfsNavigationSender(event)) {
    event.returnValue = null
    return
  }
  event.returnValue = gfsUserNavigationGeneration.advance()
})

ipcMain.handle('gfs:clearPendingDeepLinks', event => {
  assertTrustedSender(event)
  return gfsResourceDeepLinkQueue.clear()
})

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

const mainWindowCoordinator = createMainWindowCoordinator<BrowserWindow>({
  createWindow,
  focusWindow: focusMainWindow,
  getWindow: () => mainWindow,
})

function requestMainWindow(): void {
  if (!mainWindowLifecycleReady || !app.isReady()) return
  void mainWindowCoordinator.ensureWindow().catch(error => {
    console.error('[Desktop] Could not create the main window for a deep link:', error)
  })
}

function handleSandboxUiDeepLink(rawUrl: string): boolean {
  const target = parseSandboxUiDeepLink(rawUrl)
  if (!target) return false

  // Coalesce only while the same semantic target is awaiting renderer
  // acknowledgement. Query-parameter order cannot bypass this check, and once
  // acknowledged, an immediate user re-click creates a fresh envelope.
  const envelope = sandboxUiDeepLinkQueue.enqueue(target, gfsUserNavigationGeneration.current())
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sandboxUi:deepLink', envelope)
  }
  requestMainWindow()
  return true
}

function handleGfsResourceDeepLink(rawUrl: string): boolean {
  const target = parseGfsResourceDeepLink(rawUrl)
  if (!target) return false
  const envelope = gfsResourceDeepLinkQueue.enqueue(target, gfsUserNavigationGeneration.current())
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('gfs:deepLink', envelope)
  }
  requestMainWindow()
  return true
}

const evenfireDeepLinkRouter = createEvenfireDeepLinkRouter<BrowserWindow>({
  appProtocol: DESKTOP_SETUP_PROTOCOL,
  focusMainWindow,
  getWindow: () => mainWindow,
  handleSandboxUiDeepLink,
  handleGfsResourceDeepLink,
  gfsResourceDeepLinkHost: GFS_RESOURCE_DEEP_LINK_HOST,
  isRendererReady: () => mainWindowRendererReady,
  logout: logoutAndClearGfsResourceDeepLinks,
  requestMainWindow,
  sandboxUiDeepLinkHost: SANDBOX_UI_DEEP_LINK_HOST,
  shouldAcceptSandboxUiProtocolLink,
  shouldAcceptGfsResourceProtocolLink: rawUrl => parseGfsResourceDeepLink(rawUrl) !== null,
})

function registerCustomProtocols(): void {
  // In dev mode (`electron .`), Electron needs the explicit execPath +
  // script-path argument vector to relaunch correctly when the OS hands a
  // deep link to the registered protocol.
  if (process.defaultApp && process.argv.length >= 2) {
    const argv = [path.resolve(process.argv[1] || '')]
    app.setAsDefaultProtocolClient(DESKTOP_SETUP_PROTOCOL, process.execPath, argv)
    app.setAsDefaultProtocolClient(CLERUM_PROTOCOL, process.execPath, argv)
    return
  }
  app.setAsDefaultProtocolClient(DESKTOP_SETUP_PROTOCOL)
  app.setAsDefaultProtocolClient(CLERUM_PROTOCOL)
}

/**
 * Spec §9.9 — `clerum://oauth-completed?clientId=…&provider=…` is the
 * deep link the control-api OAuth callback's success page bounces to.
 * Forward the envelope to the active sandbox-ui embed; recipe JS
 * subscribes via `clerum.onOauthCompleted(callback)` exposed from the
 * embed preload. Silently ignore other clerum: URLs — the
 * `clerum://oauth?…` form is handled inside the embed driver, never at
 * the OS-protocol-handler level.
 */
function handleClerumUrl(rawUrl: string): void {
  // U5 (mcp-oauth reactive consent): the routing decision — which producer this
  // deep link came from — lives in the pure, unit-tested `routeClerumOauthCompleted`.
  // The sandbox-ui path (source absent / !== 'mcp') is byte-identical to before.
  const route = routeClerumOauthCompleted(rawUrl, CLERUM_PROTOCOL)
  if (route.kind === 'ignore') return

  if (route.kind === 'mcp') {
    // An mcp-server OAuth completion resumes the suspended conversation: forward
    // `mcpServerName` (the correlation key, self-describing on the deep-link) to
    // the renderer, which matches it against its suspended entries and re-fires
    // the approval/resume RPC. It does NOT dispatch to the sandbox-ui embed.
    // Queued when the renderer is not yet ready (cold start) so it is never
    // swallowed before `onMcpOauthCompleted` is installed.
    mcpOauthCompletionQueue.submit({
      mcpServerName: route.mcpServerName,
      provider: route.provider,
    })
    focusMainWindow()
    return
  }

  void (async () => {
    const driver = await import('./sandboxUiDriver.js')
    driver.dispatchSandboxUiOauthCompleted({
      oauthClientId: route.oauthClientId,
      provider: route.provider,
    })
  })()

  focusMainWindow()
}

// An isolated run leaves the machine-wide default handler exactly as it is: the
// normal app keeps owning `evenfire:`/`clerum:` deep links.
let registerOsProtocols = false
try {
  registerOsProtocols =
    devIsolationPolicy.registerOsProtocols &&
    shouldRegisterOsProtocols(process.argv, app.isPackaged)
} catch (error) {
  console.error(
    `[Desktop] ${error instanceof Error ? error.message : 'Protocol registration refused'}`
  )
  process.exit(1)
}
if (registerOsProtocols) {
  registerCustomProtocols()
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    // An isolated instance never routes deep links: a URL delivered here belongs
    // to the session that owns the OS handler, not to this one. A relaunch still
    // brings this instance's window forward.
    if (devIsolationPolicy.acceptDeepLinks) {
      const protocolUrls = collectInitialProtocolUrls(argv)
      protocolUrls.evenfireUrls.forEach(evenfireDeepLinkRouter.handle)
      protocolUrls.clerumUrls.forEach(handleClerumUrl)
    }
    requestMainWindow()
  })
}

if (devIsolationPolicy.acceptDeepLinks) {
  app.on('open-url', (event, rawUrl) => {
    event.preventDefault()
    const lowerUrl = rawUrl.toLowerCase()
    if (lowerUrl.startsWith(`${DESKTOP_SETUP_PROTOCOL}:`)) {
      evenfireDeepLinkRouter.handle(rawUrl)
    } else if (lowerUrl.startsWith(`${CLERUM_PROTOCOL}:`)) {
      handleClerumUrl(rawUrl)
    }
  })
}

/**
 * Verify the effective runtime against the launcher's declaration and log the
 * public metadata for this run. Returns false when the process must abort:
 * continuing would use a profile the operator did not ask for.
 *
 * Paths are compared after `realpath`, so a symlinked parent cannot fake a
 * match, and the config storage path is compared exactly — it is the proof that
 * the runtime-config layer pointed at the isolated file rather than the shared
 * `runtime-configs` directory.
 */
function verifyDevIsolationBeforeServices(plan: DevIsolationPlan): boolean {
  hydrateDesktopRuntimeConfig()
  const runtimeState = getDesktopRuntimeConfigState()
  const realPath = (value: string): string => {
    try {
      return fs.realpathSync.native(value)
    } catch {
      return path.resolve(value)
    }
  }
  const observed = {
    pid: process.pid,
    userDataDir: realPath(app.getPath('userData')),
    appPath: realPath(app.getAppPath()),
    restUrl: config.externalRestApiBaseUrl,
    rpcUrl: config.rpcProxyBaseUrl,
    configStoragePath: runtimeState.storagePath,
    envKey: getActiveEnvKey(),
  }
  const expected: DevIsolationPlan = {
    ...plan,
    userDataDir: realPath(plan.userDataDir),
    appPath: plan.appPath ? realPath(plan.appPath) : null,
  }
  const verdict = verifyDevIsolationRuntime(expected, observed)
  if (verdict.ok) {
    console.log(formatDevIsolationLogLine(publicDevIsolationRecord(expected, observed)))
    return true
  }
  const detail = verdict.mismatches.map(mismatch => mismatch.field).join(', ')
  console.error(
    `[Desktop] Dev isolation refused: the effective runtime diverges from the launcher: ${detail}`
  )
  app.exit(1)
  return false
}

async function createWindow(): Promise<void> {
  try {
    // Initialization is process-scoped. A failed attempt remains retryable when
    // the user recreates the window, while a successful attempt is never repeated.
    await appServiceInitializer.ensureInitialized()
  } catch (error) {
    console.error('[Desktop] Could not initialize the desktop session:', error)
  }

  const devUrl = String(process.env.EVENFIRE_RENDERER_URL || '').trim()

  const window = new BrowserWindow({
    width: 1240,
    height: 860,
    show: false,
    frame: false,
    roundedCorners: mainWindowRoundedCorners(),
    title:
      devIsolationPolicy.windowTitle ??
      (config.appName === EVENFIRE_APP_NAME
        ? EVENFIRE_APP_NAME
        : `${EVENFIRE_APP_NAME} — ${config.appName}`),
    icon: resolveSystemIconPath(systemIconAssetsDirectory(), nativeTheme.shouldUseDarkColors),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  mainWindow = window
  if (devIsolationPolicy.pinWindowTitle) {
    // Keep the isolated identity in the window title after the renderer updates
    // document.title: window/app automation resolves this instance by it.
    window.webContents.on('page-title-updated', event => {
      event.preventDefault()
      window.setTitle(devIsolationPolicy.windowTitle ?? window.getTitle())
    })
  }
  wireHostDesktopShortcutRouting(window)
  mainWindowRendererReady = false
  window.on('closed', () => {
    if (mainWindow === window) {
      retireCurrentMarkdownRendererDocument()
      mainWindow = null
      mainWindowRendererReady = false
    }
  })
  wireMainWindowRendererReadiness({
    webContents: window.webContents,
    isCurrentWindow: () => mainWindow === window,
    markNotReady: () => {
      mainWindowRendererReady = false
    },
    sandboxUi: appService,
  })
  window.webContents.on('did-navigate', () => {
    if (mainWindow !== window || window.isDestroyed()) return
    retireCurrentMarkdownRendererDocument()
    const documentEpoch = randomUUID()
    const challenge = randomUUID()
    currentRendererDocumentEpoch = documentEpoch
    currentRendererReadyChallenge = challenge
    try {
      window.webContents.mainFrame.send('auth:markdownDocumentHandshake', {
        documentEpoch,
        challenge,
      })
    } catch {
      currentRendererReadyChallenge = null
    }
  })
  window.webContents.on('render-process-gone', () => {
    if (mainWindow !== window) return
    for (const transitionId of activeSessionPreclearTransitions) {
      sessionPreclearRendererLost.add(transitionId)
    }
    retireCurrentMarkdownRendererDocument()
  })

  wireWindowVisibility(window)
  wireWindowControls(window)
  wireAppWindowVisibility()

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    const allowFile = url.startsWith('file://')
    const allowDev = Boolean(devUrl) && url.startsWith(devUrl)
    if (!allowFile && !allowDev) {
      event.preventDefault()
    }
  })

  try {
    if (devUrl) {
      await window.loadURL(devUrl)
    } else {
      const htmlPath = path.join(__dirname, '../ui-dist/index.html')
      await window.loadFile(htmlPath)
    }
  } catch (error) {
    if (mainWindow === window) {
      mainWindow = null
      mainWindowRendererReady = false
    }
    if (!window.isDestroyed()) window.destroy()
    throw error
  }
  // Open maximized by default; users can manually resize afterward.
  window.maximize()
  // Show window after successful load to avoid hidden-startup deadlocks.
  window.show()
  window.once('ready-to-show', () => {
    if (window.isDestroyed()) return
    window.maximize()
    window.show()
  })
}

if (gotSingleInstanceLock) {
  app
    .whenReady()
    .then(async () => {
      // Before any service initializes: an isolated run that cannot prove its
      // own userData, app path, endpoints and config storage is the declared
      // isolated ones aborts instead of reading a shared profile.
      if (devIsolationPlan && !verifyDevIsolationBeforeServices(devIsolationPlan)) return
      installDesktopTextContextMenus()
      wireAdaptiveSystemIcon()
      // Must precede registerIpcHandlers: the SDK IPC handlers resolve the
      // runtime eagerly on first call, and a plugin can be mounted the moment
      // the window paints.
      initPluginSdkRuntime({ service: appService, getMainWindow: () => mainWindow })
      registerIpcHandlers(appService, logoutAndClearGfsResourceDeepLinks, () => mainWindow)
      mainWindowLifecycleReady = true
      wirePowerMonitor()
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          requestMainWindow()
        }
      })
      // Collect startup argv once. The renderer-ready handshake drains queued
      // Evenfire URLs after its listeners are installed; rescanning argv would
      // dispatch setup links twice on Windows/Linux.
      // An isolated run collects nothing: its argv cannot contain a deep link
      // that belongs to this session.
      const initialProtocolUrls = devIsolationPolicy.acceptDeepLinks
        ? collectInitialProtocolUrls(process.argv)
        : { evenfireUrls: [], clerumUrls: [] }
      initialProtocolUrls.evenfireUrls.forEach(evenfireDeepLinkRouter.enqueuePending)
      await mainWindowCoordinator.ensureWindow()
      if (devIsolationPolicy.acceptDeepLinks && process.platform !== 'darwin') {
        initialProtocolUrls.clerumUrls.forEach(handleClerumUrl)
      }
    })
    .catch(error => {
      mainWindowLifecycleReady = app.isReady()
      console.error('[Desktop] Startup failed before the main window was ready:', error)
      requestMainWindow()
    })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
