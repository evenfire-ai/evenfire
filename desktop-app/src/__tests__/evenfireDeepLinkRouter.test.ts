import { describe, expect, it, vi } from 'vitest'
import { createEvenfireDeepLinkRouter } from '../evenfireDeepLinkRouter.js'

type SentMessage = {
  channel: string
  payload?: unknown
  window: string
}

type TestWindow = {
  id: string
  destroyed: boolean
  isDestroyed: () => boolean
  webContents: {
    send: (channel: string, payload?: unknown) => void
  }
}

function createWindow(id: string, sent: SentMessage[]): TestWindow {
  const window: TestWindow = {
    id,
    destroyed: false,
    isDestroyed: () => window.destroyed,
    webContents: {
      send: (channel, payload) => {
        sent.push({ channel, payload, window: id })
      },
    },
  }
  return window
}

function createHarness() {
  const sent: SentMessage[] = []
  let currentWindow: TestWindow | null = createWindow('initial', sent)
  let rendererReady = false
  const focusWindow = vi.fn()
  const requestMainWindow = vi.fn()
  const logout = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const handleSandboxUiDeepLink = vi.fn<(rawUrl: string) => boolean>().mockReturnValue(true)
  const shouldAcceptSandboxUiProtocolLink = vi
    .fn<(rawUrl: string) => boolean>()
    .mockReturnValue(true)
  const router = createEvenfireDeepLinkRouter<TestWindow>({
    appProtocol: 'evenfire',
    sandboxUiDeepLinkHost: 'app',
    focusMainWindow: focusWindow,
    getWindow: () => currentWindow,
    handleSandboxUiDeepLink,
    isRendererReady: () => rendererReady,
    logout,
    requestMainWindow,
    shouldAcceptSandboxUiProtocolLink,
  })

  return {
    currentWindow: () => currentWindow,
    focusWindow,
    handleSandboxUiDeepLink,
    logout,
    requestMainWindow,
    router,
    sent,
    setRendererReady: (ready: boolean) => {
      rendererReady = ready
    },
    replaceWindow: (id: string) => {
      currentWindow = createWindow(id, sent)
    },
    setWindow: (window: TestWindow | null) => {
      currentWindow = window
    },
    shouldAcceptSandboxUiProtocolLink,
  }
}

describe('evenfire deep-link router', () => {
  it('dispatches supported hostnames to their observable actions', async () => {
    const harness = createHarness()
    harness.setRendererReady(true)

    harness.router.handle('evenfire://app/evenfire/example?path=%2Finbox&team=team-1')
    expect(harness.shouldAcceptSandboxUiProtocolLink).toHaveBeenCalledWith(
      'evenfire://app/evenfire/example?path=%2Finbox&team=team-1'
    )
    expect(harness.handleSandboxUiDeepLink).toHaveBeenCalledWith(
      'evenfire://app/evenfire/example?path=%2Finbox&team=team-1'
    )

    harness.router.handle(
      'evenfire://desktop-environment?externalRestApiBaseUrl=https%3A%2F%2Fapi.example.test&tenantName=Acme'
    )
    harness.router.handle(
      'evenfire://desktop-setup?email=user%40example.test&authorizationToken=token-1'
    )
    harness.router.handle('evenfire://logout')
    await Promise.resolve()

    expect(harness.sent).toEqual([
      {
        channel: 'auth:desktopEnvironmentSetup',
        payload: { appName: 'Acme', externalRestApiBaseUrl: 'https://api.example.test' },
        window: 'initial',
      },
      {
        channel: 'auth:desktopSetupToken',
        payload: { authorizationToken: 'token-1', email: 'user@example.test' },
        window: 'initial',
      },
      { channel: 'auth:externalLogout', payload: undefined, window: 'initial' },
    ])
    expect(harness.focusWindow).toHaveBeenCalledTimes(3)
    expect(harness.logout).toHaveBeenCalledOnce()
    expect(harness.requestMainWindow).not.toHaveBeenCalled()
  })

  it('enqueues setup and environment links until the renderer is ready, then drains in order once', () => {
    const harness = createHarness()

    harness.router.handle(
      'evenfire://desktop-setup?email=one%40example.test&authorizationToken=token-1'
    )
    harness.router.handle(
      'evenfire://desktop-environment?externalRestApiBaseUrl=https%3A%2F%2Fapi.example.test&appName=Env'
    )
    harness.router.handle(
      'evenfire://desktop-setup?email=one%40example.test&authorizationToken=token-1'
    )
    expect(harness.sent).toEqual([])
    expect(harness.requestMainWindow).toHaveBeenCalledTimes(3)

    harness.setRendererReady(true)
    harness.router.drainPending()
    harness.router.drainPending()

    expect(harness.sent).toEqual([
      {
        channel: 'auth:desktopSetupToken',
        payload: { authorizationToken: 'token-1', email: 'one@example.test' },
        window: 'initial',
      },
      {
        channel: 'auth:desktopEnvironmentSetup',
        payload: { appName: 'Env', externalRestApiBaseUrl: 'https://api.example.test' },
        window: 'initial',
      },
    ])
    expect(harness.focusWindow).toHaveBeenCalledTimes(2)
  })

  it('uses the same queue for startup links, second-instance links, and recreated windows', () => {
    const harness = createHarness()

    harness.router.enqueuePending(
      'evenfire://desktop-setup?email=startup%40example.test&authorizationToken=startup-token'
    )
    harness.router.handle(
      'evenfire://desktop-environment?externalRestApiBaseUrl=https%3A%2F%2Fapi.example.test&appName=Second'
    )
    harness.replaceWindow('recreated')
    harness.setRendererReady(true)
    harness.router.drainPending()
    harness.router.handle(
      'evenfire://desktop-setup?email=ready%40example.test&authorizationToken=ready-token'
    )

    expect(harness.sent).toEqual([
      {
        channel: 'auth:desktopSetupToken',
        payload: { authorizationToken: 'startup-token', email: 'startup@example.test' },
        window: 'recreated',
      },
      {
        channel: 'auth:desktopEnvironmentSetup',
        payload: { appName: 'Second', externalRestApiBaseUrl: 'https://api.example.test' },
        window: 'recreated',
      },
      {
        channel: 'auth:desktopSetupToken',
        payload: { authorizationToken: 'ready-token', email: 'ready@example.test' },
        window: 'recreated',
      },
    ])
    expect(harness.requestMainWindow).toHaveBeenCalledOnce()
  })

  it('fails closed for unsupported, malformed, or rejected app links', () => {
    const harness = createHarness()
    harness.setRendererReady(true)
    harness.shouldAcceptSandboxUiProtocolLink.mockReturnValue(false)

    harness.router.handle('not a url')
    harness.router.handle(
      'clerum://desktop-setup?email=user%40example.test&authorizationToken=token'
    )
    harness.router.handle('evenfire://unknown?email=user%40example.test&authorizationToken=token')
    harness.router.handle('evenfire://app/evenfire/example?path=%2Finbox')

    expect(harness.sent).toEqual([])
    expect(harness.focusWindow).not.toHaveBeenCalled()
    expect(harness.requestMainWindow).not.toHaveBeenCalled()
    expect(harness.handleSandboxUiDeepLink).not.toHaveBeenCalled()
  })
})
