// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GFS_WATCH_DEBOUNCE_MS } from '@constants/gfsWatch'
import { installAppControllerClerum } from '@hooks/domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '@hooks/domain/__tests__/__fixtures__/mockClerum'
import { desktopQueryClient } from '@lib/queryClient'
import { App } from '@/App'
import {
  affordancesResult,
  grantsListPage,
  heldAffordances,
  listAccessiblePage,
  listChildrenPage,
  openGfsResourcePayload,
  resolveDeniedMessage,
  resolveResource,
  sharesListPage,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { ForwardingOwner, gfsWatchBridgeFor } from '@/gfs/__fixtures__/gfsWatchBridge'
import { GfsWatchEventSource, mainDriveKey } from '@/gfs/__fixtures__/gfsWatchEvents'
import {
  type AppServiceWatchHarnessLike,
  newAppServiceWatchHarness,
  newWatchHarness,
} from '@/gfs/__fixtures__/mainWatchHarness'
import {
  type NavigationResolution,
  gfscResourceView,
  resolvedNavigation,
} from '@/gfs/__fixtures__/navigationResolutionFixtures'
import { delegationAffordances } from '../../../src/gfs/delegation.js'
import type { GfsWatchEvent } from '../../../src/types'
import { TEAM_1, USER_A, signV1SessionToken } from '../../../testSupport/gfsWatch/sessionTokens'

vi.mock('electron', () => ({
  app: {
    isReady: vi.fn(() => false),
    getPath: vi.fn(() => '/tmp/clerum-desktop-test'),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  shell: { openExternal: vi.fn() },
}))

vi.mock('../../../src/chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  getChatStore: vi.fn(),
  unbindChatStore: vi.fn(),
}))

type GfsResourceView = Awaited<ReturnType<typeof gfscResourceView>>

const tokenA = () => signV1SessionToken({ userId: USER_A, authGeneration: 1, teamId: TEAM_1 })

const frames: FrameRequestCallback[] = []
let h: AppServiceWatchHarnessLike

async function flushFrames() {
  for (let pass = 0; pass < 8 && frames.length; pass += 1) {
    await act(async () => {
      frames.splice(0).forEach(callback => callback(performance.now()))
      await Promise.resolve()
    })
  }
}

async function waitForAuthenticatedShell() {
  for (let pass = 0; pass < 8; pass += 1) {
    if (screen.queryByTestId('nav-files')) break
    await flushFrames()
    await act(async () => {
      await Promise.resolve()
    })
  }
  expect(await screen.findByTestId('nav-files')).toBeTruthy()
}

const wait = (ms: number) =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })

const FOLDER_ID = '3c1e0a2b-4d5f-4a6b-8c7d-9e0f1a2b3c4d'

/** gfs-controller's projections of the files these tests open. */
async function views() {
  const [report, contract, folder] = await Promise.all([
    gfscResourceView({
      resourceId: '0b9f3c1e-7a42-4d4e-9c1a-5f6e7d8c9b0a',
      name: 'report.md',
      version: 3,
      bytes: 11,
    }),
    gfscResourceView({
      resourceId: '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a',
      parentResourceId: FOLDER_ID,
      name: 'contract.bin',
      version: 2,
      bytes: 40,
    }),
    gfscResourceView({
      resourceId: FOLDER_ID,
      name: 'Reports',
      kind: 'directory',
      version: 1,
      bytes: 0,
    }),
  ])
  return { report, contract, folder }
}

/**
 * The renderer over main's real AppService and watch client, as in
 * App.gfsWatch.test.tsx, with the navigation resolve the suggestion prefetches
 * answered by AppService itself from gfs-controller's view of each file.
 */
function installBridge(files: GfsResourceView[]) {
  const { handle } = installAppControllerClerum({ agentNames: ['agent-x'] })
  vi.mocked(handle.getRuntimeConfigState).mockImplementation(async () => ({
    configured: true,
    isLocalhost: false,
    selectorVisible: true,
    activeOptionId: null,
    currentConfig: undefined,
    storagePath: '/harness/runtime-configs',
    options: [],
    envKey: 'environment-a',
  }))
  handle.getSessionState.mockImplementation(() => h.service.getSessionState())
  handle.getSessionGeneration.mockImplementation(async () => h.service.getSessionGeneration())
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
    listApps: vi.fn().mockResolvedValue({ apps: [] }),
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
  let openResource: ((resource: unknown) => void) | null = null
  bridge.pluginSdk = {
    onOpenGfsResource: vi.fn((listener: (resource: unknown) => void) => {
      openResource = listener
      return vi.fn()
    }),
  }
  const byUri = new Map(files.map(file => [file.gfsUri, file]))
  const resolveImpl = vi.fn(async (uri: string) => {
    const file = byUri.get(uri)
    if (!file) throw new Error(`unexpected resolve of ${uri}`)
    return resolveResource(file)
  })
  const resolveForNavigation = vi.fn(async (uri: string): Promise<NavigationResolution> => {
    const file = byUri.get(uri)
    if (!file) throw new Error(`unexpected navigation resolve of ${uri}`)
    return resolvedNavigation(file)
  })
  bridge.gfs = {
    ...(bridge.gfs ?? {}),
    resolve: vi.fn((uri: string) => resolveImpl(uri)),
    resolveForNavigation,
    downloadPreview: vi.fn(() => new Promise(() => undefined)),
    listAccessible: vi.fn(async () => listAccessiblePage([])),
    listChildren: vi.fn(async () => listChildrenPage([])),
    affordances: vi.fn(async () => affordancesResult(heldAffordances(['read']))),
  }
  const owner = new ForwardingOwner(1)
  h.owners.set(1, owner)
  const watch = gfsWatchBridgeFor(h.client, owner)
  bridge.gfsWatch = watch.bridge
  return {
    watch,
    gfs: bridge.gfs as Record<string, ReturnType<typeof vi.fn>>,
    resolveImpl,
    resolveForNavigation,
    open: async (resource: unknown) => {
      if (!openResource) throw new Error('the App did not subscribe to plugin GFS resources')
      const listener = openResource
      await act(async () => {
        listener(resource)
        await Promise.resolve()
      })
    },
  }
}

type Bridge = ReturnType<typeof installBridge>

function renderApp() {
  return render(
    <QueryClientProvider client={desktopQueryClient}>
      <AgentTaskTrackerProvider>
        <App />
      </AgentTaskTrackerProvider>
    </QueryClientProvider>
  )
}

async function settledWatch(bridge: Bridge) {
  await wait(GFS_WATCH_DEBOUNCE_MS * 2)
  await act(() => h.settle())
  return bridge.watch.requests.at(-1)
}

/**
 * Files lands on a file only from a row action: opening a file link previews or
 * downloads it and keeps the folder. Share on the row moves the location onto
 * the file, as it does for a user.
 */
async function openFilesOnFile(
  bridge: Bridge,
  folder: GfsResourceView,
  file: GfsResourceView
): Promise<void> {
  if (file.parentResourceId !== folder.resourceId) {
    throw new Error(`${file.name} is not a child of ${folder.name}`)
  }
  bridge.gfs.listChildren = vi.fn(async () => listChildrenPage([file]))
  bridge.gfs.affordances = vi.fn(async () =>
    delegationAffordances(new Set(['read', 'write', 'delete', 'manage_acl', 'share']), false)
  )
  bridge.gfs.listGrants = vi.fn(async () => grantsListPage([]))
  bridge.gfs.listShares = vi.fn(async () => sharesListPage([]))
  await bridge.open(await openGfsResourcePayload(folder))
  fireEvent.click(await screen.findByRole('button', { name: `Share ${file.name}` }))
  await waitFor(() =>
    expect(
      screen.getByRole('navigation', { name: 'File location', hidden: true }).textContent
    ).toContain(file.name)
  )
}

const chip = (name: string) =>
  screen.queryByRole('button', { name: `Reference ${name} in this message` })

async function openDrawer() {
  fireEvent.click(await screen.findByRole('button', { name: 'Open chat drawer' }))
  await flushFrames()
}

async function startWith(files: GfsResourceView[]) {
  await h.login(tokenA())
  const bridge = installBridge(files)
  renderApp()
  await waitForAuthenticatedShell()
  return bridge
}

/** The `rejected` event main's watch client emits when the server refuses `key`. */
async function rejectedEvent(key: string): Promise<GfsWatchEvent> {
  const harness = await newWatchHarness()
  await harness.start()
  try {
    await harness.login()
    const server = harness.server as typeof harness.server & {
      putPolicy: () => {
        kind: 'accept'
        decide: (keys: string[]) => { accepted: string[]; rejected: string[]; deferred: string[] }
      }
    }
    server.putPolicy = () => ({
      kind: 'accept',
      decide: keys => ({
        accepted: keys.filter(candidate => candidate !== key),
        rejected: keys.filter(candidate => candidate === key),
        deferred: [],
      }),
    })
    const owner = harness.owner(1)
    const from = owner.events.length
    await harness.subscribe([key])
    const rejected = owner.events.slice(from).find(event => event.type === 'rejected')
    if (!rejected) throw new Error('the watch client emitted no rejected event')
    return structuredClone(rejected)
  } finally {
    await harness.stop()
  }
}

describe('App — the drawer suggests the file of the active tab', () => {
  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    h = await (await newAppServiceWatchHarness()).start()
    frames.length = 0
    window.localStorage.clear()
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
    vi.stubGlobal(
      'matchMedia',
      vi.fn(
        () =>
          ({
            matches: false,
            media: '(max-width: 759px)',
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
          }) as MediaQueryList
      )
    )
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
  })

  afterEach(async () => {
    cleanup()
    await new Promise(resolve => window.setTimeout(resolve, 0))
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    uninstallMockClerum()
    desktopQueryClient.clear()
    await h.stop()
  })

  it('suggests the file of an open preview', async () => {
    const { report } = await views()
    const bridge = await startWith([report])
    await bridge.open(await openGfsResourcePayload(report))
    await openDrawer()
    expect(await screen.findByRole('button', { name: 'Reference report.md in this message' }))
    expect(bridge.resolveForNavigation).toHaveBeenCalledWith(report.gfsUri)
  })

  it('attaches the suggested file from the drawer and leaves the focus in the message box', async () => {
    const { report } = await views()
    const bridge = await startWith([report])
    await bridge.open(await openGfsResourcePayload(report))
    await openDrawer()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Reference report.md in this message' })
    )
    expect(await screen.findByRole('button', { name: 'Remove report.md' })).toBeTruthy()
    expect(screen.getByTestId('composer-attachments-count').textContent).toBe('1 attachment')
    expect(chip('report.md')).toBeNull()
    expect(document.activeElement).toBe(screen.getByLabelText('Agent message composer'))
  })

  it('stops suggesting a preview once it becomes unavailable', async () => {
    const { report } = await views()
    const bridge = await startWith([report])
    await bridge.open(await openGfsResourcePayload(report))
    await openDrawer()
    expect(await screen.findByRole('button', { name: 'Reference report.md in this message' }))
    const fileKey = mainDriveKey('file', report.rid)
    expect((await settledWatch(bridge))?.keys).toContain(fileKey)

    const source = await new GfsWatchEventSource().start([fileKey])
    try {
      const changed = await source.changed([fileKey])
      const denied = await resolveDeniedMessage(report.gfsUri)
      bridge.resolveImpl.mockImplementation(async () => {
        throw new Error(denied)
      })
      await act(async () => bridge.watch.deliver(changed))
      await waitFor(() => expect(screen.getAllByText('File unavailable').length).toBeGreaterThan(0))
      expect(chip('report.md')).toBeNull()
    } finally {
      await source.stop()
    }
  })

  it('suggests the file Files is open on', async () => {
    const { contract, folder } = await views()
    const bridge = await startWith([contract, folder])
    await openFilesOnFile(bridge, folder, contract)
    await openDrawer()
    expect(await screen.findByRole('button', { name: 'Reference contract.bin in this message' }))
    expect(bridge.resolveForNavigation).toHaveBeenCalledWith(contract.gfsUri)
  })

  it('suggests the folder Files is on and attaches it from the drawer as a folder', async () => {
    const { folder } = await views()
    const bridge = await startWith([folder])
    await bridge.open(await openGfsResourcePayload(folder))
    await openDrawer()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Reference Reports in this message' })
    )
    const attached = await screen.findByRole('button', { name: 'Remove Reports' })
    expect(attached.closest('.composer-attachment-chip')?.getAttribute('title')).toBe(
      'Global Folder'
    )
    expect(chip('Reports')).toBeNull()
    expect(bridge.resolveForNavigation).toHaveBeenCalledTimes(1)
    expect(bridge.resolveForNavigation).toHaveBeenCalledWith(folder.gfsUri)
  })

  it('S-F5: changes inside the folder Files is on resolve the suggestion nothing more', async () => {
    const { folder } = await views()
    const bridge = await startWith([folder])
    await bridge.open(await openGfsResourcePayload(folder))
    await openDrawer()
    expect(
      await screen.findByRole('button', { name: 'Reference Reports in this message' })
    ).toBeTruthy()
    const dirKey = mainDriveKey('dir', folder.rid)
    expect((await settledWatch(bridge))?.keys).toEqual([dirKey])
    await wait(0)
    const listChildren = bridge.gfs.listChildren!
    const listed = listChildren.mock.calls.length
    const settled = bridge.resolveForNavigation.mock.calls.length

    const source = await new GfsWatchEventSource().start([dirKey])
    try {
      await act(async () => bridge.watch.deliver(await source.changed([dirKey])))
      // Files does react to the change: it lists the folder again.
      await waitFor(() => expect(listChildren.mock.calls.length).toBeGreaterThan(listed))
      await settledWatch(bridge)
      expect(bridge.resolveForNavigation.mock.calls.length).toBe(settled)
      expect(chip('Reports')).toBeTruthy()
    } finally {
      await source.stop()
    }
  })

  it('suggests nothing at the Files root', async () => {
    const bridge = await startWith([])
    fireEvent.click(screen.getByTestId('nav-files'))
    await openDrawer()
    expect(await screen.findByLabelText('Agent message composer')).toBeTruthy()
    await settledWatch(bridge)
    expect(screen.queryByRole('button', { name: /^Reference .* in this message$/ })).toBeNull()
    expect(bridge.resolveForNavigation).not.toHaveBeenCalled()
  })

  it('suggests nothing over Settings', async () => {
    const bridge = await startWith([])
    fireEvent.click(screen.getByTestId('nav-settings-menu'))
    fireEvent.click(await screen.findByTestId('nav-mcp-servers'))
    await openDrawer()
    expect(await screen.findByLabelText('Agent message composer')).toBeTruthy()
    await settledWatch(bridge)
    expect(screen.queryByRole('button', { name: /^Reference .* in this message$/ })).toBeNull()
    expect(bridge.resolveForNavigation).not.toHaveBeenCalled()
  })

  it('stops suggesting a preview while the apps picker covers it', async () => {
    const { report } = await views()
    const bridge = await startWith([report])
    await bridge.open(await openGfsResourcePayload(report))
    await openDrawer()
    expect(await screen.findByRole('button', { name: 'Reference report.md in this message' }))
    fireEvent.click(screen.getByTestId('nav-sandbox-ui'))
    await flushFrames()
    await waitFor(() => expect(chip('report.md')).toBeNull())
    expect(screen.getByLabelText('Agent message composer')).toBeTruthy()
  })

  it('resolves nothing and suggests nothing while the drawer is closed', async () => {
    const { report } = await views()
    const bridge = await startWith([report])
    await bridge.open(await openGfsResourcePayload(report))
    await settledWatch(bridge)
    expect(screen.queryByLabelText('Agent message composer')).toBeNull()
    expect(bridge.resolveForNavigation).not.toHaveBeenCalled()
  })

  it('re-resolves the file open in Files when the watch reports it changed, not when it is rejected', async () => {
    const { contract, folder } = await views()
    const bridge = await startWith([contract, folder])
    await openFilesOnFile(bridge, folder, contract)
    await openDrawer()
    expect(await screen.findByRole('button', { name: 'Reference contract.bin in this message' }))
    const fileKey = mainDriveKey('file', contract.rid)
    expect((await settledWatch(bridge))?.keys).toEqual([fileKey])
    await wait(0)
    const settled = bridge.resolveForNavigation.mock.calls.length

    const rejected = await rejectedEvent(fileKey)
    await act(async () => bridge.watch.deliver([rejected]))
    await settledWatch(bridge)
    // The refusal re-reads the location like any watch reaction, but brings no
    // news about the file: the suggestion is not resolved again.
    await waitFor(() =>
      expect(
        bridge.resolveImpl.mock.calls.filter(([uri]) => uri === contract.gfsUri).length
      ).toBeGreaterThan(1)
    )
    expect(bridge.resolveForNavigation.mock.calls.length).toBe(settled)

    const source = await new GfsWatchEventSource().start([fileKey])
    try {
      await act(async () => bridge.watch.deliver(await source.changed([fileKey])))
      await waitFor(() => expect(bridge.resolveForNavigation.mock.calls.length).toBe(settled + 1))
      expect(bridge.resolveForNavigation.mock.calls.at(-1)).toEqual([contract.gfsUri])
      expect(chip('contract.bin')).toBeTruthy()
    } finally {
      await source.stop()
    }
  })

  it('re-resolves the file open in Files when the watch resyncs it, and the chip shows the new result', async () => {
    const { contract, folder } = await views()
    const bridge = await startWith([contract, folder])
    await openFilesOnFile(bridge, folder, contract)
    await openDrawer()
    expect(await screen.findByRole('button', { name: 'Reference contract.bin in this message' }))
    const fileKey = mainDriveKey('file', contract.rid)
    expect((await settledWatch(bridge))?.keys).toEqual([fileKey])
    await wait(0)
    const settled = bridge.resolveForNavigation.mock.calls.length

    // The same resource, renamed while the stream was down: only a fresh
    // resolve can show it.
    const renamed = await gfscResourceView({
      resourceId: contract.resourceId,
      parentResourceId: FOLDER_ID,
      name: 'contract-signed.bin',
      version: 3,
      bytes: 40,
    })
    expect(renamed.gfsUri).toBe(contract.gfsUri)
    bridge.resolveForNavigation.mockImplementation(async () => resolvedNavigation(renamed))

    const source = await new GfsWatchEventSource().start()
    try {
      const resync = (await source.opened([fileKey])).find(event => event.type === 'resync')
      expect(resync).toEqual({ type: 'resync', keys: [fileKey] })
      await act(async () => bridge.watch.deliver([resync!]))
      await waitFor(() => expect(bridge.resolveForNavigation.mock.calls.length).toBe(settled + 1))
      expect(bridge.resolveForNavigation.mock.calls.at(-1)).toEqual([contract.gfsUri])
      expect(
        await screen.findByRole('button', { name: 'Reference contract-signed.bin in this message' })
      ).toBeTruthy()
      expect(chip('contract.bin')).toBeNull()
    } finally {
      await source.stop()
    }
  })
})
