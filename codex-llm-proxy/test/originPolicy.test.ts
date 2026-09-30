import { describe, expect, it } from 'vitest'
import {
  CODEX_CATALOG_ORIGIN,
  CODEX_COMPLETIONS_ORIGIN,
  OriginDeniedError,
  assertAllowedUpstreamUrl,
  assertRedirectLocation,
  fetchFrozenOrigin,
  isBlockedAddress,
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
    expect(isBlockedAddress('100.64.0.1')).toBe(true)
    expect(isBlockedAddress('198.18.0.1')).toBe(true)
    expect(isBlockedAddress('198.19.255.1')).toBe(true)
    expect(isBlockedAddress('64:ff9b::1')).toBe(true)
    expect(isBlockedAddress('ff02::1')).toBe(true)
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

  // Review R4-L1: a failed lookup carries its system code on the error itself
  // and names the host in its message. Only a code-shaped code is kept, as
  // the cause the transport maps by code.
  it('maps a failed lookup to its code without the host name', async () => {
    const { assertResolvedUpstream } = await import('../src/originPolicy.js')
    const host = 'codex-origin-policy-r4-l1.invalid'
    let lookups = 0
    const err: unknown = await assertResolvedUpstream(new URL(CODEX_COMPLETIONS_ORIGIN), async () => {
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
  })

  it('rethrows a lookup error without a code-shaped code unchanged', async () => {
    const { assertResolvedUpstream } = await import('../src/originPolicy.js')
    const plain = new Error('lookup exploded')
    await expect(
      assertResolvedUpstream(new URL(CODEX_COMPLETIONS_ORIGIN), async () => {
        throw plain
      })
    ).rejects.toBe(plain)
    const oddCode = Object.assign(new Error('odd'), { code: 'not a code' })
    await expect(
      assertResolvedUpstream(new URL(CODEX_COMPLETIONS_ORIGIN), async () => {
        throw oddCode
      })
    ).rejects.toBe(oddCode)
  })
})
