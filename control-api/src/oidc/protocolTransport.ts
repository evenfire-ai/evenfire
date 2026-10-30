import { type CustomFetch, type FetchBody } from 'openid-client'
import { pinnedFetch } from '../http/pinnedFetch.js'
import { resolveValidatedOAuthEndpoint } from '../http/validateMcpServerSpec.js'
import { checkAsEndpointsSameSite, registrableSite } from '../oauth/discovery.js'
import type { OidcProviderConfiguration } from './configuration.js'
import {
  OidcCallerCancelledError,
  type OidcOperationContext,
  OidcProviderIncompatibleError,
  type OidcProviderOperationFailure,
  OidcProviderUnavailableError,
} from './protocolResult.js'
import {
  type OidcServerMetadata,
  type TrustedOidcProviderEndpoints,
  type ValidatedOidcProviderProfile,
  isRecord,
  requireString,
  validateJwks,
  validateMetadataEndpoint,
  validateOidcProviderProfile,
} from './providerProfile.js'

export const OIDC_REQUEST_TIMEOUT_MS = 15_000

export class TrustedOidcTransport {
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
        if (resolved.classification === 'transient_dns') {
          throw new OidcProviderUnavailableError()
        }
        throw new OidcProviderIncompatibleError(
          'OIDC endpoint failed public-network validation',
          'untrusted-endpoint'
        )
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
    const operationSignal = this.dependencies.getOperationContext()?.signal
    let result: Awaited<ReturnType<typeof pinnedFetch>>
    try {
      result = await pinnedFetch(normalized, 'OIDC provider endpoint', {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        timeoutMs: OIDC_REQUEST_TIMEOUT_MS,
        maxBodyBytes: 1024 * 1024,
        signal: combineSignals(options.signal, operationSignal),
      })
    } catch (error) {
      if (operationSignal?.aborted) throw new OidcCallerCancelledError()
      throw error
    }
    if (!result.ok) {
      if (operationSignal?.aborted) throw new OidcCallerCancelledError()
      let error: OidcProviderIncompatibleError | OidcProviderUnavailableError
      if (result.error.kind === 'kernel_rejected') {
        error = new OidcProviderIncompatibleError(
          'OIDC endpoint failed public-network validation',
          'untrusted-endpoint'
        )
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
  const timeout = AbortSignal.timeout(OIDC_REQUEST_TIMEOUT_MS)
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
    if (operationSignal?.aborted) throw new OidcCallerCancelledError()
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
