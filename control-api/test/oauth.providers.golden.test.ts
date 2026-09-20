import { describe, expect, it } from 'vitest'
import {
  KNOWN_OAUTH_PROVIDERS,
  type OAuthProvider,
  type TokenRequest,
  getOAuthProviderAdapter,
} from '../src/oauth/providers.js'

/**
 * T1 golden (spec 19 §7 T1 / invariant §6.2): the request bytes emitted by the 8
 * real, baked adapters MUST be byte-identical after E-19.2 (client-public
 * signatures). E-19.2 made `clientSecret` optional but must NOT alter any request
 * when the secret is PRESENT — the confidential path is what every baked provider
 * uses today.
 *
 * The `actual` values are DERIVED from the real producer (`getOAuthProviderAdapter`
 * / `ADAPTERS`) — never hand-built. The `GOLDEN_*` values are the frozen literal
 * bytes those adapters emitted before the change; any reorder or byte drift turns
 * this red.
 */

const REDIRECT = 'https://control.example.com/api/v1/oauth-callback/provider'
const SCOPES = ['scope-a', 'scope-b']

// Confidential-client inputs — every baked provider is confidential (DEC-3).
const AUTHORIZE_INPUT = (usesPkce: boolean) => ({
  clientId: 'cid',
  redirectUri: REDIRECT,
  state: 'signed-state',
  scopes: SCOPES,
  codeChallenge: usesPkce ? 'CHALLENGE' : undefined,
})
const TOKEN_INPUT = (usesPkce: boolean) => ({
  code: 'thecode',
  clientId: 'cid',
  clientSecret: 'csec',
  redirectUri: REDIRECT,
  codeVerifier: usesPkce ? 'VERIFIER' : undefined,
})
const REFRESH_INPUT = { refreshToken: 'RT', clientId: 'cid', clientSecret: 'csec' }

const FORM = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' }

const GOLDEN_AUTHORIZE: Record<OAuthProvider, string> = {
  salesforce:
    'https://login.salesforce.com/services/oauth2/authorize?response_type=code&client_id=cid&redirect_uri=https%3A%2F%2Fcontrol.example.com%2Fapi%2Fv1%2Foauth-callback%2Fprovider&state=signed-state&scope=scope-a%20scope-b',
  slack:
    'https://slack.com/oauth/v2/authorize?client_id=cid&redirect_uri=https%3A%2F%2Fcontrol.example.com%2Fapi%2Fv1%2Foauth-callback%2Fprovider&state=signed-state&scope=scope-a%2Cscope-b',
  notion:
    'https://api.notion.com/v1/oauth/authorize?client_id=cid&redirect_uri=https%3A%2F%2Fcontrol.example.com%2Fapi%2Fv1%2Foauth-callback%2Fprovider&response_type=code&owner=user&state=signed-state',
  'microsoft-graph':
    'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=cid&redirect_uri=https%3A%2F%2Fcontrol.example.com%2Fapi%2Fv1%2Foauth-callback%2Fprovider&response_type=code&response_mode=query&scope=scope-a%20scope-b&state=signed-state',
  google:
    'https://accounts.google.com/o/oauth2/v2/auth?client_id=cid&redirect_uri=https%3A%2F%2Fcontrol.example.com%2Fapi%2Fv1%2Foauth-callback%2Fprovider&response_type=code&access_type=offline&prompt=consent&state=signed-state&scope=scope-a%20scope-b',
  monday:
    'https://auth.monday.com/oauth2/authorize?client_id=cid&redirect_uri=https%3A%2F%2Fcontrol.example.com%2Fapi%2Fv1%2Foauth-callback%2Fprovider&response_type=code&state=signed-state&scope=scope-a%20scope-b&code_challenge=CHALLENGE&code_challenge_method=S256',
  clickup:
    'https://app.clickup.com/api?client_id=cid&redirect_uri=https%3A%2F%2Fcontrol.example.com%2Fapi%2Fv1%2Foauth-callback%2Fprovider&state=signed-state',
  vercel:
    'https://vercel.com/oauth/authorize?client_id=cid&redirect_uri=https%3A%2F%2Fcontrol.example.com%2Fapi%2Fv1%2Foauth-callback%2Fprovider&response_type=code&scope=scope-a%20scope-b&state=signed-state&code_challenge=CHALLENGE&code_challenge_method=S256',
}

const GOLDEN_TOKEN: Record<OAuthProvider, TokenRequest> = {
  salesforce: {
    url: 'https://login.salesforce.com/services/oauth2/token',
    method: 'POST',
    headers: FORM,
    body: 'grant_type=authorization_code&code=thecode&client_id=cid&client_secret=csec&redirect_uri=https%3A%2F%2Fcontrol.example.com%2Fapi%2Fv1%2Foauth-callback%2Fprovider',
  },
  slack: {
    url: 'https://slack.com/api/oauth.v2.access',
    method: 'POST',
    headers: FORM,
    body: 'grant_type=authorization_code&code=thecode&client_id=cid&client_secret=csec&redirect_uri=https%3A%2F%2Fcontrol.example.com%2Fapi%2Fv1%2Foauth-callback%2Fprovider',
  },
  notion: {
    url: 'https://api.notion.com/v1/oauth/token',
    method: 'POST',
    headers: { ...JSON_HEADERS, authorization: 'Basic Y2lkOmNzZWM=' },
    body: '{"grant_type":"authorization_code","code":"thecode","redirect_uri":"https://control.example.com/api/v1/oauth-callback/provider"}',
  },
  'microsoft-graph': {
    url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    method: 'POST',
    headers: FORM,
    body: 'grant_type=authorization_code&code=thecode&client_id=cid&client_secret=csec&redirect_uri=https%3A%2F%2Fcontrol.example.com%2Fapi%2Fv1%2Foauth-callback%2Fprovider',
  },
  google: {
    url: 'https://oauth2.googleapis.com/token',
    method: 'POST',
    headers: FORM,
    body: 'grant_type=authorization_code&code=thecode&client_id=cid&client_secret=csec&redirect_uri=https%3A%2F%2Fcontrol.example.com%2Fapi%2Fv1%2Foauth-callback%2Fprovider',
  },
  monday: {
    url: 'https://auth.monday.com/oauth_ms/oauth/token',
    method: 'POST',
    headers: JSON_HEADERS,
    body: '{"grant_type":"authorization_code","client_id":"cid","client_secret":"csec","code":"thecode","redirect_uri":"https://control.example.com/api/v1/oauth-callback/provider","code_verifier":"VERIFIER"}',
  },
  clickup: {
    url: 'https://api.clickup.com/api/v2/oauth/token',
    method: 'POST',
    headers: FORM,
    body: 'client_id=cid&client_secret=csec&code=thecode',
  },
  vercel: {
    url: 'https://api.vercel.com/login/oauth/token',
    method: 'POST',
    headers: FORM,
    body: 'grant_type=authorization_code&code=thecode&client_id=cid&client_secret=csec&redirect_uri=https%3A%2F%2Fcontrol.example.com%2Fapi%2Fv1%2Foauth-callback%2Fprovider&code_verifier=VERIFIER',
  },
}

// Refresh: form-encoded standard for the standard providers; JSON for monday;
// notion + clickup have no refresh token and THROW.
const GOLDEN_REFRESH: Record<OAuthProvider, TokenRequest | { throws: RegExp }> = {
  salesforce: {
    url: 'https://login.salesforce.com/services/oauth2/token',
    method: 'POST',
    headers: FORM,
    body: 'grant_type=refresh_token&refresh_token=RT&client_id=cid&client_secret=csec',
  },
  slack: {
    url: 'https://slack.com/api/oauth.v2.access',
    method: 'POST',
    headers: FORM,
    body: 'grant_type=refresh_token&refresh_token=RT&client_id=cid&client_secret=csec',
  },
  notion: { throws: /does not support refresh tokens/ },
  'microsoft-graph': {
    url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    method: 'POST',
    headers: FORM,
    body: 'grant_type=refresh_token&refresh_token=RT&client_id=cid&client_secret=csec',
  },
  google: {
    url: 'https://oauth2.googleapis.com/token',
    method: 'POST',
    headers: FORM,
    body: 'grant_type=refresh_token&refresh_token=RT&client_id=cid&client_secret=csec',
  },
  monday: {
    url: 'https://auth.monday.com/oauth_ms/oauth/token',
    method: 'POST',
    headers: JSON_HEADERS,
    body: '{"grant_type":"refresh_token","client_id":"cid","client_secret":"csec","refresh_token":"RT"}',
  },
  clickup: { throws: /does not support refresh tokens/ },
  vercel: {
    url: 'https://api.vercel.com/login/oauth/token',
    method: 'POST',
    headers: FORM,
    body: 'grant_type=refresh_token&refresh_token=RT&client_id=cid&client_secret=csec',
  },
}

function isThrows(v: TokenRequest | { throws: RegExp }): v is { throws: RegExp } {
  return 'throws' in v
}

describe('OAuth adapters — byte-identical golden (T1, §6.2)', () => {
  it('covers all 8 baked providers', () => {
    expect([...KNOWN_OAUTH_PROVIDERS].sort()).toEqual(
      [
        'clickup',
        'google',
        'microsoft-graph',
        'monday',
        'notion',
        'salesforce',
        'slack',
        'vercel',
      ].sort()
    )
  })

  for (const provider of [...KNOWN_OAUTH_PROVIDERS]) {
    describe(provider, () => {
      const a = getOAuthProviderAdapter(provider)
      const usesPkce = a.usesPkce === true

      it('authorize URL is byte-identical', () => {
        expect(a.buildAuthorizeUrl(AUTHORIZE_INPUT(usesPkce))).toBe(GOLDEN_AUTHORIZE[provider])
      })

      it('token request is byte-identical', () => {
        expect(a.buildTokenRequest(TOKEN_INPUT(usesPkce))).toEqual(GOLDEN_TOKEN[provider])
      })

      it('refresh request matches the golden (or throws)', () => {
        const golden = GOLDEN_REFRESH[provider]
        if (isThrows(golden)) {
          expect(() => a.buildRefreshRequest(REFRESH_INPUT)).toThrow(golden.throws)
        } else {
          expect(a.buildRefreshRequest(REFRESH_INPUT)).toEqual(golden)
        }
      })
    })
  }

  // Explicit ordering guard for a standardTokenRequest provider: with the secret
  // PRESENT the body is exactly grant_type&code&client_id&client_secret&redirect_uri.
  it('standardTokenRequest keeps client_secret between client_id and redirect_uri', () => {
    const body = getOAuthProviderAdapter('salesforce').buildTokenRequest({
      code: 'thecode',
      clientId: 'cid',
      clientSecret: 'csec',
      redirectUri: REDIRECT,
    }).body
    expect(body).toBe(
      'grant_type=authorization_code&code=thecode&client_id=cid&client_secret=csec&redirect_uri=https%3A%2F%2Fcontrol.example.com%2Fapi%2Fv1%2Foauth-callback%2Fprovider'
    )
  })
})

// ─── T5 E-19.2: public client (no secret) omits client_secret ──────────────
describe('E-19.2 public client — client_secret omitted when absent', () => {
  const a = getOAuthProviderAdapter('salesforce')

  it('token POST omits client_secret when clientSecret is undefined', () => {
    const body = a.buildTokenRequest({
      code: 'thecode',
      clientId: 'cid',
      clientSecret: undefined,
      redirectUri: REDIRECT,
    }).body
    expect(body).not.toContain('client_secret')
    expect(body).toBe(
      'grant_type=authorization_code&code=thecode&client_id=cid&redirect_uri=https%3A%2F%2Fcontrol.example.com%2Fapi%2Fv1%2Foauth-callback%2Fprovider'
    )
  })

  it('token POST includes client_secret when present (confidential order)', () => {
    const body = a.buildTokenRequest({
      code: 'thecode',
      clientId: 'cid',
      clientSecret: 'csec',
      redirectUri: REDIRECT,
    }).body
    expect(body).toContain('&client_secret=csec&')
  })

  it('refresh POST omits client_secret when clientSecret is undefined', () => {
    const body = a.buildRefreshRequest({
      refreshToken: 'RT',
      clientId: 'cid',
      clientSecret: undefined,
    }).body
    expect(body).not.toContain('client_secret')
    expect(body).toBe('grant_type=refresh_token&refresh_token=RT&client_id=cid')
  })

  it('refresh POST includes client_secret when present', () => {
    const body = a.buildRefreshRequest({
      refreshToken: 'RT',
      clientId: 'cid',
      clientSecret: 'csec',
    }).body
    expect(body).toBe('grant_type=refresh_token&refresh_token=RT&client_id=cid&client_secret=csec')
  })

  it('confidential-only baked adapters fail closed for a public client', () => {
    for (const provider of ['notion', 'monday', 'clickup'] as const) {
      expect(() =>
        getOAuthProviderAdapter(provider).buildTokenRequest({
          code: 'c',
          clientId: 'cid',
          clientSecret: undefined,
          redirectUri: REDIRECT,
          codeVerifier: 'V',
        })
      ).toThrow(/requires a confidential client secret/)
    }
  })
})
