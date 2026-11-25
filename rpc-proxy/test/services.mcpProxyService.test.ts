import { beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { generateKeyPairSync } from 'node:crypto'
import { HOST_EDGE_ASSERTION_HEADER } from '@clerum/action-context-contracts'
import { config } from '../src/config.js'
import {
  forwardHostMessageToHost,
  forwardRpcToServer,
  isHeldEdgeAssertionNearExpiry,
  refreshV1HostConnection,
  resolveHostConnectionForUser,
  validateRpcRequest,
} from '../src/services/mcpProxyService.js'
import type { JsonRpcRequest, ResolvedServerConnection } from '../src/types.js'

function mkResponse(status: number, body: string, headers?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: headers || { 'content-type': 'application/json' },
  })
}

describe('services/mcpProxyService', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('accepts MCP method names with slash', () => {
    const request = validateRpcRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    })
    expect(request).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    })
  })

  it('forwards plain JSON upstream responses', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        mkResponse(200, JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }))
      )

    const server: ResolvedServerConnection = {
      name: 'mongodb-server',
      url: 'http://mongodb-server.test/mcp-json',
      headers: {},
    }
    const rpcRequest: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }

    const response = await forwardRpcToServer(server, rpcRequest)
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { ok: true },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('parses SSE upstream responses', async () => {
    const sseBody = [
      'event: message',
      'data: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"listCollections"}]}}',
      '',
    ].join('\n')
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mkResponse(200, sseBody, { 'content-type': 'text/event-stream' })
    )

    const server: ResolvedServerConnection = {
      name: 'mongodb-server',
      url: 'http://mongodb-server.test/mcp-sse',
      headers: {},
    }
    const rpcRequest: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }

    const response = await forwardRpcToServer(server, rpcRequest)
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ name: 'listCollections' }] },
    })
  })

  it('initializes MCP session then retries on session-required upstream', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      // First request fails: session required
      .mockResolvedValueOnce(
        mkResponse(
          400,
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'session id is required' },
          })
        )
      )
      // Initialize succeeds and returns session id
      .mockResolvedValueOnce(
        mkResponse(
          200,
          [
            'event: message',
            'data: {"jsonrpc":"2.0","id":"init-1","result":{"protocolVersion":"2024-11-05"}}',
            '',
          ].join('\n'),
          {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'session-123',
          }
        )
      )
      // Post-initialize notification
      .mockResolvedValueOnce(mkResponse(202, ''))
      // Retried request succeeds with session
      .mockResolvedValueOnce(
        mkResponse(
          200,
          [
            'event: message',
            'data: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"listCollections"}]}}',
            '',
          ].join('\n'),
          { 'content-type': 'text/event-stream' }
        )
      )

    const server: ResolvedServerConnection = {
      name: 'mongodb-server',
      url: 'http://mongodb-server.test/mcp-session',
      headers: {},
    }
    const rpcRequest: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }

    const response = await forwardRpcToServer(server, rpcRequest)
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ name: 'listCollections' }] },
    })
    expect(fetchMock).toHaveBeenCalledTimes(4)

    const fourthCallInit = fetchMock.mock.calls[3]?.[1]
    const headers = (fourthCallInit as RequestInit).headers as Record<string, string>
    expect(headers['mcp-session-id']).toBe('session-123')
    expect(headers['mcp-protocol-version']).toBe('2024-11-05')
  })

  it('initializes MCP session on generic invalid-request when no session exists', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      // First request fails with generic invalid request
      .mockResolvedValueOnce(
        mkResponse(
          400,
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32004, message: 'invalid request' } })
        )
      )
      // Initialize succeeds and returns session id
      .mockResolvedValueOnce(
        mkResponse(
          200,
          [
            'event: message',
            'data: {"jsonrpc":"2.0","id":"init-1","result":{"protocolVersion":"2024-11-05"}}',
            '',
          ].join('\n'),
          {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'session-abc',
          }
        )
      )
      // Post-initialize notification
      .mockResolvedValueOnce(mkResponse(202, ''))
      // Retried request succeeds
      .mockResolvedValueOnce(
        mkResponse(
          200,
          [
            'event: message',
            'data: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"listCollections"}]}}',
            '',
          ].join('\n'),
          { 'content-type': 'text/event-stream' }
        )
      )

    const server: ResolvedServerConnection = {
      name: 'mongodb-server',
      url: 'http://mongodb-server.test/mcp-invalid-request',
      headers: {},
    }
    const rpcRequest: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }

    const response = await forwardRpcToServer(server, rpcRequest)
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ name: 'listCollections' }] },
    })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('resolves host connection from control-api rpc access endpoint', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mkResponse(
        200,
        JSON.stringify({
          userId: 'user-1',
          hostRef: 'agent2',
          url: 'http://agent2.mcp-host:8080',
          edgeAssertion: 'edge-assertion-fixture',
        })
      )
    )
    const host = await resolveHostConnectionForUser('user-1', 'agent2', 'rpc-token')
    expect(host).toEqual({
      name: 'agent2',
      url: 'http://agent2.mcp-host:8080',
      headers: {
        'x-clerum-edge-assertion': 'edge-assertion-fixture',
        'x-clerum-edge-access-scope': 'user',
        'x-clerum-edge-caller': 'rpc-proxy',
        'x-clerum-edge-host-ref': 'agent2',
        'x-clerum-edge-user-id': 'user-1',
      },
    })
  })

  it('resolves a forbidden host to a non-revoking denial when control-api gives no reason', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mkResponse(403, JSON.stringify({ error: 'Forbidden' }))
    )
    const host = await resolveHostConnectionForUser('user-1', 'agent2', 'rpc-token')
    expect(host).toEqual({ denied: true, code: 'host_access_denied' })
  })

  it('forwards host message and returns REST response body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mkResponse(200, JSON.stringify({ queued: true }))
    )
    const response = await forwardHostMessageToHost(
      { name: 'agent2', url: 'http://agent2.mcp-host:8080', headers: {} },
      {
        content: 'hello',
        channelType: 'rpc',
        sender: 'desktop',
      }
    )
    expect(response).toEqual({
      queued: true,
    })
  })

  it('throws on host upstream failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mkResponse(500, JSON.stringify({ error: 'fail' }))
    )
    await expect(
      forwardHostMessageToHost(
        { name: 'agent2', url: 'http://agent2.mcp-host:8080', headers: {} },
        { content: 'hello', channelType: 'rpc', sender: 'desktop' }
      )
    ).rejects.toThrow('Upstream host returned 500')
  })
})

describe('isHeldEdgeAssertionNearExpiry', () => {
  const EDGE_KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const EXP_SECONDS = 2_000_000_000
  // The re-resolve margin: the longest a retry attempt runs, plus 2 s.
  const MARGIN_MS = config.upstreamTimeoutMs + 2_000

  function sign(payload: Record<string, unknown>): string {
    return jwt.sign(payload, EDGE_KEYS.privateKey, { algorithm: 'RS256' })
  }

  const assertion = sign({ sub: 'user-1', iat: EXP_SECONDS - 300, exp: EXP_SECONDS })

  it('is near expiry when exp is exactly the margin away', () => {
    expect(isHeldEdgeAssertionNearExpiry(assertion, EXP_SECONDS * 1000 - MARGIN_MS)).toBe(true)
  })

  it('is not near expiry 1 ms outside the margin', () => {
    expect(isHeldEdgeAssertionNearExpiry(assertion, EXP_SECONDS * 1000 - MARGIN_MS - 1)).toBe(false)
  })

  it('is near expiry once exp has passed', () => {
    expect(isHeldEdgeAssertionNearExpiry(assertion, EXP_SECONDS * 1000 + 1)).toBe(true)
  })

  it.each([
    { label: 'a value that is not a JWT', value: 'edge-assertion-fixture' },
    { label: 'a JWT without exp', value: sign({ sub: 'user-1', iat: EXP_SECONDS - 300 }) },
    { label: 'no assertion', value: undefined },
  ])('throws for $label', ({ value }) => {
    expect(() => isHeldEdgeAssertionNearExpiry(value, EXP_SECONDS * 1000)).toThrow(
      'Held edge assertion has no readable exp'
    )
  })
})

describe('V1 Host resolve: thrown and unavailable control-api answers', () => {
  const EDGE_KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const USER_ID = 'user-secret-id-1'
  const TOKEN = 'rpc-token-secret-1'
  const LINE_PREFIX = '[RPC_PROXY] control-api host resolve unavailable'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // A body that fails while it is read, with a timeout: what undici does when
  // the request deadline fires after the headers arrived.
  function bodyReadTimeout(): Response {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(
          new DOMException('body-read-detail: aborted due to timeout', 'TimeoutError')
        )
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const THROWN_CASES = [
    {
      label: 'a network failure',
      fetch: () =>
        Promise.reject(
          new TypeError('network-detail: fetch failed', { cause: { code: 'ECONNREFUSED' } })
        ),
      cause: 'request_failed',
      error: 'TypeError code=ECONNREFUSED',
      detail: 'network-detail',
    },
    {
      label: 'a timeout',
      fetch: () =>
        Promise.reject(new DOMException('timeout-detail: aborted due to timeout', 'TimeoutError')),
      cause: 'timeout',
      error: 'TimeoutError',
      detail: 'timeout-detail',
    },
    {
      label: 'a non-JSON 200',
      fetch: () =>
        Promise.resolve(
          new Response('<html>html-detail</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })
        ),
      cause: 'request_failed',
      error: 'SyntaxError',
      detail: 'html-detail',
    },
    {
      label: 'a body-read timeout',
      fetch: () => Promise.resolve(bodyReadTimeout()),
      cause: 'timeout',
      error: 'TimeoutError',
      detail: 'body-read-detail',
    },
  ] as const

  function resolveLines(warn: { mock: { calls: unknown[][] } }): string[] {
    return warn.mock.calls.map(args => String(args[0])).filter(line => line.startsWith(LINE_PREFIX))
  }

  function expectNoSecret(line: string, detail: string): void {
    expect(line).not.toContain(USER_ID)
    expect(line).not.toContain(TOKEN)
    expect(line).not.toContain(detail)
  }

  function nearExpiryHost(): ResolvedServerConnection {
    const exp = Math.floor(Date.now() / 1000) + 1
    return {
      name: 'agent2',
      url: 'http://agent2.mcp-host:8080',
      headers: {
        [HOST_EDGE_ASSERTION_HEADER]: jwt.sign(
          { sub: USER_ID, iat: exp - 300, exp },
          EDGE_KEYS.privateKey,
          { algorithm: 'RS256' }
        ),
      },
    }
  }

  it.each(THROWN_CASES)(
    'resolveHostConnectionForUser returns unavailable when the control-api call throws: $label',
    async ({ fetch, cause, error, detail }) => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(fetch)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

      const resolved = await resolveHostConnectionForUser(USER_ID, 'agent2', TOKEN)

      expect(fetchMock).toHaveBeenCalledOnce()
      expect(resolved).toEqual({ unavailable: true, cause })
      // Exactly one line: it is also the witness that the catch ran.
      const lines = resolveLines(warn)
      expect(lines).toEqual([
        `${LINE_PREFIX} phase=resolve host=agent2 cause=${cause} error=${error}`,
      ])
      expectNoSecret(lines[0]!, detail)
    }
  )

  it.each(THROWN_CASES)(
    'refreshV1HostConnection returns unavailable when the control-api call throws: $label',
    async ({ fetch, cause, error, detail }) => {
      const host = nearExpiryHost()
      const heldAssertion = host.headers[HOST_EDGE_ASSERTION_HEADER]
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(fetch)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

      const refusal = await refreshV1HostConnection(host, USER_ID, 'agent2', TOKEN)

      expect(fetchMock).toHaveBeenCalledOnce()
      expect(refusal).toEqual({ unavailable: true, cause })
      expect(host.headers[HOST_EDGE_ASSERTION_HEADER]).toBe(heldAssertion)
      const lines = resolveLines(warn)
      expect(lines).toEqual([
        `${LINE_PREFIX} phase=re-resolve host=agent2 cause=${cause} error=${error}`,
      ])
      expectNoSecret(lines[0]!, detail)
    }
  )

  it('resolveHostConnectionForUser logs one line for a returned http_status 503', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mkResponse(503, JSON.stringify({ error: 'status-detail' })))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const resolved = await resolveHostConnectionForUser(USER_ID, 'agent2', TOKEN)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(resolved).toEqual({ unavailable: true, cause: 'http_status', status: 503 })
    const lines = resolveLines(warn)
    expect(lines).toEqual([`${LINE_PREFIX} phase=resolve host=agent2 cause=http_status status=503`])
    expectNoSecret(lines[0]!, 'status-detail')
  })

  it('refreshV1HostConnection logs one line for a returned http_status 503', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mkResponse(503, JSON.stringify({ error: 'status-detail' })))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const refusal = await refreshV1HostConnection(nearExpiryHost(), USER_ID, 'agent2', TOKEN)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(refusal).toEqual({ unavailable: true, cause: 'http_status', status: 503 })
    const lines = resolveLines(warn)
    expect(lines).toEqual([
      `${LINE_PREFIX} phase=re-resolve host=agent2 cause=http_status status=503`,
    ])
    expectNoSecret(lines[0]!, 'status-detail')
  })
})
