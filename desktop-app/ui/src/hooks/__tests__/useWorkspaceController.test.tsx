// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_TOAST_DURATION_MS } from '@constants/toasts'
import { useWorkspaceController } from '../useWorkspaceController'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

type SessionState = {
  authenticated: boolean
  me: { id: string; email: string; name: string; teamId: string; teamName: string } | null
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

function createCatalog() {
  return {
    userId: 'user-1',
    teamId: '',
    agentNames: [],
    userAgentNames: [],
    teamAgentNames: [],
    mcpServersByAgent: {},
    agentContextByName: {},
    contextIds: [],
    userContextIds: [],
    teamContextIds: [],
  }
}

function createHealth() {
  return {
    externalRestApi: { ok: true },
    rpcProxy: { ok: true },
  }
}

function createSessionState(authenticated: boolean): SessionState {
  return authenticated
    ? {
        authenticated: true,
        me: {
          id: 'user-1',
          email: 'test@clerum.io',
          name: 'Test User',
          teamId: 'team-1',
          teamName: 'Test Team',
        },
      }
    : {
        authenticated: false,
        me: null,
      }
}

function installClerumHarness(
  options: {
    delayAuthenticatedLoad?: boolean
    delayHealth?: boolean
    healthError?: unknown
    passwordLoginError?: unknown
  } = {}
) {
  let authenticated = false
  const teamDirectoryDeferred = createDeferred<{ items: []; currentTeamId: string }>()
  const catalogDeferred = createDeferred<ReturnType<typeof createCatalog>>()
  const approvalsDeferred = createDeferred<[]>()
  const healthDeferred = createDeferred<ReturnType<typeof createHealth>>()

  const getSessionState = vi.fn(async () => createSessionState(authenticated))
  const passwordLogin = vi.fn(async () => {
    if (options.passwordLoginError) throw options.passwordLoginError
    authenticated = true
    return createSessionState(true)
  })

  const teamDirectory = vi.fn(async () =>
    options.delayAuthenticatedLoad && authenticated
      ? teamDirectoryDeferred.promise
      : { items: [], currentTeamId: '' }
  )
  const refreshCatalog = vi.fn(async () =>
    options.delayAuthenticatedLoad && authenticated ? catalogDeferred.promise : createCatalog()
  )
  const listPending = vi.fn(async () =>
    options.delayAuthenticatedLoad && authenticated ? approvalsDeferred.promise : []
  )
  const getDesktopReleaseStatus = vi.fn(async () => ({
    checked: true,
    currentVersion: '0.1.249',
    latestVersion: '0.1.250',
    minimumVersion: '0.1.250',
    updateRequired: true,
    releaseUrl: 'https://github.com/your-org/evenfire/releases/tag/desktop-app-0.1.250',
  }))

  const getDependenciesHealth = vi.fn(async () => {
    if (options.healthError) throw options.healthError
    return options.delayHealth ? healthDeferred.promise : createHealth()
  })

  Object.defineProperty(window, 'clerum', {
    configurable: true,
    writable: true,
    value: {
      auth: {
        getRuntimeConfigState: vi.fn(async () => ({
          activeProfileId: null,
          configured: false,
          isPackaged: false,
          options: [],
        })),
        getDependenciesHealth,
        getSessionState,
        passwordLogin,
        onDesktopSetupToken: vi.fn(() => () => undefined),
        onDesktopEnvironmentSetup: vi.fn(() => () => undefined),
        onExternalLogout: vi.fn(() => () => undefined),
        getDesktopReleaseStatus,
        openDesktopRelease: vi.fn(async () => undefined),
        logout: vi.fn(async () => undefined),
      },
      team: {
        list: vi.fn(async () => ({ items: [], currentTeamId: '' })),
        members: vi.fn(async () => []),
        directory: teamDirectory,
        initialDirectory: teamDirectory,
        switch: vi.fn(async () => undefined),
      },
      access: {
        refreshCatalog,
      },
      notificationPreferences: {
        get: vi.fn(async () => ({
          preferredMedium: null,
          channelFallbackEnabled: true,
          verifiedMedia: [],
        })),
        update: vi.fn(async (next: unknown) => ({
          ...(next && typeof next === 'object' ? next : {}),
          verifiedMedia: [],
        })),
      },
      approvals: {
        listPending,
        decide: vi.fn(async () => ({ ok: true })),
      },
      notifications: {
        ack: vi.fn(async () => undefined),
        subscribe: vi.fn(async (onEvent: (event: unknown) => void) => {
          onEvent({
            type: 'notification.snapshot',
            items: [],
            cursor: null,
            observedAt: new Date().toISOString(),
          })
          return async () => undefined
        }),
        status: vi.fn(async () => ({
          active: 1,
          open: 1,
          connecting: 0,
          error: 0,
          approvalRequested: 0,
          snapshot: 1,
          updated: 0,
        })),
        isSupported: vi.fn(async () => false),
        show: vi.fn(async (payload: { id: string }) => ({ supported: false, id: payload.id })),
        onClick: vi.fn(() => () => undefined),
        onAction: vi.fn(() => () => undefined),
        onFailed: vi.fn(() => () => undefined),
      },
      rpc: {
        listServers: vi.fn(async () => ({ servers: [] })),
        subscribeHostStatus: vi.fn(async () => async () => undefined),
        approveToolCall: vi.fn(async () => undefined),
        denyToolCall: vi.fn(async () => undefined),
        cancelTask: vi.fn(async () => undefined),
        listSessions: vi.fn(async () => ({ items: [] })),
        loadSessionMessages: vi.fn(async () => ({ agent: '', chatId: '', turns: [] })),
      },
      chat: {
        list: vi.fn(async () => []),
        create: vi.fn(async (_agentRef: string, chatId: string) => ({
          id: chatId,
          title: 'New Chat',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })),
        rename: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
        loadMessages: vi.fn(async () => []),
        appendMessages: vi.fn(async () => undefined),
        getLastActive: vi.fn(async () => null),
        setLastActive: vi.fn(async () => undefined),
        getIndex: vi.fn(async () => ({ chats: [] })),
      },
      desktop: {
        onWindowClosed: vi.fn(() => () => undefined),
        getStatus: vi.fn(async () => ({ status: 'inactive' })),
      },
      workflows: {
        list: vi.fn(async () => ({ items: [], count: 0 })),
        runs: vi.fn(async () => ({ items: [] })),
        listRunArtifacts: vi.fn(async () => ({ artifacts: [] })),
        trigger: vi.fn(async () => undefined),
      },
    },
  })

  return {
    passwordLogin,
    getDependenciesHealth,
    getSessionState,
    getDesktopReleaseStatus,
    resolveHealth() {
      healthDeferred.resolve(createHealth())
    },
    resolveAuthenticatedLoad() {
      teamDirectoryDeferred.resolve({ items: [], currentTeamId: '' })
      catalogDeferred.resolve(createCatalog())
      approvalsDeferred.resolve([])
    },
  }
}

function renderControllerHarness() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <AgentTaskTrackerProvider>
        <ControllerHarness />
      </AgentTaskTrackerProvider>
    </QueryClientProvider>
  )
  return { ...view, queryClient }
}

function ControllerHarness() {
  const vm = useWorkspaceController()

  return (
    <div>
      <div data-testid="booting">{String(vm.booting)}</div>
      <div data-testid="busy">{String(vm.busy)}</div>
      <div data-testid="nav-item">{vm.navItem}</div>
      {vm.toasts.map(toast => (
        <div
          key={toast.id}
          role={toast.tone === 'error' ? 'alert' : 'status'}
          data-duration-ms={toast.durationMs}
        >
          {toast.text}
        </div>
      ))}
      <button
        type="button"
        onClick={() => {
          vm.setEmail('test@clerum.io')
          vm.setPassword('test')
        }}
      >
        Set credentials
      </button>
      <button type="button" onClick={() => void vm.handlePasswordLogin()}>
        Login
      </button>
      <button type="button" onClick={() => vm.handleNavSelect('workflows')}>
        Open workflows
      </button>
      <button type="button" onClick={() => void vm.loadSession()}>
        Reload session
      </button>
    </div>
  )
}

describe('useWorkspaceController', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    delete (window as { clerum?: unknown }).clerum
  })

  it('restores the session without waiting for a slow dependency-health probe', async () => {
    const clerum = installClerumHarness({ delayHealth: true })

    renderControllerHarness()

    await waitFor(() => expect(clerum.getSessionState).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByTestId('booting').textContent).toBe('false'))

    clerum.resolveHealth()
  })

  it('logs dependency-health probe failures without blocking session restoration', async () => {
    const healthError = new Error('health endpoint unavailable')
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const clerum = installClerumHarness({ healthError })

    renderControllerHarness()

    await waitFor(() => expect(clerum.getSessionState).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByTestId('booting').textContent).toBe('false'))
    await waitFor(() =>
      expect(consoleWarn).toHaveBeenCalledWith(
        '[Desktop] Could not refresh dependency health:',
        healthError
      )
    )
  })

  it('preserves a workflow nav selection while login session hydration finishes', async () => {
    const clerum = installClerumHarness({ delayAuthenticatedLoad: true })

    renderControllerHarness()

    await waitFor(() => expect(screen.getByTestId('booting').textContent).toBe('false'))
    await waitFor(() => expect(screen.getByTestId('nav-item').textContent).toBe('chat'))

    fireEvent.click(screen.getByRole('button', { name: 'Set credentials' }))
    fireEvent.click(screen.getByRole('button', { name: 'Login' }))

    await waitFor(() => expect(clerum.passwordLogin).toHaveBeenCalledWith('test@clerum.io', 'test'))
    await waitFor(() => expect(clerum.getSessionState).toHaveBeenCalledTimes(2))

    fireEvent.click(screen.getByRole('button', { name: 'Open workflows' }))
    expect(screen.getByTestId('nav-item').textContent).toBe('workflows')

    clerum.resolveAuthenticatedLoad()

    await waitFor(() => expect(screen.getByTestId('busy').textContent).toBe('false'))
    await waitFor(() => expect(screen.getByTestId('nav-item').textContent).toBe('workflows'))
  })

  it('checks desktop release status before authenticated workspace hydration finishes', async () => {
    const clerum = installClerumHarness({ delayAuthenticatedLoad: true })

    renderControllerHarness()

    await waitFor(() => expect(screen.getByTestId('booting').textContent).toBe('false'))

    fireEvent.click(screen.getByRole('button', { name: 'Set credentials' }))
    fireEvent.click(screen.getByRole('button', { name: 'Login' }))

    await waitFor(() => expect(clerum.passwordLogin).toHaveBeenCalledWith('test@clerum.io', 'test'))
    await waitFor(() => expect(clerum.getSessionState).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(clerum.getDesktopReleaseStatus).toHaveBeenCalledTimes(1))

    expect(screen.getByTestId('busy').textContent).toBe('true')

    clerum.resolveAuthenticatedLoad()
    await waitFor(() => expect(screen.getByTestId('busy').textContent).toBe('false'))
  })

  it('resets navigation to chat on a default session reload', async () => {
    const clerum = installClerumHarness()

    renderControllerHarness()

    await waitFor(() => expect(screen.getByTestId('booting').textContent).toBe('false'))

    fireEvent.click(screen.getByRole('button', { name: 'Set credentials' }))
    fireEvent.click(screen.getByRole('button', { name: 'Login' }))

    await waitFor(() => expect(clerum.passwordLogin).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId('busy').textContent).toBe('false'))

    fireEvent.click(screen.getByRole('button', { name: 'Open workflows' }))
    await waitFor(() => expect(screen.getByTestId('nav-item').textContent).toBe('workflows'))

    fireEvent.click(screen.getByRole('button', { name: 'Reload session' }))

    await waitFor(() => expect(screen.getByTestId('nav-item').textContent).toBe('chat'))
  })

  it('shows a specific notification when password login is unauthorized', async () => {
    const clerum = installClerumHarness({
      passwordLoginError: new Error(
        "Error invoking remote method 'auth:passwordLogin': ApiError: 401 Unauthorized: Unauthorized"
      ),
    })

    renderControllerHarness()

    await waitFor(() => expect(screen.getByTestId('booting').textContent).toBe('false'))

    fireEvent.click(screen.getByRole('button', { name: 'Set credentials' }))
    fireEvent.click(screen.getByRole('button', { name: 'Login' }))

    await waitFor(() => expect(clerum.passwordLogin).toHaveBeenCalledWith('test@clerum.io', 'test'))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Email or password is incorrect.')
    )
    expect(screen.getByRole('alert').getAttribute('data-duration-ms')).toBe(
      String(DEFAULT_TOAST_DURATION_MS)
    )
  })

  it('does not treat unrelated messages containing 401 as unauthorized login failures', async () => {
    const clerum = installClerumHarness({
      passwordLoginError: new Error(
        "Error invoking remote method 'auth:passwordLogin': 4010 retries exceeded"
      ),
    })

    renderControllerHarness()

    await waitFor(() => expect(screen.getByTestId('booting').textContent).toBe('false'))

    fireEvent.click(screen.getByRole('button', { name: 'Set credentials' }))
    fireEvent.click(screen.getByRole('button', { name: 'Login' }))

    await waitFor(() => expect(clerum.passwordLogin).toHaveBeenCalledWith('test@clerum.io', 'test'))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'Login failed. Check your email and password.'
      )
    )
    expect(screen.getByRole('alert').getAttribute('data-duration-ms')).toBeNull()
  })
})
