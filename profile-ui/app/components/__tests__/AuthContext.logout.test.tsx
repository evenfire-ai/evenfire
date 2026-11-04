import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AuthProvider, useAuth } from '@components/AuthContext'
import { ToastProvider } from '@components/Toast'

const mocks = vi.hoisted(() => ({
  clearToken: vi.fn(),
  getMe: vi.fn(),
  isSilentApiError: vi.fn(),
  loginWithPassword: vi.fn(),
  logoutProfileUI: vi.fn(),
  setGlobalAuthErrorHandler: vi.fn(),
  resetProfileAccessCache: vi.fn(),
}))

vi.mock('@lib/api', () => ({
  clearToken: mocks.clearToken,
  getMe: mocks.getMe,
  isSilentApiError: mocks.isSilentApiError,
  loginWithPassword: mocks.loginWithPassword,
  logoutProfileUI: mocks.logoutProfileUI,
  setGlobalAuthErrorHandler: mocks.setGlobalAuthErrorHandler,
}))

vi.mock('@lib/profileAccess', () => ({ resetProfileAccessCache: mocks.resetProfileAccessCache }))

type LogoutResult = {
  revocationConfirmed: boolean
  fencePersisted: boolean
  sessionAbsent: boolean
}

const unsavedFailure: LogoutResult = {
  revocationConfirmed: false,
  fencePersisted: false,
  sessionAbsent: false,
}

const noSessionReached: LogoutResult = {
  revocationConfirmed: false,
  fencePersisted: false,
  sessionAbsent: true,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => {
    resolve = next
  })
  return { promise, resolve }
}

function AuthProbe() {
  const { authState, login, logout, signOutIncomplete, signOutPending, retrySignOut } = useAuth()
  return (
    <div>
      <span>{authState.isLoggedIn ? 'signed-in' : 'signed-out'}</span>
      <span>{signOutPending ? 'sign-out-pending' : 'sign-out-idle'}</span>
      <button type="button" onClick={logout}>
        Log out
      </button>
      <button type="button" onClick={() => void login('user@example.invalid', 'password')}>
        Log in
      </button>
      {signOutIncomplete ? <p role="alert">Sign-out is not complete</p> : null}
      <button type="button" onClick={retrySignOut}>
        Retry sign-out
      </button>
    </div>
  )
}

describe('Profile logout consumer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.logoutProfileUI.mockReset()
    mocks.getMe.mockResolvedValue({ id: 'user-1', email: 'user@example.invalid' })
    mocks.isSilentApiError.mockReturnValue(false)
  })

  afterEach(cleanup)

  it('stays signed out and explains unconfirmed revocation', async () => {
    mocks.logoutProfileUI.mockResolvedValueOnce({
      revocationConfirmed: false,
      fencePersisted: true,
      sessionAbsent: false,
    })
    render(
      <ToastProvider>
        <AuthProvider>
          <AuthProbe />
        </AuthProvider>
      </ToastProvider>
    )

    await screen.findByText('signed-in')
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }))

    expect(screen.getByText('signed-out')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        /server could not confirm that your session was revoked/i
      )
    )
  })

  it('handles an unexpected logout rejection without an unhandled promise', async () => {
    mocks.logoutProfileUI.mockRejectedValueOnce(new Error('unexpected transport failure'))
    render(
      <ToastProvider>
        <AuthProvider>
          <AuthProbe />
        </AuthProvider>
      </ToastProvider>
    )

    await screen.findByText('signed-in')
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }))

    expect(screen.getByText('signed-out')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        /server could not confirm that your session was revoked/i
      )
    )
  })

  function renderSignedIn() {
    render(
      <ToastProvider>
        <AuthProvider>
          <AuthProbe />
        </AuthProvider>
      </ToastProvider>
    )
  }

  async function logOutWithUnsavedFence() {
    await screen.findByText('signed-in')
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }))

    expect(screen.getByText('signed-out')).toBeInTheDocument()
    await screen.findByRole('alert')
    expect(mocks.logoutProfileUI).toHaveBeenCalledOnce()
    // The working-storage toast would claim a sign-out this browser cannot keep.
    expect(screen.queryByText(/signed out here/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Retry sign-out' }))
    expect(mocks.logoutProfileUI).toHaveBeenCalledTimes(2)
  }

  it('keeps the local sign-out and confirms a retry that revoked the session', async () => {
    mocks.logoutProfileUI
      .mockResolvedValueOnce({
        revocationConfirmed: false,
        fencePersisted: false,
        sessionAbsent: false,
      })
      .mockResolvedValueOnce({
        revocationConfirmed: true,
        fencePersisted: false,
        sessionAbsent: false,
      })
    renderSignedIn()

    await logOutWithUnsavedFence()

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByText('signed-out')).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('reports an unconfirmed revocation when the retry reached no session', async () => {
    mocks.logoutProfileUI
      .mockResolvedValueOnce({
        revocationConfirmed: false,
        fencePersisted: false,
        sessionAbsent: false,
      })
      .mockResolvedValueOnce({
        revocationConfirmed: false,
        fencePersisted: false,
        sessionAbsent: true,
      })
    renderSignedIn()

    await logOutWithUnsavedFence()

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        /server could not confirm that your session was revoked/i
      )
    )
    expect(screen.getByText('signed-out')).toBeInTheDocument()
  })

  it('keeps offering the retry when the retry fails while the cookie may remain', async () => {
    const retry = deferred<LogoutResult>()
    mocks.logoutProfileUI.mockResolvedValueOnce(unsavedFailure).mockReturnValueOnce(retry.promise)
    renderSignedIn()

    await logOutWithUnsavedFence()
    expect(screen.getByText('sign-out-pending')).toBeInTheDocument()

    await act(async () => retry.resolve(unsavedFailure))

    // Liveness: the retry's answer was processed, not only requested.
    await screen.findByText('sign-out-idle')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText('signed-out')).toBeInTheDocument()
  })

  it('sends one retry at a time, so overlapping answers cannot show the banner and the notice together', async () => {
    const retry = deferred<LogoutResult>()
    const secondRetry = deferred<LogoutResult>()
    mocks.logoutProfileUI
      .mockResolvedValueOnce(unsavedFailure)
      .mockReturnValueOnce(retry.promise)
      .mockReturnValueOnce(secondRetry.promise)
    renderSignedIn()

    await logOutWithUnsavedFence()
    fireEvent.click(screen.getByRole('button', { name: 'Retry sign-out' }))

    // The answer without a session arrives first; a failure for a second request would follow.
    await act(async () => retry.resolve(noSessionReached))
    await act(async () => secondRetry.resolve(unsavedFailure))

    // Liveness: the first retry's answer reached the screen.
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        /server could not confirm that your session was revoked/i
      )
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(mocks.logoutProfileUI).toHaveBeenCalledTimes(2)
  })

  it('ignores a sign-out answer that arrives after a new login', async () => {
    const retry = deferred<LogoutResult>()
    mocks.logoutProfileUI.mockResolvedValueOnce(unsavedFailure).mockReturnValueOnce(retry.promise)
    mocks.loginWithPassword.mockResolvedValueOnce({
      token: 'test-token',
      me: { id: 'user-1', email: 'user@example.invalid' },
    })
    renderSignedIn()

    await logOutWithUnsavedFence()
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
    await screen.findByText('signed-in')
    expect(mocks.loginWithPassword).toHaveBeenCalledOnce()

    await act(async () => retry.resolve(noSessionReached))

    // Liveness: the late answer was delivered to the provider before the checks below.
    await expect(mocks.logoutProfileUI.mock.results[1]?.value).resolves.toEqual(noSessionReached)
    await act(async () => {})
    expect(screen.getByText('signed-in')).toBeInTheDocument()
    expect(screen.queryByText(/signed out here/i)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('sign-out-idle')).toBeInTheDocument()
  })

  it('a new login clears the incomplete sign-out', async () => {
    mocks.logoutProfileUI.mockResolvedValueOnce({
      revocationConfirmed: false,
      fencePersisted: false,
      sessionAbsent: false,
    })
    mocks.loginWithPassword.mockResolvedValueOnce({
      token: 'test-token',
      me: { id: 'user-1', email: 'user@example.invalid' },
    })
    render(
      <ToastProvider>
        <AuthProvider>
          <AuthProbe />
        </AuthProvider>
      </ToastProvider>
    )

    await screen.findByText('signed-in')
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }))
    await screen.findByRole('alert')

    fireEvent.click(screen.getByRole('button', { name: 'Log in' }))

    await waitFor(() => expect(mocks.loginWithPassword).toHaveBeenCalledOnce())
    await screen.findByText('signed-in')
    expect(screen.queryByRole('alert')).toBeNull()

    // A later 401 must not revive the stale banner on the login screen.
    const handleGlobalAuthError = mocks.setGlobalAuthErrorHandler.mock.calls[0]?.[0] as () => void
    act(() => handleGlobalAuthError())

    expect(screen.getByText('signed-out')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('confirmed logout shows no warning', async () => {
    mocks.logoutProfileUI.mockResolvedValueOnce({
      revocationConfirmed: true,
      fencePersisted: true,
      sessionAbsent: false,
    })
    render(
      <ToastProvider>
        <AuthProvider>
          <AuthProbe />
        </AuthProvider>
      </ToastProvider>
    )

    await screen.findByText('signed-in')
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }))

    expect(screen.getByText('signed-out')).toBeInTheDocument()
    await mocks.logoutProfileUI.mock.results[0]?.value
    await act(async () => {})

    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
