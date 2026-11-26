import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { withRpcProxyEdgeTestAuthentication } from './rpcProxyEdgeTestHeaders'

const originalEnv = new Map<string, string | undefined>()
const envKeys = ['CLERUM_ENABLE_AUTH', 'CLERUM_HOST_NAME', 'CLERUM_NAMESPACE']

beforeAll(() => {
  for (const key of envKeys) originalEnv.set(key, process.env[key])
})

afterAll(() => {
  for (const key of envKeys) {
    const value = originalEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.resetModules()
})

async function withServer(
  run: (
    baseUrl: string,
    search: ReturnType<typeof vi.fn>,
    sessionsList: ReturnType<typeof vi.fn>
  ) => Promise<void>
) {
  process.env.CLERUM_ENABLE_AUTH = 'true'
  process.env.CLERUM_HOST_NAME = 'chatllm'
  process.env.CLERUM_NAMESPACE = 'mcp-host'
  vi.resetModules()
  const { RPCServer } = await import('../server')
  const server = new RPCServer(0)
  const search = vi.fn(async ({ userSub }: { userSub: string }) => ({
    results: [
      {
        snippet: userSub,
        session_id: 'session-1',
        timestamp: '2026-10-05T00:00:00Z',
        channel: 'rpc',
        role: 'user',
      },
    ],
    total: 1,
  }))
  const sessionsList = vi.fn().mockResolvedValue({ sessions: [], nextCursor: null })
  server.onSessionSearch(search)
  server.onSessionsList(sessionsList)
  await server.start()
  const address = (server as unknown as { server: { address: () => AddressInfo } }).server.address()
  try {
    await run(`http://127.0.0.1:${address.port}`, search, sessionsList)
  } finally {
    await server.stop()
    vi.resetModules()
  }
}

const edgeHeaders = {
  'x-clerum-edge-caller': 'rpc-proxy',
  'x-clerum-edge-host-ref': 'chatllm',
  'x-clerum-edge-user-id': 'alice-user',
}

describe('mounted session-search authority', () => {
  it('refuses legacy actor headers, signed or not, as missing V2 authority', async () => {
    await withServer(async (baseUrl, search, sessionsList) => {
      for (const headers of [edgeHeaders, withRpcProxyEdgeTestAuthentication(edgeHeaders)]) {
        const response = await fetch(`${baseUrl}/v1/runtime/sessions/search?q=budget`, {
          headers,
        })
        expect(response.status).toBe(401)
        expect(await response.json()).toEqual({ error: 'V2 runtime authority required' })
      }
      expect(search).not.toHaveBeenCalled()

      // Witness: the same signed headers open the V1 sessions route.
      const list = await fetch(`${baseUrl}/v1/runtime/sessions`, {
        headers: withRpcProxyEdgeTestAuthentication(edgeHeaders),
      })
      expect(list.status).toBe(200)
      expect(sessionsList).toHaveBeenCalledTimes(1)
    })
  })

  it('sends a declared V2 request through the strict edge guard', async () => {
    await withServer(async (baseUrl, search, sessionsList) => {
      const response = await fetch(`${baseUrl}/v1/runtime/sessions/search?q=budget`, {
        headers: {
          'x-clerum-edge-caller': 'rpc-proxy',
          'x-clerum-edge-host-ref': 'chatllm',
          'x-clerum-edge-action-context': 'malformed-v2-envelope',
        },
      })
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'Missing runtime edge caller context' })
      expect(search).not.toHaveBeenCalled()

      const list = await fetch(`${baseUrl}/v1/runtime/sessions`, {
        headers: withRpcProxyEdgeTestAuthentication(edgeHeaders),
      })
      expect(list.status).toBe(200)
      expect(sessionsList).toHaveBeenCalledTimes(1)
    })
  })
})
