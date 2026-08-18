import { type AuthorizedActionV2, actionAuthorityCheckpointRequest } from '../actionAuthorityV2.js'
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
  | { kind: 'authority'; status: 400 | 403 | 404 | 409 | 503; code: string }

async function drainBody(response: Response): Promise<void> {
  try {
    await response.arrayBuffer()
  } catch {
    /* draining is best effort; the status code already carries the answer */
  }
}

export async function requestHostWakeFromControlApi(
  hostRef: string,
  rpcAccessToken: string,
  options: { authorizedActionV2?: AuthorizedActionV2; wakeReason?: string } = {}
): Promise<HostWakeApiResponse> {
  const v2 = options.authorizedActionV2
  const response = await fetch(
    v2
      ? `${controlApiBaseUrl()}/internal/action-authority/hosts/${encodeURIComponent(hostRef)}/wake`
      : `${controlApiBaseUrl()}/rpc/hosts/${encodeURIComponent(hostRef)}/wake`,
    {
      method: 'POST',
      headers: v2
        ? {
            authorization: `Bearer ${config.controlApiServiceToken}`,
            'content-type': 'application/json',
            'x-service-token': config.controlApiServiceName,
          }
        : controlApiHeaders(rpcAccessToken),
      ...(v2
        ? {
            body: JSON.stringify({
              binding: actionAuthorityCheckpointRequest(v2.claims, v2.bound),
              wakeReason: options.wakeReason ?? 'message_retry',
            }),
          }
        : {}),
    }
  )

  if (v2 && [400, 403, 404, 409, 503].includes(response.status)) {
    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      throw new Error('Control API v2 host wake returned an invalid authority response')
    }
    const value = parsed as { status?: unknown; code?: unknown }
    if (
      ![
        'invalid_binding',
        'denied',
        'not_found',
        'access_path_stale',
        'authority_unavailable',
      ].includes(String(value.status)) ||
      typeof value.code !== 'string'
    ) {
      throw new Error('Control API v2 host wake returned an invalid authority response')
    }
    return {
      kind: 'authority',
      status: response.status as 400 | 403 | 404 | 409 | 503,
      code: value.code,
    }
  }

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
