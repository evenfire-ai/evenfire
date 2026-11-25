import jwt from 'jsonwebtoken'
import { HOST_EDGE_ASSERTION_HEADER } from '@clerum/action-context-contracts'
import { ActionAuthorityCheckpointError, type AuthorizedActionV2 } from '../actionAuthorityV2.js'
import { config } from '../config.js'
import { ResolvedServerConnection } from '../types.js'
import {
  type DirectRunBindingRequest,
  type UserAllowedServers,
  fetchHostConnectionFromControlApi,
  fetchUserAllowedServersFromControlApi,
} from './controlApiRestService.js'
import {
  CONTROL_API_HOST_EDGE_ASSERTION_MISSING_ERROR,
  type HostAccessDenial,
  isHostAccessDenied,
} from './hostAccessDenial.js'
import { sanitizeHostRefForLog } from './wakeAndHold.js'

export { validateRpcRequest, forwardRpcToServer } from './mcpRpcService.js'
export {
  forwardHostActivity,
  forwardHostHealth,
  type HostActivityEvent,
  type HostActivitySnapshot,
  type HostRuntimeMessageRequest,
  forwardHostMessageToHost,
  forwardHostStatus,
  forwardTaskResultFromHost,
  forwardCancelToHost,
  UpstreamHostError,
  type CancelUpstreamResult,
  type HostRuntimeHealth,
  type HostRuntimeStatus,
} from './mcpHostRestService.js'

type CacheEntry = {
  data: UserAllowedServers
  cachedAt: number
}

const userServerCache = new Map<string, CacheEntry>()

async function getCachedUserAllowedServers(
  userId: string,
  rpcAccessToken: string
): Promise<UserAllowedServers> {
  const cached = userServerCache.get(userId)
  const now = Date.now()
  if (cached && now - cached.cachedAt <= config.controlApiCacheTtlMs) {
    return cached.data
  }

  const data = await fetchUserAllowedServersFromControlApi(userId, rpcAccessToken)
  userServerCache.set(userId, { data, cachedAt: now })
  return data
}

export async function listAllowedServersForUser(
  userId: string,
  rpcAccessToken: string
): Promise<{ userId: string; contextIds: string[]; servers: string[] }> {
  const data = await getCachedUserAllowedServers(userId, rpcAccessToken)
  return {
    userId,
    contextIds: data.contextIds,
    servers: data.servers.map(server => server.name),
  }
}

export async function resolveServerConnectionForUser(
  userId: string,
  serverName: string,
  rpcAccessToken: string,
  authorizedActionV2?: AuthorizedActionV2
): Promise<ResolvedServerConnection | null> {
  if (authorizedActionV2) {
    const destination = authorizedActionV2.checkpoint.destination
    const expectedRef = `${config.mcpServerNamespace}/${serverName}`
    if (!destination || destination.kind !== 'mcp_server' || destination.ref !== expectedRef) {
      throw new Error('Invalid v2 MCP destination binding')
    }
    return { name: serverName, url: destination.url, headers: {} }
  }
  const data = await getCachedUserAllowedServers(userId, rpcAccessToken)
  const server = data.servers.find(entry => entry.name === serverName)
  if (!server) return null
  return {
    name: server.name,
    url: server.url,
    headers: {},
  }
}

/**
 * The edge assertion of a V2 checkpoint whose destination is a Host.
 * `authorizeActionV2` refuses such a checkpoint without one, so a missing
 * assertion here is a broken invariant and throws.
 */
export function v2HostEdgeAssertion(authorizedActionV2: AuthorizedActionV2): string {
  if (authorizedActionV2.hostEdgeAssertion === null) {
    throw new Error('V2 Host checkpoint carries no edge assertion')
  }
  return authorizedActionV2.hostEdgeAssertion
}

export async function resolveHostConnectionForUser(
  userId: string,
  hostRef: string,
  rpcAccessToken: string,
  edgeContext?: {
    accessScope?: 'team' | 'user'
    teamId?: string | null
    requestId?: string
    directRunBinding?: DirectRunBindingRequest
    authorizedActionV2?: AuthorizedActionV2
  }
): Promise<ResolvedServerConnection | HostAccessDenial> {
  const expectedRef = `${config.hostNamespace}/${hostRef}`
  const authorizedActionV2 = edgeContext?.authorizedActionV2
  const destination = authorizedActionV2?.checkpoint.destination
  let host: ResolvedServerConnection
  if (authorizedActionV2) {
    if (destination?.kind !== 'host' || destination.ref !== expectedRef) {
      throw new Error('Invalid v2 host destination binding')
    }
    host = {
      name: hostRef,
      url: destination.url,
      headers: { [HOST_EDGE_ASSERTION_HEADER]: v2HostEdgeAssertion(authorizedActionV2) },
      attributionBindingStatus: undefined,
    }
  } else {
    let resolved: Awaited<ReturnType<typeof fetchHostConnectionFromControlApi>>
    try {
      resolved = await fetchHostConnectionFromControlApi(userId, hostRef, rpcAccessToken, {
        directRunBinding: edgeContext?.directRunBinding,
      })
    } catch (error) {
      // The route answers this error as 503 `authority_unavailable` without its
      // message, so this line is where the operator sees the cause.
      if (error instanceof Error && error.name === CONTROL_API_HOST_EDGE_ASSERTION_MISSING_ERROR) {
        console.warn(
          `[RPC_PROXY] control-api answered the host resolve without an edge assertion; upgrade control-api before RPC Proxy host=${sanitizeHostRefForLog(
            hostRef
          )}`
        )
      }
      throw error
    }
    if (isHostAccessDenied(resolved)) return resolved
    const { edgeAssertion, ...connection } = resolved
    host = {
      ...connection,
      headers: { ...connection.headers, [HOST_EDGE_ASSERTION_HEADER]: edgeAssertion },
    }
  }

  const headers: Record<string, string> = {
    ...host.headers,
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': hostRef,
  }
  delete headers.authorization
  if (authorizedActionV2) {
    headers['x-clerum-edge-action-context'] = authorizedActionV2.trustedEdgeHeader
  } else {
    headers['x-clerum-edge-user-id'] = userId
    if (edgeContext?.teamId) headers['x-clerum-edge-team-id'] = edgeContext.teamId
    headers['x-clerum-edge-access-scope'] =
      edgeContext?.accessScope ?? (edgeContext?.teamId ? 'team' : 'user')
  }
  if (edgeContext?.requestId) headers['x-clerum-edge-request-id'] = edgeContext.requestId

  return {
    ...host,
    headers,
  }
}

/**
 * Allowance for the whole-second `exp` and for the Host verifying the assertion
 * with no clock tolerance. Same value as the hold's RPC token margin
 * (`TOKEN_EXP_SAFETY_MARGIN_MS` in wakeAndHold.ts, which does not export it).
 */
const EDGE_ASSERTION_EXP_SAFETY_MARGIN_MS = 2_000

/**
 * Whether a held V1 edge assertion is close enough to its `exp` that a retry
 * must re-resolve it first: `exp` is at most `upstreamTimeoutMs` plus the
 * safety margin away. A retry attempt never outlives `upstreamTimeoutMs`, so an
 * assertion outside that window is still valid when the Host checks it.
 *
 * The assertion is decoded without verification (rpc-proxy does not hold the
 * Host's key; it only reads `exp`). control-api always issues a JWT with a
 * numeric `exp`, so an assertion without one is a broken invariant and throws.
 */
export function isHeldEdgeAssertionNearExpiry(
  assertion: string | undefined,
  nowMs: number
): boolean {
  const payload = assertion === undefined ? null : jwt.decode(assertion)
  const exp = payload !== null && typeof payload === 'object' ? payload.exp : undefined
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    throw new Error('Held edge assertion has no readable exp')
  }
  return exp * 1000 - nowMs <= config.upstreamTimeoutMs + EDGE_ASSERTION_EXP_SAFETY_MARGIN_MS
}

/**
 * Re-resolves a V1 Host connection before a wake-and-hold retry when the held
 * edge assertion is near its `exp` (`isHeldEdgeAssertionNearExpiry`), so the
 * retry carries a fresh assertion. Far from `exp` it returns null without
 * calling control-api and the retry reuses the held assertion. Uses the GET
 * form (no direct-run binding) with the caller's RPC token.
 *
 * - A held assertion without a readable `exp` throws.
 * - A denial (control-api 403/404, or a user or Host mismatch) is returned for
 *   the route to answer as it answers a denial at its first resolve.
 * - A control-api 401 (`ControlApiHostAccessRejectedError`) is rethrown as is,
 *   so it reaches the client as 401.
 * - Any other failure of the control-api call (network, timeout, other non-2xx,
 *   a response without an edge assertion) is rethrown as a 503
 *   `authority_unavailable`, which is never wake-eligible: a control-api network
 *   failure must not be read as the Host being down.
 * - A connection whose URL differs from the first resolve throws.
 *
 * On success it rewrites the assertion header in place, synchronously after the
 * await, because the route's forwarders read `host.headers` on the retry.
 */
export async function refreshV1HostConnection(
  host: ResolvedServerConnection,
  userId: string,
  hostRef: string,
  rpcAccessToken: string
): Promise<HostAccessDenial | null> {
  if (!isHeldEdgeAssertionNearExpiry(host.headers[HOST_EDGE_ASSERTION_HEADER], Date.now())) {
    return null
  }
  let resolved: Awaited<ReturnType<typeof fetchHostConnectionFromControlApi>>
  try {
    resolved = await fetchHostConnectionFromControlApi(userId, hostRef, rpcAccessToken)
  } catch (error) {
    if (error instanceof Error && error.name === 'ControlApiHostAccessRejectedError') throw error
    console.warn(
      `[RPC_PROXY] host connection re-resolve failed host=${sanitizeHostRefForLog(hostRef)} error=${
        error instanceof Error ? error.name : typeof error
      }`
    )
    throw new ActionAuthorityCheckpointError(503, 'authority_unavailable')
  }
  if (isHostAccessDenied(resolved)) return resolved
  if (resolved.url !== host.url) {
    throw new Error('Control API returned a different Host URL on re-resolve')
  }
  host.headers[HOST_EDGE_ASSERTION_HEADER] = resolved.edgeAssertion
  return null
}
