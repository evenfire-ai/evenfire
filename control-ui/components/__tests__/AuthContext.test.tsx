import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { apiGet } from '../../lib/api'
import {
  PublishScopeProvider,
  resetPublishScopeCache,
  usePublishScope,
} from '../../lib/hooks/usePublishScope'
import {
  __resetRegistryCapabilityCacheForTests,
  useRegistryCapability,
} from '../../lib/hooks/useRegistryCapability'
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

function LoginButton() {
  const { login } = useAuth()
  return (
    <button type="button" onClick={() => void login('admin-b', 'password')}>
      Log in
    </button>
  )
}

function AuthUserProbe() {
  const { authState } = useAuth()
  return <div data-testid="auth-user">{authState.username || 'signed-out'}</div>
}

function AuthProbe() {
  useAuth()
  return <div>Auth mounted</div>
}

function PublishScopeProbe() {
  const { loading, scope } = usePublishScope()
  return <div data-testid="publish-scope">{loading ? 'loading' : (scope?.orgName ?? 'none')}</div>
}

function RegistryCapabilityProbe() {
  const { capability, loading } = useRegistryCapability()
  return (
    <div data-testid="registry-capability">
      {loading ? 'loading' : (capability?.orgName ?? 'none')}
    </div>
  )
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
  resetPublishScopeCache()
  __resetRegistryCapabilityCacheForTests()
  window.localStorage.clear()
  vi.unstubAllGlobals()
})

describe('AuthProvider session expiry handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetPublishScopeCache()
    __resetRegistryCapabilityCacheForTests()
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

  it('clears publish-scope and registry-capability caches after login', async () => {
    let registryIdentity = 'Org A'
    const requests: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method || 'GET'
      requests.push(`${method} ${url}`)
      if (url.includes('/api/v1/admin/registry/publish-scope')) {
        return response(200, {
          scope: registryIdentity === 'Org A' ? '@org-a' : '@org-b',
          curator: false,
          orgName: registryIdentity,
        })
      }
      if (url.includes('/api/v1/admin/registry/connect')) {
        return response(200, {
          state: 'connected',
          org: registryIdentity,
          authEnabled: true,
        })
      }
      if (url.includes('/api/v1/admin/auth/me')) {
        return response(401, { error: 'expired' })
      }
      if (url.includes('/api/v1/admin/auth/login')) {
        return response(200, {
          me: { id: 'admin', username: 'admin-b', email: 'b@example.com' },
        })
      }
      throw new Error(`unexpected request: ${method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const publishA = render(
      <PublishScopeProvider cacheKey="admin">
        <PublishScopeProbe />
      </PublishScopeProvider>
    )
    await waitFor(() => expect(screen.getByTestId('publish-scope')).toHaveTextContent('Org A'))
    publishA.unmount()

    const capabilityA = render(<RegistryCapabilityProbe />)
    await waitFor(() =>
      expect(screen.getByTestId('registry-capability')).toHaveTextContent('Org A')
    )
    capabilityA.unmount()

    registryIdentity = 'Org B'
    const auth = render(
      <ToastProvider>
        <AuthProvider>
          <LoginButton />
          <AuthUserProbe />
        </AuthProvider>
      </ToastProvider>
    )
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/auth/me'), expect.anything())
    )
    fireEvent.click(screen.getByRole('button', { name: /log in/i }))
    await waitFor(() => expect(screen.getByTestId('auth-user')).toHaveTextContent('admin-b'))
    auth.unmount()

    render(
      <PublishScopeProvider cacheKey="admin">
        <PublishScopeProbe />
      </PublishScopeProvider>
    )
    await waitFor(() => expect(screen.getByTestId('publish-scope')).toHaveTextContent('Org B'))
    cleanup()

    render(<RegistryCapabilityProbe />)
    await waitFor(() =>
      expect(screen.getByTestId('registry-capability')).toHaveTextContent('Org B')
    )
    expect(
      requests.filter(request => request.includes('/api/v1/admin/registry/publish-scope'))
    ).toHaveLength(4)
  })

  it('clears publish-scope and registry-capability caches after session expiration', async () => {
    let registryIdentity = 'Org A'
    const requests: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method || 'GET'
      requests.push(`${method} ${url}`)
      if (url.includes('/api/v1/admin/registry/publish-scope')) {
        return response(200, {
          scope: registryIdentity === 'Org A' ? '@org-a' : '@org-b',
          curator: false,
          orgName: registryIdentity,
        })
      }
      if (url.includes('/api/v1/admin/registry/connect')) {
        return response(200, {
          state: 'connected',
          org: registryIdentity,
          authEnabled: true,
        })
      }
      if (url.includes('/api/v1/admin/auth/me')) {
        return response(200, { me: { id: 'admin', username: 'admin-a' } })
      }
      if (url.includes('/api/v1/admin/hosts')) {
        return response(401, { error: 'expired' })
      }
      throw new Error(`unexpected request: ${method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const publishA = render(
      <PublishScopeProvider cacheKey="admin">
        <PublishScopeProbe />
      </PublishScopeProvider>
    )
    await waitFor(() => expect(screen.getByTestId('publish-scope')).toHaveTextContent('Org A'))
    publishA.unmount()

    const capabilityA = render(<RegistryCapabilityProbe />)
    await waitFor(() =>
      expect(screen.getByTestId('registry-capability')).toHaveTextContent('Org A')
    )
    capabilityA.unmount()

    render(
      <ToastProvider>
        <AuthProvider>
          <ExpireSessionButton />
        </AuthProvider>
      </ToastProvider>
    )
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/auth/me'), expect.anything())
    )
    fireEvent.click(screen.getByRole('button', { name: /expire session/i }))
    await waitFor(() =>
      expect(screen.getAllByText('Session expired. Please sign in again.')).toHaveLength(1)
    )
    cleanup()

    registryIdentity = 'Org B'
    render(
      <PublishScopeProvider cacheKey="admin">
        <PublishScopeProbe />
      </PublishScopeProvider>
    )
    await waitFor(() => expect(screen.getByTestId('publish-scope')).toHaveTextContent('Org B'))
    cleanup()

    render(<RegistryCapabilityProbe />)
    await waitFor(() =>
      expect(screen.getByTestId('registry-capability')).toHaveTextContent('Org B')
    )
    expect(
      requests.filter(request => request.includes('/api/v1/admin/registry/publish-scope'))
    ).toHaveLength(4)
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
