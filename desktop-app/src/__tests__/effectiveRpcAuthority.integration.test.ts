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
    sessionPreclearRetired: null as null | ((notice: any) => void),
    parseSandboxUiDeepLink: vi.fn(() => null),
    registeredLogout: null as null | (() => Promise<unknown>),
    createWindow: null as null | ((options?: Record<string, unknown>) => Record<string, any>),
  }
  state.createWindow = (options: Record<string, unknown> = {}) => {
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

describe('main.ts GFS navigation-generation composition', () => {
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
  it('integrates real diagnostics discovery, preclear recovery, and main-window show', async () => {
    const service = harness.service as any
    if (!service) throw new Error('main.ts did not construct the real AppService')
    let resolveExitOnlyDialog!: (value: { response: number }) => void
    harness.showMessageBox.mockClear()
    harness.appQuit.mockClear()
    harness.showMessageBox.mockImplementationOnce(
      () => new Promise(resolve => (resolveExitOnlyDialog = resolve)) as never
    )
    const runtimeConfig = await import('../config.js')
    const restA = 'https://rest-a.integration.test'
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })

    let resolveDiscovery!: (value: any) => void
    let resolveRecovery!: (value: any) => void
    let resolveSecondDiscovery!: (value: any) => void
    const discovered = new Promise(resolve => {
      resolveDiscovery = resolve
    })
    const recovery = new Promise(resolve => {
      resolveRecovery = resolve
    })
    const secondDiscovered = new Promise(resolve => {
      resolveSecondDiscovery = resolve
    })
    const login = testLoginResult('token-e1')
    const authClient = service.authClient as any
    vi.spyOn(authClient, 'googleLogin')
      .mockResolvedValueOnce(login)
      .mockResolvedValueOnce(testLoginResult('token-e1-next', login.me))
    vi.spyOn(authClient, 'getDesktopEnvironment')
      .mockRejectedValueOnce(new Error('initial discovery unavailable'))
      .mockReturnValueOnce(discovered)
      .mockRejectedValueOnce(new Error('post-logout discovery unavailable'))
      .mockReturnValueOnce(secondDiscovered)
    vi.spyOn(authClient, 'getMe').mockResolvedValueOnce(login.me).mockReturnValueOnce(recovery)
    vi.spyOn(authClient, 'health').mockResolvedValue({ status: 'ok' })
    vi.spyOn(service.rpcClient, 'health').mockResolvedValue({ status: 'ok' })
    vi.spyOn(service.tokenStore, 'clearSessionToken')
      .mockRejectedValueOnce(new Error('persisted token clear failed'))
      .mockResolvedValue(undefined)

    await service.googleLogin('identity-token')
    expect(await service.getSessionState()).toMatchObject({ authenticated: true })
    const mainWindow = harness.windows[0] as any
    const ownContents = mainWindow?.webContents
    if (!mainWindow || !ownContents) throw new Error('main window unavailable')
    mainWindow.show.mockClear()

    const handlers = harness.handleHandlers
    const acknowledge = registeredHandler(handlers, 'auth:acknowledgeSessionPreclear') as any
    const diagnostics = registeredHandler(handlers, 'auth:getDependenciesHealth') as any
    const logout = registeredHandler(handlers, 'auth:logout') as any
    ownContents.send.mockClear()
    const failedLogout = logout(ipcEvent(ownContents))
    await vi.waitFor(() =>
      expect(ownContents.send).toHaveBeenCalledWith('auth:sessionWillClear', expect.any(Object))
    )
    const preclearNotice = ownContents.send.mock.calls.find(
      ([channel]: unknown[]) => channel === 'auth:sessionWillClear'
    )?.[1]
    if (!preclearNotice) throw new Error('main did not send the real preclear notice')
    await acknowledge(ipcEvent(ownContents), preclearNotice)
    await expect(failedLogout).rejects.toThrow('persisted token clear failed')
    await vi.waitFor(() => expect(authClient.getMe).toHaveBeenCalledTimes(2))

    const diagnosticsTask = diagnostics(ipcEvent(ownContents))
    await vi.waitFor(() => expect(authClient.getDesktopEnvironment).toHaveBeenCalledTimes(2))
    resolveDiscovery({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: 'https://rpc-effective-e2.integration.test',
      appName: 'Environment A',
    })
    await diagnosticsTask
    resolveRecovery(login.me)
    await vi.waitFor(() => expect(authClient.getMe).toHaveBeenCalledTimes(2))
    expect(mainWindow.hide).toHaveBeenCalled()
    expect(mainWindow.show).not.toHaveBeenCalled()
    expect(service.sessionToken).toBe('token-e1')
    expect(service.getEffectiveRpcProxyBaseUrl()).toBe('https://rpc-effective-e2.integration.test')
    expect(ownContents.send).not.toHaveBeenCalledWith('auth:sessionClearCancelled', preclearNotice)
    if (service.pendingSessionPreclear) {
      await vi.waitFor(() => expect(harness.showMessageBox).toHaveBeenCalledOnce())
      expect(harness.showMessageBox).toHaveBeenCalledWith(
        expect.objectContaining({ buttons: ['Exit'] })
      )
      resolveExitOnlyDialog({ response: 0 })
      await vi.waitFor(() => expect(harness.appQuit).toHaveBeenCalledOnce())
      await vi.waitFor(() => expect(service.pendingSessionPreclear).toBeNull())
    }

    // Complete a real logout to create a hidden transition document, then log in
    // under REST-only E1 and hold its main-derived session receipt across E27.
    mainWindow.show.mockClear()
    ownContents.send.mockClear()
    const successfulLogout = logout(ipcEvent(ownContents))
    await vi.waitFor(() =>
      expect(ownContents.send).toHaveBeenCalledWith('auth:sessionWillClear', expect.any(Object))
    )
    const secondNotice = ownContents.send.mock.calls.find(
      ([channel]: unknown[]) => channel === 'auth:sessionWillClear'
    )?.[1]
    if (!secondNotice) throw new Error('main did not send the second preclear')
    await acknowledge(ipcEvent(ownContents), secondNotice)
    await successfulLogout
    expect(mainWindow.show).not.toHaveBeenCalled()
    // The completed logout commits the accepted discovery to configured runtime
    // storage. Reset only this temporary test profile so the next case exercises
    // effective-RPC discovery separately from configured RPC identity.
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: '',
      appName: 'Environment A',
    })

    const didNavigate = ownContents.listeners.get('did-navigate')
    if (!didNavigate) throw new Error('main did not register document navigation')
    didNavigate()
    const handshakes = ownContents.mainFrame.send.mock.calls.filter(
      ([channel]: unknown[]) => channel === 'auth:markdownDocumentHandshake'
    )
    const handshake = handshakes.at(-1)
    if (!handshake) throw new Error('main did not send the replacement document challenge')
    const rendererReady = registeredHandler(harness.handleHandlers, 'app:rendererReady') as any
    const readyState = rendererReady(ipcEvent(ownContents), handshake[1]) as any
    expect(readyState.sessionTransitionRevealPending).toBe(true)

    await service.googleLogin('identity-token-next')
    expect(service.sessionToken).toBe('token-e1-next')
    const view = registeredHandler(harness.handleHandlers, 'auth:getRendererSessionView') as any
    const receipt = await view(ipcEvent(ownContents))
    expect(receipt.state).toMatchObject({ authenticated: true, me: { id: login.me.id } })

    const secondDiagnosticsTask = diagnostics(ipcEvent(ownContents))
    await vi.waitFor(() => expect(authClient.getDesktopEnvironment).toHaveBeenCalledTimes(4))
    resolveSecondDiscovery({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: 'https://rpc-effective-e3.integration.test',
      appName: 'Environment A',
    })
    await secondDiagnosticsTask
    expect(service.getEffectiveRpcProxyBaseUrl()).toBe('https://rpc-effective-e3.integration.test')

    const commitView = registeredHandler(
      harness.handleHandlers,
      'auth:commitRendererSessionView'
    ) as any
    const accepted = await commitView(ipcEvent(ownContents), receipt)
    expect(accepted).toBe(false)
    expect(mainWindow.show).not.toHaveBeenCalled()
  })
})
