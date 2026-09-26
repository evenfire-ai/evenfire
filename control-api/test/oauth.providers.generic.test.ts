import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  type GenericAdapterConfig,
  buildAdapterFromConfig,
  buildRemoteRefreshRequest,
  buildRemoteTokenRequest,
  getOAuthProviderAdapter,
} from '../src/oauth/providers.js'

/**
 * S3.2 / DEC-28 — `buildAdapterFromConfig` is the PURE knob→wire composer for the
 * generic self-hosted OAuth lane. T4: assert the OBSERVABLE emitted request bytes
 * / authorize URL. T2 (fast-check): the mapping (config, input) → request is a
 * pure function; a config that re-expresses a baked adapter's form shape emits the
 * SAME bytes as the real remote form producer (`buildRemoteTokenRequest`), and the
 * knob branches (form/json, body/basic, scopeSeparator, sendScope) each select one
 * fixed behavior. The 8 baked adapters and the provider enum stay byte-frozen
 * (pinned by `oauth.providers.golden.test.ts`); here we only prove the composer.
 */

const AUTH_ENDPOINT = 'https://idp.example.com/authorize'
const TOKEN_ENDPOINT = 'https://idp.example.com/token'
const RESOURCE = 'https://api.example.com'

function cfg(overrides: Partial<GenericAdapterConfig> = {}): GenericAdapterConfig {
  return {
    authorizationEndpoint: AUTH_ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    tokenRequestFormat: 'form',
    tokenAuthMethod: 'body',
    scopeSeparator: 'space',
    sendScope: true,
    usePkce: true,
    includeResponseType: true,
    ...overrides,
  }
}

const TOKEN_INPUT = {
  code: 'CODE',
  clientId: 'CID',
  clientSecret: 'SEC',
  redirectUri: 'https://cb.example.com/generic',
  codeVerifier: 'VER',
}

describe('buildAdapterFromConfig.buildAuthorizeUrl (knob-gated, T4)', () => {
  const AUTH_INPUT = {
    clientId: 'CID',
    redirectUri: 'https://cb.example.com/generic',
    state: 'signed-state',
    scopes: ['read', 'write'],
    codeChallenge: 'CHAL',
  }

  it('honors usePkce=true / sendScope=true (space) / includeResponseType=true + resource', () => {
    const url = new URL(
      buildAdapterFromConfig(cfg({ resource: RESOURCE })).buildAuthorizeUrl(AUTH_INPUT)
    )
    expect(`${url.origin}${url.pathname}`).toBe(AUTH_ENDPOINT)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('CID')
    expect(url.searchParams.get('code_challenge')).toBe('CHAL')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe('read write')
    expect(url.searchParams.get('resource')).toBe(RESOURCE)
  })

  it('usePkce=false ⇒ no code_challenge even when a challenge is supplied', () => {
    const url = new URL(
      buildAdapterFromConfig(cfg({ usePkce: false })).buildAuthorizeUrl(AUTH_INPUT)
    )
    expect(url.searchParams.get('code_challenge')).toBeNull()
    expect(url.searchParams.get('code_challenge_method')).toBeNull()
  })

  it('sendScope=false ⇒ no scope param', () => {
    const url = new URL(
      buildAdapterFromConfig(cfg({ sendScope: false })).buildAuthorizeUrl(AUTH_INPUT)
    )
    expect(url.searchParams.get('scope')).toBeNull()
  })

  it('scopeSeparator=comma joins scopes with a comma', () => {
    const url = new URL(
      buildAdapterFromConfig(cfg({ scopeSeparator: 'comma' })).buildAuthorizeUrl(AUTH_INPUT)
    )
    expect(url.searchParams.get('scope')).toBe('read,write')
  })

  it('includeResponseType=false ⇒ no response_type param', () => {
    const url = new URL(
      buildAdapterFromConfig(cfg({ includeResponseType: false })).buildAuthorizeUrl(AUTH_INPUT)
    )
    expect(url.searchParams.get('response_type')).toBeNull()
  })

  it('merges extraAuthorizeParams but reserved params always win (no clobber of state/PKCE)', () => {
    const url = new URL(
      buildAdapterFromConfig(
        cfg({ extraAuthorizeParams: { audience: 'aud-1', state: 'ATTACKER', prompt: 'consent' } })
      ).buildAuthorizeUrl(AUTH_INPUT)
    )
    expect(url.searchParams.get('audience')).toBe('aud-1')
    expect(url.searchParams.get('prompt')).toBe('consent')
    // extraAuthorizeParams cannot override the signed state binding.
    expect(url.searchParams.get('state')).toBe('signed-state')
  })

  it('appends to an authorize endpoint that already has a query string', () => {
    const url = buildAdapterFromConfig(
      cfg({ authorizationEndpoint: 'https://idp.example.com/authorize?tenant=acme' })
    ).buildAuthorizeUrl(AUTH_INPUT)
    expect(url).toContain('?tenant=acme&')
    expect(url).toContain('client_id=CID')
  })
})

describe('buildAdapterFromConfig.buildTokenRequest (format/authMethod, T4)', () => {
  it('form + body → standard form shape verbatim (byte-identical to the remote form producer)', () => {
    const req = buildAdapterFromConfig(cfg({ resource: RESOURCE })).buildTokenRequest(TOKEN_INPUT)
    expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(req.body).toBe(buildRemoteTokenRequest(TOKEN_ENDPOINT, TOKEN_INPUT, RESOURCE).body)
    expect(req.body).toContain('client_secret=SEC')
    expect(req.body).toContain('code_verifier=VER')
    expect(req.body.endsWith('&resource=https%3A%2F%2Fapi.example.com')).toBe(true)
  })

  it('form + basic → creds in the Authorization header, omitted from the body', () => {
    const req = buildAdapterFromConfig(cfg({ tokenAuthMethod: 'basic' })).buildTokenRequest(
      TOKEN_INPUT
    )
    expect(req.headers.authorization).toBe(`Basic ${Buffer.from('CID:SEC').toString('base64')}`)
    expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(req.body).not.toContain('client_secret')
    expect(req.body).not.toContain('client_id')
    expect(req.body).toContain('code_verifier=VER')
  })

  it('json + body → JSON body with client creds', () => {
    const req = buildAdapterFromConfig(
      cfg({ tokenRequestFormat: 'json', resource: RESOURCE })
    ).buildTokenRequest(TOKEN_INPUT)
    expect(req.headers['content-type']).toBe('application/json')
    expect(JSON.parse(req.body)).toEqual({
      grant_type: 'authorization_code',
      client_id: 'CID',
      client_secret: 'SEC',
      code: 'CODE',
      redirect_uri: 'https://cb.example.com/generic',
      code_verifier: 'VER',
      resource: RESOURCE,
    })
  })

  it('json + basic → JSON body without creds + Basic header', () => {
    const req = buildAdapterFromConfig(
      cfg({ tokenRequestFormat: 'json', tokenAuthMethod: 'basic' })
    ).buildTokenRequest(TOKEN_INPUT)
    expect(req.headers.authorization).toBe(`Basic ${Buffer.from('CID:SEC').toString('base64')}`)
    const parsed = JSON.parse(req.body)
    expect(parsed.client_secret).toBeUndefined()
    expect(parsed.client_id).toBeUndefined()
    expect(parsed.code).toBe('CODE')
  })

  it('public client (no secret, body) omits client_secret', () => {
    const req = buildAdapterFromConfig(cfg()).buildTokenRequest({
      code: 'CODE',
      clientId: 'CID',
      redirectUri: 'https://cb.example.com/generic',
      codeVerifier: 'VER',
    })
    expect(req.body).not.toContain('client_secret')
    expect(req.body).toContain('client_id=CID')
  })

  it('tokenAuthMethod=basic without a secret fails closed (throws)', () => {
    expect(() =>
      buildAdapterFromConfig(cfg({ tokenAuthMethod: 'basic' })).buildTokenRequest({
        code: 'CODE',
        clientId: 'CID',
        redirectUri: 'https://cb.example.com/generic',
      })
    ).toThrow(/basic requires a client secret/)
  })
})

describe('buildAdapterFromConfig.buildRefreshRequest', () => {
  const REFRESH_INPUT = { refreshToken: 'RT', clientId: 'CID', clientSecret: 'SEC' }

  it('form + body → standard refresh shape (byte-identical to the remote form producer)', () => {
    const req = buildAdapterFromConfig(cfg({ resource: RESOURCE })).buildRefreshRequest(
      REFRESH_INPUT
    )
    expect(req.url).toBe(TOKEN_ENDPOINT)
    expect(req.body).toBe(buildRemoteRefreshRequest(TOKEN_ENDPOINT, REFRESH_INPUT, RESOURCE).body)
  })

  it('refreshEndpoint overrides tokenEndpoint as the POST target', () => {
    const req = buildAdapterFromConfig(
      cfg({ refreshEndpoint: 'https://idp.example.com/refresh' })
    ).buildRefreshRequest(REFRESH_INPUT)
    expect(req.url).toBe('https://idp.example.com/refresh')
  })

  it('json + basic refresh → JSON body without creds + Basic header', () => {
    const req = buildAdapterFromConfig(
      cfg({ tokenRequestFormat: 'json', tokenAuthMethod: 'basic' })
    ).buildRefreshRequest(REFRESH_INPUT)
    expect(req.headers.authorization).toBe(`Basic ${Buffer.from('CID:SEC').toString('base64')}`)
    expect(JSON.parse(req.body)).toEqual({ grant_type: 'refresh_token', refresh_token: 'RT' })
  })
})

// ─── T2 property-based: the composer is a pure (config,input)→request function ──
describe('buildAdapterFromConfig — property-based (T2)', () => {
  const arbInput = fc.record({
    code: fc.string({ minLength: 1 }),
    clientId: fc.string({ minLength: 1 }),
    clientSecret: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
    redirectUri: fc.webUrl(),
    codeVerifier: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  })
  const arbResource = fc.option(fc.webUrl(), { nil: undefined })

  it('form+body token request re-expresses the baked/remote form shape for any input', () => {
    fc.assert(
      fc.property(arbInput, arbResource, (input, resource) => {
        const generic = buildAdapterFromConfig(cfg({ resource })).buildTokenRequest(input)
        const remote = buildRemoteTokenRequest(TOKEN_ENDPOINT, input, resource)
        return generic.body === remote.body && generic.url === remote.url
      })
    )
  })

  it('scopeSeparator selects one fixed join; sendScope=false always omits scope', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ minLength: 1 }).filter(s => !/[\s,&=?#]/.test(s)),
          { minLength: 1, maxLength: 6 }
        ),
        fc.constantFrom<'space' | 'comma'>('space', 'comma'),
        fc.boolean(),
        (scopes, scopeSeparator, sendScope) => {
          const url = new URL(
            buildAdapterFromConfig(cfg({ scopeSeparator, sendScope })).buildAuthorizeUrl({
              clientId: 'CID',
              redirectUri: 'https://cb.example.com/generic',
              state: 'S',
              scopes,
              codeChallenge: 'C',
            })
          )
          const scope = url.searchParams.get('scope')
          if (!sendScope) return scope === null
          return scope === scopes.join(scopeSeparator === 'comma' ? ',' : ' ')
        }
      )
    )
  })

  it('is deterministic — identical (config,input) yields identical bytes', () => {
    fc.assert(
      fc.property(
        arbInput,
        fc.constantFrom<'form' | 'json'>('form', 'json'),
        fc.constantFrom<'body' | 'basic'>('body', 'basic'),
        (input, tokenRequestFormat, tokenAuthMethod) => {
          // basic needs a secret; skip the fail-closed combination for determinism check.
          const usableInput =
            tokenAuthMethod === 'basic' ? { ...input, clientSecret: 'SEC' } : input
          const a = buildAdapterFromConfig(cfg({ tokenRequestFormat, tokenAuthMethod }))
          const b = buildAdapterFromConfig(cfg({ tokenRequestFormat, tokenAuthMethod }))
          return a.buildTokenRequest(usableInput).body === b.buildTokenRequest(usableInput).body
        }
      )
    )
  })
})

describe('the baked adapters are untouched by the generic composer', () => {
  it('salesforce token body carries no resource and is unchanged', () => {
    const body = getOAuthProviderAdapter('salesforce').buildTokenRequest({
      code: 'thecode',
      clientId: 'cid',
      clientSecret: 'csec',
      redirectUri: 'https://control.example.com/api/v1/oauth-callback/provider',
    }).body
    expect(body).not.toContain('resource=')
  })
})
