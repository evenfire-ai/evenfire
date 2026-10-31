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
import {
  getActiveSandboxUi,
  getActiveSandboxUiLocation,
  unmountSandboxUiView,
} from '../sandboxUiDriver.js'
import {
  SANDBOX_UI_REFRESH_INTERVAL_MS,
  _resetSandboxUiRefreshForTests,
} from '../sandboxUiSessionRefresh.js'
import { FakeParentWindow, electronMocks } from './__fixtures__/sandboxUiElectronFakes.js'

// The open/close lifecycle is exercised end to end through the REAL AppService,
// the REAL sandbox-ui driver, the REAL session-refresh loop, the REAL plugin
// surface pin registry and the REAL RpcProxyClient. Only the Electron runtime
// (views, sessions, windows) and the RPC-token issuer are faked; mint outcomes
// come from rpc-proxy HTTP responses fed to the real client through `fetch`.

vi.mock(
  'electron',
  async () => (await import('./__fixtures__/sandboxUiElectronFakes.js')).electronModule
)

const authMocks = vi.hoisted(() => ({
  getDesktopEnvironment: vi.fn(),
  getMe: vi.fn(),
  googleLogin: vi.fn(),
  health: vi.fn(),
}))

vi.mock('../config.js', async importOriginal => {
  const validatorDirectory = await mkdtemp(path.join(tmpdir(), 'sandbox-rpc-validator-'))
  const originalConfigPath = process.env.CLERUM_DESKTOP_CONFIG_PATH
  let validateRpcProxyBaseUrl: typeof import('../config.js').validateRpcProxyBaseUrl
  try {
    process.env.CLERUM_DESKTOP_CONFIG_PATH = path.join(validatorDirectory, 'runtime-config.json')
    ;({ validateRpcProxyBaseUrl } = await importOriginal<typeof import('../config.js')>())
  } finally {
    if (originalConfigPath === undefined) delete process.env.CLERUM_DESKTOP_CONFIG_PATH
    else process.env.CLERUM_DESKTOP_CONFIG_PATH = originalConfigPath
    await rm(validatorDirectory, { recursive: true, force: true })
  }
  return {
    validateRpcProxyBaseUrl,
    getActiveDeploymentProfileUiBaseUrl: () => 'https://profile.example.com',
    getActiveRuntimeConfigOptionId: () => null,
    getActiveEnvKey: () => 'test-env',
    getActiveLegacyEnvKeys: () => [],
    hydrateDesktopRuntimeConfig: () => undefined,
    isDesktopRuntimeConfigured: () => true,
    saveDesktopRuntimeConfig: vi.fn(),
    getDesktopRuntimeConfigState: () => ({
      configured: true,
      isLocalhost: false,
      selectorVisible: false,
      activeOptionId: null,
      currentConfig: {
        externalRestApiBaseUrl: 'http://rest',
        rpcProxyBaseUrl: 'https://rpc.example',
      },
      envKey: 'test-env',
      storagePath: '/tmp/runtime-config.json',
      options: [],
    }),
    config: {
      rpcProxyBaseUrl: 'https://rpc.example',
      externalRestApiBaseUrl: 'http://rest',
      desktopProfileUiBaseUrl: 'https://profile.example.com',
      desktopProfileUiBaseUrlExplicit: false,
      enableDevLoginUi: false,
      requestTimeoutMs: 60000,
      appName: 'test',
    },
  }
})

vi.mock('../sandboxUiPartitionGc.js', async () => ({
  touchSandboxUiPartition: (await import('./__fixtures__/sandboxUiElectronFakes.js')).electronMocks
    .touchSandboxUiPartition,
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
    health = authMocks.health
    getMe = authMocks.getMe
    googleLogin = authMocks.googleLogin
    getDesktopEnvironment = authMocks.getDesktopEnvironment
  },
}))

vi.mock('../tokenStore.js', () => ({
  TokenStore: class {
    getSessionToken = vi.fn().mockResolvedValue(null)
    setSessionToken = vi.fn()
    clearSessionToken = vi.fn()
  },
}))

type Listener = (...args: unknown[]) => void

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

type OpenArgs = Parameters<AppService['openSandboxUi']>[0]

function openArgs(
  recipeName: string,
  parentWindow: FakeParentWindow,
  onReleased: NonNullable<OpenArgs['onReleased']> = vi.fn(),
  overrides: Partial<Omit<OpenArgs, 'parentWindow'>> = {}
): OpenArgs {
  return {
    recipeNs: 'sandbox-recipes',
    recipeName,
    title: recipeName,
    defaultPath: '/',
    bounds: { x: 0, y: 0, width: 400, height: 300 },
    parentWindow: parentWindow as unknown as OpenArgs['parentWindow'],
    launchId: crypto.randomUUID(),
    onReleased,
    ...overrides,
  }
}

let userDataDir = ''

beforeEach(async () => {
  vi.clearAllMocks()
  const { config } = await import('../config.js')
  config.rpcProxyBaseUrl = 'https://rpc.example'
  authMocks.health.mockResolvedValue({ status: 'ok' })
  authMocks.getMe.mockResolvedValue(null)
  authMocks.googleLogin.mockReset()
  authMocks.getDesktopEnvironment.mockReset()
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

async function setupWithLiveFirstApp(onReleased: NonNullable<OpenArgs['onReleased']> = vi.fn()) {
  const service = makeService()
  initPluginSdkRuntime({ service, getMainWindow: () => null, userDataDir })
  const parentWindow = new FakeParentWindow()
  await service.openSandboxUi(openArgs('first-app', parentWindow, onReleased))
  const first = getActiveSandboxUi()
  expect(first?.appRef).toBe('sandbox-recipes/first-app')
  expect(resolvePluginSurface(first!.webContentsId)?.pluginId).toBe('sandbox-recipes/first-app')
  const firstView = electronMocks.views[0]
  return { service, parentWindow, firstWebContentsId: first!.webContentsId, firstView }
}

describe('AppService sandbox-ui effective RPC endpoint', () => {
  it('uses a late discovery from the active session for mint, cookie, and navigation', async () => {
    const { config } = await import('../config.js')
    const discoveredRpcUrl = 'https://late-rpc.example.test'
    config.rpcProxyBaseUrl = ''
    authMocks.getDesktopEnvironment
      .mockRejectedValueOnce(new Error('initial discovery unavailable'))
      .mockResolvedValueOnce({
        externalRestApiBaseUrl: 'http://rest',
        rpcProxyBaseUrl: discoveredRpcUrl,
        appName: 'Discovered environment',
      })
    authMocks.googleLogin.mockResolvedValue({
      token: 'fake-session-token',
      me: {
        id: 'user-a',
        email: 'user-a@example.test',
        name: 'User A',
        picture: null,
        teamId: 'team-a',
        teamName: 'Team A',
        role: 'member',
      },
    })
    const service = new AppService()
    await service.googleLogin('google-id-token')
    await service.getDependenciesHealth()
    expect(config.rpcProxyBaseUrl).toBe('')

    const parentWindow = new FakeParentWindow()

    await service.openSandboxUi(openArgs('effective-app', parentWindow))

    expect(fetchMock).toHaveBeenCalledWith(
      `${discoveredRpcUrl}/api/v1/sandbox-ui/sandbox-recipes/effective-app/session`,
      expect.objectContaining({ method: 'POST' })
    )
    expect(electronMocks.sessionObject.cookies.set).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `${discoveredRpcUrl}/api/v1/sandbox-ui/sandbox-recipes/effective-app/`,
      })
    )
    const { webContents } = electronMocks.views.at(-1)!
    webContents.commitLoad()
    expect(webContents.currentUrl).toBe(
      `${discoveredRpcUrl}/api/v1/sandbox-ui/sandbox-recipes/effective-app/view/`
    )
  })
})

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
})

describe('AppService sandbox-ui embed whose renderer dies', () => {
  it('leaves no view, no refresh loop and no pin, and reports the release once', async () => {
    const onReleased = vi.fn()
    const { parentWindow, firstWebContentsId, firstView } = await setupWithLiveFirstApp(onReleased)

    firstView!.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 139 })

    expect(getActiveSandboxUi()).toBeNull()
    expect(parentWindow.contentView.removeChildView).toHaveBeenCalledWith(firstView)
    expect(resolvePluginSurface(firstWebContentsId)).toBeNull()
    expect(onReleased).toHaveBeenCalledOnce()
    expect(onReleased).toHaveBeenCalledWith(expect.objectContaining({ reason: 'crashed' }))
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

  it('a refresh whose mint hangs is retried instead of abandoned', async () => {
    const onRefreshError = vi.fn()
    const service = makeService()
    initPluginSdkRuntime({ service, getMainWindow: () => null, userDataDir })
    const parentWindow = new FakeParentWindow()
    await service.openSandboxUi({ ...openArgs('first-app', parentWindow), onRefreshError })
    const embed = getActiveSandboxUi()!
    // The mint bound fires when the test says so, not on the runtime's real
    // clock, so the retry timing stays on the fake timers alone.
    const mintBounds: AbortController[] = []
    const realTimeout = AbortSignal.timeout.bind(AbortSignal)
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      if (ms !== SANDBOX_UI_MINT_TIMEOUT_MS) return realTimeout(ms)
      const bound = new AbortController()
      mintBounds.push(bound)
      return bound.signal
    })
    mintResponders.set('first-app', mintHangs)

    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS + 1_000)
    expect(mintCallsFor('first-app')).toBe(2)
    mintBounds.at(-1)!.abort(new DOMException('mint timed out', 'TimeoutError'))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mintCallsFor('first-app')).toBe(3)
    expect(onRefreshError).not.toHaveBeenCalled()
    expect(getActiveSandboxUi()?.webContentsId).toBe(embed.webContentsId)
    expect(resolvePluginSurface(embed.webContentsId)?.pluginId).toBe('sandbox-recipes/first-app')
  })
})

describe('AppService sandbox-ui session against a failing rpc-proxy', () => {
  it('retries, reports only once the cookie is past its grace period, and resumes on an embed request', async () => {
    // The retry deadline is wall-clock, so here the wall clock moves with the timers.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const onRefreshError = vi.fn()
    const onRefreshRecovered = vi.fn()
    const service = makeService()
    initPluginSdkRuntime({ service, getMainWindow: () => null, userDataDir })
    const parentWindow = new FakeParentWindow()
    await service.openSandboxUi({
      ...openArgs('first-app', parentWindow),
      onRefreshError,
      onRefreshRecovered,
    })
    const embed = getActiveSandboxUi()!
    mintResponders.set('first-app', () => mintFails(503, 'upstream unavailable'))

    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mintCallsFor('first-app')).toBe(3)
    expect(onRefreshError).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(120_000)
    expect(onRefreshError).toHaveBeenCalledOnce()
    expect(onRefreshError.mock.calls[0]![0]).toContain('503')
    expect(onRefreshRecovered).not.toHaveBeenCalled()
    const mintsWhenExhausted = mintCallsFor('first-app')
    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS)
    expect(mintCallsFor('first-app')).toBe(mintsWhenExhausted)
    // The view and its pins survive the error.
    expect(getActiveSandboxUi()?.webContentsId).toBe(embed.webContentsId)
    expect(resolvePluginSurface(embed.webContentsId)?.pluginId).toBe('sandbox-recipes/first-app')

    mintResponders.delete('first-app')
    electronMocks.sessionObject.cookies.set.mockClear()
    await service.requestSandboxUiRefresh(embed.webContentsId)
    expect(mintCallsFor('first-app')).toBe(mintsWhenExhausted + 1)
    expect(electronMocks.sessionObject.cookies.set).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'tok-first-app' })
    )
    expect(onRefreshRecovered).toHaveBeenCalledOnce()
  })

  it('a recovery whose cookie write lands after logout is not reported', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const onRefreshError = vi.fn()
    const onRefreshRecovered = vi.fn()
    const service = makeService()
    initPluginSdkRuntime({ service, getMainWindow: () => null, userDataDir })
    const parentWindow = new FakeParentWindow()
    await service.openSandboxUi({
      ...openArgs('first-app', parentWindow),
      onRefreshError,
      onRefreshRecovered,
    })
    const embed = getActiveSandboxUi()!
    mintResponders.set('first-app', () => mintFails(503, 'upstream unavailable'))
    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(onRefreshError).toHaveBeenCalledOnce()

    mintResponders.delete('first-app')
    let finishCookieWrite: () => void = () => undefined
    electronMocks.sessionObject.cookies.set.mockClear()
    electronMocks.sessionObject.cookies.set.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishCookieWrite = resolve
        })
    )
    const refresh = service.requestSandboxUiRefresh(embed.webContentsId)
    await vi.waitFor(() => expect(electronMocks.sessionObject.cookies.set).toHaveBeenCalledOnce(), {
      timeout: 1_000,
    })
    // Lifecycle work ahead of the session's close keeps the loop running while
    // the cookie write lands under the next session.
    let releaseQueue: () => void = () => undefined
    const queueBusy = (
      service as unknown as { enqueueSandboxUiLifecycle(op: () => Promise<void>): Promise<void> }
    ).enqueueSandboxUiLifecycle(
      () =>
        new Promise<void>(resolve => {
          releaseQueue = resolve
        })
    )
    await service.logout()
    finishCookieWrite()
    await refresh
    expect(getActiveSandboxUi()?.webContentsId).toBe(embed.webContentsId)

    releaseQueue()
    await queueBusy
    await vi.waitFor(() => expect(getActiveSandboxUi()).toBeNull(), { timeout: 1_000 })
    expect(onRefreshRecovered).not.toHaveBeenCalled()
    expect(onRefreshError).toHaveBeenCalledOnce()
  })
})

describe('AppService sandbox-ui embed whose document comes back 401', () => {
  it('re-mints through rpc-proxy and reloads the embed once per mint', async () => {
    const { firstView } = await setupWithLiveFirstApp()
    const webContents = firstView!.webContents
    const appUrl = 'https://rpc.example/api/v1/sandbox-ui/sandbox-recipes/first-app/view/'

    webContents.emit('did-navigate', {}, appUrl, 401, 'Unauthorized')
    await vi.waitFor(() => expect(webContents.reloadIgnoringCache).toHaveBeenCalledOnce(), {
      timeout: 1_000,
    })
    expect(mintCallsFor('first-app')).toBe(2)

    // The reload 401s again under the recovery cookie: no second round.
    webContents.emit('did-navigate', {}, appUrl, 401, 'Unauthorized')
    await vi.advanceTimersByTimeAsync(0)
    expect(mintCallsFor('first-app')).toBe(2)
    expect(webContents.reloadIgnoringCache).toHaveBeenCalledOnce()
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
    sandboxUi: service,
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
    const { service, parentWindow, firstWebContentsId, firstView } = await setupWithLiveFirstApp()
    const mainWebContents = wireMainWindow(service)

    // A reload (Cmd+R / View > Reload with the renderer focused) or a new
    // document committed in the main frame. A load that ends on an error page
    // emits no did-navigate and is not covered here.
    mainWebContents.emit('did-navigate', {}, 'file:///ui-dist/index.html', 200, 'OK')

    await expectEmbedGoneWithoutRefresh(parentWindow, firstView, firstWebContentsId)
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
    const onReleased = vi.fn()
    const service = makeService()
    initPluginSdkRuntime({ service, getMainWindow: () => null, userDataDir })
    const parentWindow = new FakeParentWindow()
    const answerMint = holdMint('first-app')

    const open = service.openSandboxUi(openArgs('first-app', parentWindow, onReleased))
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
    // No view was ever assigned to this launch, so it is never released.
    expect(onReleased).not.toHaveBeenCalled()
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
    const onReleased = vi.fn()
    const service = makeService()
    initPluginSdkRuntime({ service, getMainWindow: () => null, userDataDir })
    const parentWindow = new FakeParentWindow()
    const answerMint = holdMint('first-app')

    const open = service.openSandboxUi(openArgs('first-app', parentWindow, onReleased))
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
    // No view was ever assigned to this launch, so it is never released.
    expect(onReleased).not.toHaveBeenCalled()
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
    const onReleased = vi.fn()
    const service = await serviceLoggedInAsA()
    const parentWindow = new FakeParentWindow()
    const answerMint = holdMint('first-app')

    const outcome = service.openSandboxUi(openArgs('first-app', parentWindow, onReleased)).then(
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
    // No view was ever assigned to this launch, so it is never released.
    expect(onReleased).not.toHaveBeenCalled()
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

// ─── View release contract ───────────────────────────────────────────────
// Every view main assigns ends with exactly one `released` that names the open
// that mounted it, why it died and the route it was showing, and no view is
// left attached without an owner.

type ReleasedEvent = {
  launchId: string
  reason: string
  location: { routePath?: string } | null
}

const APP_VIEW_URL = 'https://rpc.example/api/v1/sandbox-ui/sandbox-recipes/first-app/view'

async function drainLifecycleQueue(service: AppService): Promise<void> {
  await (
    service as unknown as { enqueueSandboxUiLifecycle(op: () => Promise<void>): Promise<void> }
  ).enqueueSandboxUiLifecycle(async () => undefined)
}

// I-orphan: without an active view, the window holds no sandbox-ui view; with
// one, it holds exactly that one.
function expectNoOrphanView(parentWindow: FakeParentWindow): void {
  if (parentWindow.destroyed) return
  const active = getActiveSandboxUi()
  const attached = parentWindow.contentView.children
  if (!active) {
    expect(attached).toEqual([])
    return
  }
  expect(attached).toHaveLength(1)
  expect(
    (attached[0] as InstanceType<typeof electronMocks.FakeWebContentsView>).webContents.id
  ).toBe(active.webContentsId)
}

async function setupReleaseRecorder(routePath?: string) {
  const service = makeService()
  const runtime = initPluginSdkRuntime({ service, getMainWindow: () => null, userDataDir })
  const parentWindow = new FakeParentWindow()
  const released: ReleasedEvent[] = []
  const onReleased = (event: ReleasedEvent) => {
    released.push(event)
  }
  const launch = (
    recipeName: string,
    overrides: Partial<Omit<OpenArgs, 'parentWindow'>> = {}
  ): OpenArgs =>
    openArgs(recipeName, parentWindow, vi.fn(), {
      onReleased,
      ...(routePath ? { routePath } : {}),
      ...overrides,
    })
  return { service, runtime, parentWindow, released, launch }
}

describe('AppService sandbox-ui teardown whose cleanup throws', () => {
  it('still detaches the view, closes its webContents and releases it once', async () => {
    const { service, parentWindow, released, launch } = await setupReleaseRecorder()
    const args = launch('first-app')
    await service.openSandboxUi(args)
    const view = electronMocks.views[0]!
    // A native call made while tearing down fails (the renderer went away
    // between the liveness check and the call).
    view.webContents.stopFindInPage.mockImplementationOnce(() => {
      throw new Error('Object has been destroyed')
    })

    await service.closeSandboxUi({ launchId: args.launchId })

    expect(parentWindow.contentView.children).toEqual([])
    expect(view.webContents.isDestroyed()).toBe(true)
    expect(getActiveSandboxUi()).toBeNull()
    expect(released).toEqual([{ launchId: args.launchId, reason: 'closed', location: {} }])
    expectNoOrphanView(parentWindow)
  })

  it('still releases the view when unhooking the session refresh from the parent throws', async () => {
    // Electron's removeListener does not throw; the failure is injected to
    // prove that nothing run ahead of the unmount (the refresh loop unhooks
    // its own parent listeners first) can keep the view attached.
    const { service, parentWindow, released, launch } = await setupReleaseRecorder()
    const args = launch('first-app')
    await service.openSandboxUi(args)
    const view = electronMocks.views[0]!
    vi.spyOn(parentWindow, 'removeListener').mockImplementation(() => {
      throw new Error('Object has been destroyed')
    })

    await service.closeSandboxUi({ launchId: args.launchId })

    expect(parentWindow.contentView.children).toEqual([])
    expect(view.webContents.isDestroyed()).toBe(true)
    expect(getActiveSandboxUi()).toBeNull()
    expect(released).toEqual([{ launchId: args.launchId, reason: 'closed', location: {} }])
    expect(resolvePluginSurface(view.webContents.id)).toBeNull()
  })
})

describe('AppService sandbox-ui view release', () => {
  it('releases each assigned view exactly once and never a launch that got no view', async () => {
    const { service, parentWindow, released, launch } = await setupReleaseRecorder()
    const first = launch('first-app')
    await service.openSandboxUi(first)
    expectNoOrphanView(parentWindow)

    mintResponders.set('second-app', () => mintFails(409, 'app is starting'))
    const failed = launch('second-app')
    await expect(service.openSandboxUi(failed)).rejects.toThrow(/\(409\)/)
    expectNoOrphanView(parentWindow)

    const third = launch('first-app')
    await service.openSandboxUi(third)
    await service.closeSandboxUi({ launchId: third.launchId })
    await service.logout()
    await drainLifecycleQueue(service)

    expect(released).toEqual([
      { launchId: first.launchId, reason: 'replaced', location: {} },
      { launchId: third.launchId, reason: 'closed', location: {} },
    ])
    expectNoOrphanView(parentWindow)
  })

  it('releases a view mounted under a session that ended before rejecting its open', async () => {
    const { service, parentWindow, launch } = await setupReleaseRecorder()
    const order: Array<[string, unknown]> = []
    const args = launch('first-app', {
      onReleased: event => {
        order.push(['released', event])
      },
    })
    // The session ends right as the view is attached: what logout does
    // synchronously once its upload fence settles.
    parentWindow.contentView.addChildView.mockImplementationOnce((view: unknown) => {
      parentWindow.children.push(view)
      ;(
        service as unknown as { clearAuthenticatedSessionState(): void }
      ).clearAuthenticatedSessionState()
    })

    await service.openSandboxUi(args).catch((error: Error) => {
      order.push(['rejected', error.message])
    })
    await drainLifecycleQueue(service)

    expect(order).toEqual([
      ['released', { launchId: args.launchId, reason: 'session', location: {} }],
      ['rejected', expect.stringMatching(/session changed/)],
    ])
    expect(getActiveSandboxUi()).toBeNull()
    expectNoOrphanView(parentWindow)
  })

  it('releases a view whose open failed after mounting it as open_failed, before rejecting', async () => {
    const { service, parentWindow, launch } = await setupReleaseRecorder('/r/asked')
    const order: Array<[string, unknown]> = []
    const args = launch('first-app', {
      onReleased: event => {
        order.push(['released', event])
      },
    })
    parentWindow.contentView.addChildView.mockImplementationOnce(() => {
      throw new Error('attach failed')
    })

    await service.openSandboxUi(args).catch((error: Error) => {
      order.push(['rejected', error.message])
    })

    expect(order).toEqual([
      [
        'released',
        { launchId: args.launchId, reason: 'open_failed', location: { routePath: '/r/asked' } },
      ],
      ['rejected', 'attach failed'],
    ])
    expect(getActiveSandboxUi()).toBeNull()
    expectNoOrphanView(parentWindow)
  })

  it('a close naming another launch leaves the live view alone', async () => {
    const { service, parentWindow, released, launch } = await setupReleaseRecorder()
    const args = launch('first-app')
    await service.openSandboxUi(args)
    const live = getActiveSandboxUi()

    await service.closeSandboxUi({ launchId: crypto.randomUUID() })

    expect(getActiveSandboxUi()?.webContentsId).toBe(live!.webContentsId)
    expect(released).toEqual([])
    expectNoOrphanView(parentWindow)

    // Main's own close names no launch and closes whatever is live.
    await service.closeSandboxUi()
    expect(getActiveSandboxUi()).toBeNull()
    expect(released).toEqual([{ launchId: args.launchId, reason: 'closed', location: {} }])
    expectNoOrphanView(parentWindow)
  })
})

describe('AppService sandbox-ui release reason per caller', () => {
  it('crashed during the open: the release comes first, then the open rejects', async () => {
    const { service, parentWindow, launch } = await setupReleaseRecorder()
    const order: Array<[string, unknown]> = []
    const args = launch('first-app', {
      onReleased: event => {
        order.push(['released', event])
      },
    })
    // The embed renderer dies as soon as the view is attached.
    parentWindow.contentView.addChildView.mockImplementationOnce((view: unknown) => {
      parentWindow.children.push(view)
      ;(view as InstanceType<typeof electronMocks.FakeWebContentsView>).webContents.emit(
        'render-process-gone',
        {},
        { reason: 'crashed' }
      )
    })

    await service.openSandboxUi(args).catch((error: Error) => {
      order.push(['rejected', error.message])
    })

    expect(order).toEqual([
      ['released', { launchId: args.launchId, reason: 'crashed', location: null }],
      ['rejected', expect.stringMatching(/closed before it finished opening/)],
    ])
    expect(getActiveSandboxUi()).toBeNull()
    expectNoOrphanView(parentWindow)
  })

  it('replaced: an open over a live view', async () => {
    const { service, released, launch } = await setupReleaseRecorder()
    const first = launch('first-app')
    await service.openSandboxUi(first)
    await service.openSandboxUi(launch('second-app'))
    expect(released).toEqual([{ launchId: first.launchId, reason: 'replaced', location: {} }])
  })

  it('crashed: the embed renderer dies, and the route is not reported', async () => {
    // The route the view was asked for would otherwise be reported: a crash
    // must not hand it back for a relaunch that would crash again.
    const { service, parentWindow, released, launch } = await setupReleaseRecorder('/r/crash')
    const args = launch('first-app')
    await service.openSandboxUi(args)

    electronMocks.views[0]!.webContents.emit('render-process-gone', {}, { reason: 'crashed' })

    expect(released).toEqual([{ launchId: args.launchId, reason: 'crashed', location: null }])
    expectNoOrphanView(parentWindow)
  })

  it('parent_closed: the window holding the view closes', async () => {
    const { service, parentWindow, released, launch } = await setupReleaseRecorder()
    const args = launch('first-app')
    await service.openSandboxUi(args)
    const view = electronMocks.views[0]!

    parentWindow.destroy()
    parentWindow.emit('closed')

    expect(view.webContents.isDestroyed()).toBe(true)
    expect(getActiveSandboxUi()).toBeNull()
    expect(released).toEqual([{ launchId: args.launchId, reason: 'parent_closed', location: {} }])
  })

  it('session: logout', async () => {
    const { service, parentWindow, released, launch } = await setupReleaseRecorder()
    const args = launch('first-app')
    await service.openSandboxUi(args)

    await service.logout()
    await drainLifecycleQueue(service)

    expect(released).toEqual([{ launchId: args.launchId, reason: 'session', location: {} }])
    expectNoOrphanView(parentWindow)
  })

  it('renderer_replaced: the trusted renderer commits a new document', async () => {
    const { service, parentWindow, released, launch } = await setupReleaseRecorder()
    const args = launch('first-app')
    await service.openSandboxUi(args)
    const mainWebContents = wireMainWindow(service)

    mainWebContents.emit('did-navigate', {}, 'file:///ui-dist/index.html', 200, 'OK')
    await drainLifecycleQueue(service)

    expect(released).toEqual([
      { launchId: args.launchId, reason: 'renderer_replaced', location: {} },
    ])
    expectNoOrphanView(parentWindow)
  })
})

describe('AppService sandbox-ui represented location', () => {
  it('is the requested route until the view applies it, then the live route', async () => {
    const { service, released, launch } = await setupReleaseRecorder('/r/first')
    const first = launch('first-app')
    await service.openSandboxUi(first)
    const webContents = electronMocks.views[0]!.webContents

    expect(getActiveSandboxUiLocation()).toEqual({
      recipeNs: 'sandbox-recipes',
      recipeName: 'first-app',
      path: '/r/first',
    })

    // The document commits and the driver hands the route to the app.
    webContents.commitLoad()
    await vi.waitFor(() => expect(webContents.getURL()).toBe(`${APP_VIEW_URL}/r/first`), {
      timeout: 1_000,
    })
    webContents.navigateInPage(`${APP_VIEW_URL}/inbox`)
    expect(getActiveSandboxUiLocation()).toEqual({
      recipeNs: 'sandbox-recipes',
      recipeName: 'first-app',
      path: '/inbox',
    })

    await service.closeSandboxUi({ launchId: first.launchId })
    expect(released).toEqual([
      { launchId: first.launchId, reason: 'closed', location: { routePath: '/inbox' } },
    ])
  })

  it('a view replaced while still loading reports the route it was asked for', async () => {
    const { service, released, launch } = await setupReleaseRecorder('/r/first')
    const first = launch('first-app')
    await service.openSandboxUi(first)

    await service.openSandboxUi(launch('second-app', { routePath: '/r/second' }))

    expect(released).toEqual([
      { launchId: first.launchId, reason: 'replaced', location: { routePath: '/r/first' } },
    ])
  })

  it('keeps the requested route while the app is not ready for it, until the user navigates', async () => {
    const { service, released, launch } = await setupReleaseRecorder('/r/first')
    const first = launch('first-app')
    await service.openSandboxUi(first)
    const webContents = electronMocks.views[0]!.webContents

    // rpc-proxy answers with a "starting" interstitial: the handoff waits.
    webContents.commitLoad(503)
    expect(getActiveSandboxUiLocation()).toEqual({
      recipeNs: 'sandbox-recipes',
      recipeName: 'first-app',
      path: '/r/first',
    })

    webContents.navigateInPage(`${APP_VIEW_URL}/elsewhere`)
    await service.closeSandboxUi({ launchId: first.launchId })
    expect(released).toEqual([
      { launchId: first.launchId, reason: 'closed', location: { routePath: '/elsewhere' } },
    ])
  })

  it('a view without a requested route reports the default route until it navigates', async () => {
    const { service, released, launch } = await setupReleaseRecorder()
    const first = launch('first-app')
    await service.openSandboxUi(first)
    const webContents = electronMocks.views[0]!.webContents

    expect(getActiveSandboxUiLocation()).toEqual({
      recipeNs: 'sandbox-recipes',
      recipeName: 'first-app',
    })
    webContents.commitLoad()
    webContents.navigateInPage(`${APP_VIEW_URL}/settings`)

    await service.closeSandboxUi({ launchId: first.launchId })
    expect(released).toEqual([
      { launchId: first.launchId, reason: 'closed', location: { routePath: '/settings' } },
    ])
  })

  it('a deep link copied while the view loads points at the requested route', async () => {
    const { buildSandboxUiWebLink } = await import('../sandboxUiDeepLinks.js')
    const { config } = await import('../config.js')
    vi.spyOn(config, 'desktopProfileUiBaseUrlExplicit', 'get').mockReturnValue(true)
    const { service, launch } = await setupReleaseRecorder('/r/first')
    service.me = { id: 'user-1', teamId: 'team-1' }
    await service.openSandboxUi(launch('first-app'))

    await expect(service.createSandboxUiDeepLink()).resolves.toEqual({
      url: buildSandboxUiWebLink('https://profile.example.com', {
        recipeNs: 'sandbox-recipes',
        recipeName: 'first-app',
        path: '/r/first',
      }),
    })
  })
})

describe('sandbox-ui IPC lifecycle handlers over the real AppService', () => {
  type Sender = { id: number }

  function registerHandlers(service: AppService) {
    electronMocks.ipcHandlers.clear()
    electronMocks.windowsBySender.clear()
    return import('../ipc.js').then(({ registerIpcHandlers }) => registerIpcHandlers(service))
  }

  function invoke(channel: string, sender: Sender, payload?: unknown): Promise<unknown> {
    const handler = electronMocks.ipcHandlers.get(channel)
    if (!handler) throw new Error(`no IPC handler registered for ${channel}`)
    return handler({ sender, senderFrame: { url: 'file:///app/index.html' } }, payload)
  }

  function windowFor(sender: Sender): FakeParentWindow {
    const parentWindow = new FakeParentWindow()
    electronMocks.windowsBySender.set(sender, parentWindow)
    return parentWindow
  }

  const openPayload = (launchId: string) => ({
    recipeNs: 'sandbox-recipes',
    recipeName: 'first-app',
    defaultPath: '/',
    bounds: { x: 0, y: 0, width: 400, height: 300 },
    launchId,
  })

  it('a close sent right after its open never reaches the queue first', async () => {
    const service = makeService()
    initPluginSdkRuntime({ service, getMainWindow: () => null, userDataDir })
    await registerHandlers(service)
    const mainSender = { id: 1 }
    const otherSender = { id: 2 }
    const parentWindow = windowFor(mainSender)
    const otherWindow = windowFor(otherSender)
    const launchId = crypto.randomUUID()

    // Both invokes are dispatched in the same tick, in send order.
    const opened = invoke('sandboxUi:open', mainSender, openPayload(launchId))
    const closed = invoke('sandboxUi:close', otherSender, { launchId })
    await Promise.all([opened, closed])

    expect(getActiveSandboxUi()).toBeNull()
    expectNoOrphanView(parentWindow)
    const releasedSends = parentWindow.webContents.send.mock.calls.filter(
      ([channel]) => channel === 'sandboxUi:released'
    )
    expect(releasedSends).toEqual([
      ['sandboxUi:released', { launchId, reason: 'closed', location: {} }],
    ])
    // Only the window that mounted the view hears about it.
    expect(otherWindow.webContents.send).not.toHaveBeenCalled()
  })

  it('rejects a close with a malformed launch id without closing anything', async () => {
    const service = makeService()
    initPluginSdkRuntime({ service, getMainWindow: () => null, userDataDir })
    await registerHandlers(service)
    const sender = { id: 1 }
    const parentWindow = windowFor(sender)
    await invoke('sandboxUi:open', sender, openPayload(crypto.randomUUID()))

    await expect(invoke('sandboxUi:close', sender, { launchId: '../x' })).rejects.toThrow(
      /launchId/
    )
    await drainLifecycleQueue(service)

    expect(getActiveSandboxUi()).not.toBeNull()
    expectNoOrphanView(parentWindow)
  })
})

describe('AppService sandbox-ui teardown isolates every step', () => {
  async function openLive(routePath?: string) {
    const recorder = await setupReleaseRecorder(routePath)
    const args = recorder.launch('first-app')
    await recorder.service.openSandboxUi(args)
    const view = electronMocks.views[0]!
    return { ...recorder, args, view }
  }

  function expectReleasedAndGone(
    view: InstanceType<typeof electronMocks.FakeWebContentsView>,
    released: ReleasedEvent[],
    expected: ReleasedEvent
  ): void {
    expect(view.webContents.isDestroyed()).toBe(true)
    expect(getActiveSandboxUi()).toBeNull()
    expect(released).toEqual([expected])
  }

  it('a view whose listener unhooks and find stop all throw is still released and gone', async () => {
    // Every per-view cleanup is live: a route handoff still waiting (the app
    // answered 503), a find session, shortcut routing, document listeners.
    const { service, parentWindow, released, args, view } = await openLive('/r/first')
    view.webContents.commitLoad(503)
    await expect(service.findInActiveSandboxUi('invoice', 'start', 1, vi.fn())).resolves.toEqual({
      status: 'started',
      requestId: 41,
    })
    // Injected failures, one per cleanup step.
    vi.spyOn(view.webContents, 'removeListener').mockImplementation(() => {
      throw new Error('injected unhook failure')
    })
    view.webContents.stopFindInPage.mockImplementation(() => {
      throw new Error('injected stop failure')
    })

    await expect(service.closeSandboxUi({ launchId: args.launchId })).resolves.toBeUndefined()

    expect(parentWindow.contentView.children).toEqual([])
    expectReleasedAndGone(view, released, {
      launchId: args.launchId,
      reason: 'closed',
      location: { routePath: '/r/first' },
    })
  })

  it('a failing detach still closes and releases the view', async () => {
    const { service, parentWindow, released, args, view } = await openLive()
    parentWindow.contentView.removeChildView.mockImplementationOnce(() => {
      throw new Error('detach failed')
    })

    await expect(service.closeSandboxUi({ launchId: args.launchId })).resolves.toBeUndefined()

    expectReleasedAndGone(view, released, {
      launchId: args.launchId,
      reason: 'closed',
      location: {},
    })
  })

  it('a failing webContents close still detaches and releases the view', async () => {
    const { service, parentWindow, released, args, view } = await openLive()
    vi.spyOn(view.webContents, 'close').mockImplementationOnce(() => {
      throw new Error('close failed')
    })

    await expect(service.closeSandboxUi({ launchId: args.launchId })).resolves.toBeUndefined()

    expect(parentWindow.contentView.children).toEqual([])
    expect(getActiveSandboxUi()).toBeNull()
    expect(released).toEqual([{ launchId: args.launchId, reason: 'closed', location: {} }])
  })

  it('a release listener that throws does not fail the close', async () => {
    const recorder = await setupReleaseRecorder()
    const args = recorder.launch('first-app', {
      onReleased: () => {
        throw new Error('listener failed')
      },
    })
    await recorder.service.openSandboxUi(args)

    await expect(
      recorder.service.closeSandboxUi({ launchId: args.launchId })
    ).resolves.toBeUndefined()

    expect(getActiveSandboxUi()).toBeNull()
    expectNoOrphanView(recorder.parentWindow)
  })

  it('a failing surface unpin still unmounts and releases the view', async () => {
    const { service, runtime, parentWindow, released, args, view } = await openLive()
    vi.spyOn(runtime, 'unpinAllSandboxUiSurfaces').mockImplementation(() => {
      throw new Error('unpin failed')
    })

    await expect(service.closeSandboxUi({ launchId: args.launchId })).resolves.toBeUndefined()

    expect(parentWindow.contentView.children).toEqual([])
    expectReleasedAndGone(view, released, {
      launchId: args.launchId,
      reason: 'closed',
      location: {},
    })
  })

  it('a view whose URL cannot be read is released with no location', async () => {
    const { service, parentWindow, released, args, view } = await openLive()
    view.webContents.commitLoad()
    vi.spyOn(view.webContents, 'getURL').mockImplementation(() => {
      throw new Error('Object has been destroyed')
    })

    await expect(service.closeSandboxUi({ launchId: args.launchId })).resolves.toBeUndefined()

    expect(parentWindow.contentView.children).toEqual([])
    expectReleasedAndGone(view, released, {
      launchId: args.launchId,
      reason: 'closed',
      location: null,
    })
  })

  it('a view showing a URL outside the app is released with no location', async () => {
    const { service, parentWindow, released, args, view } = await openLive()
    view.webContents.commitLoad()
    view.webContents.navigateInPage('https://elsewhere.example/landing')
    // The deep link refuses it, and the release reports no location.
    expect(() => getActiveSandboxUiLocation()).toThrow('Cannot read the current app route')

    await expect(service.closeSandboxUi({ launchId: args.launchId })).resolves.toBeUndefined()

    expect(parentWindow.contentView.children).toEqual([])
    expectReleasedAndGone(view, released, {
      launchId: args.launchId,
      reason: 'closed',
      location: null,
    })
  })
})

describe('AppService sandbox-ui route settling', () => {
  async function openLoading(routePath?: string) {
    const recorder = await setupReleaseRecorder(routePath)
    await recorder.service.openSandboxUi(recorder.launch('first-app'))
    return { ...recorder, webContents: electronMocks.views[0]!.webContents }
  }

  const location = (routePath?: string) => ({
    recipeNs: 'sandbox-recipes',
    recipeName: 'first-app',
    ...(routePath ? { path: routePath } : {}),
  })

  it('a view with no requested route reports where the server sent its first load', async () => {
    const { webContents } = await openLoading()
    webContents.commitLoad(200, `${APP_VIEW_URL}/welcome`)
    expect(getActiveSandboxUiLocation()).toEqual(location('/welcome'))
  })

  // Chromium commits a document (`did-navigate`) well before it finishes
  // loading; the fake's commitLoad does both at once, so these emit the commit
  // alone for the URL the driver asked to load.
  function commitWithoutFinishing(
    webContents: InstanceType<typeof electronMocks.FakeWebContentsView>['webContents'],
    url = webContents.pendingUrl
  ) {
    webContents.currentUrl = url
    webContents.emit('did-navigate', {}, url, 200, '')
  }

  it('a view with no requested route follows the user before the document finishes loading', async () => {
    const { service, released, webContents } = await openLoading()
    commitWithoutFinishing(webContents)
    webContents.navigateInPage(`${APP_VIEW_URL}/settings`)
    expect(getActiveSandboxUiLocation()).toEqual(location('/settings'))
    await service.closeSandboxUi()
    expect(released.map(event => event.location)).toEqual([{ routePath: '/settings' }])
  })

  it('a deep link copied before the load finishes points where the user went', async () => {
    const { buildSandboxUiWebLink } = await import('../sandboxUiDeepLinks.js')
    const { config } = await import('../config.js')
    vi.spyOn(config, 'desktopProfileUiBaseUrlExplicit', 'get').mockReturnValue(true)
    const { service, webContents } = await openLoading()
    service.me = { id: 'user-1', teamId: 'team-1' }
    commitWithoutFinishing(webContents)
    webContents.navigateInPage(`${APP_VIEW_URL}/settings`)
    await expect(service.createSandboxUiDeepLink()).resolves.toEqual({
      url: buildSandboxUiWebLink('https://profile.example.com', location('/settings')),
    })
  })

  it('a view with no requested route reports a document the server redirected it to before it loads', async () => {
    const { webContents } = await openLoading()
    commitWithoutFinishing(webContents, `${APP_VIEW_URL}/welcome`)
    expect(getActiveSandboxUiLocation()).toEqual(location('/welcome'))
  })

  it('a view with no requested route ignores a document committed outside the app', async () => {
    const { webContents } = await openLoading()
    commitWithoutFinishing(webContents, 'https://idp.example/login')
    expect(getActiveSandboxUiLocation()).toEqual(location())
  })

  it('a boot redirect before the load does not replace a requested route', async () => {
    const { service, released, webContents } = await openLoading('/r/first')
    commitWithoutFinishing(webContents)
    webContents.navigateInPage(`${APP_VIEW_URL}/login`)
    expect(getActiveSandboxUiLocation()).toEqual(location('/r/first'))
    await service.closeSandboxUi()
    expect(released.map(event => event.location)).toEqual([{ routePath: '/r/first' }])
  })

  it('an in-page navigation before the first load does not replace the requested route', async () => {
    const { webContents } = await openLoading('/r/first')
    webContents.navigateInPage(`${APP_VIEW_URL}/#boot`)
    webContents.commitLoad(503)
    expect(getActiveSandboxUiLocation()).toEqual(location('/r/first'))
  })

  it('an in-page navigation of a subframe does not replace the requested route', async () => {
    const { webContents } = await openLoading('/r/first')
    webContents.commitLoad(503)
    webContents.emit('did-navigate-in-page', {}, `${APP_VIEW_URL}/frame`, false)
    expect(getActiveSandboxUiLocation()).toEqual(location('/r/first'))
  })

  it('a handoff that finds the app already on the route settles it', async () => {
    const { webContents } = await openLoading('/r/first')
    webContents.commitLoad(200, `${APP_VIEW_URL}/r/first`)
    await vi.waitFor(() => expect(webContents.executeJavaScript).toHaveBeenCalledOnce(), {
      timeout: 1_000,
    })
    await expect(webContents.executeJavaScript.mock.results[0]!.value).resolves.toBe(true)
    expect(getActiveSandboxUiLocation()).toEqual(location('/r/first'))
  })

  it('a handoff the app does not take keeps the requested route', async () => {
    const { webContents } = await openLoading('/r/first')
    webContents.historyLocked = true
    webContents.commitLoad()
    await vi.waitFor(() => expect(webContents.executeJavaScript).toHaveBeenCalledOnce(), {
      timeout: 1_000,
    })
    await expect(webContents.executeJavaScript.mock.results[0]!.value).resolves.toBe(false)
    expect(getActiveSandboxUiLocation()).toEqual(location('/r/first'))
  })

  it('a new document the user opens after the handoff gave up is the live route', async () => {
    const { service, released, webContents } = await openLoading('/r/first')
    webContents.commitLoad(503)
    await vi.advanceTimersByTimeAsync(30_000)

    // A reload commits the same document: still the requested route.
    webContents.commitLoad()
    expect(getActiveSandboxUiLocation()).toEqual(location('/r/first'))

    webContents.navigateTo(`${APP_VIEW_URL}/reports`)
    expect(getActiveSandboxUiLocation()).toEqual(location('/reports'))
    await service.closeSandboxUi()
    expect(released.map(event => event.location)).toEqual([{ routePath: '/reports' }])
  })

  it('a handoff that gives up before the first load does not settle on that first load', async () => {
    // The app takes longer than the handoff waits to answer at all.
    const { webContents } = await openLoading('/r/first')
    await vi.advanceTimersByTimeAsync(30_000)
    webContents.commitLoad()
    expect(getActiveSandboxUiLocation()).toEqual(location('/r/first'))
  })

  it('a document committed outside the app does not replace the requested route', async () => {
    const { webContents } = await openLoading('/r/first')
    webContents.commitLoad(503)
    await vi.advanceTimersByTimeAsync(30_000)
    webContents.navigateTo('https://elsewhere.example/landing')
    expect(getActiveSandboxUiLocation()).toEqual(location('/r/first'))
  })

  it('a reload after the router moved the URL during boot keeps the requested route', async () => {
    const { webContents } = await openLoading('/r/first')
    // The app's router rewrites the URL before the document finishes loading.
    webContents.emit('did-navigate', {}, `${APP_VIEW_URL}/`, 200, '')
    webContents.navigateInPage(`${APP_VIEW_URL}/home`)
    await vi.advanceTimersByTimeAsync(30_000)
    webContents.emit('did-finish-load')
    expect(getActiveSandboxUiLocation()).toEqual(location('/r/first'))

    // A reload commits the document the view is already showing.
    webContents.emit('did-navigate', {}, `${APP_VIEW_URL}/home`, 200, '')
    webContents.emit('did-finish-load')
    expect(getActiveSandboxUiLocation()).toEqual(location('/r/first'))
  })

  it('a new document committed while the handoff still waits keeps the requested route', async () => {
    const { webContents } = await openLoading('/r/first')
    webContents.commitLoad(503)
    webContents.navigateTo(`${APP_VIEW_URL}/starting`, 503)
    expect(getActiveSandboxUiLocation()).toEqual(location('/r/first'))
  })
})

describe('sandbox-ui IPC close ordering and payloads', () => {
  type Sender = { id: number }

  async function setupIpc() {
    const service = makeService()
    initPluginSdkRuntime({ service, getMainWindow: () => null, userDataDir })
    electronMocks.ipcHandlers.clear()
    electronMocks.windowsBySender.clear()
    const { registerIpcHandlers } = await import('../ipc.js')
    registerIpcHandlers(service)
    const sender: Sender = { id: 1 }
    const parentWindow = new FakeParentWindow()
    electronMocks.windowsBySender.set(sender, parentWindow)
    const invoke = (channel: string, payload?: unknown): Promise<unknown> => {
      const handler = electronMocks.ipcHandlers.get(channel)
      if (!handler) throw new Error(`no IPC handler registered for ${channel}`)
      return handler({ sender, senderFrame: { url: 'file:///app/index.html' } }, payload)
    }
    const open = (launchId: string) =>
      invoke('sandboxUi:open', {
        recipeNs: 'sandbox-recipes',
        recipeName: 'first-app',
        defaultPath: '/',
        bounds: { x: 0, y: 0, width: 400, height: 300 },
        launchId,
      })
    const releasedSends = () =>
      parentWindow.webContents.send.mock.calls.filter(
        ([channel]) => channel === 'sandboxUi:released'
      )
    return { service, parentWindow, invoke, open, releasedSends }
  }

  // The renderer always names its launch. A close without one used to close
  // whatever was live, which by the time the queue reached it could be a view
  // another launch owned.
  it.each([undefined, null, {}])(
    'rejects a close with payload %j without closing the live view',
    async payload => {
      const { service, invoke, open, releasedSends, parentWindow } = await setupIpc()
      const launchId = crypto.randomUUID()
      await open(launchId)

      await expect(invoke('sandboxUi:close', payload)).rejects.toThrow(/launchId/)
      await drainLifecycleQueue(service)

      expect(getActiveSandboxUi()?.launchId).toBe(launchId)
      expect(parentWindow.contentView.children).toHaveLength(1)
      expect(releasedSends()).toEqual([])
    }
  )

  // A view main tears down on its own (crash, parent closed) reaches the
  // renderer only as its release; there is no second "closed" signal for the
  // renderer to reconcile against it.
  it('a view whose renderer dies is reported to its window only by its release', async () => {
    const { open, parentWindow } = await setupIpc()
    const launchId = crypto.randomUUID()
    await open(launchId)
    parentWindow.webContents.send.mockClear()

    electronMocks.views[0]!.webContents.emit(
      'render-process-gone',
      {},
      { reason: 'crashed', exitCode: 139 }
    )

    expect(parentWindow.webContents.send.mock.calls).toEqual([
      ['sandboxUi:released', { launchId, reason: 'crashed', location: null }],
    ])
  })

  it('a close sent right before the next open closes its own view first', async () => {
    const { invoke, open, releasedSends } = await setupIpc()
    const first = crypto.randomUUID()
    const second = crypto.randomUUID()
    await open(first)

    const closed = invoke('sandboxUi:close', { launchId: first })
    const opened = open(second)
    await Promise.all([closed, opened])

    expect(getActiveSandboxUi()?.launchId).toBe(second)
    expect(releasedSends()).toEqual([
      ['sandboxUi:released', { launchId: first, reason: 'closed', location: {} }],
    ])
  })
})

// Refresh of a healthy view reloads its document in place: same view, same
// session, same refresh loop. Only the launch that owns the view can reload it.
describe('sandbox-ui IPC reload of the live view', () => {
  type Sender = { id: number }

  async function setupIpc() {
    const service = makeService()
    initPluginSdkRuntime({ service, getMainWindow: () => null, userDataDir })
    electronMocks.ipcHandlers.clear()
    electronMocks.windowsBySender.clear()
    const { registerIpcHandlers } = await import('../ipc.js')
    registerIpcHandlers(service)
    const sender: Sender = { id: 1 }
    const parentWindow = new FakeParentWindow()
    electronMocks.windowsBySender.set(sender, parentWindow)
    const invokeFrom = (frameUrl: string, channel: string, payload?: unknown) => {
      const handler = electronMocks.ipcHandlers.get(channel)
      if (!handler) throw new Error(`no IPC handler registered for ${channel}`)
      return handler({ sender, senderFrame: { url: frameUrl } }, payload)
    }
    const invoke = (channel: string, payload?: unknown): Promise<unknown> =>
      invokeFrom('file:///app/index.html', channel, payload)
    const open = (launchId: string) =>
      invoke('sandboxUi:open', {
        recipeNs: 'sandbox-recipes',
        recipeName: 'first-app',
        defaultPath: '/',
        bounds: { x: 0, y: 0, width: 400, height: 300 },
        launchId,
      })
    const releasedSends = () =>
      parentWindow.webContents.send.mock.calls.filter(
        ([channel]) => channel === 'sandboxUi:released'
      )
    const reloads = () =>
      electronMocks.views.map(view => view.webContents.reloadIgnoringCache.mock.calls.length)
    return { service, parentWindow, invoke, invokeFrom, open, releasedSends, reloads }
  }

  it('reloads the view its launch owns without a new mint, a release or a new view', async () => {
    const { invoke, open, releasedSends, reloads, parentWindow } = await setupIpc()
    const launchId = crypto.randomUUID()
    await open(launchId)
    const live = getActiveSandboxUi()
    fetchMock.mockClear()

    await invoke('sandboxUi:reload', { launchId })

    expect(reloads()).toEqual([1])
    expect(getActiveSandboxUi()).toEqual(live)
    expect(parentWindow.contentView.children).toEqual([electronMocks.views[0]])
    expect(releasedSends()).toEqual([])
    expect(mintCallsFor('first-app')).toBe(0)
    // The session refresh loop of the view keeps running.
    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS + 1_000)
    expect(mintCallsFor('first-app')).toBe(1)
  })

  it('a reload naming a launch that no longer owns the view reloads nothing', async () => {
    const { invoke, open, reloads } = await setupIpc()
    const first = crypto.randomUUID()
    const second = crypto.randomUUID()
    await open(first)
    await open(second)

    await invoke('sandboxUi:reload', { launchId: first })

    expect(getActiveSandboxUi()?.launchId).toBe(second)
    expect(reloads()).toEqual([0, 0])
  })

  it('a reload sent right after its open reloads the view that open mounts', async () => {
    const { invoke, open, reloads } = await setupIpc()
    const launchId = crypto.randomUUID()

    // Both invokes are dispatched in the same tick, in send order.
    await Promise.all([open(launchId), invoke('sandboxUi:reload', { launchId })])

    expect(getActiveSandboxUi()?.launchId).toBe(launchId)
    expect(reloads()).toEqual([1])
  })

  it('a reload that reaches main after its view crashed or its session ended does nothing', async () => {
    const { service, invoke, open, reloads } = await setupIpc()
    const crashed = crypto.randomUUID()
    await open(crashed)
    electronMocks.views[0]!.webContents.emit(
      'render-process-gone',
      {},
      { reason: 'crashed', exitCode: 139 }
    )
    await invoke('sandboxUi:reload', { launchId: crashed })

    const loggedOut = crypto.randomUUID()
    await open(loggedOut)
    ;(service as unknown as { invalidateSandboxUiSession(): void }).invalidateSandboxUiSession()
    await invoke('sandboxUi:reload', { launchId: loggedOut })

    expect(getActiveSandboxUi()).toBeNull()
    expect(reloads()).toEqual([0, 0])
  })

  it.each([undefined, null, {}, { launchId: '../x' }, { launchId: 'launch-1' }])(
    'rejects a reload with payload %j without reloading the live view',
    async payload => {
      const { service, invoke, open, reloads } = await setupIpc()
      await open(crypto.randomUUID())

      await expect(invoke('sandboxUi:reload', payload)).rejects.toThrow(/launchId/)
      await drainLifecycleQueue(service)

      expect(reloads()).toEqual([0])
    }
  )

  it('rejects a reload from an untrusted sender without reloading the live view', async () => {
    const { service, invokeFrom, open, reloads } = await setupIpc()
    const launchId = crypto.randomUUID()
    await open(launchId)

    await expect(
      invokeFrom('https://evil.example/', 'sandboxUi:reload', { launchId })
    ).rejects.toThrow(/Untrusted/)
    await drainLifecycleQueue(service)

    expect(reloads()).toEqual([0])
  })
})
