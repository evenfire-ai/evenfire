import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  findInActiveSandboxUi,
  focusActiveSandboxUi,
  getActiveSandboxUi,
  installSandboxUiCookie,
  mountSandboxUiView,
  unmountSandboxUiView,
} from '../sandboxUiDriver.js'

type Listener = () => void

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

    listenerCount(event: string): number {
      return this.listeners.get(event)?.size ?? 0
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

  // Partition cookie jar keyed by `${url}|${name}`, the identity Electron's
  // `cookies.remove(url, name)` matches on.
  const cookieJar = new Map<string, string>()
  const sessionObject = {
    cookies: {
      set: vi.fn(
        async (_details?: { url: string; name: string; value: string }): Promise<void> => undefined
      ),
      remove: vi.fn(async (url: string, name: string): Promise<void> => {
        cookieJar.delete(`${url}|${name}`)
      }),
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
    cookieJar,
    views,
  }
})

vi.mock('electron', () => ({
  WebContentsView: electronMocks.FakeWebContentsView,
  screen: { getDisplayMatching: electronMocks.getDisplayMatching },
  session: { fromPartition: electronMocks.fromPartition },
  shell: { openExternal: vi.fn() },
}))

vi.mock('../config.js', () => ({
  getActiveEnvKey: () => 'test-env',
}))

vi.mock('../sandboxUiPartitionGc.js', () => ({
  touchSandboxUiPartition: electronMocks.touchSandboxUiPartition,
}))

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

  getBounds(): Electron.Rectangle {
    return { x: 0, y: 0, width: 800, height: 600 }
  }

  once(event: string, handler: Listener): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(handler)
    return this
  }

  removeListener(event: string, handler: Listener): this {
    this.listeners.get(event)?.delete(handler)
    return this
  }

  emit(event: string): void {
    const handlers = [...(this.listeners.get(event) ?? [])]
    this.listeners.delete(event)
    handlers.forEach(handler => handler())
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0
  }
}

type MountSandboxUiViewArgs = Parameters<typeof mountSandboxUiView>[0]
type MountSandboxUiViewOverrides = Omit<Partial<MountSandboxUiViewArgs>, 'parentWindow'> & {
  parentWindow: FakeParentWindow
}

function mountArgs(overrides: MountSandboxUiViewOverrides): MountSandboxUiViewArgs {
  return {
    recipeNs: 'sandbox-recipes',
    recipeName: 'task-board',
    setCookie:
      'clerum_sandbox_ui_session=tok;' +
      ' Path=/api/v1/sandbox-ui/sandbox-recipes/task-board/; HttpOnly',
    rpcProxyUrl: 'https://rpc.example',
    defaultPath: '/',
    bounds: { x: 0, y: 0, width: 400, height: 300 },
    ...overrides,
    parentWindow: overrides.parentWindow as unknown as MountSandboxUiViewArgs['parentWindow'],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  electronMocks.views.length = 0
  electronMocks.cookieJar.clear()
  electronMocks.sessionObject.cookies.set.mockResolvedValue(undefined)
})

/** Holds every cookie write pending; `release()` lands them in the jar. */
function holdCookieWrites(): { release: () => void } {
  const pending: Array<() => void> = []
  electronMocks.sessionObject.cookies.set.mockImplementation(
    details =>
      new Promise<void>(resolve => {
        pending.push(() => {
          if (details) electronMocks.cookieJar.set(`${details.url}|${details.name}`, details.value)
          resolve()
        })
      })
  )
  return { release: () => pending.splice(0).forEach(land => land()) }
}

afterEach(async () => {
  await unmountSandboxUiView()
})

describe('mountSandboxUiView lifecycle cleanup', () => {
  it('removes the old parent close listener when a view is replaced', async () => {
    const parentWindow = new FakeParentWindow()
    const firstClosed = vi.fn()
    const secondClosed = vi.fn()

    await mountSandboxUiView(mountArgs({ parentWindow, onClosed: firstClosed }))
    await mountSandboxUiView(
      mountArgs({ parentWindow, recipeName: 'support-desk', onClosed: secondClosed })
    )

    expect(parentWindow.listenerCount('closed')).toBe(1)

    parentWindow.emit('closed')

    expect(firstClosed).not.toHaveBeenCalled()
    expect(secondClosed).toHaveBeenCalledOnce()
  })

  it('removes the parent close listener when the active view is unmounted', async () => {
    const parentWindow = new FakeParentWindow()
    const onClosed = vi.fn()

    await mountSandboxUiView(mountArgs({ parentWindow, onClosed }))
    expect(parentWindow.listenerCount('closed')).toBe(1)

    await unmountSandboxUiView()

    expect(parentWindow.listenerCount('closed')).toBe(0)
    expect(electronMocks.views[0]?.webContents.stopFindInPage).toHaveBeenCalledWith(
      'clearSelection'
    )
    parentWindow.emit('closed')
    expect(onClosed).not.toHaveBeenCalled()
  })

  // Electron's payload for a dead renderer; any reason (crash, OOM, kill)
  // leaves the view painting its last frame.
  const RENDER_PROCESS_GONE: [unknown, Electron.RenderProcessGoneDetails] = [
    {},
    { reason: 'crashed', exitCode: 139 },
  ]

  it('tears the active view down and reports it closed once when its renderer dies', async () => {
    const parentWindow = new FakeParentWindow()
    const onClosed = vi.fn()
    await mountSandboxUiView(mountArgs({ parentWindow, onClosed }))
    const view = electronMocks.views[0]!

    view.webContents.emit('render-process-gone', ...RENDER_PROCESS_GONE)

    expect(getActiveSandboxUi()).toBeNull()
    expect(parentWindow.contentView.removeChildView).toHaveBeenCalledOnce()
    expect(parentWindow.contentView.removeChildView).toHaveBeenCalledWith(view)
    expect(onClosed).toHaveBeenCalledOnce()
    // The listener went with the view: a repeated signal reports nothing more.
    expect(view.webContents.listenerCount('render-process-gone')).toBe(0)
    view.webContents.emit('render-process-gone', ...RENDER_PROCESS_GONE)
    expect(onClosed).toHaveBeenCalledOnce()
  })

  it('the dead-renderer listener of a replaced view no longer fires', async () => {
    const parentWindow = new FakeParentWindow()
    const firstClosed = vi.fn()
    const secondClosed = vi.fn()
    await mountSandboxUiView(mountArgs({ parentWindow, onClosed: firstClosed }))
    await mountSandboxUiView(
      mountArgs({ parentWindow, recipeName: 'support-desk', onClosed: secondClosed })
    )
    const [first, second] = electronMocks.views

    first!.webContents.emit('render-process-gone', ...RENDER_PROCESS_GONE)

    expect(getActiveSandboxUi()?.webContentsId).toBe(second!.webContents.id)
    expect(parentWindow.contentView.removeChildView).toHaveBeenCalledTimes(1)
    expect(firstClosed).not.toHaveBeenCalled()
    expect(secondClosed).not.toHaveBeenCalled()
  })

  it('removes the dead-renderer listener when the active view is unmounted', async () => {
    const parentWindow = new FakeParentWindow()
    const onClosed = vi.fn()
    await mountSandboxUiView(mountArgs({ parentWindow, onClosed }))
    const view = electronMocks.views[0]!
    expect(view.webContents.listenerCount('render-process-gone')).toBe(1)

    await unmountSandboxUiView()

    expect(view.webContents.listenerCount('render-process-gone')).toBe(0)
    expect(onClosed).not.toHaveBeenCalled()
  })

  it('focuses only the currently mounted native view', async () => {
    expect(focusActiveSandboxUi()).toBe(false)
    const parentWindow = new FakeParentWindow()
    await mountSandboxUiView(mountArgs({ parentWindow }))

    expect(focusActiveSandboxUi()).toBe(true)
    expect(electronMocks.views[0]?.webContents.focus).toHaveBeenCalledOnce()
  })

  it('gates find by document readiness and invalidates it on main-frame navigation', async () => {
    const parentWindow = new FakeParentWindow()
    await mountSandboxUiView(mountArgs({ parentWindow }))
    const webContents = electronMocks.views[0]!.webContents
    const onResult = vi.fn()

    expect(findInActiveSandboxUi('invoice', 'start', 1, onResult)).toEqual({
      status: 'unavailable',
      reason: 'document-loading',
    })

    webContents.emit('did-finish-load')
    expect(findInActiveSandboxUi('invoice', 'start', 1, onResult)).toEqual({
      status: 'started',
      requestId: 41,
    })
    expect(webContents.findInPage).toHaveBeenCalledWith('invoice', {
      forward: true,
      findNext: true,
    })
    webContents.emit('found-in-page', {} as Electron.Event, {
      requestId: 41,
      activeMatchOrdinal: 1,
      matches: 2,
      selectionArea: { x: 0, y: 0, width: 1, height: 1 },
      finalUpdate: true,
    })
    expect(findInActiveSandboxUi('invoice', 'next', 1, onResult).status).toBe('started')

    webContents.emit(
      'did-start-navigation',
      {} as Electron.Event,
      'https://rpc.example/next',
      false,
      true
    )
    expect(webContents.stopFindInPage).toHaveBeenCalledWith('clearSelection')
    expect(findInActiveSandboxUi('invoice', 'next', 1, onResult)).toEqual({
      status: 'unavailable',
      reason: 'document-loading',
    })
  })

  it('keeps the current document searchable after same-document navigation', async () => {
    const parentWindow = new FakeParentWindow()
    await mountSandboxUiView(mountArgs({ parentWindow }))
    const webContents = electronMocks.views[0]!.webContents
    const onResult = vi.fn()

    webContents.emit('did-finish-load')
    expect(findInActiveSandboxUi('invoice', 'start', 1, onResult).status).toBe('started')
    webContents.emit('found-in-page', {} as Electron.Event, {
      requestId: 41,
      activeMatchOrdinal: 1,
      matches: 2,
      selectionArea: { x: 0, y: 0, width: 1, height: 1 },
      finalUpdate: true,
    })

    webContents.emit(
      'did-start-navigation',
      {} as Electron.Event,
      'https://rpc.example/app#next',
      true,
      true
    )

    expect(findInActiveSandboxUi('invoice', 'start', 2, onResult).status).toBe('started')
  })

  it('keeps only the newest view when cookie writes complete out of order', async () => {
    const parentWindow = new FakeParentWindow()
    let resolveFirstCookie!: () => void
    let resolveSecondCookie!: () => void
    electronMocks.sessionObject.cookies.set.mockImplementation(
      (details?: { value: string }) =>
        new Promise<void>(resolve => {
          const value = details?.value
          if (value === 'tok-first') resolveFirstCookie = resolve
          if (value === 'tok-second') resolveSecondCookie = resolve
        })
    )

    const firstMount = mountSandboxUiView(
      mountArgs({
        parentWindow,
        recipeName: 'first-app',
        setCookie:
          'clerum_sandbox_ui_session=tok-first;' +
          ' Path=/api/v1/sandbox-ui/sandbox-recipes/first-app/; HttpOnly',
      })
    )
    await vi.waitFor(() => {
      expect(electronMocks.sessionObject.cookies.set).toHaveBeenCalledTimes(1)
    })

    const secondMount = mountSandboxUiView(
      mountArgs({
        parentWindow,
        recipeName: 'second-app',
        setCookie:
          'clerum_sandbox_ui_session=tok-second;' +
          ' Path=/api/v1/sandbox-ui/sandbox-recipes/second-app/; HttpOnly',
      })
    )
    await vi.waitFor(() => {
      expect(electronMocks.sessionObject.cookies.set).toHaveBeenCalledTimes(2)
    })

    resolveSecondCookie()
    await secondMount
    resolveFirstCookie()
    await firstMount

    expect(electronMocks.views).toHaveLength(1)
    expect(parentWindow.contentView.addChildView).toHaveBeenCalledOnce()
    expect(parentWindow.contentView.removeChildView).not.toHaveBeenCalled()
    expect(parentWindow.listenerCount('closed')).toBe(1)
    expect(electronMocks.views[0]?.webContents.isDestroyed()).toBe(false)
  })

  it('does not attach a view when unmount invalidates an in-flight mount', async () => {
    const parentWindow = new FakeParentWindow()
    let resolveCookie!: () => void
    electronMocks.sessionObject.cookies.set.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          resolveCookie = resolve
        })
    )

    const mount = mountSandboxUiView(mountArgs({ parentWindow }))
    await vi.waitFor(() => {
      expect(electronMocks.sessionObject.cookies.set).toHaveBeenCalledOnce()
    })

    await unmountSandboxUiView()
    resolveCookie()
    await mount

    expect(electronMocks.views).toHaveLength(0)
    expect(parentWindow.contentView.addChildView).not.toHaveBeenCalled()
    expect(parentWindow.listenerCount('closed')).toBe(0)
  })

  it('removes the cookie it wrote when the session changes during the write', async () => {
    const parentWindow = new FakeParentWindow()
    const cookieWrites = holdCookieWrites()
    let sessionCurrent = true

    const mount = mountSandboxUiView(mountArgs({ parentWindow, isCurrent: () => sessionCurrent }))
    await vi.waitFor(() => {
      expect(electronMocks.sessionObject.cookies.set).toHaveBeenCalledOnce()
    })

    sessionCurrent = false
    cookieWrites.release()
    await mount

    expect([...electronMocks.cookieJar.keys()]).toEqual([])
    expect(electronMocks.views).toHaveLength(0)
    expect(parentWindow.contentView.addChildView).not.toHaveBeenCalled()
  })

  it('leaves the cookie alone when a newer mount superseded the write', async () => {
    const parentWindow = new FakeParentWindow()
    const cookieWrites = holdCookieWrites()
    let sessionCurrent = true

    const mount = mountSandboxUiView(mountArgs({ parentWindow, isCurrent: () => sessionCurrent }))
    await vi.waitFor(() => {
      expect(electronMocks.sessionObject.cookies.set).toHaveBeenCalledOnce()
    })

    const newerMount = mountSandboxUiView(
      mountArgs({
        parentWindow,
        setCookie:
          'clerum_sandbox_ui_session=tok-newer;' +
          ' Path=/api/v1/sandbox-ui/sandbox-recipes/task-board/; HttpOnly',
      })
    )
    await vi.waitFor(() => {
      expect(electronMocks.sessionObject.cookies.set).toHaveBeenCalledTimes(2)
    })
    sessionCurrent = false
    cookieWrites.release()
    await Promise.all([mount, newerMount])

    expect(electronMocks.sessionObject.cookies.remove).not.toHaveBeenCalled()
    expect([...electronMocks.cookieJar.values()]).toEqual(['tok-newer'])
    expect(electronMocks.views).toHaveLength(1)
  })

  it('encodes the canonical client route before handing it to the mounted app', async () => {
    const parentWindow = new FakeParentWindow()

    await mountSandboxUiView(
      mountArgs({
        parentWindow,
        routePath: '/café menu/literal%percent',
      })
    )
    const view = electronMocks.views[0]
    expect(view).toBeDefined()
    view!.webContents.executeJavaScript.mockResolvedValue(true)
    view!.webContents.emit(
      'did-navigate',
      {},
      'https://rpc.example/api/v1/sandbox-ui/sandbox-recipes/task-board/view/',
      200
    )
    view!.webContents.emit('did-finish-load')

    await vi.waitFor(() => {
      expect(view!.webContents.executeJavaScript).toHaveBeenCalledOnce()
    })
    expect(view!.webContents.executeJavaScript.mock.calls[0]?.[0]).toContain(
      'https://rpc.example/api/v1/sandbox-ui/sandbox-recipes/task-board/view/' +
        'caf%C3%A9%20menu/literal%25percent'
    )
  })

  it('encodes the canonical default route before loading the mounted app', async () => {
    const parentWindow = new FakeParentWindow()

    await mountSandboxUiView(
      mountArgs({
        parentWindow,
        defaultPath: '/café menu/literal%percent',
      })
    )
    const view = electronMocks.views[0]

    expect(view!.webContents.loadURL).toHaveBeenCalledWith(
      'https://rpc.example/api/v1/sandbox-ui/sandbox-recipes/task-board/view/' +
        'caf%C3%A9%20menu/literal%25percent'
    )
  })

  it('rejects a refresh cookie scoped to a different recipe', async () => {
    const parentWindow = new FakeParentWindow()
    await mountSandboxUiView(mountArgs({ parentWindow }))

    await expect(
      installSandboxUiCookie(
        'clerum_sandbox_ui_session=foreign;' +
          ' Path=/api/v1/sandbox-ui/sandbox-recipes/other-app/; HttpOnly'
      )
    ).rejects.toThrow('does not match the active recipe')

    expect(electronMocks.sessionObject.cookies.set).toHaveBeenCalledOnce()
  })
})
