import { AsyncLocalStorage } from 'node:async_hooks'
import {
  ClientSecretBasic,
  ClientSecretPost,
  type Configuration,
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
import {
  OidcAttemptRejectedError,
  OidcCallerCancelledError,
  OidcCredentialConfigurationError,
  type OidcOperationContext,
  OidcPersistenceFailure,
  OidcProviderIncompatibleError,
  OidcProviderUnavailableError,
  type OidcProviderValidationReason,
} from './protocolResult.js'
import { OIDC_REQUEST_TIMEOUT_MS, TrustedOidcTransport } from './protocolTransport.js'
import {
  OIDC_ID_TOKEN_ALGORITHM,
  type OidcServerMetadata,
  type ValidatedOidcProviderProfile,
} from './providerProfile.js'

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

const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000
const PROOF_PURPOSE = 'oidc-identity-proof-v1' as const

export type OidcProviderValidation = Readonly<{
  status: 'metadata-and-jwks-valid' | 'unavailable' | 'incompatible'
  registrationId: string
  displayLabel: string
  issuer: string
  configurationGeneration: string
  memberAuthenticationActivated: false
  reason?: OidcProviderValidationReason
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
    throw new OidcAttemptRejectedError('malformed-callback', 'OIDC callback URL is malformed')
  }
  if (
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname ||
    callback.hash !== '' ||
    callback.username !== '' ||
    callback.password !== ''
  ) {
    throw new OidcAttemptRejectedError(
      'malformed-callback',
      'OIDC callback URL does not match the registered redirect URI'
    )
  }
  for (const name of ['state', 'code', 'iss', 'error', 'error_description']) {
    if (callback.searchParams.getAll(name).length > 1) {
      throw new OidcAttemptRejectedError(
        'malformed-callback',
        'OIDC callback contains duplicate protocol parameters'
      )
    }
  }
  if (callback.searchParams.has('error') || callback.searchParams.has('error_description')) {
    throw new OidcAttemptRejectedError(
      'provider-response',
      'OIDC authorization was denied or could not be completed'
    )
  }
  const state = callback.searchParams.get('state')
  const code = callback.searchParams.get('code')
  const issuer = callback.searchParams.get('iss') ?? undefined
  if (!state || !code) {
    throw new OidcAttemptRejectedError(
      'malformed-callback',
      'OIDC callback is missing its state or authorization code'
    )
  }
  return { state, code, ...(issuer !== undefined ? { issuer } : {}) }
}

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
        if (options.signal?.aborted) throw new OidcCallerCancelledError()
        if (error instanceof OidcProviderIncompatibleError) {
          return this.safeStatus('incompatible', error.reason)
        }
        if (error instanceof OidcCallerCancelledError) throw error
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
      let attempt: Awaited<ReturnType<typeof insertOidcProtocolAttempt>>
      try {
        attempt = await insertOidcProtocolAttempt(
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
      } catch {
        throw new OidcPersistenceFailure('insert')
      }

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
    return this.operationContext.run({ signal: options.signal }, async () => {
      try {
        return await this.completeIdentityProofAttemptInternal(input)
      } catch (error) {
        if (options.signal?.aborted && !(error instanceof OidcPersistenceFailure)) {
          throw new OidcCallerCancelledError()
        }
        throw error
      }
    })
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
      throw new OidcAttemptRejectedError(
        'malformed-callback',
        'OIDC authorization response is malformed'
      )
    }
    this.assertCurrentGeneration()
    const trusted = await this.getTrustedConfiguration()
    const hasIssuerBinding = trusted.profile.authorizationResponseIssuerParameterSupported
    if (hasIssuerBinding && input.issuer !== this.provider.issuer) {
      throw new OidcAttemptRejectedError(
        'issuer-binding',
        'OIDC authorization response issuer binding is invalid'
      )
    }
    if (!hasIssuerBinding && input.issuer !== undefined && input.issuer !== this.provider.issuer) {
      throw new OidcAttemptRejectedError(
        'issuer-binding',
        'OIDC authorization response issuer binding is invalid'
      )
    }

    let claimed: Awaited<ReturnType<typeof claimOidcProtocolAttempt>>
    try {
      claimed = await claimOidcProtocolAttempt(
        this.dependencies.db,
        this.dependencies.encryptionKeyHex,
        input.state,
        this.binding(trusted.profile)
      )
    } catch {
      throw new OidcPersistenceFailure('claim')
    }
    if (!claimed)
      throw new OidcAttemptRejectedError(
        'expired-or-replayed',
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
        throw new OidcAttemptRejectedError(
          'verified-token',
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
      if (error instanceof OidcCallerCancelledError) throw error
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
      throw new OidcAttemptRejectedError(
        'provider-response',
        'OIDC authorization response could not be verified'
      )
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
      throw new OidcAttemptRejectedError(
        'verified-token',
        'OIDC ID token claims do not match the client registration'
      )
    }
    if (attempt.issuer !== this.provider.issuer || attempt.clientId !== this.provider.clientId) {
      throw new OidcAttemptRejectedError(
        'issuer-binding',
        'OIDC attempt registration binding is invalid'
      )
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
          timeout: OIDC_REQUEST_TIMEOUT_MS / 1000,
          [customFetch]: transport.fetch,
        }
      )
    } catch (error) {
      if (
        error instanceof OidcProviderIncompatibleError ||
        error instanceof OidcProviderUnavailableError ||
        error instanceof OidcCallerCancelledError
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
    client.timeout = OIDC_REQUEST_TIMEOUT_MS / 1000
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
      throw new OidcCredentialConfigurationError()
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
