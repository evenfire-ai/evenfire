import { createMessageRetryHostWakeRequest } from '@clerum/action-context-contracts'
import { type AuthorizedActionV2, actionAuthorityCheckpointRequest } from '../actionAuthorityV2.js'
import { config } from '../config.js'
import { ResolvedServerConnection } from '../types.js'
import {
  type HostAccessDenial,
  type HostAccessDenialCode,
  hostAccessDenialCodeForReason,
  hostAccessDenied,
} from './hostAccessDenial.js'

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
  /**
   * Set for a 403 only: whether control-api's denial reason proves the access
   * was removed from the user. Absent for 401/409, which are not authorization
   * denials of the Host.
   */
  readonly denialCode: HostAccessDenialCode | null
  constructor(
    readonly status: number,
    denialCode: HostAccessDenialCode | null = null
  ) {
    super(`Control API rejected host access (${status})`)
    this.name = 'ControlApiHostAccessRejectedError'
    this.denialCode = denialCode
  }
}

export class ControlApiArtifactReadRateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`Control API rate limited artifact reads for ${retryAfterSeconds} seconds`)
    this.name = 'ControlApiArtifactReadRateLimitedError'
  }
}

export class ControlApiHostMessageAdmissionError extends Error {
  constructor(
    readonly status: 429 | 503,
    readonly body: { error: string; retryAfterSeconds?: number },
    readonly headers: Record<string, string>
  ) {
    super(`Control API Host-message admission returned ${status}`)
    this.name = 'ControlApiHostMessageAdmissionError'
  }
}

export type LegacySessionAdmissionResult =
  | { allowed: true }
  | {
      allowed: false
      status: 429 | 503
      retryAfterSeconds: number
      headers: Record<string, string>
    }

const LEGACY_SESSION_ADMISSION_FALLBACK_RETRY_AFTER_SECONDS = 2

function boundedRetryAfter(value: string | null): number | null {
  if (!value || !/^(?:0|[1-9]\d{0,2})$/.test(value)) return null
  const seconds = Number(value)
  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 60 ? seconds : null
}

function boundedRateHeader(value: string | null, maxDigits = 12): string | null {
  if (!value || value.length > maxDigits || !/^(?:0|[1-9]\d*)$/.test(value)) return null
  return value
}

/**
 * Claims the shared durable verified-subject budget before legacy session
 * routes touch HCC or the Sandbox registry. Network/protocol failures fail
 * closed with a sanitized bounded retry response.
 */
export async function admitLegacySessionCreation(
  rpcAccessToken: string
): Promise<LegacySessionAdmissionResult> {
  let response: Response
  try {
    response = await fetch(`${controlApiBaseUrl()}/internal/rpc-proxy/legacy-session-admission`, {
      method: 'POST',
      headers: controlApiHeaders(rpcAccessToken),
      signal: upstreamAbortSignal(),
    })
  } catch {
    return {
      allowed: false,
      status: 503,
      retryAfterSeconds: LEGACY_SESSION_ADMISSION_FALLBACK_RETRY_AFTER_SECONDS,
      headers: {},
    }
  }

  if (response.status === 204 && response.ok) return { allowed: true }
  if (response.status !== 429 && response.status !== 503) {
    return {
      allowed: false,
      status: 503,
      retryAfterSeconds: LEGACY_SESSION_ADMISSION_FALLBACK_RETRY_AFTER_SECONDS,
      headers: {},
    }
  }

  const retryAfterSeconds =
    boundedRetryAfter(response.headers.get('retry-after')) ??
    LEGACY_SESSION_ADMISSION_FALLBACK_RETRY_AFTER_SECONDS
  if (response.status === 503) {
    return { allowed: false, status: 503, retryAfterSeconds, headers: {} }
  }

  const headers: Record<string, string> = {}
  const limit = boundedRateHeader(response.headers.get('x-ratelimit-limit'))
  const remaining = boundedRateHeader(response.headers.get('x-ratelimit-remaining'))
  const reset = boundedRateHeader(response.headers.get('x-ratelimit-reset'))
  if (limit !== null) headers['X-RateLimit-Limit'] = limit
  if (remaining !== null) headers['X-RateLimit-Remaining'] = remaining
  if (reset !== null) headers['X-RateLimit-Reset'] = reset

  return { allowed: false, status: 429, retryAfterSeconds, headers }
export class ControlApiHostRpcAdmissionError extends Error {
  constructor(
    readonly status: 429 | 503,
    readonly body: { error: string; retryAfterSeconds?: number },
    readonly headers: Record<string, string>
  ) {
    super(`Control API Host-RPC admission returned ${status}`)
    this.name = 'ControlApiHostRpcAdmissionError'
  }
}

/** Charge one legacy non-message Host-RPC request through Control API authority. */
export async function requestHostRpcAdmission(
  userId: string,
  hostRef: string,
  rpcAccessToken: string,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<void> {
  const response = await (options.fetchImpl ?? fetch)(
    `${controlApiBaseUrl()}/rpc/access/users/${encodeURIComponent(userId)}/mcp-hosts/${encodeURIComponent(hostRef)}/host-rpc-admission`,
    {
      method: 'POST',
      headers: controlApiHeaders(rpcAccessToken),
      signal: upstreamAbortSignal(),
    }
  )
  if (response.status === 204) return
  if (response.status === 401 || response.status === 403) {
    await drainBody(response)
    throw new ControlApiHostAccessRejectedError(response.status)
  }
  if (response.status === 503) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null
    if (body?.error === 'host_rpc_admission_unavailable') {
      throw new ControlApiHostRpcAdmissionError(
        503,
        { error: 'host_rpc_admission_unavailable' },
        {}
      )
    }
    throw new ControlApiHostRpcAdmissionError(503, { error: 'host_rpc_admission_unavailable' }, {})
  }
  if (response.status === 429) {
    const body = (await response.json().catch(() => null)) as {
      error?: unknown
      retryAfterSeconds?: unknown
    } | null
    const names = [
      'retry-after',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
    ] as const
    const headers = Object.fromEntries(names.map(name => [name, response.headers.get(name)]))
    const parseCanonicalInteger = (value: string | null): number | null => {
      if (value === null || !/^(0|[1-9]\d*)$/.test(value)) return null
      const parsed = Number(value)
      return Number.isSafeInteger(parsed) ? parsed : null
    }
    const retryAfter = parseCanonicalInteger(headers['retry-after'])
    const limit = parseCanonicalInteger(headers['x-ratelimit-limit'])
    const remaining = parseCanonicalInteger(headers['x-ratelimit-remaining'])
    const reset = parseCanonicalInteger(headers['x-ratelimit-reset'])
    if (
      body?.error === 'Too Many Requests' &&
      Number.isSafeInteger(body.retryAfterSeconds) &&
      Number(body.retryAfterSeconds) > 0 &&
      retryAfter !== null &&
      retryAfter === Number(body.retryAfterSeconds) &&
      limit !== null &&
      limit > 0 &&
      remaining === 0 &&
      reset !== null &&
      reset > 0
    ) {
      throw new ControlApiHostRpcAdmissionError(
        429,
        { error: 'Too Many Requests', retryAfterSeconds: Number(body.retryAfterSeconds) },
        {
          'Retry-After': String(headers['retry-after']),
          'X-RateLimit-Limit': String(headers['x-ratelimit-limit']),
          'X-RateLimit-Remaining': String(headers['x-ratelimit-remaining']),
          'X-RateLimit-Reset': String(headers['x-ratelimit-reset']),
        }
      )
    }
    throw new ControlApiHostRpcAdmissionError(503, { error: 'host_rpc_admission_unavailable' }, {})
  }
  await drainBody(response)
  throw new ControlApiHostRpcAdmissionError(503, { error: 'host_rpc_admission_unavailable' }, {})
}

// Typed rejection for the connectors read-model, mirroring the host rail above.
// A generic Error collapses to 500 in the app error handler, which the desktop
// reads as non-refreshable — so an expired/rotated rpc access token (401) would
// never trigger a token refresh and the panel would stay broken. Carrying the
// status lets the route map 401/403 to a real status the client can act on.
export class ControlApiConnectorsRejectedError extends Error {
  constructor(readonly status: 401 | 403) {
    super(`Control API rejected connectors read (${status})`)
    this.name = 'ControlApiConnectorsRejectedError'
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

  if (response.status === 401 || response.status === 403) {
    throw new ControlApiConnectorsRejectedError(response.status)
  }
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
    messageResolution?: boolean
    fetchImpl?: typeof fetch
  } = {}
): Promise<ResolvedServerConnection | HostAccessDenial> {
  return fetchHostConnectionForPath(userId, hostRef, rpcAccessToken, options)
}

/**
 * Resolves a Host connection after Control API has enforced the durable,
 * cross-replica artifact-read budget for this verified user and canonical Host.
 */
export async function fetchArtifactReadHostConnectionFromControlApi(
  userId: string,
  hostRef: string,
  rpcAccessToken: string,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<ResolvedServerConnection | HostAccessDenial> {
  return fetchHostConnectionForPath(userId, hostRef, rpcAccessToken, {
    ...options,
    artifactRead: true,
  })
}

async function fetchHostConnectionForPath(
  userId: string,
  hostRef: string,
  rpcAccessToken: string,
  options: {
    directRunBinding?: DirectRunBindingRequest
    fetchImpl?: typeof fetch
    artifactRead?: boolean
    messageResolution?: boolean
  } = {}
): Promise<ResolvedServerConnection | HostAccessDenial> {
  const directRunBinding = options.directRunBinding
  const hostAccessPath = `${controlApiBaseUrl()}/rpc/access/users/${encodeURIComponent(userId)}/mcp-hosts/${encodeURIComponent(hostRef)}`
  const messageResolution = options.messageResolution === true
  const response = await (options.fetchImpl ?? fetch)(
    options.artifactRead
      ? `${hostAccessPath}/artifact-read`
      : messageResolution
        ? `${hostAccessPath}/message-resolution`
        : hostAccessPath,
    {
      method: messageResolution || directRunBinding ? 'POST' : 'GET',
      headers: {
        ...controlApiHeaders(rpcAccessToken),
        ...(messageResolution || directRunBinding ? { 'content-type': 'application/json' } : {}),
      },
      ...(messageResolution || directRunBinding
        ? { body: JSON.stringify(directRunBinding ?? {}) }
        : {}),
      signal: upstreamAbortSignal(),
    }
  )

  if (messageResolution && (response.status === 429 || response.status === 503)) {
    const body = (await response.json().catch(() => null)) as {
      error?: unknown
      retryAfterSeconds?: unknown
    } | null
    if (response.status === 503 && body?.error === 'host_message_admission_unavailable') {
      throw new ControlApiHostMessageAdmissionError(
        503,
        { error: 'host_message_admission_unavailable' },
        {}
      )
    }
    const headerNames = [
      'retry-after',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
    ] as const
    const headers = Object.fromEntries(
      headerNames.map(name => [name, response.headers.get(name)])
    ) as Record<string, string | null>
    if (
      response.status === 429 &&
      body?.error === 'Too Many Requests' &&
      typeof body.retryAfterSeconds === 'number' &&
      Number.isSafeInteger(body.retryAfterSeconds) &&
      body.retryAfterSeconds > 0 &&
      headerNames.every(name => headers[name] !== null)
    ) {
      throw new ControlApiHostMessageAdmissionError(
        429,
        { error: 'Too Many Requests', retryAfterSeconds: body.retryAfterSeconds },
        headers as Record<string, string>
      )
    }
    throw new Error('Control API Host-message admission response was invalid')
  }

  if (options.artifactRead && response.status === 429) {
    const retryAfterHeader = Number(response.headers.get('retry-after'))
    let retryAfterBody = Number.NaN
    try {
      const body = (await response.json()) as { retryAfterSeconds?: unknown }
      if (typeof body.retryAfterSeconds === 'number') retryAfterBody = body.retryAfterSeconds
    } catch {
      /* use the header below when the canonical JSON body is unavailable */
    }
    const retryAfterSeconds =
      Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader : retryAfterBody
    if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
      throw new Error('Control API artifact-read limit returned 429 without Retry-After')
    }
    throw new ControlApiArtifactReadRateLimitedError(retryAfterSeconds)
  }
  if (!directRunBinding && response.status === 403) {
    return hostAccessDenied(await readHostAccessDenialCode(response))
  }
  if (!directRunBinding && response.status === 404) {
    await drainBody(response)
    return hostAccessDenied('host_access_denied')
  }
  if (response.status === 403) {
    throw new ControlApiHostAccessRejectedError(403, await readHostAccessDenialCode(response))
  }
  if (response.status === 401 || response.status === 409) {
    await drainBody(response)
    throw new ControlApiHostAccessRejectedError(response.status)
  }
  if (!response.ok) {
    await drainBody(response)
    throw new Error(`Control API MCP host lookup failed (${response.status})`)
  }

  const parsed = (await response.json()) as Partial<UserAllowedHost>
  if (parsed.userId !== userId) {
    return hostAccessDenied('host_access_denied')
  }
  const url = typeof parsed.url === 'string' ? parsed.url.trim() : ''
  const resolvedHostRef = typeof parsed.hostRef === 'string' ? parsed.hostRef.trim() : ''
  if (!url || !resolvedHostRef || resolvedHostRef !== hostRef) {
    return hostAccessDenied('host_access_denied')
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

/**
 * control-api reports the denial reason in the `x-host-access-denial-reason`
 * response header; its 403 body is the fixed `{"error":"Forbidden"}` and is never
 * parsed. An absent or unknown header yields the non-revoking code: an
 * unreadable reason can never prove the access was removed.
 */
async function readHostAccessDenialCode(response: Response): Promise<HostAccessDenialCode> {
  const reason = response.headers.get('x-host-access-denial-reason')
  await drainBody(response)
  return hostAccessDenialCodeForReason(reason)
}

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
  let v2Body: string | undefined
  if (v2) {
    if (v2.claims.exp * 1000 <= Date.now()) {
      return { kind: 'authority', status: 403, code: 'forbidden' }
    }
    if (v2.bound.operationId === 'chat.message.invoke') {
      if (options.wakeReason !== undefined && options.wakeReason !== 'message_retry') {
        throw new Error('Invalid derived message wake reason')
      }
      v2Body = JSON.stringify(
        createMessageRetryHostWakeRequest(actionAuthorityCheckpointRequest(v2.claims, v2.bound))
      )
    } else {
      v2Body = JSON.stringify({
        binding: actionAuthorityCheckpointRequest(v2.claims, v2.bound),
        wakeReason: options.wakeReason ?? 'explicit',
      })
    }
  }
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
            body: v2Body,
          }
        : {}),
      signal: upstreamAbortSignal(),
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
