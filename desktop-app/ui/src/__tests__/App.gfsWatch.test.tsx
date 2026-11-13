// @vitest-environment jsdom
import { StrictMode } from 'react'
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
  accessibleResource,
  affordancesResult,
  childView,
  grantsListPage,
  heldAffordances,
  listAccessiblePage,
  listChildrenPage,
  openGfsResourcePayload,
  resolveDeniedMessage,
  resolveResource,
  resolvedDirectory,
  resolvedFile,
  sharesListPage,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { ForwardingOwner, gfsWatchBridgeFor } from '@/gfs/__fixtures__/gfsWatchBridge'
import { GfsWatchEventSource, mainDriveKey } from '@/gfs/__fixtures__/gfsWatchEvents'
import {
  type AppServiceWatchHarnessLike,
  newAppServiceWatchHarness,
  newWatchServer,
} from '@/gfs/__fixtures__/mainWatchHarness'
import { config } from '../../../src/config'
import { delegationAffordances } from '../../../src/gfs/delegation.js'
import {
  TEAM_1,
  TEAM_2,
  USER_A,
  USER_B,
  signV1SessionToken,
} from '../../../testSupport/gfsWatch/sessionTokens'

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

const IMAGE_RID = 'a1'.repeat(16)
const IMAGE_URI = `gfs://main/${IMAGE_RID}`
const IMAGE_KEY = mainDriveKey('file', IMAGE_RID)
const DIAGRAM = resolvedFile(IMAGE_RID, 'diagram.png', { gfsUri: IMAGE_URI, bytes: 3 })
const SKETCH_RID = 'a2'.repeat(16)
const SKETCH = resolvedFile(SKETCH_RID, 'sketch.png', {
  gfsUri: `gfs://main/${SKETCH_RID}`,
  bytes: 3,
})

// The preview's transient-failure backoff: 5 s doubling, capped at 60 s.
const PREVIEW_RETRY_DELAYS = new Set([5000, 10000, 20000, 40000, 60000])

const tokenA = (teamId: string | null = TEAM_1, authGeneration = 1) =>
  signV1SessionToken({ userId: USER_A, authGeneration, teamId })

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

/**
 * The renderer with main's real AppService behind its session calls and main's
 * real watch client behind `window.clerum.gfsWatch`; the watch talks HTTP to the
 * fake watch server. Everything else the App needs is the controller harness.
 */
function installBridge() {
  const { handle } = installAppControllerClerum({ agentNames: ['agent-x'] })
  let envKey = 'environment-a'
  const baseRuntimeConfig = {
    configured: true,
    isLocalhost: false,
    selectorVisible: true,
    activeOptionId: null,
    currentConfig: undefined,
    storagePath: '/harness/runtime-configs',
    options: [],
  }
  vi.mocked(handle.getRuntimeConfigState).mockImplementation(async () => ({
    ...baseRuntimeConfig,
    envKey,
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
  const resolveImpl = vi.fn(async (uri: string) => {
    if (uri === IMAGE_URI) return resolveResource(DIAGRAM)
    throw new Error(`unexpected resolve of ${uri}`)
  })
  bridge.gfs = {
    ...(bridge.gfs ?? {}),
    resolve: vi.fn((uri: string) => resolveImpl(uri)),
    downloadPreview: vi.fn(() => new Promise(() => undefined)),
    listAccessible: vi.fn(async () => listAccessiblePage([])),
    affordances: vi.fn(async () => affordancesResult(heldAffordances(['read']))),
  }
  let sessionCleared: (() => void) | null = null
  bridge.auth.onSessionCleared = vi.fn((listener: () => void) => {
    sessionCleared = listener
    return vi.fn()
  })
  const owner = new ForwardingOwner(1)
  h.owners.set(1, owner)
  const watch = gfsWatchBridgeFor(h.client, owner)
  bridge.gfsWatch = watch.bridge
  return {
    watch,
    gfs: bridge.gfs as Record<string, ReturnType<typeof vi.fn>>,
    resolveImpl,
    setEnvKey(next: string) {
      envKey = next
    },
    open: async (resource: unknown) => {
      if (!openResource) throw new Error('the App did not subscribe to plugin GFS resources')
      const listener = openResource
      await act(async () => {
        listener(resource)
        await Promise.resolve()
      })
    },
    /** Main tells the renderer its session changed; the renderer reloads it. */
    notifySessionChanged: async () => {
      if (!sessionCleared) throw new Error('the App did not subscribe to the session notice')
      const notify = sessionCleared
      await act(async () => {
        notify()
        await Promise.resolve()
      })
    },
  }
}

// The App reacts through the app-wide query client, as in production, so the
// pages it renders must read through the same one.
function renderApp({ strict = false }: { strict?: boolean } = {}) {
  const app = (
    <QueryClientProvider client={desktopQueryClient}>
      <AgentTaskTrackerProvider>
        <App />
      </AgentTaskTrackerProvider>
    </QueryClientProvider>
  )
  return render(strict ? <StrictMode>{app}</StrictMode> : app)
}

/** The last list the renderer handed to main, after its debounce settled. */
async function settledRequest(watch: ReturnType<typeof installBridge>['watch']) {
  await wait(GFS_WATCH_DEBOUNCE_MS * 2)
  await act(() => h.settle())
  return watch.requests.at(-1)
}

describe('App GFS watch subscription', () => {
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

  async function overlayOpenForUserA() {
    await h.login(tokenA())
    const bridge = installBridge()
    renderApp()
    await waitForAuthenticatedShell()
    await bridge.open(await openGfsResourcePayload(DIAGRAM))
    expect(await settledRequest(bridge.watch)).toEqual({ keys: [IMAGE_KEY], userId: USER_A })
    expect(h.server.current()?.keys).toEqual(new Set([IMAGE_KEY]))
    return bridge
  }

  it('under StrictMode (as main.tsx mounts it), a watched change still re-resolves the preview', async () => {
    await h.login(tokenA())
    const bridge = installBridge()
    renderApp({ strict: true })
    await waitForAuthenticatedShell()
    await bridge.open(await openGfsResourcePayload(DIAGRAM))
    expect(await settledRequest(bridge.watch)).toEqual({ keys: [IMAGE_KEY], userId: USER_A })
    expect(h.server.current()?.keys).toEqual(new Set([IMAGE_KEY]))
    const source = await new GfsWatchEventSource().start([IMAGE_KEY])
    try {
      const changed = await source.changed([IMAGE_KEY])
      const before = bridge.gfs.resolve!.mock.calls.length
      await act(async () => bridge.watch.deliver(changed))
      await waitFor(() => expect(bridge.gfs.resolve!.mock.calls.length).toBe(before + 1))
      expect(bridge.gfs.resolve!.mock.calls.at(-1)).toEqual([IMAGE_URI])
    } finally {
      await source.stop()
    }
  })

  it('T-CB37: registers on mount and watches under me.id of the session main published', async () => {
    const bridge = await overlayOpenForUserA()
    const { me } = await h.service.getSessionState()
    expect(me?.id).toBe(USER_A)
    // The first request registered the window before any list existed.
    expect(bridge.watch.requests[0]?.keys).toEqual([])
    expect(
      bridge.watch.requests.every(request => request.userId !== `${USER_A}:${me?.email}`)
    ).toBe(true)
  })

  it('T-CB37/H-B109: a list of A still in the debounce never reaches the stream of B', async () => {
    const bridge = await overlayOpenForUserA()
    // A switches the overlay to another file: that list waits in the debounce.
    await bridge.open(await openGfsResourcePayload(SKETCH))
    const tokenB = signV1SessionToken({ userId: USER_B, authGeneration: 1, teamId: TEAM_1 })
    await act(async () => {
      await h.login(tokenB)
    })
    await bridge.notifySessionChanged()
    expect(await settledRequest(bridge.watch)).toEqual({ keys: [], userId: USER_B })

    const ofB = [...h.server.gets, ...h.server.puts].filter(request => request.token === tokenB)
    expect(ofB.length).toBeGreaterThan(0)
    const keysOfB = ofB.flatMap(request => request.keys)
    expect(keysOfB.filter(key => key.includes(IMAGE_RID) || key.includes(SKETCH_RID))).toEqual([])
  })

  it('T-CB30: a re-login of the same user with the overlay open sends the same list again', async () => {
    const bridge = await overlayOpenForUserA()
    const sent = bridge.watch.requests.length

    // Main logs out and back in before the renderer reloads the session.
    await act(async () => {
      await h.service.logout()
      await h.login(tokenA())
    })
    expect(h.server.current()?.keys ?? new Set()).toEqual(new Set())
    await bridge.notifySessionChanged()

    expect(await settledRequest(bridge.watch)).toEqual({ keys: [IMAGE_KEY], userId: USER_A })
    expect(bridge.watch.requests.length).toBeGreaterThan(sent)
    expect(h.server.current()?.keys).toEqual(new Set([IMAGE_KEY]))
  })

  it('T-CB30: an environment change sends the same list to the new environment', async () => {
    const bridge = await overlayOpenForUserA()
    const envB = await newWatchServer()
    await envB.start()
    try {
      await act(async () => {
        await h.service.applyRuntimeEnvironmentChange(async () => {
          config.externalRestApiBaseUrl = envB.baseUrl
        })
        await h.login(tokenA())
      })
      bridge.setEnvKey('environment-b')
      await bridge.notifySessionChanged()

      expect(await settledRequest(bridge.watch)).toEqual({ keys: [IMAGE_KEY], userId: USER_A })
      await waitFor(() => expect(envB.current()?.keys).toEqual(new Set([IMAGE_KEY])))
    } finally {
      await envB.stop()
    }
  })

  it('T-CB30: after a team change the preview retries start again from the initial backoff', async () => {
    const bridge = await overlayOpenForUserA()
    const unavailable = await resolveDeniedMessage(
      IMAGE_URI,
      { code: 'upstream', message: 'upstream unavailable' },
      503
    )
    bridge.resolveImpl.mockImplementation(async () => {
      throw new Error(unavailable)
    })
    const retries: Array<{ delay: number; run: () => void }> = []
    const realSetTimeout = window.setTimeout.bind(window)
    vi.spyOn(window, 'setTimeout').mockImplementation(((
      handler: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (typeof handler === 'function' && PREVIEW_RETRY_DELAYS.has(delay ?? 0)) {
        retries.push({ delay: delay ?? 0, run: () => (handler as () => void)() })
        return 0
      }
      return realSetTimeout(handler, delay, ...args)
    }) as typeof window.setTimeout)

    const source = await new GfsWatchEventSource().start([IMAGE_KEY])
    try {
      const changed = await source.changed([IMAGE_KEY])
      await act(async () => bridge.watch.deliver(changed))
      await waitFor(() => expect(retries.map(r => r.delay)).toEqual([5000]))
      await act(async () => retries[0]!.run())
      await waitFor(() => expect(retries.map(r => r.delay)).toEqual([5000, 10000]))

      await act(async () => {
        await h.service.switchTeam(TEAM_2)
      })
      await bridge.notifySessionChanged()
      await settledRequest(bridge.watch)
      const resolvesBefore = bridge.gfs.resolve!.mock.calls.length
      await act(async () => retries[1]!.run())
      expect(bridge.gfs.resolve!.mock.calls.length).toBe(resolvesBefore)

      await act(async () => bridge.watch.deliver(changed))
      await waitFor(() => expect(retries.map(r => r.delay)).toEqual([5000, 10000, 5000]))
    } finally {
      await source.stop()
    }
  })

  it('a reauthorize close refreshes access at once; watched keys wait for the resync of the next ready', async () => {
    const bridge = await overlayOpenForUserA()
    const explorerToggle = screen.queryByTestId('nav-files-explorer-toggle')
    if (explorerToggle?.getAttribute('aria-expanded') === 'false') fireEvent.click(explorerToggle)
    await waitFor(() => expect(bridge.gfs.listAccessible).toHaveBeenCalled())
    const source = await new GfsWatchEventSource().start([IMAGE_KEY])
    try {
      const [closing, ...afterReopen] = await source.reauthorize([IMAGE_KEY])
      expect(closing).toEqual({ type: 'accessChanged' })
      const resync = afterReopen.find(event => event.type === 'resync')
      expect(resync).toEqual({ type: 'resync', keys: [IMAGE_KEY] })

      const roots = bridge.gfs.listAccessible!.mock.calls.length
      const resolves = bridge.gfs.resolve!.mock.calls.length
      await act(async () => bridge.watch.deliver([closing!]))
      await waitFor(() => expect(bridge.gfs.listAccessible!.mock.calls.length).toBe(roots + 1))
      await wait(50)
      expect(bridge.gfs.resolve!.mock.calls.length).toBe(resolves)

      await act(async () => bridge.watch.deliver([resync!]))
      await waitFor(() => expect(bridge.gfs.resolve!.mock.calls.length).toBe(resolves + 1))
      await wait(50)
      expect(bridge.gfs.resolve!.mock.calls.slice(resolves)).toEqual([[IMAGE_URI]])
    } finally {
      await source.stop()
    }
  })

  it('a reauthorization re-resolves each watched key exactly once', async () => {
    const bridge = await overlayOpenForUserA()
    const source = await new GfsWatchEventSource().start([IMAGE_KEY])
    try {
      const reopened = await source.reauthorize([IMAGE_KEY])
      expect(reopened.map(event => event.type)).toEqual([
        'accessChanged',
        'resync',
        'accessChanged',
      ])
      const before = bridge.gfs.resolve!.mock.calls.length
      await act(async () => bridge.watch.deliver(reopened))
      await waitFor(() => expect(bridge.gfs.resolve!.mock.calls.length).toBe(before + 1))
      await wait(50)
      expect(bridge.gfs.resolve!.mock.calls.slice(before)).toEqual([[IMAGE_URI]])
    } finally {
      await source.stop()
    }
  })
})

describe('App GFS watch: what the window watches and how it reacts', () => {
  const A_RID = 'b1'.repeat(16)
  const B_RID = 'c1'.repeat(16)
  const FOLDER_ID = '3c1e0a2b-4d5f-4a6b-8c7d-9e0f1a2b3c4d'
  const FOLDER_RID = FOLDER_ID.replace(/-/g, '')
  const FOLDER_URI = `gfs://main/${FOLDER_RID}`
  const NOTE_A = resolvedFile(A_RID, 'a.md', { gfsUri: `gfs://main/${A_RID}`, bytes: 4 })
  const NOTE_B = resolvedFile(B_RID, 'b.md', { gfsUri: `gfs://main/${B_RID}`, bytes: 4 })
  const FOLDER = resolvedDirectory(FOLDER_ID, 'Reports', { gfsUri: FOLDER_URI })

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

  it('G1-10: a preview tab that leaves the watch still applies its in-flight resolve', async () => {
    await h.login(tokenA())
    const bridge = installBridge()
    let finishA: ((value: Promise<never>) => void) | null = null
    let holdA = false
    bridge.resolveImpl.mockImplementation(async (uri: string) => {
      if (uri === NOTE_A.gfsUri) {
        if (holdA) {
          holdA = false
          return new Promise<never>(resolve => {
            finishA = resolve as (value: Promise<never>) => void
          })
        }
        return resolveResource(NOTE_A)
      }
      if (uri === NOTE_B.gfsUri) return resolveResource(NOTE_B)
      throw new Error(`unexpected resolve of ${uri}`)
    })
    renderApp()
    await waitForAuthenticatedShell()
    await bridge.open(await openGfsResourcePayload(NOTE_A))
    expect((await settledRequest(bridge.watch))?.keys).toEqual([mainDriveKey('file', A_RID)])

    const source = await new GfsWatchEventSource().start([mainDriveKey('file', A_RID)])
    try {
      holdA = true
      await act(async () =>
        bridge.watch.deliver(await source.changed([mainDriveKey('file', A_RID)]))
      )
      await waitFor(() => expect(finishA).toBeTypeOf('function'))

      await bridge.open(await openGfsResourcePayload(NOTE_B))
      expect((await settledRequest(bridge.watch))?.keys).toEqual([mainDriveKey('file', B_RID)])

      const denied = await resolveDeniedMessage(NOTE_A.gfsUri)
      await act(async () => {
        finishA!(Promise.reject(new Error(denied)))
        await Promise.resolve()
      })
      await waitFor(() => expect(screen.getByText('File unavailable')).toBeTruthy())
      expect(screen.getAllByText('b.md').length).toBeGreaterThan(0)
    } finally {
      await source.stop()
    }
  })

  it('watches the open folder and re-resolves it, with its listing, when it changes', async () => {
    await h.login(tokenA())
    const bridge = installBridge()
    const listChildren = vi.fn(async () =>
      listChildrenPage([childView('9f8e7d6c-5b4a-4392-8171-605f4e3d2c1b', 'notes.md', 'file')])
    )
    bridge.gfs.listChildren = listChildren
    bridge.resolveImpl.mockImplementation(async (uri: string) => {
      if (uri === FOLDER_URI) return resolveResource(FOLDER)
      throw new Error(`unexpected resolve of ${uri}`)
    })
    renderApp()
    await waitForAuthenticatedShell()
    await bridge.open(await openGfsResourcePayload(FOLDER))
    expect(await screen.findByText('notes.md')).toBeTruthy()
    expect((await settledRequest(bridge.watch))?.keys).toEqual([mainDriveKey('dir', FOLDER_RID)])

    const source = await new GfsWatchEventSource().start([mainDriveKey('dir', FOLDER_RID)])
    try {
      const resolves = bridge.gfs.resolve!.mock.calls.length
      const listings = listChildren.mock.calls.length
      await act(async () =>
        bridge.watch.deliver(await source.changed([mainDriveKey('dir', FOLDER_RID)]))
      )
      await waitFor(() => expect(listChildren.mock.calls.length).toBeGreaterThan(listings))
      await waitFor(() => expect(bridge.gfs.resolve!.mock.calls.length).toBe(resolves + 1))
      expect(bridge.gfs.resolve!.mock.calls.at(-1)).toEqual([FOLDER_URI])
    } finally {
      await source.stop()
    }
  })

  it('watches a file the Files tab moved onto (Share on a file row) as a file, and re-resolves it', async () => {
    await h.login(tokenA())
    const bridge = installBridge()
    const CONTRACT_ID = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a'
    const CONTRACT_RID = CONTRACT_ID.replace(/-/g, '')
    const CONTRACT_URI = `gfs://main/${CONTRACT_RID}`
    const contractRow = childView(CONTRACT_ID, 'contract.bin', 'file', {
      gfsUri: CONTRACT_URI,
      parentResourceId: FOLDER_ID,
    })
    bridge.gfs.listChildren = vi.fn(async () => listChildrenPage([contractRow]))
    bridge.gfs.affordances = vi.fn(async () =>
      delegationAffordances(new Set(['read', 'write', 'delete', 'manage_acl', 'share']), false)
    )
    bridge.gfs.listGrants = vi.fn(async () => grantsListPage([]))
    bridge.gfs.listShares = vi.fn(async () => sharesListPage([]))
    bridge.resolveImpl.mockImplementation(async (uri: string) => {
      if (uri === FOLDER_URI) return resolveResource(FOLDER)
      if (uri === CONTRACT_URI) {
        return resolveResource(
          resolvedFile(CONTRACT_ID, 'contract.bin', {
            gfsUri: CONTRACT_URI,
            parentResourceId: FOLDER_ID,
          })
        )
      }
      throw new Error(`unexpected resolve of ${uri}`)
    })
    renderApp()
    await waitForAuthenticatedShell()
    await bridge.open(await openGfsResourcePayload(FOLDER))
    fireEvent.click(await screen.findByRole('button', { name: 'Share contract.bin' }))
    await waitFor(() =>
      expect(
        screen.getByRole('navigation', { name: 'File location', hidden: true }).textContent
      ).toContain('contract.bin')
    )
    const fileKey = mainDriveKey('file', CONTRACT_RID)
    expect((await settledRequest(bridge.watch))?.keys).toEqual([fileKey])
    expect(h.server.current()?.keys).toEqual(new Set([fileKey]))

    const source = await new GfsWatchEventSource().start([fileKey])
    try {
      const resolves = bridge.gfs.resolve!.mock.calls.length
      await act(async () => bridge.watch.deliver(await source.changed([fileKey])))
      await waitFor(() =>
        expect(bridge.gfs.resolve!.mock.calls.slice(resolves)).toContainEqual([CONTRACT_URI])
      )
    } finally {
      await source.stop()
    }
  })

  it('a session expiry clears the open Files location, its names included', async () => {
    await h.login(tokenA())
    const bridge = installBridge()
    const legal = resolvedDirectory(FOLDER_ID, 'Legal', {
      gfsUri: FOLDER_URI,
      path: '/Reports/Q3/Legal',
      parentResourceId: '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d',
    })
    bridge.gfs.listChildren = vi.fn(async () => listChildrenPage([]))
    bridge.resolveImpl.mockImplementation(async (uri: string) => {
      if (uri === FOLDER_URI) return resolveResource(legal)
      throw new Error(`unexpected resolve of ${uri}`)
    })
    renderApp()
    await waitForAuthenticatedShell()
    await bridge.open(await openGfsResourcePayload(legal))
    const location = () =>
      screen.queryByRole('navigation', { name: 'File location' })?.textContent ?? ''
    await waitFor(() => expect(location()).toContain('Legal'))

    const source = await new GfsWatchEventSource().start([mainDriveKey('dir', FOLDER_RID)])
    try {
      const expired = await source.sessionExpired()
      expect(expired).toEqual([{ type: 'sessionExpired' }])
      await act(async () => bridge.watch.deliver(expired))
      await waitFor(() => expect(location()).not.toContain('Legal'))
      expect(location()).not.toContain('Q3')
    } finally {
      await source.stop()
    }
  })

  it('watches the folders expanded in the sidebar, and stops when they collapse', async () => {
    await h.login(tokenA())
    const bridge = installBridge()
    bridge.gfs.listAccessible = vi.fn(async () =>
      listAccessiblePage([
        accessibleResource(FOLDER_ID, 'Reports', 'directory', { gfsUri: FOLDER_URI }),
      ])
    )
    bridge.gfs.listChildren = vi.fn(async () => listChildrenPage([]))
    renderApp()
    await waitForAuthenticatedShell()
    const explorerToggle = screen.queryByTestId('nav-files-explorer-toggle')
    if (explorerToggle?.getAttribute('aria-expanded') === 'false') fireEvent.click(explorerToggle)
    const row = await screen.findByRole('treeitem', { name: /Reports/ })
    fireEvent.click(row.querySelector('button') ?? row)
    await waitFor(() => expect(row.getAttribute('aria-expanded')).toBe('true'))
    expect((await settledRequest(bridge.watch))?.keys).toEqual([mainDriveKey('dir', FOLDER_RID)])
    expect(h.server.current()?.keys).toEqual(new Set([mainDriveKey('dir', FOLDER_RID)]))

    fireEvent.click(row.querySelector('button') ?? row)
    await waitFor(() => expect(row.getAttribute('aria-expanded')).toBe('false'))
    expect((await settledRequest(bridge.watch))?.keys).toEqual([])
  })
})
