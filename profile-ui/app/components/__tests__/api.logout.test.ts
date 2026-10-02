import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthExpiredError, apiGet, loginWithPassword, logoutProfileUI } from '@lib/api'

describe('Profile logout client boundary', () => {
  beforeEach(() => {
    window.localStorage.clear()
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

    await expect(logoutProfileUI()).resolves.toEqual({ revocationConfirmed: false })

    expect(window.localStorage.getItem('external_session_token')).toBeNull()
    await expect(apiGet('/api/v1/me')).rejects.toBeInstanceOf(AuthExpiredError)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('restores session requests only after a successful new login', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'new-token', me: { id: 'user-1' } }), {
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
})
