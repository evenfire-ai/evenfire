import { parseAuthorizeAttemptResponse } from '@clerum/llm-provider-attempt-contract'

export const AUTHORIZE_PATH = '/api/v1/mcp-host/llm/provider-attempts/authorize'

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
}

export type ProviderAttemptAuthorizerOptions = {
  authorizeUrl: string
  readPlatformJwt: () => string
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

  async authorize(body: AuthorizeAttemptBody): Promise<{
    providerAttemptId: string
    requestHash: string
    executionTicket: string
    expiresAt: string
  }> {
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
      body: JSON.stringify(body),
    })
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (!response.ok) {
      const code = typeof payload.error === 'string' ? payload.error : 'provider_unavailable'
      throw new CodexAuthorizeError(code, `authorize failed with ${response.status}`)
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
