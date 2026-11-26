import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { format } from 'node:util'
import { pushedBrowserSignInSnapshots } from '../../testSupport/browserSignInHarness.js'
import { buildDesktopLoginCodeLink } from '../browserSignInModel.js'
import type { BrowserSignInSnapshot } from '../types.js'

/**
 * `main.ts`'s browser sign-in wiring (state model X4): the `AppService` options it passes, the
 * snapshot push to the window, the `open-url`, `second-instance` and launch-argument routes of a
 * `desktop-login` link, the power monitor's deadline check, and a matched link during a deferred
 * macOS quit (A3-70). `main.ts` is imported after `vi.resetModules()`, with `electron`,
 * `AppService` and the window's collaborators mocked, as `main.quitDrain.test.ts` does. The router,
 * the link handler and the token store are the real modules.
 */

type MainEvent = {
  senderFrame: { url: string }
  sender: unknown
  returnValue?: unknown
}

const pendingDeferredCleanups = new Set<() => void>()

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let settled = false
  const cleanup = () => {
    if (settled) return
    resolve(undefined as T)
  }
  pendingDeferredCleanups.add(cleanup)
  const promise = new Promise<T>(done => {
    resolve = value => {
      if (settled) return
      settled = true
      pendingDeferredCleanups.delete(cleanup)
      done(value)
    }
  })
  return { promise, resolve }
}

async function settlePendingDeferredCleanups(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
  for (let pass = 0; pendingDeferredCleanups.size > 0; pass += 1) {
    if (pass >= 10) throw new Error('Timed out settling deferred browser sign-in test operations')
    pendingDeferredCleanups.forEach(cleanup => cleanup())
    await new Promise(resolve => setImmediate(resolve))
  }
}

/** Every microtask, and the window creation `requestMainWindow` starts, has run. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

const harness = vi.hoisted(() => {
  const state = {
    handleHandlers: new Map<string, (event: MainEvent) => unknown>(),
    appListeners: new Map<string, (...args: unknown[]) => void>(),
    powerMonitorListeners: new Map<string, Array<() => void>>(),
    windows: [] as Array<Record<string, any>>,
    readyResolver: null as null | (() => void),
    acceptDeepLinks: true,
    serviceOptions: null as null | Record<string, unknown>,
    initialize: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn(async () => 7),
    acceptDesktopLoginLink: vi.fn((_rawUrl: string): boolean => false),
    checkBrowserSignInDeadline: vi.fn((): void => undefined),
    nativeSet: vi.fn(),
    nativeGet: vi.fn(),
    nativeDelete: vi.fn(),
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
const hostPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

vi.mock('keytar', () => ({
  getPassword: harness.nativeGet,
  setPassword: harness.nativeSet,
  deletePassword: harness.nativeDelete,
}))

vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor(options?: Record<string, unknown>) {
      const createWindow = harness.createWindow
      if (!createWindow) throw new Error('the harness has no window factory')
      return createWindow(options)
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
    getPath: () => process.env.TOKEN_STORE_TEST_USER_DATA,
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
    on: vi.fn(),
    handle: vi.fn((channel: string, handler: (event: MainEvent) => unknown) => {
      harness.handleHandlers.set(channel, handler)
    }),
    removeHandler: vi.fn(),
  },
  safeStorage: { isEncryptionAvailable: () => false },
  nativeTheme: { shouldUseDarkColors: false, on: vi.fn() },
  // Every listener is kept: `main.ts` registers several for each power event.
  powerMonitor: {
    on: vi.fn((event: string, listener: () => void) => {
      const listeners = harness.powerMonitorListeners.get(event) ?? []
      listeners.push(listener)
      harness.powerMonitorListeners.set(event, listeners)
    }),
  },
  Notification: vi.fn(),
  clipboard: { writeText: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
}))

vi.mock('../appService.js', () => ({
  AppService: class {
    constructor(options: Record<string, unknown> = {}) {
      harness.serviceOptions = options
    }
    initialize = harness.initialize
    logout = harness.logout
    getSessionGeneration = () => 0
    acceptDesktopLoginLink = harness.acceptDesktopLoginLink
    checkBrowserSignInDeadline = harness.checkBrowserSignInDeadline
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
    acceptDeepLinks: harness.acceptDeepLinks,
    registerOsProtocols: false,
  })),
  formatDevIsolationLogLine: vi.fn(),
  publicDevIsolationRecord: vi.fn(),
  verifyDevIsolationRuntime: vi.fn(() => ({ ok: true })),
}))
vi.mock('../ipc.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../ipc.js')>()
  return { ...actual, registerIpcHandlers: vi.fn() }
})
vi.mock('../mainWindowReadiness.js', () => ({ wireMainWindowRendererReadiness: vi.fn() }))
vi.mock('../pluginSdkRuntime.js', () => ({ initPluginSdkRuntime: vi.fn() }))
vi.mock('../protocolLaunchArgs.js', async importOriginal => {
  const original = await importOriginal<typeof import('../protocolLaunchArgs.js')>()
  return { ...original, shouldRegisterOsProtocols: vi.fn(() => false) }
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

// PR 2's builder writes the link the Profile UI sends to end a Desktop sign-in.
const LINK_STATE = 'fake-desktop-login-state-'.padEnd(43, 's')
const LINK_CODE = 'fake-desktop-login-code-'.padEnd(43, 'c')
const DESKTOP_LOGIN_LINK = buildDesktopLoginCodeLink({
  state: LINK_STATE,
  code: LINK_CODE,
  environment: 'https://api-link.example.test',
})
const DESKTOP_SETUP_LINK =
  'evenfire://desktop-setup?email=user%40example.test&authorizationToken=fake-setup-token'
const DESKTOP_SETUP_PAYLOAD = { email: 'user@example.test', authorizationToken: 'fake-setup-token' }
const TRUSTED_SENDER_URL = 'file:///app/ui-dist/index.html'
const CONSOLE_METHODS = ['debug', 'error', 'info', 'log', 'warn'] as const

async function startMain(): Promise<void> {
  await import('../main.js')
  harness.readyResolver?.()
  await vi.waitFor(() => expect(harness.windows).toHaveLength(1))
}

function mainWindow(): Record<string, any> {
  const window = harness.windows[0]
  if (!window) throw new Error('main.ts created no window')
  return window
}

function openUrl(rawUrl: string): void {
  const listener = harness.appListeners.get('open-url')
  if (!listener) throw new Error('main.ts registered no open-url listener')
  listener({ preventDefault: vi.fn() }, rawUrl)
}

function secondInstance(argv: string[]): void {
  const listener = harness.appListeners.get('second-instance')
  if (!listener) throw new Error('main.ts registered no second-instance listener')
  listener({}, argv)
}

/**
 * Emits a power event as Electron's `EventEmitter.emit` does: each listener in the order it was
 * registered, and a throw leaves `emit` before the listeners after it run.
 */
function emitPowerEvent(event: string): void {
  for (const listener of harness.powerMonitorListeners.get(event) ?? []) listener()
}

function markRendererReady(window: Record<string, any>): void {
  const rendererReady = harness.handleHandlers.get('app:rendererReady')
  if (!rendererReady) throw new Error('main.ts registered no app:rendererReady handler')
  rendererReady({ senderFrame: { url: TRUSTED_SENDER_URL }, sender: window.webContents })
}

/** The window's `closed` listener runs and the window is gone, as when the user closes it. */
function closeMainWindow(): void {
  const window = mainWindow()
  const closed = window.on.mock.calls.find((call: unknown[]) => call[0] === 'closed')?.[1]
  if (typeof closed !== 'function') throw new Error('main.ts registered no closed listener')
  closed()
  harness.windows.splice(0)
}

function quitEvent() {
  return {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    },
  }
}

function spyOnConsole() {
  return CONSOLE_METHODS.map(method =>
    vi.spyOn(console, method).mockImplementation(() => undefined)
  )
}

/** No console line carries the link, its state or its code (D18). */
function expectNoLinkLogged(logs: ReturnType<typeof spyOnConsole>): void {
  for (const log of logs) {
    for (const call of log.mock.calls) {
      const line = format(...call)
      for (const secret of [DESKTOP_LOGIN_LINK, LINK_STATE, LINK_CODE]) {
        expect(line).not.toContain(secret)
      }
    }
  }
}

describe('main.ts browser sign-in wiring', () => {
  let originalPlatformDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    if (!originalPlatformDescriptor)
      throw new Error('Node process.platform descriptor is unavailable')
    // A3-70's deferred quit exists on macOS only (`main.ts` will-quit).
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'darwin' })
    vi.resetModules()
    harness.appListeners.clear()
    harness.handleHandlers.clear()
    harness.powerMonitorListeners.clear()
    harness.windows.length = 0
    harness.readyResolver = null
    harness.acceptDeepLinks = true
    harness.serviceOptions = null
    harness.initialize.mockReset().mockResolvedValue(undefined)
    harness.logout.mockReset().mockResolvedValue(7)
    harness.acceptDesktopLoginLink.mockReset().mockReturnValue(false)
    harness.checkBrowserSignInDeadline.mockReset()
    harness.nativeSet.mockReset().mockResolvedValue(undefined)
    harness.nativeGet.mockReset().mockResolvedValue(null)
    harness.nativeDelete.mockReset().mockResolvedValue(true)
  })

  afterEach(async () => {
    try {
      const { openTokenStoreAdmission, waitForTokenStoreOperations } =
        await import('../tokenStore.js')
      openTokenStoreAdmission()
      await settlePendingDeferredCleanups()
      await waitForTokenStoreOperations()
      await new Promise(resolve => setImmediate(resolve))
      const { app } = await import('electron')
      vi.mocked(app.quit).mockReset()
      vi.mocked(app.exit).mockReset()
      vi.restoreAllMocks()
    } finally {
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor)
      }
    }
  })

  afterAll(() => {
    expect(Object.getOwnPropertyDescriptor(process, 'platform')).toEqual(hostPlatformDescriptor)
  })

  it.each([true, false])(
    'builds AppService with browserSignInLinksAvailable %s from the dev-isolation policy',
    async acceptDeepLinks => {
      harness.acceptDeepLinks = acceptDeepLinks
      await startMain()

      const options = harness.serviceOptions
      expect(options?.browserSignInLinksAvailable).toBe(acceptDeepLinks)
      // The test-only seams stay out of the running app (AppServiceOptions).
      expect(options).not.toHaveProperty('onSessionGenerationAdvanced')
      expect(options).not.toHaveProperty('browserSignInClock')
    }
  )

  it('forwards each snapshot to the main window, and does nothing without one', async () => {
    await startMain()
    const forward = harness.serviceOptions?.onBrowserSignInChanged
    expect(forward).toBeTypeOf('function')
    const push = forward as (snapshot: BrowserSignInSnapshot) => void
    const snapshots = await pushedBrowserSignInSnapshots()
    // C-1: the redeeming phase, both closed reasons and the idle snapshot cross as they are.
    expect(snapshots.map(snapshot => snapshot.phase)).toEqual([
      'waiting',
      'redeeming',
      'ended',
      'idle',
      'waiting',
      'ended',
      'waiting',
      'ended',
    ])
    const window = mainWindow()
    window.webContents.send.mockClear()

    for (const snapshot of snapshots) push(snapshot)
    expect(window.webContents.send.mock.calls).toEqual(
      snapshots.map(snapshot => ['auth:browserSignInResult', snapshot])
    )

    window.isDestroyed.mockReturnValue(true)
    push(snapshots[0] as BrowserSignInSnapshot)
    expect(window.webContents.send).toHaveBeenCalledTimes(snapshots.length)

    window.isDestroyed.mockReturnValue(false)
    closeMainWindow()
    expect(() => push(snapshots[0] as BrowserSignInSnapshot)).not.toThrow()
    expect(window.webContents.send).toHaveBeenCalledTimes(snapshots.length)
  })

  it('G2-8a main-level: open-url and second-instance each hand a desktop-login link to the service once', async () => {
    await startMain()
    const window = mainWindow()
    markRendererReady(window)
    window.webContents.send.mockClear()
    harness.acceptDesktopLoginLink.mockReturnValue(true)
    const logs = spyOnConsole()

    openUrl(DESKTOP_LOGIN_LINK)
    expect(harness.acceptDesktopLoginLink.mock.calls).toEqual([[DESKTOP_LOGIN_LINK]])

    secondInstance([process.execPath, DESKTOP_LOGIN_LINK])
    expect(harness.acceptDesktopLoginLink.mock.calls).toEqual([
      [DESKTOP_LOGIN_LINK],
      [DESKTOP_LOGIN_LINK],
    ])

    await flush()
    // The router never sends a desktop-login link to the renderer (D8).
    expect(window.webContents.send).not.toHaveBeenCalled()
    expect(harness.windows).toHaveLength(1)
    expectNoLinkLogged(logs)
  })

  it('G2-12a main-level: resume calls the deadline check once', async () => {
    await startMain()
    const window = mainWindow()
    window.webContents.send.mockClear()
    const resume = harness.powerMonitorListeners.get('resume') ?? []
    const unlockScreen = harness.powerMonitorListeners.get('unlock-screen') ?? []

    for (const listener of resume) listener()
    // The listeners ran: the renderer's own resume tick went out.
    expect(window.webContents.send.mock.calls).toEqual([['system:resume']])
    expect(harness.checkBrowserSignInDeadline).toHaveBeenCalledTimes(1)

    for (const listener of unlockScreen) listener()
    expect(window.webContents.send.mock.calls).toEqual([['system:resume'], ['system:resume']])
    expect(harness.checkBrowserSignInDeadline).toHaveBeenCalledTimes(2)
  })

  it.each([
    ["the renderer's resume tick", 'fake resume tick failure'],
    ["the sandbox UI's resume notice", 'fake sandbox UI resume failure'],
  ])('checks the deadline on a power event even when %s throws', async (_listener, failure) => {
    await startMain()
    const window = mainWindow()
    const { notifySandboxUiHostResumed } = await import('../sandboxUiSessionRefresh.js')
    const thrower =
      failure === 'fake resume tick failure'
        ? window.webContents.send
        : vi.mocked(notifySandboxUiHostResumed)
    thrower.mockImplementation(() => {
      throw new Error(failure)
    })

    for (const event of ['resume', 'unlock-screen']) {
      harness.checkBrowserSignInDeadline.mockClear()
      thrower.mockClear()
      expect(() => emitPowerEvent(event)).toThrow(failure)
      // The throwing listener ran, and the deadline check ran too.
      expect(thrower, event).toHaveBeenCalledTimes(1)
      expect(harness.checkBrowserSignInDeadline, event).toHaveBeenCalledTimes(1)
    }
  })

  it('A3-70 a matched link during a deferred quit cancels it', async () => {
    await startMain()
    const heldWrite = deferred<void>()
    const successorWrite = deferred<void>()
    harness.nativeSet
      .mockImplementationOnce(() => heldWrite.promise)
      .mockImplementationOnce(() => successorWrite.promise)
    harness.acceptDesktopLoginLink.mockReturnValue(true)
    const { TokenStore } = await import('../tokenStore.js')
    const { app } = await import('electron')
    const quit = vi.mocked(app.quit)
    quit.mockClear()
    const held = new TokenStore().setSessionToken('synthetic-held', 'held-aaaaaaaaaaaa')
    let successor: Promise<void> | undefined
    try {
      await vi.waitFor(() => expect(harness.nativeSet).toHaveBeenCalledTimes(1))
      closeMainWindow()
      const willQuit = quitEvent()
      harness.appListeners.get('will-quit')?.(willQuit)
      expect(willQuit.defaultPrevented).toBe(true)
      successor = new TokenStore().setSessionToken('synthetic-successor', 'next-aaaaaaaaaaaa')
      await flush()
      // Admission is closed: the successor waits behind it.
      expect(harness.nativeSet).toHaveBeenCalledTimes(1)

      openUrl(DESKTOP_LOGIN_LINK)
      expect(harness.acceptDesktopLoginLink.mock.calls).toEqual([[DESKTOP_LOGIN_LINK]])
      await flush()

      // Admission is open again: the queued successor has reached the keychain.
      expect(harness.nativeSet).toHaveBeenCalledTimes(2)
      expect(harness.windows).toHaveLength(1)
      heldWrite.resolve()
      await held
      successorWrite.resolve()
      await successor
      await flush()
      expect(quit).not.toHaveBeenCalled()
    } finally {
      heldWrite.resolve()
      successorWrite.resolve()
      const { openTokenStoreAdmission } = await import('../tokenStore.js')
      openTokenStoreAdmission()
      await held
      if (successor) await successor
    }
  })

  it('A3-70 an unmatched link during a deferred quit leaves it, and the quit completes', async () => {
    await startMain()
    const heldWrite = deferred<void>()
    harness.nativeSet.mockImplementationOnce(() => heldWrite.promise)
    const { TokenStore } = await import('../tokenStore.js')
    const { app } = await import('electron')
    const quit = vi.mocked(app.quit)
    quit.mockClear()
    const held = new TokenStore().setSessionToken('synthetic-held', 'held-aaaaaaaaaaaa')
    try {
      await vi.waitFor(() => expect(harness.nativeSet).toHaveBeenCalledTimes(1))
      closeMainWindow()
      const willQuit = quitEvent()
      harness.appListeners.get('will-quit')?.(willQuit)
      expect(willQuit.defaultPrevented).toBe(true)

      openUrl(DESKTOP_LOGIN_LINK)
      expect(harness.acceptDesktopLoginLink.mock.calls).toEqual([[DESKTOP_LOGIN_LINK]])
      await flush()
      expect(harness.windows).toHaveLength(0)
      expect(quit).not.toHaveBeenCalled()

      heldWrite.resolve()
      await held
      await flush()
      expect(quit).toHaveBeenCalledTimes(1)
      expect(harness.windows).toHaveLength(0)
    } finally {
      heldWrite.resolve()
      await held
    }
  })

  it('never routes a desktop-login link from the launch arguments, and still sends a desktop-setup one', async () => {
    const launchArgv = process.argv
    process.argv = [...launchArgv, DESKTOP_LOGIN_LINK, DESKTOP_SETUP_LINK]
    try {
      await startMain()
    } finally {
      process.argv = launchArgv
    }
    const window = mainWindow()
    window.webContents.send.mockClear()

    markRendererReady(window)

    expect(window.webContents.send).toHaveBeenCalledWith(
      'auth:desktopSetupToken',
      DESKTOP_SETUP_PAYLOAD
    )
    expect(harness.acceptDesktopLoginLink).not.toHaveBeenCalled()
  })

  // Task 5 concern 2: acceptance never throws by contract, and the Electron handlers must not
  // depend on that. The error's message carries the link, so a log of the message would show.
  it('drops a desktop-login link whose handling throws, and the Electron handlers carry on', async () => {
    await startMain()
    const window = mainWindow()
    markRendererReady(window)
    window.webContents.send.mockClear()
    harness.acceptDesktopLoginLink.mockImplementation(() => {
      throw new Error(`fake acceptance failure for ${DESKTOP_LOGIN_LINK}`)
    })
    const logs = spyOnConsole()
    const warn = vi.mocked(console.warn)

    // The desktop-setup link after the failing one is still routed.
    expect(() =>
      secondInstance([process.execPath, DESKTOP_LOGIN_LINK, DESKTOP_SETUP_LINK])
    ).not.toThrow()
    expect(harness.acceptDesktopLoginLink).toHaveBeenCalledTimes(1)
    expect(window.webContents.send).toHaveBeenCalledWith(
      'auth:desktopSetupToken',
      DESKTOP_SETUP_PAYLOAD
    )

    // With no window, the dropped link requests none.
    closeMainWindow()
    expect(() => openUrl(DESKTOP_LOGIN_LINK)).not.toThrow()
    expect(harness.acceptDesktopLoginLink).toHaveBeenCalledTimes(2)
    await flush()
    expect(harness.windows).toHaveLength(0)

    expect(warn.mock.calls).toEqual([
      ['[Desktop] A desktop-login link could not be handled:', 'Error'],
      ['[Desktop] A desktop-login link could not be handled:', 'Error'],
    ])
    expectNoLinkLogged(logs)
  })
})
