import { normalizeProfileUiBaseUrl } from '@clerum/desktop-app-links'
import { config } from '../config.js'
import { ResolvedServerConnection } from '../types.js'
import {
  type DirectRunBindingRequest,
  type UserAllowedServers,
  fetchHostConnectionFromControlApi,
  fetchUserAllowedServersFromControlApi,
} from './controlApiRestService.js'
import { type HostAccessDenial, isHostAccessDenied } from './hostAccessDenial.js'

const EDGE_PROFILE_LINK_CONTEXT_HEADER = 'x-clerum-edge-profile-link-context'

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
  rpcAccessToken: string
): Promise<ResolvedServerConnection | null> {
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
    includeProfileLinkContext?: boolean
  }
): Promise<ResolvedServerConnection | HostAccessDenial> {
  const host = await fetchHostConnectionFromControlApi(userId, hostRef, rpcAccessToken, {
    directRunBinding: edgeContext?.directRunBinding,
    ...(edgeContext?.includeProfileLinkContext
      ? { profileLinkContext: { teamId: edgeContext.teamId ?? null } }
      : {}),
  })
  if (isHostAccessDenied(host)) return host

  const headers: Record<string, string> = {
    ...host.headers,
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': hostRef,
    'x-clerum-edge-user-id': userId,
  }
  // Profile context is server-owned; never forward an upstream value when
  // this authenticated request did not receive a verified context.
  delete headers[EDGE_PROFILE_LINK_CONTEXT_HEADER]
  if (edgeContext?.teamId) headers['x-clerum-edge-team-id'] = edgeContext.teamId
  headers['x-clerum-edge-access-scope'] =
    edgeContext?.accessScope ?? (edgeContext?.teamId ? 'team' : 'user')
  if (edgeContext?.requestId) headers['x-clerum-edge-request-id'] = edgeContext.requestId
  const profileLinkContext = host.profileLinkContext
  const profileUiBaseUrl = profileLinkContext
    ? normalizeProfileUiBaseUrl(profileLinkContext.profileUiBaseUrl)
    : null
  if (
    edgeContext?.includeProfileLinkContext &&
    profileLinkContext?.version === 1 &&
    profileUiBaseUrl === profileLinkContext.profileUiBaseUrl &&
    profileLinkContext.userId === userId &&
    profileLinkContext.hostRef === hostRef &&
    profileLinkContext.teamId === (edgeContext.teamId ?? null)
  ) {
    headers[EDGE_PROFILE_LINK_CONTEXT_HEADER] = Buffer.from(
      JSON.stringify(profileLinkContext)
    ).toString('base64url')
  }

  return {
    ...host,
    headers,
  }
}
