// @vitest-environment jsdom
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ERROR_TOAST_DURATION_MS } from '@constants/toasts'
import { installAppControllerClerum } from '@hooks/domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '@hooks/domain/__tests__/__fixtures__/mockClerum'
import { App } from '@/App'
import {
  accessibleResource,
  affordancesFailureMessage,
  affordancesResult,
  childView,
  heldAffordances,
  listAccessiblePage,
  listChildrenPage,
  renameResourceResult,
  resolveResource,
  resolvedDirectory,
  resolvedFile,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import {
  appServiceAffordanceProducer,
  heldPermissionResponse,
} from '@/gfs/__fixtures__/permissionProducerFixtures'
import { GfsClient } from '../../../src/gfs/uriHandler.js'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
} from '../../../testSupport/appService.nativeCommitTestHarness'
import { type ChromiumFocusShim, installChromiumFocusShim } from './__fixtures__/chromiumFocusShim'
import { createPointerDriver } from './__fixtures__/pointerDriver'

// The real App: real SidebarNav, FileExplorerTree, GfsActionHost, FilesPage
// and SandboxUiPage. Only `window.clerum.*` is stubbed.

const frames: FrameRequestCallback[] = []
let compact = false
const mediaListeners = new Set<(event: MediaQueryListEvent) => void>()

const MEASURED_SLOT = {
  x: 0,
  y: 0,
  top: 12,
  left: 16,
  right: 416,
  bottom: 312,
  width: 400,
  height: 300,
  toJSON: () => ({}),
} as DOMRect

const REPORTS_ID = 'a1'.repeat(16)
const NOTES_ID = 'b2'.repeat(16)
const NOTES_PARENT_ID = 'c3'.repeat(16)
const REPORTS = resolvedDirectory(REPORTS_ID, 'Reports')

/** What `gfs.deleteResource` resolves to, through the real GfsClient and the IPC clone. */
async function deleteReceipt(resourceId: string, ifMatch: number) {
  const client = new GfsClient({
    baseUrl: 'https://gfs.fixture.test',
    requestJson: async () => ({ ok: true, data: { deleted: true, resourceId } }) as never,
    fetchBytes: async () => new ArrayBuffer(0),
  })
  return structuredClone(
    await client.deleteResource({ resourceId, drive: 'main', ifMatch }, 'fixture-session-token')
  )
}

function installMedia() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(
      (query: string) =>
        ({
          get matches() {
            return query === '(max-width: 759px)' ? compact : false
          },
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) =>
            mediaListeners.add(listener)
          ),
          removeEventListener: vi.fn(
            (_type: string, listener: (event: MediaQueryListEvent) => void) =>
              mediaListeners.delete(listener)
          ),
          dispatchEvent: vi.fn(),
        }) as MediaQueryList
    )
  )
}

async function crossCompactThreshold(next: boolean) {
  compact = next
  await act(async () => {
    for (const listener of [...mediaListeners]) {
      listener({ matches: next } as MediaQueryListEvent)
    }
    await Promise.resolve()
  })
  await flushFrames()
}

async function flushFrames() {
  for (let pass = 0; pass < 8; pass += 1) {
    await act(async () => {
      frames.splice(0).forEach(callback => callback(performance.now()))
      await Promise.resolve()
    })
  }
}

function installBridge(desktopEnvironmentHandoffProducer?: any) {
  const { handle } = installAppControllerClerum({
    agentNames: ['agent-x'],
    desktopEnvironmentHandoffProducer,
  })
  // Main's generation is the one its session state publishes.
  const sessionState = handle.getSessionState as () => Promise<{ sessionGeneration: number }>
  handle.getSessionGeneration.mockImplementation(
    async () => (await sessionState()).sessionGeneration
  )
  const bridge = window.clerum as unknown as Record<string, any>
  bridge.chat.getIndex = vi.fn().mockResolvedValue({
    version: 1,
    lastActiveChatId: null,
    onboardingDismissed: false,
    chats: [],
  })
  bridge.rpc.getHostModels = vi.fn().mockResolvedValue({ models: [] })
  bridge.rpc.loadSessionMessages = vi.fn(() => new Promise(() => undefined))
  bridge.app = { rendererReady: vi.fn().mockResolvedValue(undefined) }
  let shortcutListener: ((commandId: string, source: string) => void) | null = null
  bridge.shortcuts = {
    onCommand: vi.fn((listener: (commandId: string, source: string) => void) => {
      shortcutListener = listener
      return vi.fn()
    }),
  }
  bridge.sandboxUi = {
    listApps: vi.fn().mockResolvedValue({
      apps: [
        {
          appRef: 'sandbox-recipes/alpha',
          title: 'Alpha',
          defaultPath: '/',
          ready: true,
          phase: 'active',
          updatedAt: null,
        },
      ],
    }),
    listPendingDeepLinks: vi.fn().mockResolvedValue({ links: [] }),
    clearPendingDeepLinks: vi.fn().mockResolvedValue(undefined),
    onDeepLink: vi.fn(() => vi.fn()),
    onSessionInvalidated: vi.fn(() => vi.fn()),
    onTitleChanged: vi.fn(() => vi.fn()),
    onClosed: vi.fn(() => vi.fn()),
    onRefreshError: vi.fn(() => vi.fn()),
    onFindResult: vi.fn(() => vi.fn()),
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getLocation: vi.fn().mockResolvedValue(null),
    setVisible: vi.fn().mockResolvedValue(undefined),
    setBounds: vi.fn().mockResolvedValue(undefined),
    capturePreview: vi.fn().mockResolvedValue(null),
    stopFindInPage: vi.fn().mockResolvedValue(undefined),
    focusActive: vi.fn().mockResolvedValue(true),
    reload: vi.fn().mockResolvedValue(undefined),
  }
  bridge.pluginSdk = { onOpenGfsResource: vi.fn(() => vi.fn()) }
  // The listing follows what the rename receipt says the server now holds.
  const notes = { name: 'notes.txt', version: 3 }
  bridge.gfs = {
    ...(bridge.gfs ?? {}),
    listAccessible: vi.fn(async () =>
      listAccessiblePage([
        accessibleResource(REPORTS_ID, 'Reports', 'directory', { permissions: ['read'] }),
        accessibleResource(NOTES_ID, notes.name, 'file', {
          version: notes.version,
          permissions: ['read', 'write', 'delete'],
        }),
      ])
    ),
    listChildren: vi.fn(async () => listChildrenPage([])),
    resolve: vi.fn(async (uri: string) => {
      if (uri === REPORTS.gfsUri) return resolveResource(REPORTS)
      throw new Error(`unexpected resolve of ${uri}`)
    }),
    affordances: vi.fn(async () => affordancesResult(heldAffordances(['read', 'write', 'delete']))),
    renameResource: vi.fn(async (resourceId: string, name: string) => {
      const receipt = await renameResourceResult(resourceId, name, notes.version + 1)
      notes.name = name
      notes.version = receipt.version
      return receipt
    }),
    deleteResource: vi.fn(async (resourceId: string, _drive?: string, ifMatch?: number) =>
      deleteReceipt(resourceId, ifMatch ?? 0)
    ),
    downloadPreview: vi.fn(() => new Promise(() => undefined)),
  }
  const runCommand = (commandId: string) => {
    if (!shortcutListener) throw new Error('the App did not subscribe to desktop commands')
    shortcutListener(commandId, 'host')
  }
  return { bridge, runCommand }
}

const SIGNED_IN_USER = {
  id: 'user-1',
  email: 'test@clerum.io',
  name: 'Test User',
  picture: null,
  teamId: 'team-1',
  teamName: 'Team 1',
  role: 'member',
}

/** Main's real AppService, signed in, so logout and login run its own session state. */
async function signedInMainSession() {
  const native = await createNativeCommitTestHarness()
  const service = native.service as any
  service.authClient = {
    googleLogin: vi.fn().mockResolvedValue({ token: 'synthetic-session-a', me: SIGNED_IN_USER }),
    passwordLogin: vi.fn().mockResolvedValue({ token: 'synthetic-session-b', me: SIGNED_IN_USER }),
  }
  service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn(async () => {})
  await service.googleLogin('synthetic-google-token')
  return service
}

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AgentTaskTrackerProvider>
        <App />
      </AgentTaskTrackerProvider>
    </QueryClientProvider>
  )
  return queryClient
}

async function waitForShell() {
  for (let pass = 0; pass < 8; pass += 1) {
    if (screen.queryByTestId('nav-files')) break
    await flushFrames()
  }
  expect(await screen.findByTestId('nav-files')).toBeTruthy()
}

async function launchAlpha(bridge: Record<string, any>) {
  fireEvent.click(screen.getByTestId('nav-sandbox-ui'))
  fireEvent.click(await screen.findByRole('button', { name: 'Open Alpha' }))
  await flushFrames()
  await waitFor(() => expect(bridge.sandboxUi.open).toHaveBeenCalled())
  await waitFor(() => expect(bridge.sandboxUi.setVisible).toHaveBeenLastCalledWith(true))
}

function openExplorer() {
  const toggle = screen.getByTestId('nav-files-explorer-toggle')
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle)
}

async function openRowMenu(name: string) {
  const row = await screen.findByRole('button', { name })
  fireEvent.contextMenu(row, { clientX: 20, clientY: 20 })
  return screen.findByRole('menu', { name: `Actions for ${name}` })
}

function lastVisibility(bridge: Record<string, any>) {
  return bridge.sandboxUi.setVisible.mock.calls.at(-1)?.[0]
}

function drawerOpen() {
  return Boolean(document.querySelector('aside')?.classList.contains('compact-open'))
}

function activeTabLabel() {
  const strip = screen.getByRole('toolbar', { name: 'Workspace tabs' })
  return strip.querySelector('[aria-pressed="true"]')?.getAttribute('aria-label') ?? null
}

function fileLocation() {
  return screen.queryByRole('navigation', { name: 'File location', hidden: true })?.textContent
}

describe('App sidebar GFS resource menu', () => {
  beforeEach(() => {
    frames.length = 0
    compact = false
    mediaListeners.clear()
    window.localStorage.clear()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()
      }
    )
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(MEASURED_SLOT)
    installMedia()
  })

  afterEach(async () => {
    vi.useRealTimers()
    cleanup()
    await new Promise(resolve => window.setTimeout(resolve, 0))
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    uninstallMockClerum()
    await cleanupNativeCommitTestHarness()
  })

  it('crossing the compact threshold with the menu open keeps the native view hidden', async () => {
    const { bridge } = installBridge()
    renderApp()
    await waitForShell()
    await launchAlpha(bridge)
    openExplorer()

    const menu = await openRowMenu('notes.txt')
    await waitFor(() => expect(lastVisibility(bridge)).toBe(false))
    const callsWithMenuOpen = bridge.sandboxUi.setVisible.mock.calls.length

    await crossCompactThreshold(true)

    expect(menu.isConnected).toBe(true)
    expect(
      bridge.sandboxUi.setVisible.mock.calls.slice(callsWithMenuOpen).map(([v]: [boolean]) => v)
    ).not.toContain(true)
    expect(lastVisibility(bridge)).toBe(false)

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await flushFrames()
    await waitFor(() => expect(lastVisibility(bridge)).toBe(true))
  })

  it('unmounting the tree with the menu open uncovers the native view', async () => {
    const { bridge } = installBridge()
    renderApp()
    await waitForShell()
    await launchAlpha(bridge)
    openExplorer()

    await openRowMenu('notes.txt')
    await waitFor(() => expect(lastVisibility(bridge)).toBe(false))

    // A click alone (no mousedown) takes the tree away without dismissing the menu first.
    fireEvent.click(screen.getByTestId('nav-files-explorer-toggle'))
    expect(screen.queryByRole('menu', { name: 'Actions for notes.txt' })).toBeNull()
    await flushFrames()
    await waitFor(() => expect(lastVisibility(bridge)).toBe(true))
  })

  it('a session that ends with a host dialog open leaves the native view visible after the next sign-in', async () => {
    const main = await signedInMainSession()
    const { bridge } = installBridge(main)
    let notifySessionCleared: (() => void) | null = null
    bridge.auth.onSessionCleared = vi.fn((listener: () => void) => {
      notifySessionCleared = listener
      return vi.fn()
    })
    main.onSessionCleared = () => notifySessionCleared?.()
    bridge.auth.passwordLogin = vi.fn((email: string, password: string) =>
      main.passwordLogin(email, password)
    )
    renderApp()
    await waitForShell()
    await launchAlpha(bridge)
    openExplorer()

    const menu = await openRowMenu('notes.txt')
    const rename = await within(menu).findByRole('menuitem', { name: 'Rename' })
    await waitFor(() => expect((rename as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(rename)
    expect(await screen.findByRole('dialog', { name: 'Rename file' })).toBeTruthy()
    await flushFrames()
    expect(lastVisibility(bridge)).toBe(false)

    // Main ends the committed session (control-api rejected it) and tells the window.
    await act(async () => {
      await main.endCommittedSession()
    })
    await waitFor(() => expect(screen.queryByTestId('nav-files')).toBeNull())
    expect(await main.getSessionState()).toMatchObject({ authenticated: false })

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: SIGNED_IN_USER.email } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'test-password' } })
    // Only the toast expiry needs a jump. The clock keeps advancing with real
    // time so every other setTimeout (query notifications, waitFor) runs as
    // before, and clearing the session-end toast's native timer still works.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout'],
      shouldAdvanceTime: true,
      shouldClearNativeTimers: true,
    })
    fireEvent.submit(screen.getByLabelText('Password').closest('form')!)
    await waitForShell()
    expect(bridge.auth.passwordLogin).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog', { name: 'Rename file' })).toBeNull()
    expect(screen.queryByRole('menu')).toBeNull()

    bridge.sandboxUi.open.mockClear()
    bridge.sandboxUi.setVisible.mockClear()
    fireEvent.click(screen.getByTestId('nav-sandbox-ui'))
    fireEvent.click(await screen.findByRole('button', { name: 'Open Alpha' }))
    await flushFrames()
    await waitFor(() => expect(bridge.sandboxUi.open).toHaveBeenCalled())
    await waitFor(() => expect(bridge.sandboxUi.setVisible).toHaveBeenCalled())
    // The session-end and sign-in toasts also cover the view; each expires on its
    // own timer, and only the newest one is armed at a time.
    for (let pass = 0; pass < 3 && document.querySelector('.toast-stack'); pass += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ERROR_TOAST_DURATION_MS)
      })
    }
    vi.useRealTimers()
    await waitFor(() => expect(document.querySelector('.toast-stack')).toBeNull())
    await flushFrames()
    await waitFor(() => expect(lastVisibility(bridge)).toBe(true))
  })

  it('Escape in the compact drawer closes the menu first, then the drawer', async () => {
    compact = true
    const { bridge } = installBridge()
    renderApp()
    await waitForShell()
    fireEvent.click(screen.getByTestId('compact-navigation-toggle'))
    expect(drawerOpen()).toBe(true)
    openExplorer()

    const menu = await openRowMenu('notes.txt')
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })

    expect(screen.queryByRole('menu', { name: 'Actions for notes.txt' })).toBeNull()
    expect(drawerOpen()).toBe(true)

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(drawerOpen()).toBe(false)
    expect(bridge.gfs.renameResource).not.toHaveBeenCalled()
  })

  it.each([
    { action: 'Delete', row: 'notes.txt', dialog: 'Delete notes.txt?', escapeCloses: true },
    { action: 'Rename', row: 'notes.txt', dialog: 'Rename file', escapeCloses: true },
    { action: 'New folder', row: 'Reports', dialog: 'New folder', escapeCloses: true },
    { action: 'Share', row: 'notes.txt', dialog: 'Share file notes.txt', escapeCloses: true },
    // The Move dialog has no Escape of its own: the drawer still leaves it alone.
    { action: 'Move to', row: 'notes.txt', dialog: 'Move file notes.txt', escapeCloses: false },
  ])(
    'Escape in the compact drawer with the host $action dialog open leaves the drawer open',
    async ({ action, row, dialog: dialogName, escapeCloses }) => {
      compact = true
      const { bridge } = installBridge()
      // Every host action offered: write on the folder, manage_acl on the file,
      // and a known parent so Move can be judged on it.
      const notes = resolvedFile(NOTES_ID, 'notes.txt', {
        parentResourceId: NOTES_PARENT_ID,
        version: 3,
      })
      bridge.gfs.listAccessible = vi.fn(async () =>
        listAccessiblePage([
          accessibleResource(REPORTS_ID, 'Reports', 'directory', {
            permissions: ['read', 'write'],
          }),
          accessibleResource(NOTES_ID, 'notes.txt', 'file', {
            version: 3,
            parentResourceId: NOTES_PARENT_ID,
            permissions: ['read', 'write', 'delete', 'manage_acl'],
          }),
        ])
      )
      bridge.gfs.resolve = vi.fn(async (uri: string) => {
        if (uri === REPORTS.gfsUri) return resolveResource(REPORTS)
        if (uri === notes.gfsUri) return resolveResource(notes)
        throw new Error(`unexpected resolve of ${uri}`)
      })
      bridge.gfs.affordances = vi.fn(
        appServiceAffordanceProducer(async () =>
          heldPermissionResponse(['read', 'write', 'delete', 'manage_acl'])
        )
      )
      // Share reads its lists on open; they stay pending, the dialog is open either way.
      bridge.gfs.listGrants = vi.fn(() => new Promise(() => undefined))
      bridge.gfs.listShares = vi.fn(() => new Promise(() => undefined))
      renderApp()
      await waitForShell()
      fireEvent.click(screen.getByTestId('compact-navigation-toggle'))
      expect(drawerOpen()).toBe(true)
      openExplorer()

      const menu = await openRowMenu(row)
      const item = await within(menu).findByRole('menuitem', { name: action })
      await waitFor(() => expect((item as HTMLButtonElement).disabled).toBe(false))
      fireEvent.click(item)
      if (action === 'Share') {
        // Share opens its flyout; the flyout's Share opens the dialog.
        const flyout = await screen.findByRole('menu', { name: `Share options for ${row}` })
        fireEvent.click(within(flyout).getByRole('menuitem', { name: 'Share' }))
      }
      const dialog = await screen.findByRole('dialog', { name: dialogName })
      expect(drawerOpen()).toBe(true)

      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

      expect(drawerOpen()).toBe(true)
      if (escapeCloses) {
        await waitFor(() => expect(dialog.isConnected).toBe(false))
      } else {
        expect(dialog.isConnected).toBe(true)
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close move dialog' }))
        await waitFor(() => expect(dialog.isConnected).toBe(false))
      }
      expect(drawerOpen()).toBe(true)

      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
      expect(drawerOpen()).toBe(false)
      expect(bridge.gfs.renameResource).not.toHaveBeenCalled()
      expect(bridge.gfs.deleteResource).not.toHaveBeenCalled()
    }
  )

  it.each([
    { action: 'Delete', row: 'notes.txt', dialog: 'Delete notes.txt?' },
    { action: 'Rename', row: 'notes.txt', dialog: 'Rename file' },
    { action: 'New folder', row: 'Reports', dialog: 'New folder' },
  ])(
    'Escape in the compact drawer while the host $action is still checking closes the drawer',
    async ({ action, row, dialog: dialogName }) => {
      compact = true
      const { bridge } = installBridge()
      const notes = resolvedFile(NOTES_ID, 'notes.txt', {
        parentResourceId: NOTES_PARENT_ID,
        version: 3,
      })
      bridge.gfs.listAccessible = vi.fn(async () =>
        listAccessiblePage([
          accessibleResource(REPORTS_ID, 'Reports', 'directory', {
            permissions: ['read', 'write'],
          }),
          accessibleResource(NOTES_ID, 'notes.txt', 'file', {
            version: 3,
            parentResourceId: NOTES_PARENT_ID,
            permissions: ['read', 'write', 'delete', 'manage_acl'],
          }),
        ])
      )
      bridge.gfs.resolve = vi.fn(async (uri: string) => {
        if (uri === REPORTS.gfsUri) return resolveResource(REPORTS)
        if (uri === notes.gfsUri) return resolveResource(notes)
        throw new Error(`unexpected resolve of ${uri}`)
      })
      const affordances = appServiceAffordanceProducer(async () =>
        heldPermissionResponse(['read', 'write', 'delete', 'manage_acl'])
      )
      bridge.gfs.affordances = vi.fn(affordances)
      renderApp()
      await waitForShell()
      await launchAlpha(bridge)
      fireEvent.click(screen.getByTestId('compact-navigation-toggle'))
      expect(drawerOpen()).toBe(true)
      openExplorer()

      const menu = await openRowMenu(row)
      const item = await within(menu).findByRole('menuitem', { name: action })
      await waitFor(() => expect((item as HTMLButtonElement).disabled).toBe(false))
      // From the click on, the host's fresh permission check waits on main.
      let releaseAffordances!: () => void
      const affordancesHeld = new Promise<void>(resolve => {
        releaseAffordances = resolve
      })
      bridge.gfs.affordances = vi.fn(async (...args: Parameters<typeof affordances>) => {
        await affordancesHeld
        return affordances(...args)
      })
      fireEvent.click(item)
      await waitFor(() => expect(bridge.gfs.affordances).toHaveBeenCalled())
      expect(screen.queryByRole('dialog', { name: dialogName })).toBeNull()

      const callsBeforeEscape = bridge.sandboxUi.setVisible.mock.calls.length
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
      expect(drawerOpen()).toBe(false)
      // The drawer no longer covers the view, but the checking action still does.
      await flushFrames()
      await act(async () => {})
      expect(
        bridge.sandboxUi.setVisible.mock.calls
          .slice(callsBeforeEscape)
          .map(([visible]: [boolean]) => visible)
      ).not.toContain(true)
      expect(lastVisibility(bridge)).toBe(false)

      await act(async () => {
        releaseAffordances()
        await Promise.resolve()
      })
      expect(await screen.findByRole('dialog', { name: dialogName })).toBeTruthy()
      expect(bridge.gfs.renameResource).not.toHaveBeenCalled()
      expect(bridge.gfs.deleteResource).not.toHaveBeenCalled()
    }
  )

  it('a host rename of the folder the Files tab shows re-reads its location on the page', async () => {
    const { bridge } = installBridge()
    const reports = { name: 'Reports', version: 1 }
    bridge.gfs.listAccessible = vi.fn(async () =>
      listAccessiblePage([
        accessibleResource(REPORTS_ID, reports.name, 'directory', {
          version: reports.version,
          permissions: ['read', 'write'],
        }),
      ])
    )
    bridge.gfs.resolve = vi.fn(async (uri: string) => {
      if (uri === REPORTS.gfsUri) {
        return resolveResource(
          resolvedDirectory(REPORTS_ID, reports.name, { version: reports.version })
        )
      }
      throw new Error(`unexpected resolve of ${uri}`)
    })
    bridge.gfs.renameResource = vi.fn(async (resourceId: string, name: string) => {
      const receipt = await renameResourceResult(resourceId, name, reports.version + 1)
      reports.name = name
      reports.version = receipt.version
      return receipt
    })
    renderApp()
    await waitForShell()
    openExplorer()

    fireEvent.doubleClick(await screen.findByRole('button', { name: 'Reports' }))
    await waitFor(() => expect(fileLocation()).toContain('Reports'))
    const resolvesBefore = bridge.gfs.resolve.mock.calls.length

    const tree = screen.getByRole('tree', { name: 'Shared files' })
    fireEvent.contextMenu(within(tree).getByRole('button', { name: 'Reports' }), {
      clientX: 20,
      clientY: 20,
    })
    const menu = await screen.findByRole('menu', { name: 'Actions for Reports' })
    const rename = await within(menu).findByRole('menuitem', { name: 'Rename' })
    await waitFor(() => expect((rename as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(rename)
    const renameDialog = await screen.findByRole('dialog', { name: 'Rename folder' })
    fireEvent.change(within(renameDialog).getByLabelText('Name'), {
      target: { value: 'Reports 2026' },
    })
    fireEvent.click(within(renameDialog).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(bridge.gfs.renameResource).toHaveBeenCalledWith(REPORTS_ID, 'Reports 2026', 'main', 1)
    )
    await waitFor(() => expect(renameDialog.isConnected).toBe(false))

    await waitFor(() => expect(fileLocation()).toContain('Reports 2026'))
    expect(bridge.gfs.resolve.mock.calls.length).toBeGreaterThan(resolvesBefore)
  })

  it('in-place actions on another resource leave the Files tab, its location and its crumbs alone', async () => {
    const { bridge } = installBridge()
    renderApp()
    await waitForShell()
    openExplorer()

    // The Files tab shows Q = Reports, opened from the tree.
    fireEvent.doubleClick(await screen.findByRole('button', { name: 'Reports' }))
    await waitFor(() => expect(fileLocation()).toContain('Reports'))
    const tabBefore = activeTabLabel()
    const locationBefore = fileLocation()
    expect(tabBefore).toBeTruthy()

    // Rename T = notes.txt, a sibling of Q.
    let menu = await openRowMenu('notes.txt')
    const rename = await within(menu).findByRole('menuitem', { name: 'Rename' })
    await waitFor(() => expect((rename as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(rename)
    const renameDialog = await screen.findByRole('dialog', { name: 'Rename file' })
    fireEvent.change(within(renameDialog).getByLabelText('Name'), {
      target: { value: 'notes-final.txt' },
    })
    fireEvent.click(within(renameDialog).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(bridge.gfs.renameResource).toHaveBeenCalledWith(NOTES_ID, 'notes-final.txt', 'main', 3)
    )
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename file' })).toBeNull())
    expect(activeTabLabel()).toBe(tabBefore)
    expect(fileLocation()).toBe(locationBefore)

    // The tree re-reads the renamed row, with the version the rename returned.
    expect(await screen.findByRole('button', { name: 'notes-final.txt' })).toBeTruthy()

    // A host dialog outlives the tree that opened it.
    menu = await openRowMenu('notes-final.txt')
    const remove = await within(menu).findByRole('menuitem', { name: 'Delete' })
    await waitFor(() => expect((remove as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(remove)
    const deleteDialog = await screen.findByRole('dialog', { name: 'Delete notes-final.txt?' })
    fireEvent.click(screen.getByTestId('nav-files-explorer-toggle'))
    expect(screen.queryByRole('tree', { name: 'Shared files' })).toBeNull()
    expect(deleteDialog.isConnected).toBe(true)
    fireEvent.click(within(deleteDialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(bridge.gfs.deleteResource).toHaveBeenCalledWith(NOTES_ID, 'main', 4))
    await waitFor(() => expect(deleteDialog.isConnected).toBe(false))
    expect(activeTabLabel()).toBe(tabBefore)
    expect(fileLocation()).toBe(locationBefore)
  })

  // Entry focus and Escape ownership of the row menu, under Chromium's focus
  // boundary (jsdom alone accepts focus on the still-hidden first paint). The
  // pointer is driven by one driver that replays Chromium's recorded event
  // sequences; the keyboard by user-event.
  describe('focus and Escape in the compact drawer, with Chromium focus rules', () => {
    const SUMMARY_ID = 'd4'.repeat(16)
    const ALL_BITS = ['read', 'write', 'delete', 'manage_acl']
    let shim: ChromiumFocusShim

    beforeEach(() => {
      shim = installChromiumFocusShim()
    })

    afterEach(() => {
      shim.uninstall()
    })

    async function openDrawerTree({ strict = false } = {}) {
      compact = true
      const { bridge } = installBridge()
      // Reports holds one file, so its menu needs a read of its own bits
      // (a forest root opens settled from the accessible listing).
      const summary = childView(SUMMARY_ID, 'summary.txt', 'file', {
        parentResourceId: REPORTS_ID,
      })
      bridge.gfs.listChildren = vi.fn(async (resourceId: string) =>
        listChildrenPage(resourceId === REPORTS_ID ? [summary] : [])
      )
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      const tree = (
        <QueryClientProvider client={queryClient}>
          <AgentTaskTrackerProvider>
            <App />
          </AgentTaskTrackerProvider>
        </QueryClientProvider>
      )
      render(strict ? <StrictMode>{tree}</StrictMode> : tree)
      await waitForShell()
      fireEvent.click(screen.getByTestId('compact-navigation-toggle'))
      expect(drawerOpen()).toBe(true)
      openExplorer()
      const notes = await screen.findByRole('button', { name: 'notes.txt' })
      return { bridge, queryClient, notes }
    }

    async function expandReports() {
      fireEvent.click(await screen.findByRole('button', { name: 'Expand Reports' }))
      return screen.findByRole('button', { name: 'summary.txt' })
    }

    /**
     * From here on every affordance read waits until `settle`, which answers
     * all of them through main's real producer (held bits or a 500).
     */
    function holdAffordances(bridge: Record<string, any>, queryClient: QueryClient) {
      // Idle cached bits would settle the next opening in a microtask.
      queryClient.removeQueries({
        predicate: query =>
          query.queryKey[3] === 'affordances' && query.state.fetchStatus === 'idle',
      })
      const produce = appServiceAffordanceProducer(async () => heldPermissionResponse(ALL_BITS))
      const waiting: Array<{
        resourceId: string
        drive: string
        resolve: (value: unknown) => void
        reject: (error: Error) => void
      }> = []
      bridge.gfs.affordances = vi.fn(
        (resourceId: string, drive = 'main') =>
          new Promise((resolve, reject) => waiting.push({ resourceId, drive, resolve, reject }))
      )
      return {
        waiting,
        async settle(outcome: 'ok' | 'error') {
          const failure = outcome === 'error' ? await affordancesFailureMessage(500) : null
          await act(async () => {
            for (const read of waiting.splice(0)) {
              if (failure === null) read.resolve(await produce(read.resourceId, read.drive))
              else read.reject(new Error(failure))
            }
          })
          await flushFrames()
        },
      }
    }

    async function openByKeyboard(row: HTMLElement) {
      act(() => row.focus())
      expect(document.activeElement).toBe(row)
      await userEvent.setup().keyboard('{Shift>}{F10}{/Shift}')
      return screen.findByRole('menu', { name: `Actions for ${row.textContent?.trim()}` })
    }

    const press = (keys: string) => userEvent.setup().keyboard(keys)
    const shareOf = (menu: HTMLElement) => within(menu).getByRole('menuitem', { name: 'Share' })
    const enabledItems = (menu: HTMLElement) =>
      Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'))
    const submenuFor = (name: string) =>
      screen.queryByRole('menu', { name: `Share options for ${name}` })
    const rowMenu = (name: string) => screen.queryByRole('menu', { name: `Actions for ${name}` })
    const rename = (menu: HTMLElement) =>
      within(menu).getByRole('menuitem', { name: 'Rename' }) as HTMLButtonElement

    it('S-1 Shift+F10 on a tree row focuses Share, and ArrowDown reaches the next item', async () => {
      const { notes } = await openDrawerTree()
      const menu = await openByKeyboard(notes)

      expect(document.activeElement).toBe(shareOf(menu))
      await press('{ArrowDown}')
      expect(document.activeElement).toBe(enabledItems(menu)[1])
    })

    it('S-2 a right-click on a tree row focuses Share, and ArrowDown reaches the next item', async () => {
      const { notes } = await openDrawerTree()
      createPointerDriver(notes).contextClick()
      const menu = await screen.findByRole('menu', { name: 'Actions for notes.txt' })

      expect(document.activeElement).toBe(shareOf(menu))
      await press('{ArrowDown}')
      expect(document.activeElement).toBe(enabledItems(menu)[1])
    })

    it('S-4 bits that settle after the menu opened leave focus on Share', async () => {
      const { bridge, queryClient } = await openDrawerTree()
      const summary = await expandReports()
      const reads = holdAffordances(bridge, queryClient)
      const menu = await openByKeyboard(summary)
      expect(rename(menu).disabled).toBe(true)
      expect(reads.waiting.length).toBeGreaterThan(0)

      expect(document.activeElement).toBe(shareOf(menu))
      await reads.settle('ok')
      expect(rename(menu).disabled).toBe(false)
      expect(document.activeElement).toBe(shareOf(menu))
    })

    it('S-5 bits that settle after ArrowDown leave focus on the item the user reached', async () => {
      const { bridge, queryClient } = await openDrawerTree()
      const summary = await expandReports()
      const reads = holdAffordances(bridge, queryClient)
      const menu = await openByKeyboard(summary)
      expect(rename(menu).disabled).toBe(true)

      await press('{ArrowDown}')
      const reached = document.activeElement
      expect(reached).toBe(enabledItems(menu)[1])
      await reads.settle('ok')
      expect(rename(menu).disabled).toBe(false)
      expect(document.activeElement).toBe(reached)
      expect((reached as HTMLElement).isConnected).toBe(true)
    })

    it('S-6 moving the pointer onto Share with focus on Rename moves focus into the submenu', async () => {
      const { notes } = await openDrawerTree()
      const menu = await openByKeyboard(notes)
      const pointer = createPointerDriver(notes)
      act(() => rename(menu).focus())
      expect(document.activeElement).toBe(rename(menu))

      pointer.moveTo(shareOf(menu))
      const submenu = submenuFor('notes.txt')
      expect(submenu).toBeTruthy()
      expect(document.activeElement).toBe(enabledItems(submenu!)[0])
    })

    it('S-8 Escape after the bits failed closes the menu and leaves the drawer open', async () => {
      const { bridge, queryClient } = await openDrawerTree()
      const summary = await expandReports()
      const reads = holdAffordances(bridge, queryClient)
      const menu = await openByKeyboard(summary)
      expect(rename(menu).disabled).toBe(true)

      await reads.settle('error')
      expect(rename(menu).disabled).toBe(true)
      await press('{Escape}')
      expect(rowMenu('summary.txt')).toBeNull()
      expect(drawerOpen()).toBe(true)
      expect(document.activeElement).toBe(summary)
    })

    it('S-9 bits that settle after the menu closed move no focus', async () => {
      const { bridge, queryClient } = await openDrawerTree()
      const summary = await expandReports()
      const reads = holdAffordances(bridge, queryClient)
      const menu = await openByKeyboard(summary)
      expect(rename(menu).disabled).toBe(true)

      await press('{Escape}')
      expect(rowMenu('summary.txt')).toBeNull()
      // Escape itself returned focus to the row from the menu, so the shim does
      // attribute this module's calls.
      const callsAtClose = shim.callsFrom('GfsResourceMenu/index.tsx').length
      expect(callsAtClose).toBeGreaterThan(0)
      expect(reads.waiting.length).toBeGreaterThan(0)
      await reads.settle('ok')
      expect(reads.waiting).toHaveLength(0)
      expect(shim.callsFrom('GfsResourceMenu/index.tsx')).toHaveLength(callsAtClose)
      expect(document.activeElement).toBe(summary)
    })

    it('S-10 under StrictMode the menu takes entry focus once, and Escape returns it to the row', async () => {
      const { notes } = await openDrawerTree({ strict: true })
      shim.reset()
      const menu = await openByKeyboard(notes)

      const entry = shim
        .callsFrom('GfsResourceMenu/index.tsx')
        .filter(call => call.element.getAttribute('role') === 'menuitem')
      expect(entry.map(call => [call.element, call.rejected])).toEqual([[shareOf(menu), null]])
      expect(document.activeElement).toBe(shareOf(menu))
      await press('{Escape}')
      expect(rowMenu('notes.txt')).toBeNull()
      expect(document.activeElement).toBe(notes)
    })

    it('S-11 a scroll or resize after ArrowDown leaves focus where the user put it', async () => {
      const { notes } = await openDrawerTree()
      const menu = await openByKeyboard(notes)
      await press('{ArrowDown}')
      const reached = enabledItems(menu)[1]
      expect(document.activeElement).toBe(reached)

      act(() => {
        fireEvent.scroll(menu)
        window.dispatchEvent(new Event('resize'))
      })
      await flushFrames()
      expect(document.activeElement).toBe(reached)
    })

    it('S-12 Escape closes the menu first and leaves the drawer open; a second Escape closes the drawer', async () => {
      const { notes } = await openDrawerTree()
      await openByKeyboard(notes)

      await press('{Escape}')
      expect(rowMenu('notes.txt')).toBeNull()
      expect(drawerOpen()).toBe(true)
      expect(document.activeElement).toBe(notes)
      await press('{Escape}')
      expect(drawerOpen()).toBe(false)
    })

    it('S-13 ArrowRight on Share focuses the submenu, and ArrowLeft returns to Share', async () => {
      const { notes } = await openDrawerTree()
      const menu = await openByKeyboard(notes)

      await press('{ArrowRight}')
      const submenu = submenuFor('notes.txt')
      expect(submenu).toBeTruthy()
      expect(document.activeElement).toBe(enabledItems(submenu!)[0])
      await press('{ArrowLeft}')
      expect(submenuFor('notes.txt')).toBeNull()
      expect(document.activeElement).toBe(shareOf(menu))
    })

    it('S-14 a contextmenu on the panel or the submenu never reaches the native menu', async () => {
      const { notes } = await openDrawerTree()
      const menu = await openByKeyboard(notes)

      const onPanel = createEvent.contextMenu(shareOf(menu))
      fireEvent(shareOf(menu), onPanel)
      expect(onPanel.defaultPrevented).toBe(true)
      await press('{ArrowRight}')
      const firstChild = enabledItems(submenuFor('notes.txt')!)[0]!
      const onSubmenu = createEvent.contextMenu(firstChild)
      fireEvent(firstChild, onSubmenu)
      expect(onSubmenu.defaultPrevented).toBe(true)
    })

    it('S-17 hover then ArrowRight keeps focus in the submenu; Escape closes only the submenu', async () => {
      const { notes } = await openDrawerTree()
      const menu = await openByKeyboard(notes)
      createPointerDriver(notes).moveTo(shareOf(menu))
      const submenu = submenuFor('notes.txt')!
      expect(submenu).toBeTruthy()

      await press('{ArrowRight}')
      expect(document.activeElement).toBe(enabledItems(submenu)[0])
      await press('{Escape}')
      expect(submenuFor('notes.txt')).toBeNull()
      expect(rowMenu('notes.txt')).toBeTruthy()
      expect(document.activeElement).toBe(shareOf(menu))
    })

    it('S-18 a click on Share after hover closes the submenu and leaves focus on Share', async () => {
      const { notes } = await openDrawerTree()
      const menu = await openByKeyboard(notes)
      const pointer = createPointerDriver(notes)
      pointer.moveTo(shareOf(menu))
      expect(submenuFor('notes.txt')).toBeTruthy()

      pointer.click()
      expect(submenuFor('notes.txt')).toBeNull()
      expect(document.activeElement).toBe(shareOf(menu))
    })

    it('S-19a Share arriving under a still pointer does not open the submenu', async () => {
      const { notes } = await openDrawerTree()
      const menu = await openByKeyboard(notes)
      const pointer = createPointerDriver(notes)

      // The panel appears under the pointer.
      pointer.layoutShiftTo(shareOf(menu))
      expect(submenuFor('notes.txt')).toBeNull()
      expect(document.activeElement).toBe(shareOf(menu))
      // After a real move away, a scroll or a shrinking panel slides Share back
      // under the still pointer.
      pointer.moveTo(rename(menu))
      pointer.layoutShiftTo(shareOf(menu))
      expect(submenuFor('notes.txt')).toBeNull()
      expect(document.activeElement).toBe(shareOf(menu))
    })

    it('S-19b a submenu that covered Share and closes does not reopen under a still pointer', async () => {
      const { notes } = await openDrawerTree()
      const menu = await openByKeyboard(notes)
      const pointer = createPointerDriver(notes)
      pointer.moveTo(shareOf(menu))
      const submenu = submenuFor('notes.txt')
      expect(submenu).toBeTruthy()
      // A narrow window lays the submenu over Share: the pointer now rests on it.
      pointer.layoutShiftTo(enabledItems(submenu!)[0]!)

      await press('{Escape}')
      expect(submenuFor('notes.txt')).toBeNull()
      pointer.layoutShiftTo(shareOf(menu))
      expect(submenuFor('notes.txt')).toBeNull()
      await press('{Escape}')
      expect(rowMenu('notes.txt')).toBeNull()
    })

    it('S-20 after Escape closes the hovered submenu, a tremor on Share does not reopen it', async () => {
      const { notes } = await openDrawerTree()
      const menu = await openByKeyboard(notes)
      const pointer = createPointerDriver(notes)
      pointer.moveTo(shareOf(menu))
      expect(submenuFor('notes.txt')).toBeTruthy()

      await press('{Escape}')
      pointer.microMove()
      expect(submenuFor('notes.txt')).toBeNull()
      // A second tremor: the first one may have re-armed the hover after
      // React's handler already read it.
      pointer.microMove()
      expect(submenuFor('notes.txt')).toBeNull()
      expect(document.activeElement).toBe(shareOf(menu))
      await press('{Escape}')
      expect(rowMenu('notes.txt')).toBeNull()
    })

    it('S-20b after ArrowLeft closes the hovered submenu, tremors on Share do not reopen it', async () => {
      const { notes } = await openDrawerTree()
      const menu = await openByKeyboard(notes)
      const pointer = createPointerDriver(notes)
      pointer.moveTo(shareOf(menu))
      expect(submenuFor('notes.txt')).toBeTruthy()

      await press('{ArrowLeft}')
      expect(submenuFor('notes.txt')).toBeNull()
      pointer.microMove()
      expect(submenuFor('notes.txt')).toBeNull()
      pointer.microMove()
      expect(submenuFor('notes.txt')).toBeNull()
      expect(document.activeElement).toBe(shareOf(menu))
      await press('{Escape}')
      expect(rowMenu('notes.txt')).toBeNull()
    })

    it('S-21a a click that closes the submenu disarms hover until the pointer leaves Share', async () => {
      const { notes } = await openDrawerTree()
      const menu = await openByKeyboard(notes)
      const pointer = createPointerDriver(notes)
      pointer.moveTo(shareOf(menu))
      expect(submenuFor('notes.txt')).toBeTruthy()

      pointer.click()
      pointer.microMove()
      expect(submenuFor('notes.txt')).toBeNull()
      pointer.moveTo(rename(menu))
      pointer.moveTo(shareOf(menu))
      expect(submenuFor('notes.txt')).toBeTruthy()
    })

    it('S-21b returning from the submenu to Share after Escape reopens it', async () => {
      const { notes } = await openDrawerTree()
      const menu = await openByKeyboard(notes)
      const pointer = createPointerDriver(notes)
      pointer.moveTo(shareOf(menu))
      pointer.moveTo(enabledItems(submenuFor('notes.txt')!)[0]!)

      await press('{Escape}')
      expect(submenuFor('notes.txt')).toBeNull()
      // The submenu is gone; the pointer now rests on the panel beside Share.
      pointer.layoutShiftTo(menu)
      pointer.moveTo(shareOf(menu))
      expect(submenuFor('notes.txt')).toBeTruthy()
    })

    it('S-22 Share reached by a still-pointer scroll stays closed after ArrowRight and Escape', async () => {
      const { notes } = await openDrawerTree()
      const menu = await openByKeyboard(notes)
      const pointer = createPointerDriver(notes)
      pointer.moveTo(rename(menu))
      pointer.layoutShiftTo(shareOf(menu))
      expect(submenuFor('notes.txt')).toBeNull()

      await press('{ArrowRight}')
      expect(submenuFor('notes.txt')).toBeTruthy()
      await press('{Escape}')
      pointer.microMove()
      expect(submenuFor('notes.txt')).toBeNull()
      // A second tremor: the first one may have re-armed the hover after
      // React's handler already read it.
      pointer.microMove()
      expect(submenuFor('notes.txt')).toBeNull()
      expect(document.activeElement).toBe(shareOf(menu))
      await press('{Escape}')
      expect(rowMenu('notes.txt')).toBeNull()
    })

    it('S-24 a still-pointer scroll away from Share and back does not re-arm hover', async () => {
      const { notes } = await openDrawerTree()
      const menu = await openByKeyboard(notes)
      const pointer = createPointerDriver(notes)
      pointer.moveTo(shareOf(menu))
      expect(submenuFor('notes.txt')).toBeTruthy()
      await press('{Escape}')

      await press('{End}')
      act(() => {
        fireEvent.scroll(menu)
      })
      pointer.layoutShiftTo(rename(menu))
      await press('{Home}')
      act(() => {
        fireEvent.scroll(menu)
      })
      pointer.layoutShiftTo(shareOf(menu))
      pointer.microMove()
      expect(submenuFor('notes.txt')).toBeNull()
      // A second tremor: the first one may have re-armed the hover after
      // React's handler already read it.
      pointer.microMove()
      expect(submenuFor('notes.txt')).toBeNull()
      expect(document.activeElement).toBe(shareOf(menu))
      await press('{Escape}')
      expect(rowMenu('notes.txt')).toBeNull()
    })

    it('S-25 a panel opened under the pointer does not open Share as the pointer leaves it', async () => {
      const { notes } = await openDrawerTree()
      const menu = await openByKeyboard(notes)
      const pointer = createPointerDriver(notes)
      pointer.layoutShiftTo(shareOf(menu))

      pointer.moveTo(notes)
      expect(submenuFor('notes.txt')).toBeNull()
      expect(document.activeElement).toBe(shareOf(menu))
      pointer.moveTo(shareOf(menu))
      expect(submenuFor('notes.txt')).toBeTruthy()
    })
  })
})
