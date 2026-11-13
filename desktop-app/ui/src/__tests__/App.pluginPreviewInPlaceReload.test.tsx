// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { installAppControllerClerum } from '@hooks/domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '@hooks/domain/__tests__/__fixtures__/mockClerum'
import { App } from '@/App'
import {
  downloadResult,
  openGfsResourcePayload,
  resolveDeniedMessage,
  resolveResource,
  resolvedFile,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { GfsWatchEventSource, mainDriveKey } from '@/gfs/__fixtures__/gfsWatchEvents'

const USER = { id: 'user-a', email: 'a@clerum.io', name: 'A', teamId: null, teamName: null }
const RID = 'd1a6a3f0c2b44e8e9f7a5b3c1d2e4f60'
const URI = `gfs://main/${RID}`
const NAME = 'plugin-diagram.png'
const ALT = `Preview of ${NAME}`
const DIALOG = '.da-gfs-image-preview-dialog'

type Download = Awaited<ReturnType<typeof downloadResult>>

const frames: FrameRequestCallback[] = []

function fileAt(version: number, bytes: number) {
  return resolvedFile(RID, NAME, { gfsUri: URI, version, bytes })
}

let watchEvents: GfsWatchEventSource

function installBridge() {
  installAppControllerClerum({
    agentNames: ['agent-x'],
    desktopReleaseStatus: {
      checked: true,
      currentVersion: '1.0.0',
      latestVersion: '1.0.0',
      minimumVersion: '1.0.0',
      updateRequired: false,
      releaseUrl: 'https://example.invalid/release',
    },
  })
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
  const watch = watchEvents.connectRenderer()
  bridge.gfsWatch = watch.bridge
  const pending: Array<{ resolve: (value: Download) => void; reject: (error: unknown) => void }> =
    []
  const downloadPreview = vi.fn(
    () =>
      new Promise<Download>((resolve, reject) => {
        pending.push({ resolve, reject })
      })
  )
  let current = fileAt(1, 3)
  bridge.gfs = bridge.gfs ?? {}
  bridge.gfs.downloadPreview = downloadPreview
  bridge.gfs.resolve = vi.fn(async () => resolveResource(current))
  bridge.auth.getSessionState = vi.fn(async () => ({
    authenticated: true,
    me: USER,
    sessionGeneration: 1,
  }))
  bridge.auth.onSessionCleared = vi.fn(() => vi.fn())
  return {
    pending,
    downloadPreview,
    openFile: async () => {
      if (!openResource) throw new Error('the App did not subscribe to plugin GFS resources')
      const payload = await openGfsResourcePayload(current)
      const open = openResource
      await act(async () => {
        open(payload)
        await Promise.resolve()
      })
    },
    // A newer version lands on the server and the change reaches the renderer.
    publishNewVersion: async (version: number, bytes: number) => {
      current = fileAt(version, bytes)
      await waitFor(() => expect(watch.opens).toBe(1))
      await act(async () => {
        await watchEvents.changed([mainDriveKey('file', RID)])
      })
    },
  }
}

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

async function imageDownload(seed: number): Promise<Download> {
  const bytes = new Uint8Array([seed, seed, seed]).buffer as ArrayBuffer
  return downloadResult(fileAt(seed, 3), bytes)
}

describe('App plugin GFS image overlay in-place reload', () => {
  let createdUrls: string[] = []

  beforeEach(async () => {
    watchEvents = await new GfsWatchEventSource().start([mainDriveKey('file', RID)])
    frames.length = 0
    createdUrls = []
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
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => {
        const url = `blob:plugin-preview-${createdUrls.length + 1}`
        createdUrls.push(url)
        return url
      }),
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  })

  afterEach(async () => {
    cleanup()
    await new Promise(resolve => window.setTimeout(resolve, 0))
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    uninstallMockClerum()
    await watchEvents.stop()
  })

  it('swaps in the new version without remounting the overlay or revoking the visible URL early', async () => {
    const bridge = installBridge()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <AgentTaskTrackerProvider>
          <App />
        </AgentTaskTrackerProvider>
      </QueryClientProvider>
    )
    await waitForAuthenticatedShell()
    await bridge.openFile()
    await waitFor(() => expect(bridge.pending).toHaveLength(1))
    await act(async () => bridge.pending[0]!.resolve(await imageDownload(1)))
    const firstImage = await screen.findByAltText(ALT)
    expect(firstImage.getAttribute('src')).toBe('blob:plugin-preview-1')
    const dialog = document.querySelector(DIALOG)

    // Same size, newer version: only the version tells the body to reload.
    await bridge.publishNewVersion(2, 3)
    await waitFor(() => expect(bridge.pending).toHaveLength(2))

    expect(document.querySelector(DIALOG)).toBe(dialog)
    expect(screen.getByAltText(ALT).getAttribute('src')).toBe('blob:plugin-preview-1')
    expect(screen.queryByText('Loading image preview…')).toBeNull()
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:plugin-preview-1')

    await act(async () => bridge.pending[1]!.resolve(await imageDownload(2)))
    await waitFor(() =>
      expect(screen.getByAltText(ALT).getAttribute('src')).toBe('blob:plugin-preview-2')
    )
    expect(document.querySelector(DIALOG)).toBe(dialog)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:plugin-preview-1')
  })

  async function renderWithOpenOverlay() {
    const bridge = installBridge()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <AgentTaskTrackerProvider>
          <App />
        </AgentTaskTrackerProvider>
      </QueryClientProvider>
    )
    await waitForAuthenticatedShell()
    await bridge.openFile()
    await waitFor(() => expect(bridge.pending).toHaveLength(1))
    await act(async () => bridge.pending[0]!.resolve(await imageDownload(1)))
    await screen.findByAltText(ALT)
    return bridge
  }

  it('drops the visible image when the in-place download is rejected by the session', async () => {
    const bridge = await renderWithOpenOverlay()

    await bridge.publishNewVersion(2, 3)
    await waitFor(() => expect(bridge.pending).toHaveLength(2))
    const sessionRejected = await resolveDeniedMessage(
      URI,
      { code: 'unauthorized', message: 'not authenticated' },
      401
    )
    await act(async () => bridge.pending[1]!.reject(new Error(sessionRejected)))

    await waitFor(() => expect(screen.queryByAltText(ALT)).toBeNull())
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:plugin-preview-1')
  })
})
