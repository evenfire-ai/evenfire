import { describe, expect, it } from 'vitest'
import {
  currentOidcConfigurationGeneration,
  loadOidcProviderConfiguration,
  readOidcClientSecret,
} from '../src/oidc/configuration.js'

const SECRET = 'a-test-only-oidc-provider-fixture-secret-that-must-never-escape'
const GENERATION_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
const OIDC_ENV = {
  CONTROL_API_OIDC_REGISTRATION_ID: 'company-login',
  CONTROL_API_OIDC_DISPLAY_LABEL: 'Company login',
  CONTROL_API_OIDC_ISSUER: 'https://issuer.example.test/tenant/v2.0',
  CONTROL_API_OIDC_CLIENT_ID: 'test-client-id',
  CONTROL_API_OIDC_CLIENT_SECRET: SECRET,
  CONTROL_API_OIDC_CLIENT_AUTH_METHOD: 'client_secret_basic',
  CONTROL_API_OIDC_REDIRECT_URI: 'https://api.example.test/api/v1/oidc/callback',
  CONTROL_API_OIDC_RESPONSE_MODE: 'query',
  CONTROL_API_OIDC_TRUST_GENERATION: 'config-2026-10-27-1',
}

describe('OIDC deployment configuration', () => {
  it('leaves installations without OIDC configuration unchanged', () => {
    expect(loadOidcProviderConfiguration({}, GENERATION_KEY)).toBeUndefined()
  })

  it('accepts one complete provider as configured but not activated for member login', () => {
    const provider = loadOidcProviderConfiguration(OIDC_ENV, GENERATION_KEY)
    expect(provider).toMatchObject({
      registrationId: 'company-login',
      displayLabel: 'Company login',
      issuer: OIDC_ENV.CONTROL_API_OIDC_ISSUER,
      clientId: 'test-client-id',
      clientSecretRef: 'CONTROL_API_OIDC_CLIENT_SECRET',
      clientAuthenticationMethod: 'client_secret_basic',
      redirectUri: OIDC_ENV.CONTROL_API_OIDC_REDIRECT_URI,
      responseType: 'code',
      responseMode: 'query',
      scopes: ['openid', 'profile', 'email'],
      memberAuthenticationActivated: false,
    })
    expect(provider?.configurationGeneration).toBe(
      currentOidcConfigurationGeneration(provider!, SECRET, GENERATION_KEY)
    )
    expect(readOidcClientSecret(provider!, OIDC_ENV)).toBe(SECRET)
    expect(JSON.stringify(provider)).not.toContain(SECRET)
  })

  it('changes the trust generation when any registration or secret changes', () => {
    const first = loadOidcProviderConfiguration(OIDC_ENV, GENERATION_KEY)!
    const rotated = loadOidcProviderConfiguration(
      { ...OIDC_ENV, CONTROL_API_OIDC_CLIENT_SECRET: `${SECRET}-rotated` },
      GENERATION_KEY
    )!
    const trustRevision = loadOidcProviderConfiguration(
      { ...OIDC_ENV, CONTROL_API_OIDC_TRUST_GENERATION: 'config-2026-10-28-1' },
      GENERATION_KEY
    )!
    expect(rotated.configurationGeneration).not.toBe(first.configurationGeneration)
    expect(trustRevision.configurationGeneration).not.toBe(first.configurationGeneration)
  })

  it('keys the trust generation with the configured generation key', () => {
    const first = loadOidcProviderConfiguration(OIDC_ENV, GENERATION_KEY)!
    const rotatedKey = loadOidcProviderConfiguration(
      OIDC_ENV,
      'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100'
    )!

    expect(rotatedKey.configurationGeneration).not.toBe(first.configurationGeneration)
    expect(first.configurationGeneration).not.toContain(SECRET)
    expect(rotatedKey.configurationGeneration).not.toContain(SECRET)
  })

  it('rejects incomplete and unknown OIDC settings without echoing the credential', () => {
    expect(() =>
      loadOidcProviderConfiguration(
        { ...OIDC_ENV, CONTROL_API_OIDC_CLIENT_ID: undefined },
        GENERATION_KEY
      )
    ).toThrow(/CONTROL_API_OIDC_CLIENT_ID/)
    expect(() =>
      loadOidcProviderConfiguration(
        { ...OIDC_ENV, CONTROL_API_OIDC_PROVIDERS: 'two' },
        GENERATION_KEY
      )
    ).toThrow(/Unsupported OIDC configuration field/)
    try {
      loadOidcProviderConfiguration(
        { ...OIDC_ENV, CONTROL_API_OIDC_CLIENT_ID: undefined },
        GENERATION_KEY
      )
    } catch (error) {
      expect(String(error)).not.toContain(SECRET)
    }
  })

  it.each([
    ['HTTP issuer', { ...OIDC_ENV, CONTROL_API_OIDC_ISSUER: 'http://issuer.example.test' }],
    ['localhost issuer', { ...OIDC_ENV, CONTROL_API_OIDC_ISSUER: 'https://localhost/issuer' }],
    ['private IP issuer', { ...OIDC_ENV, CONTROL_API_OIDC_ISSUER: 'https://10.1.2.3/issuer' }],
    [
      'userinfo issuer',
      { ...OIDC_ENV, CONTROL_API_OIDC_ISSUER: 'https://user@issuer.example.test' },
    ],
    [
      'query-bearing issuer',
      { ...OIDC_ENV, CONTROL_API_OIDC_ISSUER: 'https://issuer.example.test/?tenant=x' },
    ],
    [
      'fragment callback',
      { ...OIDC_ENV, CONTROL_API_OIDC_REDIRECT_URI: 'https://api.example.test/callback#fragment' },
    ],
    ['unsupported response mode', { ...OIDC_ENV, CONTROL_API_OIDC_RESPONSE_MODE: 'fragment' }],
    [
      'unsupported client authentication',
      { ...OIDC_ENV, CONTROL_API_OIDC_CLIENT_AUTH_METHOD: 'none' },
    ],
  ])('rejects %s configuration', (_label, environment) => {
    expect(() => loadOidcProviderConfiguration(environment, GENERATION_KEY)).toThrow()
  })

  it('fails closed when the configured credential reference no longer resolves', () => {
    const provider = loadOidcProviderConfiguration(OIDC_ENV, GENERATION_KEY)!
    expect(() => readOidcClientSecret(provider, {})).toThrow(
      'OIDC client credential is unavailable'
    )
  })
})
