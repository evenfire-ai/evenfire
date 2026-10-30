import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AuthExpiredError,
  ProfileApiError,
  apiGet,
  clearUnconfirmedLogout,
  loginWithPassword,
  logoutProfileUI,
  setupInvitationPasswordWithToken,
} from '@lib/api'

describe('Profile logout client boundary', () => {
  beforeEach(() => {
    window.localStorage.clear()
    clearUnconfirmedLogout()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    ['503 response', () => Promise.resolve(new Response('', { status: 503 }))],
    ['transport failure', () => Promise.reject(new TypeError('network unavailable'))],
  ])('abandons local credentials after a logout %s', async (_caseName, response) => {
    vi.mocked(fetch).mockImplementationOnce(response)
    window.localStorage.setItem('external_session_token', 'legacy-token')

    await expect(logoutProfileUI()).resolves.toEqual({
      revocationConfirmed: false,
      fencePersisted: true,
    })

    expect(window.localStorage.getItem('external_session_token')).toBeNull()
    await expect(apiGet('/api/v1/me')).rejects.toBeInstanceOf(AuthExpiredError)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each([
    ['transport failure', () => Promise.reject(new TypeError('network unavailable'))],
    ['503 response', () => Promise.resolve(new Response('', { status: 503 }))],
  ])(
    'fences only this page when browser storage rejects the logout fence after a %s',
    async (_caseName, response) => {
      const storage = {
        length: 0,
        getItem: vi.fn(() => null),
        setItem: vi.fn(() => {
          throw new DOMException('Quota exceeded', 'QuotaExceededError')
        }),
        removeItem: vi.fn(),
        clear: vi.fn(),
        key: vi.fn(() => null),
      }
      vi.stubGlobal('localStorage', storage)
      vi.mocked(fetch).mockImplementationOnce(response)

      await expect(logoutProfileUI()).resolves.toEqual({
        revocationConfirmed: false,
        fencePersisted: false,
      })

      // Liveness: the API boundary wrote through the stubbed browser storage.
      expect(window.localStorage).toBe(storage)
      expect(storage.setItem).toHaveBeenCalledWith('profile_logout_unconfirmed', 'true')
      expect(fetch).toHaveBeenCalledOnce()
      expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain('/api/v1/auth/logout')
      expect(vi.mocked(fetch).mock.calls[0]?.[1]?.method).toBe('POST')
      expect(vi.mocked(fetch).mock.calls[0]?.[1]?.credentials).toBe('include')

      // The in-memory fence still abandons the credential for this page lifetime.
      await expect(apiGet('/api/v1/me')).rejects.toBeInstanceOf(AuthExpiredError)
      expect(fetch).toHaveBeenCalledOnce()
    }
  )

  it('restores session requests only after a successful new login', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'new-test-token', me: { id: 'user-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'user-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )

    await logoutProfileUI()
    await loginWithPassword('user@example.invalid', 'new-password')
    await expect(apiGet('/api/v1/me')).resolves.toEqual({ id: 'user-1' })

    expect(vi.mocked(fetch).mock.calls[2]?.[1]?.credentials).toBe('include')
  })

  it('clears the in-memory and stored logout fence', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'user-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )

    await expect(logoutProfileUI()).resolves.toEqual({
      revocationConfirmed: false,
      fencePersisted: true,
    })
    expect(window.localStorage.getItem('profile_logout_unconfirmed')).toBe('true')
    await expect(apiGet('/api/v1/me')).rejects.toBeInstanceOf(AuthExpiredError)
    expect(fetch).toHaveBeenCalledOnce()

    clearUnconfirmedLogout()

    expect(window.localStorage.getItem('profile_logout_unconfirmed')).toBeNull()
    await expect(apiGet('/api/v1/me')).resolves.toEqual({ id: 'user-1' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('sends a recovery submission through the fence without releasing it locally', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ passwordUpdated: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )

    await logoutProfileUI()
    expect(window.localStorage.getItem('profile_logout_unconfirmed')).toBe('true')
    // Liveness: the fence blocks an ordinary session request without a fetch.
    await expect(apiGet('/api/v1/me')).rejects.toBeInstanceOf(AuthExpiredError)
    expect(fetch).toHaveBeenCalledOnce()

    await expect(
      setupInvitationPasswordWithToken(
        'synthetic-reset-proof',
        'member@example.invalid',
        'reset-row-1',
        'Synthetic-New-Password-123'
      )
    ).resolves.toEqual({ passwordUpdated: true })

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(String(vi.mocked(fetch).mock.calls[1]?.[0])).toContain(
      '/api/v1/invitations/password-reset'
    )
    expect(vi.mocked(fetch).mock.calls[1]?.[1]?.method).toBe('POST')
    expect(vi.mocked(fetch).mock.calls[1]?.[1]?.credentials).toBe('include')
    // The API boundary proves the request reached the server. Releasing the
    // fence is the screen's decision after this authoritative response.
    expect(window.localStorage.getItem('profile_logout_unconfirmed')).toBe('true')
  })

  it('keeps the fence when the server rejects the recovery submission', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'expired', message: 'Invitation has expired' }), {
          status: 410,
          headers: { 'content-type': 'application/json' },
        })
      )

    await logoutProfileUI()
    expect(window.localStorage.getItem('profile_logout_unconfirmed')).toBe('true')

    const rejected = setupInvitationPasswordWithToken(
      'synthetic-expired-reset-proof',
      'member@example.invalid',
      'reset-row-2',
      'Synthetic-New-Password-123'
    )
    await expect(rejected).rejects.toBeInstanceOf(ProfileApiError)
    await expect(rejected).rejects.toMatchObject({ status: 410, code: 'expired' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(window.localStorage.getItem('profile_logout_unconfirmed')).toBe('true')

    // Liveness: the surviving session is still fenced after the rejection.
    await expect(apiGet('/api/v1/me')).rejects.toBeInstanceOf(AuthExpiredError)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
