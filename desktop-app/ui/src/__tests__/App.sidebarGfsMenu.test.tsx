// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { installAppControllerClerum } from '@hooks/domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '@hooks/domain/__tests__/__fixtures__/mockClerum'
import { App } from '@/App'
import {
  accessibleResource,
  affordancesResult,
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

function installBridge() {
  const { handle } = installAppControllerClerum({ agentNames: ['agent-x'] })
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
  bridge.shortcuts = { onCommand: vi.fn(() => vi.fn()) }
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
  return { bridge }
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
    cleanup()
    await new Promise(resolve => window.setTimeout(resolve, 0))
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    uninstallMockClerum()
  })

  it('S-7b: crossing the compact threshold with the menu open keeps the native view hidden', async () => {
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

  it('S-7c: unmounting the tree with the menu open uncovers the native view', async () => {
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

  it('S-12: Escape in the compact drawer closes the menu first, then the drawer', async () => {
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
    'S-12b: Escape in the compact drawer with the host $action dialog open leaves the drawer open',
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

  it('S-8: in-place actions on another resource leave the Files tab, its location and its crumbs alone', async () => {
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
})
