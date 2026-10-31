import { describe, expect, it } from 'vitest'
import { loadOidcProviderConfiguration } from '../src/oidc/configuration.js'
import { OidcProviderIncompatibleError } from '../src/oidc/protocolResult.js'
import {
  OIDC_ID_TOKEN_ALGORITHM,
  validateOidcProviderProfile,
} from '../src/oidc/providerProfile.js'

const GENERATION_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
const PROVIDER = loadOidcProviderConfiguration(
  {
    CONTROL_API_OIDC_REGISTRATION_ID: 'company-login',
    CONTROL_API_OIDC_DISPLAY_LABEL: 'Company login',
    CONTROL_API_OIDC_ISSUER: 'https://issuer.example.test/tenant',
    CONTROL_API_OIDC_CLIENT_ID: 'test-client',
    CONTROL_API_OIDC_CLIENT_SECRET: 'provider-profile-fixture-secret',
    CONTROL_API_OIDC_CLIENT_AUTH_METHOD: 'client_secret_post',
    CONTROL_API_OIDC_REDIRECT_URI: 'https://api.example.test/oidc/callback',
    CONTROL_API_OIDC_RESPONSE_MODE: 'query',
    CONTROL_API_OIDC_TRUST_GENERATION: 'profile-test-v1',
  },
  GENERATION_KEY
)!

const TRUSTED_ENDPOINTS = {
  issuer: PROVIDER.issuer,
  authorizationEndpoint: `${PROVIDER.issuer}/authorize`,
  tokenEndpoint: `${PROVIDER.issuer}/token`,
  jwksEndpoint: `${PROVIDER.issuer}/keys`,
}

function profile(metadata: Record<string, unknown>) {
  return validateOidcProviderProfile(
    {
      issuer: PROVIDER.issuer,
      response_types_supported: ['code'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      ...metadata,
    },
    PROVIDER,
    TRUSTED_ENDPOINTS
  )
}

describe('OIDC ID-token signing-algorithm metadata', () => {
  it('preserves the existing RS256 default when optional metadata is absent', () => {
    expect(profile({}).idTokenSigningAlgorithm).toBe(OIDC_ID_TOKEN_ALGORITHM)
  })

  it('accepts a valid declaration that includes the pinned RS256 algorithm', () => {
    expect(profile({ id_token_signing_alg_values_supported: ['PS256', 'RS256'] })).toMatchObject({
      idTokenSigningAlgorithm: 'RS256',
    })
  })

  it('rejects a valid declaration that excludes the pinned RS256 algorithm', () => {
    expect(() => profile({ id_token_signing_alg_values_supported: ['PS256'] })).toThrow(
      OidcProviderIncompatibleError
    )
  })

  it.each([
    ['not an array', 'RS256'],
    ['contains a non-string', ['RS256', 1]],
    ['is empty', []],
  ])('rejects metadata that is malformed or unsupported (%s)', (_case, value) => {
    expect(() => profile({ id_token_signing_alg_values_supported: value })).toThrow(
      OidcProviderIncompatibleError
    )
  })
})
