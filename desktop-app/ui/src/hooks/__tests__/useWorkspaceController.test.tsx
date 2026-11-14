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
  const [sessionReloads, setSessionReloads] = React.useState(0)

  return (
    <div>
      <div data-testid="booting">{String(vm.booting)}</div>
      <div data-testid="busy">{String(vm.busy)}</div>
      <div data-testid="nav-item">{vm.navItem}</div>
      <div data-testid="session-reloads">{sessionReloads}</div>
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
      <button
        type="button"
        onClick={async () => {
          await vm.loadSession()
          setSessionReloads(count => count + 1)
        }}
      >
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

  it('preserves an explicit route through default session reload navigation', async () => {
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

    await waitFor(() => expect(screen.getByTestId('session-reloads').textContent).toBe('1'))
    expect(screen.getByTestId('nav-item').textContent).toBe('workflows')
  })

  it('shows a specific notification when password login is unauthorized', async () => {
    const clerum = installClerumHarness({
      passwordLoginError: new Error(
        "Error invoking remote method 'auth:passwordLogin': Error: 401 Unauthorized: Unauthorized httpStatus=401"
      ),
    })
    const diagnoseLoginBackend = vi.fn(async () => null)
    Object.assign(window.clerum.auth, { diagnoseLoginBackend })

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
    await waitFor(() => expect(screen.getByTestId('busy').textContent).toBe('false'))
    expect(diagnoseLoginBackend).not.toHaveBeenCalled()
  })

  it.each([
    ['1', 'Please try again in about a second.'],
    ['17', 'Please try again in about 17 seconds.'],
    // The minutes form starts above 90 s and rounds up, so it never under-promises.
    ['61', 'Please try again in about 61 seconds.'],
    ['90', 'Please try again in about 90 seconds.'],
    ['91', 'Please try again in about 2 minutes.'],
    ['121', 'Please try again in about 3 minutes.'],
    // 404 and 410 must not read as other failures, which name those digits.
    ['404', 'Please try again in about 7 minutes.'],
    ['410', 'Please try again in about 7 minutes.'],
    ['900', 'Please try again in about 15 minutes.'],
  ])(
    'explains a rate-limited login without blaming the password (wait %s s)',
    async (seconds, retryText) => {
      const clerum = installClerumHarness({
        passwordLoginError: new Error(
          `Error invoking remote method 'auth:passwordLogin': Error: 429 Too Many Requests: rate_limited httpStatus=429 retryAfterSeconds=${seconds}`
        ),
      })
      const diagnoseLoginBackend = vi.fn(async () => null)
      Object.assign(window.clerum.auth, { diagnoseLoginBackend })

      renderControllerHarness()

      await waitFor(() => expect(screen.getByTestId('booting').textContent).toBe('false'))

      fireEvent.click(screen.getByRole('button', { name: 'Set credentials' }))
      fireEvent.click(screen.getByRole('button', { name: 'Login' }))

      await waitFor(() =>
        expect(clerum.passwordLogin).toHaveBeenCalledWith('test@clerum.io', 'test')
      )
      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(retryText))
      const alert = screen.getByRole('alert').textContent
      expect(alert).toContain('Sign-in is paused for now. Your password was not checked.')
      expect(alert).not.toContain('Check your email and password')
      expect(screen.getByRole('alert').getAttribute('data-duration-ms')).toBeNull()
      expect(diagnoseLoginBackend).not.toHaveBeenCalled()
    }
  )

  it('asks to try later when a rate-limited login has no wait', async () => {
    const clerum = installClerumHarness({
      passwordLoginError: new Error(
        "Error invoking remote method 'auth:passwordLogin': Error: 429 Too Many Requests: rate_limited httpStatus=429"
      ),
    })

    renderControllerHarness()

    await waitFor(() => expect(screen.getByTestId('booting').textContent).toBe('false'))

    fireEvent.click(screen.getByRole('button', { name: 'Set credentials' }))
    fireEvent.click(screen.getByRole('button', { name: 'Login' }))

    await waitFor(() => expect(clerum.passwordLogin).toHaveBeenCalledWith('test@clerum.io', 'test'))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'Your password was not checked. Please try again in a little while.'
      )
    )
  })

  it('stays busy while the login is pending and is usable again after a rate limit', async () => {
    const clerum = installClerumHarness()
    let rejectLogin: (error: Error) => void = () => undefined
    clerum.passwordLogin.mockImplementationOnce(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectLogin = reject
        })
    )

    renderControllerHarness()

    await waitFor(() => expect(screen.getByTestId('booting').textContent).toBe('false'))

    fireEvent.click(screen.getByRole('button', { name: 'Set credentials' }))
    fireEvent.click(screen.getByRole('button', { name: 'Login' }))

    await waitFor(() => expect(clerum.passwordLogin).toHaveBeenCalledWith('test@clerum.io', 'test'))
    await waitFor(() => expect(screen.getByTestId('busy').textContent).toBe('true'))

    rejectLogin(
      new Error(
        "Error invoking remote method 'auth:passwordLogin': Error: 429 Too Many Requests: rate_limited httpStatus=429 retryAfterSeconds=17"
      )
    )

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Sign-in is paused for now.')
    )
    await waitFor(() => expect(screen.getByTestId('busy').textContent).toBe('false'))
  })

  it.each([
    [
      '503 issuance',
      'Error: 503 Service Unavailable: session issuance failed httpStatus=503',
      "Sign-in isn't available right now. Please try again in a moment.",
    ],
    [
      'an imitating 500 body',
      'Error: 500 Internal Server Error: {"detail":"httpStatus=429"} httpStatus=500',
      "Sign-in isn't available right now. Please try again in a moment.",
    ],
    [
      'no HTTP answer',
      'Error: fetch failed signInTransport=noResponse',
      "Sign-in isn't available right now. Please try again in a moment.",
    ],
    [
      '426',
      'Error: 426 Upgrade Required: desktop_update_required httpStatus=426',
      'Login failed. Check your email and password.',
    ],
    [
      'a 400 whose body names 410',
      'Error: 400 Bad Request: {"error":"code 410 invitation_expired"} httpStatus=400',
      'Login failed. Check your email and password.',
    ],
    [
      'a 404 from a wrong server',
      'Error: 404 Not Found: no route httpStatus=404',
      'Login failed. Check your email and password.',
    ],
    [
      'an unmarked 401 in prose',
      'Error: 401 Unauthorized: x',
      'Login failed. Check your email and password.',
    ],
  ])('shows its own text and probes the backend for %s', async (_label, message, text) => {
    const clerum = installClerumHarness({
      passwordLoginError: new Error(
        `Error invoking remote method 'auth:passwordLogin': ${message}`
      ),
    })
    const diagnoseLoginBackend = vi.fn(async () => null)
    Object.assign(window.clerum.auth, { diagnoseLoginBackend })

    renderControllerHarness()

    await waitFor(() => expect(screen.getByTestId('booting').textContent).toBe('false'))

    fireEvent.click(screen.getByRole('button', { name: 'Set credentials' }))
    fireEvent.click(screen.getByRole('button', { name: 'Login' }))

    await waitFor(() => expect(clerum.passwordLogin).toHaveBeenCalledWith('test@clerum.io', 'test'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(text))
    const alert = screen.getByRole('alert').textContent
    expect(alert).not.toContain('Email or password is incorrect.')
    expect(alert).not.toContain('Invitation expired.')
    expect(alert).not.toContain('You must be invited')
    expect(screen.getByRole('alert').getAttribute('data-duration-ms')).toBeNull()
    await waitFor(() => expect(diagnoseLoginBackend).toHaveBeenCalledTimes(1))
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
