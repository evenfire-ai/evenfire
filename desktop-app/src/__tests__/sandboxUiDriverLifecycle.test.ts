import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSandboxUiView, unmountSandboxUiView } from '../sandboxUiDriver.js'

type Listener = () => void

const electronMocks = vi.hoisted(() => {
  let nextWebContentsId = 1

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

    on(event: string, handler: (...args: unknown[]) => void): this {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set())
      this.listeners.get(event)!.add(handler)
      return this
    }

    removeListener(event: string, handler: (...args: unknown[]) => void): this {
      this.listeners.get(event)?.delete(handler)
      return this
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
  }

  const sessionObject = {
    cookies: { set: vi.fn(async () => undefined) },
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
})

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
    parentWindow.emit('closed')
    expect(onClosed).not.toHaveBeenCalled()
  })
})
