// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { installAppControllerClerum } from '@hooks/domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '@hooks/domain/__tests__/__fixtures__/mockClerum'
import { App } from '@/App'

const USER_A = { id: 'user-a', email: 'a@clerum.io', name: 'A', teamId: null, teamName: null }
const USER_B = { id: 'user-b', email: 'b@clerum.io', name: 'B', teamId: null, teamName: null }
const A_FILE = { uri: 'gfs://main/user-a-private.png', name: 'user-a-private.png' }
const B_FILE = { uri: 'gfs://main/user-b-own.png', name: 'user-b-own.png' }
const DIALOG = '.da-gfs-image-preview-dialog'

const frames: FrameRequestCallback[] = []

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
    chats: [
      {
        id: 'empty-chat-1',
        title: 'Empty chat',
        createdAt: '2026-11-05T00:00:00Z',
        updatedAt: '2026-11-05T00:00:00Z',
        messageCount: 0,
      },
    ],
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
  const downloadPreview = vi.fn(async (_uri: string) => {
    throw new Error('preview bytes are not needed by this test')
  })
  bridge.gfs = bridge.gfs ?? {}
  bridge.gfs.downloadPreview = downloadPreview
  let session: unknown = { authenticated: true, me: USER_A, sessionGeneration: 1 }
  bridge.auth.getSessionState = vi.fn(async () => session)
  const sessionClearListeners = new Set<() => void>()
  bridge.auth.onSessionCleared = vi.fn((listener: () => void) => {
    sessionClearListeners.add(listener)
    return () => sessionClearListeners.delete(listener)
  })
  return {
    downloadPreview,
    openFile: async (file: { uri: string; name: string }) => {
      if (!openResource) throw new Error('the App did not subscribe to plugin GFS resources')
      const open = openResource
      await act(async () => {
        open({ kind: 'file', gfsUri: file.uri, name: file.name, bytes: 10, version: 1 })
        await Promise.resolve()
      })
    },
    // Main ended or replaced the session, so the renderer reloads the session state.
    changeSession: async (next: unknown) => {
      if (sessionClearListeners.size === 0)
        throw new Error('the App did not subscribe to the session notice')
      session = next
      await act(async () => {
        for (const notify of [...sessionClearListeners]) notify()
        await Promise.resolve()
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

async function settle() {
  await act(async () => {
    await new Promise(resolve => window.setTimeout(resolve, 20))
  })
}

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentTaskTrackerProvider>
        <App />
      </AgentTaskTrackerProvider>
    </QueryClientProvider>
  )
}

describe('App plugin GFS image preview across a session change', () => {
  beforeEach(() => {
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
  })

  async function openPreviewForUserA() {
    const bridge = installBridge()
    renderApp()
    await waitForAuthenticatedShell()
    await bridge.openFile(A_FILE)
    await waitFor(() => expect(document.querySelector(DIALOG), 'opened for A').toBeTruthy())
    expect(document.querySelector(DIALOG)!.textContent).toContain(A_FILE.name)
    return bridge
  }

  it('does not carry the preview across a session end into another user', async () => {
    const bridge = await openPreviewForUserA()

    await bridge.changeSession({ authenticated: false, me: null, sessionGeneration: 2 })
    await waitFor(() => expect(screen.queryByTestId('nav-files')).toBeNull())
    expect(document.querySelector(DIALOG), 'signed out').toBeNull()

    bridge.downloadPreview.mockClear()
    await bridge.changeSession({ authenticated: true, me: USER_B, sessionGeneration: 3 })
    await waitForAuthenticatedShell()
    await settle()

    expect(document.querySelector(DIALOG)).toBeNull()
    expect(bridge.downloadPreview.mock.calls.filter(([uri]) => uri === A_FILE.uri)).toEqual([])
  })

  it('closes the preview on a direct change to another user', async () => {
    const bridge = await openPreviewForUserA()

    bridge.downloadPreview.mockClear()
    await bridge.changeSession({ authenticated: true, me: USER_B, sessionGeneration: 2 })
    await waitFor(() => expect(document.querySelector(DIALOG)).toBeNull())
    await waitForAuthenticatedShell()
    await settle()

    expect(document.querySelector(DIALOG)).toBeNull()
    expect(bridge.downloadPreview.mock.calls.filter(([uri]) => uri === A_FILE.uri)).toEqual([])
  })

  it('still shows the next user their own file', async () => {
    const bridge = await openPreviewForUserA()

    await bridge.changeSession({ authenticated: false, me: null, sessionGeneration: 2 })
    await waitFor(() => expect(screen.queryByTestId('nav-files')).toBeNull())
    await bridge.changeSession({ authenticated: true, me: USER_B, sessionGeneration: 3 })
    await waitForAuthenticatedShell()
    await settle()

    await bridge.openFile(B_FILE)

    await waitFor(() => expect(document.querySelector(DIALOG)).toBeTruthy())
    expect(document.querySelector(DIALOG)!.textContent).toContain(B_FILE.name)
    await waitFor(() =>
      expect(bridge.downloadPreview.mock.calls.map(([uri]) => uri)).toContain(B_FILE.uri)
    )
  })
})
