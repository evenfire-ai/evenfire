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

function AuthProbe() {
  const { authState, login, logout, signOutIncomplete, retrySignOut } = useAuth()
  return (
    <div>
      <span>{authState.isLoggedIn ? 'signed-in' : 'signed-out'}</span>
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

  it('keeps the local sign-out and offers a retry when the fence cannot be saved', async () => {
    mocks.logoutProfileUI
      .mockResolvedValueOnce({ revocationConfirmed: false, fencePersisted: false })
      .mockResolvedValueOnce({ revocationConfirmed: true, fencePersisted: false })
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
    await screen.findByRole('alert')
    expect(mocks.logoutProfileUI).toHaveBeenCalledOnce()
    // The working-storage toast would claim a sign-out this browser cannot keep.
    expect(screen.queryByText(/signed out here/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Retry sign-out' }))

    expect(mocks.logoutProfileUI).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByText('signed-out')).toBeInTheDocument()
  })

  it('a new login clears the incomplete sign-out', async () => {
    mocks.logoutProfileUI.mockResolvedValueOnce({
      revocationConfirmed: false,
      fencePersisted: false,
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
