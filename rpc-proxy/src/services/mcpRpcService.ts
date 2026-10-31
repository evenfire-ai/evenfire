import { config } from '../config.js'
import { JsonRpcError, JsonRpcRequest, JsonRpcSuccess, ResolvedServerConnection } from '../types.js'

type McpSessionCacheEntry = Readonly<{
  sessionId: string
  expiresAtMs: number
}>

/**
 * Small LRU used for upstream MCP protocol sessions. Authority-isolated v2
 * entries expire with the delegation/checkpoint ceiling that created them.
 */
export class McpSessionCache {
  private readonly entries = new Map<string, McpSessionCacheEntry>()

  constructor(
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error('MCP session cache maxEntries must be a positive integer')
    }
  }

  get size(): number {
    return this.entries.size
  }

  get(key: string, expiresAtCeilingMs = Number.POSITIVE_INFINITY): string | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    const expiresAtMs = Math.min(entry.expiresAtMs, expiresAtCeilingMs)
    if (expiresAtMs <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    // Refresh insertion order so the size cap evicts the least recently used.
    this.entries.delete(key)
    this.entries.set(key, { ...entry, expiresAtMs })
    return entry.sessionId
  }

  set(key: string, sessionId: string, expiresAtMs: number): void {
    const now = this.now()
    this.reclaimExpired(now)
    this.entries.delete(key)
    if (expiresAtMs <= now) return
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    this.entries.set(key, { sessionId, expiresAtMs })
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  reclaimExpired(now = this.now()): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs <= now) this.entries.delete(key)
    }
  }
}

const mcpSessionCache = new McpSessionCache(1_024)
const MCP_PROTOCOL_VERSION = '2024-11-05'

export type RefreshedMcpForwardingAuthority = Readonly<{
  server: ResolvedServerConnection
  authorityCacheKey: string
  authorityExpiresAt: string
}>

type ForwardRpcOptions = Readonly<{
  authorityCacheKey?: string
  authorityExpiresAt?: string
  beforeRetry?: () => Promise<RefreshedMcpForwardingAuthority>
}>

type ForwardingState = Readonly<{
  server: ResolvedServerConnection
  cacheKey: string
  cacheExpiresAtMs: number
}>

function forwardingState(
  server: ResolvedServerConnection,
  userId: string | undefined,
  options: Pick<ForwardRpcOptions, 'authorityCacheKey' | 'authorityExpiresAt'>
): ForwardingState {
  const cacheIdentity = options.authorityCacheKey ?? userId
  let cacheExpiresAtMs = Number.POSITIVE_INFINITY
  if (options.authorityCacheKey !== undefined) {
    cacheExpiresAtMs = Date.parse(options.authorityExpiresAt ?? '')
    if (!Number.isFinite(cacheExpiresAtMs)) {
      throw new Error('V2 MCP session cache requires a valid authority expiry')
    }
  }
  return {
    server,
    cacheKey: cacheIdentity ? `${cacheIdentity}::${server.url}` : server.url,
    cacheExpiresAtMs,
  }
}

export function validateRpcRequest(input: unknown): JsonRpcRequest | null {
  if (!input || typeof input !== 'object') return null
  const candidate = input as Partial<JsonRpcRequest>
  if (candidate.jsonrpc !== '2.0') return null
  if (typeof candidate.method !== 'string' || !config.allowedMethodPattern.test(candidate.method))
    return null
  const validId =
    candidate.id === null || typeof candidate.id === 'string' || typeof candidate.id === 'number'
  if (!validId) return null
  return {
    jsonrpc: '2.0',
    id: candidate.id ?? null,
    method: candidate.method,
    params: candidate.params,
  }
}

export async function forwardRpcToServer(
  server: ResolvedServerConnection,
  rpcRequest: JsonRpcRequest,
  userId?: string,
  options: ForwardRpcOptions = {}
): Promise<JsonRpcSuccess | JsonRpcError> {
  if (options.authorityCacheKey !== undefined && !options.beforeRetry) {
    throw new Error('V2 MCP forwarding requires a live-authority retry checkpoint')
  }
  const initialState = forwardingState(server, userId, options)
  function createBaseHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      // Streamable HTTP MCP servers may require both JSON and SSE in Accept.
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    }
  }

  async function parseUpstreamPayload(
    rawBody: string
  ): Promise<JsonRpcSuccess | JsonRpcError | null> {
    const trimmed = rawBody.trim()
    if (!trimmed) return null

    if (trimmed.startsWith('{')) {
      const parsed = JSON.parse(trimmed) as unknown
      if (!parsed || typeof parsed !== 'object') return null
      return parsed as JsonRpcSuccess | JsonRpcError
    }

    // Streamable MCP servers can respond in SSE format:
    // event: message
    // data: {...jsonrpc payload...}
    const dataLines = rawBody
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .filter(Boolean)
    if (dataLines.length === 0) return null

    const data = dataLines.join('\n').trim()
    if (!data.startsWith('{')) return null
    const parsed = JSON.parse(data) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as JsonRpcSuccess | JsonRpcError
  }

  async function initializeSessionIfNeeded(
    state: ForwardingState,
    baseHeaders: Record<string, string>
  ): Promise<string | null> {
    const initRequest: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: `init-${Date.now()}`,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: 'clerum-rpc-proxy',
          version: '0.1.0',
        },
      },
    }
    const response = await fetch(state.server.url, {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify(initRequest),
    })
    const raw = await response.text()
    if (!response.ok) {
      throw new Error(`MCP initialize failed (${response.status}): ${raw.slice(0, 300)}`)
    }
    const sessionId = response.headers.get('mcp-session-id')?.trim() || ''
    if (!sessionId) return null
    mcpSessionCache.set(state.cacheKey, sessionId, state.cacheExpiresAtMs)

    // Some MCP servers require this notification before regular tool calls.
    const initializedHeaders = {
      ...baseHeaders,
      'mcp-session-id': sessionId,
    }
    await fetch(state.server.url, {
      method: 'POST',
      headers: initializedHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      }),
    })

    return sessionId
  }

  async function doForward(
    state: ForwardingState,
    withSessionInitRetry: boolean
  ): Promise<JsonRpcSuccess | JsonRpcError> {
    const headers: Record<string, string> = createBaseHeaders()
    Object.assign(headers, state.server.headers)

    const cachedSessionId = mcpSessionCache.get(state.cacheKey, state.cacheExpiresAtMs)
    if (cachedSessionId) {
      headers['mcp-session-id'] = cachedSessionId
    }

    const response = await fetch(state.server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(rpcRequest),
      signal: abortController.signal,
    })

    const rawBody = await response.text()
    if (!response.ok) {
      const lower = rawBody.toLowerCase()
      const needsSession = lower.includes('session id is required')
      const invalidSession = lower.includes('invalid session')
      const genericInvalidRequest =
        response.status === 400 &&
        !cachedSessionId &&
        lower.includes('"code":-32004') &&
        lower.includes('invalid request')
      if (withSessionInitRetry && (needsSession || invalidSession || genericInvalidRequest)) {
        // The challenged session is not usable for this authority/server pair.
        mcpSessionCache.delete(state.cacheKey)
        const refreshed = await options.beforeRetry?.()
        const retryState = refreshed ? forwardingState(refreshed.server, userId, refreshed) : state
        if (!mcpSessionCache.get(retryState.cacheKey, retryState.cacheExpiresAtMs)) {
          const retryHeaders = createBaseHeaders()
          Object.assign(retryHeaders, retryState.server.headers)
          await initializeSessionIfNeeded(retryState, retryHeaders)
        }
        return doForward(retryState, false)
      }
      return {
        jsonrpc: '2.0',
        id: rpcRequest.id,
        error: {
          code: -32002,
          message: `Upstream server returned ${response.status}`,
          data: rawBody.slice(0, 500),
        },
      }
    }

    const parsed = await parseUpstreamPayload(rawBody)
    if (!parsed) {
      return {
        jsonrpc: '2.0',
        id: rpcRequest.id,
        error: {
          code: -32603,
          message: 'Invalid upstream RPC response',
        },
      }
    }
    return parsed
  }

  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), config.upstreamTimeoutMs)

  try {
    return await doForward(initialState, true)
  } finally {
    clearTimeout(timeout)
  }
}
