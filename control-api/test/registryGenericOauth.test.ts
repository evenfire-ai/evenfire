import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { type GenericOAuthKnobs, GenericOAuthKnobsSchema } from '../src/oauth/genericKnobs.js'
import {
  buildGenericOAuthSpec,
  validateGenericEndpoints,
} from '../src/routes/admin/registryGenericOauth.js'

/**
 * S3-B4 — pure install-side generic wiring. `buildGenericOAuthSpec` is a pure
 * knob→spec map; `validateGenericEndpoints` is the kernel §4 seam applied to every
 * operator-typed endpoint. `resolveDns` is injected so the kernel runs without DNS.
 */

const KNOBS: GenericOAuthKnobs = {
  authorizationEndpoint: 'https://idp.example.com/authorize',
  tokenEndpoint: 'https://idp.example.com/token',
  tokenRequestFormat: 'form',
  tokenAuthMethod: 'body',
  scopeSeparator: 'space',
  sendScope: true,
  usePkce: true,
  includeResponseType: true,
  supportsRefresh: true,
}

const REMOTE_ONLY_KEYS = [
  'provider',
  'clientMode',
  'issuer',
  'registrationEndpoint',
  'issForCallback',
  'bearerInBody',
]

describe('buildGenericOAuthSpec', () => {
  it('writes source:generic + the 10 required knobs, no remote fields (public)', () => {
    const spec = buildGenericOAuthSpec({
      id: 'my-idp',
      knobs: KNOBS,
      scopes: ['a'],
      grantScope: 'user',
    })
    expect(spec.source).toBe('generic')
    expect(spec.id).toBe('my-idp')
    expect(spec.scopes).toEqual(['a'])
    expect(spec.grantScope).toBe('user')
    for (const k of REMOTE_ONLY_KEYS) expect(spec).not.toHaveProperty(k)
    // No refs in public mode.
    expect(spec).not.toHaveProperty('clientIdRef')
    expect(spec).not.toHaveProperty('clientSecretRef')
    // Optional knobs omitted when absent.
    expect(spec).not.toHaveProperty('refreshEndpoint')
    expect(spec).not.toHaveProperty('resource')
    expect(spec).not.toHaveProperty('extraAuthorizeParams')
  })

  it('carries both refs in confidential mode', () => {
    const spec = buildGenericOAuthSpec({
      id: 'my-idp',
      knobs: KNOBS,
      scopes: ['a'],
      grantScope: 'user',
      refs: {
        clientIdRef: { name: 'gen-creds', key: 'client_id' },
        clientSecretRef: { name: 'gen-creds', key: 'client_secret' },
      },
    })
    expect(spec.clientIdRef).toEqual({ name: 'gen-creds', key: 'client_id' })
    expect(spec.clientSecretRef).toEqual({ name: 'gen-creds', key: 'client_secret' })
  })

  it('carries optional knobs only when present', () => {
    const spec = buildGenericOAuthSpec({
      id: 'my-idp',
      knobs: {
        ...KNOBS,
        refreshEndpoint: 'https://idp.example.com/refresh',
        resource: 'https://api.example.com',
        extraAuthorizeParams: { audience: 'aud-1' },
      },
      scopes: ['a'],
      grantScope: 'context',
    })
    expect(spec.refreshEndpoint).toBe('https://idp.example.com/refresh')
    expect(spec.resource).toBe('https://api.example.com')
    expect(spec.extraAuthorizeParams).toEqual({ audience: 'aud-1' })
  })

  // T2: property-based — the spec never contains a remote/baked field, its knob
  // subset round-trips through the schema, and refs are paired (both or neither).
  it('property: round-trips knobs, never leaks remote fields, pairs refs', () => {
    const knobArb: fc.Arbitrary<GenericOAuthKnobs> = fc.record(
      {
        authorizationEndpoint: fc.constant('https://idp.example.com/authorize'),
        tokenEndpoint: fc.constant('https://idp.example.com/token'),
        refreshEndpoint: fc.option(fc.constant('https://idp.example.com/refresh'), {
          nil: undefined,
        }),
        resource: fc.option(fc.constant('https://api.example.com'), { nil: undefined }),
        tokenRequestFormat: fc.constantFrom('form', 'json'),
        tokenAuthMethod: fc.constantFrom('body', 'basic'),
        scopeSeparator: fc.constantFrom('space', 'comma'),
        sendScope: fc.boolean(),
        usePkce: fc.boolean(),
        includeResponseType: fc.boolean(),
        supportsRefresh: fc.boolean(),
        extraAuthorizeParams: fc.option(
          fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.string({ maxLength: 8 }), {
            maxKeys: 16,
          }),
          { nil: undefined }
        ),
      },
      { withDeletedKeys: false }
    ) as fc.Arbitrary<GenericOAuthKnobs>

    fc.assert(
      fc.property(knobArb, fc.boolean(), (knobs, confidential) => {
        const refs = confidential
          ? {
              clientIdRef: { name: 's', key: 'client_id' },
              clientSecretRef: { name: 's', key: 'client_secret' },
            }
          : undefined
        const spec = buildGenericOAuthSpec({ id: 'x', knobs, scopes: [], grantScope: 'user', refs })
        for (const k of REMOTE_ONLY_KEYS) expect(spec).not.toHaveProperty(k)
        expect('clientIdRef' in spec).toBe('clientSecretRef' in spec)
        expect('clientIdRef' in spec).toBe(confidential)
        // The knob subset written to the spec re-validates against the schema.
        const {
          source: _s,
          id: _i,
          scopes: _sc,
          grantScope: _g,
          clientIdRef: _ci,
          clientSecretRef: _cs,
          ...knobSubset
        } = spec as Record<string, unknown>
        expect(GenericOAuthKnobsSchema.safeParse(knobSubset).success).toBe(true)
      })
    )
  })
})

describe('validateGenericEndpoints (kernel §4)', () => {
  const publicDns = () => vi.fn(async () => ['93.184.216.34'])

  it('returns [] when every endpoint is https + public + resolvable', async () => {
    const errors = await validateGenericEndpoints(
      {
        ...KNOBS,
        refreshEndpoint: 'https://idp.example.com/refresh',
        resource: 'https://api.example.com',
      },
      { resolveDns: publicDns() }
    )
    expect(errors).toEqual([])
  })

  it('rejects a non-https authorization endpoint (field-prefixed)', async () => {
    const errors = await validateGenericEndpoints(
      { ...KNOBS, authorizationEndpoint: 'http://idp.example.com/authorize' },
      { resolveDns: publicDns() }
    )
    expect(errors.some(e => e.field === 'oauth.generic.authorizationEndpoint')).toBe(true)
  })

  it('rejects an internal-hostname token endpoint without resolving it', async () => {
    const resolveDns = vi.fn(async () => ['93.184.216.34'])
    const errors = await validateGenericEndpoints(
      { ...KNOBS, tokenEndpoint: 'https://token.svc.cluster.local/token' },
      { resolveDns }
    )
    expect(errors.some(e => e.field === 'oauth.generic.tokenEndpoint')).toBe(true)
  })

  it('rejects a resource that resolves to a blocked (private) IP', async () => {
    const resolveDns = vi.fn(async (host: string) =>
      host === 'api.example.com' ? ['10.0.0.5'] : ['93.184.216.34']
    )
    const errors = await validateGenericEndpoints(
      { ...KNOBS, resource: 'https://api.example.com/' },
      { resolveDns }
    )
    expect(errors.some(e => e.field === 'oauth.generic.resource')).toBe(true)
  })
})
