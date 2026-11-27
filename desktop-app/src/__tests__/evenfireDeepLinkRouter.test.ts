import { describe, expect, it, vi } from 'vitest'
import { buildGfsResourceDeepLink } from '@clerum/desktop-app-links'
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

type HarnessOptions = {
  onPendingUrlDropped?: (host: string) => void
}

function createHarness(harnessOptions: HarnessOptions = {}) {
  const sent: SentMessage[] = []
  let currentWindow: TestWindow | null = createWindow('initial', sent)
  let rendererReady = false
  const focusWindow = vi.fn()
  const requestMainWindow = vi.fn()
  const logout = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const handleSandboxUiDeepLink = vi.fn<(rawUrl: string) => boolean>().mockReturnValue(true)
  const handleGfsResourceDeepLink = vi.fn<(rawUrl: string) => boolean>().mockReturnValue(true)
  const router = createEvenfireDeepLinkRouter<TestWindow>({
    appProtocol: 'evenfire',
    focusMainWindow: focusWindow,
    getWindow: () => currentWindow,
    isRendererReady: () => rendererReady,
    logout,
    onPendingUrlDropped: harnessOptions.onPendingUrlDropped,
    requestMainWindow,
    routes: {
      app: handleSandboxUiDeepLink,
      files: handleGfsResourceDeepLink,
    },
  })

  return {
    currentWindow: () => currentWindow,
    focusWindow,
    handleSandboxUiDeepLink,
    handleGfsResourceDeepLink,
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
  }
}

describe('evenfire deep-link router', () => {
  it('dispatches supported hostnames to their observable actions', async () => {
    const harness = createHarness()
    harness.setRendererReady(true)

    harness.router.handle('evenfire://app/evenfire/example?path=%2Finbox&team=team-1')
    expect(harness.handleSandboxUiDeepLink).toHaveBeenCalledWith(
      'evenfire://app/evenfire/example?path=%2Finbox&team=team-1'
    )

    const resourceLink = buildGfsResourceDeepLink('gfs://main/0123456789abcdef0123456789abcdef')
    harness.router.handle(resourceLink)
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

  // `evenfire:` is not a special URL scheme, so `URL` keeps the host's original case.
  it('matches hosts case-insensitively for caller routes and its own routes', () => {
    const harness = createHarness()
    harness.setRendererReady(true)

    harness.router.handle('evenfire://APP/evenfire/example')
    expect(harness.handleSandboxUiDeepLink).toHaveBeenCalledWith('evenfire://APP/evenfire/example')

    harness.router.handle('evenfire://Files?uri=x')
    expect(harness.handleGfsResourceDeepLink).toHaveBeenCalledWith('evenfire://Files?uri=x')

    harness.router.handle(
      'evenfire://Desktop-Setup?email=user%40example.test&authorizationToken=token-1'
    )
    expect(harness.sent).toEqual([
      {
        channel: 'auth:desktopSetupToken',
        payload: { authorizationToken: 'token-1', email: 'user@example.test' },
        window: 'initial',
      },
    ])

    const mixedCaseRoute = vi.fn()
    const router = createEvenfireDeepLinkRouter<TestWindow>({
      appProtocol: 'evenfire',
      focusMainWindow: vi.fn(),
      getWindow: () => null,
      isRendererReady: () => true,
      logout: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      requestMainWindow: vi.fn(),
      routes: { App: mixedCaseRoute },
    })
    router.handle('evenfire://app/evenfire/example')
    expect(mixedCaseRoute).toHaveBeenCalledWith('evenfire://app/evenfire/example')
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

  it('fails closed for unsupported or malformed links and leaves app-link validation to its handler', () => {
    const harness = createHarness()
    harness.setRendererReady(true)
    harness.handleSandboxUiDeepLink.mockReturnValue(false)
    const rejectedAppLink = 'evenfire://app/evenfire/example?path=%2Fsafe%2F..%2Fadmin'

    harness.router.handle('not a url')
    harness.router.handle(
      'clerum://desktop-setup?email=user%40example.test&authorizationToken=token'
    )
    harness.router.handle('evenfire://unknown?email=user%40example.test&authorizationToken=token')
    harness.router.handle(rejectedAppLink)

    expect(harness.handleSandboxUiDeepLink.mock.calls).toEqual([[rejectedAppLink]])
    expect(harness.handleGfsResourceDeepLink).not.toHaveBeenCalled()
    expect(harness.sent).toEqual([])
    expect(harness.focusWindow).not.toHaveBeenCalled()
    expect(harness.requestMainWindow).not.toHaveBeenCalled()
    expect(harness.logout).not.toHaveBeenCalled()
  })

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'treats the Object.prototype name %s as an unknown host',
    host => {
      const harness = createHarness()

      expect(() => harness.router.handle(`evenfire://${host}`)).not.toThrow()
      expect(() =>
        harness.router.handle(`evenfire://${host}?email=a%40example.test&authorizationToken=t`)
      ).not.toThrow()
      harness.setRendererReady(true)
      harness.router.drainPending()

      expect(harness.handleSandboxUiDeepLink).not.toHaveBeenCalled()
      expect(harness.handleGfsResourceDeepLink).not.toHaveBeenCalled()
      expect(harness.logout).not.toHaveBeenCalled()
      expect(harness.sent).toEqual([])
      expect(harness.focusWindow).not.toHaveBeenCalled()
      expect(harness.requestMainWindow).not.toHaveBeenCalled()
    }
  )

  it('reports only the host of a pending link evicted by the queue cap', () => {
    const onPendingUrlDropped = vi.fn<(host: string) => void>()
    const harness = createHarness({ onPendingUrlDropped })
    const links = Array.from(
      { length: 21 },
      (_, index) =>
        `evenfire://desktop-setup?email=user${index}%40example.test&authorizationToken=secret-${index}`
    )

    links.forEach(link => harness.router.handle(link))

    expect(onPendingUrlDropped.mock.calls).toEqual([['desktop-setup']])
    expect(JSON.stringify(onPendingUrlDropped.mock.calls)).not.toContain('authorizationToken')
    expect(JSON.stringify(onPendingUrlDropped.mock.calls)).not.toContain('secret-')
    harness.setRendererReady(true)
    harness.router.drainPending()
    expect(harness.sent.map(message => message.payload)).toEqual(
      links.slice(1).map((_, index) => ({
        authorizationToken: `secret-${index + 1}`,
        email: `user${index + 1}@example.test`,
      }))
    )
  })

  it('keeps the 20 newest pending links when the eviction reporter throws', () => {
    const onPendingUrlDropped = vi.fn<(host: string) => void>(() => {
      throw new Error('reporter failed')
    })
    const harness = createHarness({ onPendingUrlDropped })
    const links = Array.from(
      { length: 21 },
      (_, index) =>
        `evenfire://desktop-setup?email=user${index}%40example.test&authorizationToken=secret-${index}`
    )

    links.slice(0, 20).forEach(link => harness.router.handle(link))
    expect(() => harness.router.handle(links[20]!)).not.toThrow()
    expect(() => harness.router.enqueuePending('not a url')).not.toThrow()

    expect(onPendingUrlDropped.mock.calls).toEqual([['desktop-setup'], ['desktop-setup']])
    expect(harness.requestMainWindow).toHaveBeenCalledTimes(21)
    harness.setRendererReady(true)
    harness.router.drainPending()
    expect(harness.sent.map(message => message.payload)).toEqual(
      links.slice(2).map((_, index) => ({
        authorizationToken: `secret-${index + 2}`,
        email: `user${index + 2}@example.test`,
      }))
    )
  })

  it('evicts the oldest pending link before reporting it, so a re-entrant drain never delivers it', () => {
    let drainFromReporter = () => {}
    const harness = createHarness({ onPendingUrlDropped: () => drainFromReporter() })
    drainFromReporter = () => harness.router.drainPending()
    harness.setRendererReady(true)
    const links = Array.from(
      { length: 21 },
      (_, index) =>
        `evenfire://desktop-setup?email=user${index}%40example.test&authorizationToken=secret-${index}`
    )

    links.forEach(link => harness.router.enqueuePending(link))

    expect(harness.sent.map(message => message.payload)).toEqual(
      links.slice(1).map((_, index) => ({
        authorizationToken: `secret-${index + 1}`,
        email: `user${index + 1}@example.test`,
      }))
    )
  })

  it('reports an unparseable evicted startup argument as an unknown host', () => {
    const onPendingUrlDropped = vi.fn<(host: string) => void>()
    const harness = createHarness({ onPendingUrlDropped })

    harness.router.enqueuePending('not a url')
    for (let index = 0; index < 20; index += 1) {
      harness.router.enqueuePending(`evenfire://logout?n=${index}`)
    }

    expect(onPendingUrlDropped.mock.calls).toEqual([['unknown']])
  })

  it.each([
    ['a caller route and a built-in route', { LOGOUT: () => {} }, 'logout'],
    ['a caller route and the setup route', { 'desktop-setup': () => {} }, 'desktop-setup'],
    ['two caller routes that differ only in case', { App: () => {}, app: () => {} }, 'app'],
  ])('throws at construction on a host collision between %s', (_label, routes, host) => {
    expect(() =>
      createEvenfireDeepLinkRouter({
        appProtocol: 'evenfire',
        focusMainWindow: () => {},
        getWindow: () => null,
        isRendererReady: () => false,
        logout: () => Promise.resolve(),
        requestMainWindow: () => {},
        routes,
      })
    ).toThrow(`Duplicate evenfire deep-link route for host "${host}"`)
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
})
