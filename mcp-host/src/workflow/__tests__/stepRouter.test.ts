import { describe, expect, it, vi } from 'vitest'
import {
  type McpClientConnection,
  type McpClientFactory,
  StepMcpRouter,
  StepRouterConnectionError,
  ToolDispatchError,
} from '../stepRouter'
import type { AllowedToolsConfig, StepMcpServerRef } from '../types'

describe('internal tool execution context', () => {
  it('forwards cancellation and deadline while projecting both recorded destinations', async () => {
    const execute = vi.fn(async () => ({
      success: true,
      content: 'text',
      unexpected: Buffer.from('raw'),
    }))
    const router = new StepMcpRouter(() => mockClient())
    router.registerInternalTools(
      [
        {
          name: 'clerum__read',
          description: 'read',
          parameters: { type: 'object' },
          execute,
        },
      ],
      '/output'
    )
    const signal = new AbortController().signal
    const result = await router.callTool('clerum__read', {}, { timeoutMs: 1234, signal })
    expect(execute).toHaveBeenCalledWith(
      {},
      '/output',
      expect.objectContaining({ timeoutMs: 1234, signal })
    )
    expect(result.result.content).toEqual({ success: true, content: 'text' })
    expect(result.record.result).toEqual({ success: true, content: 'text' })
  })

  it('never starts an internal tool for an already cancelled caller', async () => {
    const execute = vi.fn(async () => ({ success: true, content: 'text' }))
    const router = new StepMcpRouter(() => mockClient())
    router.registerInternalTools(
      [
        {
          name: 'clerum__read',
          description: 'read',
          parameters: { type: 'object' },
          execute,
        },
      ],
      '/output'
    )
    await expect(
      router.callTool('clerum__read', {}, { signal: AbortSignal.abort() })
    ).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled()
  })
})

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

describe('StepMcpRouter call-time allowlist (spec §3.1.2)', () => {
  const notAllowed = (toolName: string) =>
    `Tool '${toolName}' is not allowed in this step and was not run. Use only the tools provided for this step.`

  async function routerWithAllowlist(allowedTools?: AllowedToolsConfig) {
    const client = mockClient([{ name: 'read' }, { name: 'write' }])
    const execute = vi.fn(async () => ({ success: true, content: 'internal ran' }))
    const router = new StepMcpRouter(mockFactory(new Map([['srv', client]])))
    router.registerInternalTools(
      [
        {
          name: 'clerum__read_workflow',
          description: 'read',
          parameters: { type: 'object' },
          execute,
        },
        {
          name: 'clerum__list_workflows',
          description: 'list',
          parameters: { type: 'object' },
          execute,
        },
      ],
      '/output'
    )
    await router.connect([{ name: 'srv', url: 'http://srv:3000' }])
    router.setAllowedTools(allowedTools)
    return { client, execute, router }
  }

  it('returns a recoverable tool error for an MCP tool outside include and never calls the server', async () => {
    const { client, router } = await routerWithAllowlist({ include: ['srv__read'] })

    const { result, record } = await router.callTool('srv__write', { path: 'README.md' })

    const errorResult = { success: false, error: notAllowed('srv__write') }
    expect(result).toEqual({ content: errorResult, isError: true })
    expect(record).toEqual({
      serverName: 'srv',
      toolName: 'write',
      args: { path: 'README.md' },
      result: errorResult,
      durationMs: 0,
    })
    expect(client.callTool).not.toHaveBeenCalled()
  })

  it('returns a recoverable tool error for a registered internal tool outside include and never executes it', async () => {
    const { execute, router } = await routerWithAllowlist({ include: ['srv__read'] })

    const { result, record } = await router.callTool('clerum__read_workflow', {
      namespace: 'sandbox-recipes',
      name: 'other-recipe',
    })

    expect(result).toEqual({
      content: { success: false, error: notAllowed('clerum__read_workflow') },
      isError: true,
    })
    expect(record.serverName).toBe('clerum')
    expect(record.toolName).toBe('read_workflow')
    expect(execute).not.toHaveBeenCalled()
  })

  it('answers a listed name that no server registered with a tool error instead of throwing', async () => {
    const { client, router } = await routerWithAllowlist({
      include: ['srv__read', 'srv__delete', 'shell_exec'],
    })

    await expect(router.callTool('srv__delete', {})).resolves.toMatchObject({
      result: { content: { success: false, error: notAllowed('srv__delete') }, isError: true },
      record: { serverName: 'srv', toolName: 'delete' },
    })
    await expect(router.callTool('shell_exec', {})).resolves.toMatchObject({
      result: { isError: true },
      record: { serverName: 'unknown', toolName: 'shell_exec' },
    })
    expect(client.callTool).not.toHaveBeenCalled()
  })

  it('dispatches listed MCP and internal tools normally', async () => {
    const { client, execute, router } = await routerWithAllowlist({
      include: ['srv__read', 'clerum__list_workflows'],
    })

    const mcp = await router.callTool('srv__read', { q: 1 })
    const internal = await router.callTool('clerum__list_workflows', {})

    expect(client.callTool).toHaveBeenCalledWith('read', { q: 1 }, {})
    expect(mcp.result).toEqual({ content: 'result', isError: false })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(internal.result).toEqual({
      content: { success: true, content: 'internal ran' },
      isError: false,
    })
  })

  it.each<[string, AllowedToolsConfig | undefined]>([
    ['absent', undefined],
    ['empty', { include: [] }],
  ])('keeps unrestricted dispatch when include is %s', async (_label, allowedTools) => {
    const { client, execute, router } = await routerWithAllowlist(allowedTools)

    await router.callTool('srv__write', { path: 'notes.md' })
    await router.callTool('clerum__read_workflow', {})

    expect(client.callTool).toHaveBeenCalledWith('write', { path: 'notes.md' }, {})
    expect(execute).toHaveBeenCalledTimes(1)
    await expect(router.callTool('unknown__tool', {})).rejects.toThrow(ToolDispatchError)
  })

  it('still throws for an already cancelled caller before the allowlist check', async () => {
    const { client, router } = await routerWithAllowlist({ include: ['srv__read'] })

    await expect(
      router.callTool('srv__write', {}, { signal: AbortSignal.abort('step-timeout') })
    ).rejects.toThrow('step-timeout')
    expect(client.callTool).not.toHaveBeenCalled()
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
