import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { apiGet } from '../../lib/api'
import { AuthProvider, useAuth } from '../AuthContext'
import { ToastProvider } from '../Toast'

const replaceMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
}))

function response(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response
}

function ExpireSessionButton({ repeated = false }: { repeated?: boolean }) {
  useAuth()
  return (
    <button
      type="button"
      onClick={() => {
        const requests = repeated
          ? [apiGet('/api/v1/admin/hosts'), apiGet('/api/v1/admin/llm-models')]
          : [apiGet('/api/v1/admin/hosts')]
        void Promise.allSettled(requests)
      }}
    >
      Expire session
    </button>
  )
}

function CheckAuthButton() {
  const { checkAuth } = useAuth()
  return (
    <button type="button" onClick={() => void checkAuth()}>
      Check auth
    </button>
  )
}

function AuthProbe() {
  useAuth()
  return <div>Auth mounted</div>
}

function LogoutButton() {
  const { logout } = useAuth()
  return (
    <button type="button" onClick={() => void logout()}>
      Log out
    </button>
  )
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.unstubAllGlobals()
})

describe('AuthProvider session expiry handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.pushState({}, '', '/')
  })

  it('shows one session-expired toast and redirects to login for repeated 401s', async () => {
    window.history.pushState({}, '', '/agents/chatllm/env#runtime')
    window.localStorage.setItem('controlUiAdminToken', 'expired-token')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, { me: { id: 'admin', role: 'admin' } }))
      .mockResolvedValue(response(401, { error: 'expired' }))
    vi.stubGlobal('fetch', fetchMock)

    render(
      <ToastProvider>
        <AuthProvider>
          <ExpireSessionButton repeated />
        </AuthProvider>
      </ToastProvider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: /expire session/i }))

    await waitFor(() => {
      expect(screen.getAllByText('Session expired. Please sign in again.')).toHaveLength(1)
    })
    expect(replaceMock).toHaveBeenCalledWith('/?next=%2Fagents%2Fchatllm%2Fenv%23runtime')
    expect(replaceMock).toHaveBeenCalledTimes(1)
    expect(window.localStorage.getItem('controlUiAdminToken')).toBeNull()
  })

  it('re-arms the session-expired toast after a successful auth check', async () => {
    window.history.pushState({}, '', '/agents')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, { me: { id: 'admin', role: 'admin' } }))
      .mockResolvedValueOnce(response(401, { error: 'expired' }))
      .mockResolvedValueOnce(response(200, { me: { id: 'admin', role: 'admin' } }))
      .mockResolvedValueOnce(response(401, { error: 'expired' }))
    vi.stubGlobal('fetch', fetchMock)

    render(
      <ToastProvider>
        <AuthProvider>
          <ExpireSessionButton />
          <CheckAuthButton />
        </AuthProvider>
      </ToastProvider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: /expire session/i }))
    await waitFor(() =>
      expect(screen.getAllByText('Session expired. Please sign in again.')).toHaveLength(1)
    )

    fireEvent.click(screen.getByRole('button', { name: /check auth/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    fireEvent.click(screen.getByRole('button', { name: /expire session/i }))
    await waitFor(() =>
      expect(screen.getAllByText('Session expired. Please sign in again.')).toHaveLength(2)
    )
  })

  it('does not re-arm the session-expired toast after a failed auth check', async () => {
    window.history.pushState({}, '', '/agents')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, { me: { id: 'admin', role: 'admin' } }))
      .mockResolvedValueOnce(response(401, { error: 'expired' }))
      .mockResolvedValueOnce(response(401, { error: 'expired' }))
      .mockResolvedValueOnce(response(401, { error: 'expired' }))
    vi.stubGlobal('fetch', fetchMock)

    render(
      <ToastProvider>
        <AuthProvider>
          <ExpireSessionButton />
          <CheckAuthButton />
        </AuthProvider>
      </ToastProvider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: /expire session/i }))
    await waitFor(() =>
      expect(screen.getAllByText('Session expired. Please sign in again.')).toHaveLength(1)
    )

    fireEvent.click(screen.getByRole('button', { name: /check auth/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    fireEvent.click(screen.getByRole('button', { name: /expire session/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
    expect(screen.getAllByText('Session expired. Please sign in again.')).toHaveLength(1)
    expect(replaceMock).toHaveBeenCalledTimes(1)
  })

  it('clears legacy storage without a toast when no cookie session exists on mount', async () => {
    window.history.pushState({}, '', '/contexts/context1')
    window.localStorage.setItem('controlUiAdminToken', 'expired-token')
    const fetchMock = vi.fn().mockResolvedValue(response(401, { error: 'expired' }))
    vi.stubGlobal('fetch', fetchMock)

    render(
      <ToastProvider>
        <AuthProvider>
          <AuthProbe />
        </AuthProvider>
      </ToastProvider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('Session expired. Please sign in again.')).toBeNull()
    expect(replaceMock).not.toHaveBeenCalled()
    expect(window.localStorage.getItem('controlUiAdminToken')).toBeNull()
  })

  it('redirects to login after logout', async () => {
    window.localStorage.setItem('controlUiAdminToken', 'valid-token')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, { me: { id: 'admin', role: 'admin' } }))
      .mockResolvedValueOnce(response(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    render(
      <ToastProvider>
        <AuthProvider>
          <LogoutButton />
        </AuthProvider>
      </ToastProvider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: /log out/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(replaceMock).toHaveBeenCalledWith('/')
    expect(window.localStorage.getItem('controlUiAdminToken')).toBeNull()
  })

  it('redirects after logout even when token revocation fails', async () => {
    window.localStorage.setItem('controlUiAdminToken', 'valid-token')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, { me: { id: 'admin', role: 'admin' } }))
      .mockResolvedValueOnce(response(500, { error: 'revoke failed' }))
    vi.stubGlobal('fetch', fetchMock)

    render(
      <ToastProvider>
        <AuthProvider>
          <LogoutButton />
        </AuthProvider>
      </ToastProvider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: /log out/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(replaceMock).toHaveBeenCalledWith('/')
    expect(window.localStorage.getItem('controlUiAdminToken')).toBeNull()
  })
})
