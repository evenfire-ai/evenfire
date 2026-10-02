import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  const { authState, logout } = useAuth()
  return (
    <div>
      <span>{authState.isLoggedIn ? 'signed-in' : 'signed-out'}</span>
      <button type="button" onClick={logout}>
        Log out
      </button>
    </div>
  )
}

describe('Profile logout consumer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getMe.mockResolvedValue({ id: 'user-1', email: 'user@example.invalid' })
    mocks.isSilentApiError.mockReturnValue(false)
  })

  afterEach(cleanup)

  it('stays signed out and explains unconfirmed revocation', async () => {
    mocks.logoutProfileUI.mockResolvedValueOnce({ revocationConfirmed: false })
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
})
