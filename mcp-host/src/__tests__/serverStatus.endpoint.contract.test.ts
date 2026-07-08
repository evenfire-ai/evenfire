import { describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'
import type { StatusResponse } from '../server/types'

type StartResult = { server: any; baseUrl: string }

async function startServer(configure?: (server: any) => void): Promise<StartResult> {
  process.env.CLERUM_ENABLE_AUTH = 'false'
  process.env.CLERUM_HOST_NAME = 'chatllm'
  vi.resetModules()
  const { RPCServer } = await import('../server')
  const server = new RPCServer(0)
  if (configure) configure(server)
  await server.start()
  const address = (server as unknown as { server: { address: () => AddressInfo } }).server.address()
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

const rpcEdgeHeaders = {
  'x-clerum-edge-caller': 'rpc-proxy',
  'x-clerum-edge-host-ref': 'chatllm',
  'x-clerum-edge-user-id': 'user-1',
}

describe('GET /v1/runtime/status — mcpServers contract', () => {
  it('echoes the mcpServers payload verbatim', async () => {
    const observedAt = '2026-04-21T18:00:00.000Z'
    const mcpServers = [
      {
        name: 'mcp-coingecko-remote',
        state: 'failed' as const,
        expected: true,
        toolCount: 0,
        reason: 'auth_failed' as const,
        message: 'initialize returned 401',
        observedAt,
      },
      {
        name: 'mcp-alphavantage-remote',
        state: 'connected' as const,
        expected: true,
        toolCount: 5,
        reason: null,
        message: null,
        observedAt,
      },
    ]

    const onStatus = vi.fn(
      async (): Promise<StatusResponse> => ({
        agent: {
          state: 'idle',
          currentTaskId: null,
          tasksProcessed: 0,
          tasksSucceeded: 0,
          tasksFailed: 0,
          uptime: 1,
        },
        queue: { pending: 0, processing: 0, completed: 0, failed: 0 },
        cronJobs: 0,
        mcpServers,
      })
    )

    const { server, baseUrl } = await startServer(rpcServer => {
      rpcServer.onStatus(onStatus)
    })

    try {
      const res = await fetch(`${baseUrl}/v1/runtime/status`, { headers: rpcEdgeHeaders })
      expect(res.status).toBe(200)
      const body = (await res.json()) as StatusResponse
      expect(body.mcpServers).toEqual(mcpServers)
    } finally {
      await server.stop()
    }
  })

  it('accepts status responses that omit mcpServers (backward compat)', async () => {
    const onStatus = vi.fn(
      async (): Promise<StatusResponse> => ({
        agent: {
          state: 'idle',
          currentTaskId: null,
          tasksProcessed: 0,
          tasksSucceeded: 0,
          tasksFailed: 0,
          uptime: 1,
        },
        queue: { pending: 0, processing: 0, completed: 0, failed: 0 },
        cronJobs: 0,
      })
    )

    const { server, baseUrl } = await startServer(rpcServer => {
      rpcServer.onStatus(onStatus)
    })

    try {
      const res = await fetch(`${baseUrl}/v1/runtime/status`, { headers: rpcEdgeHeaders })
      const body = (await res.json()) as StatusResponse
      expect(body.mcpServers).toBeUndefined()
    } finally {
      await server.stop()
    }
  })
})
