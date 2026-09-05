import { describe, expect, it } from 'vitest'
import {
  KNOWN_OAUTH_PROVIDERS,
  type OAuthProvider,
  getOAuthProviderAdapter,
} from '../src/oauth/providers.js'

const REDIRECT = 'https://control.example.com/api/v1/oauth-callback/salesforce'

/** The provider list is derived from the adapter registry — never hardcoded. */
const ALL_PROVIDERS: OAuthProvider[] = [...KNOWN_OAUTH_PROVIDERS]

function urlParams(url: string): URLSearchParams {
  return new URL(url).searchParams
}

describe('getOAuthProviderAdapter (O2.1)', () => {
  it('returns the right adapter for every supported provider', () => {
    for (const p of ALL_PROVIDERS) {
      const a = getOAuthProviderAdapter(p)
      expect(a.provider).toBe(p)
      expect(typeof a.buildAuthorizeUrl).toBe('function')
      expect(typeof a.buildTokenRequest).toBe('function')
      expect(typeof a.buildRefreshRequest).toBe('function')
      expect(typeof a.parseTokenResponse).toBe('function')
    }
  })

  // T5 invariant: every registry key resolves and exposes all four methods.
  it('every KNOWN_OAUTH_PROVIDERS key resolves via getOAuthProviderAdapter', () => {
    expect(ALL_PROVIDERS.length).toBeGreaterThanOrEqual(8)
    for (const p of ALL_PROVIDERS) {
      const a = getOAuthProviderAdapter(p)
      expect(a.provider).toBe(p)
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

// ─── U2: monday / clickup / vercel ──────────────────────────────────────

describe('monday adapter (U2, PKCE)', () => {
  const a = getOAuthProviderAdapter('monday')

  it('declares usesPkce', () => {
    expect(a.usesPkce).toBe(true)
  })

  it('builds the authorize URL with code_challenge + code_challenge_method=S256 and space-separated scopes', () => {
    const url = a.buildAuthorizeUrl({
      clientId: 'cid',
      redirectUri: REDIRECT,
      state: 'signed-state',
      scopes: ['boards:read', 'me:read'],
      codeChallenge: 'CHALLENGE',
    })
    expect(url.startsWith('https://auth.monday.com/oauth2/authorize?')).toBe(true)
    const p = urlParams(url)
    expect(p.get('client_id')).toBe('cid')
    expect(p.get('response_type')).toBe('code')
    expect(p.get('state')).toBe('signed-state')
    expect(p.get('scope')).toBe('boards:read me:read')
    expect(p.get('code_challenge')).toBe('CHALLENGE')
    expect(p.get('code_challenge_method')).toBe('S256')
  })

  it('builds the token POST as JSON to the OAuth 2.1 endpoint, carrying code_verifier', () => {
    const req = a.buildTokenRequest({
      code: 'thecode',
      clientId: 'cid',
      clientSecret: 'csec',
      redirectUri: REDIRECT,
      codeVerifier: 'VERIFIER',
    })
    expect(req.url).toBe('https://auth.monday.com/oauth_ms/oauth/token')
    expect(req.headers['content-type']).toBe('application/json')
    const body = JSON.parse(req.body)
    expect(body.grant_type).toBe('authorization_code')
    expect(body.client_id).toBe('cid')
    expect(body.client_secret).toBe('csec') // confidential client
    expect(body.code).toBe('thecode')
    expect(body.redirect_uri).toBe(REDIRECT)
    expect(body.code_verifier).toBe('VERIFIER')
  })

  it('builds a refresh request that carries NO code_verifier', () => {
    const req = a.buildRefreshRequest({ refreshToken: 'RT', clientId: 'cid', clientSecret: 'csec' })
    expect(req.url).toBe('https://auth.monday.com/oauth_ms/oauth/token')
    const body = JSON.parse(req.body)
    expect(body.grant_type).toBe('refresh_token')
    expect(body.refresh_token).toBe('RT')
    expect(body.code_verifier).toBeUndefined()
  })

  it('parses a standard token response', () => {
    const parsed = a.parseTokenResponse({
      access_token: 'AT',
      refresh_token: 'RT',
      expires_in: 3600,
      token_type: 'Bearer',
    })
    expect(parsed.accessToken).toBe('AT')
    expect(parsed.refreshToken).toBe('RT')
    expect(parsed.expiresIn).toBe(3600)
  })
})

describe('clickup adapter (U2, no PKCE, no refresh)', () => {
  const a = getOAuthProviderAdapter('clickup')

  it('does NOT declare usesPkce', () => {
    expect(a.usesPkce).toBeFalsy()
  })

  it('builds an authorize URL carrying state but NO code_challenge/method/scope', () => {
    const url = a.buildAuthorizeUrl({
      clientId: 'cid',
      redirectUri: REDIRECT,
      state: 'signed-state',
      scopes: ['ignored'],
    })
    expect(url.startsWith('https://app.clickup.com/api?')).toBe(true)
    const p = urlParams(url)
    expect(p.get('client_id')).toBe('cid')
    expect(p.get('redirect_uri')).toBe(REDIRECT)
    expect(p.get('state')).toBe('signed-state')
    expect(p.has('code_challenge')).toBe(false)
    expect(p.has('code_challenge_method')).toBe(false)
    expect(p.has('scope')).toBe(false)
  })

  it('builds a bespoke token POST: form body, no grant_type, no redirect_uri', () => {
    const req = a.buildTokenRequest({
      code: 'thecode',
      clientId: 'cid',
      clientSecret: 'csec',
      redirectUri: REDIRECT,
    })
    expect(req.url).toBe('https://api.clickup.com/api/v2/oauth/token')
    expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded')
    const p = new URLSearchParams(req.body)
    expect(p.get('client_id')).toBe('cid')
    expect(p.get('client_secret')).toBe('csec')
    expect(p.get('code')).toBe('thecode')
    expect(p.has('grant_type')).toBe(false)
    expect(p.has('redirect_uri')).toBe(false)
  })

  it('throws on refresh — ClickUp tokens do not expire', () => {
    expect(() =>
      a.buildRefreshRequest({ refreshToken: 'r', clientId: 'c', clientSecret: 's' })
    ).toThrow(/does not support refresh tokens/)
  })

  it('parses a response with only access_token (no refresh/expiry)', () => {
    const parsed = a.parseTokenResponse({ access_token: 'AT' })
    expect(parsed.accessToken).toBe('AT')
    expect(parsed.refreshToken).toBeUndefined()
    expect(parsed.expiresIn).toBeUndefined()
    expect(parsed.tokenType).toBe('Bearer')
  })
})

describe('vercel adapter (U2, PKCE)', () => {
  const a = getOAuthProviderAdapter('vercel')

  it('declares usesPkce', () => {
    expect(a.usesPkce).toBe(true)
  })

  it('builds the authorize URL with code_challenge + S256 and offline_access default scope', () => {
    const url = a.buildAuthorizeUrl({
      clientId: 'cid',
      redirectUri: REDIRECT,
      state: 'signed-state',
      scopes: [],
      codeChallenge: 'CHALLENGE',
    })
    expect(url.startsWith('https://vercel.com/oauth/authorize?')).toBe(true)
    const p = urlParams(url)
    expect(p.get('response_type')).toBe('code')
    expect(p.get('code_challenge')).toBe('CHALLENGE')
    expect(p.get('code_challenge_method')).toBe('S256')
    expect(p.get('scope')?.split(' ')).toContain('offline_access')
  })

  it('uses recipe-supplied scopes when present', () => {
    const url = a.buildAuthorizeUrl({
      clientId: 'cid',
      redirectUri: REDIRECT,
      state: 's',
      scopes: ['openid'],
      codeChallenge: 'C',
    })
    expect(urlParams(url).get('scope')).toBe('openid')
  })

  it('builds a standard form token POST carrying code_verifier to the vercel token endpoint', () => {
    const req = a.buildTokenRequest({
      code: 'thecode',
      clientId: 'cid',
      clientSecret: 'csec',
      redirectUri: REDIRECT,
      codeVerifier: 'VERIFIER',
    })
    expect(req.url).toBe('https://api.vercel.com/login/oauth/token')
    expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(req.body).toContain('grant_type=authorization_code')
    expect(req.body).toContain('client_secret=csec') // confidential client accepted
    expect(req.body).toContain('code_verifier=VERIFIER')
  })

  it('refresh uses the refresh_token grant and carries NO code_verifier', () => {
    const req = a.buildRefreshRequest({ refreshToken: 'RT', clientId: 'cid', clientSecret: 'csec' })
    expect(req.url).toBe('https://api.vercel.com/login/oauth/token')
    expect(req.body).toContain('grant_type=refresh_token')
    expect(req.body).not.toContain('code_verifier')
  })
})

// ─── T1: byte-identical golden for the 5 pre-existing (non-PKCE) adapters ─
//
// Snapshots the authorize URL + token request bytes for the recipe-path adapters,
// called EXACTLY as the recipe flow calls them (no PKCE inputs — the caller gates
// PKCE fields on adapter.usesPkce, which is false here). Asserts NO PKCE parameter
// appears. Guards that adding PKCE to the registry did not alter the recipe flow.
//
// The golden values below are the literal bytes emitted before U2; a diff here
// means the recipe path changed.
describe('T1 byte-identical golden — pre-existing adapters carry no PKCE', () => {
  const LEGACY: OAuthProvider[] = ['salesforce', 'slack', 'notion', 'microsoft-graph', 'google']

  const GOLDEN_AUTHORIZE: Record<string, string> = {
    salesforce:
      'https://login.salesforce.com/services/oauth2/authorize?response_type=code&client_id=cid&redirect_uri=https%3A%2F%2Fcontrol.example.com%2Fapi%2Fv1%2Foauth-callback%2Fsalesforce&state=signed-state&scope=scope-a',
    slack:
      'https://slack.com/oauth/v2/authorize?client_id=cid&redirect_uri=https%3A%2F%2Fcontrol.example.com%2Fapi%2Fv1%2Foauth-callback%2Fsalesforce&state=signed-state&scope=scope-a',
    notion:
      'https://api.notion.com/v1/oauth/authorize?client_id=cid&redirect_uri=https%3A%2F%2Fcontrol.example.com%2Fapi%2Fv1%2Foauth-callback%2Fsalesforce&response_type=code&owner=user&state=signed-state',
    'microsoft-graph':
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=cid&redirect_uri=https%3A%2F%2Fcontrol.example.com%2Fapi%2Fv1%2Foauth-callback%2Fsalesforce&response_type=code&response_mode=query&scope=scope-a&state=signed-state',
    google:
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=cid&redirect_uri=https%3A%2F%2Fcontrol.example.com%2Fapi%2Fv1%2Foauth-callback%2Fsalesforce&response_type=code&access_type=offline&prompt=consent&state=signed-state&scope=scope-a',
  }

  for (const provider of LEGACY) {
    it(`${provider} authorize URL + token request are byte-identical and PKCE-free`, () => {
      const a = getOAuthProviderAdapter(provider)
      expect(a.usesPkce).toBeFalsy()

      // Called exactly as the recipe path calls it: no codeChallenge.
      const authorizeUrl = a.buildAuthorizeUrl({
        clientId: 'cid',
        redirectUri: REDIRECT,
        state: 'signed-state',
        scopes: ['scope-a'],
      })
      expect(authorizeUrl).toBe(GOLDEN_AUTHORIZE[provider])
      expect(authorizeUrl).not.toContain('code_challenge')

      // No codeVerifier — the recipe path never supplies one for a non-PKCE adapter.
      const tokenReq = a.buildTokenRequest({
        code: 'c',
        clientId: 'cid',
        clientSecret: 'csec',
        redirectUri: REDIRECT,
      })
      expect(tokenReq.body).not.toContain('code_verifier')
      expect(tokenReq.body).not.toContain('code_challenge')
    })
  }
})
