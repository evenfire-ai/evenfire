import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AppService } from '../appService.js'
import { _resetPluginSdkRuntimeForTests, initPluginSdkRuntime } from '../pluginSdkRuntime.js'
import { _resetPluginSurfacesForTests, resolvePluginSurface } from '../pluginSurfaceRegistry.js'
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
  getActiveEnvKey: () => 'test-env',
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
    getOrIssue = vi.fn(async () => ({ token: 'rpc-token' }))
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
  TokenStore: class {
    getSessionToken = vi.fn().mockResolvedValue(null)
    setSessionToken = vi.fn()
    clearSessionToken = vi.fn()
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

const mintResponders = new Map<string, () => Response>()
const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
  const url = String(input instanceof Request ? input.url : input)
  const match = /\/api\/v1\/sandbox-ui\/sandbox-recipes\/([^/]+)\/session$/.exec(url)
  if (!match) throw new Error(`unexpected fetch ${url}`)
  const recipeName = decodeURIComponent(match[1]!)
  const respond = mintResponders.get(recipeName)
  return respond ? respond() : mintOk(recipeName)
})

function mintCallsFor(recipeName: string): number {
  return fetchMock.mock.calls.filter(([input]) =>
    String(input).includes(`/sandbox-recipes/${recipeName}/session`)
  ).length
}

function makeService(): AppService {
  const svc = new AppService()
  ;(svc as unknown as { sessionToken: string }).sessionToken = 'session-token'
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
  vi.stubGlobal('fetch', fetchMock)
  userDataDir = await mkdtemp(path.join(tmpdir(), 'clerum-sandbox-lifecycle-'))
})

afterEach(async () => {
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
