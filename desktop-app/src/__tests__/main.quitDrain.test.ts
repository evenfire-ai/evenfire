import { beforeAll, describe, expect, it, vi } from 'vitest'

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
    nativeSet: vi.fn(),
    nativeGet: vi.fn(),
    nativeDelete: vi.fn(),
    sessionGeneration: 0,
    invalidateSandboxUiSession: null as null | (() => void),
    sessionCleared: null as null | (() => void),
    parseSandboxUiDeepLink: vi.fn(() => null),
    registeredLogout: null as null | (() => Promise<unknown>),
    createWindow: null as null | ((options?: Record<string, unknown>) => Record<string, any>),
  }
  state.createWindow = (options: Record<string, unknown> = {}) => {
    const window = {
      options,
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
    state.appListeners.get('browser-window-created')?.({}, window)
    return window
  }
  return state
})

vi.mock('keytar', () => ({
  getPassword: harness.nativeGet,
  setPassword: harness.nativeSet,
  deletePassword: harness.nativeDelete,
}))

vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor(options?: Record<string, unknown>) {
      return harness.createWindow?.(options)
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
    getPath: () => process.env.SPEC125_SCRATCH,
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
  safeStorage: { isEncryptionAvailable: () => false },
  nativeTheme: { shouldUseDarkColors: false, on: vi.fn() },
  powerMonitor: { on: vi.fn() },
  Notification: vi.fn(),
  clipboard: { writeText: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
}))

vi.mock('../appService.js', () => ({
  AppService: class {
    constructor(options?: {
      onSandboxUiSessionInvalidated?: () => void
      onSessionCleared?: () => void
    }) {
      harness.invalidateSandboxUiSession = options?.onSandboxUiSessionInvalidated ?? null
      harness.sessionCleared = options?.onSessionCleared ?? null
    }
    initialize = harness.initialize
    logout = harness.logout
    getSessionGeneration = () => harness.sessionGeneration
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
vi.mock('../protocolLaunchArgs.js', async importOriginal => {
  const original = await importOriginal<typeof import('../protocolLaunchArgs.js')>()
  return { ...original, shouldRegisterOsProtocols: vi.fn(() => false) }
})
vi.mock('../sandboxUiDeepLinks.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../sandboxUiDeepLinks.js')>()
  return { ...actual, parseSandboxUiDeepLink: harness.parseSandboxUiDeepLink }
})
vi.mock('../sandboxUiProtocolWindowPolicy.js', () => ({
  shouldAcceptSandboxUiProtocolLink: vi.fn(() => true),
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

describe('planned W reopen cancellation assertion', () => {
  beforeAll(async () => {
    await import('../main.ts')
    harness.readyResolver?.()
    await vi.waitFor(() => expect(harness.windows).toHaveLength(1))
  })
  it.skipIf(process.platform !== 'darwin')(
    'reopens admission and cancels the stale retry when a window is requested during drain',
    async () => {
      harness.nativeSet.mockReset()
      const releases: Array<() => void> = []
      harness.nativeSet.mockImplementation(
        () => new Promise<void>(resolve => releases.push(resolve))
      )
      const { TokenStore } = await import('../tokenStore.ts')
      const { app } = await import('electron')
      const quit = vi.mocked(app.quit)
      quit.mockClear()
      const first = new TokenStore().setSessionToken('synthetic-first', 'first-aaaaaaaaaaaa')
      await vi.waitFor(() => expect(harness.nativeSet).toHaveBeenCalledTimes(1))
      let second: Promise<void> | undefined
      try {
        const closed = harness.windows[0].on.mock.calls.find(
          (c: unknown[]) => c[0] === 'closed'
        )?.[1]
        expect(closed).toBeTypeOf('function')
        closed()
        harness.windows.splice(0)
        let veto = false
        const event = {
          defaultPrevented: false,
          preventDefault() {
            this.defaultPrevented = true
            veto = true
          },
        }
        harness.appListeners.get('will-quit')?.(event)
        expect(veto).toBe(true)
        second = new TokenStore().setSessionToken('synthetic-second', 'second-aaaaaaaaaaaa')
        await new Promise(resolve => setImmediate(resolve))
        expect(harness.nativeSet).toHaveBeenCalledTimes(1)
        const activate = harness.appListeners.get('activate')
        expect(activate).toBeTypeOf('function')
        activate?.()
        await vi.waitFor(() => expect(harness.windows).toHaveLength(1))
        await vi.waitFor(() => expect(harness.nativeSet).toHaveBeenCalledTimes(2))
        releases[0]()
        await first
        releases[1]()
        await second
        await new Promise(resolve => setImmediate(resolve))
        expect(quit).not.toHaveBeenCalled()
        expect(harness.windows).toHaveLength(1)
      } finally {
        for (const release of releases) release()
        await first
        if (second && releases.length > 1) await second
      }
    }
  )
})
