import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { testLoginResult } from '../../testSupport/authTestFixtures.js'

type MainEvent = {
  senderFrame: { url: string; send?: (...args: unknown[]) => void }
  sender: { mainFrame?: MainEvent['senderFrame']; id?: number }
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
    service: null as any,
    logout: vi.fn(async () => 7),
    exitRecovery: vi.fn(() => true),
    retryRecovery: vi.fn(() => true),
    showMessageBox: vi.fn().mockResolvedValue({ response: 1 }),
    appQuit: vi.fn(),
    sessionGeneration: 0,
    invalidateSandboxUiSession: null as null | (() => void),
    sessionCleared: null as null | (() => void),
    sessionPreclear: null as null | ((notice: any) => boolean | void),
    sessionPreclearTimeout: null as null | ((notice: any) => void),
    sessionPreclearCancelled: null as null | ((notice: any) => void),
    sessionPreclearRecoveryRequired: null as null | ((notice: any, state: any) => void),
    sessionPreclearAwaitingReceipt: null as null | ((notice: any, state: any) => void),
    sessionPreclearReceiptCommitted: null as null | ((notice: any) => void),
    sessionPreclearRetired: null as null | ((notice: any) => void),
    parseSandboxUiDeepLink: vi.fn(() => null),
    registeredLogout: null as null | (() => Promise<unknown>),
    createWindow: null as null | ((options?: Record<string, unknown>) => Record<string, any>),
  }
  state.createWindow = (options: Record<string, unknown> = {}) => {
    const window = {
      options,
      listeners: new Map<string, (...args: unknown[]) => void>(),
      webContents: {
        id: 41,
        listeners: new Map<string, (...args: unknown[]) => void>(),
        on: vi.fn(function (this: any, event: string, listener: (...args: unknown[]) => void) {
          this.listeners.set(event, listener)
        }),
        once: vi.fn(),
        send: vi.fn(),
        mainFrame: { url: 'file:///app/index.html', send: vi.fn() },
        isLoading: vi.fn(() => false),
        isDestroyed: vi.fn(() => false),
        reload: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        loadFile: vi.fn().mockResolvedValue(undefined),
        loadURL: vi.fn().mockResolvedValue(undefined),
      },
      loadFile: vi.fn().mockResolvedValue(undefined),
      loadURL: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(function (this: any, event: string, listener: (...args: unknown[]) => void) {
        this.listeners.set(event, listener)
      }),
      once: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      isMinimized: vi.fn(() => false),
      isMaximized: vi.fn(() => false),
      isFullScreen: vi.fn(() => false),
      isFocused: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
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

vi.mock('keytar', () => {
  throw new Error('keytar is unavailable in this hermetic integration test')
})

vi.mock('electron', async () => ({
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
    getPath: vi.fn(() => process.env.APPDATA || '/tmp/evenfire-a6-main'),
    setPath: vi.fn(),
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
    quit: harness.appQuit,
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
  safeStorage: (await import('../../testSupport/electronStorageTestMocks.js')).safeStorage,
  dialog: { showSaveDialog: vi.fn(), showMessageBox: harness.showMessageBox },
}))

vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  unbindChatStore: vi.fn(),
  __setChatStoreBaseDirForTests: vi.fn(),
}))

vi.mock('../appService.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../appService.js')>()
  return {
    ...actual,
    AppService: class extends actual.AppService {
      constructor(options?: any) {
        super(options)
        harness.service = this
        ;(this as any).initialize = harness.initialize
        harness.invalidateSandboxUiSession = options?.onSandboxUiSessionInvalidated ?? null
        harness.sessionCleared = options?.onSessionCleared ?? null
        harness.sessionPreclear = options?.onSessionPreclear ?? null
        harness.sessionPreclearTimeout = options?.onSessionPreclearTimeout ?? null
        harness.sessionPreclearCancelled = options?.onSessionPreclearCancelled ?? null
        harness.sessionPreclearRecoveryRequired = options?.onSessionPreclearRecoveryRequired ?? null
        harness.sessionPreclearRetired = options?.onSessionPreclearRetired ?? null
        harness.sessionPreclearAwaitingReceipt = options?.onSessionPreclearAwaitingReceipt ?? null
        harness.sessionPreclearReceiptCommitted = options?.onSessionPreclearReceiptCommitted ?? null
      }
    },
  }
})
vi.mock('../config.js', async importOriginal => importOriginal())
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
    registerIpcHandlers: vi.fn((service, logout, getMainWindow) => {
      harness.registeredLogout = logout
      actual.registerIpcHandlers(service, logout, getMainWindow)
    }),
  }
})
vi.mock('../mainWindowReadiness.js', () => ({ wireMainWindowRendererReadiness: vi.fn() }))
vi.mock('../pluginSdkRuntime.js', () => ({
  initPluginSdkRuntime: vi.fn(),
  tryGetPluginSdkRuntime: vi.fn(() => null),
}))
vi.mock('../protocolLaunchArgs.js', () => ({
  collectInitialProtocolUrls: vi.fn(() => ({ evenfireUrls: [], clerumUrls: [] })),
  shouldRegisterOsProtocols: vi.fn(() => false),
}))
vi.mock('../sandboxUiDeepLinks.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../sandboxUiDeepLinks.js')>()
  return { ...actual, parseSandboxUiDeepLink: harness.parseSandboxUiDeepLink }
})
vi.mock('../sandboxUiProtocolWindowPolicy.js', () => ({
  shouldAcceptSandboxUiProtocolLink: vi.fn(() => true),
}))
vi.mock('../sandboxUiSessionRefresh.js', () => ({
  notifySandboxUiHostResumed: vi.fn(),
  cancelSandboxUiRefresh: vi.fn(),
}))
vi.mock('../shortcutRouter.js', () => ({ wireHostDesktopShortcutRouting: vi.fn() }))
vi.mock('../systemIcon.js', () => ({
  installAdaptiveSystemIcon: vi.fn(),
  resolveSystemIconPath: vi.fn(() => 'icon.png'),
}))
vi.mock('../clerumDeepLink.js', () => ({
  routeClerumOauthCompleted: vi.fn(() => ({ kind: 'ignore' })),
}))

function ipcEvent(sender: MainEvent['sender'], url = 'file:///app/index.html'): MainEvent {
  const mainFrame = sender.mainFrame
  return {
    senderFrame: mainFrame?.url === url ? mainFrame : { url },
    sender,
  }
}

function registeredHandler<T extends (...args: never[]) => unknown>(
  handlers: Map<string, T>,
  channel: string
): T {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`Missing composed IPC handler: ${channel}`)
  return handler
}

describe('main.ts recovery dialog and BrowserWindow destruction', () => {
  let appDataDir = ''
  beforeAll(async () => {
    appDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-main-a6-'))
    process.env.APPDATA = appDataDir
    process.env.CLERUM_DESKTOP_CONFIG_PATH = path.join(appDataDir, 'desktop-config.json')
    await import('../main.js')
    harness.readyResolver?.()
    await vi.waitFor(() => {
      expect(harness.registeredLogout).toBeTypeOf('function')
      expect(harness.windows).toHaveLength(1)
    })
  })

  afterAll(async () => {
    await fs.rm(appDataDir, { recursive: true, force: true })
  })

  it('keeps the process recovery dialog actionable after its BrowserWindow closes', async () => {
    const service = harness.service as any
    if (!service) throw new Error('main.ts did not construct the real AppService')
    const mainWindow = harness.windows[0] as any
    const ownContents = mainWindow?.webContents
    if (!mainWindow || !ownContents)
      throw new Error('main.ts did not create the owning BrowserWindow')

    let resolveRetryDialog!: (value: { response: number }) => void
    let resolvePendingDialog!: (value: { response: number }) => void
    harness.showMessageBox.mockClear()
    harness.showMessageBox
      .mockImplementationOnce(() => {
        return new Promise(resolve => {
          resolveRetryDialog = resolve
        }) as never
      })
      .mockImplementationOnce(() => {
        return new Promise(resolve => {
          resolvePendingDialog = resolve
        }) as never
      })
    const runtimeConfig = await import('../config.js')
    const restA = 'https://rest-a.window-close.test'
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Window-close test',
    })

    const login = testLoginResult('window-close-session')
    const authClient = service.authClient as any
    vi.spyOn(authClient, 'googleLogin').mockResolvedValue(login)
    vi.spyOn(authClient, 'getDesktopEnvironment')
      .mockRejectedValueOnce(new Error('initial discovery unavailable'))
      .mockResolvedValueOnce({
        externalRestApiBaseUrl: restA,
        rpcProxyBaseUrl: 'https://rpc-effective-window-close.test',
        appName: 'Window-close test',
      })
    vi.spyOn(authClient, 'getMe').mockResolvedValue(login.me)
    vi.spyOn(authClient, 'health').mockResolvedValue({ status: 'ok' })
    vi.spyOn(service.rpcClient, 'health').mockResolvedValue({ status: 'ok' })

    await service.googleLogin('identity-token')
    expect(await service.getSessionState()).toMatchObject({ authenticated: true })
    mainWindow.show.mockClear()
    const diagnostics = registeredHandler(
      harness.handleHandlers,
      'auth:getDependenciesHealth'
    ) as any
    await diagnostics(ipcEvent(ownContents))
    await vi.waitFor(() => expect(harness.showMessageBox).toHaveBeenCalledOnce())
    expect(harness.showMessageBox.mock.calls[0]?.[0].buttons).toEqual(['Retry', 'Exit'])

    const onClosed = mainWindow.listeners.get('closed')
    if (!onClosed) throw new Error('main.ts did not register BrowserWindow destruction')
    mainWindow.isDestroyed.mockReturnValue(true)
    onClosed()
    expect(mainWindow.show).not.toHaveBeenCalled()

    // The Retry selected after W1 destruction remains bound to the exact
    // process-owned preclear instead of being canceled with the window.
    const retry = vi.spyOn(service, 'retrySessionPreclearRecovery')
    const exit = vi.spyOn(service, 'exitSessionPreclearRecovery')
    resolveRetryDialog({ response: 0 })
    await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce())
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({ reason: 'environment-change' }))
    await vi.waitFor(() => expect(harness.showMessageBox).toHaveBeenCalledTimes(2))
    expect(harness.showMessageBox.mock.calls[1]?.[0].buttons).toEqual(['Exit'])
    expect(service.pendingSessionPreclear?.awaitingCurrentDocumentReceipt).toBe(true)
    expect(mainWindow.show).not.toHaveBeenCalled()

    resolvePendingDialog({ response: 0 })
    await vi.waitFor(() => expect(harness.appQuit).toHaveBeenCalledOnce())
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(expect.objectContaining({ reason: 'environment-change' }))
  })
})
