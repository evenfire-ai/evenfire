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
  rpcAccessToken: string
): Promise<ResolvedServerConnection | null> {
  const response = await fetch(
    `${controlApiBaseUrl()}/rpc/access/users/${encodeURIComponent(userId)}/mcp-hosts/${encodeURIComponent(hostRef)}`,
    {
      method: 'GET',
      headers: controlApiHeaders(rpcAccessToken),
    }
  )

  if (response.status === 403 || response.status === 404) {
    return null
  }
  if (!response.ok) {
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

  return {
    name: resolvedHostRef,
    url,
    headers: {},
  }
}
