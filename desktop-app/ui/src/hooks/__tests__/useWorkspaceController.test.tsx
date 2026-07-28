// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_TOAST_DURATION_MS } from '@constants/toasts'
import {
  type AppControllerClerumOptions,
  installAppControllerClerum,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'
import { useWorkspaceController } from '../useWorkspaceController'

/**
 * `useWorkspaceController` is a deprecated re-export of `useAppController`, so
 * the `window.clerum` bridge these tests need is the same one
 * `hooks/domain/__tests__/chatSelectionAcrossRouteChange` needs. It lives in the
 * shared fixture; only the deltas this suite depends on are spelled out here.
 */
const OUTDATED_DESKTOP_RELEASE = {
  checked: true,
  currentVersion: '0.1.249',
  latestVersion: '0.1.250',
  minimumVersion: '0.1.250',
  updateRequired: true,
  releaseUrl: 'https://github.com/your-org/evenfire/releases/tag/desktop-app-0.1.250',
}

/**
 * Boots at the login screen (these tests drive `handlePasswordLogin` themselves),
 * with no agents in the access catalog and an update-required release status.
 */
function installClerumHarness(options: AppControllerClerumOptions = {}) {
  return installAppControllerClerum({
    startAuthenticated: false,
    agentNames: [],
    desktopReleaseStatus: OUTDATED_DESKTOP_RELEASE,
    ...options,
  }).handle
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
    uninstallMockClerum()
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
