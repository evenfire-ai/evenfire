import { vi } from 'vitest'
import { AppService } from '../../appService.js'
import { registerIpcHandlers } from '../../ipc.js'
import { wireMainWindowRendererReadiness } from '../../mainWindowReadiness.js'
import { _resetPluginSdkRuntimeForTests, initPluginSdkRuntime } from '../../pluginSdkRuntime.js'
import { _resetPluginSurfacesForTests } from '../../pluginSurfaceRegistry.js'
import { unmountSandboxUiView } from '../../sandboxUiDriver.js'
import { _resetSandboxUiRefreshForTests } from '../../sandboxUiSessionRefresh.js'
import { FakeParentWindow, type FakeWebContents, electronMocks } from './sandboxUiElectronFakes.js'

// The REAL sandbox-ui main process — AppService lifecycle queue, sandbox-ui
// driver, session refresh and the `sandboxUi:*` IPC handlers of ipc.ts —
// standing on the Electron fakes. Only the Electron runtime, rpc-proxy's HTTP
// answers and the RPC-token issuer are fake, so every `released`, open outcome
// and location a suite sees is the one the app produces.
//
// A suite that uses it must mock, in its own file, `electron` with
// `sandboxUiElectronFakes` and config / sandboxUiPartitionGc / rpcTokenManager /
// authClient / tokenStore with `sandboxUiMainModuleMocks`, and stub the global
// `fetch` with `sandboxUiMintFetch`.

export type RealMainOptions = {
  /** Plugin SDK state directory; the suite owns it. */
  userDataDir: string
  /** rpc-proxy's answer to a session mint for `recipeNs/recipeName`. */
  mint(recipeName: string, recipeNs: string): Response | Promise<Response>
  /** Everything main sends to the window the embed lives in. */
  onSend(channel: string, payload: unknown): void
  /** Main's authoritative App-link queue reset and renderer notification. */
  onSessionInvalidated?: () => void
  /** Every document load the driver starts; unset, a load never commits. */
  onLoad?(webContents: FakeWebContents, url: string): void
}

export type RealMain = {
  readonly service: AppService
  readonly parent: FakeParentWindow
  readonly sender: { id: number }
  readonly mainWebContents: FakeMainWebContents
  /** True once the main process was reset; nothing it does reaches the suite any more. */
  readonly dead: boolean
  /** Calls the real IPC handler of `channel` as the trusted renderer would. */
  invoke(channel: string, payload: unknown): Promise<unknown>
  /** What a logout or a login over the live session does to the embed. */
  invalidateSession(): void
}

// rpc-proxy's mint contract: 204 + a Path-scoped Set-Cookie on success, any
// other status with a text body on failure.
export function mintOk(recipeName: string, recipeNs = 'sandbox-recipes'): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'set-cookie':
        `clerum_sandbox_ui_session=tok-${recipeName}; ` +
        `Path=/api/v1/sandbox-ui/${recipeNs}/${recipeName}/; HttpOnly`,
    },
  })
}

export class FakeMainWebContents {
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  reload = vi.fn()

  on(event: string, handler: (...args: unknown[]) => void): this {
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

type LiveMain = RealMain & { dead: boolean; options: RealMainOptions }

let current: LiveMain | null = null

export const sandboxUiMintFetch = vi.fn(
  async (input: string | URL | Request): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input)
    const match = /\/api\/v1\/sandbox-ui\/([^/]+)\/([^/]+)\/session$/.exec(url)
    if (!match) throw new Error(`unexpected fetch ${url}`)
    if (!current) throw new Error('mint with no main process running')
    return current.options.mint(decodeURIComponent(match[2]!), decodeURIComponent(match[1]!))
  }
)

/** Tears the running main process down; await it before starting the next one. */
export async function resetRealMain(): Promise<void> {
  if (current) current.dead = true
  current = null
  electronMocks.onLoadURL = null
  await unmountSandboxUiView()
  _resetSandboxUiRefreshForTests()
  _resetPluginSurfacesForTests()
  _resetPluginSdkRuntimeForTests()
  electronMocks.views.length = 0
}

/** Starts a main process with one trusted window. The previous one must have been reset. */
export function startRealMain(options: RealMainOptions): RealMain {
  if (current) throw new Error('a main process is already running: await resetRealMain() first')
  const service = new AppService({
    onSandboxUiSessionInvalidated: () => options.onSessionInvalidated?.(),
  })
  ;(service as unknown as { sessionToken: string }).sessionToken = 'fake-session-token'
  const parent = new FakeParentWindow()
  const sender = { id: 1 }
  const mainWebContents = new FakeMainWebContents()
  const main: LiveMain = {
    service,
    parent,
    sender,
    mainWebContents,
    dead: false,
    options,
    invoke(channel, payload) {
      const handler = electronMocks.ipcHandlers.get(channel)
      if (!handler) return Promise.reject(new Error(`no IPC handler for ${channel}`))
      try {
        return handler({ sender, senderFrame: { url: 'file:///app/index.html' } }, payload)
      } catch (error) {
        return Promise.reject(error)
      }
    },
    invalidateSession() {
      ;(service as unknown as { invalidateSandboxUiSession(): void }).invalidateSandboxUiSession()
    },
  }
  initPluginSdkRuntime({ service, getMainWindow: () => null, userDataDir: options.userDataDir })
  electronMocks.ipcHandlers.clear()
  electronMocks.windowsBySender.clear()
  registerIpcHandlers(service, () => service.logout())
  electronMocks.windowsBySender.set(sender, parent)
  parent.webContents.send.mockImplementation((channel: string, payload: unknown) => {
    if (!main.dead) options.onSend(channel, payload)
  })
  wireMainWindowRendererReadiness({
    webContents: mainWebContents as never,
    isCurrentWindow: () => true,
    markNotReady: () => {},
    sandboxUi: service,
  })
  electronMocks.onLoadURL = (webContents, url) => {
    if (!main.dead) options.onLoad?.(webContents, url)
  }
  current = main
  return main
}
