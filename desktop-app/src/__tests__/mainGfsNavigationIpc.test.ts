import { beforeAll, describe, expect, it, vi } from 'vitest'
import { buildGfsResourceDeepLink } from '../gfsDeepLinks.js'

type MainEvent = {
  senderFrame: { url: string }
  sender: unknown
  returnValue?: unknown
}
type SyncHandler = (event: MainEvent) => void

const harness = vi.hoisted(() => {
  const state = {
    onHandlers: new Map<string, SyncHandler>(),
    handleHandlers: new Map<string, (event: MainEvent) => unknown>(),
    appListeners: new Map<string, (...args: unknown[]) => void>(),
    windows: [] as Array<Record<string, any>>,
    readyResolver: null as null | (() => void),
    initialize: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn(async () => 7),
    registeredLogout: null as null | (() => Promise<unknown>),
    createWindow: null as null | (() => Record<string, any>),
  }
  state.createWindow = () => {
    const window = {
      webContents: {
        id: 41,
        on: vi.fn(),
        send: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        loadFile: vi.fn().mockResolvedValue(undefined),
        loadURL: vi.fn().mockResolvedValue(undefined),
      },
      loadFile: vi.fn().mockResolvedValue(undefined),
      loadURL: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      once: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      isMinimized: vi.fn(() => false),
      isMaximized: vi.fn(() => false),
      isFullScreen: vi.fn(() => false),
      isFocused: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      maximize: vi.fn(),
      setTitle: vi.fn(),
      getTitle: vi.fn(() => 'Evenfire'),
      destroy: vi.fn(),
    }
    state.windows.push(window)
    return window
  }
  return state
})

vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor() {
      return harness.createWindow?.()
    }
    static getAllWindows() {
      return harness.windows
    }
    static fromWebContents(sender: unknown) {
      return harness.windows.find(window => window.webContents === sender) ?? null
    }
  },
  app: {
    dock: undefined,
    isPackaged: false,
    isReady: () => true,
    setName: vi.fn(),
    setAppUserModelId: vi.fn(),
    setAsDefaultProtocolClient: vi.fn(),
    requestSingleInstanceLock: () => true,
    whenReady: () =>
      new Promise<void>(resolve => {
        harness.readyResolver = resolve
      }),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      harness.appListeners.set(event, listener)
    }),
    quit: vi.fn(),
    exit: vi.fn(),
  },
  ipcMain: {
    on: vi.fn((channel: string, handler: SyncHandler) => {
      harness.onHandlers.set(channel, handler)
    }),
    handle: vi.fn((channel: string, handler: (event: MainEvent) => unknown) => {
      harness.handleHandlers.set(channel, handler)
    }),
    removeHandler: vi.fn(),
  },
  nativeTheme: { shouldUseDarkColors: false, on: vi.fn() },
  powerMonitor: { on: vi.fn() },
  Notification: vi.fn(),
  clipboard: { writeText: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
}))

vi.mock('../appService.js', () => ({
  AppService: class {
    initialize = harness.initialize
    logout = harness.logout
  },
}))
vi.mock('../config.js', () => ({
  config: { appName: 'Evenfire', externalRestApiBaseUrl: '', rpcProxyBaseUrl: '' },
  getActiveEnvKey: vi.fn(() => 'test'),
  getDesktopRuntimeConfigState: vi.fn(() => ({ storagePath: '' })),
  hydrateDesktopRuntimeConfig: vi.fn(),
}))
vi.mock('../desktopTextContextMenu.js', () => ({ installDesktopTextContextMenus: vi.fn() }))
vi.mock('../devIsolation.js', () => ({
  resolveDevIsolation: vi.fn(() => ({ mode: 'shared' })),
  devIsolationRuntimePolicy: vi.fn(() => ({
    appName: null,
    pinWindowTitle: false,
    acceptDeepLinks: true,
    registerOsProtocols: false,
  })),
  formatDevIsolationLogLine: vi.fn(),
  publicDevIsolationRecord: vi.fn(),
  verifyDevIsolationRuntime: vi.fn(() => ({ ok: true })),
}))
vi.mock('../ipc.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../ipc.js')>()
  return {
    ...actual,
    registerIpcHandlers: vi.fn((_service, logout: () => Promise<unknown>) => {
      harness.registeredLogout = logout
    }),
  }
})
vi.mock('../mainWindowReadiness.js', () => ({ wireMainWindowRendererReadiness: vi.fn() }))
vi.mock('../pluginSdkRuntime.js', () => ({ initPluginSdkRuntime: vi.fn() }))
vi.mock('../protocolLaunchArgs.js', () => ({
  collectInitialProtocolUrls: vi.fn(() => ({ evenfireUrls: [], clerumUrls: [] })),
  shouldRegisterOsProtocols: vi.fn(() => false),
}))
vi.mock('../sandboxUiDeepLinks.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../sandboxUiDeepLinks.js')>()
  return { ...actual, parseSandboxUiDeepLink: vi.fn(() => null) }
})
vi.mock('../sandboxUiProtocolWindowPolicy.js', () => ({
  shouldAcceptSandboxUiProtocolLink: vi.fn(() => false),
}))
vi.mock('../sandboxUiSessionRefresh.js', () => ({ notifySandboxUiHostResumed: vi.fn() }))
vi.mock('../shortcutRouter.js', () => ({ wireHostDesktopShortcutRouting: vi.fn() }))
vi.mock('../systemIcon.js', () => ({
  installAdaptiveSystemIcon: vi.fn(),
  resolveSystemIconPath: vi.fn(() => 'icon.png'),
}))
vi.mock('../clerumDeepLink.js', () => ({
  routeClerumOauthCompleted: vi.fn(() => ({ kind: 'ignore' })),
}))

function ipcEvent(sender: unknown, url = 'file:///app/index.html'): MainEvent {
  return { senderFrame: { url }, sender }
}

function registeredHandler<T extends (...args: never[]) => unknown>(
  handlers: Map<string, T>,
  channel: string
): T {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`Missing composed IPC handler: ${channel}`)
  return handler
}

describe('main.ts GFS navigation-generation composition', () => {
  beforeAll(async () => {
    await import('../main.js')
    harness.readyResolver?.()
    await vi.waitFor(() => {
      expect(harness.registeredLogout).toBeTypeOf('function')
      expect(harness.windows).toHaveLength(1)
    })
  })

  it('returns null for denied sync IPC without changing the generation', () => {
    const mainWindow = harness.windows[0]
    const ownContents = mainWindow?.webContents
    if (!ownContents) throw new Error('main.ts did not create the owning BrowserWindow')
    const getGeneration = registeredHandler(harness.onHandlers, 'gfs:getUserNavigationGeneration')
    const advanceGeneration = registeredHandler(
      harness.onHandlers,
      'gfs:advanceUserNavigationGeneration'
    )

    for (const denied of [
      ipcEvent({ id: 42 }, 'https://untrusted.example/'),
      ipcEvent({ id: 42 }),
    ]) {
      expect(() => getGeneration(denied)).not.toThrow()
      expect(denied.returnValue).toBeNull()
    }
    for (const denied of [
      ipcEvent({ id: 42 }, 'https://untrusted.example/'),
      ipcEvent({ id: 42 }),
    ]) {
      expect(() => advanceGeneration(denied)).not.toThrow()
      expect(denied.returnValue).toBeNull()
    }

    const ownerEvent = ipcEvent(ownContents)
    getGeneration(ownerEvent)
    expect(ownerEvent.returnValue).toBe(0)
  })

  it('composes generation stamping and logout purge through the real main router', async () => {
    const mainWindow = harness.windows[0]
    const ownContents = mainWindow?.webContents
    if (!ownContents) throw new Error('main.ts did not create the owning BrowserWindow')
    const getGeneration = registeredHandler(harness.onHandlers, 'gfs:getUserNavigationGeneration')
    const advanceGeneration = registeredHandler(
      harness.onHandlers,
      'gfs:advanceUserNavigationGeneration'
    )
    const listPending = registeredHandler(harness.handleHandlers, 'gfs:listPendingDeepLinks') as (
      event: MainEvent
    ) => { links: unknown[] }

    const ownerEvent = ipcEvent(ownContents)
    getGeneration(ownerEvent)
    expect(ownerEvent.returnValue).toBe(0)
    const advanceEvent = ipcEvent(ownContents)
    advanceGeneration(advanceEvent)
    expect(advanceEvent.returnValue).toBe(1)

    const openUrl = harness.appListeners.get('open-url')
    if (!openUrl) throw new Error('main.ts did not register the OS deep-link route')
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    openUrl({ preventDefault: vi.fn() }, buildGfsResourceDeepLink(uri))
    expect(listPending(ipcEvent(ownContents)).links).toEqual([
      { id: 1, uri, userNavigationGenerationAtActivation: 1 },
    ])

    openUrl({ preventDefault: vi.fn() }, 'evenfire://logout')
    await vi.waitFor(() => {
      expect(
        ownContents.send.mock.calls.some(([channel]) => channel === 'auth:externalLogout')
      ).toBe(true)
    })
    expect(harness.logout).toHaveBeenCalledOnce()
    expect(listPending(ipcEvent(ownContents)).links).toEqual([])
    await expect(harness.registeredLogout?.()).resolves.toBe(7)
    expect(harness.logout).toHaveBeenCalledTimes(2)
    expect(listPending(ipcEvent(ownContents)).links).toEqual([])
  })
})
