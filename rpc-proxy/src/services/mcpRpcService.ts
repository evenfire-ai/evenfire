import { config } from '../config.js'
import { JsonRpcError, JsonRpcRequest, JsonRpcSuccess, ResolvedServerConnection } from '../types.js'

const mcpSessionByServerUrl = new Map<string, string>()
const MCP_PROTOCOL_VERSION = '2024-11-05'

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
  userId?: string
): Promise<JsonRpcSuccess | JsonRpcError> {
  const cacheKey = userId ? `${userId}::${server.url}` : server.url
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
    const response = await fetch(server.url, {
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
    mcpSessionByServerUrl.set(cacheKey, sessionId)

    // Some MCP servers require this notification before regular tool calls.
    const initializedHeaders = {
      ...baseHeaders,
      'mcp-session-id': sessionId,
    }
    await fetch(server.url, {
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

  async function doForward(withSessionInitRetry: boolean): Promise<JsonRpcSuccess | JsonRpcError> {
    const headers: Record<string, string> = createBaseHeaders()
    Object.assign(headers, server.headers)

    const cachedSessionId = mcpSessionByServerUrl.get(cacheKey)
    if (cachedSessionId) {
      headers['mcp-session-id'] = cachedSessionId
    }

    const response = await fetch(server.url, {
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
        if (invalidSession) {
          mcpSessionByServerUrl.delete(cacheKey)
        }
        await initializeSessionIfNeeded(headers)
        return doForward(false)
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
    return await doForward(true)
  } finally {
    clearTimeout(timeout)
  }
}
