// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { installAppControllerClerum } from '@hooks/domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '@hooks/domain/__tests__/__fixtures__/mockClerum'
import { App } from '@/App'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
} from '../../../testSupport/appService.nativeCommitTestHarness'

const frames: Array<{ callback: FrameRequestCallback; stack: string }> = []
let shortcutCommand: ((commandId: string, source: string) => void) | null = null
let mediaMatches = true
let resolveHistory: ((value: { agent: string; chatId: string; turns: unknown[] }) => void) | null =
  null
let emitEnvironmentSetup:
  | ((payload: { appName: string; externalRestApiBaseUrl: string }) => Promise<void>)
  | null = null
const visibilityLifecycleEvents: string[] = []

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

class TestPointerEvent extends MouseEvent {
  pointerId: number
  isPrimary: boolean

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 0
    this.isPrimary = init.isPrimary ?? true
  }
}

function installPlatformBoundary(updateRequired = true, desktopEnvironmentHandoffProducer?: any) {
  const installed = installAppControllerClerum({
    agentNames: ['agent-x'],
    desktopEnvironmentHandoffProducer,
    desktopReleaseStatus: {
      checked: true,
      currentVersion: '1.0.0',
      latestVersion: '2.0.0',
      minimumVersion: '1.0.0',
      updateRequired,
      releaseUrl: 'https://example.invalid/release',
    },
  })
  emitEnvironmentSetup = installed.handle.emitDesktopEnvironmentSetup
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
  bridge.rpc.loadSessionMessages = vi.fn(
    () =>
      new Promise(resolve => {
        resolveHistory = resolve
      })
  )
  bridge.app = { rendererReady: vi.fn().mockResolvedValue(undefined) }
  bridge.shortcuts = {
    onCommand: vi.fn((listener: (commandId: string, source: string) => void) => {
      shortcutCommand = listener
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
    close: vi.fn(async () => {
      visibilityLifecycleEvents.push('close')
    }),
    getLocation: vi.fn().mockResolvedValue(null),
    setVisible: vi.fn().mockResolvedValue(undefined),
    setBounds: vi.fn().mockResolvedValue(undefined),
    capturePreview: vi.fn().mockResolvedValue(null),
    stopFindInPage: vi.fn().mockResolvedValue(undefined),
    focusActive: vi.fn().mockResolvedValue(true),
    reload: vi.fn().mockResolvedValue(undefined),
  }
  bridge.pluginSdk = { onOpenGfsResource: vi.fn(() => vi.fn()) }
  bridge.sandboxUi.setVisible = vi.fn(async (visible: boolean) => {
    visibilityLifecycleEvents.push(`visible:${visible}`)
  })
  return installed
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

async function flushFrames() {
  for (let pass = 0; pass < 8 && frames.length; pass += 1) {
    await act(async () => {
      const pending = frames.splice(0)
      pending.forEach(frame => frame.callback(performance.now()))
      await Promise.resolve()
    })
  }
}

function compactMedia(matches: boolean) {
  mediaMatches = matches
  vi.stubGlobal(
    'matchMedia',
    vi.fn(
      () =>
        ({
          get matches() {
            return mediaMatches
          },
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
}

describe('PR1087 App-root native visibility owners', () => {
  beforeEach(() => {
    frames.length = 0
    visibilityLifecycleEvents.length = 0
    resolveHistory = null
    window.localStorage.clear()
    vi.stubGlobal('PointerEvent', TestPointerEvent)
    Object.defineProperty(window, 'PointerEvent', {
      configurable: true,
      value: TestPointerEvent,
    })
    shortcutCommand = null
    installPlatformBoundary()
    emitEnvironmentSetup = null
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push({ callback, stack: new Error().stack ?? '' })
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
    compactMedia(true)
  })

  afterEach(async () => {
    cleanup()
    await new Promise(resolve => window.setTimeout(resolve, 0))
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    uninstallMockClerum()
    await cleanupNativeCommitTestHarness()
  })

  it('keeps real Composer focus after compact New Chat settles', async () => {
    renderApp()
    expect(await screen.findByTestId('nav-files')).toBeTruthy()

    const trigger = screen.getByTestId('compact-navigation-toggle')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(screen.getByTestId('nav-new-chat'))
    await flushFrames()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const composer = await screen.findByTestId('chat-input')
    await waitFor(() => expect(document.activeElement).toBe(composer))
    expect(composer.isConnected).toBe(true)
    const composerBounds = composer.getBoundingClientRect()
    expect(composerBounds.width).toBeGreaterThan(0)
    expect(composerBounds.height).toBeGreaterThan(0)
    expect(getComputedStyle(composer).visibility).not.toBe('hidden')

    fireEvent.click(trigger)
    const backdrop = document.querySelector('.sidebar-mobile-backdrop')
    expect(backdrop).toBeTruthy()
    fireEvent.click(backdrop!)
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('keeps ordinary dismissal focus through delayed real Chat history hydration', async () => {
    const chatId = 'hydrating-chat'
    ;(window.clerum as any).chat.getIndex.mockResolvedValue({
      version: 1,
      lastActiveChatId: chatId,
      onboardingDismissed: false,
      chats: [
        {
          id: chatId,
          title: 'Hydrating chat',
          createdAt: '2026-11-05T00:00:00Z',
          updatedAt: '2026-11-05T00:00:00Z',
          messageCount: 1,
        },
      ],
    })
    renderApp()
    expect(await screen.findByTestId('nav-files')).toBeTruthy()
    const composer = await screen.findByTestId('chat-input')
    const loadSessionMessages = (window.clerum as any).rpc.loadSessionMessages
    await waitFor(() => expect(loadSessionMessages).toHaveBeenCalled())
    const [, agent, requestedChatId] = loadSessionMessages.mock.calls.at(-1) as [
      string,
      string,
      string,
    ]
    expect(requestedChatId).toBe(chatId)

    const trigger = screen.getByTestId('compact-navigation-toggle')
    fireEvent.click(trigger)
    fireEvent.click(document.querySelector('.sidebar-mobile-backdrop')!)
    await waitFor(() => expect(document.activeElement).toBe(trigger))

    await act(async () => {
      resolveHistory?.({
        agent,
        chatId,
        turns: [
          {
            number: 1,
            user_input: 'Hydrated after dismissal',
            response: 'Hydrated response',
            started_at: '2026-11-05T00:00:00Z',
          },
        ],
      })
      await Promise.resolve()
    })
    await flushFrames()
    expect(composer.isConnected).toBe(true)
    expect(document.activeElement).toBe(trigger)
  })

  it('joins the real release-status producer and App-root dialog with a mounted SandboxUiPage', async () => {
    compactMedia(false)
    let resolveReleaseStatus!: (status: {
      checked: true
      currentVersion: string
      latestVersion: string
      minimumVersion: string
      updateRequired: boolean
      releaseUrl: string
    }) => void
    const pendingReleaseStatus = new Promise<Parameters<typeof resolveReleaseStatus>[0]>(
      resolve => {
        resolveReleaseStatus = resolve
      }
    )
    ;(window.clerum as any).auth.getDesktopReleaseStatus.mockReturnValue(pendingReleaseStatus)
    renderApp()
    for (let pass = 0; pass < 8; pass += 1) {
      if (screen.queryByTestId('nav-files')) break
      await flushFrames()
      await act(async () => {
        await Promise.resolve()
      })
    }
    expect(await screen.findByTestId('nav-files')).toBeTruthy()

    fireEvent.click(screen.getByTestId('nav-sandbox-ui'))
    fireEvent.click(await screen.findByRole('button', { name: 'Open Alpha' }))
    await flushFrames()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect((window.clerum as any).sandboxUi.open).toHaveBeenCalled())
    await waitFor(() =>
      expect((window.clerum as any).sandboxUi.setVisible).toHaveBeenLastCalledWith(true)
    )

    const releaseStatusProducer = (window.clerum as any).auth.getDesktopReleaseStatus
    await waitFor(() => expect(releaseStatusProducer).toHaveBeenCalled())
    await act(async () => {
      resolveReleaseStatus({
        checked: true,
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        minimumVersion: '1.0.0',
        updateRequired: true,
        releaseUrl: 'https://example.invalid/release',
      })
      await pendingReleaseStatus
    })
    expect(await screen.findByRole('dialog')).toBeTruthy()

    // The real release-status producer must reach the App-root visibility owner.
    expect((window.clerum as any).sandboxUi.setVisible).toHaveBeenLastCalledWith(false)
  })

  it('joins the real environment-setup producer and App-root dialog with SandboxUiPage', async () => {
    compactMedia(false)
    const native = await createNativeCommitTestHarness()
    const producer = native.service as any
    const newRest = 'https://api-c.example.test'
    producer.authClient = {
      googleLogin: vi.fn().mockResolvedValue({
        token: 'synthetic-session-a',
        me: {
          id: 'user-1',
          email: 'test@clerum.io',
          name: 'Test User',
          picture: null,
          teamId: 'team-a',
          teamName: 'Team A',
          role: 'member',
        },
      }),
      getDesktopEnvironment: vi.fn().mockResolvedValue({
        appName: 'Environment C',
        externalRestApiBaseUrl: newRest,
        rpcProxyBaseUrl: 'https://rpc-c.example.test',
      }),
    }
    producer.suspendDesktopGfsUploadsForAuthBoundary = vi.fn(async () => {})
    await producer.googleLogin('synthetic-google-token')
    uninstallMockClerum()
    installPlatformBoundary(false, producer)
    ;(window.clerum as any).auth.saveRuntimeConfig = producer.saveRuntimeConfig.bind(producer)
    renderApp()
    for (let pass = 0; pass < 8; pass += 1) {
      if (screen.queryByTestId('nav-files')) break
      await flushFrames()
      await act(async () => {
        await Promise.resolve()
      })
    }
    expect(await screen.findByTestId('nav-files')).toBeTruthy()
    fireEvent.click(screen.getByTestId('nav-sandbox-ui'))
    fireEvent.click(await screen.findByRole('button', { name: 'Open Alpha' }))
    await flushFrames()
    await waitFor(() =>
      expect((window.clerum as any).sandboxUi.setVisible).toHaveBeenLastCalledWith(true)
    )

    expect((window.clerum as any).auth.onDesktopEnvironmentSetup).toHaveBeenCalledOnce()
    let environmentHandoff: Promise<void> | undefined
    act(() => {
      environmentHandoff = emitEnvironmentSetup?.({
        appName: 'Environment B',
        externalRestApiBaseUrl: newRest,
      })
    })
    expect(await screen.findByText('Switch desktop environment?')).toBeTruthy()
    expect((window.clerum as any).sandboxUi.setVisible).toHaveBeenLastCalledWith(false)

    fireEvent.click(screen.getByRole('button', { name: 'Sign out and switch' }))
    expect(await screen.findByText('Add desktop environment?')).toBeTruthy()
    await act(async () => {
      await environmentHandoff
    })
    await waitFor(() => expect((window.clerum as any).sandboxUi.close).toHaveBeenCalled())
    const sandboxCloseIndex = visibilityLifecycleEvents.indexOf('close')
    expect(sandboxCloseIndex).toBeGreaterThanOrEqual(0)
    expect(visibilityLifecycleEvents.slice(sandboxCloseIndex + 1)).not.toContain('visible:true')

    fireEvent.click(screen.getByRole('button', { name: 'Add environment' }))
    expect(await screen.findByText('Environment saved')).toBeTruthy()
    expect(visibilityLifecycleEvents.slice(sandboxCloseIndex + 1)).not.toContain('visible:true')
  })
})
