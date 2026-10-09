import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app, shell } from 'electron'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AppService } from '../appService.js'
import { __setChatStoreBaseDirForTests, unbindChatStore } from '../chatStoreBinding.js'
import { wireMainWindowRendererReadiness } from '../mainWindowReadiness.js'
import { _resetPluginSdkRuntimeForTests, initPluginSdkRuntime } from '../pluginSdkRuntime.js'
import { _resetPluginSurfacesForTests, resolvePluginSurface } from '../pluginSurfaceRegistry.js'
import { SANDBOX_UI_MINT_TIMEOUT_MS } from '../rpcProxyClient.js'
import { getActiveSandboxUi, unmountSandboxUiView } from '../sandboxUiDriver.js'
import {
  SANDBOX_UI_REFRESH_INTERVAL_MS,
  _resetSandboxUiRefreshForTests,
} from '../sandboxUiSessionRefresh.js'

// The open/close lifecycle is exercised end to end through the REAL AppService,
// the REAL sandbox-ui driver, the REAL session-refresh loop, the REAL plugin
// surface pin registry and the REAL RpcProxyClient. Only the Electron runtime
// (views, sessions, windows) and the RPC-token issuer are faked; mint outcomes
// come from rpc-proxy HTTP responses fed to the real client through `fetch`.

const electronMocks = vi.hoisted(() => {
  let nextWebContentsId = 1
  const views: FakeWebContentsView[] = []

  class FakeWebContents {
    id = nextWebContentsId++
    currentUrl = ''
    destroyed = false
    private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()
    executeJavaScript = vi.fn()
    loadURL = vi.fn(async (url: string) => {
      this.currentUrl = url
    })
    setWindowOpenHandler = vi.fn()
    stopFindInPage = vi.fn()
    findInPage = vi.fn(() => 41)
    focus = vi.fn()
    send = vi.fn()

    on(event: string, handler: (...args: unknown[]) => void): this {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set())
      this.listeners.get(event)!.add(handler)
      return this
    }

    removeListener(event: string, handler: (...args: unknown[]) => void): this {
      this.listeners.get(event)?.delete(handler)
      return this
    }

    emit(event: string, ...args: unknown[]): void {
      this.listeners.get(event)?.forEach(handler => handler(...args))
    }

    getURL(): string {
      return this.currentUrl
    }

    isDestroyed(): boolean {
      return this.destroyed
    }

    close(): void {
      this.destroyed = true
    }
  }

  class FakeWebContentsView {
    webContents = new FakeWebContents()
    setBounds = vi.fn()
    setVisible = vi.fn()

    constructor() {
      views.push(this)
    }
  }

  const sessionObject = {
    cookies: {
      set: vi.fn(async (_details?: { value: string }): Promise<void> => undefined),
    },
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    removeAllListeners: vi.fn(),
    on: vi.fn(),
    clearCache: vi.fn(async () => undefined),
  }

  return {
    FakeWebContentsView,
    fromPartition: vi.fn(() => sessionObject),
    getDisplayMatching: vi.fn(() => ({ scaleFactor: 1 })),
    touchSandboxUiPartition: vi.fn(async () => undefined),
    sessionObject,
    views,
  }
})

vi.mock('electron', () => ({
  WebContentsView: electronMocks.FakeWebContentsView,
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {
    static isSupported(): boolean {
      return false
    }
  },
  app: { getPath: vi.fn(() => tmpdir()) },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  screen: { getDisplayMatching: electronMocks.getDisplayMatching },
  session: { fromPartition: electronMocks.fromPartition },
  shell: { openExternal: vi.fn() },
}))

vi.mock('../config.js', () => ({
  getActiveEnvKey: () => 'test_env-000000000000',
  getActiveLegacyEnvKeys: () => [],
  config: {
    rpcProxyBaseUrl: 'https://rpc.example',
    externalRestApiBaseUrl: 'http://rest',
    desktopProfileUiBaseUrl: 'https://profile.example.com',
    desktopProfileUiBaseUrlExplicit: false,
    enableDevLoginUi: false,
    requestTimeoutMs: 60000,
    appName: 'test',
  },
}))

vi.mock('../sandboxUiPartitionGc.js', () => ({
  touchSandboxUiPartition: electronMocks.touchSandboxUiPartition,
}))

// The RPC token is issued by control-api through external-rest-api — a layer
// this suite does not stand up. The mint itself (rpc-proxy) runs through the
// real RpcProxyClient below.
vi.mock('../rpcTokenManager.js', () => ({
  RpcTokenManager: class {
    getOrIssue = vi.fn(async () => ({ token: 'fake-rpc-token' }))
    clear = vi.fn()
    getMetadata = vi.fn(() => ({ expiresAtMs: null, scopes: [], hostRefs: [] }))
  },
}))

vi.mock('../authClient.js', () => ({
  AuthClient: class {
    health = vi.fn().mockResolvedValue({ status: 'ok' })
    getMe = vi.fn()
  },
}))

vi.mock('../tokenStore.js', () => ({
  SessionTokenStorageClearError: class extends Error {
    canBeReplacedByFreshLoginCredential(): boolean {
      return false
    }
  },
  TokenStore: class {
    private safeStorageToken: string | null = null

    getSessionToken = vi.fn().mockResolvedValue(null)
    setSessionToken = vi.fn()
    setSafeStorageSessionToken = vi.fn(async (token: string) => {
      this.safeStorageToken = token
    })
    getSafeStorageSessionToken = vi.fn(async () => this.safeStorageToken)
    clearSessionToken = vi.fn()
    clearSessionTokenStrictly = vi.fn().mockResolvedValue({
      keytarAvailable: false,
      keytarDisabled: false,
    })
  },
}))

type Listener = (...args: unknown[]) => void

class FakeParentWindow {
  destroyed = false
  contentView = {
    addChildView: vi.fn(),
    removeChildView: vi.fn(),
  }
  private readonly listeners = new Map<string, Set<Listener>>()

  isDestroyed(): boolean {
    return this.destroyed
  }

  isVisible(): boolean {
    return true
  }

  isMinimized(): boolean {
    return false
  }

  getBounds(): { x: number; y: number; width: number; height: number } {
    return { x: 0, y: 0, width: 800, height: 600 }
  }

  on(event: string, handler: Listener): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(handler)
    return this
  }

  once(event: string, handler: Listener): this {
    return this.on(event, handler)
  }

  removeListener(event: string, handler: Listener): this {
    this.listeners.get(event)?.delete(handler)
    return this
  }
}

// rpc-proxy's mint contract: 204 + a Path-scoped Set-Cookie on success, any
// other status with a text body on failure.
function mintOk(recipeName: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'set-cookie':
        `clerum_sandbox_ui_session=tok-${recipeName}; ` +
        `Path=/api/v1/sandbox-ui/sandbox-recipes/${recipeName}/; HttpOnly`,
    },
  })
}

function mintFails(status: number, body: string): Response {
  return new Response(body, { status })
}

// rpc-proxy accepted the mint and never answers: it settles only if the client
// aborts it.
function mintHangs(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

// `AbortSignal.timeout` runs on the runtime's own timers, which fake timers do
// not drive. The mint bound is shrunk to a few ms instead, keyed on its exact
// value so the app-wide 60 s default is left untouched.
function shrinkMintBound(toMs = 25) {
  const realTimeout = AbortSignal.timeout.bind(AbortSignal)
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms =>
    realTimeout(ms === SANDBOX_UI_MINT_TIMEOUT_MS ? toMs : ms)
  )
}

const mintResponders = new Map<string, (init?: RequestInit) => Response | Promise<Response>>()
const authorizeUrlResponders = new Map<string, () => Response | Promise<Response>>()
const fetchMock = vi.fn(
  async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input)
    const authorize = /\/api\/v1\/sandbox-ui\/sandbox-recipes\/([^/]+)\/oauth\/authorize-url$/.exec(
      url
    )
    if (authorize) {
      const respond = authorizeUrlResponders.get(decodeURIComponent(authorize[1]!))
      if (!respond) throw new Error(`unexpected authorize-url fetch ${url}`)
      return respond()
    }
    const match = /\/api\/v1\/sandbox-ui\/sandbox-recipes\/([^/]+)\/session$/.exec(url)
    if (!match) throw new Error(`unexpected fetch ${url}`)
    const recipeName = decodeURIComponent(match[1]!)
    const respond = mintResponders.get(recipeName)
    return respond ? respond(init) : mintOk(recipeName)
  }
)

function mintCallsFor(recipeName: string): number {
  return fetchMock.mock.calls.filter(([input]) =>
    String(input).includes(`/sandbox-recipes/${recipeName}/session`)
  ).length
}

function makeService(): AppService {
  const svc = new AppService()
  ;(svc as unknown as { sessionToken: string }).sessionToken = 'fake-session-token'
  return svc
}

function openArgs(
  recipeName: string,
  parentWindow: FakeParentWindow,
  onClosed: () => void = vi.fn()
): Parameters<AppService['openSandboxUi']>[0] {
  return {
    recipeNs: 'sandbox-recipes',
    recipeName,
    title: recipeName,
    defaultPath: '/',
    bounds: { x: 0, y: 0, width: 400, height: 300 },
    parentWindow: parentWindow as unknown as Parameters<
      AppService['openSandboxUi']
    >[0]['parentWindow'],
    onClosed,
  }
}

let userDataDir = ''

beforeEach(async () => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  electronMocks.views.length = 0
  electronMocks.sessionObject.cookies.set.mockResolvedValue(undefined)
  mintResponders.clear()
  authorizeUrlResponders.clear()
  vi.stubGlobal('fetch', fetchMock)
  userDataDir = await mkdtemp(path.join(tmpdir(), 'clerum-sandbox-lifecycle-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  unbindChatStore()
  __setChatStoreBaseDirForTests(null)
  await unmountSandboxUiView()
  _resetSandboxUiRefreshForTests()
  _resetPluginSurfacesForTests()
  _resetPluginSdkRuntimeForTests()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  await rm(userDataDir, { recursive: true, force: true })
})

async function setupWithLiveFirstApp(onClosed: () => void = vi.fn()) {
  const service = makeService()
  initPluginSdkRuntime({ service, getMainWindow: () => null, userDataDir })
  const parentWindow = new FakeParentWindow()
  await service.openSandboxUi(openArgs('first-app', parentWindow, onClosed))
  const first = getActiveSandboxUi()
  expect(first?.appRef).toBe('sandbox-recipes/first-app')
  expect(resolvePluginSurface(first!.webContentsId)?.pluginId).toBe('sandbox-recipes/first-app')
  const firstView = electronMocks.views[0]
  return { service, parentWindow, firstWebContentsId: first!.webContentsId, firstView }
}

describe('AppService sandbox-ui open replaces the live view whatever its outcome', () => {
  it('a reopen whose mint rejects leaves no view, no refresh loop and no pin behind', async () => {
    const { service, parentWindow, firstWebContentsId, firstView } = await setupWithLiveFirstApp()
    mintResponders.set('second-app', () => mintFails(409, 'app is starting'))

    await expect(service.openSandboxUi(openArgs('second-app', parentWindow))).rejects.toThrow(
      /\(409\)/
    )

    expect(getActiveSandboxUi()).toBeNull()
    expect(parentWindow.contentView.removeChildView).toHaveBeenCalledTimes(1)
    expect(parentWindow.contentView.removeChildView).toHaveBeenCalledWith(firstView)
    expect(firstView?.webContents.isDestroyed()).toBe(true)
    expect(resolvePluginSurface(firstWebContentsId)).toBeNull()
    // The old view's refresh loop is gone: a full refresh interval mints nothing.
    const mintsBefore = mintCallsFor('first-app')
    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS + 1_000)
    expect(mintCallsFor('first-app')).toBe(mintsBefore)
  })

  it('a reopen whose mount fails after the teardown leaves no view and no refresh loop', async () => {
    const { service, parentWindow, firstWebContentsId } = await setupWithLiveFirstApp()
    electronMocks.sessionObject.cookies.set.mockRejectedValueOnce(new Error('cookie store down'))

    await expect(service.openSandboxUi(openArgs('second-app', parentWindow))).rejects.toThrow(
      'cookie store down'
    )

    expect(getActiveSandboxUi()).toBeNull()
    expect(resolvePluginSurface(firstWebContentsId)).toBeNull()
    const mintsBefore = mintCallsFor('first-app') + mintCallsFor('second-app')
    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS + 1_000)
    expect(mintCallsFor('first-app') + mintCallsFor('second-app')).toBe(mintsBefore)
  })

  it('a reopen that fails once the new view is already active tears that new view down', async () => {
    const { service, parentWindow } = await setupWithLiveFirstApp()
    // The driver registers the new view as active before attaching it, so an
    // attach failure leaves B active unless the open cleans up after itself.
    parentWindow.contentView.addChildView.mockImplementationOnce(() => {
      throw new Error('attach failed')
    })

    await expect(service.openSandboxUi(openArgs('second-app', parentWindow))).rejects.toThrow(
      'attach failed'
    )

    const secondView = electronMocks.views[1]
    expect(secondView).toBeDefined()
    expect(getActiveSandboxUi()).toBeNull()
    expect(parentWindow.contentView.removeChildView).toHaveBeenCalledWith(secondView)
    expect(secondView?.webContents.isDestroyed()).toBe(true)
    const mintsBefore = mintCallsFor('first-app') + mintCallsFor('second-app')
    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS + 1_000)
    expect(mintCallsFor('first-app') + mintCallsFor('second-app')).toBe(mintsBefore)
  })

  it('a successful reopen swaps to the new view with only its own refresh loop', async () => {
    const { service, parentWindow, firstWebContentsId } = await setupWithLiveFirstApp()

    await service.openSandboxUi(openArgs('second-app', parentWindow))

    const second = getActiveSandboxUi()
    expect(second?.appRef).toBe('sandbox-recipes/second-app')
    expect(resolvePluginSurface(firstWebContentsId)).toBeNull()
    expect(resolvePluginSurface(second!.webContentsId)?.pluginId).toBe('sandbox-recipes/second-app')
    fetchMock.mockClear()
    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS + 1_000)
    expect(mintCallsFor('first-app')).toBe(0)
    expect(mintCallsFor('second-app')).toBe(1)
  })

  // The renderer's `sandboxUi:closed` listener drops ownership of the live
  // embed. If the solicited teardown inside an open signalled it, the renderer
  // would lose the owner of the view main is about to mount — the very orphan
  // this teardown prevents. An open reports failure only through its rejection.
  it('never signals onClosed from a reopen, whether it succeeds or fails', async () => {
    const onClosed = vi.fn()
    const { service, parentWindow } = await setupWithLiveFirstApp(onClosed)

    await service.openSandboxUi(openArgs('first-app', parentWindow, onClosed))
    expect(getActiveSandboxUi()?.appRef).toBe('sandbox-recipes/first-app')

    mintResponders.set('first-app', () => mintFails(409, 'app is starting'))
    await expect(
      service.openSandboxUi(openArgs('first-app', parentWindow, onClosed))
    ).rejects.toThrow(/\(409\)/)
    expect(getActiveSandboxUi()).toBeNull()

    expect(onClosed).not.toHaveBeenCalled()
  })

  // On an app→app switch the renderer reads the outgoing view's route and then
  // asks main to open the incoming app, in that order and in the same tick. The
  // open's teardown must not overtake that read, or the outgoing tab's route is
  // read from nothing.
  it('a location read issued before an open in the same tick still sees the outgoing view', async () => {
    const { service, parentWindow } = await setupWithLiveFirstApp()

    const location = service.getSandboxUiLocation()
    const reopen = service.openSandboxUi(openArgs('second-app', parentWindow))

    await expect(location).resolves.toMatchObject({ appRef: 'sandbox-recipes/first-app' })
    await reopen
    expect(getActiveSandboxUi()?.appRef).toBe('sandbox-recipes/second-app')
  })
})

describe('AppService sandbox-ui embed whose renderer dies', () => {
  it('leaves no view, no refresh loop and no pin, and reports the close once', async () => {
    const onClosed = vi.fn()
    const { parentWindow, firstWebContentsId, firstView } = await setupWithLiveFirstApp(onClosed)

    firstView!.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 139 })

    expect(getActiveSandboxUi()).toBeNull()
    expect(parentWindow.contentView.removeChildView).toHaveBeenCalledWith(firstView)
    expect(resolvePluginSurface(firstWebContentsId)).toBeNull()
    expect(onClosed).toHaveBeenCalledOnce()
    const mintsBefore = mintCallsFor('first-app')
    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS + 1_000)
    expect(mintCallsFor('first-app')).toBe(mintsBefore)
  })
})

describe('AppService sandbox-ui mint against a hung rpc-proxy', () => {
  it('a close queued behind an open whose mint hangs still runs', async () => {
    const { service, parentWindow } = await setupWithLiveFirstApp()
    shrinkMintBound()
    mintResponders.set('second-app', mintHangs)

    const open = service.openSandboxUi(openArgs('second-app', parentWindow))
    const openOutcome = open.then(
      () => 'opened',
      (error: unknown) => error
    )
    let closed = false
    void service.closeSandboxUi().then(() => {
      closed = true
    })

    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1_000 })
    await expect(openOutcome).resolves.toMatchObject({ name: 'TimeoutError' })
    expect(getActiveSandboxUi()).toBeNull()
  })

  it('a refresh whose mint hangs stops and reports the error', async () => {
    const onRefreshError = vi.fn()
    const service = makeService()
    initPluginSdkRuntime({ service, getMainWindow: () => null, userDataDir })
    const parentWindow = new FakeParentWindow()
    await service.openSandboxUi({ ...openArgs('first-app', parentWindow), onRefreshError })
    shrinkMintBound()
    mintResponders.set('first-app', mintHangs)

    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS + 1_000)

    await vi.waitFor(() => expect(onRefreshError).toHaveBeenCalledOnce(), { timeout: 1_000 })
    // Stopped: a further interval issues no mint.
    const mintsBefore = mintCallsFor('first-app')
    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS + 1_000)
    expect(mintCallsFor('first-app')).toBe(mintsBefore)
  })
})

// The trusted renderer's webContents, wired exactly as main.ts wires the main
// window: through the real readiness wiring into the real AppService close.
class FakeMainWebContents {
  private readonly listeners = new Map<string, Set<Listener>>()
  reload = vi.fn()

  on(event: string, handler: Listener): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(handler)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    this.listeners.get(event)?.forEach(handler => handler(...args))
  }

  isDestroyed(): boolean {
    return false
  }
}

function wireMainWindow(service: AppService): FakeMainWebContents {
  const mainWebContents = new FakeMainWebContents()
  wireMainWindowRendererReadiness({
    webContents: mainWebContents as never,
    isCurrentWindow: () => true,
    markNotReady: vi.fn(),
    closeSandboxUi: () => service.closeSandboxUi(),
  })
  return mainWebContents
}

async function expectEmbedGoneWithoutRefresh(
  parentWindow: FakeParentWindow,
  firstView: InstanceType<typeof electronMocks.FakeWebContentsView> | undefined,
  firstWebContentsId: number
): Promise<void> {
  await vi.waitFor(() => expect(getActiveSandboxUi()).toBeNull(), { timeout: 1_000 })
  expect(parentWindow.contentView.removeChildView).toHaveBeenCalledWith(firstView)
  expect(firstView?.webContents.isDestroyed()).toBe(true)
  expect(resolvePluginSurface(firstWebContentsId)).toBeNull()
  const mintsBefore = mintCallsFor('first-app')
  await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS + 1_000)
  expect(mintCallsFor('first-app')).toBe(mintsBefore)
}

describe('AppService sandbox-ui embed whose trusted renderer is replaced', () => {
  it('a committed document navigation of the main window closes the embed', async () => {
    const onClosed = vi.fn()
    const { service, parentWindow, firstWebContentsId, firstView } =
      await setupWithLiveFirstApp(onClosed)
    const mainWebContents = wireMainWindow(service)

    // A reload (Cmd+R / View > Reload with the renderer focused) or a new
    // document committed in the main frame. A load that ends on an error page
    // emits no did-navigate and is not covered here.
    mainWebContents.emit('did-navigate', {}, 'file:///ui-dist/index.html', 200, 'OK')

    await expectEmbedGoneWithoutRefresh(parentWindow, firstView, firstWebContentsId)
    // The replacement renderer starts without state: nothing to notify.
    expect(onClosed).not.toHaveBeenCalled()
  })

  it('in-page, subframe and cancelled navigations of the main window leave the embed', async () => {
    const { service, firstWebContentsId } = await setupWithLiveFirstApp()
    const mainWebContents = wireMainWindow(service)

    // An external link is started and then cancelled by will-navigate: the
    // renderer that owns the embed stays.
    mainWebContents.emit('did-start-navigation', {
      url: 'https://example.com/',
      isMainFrame: true,
      isSameDocument: false,
    })
    mainWebContents.emit('did-navigate-in-page', {}, 'file:///ui-dist/index.html#/apps', true)
    mainWebContents.emit('did-frame-navigate', {}, 'about:blank', 200, 'OK', false)
    // Drain the serial lifecycle queue: a close enqueued by any of those events
    // has run once this barrier settles.
    await (
      service as unknown as { enqueueSandboxUiLifecycle(op: () => Promise<void>): Promise<void> }
    ).enqueueSandboxUiLifecycle(async () => undefined)

    expect(getActiveSandboxUi()?.webContentsId).toBe(firstWebContentsId)
  })

  it('a crash of the main renderer closes the embed', async () => {
    const { service, parentWindow, firstWebContentsId, firstView } = await setupWithLiveFirstApp()
    const mainWebContents = wireMainWindow(service)

    mainWebContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 139 })

    expect(mainWebContents.reload).toHaveBeenCalledOnce()
    await expectEmbedGoneWithoutRefresh(parentWindow, firstView, firstWebContentsId)
  })
})

describe('AppService sandbox-ui embed across a session clear', () => {
  // rpc-proxy holds the mint until the test answers it.
  function holdMint(recipeName: string) {
    let answer: (response: Response) => void = () => undefined
    const held = new Promise<Response>(resolve => {
      answer = resolve
    })
    mintResponders.set(recipeName, () => held)
    return (response: Response) => answer(response)
  }

  // Effects observable outside main: a cookie written to a partition, a view
  // created, attached or navigated, a pinned SDK surface, a refresh mint.
  async function expectNothingMountedFor(
    parentWindow: FakeParentWindow,
    service: AppService
  ): Promise<void> {
    // Drain the serial queue so the close queued by the session clear has run.
    await (
      service as unknown as { enqueueSandboxUiLifecycle(op: () => Promise<void>): Promise<void> }
    ).enqueueSandboxUiLifecycle(async () => undefined)
    expect(electronMocks.sessionObject.cookies.set).not.toHaveBeenCalled()
    expect(electronMocks.views).toHaveLength(0)
    expect(parentWindow.contentView.addChildView).not.toHaveBeenCalled()
    expect(getActiveSandboxUi()).toBeNull()
    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS + 1_000)
    expect(mintCallsFor('first-app')).toBe(1)
  }

  it('an open whose mint lands after logout installs nothing and rejects', async () => {
    const onClosed = vi.fn()
    const service = makeService()
    initPluginSdkRuntime({ service, getMainWindow: () => null, userDataDir })
    const parentWindow = new FakeParentWindow()
    const answerMint = holdMint('first-app')

    const open = service.openSandboxUi(openArgs('first-app', parentWindow, onClosed))
    const outcome = open.then(
      () => 'opened',
      (error: unknown) => error
    )
    await vi.waitFor(() => expect(mintCallsFor('first-app')).toBe(1), { timeout: 1_000 })
    await service.logout()
    answerMint(mintOk('first-app'))

    const settled = await outcome
    await expectNothingMountedFor(parentWindow, service)
    expect(settled).toMatchObject({ message: expect.stringMatching(/session changed/) })
    expect(onClosed).not.toHaveBeenCalled()
  })

  it('an open whose mint lands after another user logged in installs nothing and rejects', async () => {
    const service = makeService()
    initPluginSdkRuntime({ service, getMainWindow: () => null, userDataDir })
    const parentWindow = new FakeParentWindow()
    const answerMint = holdMint('first-app')

    const open = service.openSandboxUi(openArgs('first-app', parentWindow))
    const outcome = open.then(
      () => 'opened',
      (error: unknown) => error
    )
    await vi.waitFor(() => expect(mintCallsFor('first-app')).toBe(1), { timeout: 1_000 })
    await service.logout()
    __setChatStoreBaseDirForTests(userDataDir)
    const authClient = (service as unknown as { authClient: Record<string, unknown> }).authClient
    authClient.googleLogin = vi.fn().mockResolvedValue({
      token: 'fake-session-token-b',
      me: { id: 'user-b', teamId: 'team-b' },
    })
    await service.googleLogin('id-token-b')
    answerMint(mintOk('first-app'))

    const settled = await outcome
    await expectNothingMountedFor(parentWindow, service)
    expect(settled).toMatchObject({ message: expect.stringMatching(/session changed/) })
  })

  it('an open whose cookie write is in flight at logout creates no view and rejects', async () => {
    const service = makeService()
    initPluginSdkRuntime({ service, getMainWindow: () => null, userDataDir })
    const parentWindow = new FakeParentWindow()
    let finishCookieWrite: () => void = () => undefined
    electronMocks.sessionObject.cookies.set.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishCookieWrite = resolve
        })
    )

    const outcome = service.openSandboxUi(openArgs('first-app', parentWindow)).then(
      () => 'opened',
      (error: unknown) => error
    )
    await vi.waitFor(() => expect(electronMocks.sessionObject.cookies.set).toHaveBeenCalledOnce(), {
      timeout: 1_000,
    })
    await service.logout()
    finishCookieWrite()

    const settled = await outcome
    expect(electronMocks.views).toHaveLength(0)
    expect(parentWindow.contentView.addChildView).not.toHaveBeenCalled()
    expect(getActiveSandboxUi()).toBeNull()
    expect(settled).toMatchObject({ message: expect.stringMatching(/session changed/) })
    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS + 1_000)
    expect(mintCallsFor('first-app')).toBe(1)
  })

  it('a refresh whose mint lands after logout writes no cookie and reports nothing', async () => {
    const onRefreshError = vi.fn()
    const service = makeService()
    initPluginSdkRuntime({ service, getMainWindow: () => null, userDataDir })
    const parentWindow = new FakeParentWindow()
    await service.openSandboxUi({ ...openArgs('first-app', parentWindow), onRefreshError })
    const answerMint = holdMint('first-app')
    electronMocks.sessionObject.cookies.set.mockClear()

    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
    await vi.waitFor(() => expect(mintCallsFor('first-app')).toBe(2), { timeout: 1_000 })
    await service.logout()
    answerMint(mintOk('first-app'))
    await vi.waitFor(() => expect(getActiveSandboxUi()).toBeNull(), { timeout: 1_000 })
    await (
      service as unknown as { enqueueSandboxUiLifecycle(op: () => Promise<void>): Promise<void> }
    ).enqueueSandboxUiLifecycle(async () => undefined)

    expect(electronMocks.sessionObject.cookies.set).not.toHaveBeenCalled()
    expect(onRefreshError).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS + 1_000)
    expect(mintCallsFor('first-app')).toBe(2)
  })

  it('an OAuth connect whose authorize URL lands after logout opens no browser', async () => {
    const service = makeService()
    let answer: (response: Response) => void = () => undefined
    authorizeUrlResponders.set(
      'first-app',
      () =>
        new Promise<Response>(resolve => {
          answer = resolve
        })
    )

    const connect = service
      .requestSandboxUiOauthAuthorize('sandbox-recipes', 'first-app', 'client-1')
      .then(
        () => 'opened',
        (error: unknown) => error
      )
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce(), { timeout: 1_000 })
    await service.logout()
    answer(Response.json({ authorizeUrl: 'https://provider.example/authorize?state=a' }))

    const settled = await connect
    expect(shell.openExternal).not.toHaveBeenCalled()
    expect(settled).toMatchObject({ message: expect.stringMatching(/session changed/) })
  })

  it('an open whose mint fails after logout leaves nothing behind and rejects once', async () => {
    const onClosed = vi.fn()
    const service = makeService()
    initPluginSdkRuntime({ service, getMainWindow: () => null, userDataDir })
    const parentWindow = new FakeParentWindow()
    const answerMint = holdMint('first-app')

    const open = service.openSandboxUi(openArgs('first-app', parentWindow, onClosed))
    const outcome = open.then(
      () => 'opened',
      (error: unknown) => error
    )
    await vi.waitFor(() => expect(mintCallsFor('first-app')).toBe(1), { timeout: 1_000 })
    await service.logout()
    answerMint(mintFails(409, 'app is starting'))

    await expect(outcome).resolves.toMatchObject({ message: expect.stringMatching(/\(409\)/) })
    // Drain the serial queue so the close queued by logout has run too.
    await (
      service as unknown as { enqueueSandboxUiLifecycle(op: () => Promise<void>): Promise<void> }
    ).enqueueSandboxUiLifecycle(async () => undefined)
    expect(electronMocks.views).toHaveLength(0)
    expect(getActiveSandboxUi()).toBeNull()
    expect(parentWindow.contentView.addChildView).not.toHaveBeenCalled()
    expect(parentWindow.contentView.removeChildView).not.toHaveBeenCalled()
    expect(onClosed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS + 1_000)
    expect(mintCallsFor('first-app')).toBe(1)
  })

  it('logout closes the embed and stops its refresh loop', async () => {
    const { service, parentWindow, firstWebContentsId, firstView } = await setupWithLiveFirstApp()

    await service.logout()

    await expectEmbedGoneWithoutRefresh(parentWindow, firstView, firstWebContentsId)
  })
})

describe('AppService sandbox-ui embed across a login that replaces a live session', () => {
  // A is still logged in when B logs in: no logout runs in between, so only the
  // login itself can retire A's sandbox-ui work.
  beforeEach(() => {
    // The login replacement fences the outgoing user's GFS uploads on disk.
    vi.mocked(app.getPath).mockImplementation(() => userDataDir)
    __setChatStoreBaseDirForTests(userDataDir)
  })

  afterEach(() => {
    vi.mocked(app.getPath).mockImplementation(() => tmpdir())
  })

  async function loginAs(service: AppService, token: string, userId: string): Promise<void> {
    const authClient = (service as unknown as { authClient: Record<string, unknown> }).authClient
    authClient.googleLogin = vi.fn().mockResolvedValue({
      token,
      me: { id: userId, teamId: `team-${userId}` },
    })
    await service.googleLogin(`id-token-${userId}`)
  }

  async function drainSandboxUiQueue(service: AppService): Promise<void> {
    await (
      service as unknown as { enqueueSandboxUiLifecycle(op: () => Promise<void>): Promise<void> }
    ).enqueueSandboxUiLifecycle(async () => undefined)
  }

  function holdMint(recipeName: string) {
    let answer: (response: Response) => void = () => undefined
    const held = new Promise<Response>(resolve => {
      answer = resolve
    })
    mintResponders.set(recipeName, () => held)
    return (response: Response) => answer(response)
  }

  async function serviceLoggedInAsA(): Promise<AppService> {
    const service = new AppService()
    initPluginSdkRuntime({ service, getMainWindow: () => null, userDataDir })
    await loginAs(service, 'fake-session-token-a', 'user-a')
    return service
  }

  it('an open whose mint lands after B logged in over A installs nothing and rejects', async () => {
    const onClosed = vi.fn()
    const service = await serviceLoggedInAsA()
    const parentWindow = new FakeParentWindow()
    const answerMint = holdMint('first-app')

    const outcome = service.openSandboxUi(openArgs('first-app', parentWindow, onClosed)).then(
      () => 'opened',
      (error: unknown) => error
    )
    await vi.waitFor(() => expect(mintCallsFor('first-app')).toBe(1), { timeout: 1_000 })
    await loginAs(service, 'fake-session-token-b', 'user-b')
    answerMint(mintOk('first-app'))

    const settled = await outcome
    await drainSandboxUiQueue(service)
    expect(settled).toMatchObject({ message: expect.stringMatching(/session changed/) })
    expect(electronMocks.sessionObject.cookies.set).not.toHaveBeenCalled()
    expect(electronMocks.views).toHaveLength(0)
    expect(parentWindow.contentView.addChildView).not.toHaveBeenCalled()
    expect(getActiveSandboxUi()).toBeNull()
    expect(onClosed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS + 1_000)
    expect(mintCallsFor('first-app')).toBe(1)
  })

  it("B logging in over A closes A's embed and stops its refresh loop", async () => {
    const service = await serviceLoggedInAsA()
    const parentWindow = new FakeParentWindow()
    await service.openSandboxUi(openArgs('first-app', parentWindow))
    const first = getActiveSandboxUi()
    expect(first?.appRef).toBe('sandbox-recipes/first-app')
    const firstView = electronMocks.views[0]

    await loginAs(service, 'fake-session-token-b', 'user-b')

    await expectEmbedGoneWithoutRefresh(parentWindow, firstView, first!.webContentsId)
  })

  it("a refresh of A's embed whose mint lands after B logged in writes no cookie and reports nothing", async () => {
    const onRefreshError = vi.fn()
    const service = await serviceLoggedInAsA()
    const parentWindow = new FakeParentWindow()
    await service.openSandboxUi({ ...openArgs('first-app', parentWindow), onRefreshError })
    const answerMint = holdMint('first-app')
    electronMocks.sessionObject.cookies.set.mockClear()

    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
    await vi.waitFor(() => expect(mintCallsFor('first-app')).toBe(2), { timeout: 1_000 })
    await loginAs(service, 'fake-session-token-b', 'user-b')
    answerMint(mintOk('first-app'))
    await vi.waitFor(() => expect(getActiveSandboxUi()).toBeNull(), { timeout: 1_000 })
    await drainSandboxUiQueue(service)

    expect(electronMocks.sessionObject.cookies.set).not.toHaveBeenCalled()
    expect(onRefreshError).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS + 1_000)
    expect(mintCallsFor('first-app')).toBe(2)
  })

  it("an open B issues right after logging in over A mounts B's embed", async () => {
    const service = await serviceLoggedInAsA()
    const parentWindow = new FakeParentWindow()
    await service.openSandboxUi(openArgs('first-app', parentWindow))
    const firstView = electronMocks.views[0]

    await loginAs(service, 'fake-session-token-b', 'user-b')
    await service.openSandboxUi(openArgs('second-app', parentWindow))

    expect(getActiveSandboxUi()?.appRef).toBe('sandbox-recipes/second-app')
    expect(firstView?.webContents.isDestroyed()).toBe(true)
    expect(electronMocks.views).toHaveLength(2)
  })
})
