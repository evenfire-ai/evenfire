import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AuthProvider, useAuth } from '../AuthContext'

const apiMocks = vi.hoisted(() => ({
  clearToken: vi.fn(),
  getMe: vi.fn(),
  isSilentApiError: vi.fn(),
  loginWithPassword: vi.fn(),
  logoutProfileUI: vi.fn(),
  setGlobalAuthErrorHandler: vi.fn(),
}))

vi.mock('@lib/api', () => apiMocks)
vi.mock('@lib/profileAccess', () => ({ resetProfileAccessCache: vi.fn() }))

function AuthProbe() {
  const { authState, checkAuth } = useAuth()
  return (
    <div>
      <div data-testid="auth-state">
        {authState.isLoggedIn ? `signed-in:${authState.me?.email}` : 'signed-out'}
      </div>
      <button type="button" onClick={() => void checkAuth()}>
        Check recovered session
      </button>
    </div>
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const member = {
  id: 'recovered-user',
  email: 'member@example.test',
  name: 'Member',
  teamId: 'team-1',
  teamName: 'Team One',
  role: 'admin',
}

beforeEach(() => {
  vi.clearAllMocks()
  apiMocks.isSilentApiError.mockReturnValue(false)
})

afterEach(cleanup)

describe('AuthProvider verified recovery session', () => {
  it('ignores an older anonymous auth check after recovery establishes a session', async () => {
    const initialAnonymousCheck = deferred<typeof member>()
    apiMocks.getMe.mockReturnValueOnce(initialAnonymousCheck.promise).mockResolvedValueOnce(member)

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Check recovered session' }))
    await waitFor(() =>
      expect(screen.getByTestId('auth-state')).toHaveTextContent('signed-in:member@example.test')
    )

    await act(async () => {
      initialAnonymousCheck.reject(new Error('anonymous request completed after recovery'))
      await initialAnonymousCheck.promise.catch(() => undefined)
    })

    expect(screen.getByTestId('auth-state')).toHaveTextContent('signed-in:member@example.test')
    expect(apiMocks.clearToken).not.toHaveBeenCalled()
  })
})
