/**
 * Client for communicating with the Context Mapper service.
 *
 * The Context Mapper provides McpServer CRDs via REST API, so mcp-host
 * doesn't need direct K8s access to McpServer resources.
 */
import { config } from './config'
import { McpServerInfo } from './types'

export interface McpServersResponse {
  servers: McpServerInfo[]
  timestamp: string
}

export interface AuthTokenResponse {
  token: string | null
  credentialRevision: string
}

const DEFAULT_CONTEXT_MAPPER_REQUEST_TIMEOUT_MS = 10_000
const MCP_SERVER_NAME_PATTERN = /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/

export type ContextMapperRequestKind = 'inventory' | 'credential'

export class ContextMapperRequestError extends Error {
  constructor(
    readonly status: number,
    readonly kind: ContextMapperRequestKind,
    readonly authorizationFailure: boolean
  ) {
    super(
      authorizationFailure
        ? 'HCC caller authority was rejected'
        : `HCC ${kind} request failed with status ${status}`
    )
    this.name = 'ContextMapperRequestError'
  }
}

export function isContextMapperAuthorityRevocation(error: unknown): boolean {
  return (
    (error instanceof ContextMapperRequestError &&
      (error.authorizationFailure || (error.kind === 'credential' && error.status === 404)))
  )
}

/**
 * An inventory 404 means HCC could not resolve the authenticated Host's live
 * Context authority. Unlike a credential 404 (which retires one target), this
 * invalidates the complete locally-published MCP fleet.
 */
export function isContextMapperInventoryAuthorityRevocation(error: unknown): boolean {
  return (
    error instanceof ContextMapperRequestError && error.kind === 'inventory' && error.status === 404
  )
}

export interface ContextMapperAuthentication {
  getAccessToken(): string
  refreshOnUnauthorized(): Promise<void>
  /** Required so every authenticated client has a synchronous revocation hook. */
  onCallerAuthorizationFailure(status: 401 | 403): void
}

export interface ContextMapperClientOptions {
  requestTimeoutMs?: number
  authentication?: ContextMapperAuthentication
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function decodeMcpServer(value: unknown): McpServerInfo {
  if (!isRecord(value)) throw new Error('HCC inventory response is malformed')
  if ('contextRef' in value &&
    (typeof value.contextRef !== 'string' || !MCP_SERVER_NAME_PATTERN.test(value.contextRef))) {
    throw new Error('HCC inventory response contains an invalid Context reference')
  }
  if (
    'auth' in value ||
    'secretRef' in value ||
    'secretKey' in value ||
    'credentialRevision' in value
  ) {
    if ('credentialRevision' in value) {
      throw new Error('HCC inventory response contains forbidden credential revision')
    }
    throw new Error('HCC inventory response contains forbidden authority metadata')
  }
  if (typeof value.name !== 'string' || !MCP_SERVER_NAME_PATTERN.test(value.name)) {
    throw new Error('HCC inventory response contains an invalid server selector')
  }
  if (!isRecord(value.transport)) throw new Error('HCC inventory response is malformed')
  const transportType = value.transport.type
  if (!['sse', 'streamableHttp', 'stdio'].includes(String(transportType))) {
    throw new Error('HCC inventory response contains an invalid transport')
  }
  const transportUrl = value.transport.url
  if (transportUrl !== undefined && typeof transportUrl !== 'string') {
    throw new Error('HCC inventory response contains an invalid transport')
  }
  const transportPort = value.transport.port
  if (
    transportPort !== undefined &&
    (!Number.isSafeInteger(transportPort) ||
      (transportPort as number) < 1 ||
      (transportPort as number) > 65_535)
  ) {
    throw new Error('HCC inventory response contains an invalid transport port')
  }
  if (typeof value.enabled !== 'boolean' || typeof value.authRequired !== 'boolean') {
    throw new Error('HCC inventory response is malformed')
  }
  if (!isRecord(value.status)) throw new Error('HCC inventory response is malformed')
  if (typeof value.status.deployed !== 'boolean' || typeof value.status.ready !== 'boolean') {
    throw new Error('HCC inventory response is malformed')
  }
  return {
    name: value.name,
    ...(typeof value.contextRef === 'string' ? { contextRef: value.contextRef } : {}),
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    transport: {
      type: transportType as McpServerInfo['transport']['type'],
      ...(typeof transportUrl === 'string' ? { url: transportUrl } : {}),
      ...(typeof transportPort === 'number' ? { port: transportPort } : {}),
    },
    enabled: value.enabled,
    authRequired: value.authRequired,
    status: {
      deployed: value.status.deployed,
      ready: value.status.ready,
      ...(typeof value.status.authoritative === 'boolean'
        ? { authoritative: value.status.authoritative }
        : {}),
    },
  }
}

function decodeInventoryResponse(value: unknown): McpServersResponse {
  if (!isRecord(value) || !Array.isArray(value.servers) || typeof value.timestamp !== 'string') {
    throw new Error('HCC inventory response is malformed')
  }
  return { servers: value.servers.map(decodeMcpServer), timestamp: value.timestamp }
}

function decodeCredentialResponse(value: unknown): AuthTokenResponse {
  if (!isRecord(value)) throw new Error('HCC credential response is malformed')
  const keys = Object.keys(value).sort()
  if (
    keys.length !== 2 ||
    keys[0] !== 'credentialRevision' ||
    keys[1] !== 'token' ||
    (value.token !== null && typeof value.token !== 'string') ||
    typeof value.credentialRevision !== 'string' ||
    !value.credentialRevision
  ) {
    throw new Error('HCC credential response is malformed')
  }
  return { token: value.token as string | null, credentialRevision: value.credentialRevision }
}

/**
 * Context Mapper client.
 */
export class ContextMapperClient {
  private baseUrl: string
  private requestTimeoutMs: number
  private authentication?: ContextMapperAuthentication

  constructor(
    baseUrl: string,
    options: number | ContextMapperClientOptions = DEFAULT_CONTEXT_MAPPER_REQUEST_TIMEOUT_MS
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '') // Remove trailing slash
    this.requestTimeoutMs =
      typeof options === 'number'
        ? options
        : (options.requestTimeoutMs ?? DEFAULT_CONTEXT_MAPPER_REQUEST_TIMEOUT_MS)
    this.authentication = typeof options === 'number' ? undefined : options.authentication
  }

  private fetch(input: string, init: RequestInit = {}): Promise<Response> {
    return fetch(input, {
      ...init,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    })
  }

  private accessToken(kind: ContextMapperRequestKind): string {
    let token = ''
    try {
      token = this.authentication?.getAccessToken().trim() ?? ''
    } catch {
      // Treat an unreadable local credential exactly like an HCC rejection:
      // revoke any already-published fleet before returning to the caller.
    }
    if (!token) {
      this.authentication?.onCallerAuthorizationFailure(401)
      throw new ContextMapperRequestError(401, kind, true)
    }
    return token
  }

  private async protectedFetch(
    path: string,
    kind: ContextMapperRequestKind,
    init: RequestInit = {}
  ): Promise<Response> {
    let retriedAfterRefresh = false
    for (;;) {
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          ...init.headers,
          Authorization: `Bearer ${this.accessToken(kind)}`,
        },
      })

      if (response.status === 401 && !retriedAfterRefresh && this.authentication) {
        retriedAfterRefresh = true
        try {
          await this.authentication.refreshOnUnauthorized()
        } catch {
          this.authentication.onCallerAuthorizationFailure(401)
          throw new ContextMapperRequestError(401, kind, true)
        }
        continue
      }

      if (response.status === 401 || response.status === 403) {
        this.authentication?.onCallerAuthorizationFailure(response.status)
        throw new ContextMapperRequestError(response.status, kind, true)
      }
      if (!response.ok) {
        throw new ContextMapperRequestError(response.status, kind, false)
      }
      return response
    }
  }

  /**
   * Health check.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.fetch(`${this.baseUrl}/ready`)
      return response.ok
    } catch {
      console.error('[ContextMapper] Health check failed (reason=transport)')
      return false
    }
  }

  /**
   * List only the McpServers authorized for the authenticated Host. The old
   * global/context-selecting v1 routes are intentionally not represented by
   * this client.
   */
  async listServersForHost(): Promise<McpServerInfo[]> {
    const response = await this.protectedFetch('/api/v2/hosts/self/mcpservers', 'inventory')
    const data = decodeInventoryResponse(await response.json())
    console.log(`[ContextMapper] Received ${data.servers.length} authorized MCP server(s)`)
    return data.servers
  }

  /**
   * Get auth token for an McpServer.
   */
  async getAuthToken(serverName: string): Promise<AuthTokenResponse> {
    const response = await this.protectedFetch(
      '/api/v2/hosts/self/mcpservers/credential',
      'credential',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverName }),
      }
    )
    const data = decodeCredentialResponse(await response.json())
    return data
  }

  /**
   * Poll for changes to McpServers.
   * Returns only authoritative snapshots. Transport and HTTP failures reject
   * so callers preserve their last known fleet instead of treating an
   * unavailable controller as an authoritative empty inventory.
   */
  async pollServers(): Promise<{ servers: McpServerInfo[]; timestamp: string }> {
    const response = await this.protectedFetch('/api/v2/hosts/self/mcpservers', 'inventory')
    const data = decodeInventoryResponse(await response.json())
    return { servers: data.servers, timestamp: data.timestamp }
  }
}

// Default client instance (configured from environment)
let defaultClient: ContextMapperClient | null = null

export function getContextMapperClient(
  authentication: ContextMapperAuthentication
): ContextMapperClient {
  if (!defaultClient) {
    defaultClient = new ContextMapperClient(config.contextMapperUrl, { authentication })
  }
  return defaultClient
}
