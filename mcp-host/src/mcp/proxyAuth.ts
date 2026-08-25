/**
 * Host-scoped authentication for the MCP proxy data plane.
 *
 * The normal Authorization header remains the MCP server credential. The
 * proxy's private identity is carried separately in Proxy-Authorization and
 * is read afresh for every SDK request, including SSE reconnects.
 */
export interface McpProxyHostAuthorization {
  getAccessToken(): string
  /**
   * Re-read an access-only rotation from the private runtime state.
   *
   * This boundary must never consume the long-lived credential, call a token
   * rotation endpoint, or persist a new token pair. `true` means that the provider adopted a
   * strictly newer, valid, same-binding access token.
   */
  rereadAccessToken(): Promise<boolean>
}

export type McpProxyFetch = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>

/** Marker emitted only for a proxy-generated pre-forward Host challenge. */
export const MCP_PROXY_HOST_AUTH_CHALLENGE = 'Bearer realm="mcp-proxy"'

export class McpProxyAuthorizationError extends Error {
  constructor(
    readonly code: 'host_bearer_unavailable' | 'host_bearer_rotation_unavailable'
  ) {
    super(code)
    this.name = 'McpProxyAuthorizationError'
  }
}

type SharedRereadState = {
  rereadPromise: Promise<boolean> | null
  adoptedBearer: string | null
}

const sharedRereadStates = new WeakMap<McpProxyHostAuthorization, SharedRereadState>()

const sharedHostAuthorizations = new WeakMap<object, McpProxyHostAuthorization>()

/**
 * Keep the Host authorization facade stable for the lifetime of one runtime
 * authentication object. Manager replacement must not create a second
 * access-token reread domain for the same runtime bearer.
 */
export function getSharedMcpProxyHostAuthorization<T extends object>(
  scope: T,
  create: () => McpProxyHostAuthorization
): McpProxyHostAuthorization {
  let authorization = sharedHostAuthorizations.get(scope)
  if (!authorization) {
    authorization = create()
    sharedHostAuthorizations.set(scope, authorization)
  }
  return authorization
}

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

async function makeReplayableBody(body: BodyInit | null | undefined): Promise<BodyInit | null | undefined> {
  if (
    body === null ||
    body === undefined ||
    typeof body !== 'object' ||
    typeof ReadableStream === 'undefined' ||
    !(body instanceof ReadableStream)
  ) {
    return body
  }
  return new Uint8Array(await new Response(body).arrayBuffer())
}

/**
 * Wrap the SDK fetch boundary so every request carries the current Host
 * identity. An exact proxy identity challenge may trigger one shared,
 * access-only reread and one replay for this HTTP exchange. No other 401 (or
 * any other status) is an identity challenge, and a second exact challenge is
 * returned without another replay.
 */
export function createMcpProxyFetch(
  auth: McpProxyHostAuthorization,
  baseFetch: McpProxyFetch = globalThis.fetch.bind(globalThis)
): McpProxyFetch {
  let rereadState = sharedRereadStates.get(auth)
  if (!rereadState) {
    rereadState = { rereadPromise: null, adoptedBearer: null }
    sharedRereadStates.set(auth, rereadState)
  }

  const rereadAfterUnauthorized = async (observedBearer: string): Promise<void> => {
    let currentBearer = ''
    try {
      currentBearer = auth.getAccessToken().trim()
    } catch {
      throw new McpProxyAuthorizationError('host_bearer_unavailable')
    }
    // Another request may have adopted the rotation before this request
    // inspected the 401. Reuse only the value recorded by this shared
    // access-only state; an arbitrary mutation of the facade is not enough.
    if (currentBearer && currentBearer !== observedBearer) {
      if (currentBearer === rereadState.adoptedBearer) return
    }

    if (!rereadState.rereadPromise) {
      rereadState.rereadPromise = auth
        .rereadAccessToken()
        .catch(() => false)
        .finally(() => {
          rereadState!.rereadPromise = null
        })
    }
    const adopted = await rereadState.rereadPromise
    if (!adopted) {
      throw new McpProxyAuthorizationError('host_bearer_rotation_unavailable')
    }

    let nextBearer = ''
    try {
      nextBearer = auth.getAccessToken().trim()
    } catch {
      throw new McpProxyAuthorizationError('host_bearer_unavailable')
    }
    if (!nextBearer || nextBearer === observedBearer) {
      throw new McpProxyAuthorizationError('host_bearer_rotation_unavailable')
    }
    rereadState.adoptedBearer = nextBearer
  }

  return async (input, init = {}) => {
    const replayableBody = await makeReplayableBody(init.body)
    let retried = false
    for (;;) {
      const hostBearer = readHostBearer(auth)
      const headers = new Headers(init.headers)
      headers.set('Proxy-Authorization', 'Bearer ' + hostBearer)
      const requestInit: RequestInit = {
        ...init,
        headers,
        ...(replayableBody === undefined ? {} : { body: replayableBody }),
      }
      const response = await baseFetch(input, requestInit)

      if (
        response.status !== 401 ||
        response.headers.get('www-authenticate') !== MCP_PROXY_HOST_AUTH_CHALLENGE ||
        retried
      ) {
        return response
      }
      retried = true
      await response.body?.cancel().catch(() => undefined)
      await rereadAfterUnauthorized(hostBearer)
    }
  }
}
