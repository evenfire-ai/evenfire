import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AppService } from '../appService.js'
import { __setChatStoreBaseDirForTests, unbindChatStore } from '../chatStoreBinding.js'
import { CONSENT_PROMPT_COOLDOWN_MS, PluginConsentGate } from '../pluginConsentGate.js'
import type { ConsentStore } from '../pluginConsentStore.js'
import { getCapability } from '../pluginSdkCapabilities.js'
import {
  PLUGIN_SDK_CONSENT_CANCELLED_CHANNEL,
  PLUGIN_SDK_CONSENT_REQUESTED_CHANNEL,
} from '../pluginSdkProtocol.js'
import { _resetPluginSdkRuntimeForTests, initPluginSdkRuntime } from '../pluginSdkRuntime.js'
import type { PinnedPluginSurface } from '../pluginSurfaceRegistry.js'
import {
  _resetPluginSurfacesForTests,
  resolvePluginSurface,
  unpinPluginSurface,
} from '../pluginSurfaceRegistry.js'
import { getActiveSandboxUi, unmountSandboxUiView } from '../sandboxUiDriver.js'
import { _resetSandboxUiRefreshForTests } from '../sandboxUiSessionRefresh.js'
import { FakeParentWindow, electronMocks } from './__fixtures__/sandboxUiElectronFakes.js'

// The open/close lifecycle is exercised end to end through the REAL AppService,
// the REAL sandbox-ui driver, the REAL session-refresh loop, the REAL plugin
// surface pin registry and the REAL RpcProxyClient. Only the Electron runtime
// (views, sessions, windows) and the RPC-token issuer are faked; mint outcomes
// come from rpc-proxy HTTP responses fed to the real client through `fetch`.
// For E32, a one-shot wrapper delays the imported driver's exported visibility
// setter before its real mutation. The module import itself resolves normally;
// this holds the final mutation boundary without claiming native Electron timing.

const driverDelay = vi.hoisted(() => ({
  enabled: false,
  blocked: null as Promise<void> | null,
  started: null as (() => void) | null,
  finished: null as (() => void) | null,
}))

vi.mock('../sandboxUiDriver.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../sandboxUiDriver.js')>()
  return {
    ...actual,
    setSandboxUiVisibleForWebContents: (webContentsId: number, visible: boolean) => {
      if (!visible && driverDelay.enabled) {
        driverDelay.enabled = false
        driverDelay.started?.()
        return driverDelay.blocked!.then(() => {
          actual.setSandboxUiVisibleForWebContents(webContentsId, visible)
          driverDelay.finished?.()
        })
      }
      return actual.setSandboxUiVisibleForWebContents(webContentsId, visible)
    },
  }
})

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
      envKey: 'testenv-0123456789ab',
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

// rpc-proxy's mint success contract: 204 + a Path-scoped Set-Cookie.
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
  driverDelay.enabled = false
  driverDelay.blocked = null
  driverDelay.started = null
  driverDelay.finished = null
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
  const windowState = { ready: true }
  const mainWindow = {
    isDestroyed: () => false,
    isVisible: () => windowState.ready,
    isMinimized: () => false,
    isFocused: () => windowState.ready,
    webContents: { send: vi.fn(), isDestroyed: () => false },
  }
  const runtime = initPluginSdkRuntime({
    service,
    getMainWindow: () => mainWindow as never,
    userDataDir,
  })
  const parentWindow = new FakeParentWindow()
  await service.openSandboxUi(openArgs('first-app', parentWindow, onReleased))
  const first = getActiveSandboxUi()
  expect(first?.appRef).toBe('sandbox-recipes/first-app')
  expect(resolvePluginSurface(first!.webContentsId)?.pluginId).toBe('sandbox-recipes/first-app')
  const firstView = electronMocks.views[0]
  return {
    service,
    parentWindow,
    firstWebContentsId: first!.webContentsId,
    firstView,
    runtime,
    mainWindow,
    setWindowReady: (ready: boolean) => {
      windowState.ready = ready
    },
  }
}

async function flushUntil(predicate: () => boolean, maxTicks = 1000): Promise<void> {
  for (let i = 0; i < maxTicks && !predicate(); i++) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  if (!predicate()) throw new Error('flushUntil: predicate did not hold within maxTicks')
}

function pendingPromptId(gate: { pending: unknown }): string {
  const pending = gate.pending as { promptId?: string } | null
  if (!pending?.promptId) throw new Error('expected a registered pending consent prompt')
  return pending.promptId
}

function initialMount() {
  const view = getActiveSandboxUi()
  if (!view) throw new Error('expected the first sandbox-ui mount')
  const mount = resolvePluginSurface(view.webContentsId)
  if (!mount) throw new Error('expected the first plugin surface to be pinned')
  return mount
}

describe('PluginConsentGate mount-bound lifecycle', () => {
  it('denies a stale mount before reading grants or presenting consent', async () => {
    const { service, parentWindow, runtime, mainWindow, firstWebContentsId } =
      await setupWithLiveFirstApp()
    const mount = resolvePluginSurface(firstWebContentsId)!
    const getGrant = vi.spyOn(runtime.store, 'get')
    const sendStart = mainWindow.webContents.send.mock.calls.length

    await service.openSandboxUi(openArgs('second-app', parentWindow))
    const outcome = await runtime.gate.ensure({
      envKey: 'testenv-0123456789ab',
      userId: 'user-a',
      pluginId: mount.pluginId,
      pluginTitle: 'First app',
      mount,
      capabilities: ['identity.read'],
    })

    expect(outcome).toEqual({
      granted: { 'identity.read': false },
      source: { 'identity.read': 'prompt_denied' },
    })
    expect(getGrant).not.toHaveBeenCalled()
    expect(
      mainWindow.webContents.send.mock.calls
        .slice(sendStart)
        .some(([channel]) => channel === PLUGIN_SDK_CONSENT_REQUESTED_CHANNEL)
    ).toBe(false)
  })

  it('denies a grant read that resolves after the request mount is unpinned', async () => {
    const { runtime } = await setupWithLiveFirstApp()
    const mount = initialMount()
    const capability = 'identity.read'
    const descriptor = getCapability(capability)!
    const grant = {
      envKey: 'testenv-0123456789ab',
      userId: 'user-a',
      pluginId: mount.pluginId,
      capability,
      grantedAt: '2026-11-06T00:00:00.000Z',
      lastUsedAt: null,
      descriptorVersion: descriptor.descriptorVersion,
      revision: 0,
    }
    let releaseRead!: () => void
    let readStarted!: () => void
    const readStartedPromise = new Promise<void>(resolve => {
      readStarted = resolve
    })
    const readBlocked = new Promise<void>(resolve => {
      releaseRead = resolve
    })
    const getGrant = vi.spyOn(runtime.store, 'get').mockImplementation(async () => {
      readStarted()
      await readBlocked
      return grant
    })

    const pending = runtime.gate.ensure({
      envKey: grant.envKey,
      userId: grant.userId,
      pluginId: mount.pluginId,
      pluginTitle: 'First app',
      mount,
      capabilities: [capability],
    })
    await readStartedPromise
    unpinPluginSurface(mount.webContentsId)
    releaseRead()
    const outcome = await pending

    expect(outcome.granted[capability]).toBe(false)
    expect(outcome.source[capability]).toBe('prompt_denied')
    expect(getGrant).toHaveBeenCalledOnce()
    expect(runtime.gate.hasPendingPrompt()).toBe(false)
  })

  it('stops the queued grant recheck loop after its mount is unpinned', async () => {
    const { runtime } = await setupWithLiveFirstApp()
    const mount = initialMount()
    const originalGet = runtime.store.get.bind(runtime.store)
    const reads = new Map<string, number>()
    let releaseRead!: () => void
    let readStarted!: () => void
    const readStartedPromise = new Promise<void>(resolve => {
      readStarted = resolve
    })
    const readBlocked = new Promise<void>(resolve => {
      releaseRead = resolve
    })
    const getGrant = vi.spyOn(runtime.store, 'get').mockImplementation(async key => {
      const count = (reads.get(key.capability) ?? 0) + 1
      reads.set(key.capability, count)
      if (key.capability === 'identity.read' && count === 5) {
        readStarted()
        await readBlocked
      }
      return originalGet(key)
    })

    const first = runtime.gate.ensure({
      envKey: 'testenv-0123456789ab',
      userId: 'user-a',
      pluginId: mount.pluginId,
      pluginTitle: 'First app',
      mount,
      capabilities: ['identity.read', 'org.read'],
    })
    await flushUntil(() => runtime.gate.hasPendingPrompt())
    const queued = runtime.gate.ensure({
      envKey: 'testenv-0123456789ab',
      userId: 'user-a',
      pluginId: mount.pluginId,
      pluginTitle: 'First app',
      mount,
      capabilities: ['identity.read', 'org.read'],
    })
    await flushUntil(() => reads.get('org.read') === 2)
    const firstPromptId = pendingPromptId(runtime.gate as unknown as { pending: unknown })
    expect(runtime.gate.resolvePrompt(firstPromptId, ['identity.read', 'org.read'])).toBe(true)
    await readStartedPromise
    unpinPluginSurface(mount.webContentsId)
    releaseRead()
    const [firstOutcome, queuedOutcome] = await Promise.all([first, queued])

    expect(firstOutcome.granted).toEqual({ 'identity.read': true, 'org.read': true })
    expect(queuedOutcome.granted).toEqual({ 'identity.read': false, 'org.read': false })
    expect(reads.get('org.read')).toBe(4)
    expect(getGrant).toHaveBeenCalledTimes(9)
    expect(runtime.gate.hasPendingPrompt()).toBe(false)
  })

  it('cancels without presenting when hiding the current mount resolves false', async () => {
    const { service, runtime, mainWindow, firstWebContentsId } = await setupWithLiveFirstApp()
    const mount = resolvePluginSurface(firstWebContentsId)!
    expect(resolvePluginSurface(mount.webContentsId)).toBe(mount)
    vi.spyOn(service, 'hideSandboxUiForPluginMount').mockResolvedValue(false)
    const putGrant = vi.spyOn(runtime.store, 'put')
    const send = mainWindow.webContents.send
    send.mockImplementation((channel, payload) => {
      if (channel === PLUGIN_SDK_CONSENT_REQUESTED_CHANNEL) {
        runtime.gate.resolvePrompt((payload as { promptId: string }).promptId, [])
      }
    })

    const outcome = await runtime.gate.ensure({
      envKey: 'testenv-0123456789ab',
      userId: 'user-a',
      pluginId: mount.pluginId,
      pluginTitle: 'First app',
      mount,
      capabilities: ['identity.read'],
    })
    const cancellations = send.mock.calls.filter(
      ([channel]) => channel === PLUGIN_SDK_CONSENT_CANCELLED_CHANNEL
    )
    const prompts = send.mock.calls.filter(
      ([channel]) => channel === PLUGIN_SDK_CONSENT_REQUESTED_CHANNEL
    )

    expect(prompts).toHaveLength(0)
    expect(cancellations).toHaveLength(1)
    expect(outcome).toEqual({
      granted: { 'identity.read': false },
      source: { 'identity.read': 'prompt_denied' },
    })
    expect(runtime.gate.hasPendingPrompt()).toBe(false)
    expect(putGrant).not.toHaveBeenCalled()
  })

  it('does not present after the mount is unpinned during the visibility await', async () => {
    const { service, runtime, mainWindow } = await setupWithLiveFirstApp()
    const mount = initialMount()
    const hide = vi.spyOn(service, 'hideSandboxUiForPluginMount').mockImplementation(async () => {
      unpinPluginSurface(mount.webContentsId)
      return true
    })
    const send = mainWindow.webContents.send
    send.mockImplementation((channel, payload) => {
      if (channel === PLUGIN_SDK_CONSENT_REQUESTED_CHANNEL) {
        runtime.gate.resolvePrompt((payload as { promptId: string }).promptId, [])
      }
    })

    const outcome = await runtime.gate.ensure({
      envKey: 'testenv-0123456789ab',
      userId: 'user-a',
      pluginId: mount.pluginId,
      pluginTitle: 'First app',
      mount,
      capabilities: ['identity.read'],
    })
    const prompts = send.mock.calls.filter(
      ([channel]) => channel === PLUGIN_SDK_CONSENT_REQUESTED_CHANNEL
    )
    const cancellations = send.mock.calls.filter(
      ([channel]) => channel === PLUGIN_SDK_CONSENT_CANCELLED_CHANNEL
    )

    expect(hide).toHaveBeenCalledOnce()
    expect(prompts).toHaveLength(0)
    expect(cancellations).toHaveLength(1)
    expect(outcome.granted['identity.read']).toBe(false)
    expect(runtime.gate.hasPendingPrompt()).toBe(false)
  })

  it('does not persist a grant answered after its mount is unpinned', async () => {
    const { runtime, mainWindow } = await setupWithLiveFirstApp()
    const mount = initialMount()
    const putGrant = vi.spyOn(runtime.store, 'put').mockResolvedValue()
    const sendStart = mainWindow.webContents.send.mock.calls.length
    const pending = runtime.gate.ensure({
      envKey: 'testenv-0123456789ab',
      userId: 'user-a',
      pluginId: mount.pluginId,
      pluginTitle: 'First app',
      mount,
      capabilities: ['identity.read'],
    })
    await flushUntil(() =>
      mainWindow.webContents.send.mock.calls
        .slice(sendStart)
        .some(([channel]) => channel === PLUGIN_SDK_CONSENT_REQUESTED_CHANNEL)
    )
    const prompt = mainWindow.webContents.send.mock.calls
      .slice(sendStart)
      .find(([channel]) => channel === PLUGIN_SDK_CONSENT_REQUESTED_CHANNEL)?.[1] as {
      promptId: string
    }
    unpinPluginSurface(mount.webContentsId)
    expect(runtime.gate.resolvePrompt(prompt.promptId, ['identity.read'])).toBe(true)
    const outcome = await pending

    expect(outcome.granted['identity.read']).toBe(false)
    expect(putGrant).not.toHaveBeenCalled()
    expect(runtime.gate.hasPendingPrompt()).toBe(false)
  })

  it('does not forward an unpinned mount to the native visibility driver', async () => {
    const { service, runtime } = await setupWithLiveFirstApp()
    const mount = initialMount()
    const setVisibleForMount = vi
      .spyOn(await import('../sandboxUiDriver.js'), 'setSandboxUiVisibleForWebContents')
      .mockResolvedValue(true)
    const hiding = service.hideSandboxUiForPluginMount(mount)
    runtime.unpinSandboxUiSurface(mount.webContentsId)

    await expect(hiding).resolves.toBe(false)
    expect(setVisibleForMount).not.toHaveBeenCalled()
  })

  it('does not present or hide a replacement after release during initial grant lookup', async () => {
    const { service, parentWindow, runtime, mainWindow, firstWebContentsId } =
      await setupWithLiveFirstApp()
    const pluginId = 'sandbox-recipes/first-app'
    const mount = resolvePluginSurface(firstWebContentsId)!
    let releaseGrantRead!: () => void
    let grantReadStarted!: () => void
    const grantReadStartedPromise = new Promise<void>(resolve => {
      grantReadStarted = resolve
    })
    const grantReadBlocked = new Promise<void>(resolve => {
      releaseGrantRead = resolve
    })
    let grantReads = 0
    vi.spyOn(runtime.store, 'get').mockImplementation(async () => {
      grantReads += 1
      if (grantReads === 1) {
        grantReadStarted()
        await grantReadBlocked
      }
      return null
    })
    const sendStart = mainWindow.webContents.send.mock.calls.length

    const pending = runtime.gate.ensure({
      envKey: 'testenv-0123456789ab',
      userId: 'user-a',
      pluginId,
      pluginTitle: 'First app',
      mount,
      capabilities: ['identity.read'],
    })
    await grantReadStartedPromise

    // AppService replacement runs its real unpin → releasePlugin → resetPlugin
    // path while the real Gate is still before pending-prompt registration.
    await service.openSandboxUi(openArgs('second-app', parentWindow))
    const replacementView = electronMocks.views[1]!
    releaseGrantRead()
    const outcome = await pending
    const stalePrompt = mainWindow.webContents.send.mock.calls
      .slice(sendStart)
      .some(([channel]) => channel === PLUGIN_SDK_CONSENT_REQUESTED_CHANNEL)
    expect(outcome.granted['identity.read']).toBe(false)
    expect(grantReads).toBe(1)
    expect(stalePrompt).toBe(false)
    expect(runtime.gate.hasPendingPrompt()).toBe(false)
    expect(replacementView.setVisible).not.toHaveBeenCalledWith(false)
  })

  it('real AppService setter settles its hide before another event can replace the active view', async () => {
    const { LocalConsentStore } = await import('../pluginConsentStore.js')
    const { PluginConsentGate } = await import('../pluginConsentGate.js')
    const { service, parentWindow, firstView } = await setupWithLiveFirstApp()
    const pluginId = 'sandbox-recipes/first-app'
    let gate!: InstanceType<typeof PluginConsentGate>
    let hideStarted!: () => void
    const hideStartedPromise = new Promise<void>(resolve => {
      hideStarted = resolve
    })
    const prompts: unknown[] = []
    gate = new PluginConsentGate({
      store: new LocalConsentStore(path.join(userDataDir, 'consent-race-real')),
      isMountCurrent: mount => resolvePluginSurface(mount.webContentsId) === mount,
      presentPrompt: request => prompts.push(request),
      cancelPrompt: vi.fn(),
      setSurfaceVisible: (visible, mount) => {
        const operation = service.hideSandboxUiForPluginMount(mount)
        if (!visible) {
          hideStarted()
          gate.resetPlugin(pluginId)
        }
        return operation
      },
      isWindowReady: () => true,
    })

    const pending = gate.ensure({
      envKey: 'testenv-0123456789ab',
      userId: 'user-a',
      pluginId,
      pluginTitle: 'First app',
      mount: resolvePluginSurface(getActiveSandboxUi()!.webContentsId)!,
      capabilities: ['identity.read'],
    })
    await hideStartedPromise
    await pending
    expect(prompts).toHaveLength(0)
    expect(firstView?.setVisible).toHaveBeenCalledWith(false)

    await service.openSandboxUi(openArgs('second-app', parentWindow))
    const replacementView = electronMocks.views[1]!
    await service.setSandboxUiVisible(true)
    expect(replacementView.setVisible).toHaveBeenLastCalledWith(true)
    expect(replacementView.setVisible).not.toHaveBeenCalledWith(false)
  })

  it('does not apply a deferred hide to a replacement view', async () => {
    const { LocalConsentStore } = await import('../pluginConsentStore.js')
    const { PluginConsentGate } = await import('../pluginConsentGate.js')
    const { service, parentWindow } = await setupWithLiveFirstApp()
    const pluginId = 'sandbox-recipes/first-app'
    let releaseHide!: () => void
    let hideStarted!: () => void
    const hideStartedPromise = new Promise<void>(resolve => {
      hideStarted = resolve
    })
    const hideBlocked = new Promise<void>(resolve => {
      releaseHide = resolve
    })
    const gate = new PluginConsentGate({
      store: new LocalConsentStore(path.join(userDataDir, 'consent-race-delayed')),
      isMountCurrent: mount => resolvePluginSurface(mount.webContentsId) === mount,
      presentPrompt: vi.fn(),
      cancelPrompt: vi.fn(),
      setSurfaceVisible: async (_visible, mount) => {
        hideStarted()
        await hideBlocked
        return service.hideSandboxUiForPluginMount(mount)
      },
      isWindowReady: () => true,
    })

    const pending = gate.ensure({
      envKey: 'testenv-0123456789ab',
      userId: 'user-a',
      pluginId,
      pluginTitle: 'First app',
      mount: resolvePluginSurface(getActiveSandboxUi()!.webContentsId)!,
      capabilities: ['identity.read'],
    })
    await hideStartedPromise
    gate.resetPlugin(pluginId)
    await service.openSandboxUi(openArgs('second-app', parentWindow))
    const replacementView = electronMocks.views[1]!
    await service.setSandboxUiVisible(true)
    releaseHide()
    await pending

    expect(replacementView.setVisible).not.toHaveBeenCalledWith(false)
    expect(replacementView.setVisible).toHaveBeenLastCalledWith(true)
  })

  it('a late AppService-to-driver hide cannot hide a replacement after release', async () => {
    const { service, parentWindow, runtime } = await setupWithLiveFirstApp()
    const pluginId = 'sandbox-recipes/first-app'
    const mount = initialMount()
    let releaseDriverHide!: () => void
    let driverHideStarted!: () => void
    let driverHideFinished!: () => void
    const driverHideStartedPromise = new Promise<void>(resolve => {
      driverHideStarted = resolve
    })
    const driverHideFinishedPromise = new Promise<void>(resolve => {
      driverHideFinished = resolve
    })
    driverDelay.enabled = true
    driverDelay.blocked = new Promise<void>(resolve => {
      releaseDriverHide = resolve
    })
    driverDelay.started = driverHideStarted
    driverDelay.finished = driverHideFinished

    const pending = runtime.gate.ensure({
      envKey: 'testenv-0123456789ab',
      userId: 'user-a',
      pluginId,
      pluginTitle: 'First app',
      mount,
      capabilities: ['identity.read'],
    })
    await driverHideStartedPromise
    await flushUntil(() => runtime.gate.hasPendingPrompt())

    await service.openSandboxUi(openArgs('first-app', parentWindow))
    const replacementView = electronMocks.views[1]!
    await service.setSandboxUiVisible(true)
    const replacementCallStart = replacementView.setVisible.mock.calls.length

    releaseDriverHide()
    await Promise.all([pending, driverHideFinishedPromise])
    const lateHide = replacementView.setVisible.mock.calls
      .slice(replacementCallStart)
      .some(([visible]) => visible === false)

    expect(lateHide).toBe(false)
  })

  it('does not revive a queued request released after its dequeue recheck', async () => {
    const { service, parentWindow, runtime, mainWindow } = await setupWithLiveFirstApp()
    const pluginId = 'sandbox-recipes/first-app'
    const mount = initialMount()
    const scheduled = vi.spyOn(globalThis, 'setTimeout')
    let reads = 0
    let releaseRecheck!: () => void
    let recheckStarted!: () => void
    const recheckStartedPromise = new Promise<void>(resolve => {
      recheckStarted = resolve
    })
    const recheckBlocked = new Promise<void>(resolve => {
      releaseRecheck = resolve
    })
    const originalGet = runtime.store.get.bind(runtime.store)
    vi.spyOn(runtime.store, 'get').mockImplementation(async key => {
      reads += 1
      if (reads === 4) {
        recheckStarted()
        await recheckBlocked
      }
      return originalGet(key)
    })

    const first = runtime.gate.ensure({
      envKey: 'testenv-0123456789ab',
      userId: 'user-a',
      pluginId,
      pluginTitle: 'First app',
      mount,
      capabilities: ['identity.read'],
    })
    await flushUntil(() => runtime.gate.hasPendingPrompt())
    const second = runtime.gate.ensure({
      envKey: 'testenv-0123456789ab',
      userId: 'user-a',
      pluginId,
      pluginTitle: 'First app',
      mount,
      capabilities: ['org.read'],
    })
    await flushUntil(() => reads >= 3)
    const firstPromptId = pendingPromptId(runtime.gate as unknown as { pending: unknown })
    expect(runtime.gate.resolvePrompt(firstPromptId, ['identity.read'])).toBe(true)
    await recheckStartedPromise
    const sendStart = mainWindow.webContents.send.mock.calls.length
    let secondSettled = false
    void second.then(
      () => {
        secondSettled = true
      },
      () => {
        secondSettled = true
      }
    )

    await service.openSandboxUi(openArgs('first-app', parentWindow))
    const replacementView = electronMocks.views[1]!
    const replacementCallStart = replacementView.setVisible.mock.calls.length
    const timerCallStart = scheduled.mock.calls.length
    releaseRecheck()
    await flushUntil(
      () =>
        secondSettled ||
        scheduled.mock.calls
          .slice(timerCallStart)
          .some(
            ([, delay]) =>
              typeof delay === 'number' && delay > 0 && delay <= CONSENT_PROMPT_COOLDOWN_MS
          )
    )
    const staleCooldownStarted = scheduled.mock.calls
      .slice(timerCallStart)
      .some(
        ([, delay]) => typeof delay === 'number' && delay > 0 && delay <= CONSENT_PROMPT_COOLDOWN_MS
      )
    if (staleCooldownStarted) await vi.advanceTimersByTimeAsync(CONSENT_PROMPT_COOLDOWN_MS)
    await flushUntil(() => secondSettled)
    await Promise.all([first, second])

    const stalePending = runtime.gate.hasPendingPrompt()
    const stalePromptPresented = mainWindow.webContents.send.mock.calls
      .slice(sendStart)
      .some(
        ([channel, request]) =>
          channel === PLUGIN_SDK_CONSENT_REQUESTED_CHANNEL &&
          (request as { pluginId?: string })?.pluginId === pluginId
      )
    const staleHide = replacementView.setVisible.mock.calls
      .slice(replacementCallStart)
      .some(([visible]) => visible === false)
    expect({ stalePending, stalePromptPresented, staleHide }).toEqual({
      stalePending: false,
      stalePromptPresented: false,
      staleHide: false,
    })
    expect(staleCooldownStarted).toBe(false)
  })

  it('does not recheck a queued request after its mount is replaced before dequeue', async () => {
    const { service, parentWindow, runtime, mainWindow } = await setupWithLiveFirstApp()
    const pluginId = 'sandbox-recipes/first-app'
    const mount = initialMount()
    let orgGrantReads = 0
    const originalGet = runtime.store.get.bind(runtime.store)
    vi.spyOn(runtime.store, 'get').mockImplementation(async key => {
      if (key.capability === 'org.read') {
        orgGrantReads += 1
        if (orgGrantReads > 1) throw new Error('released queued mount reached dequeue recheck')
      }
      return originalGet(key)
    })

    const first = runtime.gate.ensure({
      envKey: 'testenv-0123456789ab',
      userId: 'user-a',
      pluginId,
      pluginTitle: 'First app',
      mount,
      capabilities: ['identity.read'],
    })
    await flushUntil(() => runtime.gate.hasPendingPrompt())
    const second = runtime.gate.ensure({
      envKey: 'testenv-0123456789ab',
      userId: 'user-a',
      pluginId,
      pluginTitle: 'First app',
      mount,
      capabilities: ['org.read'],
    })
    await flushUntil(() => orgGrantReads === 1)
    const sendStart = mainWindow.webContents.send.mock.calls.length
    await service.openSandboxUi(openArgs('first-app', parentWindow))
    expect(resolvePluginSurface(mount.webContentsId)).not.toBe(mount)
    await Promise.all([first, second])

    expect(orgGrantReads).toBe(1)
    expect(runtime.gate.hasPendingPrompt()).toBe(false)
    expect(
      mainWindow.webContents.send.mock.calls
        .slice(sendStart)
        .some(([channel]) => channel === PLUGIN_SDK_CONSENT_REQUESTED_CHANNEL)
    ).toBe(false)
  })

  it('does not let a released queued request reach the consent store after dequeue', async () => {
    const { service, parentWindow, runtime } = await setupWithLiveFirstApp()
    const pluginId = 'sandbox-recipes/first-app'
    const mount = initialMount()
    const originalPut = runtime.store.put.bind(runtime.store)
    let releaseGrantWrite!: () => void
    let grantWriteStarted!: () => void
    const grantWriteStartedPromise = new Promise<void>(resolve => {
      grantWriteStarted = resolve
    })
    const grantWriteBlocked = new Promise<void>(resolve => {
      releaseGrantWrite = resolve
    })
    let replaced = false
    let orgGrantReads = 0
    vi.spyOn(runtime.store, 'put').mockImplementation(async grant => {
      if (grant.capability === 'identity.read') {
        grantWriteStarted()
        await grantWriteBlocked
      }
      return originalPut(grant)
    })
    const originalGet = runtime.store.get.bind(runtime.store)
    vi.spyOn(runtime.store, 'get').mockImplementation(async key => {
      if (key.capability === 'org.read') {
        orgGrantReads += 1
        if (replaced) {
          throw new Error('stale queued request read after its mount was released')
        }
      }
      return originalGet(key)
    })

    const first = runtime.gate.ensure({
      envKey: 'testenv-0123456789ab',
      userId: 'user-a',
      pluginId,
      pluginTitle: 'First app',
      mount,
      capabilities: ['identity.read'],
    })
    await flushUntil(() => runtime.gate.hasPendingPrompt())
    const second = runtime.gate.ensure({
      envKey: 'testenv-0123456789ab',
      userId: 'user-a',
      pluginId,
      pluginTitle: 'First app',
      mount,
      capabilities: ['org.read'],
    })
    await flushUntil(() => orgGrantReads >= 1)
    const promptId = pendingPromptId(runtime.gate as unknown as { pending: unknown })
    expect(runtime.gate.resolvePrompt(promptId, ['identity.read'])).toBe(true)
    await grantWriteStartedPromise

    await service.openSandboxUi(openArgs('first-app', parentWindow))
    replaced = true
    releaseGrantWrite()
    const [firstOutcome, secondOutcome] = await Promise.all([first, second])

    expect(firstOutcome.granted['identity.read']).toBe(false)
    expect(secondOutcome.granted['org.read']).toBe(false)
  })

  it('deterministically replays the queued-consent replacement trace', async () => {
    type Model = {
      phase: 'idle' | 'active' | 'queued' | 'rechecking' | 'replaced' | 'settled'
    }
    type Real = {
      service: AppService
      parentWindow: FakeParentWindow
      runtime: Awaited<ReturnType<typeof setupWithLiveFirstApp>>['runtime']
      mount: ReturnType<typeof initialMount>
      first?: Promise<unknown>
      second?: Promise<unknown>
      firstPromptId?: string
      reads: number
      resolveRecheck?: () => void
      recheckStarted?: Promise<void>
      replacementView?: (typeof electronMocks.views)[number]
    }
    const { service, parentWindow, runtime } = await setupWithLiveFirstApp()
    const pluginId = 'sandbox-recipes/first-app'
    const mount = initialMount()
    let resolveRecheck!: () => void
    let recheckStarted!: () => void
    const recheckBlocked = new Promise<void>(resolve => {
      resolveRecheck = resolve
    })
    const recheckStartedPromise = new Promise<void>(resolve => {
      recheckStarted = resolve
    })
    let reads = 0
    const originalGet = runtime.store.get.bind(runtime.store)
    vi.spyOn(runtime.store, 'get').mockImplementation(async key => {
      reads += 1
      if (reads === 4) {
        recheckStarted()
        await recheckBlocked
      }
      return originalGet(key)
    })

    const model: Model = { phase: 'idle' }
    const real: Real = {
      service,
      parentWindow,
      runtime,
      mount,
      reads,
      resolveRecheck,
      recheckStarted: recheckStartedPromise,
    }
    const startActive: fc.AsyncCommand<Model, Real> = {
      check: state => state.phase === 'idle',
      run: async (state, system) => {
        system.first = system.runtime.gate.ensure({
          envKey: 'testenv-0123456789ab',
          userId: 'user-a',
          pluginId,
          pluginTitle: 'First app',
          mount: system.mount,
          capabilities: ['identity.read'],
        })
        await flushUntil(() => system.runtime.gate.hasPendingPrompt())
        system.firstPromptId = pendingPromptId(
          system.runtime.gate as unknown as { pending: unknown }
        )
        state.phase = 'active'
      },
      toString: () => 'start the active consent request',
    }
    const enqueueSecond: fc.AsyncCommand<Model, Real> = {
      check: state => state.phase === 'active',
      run: async (state, system) => {
        system.second = system.runtime.gate.ensure({
          envKey: 'testenv-0123456789ab',
          userId: 'user-a',
          pluginId,
          pluginTitle: 'First app',
          mount: system.mount,
          capabilities: ['org.read'],
        })
        await flushUntil(() => reads >= 3)
        state.phase = 'queued'
      },
      toString: () => 'queue a second consent request behind the active prompt',
    }
    const releaseActivePrompt: fc.AsyncCommand<Model, Real> = {
      check: state => state.phase === 'queued',
      run: async (state, system) => {
        expect(system.runtime.gate.resolvePrompt(system.firstPromptId!, ['identity.read'])).toBe(
          true
        )
        await system.recheckStarted
        state.phase = 'rechecking'
      },
      toString: () => 'answer the active prompt and start the queued recheck',
    }
    const replaceMount: fc.AsyncCommand<Model, Real> = {
      check: state => state.phase === 'rechecking',
      run: async (state, system) => {
        await system.service.openSandboxUi(openArgs('first-app', system.parentWindow))
        system.replacementView = electronMocks.views[1]
        state.phase = 'replaced'
      },
      toString: () => 'release and replace the plugin mount with the same plugin id',
    }
    const releaseQueuedRecheck: fc.AsyncCommand<Model, Real> = {
      check: state => state.phase === 'replaced',
      run: async (state, system) => {
        system.resolveRecheck?.()
        await Promise.all([system.first, system.second])
        const stalePrompt = system.runtime.gate.hasPendingPrompt()
        const staleHide = system.replacementView!.setVisible.mock.calls.some(
          ([visible]) => visible === false
        )
        state.phase = 'settled'
        expect({ stalePrompt, staleHide }).toEqual({ stalePrompt: false, staleHide: false })
      },
      toString: () => 'release the queued grant recheck and check replacement safety',
    }
    const sequence: fc.AsyncCommand<Model, Real>[] = [
      startActive,
      enqueueSecond,
      releaseActivePrompt,
      replaceMount,
      releaseQueuedRecheck,
    ]

    try {
      await fc.asyncModelRun(() => ({ model, real }), sequence)
      expect(model.phase).toBe('settled')
    } finally {
      resolveRecheck()
      runtime.gate.resetPlugin(pluginId)
      await Promise.allSettled([real.first, real.second].filter(Boolean) as Promise<unknown>[])
    }
  })

  it('generated release and settlement commands keep consent effects mount-bound', async () => {
    type Model = {
      started: boolean
      released: boolean
      settled: boolean
      promptsAtRelease: number | null
    }
    type Real = {
      gate: PluginConsentGate
      oldMount: PinnedPluginSurface
      replacement: PinnedPluginSurface
      scheduler: Awaited<ReturnType<typeof fc.scheduler>>
      activeMount: PinnedPluginSurface
      storeReads: number
      staleStoreReads: number
      prompts: Array<{ promptId: string }>
      hiddenWebContentsIds: number[]
      request?: Promise<unknown>
      requestSettled: boolean
    }
    const observedOrders = new Set<string>()

    const releaseMount: fc.AsyncCommand<Model, Real> = {
      check: model => model.started && !model.released,
      run: async (model, real) => {
        observedOrders.add(model.settled ? 'settle-before-release' : 'release-before-settle')
        real.activeMount = real.replacement
        real.gate.resetPlugin(real.oldMount.pluginId)
        model.released = true
        model.promptsAtRelease = real.prompts.length
      },
      toString: () => 'release the request mount and install a same-plugin replacement',
    }
    const settle: fc.AsyncCommand<Model, Real> = {
      check: model => model.started && !model.settled,
      run: async (model, real) => {
        observedOrders.add(model.released ? 'release-before-settle' : 'settle-before-release')
        for (let turn = 0; turn < 8 && !real.requestSettled; turn += 1) {
          await real.scheduler.waitAll()
          await new Promise<void>(resolve => setImmediate(resolve))
          if (real.gate.hasPendingPrompt()) {
            const prompt = real.prompts.at(-1)
            if (prompt) real.gate.resolvePrompt(prompt.promptId, [])
          }
        }
        expect(real.requestSettled).toBe(true)
        await real.request
        model.settled = true
      },
      toString: () => 'resolve scheduled store work and settle the consent request',
    }
    const generatedCommands = fc.commands([fc.constant(releaseMount), fc.constant(settle)], {
      maxCommands: 6,
      size: '+1',
    })

    await fc.assert(
      fc.asyncProperty(fc.scheduler(), generatedCommands, async (scheduler, commands) => {
        const pluginId = 'sandbox-recipes/model-app'
        const oldMount: PinnedPluginSurface = {
          pluginId,
          pluginTitle: 'Model app',
          surface: 'sandbox-ui-embed',
          webContentsId: 701,
          generation: 1,
        }
        const replacement: PinnedPluginSurface = { ...oldMount, webContentsId: 702, generation: 2 }
        const model: Model = {
          started: false,
          released: false,
          settled: false,
          promptsAtRelease: null,
        }
        const real: Real = {
          gate: undefined as unknown as PluginConsentGate,
          oldMount,
          replacement,
          scheduler,
          activeMount: oldMount,
          storeReads: 0,
          staleStoreReads: 0,
          prompts: [],
          hiddenWebContentsIds: [],
          requestSettled: false,
        }
        const store = {
          get: async () => {
            real.storeReads += 1
            if (real.activeMount !== oldMount) real.staleStoreReads += 1
            return scheduler.schedule(Promise.resolve(null), 'consent grant lookup')
          },
          put: async () => undefined,
          list: async () => [],
          touch: async () => undefined,
          revoke: async () => undefined,
          revokeAllForPlugin: async () => undefined,
        } as ConsentStore
        real.gate = new PluginConsentGate({
          store,
          isMountCurrent: mount => real.activeMount === mount,
          setSurfaceVisible: async (_visible, mount) => {
            if (real.activeMount !== mount) return false
            real.hiddenWebContentsIds.push(mount.webContentsId)
            return true
          },
          presentPrompt: request => real.prompts.push({ promptId: request.promptId }),
          cancelPrompt: () => undefined,
          isWindowReady: () => true,
          sleep: async () => undefined,
        })

        const start: fc.AsyncCommand<Model, Real> = {
          check: state => !state.started,
          run: async (state, system) => {
            system.request = system.gate.ensure({
              envKey: 'testenv-0123456789ab',
              userId: 'user-a',
              pluginId,
              pluginTitle: 'Model app',
              mount: oldMount,
              capabilities: ['identity.read'],
            })
            void system.request.then(
              () => {
                system.requestSettled = true
              },
              () => {
                system.requestSettled = true
              }
            )
            await flushUntil(() => system.storeReads >= 1)
            state.started = true
          },
          toString: () => 'start a consent request on the original mount',
        }

        const scenario = [start, ...commands, settle]
        await fc.asyncModelRun(() => ({ model, real }), scenario)
        await scheduler.waitAll()
        expect(real.requestSettled).toBe(true)
        expect(real.gate.hasPendingPrompt()).toBe(false)
        expect(real.hiddenWebContentsIds).not.toContain(replacement.webContentsId)
        expect(real.staleStoreReads).toBe(0)
        if (model.released) {
          expect(real.prompts).toHaveLength(model.promptsAtRelease)
        }
      }),
      { numRuns: 16, seed: 11062026 }
    )
    expect(observedOrders).toEqual(new Set(['release-before-settle', 'settle-before-release']))
  })

  it('does not revive a queued request released during cooldown', async () => {
    const { service, parentWindow, runtime, mainWindow, setWindowReady } =
      await setupWithLiveFirstApp()
    const pluginId = 'sandbox-recipes/first-app'
    const mount = initialMount()
    vi.spyOn(runtime.store, 'get').mockResolvedValue(null)
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const scheduled = vi.spyOn(globalThis, 'setTimeout')
    const first = runtime.gate.ensure({
      envKey: 'testenv-0123456789ab',
      userId: 'user-a',
      pluginId,
      pluginTitle: 'First app',
      mount,
      capabilities: ['identity.read'],
    })
    await flushUntil(() => runtime.gate.hasPendingPrompt())
    const second = runtime.gate.ensure({
      envKey: 'testenv-0123456789ab',
      userId: 'user-a',
      pluginId,
      pluginTitle: 'First app',
      mount,
      capabilities: ['org.read'],
    })
    await flushUntil(() => scheduled.mock.calls.length >= 1)
    const firstPromptId = pendingPromptId(runtime.gate as unknown as { pending: unknown })
    expect(runtime.gate.resolvePrompt(firstPromptId, ['identity.read'])).toBe(true)
    await flushUntil(() =>
      scheduled.mock.calls.some(([, delay]) => delay === CONSENT_PROMPT_COOLDOWN_MS)
    )

    const sendStart = mainWindow.webContents.send.mock.calls.length
    setWindowReady(false)
    await service.openSandboxUi(openArgs('first-app', parentWindow))
    const replacementView = electronMocks.views[1]!
    const replacementCallStart = replacementView.setVisible.mock.calls.length
    let secondSettled = false
    void second.then(
      () => {
        secondSettled = true
      },
      () => {
        secondSettled = true
      }
    )
    await vi.advanceTimersByTimeAsync(CONSENT_PROMPT_COOLDOWN_MS)
    const readinessWaitStarted = scheduled.mock.calls.some(([, delay]) => delay === 500)
    if (readinessWaitStarted) {
      setWindowReady(true)
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(readinessWaitStarted).toBe(false)
    await flushUntil(() => secondSettled)
    await Promise.all([first, second])

    const stalePending = runtime.gate.hasPendingPrompt()
    const stalePromptPresented = mainWindow.webContents.send.mock.calls
      .slice(sendStart)
      .some(
        ([channel, request]) =>
          channel === PLUGIN_SDK_CONSENT_REQUESTED_CHANNEL &&
          (request as { pluginId?: string })?.pluginId === pluginId
      )
    const staleHide = replacementView.setVisible.mock.calls
      .slice(replacementCallStart)
      .some(([visible]) => visible === false)
    expect({ stalePending, stalePromptPresented, staleHide }).toEqual({
      stalePending: false,
      stalePromptPresented: false,
      staleHide: false,
    })
  })

  it('does not revive a queued request released during window readiness wait', async () => {
    const { service, parentWindow, runtime, mainWindow, setWindowReady } =
      await setupWithLiveFirstApp()
    const pluginId = 'sandbox-recipes/first-app'
    const mount = initialMount()
    vi.spyOn(runtime.store, 'get').mockResolvedValue(null)
    const scheduled = vi.spyOn(globalThis, 'setTimeout')
    const first = runtime.gate.ensure({
      envKey: 'testenv-0123456789ab',
      userId: 'user-a',
      pluginId,
      pluginTitle: 'First app',
      mount,
      capabilities: ['identity.read'],
    })
    await flushUntil(() => runtime.gate.hasPendingPrompt())
    const second = runtime.gate.ensure({
      envKey: 'testenv-0123456789ab',
      userId: 'user-a',
      pluginId,
      pluginTitle: 'First app',
      mount,
      capabilities: ['org.read'],
    })
    await flushUntil(() => scheduled.mock.calls.length >= 1)
    const firstPromptId = pendingPromptId(runtime.gate as unknown as { pending: unknown })
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + CONSENT_PROMPT_COOLDOWN_MS + 1)
    setWindowReady(false)
    expect(runtime.gate.resolvePrompt(firstPromptId, ['identity.read'])).toBe(true)
    await flushUntil(() => scheduled.mock.calls.some(([, delay]) => delay === 500))

    setWindowReady(true)
    const sendStart = mainWindow.webContents.send.mock.calls.length
    await service.openSandboxUi(openArgs('first-app', parentWindow))
    const replacementView = electronMocks.views[1]!
    const hideMount = vi.spyOn(service, 'hideSandboxUiForPluginMount')
    const replacementCallStart = replacementView.setVisible.mock.calls.length
    await vi.advanceTimersByTimeAsync(500)
    await Promise.all([first, second])

    const stalePending = runtime.gate.hasPendingPrompt()
    const stalePromptPresented = mainWindow.webContents.send.mock.calls
      .slice(sendStart)
      .some(
        ([channel, request]) =>
          channel === PLUGIN_SDK_CONSENT_REQUESTED_CHANNEL &&
          (request as { pluginId?: string })?.pluginId === pluginId
      )
    const staleHide = replacementView.setVisible.mock.calls
      .slice(replacementCallStart)
      .some(([visible]) => visible === false)
    expect({ stalePending, stalePromptPresented, staleHide }).toEqual({
      stalePending: false,
      stalePromptPresented: false,
      staleHide: false,
    })
    expect(hideMount).not.toHaveBeenCalled()
  })
})
