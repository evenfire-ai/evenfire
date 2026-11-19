import { isIP } from 'node:net'
import type { OidcProviderConfiguration } from './configuration.js'
import { OidcProviderIncompatibleError } from './protocolResult.js'

export const MAX_JWKS_KEYS = 64
export const MIN_RSA_MODULUS_BITS = 2048
export const OIDC_ID_TOKEN_ALGORITHM = 'RS256'

export type OidcServerMetadata = {
  issuer?: unknown
  authorization_endpoint?: unknown
  token_endpoint?: unknown
  jwks_uri?: unknown
  response_types_supported?: unknown
  response_modes_supported?: unknown
  grant_types_supported?: unknown
  scopes_supported?: unknown
  id_token_signing_alg_values_supported?: unknown
  token_endpoint_auth_methods_supported?: unknown
  code_challenge_methods_supported?: unknown
  authorization_response_iss_parameter_supported?: unknown
}

export type TrustedOidcProviderEndpoints = Readonly<{
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  jwksEndpoint: string
}>

export type ValidatedOidcProviderProfile = TrustedOidcProviderEndpoints &
  Readonly<{
    responseType: 'code'
    responseMode: 'query'
    grantType: 'authorization_code'
    scopes: readonly ['openid', 'profile', 'email']
    clientAuthenticationMethod: OidcProviderConfiguration['clientAuthenticationMethod']
    codeChallengeMethod: 'S256'
    idTokenSigningAlgorithm: typeof OIDC_ID_TOKEN_ALGORITHM
    minimumRsaModulusBits: typeof MIN_RSA_MODULUS_BITS
    authorizationResponseIssuerParameterSupported: boolean
  }>

export function validateMetadataEndpoint(value: string, field: string): void {
  const url = new URL(value)
  const hostname = url.hostname.toLowerCase()
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    isIP(hostname) !== 0 ||
    !hostname.includes('.') ||
    hostname === 'localhost' ||
    hostname === 'metadata.goog' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.svc') ||
    hostname.endsWith('.svc.cluster.local') ||
    hostname.endsWith('.cluster.local') ||
    !hostname.split('.').every(label => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new OidcProviderIncompatibleError(
      `OIDC ${field} is not a public HTTPS endpoint`,
      'untrusted-endpoint'
    )
  }
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new OidcProviderIncompatibleError(`OIDC metadata has no valid ${field}`)
  }
  return value
}

function metadataStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    value.some(entry => typeof entry !== 'string' || entry.length === 0)
  ) {
    throw new OidcProviderIncompatibleError(`OIDC metadata has an invalid ${field}`)
  }
  return value as string[]
}

export function validateOidcProviderProfile(
  metadata: OidcServerMetadata,
  provider: OidcProviderConfiguration,
  trustedEndpoints: TrustedOidcProviderEndpoints
): ValidatedOidcProviderProfile {
  if (
    metadata.authorization_response_iss_parameter_supported !== undefined &&
    typeof metadata.authorization_response_iss_parameter_supported !== 'boolean'
  ) {
    throw new OidcProviderIncompatibleError(
      'OIDC discovery response has an invalid issuer-binding capability'
    )
  }
  const responseTypes = metadataStringArray(
    metadata.response_types_supported,
    'response_types_supported'
  )
  if (!responseTypes?.includes('code')) {
    throw new OidcProviderIncompatibleError(
      'OIDC provider does not support authorization-code response'
    )
  }
  const responseModes = metadataStringArray(
    metadata.response_modes_supported,
    'response_modes_supported'
  )
  const grantTypes = metadataStringArray(metadata.grant_types_supported, 'grant_types_supported')
  const scopes = metadataStringArray(metadata.scopes_supported, 'scopes_supported')
  const idTokenAlgorithms = metadataStringArray(
    metadata.id_token_signing_alg_values_supported,
    'id_token_signing_alg_values_supported'
  )
  const authenticationMethods = metadataStringArray(
    metadata.token_endpoint_auth_methods_supported,
    'token_endpoint_auth_methods_supported'
  )
  const codeChallengeMethods = metadataStringArray(
    metadata.code_challenge_methods_supported,
    'code_challenge_methods_supported'
  )
  if (grantTypes && !grantTypes.includes('authorization_code')) {
    throw new OidcProviderIncompatibleError(
      'OIDC provider does not support authorization-code grant'
    )
  }
  if (scopes && !['openid', 'profile', 'email'].every(scope => scopes.includes(scope))) {
    throw new OidcProviderIncompatibleError('OIDC provider does not support required scopes')
  }
  if (idTokenAlgorithms && !idTokenAlgorithms.includes(OIDC_ID_TOKEN_ALGORITHM)) {
    throw new OidcProviderIncompatibleError(
      `OIDC provider does not support the configured ${OIDC_ID_TOKEN_ALGORITHM} ID-token algorithm`
    )
  }
  if (responseModes && !responseModes.includes('query')) {
    throw new OidcProviderIncompatibleError(
      'OIDC provider does not support the configured query response mode'
    )
  }
  const supportedAuthenticationMethods = authenticationMethods ?? ['client_secret_basic']
  if (!supportedAuthenticationMethods.includes(provider.clientAuthenticationMethod)) {
    throw new OidcProviderIncompatibleError(
      'OIDC provider does not support configured client authentication'
    )
  }
  if (codeChallengeMethods && !codeChallengeMethods.includes('S256')) {
    throw new OidcProviderIncompatibleError('OIDC provider does not support PKCE S256')
  }
  return Object.freeze({
    ...trustedEndpoints,
    responseType: 'code',
    responseMode: 'query',
    grantType: 'authorization_code',
    scopes: ['openid', 'profile', 'email'] as const,
    clientAuthenticationMethod: provider.clientAuthenticationMethod,
    codeChallengeMethod: 'S256',
    idTokenSigningAlgorithm: OIDC_ID_TOKEN_ALGORITHM,
    minimumRsaModulusBits: MIN_RSA_MODULUS_BITS,
    authorizationResponseIssuerParameterSupported:
      metadata.authorization_response_iss_parameter_supported === true,
  })
}

export function validateJwks(body: string, profile: ValidatedOidcProviderProfile): void {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    throw new OidcProviderIncompatibleError('OIDC JWKS response is malformed')
  }
  if (
    !isRecord(value) ||
    !Array.isArray(value.keys) ||
    value.keys.length === 0 ||
    value.keys.length > MAX_JWKS_KEYS
  ) {
    throw new OidcProviderIncompatibleError('OIDC JWKS response exceeds the supported key set')
  }
  const privateParameters = new Set(['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'])
  for (const key of value.keys) {
    if (
      !isRecord(key) ||
      key.kty !== 'RSA' ||
      typeof key.n !== 'string' ||
      !hasMinimumRsaModulus(key.n, profile.minimumRsaModulusBits) ||
      typeof key.e !== 'string' ||
      typeof key.kid !== 'string' ||
      key.kid.length === 0 ||
      key.kid.length > 256 ||
      (key.use !== undefined && key.use !== 'sig') ||
      (key.alg !== undefined && key.alg !== profile.idTokenSigningAlgorithm) ||
      Object.keys(key).some(name => privateParameters.has(name))
    ) {
      throw new OidcProviderIncompatibleError('OIDC JWKS response contains an invalid public key')
    }
  }
  const keyIds = value.keys.map(key => (key as Record<string, unknown>).kid)
  if (new Set(keyIds).size !== keyIds.length) {
    throw new OidcProviderIncompatibleError('OIDC JWKS response contains duplicate key identifiers')
  }
}

function hasMinimumRsaModulus(value: string, minimumBits: number): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false
  const modulus = Buffer.from(value, 'base64url')
  if (modulus.length === 0 || modulus.toString('base64url') !== value) return false

  let firstSignificantByte = 0
  while (firstSignificantByte < modulus.length && modulus[firstSignificantByte] === 0) {
    firstSignificantByte += 1
  }
  if (firstSignificantByte === modulus.length) return false

  const significantLength = modulus.length - firstSignificantByte
  const leadingByte = modulus[firstSignificantByte] ?? 0
  const leadingBits = 32 - Math.clz32(leadingByte)
  return (significantLength - 1) * 8 + leadingBits >= minimumBits
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
