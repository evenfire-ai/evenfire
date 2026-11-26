// @vitest-environment jsdom
/**
 * `App` passes the browser sign-in fields of `useAppController` through `AuthContext`: the login
 * screen's model and its refresh, main's snapshot, and the start and cancel handlers reach the
 * provider's value. The `ui` typecheck is not a gate, so this test is what catches a field that
 * is not passed on. A probe stands in for `AuthPage` and keeps the value it was given, so the
 * fields are read as `App` passes them, without the page's own reads; `AuthPage.test.tsx` covers
 * how the page uses them.
 *
 * The real coordinator boots signed out on the shared app-controller bridge. Its browser sign-in
 * calls answer from a real `BrowserSignInAttempts`, whose pushes reach the listener the renderer
 * subscribed (T1). The login model is the one main's `buildLoginMethodsModel` builds from the
 * edge's recorded answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import type { AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { installAppControllerClerum } from '@hooks/domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '@hooks/domain/__tests__/__fixtures__/mockClerum'
import { App } from '@/App'
import { BrowserSignInAttempts } from '../../../src/browserSignIn'
import { buildLoginMethodsModel } from '../../../src/browserSignInModel'
import type {
  BrowserSignInSnapshot,
  BrowserSignInStartResult,
  LoginMethodsAnswer,
} from '../../../src/types'
import { FakeBrowserSignInClock } from '../../../testSupport/browserSignInClock'
import { LOGIN_SCREEN_ROWS } from '../../../testSupport/edgeContractRecords'

const probe = vi.hoisted(() => ({ value: null as AuthContextValue | null }))

vi.mock('@pages/AuthPage', async () => {
  const { useAuthContext } = await import('@contexts/AuthContext')
  return {
    AuthPage: function AuthPageProbe() {
      probe.value = useAuthContext()
      return null
    },
  }
})

const BINDING = Object.freeze({
  environmentKey: 'fixture_env-0123456789ab',
  profileId: null,
  restBaseUrl: 'https://edge-fixture.example.test',
})

function modelOf(label: string) {
  const row = LOGIN_SCREEN_ROWS.find(([rowLabel]) => rowLabel === label)
  if (!row) throw new Error(`LOGIN_SCREEN_ROWS has no row "${label}"`)
  return buildLoginMethodsModel(row[1], { linksAvailable: true })
}

const OIDC_ONLY = modelOf('oidc-only')

/** The provider's value as the sign-in page last received it. */
function authValue(): AuthContextValue {
  if (!probe.value) throw new Error('the sign-in page has not rendered')
  return probe.value
}

/**
 * The browser sign-in and login-model calls over a real attempt store. Start records an attempt
 * after D3's bump, as main does once it is allowed.
 */
function installBrowserSignInMain() {
  const listeners = new Set<(snapshot: BrowserSignInSnapshot) => void>()
  const store = new BrowserSignInAttempts({
    push: snapshot => {
      for (const listener of [...listeners]) listener(snapshot)
    },
    warn: (message, error) => {
      throw new Error(`unexpected browser sign-in store warning: ${message}`, { cause: error })
    },
    clock: new FakeBrowserSignInClock(),
  })
  let generation = 0
  const calls = {
    getLoginMethods: vi.fn(
      async (): Promise<LoginMethodsAnswer> => ({ model: OIDC_ONLY, generation })
    ),
    onBrowserSignInChanged: vi.fn((listener: (snapshot: BrowserSignInSnapshot) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }),
    getBrowserSignInState: vi.fn(async (): Promise<BrowserSignInSnapshot> => store.snapshot()),
    startBrowserSignIn: vi.fn(async (): Promise<BrowserSignInStartResult> => {
      generation += 1
      store.onGenerationAdvanced()
      const attemptId = store.record({
        state: `fake-state-${generation}`,
        verifier: `fake-verifier-${generation}`,
        binding: BINDING,
        generation,
      })
      return { attemptId }
    }),
    cancelBrowserSignIn: vi.fn(async (): Promise<BrowserSignInSnapshot> => store.cancel()),
    acknowledgeBrowserSignInResult: vi.fn(
      async (attemptId: number): Promise<BrowserSignInSnapshot> => store.acknowledge(attemptId)
    ),
  }
  Object.assign((window.clerum as unknown as { auth: object }).auth, calls)
  return calls
}

/** What `App` touches outside the auth bridge while it boots signed out. */
function installPlatformBoundary() {
  installAppControllerClerum({ startAuthenticated: false })
  const bridge = window.clerum as unknown as Record<string, any>
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
    setVisible: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }
  bridge.pluginSdk = { onOpenGfsResource: vi.fn(() => vi.fn()) }
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

describe('App: the browser sign-in fields in AuthContext', () => {
  beforeEach(() => {
    probe.value = null
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()
      }
    )
  })

  afterEach(async () => {
    cleanup()
    await new Promise(resolve => window.setTimeout(resolve, 0))
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    uninstallMockClerum()
  })

  it('passes the browser sign-in fields from useAppController through AuthContext', async () => {
    installPlatformBoundary()
    const main = installBrowserSignInMain()
    renderApp()

    await waitFor(() => expect(probe.value, 'the signed-out app shows sign-in').not.toBeNull())
    await waitFor(() =>
      expect(authValue().browserSignIn, "main's boot snapshot").toEqual({
        attemptId: null,
        phase: 'idle',
      })
    )
    expect(authValue().loginScreen, 'no model is read before the screen asks').toEqual({
      kind: 'loading',
    })
    expect(authValue(), 'the three functions reach the provider').toMatchObject({
      refreshLoginMethods: expect.any(Function),
      handleStartBrowserSignIn: expect.any(Function),
      handleCancelBrowserSignIn: expect.any(Function),
    })

    act(() => authValue().refreshLoginMethods())
    await waitFor(() => expect(authValue().loginScreen).toEqual(OIDC_ONLY))
    expect(main.getLoginMethods).toHaveBeenCalledTimes(1)

    await act(async () => {
      await authValue().handleStartBrowserSignIn()
    })
    expect(main.startBrowserSignIn).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(authValue().browserSignIn).toEqual({ attemptId: 1, phase: 'waiting' })
    )

    await act(async () => {
      await authValue().handleCancelBrowserSignIn()
    })
    expect(main.cancelBrowserSignIn).toHaveBeenCalledTimes(1)
    // The outcome is shown and acknowledged; main's `idle` then clears the view (decision 5).
    await waitFor(() => expect(main.acknowledgeBrowserSignInResult).toHaveBeenCalledWith(1))
    await waitFor(() => expect(authValue().browserSignIn).toEqual({ attemptId: 1, phase: 'idle' }))
  })
})
