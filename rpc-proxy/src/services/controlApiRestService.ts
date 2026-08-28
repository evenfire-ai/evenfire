import { config } from '../config.js'
import { ResolvedServerConnection } from '../types.js'

export type UserAllowedServers = {
  userId: string
  contextIds: string[]
  servers: Array<{ name: string; url: string }>
}

type UserAllowedHost = {
  userId: string
  hostRef: string
  url: string
  bindingStatus?: 'recorded' | 'unavailable'
}

function controlApiHeaders(rpcAccessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${config.controlApiServiceToken}`,
    'x-service-token': config.controlApiServiceName,
    'x-rpc-access-token': rpcAccessToken,
  }
}

function controlApiBaseUrl(): string {
  return config.controlApiBaseUrl.replace(/\/+$/, '')
}

// Shared upstream deadline for every control-api call in this file. Without it a
// hung control-api pins the proxy socket indefinitely (the sibling host rail in
// mcpHostRestService.ts already bounds its fetches at the same budget).
// AbortSignal.timeout throws a TimeoutError, which the app error handler maps to
// a 504 via isUpstreamTimeoutError — never a silent 500 or an unbounded wait.
function upstreamAbortSignal(): AbortSignal {
  return AbortSignal.timeout(config.upstreamTimeoutMs)
}

export type DirectRunBindingRequest = {
  runId: string
  sessionId: string
  origin: 'direct_chat' | 'channel_event' | 'api'
}

export class ControlApiHostAccessRejectedError extends Error {
  constructor(readonly status: number) {
    super(`Control API rejected host access (${status})`)
    this.name = 'ControlApiHostAccessRejectedError'
  }
}

export async function fetchUserAllowedServersFromControlApi(
  userId: string,
  rpcAccessToken: string
): Promise<UserAllowedServers> {
  const response = await fetch(
    `${controlApiBaseUrl()}/rpc/access/users/${encodeURIComponent(userId)}/mcp-servers`,
    {
      method: 'GET',
      headers: controlApiHeaders(rpcAccessToken),
      signal: upstreamAbortSignal(),
    }
  )

  if (!response.ok) {
    throw new Error(`Control API MCP server lookup failed (${response.status})`)
  }

  const parsed = (await response.json()) as Partial<UserAllowedServers>
  const contextIds = Array.isArray(parsed.contextIds)
    ? parsed.contextIds
        .map(String)
        .map(v => v.trim())
        .filter(Boolean)
    : []
  const servers = Array.isArray(parsed.servers)
    ? parsed.servers
        .filter((entry): entry is { name: string; url: string } => {
          return Boolean(
            entry &&
            typeof entry === 'object' &&
            typeof (entry as { name?: unknown }).name === 'string' &&
            typeof (entry as { url?: unknown }).url === 'string'
          )
        })
        .map(entry => ({ name: entry.name.trim(), url: entry.url.trim() }))
        .filter(entry => entry.name.length > 0 && entry.url.length > 0)
    : []

  return {
    userId,
    contextIds,
    servers,
  }
}

export type UserConnector = {
  name: string
  provider?: string
  authKind?: 'static' | 'oauth-user' | 'oauth-context'
  grantScope?: 'user' | 'context'
  status: 'authorized' | 'requires_setup' | 'no_oauth'
}

export type UserAgentConnectors = {
  name: string
  contextRef: string | null
  connectors: UserConnector[]
}

export type UserConnectorsResponse = {
  userId: string
  agents: UserAgentConnectors[]
}

const CONNECTOR_STATUSES = new Set(['authorized', 'requires_setup', 'no_oauth'])
const CONNECTOR_AUTH_KINDS = new Set(['static', 'oauth-user', 'oauth-context'])
const CONNECTOR_GRANT_SCOPES = new Set(['user', 'context'])

function sanitizeConnector(raw: unknown): UserConnector | null {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>
  const name = typeof entry.name === 'string' ? entry.name.trim() : ''
  const status = entry.status
  if (!name || typeof status !== 'string' || !CONNECTOR_STATUSES.has(status)) return null
  const connector: UserConnector = { name, status: status as UserConnector['status'] }
  if (typeof entry.provider === 'string' && entry.provider.trim()) {
    connector.provider = entry.provider.trim()
  }
  if (typeof entry.authKind === 'string' && CONNECTOR_AUTH_KINDS.has(entry.authKind)) {
    connector.authKind = entry.authKind as UserConnector['authKind']
  }
  if (typeof entry.grantScope === 'string' && CONNECTOR_GRANT_SCOPES.has(entry.grantScope)) {
    connector.grantScope = entry.grantScope as UserConnector['grantScope']
  }
  return connector
}

function sanitizeAgentConnectors(raw: unknown): UserAgentConnectors | null {
  if (!raw || typeof raw !== 'object') return null
  const agent = raw as Record<string, unknown>
  const name = typeof agent.name === 'string' ? agent.name.trim() : ''
  if (!name) return null
  const contextRef =
    typeof agent.contextRef === 'string' && agent.contextRef.trim() ? agent.contextRef.trim() : null
  const connectors = Array.isArray(agent.connectors)
    ? agent.connectors
        .map(sanitizeConnector)
        .filter((entry): entry is UserConnector => entry !== null)
    : []
  return { name, contextRef, connectors }
}

/**
 * Fetch the proactive connectors read-model for a user (spec 11 U1). Projects
 * the control-api payload down to the declared, NON-SECRET shape and drops any
 * unexpected field — the inventory never transports `auth`/`secretRef`/tokens.
 * Deliberately UNCACHED: the tri-state must reflect a just-completed
 * connect/disconnect, unlike the server catalog (`fetchUserAllowedServers…`).
 */
export async function fetchUserConnectorsFromControlApi(
  userId: string,
  rpcAccessToken: string
): Promise<UserConnectorsResponse> {
  const response = await fetch(
    `${controlApiBaseUrl()}/rpc/access/users/${encodeURIComponent(userId)}/mcp-connectors`,
    {
      method: 'GET',
      headers: controlApiHeaders(rpcAccessToken),
      signal: upstreamAbortSignal(),
    }
  )

  if (!response.ok) {
    throw new Error(`Control API MCP connectors lookup failed (${response.status})`)
  }

  const parsed = (await response.json()) as Partial<UserConnectorsResponse>
  const agents = Array.isArray(parsed.agents)
    ? parsed.agents
        .map(sanitizeAgentConnectors)
        .filter((agent): agent is UserAgentConnectors => agent !== null)
    : []

  return { userId, agents }
}

export async function fetchHostConnectionFromControlApi(
  userId: string,
  hostRef: string,
  rpcAccessToken: string,
  options: {
    directRunBinding?: DirectRunBindingRequest
    fetchImpl?: typeof fetch
  } = {}
): Promise<ResolvedServerConnection | null> {
  const directRunBinding = options.directRunBinding
  const response = await (options.fetchImpl ?? fetch)(
    `${controlApiBaseUrl()}/rpc/access/users/${encodeURIComponent(userId)}/mcp-hosts/${encodeURIComponent(hostRef)}`,
    {
      method: directRunBinding ? 'POST' : 'GET',
      headers: {
        ...controlApiHeaders(rpcAccessToken),
        ...(directRunBinding ? { 'content-type': 'application/json' } : {}),
      },
      ...(directRunBinding ? { body: JSON.stringify(directRunBinding) } : {}),
      signal: upstreamAbortSignal(),
    }
  )

  if (!directRunBinding && (response.status === 403 || response.status === 404)) {
    return null
  }
  if (response.status === 401 || response.status === 403 || response.status === 409) {
    await drainBody(response)
    throw new ControlApiHostAccessRejectedError(response.status)
  }
  if (!response.ok) {
    await drainBody(response)
    throw new Error(`Control API MCP host lookup failed (${response.status})`)
  }

  const parsed = (await response.json()) as Partial<UserAllowedHost>
  if (parsed.userId !== userId) {
    return null
  }
  const url = typeof parsed.url === 'string' ? parsed.url.trim() : ''
  const resolvedHostRef = typeof parsed.hostRef === 'string' ? parsed.hostRef.trim() : ''
  if (!url || !resolvedHostRef || resolvedHostRef !== hostRef) {
    return null
  }
  const attributionBindingStatus = directRunBinding ? parsed.bindingStatus : undefined
  if (
    directRunBinding &&
    attributionBindingStatus !== 'recorded' &&
    attributionBindingStatus !== 'unavailable'
  ) {
    throw new Error('Control API MCP host binding response was invalid')
  }

  return {
    name: resolvedHostRef,
    url,
    headers: {},
    ...(attributionBindingStatus ? { attributionBindingStatus } : {}),
  }
}

/**
 * Discriminated view of the control-api wake endpoint contract (Stage 4.1):
 *   200 {status:'active'[, wakeGeneration]}  running or drain-cancelled
 *   202 {status:'wake-requested', ...}       wake recorded, pod not up yet
 *   404 {status:'unknown'}                   Host CR absent
 *   409 {status:'not-stateless'}             lifecycle kill-switch off
 *   429 {error, retryAfterSeconds}           per-host wake rate limit
 *   401/403                                  rpc access token rejected
 */
export type HostWakeApiResponse =
  | { kind: 'active'; wakeGeneration: number | null }
  | { kind: 'wake-requested'; wakeGeneration: number | null }
  | { kind: 'not-stateless' }
  | { kind: 'unknown' }
  | { kind: 'rate-limited'; retryAfterSeconds: number }
  | { kind: 'auth'; status: number }

async function drainBody(response: Response): Promise<void> {
  try {
    await response.arrayBuffer()
  } catch {
    /* draining is best effort; the status code already carries the answer */
  }
}

export async function requestHostWakeFromControlApi(
  hostRef: string,
  rpcAccessToken: string
): Promise<HostWakeApiResponse> {
  const response = await fetch(
    `${controlApiBaseUrl()}/rpc/hosts/${encodeURIComponent(hostRef)}/wake`,
    {
      method: 'POST',
      headers: controlApiHeaders(rpcAccessToken),
      signal: upstreamAbortSignal(),
    }
  )

  if (response.status === 401 || response.status === 403) {
    await drainBody(response)
    return { kind: 'auth', status: response.status }
  }
  if (response.status === 404) {
    await drainBody(response)
    return { kind: 'unknown' }
  }
  if (response.status === 409) {
    await drainBody(response)
    return { kind: 'not-stateless' }
  }
  if (response.status === 429) {
    const headerSeconds = Number(response.headers.get('retry-after'))
    let bodySeconds = Number.NaN
    try {
      const parsed = (await response.json()) as { retryAfterSeconds?: unknown }
      if (typeof parsed?.retryAfterSeconds === 'number') bodySeconds = parsed.retryAfterSeconds
    } catch {
      /* header below is the authoritative fallback; a missing pair fails loud */
    }
    const retryAfterSeconds =
      Number.isFinite(headerSeconds) && headerSeconds > 0 ? headerSeconds : bodySeconds
    if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
      throw new Error('Control API host wake returned 429 without a usable Retry-After')
    }
    return { kind: 'rate-limited', retryAfterSeconds }
  }
  if (response.status === 200 || response.status === 202) {
    const parsed = (await response.json()) as { status?: unknown; wakeGeneration?: unknown }
    const wakeGeneration = typeof parsed?.wakeGeneration === 'number' ? parsed.wakeGeneration : null
    if (response.status === 200 && parsed?.status === 'active') {
      return { kind: 'active', wakeGeneration }
    }
    if (response.status === 202 && parsed?.status === 'wake-requested') {
      return { kind: 'wake-requested', wakeGeneration }
    }
    throw new Error(`Control API host wake returned unexpected body for status ${response.status}`)
  }
  await drainBody(response)
  throw new Error(`Control API host wake failed (${response.status})`)
}
