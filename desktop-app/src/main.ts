import { BrowserWindow, app, ipcMain, nativeTheme, powerMonitor } from 'electron'
import path from 'node:path'
import { AppService } from './appService.js'
import { routeClerumOauthCompleted } from './clerumDeepLink.js'
import { config } from './config.js'
import { assertTrustedSender, registerIpcHandlers } from './ipc.js'
import { createMainWindowCoordinator, createRetryableInitializer } from './mainWindowCoordinator.js'
import { wireMainWindowRendererReadiness } from './mainWindowReadiness.js'
import { McpOauthCompletionQueue } from './mcpOauthCompletionQueue.js'
import { collectInitialProtocolUrls } from './protocolLaunchArgs.js'
import { SandboxUiDeepLinkQueue } from './sandboxUiDeepLinkQueue.js'
import {
  CLERUM_OAUTH_PROTOCOL,
  SANDBOX_UI_DEEP_LINK_HOST,
  SANDBOX_UI_DEEP_LINK_PROTOCOL,
  parseSandboxUiDeepLink,
} from './sandboxUiDeepLinks.js'
import { shouldAcceptSandboxUiProtocolLink } from './sandboxUiProtocolWindowPolicy.js'
import { installAdaptiveSystemIcon, resolveSystemIconPath } from './systemIcon.js'

const EVENFIRE_APP_NAME = 'Evenfire'
const EVENFIRE_APP_ID = 'ai.evenfire.desktop'

process.title = EVENFIRE_APP_NAME
app.setName(EVENFIRE_APP_NAME)
app.setAppUserModelId(EVENFIRE_APP_ID)

// Prevent crash on EPIPE when stdout/stderr pipe is broken (e.g., parent terminal closed)
process.stdout?.on?.('error', () => {})
process.stderr?.on?.('error', () => {})

let mainWindow: BrowserWindow | null = null
const appService = new AppService()
const pendingEvenfireUrls: string[] = []
const MAX_PENDING_EVENFIRE_URLS = 20
const sandboxUiDeepLinkQueue = new SandboxUiDeepLinkQueue()
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

function enqueuePendingEvenfireUrl(rawUrl: string): void {
  if (pendingEvenfireUrls.includes(rawUrl)) return
  pendingEvenfireUrls.push(rawUrl)
  if (pendingEvenfireUrls.length > MAX_PENDING_EVENFIRE_URLS) {
    pendingEvenfireUrls.shift()
  }
}

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

/**
 * GAP-D1 (spec-v2 §4.5-4): after the OS sleeps/resumes (or the screen locks and
 * unlocks), open SSE sockets are typically dead but neither the tracker watchdog
 * nor the bridge reconnect has noticed yet. Broadcast a `system:resume` tick so
 * the renderer reconciles every chat with an in-flight task and re-attaches dead
 * streams — the 30s watchdog stays as a slower safety net. No payload: the
 * renderer decides which chats to reconcile from its own FSM. Registered once,
 * app-wide (not per-window); `send` is a no-op when the webContents is gone.
 */
function wirePowerMonitor(): void {
  const emit = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('system:resume')
    }
  }
  powerMonitor.on('resume', emit)
  powerMonitor.on('unlock-screen', emit)
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

ipcMain.handle('app:rendererReady', event => {
  assertTrustedSender(event)
  if (!mainWindow || event.sender !== mainWindow.webContents) return
  mainWindowRendererReady = true
  drainPendingEvenfireUrls()
  // U5: flush mcp-oauth completions that arrived before the renderer installed
  // its listener (cold start). The onMcpOauthCompleted listener is registered by
  // useAppController's effect, which runs before App's rendererReady effect, so
  // it is guaranteed installed by the time this handshake fires.
  mcpOauthCompletionQueue.drain()
})

ipcMain.handle('sandboxUi:listPendingDeepLinks', event => {
  assertTrustedSender(event)
  return { links: sandboxUiDeepLinkQueue.list() }
})

ipcMain.handle('sandboxUi:clearPendingDeepLinks', event => {
  assertTrustedSender(event)
  sandboxUiDeepLinkQueue.clear()
})

ipcMain.handle('sandboxUi:acknowledgeDeepLink', (event, payload: { id?: unknown }) => {
  assertTrustedSender(event)
  const id = Number(payload?.id)
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid app deep-link id')
  sandboxUiDeepLinkQueue.acknowledge(id)
})
const DESKTOP_SETUP_PROTOCOL = SANDBOX_UI_DEEP_LINK_PROTOCOL.replace(/:$/, '')
const CLERUM_PROTOCOL = CLERUM_OAUTH_PROTOCOL.replace(/:$/, '')

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
  const envelope = sandboxUiDeepLinkQueue.enqueue(target)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sandboxUi:deepLink', envelope)
  }
  requestMainWindow()
  return true
}

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

function handleEvenfireUrl(rawUrl: string): void {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return
  }
  if (parsed.protocol !== `${DESKTOP_SETUP_PROTOCOL}:`) {
    return
  }

  const hostname = parsed.hostname.toLowerCase()
  if (hostname === SANDBOX_UI_DEEP_LINK_HOST) {
    if (!shouldAcceptSandboxUiProtocolLink(rawUrl)) return
    handleSandboxUiDeepLink(rawUrl)
    return
  }

  if (hostname === 'logout') {
    void appService.logout().finally(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
        mainWindow.webContents.send('auth:externalLogout')
      }
    })
    return
  }

  if (hostname === 'desktop-environment') {
    const externalRestApiBaseUrl = parsed.searchParams.get('externalRestApiBaseUrl') || ''
    const appName =
      parsed.searchParams.get('tenantName') || parsed.searchParams.get('appName') || ''
    if (!externalRestApiBaseUrl) return

    if (mainWindow && !mainWindow.isDestroyed() && mainWindowRendererReady) {
      focusMainWindow()
      mainWindow.webContents.send('auth:desktopEnvironmentSetup', {
        externalRestApiBaseUrl,
        appName,
      })
    } else {
      enqueuePendingEvenfireUrl(rawUrl)
      requestMainWindow()
    }
    return
  }

  if (hostname !== 'desktop-setup') return

  const email = parsed.searchParams.get('email') || ''
  const authorizationToken = parsed.searchParams.get('authorizationToken') || ''
  if (!email || !authorizationToken) return

  if (mainWindow && !mainWindow.isDestroyed() && mainWindowRendererReady) {
    focusMainWindow()
    mainWindow.webContents.send('auth:desktopSetupToken', { email, authorizationToken })
  } else {
    enqueuePendingEvenfireUrl(rawUrl)
    requestMainWindow()
  }
}

function drainPendingEvenfireUrls(): void {
  if (!mainWindowRendererReady) return
  const pendingBatch = pendingEvenfireUrls.splice(0)
  pendingBatch.forEach(handleEvenfireUrl)
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

registerCustomProtocols()

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const protocolUrls = collectInitialProtocolUrls(argv)
    protocolUrls.evenfireUrls.forEach(handleEvenfireUrl)
    protocolUrls.clerumUrls.forEach(handleClerumUrl)
    requestMainWindow()
  })
}

app.on('open-url', (event, rawUrl) => {
  event.preventDefault()
  const lowerUrl = rawUrl.toLowerCase()
  if (lowerUrl.startsWith(`${DESKTOP_SETUP_PROTOCOL}:`)) {
    handleEvenfireUrl(rawUrl)
  } else if (lowerUrl.startsWith(`${CLERUM_PROTOCOL}:`)) {
    handleClerumUrl(rawUrl)
  }
})

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
    title:
      config.appName === EVENFIRE_APP_NAME
        ? EVENFIRE_APP_NAME
        : `${EVENFIRE_APP_NAME} — ${config.appName}`,
    icon: resolveSystemIconPath(systemIconAssetsDirectory(), nativeTheme.shouldUseDarkColors),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  mainWindow = window
  mainWindowRendererReady = false
  window.on('closed', () => {
    if (mainWindow === window) {
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
  })

  wireWindowVisibility(window)
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
      wireAdaptiveSystemIcon()
      registerIpcHandlers(appService)
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
      const initialProtocolUrls = collectInitialProtocolUrls(process.argv)
      initialProtocolUrls.evenfireUrls.forEach(enqueuePendingEvenfireUrl)
      await mainWindowCoordinator.ensureWindow()
      if (process.platform !== 'darwin') {
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
