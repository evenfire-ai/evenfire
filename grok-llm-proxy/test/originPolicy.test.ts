import { describe, expect, it } from 'vitest'
import {
  CATALOG_ORIGIN,
  COMPLETIONS_ORIGIN,
  TRANSPORT_PROTOCOL_VERSION,
} from '@clerum/grok-provider-attempt-contract'
import {
  GROK_CATALOG_ORIGIN,
  GROK_COMPLETIONS_ORIGIN,
  GROK_TRANSPORT_PROTOCOL,
  OriginDeniedError,
  assertAllowedUpstreamUrl,
  assertRedirectLocation,
  fetchFrozenOrigin,
  isBlockedAddress,
} from '../src/originPolicy.js'

const LOOPBACK_V4 = ['127', '0', '0', '1'].join('.')

describe('originPolicy', () => {
  it('enforces the Grok attempt-contract origin constants', () => {
    expect(GROK_COMPLETIONS_ORIGIN).toBe(COMPLETIONS_ORIGIN)
    expect(GROK_CATALOG_ORIGIN).toBe(CATALOG_ORIGIN)
    expect(GROK_TRANSPORT_PROTOCOL).toBe(TRANSPORT_PROTOCOL_VERSION)
    expect(GROK_COMPLETIONS_ORIGIN).toBe('https://cli-chat-proxy.grok.com/v1/responses')
    expect(GROK_CATALOG_ORIGIN).toBe('https://cli-chat-proxy.grok.com/v1/models')
    expect(GROK_CATALOG_ORIGIN).not.toContain('api.x.ai')
  })

  it('accepts only the frozen HTTPS catalog and completions URLs', () => {
    expect(assertAllowedUpstreamUrl(GROK_COMPLETIONS_ORIGIN, 'completions').href).toBe(
      GROK_COMPLETIONS_ORIGIN
    )
    expect(assertAllowedUpstreamUrl(GROK_CATALOG_ORIGIN, 'catalog').href).toBe(GROK_CATALOG_ORIGIN)
  })

  it('rejects caller-supplied, HTTP, billing, loopback, and metadata URLs', () => {
    expect(() =>
      assertAllowedUpstreamUrl('https://api.x.ai/v1/chat/completions', 'completions')
    ).toThrow(OriginDeniedError)
    expect(() =>
      assertAllowedUpstreamUrl(
        'http://cli-chat-proxy.grok.com/backend-api/grok/responses',
        'completions'
      )
    ).toThrow(/origin_denied/)
    expect(() =>
      assertAllowedUpstreamUrl(`https://${LOOPBACK_V4}/backend-api/grok/responses`, 'completions')
    ).toThrow(OriginDeniedError)
    expect(() => assertAllowedUpstreamUrl('https://169.254.169.254/', 'catalog')).toThrow(
      OriginDeniedError
    )
    expect(isBlockedAddress('100.64.0.1')).toBe(true)
    expect(isBlockedAddress('198.18.0.1')).toBe(true)
    expect(isBlockedAddress('198.19.255.1')).toBe(true)
    expect(isBlockedAddress('64:ff9b::1')).toBe(true)
    expect(isBlockedAddress('ff02::1')).toBe(true)
    expect(() =>
      assertAllowedUpstreamUrl(
        'https://cli-chat-proxy.grok.com/v1/responses?hijack=1',
        'completions'
      )
    ).toThrow(OriginDeniedError)
    expect(() =>
      assertAllowedUpstreamUrl('https://cli-chat-proxy.grok.com/v1/models?hijack=1', 'catalog')
    ).toThrow(OriginDeniedError)
    expect(() => assertAllowedUpstreamUrl('https://api.x.ai/v1/responses', 'completions')).toThrow(
      OriginDeniedError
    )
  })

  it('rejects cross-origin and private-address redirects', () => {
    expect(() =>
      assertRedirectLocation('https://evil.example/cb', new URL(GROK_COMPLETIONS_ORIGIN))
    ).toThrow(OriginDeniedError)
    expect(() =>
      assertRedirectLocation(`https://${LOOPBACK_V4}/loopback`, new URL(GROK_COMPLETIONS_ORIGIN))
    ).toThrow(OriginDeniedError)
    expect(() =>
      assertRedirectLocation(
        'http://cli-chat-proxy.grok.com/backend-api/grok/responses',
        new URL(GROK_COMPLETIONS_ORIGIN)
      )
    ).toThrow(OriginDeniedError)
    expect(
      assertRedirectLocation(
        'https://cli-chat-proxy.grok.com/v1/responses',
        new URL(GROK_COMPLETIONS_ORIGIN)
      ).href
    ).toBe(GROK_COMPLETIONS_ORIGIN)
  })

  it('follows one frozen same-origin redirect and denies a second hop', async () => {
    let hops = 0
    const allowed = await fetchFrozenOrigin({
      url: new URL(GROK_COMPLETIONS_ORIGIN),
      init: { method: 'POST' },
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
      fetchFn: (async () => {
        hops += 1
        if (hops === 1) {
          return new Response(null, {
            status: 307,
            headers: { location: GROK_COMPLETIONS_ORIGIN },
          })
        }
        return new Response('ok', { status: 200 })
      }) as unknown as typeof fetch,
    })
    expect(allowed.status).toBe(200)
    expect(hops).toBe(2)

    await expect(
      fetchFrozenOrigin({
        url: new URL(GROK_COMPLETIONS_ORIGIN),
        init: { method: 'POST' },
        lookup: async () => [{ address: '1.2.3.4', family: 4 }],
        fetchFn: (async () =>
          new Response(null, {
            status: 302,
            headers: { location: GROK_COMPLETIONS_ORIGIN },
          })) as unknown as typeof fetch,
      })
    ).rejects.toBeInstanceOf(OriginDeniedError)
  })

  it('rejects DNS rebinding onto private or metadata addresses', async () => {
    const { assertResolvedUpstream } = await import('../src/originPolicy.js')
    await expect(
      assertResolvedUpstream(new URL(GROK_COMPLETIONS_ORIGIN), async () => [
        { address: '127.0.0.1', family: 4 },
      ])
    ).rejects.toBeInstanceOf(OriginDeniedError)
    await expect(
      assertResolvedUpstream(new URL(GROK_COMPLETIONS_ORIGIN), async () => [
        { address: '169.254.169.254', family: 4 },
      ])
    ).rejects.toBeInstanceOf(OriginDeniedError)
    await expect(
      assertResolvedUpstream(new URL(GROK_COMPLETIONS_ORIGIN), async () => [
        { address: '1.2.3.4', family: 4 },
      ])
    ).resolves.toBeUndefined()
  })

  it('wraps operational lookup codes without the host name', async () => {
    const { assertResolvedUpstream } = await import('../src/originPolicy.js')
    const codes = [
      'ENOTFOUND',
      'EAI_AGAIN',
      'EAI_NONAME',
      'ECONNREFUSED',
      'ENETUNREACH',
      'EHOSTUNREACH',
    ] as const
    let lookups = 0
    for (const code of codes) {
      const lookupError = Object.assign(new Error(`lookup failed for ${code}.invalid`), { code })
      const err: unknown = await assertResolvedUpstream(
        new URL(GROK_COMPLETIONS_ORIGIN),
        async () => {
          lookups += 1
          throw lookupError
        }
      ).then(
        () => 'resolved',
        (rejection: unknown) => rejection
      )
      expect(err).toBeInstanceOf(Error)
      expect(err).not.toBeInstanceOf(OriginDeniedError)
      expect((err as Error).message).toBe('upstream address lookup failed')
      const cause = (err as { cause?: unknown }).cause as Record<string, unknown>
      expect(cause).toEqual({ code })
      expect(JSON.stringify({ message: (err as Error).message, cause })).not.toContain(
        `${code}.invalid`
      )
    }
    expect(lookups).toBe(codes.length)
  })

  it('rethrows a Node ERR_* lookup error as the same reference', async () => {
    const { assertResolvedUpstream } = await import('../src/originPolicy.js')
    const err = Object.assign(new Error('lookup argument is invalid'), {
      code: 'ERR_INVALID_ARG_TYPE',
    })
    let lookups = 0
    await expect(
      assertResolvedUpstream(new URL(GROK_COMPLETIONS_ORIGIN), async () => {
        lookups += 1
        throw err
      })
    ).rejects.toBe(err)
    expect(lookups).toBe(1)
  })

  // Review R4-L1: the real lookup depends on the resolver honoring .invalid
  // NXDOMAIN. The deterministic twins above own the code semantics.
  it('maps a failed lookup to its code without the host name', async () => {
    const { assertResolvedUpstream } = await import('../src/originPolicy.js')
    const host = 'grok-origin-policy-r4-l1.invalid'
    let lookups = 0
    const err: unknown = await assertResolvedUpstream(new URL(GROK_COMPLETIONS_ORIGIN), async () => {
      lookups += 1
      const { lookup } = await import('node:dns/promises')
      const records = await lookup(host, { all: true })
      return records.map(record => ({ address: record.address, family: record.family }))
    }).then(
      () => 'resolved',
      (rejection: unknown) => rejection
    )
    // Witness: the real lookup ran once.
    expect(lookups).toBe(1)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(OriginDeniedError)
    expect((err as Error).message).toBe('upstream address lookup failed')
    const cause = (err as { cause?: unknown }).cause as Record<string, unknown>
    expect(Object.keys(cause)).toEqual(['code'])
    expect(String(cause.code)).toMatch(/^(ENOTFOUND|EAI_AGAIN)$/)
    expect(JSON.stringify({ message: (err as Error).message, cause })).not.toContain(host)
  }, 15_000)

  it('rethrows a lookup error without a code-shaped code unchanged', async () => {
    const { assertResolvedUpstream } = await import('../src/originPolicy.js')
    const plain = new Error('lookup exploded')
    await expect(
      assertResolvedUpstream(new URL(GROK_COMPLETIONS_ORIGIN), async () => {
        throw plain
      })
    ).rejects.toBe(plain)
    const oddCode = Object.assign(new Error('odd'), { code: 'not a code' })
    await expect(
      assertResolvedUpstream(new URL(GROK_COMPLETIONS_ORIGIN), async () => {
        throw oddCode
      })
    ).rejects.toBe(oddCode)
  })
})
