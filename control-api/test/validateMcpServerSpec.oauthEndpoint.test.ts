import { describe, expect, it, vi } from 'vitest'
import { validateOAuthEndpointUrl } from '../src/http/validateMcpServerSpec.js'

/**
 * Kernel §4 (spec 19): validateOAuthEndpointUrl. https + public host + resolve→
 * non-blocked IP. `resolveDns` is injected (vi.fn) so the check runs with no
 * cluster, mirroring validateMcpServerSpec.test.ts's preflight tests.
 */
const FIELD = 'spec.oauth.tokenUrl'

describe('validateOAuthEndpointUrl (kernel §4)', () => {
  it('accepts https + public host resolving to a public IPv4', async () => {
    const resolveDns = vi.fn(async () => ['93.184.216.34'])
    const errors = await validateOAuthEndpointUrl('https://api.example.com/oauth/token', FIELD, {
      resolveDns,
    })
    expect(errors).toEqual([])
    expect(resolveDns).toHaveBeenCalledTimes(1)
    expect(resolveDns).toHaveBeenCalledWith('api.example.com')
  })

  it('rejects http scheme (still validates host + resolve)', async () => {
    const resolveDns = vi.fn(async () => ['93.184.216.34'])
    const errors = await validateOAuthEndpointUrl('http://api.example.com/token', FIELD, {
      resolveDns,
    })
    expect(errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: FIELD, message: 'must use https' })])
    )
    // host is public + resolves clean, so `must use https` is the only error.
    expect(errors).toHaveLength(1)
    expect(resolveDns).toHaveBeenCalledTimes(1)
  })

  it('rejects a host resolving to a private range', async () => {
    const resolveDns = vi.fn(async () => ['10.0.0.5'])
    const errors = await validateOAuthEndpointUrl('https://api.example.com/token', FIELD, {
      resolveDns,
    })
    expect(errors).toEqual([
      expect.objectContaining({ field: FIELD, message: expect.stringContaining('10.0.0.5') }),
    ])
  })

  it('rejects a host resolving to the metadata IP', async () => {
    const resolveDns = vi.fn(async () => ['169.254.169.254'])
    const errors = await validateOAuthEndpointUrl('https://api.example.com/token', FIELD, {
      resolveDns,
    })
    expect(errors).toEqual([
      expect.objectContaining({
        field: FIELD,
        message: expect.stringContaining('169.254.169.254'),
      }),
    ])
  })

  it.each(['https://foo.local/token', 'https://localhost/token', 'https://10.0.0.1/token'])(
    'rejects internal/literal host %s without resolving DNS',
    async rawUrl => {
      const resolveDns = vi.fn(async () => ['93.184.216.34'])
      const errors = await validateOAuthEndpointUrl(rawUrl, FIELD, { resolveDns })
      expect(errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: FIELD,
            message: 'host must be a public DNS hostname',
          }),
        ])
      )
      expect(resolveDns).not.toHaveBeenCalled()
    }
  )

  it('rejects a malformed URL without resolving DNS', async () => {
    const resolveDns = vi.fn(async () => ['93.184.216.34'])
    const errors = await validateOAuthEndpointUrl('not a url', FIELD, { resolveDns })
    expect(errors).toEqual([{ field: FIELD, message: 'must be a valid absolute URL' }])
    expect(resolveDns).not.toHaveBeenCalled()
  })

  it('rejects a host that does not resolve to an A record', async () => {
    const resolveDns = vi.fn(async () => [])
    const errors = await validateOAuthEndpointUrl('https://api.example.com/token', FIELD, {
      resolveDns,
    })
    expect(errors).toEqual([
      expect.objectContaining({
        field: FIELD,
        message: expect.stringContaining('did not resolve'),
      }),
    ])
  })

  it('surfaces a DNS resolution error', async () => {
    const resolveDns = vi.fn(async () => {
      throw new Error('ENOTFOUND')
    })
    const errors = await validateOAuthEndpointUrl('https://api.example.com/token', FIELD, {
      resolveDns,
    })
    expect(errors).toEqual([
      expect.objectContaining({
        field: FIELD,
        message: expect.stringContaining('could not be resolved: ENOTFOUND'),
      }),
    ])
  })

  // T1 rebind: each validation is independent — the same host that resolved to a
  // public IP on one call is rejected when it resolves to a blocked IP on the
  // next. No caching across calls.
  it('re-resolves on every call (no cross-call cache)', async () => {
    const resolveDns = vi
      .fn<(host: string) => Promise<string[]>>()
      .mockResolvedValueOnce(['93.184.216.34'])
      .mockResolvedValueOnce(['10.0.0.5'])

    const first = await validateOAuthEndpointUrl('https://rebind.example.com/token', FIELD, {
      resolveDns,
    })
    expect(first).toEqual([])

    const second = await validateOAuthEndpointUrl('https://rebind.example.com/token', FIELD, {
      resolveDns,
    })
    expect(second).toEqual([
      expect.objectContaining({ field: FIELD, message: expect.stringContaining('10.0.0.5') }),
    ])
    expect(resolveDns).toHaveBeenCalledTimes(2)
  })
})
