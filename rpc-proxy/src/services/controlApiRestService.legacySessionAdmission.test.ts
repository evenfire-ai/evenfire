import { afterEach, describe, expect, it, vi } from 'vitest'
import { config } from '../config.js'
import { admitLegacySessionCreation } from './controlApiRestService.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('admitLegacySessionCreation', () => {
  it('uses the existing service credential and forwards the verified user token internally', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    globalThis.fetch = fetchMock as typeof fetch

    await expect(admitLegacySessionCreation('verified-rpc-user-token')).resolves.toEqual({
      allowed: true,
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      `${config.controlApiBaseUrl.replace(/\/+$/, '')}/internal/rpc-proxy/legacy-session-admission`
    )
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      authorization: `Bearer ${config.controlApiServiceToken}`,
      'x-service-token': config.controlApiServiceName,
      'x-rpc-access-token': 'verified-rpc-user-token',
    })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('preserves only canonical bounded exhaustion headers', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'untrusted internal detail' }), {
        status: 429,
        headers: {
          'retry-after': '12',
          'x-ratelimit-limit': '60',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1800000000',
          'x-debug-subject': 'must-not-forward',
        },
      })
    ) as typeof fetch

    const result = await admitLegacySessionCreation('verified-rpc-user-token')

    expect(result).toEqual({
      allowed: false,
      status: 429,
      retryAfterSeconds: 12,
      headers: {
        'X-RateLimit-Limit': '60',
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': '1800000000',
      },
    })
  })

  it('fails closed with a sanitized bounded 503 on backend and protocol failures', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'private database details' }), {
        status: 503,
        headers: { 'retry-after': '9999', 'x-ratelimit-limit': '60' },
      })
    ) as typeof fetch

    await expect(admitLegacySessionCreation('verified-rpc-user-token')).resolves.toEqual({
      allowed: false,
      status: 503,
      retryAfterSeconds: 2,
      headers: {},
    })

    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('private transport detail')) as typeof fetch
    await expect(admitLegacySessionCreation('verified-rpc-user-token')).resolves.toEqual({
      allowed: false,
      status: 503,
      retryAfterSeconds: 2,
      headers: {},
    })
  })
})
