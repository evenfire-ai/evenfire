import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

type MainEvent = {
  senderFrame: { url: string }
  sender: unknown
  returnValue?: unknown
}
type SyncHandler = (event: MainEvent) => void

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

type CanceledQuitModel = {
  quitStarted: boolean
  queuedTokenWrite: boolean
  windowAndAdmissionReopened: boolean
  nativeOperationCompleted: boolean
}
type CanceledQuitReal = {
  scheduler: fc.Scheduler
  beginQuit: () => void
  queueTokenWrite: () => void
  reopenWindow: () => Promise<void>
  nativeOperation: () => Promise<string>
}

class CanceledQuitSequenceCommand implements fc.AsyncCommand<CanceledQuitModel, CanceledQuitReal> {
  check(model: Readonly<CanceledQuitModel>): boolean {
    return !model.quitStarted
  }
  async run(model: CanceledQuitModel, real: CanceledQuitReal): Promise<void> {
    real.beginQuit()
    model.quitStarted = true
    real.queueTokenWrite()
    await new Promise(resolve => setImmediate(resolve))
    model.queuedTokenWrite = true
    await real.reopenWindow()
    model.windowAndAdmissionReopened = true
    const scheduled = real.scheduler.schedule(
      Promise.resolve().then(() => real.nativeOperation()),
      'native-operation-after-cancel'
    )
    const result = await real.scheduler.waitFor(scheduled)
    expect(result).toBe('reopened-operation-completed')
    model.nativeOperationCompleted = true
  }
  toString(): string {
    return 'cancel-deferred-quit-and-complete-native-operation'
  }
}

type TerminalQuitModel = {
  terminalQuitReached: boolean
  ownerQueueReleased: boolean
  postCloseTokenWritePending: boolean
}
type TerminalQuitReal = {
  scheduler: fc.Scheduler
  terminalQuit: () => boolean
  releaseOwner: () => void
  ownerOperation: Promise<string>
  queuedTokenOperation: Promise<void>
  tokenWriteStarted: () => boolean
}
class TerminalQuitSequenceCommand implements fc.AsyncCommand<TerminalQuitModel, TerminalQuitReal> {
  check(model: Readonly<TerminalQuitModel>): boolean {
    return !model.terminalQuitReached
  }
  async run(model: TerminalQuitModel, real: TerminalQuitReal): Promise<void> {
    const prevented = real.terminalQuit()
    expect(prevented).toBe(false)
    model.terminalQuitReached = true
    const release = real.scheduler.schedule(
      Promise.resolve().then(() => real.releaseOwner()),
      'release-owner-after-token-admission-closes'
    )
    await real.scheduler.waitFor(release)
    await expect(real.ownerOperation).resolves.toBe('active-owner-finished')
    model.ownerQueueReleased = true
    await new Promise(resolve => setImmediate(resolve))
    let queuedSettled = false
    void real.queuedTokenOperation.then(
      () => {
        queuedSettled = true
      },
      () => {
        queuedSettled = true
      }
    )
    await new Promise(resolve => setImmediate(resolve))
    expect(real.tokenWriteStarted()).toBe(false)
    expect(queuedSettled).toBe(false)
    model.postCloseTokenWritePending = !queuedSettled
  }
  toString(): string {
    return 'terminal-quit-closes-token-admission-before-queued-owner-work'
  }
}

const pendingDeferredCleanups = new Set<() => void>()

async function settlePendingDeferredCleanups(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
  for (let pass = 0; pendingDeferredCleanups.size > 0; pass += 1) {
    if (pass >= 10) throw new Error('Timed out settling deferred Quit test operations')
    pendingDeferredCleanups.forEach(cleanup => cleanup())
    await new Promise(resolve => setImmediate(resolve))
  }
}

const harness = vi.hoisted(() => {
  const state = {
    onHandlers: new Map<string, SyncHandler>(),
    handleHandlers: new Map<string, (event: MainEvent) => unknown>(),
    appListeners: new Map<string, (...args: unknown[]) => void>(),
    windows: [] as Array<Record<string, any>>,
    readyResolver: null as null | (() => void),
    initialize: vi.fn().mockResolvedValue(undefined),
    beginShutdown: vi.fn(),
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
const hostPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

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
    beginShutdown = harness.beginShutdown
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

describe('macOS Quit drain', () => {
  let originalPlatformDescriptor: PropertyDescriptor | undefined

  beforeEach(async () => {
    originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    if (!originalPlatformDescriptor)
      throw new Error('Node process.platform descriptor is unavailable')
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'darwin' })
    vi.resetModules()
    harness.appListeners.clear()
    harness.onHandlers.clear()
    harness.handleHandlers.clear()
    harness.windows.length = 0
    harness.readyResolver = null
    harness.initialize.mockReset().mockResolvedValue(undefined)
    harness.beginShutdown.mockReset()
    harness.nativeSet.mockReset().mockResolvedValue(undefined)
    harness.nativeGet.mockReset().mockResolvedValue(null)
    harness.nativeDelete.mockReset().mockResolvedValue(true)
    harness.logout.mockReset().mockResolvedValue(7)
    harness.sessionGeneration = 0
    harness.invalidateSandboxUiSession = null
    harness.sessionCleared = null
    harness.registeredLogout = null
  })

  async function startMain(): Promise<void> {
    await import('../main.ts')
    harness.readyResolver?.()
    await vi.waitFor(() => expect(harness.windows).toHaveLength(1))
  }

  afterEach(async () => {
    try {
      const { openTokenStoreAdmission, waitForTokenStoreOperations } =
        await import('../tokenStore.ts')
      openTokenStoreAdmission()
      await settlePendingDeferredCleanups()
      await waitForTokenStoreOperations()
      await new Promise(resolve => setImmediate(resolve))

      const { app } = await import('electron')
      vi.mocked(app.quit).mockReset()
      vi.mocked(app.exit).mockReset()
      vi.restoreAllMocks()
      harness.appListeners.clear()
      harness.onHandlers.clear()
      harness.handleHandlers.clear()
      harness.windows.length = 0
      harness.readyResolver = null
      harness.initialize.mockReset().mockResolvedValue(undefined)
      harness.beginShutdown.mockReset()
      harness.logout.mockReset().mockResolvedValue(7)
      harness.nativeSet.mockReset().mockResolvedValue(undefined)
      harness.nativeGet.mockReset().mockResolvedValue(null)
      harness.nativeDelete.mockReset().mockResolvedValue(true)
      harness.sessionGeneration = 0
      harness.invalidateSandboxUiSession = null
      harness.sessionCleared = null
      harness.registeredLogout = null
    } finally {
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor)
      }
    }
  })

  afterAll(() => {
    expect(Object.getOwnPropertyDescriptor(process, 'platform')).toEqual(hostPlatformDescriptor)
  })

  it('reopens admission and cancels the stale retry when a window is requested during drain', async () => {
    await startMain()
    harness.nativeSet.mockReset()
    const releases: Array<() => void> = []
    harness.nativeSet.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          const release = () => {
            pendingDeferredCleanups.delete(release)
            resolve()
          }
          pendingDeferredCleanups.add(release)
          releases.push(release)
        })
    )
    const { TokenStore } = await import('../tokenStore.ts')
    const { app } = await import('electron')
    const quit = vi.mocked(app.quit)
    quit.mockClear()
    const first = new TokenStore().setSessionToken('synthetic-first', 'first-aaaaaaaaaaaa')
    let second: Promise<void> | undefined
    try {
      await vi.waitFor(() => expect(harness.nativeSet).toHaveBeenCalledTimes(1))
      const closed = harness.windows[0].on.mock.calls.find((c: unknown[]) => c[0] === 'closed')?.[1]
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
  })

  it('reopens admission when a synchronous listener cancels a no-work Quit', async () => {
    await startMain()
    const { TokenStore } = await import('../tokenStore.ts')
    const willQuit = harness.appListeners.get('will-quit')
    expect(willQuit).toBeTypeOf('function')
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      },
    }
    let write: Promise<void> | undefined
    try {
      willQuit?.(event)
      event.preventDefault()
      write = new TokenStore().setSessionToken('synthetic-canceled-quit', 'cancel-aaaaaaaaaaaa')
      await vi.waitFor(() => expect(harness.nativeSet).toHaveBeenCalledTimes(1))
      await write
      expect(event.defaultPrevented).toBe(true)
    } finally {
      const { openTokenStoreAdmission } = await import('../tokenStore.ts')
      openTokenStoreAdmission()
      await write
    }
  })

  it('cancels Quit before a token-dependent main-window initializer can block', async () => {
    const firstNativeWrite = deferred<void>()
    const initializerRead = deferred<string | null>()
    harness.initialize.mockRejectedValueOnce(new Error('synthetic first initialization failure'))
    const initializationError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await startMain()
      expect(initializationError).toHaveBeenCalledWith(
        '[Desktop] Could not initialize the desktop session:',
        expect.any(Error)
      )
    } finally {
      initializationError.mockRestore()
    }
    harness.initialize.mockClear()
    harness.nativeSet.mockImplementationOnce(() => firstNativeWrite.promise)
    harness.nativeGet.mockImplementationOnce(() => initializerRead.promise)
    const { TokenStore } = await import('../tokenStore.ts')
    const { app } = await import('electron')
    const first = new TokenStore().setSessionToken('synthetic-first', 'first-aaaaaaaaaaaa')
    try {
      await vi.waitFor(() => expect(harness.nativeSet).toHaveBeenCalledTimes(1))
      const closed = harness.windows[0].on.mock.calls.find(
        (call: unknown[]) => call[0] === 'closed'
      )?.[1]
      expect(closed).toBeTypeOf('function')
      closed()
      harness.windows.splice(0)

      let vetoed = false
      harness.appListeners.get('will-quit')?.({
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true
          vetoed = true
        },
      })
      expect(vetoed).toBe(true)

      harness.initialize.mockImplementation(async () => {
        await new TokenStore().getSessionToken('initializer-aaaaaaaaaaaa')
      })
      harness.appListeners.get('activate')?.()
      await vi.waitFor(() => expect(harness.initialize).toHaveBeenCalled())
      await vi.waitFor(() =>
        expect(harness.nativeGet).toHaveBeenCalledWith(
          'Evenfire',
          'session-token::initializer-aaaaaaaaaaaa'
        )
      )
      expect(harness.windows).toHaveLength(0)

      firstNativeWrite.resolve()
      await first
      initializerRead.resolve('synthetic-initializer-token')
      await vi.waitFor(() => expect(harness.windows).toHaveLength(1))
      expect(harness.nativeSet).toHaveBeenCalledTimes(1)
      expect(vi.mocked(app.quit)).not.toHaveBeenCalled()
    } finally {
      firstNativeWrite.resolve()
      initializerRead.resolve('synthetic-initializer-token')
      const { openTokenStoreAdmission } = await import('../tokenStore.ts')
      openTokenStoreAdmission()
      await first
    }
  })

  it('cancels the pending drain when a secondary window is created directly', async () => {
    await startMain()
    const firstNativeWrite = deferred<void>()
    const secondNativeWrite = deferred<void>()
    harness.nativeSet
      .mockImplementationOnce(() => firstNativeWrite.promise)
      .mockImplementationOnce(() => secondNativeWrite.promise)
    const { TokenStore } = await import('../tokenStore.ts')
    const { BrowserWindow, app } = await import('electron')
    const first = new TokenStore().setSessionToken('synthetic-first', 'first-aaaaaaaaaaaa')
    let second: Promise<void> | undefined
    try {
      await vi.waitFor(() => expect(harness.nativeSet).toHaveBeenCalledTimes(1))
      const closed = harness.windows[0].on.mock.calls.find(
        (call: unknown[]) => call[0] === 'closed'
      )?.[1]
      expect(closed).toBeTypeOf('function')
      closed()
      harness.windows.splice(0)
      let vetoed = false
      harness.appListeners.get('will-quit')?.({
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true
          vetoed = true
        },
      })
      expect(vetoed).toBe(true)

      second = new TokenStore().setSessionToken('synthetic-second', 'second-aaaaaaaaaaaa')
      new BrowserWindow({})
      expect(harness.windows).toHaveLength(1)
      await vi.waitFor(() => expect(harness.nativeSet).toHaveBeenCalledTimes(2))
      firstNativeWrite.resolve()
      secondNativeWrite.resolve()
      await Promise.all([first, second])
      await new Promise(resolve => setImmediate(resolve))
      expect(vi.mocked(app.quit)).not.toHaveBeenCalled()
      expect(harness.windows).toHaveLength(1)
    } finally {
      firstNativeWrite.resolve()
      secondNativeWrite.resolve()
      const { openTokenStoreAdmission } = await import('../tokenStore.ts')
      openTokenStoreAdmission()
      await first
      if (second) await second
    }
  })

  it('retries app.quit once after a normal drain and permits the final Quit', async () => {
    await startMain()
    const nativeWrite = deferred<void>()
    harness.nativeSet.mockImplementationOnce(() => nativeWrite.promise)
    const { TokenStore } = await import('../tokenStore.ts')
    const { app } = await import('electron')
    const quit = vi.mocked(app.quit)
    quit.mockClear()
    const write = new TokenStore().setSessionToken('synthetic-token', 'token-aaaaaaaaaaaa')
    try {
      await vi.waitFor(() => expect(harness.nativeSet).toHaveBeenCalledTimes(1))
      const closed = harness.windows[0].on.mock.calls.find(
        (call: unknown[]) => call[0] === 'closed'
      )?.[1]
      expect(closed).toBeTypeOf('function')
      closed()
      harness.windows.splice(0)
      let prevented = false
      harness.appListeners.get('will-quit')?.({
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true
          prevented = true
        },
      })
      expect(prevented).toBe(true)
      expect(quit).not.toHaveBeenCalled()

      nativeWrite.resolve()
      await write
      await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
      await new Promise(resolve => setImmediate(resolve))
      expect(quit).toHaveBeenCalledTimes(1)

      let finalQuitPrevented = false
      harness.appListeners.get('will-quit')?.({
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true
          finalQuitPrevented = true
        },
      })
      expect(finalQuitPrevented).toBe(false)
      expect(quit).toHaveBeenCalledTimes(1)
    } finally {
      nativeWrite.resolve()
      await write
    }
  })

  it('keeps native auth/environment admission after a canceled macOS Quit', async () => {
    await startMain()
    const { AppService } =
      await vi.importActual<typeof import('../appService.js')>('../appService.js')
    const service = new AppService() as unknown as {
      beginShutdown(): void
      withNativeAuthEnvironmentCommit<T>(operation: () => Promise<T>): Promise<T>
    }
    harness.beginShutdown.mockImplementation(() => service.beginShutdown())

    const { TokenStore } = await import('../tokenStore.ts')
    const firstNativeWrite = deferred<void>()
    harness.nativeSet.mockImplementationOnce(() => firstNativeWrite.promise)
    const first = new TokenStore().setSessionToken('synthetic-first', 'first-aaaaaaaaaaaa')
    let second: Promise<void> | undefined
    const scheduler = fc.scheduler()
    const generatedCommands = fc
      .sample(
        fc.commands([fc.constant(new CanceledQuitSequenceCommand())], {
          maxCommands: 1,
          size: '+1',
        }),
        { numRuns: 100, seed: 146360, size: '+1' }
      )
      .find(commands => commands.commands.length === 1)
    if (!generatedCommands) throw new Error('fast-check generated no lifecycle command run')
    const model: CanceledQuitModel = {
      quitStarted: false,
      queuedTokenWrite: false,
      windowAndAdmissionReopened: false,
      nativeOperationCompleted: false,
    }
    const real: CanceledQuitReal = {
      scheduler: fc.sample(fc.scheduler(), 1)[0]!,
      beginQuit: () => {
        const beforeQuit = harness.appListeners.get('before-quit')
        beforeQuit?.()
        let vetoed = false
        harness.appListeners.get('will-quit')?.({
          defaultPrevented: false,
          preventDefault() {
            this.defaultPrevented = true
            vetoed = true
          },
        })
        expect(vetoed).toBe(true)
      },
      queueTokenWrite: () => {
        second = new TokenStore().setSessionToken('synthetic-second', 'second-aaaaaaaaaaaa')
      },
      reopenWindow: async () => {
        harness.appListeners.get('activate')?.()
        await vi.waitFor(() => expect(harness.windows).toHaveLength(1))
        await vi.waitFor(() => expect(harness.nativeSet).toHaveBeenCalledTimes(2))
      },
      nativeOperation: () =>
        service.withNativeAuthEnvironmentCommit(async () => 'reopened-operation-completed'),
    }

    try {
      await vi.waitFor(() => expect(harness.nativeSet).toHaveBeenCalledTimes(1))
      const closed = harness.windows[0].on.mock.calls.find(
        (call: unknown[]) => call[0] === 'closed'
      )?.[1]
      expect(closed).toBeTypeOf('function')
      closed()
      harness.windows.splice(0)
      await fc.asyncModelRun(() => ({ model, real }), generatedCommands)
      expect(model).toEqual({
        quitStarted: true,
        queuedTokenWrite: true,
        windowAndAdmissionReopened: true,
        nativeOperationCompleted: true,
      })
    } finally {
      firstNativeWrite.resolve()
      await first
      if (second) await second
      const { openTokenStoreAdmission } = await import('../tokenStore.ts')
      openTokenStoreAdmission()
    }
  })

  it('keeps dev terminal Quit behavior for work queued behind the native owner', async () => {
    await startMain()
    const { AppService } =
      await vi.importActual<typeof import('../appService.js')>('../appService.js')
    const service = new AppService() as unknown as {
      beginShutdown(): void
      withNativeAuthEnvironmentCommit<T>(operation: () => Promise<T>): Promise<T>
    }
    harness.beginShutdown.mockImplementation(() => service.beginShutdown())
    const { TokenStore } = await import('../tokenStore.ts')
    const activeStarted = deferred<void>()
    const releaseActive = deferred<void>()
    const active = service.withNativeAuthEnvironmentCommit(async () => {
      activeStarted.resolve()
      await releaseActive.promise
      return 'active-owner-finished'
    })
    await activeStarted.promise
    const queued = service.withNativeAuthEnvironmentCommit(async () => {
      await new TokenStore().setSessionToken('synthetic-terminal-quit', 'terminal-aaaaaaaaaaaa')
    })
    let queuedSettled = false
    void queued.then(
      () => {
        queuedSettled = true
      },
      () => {
        queuedSettled = true
      }
    )
    const scheduler = fc.sample(fc.scheduler(), 1)[0]!
    const generatedCommands = fc
      .sample(
        fc.commands([fc.constant(new TerminalQuitSequenceCommand())], {
          maxCommands: 1,
          size: '+1',
        }),
        { numRuns: 100, seed: 146361, size: '+1' }
      )
      .find(commands => commands.commands.length === 1)
    if (!generatedCommands) throw new Error('fast-check generated no terminal lifecycle command')
    const model: TerminalQuitModel = {
      terminalQuitReached: false,
      ownerQueueReleased: false,
      postCloseTokenWritePending: false,
    }
    const real: TerminalQuitReal = {
      scheduler,
      terminalQuit: () => {
        const beforeQuit = harness.appListeners.get('before-quit')
        beforeQuit?.()
        const event = {
          defaultPrevented: false,
          preventDefault() {
            this.defaultPrevented = true
          },
        }
        harness.appListeners.get('will-quit')?.(event)
        return event.defaultPrevented
      },
      releaseOwner: () => releaseActive.resolve(),
      ownerOperation: active,
      queuedTokenOperation: queued,
      tokenWriteStarted: () => harness.nativeSet.mock.calls.length > 0,
    }
    try {
      await fc.asyncModelRun(() => ({ model, real }), generatedCommands)
      expect(model).toEqual({
        terminalQuitReached: true,
        ownerQueueReleased: true,
        postCloseTokenWritePending: true,
      })
      expect(queuedSettled).toBe(false)
    } finally {
      releaseActive.resolve()
      const { openTokenStoreAdmission } = await import('../tokenStore.ts')
      openTokenStoreAdmission()
      await Promise.allSettled([active, queued])
    }
  })

  it('preserves dev-isolated TokenStore operations after shared admission closes', async () => {
    await startMain()
    const isolatedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-profile-origin-isolated-'))
    const previousUserData = process.env.TOKEN_STORE_TEST_USER_DATA
    process.env.TOKEN_STORE_TEST_USER_DATA = isolatedDir
    const { TokenStore, closeTokenStoreAdmission, openTokenStoreAdmission } =
      await import('../tokenStore.ts')
    const isolatedStore = new TokenStore({ isolatedUserDataPath: isolatedDir })
    const { AppService } =
      await vi.importActual<typeof import('../appService.js')>('../appService.js')
    const service = new AppService({ tokenStore: isolatedStore }) as unknown as {
      beginShutdown(): void
      withNativeAuthEnvironmentCommit<T>(operation: () => Promise<T>): Promise<T>
    }
    harness.beginShutdown.mockImplementation(() => service.beginShutdown())
    const recordKey = 'isolated-aaaaaaaaaaaa'
    try {
      const beforeQuit = harness.appListeners.get('before-quit')
      beforeQuit?.()
      let prevented = false
      harness.appListeners.get('will-quit')?.({
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true
          prevented = true
        },
      })
      expect(prevented).toBe(false)
      expect(closeTokenStoreAdmission()).toBe(false)

      const result = await service.withNativeAuthEnvironmentCommit(async () => {
        await isolatedStore.setSessionToken('synthetic-isolated-session', recordKey)
        return 'isolated-write-completed'
      })
      expect(result).toBe('isolated-write-completed')
      await expect(isolatedStore.getSessionToken(recordKey)).resolves.toBe(
        'synthetic-isolated-session'
      )
    } finally {
      openTokenStoreAdmission()
      if (previousUserData === undefined) delete process.env.TOKEN_STORE_TEST_USER_DATA
      else process.env.TOKEN_STORE_TEST_USER_DATA = previousUserData
      await fs.rm(isolatedDir, { recursive: true, force: true })
    }
  })
})
