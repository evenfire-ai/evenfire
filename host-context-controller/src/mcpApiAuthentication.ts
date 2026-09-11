import jwt from 'jsonwebtoken'
import { createPublicKey } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

export const HCC_MCP_AUDIENCE = 'host-context-controller'
export const WORKFLOW_APPROVAL_AUDIENCE = 'workflow-approvals'
export const MCP_CREDENTIAL_READ_CAPABILITY = 'mcp:credential:read'

const HOST_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

export interface VerifiedMcpHostPrincipal {
  subject: string
  hostName: string
  hostUid: string
  namespace: string
  jti: string
  issuedAt: number
  expiresAt: number
  audiences: readonly string[]
}

export class McpApiAuthenticationError extends Error {
  readonly code = 'unauthorized'

  constructor() {
    super('unauthorized')
    this.name = 'McpApiAuthenticationError'
  }
}

export class McpApiVerifierConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpApiVerifierConfigurationError'
  }
}

export interface McpApiAuthenticatorOptions {
  publicKey: string
  issuer: string
  hostNamespace: string
  clockToleranceSeconds?: number
  maxTokenLifetimeSeconds?: number
}

function exactAudiences(value: unknown): string[] | null {
  const audiences = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null
  if (
    !audiences ||
    audiences.length === 0 ||
    audiences.some(item => typeof item !== 'string') ||
    new Set(audiences).size !== audiences.length
  ) {
    return null
  }
  const values = new Set(audiences as string[])
  const hccOnly = values.size === 1 && values.has(HCC_MCP_AUDIENCE)
  const migrationPair =
    values.size === 2 && values.has(HCC_MCP_AUDIENCE) && values.has(WORKFLOW_APPROVAL_AUDIENCE)
  return hccOnly || migrationPair ? (audiences as string[]) : null
}

function canonicalHostUid(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized || normalized !== value || normalized.length > 128) return null
  return /[^A-Za-z0-9._:-]/.test(normalized) ? null : normalized
}

function bearerFromHeaders(headers: IncomingHttpHeaders, rawHeaders: readonly string[]): string {
  let authorizationCount = 0
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === 'authorization') authorizationCount += 1
  }
  if (authorizationCount > 1 || Array.isArray(headers.authorization)) {
    throw new McpApiAuthenticationError()
  }
  const header = headers.authorization
  if (typeof header !== 'string') throw new McpApiAuthenticationError()
  const match = /^Bearer ([^\s,]+)$/.exec(header)
  if (!match) throw new McpApiAuthenticationError()
  return match[1]
}

export class McpApiAuthenticator {
  private readonly publicKey: string
  private readonly issuer: string
  private readonly hostNamespace: string
  private readonly clockToleranceSeconds: number
  private readonly maxTokenLifetimeSeconds: number

  constructor(options: McpApiAuthenticatorOptions) {
    const key = options.publicKey.trim()
    if (!key) throw new McpApiVerifierConfigurationError('HCC MCP JWT public key is required')
    if (/placeholder|replace[-_ ]?me|your[-_ ]?key/i.test(key)) {
      throw new McpApiVerifierConfigurationError('HCC MCP JWT public key contains a placeholder')
    }
    if (/PRIVATE KEY/.test(key)) {
      throw new McpApiVerifierConfigurationError('HCC MCP JWT verifier requires a public key')
    }
    try {
      const publicKey = createPublicKey(key)
      if (
        publicKey.asymmetricKeyType !== 'rsa' ||
        (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      ) {
        throw new Error('unsupported RSA key')
      }
    } catch {
      throw new McpApiVerifierConfigurationError('HCC MCP JWT public key is malformed')
    }
    if (!options.issuer.trim()) {
      throw new McpApiVerifierConfigurationError('HCC MCP JWT issuer is required')
    }
    if (!options.hostNamespace.trim()) {
      throw new McpApiVerifierConfigurationError('HCC Host namespace is required')
    }
    this.publicKey = key
    this.issuer = options.issuer.trim()
    this.hostNamespace = options.hostNamespace.trim()
    this.clockToleranceSeconds = options.clockToleranceSeconds ?? 5
    this.maxTokenLifetimeSeconds = options.maxTokenLifetimeSeconds ?? 600
    if (!Number.isSafeInteger(this.maxTokenLifetimeSeconds) || this.maxTokenLifetimeSeconds <= 0) {
      throw new McpApiVerifierConfigurationError('HCC MCP JWT maximum lifetime is invalid')
    }
  }

  authenticate(
    headers: IncomingHttpHeaders,
    rawHeaders: readonly string[] = []
  ): VerifiedMcpHostPrincipal {
    const token = bearerFromHeaders(headers, rawHeaders)
    let payload: jwt.JwtPayload
    try {
      const verified = jwt.verify(token, this.publicKey, {
        algorithms: ['RS256'],
        issuer: this.issuer,
        clockTolerance: this.clockToleranceSeconds,
      })
      if (typeof verified === 'string') throw new McpApiAuthenticationError()
      payload = verified
    } catch {
      throw new McpApiAuthenticationError()
    }

    const audiences = exactAudiences(payload.aud)
    const hostRefs = payload.hostRefs
    const capabilities = payload.mcpCapabilities
    const hostUid = canonicalHostUid(payload.host_uid)
    const now = Math.floor(Date.now() / 1000)
    if (
      !audiences ||
      payload.scope !== 'workflow:approval:request' ||
      payload.recipeNamespace !== this.hostNamespace ||
      payload.recipeName !== 'standalone' ||
      payload.sub !== `${this.hostNamespace}/standalone` ||
      !Array.isArray(hostRefs) ||
      hostRefs.length !== 1 ||
      typeof hostRefs[0] !== 'string' ||
      hostRefs[0].length > 63 ||
      !HOST_NAME_RE.test(hostRefs[0]) ||
      !hostUid ||
      !Array.isArray(capabilities) ||
      capabilities.length !== 1 ||
      capabilities[0] !== MCP_CREDENTIAL_READ_CAPABILITY ||
      typeof payload.jti !== 'string' ||
      !payload.jti.trim() ||
      payload.jti.trim() !== payload.jti ||
      payload.jti.length > 128 ||
      /[^A-Za-z0-9._:-]/.test(payload.jti) ||
      !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp) ||
      (payload.iat as number) > now + this.clockToleranceSeconds ||
      (payload.exp as number) <= (payload.iat as number) ||
      (payload.exp as number) - (payload.iat as number) > this.maxTokenLifetimeSeconds
    ) {
      throw new McpApiAuthenticationError()
    }

    return {
      subject: payload.sub,
      hostName: hostRefs[0],
      hostUid,
      namespace: payload.recipeNamespace,
      jti: payload.jti,
      issuedAt: payload.iat as number,
      expiresAt: payload.exp as number,
      audiences,
    }
  }
}
