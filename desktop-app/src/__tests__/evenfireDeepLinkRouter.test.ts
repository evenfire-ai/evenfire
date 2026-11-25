import { describe, expect, it, vi } from 'vitest'
import { buildGfsResourceDeepLink } from '@clerum/desktop-app-links'
import { buildDesktopLoginCodeLink } from '../browserSignInModel.js'
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

// PR 2's builder writes the link the Profile UI sends to end a Desktop sign-in.
const DESKTOP_LOGIN_LINK = buildDesktopLoginCodeLink({
  state: 'fake-desktop-login-state-'.padEnd(43, 's'),
  code: 'fake-desktop-login-code-'.padEnd(43, 'c'),
  environment: 'https://api-link.example.test',
})
// PR 2's builder writes only the lower-case host, so these are raw strings. `URL` keeps an app
// link's host in its letter case.
const DESKTOP_LOGIN_QUERY = new URL(DESKTOP_LOGIN_LINK).search
const MIXED_CASE_DESKTOP_LOGIN_LINK = `evenfire://Desktop-Login${DESKTOP_LOGIN_QUERY}`
const UPPER_CASE_DESKTOP_LOGIN_LINK = `evenfire://DESKTOP-LOGIN${DESKTOP_LOGIN_QUERY}`
const CONSOLE_METHODS = ['debug', 'error', 'info', 'log', 'warn'] as const
const DESKTOP_SETUP_LINK =
  'evenfire://desktop-setup?email=user%40example.test&authorizationToken=fake-setup-token'
const DESKTOP_SETUP_MESSAGE = {
  channel: 'auth:desktopSetupToken',
  payload: { authorizationToken: 'fake-setup-token', email: 'user@example.test' },
  window: 'initial',
}

function createHarness(options: { maxPendingUrls?: number } = {}) {
  const sent: SentMessage[] = []
  let currentWindow: TestWindow | null = createWindow('initial', sent)
  let rendererReady = false
  const focusWindow = vi.fn()
  const requestMainWindow = vi.fn()
  const logout = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const handleSandboxUiDeepLink = vi.fn<(rawUrl: string) => boolean>().mockReturnValue(true)
  const handleGfsResourceDeepLink = vi.fn<(rawUrl: string) => boolean>().mockReturnValue(true)
  const handleDesktopLoginLink = vi.fn<(rawUrl: string) => void>()
  const shouldAcceptSandboxUiProtocolLink = vi
    .fn<(rawUrl: string) => boolean>()
    .mockReturnValue(true)
  const shouldAcceptGfsResourceProtocolLink = vi
    .fn<(rawUrl: string) => boolean>()
    .mockReturnValue(true)
  const router = createEvenfireDeepLinkRouter<TestWindow>({
    appProtocol: 'evenfire',
    sandboxUiDeepLinkHost: 'app',
    gfsResourceDeepLinkHost: 'files',
    focusMainWindow: focusWindow,
    getWindow: () => currentWindow,
    handleSandboxUiDeepLink,
    handleGfsResourceDeepLink,
    handleDesktopLoginLink,
    isRendererReady: () => rendererReady,
    logout,
    maxPendingUrls: options.maxPendingUrls,
    requestMainWindow,
    shouldAcceptSandboxUiProtocolLink,
    shouldAcceptGfsResourceProtocolLink,
  })

  return {
    currentWindow: () => currentWindow,
    focusWindow,
    handleSandboxUiDeepLink,
    handleGfsResourceDeepLink,
    handleDesktopLoginLink,
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
    shouldAcceptGfsResourceProtocolLink,
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

    const resourceLink = buildGfsResourceDeepLink('gfs://main/0123456789abcdef0123456789abcdef')
    harness.router.handle(resourceLink)
    expect(harness.shouldAcceptGfsResourceProtocolLink).toHaveBeenCalledWith(resourceLink)
    expect(harness.handleGfsResourceDeepLink).toHaveBeenCalledWith(resourceLink)

    harness.router.handle(
      'evenfire://desktop-environment?externalRestApiBaseUrl=https%3A%2F%2Fapi.example.test&rpcProxyBaseUrl=https%3A%2F%2Frpc.example.test&tenantName=Acme'
    )
    harness.router.handle(
      'evenfire://desktop-setup?email=user%40example.test&authorizationToken=token-1'
    )
    harness.router.handle('evenfire://logout')
    await Promise.resolve()

    expect(harness.sent).toEqual([
      {
        channel: 'auth:desktopEnvironmentSetup',
        payload: {
          appName: 'Acme',
          externalRestApiBaseUrl: 'https://api.example.test',
        },
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
        payload: {
          appName: 'Env',
          externalRestApiBaseUrl: 'https://api.example.test',
        },
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
        payload: {
          appName: 'Second',
          externalRestApiBaseUrl: 'https://api.example.test',
        },
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

  it('drops setup and environment links with missing or empty required parameters', () => {
    const harness = createHarness()
    harness.setRendererReady(true)

    harness.router.handle('evenfire://desktop-environment')
    harness.router.handle('evenfire://desktop-environment?externalRestApiBaseUrl=')
    harness.router.handle('evenfire://desktop-setup?authorizationToken=token-1')
    harness.router.handle('evenfire://desktop-setup?email=user%40example.test')
    harness.router.handle('evenfire://desktop-setup?email=&authorizationToken=token-1')
    harness.router.handle('evenfire://desktop-setup?email=user%40example.test&authorizationToken=')

    expect(harness.sent).toEqual([])
    expect(harness.focusWindow).not.toHaveBeenCalled()
    expect(harness.requestMainWindow).not.toHaveBeenCalled()
  })

  describe('tier 0 baseline', () => {
    it('T0-4 sends nothing and requests no window for a desktop-login link', () => {
      const harness = createHarness()
      expect(new URL(DESKTOP_LOGIN_LINK).hostname).toBe('desktop-login')

      harness.router.handle(DESKTOP_LOGIN_LINK)
      expect(harness.requestMainWindow).not.toHaveBeenCalled()
      harness.setRendererReady(true)
      harness.router.handle(DESKTOP_LOGIN_LINK)
      expect(harness.sent).toEqual([])
      expect(harness.focusWindow).not.toHaveBeenCalled()
      expect(harness.requestMainWindow).not.toHaveBeenCalled()

      // The same router sends a desktop-setup link to the ready window.
      harness.router.handle(DESKTOP_SETUP_LINK)
      expect(harness.sent).toEqual([DESKTOP_SETUP_MESSAGE])
      expect(harness.focusWindow).toHaveBeenCalledOnce()
      expect(harness.requestMainWindow).not.toHaveBeenCalled()
    })
  })

  // D8: a desktop-login link carries a code. The router hands it to main and never sends, focuses,
  // queues or logs it.
  describe('desktop-login hand-off', () => {
    it('G2-8a hands a desktop-login link to main and nothing else', () => {
      const harness = createHarness()
      const logs = CONSOLE_METHODS.map(method =>
        vi.spyOn(console, method).mockImplementation(() => undefined)
      )
      try {
        harness.router.handle(DESKTOP_LOGIN_LINK)
        expect(harness.handleDesktopLoginLink.mock.calls).toEqual([[DESKTOP_LOGIN_LINK]])
        // Not queued: a drain once the renderer is ready hands nothing over again.
        harness.setRendererReady(true)
        harness.router.drainPending()
        expect(harness.handleDesktopLoginLink).toHaveBeenCalledOnce()

        // The host is matched in any letter case, as every other host is.
        harness.router.handle(MIXED_CASE_DESKTOP_LOGIN_LINK)
        expect(harness.handleDesktopLoginLink.mock.calls).toEqual([
          [DESKTOP_LOGIN_LINK],
          [MIXED_CASE_DESKTOP_LOGIN_LINK],
        ])

        expect(harness.sent).toEqual([])
        expect(harness.focusWindow).not.toHaveBeenCalled()
        expect(harness.requestMainWindow).not.toHaveBeenCalled()
        for (const log of logs) expect(log).not.toHaveBeenCalled()
      } finally {
        for (const log of logs) log.mockRestore()
      }
    })

    // A3-31, observed through eviction (G1-m9): a desktop-login link given to `enqueuePending`
    // must not take the slot of a queued setup link. At c479968f0 it did
    // (`evenfireDeepLinkRouter.ts:47-53`); this was T0-3. The upper-case row needs
    // `enqueuePending` to classify the host as `handle` does.
    it.each([
      ['the built link', DESKTOP_LOGIN_LINK],
      ['an upper-case host', UPPER_CASE_DESKTOP_LOGIN_LINK],
    ])(
      'G2-8b keeps a queued desktop-setup link when a desktop-login link (%s) is enqueued after it',
      (_label, desktopLoginLink) => {
        const harness = createHarness({ maxPendingUrls: 1 })

        harness.router.enqueuePending(DESKTOP_SETUP_LINK)
        harness.router.enqueuePending(desktopLoginLink)
        harness.setRendererReady(true)
        harness.router.drainPending()

        expect(harness.sent).toEqual([DESKTOP_SETUP_MESSAGE])
        expect(harness.handleDesktopLoginLink).not.toHaveBeenCalled()
      }
    )
  })
})
