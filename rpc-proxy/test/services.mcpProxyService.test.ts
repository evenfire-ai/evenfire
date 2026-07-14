import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  forwardHostMessageToHost,
  forwardRpcToServer,
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
        JSON.stringify({ userId: 'user-1', hostRef: 'agent2', url: 'http://agent2.mcp-host:8080' })
      )
    )
    const host = await resolveHostConnectionForUser('user-1', 'agent2', 'rpc-token')
    expect(host).toEqual({
      name: 'agent2',
      url: 'http://agent2.mcp-host:8080',
      headers: {
        'x-clerum-edge-access-scope': 'user',
        'x-clerum-edge-caller': 'rpc-proxy',
        'x-clerum-edge-host-ref': 'agent2',
        'x-clerum-edge-user-id': 'user-1',
      },
    })
  })

  it('returns null on forbidden host resolution', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mkResponse(403, JSON.stringify({ error: 'Forbidden' }))
    )
    const host = await resolveHostConnectionForUser('user-1', 'agent2', 'rpc-token')
    expect(host).toBeNull()
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
