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
  cancelOidcProtocolAttempt,
  claimOidcProtocolAttempt,
  finishOidcProtocolAttempt,
  insertOidcProtocolAttempt,
  preflightOidcProtocolAttempt,
} from './protocolAttemptStore.js'
import {
  OidcAttemptRejectedError,
  OidcCallerCancelledError,
  OidcCredentialConfigurationError,
  type OidcOperationContext,
  OidcPersistenceFailure,
  type OidcProtocolOutcome,
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
  /** Server-owned claim names needed by the later eligibility-policy owner. */
  policyEvidenceClaimNames?: readonly string[]
  now?: () => number
}>

type TrustedConfiguration = Readonly<{
  client: Configuration
  transport: TrustedOidcTransport
  profile: ValidatedOidcProviderProfile
  validatedAt: number
}>

function safePrimaryOutcome(
  error: unknown,
  transportFailure: OidcOperationContext['transportFailure']
): OidcProtocolOutcome {
  if (error instanceof OidcCallerCancelledError) return error.category
  if (error instanceof OidcProviderUnavailableError || transportFailure?.kind === 'unavailable') {
    return 'provider-unavailable'
  }
  if (error instanceof OidcProviderIncompatibleError) return error.category
  if (error instanceof OidcPersistenceFailure) return error.category
  if (transportFailure?.kind === 'incompatible') return 'provider-incompatible'
  return 'attempt-rejected'
}

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

export interface OidcVerifiedClaimObject {
  readonly [key: string]: OidcVerifiedClaimValue
}

export type OidcVerifiedClaimValue =
  | string
  | number
  | boolean
  | null
  | readonly OidcVerifiedClaimValue[]
  | OidcVerifiedClaimObject
export type OidcVerifiedClaimObservation =
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'unsupported' }>
  | Readonly<{ status: 'present'; value: OidcVerifiedClaimValue }>
export type OidcVerifiedClaimEvidence = Readonly<{
  source: 'validated_id_token'
  claims: Readonly<Record<string, OidcVerifiedClaimObservation>>
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
  verifiedClaims: OidcVerifiedClaimEvidence
}>

const validProofs = new WeakSet<object>()
const MAX_VERIFIED_CLAIMS = 64
const MAX_VERIFIED_CLAIMS_BYTES = 16_384
const MAX_VERIFIED_CLAIM_NAME_LENGTH = 128
const MAX_VERIFIED_CLAIM_STRING_LENGTH = 512
const MAX_VERIFIED_CLAIM_ARRAY_LENGTH = 32
const MAX_VERIFIED_CLAIM_OBJECT_KEYS = 32
const MAX_VERIFIED_CLAIM_DEPTH = 8
const MAX_VERIFIED_CLAIM_NODES = 256
const MAX_VERIFIED_CLAIM_VALUE_BYTES = 4096
const BASE_VERIFIED_CLAIM_NAMES = ['email', 'email_verified'] as const
const OIDC_PROTOCOL_CLAIMS = new Set([
  'iss',
  'sub',
  'aud',
  'exp',
  'iat',
  'nbf',
  'jti',
  'nonce',
  'azp',
  'auth_time',
  'at_hash',
  'c_hash',
  's_hash',
  'sid',
])

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
  private readonly policyEvidenceClaimNames: readonly string[]

  constructor(
    private readonly provider: OidcProviderConfiguration,
    private readonly dependencies: OidcProtocolDependencies
  ) {
    this.policyEvidenceClaimNames = this.validatePolicyEvidenceClaimNames(
      dependencies.policyEvidenceClaimNames ?? []
    )
  }

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

  async beginIdentityProofAttempt(options: {
    browserBinding: string
    signal?: AbortSignal
  }): Promise<{ authorizationUrl: string; expiresAt: Date }> {
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
            browserBinding: options.browserBinding,
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
      browserBinding?: string
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
    browserBinding?: string
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

    let preflightPassed: boolean
    try {
      preflightPassed = await preflightOidcProtocolAttempt(
        this.dependencies.db,
        input.state,
        input.browserBinding ?? '',
        this.configuredBinding()
      )
    } catch {
      throw new OidcPersistenceFailure('preflight')
    }
    if (!preflightPassed) {
      throw new OidcAttemptRejectedError(
        'expired-or-replayed',
        'OIDC authorization attempt is expired or already used'
      )
    }

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
        input.browserBinding ?? '',
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
      let finalized: boolean
      try {
        finalized = await finishOidcProtocolAttempt(this.dependencies.db, claimed.id, 'completed')
      } catch {
        throw new OidcPersistenceFailure('finalize')
      }
      if (!finalized) throw new OidcPersistenceFailure('finalize')
      return proof
    } catch (error) {
      const transportFailure = this.operationContext.getStore()?.transportFailure
      try {
        const failed = await finishOidcProtocolAttempt(this.dependencies.db, claimed.id, 'failed')
        if (!failed) throw new Error('OIDC attempt failure was not persisted')
      } catch {
        throw new OidcPersistenceFailure(
          'finalize',
          safePrimaryOutcome(error, transportFailure),
          error instanceof OidcPersistenceFailure ? error.operation : undefined
        )
      }
      if (error instanceof OidcPersistenceFailure) throw error
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

  async cancelIdentityProofAttempt(input: {
    state: string
    browserBinding: string
  }): Promise<boolean> {
    if (
      typeof input.state !== 'string' ||
      input.state.length < 32 ||
      input.state.length > 512 ||
      typeof input.browserBinding !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.browserBinding)
    ) {
      return false
    }
    this.assertCurrentGeneration()
    try {
      return await cancelOidcProtocolAttempt(
        this.dependencies.db,
        input.state,
        input.browserBinding,
        this.configuredBinding()
      )
    } catch {
      throw new OidcPersistenceFailure('finalize')
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
    const verifiedClaims = this.readVerifiedClaims(claims)
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
      verifiedClaims,
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

  private readVerifiedClaims(claims: Record<string, unknown>): OidcVerifiedClaimEvidence {
    const projected: Record<string, OidcVerifiedClaimObservation> = Object.create(null)
    let projectedBytes = 0

    for (const name of this.policyEvidenceClaimNames) {
      let observation: OidcVerifiedClaimObservation
      if (!Object.hasOwn(claims, name)) {
        observation = Object.freeze({ status: 'missing' })
      } else {
        const projectedValue = this.projectVerifiedClaimValue(claims[name])
        observation =
          projectedValue === undefined
            ? Object.freeze({ status: 'unsupported' })
            : Object.freeze({ status: 'present', value: projectedValue })
      }

      const encoded = JSON.stringify(observation)
      const entryBytes = Buffer.byteLength(name) + Buffer.byteLength(encoded) + 4
      if (
        projectedBytes + entryBytes > MAX_VERIFIED_CLAIMS_BYTES ||
        entryBytes > MAX_VERIFIED_CLAIM_VALUE_BYTES
      ) {
        observation = Object.freeze({ status: 'unsupported' })
      } else {
        projectedBytes += entryBytes
      }
      projected[name] = observation
    }

    return Object.freeze({
      source: 'validated_id_token',
      claims: Object.freeze(projected),
    })
  }

  private validatePolicyEvidenceClaimNames(names: readonly string[]): readonly string[] {
    if (!Array.isArray(names)) {
      throw new TypeError('OIDC policy-evidence claim selection is invalid')
    }
    const selectedNames = [...BASE_VERIFIED_CLAIM_NAMES, ...names]
    if (
      selectedNames.length > MAX_VERIFIED_CLAIMS ||
      names.some(
        name =>
          typeof name !== 'string' ||
          name.length === 0 ||
          name.length > MAX_VERIFIED_CLAIM_NAME_LENGTH ||
          /[\u0000-\u001f\u007f]/.test(name) ||
          OIDC_PROTOCOL_CLAIMS.has(name)
      ) ||
      new Set(names).size !== names.length
    ) {
      throw new TypeError('OIDC policy-evidence claim selection is invalid')
    }
    return Object.freeze([...new Set(selectedNames)].sort())
  }

  private projectVerifiedClaimValue(value: unknown): OidcVerifiedClaimValue | undefined {
    let nodes = 0
    const project = (candidate: unknown, depth: number): OidcVerifiedClaimValue | undefined => {
      nodes += 1
      if (nodes > MAX_VERIFIED_CLAIM_NODES || depth > MAX_VERIFIED_CLAIM_DEPTH) return undefined
      if (candidate === null) return null
      if (typeof candidate === 'string') {
        return candidate.length <= MAX_VERIFIED_CLAIM_STRING_LENGTH ? candidate : undefined
      }
      if (typeof candidate === 'boolean') return candidate
      if (typeof candidate === 'number') return Number.isFinite(candidate) ? candidate : undefined
      if (Array.isArray(candidate)) {
        if (candidate.length > MAX_VERIFIED_CLAIM_ARRAY_LENGTH) return undefined
        const projected: OidcVerifiedClaimValue[] = []
        for (const entry of candidate) {
          const item = project(entry, depth + 1)
          if (item === undefined) return undefined
          projected.push(item)
        }
        return Object.freeze(projected)
      }
      if (typeof candidate !== 'object') return undefined

      const prototype = Object.getPrototypeOf(candidate)
      if (prototype !== Object.prototype && prototype !== null) return undefined
      const entries = Object.entries(candidate)
      if (entries.length > MAX_VERIFIED_CLAIM_OBJECT_KEYS) return undefined
      const projected: Record<string, OidcVerifiedClaimValue> = Object.create(null)
      for (const [key, entry] of entries.sort(([left], [right]) => left.localeCompare(right))) {
        if (
          key.length === 0 ||
          key.length > MAX_VERIFIED_CLAIM_NAME_LENGTH ||
          /[\u0000-\u001f\u007f]/.test(key)
        ) {
          return undefined
        }
        const item = project(entry, depth + 1)
        if (item === undefined) return undefined
        projected[key] = item
      }
      return Object.freeze(projected)
    }

    const projected = project(value, 0)
    if (
      projected === undefined ||
      Buffer.byteLength(JSON.stringify(projected)) > MAX_VERIFIED_CLAIM_VALUE_BYTES
    ) {
      return undefined
    }
    return projected
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

  private configuredBinding(): OidcProtocolAttemptBinding {
    return {
      registrationId: this.provider.registrationId,
      configurationGeneration: this.provider.configurationGeneration,
      issuer: this.provider.issuer,
      clientId: this.provider.clientId,
      redirectUri: this.provider.redirectUri,
      responseMode: this.provider.responseMode,
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
