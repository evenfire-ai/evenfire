import { afterEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  postDesktopSession: vi.fn(),
  cookieSet: vi.fn(),
  cookieRemove: vi.fn(),
  browserWindowCreated: 0,
  browserWindowVisible: false,
  browserWindowClosed: false,
  browserWindowDestroyed: false,
  browserWindowDestroyedCount: 0,
  readyToShow: undefined as (() => void) | undefined,
  closed: undefined as (() => void) | undefined,
  loadUrl: undefined as (() => Promise<void>) | undefined,
}))

vi.mock('electron', () => ({
  BrowserWindow: class {
    private destroyed = false
    private visible = false
    private closedListener?: () => void

    constructor() {
      fixture.browserWindowCreated += 1
    }

    isDestroyed() {
      return this.destroyed
    }

    isVisible() {
      return this.visible
    }

    focus() {}

    maximize() {}

    show() {
      fixture.browserWindowVisible = true
      this.visible = true
    }

    close() {
      this.destroyed = true
      fixture.browserWindowClosed = true
      this.closedListener?.()
    }

    destroy() {
      this.destroyed = true
      fixture.browserWindowClosed = true
      fixture.browserWindowDestroyed = true
      fixture.browserWindowDestroyedCount += 1
      this.closedListener?.()
    }

    on(event: string, listener: () => void) {
      if (event === 'closed') {
        this.closedListener = listener
        fixture.closed = listener
      }
    }

    once(event: string, listener: () => void) {
      if (event === 'ready-to-show') fixture.readyToShow = listener
    }

    loadURL() {
      return fixture.loadUrl?.() ?? Promise.resolve()
    }
  },
  session: {
    fromPartition: vi.fn(() => ({
      cookies: {
        set: fixture.cookieSet,
        remove: fixture.cookieRemove,
      },
    })),
  },
}))

vi.mock('../rpcProxyClient.js', () => ({
  RpcProxyClient: class {
    postDesktopSession(...args: unknown[]) {
      return fixture.postDesktopSession(...args)
    }
  },
}))

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  fixture.browserWindowCreated = 0
  fixture.browserWindowVisible = false
  fixture.browserWindowClosed = false
  fixture.browserWindowDestroyed = false
  fixture.browserWindowDestroyedCount = 0
  fixture.readyToShow = undefined
  fixture.closed = undefined
  fixture.loadUrl = undefined
})

describe('desktop window session ownership', () => {
  const ownerContext = Object.freeze({ owner: 'session-a' })
  const ownerArgs = (requestOwnerContext = ownerContext) => ({
    requestOwnerContext,
    sessionRequestContextsMatchOwner: (left: unknown, right: unknown) => left === right,
  })

  it('checks ownership after the session exchange and before installing its cookie', async () => {
    const exchange = deferred<{ setCookie: string }>()
    fixture.postDesktopSession.mockReturnValue(exchange.promise)
    const { openDesktopWindow } = await import('../desktopWindow.js')
    let ownerIsCurrent = true
    const assertRequestOwnerCurrent = vi.fn(() => {
      if (!ownerIsCurrent) throw new Error('stale request owner')
    })

    const opening = openDesktopWindow({
      hostRef: 'owned-window-session-exchange',
      jwt: 'rpc-bearer',
      rpcProxyUrl: 'https://rpc.example.test',
      ...ownerArgs(),
      assertRequestOwnerCurrent,
    })
    await vi.waitFor(() => expect(fixture.postDesktopSession).toHaveBeenCalledOnce())
    ownerIsCurrent = false
    exchange.resolve({
      setCookie: 'clerum_desktop_session=stale-session; Path=/; HttpOnly',
    })

    await expect(opening).rejects.toThrow('stale request owner')
    expect(assertRequestOwnerCurrent).toHaveBeenCalledTimes(2)
    expect(fixture.cookieSet).not.toHaveBeenCalled()
    expect(fixture.cookieRemove).not.toHaveBeenCalled()
    expect(fixture.browserWindowCreated).toBe(0)
  })

  it('removes the cookie if ownership ends while cookie installation is pending', async () => {
    const cookieInstall = deferred<void>()
    fixture.postDesktopSession.mockResolvedValue({
      setCookie: 'clerum_desktop_session=stale-session; Path=/; HttpOnly',
    })
    fixture.cookieSet.mockReturnValue(cookieInstall.promise)
    fixture.cookieRemove.mockResolvedValue(undefined)
    const { openDesktopWindow } = await import('../desktopWindow.js')
    let ownerIsCurrent = true
    const assertRequestOwnerCurrent = vi.fn(() => {
      if (!ownerIsCurrent) throw new Error('stale request owner')
    })

    const opening = openDesktopWindow({
      hostRef: 'owned-window-cookie-install',
      jwt: 'rpc-bearer',
      rpcProxyUrl: 'https://rpc.example.test',
      ...ownerArgs(),
      assertRequestOwnerCurrent,
    })
    await vi.waitFor(() => expect(fixture.cookieSet).toHaveBeenCalledOnce())
    ownerIsCurrent = false
    cookieInstall.resolve()

    await expect(opening).rejects.toThrow('stale request owner')
    expect(fixture.cookieRemove).toHaveBeenCalledWith(
      'https://rpc.example.test/api/v1/desktop/owned-window-cookie-install',
      'clerum_desktop_session'
    )
    expect(fixture.browserWindowCreated).toBe(0)
  })

  it('does not show or retain a window when ownership ends before ready-to-show', async () => {
    const loading = deferred<void>()
    fixture.postDesktopSession.mockResolvedValue({
      setCookie: 'clerum_desktop_session=stale-session; Path=/; HttpOnly',
    })
    fixture.cookieSet.mockResolvedValue(undefined)
    fixture.cookieRemove.mockResolvedValue(undefined)
    fixture.loadUrl = vi.fn(() => loading.promise)
    const { openDesktopWindow } = await import('../desktopWindow.js')
    let ownerIsCurrent = true
    const onClose = vi.fn()
    const assertRequestOwnerCurrent = vi.fn(() => {
      if (!ownerIsCurrent) throw new Error('stale request owner')
    })

    const opening = openDesktopWindow({
      hostRef: 'owned-window-ready-to-show',
      jwt: 'rpc-bearer',
      rpcProxyUrl: 'https://rpc.example.test',
      ...ownerArgs(),
      assertRequestOwnerCurrent,
      onClose,
    })
    await vi.waitFor(() => expect(fixture.loadUrl).toHaveBeenCalledOnce())
    ownerIsCurrent = false
    fixture.readyToShow?.()
    await vi.waitFor(() => expect(fixture.cookieRemove).toHaveBeenCalledOnce())

    expect(fixture.browserWindowVisible).toBe(false)
    expect(fixture.browserWindowClosed).toBe(true)
    expect(fixture.browserWindowDestroyed).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    loading.resolve()

    await expect(opening).rejects.toThrow('stale request owner')
    expect(fixture.browserWindowVisible).toBe(false)
    expect(fixture.cookieRemove).toHaveBeenCalledWith(
      'https://rpc.example.test/api/v1/desktop/owned-window-ready-to-show',
      'clerum_desktop_session'
    )
  })

  it('retires a loaded A window and its cookie before B opens the same host', async () => {
    fixture.postDesktopSession.mockImplementation(async (jwt: string) => ({
      setCookie: `clerum_desktop_session=${jwt}; Path=/; HttpOnly`,
    }))
    fixture.cookieSet.mockResolvedValue(undefined)
    fixture.cookieRemove.mockResolvedValue(undefined)
    const { openDesktopWindow } = await import('../desktopWindow.js')
    const ownerA = Object.freeze({ owner: 'session-a' })
    const ownerB = Object.freeze({ owner: 'session-b' })
    let currentOwner = ownerA
    const onCloseA = vi.fn()
    const onCloseB = vi.fn()
    const assertOwner = (owner: typeof ownerA | typeof ownerB) => () => {
      if (currentOwner !== owner) throw new Error('stale request owner')
    }

    await openDesktopWindow({
      hostRef: 'shared-host',
      jwt: 'rpc-bearer-a',
      rpcProxyUrl: 'https://rpc.example.test',
      ...ownerArgs(ownerA),
      assertRequestOwnerCurrent: assertOwner(ownerA),
      onClose: onCloseA,
    })
    const staleClosedCallbackA = fixture.closed
    expect(fixture.browserWindowCreated).toBe(1)

    currentOwner = ownerB
    await openDesktopWindow({
      hostRef: 'shared-host',
      jwt: 'rpc-bearer-b',
      rpcProxyUrl: 'https://rpc.example.test',
      ...ownerArgs(ownerB),
      assertRequestOwnerCurrent: assertOwner(ownerB),
      onClose: onCloseB,
    })

    staleClosedCallbackA?.()

    expect(fixture.browserWindowClosed).toBe(true)
    expect(onCloseA).toHaveBeenCalledOnce()
    expect(onCloseA).toHaveBeenCalledWith('shared-host')
    expect(onCloseB).not.toHaveBeenCalled()
    expect(fixture.cookieRemove).toHaveBeenCalledWith(
      'https://rpc.example.test/api/v1/desktop/shared-host',
      'clerum_desktop_session'
    )
    expect(fixture.postDesktopSession).toHaveBeenCalledTimes(2)
    expect(fixture.postDesktopSession).toHaveBeenNthCalledWith(2, 'rpc-bearer-b', 'shared-host')
    expect(fixture.browserWindowCreated).toBe(2)
    expect(fixture.browserWindowVisible).toBe(true)
    expect(fixture.cookieSet).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ value: 'rpc-bearer-b' })
    )
    expect(fixture.cookieRemove.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.postDesktopSession.mock.invocationCallOrder[1]
    )
  })

  it('serializes delayed A cleanup before B installs its partition cookie', async () => {
    const cookieRemoval = deferred<void>()
    fixture.postDesktopSession.mockImplementation(async (jwt: string) => ({
      setCookie: `clerum_desktop_session=${jwt}; Path=/; HttpOnly`,
    }))
    fixture.cookieSet.mockResolvedValue(undefined)
    fixture.cookieRemove.mockReturnValue(cookieRemoval.promise)
    const { openDesktopWindow } = await import('../desktopWindow.js')
    const ownerA = Object.freeze({ owner: 'session-a' })
    const ownerB = Object.freeze({ owner: 'session-b' })
    let currentOwner = ownerA
    const assertOwner = (owner: typeof ownerA | typeof ownerB) => () => {
      if (currentOwner !== owner) throw new Error('stale request owner')
    }

    await openDesktopWindow({
      hostRef: 'delayed-cleanup-host',
      jwt: 'rpc-bearer-a',
      rpcProxyUrl: 'https://rpc.example.test',
      ...ownerArgs(ownerA),
      assertRequestOwnerCurrent: assertOwner(ownerA),
    })
    const delayedReadyToShowA = fixture.readyToShow
    currentOwner = ownerB
    delayedReadyToShowA?.()
    await vi.waitFor(() => expect(fixture.cookieRemove).toHaveBeenCalledOnce())

    const openingB = openDesktopWindow({
      hostRef: 'delayed-cleanup-host',
      jwt: 'rpc-bearer-b',
      rpcProxyUrl: 'https://rpc.example.test',
      ...ownerArgs(ownerB),
      assertRequestOwnerCurrent: assertOwner(ownerB),
    })
    await vi.waitFor(() => expect(fixture.postDesktopSession).toHaveBeenCalledTimes(2))
    expect(fixture.cookieSet).toHaveBeenCalledOnce()

    cookieRemoval.resolve()
    await openingB
    expect(fixture.cookieSet).toHaveBeenCalledTimes(2)
    expect(fixture.cookieSet).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ value: 'rpc-bearer-b' })
    )
  })

  it('refreshes callbacks when the exact accepted owner reuses its window', async () => {
    fixture.postDesktopSession.mockResolvedValue({
      setCookie: 'clerum_desktop_session=session-cookie; Path=/; HttpOnly',
    })
    fixture.cookieSet.mockResolvedValue(undefined)
    fixture.cookieRemove.mockResolvedValue(undefined)
    const { closeDesktopWindow, openDesktopWindow } = await import('../desktopWindow.js')
    const sameOwner = Object.freeze({ owner: 'same-session' })
    let originalCallbackCurrent = true
    const assertOriginalCallbackCurrent = () => {
      if (!originalCallbackCurrent) throw new Error('stale original request callback')
    }
    const assertRefreshedCallbackCurrent = vi.fn()
    const originalOnClose = vi.fn()
    const refreshedOnClose = vi.fn()

    await openDesktopWindow({
      hostRef: 'same-owner-host',
      jwt: 'rpc-bearer',
      rpcProxyUrl: 'https://rpc.example.test',
      ...ownerArgs(sameOwner),
      assertRequestOwnerCurrent: assertOriginalCallbackCurrent,
      onClose: originalOnClose,
    })
    await openDesktopWindow({
      hostRef: 'same-owner-host',
      jwt: 'rpc-bearer',
      rpcProxyUrl: 'https://rpc.example.test',
      ...ownerArgs(sameOwner),
      assertRequestOwnerCurrent: assertRefreshedCallbackCurrent,
      onClose: refreshedOnClose,
    })
    originalCallbackCurrent = false
    fixture.readyToShow?.()
    closeDesktopWindow('same-owner-host')

    expect(fixture.browserWindowCreated).toBe(1)
    expect(fixture.browserWindowDestroyed).toBe(false)
    expect(assertRefreshedCallbackCurrent).toHaveBeenCalled()
    expect(originalOnClose).not.toHaveBeenCalled()
    expect(refreshedOnClose).toHaveBeenCalledOnce()
  })

  it('destroys current host windows synchronously when the session owner is cleared', async () => {
    fixture.postDesktopSession.mockResolvedValue({
      setCookie: 'clerum_desktop_session=session-cookie; Path=/; HttpOnly',
    })
    fixture.cookieSet.mockResolvedValue(undefined)
    fixture.cookieRemove.mockResolvedValue(undefined)
    const { closeAllDesktopWindows, openDesktopWindow } = await import('../desktopWindow.js')
    let ownerIsCurrent = true
    const onClose = vi.fn()

    await openDesktopWindow({
      hostRef: 'logout-window-host',
      jwt: 'rpc-bearer-a',
      rpcProxyUrl: 'https://rpc.example.test',
      ...ownerArgs(),
      assertRequestOwnerCurrent: () => {
        if (!ownerIsCurrent) throw new Error('stale request owner')
      },
      onClose,
    })
    ownerIsCurrent = false
    const closing = closeAllDesktopWindows()

    expect(fixture.browserWindowDestroyed).toBe(true)
    expect(onClose).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledWith('logout-window-host')
    await closing
    fixture.closed?.()
    expect(onClose).toHaveBeenCalledOnce()
    expect(fixture.cookieRemove).toHaveBeenCalledWith(
      'https://rpc.example.test/api/v1/desktop/logout-window-host',
      'clerum_desktop_session'
    )
  })

  it('continues retiring every host when one renderer close notification throws', async () => {
    fixture.postDesktopSession.mockResolvedValue({
      setCookie: 'clerum_desktop_session=session-cookie; Path=/; HttpOnly',
    })
    fixture.cookieSet.mockResolvedValue(undefined)
    fixture.cookieRemove.mockResolvedValue(undefined)
    const { closeAllDesktopWindows, openDesktopWindow } = await import('../desktopWindow.js')
    const firstOwnerClosed = vi.fn(() => {
      throw new Error('renderer already gone')
    })
    const secondOwnerClosed = vi.fn()

    await openDesktopWindow({
      hostRef: 'throwing-close-callback-host',
      jwt: 'rpc-bearer-a',
      rpcProxyUrl: 'https://rpc.example.test',
      ...ownerArgs(Object.freeze({ owner: 'session-a' })),
      assertRequestOwnerCurrent: () => {},
      onClose: firstOwnerClosed,
    })
    await openDesktopWindow({
      hostRef: 'healthy-close-callback-host',
      jwt: 'rpc-bearer-b',
      rpcProxyUrl: 'https://rpc.example.test',
      ...ownerArgs(Object.freeze({ owner: 'session-b' })),
      assertRequestOwnerCurrent: () => {},
      onClose: secondOwnerClosed,
    })

    await expect(closeAllDesktopWindows()).resolves.toBeUndefined()

    expect(firstOwnerClosed).toHaveBeenCalledOnce()
    expect(secondOwnerClosed).toHaveBeenCalledOnce()
    expect(fixture.browserWindowDestroyedCount).toBe(2)
    expect(fixture.cookieRemove).toHaveBeenCalledTimes(2)
    expect(fixture.cookieRemove.mock.calls).toEqual(
      expect.arrayContaining([
        [
          'https://rpc.example.test/api/v1/desktop/throwing-close-callback-host',
          'clerum_desktop_session',
        ],
        [
          'https://rpc.example.test/api/v1/desktop/healthy-close-callback-host',
          'clerum_desktop_session',
        ],
      ])
    )
  })
})
