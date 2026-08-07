import { beforeEach, describe, expect, it, vi } from 'vitest'
import { McpClient } from '../client'

// Mock the MCP SDK transports with proper class constructors
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    connect = vi.fn().mockResolvedValue(undefined)
    close = vi.fn().mockResolvedValue(undefined)
    listTools = vi.fn().mockResolvedValue({ tools: [] })
    callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {
    close = vi.fn().mockResolvedValue(undefined)
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class MockSSE {
    close = vi.fn().mockResolvedValue(undefined)
  },
}))

describe('McpClient — reconnect deduplication', () => {
  let client: McpClient

  beforeEach(() => {
    client = new McpClient(
      {
        name: 'test-server',
        description: 'test',
        contextRef: 'ctx',
        transport: { type: 'streamableHttp', url: 'http://localhost:3000/mcp' },
        enabled: true,
        status: { deployed: true, ready: true },
      },
      undefined,
      undefined
    )
  })

  it('should deduplicate concurrent reconnect calls', async () => {
    await client.connect()

    // Spy on disconnect to count calls
    const disconnectSpy = vi.spyOn(client, 'disconnect')

    // Fire two reconnects concurrently
    const [r1, r2] = await Promise.allSettled([client.reconnect(), client.reconnect()])

    expect(r1.status).toBe('fulfilled')
    expect(r2.status).toBe('fulfilled')
    // disconnect should only be called ONCE, not twice
    expect(disconnectSpy).toHaveBeenCalledTimes(1)
  })

  it('should allow reconnect after previous reconnect completes', async () => {
    await client.connect()

    await client.reconnect()
    await client.reconnect()

    // Both should succeed (serial, not concurrent)
    expect(client.isConnected).toBe(true)
  })
})
