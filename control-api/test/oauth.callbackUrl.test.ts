import { describe, expect, it } from 'vitest'
import { buildPublicCallbackUrl } from '../src/routes/external/oauthCallback.js'

function fakeReq(host: string, protocol = 'https') {
  return { protocol, get: (h: string) => (h.toLowerCase() === 'host' ? host : undefined) }
}

describe('buildPublicCallbackUrl', () => {
  it('builds a STABLE callback URL from the oauthClientId only (no recipe instance)', () => {
    const url = buildPublicCallbackUrl(fakeReq('example.com'), 'google-gmail')
    expect(url).toBe('https://example.com/api/v1/oauth-callback/google-gmail')
  })

  it('does not embed the recipe namespace or instance name (one registration per client)', () => {
    const url = buildPublicCallbackUrl(fakeReq('example.com'), 'google-gmail')
    expect(url).not.toContain('sandbox-recipes')
    // exactly one path segment after /oauth-callback/
    expect(url.endsWith('/oauth-callback/google-gmail')).toBe(true)
  })

  it('url-encodes the oauthClientId', () => {
    const url = buildPublicCallbackUrl(fakeReq('h'), 'weird/id')
    expect(url).toBe('https://h/api/v1/oauth-callback/weird%2Fid')
  })

  it('uses an explicitly configured base URL over the request Host (proxy chain)', () => {
    // Behind cloudflared → external-rest-api → funnel the request Host is an
    // internal hostname; the configured public base URL must win so the
    // token-exchange redirect_uri matches the authorize step.
    const url = buildPublicCallbackUrl(
      fakeReq('profile-control-funnel.profiles.svc.cluster.local:8080'),
      'google-gmail',
      'https://example.com'
    )
    expect(url).toBe('https://example.com/api/v1/oauth-callback/google-gmail')
  })

  it('strips a trailing slash from the configured base URL', () => {
    const url = buildPublicCallbackUrl(fakeReq('h'), 'google-gmail', 'https://example.com/')
    expect(url).toBe('https://example.com/api/v1/oauth-callback/google-gmail')
  })

  it('falls back to the request Host when the configured base URL is empty', () => {
    const url = buildPublicCallbackUrl(fakeReq('example.com'), 'google-gmail', '')
    expect(url).toBe('https://example.com/api/v1/oauth-callback/google-gmail')
  })
})
