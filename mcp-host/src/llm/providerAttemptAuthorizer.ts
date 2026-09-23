import {
  LIMITS,
  parseAuthorizeAttemptResponse,
  requestBodyLimitBytes,
} from '@clerum/llm-provider-attempt-contract'

export const AUTHORIZE_PATH = '/api/v1/mcp-host/llm/provider-attempts/authorize'

/**
 * Room for the authorize envelope around the contract-capped `request`: ids,
 * revisions, hashes and recipe names, a few hundred bytes in practice. It
 * equals control-api's `AUTHORIZE_ENVELOPE_ALLOWANCE_BYTES`
 * (`llmProviderAttemptAuthorizer.ts`), so a request control-api would accept
 * is never refused here for its envelope (#739).
 */
export const AUTHORIZE_ENVELOPE_ALLOWANCE_BYTES = 16 * 1024

export class CodexAuthorizeError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'CodexAuthorizeError'
  }
}

export type AuthorizeAttemptBody = {
  request: unknown
  invocationId: string
  attemptGeneration: number
  providerAttemptIndex: number
  policyRevision: number
  policyHash: string
  requestHash?: string
  hostRef?: string
  recipeNamespace?: string
  recipeName?: string
  userId?: string
  budgetReservationId?: string
  pluginWorkloadSdkProviderAttemptId?: string
  targetRef?: string
}

export type ProviderAttemptAuthorizerOptions = {
  authorizeUrl: string
  readPlatformJwt: () => string
  refreshOnUnauthorized?: () => Promise<void>
  fetchFn?: typeof fetch
}

const LEAK_KEYS = ['accessToken', 'refreshToken', 'authorization']

export class ProviderAttemptAuthorizer {
  constructor(private readonly options: ProviderAttemptAuthorizerOptions) {
    if (
      !options.authorizeUrl.startsWith('http://') &&
      !options.authorizeUrl.startsWith('https://')
    ) {
      throw new Error('[CodexAuthorize] authorize URL must be an absolute server-owned URL')
    }
  }

  /**
   * The caller's `signal` is the only clock on this hop. Authorize deliberately
   * has no timeout of its own: the bridge already bounds the whole attempt, and
   * a second independent deadline would make two different answers possible for
   * "did this attempt still have time?".
   */
  async authorize(
    body: AuthorizeAttemptBody,
    options?: { signal?: AbortSignal }
  ): Promise<{
    providerAttemptId: string
    requestHash: string
    executionTicket: string
    expiresAt: string
  }> {
    return this.authorizeOnce(body, Boolean(this.options.refreshOnUnauthorized), options?.signal)
  }

  private async authorizeOnce(
    body: AuthorizeAttemptBody,
    retryOnUnauthorized: boolean,
    signal?: AbortSignal
  ): Promise<{
    providerAttemptId: string
    requestHash: string
    executionTicket: string
    expiresAt: string
  }> {
    const serialized = JSON.stringify(body)
    const requestLimit = requestBodyLimitBytes(body.request)
    // The larger of the two budgets wins, as in control-api's authorizer: the
    // non-image cap plus the envelope allowance, or the V2 visual envelope.
    const bodyLimit = Math.max(
      requestLimit,
      LIMITS.maxRequestBodyBytes + AUTHORIZE_ENVELOPE_ALLOWANCE_BYTES
    )
    if (Buffer.byteLength(serialized, 'utf8') > bodyLimit) {
      throw new CodexAuthorizeError(
        'payload_too_large',
        `Codex request exceeds ${requestLimit / (1024 * 1024)} MiB; use fewer or smaller images, or reduce context`
      )
    }
    const jwt = this.options.readPlatformJwt()
    if (!jwt) {
      throw new CodexAuthorizeError('no_grant', 'platform JWT is missing')
    }
    const fetchFn = this.options.fetchFn ?? fetch
    const response = await fetchFn(this.options.authorizeUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
      },
      body: serialized,
      ...(signal ? { signal } : {}),
    })
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (!response.ok) {
      if (response.status === 401 && retryOnUnauthorized && this.options.refreshOnUnauthorized) {
        await this.options.refreshOnUnauthorized()
        return this.authorizeOnce(body, false, signal)
      }
      // Every 413 is a size refusal of this request, never a provider outage
      // (#731): control-api answers `payload_too_large`, and the gateway in
      // front of it (nginx `client_max_body_size`) answers with no JSON code.
      const code =
        response.status === 413
          ? 'payload_too_large'
          : typeof payload.error === 'string'
            ? payload.error
            : 'provider_unavailable'
      throw new CodexAuthorizeError(
        code,
        code === 'payload_too_large'
          ? 'Codex request is too large; use fewer or smaller images, or reduce context'
          : `authorize failed with ${response.status}`
      )
    }
    for (const key of LEAK_KEYS) {
      if (key in payload) {
        throw new CodexAuthorizeError(
          'invalid_request',
          'authorize response leaked credential material'
        )
      }
    }
    const parsed = parseAuthorizeAttemptResponse(payload)
    if (!parsed.ok) {
      throw new CodexAuthorizeError('invalid_request', parsed.message)
    }
    return parsed.value
  }
}

export function resolveCodexAuthorizeUrl(gatewayBase: string): string {
  const trimmed = gatewayBase.replace(/\/+$/, '')
  return `${trimmed}${AUTHORIZE_PATH}`
}
