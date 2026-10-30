import { vi } from 'vitest'
import { tmpdir } from 'node:os'

// Electron runtime fakes for suites that drive the REAL AppService, sandbox-ui
// driver and IPC handlers. Consumed through
//   vi.mock('electron', async () =>
//     (await import('./__fixtures__/sandboxUiElectronFakes')).electronModule)
// and imported directly by the suite for the handles below; both resolve to
// this one module instance, so the suite and the code under test share state.
// This module must never import `electron` itself.

type Listener = (...args: unknown[]) => void

let nextWebContentsId = 1
const views: FakeWebContentsView[] = []

export class FakeWebContents {
  id = nextWebContentsId++
  // Chromium reports the last committed URL: '' until the first document
  // commits, whatever `loadURL` was asked for.
  currentUrl = ''
  pendingUrl = ''
  destroyed = false
  // A page whose router has taken over the history API: `replaceState` does
  // not move the URL.
  historyLocked = false
  private readonly listeners = new Map<string, Set<Listener>>()
  // Runs the script the driver sends against a minimal page, so whatever the
  // embed would observe comes from the driver's real script, not a canned
  // answer.
  executeJavaScript = vi.fn(async (code: string): Promise<unknown> => {
    const vm = await import('node:vm')
    const webContents = this
    const history = {
      state: null as unknown,
      replaceState(state: unknown, _title: string, url: string) {
        history.state = state
        if (webContents.historyLocked) return
        webContents.currentUrl = new URL(url, webContents.currentUrl).href
        webContents.emit('did-navigate-in-page', {}, webContents.currentUrl, true)
      },
    }
    class PopStateEvent {
      constructor(
        readonly type: string,
        readonly init?: unknown
      ) {}
    }
    const window = {
      location: {
        get href() {
          return webContents.currentUrl
        },
      },
      history,
      dispatchEvent: () => true,
    }
    return vm.runInNewContext(code, { window, URL, PopStateEvent })
  })
  loadURL = vi.fn(async (url: string) => {
    this.pendingUrl = url
    electronMocks.onLoadURL?.(this, url)
  })

  /**
   * The requested document commits with `status` and finishes loading;
   * `redirectedTo` is where the server sent it instead.
   */
  commitLoad(status = 200, redirectedTo?: string): void {
    this.currentUrl = redirectedTo ?? this.pendingUrl
    this.emit('did-navigate', {}, this.currentUrl, status, '')
    this.emit('did-finish-load')
  }

  /** The app navigates inside its document (history API / hash). */
  navigateInPage(url: string): void {
    this.currentUrl = url
    this.emit('did-navigate-in-page', {}, url, true)
  }
  /** The user follows a link to another document of the app. */
  navigateTo(url: string, status = 200): void {
    this.pendingUrl = url
    this.commitLoad(status)
  }
  setWindowOpenHandler = vi.fn()
  // Native methods of a destroyed webContents throw, like Electron's.
  stopFindInPage = vi.fn(() => {
    this.assertAlive()
  })
  findInPage = vi.fn(() => 41)
  focus = vi.fn()
  send = vi.fn()
  reloadIgnoringCache = vi.fn()

  on(event: string, handler: Listener): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(handler)
    return this
  }

  removeListener(event: string, handler: Listener): this {
    this.listeners.get(event)?.delete(handler)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    this.listeners.get(event)?.forEach(handler => handler(...args))
  }

  getURL(): string {
    this.assertAlive()
    return this.currentUrl
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  close(): void {
    this.destroyed = true
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('Object has been destroyed')
  }
}

export class FakeWebContentsView {
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

export const electronMocks = {
  FakeWebContentsView,
  fromPartition: vi.fn(() => sessionObject),
  getDisplayMatching: vi.fn(() => ({ scaleFactor: 1 })),
  touchSandboxUiPartition: vi.fn(async () => undefined),
  sessionObject,
  views,
  ipcHandlers: new Map<string, (event: unknown, payload?: unknown) => unknown>(),
  windowsBySender: new Map<unknown, unknown>(),
  /**
   * Observes every document load the driver starts, so a suite can decide when
   * that load commits. Unset, a load never commits on its own.
   */
  onLoadURL: null as ((webContents: FakeWebContents, url: string) => void) | null,
}

export const electronModule = {
  WebContentsView: FakeWebContentsView,
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: (sender: unknown) => electronMocks.windowsBySender.get(sender) ?? null,
  },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
      electronMocks.ipcHandlers.set(channel, handler)
    },
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
  clipboard: { writeText: vi.fn() },
  dialog: { showSaveDialog: vi.fn(), showMessageBox: vi.fn() },
  Notification: class {
    static isSupported(): boolean {
      return false
    }
  },
  app: { getPath: vi.fn(() => tmpdir()), isReady: () => false },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  screen: { getDisplayMatching: electronMocks.getDisplayMatching },
  session: { fromPartition: electronMocks.fromPartition },
  shell: { openExternal: vi.fn() },
}

// Electron throws from the native methods of a destroyed window instead of
// ignoring the call; the contentView keeps its real child list.
export class FakeParentWindow {
  destroyed = false
  readonly children: unknown[] = []
  readonly webContents = { send: vi.fn(), isDestroyed: () => this.destroyed }
  readonly contentView: {
    addChildView: ReturnType<typeof vi.fn>
    removeChildView: ReturnType<typeof vi.fn>
    readonly children: unknown[]
  }
  private readonly listeners = new Map<string, Set<Listener>>()

  constructor() {
    const win = this
    this.contentView = {
      addChildView: vi.fn((view: unknown) => {
        win.assertAlive()
        win.children.push(view)
      }),
      removeChildView: vi.fn((view: unknown) => {
        win.assertAlive()
        const index = win.children.indexOf(view)
        if (index !== -1) win.children.splice(index, 1)
      }),
      get children(): unknown[] {
        win.assertAlive()
        return [...win.children]
      },
    }
  }

  /** The window closes: Electron destroys it and the views it held. */
  destroy(): void {
    this.destroyed = true
    this.children.length = 0
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('Object has been destroyed')
  }

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

  // EventEmitter, not native: works on a destroyed window too.
  removeListener(event: string, handler: Listener): this {
    this.listeners.get(event)?.delete(handler)
    return this
  }

  emit(event: string): void {
    this.listeners.get(event)?.forEach(handler => handler())
  }
}
