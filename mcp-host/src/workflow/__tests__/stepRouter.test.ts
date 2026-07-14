import { describe, expect, it, vi } from 'vitest'
import {
  type McpClientConnection,
  type McpClientFactory,
  StepMcpRouter,
  StepRouterConnectionError,
  ToolDispatchError,
} from '../stepRouter'
import type { StepMcpServerRef } from '../types'

// ─── Mock Factory ───────────────────────────────────────────────────────

function mockClient(
  tools: Array<{ name: string; description?: string }> = []
): McpClientConnection {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue(tools),
    callTool: vi.fn().mockResolvedValue({ content: 'result', isError: false }),
    disconnect: vi.fn().mockResolvedValue(undefined),
  }
}

function mockFactory(clients: Map<string, McpClientConnection>): McpClientFactory {
  return (server: StepMcpServerRef) => {
    const client = clients.get(server.name)
    if (!client) throw new Error(`No mock for ${server.name}`)
    return client
  }
}

describe('StepMcpRouter.connect', () => {
  it('connects to all declared servers successfully', async () => {
    const clientA = mockClient([{ name: 'tool1' }])
    const clientB = mockClient([{ name: 'tool2' }])
    const factory = mockFactory(
      new Map([
        ['serverA', clientA],
        ['serverB', clientB],
      ])
    )

    const router = new StepMcpRouter(factory)
    await router.connect([
      { name: 'serverA', url: 'http://a:3000' },
      { name: 'serverB', url: 'http://b:3000' },
    ])

    expect(clientA.connect).toHaveBeenCalled()
    expect(clientB.connect).toHaveBeenCalled()
  })

  it('throws StepRouterConnectionError when one server is unreachable', async () => {
    const clientA = mockClient()
    const clientB = mockClient()
    ;(clientB.connect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('unreachable'))
    const factory = mockFactory(
      new Map([
        ['serverA', clientA],
        ['serverB', clientB],
      ])
    )

    const router = new StepMcpRouter(factory)
    await expect(
      router.connect([
        { name: 'serverA', url: 'http://a:3000' },
        { name: 'serverB', url: 'http://b:3000' },
      ])
    ).rejects.toThrow(StepRouterConnectionError)
  })

  it('includes failed server name in StepRouterConnectionError', async () => {
    const clientA = mockClient()
    ;(clientA.connect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'))
    const factory = mockFactory(new Map([['badServer', clientA]]))

    const router = new StepMcpRouter(factory)
    try {
      await router.connect([{ name: 'badServer', url: 'http://bad:3000' }])
      expect.fail('Should have thrown')
    } catch (err) {
      expect((err as StepRouterConnectionError).failedServers).toContain('badServer')
    }
  })

  it('connects to zero servers without error (step with no MCP tools)', async () => {
    const router = new StepMcpRouter(() => mockClient())
    await expect(router.connect([])).resolves.toBeUndefined()
  })

  it('forwards caller timeout options to connect and tool discovery', async () => {
    const clientA = mockClient([{ name: 'tool1' }])
    const factory = mockFactory(new Map([['serverA', clientA]]))
    const router = new StepMcpRouter(factory)
    const controller = new AbortController()
    const options = { timeoutMs: 1_234, signal: controller.signal }

    await router.connect([{ name: 'serverA', url: 'http://a:3000' }], options)

    expect(clientA.connect).toHaveBeenCalledWith(options)
    expect(clientA.listTools).toHaveBeenCalledWith(options)
  })
})

describe('StepMcpRouter.getFilteredTools', () => {
  async function routerWithTools() {
    const clientA = mockClient([{ name: 'read' }, { name: 'write' }])
    const clientB = mockClient([{ name: 'query' }])
    const factory = mockFactory(
      new Map([
        ['db', clientA],
        ['api', clientB],
      ])
    )
    const router = new StepMcpRouter(factory)
    await router.connect([
      { name: 'db', url: 'http://db:3000' },
      { name: 'api', url: 'http://api:3000' },
    ])
    return router
  }

  it('returns all tools when allowedTools is absent', async () => {
    const router = await routerWithTools()
    const tools = router.getFilteredTools()
    expect(tools).toHaveLength(3)
  })

  it('returns all tools when allowedTools.include is empty array', async () => {
    const router = await routerWithTools()
    const tools = router.getFilteredTools({ include: [] })
    expect(tools).toHaveLength(3)
  })

  it('returns only tools matching allowedTools.include', async () => {
    const router = await routerWithTools()
    const tools = router.getFilteredTools({ include: ['db__read'] })
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('db__read')
  })

  it('prefixes tool names with serverName__toolName', async () => {
    const router = await routerWithTools()
    const tools = router.getFilteredTools()
    const names = tools.map(t => t.name)
    expect(names).toContain('db__read')
    expect(names).toContain('db__write')
    expect(names).toContain('api__query')
  })

  it('does not include tools from unrelated server when allowedTools.include is set', async () => {
    const router = await routerWithTools()
    const tools = router.getFilteredTools({ include: ['db__read'] })
    expect(tools.some(t => t.name.startsWith('api__'))).toBe(false)
  })

  it('returns tools from multiple servers merged into single list', async () => {
    const router = await routerWithTools()
    const tools = router.getFilteredTools()
    const servers = new Set(tools.map(t => t.name.split('__')[0]))
    expect(servers.size).toBe(2)
  })

  it('returns empty list when allowedTools.include has no matching tools', async () => {
    const router = await routerWithTools()
    const tools = router.getFilteredTools({ include: ['nonexistent__tool'] })
    expect(tools).toHaveLength(0)
  })
})

describe('StepMcpRouter.callTool', () => {
  it('dispatches call to correct server by prefix', async () => {
    const clientA = mockClient([{ name: 'read' }])
    const factory = mockFactory(new Map([['db', clientA]]))
    const router = new StepMcpRouter(factory)
    await router.connect([{ name: 'db', url: 'http://db:3000' }])

    await router.callTool('db__read', { table: 'users' })
    expect(clientA.callTool).toHaveBeenCalledWith('read', { table: 'users' }, {})
  })

  it('returns tool result from server', async () => {
    const client = mockClient([{ name: 'query' }])
    ;(client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: { rows: 5 },
      isError: false,
    })
    const factory = mockFactory(new Map([['db', client]]))
    const router = new StepMcpRouter(factory)
    await router.connect([{ name: 'db', url: 'http://db:3000' }])

    const { result, record } = await router.callTool('db__query', {})
    expect(result.content).toEqual({ rows: 5 })
    expect(record.serverName).toBe('db')
    expect(record.toolName).toBe('query')
    expect(record.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('throws ToolDispatchError for unknown tool name', async () => {
    const router = new StepMcpRouter(() => mockClient())
    await router.connect([])
    await expect(router.callTool('unknown__tool', {})).rejects.toThrow(ToolDispatchError)
  })
})

describe('StepMcpRouter.disconnect', () => {
  it('disconnects all connected servers', async () => {
    const clientA = mockClient([{ name: 't1' }])
    const clientB = mockClient([{ name: 't2' }])
    const factory = mockFactory(
      new Map([
        ['a', clientA],
        ['b', clientB],
      ])
    )
    const router = new StepMcpRouter(factory)
    await router.connect([
      { name: 'a', url: 'http://a:3000' },
      { name: 'b', url: 'http://b:3000' },
    ])

    await router.disconnect()
    expect(clientA.disconnect).toHaveBeenCalled()
    expect(clientB.disconnect).toHaveBeenCalled()
  })

  it('does not throw if called on unconnected router', async () => {
    const router = new StepMcpRouter(() => mockClient())
    await expect(router.disconnect()).resolves.toBeUndefined()
  })

  it('disconnects even when one server disconnect throws', async () => {
    const clientA = mockClient([{ name: 't1' }])
    const clientB = mockClient([{ name: 't2' }])
    ;(clientA.disconnect as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('disconnect fail')
    )
    const factory = mockFactory(
      new Map([
        ['a', clientA],
        ['b', clientB],
      ])
    )
    const router = new StepMcpRouter(factory)
    await router.connect([
      { name: 'a', url: 'http://a:3000' },
      { name: 'b', url: 'http://b:3000' },
    ])

    await expect(router.disconnect()).resolves.toBeUndefined()
    expect(clientB.disconnect).toHaveBeenCalled()
  })
})
