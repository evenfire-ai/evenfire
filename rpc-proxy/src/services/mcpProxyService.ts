import type { AuthorizedActionV2 } from '../actionAuthorityV2.js'
import { config } from '../config.js'
import { ResolvedServerConnection } from '../types.js'
import {
  type DirectRunBindingRequest,
  type UserAllowedServers,
  fetchHostConnectionFromControlApi,
  fetchUserAllowedServersFromControlApi,
} from './controlApiRestService.js'

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

export async function resolveHostConnectionForUser(
  userId: string,
  hostRef: string,
  rpcAccessToken: string,
  edgeContext?: {
    accessScope?: 'team' | 'user'
    teamId?: string | null
    requestId?: string
    directRunBinding?: DirectRunBindingRequest
    actionContextV2?: string
    destination?: Readonly<{ kind: 'host' | 'mcp_server'; ref: string; url: string }>
  }
): Promise<ResolvedServerConnection | null> {
  const expectedRef = `${config.hostNamespace}/${hostRef}`
  const host = edgeContext?.actionContextV2
    ? edgeContext.destination?.kind === 'host' && edgeContext.destination.ref === expectedRef
      ? {
          name: hostRef,
          url: edgeContext.destination.url,
          headers: {},
          attributionBindingStatus: undefined,
        }
      : (() => {
          throw new Error('Invalid v2 host destination binding')
        })()
    : await fetchHostConnectionFromControlApi(userId, hostRef, rpcAccessToken, {
        directRunBinding: edgeContext?.directRunBinding,
      })
  if (!host) return null

  const headers: Record<string, string> = {
    ...host.headers,
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': hostRef,
  }
  if (edgeContext?.actionContextV2) {
    headers['x-clerum-edge-action-context'] = edgeContext.actionContextV2
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
