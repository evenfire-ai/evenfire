import { describe, expect, it } from 'vitest'
import {
  CODEX_CATALOG_ORIGIN,
  CODEX_COMPLETIONS_ORIGIN,
  OriginDeniedError,
  assertAllowedUpstreamUrl,
  assertRedirectLocation,
} from '../src/originPolicy.js'

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
    expect(() => assertAllowedUpstreamUrl('https://127.0.0.1/backend-api/codex/responses', 'completions')).toThrow(
      OriginDeniedError
    )
    expect(() => assertAllowedUpstreamUrl('https://169.254.169.254/', 'catalog')).toThrow(OriginDeniedError)
    expect(() => assertAllowedUpstreamUrl('https://chatgpt.com/backend-api/codex/responses?hijack=1', 'completions')).toThrow(
      OriginDeniedError
    )
  })

  it('rejects cross-origin and private-address redirects', () => {
    expect(() =>
      assertRedirectLocation('https://evil.example/cb', new URL(CODEX_COMPLETIONS_ORIGIN))
    ).toThrow(OriginDeniedError)
    expect(() =>
      assertRedirectLocation('https://127.0.0.1/loopback', new URL(CODEX_COMPLETIONS_ORIGIN))
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
