import { describe, expect, it } from 'vitest'
import {
  buildRemoteRefreshRequest,
  buildRemoteTokenRequest,
  getOAuthProviderAdapter,
  parseRemoteTokenResponse,
} from '../src/oauth/providers.js'

/**
 * Generic public token client for the remote lane (D-10 §3). T4: assert the
 * OBSERVABLE emitted `TokenRequest.body` — a public client omits `client_secret`,
 * carries `code_verifier` under PKCE, and appends RFC 8707 `resource`. The wrapper
 * must NOT perturb the 8 baked adapters (byte-identity is pinned by the T1 golden
 * suite; here we prove the wrapper adds only `resource`).
 */
const TOKEN_ENDPOINT = 'https://mcp.notion.com/token'
const RESOURCE = 'https://mcp.notion.com'

describe('buildRemoteTokenRequest (public client, RFC 8707)', () => {
  it('omits client_secret and appends resource (public + PKCE)', () => {
    const req = buildRemoteTokenRequest(
      TOKEN_ENDPOINT,
      {
        code: 'CODE',
        clientId: 'CID',
        redirectUri: 'https://cb.example.com/remote',
        codeVerifier: 'VER',
      },
      RESOURCE
    )
    expect(req.url).toBe(TOKEN_ENDPOINT)
    expect(req.method).toBe('POST')
    expect(req.body).not.toContain('client_secret')
    expect(req.body).toBe(
      'grant_type=authorization_code&code=CODE&client_id=CID&redirect_uri=https%3A%2F%2Fcb.example.com%2Fremote&code_verifier=VER&resource=https%3A%2F%2Fmcp.notion.com'
    )
  })

  it('omits resource when not provided (body identical to the standard builder)', () => {
    const req = buildRemoteTokenRequest(TOKEN_ENDPOINT, {
      code: 'CODE',
      clientId: 'CID',
      redirectUri: 'https://cb.example.com/remote',
    })
    expect(req.body).toBe(
      'grant_type=authorization_code&code=CODE&client_id=CID&redirect_uri=https%3A%2F%2Fcb.example.com%2Fremote'
    )
  })

  it('includes client_secret when a confidential secret is supplied (append still last)', () => {
    const req = buildRemoteTokenRequest(
      TOKEN_ENDPOINT,
      {
        code: 'CODE',
        clientId: 'CID',
        clientSecret: 'SEC',
        redirectUri: 'https://cb.example.com/remote',
      },
      RESOURCE
    )
    expect(req.body).toBe(
      'grant_type=authorization_code&code=CODE&client_id=CID&client_secret=SEC&redirect_uri=https%3A%2F%2Fcb.example.com%2Fremote&resource=https%3A%2F%2Fmcp.notion.com'
    )
  })
})

describe('buildRemoteRefreshRequest (public client, RFC 8707)', () => {
  it('omits client_secret and appends resource', () => {
    const req = buildRemoteRefreshRequest(
      TOKEN_ENDPOINT,
      { refreshToken: 'RT', clientId: 'CID' },
      RESOURCE
    )
    expect(req.body).toBe(
      'grant_type=refresh_token&refresh_token=RT&client_id=CID&resource=https%3A%2F%2Fmcp.notion.com'
    )
  })

  it('omits resource when not provided', () => {
    const req = buildRemoteRefreshRequest(TOKEN_ENDPOINT, { refreshToken: 'RT', clientId: 'CID' })
    expect(req.body).toBe('grant_type=refresh_token&refresh_token=RT&client_id=CID')
  })
})

describe('parseRemoteTokenResponse', () => {
  it('is the standard OAuth2 parser', () => {
    const parsed = parseRemoteTokenResponse({
      access_token: 'AT',
      refresh_token: 'RT',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'read',
    })
    expect(parsed).toEqual({
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresIn: 3600,
      tokenType: 'Bearer',
      scope: 'read',
    })
  })
})

describe('the 8 baked adapters are untouched by the remote wrappers', () => {
  it('salesforce token body is unchanged (no resource leaks in)', () => {
    const body = getOAuthProviderAdapter('salesforce').buildTokenRequest({
      code: 'thecode',
      clientId: 'cid',
      clientSecret: 'csec',
      redirectUri: 'https://control.example.com/api/v1/oauth-callback/provider',
    }).body
    expect(body).not.toContain('resource=')
    expect(body).toBe(
      'grant_type=authorization_code&code=thecode&client_id=cid&client_secret=csec&redirect_uri=https%3A%2F%2Fcontrol.example.com%2Fapi%2Fv1%2Foauth-callback%2Fprovider'
    )
  })
})
