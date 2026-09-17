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
})
