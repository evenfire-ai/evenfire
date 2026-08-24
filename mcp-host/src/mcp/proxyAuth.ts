/**
 * Host-scoped authentication for the MCP proxy data plane.
 *
 * The normal Authorization header remains the MCP server credential. The
 * proxy's private identity is carried separately in Proxy-Authorization and
 * is read afresh for every SDK request, including SSE reconnects.
 */
export interface McpProxyHostAuthorization {
  getAccessToken(): string
  refreshOnUnauthorized(): Promise<void>
}

export type McpProxyFetch = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>

/** Marker emitted only for a proxy-generated pre-forward Host challenge. */
export const MCP_PROXY_HOST_AUTH_CHALLENGE = 'Bearer realm="mcp-proxy"'

export class McpProxyAuthorizationError extends Error {
  constructor(readonly code: 'host_bearer_unavailable' | 'host_bearer_refresh_failed') {
    super(code)
    this.name = 'McpProxyAuthorizationError'
  }
}

type SharedRefreshState = { refreshPromise: Promise<void> | null }

const sharedRefreshStates = new WeakMap<McpProxyHostAuthorization, SharedRefreshState>()

function readHostBearer(auth: McpProxyHostAuthorization): string {
  let token = ''
  try {
    token = auth.getAccessToken().trim()
  } catch {
    throw new McpProxyAuthorizationError('host_bearer_unavailable')
  }
  if (!token) throw new McpProxyAuthorizationError('host_bearer_unavailable')
  return token
}

/**
 * Wrap the SDK fetch boundary so every request carries the current Host
 * identity. A 401 refresh is shared by concurrent requests and each request
 * gets at most one retry.
 */
export function createMcpProxyFetch(
  auth: McpProxyHostAuthorization,
  baseFetch: McpProxyFetch = globalThis.fetch.bind(globalThis)
): McpProxyFetch {
  let refreshState = sharedRefreshStates.get(auth)
  if (!refreshState) {
    refreshState = { refreshPromise: null }
    sharedRefreshStates.set(auth, refreshState)
  }

  const refreshAfterUnauthorized = async (observedBearer: string): Promise<void> => {
    let currentBearer = ''
    try {
      currentBearer = auth.getAccessToken().trim()
    } catch {
      throw new McpProxyAuthorizationError('host_bearer_unavailable')
    }
    // Another request may have completed the rotation before this request
    // inspected the 401. Reuse that new value instead of refreshing twice.
    if (currentBearer && currentBearer !== observedBearer) return

    if (!refreshState.refreshPromise) {
      refreshState.refreshPromise = auth
        .refreshOnUnauthorized()
        .catch(() => {
          throw new McpProxyAuthorizationError('host_bearer_refresh_failed')
        })
        .finally(() => {
          refreshState!.refreshPromise = null
        })
    }
    await refreshState.refreshPromise
  }

  return async (input, init = {}) => {
    let retried = false
    for (;;) {
      const hostBearer = readHostBearer(auth)
      const headers = new Headers(init.headers)
      headers.set('Proxy-Authorization', 'Bearer ' + hostBearer)
      const response = await baseFetch(input, { ...init, headers })

      if (
        response.status !== 401 ||
        response.headers.get('www-authenticate') !== MCP_PROXY_HOST_AUTH_CHALLENGE ||
        retried
      ) {
        return response
      }
      retried = true
      await response.body?.cancel().catch(() => undefined)
      await refreshAfterUnauthorized(hostBearer)
    }
  }
}
