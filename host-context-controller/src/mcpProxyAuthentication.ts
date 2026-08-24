import type { IncomingHttpHeaders } from 'node:http'
import type { VerifiedMcpHostPrincipal } from './mcpApiAuthentication'

export const MCP_PROXY_TOKEN_REVIEW_AUDIENCE = 'host-context-controller'
export const MCP_PROXY_TOKEN_REVIEW_EXPIRATION_SECONDS = 600

type McpProxyAuthenticationCode = 'unauthorized' | 'unavailable'

export class McpProxyAuthenticationError extends Error {
  constructor(readonly code: McpProxyAuthenticationCode) {
    super(code)
    this.name = 'McpProxyAuthenticationError'
  }
}

export interface TokenReviewRequest {
  token: string
  audiences: readonly string[]
  expirationSeconds: number
}

export interface TokenReviewResponse {
  status?: {
    authenticated?: boolean
    user?: {
      username?: string
      uid?: string
    }
    audiences?: string[]
  }
}

export interface TokenReviewClient {
  review(request: TokenReviewRequest): Promise<TokenReviewResponse>
}

export interface HostBearerVerifier {
  authenticate(
    headers: IncomingHttpHeaders,
    rawHeaders: readonly string[]
  ): VerifiedMcpHostPrincipal
}

export interface McpProxyAuthenticatorOptions {
  tokenReviewClient: TokenReviewClient
  readServiceAccountUid: () => Promise<string | null>
  systemNamespace: string
  systemServiceAccountName: string
  hostVerifier: HostBearerVerifier
}

export interface VerifiedMcpProxySystemPrincipal {
  authType: 'system'
  subject: string
  uid: string
  audiences: readonly string[]
}

const BEARER_SCHEME = ['Be', 'arer'].join('')

function singleBearer(
  headers: IncomingHttpHeaders,
  rawHeaders: readonly string[],
  headerName: string
): string {
  let count = 0
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === headerName) count += 1
  }
  const value = headers[headerName]
  if (count > 1 || Array.isArray(value) || typeof value !== 'string') {
    throw new McpProxyAuthenticationError('unauthorized')
  }
  const match = new RegExp(`^${BEARER_SCHEME} ([^\\s,]+)$`).exec(value)
  if (!match) throw new McpProxyAuthenticationError('unauthorized')
  return match[1]
}

function exactAudience(audiences: unknown): boolean {
  return (
    Array.isArray(audiences) &&
    audiences.length === 1 &&
    audiences[0] === MCP_PROXY_TOKEN_REVIEW_AUDIENCE
  )
}

export class McpProxyAuthenticator {
  private readonly tokenReviewClient: TokenReviewClient
  private readonly readServiceAccountUid: () => Promise<string | null>
  private readonly expectedSubject: string
  private readonly hostVerifier: HostBearerVerifier

  constructor(options: McpProxyAuthenticatorOptions) {
    if (!options.systemNamespace.trim() || !options.systemServiceAccountName.trim()) {
      throw new Error('MCP proxy system identity is not configured')
    }
    this.tokenReviewClient = options.tokenReviewClient
    this.readServiceAccountUid = options.readServiceAccountUid
    this.expectedSubject = `system:serviceaccount:${options.systemNamespace}:${options.systemServiceAccountName}`
    this.hostVerifier = options.hostVerifier
  }

  async authenticateSystem(
    headers: IncomingHttpHeaders,
    rawHeaders: readonly string[] = []
  ): Promise<VerifiedMcpProxySystemPrincipal> {
    const token = singleBearer(headers, rawHeaders, 'authorization')
    let review: TokenReviewResponse
    try {
      review = await this.tokenReviewClient.review({
        token,
        audiences: [MCP_PROXY_TOKEN_REVIEW_AUDIENCE],
        expirationSeconds: MCP_PROXY_TOKEN_REVIEW_EXPIRATION_SECONDS,
      })
    } catch {
      throw new McpProxyAuthenticationError('unavailable')
    }

    const status = review.status
    if (
      !status?.authenticated ||
      !status.user ||
      status.user.username !== this.expectedSubject ||
      !status.user.uid ||
      !exactAudience(status.audiences)
    ) {
      throw new McpProxyAuthenticationError('unauthorized')
    }

    let currentUid: string | null
    try {
      currentUid = await this.readServiceAccountUid()
    } catch {
      throw new McpProxyAuthenticationError('unavailable')
    }
    if (!currentUid) throw new McpProxyAuthenticationError('unavailable')
    if (currentUid !== status.user.uid) {
      throw new McpProxyAuthenticationError('unauthorized')
    }
    const audiences = status.audiences ?? []

    return {
      authType: 'system',
      subject: status.user.username,
      uid: status.user.uid,
      audiences,
    }
  }

  authenticateHost(
    headers: IncomingHttpHeaders,
    rawHeaders: readonly string[] = []
  ): VerifiedMcpHostPrincipal {
    const token = singleBearer(headers, rawHeaders, 'x-clerum-host-authorization')
    return this.hostVerifier.authenticate(
      { authorization: `${BEARER_SCHEME} ${token}` },
      ['Authorization', `${BEARER_SCHEME} ${token}`]
    )
  }
}
