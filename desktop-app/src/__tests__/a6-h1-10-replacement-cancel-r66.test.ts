import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    const webContentsId = 41 + state.windows.length
    const window = {
      options,
      listeners: new Map<string, (...args: unknown[]) => void>(),
      webContents: {
        id: webContentsId,
        listeners: new Map<string, (...args: unknown[]) => void>(),
        on: vi.fn(function (this: any, event: string, listener: (...args: unknown[]) => void) {
          this.listeners.set(event, listener)
        }),
        once: vi.fn(function (this: any, event: string, listener: (...args: unknown[]) => void) {
          this.listeners.set(event, listener)
        }),
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
      once: vi.fn(function (this: any, event: string, listener: (...args: unknown[]) => void) {
        this.listeners.set(event, listener)
      }),
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
      return harness.windows.filter(window => !window.isDestroyed())
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

async function commitCurrentDocumentReceipt(window: any): Promise<boolean> {
  const didNavigate = window.webContents.listeners.get('did-navigate')
  if (!didNavigate) throw new Error('replacement window did not install did-navigate lifecycle')
  didNavigate()
  const handshake = window.webContents.mainFrame.send.mock.calls
    .filter(([channel]: unknown[]) => channel === 'auth:markdownDocumentHandshake')
    .at(-1)?.[1]
  if (!handshake) throw new Error('main did not issue the replacement document challenge')
  const rendererReady = registeredHandler(harness.handleHandlers, 'app:rendererReady') as any
  await rendererReady(ipcEvent(window.webContents), handshake)
  const getView = registeredHandler(harness.handleHandlers, 'auth:getRendererSessionView') as any
  const receipt = await getView(ipcEvent(window.webContents))
  if (!receipt) throw new Error('current replacement document did not receive session state')
  const commitView = registeredHandler(
    harness.handleHandlers,
    'auth:commitRendererSessionView'
  ) as any
  return commitView(ipcEvent(window.webContents), receipt)
}

describe('main.ts recovery dialog and BrowserWindow destruction', () => {
  let appDataDir = ''
  beforeEach(async () => {
    harness.onHandlers.clear()
    harness.handleHandlers.clear()
    harness.appListeners.clear()
    harness.windows.splice(0)
    harness.readyResolver = null
    harness.initialize.mockReset().mockResolvedValue(undefined)
    harness.service = null
    harness.logout.mockReset().mockResolvedValue(7)
    harness.exitRecovery.mockReset().mockReturnValue(true)
    harness.retryRecovery.mockReset().mockReturnValue(true)
    harness.showMessageBox.mockReset().mockResolvedValue({ response: 1 })
    harness.sessionGeneration = 0
    harness.invalidateSandboxUiSession = null
    harness.sessionCleared = null
    harness.sessionPreclear = null
    harness.sessionPreclearTimeout = null
    harness.sessionPreclearCancelled = null
    harness.sessionPreclearRecoveryRequired = null
    harness.sessionPreclearAwaitingReceipt = null
    harness.sessionPreclearReceiptCommitted = null
    harness.sessionPreclearRetired = null
    harness.parseSandboxUiDeepLink.mockReset().mockReturnValue(null)
    harness.registeredLogout = null
    await vi.resetModules()
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

  afterEach(async () => {
    await fs.rm(appDataDir, { recursive: true, force: true })
  })

  it('ordinary startup displays the shell without inventing a transition receipt', async () => {
    const service = harness.service as any
    const initialWindow = harness.windows[0] as any
    if (!service || !initialWindow) throw new Error('main startup did not construct its real owner')
    await vi.waitFor(() => expect(initialWindow.loadFile).toHaveBeenCalled())
    expect(service.pendingSessionPreclear).toBeNull()
    expect(
      initialWindow.show,
      'ordinary no-P startup must retain shell visibility'
    ).toHaveBeenCalled()

    const didNavigate = initialWindow.webContents.listeners.get('did-navigate')
    if (!didNavigate) throw new Error('main did not register the initial document lifecycle')
    didNavigate()
    const handshake = initialWindow.webContents.mainFrame.send.mock.calls
      .filter(([channel]: unknown[]) => channel === 'auth:markdownDocumentHandshake')
      .at(-1)?.[1]
    if (!handshake) throw new Error('main did not issue the ordinary startup document challenge')
    const rendererReady = registeredHandler(harness.handleHandlers, 'app:rendererReady') as any
    const readiness = rendererReady(ipcEvent(initialWindow.webContents), handshake)
    expect(readiness.sessionTransitionRevealPending).toBe(false)
    expect(
      initialWindow.show,
      'readiness must not hide or duplicate the already visible shell'
    ).toHaveBeenCalled()
  })

  it('T22 same-boundary cancellation cannot reveal W2 without its D2 receipt', async () => {
    const service = harness.service as any
    const w1 = harness.windows.find(window => !window.isDestroyed()) as any
    if (!service || !w1) throw new Error('main startup did not construct W1 and AppService')
    await vi.waitFor(() => expect(w1.loadFile).toHaveBeenCalled())
    const runtimeConfig = await import('../config.js')
    const rest = 'https://rest-a.cancel-replacement.test'
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: '',
      appName: 'Cancel replacement test',
    })

    const login = testLoginResult('cancel-replacement-session')
    const authClient = service.authClient as any
    vi.spyOn(authClient, 'googleLogin').mockResolvedValue(login)
    vi.spyOn(authClient, 'getDesktopEnvironment').mockResolvedValue({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: '',
      appName: 'Cancel replacement test',
    })
    vi.spyOn(authClient, 'health').mockResolvedValue({ status: 'ok' })
    vi.spyOn(service.rpcClient, 'health').mockResolvedValue({ status: 'ok' })
    await service.googleLogin('identity-token')
    expect(await service.getSessionState()).toMatchObject({ authenticated: true })

    let startRecovery!: () => void
    let resolveRecovery!: (value: any) => void
    const recoveryStarted = new Promise<void>(resolve => {
      startRecovery = resolve
    })
    const recoveryMe = new Promise<any>(resolve => {
      resolveRecovery = resolve
    })
    const getMe = vi.spyOn(authClient, 'getMe').mockImplementation(() => {
      startRecovery()
      return recoveryMe
    })
    const selectRuntimeConfig = registeredHandler(
      harness.handleHandlers,
      'auth:selectRuntimeConfig'
    ) as any
    const selection = selectRuntimeConfig(ipcEvent(w1.webContents), { optionId: 'missing-option' })
    await vi.waitFor(() => expect(service.pendingSessionPreclear).not.toBeNull())

    const closed = w1.listeners.get('closed')
    if (!closed) throw new Error('W1 closed callback was not registered')
    w1.isDestroyed.mockReturnValue(true)
    closed()
    harness.appListeners.get('window-all-closed')?.()
    harness.appListeners.get('activate')?.()
    await vi.waitFor(() => expect(harness.windows.filter(w => !w.isDestroyed())).toHaveLength(1))
    const w2 = harness.windows.find(window => !window.isDestroyed()) as any
    if (w2 === w1) throw new Error('Darwin activation did not create replacement W2')
    await vi.waitFor(() => expect(w2.loadFile).toHaveBeenCalledOnce())
    await new Promise<void>(resolve => setImmediate(resolve))
    const ready = w2.listeners.get('ready-to-show')
    if (!ready) throw new Error('W2 ready-to-show callback was not registered')
    ready()
    // Preserve/record the earlier T20 red callbacks, then isolate the cancellation callback.
    w2.show.mockClear()

    await recoveryStarted
    expect(getMe).toHaveBeenCalledOnce()
    resolveRecovery(login.me)
    await expect(selection).rejects.toThrow('runtime configuration not found')
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(service.pendingSessionPreclear).toBeNull()
    expect
      .soft(w2.show, 'unchanged cancellation must not directly show W2 before its D2 receipt')
      .not.toHaveBeenCalled()
    expect(await commitCurrentDocumentReceipt(w2)).toBe(true)
    expect(w2.show, 'W2 may reveal after its current D2 receipt is accepted').toHaveBeenCalledOnce()
  })

  it('T26 destroyed W1 activation replacement records loss before its late closed callback', async () => {
    const service = harness.service as any
    const w1 = harness.windows.find(window => !window.isDestroyed()) as any
    if (!service || !w1) throw new Error('main startup did not construct W1 and AppService')
    await vi.waitFor(() => expect(w1.loadFile).toHaveBeenCalled())
    const runtimeConfig = await import('../config.js')
    const rest = 'https://rest-a.destroy-before-closed.test'
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: '',
      appName: 'Destroyed before closed test',
    })

    const login = testLoginResult('destroy-before-closed-session')
    const authClient = service.authClient as any
    vi.spyOn(authClient, 'googleLogin').mockResolvedValue(login)
    vi.spyOn(authClient, 'getDesktopEnvironment').mockResolvedValue({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: '',
      appName: 'Destroyed before closed test',
    })
    vi.spyOn(authClient, 'health').mockResolvedValue({ status: 'ok' })
    vi.spyOn(service.rpcClient, 'health').mockResolvedValue({ status: 'ok' })
    await service.googleLogin('identity-token')
    expect(await service.getSessionState()).toMatchObject({ authenticated: true })

    let startRecovery!: () => void
    let resolveRecovery!: (value: any) => void
    const recoveryStarted = new Promise<void>(resolve => {
      startRecovery = resolve
    })
    const recoveryMe = new Promise<any>(resolve => {
      resolveRecovery = resolve
    })
    const getMe = vi.spyOn(authClient, 'getMe').mockImplementation(() => {
      startRecovery()
      return recoveryMe
    })
    const selectRuntimeConfig = registeredHandler(
      harness.handleHandlers,
      'auth:selectRuntimeConfig'
    ) as any
    const selection = selectRuntimeConfig(ipcEvent(w1.webContents), { optionId: 'missing-option' })
    await vi.waitFor(() => expect(service.pendingSessionPreclear).not.toBeNull())

    const lateClosed = w1.listeners.get('closed')
    if (!lateClosed) throw new Error('W1 closed callback was not registered')
    w1.isDestroyed.mockReturnValue(true)

    // Darwin activation sees the destroyed W1 through the real coordinator caller and creates W2
    // before Electron delivers W1's registered `closed` callback.
    const activate = harness.appListeners.get('activate')
    if (!activate) throw new Error('main did not register the Darwin activation caller')
    activate()
    await vi.waitFor(() => expect(harness.windows.filter(w => !w.isDestroyed())).toHaveLength(1))
    const w2 = harness.windows.find(window => !window.isDestroyed()) as any
    if (w2 === w1) throw new Error('activation did not create replacement W2')
    await vi.waitFor(() => expect(w2.loadFile).toHaveBeenCalledOnce())
    await new Promise<void>(resolve => setImmediate(resolve))
    const ready = w2.listeners.get('ready-to-show')
    if (!ready) throw new Error('W2 ready-to-show callback was not registered')
    ready()
    w2.show.mockClear()

    // The late identity-guarded callback must not erase loss merely because mainWindow now points at W2.
    lateClosed()
    await recoveryStarted
    expect(getMe).toHaveBeenCalledOnce()
    resolveRecovery(login.me)
    await expect(selection).rejects.toThrow('runtime configuration not found')
    await vi.waitFor(() => expect(service.pendingSessionPreclear).toBeNull())
    expect(
      w2.show,
      'unchanged P cancellation must not reveal W2 without its D2 receipt'
    ).not.toHaveBeenCalled()
    expect(await commitCurrentDocumentReceipt(w2)).toBe(true)
    expect(w2.show, 'W2 may reveal after its current D2 receipt is accepted').toHaveBeenCalledOnce()
  })

  it('T27 unchanged P cancellation with destroyed W1 preserves a fence for later W2', async () => {
    const service = harness.service as any
    const w1 = harness.windows.find(window => !window.isDestroyed()) as any
    if (!service || !w1) throw new Error('main startup did not construct W1 and AppService')
    await vi.waitFor(() => expect(w1.loadFile).toHaveBeenCalled())
    const runtimeConfig = await import('../config.js')
    const rest = 'https://rest-a.cancel-before-closed.test'
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: '',
      appName: 'Cancel before closed test',
    })

    const login = testLoginResult('cancel-before-closed-session')
    const authClient = service.authClient as any
    vi.spyOn(authClient, 'googleLogin').mockResolvedValue(login)
    vi.spyOn(authClient, 'getDesktopEnvironment').mockResolvedValue({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: '',
      appName: 'Cancel before closed test',
    })
    vi.spyOn(authClient, 'health').mockResolvedValue({ status: 'ok' })
    vi.spyOn(service.rpcClient, 'health').mockResolvedValue({ status: 'ok' })
    await service.googleLogin('identity-token')

    let startRecovery!: () => void
    let resolveRecovery!: (value: any) => void
    const recoveryStarted = new Promise<void>(resolve => {
      startRecovery = resolve
    })
    const recoveryMe = new Promise<any>(resolve => {
      resolveRecovery = resolve
    })
    const getMe = vi.spyOn(authClient, 'getMe').mockImplementation(() => {
      startRecovery()
      return recoveryMe
    })
    const selectRuntimeConfig = registeredHandler(
      harness.handleHandlers,
      'auth:selectRuntimeConfig'
    ) as any
    const selection = selectRuntimeConfig(ipcEvent(w1.webContents), { optionId: 'missing-option' })
    await vi.waitFor(() => expect(service.pendingSessionPreclear).not.toBeNull())
    const lateClosed = w1.listeners.get('closed')
    if (!lateClosed) throw new Error('W1 closed callback was not registered')
    w1.isDestroyed.mockReturnValue(true)

    await recoveryStarted
    expect(getMe).toHaveBeenCalledOnce()
    resolveRecovery(login.me)
    await expect(selection).rejects.toThrow('runtime configuration not found')
    await vi.waitFor(() => expect(service.pendingSessionPreclear).toBeNull())

    const activate = harness.appListeners.get('activate')
    if (!activate) throw new Error('main did not register the Darwin activation caller')
    activate()
    await vi.waitFor(() => expect(harness.windows.filter(w => !w.isDestroyed())).toHaveLength(1))
    const w2 = harness.windows.find(window => !window.isDestroyed()) as any
    if (w2 === w1) throw new Error('activation did not create replacement W2')
    await vi.waitFor(() => expect(w2.loadFile).toHaveBeenCalledOnce())
    await new Promise<void>(resolve => setImmediate(resolve))
    w2.show.mockClear()
    lateClosed()
    const ready = w2.listeners.get('ready-to-show')
    if (!ready) throw new Error('W2 ready-to-show callback was not registered')
    ready()
    expect(w2.show, 'later W2 must remain hidden until its D2 receipt').not.toHaveBeenCalled()
    expect(await commitCurrentDocumentReceipt(w2)).toBe(true)
    expect(w2.show, 'W2 may reveal after its current D2 receipt is accepted').toHaveBeenCalledOnce()
  })

  it('T28 late W1 close retires only W1 close owner after W2 registers D2', async () => {
    const service = harness.service as any
    const w1 = harness.windows.find(window => !window.isDestroyed()) as any
    if (!service || !w1) throw new Error('main startup did not construct W1 and AppService')
    await vi.waitFor(() => expect(w1.loadFile).toHaveBeenCalled())

    const rendererReady = registeredHandler(harness.handleHandlers, 'app:rendererReady') as any
    const registerDocument = async (window: any) => {
      const didNavigate = window.webContents.listeners.get('did-navigate')
      if (!didNavigate) throw new Error('window did not install did-navigate lifecycle')
      didNavigate()
      const handshake = window.webContents.mainFrame.send.mock.calls
        .filter(([channel]: unknown[]) => channel === 'auth:markdownDocumentHandshake')
        .at(-1)?.[1]
      if (!handshake) throw new Error('main did not issue the document challenge')
      await rendererReady(ipcEvent(window.webContents), handshake)
      expect(service.markdownTabCloseDocuments.has(window.webContents.id)).toBe(true)
    }
    await registerDocument(w1)
    const w1Id = w1.webContents.id

    const runtimeConfig = await import('../config.js')
    const rest = 'https://rest-a.late-w1-owner-retirement.test'
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: '',
      appName: 'Late W1 owner retirement test',
    })
    const login = testLoginResult('late-w1-owner-retirement-session')
    const authClient = service.authClient as any
    vi.spyOn(authClient, 'googleLogin').mockResolvedValue(login)
    vi.spyOn(authClient, 'getDesktopEnvironment').mockResolvedValue({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: '',
      appName: 'Late W1 owner retirement test',
    })
    vi.spyOn(authClient, 'health').mockResolvedValue({ status: 'ok' })
    vi.spyOn(service.rpcClient, 'health').mockResolvedValue({ status: 'ok' })
    await service.googleLogin('identity-token')

    let startRecovery!: () => void
    let resolveRecovery!: (value: any) => void
    const recoveryStarted = new Promise<void>(resolve => {
      startRecovery = resolve
    })
    const recoveryMe = new Promise<any>(resolve => {
      resolveRecovery = resolve
    })
    const getMe = vi.spyOn(authClient, 'getMe').mockImplementation(() => {
      startRecovery()
      return recoveryMe
    })
    const selectRuntimeConfig = registeredHandler(
      harness.handleHandlers,
      'auth:selectRuntimeConfig'
    ) as any
    const selection = selectRuntimeConfig(ipcEvent(w1.webContents), { optionId: 'missing-option' })
    await vi.waitFor(() => expect(service.pendingSessionPreclear).not.toBeNull())

    const lateClosed = w1.listeners.get('closed')
    if (!lateClosed) throw new Error('W1 closed callback was not registered')
    w1.isDestroyed.mockReturnValue(true)
    const activate = harness.appListeners.get('activate')
    if (!activate) throw new Error('main did not register Darwin activation')
    activate()
    await vi.waitFor(() => expect(harness.windows.filter(w => !w.isDestroyed())).toHaveLength(1))
    const w2 = harness.windows.find(window => !window.isDestroyed()) as any
    if (w2 === w1) throw new Error('activation did not create replacement W2')
    await vi.waitFor(() => expect(w2.loadFile).toHaveBeenCalledOnce())
    await new Promise<void>(resolve => setImmediate(resolve))
    await registerDocument(w2)
    const w2Id = w2.webContents.id
    expect(w2Id).not.toBe(w1Id)
    expect(service.markdownTabCloseDocuments.has(w1Id)).toBe(true)
    expect(service.markdownTabCloseDocuments.has(w2Id)).toBe(true)

    // W1's registered callback arrives only after W2 owns mainWindow and its D2 owner is registered.
    lateClosed()
    await recoveryStarted
    expect(getMe).toHaveBeenCalledOnce()
    resolveRecovery(login.me)
    await expect(selection).rejects.toThrow('runtime configuration not found')
    await vi.waitFor(() => expect(service.pendingSessionPreclear).toBeNull())

    expect
      .soft(
        service.markdownTabCloseDocuments.has(w1Id),
        'late W1 close must retire its exact sender-owned record at quiescence'
      )
      .toBe(false)
    expect
      .soft(
        service.markdownTabCloseDocuments.has(w2Id),
        'W1 cleanup must preserve current W2/D2 close ownership'
      )
      .toBe(true)
    expect(service.markdownTabCloseDocuments.size).toBeLessThanOrEqual(1)
    expect(await commitCurrentDocumentReceipt(w2)).toBe(true)
    expect(
      w2.show,
      'W2 may reveal after the post-cancellation current receipt'
    ).toHaveBeenCalledOnce()
  })

  it('T23 no-window cancellation keeps force-fresh for a later W2 receipt', async () => {
    const service = harness.service as any
    const w1 = harness.windows.find(window => !window.isDestroyed()) as any
    if (!service || !w1) throw new Error('main startup did not construct W1 and AppService')
    await vi.waitFor(() => expect(w1.loadFile).toHaveBeenCalled())
    const runtimeConfig = await import('../config.js')
    const rest = 'https://rest-a.cancel-no-window.test'
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: '',
      appName: 'No window cancellation test',
    })

    const login = testLoginResult('cancel-no-window-session')
    const authClient = service.authClient as any
    vi.spyOn(authClient, 'googleLogin').mockResolvedValue(login)
    vi.spyOn(authClient, 'getDesktopEnvironment').mockResolvedValue({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: '',
      appName: 'No window cancellation test',
    })
    vi.spyOn(authClient, 'health').mockResolvedValue({ status: 'ok' })
    vi.spyOn(service.rpcClient, 'health').mockResolvedValue({ status: 'ok' })
    await service.googleLogin('identity-token')

    let startRecovery!: () => void
    let resolveRecovery!: (value: any) => void
    const recoveryStarted = new Promise<void>(resolve => {
      startRecovery = resolve
    })
    const recoveryMe = new Promise<any>(resolve => {
      resolveRecovery = resolve
    })
    vi.spyOn(authClient, 'getMe').mockImplementation(() => {
      startRecovery()
      return recoveryMe
    })
    const selectRuntimeConfig = registeredHandler(
      harness.handleHandlers,
      'auth:selectRuntimeConfig'
    ) as any
    const selection = selectRuntimeConfig(ipcEvent(w1.webContents), { optionId: 'missing-option' })
    await vi.waitFor(() => expect(service.pendingSessionPreclear).not.toBeNull())

    const closed = w1.listeners.get('closed')
    if (!closed) throw new Error('W1 closed callback was not registered')
    w1.isDestroyed.mockReturnValue(true)
    closed()
    harness.appListeners.get('window-all-closed')?.()
    await recoveryStarted
    resolveRecovery(login.me)
    await expect(selection).rejects.toThrow('runtime configuration not found')
    expect(service.pendingSessionPreclear).toBeNull()

    harness.appListeners.get('activate')?.()
    await vi.waitFor(() => expect(harness.windows.filter(w => !w.isDestroyed())).toHaveLength(1))
    const w2 = harness.windows.find(window => !window.isDestroyed()) as any
    if (w2 === w1) throw new Error('Darwin activation did not create replacement W2')
    await vi.waitFor(() => expect(w2.loadFile).toHaveBeenCalledOnce())
    await new Promise<void>(resolve => setImmediate(resolve))
    const ready = w2.listeners.get('ready-to-show')
    if (!ready) throw new Error('W2 ready-to-show callback was not registered')
    w2.show.mockClear()
    ready()
    expect
      .soft(w2.show, 'later W2 load and ready must not bypass retained force-fresh receipt')
      .not.toHaveBeenCalled()
    expect(await commitCurrentDocumentReceipt(w2)).toBe(true)
    expect(w2.show, 'W2 may reveal after its current D2 receipt is accepted').toHaveBeenCalledOnce()
  })

  it('Darwin activation load and ready-to-show cannot reveal W2 before current receipt', async () => {
    const service = harness.service as any
    if (!service) throw new Error('main.ts did not construct the real AppService')
    const mainWindow = harness.windows[0] as any
    const ownContents = mainWindow?.webContents
    if (!mainWindow || !ownContents)
      throw new Error('main.ts did not create the owning BrowserWindow')
    await vi.waitFor(() => expect(mainWindow.loadFile).toHaveBeenCalledOnce())
    await new Promise<void>(resolve => setImmediate(resolve))

    let resolveRetryDialog!: (value: { response: number }) => void
    let pendingDialogSignal: AbortSignal | undefined
    harness.showMessageBox.mockClear()
    harness.showMessageBox.mockImplementationOnce(options => {
      pendingDialogSignal = options?.signal as AbortSignal | undefined
      return new Promise(resolve => {
        resolveRetryDialog = resolve
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
    if (!onClosed) throw new Error('main did not register BrowserWindow destruction')
    mainWindow.isDestroyed.mockReturnValue(true)
    onClosed()
    harness.appListeners.get('window-all-closed')?.()
    expect(harness.windows.filter(w => !w.isDestroyed())).toHaveLength(0)

    // The real Darwin activation entry creates W2 while the native dialog and P remain pending.
    harness.appListeners.get('activate')?.()
    await vi.waitFor(() => expect(harness.windows.filter(w => !w.isDestroyed())).toHaveLength(1))
    const replacement = harness.windows.find(w => !w.isDestroyed()) as any
    await vi.waitFor(() => expect(replacement.loadFile).toHaveBeenCalledOnce())
    await new Promise<void>(resolve => setImmediate(resolve))
    expect
      .soft(replacement.show, 'load completion must not reveal W2 before its D2 receipt')
      .not.toHaveBeenCalled()

    replacement.show.mockClear()
    const readyToShow = replacement.listeners.get('ready-to-show')
    if (!readyToShow) throw new Error('main did not register ready-to-show')
    readyToShow()
    expect
      .soft(replacement.show, 'ready-to-show must not reveal W2 before its D2 receipt')
      .not.toHaveBeenCalled()

    // Close the real pending dialog through its displayed Exit action for bounded cleanup.
    resolveRetryDialog({ response: 1 })
    await new Promise<void>(resolve => setImmediate(resolve))
  })

  it('reveals the same live owner after unchanged Retry and dialog-runner cleanup', async () => {
    const service = harness.service as any
    const window = harness.windows.find(candidate => !candidate.isDestroyed()) as any
    if (!service || !window) throw new Error('main startup did not construct its real owner')
    await vi.waitFor(() => expect(window.loadFile).toHaveBeenCalled())
    const runtimeConfig = await import('../config.js')
    const rest = 'https://rest-a.retry-liveness.test'
    await runtimeConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: '',
      appName: 'Retry liveness test',
    })

    const login = testLoginResult('retry-liveness-session')
    const authClient = service.authClient as any
    vi.spyOn(authClient, 'googleLogin').mockResolvedValue(login)
    vi.spyOn(authClient, 'getDesktopEnvironment').mockResolvedValue({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: '',
      appName: 'Retry liveness test',
    })
    vi.spyOn(authClient, 'getMe')
      .mockRejectedValueOnce(new Error('temporary authority read failure'))
      .mockResolvedValueOnce(login.me)
    vi.spyOn(authClient, 'health').mockResolvedValue({ status: 'ok' })
    vi.spyOn(service.rpcClient, 'health').mockResolvedValue({ status: 'ok' })
    await service.googleLogin('identity-token')
    expect(await service.getSessionState()).toMatchObject({ authenticated: true })

    let resolveRetryDialog!: (value: { response: number }) => void
    harness.showMessageBox
      .mockReset()
      .mockImplementation(() => new Promise(resolve => (resolveRetryDialog = resolve)) as never)
    window.show.mockClear()
    const selectRuntimeConfig = registeredHandler(
      harness.handleHandlers,
      'auth:selectRuntimeConfig'
    ) as any
    const selection = selectRuntimeConfig(ipcEvent(window.webContents), {
      optionId: 'missing-option',
    })
    await vi.waitFor(() => expect(service.pendingSessionPreclear).not.toBeNull())
    const notice = service.pendingSessionPreclear.notice
    const acknowledge = registeredHandler(
      harness.handleHandlers,
      'auth:acknowledgeSessionPreclear'
    ) as any
    await expect(acknowledge(ipcEvent(window.webContents), notice)).resolves.toBe(true)
    await expect(selection).rejects.toThrow('runtime configuration not found')
    await vi.waitFor(() => expect(harness.showMessageBox).toHaveBeenCalledOnce())
    expect(harness.showMessageBox.mock.calls[0]?.[0].buttons).toEqual(['Retry', 'Exit'])

    resolveRetryDialog({ response: 0 })
    await vi.waitFor(() => expect(authClient.getMe).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(service.pendingSessionPreclear).toBeNull())
    await vi.waitFor(() => expect(window.show).toHaveBeenCalledOnce())
    expect(window.isDestroyed()).toBe(false)
    expect(await service.getSessionState()).toMatchObject({
      authenticated: true,
      me: { id: login.me.id },
    })
  })
})
