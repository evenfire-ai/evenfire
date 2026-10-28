import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import {
  ClientSecretBasic,
  ClientSecretPost,
  type Configuration,
  type CustomFetch,
  type FetchBody,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  customFetch,
  discovery,
  enableNonRepudiationChecks,
  getJwksCache,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  setJwksCache,
} from 'openid-client'
import type { DbClient } from '../db.js'
import { pinnedFetch } from '../http/pinnedFetch.js'
import { resolveValidatedOAuthEndpoint } from '../http/validateMcpServerSpec.js'
import { checkAsEndpointsSameSite, registrableSite } from '../oauth/discovery.js'
import {
  type OidcProviderConfiguration,
  currentOidcConfigurationGeneration,
} from './configuration.js'
import {
  type ClaimedOidcProtocolAttempt,
  OIDC_PROTOCOL_ATTEMPT_TTL_MS,
  type OidcProtocolAttemptBinding,
  claimOidcProtocolAttempt,
  finishOidcProtocolAttempt,
  insertOidcProtocolAttempt,
} from './protocolAttemptStore.js'

const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 15_000
const MAX_JWKS_KEYS = 64
const MIN_RSA_MODULUS_BITS = 2048
const OIDC_ID_TOKEN_ALGORITHM = 'RS256'
const PROOF_PURPOSE = 'oidc-identity-proof-v1' as const

type OidcServerMetadata = {
  issuer?: unknown
  authorization_endpoint?: unknown
  token_endpoint?: unknown
  jwks_uri?: unknown
  response_types_supported?: unknown
  response_modes_supported?: unknown
  grant_types_supported?: unknown
  scopes_supported?: unknown
  token_endpoint_auth_methods_supported?: unknown
  code_challenge_methods_supported?: unknown
  authorization_response_iss_parameter_supported?: unknown
}

type TrustedOidcProviderEndpoints = Readonly<{
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  jwksEndpoint: string
}>

type ValidatedOidcProviderProfile = TrustedOidcProviderEndpoints &
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

export type OidcProviderValidation = Readonly<{
  status: 'metadata-and-jwks-valid' | 'unavailable' | 'incompatible'
  registrationId: string
  displayLabel: string
  issuer: string
  configurationGeneration: string
  memberAuthenticationActivated: false
  reason?: 'provider-unavailable' | 'unsupported-provider-profile' | 'untrusted-endpoint'
}>

export type OidcVerifiedAttributes = Readonly<{
  source: 'validated_id_token'
  email?: string
  emailVerified?: boolean
  name?: string
  preferredUsername?: string
  locale?: string
}>

export type VerifiedOidcIdentityProof = Readonly<{
  purpose: typeof PROOF_PURPOSE
  issuer: string
  subject: string
  registrationId: string
  clientId: string
  configurationGeneration: string
  attemptId: string
  issuedAt: number
  authenticationTime?: number
  attributes: OidcVerifiedAttributes
}>

const validProofs = new WeakSet<object>()

/** Runtime provenance check for future in-process composition; this is not a token. */
export function isVerifiedOidcIdentityProof(value: unknown): value is VerifiedOidcIdentityProof {
  return typeof value === 'object' && value !== null && validProofs.has(value)
}

/** Strict adapter helper for a future callback owner; it does not admit or sign in a user. */
export function parseOidcCallbackUrl(
  rawCallbackUrl: string,
  expectedRedirectUri: string
): { state: string; code: string; issuer?: string } {
  let callback: URL
  let expected: URL
  try {
    callback = new URL(rawCallbackUrl)
    expected = new URL(expectedRedirectUri)
  } catch {
    throw new OidcProviderIncompatibleError('OIDC callback URL is malformed')
  }
  if (
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname ||
    callback.hash !== '' ||
    callback.username !== '' ||
    callback.password !== ''
  ) {
    throw new OidcProviderIncompatibleError(
      'OIDC callback URL does not match the registered redirect URI'
    )
  }
  for (const name of ['state', 'code', 'iss', 'error', 'error_description']) {
    if (callback.searchParams.getAll(name).length > 1) {
      throw new OidcProviderIncompatibleError(
        'OIDC callback contains duplicate protocol parameters'
      )
    }
  }
  if (callback.searchParams.has('error') || callback.searchParams.has('error_description')) {
    throw new OidcProviderIncompatibleError(
      'OIDC authorization was denied or could not be completed'
    )
  }
  const state = callback.searchParams.get('state')
  const code = callback.searchParams.get('code')
  const issuer = callback.searchParams.get('iss') ?? undefined
  if (!state || !code) {
    throw new OidcProviderIncompatibleError(
      'OIDC callback is missing its state or authorization code'
    )
  }
  return { state, code, ...(issuer !== undefined ? { issuer } : {}) }
}

export class OidcProviderUnavailableError extends Error {
  constructor() {
    super('Configured OIDC provider is temporarily unavailable')
    this.name = 'OidcProviderUnavailableError'
  }
}

export class OidcProviderIncompatibleError extends Error {
  constructor(reason = 'Configured OIDC provider does not meet the supported profile') {
    super(reason)
    this.name = 'OidcProviderIncompatibleError'
  }
}

type OidcProviderOperationFailure =
  | Readonly<{ kind: 'unavailable'; error: OidcProviderUnavailableError }>
  | Readonly<{ kind: 'incompatible'; error: OidcProviderIncompatibleError }>

type OidcOperationContext = {
  signal?: AbortSignal
  transportFailure?: OidcProviderOperationFailure
}

export type OidcProtocolDependencies = Readonly<{
  db: Pick<DbClient, 'query'>
  getClientSecret: () => string
  encryptionKeyHex: string
  now?: () => number
}>

type TrustedConfiguration = Readonly<{
  client: Configuration
  transport: TrustedOidcTransport
  profile: ValidatedOidcProviderProfile
  validatedAt: number
}>

/**
 * The OIDC protocol engine stops at a validated external identity proof. It has
 * no HTTP route, member repository, invitation owner, or shared-session issuer.
 */
export class OidcProtocolEngine {
  private cachedConfiguration?: TrustedConfiguration
  private readonly operationContext = new AsyncLocalStorage<OidcOperationContext>()

  constructor(
    private readonly provider: OidcProviderConfiguration,
    private readonly dependencies: OidcProtocolDependencies
  ) {}

  async validateProvider(options: { signal?: AbortSignal } = {}): Promise<OidcProviderValidation> {
    return this.operationContext.run({ signal: options.signal }, async () => {
      try {
        const trusted = await this.getTrustedConfiguration()
        await trusted.transport.fetchJwks(trusted.profile)
        return this.safeStatus('metadata-and-jwks-valid')
      } catch (error) {
        if (error instanceof OidcProviderIncompatibleError) {
          return this.safeStatus(
            'incompatible',
            error.message === 'OIDC endpoint failed public-network validation'
              ? 'untrusted-endpoint'
              : 'unsupported-provider-profile'
          )
        }
        return this.safeStatus('unavailable', 'provider-unavailable')
      }
    })
  }

  async beginIdentityProofAttempt(
    options: { signal?: AbortSignal } = {}
  ): Promise<{ authorizationUrl: string; expiresAt: Date }> {
    return this.operationContext.run({ signal: options.signal }, async () => {
      const trusted = await this.getTrustedConfiguration()
      const now = this.now()
      const state = randomState()
      const nonce = randomNonce()
      const pkceVerifier = randomPKCECodeVerifier()
      const codeChallenge = await calculatePKCECodeChallenge(pkceVerifier)
      const expiresAt = new Date(now + OIDC_PROTOCOL_ATTEMPT_TTL_MS)
      const attempt = await insertOidcProtocolAttempt(
        this.dependencies.db,
        this.dependencies.encryptionKeyHex,
        {
          ...this.binding(trusted.profile),
          state,
          pkceVerifier,
          nonce,
          expiresAt,
        }
      )

      const authorizationUrl = buildAuthorizationUrl(trusted.client, {
        client_id: this.provider.clientId,
        redirect_uri: this.provider.redirectUri,
        response_type: trusted.profile.responseType,
        response_mode: trusted.profile.responseMode,
        scope: trusted.profile.scopes.join(' '),
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: trusted.profile.codeChallengeMethod,
      })
      return { authorizationUrl: authorizationUrl.href, expiresAt: attempt.expiresAt }
    })
  }

  async completeIdentityProofAttempt(
    input: {
      state: string
      code: string
      issuer?: string
    },
    options: { signal?: AbortSignal } = {}
  ): Promise<VerifiedOidcIdentityProof> {
    return this.operationContext.run({ signal: options.signal }, () =>
      this.completeIdentityProofAttemptInternal(input)
    )
  }

  private async completeIdentityProofAttemptInternal(input: {
    state: string
    code: string
    issuer?: string
  }): Promise<VerifiedOidcIdentityProof> {
    if (
      typeof input.state !== 'string' ||
      input.state.length < 32 ||
      input.state.length > 512 ||
      typeof input.code !== 'string' ||
      input.code.length === 0 ||
      input.code.length > 4096 ||
      (input.issuer !== undefined &&
        (typeof input.issuer !== 'string' || input.issuer.length > 2048))
    ) {
      throw new OidcProviderIncompatibleError('OIDC authorization response is malformed')
    }
    this.assertCurrentGeneration()
    const trusted = await this.getTrustedConfiguration()
    const hasIssuerBinding = trusted.profile.authorizationResponseIssuerParameterSupported
    if (hasIssuerBinding && input.issuer !== this.provider.issuer) {
      throw new OidcProviderIncompatibleError(
        'OIDC authorization response issuer binding is invalid'
      )
    }
    if (!hasIssuerBinding && input.issuer !== undefined && input.issuer !== this.provider.issuer) {
      throw new OidcProviderIncompatibleError(
        'OIDC authorization response issuer binding is invalid'
      )
    }

    const claimed = await claimOidcProtocolAttempt(
      this.dependencies.db,
      this.dependencies.encryptionKeyHex,
      input.state,
      this.binding(trusted.profile)
    )
    if (!claimed)
      throw new OidcProviderIncompatibleError(
        'OIDC authorization attempt is expired or already used'
      )

    try {
      const callback = new URL(this.provider.redirectUri)
      callback.searchParams.set('code', input.code)
      callback.searchParams.set('state', input.state)
      if (input.issuer !== undefined) callback.searchParams.set('iss', input.issuer)

      const tokenResponse = await authorizationCodeGrant(trusted.client, callback, {
        expectedState: input.state,
        expectedNonce: claimed.nonce,
        pkceCodeVerifier: claimed.pkceVerifier,
        idTokenExpected: true,
      })
      const claims = tokenResponse.claims() as Record<string, unknown> | undefined
      if (!claims)
        throw new OidcProviderIncompatibleError(
          'OIDC response did not contain a validated ID token'
        )
      const proof = this.createVerifiedProof(claims, claimed)
      const finalized = await finishOidcProtocolAttempt(
        this.dependencies.db,
        claimed.id,
        'completed'
      )
      if (!finalized) throw new Error('OIDC attempt completion was not persisted')
      return proof
    } catch (error) {
      await finishOidcProtocolAttempt(this.dependencies.db, claimed.id, 'failed')
      const transportFailure = this.operationContext.getStore()?.transportFailure
      if (
        error instanceof OidcProviderUnavailableError ||
        transportFailure?.kind === 'unavailable'
      ) {
        throw new OidcProviderUnavailableError()
      }
      if (error instanceof OidcProviderIncompatibleError) throw error
      if (transportFailure?.kind === 'incompatible') {
        throw transportFailure.error
      }
      throw new OidcProviderIncompatibleError('OIDC authorization response could not be verified')
    }
  }

  private createVerifiedProof(
    claims: Record<string, unknown>,
    attempt: ClaimedOidcProtocolAttempt
  ): VerifiedOidcIdentityProof {
    const subject = claims.sub
    const issuedAt = claims.iat
    const expiresAt = claims.exp
    const audience = claims.aud
    const authorizedParty = claims.azp
    const audienceValues =
      typeof audience === 'string' ? [audience] : Array.isArray(audience) ? audience : []
    const nowSeconds = Math.floor(this.now() / 1000)
    if (
      claims.iss !== this.provider.issuer ||
      typeof subject !== 'string' ||
      subject.length === 0 ||
      subject.length > 255 ||
      typeof issuedAt !== 'number' ||
      !Number.isInteger(issuedAt) ||
      issuedAt > nowSeconds + 60 ||
      typeof expiresAt !== 'number' ||
      !Number.isInteger(expiresAt) ||
      expiresAt <= nowSeconds ||
      audienceValues.length === 0 ||
      audienceValues.length > 10 ||
      audienceValues.some(value => typeof value !== 'string') ||
      !audienceValues.includes(this.provider.clientId) ||
      (authorizedParty !== undefined && authorizedParty !== this.provider.clientId) ||
      (audienceValues.length > 1 && authorizedParty !== this.provider.clientId) ||
      (claims.auth_time !== undefined &&
        (typeof claims.auth_time !== 'number' ||
          !Number.isInteger(claims.auth_time) ||
          claims.auth_time < 0 ||
          claims.auth_time > nowSeconds + 60))
    ) {
      throw new OidcProviderIncompatibleError(
        'OIDC ID token claims do not match the client registration'
      )
    }
    if (attempt.issuer !== this.provider.issuer || attempt.clientId !== this.provider.clientId) {
      throw new OidcProviderIncompatibleError('OIDC attempt registration binding is invalid')
    }

    const attributes = this.readValidatedAttributes(claims)
    const authenticationTime = typeof claims.auth_time === 'number' ? claims.auth_time : undefined
    const proof: VerifiedOidcIdentityProof = Object.freeze({
      purpose: PROOF_PURPOSE,
      issuer: this.provider.issuer,
      subject,
      registrationId: this.provider.registrationId,
      clientId: this.provider.clientId,
      configurationGeneration: this.provider.configurationGeneration,
      attemptId: attempt.id,
      issuedAt,
      ...(authenticationTime !== undefined ? { authenticationTime } : {}),
      attributes,
    })
    validProofs.add(proof)
    return proof
  }

  private readValidatedAttributes(claims: Record<string, unknown>): OidcVerifiedAttributes {
    const attributes: {
      source: 'validated_id_token'
      email?: string
      emailVerified?: boolean
      name?: string
      preferredUsername?: string
      locale?: string
    } = { source: 'validated_id_token' }
    if (typeof claims.email === 'string' && claims.email.length <= 320)
      attributes.email = claims.email
    if (typeof claims.email_verified === 'boolean') attributes.emailVerified = claims.email_verified
    if (typeof claims.name === 'string' && claims.name.length <= 256) attributes.name = claims.name
    if (typeof claims.preferred_username === 'string' && claims.preferred_username.length <= 320) {
      attributes.preferredUsername = claims.preferred_username
    }
    if (typeof claims.locale === 'string' && claims.locale.length <= 64)
      attributes.locale = claims.locale
    return Object.freeze(attributes)
  }

  private async getTrustedConfiguration(): Promise<TrustedConfiguration> {
    this.assertCurrentGeneration()
    const now = this.now()
    if (
      this.cachedConfiguration &&
      now - this.cachedConfiguration.validatedAt < DISCOVERY_CACHE_TTL_MS
    ) {
      return this.cachedConfiguration
    }
    const previous = this.cachedConfiguration
    const discovered = await this.discover(previous)
    this.cachedConfiguration = discovered
    return discovered
  }

  private async discover(previous?: TrustedConfiguration): Promise<TrustedConfiguration> {
    const transport = new TrustedOidcTransport(this.provider, {
      getOperationContext: () => this.operationContext.getStore(),
    })
    const clientSecret = this.dependencies.getClientSecret()
    const clientAuthentication =
      this.provider.clientAuthenticationMethod === 'client_secret_basic'
        ? ClientSecretBasic(clientSecret)
        : ClientSecretPost(clientSecret)
    let client: Configuration
    try {
      client = await discovery(
        new URL(this.provider.issuer),
        this.provider.clientId,
        {
          redirect_uris: [this.provider.redirectUri],
          token_endpoint_auth_method: this.provider.clientAuthenticationMethod,
          id_token_signed_response_alg: OIDC_ID_TOKEN_ALGORITHM,
        },
        clientAuthentication,
        {
          timeout: REQUEST_TIMEOUT_MS / 1000,
          [customFetch]: transport.fetch,
        }
      )
    } catch (error) {
      if (
        error instanceof OidcProviderIncompatibleError ||
        error instanceof OidcProviderUnavailableError
      ) {
        throw error
      }
      throw transport.operationFailure?.error ?? new OidcProviderIncompatibleError()
    }

    const metadata = client.serverMetadata() as OidcServerMetadata
    const profile = await transport.trustMetadata(metadata)
    if (previous) {
      const jwksCache = getJwksCache(previous.client)
      if (jwksCache) setJwksCache(client, jwksCache)
    }
    client.timeout = REQUEST_TIMEOUT_MS / 1000
    enableNonRepudiationChecks(client)
    return { client, transport, profile, validatedAt: this.now() }
  }

  private binding(profile: ValidatedOidcProviderProfile): OidcProtocolAttemptBinding {
    return {
      registrationId: this.provider.registrationId,
      configurationGeneration: this.provider.configurationGeneration,
      issuer: this.provider.issuer,
      clientId: this.provider.clientId,
      redirectUri: this.provider.redirectUri,
      responseMode: profile.responseMode,
    }
  }

  private assertCurrentGeneration(): void {
    let current: string
    try {
      current = currentOidcConfigurationGeneration(
        this.provider,
        this.dependencies.getClientSecret(),
        this.dependencies.encryptionKeyHex
      )
    } catch {
      throw new OidcProviderIncompatibleError('OIDC provider credential is unavailable')
    }
    if (current !== this.provider.configurationGeneration) {
      this.cachedConfiguration = undefined
      throw new OidcProviderIncompatibleError(
        'OIDC provider configuration changed; restart the protocol attempt'
      )
    }
  }

  private safeStatus(
    status: OidcProviderValidation['status'],
    reason?: OidcProviderValidation['reason']
  ): OidcProviderValidation {
    return Object.freeze({
      status,
      registrationId: this.provider.registrationId,
      displayLabel: this.provider.displayLabel,
      issuer: this.provider.issuer,
      configurationGeneration: this.provider.configurationGeneration,
      memberAuthenticationActivated: false,
      ...(reason ? { reason } : {}),
    })
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now()
  }
}

class TrustedOidcTransport {
  readonly fetch: CustomFetch
  private readonly allowedEndpoints = new Set<string>()
  private readonly discoveryUrl: string
  private profile?: ValidatedOidcProviderProfile

  constructor(
    private readonly provider: OidcProviderConfiguration,
    private readonly dependencies: { getOperationContext: () => OidcOperationContext | undefined }
  ) {
    this.discoveryUrl = oidcDiscoveryUrl(provider.issuer)
    this.allowedEndpoints.add(this.discoveryUrl)
    this.fetch = (url, options) => this.request(url, options)
  }

  get operationFailure(): OidcProviderOperationFailure | undefined {
    return this.dependencies.getOperationContext()?.transportFailure
  }

  private recordOperationFailure(
    error: OidcProviderIncompatibleError | OidcProviderUnavailableError
  ): OidcProviderOperationFailure {
    const failure: OidcProviderOperationFailure =
      error instanceof OidcProviderUnavailableError
        ? { kind: 'unavailable', error }
        : { kind: 'incompatible', error }
    const context = this.dependencies.getOperationContext()
    if (context) context.transportFailure = failure
    return failure
  }

  async trustMetadata(metadata: OidcServerMetadata): Promise<ValidatedOidcProviderProfile> {
    if (metadata.issuer !== this.provider.issuer) {
      throw new OidcProviderIncompatibleError(
        'OIDC discovery issuer does not exactly match configuration'
      )
    }
    const authorizationEndpoint = requireString(
      metadata.authorization_endpoint,
      'authorization endpoint'
    )
    const tokenEndpoint = requireString(metadata.token_endpoint, 'token endpoint')
    const jwksUri = requireString(metadata.jwks_uri, 'JWKS endpoint')
    const endpoints = {
      issuer: this.provider.issuer,
      authorization: authorizationEndpoint,
      token: tokenEndpoint,
    }
    const sameSite = checkAsEndpointsSameSite(endpoints)
    if (!sameSite.ok || registrableSite(jwksUri) !== registrableSite(this.provider.issuer)) {
      throw new OidcProviderIncompatibleError(
        'OIDC endpoints do not share the configured issuer site'
      )
    }
    const endpointCandidates = [
      [authorizationEndpoint, 'authorization endpoint'],
      [tokenEndpoint, 'token endpoint'],
      [jwksUri, 'JWKS endpoint'],
    ] as const
    for (const [url, field] of endpointCandidates) {
      validateMetadataEndpoint(url, field)
      const resolved = await resolveEndpointWithDeadline(
        url,
        `OIDC ${field}`,
        this.dependencies.getOperationContext()?.signal
      )
      if (!resolved.ok) {
        if (resolved.errors.some(isTransientDnsFailure)) {
          throw new OidcProviderUnavailableError()
        }
        throw new OidcProviderIncompatibleError('OIDC endpoint failed public-network validation')
      }
    }
    const trustedEndpoints: TrustedOidcProviderEndpoints = Object.freeze({
      issuer: this.provider.issuer,
      authorizationEndpoint: new URL(authorizationEndpoint).href,
      tokenEndpoint: new URL(tokenEndpoint).href,
      jwksEndpoint: new URL(jwksUri).href,
    })
    const profile = validateOidcProviderProfile(metadata, this.provider, trustedEndpoints)
    this.profile = profile
    for (const endpoint of [
      profile.authorizationEndpoint,
      profile.tokenEndpoint,
      profile.jwksEndpoint,
    ]) {
      this.allowedEndpoints.add(endpoint)
    }
    return profile
  }

  async fetchJwks(profile: ValidatedOidcProviderProfile): Promise<void> {
    if (profile !== this.profile)
      throw new OidcProviderIncompatibleError('OIDC JWKS endpoint is unavailable')
    await this.request(profile.jwksEndpoint, {
      body: undefined,
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'manual',
    })
  }

  private async request(url: string, options: Parameters<CustomFetch>[1]): Promise<Response> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw this.recordOperationFailure(
        new OidcProviderIncompatibleError('OIDC metadata contains an invalid endpoint')
      ).error
    }
    const normalized = parsed.href
    if (options.redirect !== 'manual' || !this.allowedEndpoints.has(normalized)) {
      throw this.recordOperationFailure(
        new OidcProviderIncompatibleError(
          'OIDC endpoint is outside the validated provider boundary'
        )
      ).error
    }
    const method = options.method.toUpperCase()
    if (method !== 'GET' && method !== 'POST') {
      throw this.recordOperationFailure(
        new OidcProviderIncompatibleError('OIDC endpoint request method is unsupported')
      ).error
    }
    const body = requestBody(options.body)
    const headers = Object.fromEntries(
      Object.entries(options.headers).map(([key, value]) => [key, value])
    )
    const result = await pinnedFetch(normalized, 'OIDC provider endpoint', {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBodyBytes: 1024 * 1024,
      signal: combineSignals(options.signal, this.dependencies.getOperationContext()?.signal),
    })
    if (!result.ok) {
      let error: OidcProviderIncompatibleError | OidcProviderUnavailableError
      if (result.error.kind === 'kernel_rejected') {
        error = new OidcProviderIncompatibleError('OIDC endpoint failed public-network validation')
      } else if (result.error.kind === 'transport_failed') {
        error = new OidcProviderUnavailableError()
      } else {
        error = new OidcProviderIncompatibleError('OIDC endpoint response encoding is unsupported')
      }
      throw this.recordOperationFailure(error).error
    }
    if (result.response.status >= 300 && result.response.status < 400) {
      throw this.recordOperationFailure(
        new OidcProviderIncompatibleError('OIDC endpoint redirects are not supported')
      ).error
    }
    if (result.response.status >= 500 || result.response.status === 429) {
      throw this.recordOperationFailure(new OidcProviderUnavailableError()).error
    }
    if (result.response.status < 200 || result.response.status >= 300) {
      throw this.recordOperationFailure(
        new OidcProviderIncompatibleError('OIDC endpoint rejected the supported protocol request')
      ).error
    }
    if (result.response.status !== 200) {
      throw this.recordOperationFailure(
        new OidcProviderIncompatibleError('OIDC endpoint returned an unsupported success response')
      ).error
    }
    if (normalized === this.discoveryUrl) {
      try {
        const parsedMetadata = JSON.parse(result.response.bodyText) as unknown
        if (!isRecord(parsedMetadata) || typeof parsedMetadata.issuer !== 'string') {
          throw new Error('invalid metadata shape')
        }
      } catch {
        throw this.recordOperationFailure(
          new OidcProviderIncompatibleError('OIDC discovery response is malformed')
        ).error
      }
    }
    const profile = this.profile
    if (profile && normalized === profile.jwksEndpoint) {
      validateJwks(result.response.bodyText, profile)
    }
    return new Response(result.response.bodyText, {
      status: result.response.status,
      headers: toWebHeaders(result.response.headers),
    })
  }
}

function oidcDiscoveryUrl(issuer: string): string {
  const url = new URL(issuer)
  url.pathname = `${url.pathname}/.well-known/openid-configuration`.replace(/\/{2,}/g, '/')
  return url.href
}

async function resolveEndpointWithDeadline(
  url: string,
  field: string,
  operationSignal: AbortSignal | undefined
): Promise<Awaited<ReturnType<typeof resolveValidatedOAuthEndpoint>>> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const signal = combineSignals(operationSignal, timeout)
  let abortListener: (() => void) | undefined
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(signal?.reason ?? new Error('request aborted'))
      if (signal?.aborted) abortListener()
      else signal?.addEventListener('abort', abortListener, { once: true })
    })
    return await Promise.race([resolveValidatedOAuthEndpoint(url, field), aborted])
  } catch {
    throw new OidcProviderUnavailableError()
  } finally {
    if (signal && abortListener) signal.removeEventListener('abort', abortListener)
  }
}

function combineSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined
): AbortSignal | undefined {
  if (first && second) return AbortSignal.any([first, second])
  return first ?? second
}

function validateMetadataEndpoint(value: string, field: string): void {
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
    throw new OidcProviderIncompatibleError(`OIDC ${field} is not a public HTTPS endpoint`)
  }
}

function requireString(value: unknown, field: string): string {
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

function validateOidcProviderProfile(
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

function isTransientDnsFailure(error: { message: string }): boolean {
  return /\b(?:EAI_AGAIN|ETIMEDOUT|ESERVFAIL|SERVFAIL)\b/i.test(error.message)
}

function requestBody(value: FetchBody): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return value
  if (value instanceof URLSearchParams) return value.toString()
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8')
  if (ArrayBuffer.isView(value))
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8')
  throw new OidcProviderIncompatibleError('OIDC request body type is unsupported')
}

function toWebHeaders(headers: Record<string, string | string[] | undefined>): Headers {
  const result = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') result.set(name, value)
    else if (Array.isArray(value)) result.set(name, value.join(', '))
  }
  return result
}

function validateJwks(body: string, profile: ValidatedOidcProviderProfile): void {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
