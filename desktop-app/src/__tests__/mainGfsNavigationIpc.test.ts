import { beforeAll, describe, expect, it, vi } from 'vitest'
import { buildSandboxUiDeepLink, parseSandboxUiDeepLink } from '@clerum/desktop-app-links'
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
    sessionPreclearAuthorityChanging: null as null | ((notice: any) => void),
    sessionPreclearAuthorityChanged: null as null | ((notice: any) => void),
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

vi.mock('../appService.js', () => ({
  AppService: class {
    constructor(options?: {
      onSandboxUiSessionInvalidated?: () => void
      onSessionCleared?: () => void
      onSessionPreclear?: (notice: any) => boolean | void
      onSessionPreclearTimeout?: (notice: any) => void
      onSessionPreclearCancelled?: (notice: any) => void
      onSessionPreclearRecoveryRequired?: (notice: any, state: any) => void
      onSessionPreclearAuthorityChanging?: (notice: any) => void
      onSessionPreclearAuthorityChanged?: (notice: any) => void
      onSessionPreclearAwaitingReceipt?: (notice: any, state: any) => void
      onSessionPreclearReceiptCommitted?: (notice: any) => void
      onSessionPreclearRetired?: (notice: any) => void
    }) {
      harness.invalidateSandboxUiSession = options?.onSandboxUiSessionInvalidated ?? null
      harness.sessionCleared = options?.onSessionCleared ?? null
      harness.sessionPreclear = options?.onSessionPreclear ?? null
      harness.sessionPreclearTimeout = options?.onSessionPreclearTimeout ?? null
      harness.sessionPreclearCancelled = options?.onSessionPreclearCancelled ?? null
      harness.sessionPreclearRecoveryRequired = options?.onSessionPreclearRecoveryRequired ?? null
      harness.sessionPreclearAuthorityChanging = options?.onSessionPreclearAuthorityChanging ?? null
      harness.sessionPreclearAuthorityChanged = options?.onSessionPreclearAuthorityChanged ?? null
      harness.sessionPreclearAwaitingReceipt = options?.onSessionPreclearAwaitingReceipt ?? null
      harness.sessionPreclearReceiptCommitted = options?.onSessionPreclearReceiptCommitted ?? null
      harness.sessionPreclearRetired = options?.onSessionPreclearRetired ?? null
    }
    initialize = harness.initialize
    logout = harness.logout
    getSessionGeneration = () => harness.sessionGeneration
    beginMarkdownTabCloseDocument = () => true
    retireMarkdownTabCloseDocument = vi.fn()
    isSessionAuthorityBindingCurrent = () => true
    completeSessionPreclearRendererReceipt = () => true
    waitForSessionPreclearRendererReceipt = async () => true
    retrySessionPreclearRecovery = harness.retryRecovery
    exitSessionPreclearRecovery = harness.exitRecovery
    getSessionState = async () => ({
      authenticated: false,
      sessionGeneration: harness.sessionGeneration,
      me: null,
      authorityBinding: {
        environmentKey: 'test',
        restBaseUrl: 'https://rest.example.test',
        rpcBaseUrl: 'https://rpc.example.test',
      },
    })
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
  beforeAll(async () => {
    await import('../main.js')
    harness.readyResolver?.()
    await vi.waitFor(() => {
      expect(harness.registeredLogout).toBeTypeOf('function')
      expect(harness.windows).toHaveLength(1)
    })
  })

  it('keeps the frameless custom chrome square on Linux only', () => {
    expect(harness.windows[0]?.options).toEqual(
      expect.objectContaining({
        frame: false,
        roundedCorners: process.platform !== 'linux',
      })
    )
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

  it('notifies a fresh renderer before revealing a cleared session', () => {
    const ownContents = harness.windows[0]?.webContents
    if (!ownContents) throw new Error('main.ts did not create the owning BrowserWindow')
    if (!harness.sessionCleared) throw new Error('main.ts did not pass onSessionCleared')
    ownContents.send.mockClear()
    const mainWindow = harness.windows[0]
    if (!mainWindow) throw new Error('main.ts did not create the owning BrowserWindow')
    mainWindow.show.mockClear()

    harness.sessionCleared()

    expect(mainWindow.hide).toHaveBeenCalledOnce()
    expect(ownContents.reload).toHaveBeenCalledOnce()
    expect(mainWindow.show).not.toHaveBeenCalled()
    const rendererReady = registeredHandler(harness.handleHandlers, 'app:rendererReady')
    rendererReady(ipcEvent(ownContents))
    expect(ownContents.send).toHaveBeenCalledWith('auth:sessionCleared')
    expect(mainWindow.show).toHaveBeenCalledOnce()
    rendererReady(ipcEvent(ownContents))
    expect(
      ownContents.send.mock.calls.filter(([channel]) => channel === 'auth:sessionCleared')
    ).toHaveLength(1)
  })

  it('keeps post-invalidation App and resource links above the main queue reset floors', () => {
    const mainWindow = harness.windows[0]
    const ownContents = mainWindow?.webContents
    if (!ownContents) throw new Error('main.ts did not create the owning BrowserWindow')
    const listAppLinks = registeredHandler(
      harness.handleHandlers,
      'sandboxUi:listPendingDeepLinks'
    ) as (event: MainEvent) => { links: Array<Record<string, unknown>> }
    const listGfsLinks = registeredHandler(harness.handleHandlers, 'gfs:listPendingDeepLinks') as (
      event: MainEvent
    ) => { links: Array<Record<string, unknown>> }
    const appLink = buildSandboxUiDeepLink({ recipeNs: 'ns', recipeName: 'app', path: '/inbox' })
    const resourceUri = 'gfs://main/0123456789abcdef0123456789abcdef'
    expect(parseSandboxUiDeepLink(appLink)).toBeTruthy()
    ownContents.send.mockClear()
    const openUrl = harness.appListeners.get('open-url')
    if (!openUrl) throw new Error('main.ts did not register the OS deep-link route')

    harness.parseSandboxUiDeepLink.mockReturnValue(parseSandboxUiDeepLink(appLink))
    openUrl({ preventDefault: vi.fn() }, appLink)
    harness.parseSandboxUiDeepLink.mockReturnValue(null)
    openUrl({ preventDefault: vi.fn() }, buildGfsResourceDeepLink(resourceUri))
    const priorApp = listAppLinks(ipcEvent(ownContents)).links[0]
    const priorGfs = listGfsLinks(ipcEvent(ownContents)).links[0]
    expect({ priorApp, priorGfs }).toEqual(
      expect.objectContaining({ priorApp: expect.anything(), priorGfs: expect.anything() })
    )

    harness.sessionGeneration = 23
    harness.invalidateSandboxUiSession?.()

    expect(listAppLinks(ipcEvent(ownContents)).links).toEqual([])
    expect(listGfsLinks(ipcEvent(ownContents)).links).toEqual([])
    const invalidation = ownContents.send.mock.calls
      .filter(([channel]) => channel === 'sandboxUi:sessionInvalidated')
      .at(-1)
    const reset = invalidation?.[1] as
      | {
          sessionGeneration: number
          appDeepLinkMinimumId: number
          gfsDeepLinkMinimumId: number
        }
      | undefined
    expect(reset).toEqual({
      sessionGeneration: 23,
      appDeepLinkMinimumId: Number(priorApp.id) + 1,
      gfsDeepLinkMinimumId: Number(priorGfs.id) + 1,
    })

    const postInvalidationAppUrl = buildSandboxUiDeepLink({
      recipeNs: 'ns',
      recipeName: 'after',
      path: '/after',
    })
    harness.parseSandboxUiDeepLink.mockReturnValue(parseSandboxUiDeepLink(postInvalidationAppUrl))
    openUrl({ preventDefault: vi.fn() }, postInvalidationAppUrl)
    harness.parseSandboxUiDeepLink.mockReturnValue(null)
    openUrl({ preventDefault: vi.fn() }, buildGfsResourceDeepLink(resourceUri))
    const postApp = listAppLinks(ipcEvent(ownContents)).links
    const postGfs = listGfsLinks(ipcEvent(ownContents)).links
    expect(postApp).toHaveLength(1)
    expect(postGfs).toHaveLength(1)
    expect(postApp[0]?.id).toBe(reset?.appDeepLinkMinimumId)
    expect(postApp[0]).toMatchObject({ userNavigationGenerationAtActivation: 1 })
    expect(postGfs[0]?.id).toBe(reset?.gfsDeepLinkMinimumId)
  })
  it.each(['sandboxUi', 'gfs'] as const)(
    'atomically guards %s exact-ID retirement with current session and navigation authority',
    family => {
      const ownContents = harness.windows[0]?.webContents
      if (!ownContents) throw new Error('main.ts did not create the owning BrowserWindow')
      const owner = ipcEvent(ownContents)
      const list = registeredHandler(harness.handleHandlers, family + ':listPendingDeepLinks') as (
        event: MainEvent
      ) => { links: Array<{ id: number }> }
      const clear = registeredHandler(harness.handleHandlers, family + ':clearPendingDeepLinks')
      const acknowledge = registeredHandler(
        harness.handleHandlers,
        family + ':acknowledgeDeepLink'
      ) as (event: MainEvent, payload: unknown) => unknown
      const navigation = registeredHandler(harness.onHandlers, 'gfs:getUserNavigationGeneration')
      const advance = registeredHandler(harness.onHandlers, 'gfs:advanceUserNavigationGeneration')
      const openUrl = harness.appListeners.get('open-url')
      if (!openUrl) throw new Error('main.ts did not register protocol routing')
      const enqueue = (suffix: string) => {
        harness.parseSandboxUiDeepLink.mockImplementation(parseSandboxUiDeepLink)
        const url =
          family === 'sandboxUi'
            ? buildSandboxUiDeepLink({ recipeNs: 'ns', recipeName: 'guarded', path: '/' + suffix })
            : buildGfsResourceDeepLink('gfs://main/' + (suffix === 'first' ? 'a' : 'b').repeat(32))
        openUrl({ preventDefault: vi.fn() }, url)
      }

      clear(owner)
      enqueue('first')
      enqueue('second')
      const links = list(owner).links
      expect(links).toHaveLength(2)
      const id = links[0]!.id
      const otherId = links[1]!.id
      const event = ipcEvent(ownContents)
      navigation(event)
      const userNavigationGeneration = event.returnValue as number
      harness.sessionGeneration = 40
      const authority = { sessionGeneration: 40, userNavigationGeneration }

      for (const invalid of [
        undefined,
        null,
        {},
        [],
        { ...authority, sessionGeneration: -1 },
        { ...authority, userNavigationGeneration: 0.5 },
        { ...authority, sessionGeneration: Number.MAX_SAFE_INTEGER + 1 },
      ]) {
        expect(() => acknowledge(owner, { id, authority: invalid })).toThrow()
        expect(list(owner).links).toEqual(links)
      }
      for (const denied of [
        ipcEvent(ownContents, 'https://untrusted.example/'),
        ipcEvent({ id: 99 }),
      ]) {
        expect(() => acknowledge(denied, { id, authority })).toThrow()
        expect(list(owner).links).toEqual(links)
      }
      expect(acknowledge(owner, { id: Number.MAX_SAFE_INTEGER, authority })).toBe(false)
      harness.sessionGeneration = 41
      expect(acknowledge(owner, { id, authority })).toBe(false)
      expect(list(owner).links).toEqual(links)
      harness.sessionGeneration = 40
      advance(ipcEvent(ownContents))
      expect(acknowledge(owner, { id, authority })).toBe(false)
      expect(list(owner).links).toEqual(links)

      navigation(event)
      const currentAuthority = {
        ...authority,
        userNavigationGeneration: event.returnValue as number,
      }
      expect(acknowledge(owner, { id, authority: currentAuthority })).toBe(true)
      expect(list(owner).links.map(link => link.id)).toEqual([otherId])
      expect(acknowledge(owner, { id, authority: currentAuthority })).toBe(false)
      harness.sessionGeneration = 41
      expect(acknowledge(owner, { id: otherId, authority: currentAuthority })).toBe(false)
      expect(list(owner).links.map(link => link.id)).toEqual([otherId])
      expect(acknowledge(owner, { id: otherId })).toBeUndefined()
      expect(list(owner).links).toEqual([])
      harness.sessionGeneration = 0
    }
  )
})
