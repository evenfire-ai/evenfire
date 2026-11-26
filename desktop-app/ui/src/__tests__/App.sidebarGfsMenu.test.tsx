// @vitest-environment jsdom
import { StrictMode } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
import fc, { type AsyncCommand, type Scheduler } from 'fast-check'
import { ERROR_TOAST_DURATION_MS } from '@constants/toasts'
import { installAppControllerClerum } from '@hooks/domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '@hooks/domain/__tests__/__fixtures__/mockClerum'
import { resolveGfsPreview } from '@lib/gfsPreview'
import { buildGfsResourceActions, getGfsMenuActions } from '@lib/gfsResourceActions'
import {
  gfsActionNeedsAffordances,
  gfsPendingRowActionAvailability,
  gfsRowActionAvailability,
} from '@lib/gfsRowActionAvailability'
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
import {
  type ChromiumFocusShim,
  chromiumFocusRejection,
  installChromiumFocusShim,
  uninstallChromiumFocusShim,
} from './__fixtures__/chromiumFocusShim'
import { type PointerDriver, createPointerDriver } from './__fixtures__/pointerDriver'

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
    { action: 'Delete', row: 'notes.txt', dialog: 'Delete notes.txt?' },
    { action: 'Rename', row: 'notes.txt', dialog: 'Rename file' },
    { action: 'New folder', row: 'Reports', dialog: 'New folder' },
    { action: 'Share', row: 'notes.txt', dialog: 'Share file notes.txt' },
    { action: 'Move to', row: 'notes.txt', dialog: 'Move file notes.txt' },
  ])(
    'Escape in the compact drawer with the host $action dialog open leaves the drawer open',
    async ({ action, row, dialog: dialogName }) => {
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
      await waitFor(() => expect(dialog.isConnected).toBe(false))
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

    it('Shift+F10 on a tree row focuses Share, and ArrowDown reaches the next item', async () => {
      const { notes } = await openDrawerTree()
      const menu = await openByKeyboard(notes)

      expect(document.activeElement).toBe(shareOf(menu))
      await press('{ArrowDown}')
      expect(document.activeElement).toBe(enabledItems(menu)[1])
    })

    it('a right-click on a tree row focuses Share, and ArrowDown reaches the next item', async () => {
      const { notes } = await openDrawerTree()
      createPointerDriver(notes).contextClick()
      const menu = await screen.findByRole('menu', { name: 'Actions for notes.txt' })

      expect(document.activeElement).toBe(shareOf(menu))
      await press('{ArrowDown}')
      expect(document.activeElement).toBe(enabledItems(menu)[1])
    })

    it('bits that settle after the menu opened leave focus on Share', async () => {
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

    it('bits that settle after ArrowDown leave focus on the item the user reached', async () => {
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

    it('moving the pointer onto Share with focus on Rename moves focus into the submenu', async () => {
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

    it('Escape after the bits failed closes the menu and leaves the drawer open', async () => {
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

    it('bits that settle after the menu closed move no focus', async () => {
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

    it('under StrictMode the menu takes entry focus once, and Escape returns it to the row', async () => {
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

    it('a scroll or resize after ArrowDown leaves focus where the user put it', async () => {
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

    it('Escape closes the menu first and leaves the drawer open; a second Escape closes the drawer', async () => {
      const { notes } = await openDrawerTree()
      await openByKeyboard(notes)

      await press('{Escape}')
      expect(rowMenu('notes.txt')).toBeNull()
      expect(drawerOpen()).toBe(true)
      expect(document.activeElement).toBe(notes)
      await press('{Escape}')
      expect(drawerOpen()).toBe(false)
    })

    it('ArrowRight on Share focuses the submenu, and ArrowLeft returns to Share', async () => {
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

    it('a contextmenu on the panel or the submenu never reaches the native menu', async () => {
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

    it('hover then ArrowRight keeps focus in the submenu; Escape closes only the submenu', async () => {
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

    it('a click on Share after hover closes the submenu and leaves focus on Share', async () => {
      const { notes } = await openDrawerTree()
      const menu = await openByKeyboard(notes)
      const pointer = createPointerDriver(notes)
      pointer.moveTo(shareOf(menu))
      expect(submenuFor('notes.txt')).toBeTruthy()

      pointer.click()
      expect(submenuFor('notes.txt')).toBeNull()
      expect(document.activeElement).toBe(shareOf(menu))
    })

    it('Share arriving under a still pointer does not open the submenu', async () => {
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

    it('a submenu that covered Share and closes does not reopen under a still pointer', async () => {
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

    it('after Escape closes the hovered submenu, a tremor on Share does not reopen it', async () => {
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

    it('after ArrowLeft closes the hovered submenu, tremors on Share do not reopen it', async () => {
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

    it('a click that closes the submenu disarms hover until the pointer leaves Share', async () => {
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

    it('returning from the submenu to Share after Escape reopens it', async () => {
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

    it('Share reached by a still-pointer scroll stays closed after ArrowRight and Escape', async () => {
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

    it('a still-pointer scroll away from Share and back does not re-arm hover', async () => {
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

    it('a panel opened under the pointer does not open Share as the pointer leaves it', async () => {
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

  // Model-based oracle for the row menu's focus, levels and Share hover
  // arming. Generated sequences of user events run on the real App (host,
  // drawer, tree and menu); `fc.scheduler()` decides in which order the
  // affordance reads of an opening land. At rest every command checks the
  // DOM against a trivial model: a stack of open levels, the key that holds
  // focus on each, where the pointer physically is, and whether it moved
  // outside Share since the menu opened or the submenu was last closed or
  // activated. Mocks stay at the boundary: the affordance reads and
  // Chromium's focus rules (the shim).
  describe('model-based oracle', () => {
    type Row = 'notes' | 'summary'
    // `okWithoutParent`: the row's bits arrived and its parent's read failed,
    // so only Move is withheld.
    type Bits = 'ok' | 'pending' | 'error' | 'okWithoutParent'
    type Read = 'row' | 'parent'
    type Answer = 'pending' | 'ok' | 'error'
    type Spot = 'fuera' | 'share' | 'submenu' | 'otro'
    type LevelKeys = { panel: string[]; submenu: string[] }

    const SUMMARY_ID = 'e5'.repeat(16)
    const ALL_BITS = ['read', 'write', 'delete', 'manage_acl']
    const ROW_NAME: Record<Row, string> = { notes: 'notes.txt', summary: 'summary.txt' }
    const NOTES = accessibleResource(NOTES_ID, 'notes.txt', 'file', {
      version: 3,
      permissions: ALL_BITS,
    })
    const SUMMARY = childView(SUMMARY_ID, 'summary.txt', 'file', { parentResourceId: REPORTS_ID })

    /**
     * The enabled item keys of each level, in order, per opened row and bit
     * state. A forest root opens settled; the nested file opens pending and
     * settles once both its own read and its parent's have answered. Pinned
     * against the producers in the first test.
     */
    const ENABLED: Record<Row, Partial<Record<Bits, LevelKeys>>> = {
      notes: {
        ok: {
          panel: ['share', 'rename', 'preview', 'download', 'delete'],
          submenu: ['share-access', 'copy-link'],
        },
      },
      summary: {
        pending: {
          panel: ['share', 'preview', 'download'],
          submenu: ['copy-link'],
        },
        ok: {
          panel: ['share', 'rename', 'move', 'preview', 'download', 'delete'],
          submenu: ['share-access', 'copy-link'],
        },
        error: {
          panel: ['share', 'preview', 'download'],
          submenu: ['copy-link'],
        },
        okWithoutParent: {
          panel: ['share', 'rename', 'preview', 'download', 'delete'],
          submenu: ['share-access', 'copy-link'],
        },
      },
    }

    /**
     * The same keys from the producers the tree builds its menu with
     * (`gfsPendingRowActionAvailability` / `gfsRowActionAvailability`, then
     * the resource actions), with the menu's two layout rules: Share and
     * Copy link go in the submenu behind a Share item that leads the
     * panel, Delete closes it, and unsettled bits leave inert every action
     * that needs them.
     */
    function producedKeys(row: Row, bits: Bits): LevelKeys {
      const resource = row === 'notes' ? { ...NOTES, parentResourceId: null } : SUMMARY
      const held = heldPermissionResponse(ALL_BITS)
      const settled = bits === 'ok' || bits === 'okWithoutParent'
      const availability = settled
        ? gfsRowActionAvailability({
            resource,
            listing: row === 'notes' ? 'roots' : 'folder',
            rowAffordances: row === 'notes' ? null : held,
            parentAffordances: row === 'notes' || bits === 'okWithoutParent' ? null : held,
          })
        : gfsPendingRowActionAvailability(resource)
      const handler = () => undefined
      const canPreview = resolveGfsPreview(resource) !== null
      const actions = getGfsMenuActions(
        buildGfsResourceActions({
          kind: 'file',
          uri: resource.gfsUri,
          handlers: {
            'copy-link': handler,
            'new-folder': handler,
            'upload-file': handler,
            rename: handler,
            move: handler,
            share: handler,
            delete: handler,
            preview: canPreview ? handler : undefined,
            download: handler,
          },
          canRename: availability.canRename,
          canMove: availability.canMove,
          canCreateFolder: false,
          canUpload: false,
          canShare: availability.canManage,
          canDelete: availability.canDelete,
          canPreview,
          canDownload: true,
          mutating: false,
        })
      )
      const enabled = (action: (typeof actions)[number]) =>
        !action.disabled && (settled || !gfsActionNeedsAffordances(action.id))
      const inSubmenu = (id: string) => ['share', 'copy-link'].includes(id)
      const submenuActions = actions.filter(action => inSubmenu(action.id))
      return {
        panel: [
          ...(submenuActions.length > 0 ? ['share'] : []),
          ...actions
            .filter(action => !inSubmenu(action.id) && action.id !== 'delete' && enabled(action))
            .map(action => action.id),
          ...actions
            .filter(action => action.id === 'delete' && enabled(action))
            .map(() => 'delete'),
        ],
        submenu: submenuActions
          .filter(enabled)
          .map(action => (action.id === 'share' ? 'share-access' : action.id)),
      }
    }

    type Model = {
      drawer: boolean
      menu: {
        row: Row
        bits: Bits
        /** Key with focus on the panel; meaningful while no submenu is open. */
        focus: string
        submenu: { focus: string } | null
        /** The nested row's two reads, as this opening waits for them. */
        reads: Record<Read, Answer> | null
      } | null
      /** The row the last menu opened from: Escape returns focus there. */
      opener: Row | null
      pointer: Spot
      movedOutSinceClose: boolean
      /** Reads sent to main and not answered yet; a new opening shares them. */
      inFlight: Record<Read, boolean>
      /** `focus()` calls the menu itself makes, one per focus move it owns. */
      menuFocusCalls: number
    }

    type World = {
      s: Scheduler
      queryClient: QueryClient
      pointer: PointerDriver
      shim: ChromiumFocusShim
      /** Held answers, by resource id. */
      releases: Map<string, Array<(outcome: 'ok' | 'error') => void>>
      stats: { opened: boolean; executed: number }
    }

    type Cmd = AsyncCommand<Model, World>

    const MENU_MODULE = 'GfsResourceMenu/index.tsx'
    const READ_RESOURCE: Record<Read, string> = { row: SUMMARY_ID, parent: REPORTS_ID }
    const keysOf = (m: Model) => ENABLED[m.menu!.row][m.menu!.bits]!
    let affordanceFailure = ''
    const coverage = new Map<string, number>()
    const cover = (label: string) => coverage.set(label, (coverage.get(label) ?? 0) + 1)

    // ── Real-side lookups ─────────────────────────────────────────────────
    const rowEl = (row: Row) => screen.getByRole('button', { name: ROW_NAME[row] })
    const menuEls = () =>
      screen
        .queryAllByRole('menu')
        .filter(menu => menu.getAttribute('aria-label')?.startsWith('Actions for '))
    const submenuEls = () =>
      screen
        .queryAllByRole('menu')
        .filter(menu => menu.getAttribute('aria-label')?.startsWith('Share options for '))
    const item = (level: HTMLElement, key: string) =>
      level.querySelector<HTMLElement>(`[role="menuitem"][data-gfs-action="${key}"]`)!
    const enabledKeys = (level: HTMLElement) =>
      Array.from(level.querySelectorAll('[role="menuitem"]:not(:disabled)')).map(
        node => node.getAttribute('data-gfs-action') ?? ''
      )
    function spotEl(spot: Spot): Element {
      if (spot === 'fuera') return rowEl('notes')
      if (spot === 'submenu') return item(submenuEls()[0]!, 'copy-link')
      // Download is enabled in every bit state, so the pointer never rests
      // on an inert control that Chromium would not send mouse events to.
      return item(menuEls()[0]!, spot === 'share' ? 'share' : 'download')
    }

    // ── Model transitions ─────────────────────────────────────────────────
    function openSubmenu(m: Model) {
      m.menu!.submenu = { focus: keysOf(m).submenu[0]! }
      m.menuFocusCalls += 1
    }
    /** An explicit close of the submenu: focus back on Share, hover disarmed. */
    function closeSubmenu(m: Model) {
      m.menu!.submenu = null
      m.menu!.focus = 'share'
      m.movedOutSinceClose = false
      m.menuFocusCalls += 1
      if (m.pointer === 'submenu') m.pointer = 'fuera'
    }
    /** One pointermove where the pointer is: over Share it may open, elsewhere it arms. */
    function pointerStep(m: Model, at: Spot) {
      if (at !== 'share') {
        m.movedOutSinceClose = true
        return
      }
      if (m.movedOutSinceClose && m.menu && !m.menu.submenu) {
        openSubmenu(m)
        cover('hover-opened')
      }
    }

    // ── Rest and invariants ───────────────────────────────────────────────
    async function rest(w: World) {
      for (let pass = 0; pass < 200; pass += 1) {
        if (w.s.count() > 0) {
          await act(async () => {
            await w.s.waitOne()
          })
          continue
        }
        await flushFrames()
        await act(async () => {
          await new Promise(resolve => window.setTimeout(resolve, 0))
        })
        if (w.s.count() === 0 && frames.length === 0) return
      }
      throw new Error('the menu never came to rest')
    }

    /** The pointer rests on what is left under it once its element is gone. */
    function settlePointer(w: World) {
      if (!w.pointer.at.isConnected) w.pointer.layoutShiftTo(spotEl('fuera'))
    }

    function checkAtRest(m: Model, w: World) {
      const active = document.activeElement as HTMLElement | null
      // S1: never a hidden, inert, detached or disabled element.
      if (active && active !== document.body) {
        expect(chromiumFocusRejection(active), 'S1: focus on a hidden element').toBeNull()
        expect((active as HTMLButtonElement).disabled ?? false, 'S1: disabled').toBe(false)
      }
      // S2: one level per Escape, so the open levels match the model's stack.
      expect(drawerOpen(), 'drawer level').toBe(m.drawer)
      const menus = menuEls()
      const submenus = submenuEls()
      expect(menus.length, 'menu level').toBe(m.menu ? 1 : 0)
      expect(submenus.length, 'submenu level').toBe(m.menu?.submenu ? 1 : 0)
      if (m.menu) {
        const keys = keysOf(m)
        expect(menus[0]!.getAttribute('aria-label')).toBe(`Actions for ${ROW_NAME[m.menu.row]}`)
        expect(enabledKeys(menus[0]!), 'panel keys').toEqual(keys.panel)
        // V1′ / V1 and S3: focus on the key the model holds for the top level.
        if (m.menu.submenu) {
          expect(enabledKeys(submenus[0]!), 'submenu keys').toEqual(keys.submenu)
          expect(submenus[0]!.contains(active), 'V1′: focus in the submenu').toBe(true)
          expect(active?.getAttribute('data-gfs-action'), 'V1′: submenu key').toBe(
            m.menu.submenu.focus
          )
        } else {
          expect(menus[0]!.contains(active), 'V1: focus in the panel').toBe(true)
          expect(active?.getAttribute('data-gfs-action'), 'V1: panel key').toBe(m.menu.focus)
        }
      } else if (m.drawer && m.opener) {
        // V3: Escape returned focus to the row the menu opened from.
        expect(active, 'V3: focus on the opener').toBe(rowEl(m.opener))
      }
      // The reads main still owes are the ones the model says are in flight,
      // exactly one per resource: a reopening shares the pending read.
      for (const [read, id] of Object.entries(READ_RESOURCE) as [Read, string][]) {
        expect(w.releases.get(id)?.length ?? 0, `${read} read in flight`).toBe(
          m.inFlight[read] ? 1 : 0
        )
      }
      expect(
        [...w.releases].filter(
          ([id, held]) => held.length > 0 && !Object.values(READ_RESOURCE).includes(id)
        ),
        'reads of other resources'
      ).toEqual([])
      // C1: the menu moves focus only when the model says it does, and never
      // onto an element Chromium refuses.
      const calls = w.shim.callsFrom(MENU_MODULE)
      expect(
        calls.filter(call => call.rejected).map(call => call.rejected),
        'C1: refused focus calls'
      ).toEqual([])
      expect(calls.length, 'C1: menu focus calls').toBe(m.menuFocusCalls)
    }

    // ── Commands ──────────────────────────────────────────────────────────
    const press = (keys: string) => userEvent.setup().keyboard(keys)

    abstract class MenuCommand implements Cmd {
      abstract check: (m: Readonly<Model>) => boolean
      abstract toString: () => string
      protected abstract perform(m: Model, w: World): Promise<void> | void
      async run(m: Model, w: World) {
        w.stats.executed += 1
        if (
          m.menu?.reads &&
          Object.values(m.menu.reads).filter(a => a === 'pending').length === 1
        ) {
          cover('between-reads')
        }
        await this.perform(m, w)
        await rest(w)
        settlePointer(w)
        checkAtRest(m, w)
      }
    }

    class Open extends MenuCommand {
      constructor(
        readonly row: Row,
        readonly gesture: 'E1' | 'E2',
        readonly pointerAt: 'fuera' | 'share'
      ) {
        super()
      }
      check = (m: Readonly<Model>) => m.drawer && !m.menu
      async perform(m: Model, w: World) {
        // Idle cached bits would settle the next opening in a microtask
        // without passing through the scheduler. That warm-cache opening is
        // real behaviour the model leaves out: S-4 covers focus when the bits
        // are already settled on open. A read still in flight is shared.
        w.queryClient.removeQueries({
          predicate: query =>
            query.queryKey[3] === 'affordances' && query.state.fetchStatus === 'idle',
        })
        const row = rowEl(this.row)
        if (this.gesture === 'E1') {
          act(() => row.focus())
          await press('{Shift>}{F10}{/Shift}')
        } else {
          if (w.pointer.at !== row) w.pointer.moveTo(row)
          w.pointer.contextClick()
        }
        await rest(w)
        // The panel appears under the still pointer.
        if (this.pointerAt === 'share') w.pointer.layoutShiftTo(spotEl('share'))
        const bits: Bits = this.row === 'notes' ? 'ok' : 'pending'
        m.menu = {
          row: this.row,
          bits,
          focus: ENABLED[this.row][bits]!.panel[0]!,
          submenu: null,
          reads: null,
        }
        m.opener = this.row
        m.movedOutSinceClose = false
        m.pointer = this.pointerAt
        if (bits === 'pending') {
          m.menu.reads = { row: 'pending', parent: 'pending' }
          m.inFlight = { row: true, parent: true }
        }
        w.stats.opened = true
        m.menuFocusCalls += 1
        cover(`open:${this.row}:${this.gesture}:${this.pointerAt}`)
      }
      toString = () => `Open(${this.row}, ${this.gesture}, ${this.pointerAt})`
    }

    /** One of the nested row's reads answers; the scheduler orders it. */
    class SettleRead extends MenuCommand {
      constructor(
        readonly read: Read,
        readonly outcome: 'ok' | 'error'
      ) {
        super()
      }
      check = (m: Readonly<Model>) => m.inFlight[this.read]
      perform(m: Model, w: World) {
        const id = READ_RESOURCE[this.read]
        for (const release of w.releases.get(id)?.splice(0) ?? []) release(this.outcome)
        m.inFlight[this.read] = false
        const reads = m.menu?.reads
        if (!reads || reads[this.read] !== 'pending') {
          cover('settle:after-close')
          return
        }
        reads[this.read] = this.outcome
        if (reads.row === 'pending' || reads.parent === 'pending') {
          cover('settle:first-of-two')
          return
        }
        // The tree waits for both reads; a failed row read fails the menu,
        // a failed parent read withholds only Move.
        m.menu!.bits =
          reads.row === 'error' ? 'error' : reads.parent === 'error' ? 'okWithoutParent' : 'ok'
        cover(`settle:${m.menu!.bits}`)
      }
      toString = () => `SettleRead(${this.read}, ${this.outcome})`
    }

    class Nav extends MenuCommand {
      constructor(readonly key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End') {
        super()
      }
      check = (m: Readonly<Model>) => Boolean(m.menu)
      async perform(m: Model) {
        await press(`{${this.key}}`)
        const menu = m.menu!
        const level = menu.submenu ? keysOf(m).submenu : keysOf(m).panel
        const current = level.indexOf(menu.submenu ? menu.submenu.focus : menu.focus)
        const next =
          this.key === 'Home'
            ? 0
            : this.key === 'End'
              ? level.length - 1
              : this.key === 'ArrowDown'
                ? (current + 1) % level.length
                : (current - 1 + level.length) % level.length
        if (menu.submenu) menu.submenu.focus = level[next]!
        else menu.focus = level[next]!
        m.menuFocusCalls += 1
      }
      toString = () => `Nav(${this.key})`
    }

    class ActivateShare extends MenuCommand {
      constructor(readonly key: 'ArrowRight' | 'Enter') {
        super()
      }
      check = (m: Readonly<Model>) => Boolean(m.menu && !m.menu.submenu && m.menu.focus === 'share')
      async perform(m: Model) {
        await press(`{${this.key}}`)
        // Enter activates Share like a click; ArrowRight only opens.
        if (this.key === 'Enter') m.movedOutSinceClose = false
        openSubmenu(m)
      }
      toString = () => `ActivateShare(${this.key})`
    }

    class MoveTo extends MenuCommand {
      constructor(readonly spot: Spot) {
        super()
      }
      check = (m: Readonly<Model>) =>
        Boolean(m.menu) &&
        m.pointer !== this.spot &&
        (this.spot !== 'submenu' || Boolean(m.menu!.submenu))
      perform(m: Model, w: World) {
        w.pointer.moveTo(spotEl(this.spot))
        // The first step of a move is still at its origin.
        pointerStep(m, m.pointer)
        pointerStep(m, this.spot)
        m.pointer = this.spot
      }
      toString = () => `MoveTo(${this.spot})`
    }

    class Tremor extends MenuCommand {
      check = (m: Readonly<Model>) => Boolean(m.menu)
      perform(m: Model, w: World) {
        w.pointer.microMove()
        pointerStep(m, m.pointer)
        if (m.pointer === 'share') cover('tremor-on-share')
      }
      toString = () => 'Tremor'
    }

    /** E6e, or a still-pointer scroll: the element under the pointer changes, nothing moves. */
    class StillShift extends MenuCommand {
      constructor(
        readonly to: 'share' | 'otro',
        readonly scroll: boolean
      ) {
        super()
      }
      check = (m: Readonly<Model>) => Boolean(m.menu) && m.pointer !== this.to
      perform(m: Model, w: World) {
        if (this.scroll) {
          act(() => {
            fireEvent.scroll(menuEls()[0]!)
          })
        }
        w.pointer.layoutShiftTo(spotEl(this.to))
        m.pointer = this.to
      }
      toString = () => `StillShift(${this.to}${this.scroll ? ', scroll' : ''})`
    }

    class ClickShare extends MenuCommand {
      check = (m: Readonly<Model>) => Boolean(m.menu) && m.pointer === 'share'
      perform(m: Model, w: World) {
        w.pointer.click()
        // The press focuses Share (Chromium's own focus, not the menu's);
        // the click toggles the submenu and always disarms the hover.
        m.movedOutSinceClose = false
        if (m.menu!.submenu) {
          m.menu!.submenu = null
          m.menu!.focus = 'share'
        } else {
          openSubmenu(m)
        }
        cover('click-share')
      }
      toString = () => 'ClickShare'
    }

    class ArrowLeft extends MenuCommand {
      check = (m: Readonly<Model>) => Boolean(m.menu)
      async perform(m: Model) {
        await press('{ArrowLeft}')
        if (m.menu!.submenu) {
          closeSubmenu(m)
          cover('arrowleft-close')
        }
      }
      toString = () => 'ArrowLeft'
    }

    class Escape extends MenuCommand {
      check = (m: Readonly<Model>) => m.drawer && Boolean(m.menu)
      async perform(m: Model) {
        await press('{Escape}')
        if (m.menu!.submenu) {
          closeSubmenu(m)
          cover('escape:submenu')
        } else {
          m.menu = null
          m.pointer = 'fuera'
          m.menuFocusCalls += 1
          cover('escape:menu')
        }
      }
      toString = () => 'Escape'
    }

    /** Escape with no menu closes the drawer, which ends what a run can do. */
    class CloseDrawer extends MenuCommand {
      check = (m: Readonly<Model>) => m.drawer && !m.menu
      async perform(m: Model) {
        await press('{Escape}')
        m.drawer = false
        cover('escape:drawer')
      }
      toString = () => 'CloseDrawer'
    }

    class Resize extends MenuCommand {
      check = (m: Readonly<Model>) => Boolean(m.menu)
      perform() {
        act(() => {
          window.dispatchEvent(new Event('resize'))
        })
      }
      toString = () => 'Resize'
    }

    /** S4 is checked when the event fires, not at rest. */
    class ContextMenuOnFocus extends MenuCommand {
      check = (m: Readonly<Model>) => Boolean(m.menu)
      perform() {
        const target = document.activeElement as HTMLElement
        const event = createEvent.contextMenu(target)
        fireEvent(target, event)
        expect(event.defaultPrevented, 'S4: contextmenu reached the native menu').toBe(true)
        cover('contextmenu')
      }
      toString = () => 'ContextMenuOnFocus'
    }

    // ── World ─────────────────────────────────────────────────────────────
    async function mountWorld(s: Scheduler): Promise<{ model: Model; real: World }> {
      frames.length = 0
      mediaListeners.clear()
      compact = true
      const { bridge } = installBridge()
      bridge.gfs.listAccessible = vi.fn(async () =>
        listAccessiblePage([
          accessibleResource(REPORTS_ID, 'Reports', 'directory', { permissions: ['read'] }),
          NOTES,
        ])
      )
      bridge.gfs.listChildren = vi.fn(async (resourceId: string) =>
        listChildrenPage(resourceId === REPORTS_ID ? [SUMMARY] : [])
      )
      const queryClient = renderApp()
      await waitForShell()
      fireEvent.click(screen.getByTestId('compact-navigation-toggle'))
      openExplorer()
      fireEvent.click(await screen.findByRole('button', { name: 'Expand Reports' }))
      await screen.findByRole('button', { name: 'summary.txt' })
      await flushFrames()

      const produce = appServiceAffordanceProducer(async () => heldPermissionResponse(ALL_BITS))
      const releases: World['releases'] = new Map()
      // Every read waits for a Settle, which hands it to the scheduler.
      bridge.gfs.affordances = vi.fn(
        (resourceId: string, drive = 'main') =>
          new Promise(resolve => {
            if (!releases.has(resourceId)) releases.set(resourceId, [])
            releases.get(resourceId)!.push(outcome =>
              resolve(
                s.schedule(Promise.resolve(), `affordances ${resourceId}`).then(() => {
                  if (outcome === 'error') throw new Error(affordanceFailure)
                  return produce(resourceId, drive)
                })
              )
            )
          })
      )
      const real: World = {
        s,
        queryClient,
        pointer: createPointerDriver(rowEl('notes')),
        shim: installChromiumFocusShim(),
        releases,
        stats: { opened: false, executed: 0 },
      }
      const model: Model = {
        drawer: true,
        menu: null,
        opener: null,
        pointer: 'fuera',
        movedOutSinceClose: false,
        inFlight: { row: false, parent: false },
        menuFocusCalls: 0,
      }
      return { model, real }
    }

    async function unmountWorld(w: World | undefined) {
      uninstallChromiumFocusShim()
      if (w) {
        // Reads left pending resolve into a tree that is about to unmount.
        for (const held of w.releases.values()) for (const release of held.splice(0)) release('ok')
        await act(async () => {
          await w.s.waitAll()
        })
        w.queryClient.clear()
      }
      cleanup()
      uninstallMockClerum()
    }

    // ── Arbitraries and fixed examples ────────────────────────────────────
    const weighted = (weight: number, arbitrary: fc.Arbitrary<Cmd>) => ({ weight, arbitrary })
    const opening: fc.Arbitrary<Cmd> = fc
      .tuple(
        fc.constantFrom<Row>('notes', 'summary'),
        fc.constantFrom<'E1' | 'E2'>('E1', 'E2'),
        fc.constantFrom<'fuera' | 'share'>('fuera', 'share')
      )
      .map(([row, gesture, at]) => new Open(row, gesture, at))
    // Commands whose check fails are skipped, so Open weighs most: every
    // other command needs a menu. Closing the drawer ends the run's useful
    // part and weighs least.
    const commands: fc.Arbitrary<Cmd>[] = [
      fc.oneof(
        weighted(24, opening),
        weighted(
          8,
          fc
            .tuple(
              fc.constantFrom<Read>('row', 'parent'),
              fc.constantFrom<'ok' | 'error'>('ok', 'error')
            )
            .map(([read, outcome]) => new SettleRead(read, outcome))
        ),
        weighted(
          8,
          fc
            .constantFrom<
              'ArrowDown' | 'ArrowUp' | 'Home' | 'End'
            >('ArrowDown', 'ArrowUp', 'Home', 'End')
            .map(key => new Nav(key))
        ),
        weighted(
          6,
          fc
            .constantFrom<'ArrowRight' | 'Enter'>('ArrowRight', 'Enter')
            .map(key => new ActivateShare(key))
        ),
        weighted(
          12,
          fc.constantFrom<Spot>('fuera', 'share', 'submenu', 'otro').map(spot => new MoveTo(spot))
        ),
        // Tremors come often and in a row: the second of two reaches a re-arm
        // the first one caused.
        weighted(10, fc.constant(new Tremor())),
        weighted(
          3,
          fc
            .tuple(fc.constantFrom<'share' | 'otro'>('share', 'otro'), fc.boolean())
            .map(([to, scroll]) => new StillShift(to, scroll))
        ),
        weighted(6, fc.constant(new ClickShare())),
        weighted(4, fc.constant(new ArrowLeft())),
        weighted(6, fc.constant(new Escape())),
        weighted(2, fc.constant(new Resize())),
        weighted(2, fc.constant(new ContextMenuOnFocus())),
        weighted(1, fc.constant(new CloseDrawer()))
      ),
    ]

    const open = (
      row: Row = 'notes',
      gesture: 'E1' | 'E2' = 'E1',
      at: 'fuera' | 'share' = 'fuera'
    ) => new Open(row, gesture, at)
    /** Key paths every run of the suite includes, named after their A3 rows. */
    const EXAMPLES: Record<string, () => Cmd[]> = {
      // Escape after a hover open: tremors on Share do not reopen.
      H27: () => [
        open(),
        new MoveTo('share'),
        new Escape(),
        new Tremor(),
        new Tremor(),
        new Escape(),
      ],
      // A click closes and disarms; leaving Share and coming back reopens.
      H28: () => [
        open('notes', 'E2'),
        new MoveTo('share'),
        new ClickShare(),
        new Tremor(),
        new Tremor(),
        new MoveTo('otro'),
        new MoveTo('share'),
      ],
      // Back from the submenu to Share after Escape reopens it.
      H30: () => [
        open(),
        new MoveTo('share'),
        new MoveTo('submenu'),
        new Escape(),
        new MoveTo('share'),
      ],
      // Share slid under an armed still pointer: ArrowRight, Escape, tremors.
      H34: () => [
        open(),
        new MoveTo('otro'),
        new StillShift('share', true),
        new ActivateShare('ArrowRight'),
        new Escape(),
        new Tremor(),
        new Tremor(),
        new Escape(),
      ],
      // A still scroll away from Share and back does not re-arm.
      H35: () => [
        open(),
        new MoveTo('share'),
        new Escape(),
        new Nav('End'),
        new StillShift('otro', true),
        new Nav('Home'),
        new StillShift('share', true),
        new Tremor(),
        new Tremor(),
        new Escape(),
      ],
      // The tree's reopening: armed, closed, reopened under the pointer.
      H36: () => [
        open(),
        new MoveTo('otro'),
        new Escape(),
        open('notes', 'E1', 'share'),
        new Tremor(),
        new Tremor(),
        new Escape(),
      ],
      // Opened under the pointer: leaving Share arms, coming back opens.
      H37: () => [open('notes', 'E1', 'share'), new MoveTo('fuera'), new MoveTo('share')],
      // ArrowLeft closes and disarms like Escape.
      ArrowLeft: () => [
        open(),
        new MoveTo('share'),
        new ArrowLeft(),
        new Tremor(),
        new Tremor(),
        new Escape(),
      ],
      // Commands between the two reads, then each way the pair settles.
      Bits: () => [
        open('summary'),
        new Nav('ArrowDown'),
        new SettleRead('row', 'ok'),
        new Nav('ArrowDown'),
        new MoveTo('share'),
        new SettleRead('parent', 'ok'),
        new Escape(),
        new Escape(),
        open('summary', 'E2'),
        new ActivateShare('Enter'),
        new SettleRead('parent', 'error'),
        new Nav('ArrowDown'),
        new SettleRead('row', 'ok'),
        new Escape(),
        new Escape(),
        open('summary', 'E1', 'share'),
        new SettleRead('row', 'error'),
        new Tremor(),
        new SettleRead('parent', 'ok'),
        new Escape(),
      ],
      // Reads that land after the menu closed, and a reopening that shares
      // the read still in flight; then the drawer closes.
      LateBits: () => [
        open('summary'),
        new Escape(),
        new SettleRead('row', 'ok'),
        open('summary'),
        new SettleRead('parent', 'ok'),
        new SettleRead('row', 'ok'),
        new Escape(),
        new CloseDrawer(),
      ],
      // contextmenu on the panel and the submenu, scroll and resize at rest.
      Surfaces: () => [
        open(),
        new ContextMenuOnFocus(),
        new Nav('ArrowDown'),
        new StillShift('otro', true),
        new Resize(),
        new Nav('Home'),
        new ActivateShare('ArrowRight'),
        new ContextMenuOnFocus(),
        new Resize(),
      ],
    }

    const RUNS = Number(process.env.GFS_MENU_ORACLE_RUNS ?? 100)
    // Fixed by default so every run explores the same cases;
    // GFS_MENU_ORACLE_SEED picks another, and `random` opts into a fresh one.
    const SEED_SETTING = process.env.GFS_MENU_ORACLE_SEED ?? '20261121'
    const SEED = SEED_SETTING === 'random' ? undefined : Number(SEED_SETTING)
    // `off` runs only the generated sequences, to measure how many draws a
    // defect needs without the fixed examples.
    const WITH_EXAMPLES = process.env.GFS_MENU_ORACLE_EXAMPLES !== 'off'
    const exampleScheduler = () => fc.sample(fc.scheduler(), { seed: 2111, numRuns: 1 })[0]!

    beforeAll(async () => {
      affordanceFailure = await affordancesFailureMessage(500)
    })

    it('pins the enabled keys of each level to the producers', () => {
      for (const row of Object.keys(ENABLED) as Row[]) {
        for (const bits of Object.keys(ENABLED[row]) as Bits[]) {
          expect(producedKeys(row, bits), `${row} ${bits}`).toEqual(ENABLED[row][bits])
        }
      }
    })

    it('keeps focus, levels, hover arming and focus cost on the model at rest', async () => {
      coverage.clear()
      const examples = WITH_EXAMPLES ? Object.values(EXAMPLES).map(build => build()) : []
      const exampleRuns = new WeakSet<object>(examples)
      // Zero runs with the examples off would let fc.assert pass on nothing.
      expect(RUNS + examples.length, 'oracle runs').toBeGreaterThan(0)
      const generated: Array<World['stats']> = []
      await fc.assert(
        fc.asyncProperty(
          fc.scheduler(),
          // Every generated run starts by opening a menu: before that only
          // Open and CloseDrawer apply.
          fc
            .tuple(opening, fc.commands(commands, { maxCommands: 60, size: 'max' }))
            .map(([first, rest]): Iterable<Cmd> => [first, ...rest]),
          async (s, cmds) => {
            let world: { model: Model; real: World } | undefined
            try {
              world = await mountWorld(s)
              const { model, real } = world
              await fc.asyncModelRun(() => ({ model, real }), cmds)
            } finally {
              if (world && !exampleRuns.has(cmds)) generated.push(world.real.stats)
              await unmountWorld(world?.real)
            }
          }
        ),
        {
          numRuns: RUNS + examples.length,
          seed: SEED,
          // Shrinking remounts the App for every candidate: worth it locally,
          // too slow for CI, as in the host's oracle.
          endOnFailure: Boolean(process.env.CI),
          interruptAfterTimeLimit: 150_000,
          markInterruptAsFailure: true,
          examples: examples.map(cmds => [exampleScheduler(), cmds] as [Scheduler, Iterable<Cmd>]),
        }
      )
      const opened = generated.filter(stats => stats.opened).length
      const executed = generated.reduce((sum, stats) => sum + stats.executed, 0)
      process.stdout.write(
        `gfs menu oracle: ${generated.length} generated runs, ${opened} opened a menu, ` +
          `${(executed / Math.max(1, generated.length)).toFixed(1)} commands each; ` +
          `coverage ${JSON.stringify(Object.fromEntries([...coverage].sort()))}\n`
      )
      // Guard against a vacuous pass, on the generated runs alone: they open a
      // menu and run a real sequence (measured: every run opens, 14 to 17
      // commands run on average across seeds).
      expect(generated.length, 'generated runs').toBe(RUNS)
      if (RUNS > 0) {
        expect(opened / RUNS, 'generated runs that open a menu').toBeGreaterThanOrEqual(0.95)
        expect(executed / RUNS, 'commands per generated run').toBeGreaterThanOrEqual(10)
      }
      if (WITH_EXAMPLES) {
        // The fixed examples reach every path by construction.
        for (const label of [
          'hover-opened',
          'tremor-on-share',
          'click-share',
          'arrowleft-close',
          'escape:submenu',
          'escape:menu',
          'escape:drawer',
          'settle:ok',
          'settle:error',
          'settle:okWithoutParent',
          'settle:first-of-two',
          'settle:after-close',
          'between-reads',
          'contextmenu',
        ]) {
          expect(coverage.get(label) ?? 0, label).toBeGreaterThan(0)
        }
      }
    }, 200_000)
  })
})
