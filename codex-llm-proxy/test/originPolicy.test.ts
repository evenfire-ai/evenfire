import { describe, expect, it } from 'vitest'
import {
  CODEX_CATALOG_ORIGIN,
  CODEX_COMPLETIONS_ORIGIN,
  OriginDeniedError,
  assertAllowedUpstreamUrl,
  assertRedirectLocation,
  fetchFrozenOrigin,
} from '../src/originPolicy.js'

const LOOPBACK_V4 = ['127', '0', '0', '1'].join('.')

describe('originPolicy', () => {
  it('accepts only the frozen HTTPS catalog and completions URLs', () => {
    expect(assertAllowedUpstreamUrl(CODEX_COMPLETIONS_ORIGIN, 'completions').href).toBe(
      CODEX_COMPLETIONS_ORIGIN
    )
    expect(assertAllowedUpstreamUrl(CODEX_CATALOG_ORIGIN, 'catalog').href).toBe(CODEX_CATALOG_ORIGIN)
  })

  it('rejects caller-supplied, HTTP, billing, loopback, and metadata URLs', () => {
    expect(() =>
      assertAllowedUpstreamUrl('https://api.openai.com/v1/chat/completions', 'completions')
    ).toThrow(OriginDeniedError)
    expect(() => assertAllowedUpstreamUrl('http://chatgpt.com/backend-api/codex/responses', 'completions')).toThrow(
      /origin_denied/
    )
    expect(() => assertAllowedUpstreamUrl(`https://${LOOPBACK_V4}/backend-api/codex/responses`, 'completions')).toThrow(
      OriginDeniedError
    )
    expect(() => assertAllowedUpstreamUrl('https://169.254.169.254/', 'catalog')).toThrow(OriginDeniedError)
    expect(() => assertAllowedUpstreamUrl('https://chatgpt.com/backend-api/codex/responses?hijack=1', 'completions')).toThrow(
      OriginDeniedError
    )
    expect(() =>
      assertAllowedUpstreamUrl('https://chatgpt.com/backend-api/codex/models', 'catalog')
    ).toThrow(OriginDeniedError)
    expect(() =>
      assertAllowedUpstreamUrl(
        'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0&hijack=1',
        'catalog'
      )
    ).toThrow(OriginDeniedError)
  })

  it('rejects cross-origin and private-address redirects', () => {
    expect(() =>
      assertRedirectLocation('https://evil.example/cb', new URL(CODEX_COMPLETIONS_ORIGIN))
    ).toThrow(OriginDeniedError)
    expect(() =>
      assertRedirectLocation(`https://${LOOPBACK_V4}/loopback`, new URL(CODEX_COMPLETIONS_ORIGIN))
    ).toThrow(OriginDeniedError)
    expect(() =>
      assertRedirectLocation('http://chatgpt.com/backend-api/codex/responses', new URL(CODEX_COMPLETIONS_ORIGIN))
    ).toThrow(OriginDeniedError)
    expect(
      assertRedirectLocation(
        'https://chatgpt.com/backend-api/codex/responses',
        new URL(CODEX_COMPLETIONS_ORIGIN)
      ).href
    ).toBe(CODEX_COMPLETIONS_ORIGIN)
  })

  it('follows one frozen same-origin redirect and denies a second hop', async () => {
    let hops = 0
    const allowed = await fetchFrozenOrigin({
      url: new URL(CODEX_COMPLETIONS_ORIGIN),
      init: { method: 'POST' },
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
      fetchFn: (async () => {
        hops += 1
        if (hops === 1) {
          return new Response(null, {
            status: 307,
            headers: { location: CODEX_COMPLETIONS_ORIGIN },
          })
        }
        return new Response('ok', { status: 200 })
      }) as unknown as typeof fetch,
    })
    expect(allowed.status).toBe(200)
    expect(hops).toBe(2)

    await expect(
      fetchFrozenOrigin({
        url: new URL(CODEX_COMPLETIONS_ORIGIN),
        init: { method: 'POST' },
        lookup: async () => [{ address: '1.2.3.4', family: 4 }],
        fetchFn: (async () =>
          new Response(null, {
            status: 302,
            headers: { location: CODEX_COMPLETIONS_ORIGIN },
          })) as unknown as typeof fetch,
      })
    ).rejects.toBeInstanceOf(OriginDeniedError)
  })

  it('rejects DNS rebinding onto private or metadata addresses', async () => {
    const { assertResolvedUpstream } = await import('../src/originPolicy.js')
    await expect(
      assertResolvedUpstream(new URL(CODEX_COMPLETIONS_ORIGIN), async () => [
        { address: '127.0.0.1', family: 4 },
      ])
    ).rejects.toBeInstanceOf(OriginDeniedError)
    await expect(
      assertResolvedUpstream(new URL(CODEX_COMPLETIONS_ORIGIN), async () => [
        { address: '169.254.169.254', family: 4 },
      ])
    ).rejects.toBeInstanceOf(OriginDeniedError)
    await expect(
      assertResolvedUpstream(new URL(CODEX_COMPLETIONS_ORIGIN), async () => [
        { address: '1.2.3.4', family: 4 },
      ])
    ).resolves.toBeUndefined()
  })
})
