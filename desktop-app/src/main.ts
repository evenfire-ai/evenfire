import { BrowserWindow, app, ipcMain, nativeTheme, powerMonitor } from 'electron'
import path from 'node:path'
import { AppService } from './appService.js'
import { config } from './config.js'
import { assertTrustedSender, registerIpcHandlers } from './ipc.js'
import { createMainWindowCoordinator } from './mainWindowCoordinator.js'
import { type SandboxUiDeepLinkEnvelope, parseSandboxUiDeepLink } from './sandboxUiDeepLinks.js'
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
const pendingSandboxUiDeepLinks: SandboxUiDeepLinkEnvelope[] = []
let sandboxUiDeepLinkSequence = 0
let lastSandboxUiDeepLink: { rawUrl: string; receivedAt: number } | null = null
let mainWindowLifecycleReady = false

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

/** Push window visibility to the renderer on every show/hide/minimize/focus change. */
function wireWindowVisibility(win: BrowserWindow): void {
  const emit = () => {
    if (win.isDestroyed()) return
    win.webContents.send('window:visibility', { visible: isWindowVisible(win) })
  }
  win.on('show', emit)
  win.on('hide', emit)
  win.on('minimize', emit)
  win.on('restore', emit)
  win.on('focus', emit)
  win.on('blur', emit)
}

ipcMain.handle('window:getVisibility', event => {
  // Same trusted-sender invariant as every handler in ipc.ts (defense in depth,
  // even for a read-only boolean getter).
  assertTrustedSender(event)
  return { visible: isWindowVisible(mainWindow) }
})

ipcMain.handle('sandboxUi:listPendingDeepLinks', event => {
  assertTrustedSender(event)
  return { links: [...pendingSandboxUiDeepLinks] }
})

ipcMain.handle('sandboxUi:acknowledgeDeepLink', (event, payload: { id?: unknown }) => {
  assertTrustedSender(event)
  const id = Number(payload?.id)
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid app deep-link id')
  const index = pendingSandboxUiDeepLinks.findIndex(link => link.id === id)
  if (index >= 0) pendingSandboxUiDeepLinks.splice(index, 1)
})
const DESKTOP_SETUP_PROTOCOL = 'evenfire'
const CLERUM_PROTOCOL = 'clerum'

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

function findProtocolUrl(argv: string[], protocol: string): string | undefined {
  return argv.find(arg => arg.startsWith(`${protocol}://`))
}

function handleSandboxUiDeepLink(rawUrl: string): boolean {
  const target = parseSandboxUiDeepLink(rawUrl)
  if (!target) return false

  const now = Date.now()
  if (lastSandboxUiDeepLink?.rawUrl === rawUrl && now - lastSandboxUiDeepLink.receivedAt < 1_000) {
    requestMainWindow()
    return true
  }
  lastSandboxUiDeepLink = { rawUrl, receivedAt: now }

  const envelope: SandboxUiDeepLinkEnvelope = {
    id: (sandboxUiDeepLinkSequence += 1),
    ...target,
  }
  pendingSandboxUiDeepLinks.push(envelope)
  if (pendingSandboxUiDeepLinks.length > 20) pendingSandboxUiDeepLinks.shift()
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

  if (parsed.hostname === 'app') {
    handleSandboxUiDeepLink(rawUrl)
    return
  }

  if (parsed.hostname === 'logout') {
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

  if (parsed.hostname === 'desktop-environment') {
    const externalRestApiBaseUrl = parsed.searchParams.get('externalRestApiBaseUrl') || ''
    const appName =
      parsed.searchParams.get('tenantName') || parsed.searchParams.get('appName') || ''
    if (!externalRestApiBaseUrl) return

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
      mainWindow.webContents.send('auth:desktopEnvironmentSetup', {
        externalRestApiBaseUrl,
        appName,
      })
    } else {
      pendingEvenfireUrls.push(rawUrl)
      requestMainWindow()
    }
    return
  }

  if (parsed.hostname !== 'desktop-setup') return

  const email = parsed.searchParams.get('email') || ''
  const authorizationToken = parsed.searchParams.get('authorizationToken') || ''
  if (!email || !authorizationToken) return

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send('auth:desktopSetupToken', { email, authorizationToken })
  } else {
    pendingEvenfireUrls.push(rawUrl)
    requestMainWindow()
  }
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
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return
  }
  if (parsed.protocol !== `${CLERUM_PROTOCOL}:`) return
  if (parsed.hostname !== 'oauth-completed') return

  const oauthClientId = parsed.searchParams.get('clientId') || ''
  const provider = parsed.searchParams.get('provider') || ''
  if (!oauthClientId) return

  void (async () => {
    const driver = await import('./sandboxUiDriver.js')
    driver.dispatchSandboxUiOauthCompleted({ oauthClientId, provider })
  })()

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
}

registerCustomProtocols()

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const desktopSetupLink = argv.find(arg => arg.startsWith(`${DESKTOP_SETUP_PROTOCOL}://`))
    if (desktopSetupLink) handleEvenfireUrl(desktopSetupLink)
    const clerumLink = argv.find(arg => arg.startsWith(`${CLERUM_PROTOCOL}://`))
    if (clerumLink) handleClerumUrl(clerumLink)
    requestMainWindow()
  })
}

app.on('open-url', (event, rawUrl) => {
  event.preventDefault()
  if (rawUrl.startsWith(`${DESKTOP_SETUP_PROTOCOL}:`)) {
    handleEvenfireUrl(rawUrl)
  } else if (rawUrl.startsWith(`${CLERUM_PROTOCOL}:`)) {
    handleClerumUrl(rawUrl)
  }
})

async function createWindow(): Promise<void> {
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
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  wireWindowVisibility(window)

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    const allowFile = url.startsWith('file://')
    const allowDev = Boolean(devUrl) && url.startsWith(devUrl)
    if (!allowFile && !allowDev) {
      event.preventDefault()
    }
  })

  if (devUrl) {
    await window.loadURL(devUrl)
  } else {
    const htmlPath = path.join(__dirname, '../ui-dist/index.html')
    await window.loadFile(htmlPath)
  }
  // Open maximized by default; users can manually resize afterward.
  window.maximize()
  // Show window after successful load to avoid hidden-startup deadlocks.
  window.show()
  if (process.platform !== 'darwin') {
    const initialEvenfireUrl = findProtocolUrl(process.argv, DESKTOP_SETUP_PROTOCOL)
    if (initialEvenfireUrl) handleEvenfireUrl(initialEvenfireUrl)
    const initialClerumUrl = findProtocolUrl(process.argv, CLERUM_PROTOCOL)
    if (initialClerumUrl) handleClerumUrl(initialClerumUrl)
  }
  while (pendingEvenfireUrls.length > 0) {
    const pendingUrl = pendingEvenfireUrls.shift()
    if (pendingUrl) handleEvenfireUrl(pendingUrl)
  }
  window.once('ready-to-show', () => {
    if (window.isDestroyed()) return
    window.maximize()
    window.show()
  })
}

if (gotSingleInstanceLock) {
  app.whenReady().then(async () => {
    wireAdaptiveSystemIcon()
    registerIpcHandlers(appService)
    // AppService belongs to the process, not a BrowserWindow. Initialize it once
    // so recreating a closed macOS window does not repeat session network I/O.
    await appService.initialize()
    mainWindowLifecycleReady = true
    for (const arg of process.argv) {
      if (arg.startsWith(`${DESKTOP_SETUP_PROTOCOL}://`)) {
        pendingEvenfireUrls.push(arg)
      }
    }
    await mainWindowCoordinator.ensureWindow()
    wirePowerMonitor()

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await mainWindowCoordinator.ensureWindow()
      }
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
