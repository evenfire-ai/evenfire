import { describe, expect, it } from 'vitest'
import { type OAuthProvider, getOAuthProviderAdapter } from '../src/oauth/providers.js'

const REDIRECT = 'https://control.example.com/api/v1/oauth-callback/salesforce'

function urlParams(url: string): URLSearchParams {
  return new URL(url).searchParams
}

describe('getOAuthProviderAdapter (O2.1)', () => {
  it('returns the right adapter for every supported provider', () => {
    const all: OAuthProvider[] = ['salesforce', 'slack', 'notion', 'microsoft-graph', 'google']
    for (const p of all) {
      const a = getOAuthProviderAdapter(p)
      expect(a.provider).toBe(p)
      expect(typeof a.buildAuthorizeUrl).toBe('function')
      expect(typeof a.buildTokenRequest).toBe('function')
      expect(typeof a.parseTokenResponse).toBe('function')
    }
  })
})

describe('Salesforce adapter (O2.1)', () => {
  const a = getOAuthProviderAdapter('salesforce')

  it('builds a valid /authorize URL with state, scope, response_type=code', () => {
    const url = a.buildAuthorizeUrl({
      clientId: 'cid',
      redirectUri: REDIRECT,
      state: 'signed-state',
      scopes: ['api', 'refresh_token'],
    })
    expect(url.startsWith('https://login.salesforce.com/services/oauth2/authorize?')).toBe(true)
    const p = urlParams(url)
    expect(p.get('client_id')).toBe('cid')
    expect(p.get('redirect_uri')).toBe(REDIRECT)
    expect(p.get('state')).toBe('signed-state')
    expect(p.get('response_type')).toBe('code')
    expect(p.get('scope')).toBe('api refresh_token')
  })

  it('omits scope when no scopes supplied', () => {
    const url = a.buildAuthorizeUrl({
      clientId: 'cid',
      redirectUri: REDIRECT,
      state: 's',
      scopes: [],
    })
    expect(urlParams(url).has('scope')).toBe(false)
  })

  it('builds the token POST as form-encoded with the auth-code grant', () => {
    const req = a.buildTokenRequest({
      code: 'thecode',
      clientId: 'cid',
      clientSecret: 'csecret',
      redirectUri: REDIRECT,
    })
    expect(req.url).toBe('https://login.salesforce.com/services/oauth2/token')
    expect(req.method).toBe('POST')
    expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(req.body).toContain('grant_type=authorization_code')
    expect(req.body).toContain('code=thecode')
    expect(req.body).toContain('client_id=cid')
    expect(req.body).toContain('client_secret=csecret')
  })

  it('parses a standard OAuth2 token response', () => {
    const parsed = a.parseTokenResponse({
      access_token: 'AT',
      refresh_token: 'RT',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'api refresh_token',
    })
    expect(parsed.accessToken).toBe('AT')
    expect(parsed.refreshToken).toBe('RT')
    expect(parsed.expiresIn).toBe(3600)
    expect(parsed.tokenType).toBe('Bearer')
    expect(parsed.scope).toBe('api refresh_token')
  })

  it('rejects a token response missing access_token', () => {
    expect(() => a.parseTokenResponse({ token_type: 'Bearer' })).toThrow(
      /missing string field "access_token"/
    )
  })
})

describe('Slack adapter (O2.1)', () => {
  const a = getOAuthProviderAdapter('slack')

  it('builds /oauth/v2/authorize with comma-separated scopes', () => {
    const url = a.buildAuthorizeUrl({
      clientId: 'cid',
      redirectUri: REDIRECT,
      state: 's',
      scopes: ['chat:write', 'channels:read'],
    })
    expect(url.startsWith('https://slack.com/oauth/v2/authorize?')).toBe(true)
    expect(urlParams(url).get('scope')).toBe('chat:write,channels:read')
  })

  it('throws on an ok=false token response', () => {
    expect(() => a.parseTokenResponse({ ok: false, error: 'invalid_code' })).toThrow(
      /Slack OAuth exchange failed: invalid_code/
    )
  })

  it('parses a successful oauth.v2.access response', () => {
    const parsed = a.parseTokenResponse({
      ok: true,
      access_token: 'xoxb-AT',
      token_type: 'Bearer',
      scope: 'chat:write',
    })
    expect(parsed.accessToken).toBe('xoxb-AT')
    expect(parsed.scope).toBe('chat:write')
  })
})

describe('Notion adapter (O2.1)', () => {
  const a = getOAuthProviderAdapter('notion')

  it('builds /v1/oauth/authorize with owner=user', () => {
    const url = a.buildAuthorizeUrl({
      clientId: 'cid',
      redirectUri: REDIRECT,
      state: 's',
      scopes: ['read'],
    })
    expect(url.startsWith('https://api.notion.com/v1/oauth/authorize?')).toBe(true)
    const p = urlParams(url)
    expect(p.get('owner')).toBe('user')
    // Notion does NOT take scope query param.
    expect(p.has('scope')).toBe(false)
  })

  it('uses HTTP Basic auth + JSON body on the token POST', () => {
    const req = a.buildTokenRequest({
      code: 'c',
      clientId: 'cid',
      clientSecret: 'csec',
      redirectUri: REDIRECT,
    })
    expect(req.url).toBe('https://api.notion.com/v1/oauth/token')
    expect(req.headers['content-type']).toBe('application/json')
    const expectedBasic = 'Basic ' + Buffer.from('cid:csec').toString('base64')
    expect(req.headers.authorization).toBe(expectedBasic)
    const body = JSON.parse(req.body)
    expect(body.grant_type).toBe('authorization_code')
    expect(body.code).toBe('c')
  })

  it('throws on refresh — Notion does not support refresh tokens', () => {
    expect(() =>
      a.buildRefreshRequest({ refreshToken: 'r', clientId: 'c', clientSecret: 's' })
    ).toThrow(/does not support refresh tokens/)
  })
})

describe('Microsoft Graph adapter (O2.1)', () => {
  const a = getOAuthProviderAdapter('microsoft-graph')

  it('builds /common/oauth2/v2.0/authorize with offline_access in default scopes', () => {
    const url = a.buildAuthorizeUrl({
      clientId: 'cid',
      redirectUri: REDIRECT,
      state: 's',
      scopes: [],
    })
    expect(url).toContain('login.microsoftonline.com/common/oauth2/v2.0/authorize')
    const p = urlParams(url)
    expect(p.get('scope')?.split(' ')).toContain('offline_access')
    expect(p.get('response_mode')).toBe('query')
  })

  it('uses recipe-supplied scopes when present', () => {
    const url = a.buildAuthorizeUrl({
      clientId: 'cid',
      redirectUri: REDIRECT,
      state: 's',
      scopes: ['Mail.Read', 'offline_access'],
    })
    expect(urlParams(url).get('scope')).toBe('Mail.Read offline_access')
  })
})

describe('Google adapter (O2.1)', () => {
  const a = getOAuthProviderAdapter('google')

  it('forces access_type=offline and prompt=consent so a refresh_token is issued', () => {
    const url = a.buildAuthorizeUrl({
      clientId: 'cid',
      redirectUri: REDIRECT,
      state: 's',
      scopes: ['https://www.googleapis.com/auth/userinfo.email'],
    })
    const p = urlParams(url)
    expect(p.get('access_type')).toBe('offline')
    expect(p.get('prompt')).toBe('consent')
  })
})
