import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpToolRegistryAdapter } from '../../core/adapters/toolRegistryAdapter'
import type { LoopConfig } from '../../core/orchestration/loopConfig'
import { executeToolCalls } from '../../core/orchestration/toolUseLoopToolBatch'
import { McpManager } from '../manager'

// Mock only the remote SDK boundary. Registry, manager admission, catalog
// prefixing and McpClient dispatch execute their real implementations.
const remote = vi.hoisted(() => ({ calls: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = vi.fn().mockResolvedValue(undefined)
    close = vi.fn().mockResolvedValue(undefined)
    listTools = vi.fn().mockResolvedValue({
      tools: [
        {
          name: 'workitem__read__receipt',
          description: 'Read receipt',
          inputSchema: { type: 'object' },
        },
        { name: 'simple', description: 'Simple read', inputSchema: { type: 'object' } },
      ],
    })
    callTool = remote.calls
  },
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    close = vi.fn().mockResolvedValue(undefined)
  },
}))

const managers: McpManager[] = []
async function connectedManager() {
  const manager = new McpManager()
  managers.push(manager)
  remote.calls.mockResolvedValue({ content: [{ type: 'text', text: 'receipt-observed' }] })
  await manager.addServer({
    name: 'approved-service',
    contextRef: 'fixture-context',
    enabled: true,
    transport: { type: 'streamableHttp', url: 'http://approved-service.test/mcp' },
    status: { deployed: true, ready: true },
  })
  return manager
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()))
  remote.calls.mockReset()
})

describe('MCP delimiter dispatch', () => {
  it('dispatches every listed tool with its complete remote name', async () => {
    const manager = await connectedManager()
    const catalog = manager.getAllTools()
    expect(catalog.map(tool => tool.name)).toContain('approved-service__workitem__read__receipt')
    for (const tool of catalog) {
      const result = await manager.callTool(tool.name, {})
      expect(result.isError).toBe(false)
      expect(result.toolName).toBe(tool.name)
    }
    expect(remote.calls.mock.calls.map(call => call[0].name)).toEqual([
      'workitem__read__receipt',
      'simple',
    ])
  })

  it('executes the exact approved name through the real registry adapter', async () => {
    const manager = await connectedManager()
    const registry = new McpToolRegistryAdapter(manager, 'authenticated-sender')
    const tool = registry.get('approved-service__workitem__read__receipt')!
    expect(tool).not.toBeNull()
    expect(tool.traceDescriptor?.({})).toMatchObject({ sourceRef: 'approved-service' })
    const output = await tool.execute({})
    expect(output.is_error).toBe(false)
    expect(output.content).toBe('receipt-observed')
    expect(remote.calls.mock.calls[0][0].name).toBe('workitem__read__receipt')
  })

  it('preserves the exact name and call ID through bridge resolution and execution', async () => {
    const manager = await connectedManager()
    const registry = new McpToolRegistryAdapter(manager, 'authenticated-sender')
    const beforeExecution = vi.fn((_name: string, _params: Record<string, unknown>) => ({
      is_valid: true,
      errors: [],
    }))
    const config: LoopConfig = {
      reasoning: {} as never,
      conversation: {} as never,
      contextManager: {} as never,
      toolRegistry: registry,
      safety: {
        validateInput: () => ({ is_valid: true, errors: [] }),
        validateToolParams: () => ({ is_valid: true, errors: [] }),
        sanitizeOutput: (_name, content) => ({ content, was_modified: false, warnings: [] }),
        wrapForLlm: (_name, content) => content,
      },
      events: { emit: () => {}, on: () => {}, off: () => {} },
      loopController: {
        shouldAccept: () => true,
        onTextRejected: () => null,
        beforeTool: () => 'proceed',
        onExhaustion: () => '',
        refreshTools: async tools => tools,
      },
      toolOutputProcessor: { beforeExecution, afterExecution: (_name, output) => output.content },
      maxIterations: 10,
      toolTimeout: 5000,
      toolProgressInterval: 0,
      bridge: {
        nativeNames: new Set(['clerum__tool_call']),
        getDeferrableCatalogNames: () => new Set(manager.getAllTools().map(tool => tool.name)),
      },
    }
    const results = await executeToolCalls(
      [
        {
          id: 'selected-call',
          name: 'clerum__tool_call',
          arguments: { name: 'approved-service__workitem__read__receipt', arguments: {} },
        },
      ],
      config,
      0
    )
    expect(results).toMatchObject({
      toolResults: [{ tool_call_id: 'selected-call', is_error: false }],
    })
    expect(beforeExecution.mock.calls[0][0]).toBe('approved-service__workitem__read__receipt')
    expect(remote.calls.mock.calls[0][0].name).toBe('workitem__read__receipt')
  })

  it.each(['missing-delimiter', '__read', 'approved-service__', ''])(
    'rejects invalid namespace %s without dispatch',
    async name => {
      const manager = await connectedManager()
      const result = await manager.callTool(name, {})
      expect(result.isError).toBe(true)
      expect(result.result).toMatchObject({
        error: expect.stringContaining('Invalid tool name format'),
      })
      expect(remote.calls).not.toHaveBeenCalled()
    }
  )

  it('does not turn an unregistered namespace into an admitted client', async () => {
    const manager = await connectedManager()
    const result = await manager.callTool('unapproved-service__workitem__read', {})
    expect(result.isError).toBe(true)
    expect(result.result).toMatchObject({ error: 'MCP server not found: unapproved-service' })
    expect(remote.calls).not.toHaveBeenCalled()
  })
})
