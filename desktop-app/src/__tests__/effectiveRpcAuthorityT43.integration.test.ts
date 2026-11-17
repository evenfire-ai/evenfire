import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildSandboxUiDeepLink, parseSandboxUiDeepLink } from '@clerum/desktop-app-links'
import { testLoginResult } from '../../testSupport/authTestFixtures.js'
import { buildGfsResourceDeepLink } from '../gfsDeepLinks.js'

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
    let visible = true
    const window = {
      options,
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
      on: vi.fn(),
      once: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isVisible: vi.fn(() => visible),
      isMinimized: vi.fn(() => false),
      isMaximized: vi.fn(() => false),
      isFullScreen: vi.fn(() => false),
      isFocused: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(() => {
        visible = true
      }),
      hide: vi.fn(() => {
        visible = false
      }),
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

describe('T43 effective RPC receipt binding after logout and same-WebContents navigation', () => {
  let appDataDir = ''
  const originalAppData = process.env.APPDATA
  const originalConfigPath = process.env.CLERUM_DESKTOP_CONFIG_PATH

  beforeAll(async () => {
    appDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-effective-rpc-t43-'))
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
    if (originalAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = originalAppData
    if (originalConfigPath === undefined) delete process.env.CLERUM_DESKTOP_CONFIG_PATH
    else process.env.CLERUM_DESKTOP_CONFIG_PATH = originalConfigPath
  })

  it('rejects the D2 receipt after real diagnostics changes effective RPC', async () => {
    const service = harness.service as any
    if (!service) throw new Error('main.ts did not construct the real AppService')
    const runtimeConfig = await import('../config.js')
    const restA = 'https://rest-a.t43.integration.test'
    const rpcE2 = 'https://rpc-effective-e2.t43.integration.test'
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })

    const login = testLoginResult('token-t43-first')
    const replacementLogin = testLoginResult('token-t43-second', login.me)
    const authClient = service.authClient as any
    let diagnosticsDiscoveryEnabled = false
    vi.spyOn(authClient, 'googleLogin')
      .mockResolvedValueOnce(login)
      .mockResolvedValueOnce(replacementLogin)
    vi.spyOn(authClient, 'getDesktopEnvironment').mockImplementation(async () => {
      if (!diagnosticsDiscoveryEnabled) throw new Error('discovery unavailable before diagnostics')
      return {
        externalRestApiBaseUrl: restA,
        rpcProxyBaseUrl: rpcE2,
        appName: 'Environment A',
      }
    })
    vi.spyOn(authClient, 'getMe').mockResolvedValueOnce(login.me).mockResolvedValueOnce(login.me)
    vi.spyOn(authClient, 'health').mockResolvedValue({ status: 'ok' })
    vi.spyOn(service.rpcClient, 'health').mockResolvedValue({ status: 'ok' })

    const mainWindow = harness.windows[0] as any
    const webContents = mainWindow?.webContents
    if (!mainWindow || !webContents) throw new Error('main window unavailable')
    mainWindow.show.mockClear()
    const handlers = harness.handleHandlers
    const loginHandler = registeredHandler(handlers, 'auth:googleLogin') as any
    const logoutHandler = registeredHandler(handlers, 'auth:logout') as any
    const acknowledge = registeredHandler(handlers, 'auth:acknowledgeSessionPreclear') as any
    const rendererReady = registeredHandler(handlers, 'app:rendererReady') as any
    const getSessionView = registeredHandler(handlers, 'auth:getRendererSessionView') as any
    const commitSessionView = registeredHandler(handlers, 'auth:commitRendererSessionView') as any
    const diagnostics = registeredHandler(handlers, 'auth:getDependenciesHealth') as any
    const currentFrameEvent = () => ipcEvent(webContents)
    const completeCurrentDocumentHandshake = () => {
      const didNavigate = webContents.listeners.get('did-navigate')
      if (!didNavigate) throw new Error('main did not register document navigation')
      didNavigate()
      const handshake = webContents.mainFrame.send.mock.calls
        .filter(([channel]: unknown[]) => channel === 'auth:markdownDocumentHandshake')
        .at(-1)
      if (!handshake) throw new Error('main did not send the current document challenge')
      rendererReady(currentFrameEvent(), handshake[1])
      return handshake[1]
    }

    await loginHandler(currentFrameEvent(), { idToken: 'identity-token-first' })
    expect(await service.getSessionState()).toMatchObject({ authenticated: true })
    expect(service.getEffectiveRpcProxyBaseUrl()).toBe('')
    const firstHandshake = completeCurrentDocumentHandshake()
    const firstReceipt = await getSessionView(currentFrameEvent())
    expect(firstReceipt.state).toMatchObject({ authenticated: true, me: { id: login.me.id } })

    // A successful, real logout IPC clears the first principal and forces a
    // fresh same-WebContents document handshake before the replacement login.
    webContents.send.mockClear()
    const logoutTask = logoutHandler(currentFrameEvent())
    await vi.waitFor(() =>
      expect(webContents.send).toHaveBeenCalledWith('auth:sessionWillClear', expect.any(Object))
    )
    const notice = webContents.send.mock.calls.find(
      ([channel]: unknown[]) => channel === 'auth:sessionWillClear'
    )?.[1]
    if (!notice) throw new Error('main did not send the real logout preclear notice')
    expect(await acknowledge(currentFrameEvent(), notice)).toBe(true)
    await logoutTask
    expect(await service.getSessionState()).toMatchObject({ authenticated: false })

    const secondHandshake = completeCurrentDocumentHandshake()
    expect(secondHandshake.documentEpoch).not.toBe(firstHandshake.documentEpoch)
    await loginHandler(currentFrameEvent(), { idToken: 'identity-token-second' })
    expect(await service.getSessionState()).toMatchObject({ authenticated: true })
    expect(service.getEffectiveRpcProxyBaseUrl()).toBe('')
    const d2Receipt = await getSessionView(currentFrameEvent())
    expect(d2Receipt.state).toMatchObject({ authenticated: true, me: { id: login.me.id } })

    diagnosticsDiscoveryEnabled = true
    const diagnosticsTask = diagnostics(currentFrameEvent())
    await vi.waitFor(() => expect(authClient.getDesktopEnvironment).toHaveBeenCalled())
    await diagnosticsTask

    expect(service.sessionToken).toBe(replacementLogin.token)
    expect(service.getEffectiveRpcProxyBaseUrl()).toBe(rpcE2)
    const accepted = await commitSessionView(currentFrameEvent(), d2Receipt)
    expect(accepted).toBe(false)
    expect(mainWindow.show).not.toHaveBeenCalled()
  })
})
