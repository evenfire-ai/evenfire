import { describe, expect, it, vi } from 'vitest'
import type { Tool, ToolRegistry } from '../../interfaces'
import type { ToolOutput } from '../../types'
import { CompositeToolRegistry, McpToolRegistryAdapter } from '../toolRegistryAdapter'

function createMockTool(
  toolName: string,
  opts: { sanitize?: boolean; approval?: boolean; output?: string } = {}
): Tool {
  return {
    name: () => toolName,
    description: () => `Mock ${toolName}`,
    parametersSchema: () => ({ type: 'object', properties: {} }),
    execute: vi.fn(
      async (): Promise<ToolOutput> => ({
        content: opts.output ?? `${toolName} result`,
        duration_ms: 10,
        is_error: false,
      })
    ),
    requiresSanitization: () => opts.sanitize ?? true,
    requiresApproval: () => opts.approval ?? false,
  }
}

function createMockRegistry(tools: Tool[]): ToolRegistry {
  const map = new Map(tools.map(t => [t.name(), t]))
  return {
    get: (name: string) => map.get(name) ?? null,
    listDefinitions: () =>
      tools.map(t => ({
        name: t.name(),
        description: t.description(),
        parameters: t.parametersSchema(),
      })),
    register: vi.fn(),
  }
}

describe('CompositeToolRegistry', () => {
  it('should resolve native tools before MCP tools (Risk 3.5.6)', () => {
    const nativeTool = createMockTool('file_read')
    const mcpTool = createMockTool('server__file_read')

    const nativeRegistry = createMockRegistry([nativeTool])
    const mcpRegistry = createMockRegistry([mcpTool])
    const composite = new CompositeToolRegistry(nativeRegistry, mcpRegistry)

    // Native tool found by plain name
    expect(composite.get('file_read')).toBe(nativeTool)
    // MCP tool found by prefixed name
    expect(composite.get('server__file_read')).toBe(mcpTool)
  })

  it('should merge definitions from both registries', () => {
    const nativeRegistry = createMockRegistry([createMockTool('file_read')])
    const mcpRegistry = createMockRegistry([
      createMockTool('mongo__find'),
      createMockTool('mongo__insert'),
    ])
    const composite = new CompositeToolRegistry(nativeRegistry, mcpRegistry)

    const defs = composite.listDefinitions()
    expect(defs).toHaveLength(3)
    expect(defs.map(d => d.name)).toContain('file_read')
    expect(defs.map(d => d.name)).toContain('mongo__find')
  })

  it('should return provider-agnostic ToolDefinition format (Risk 4.7)', () => {
    const tool = createMockTool('search')
    const registry = createMockRegistry([tool])
    const defs = registry.listDefinitions()

    // Must have name, description, parameters — NOT provider-specific fields
    expect(defs[0]).toHaveProperty('name')
    expect(defs[0]).toHaveProperty('description')
    expect(defs[0]).toHaveProperty('parameters')
    expect(defs[0]).not.toHaveProperty('type') // Not OpenAI format
    expect(defs[0]).not.toHaveProperty('input_schema') // Not Claude format
  })
})

describe('McpToolRegistryAdapter', () => {
  it('extracts JPEG attachments from MCP content blocks', async () => {
    const mockManager = {
      getAllTools: () => [
        {
          name: 'playwright-server__browser_take_screenshot',
          description: 'Take screenshot',
          inputSchema: { type: 'object' },
          serverName: 'playwright-server',
        },
      ],
      callTool: vi.fn(async () => ({
        toolName: 'playwright-server__browser_take_screenshot',
        result: {
          content: [
            { type: 'text', text: 'Screenshot captured successfully.' },
            {
              type: 'image',
              mimeType: 'image/jpeg',
              data: 'Zm9v',
              filename: 'page.jpg',
              width: 1440,
              height: 900,
            },
          ],
        },
        isError: false,
      })),
    } as any

    const registry = new McpToolRegistryAdapter(mockManager)
    const tool = registry.get('playwright-server__browser_take_screenshot')
    expect(tool).not.toBeNull()
    expect(tool!.traceDescriptor?.({}, undefined)).toEqual({
      kind: 'mcp_server_tool',
      sourceRef: 'playwright-server',
    })

    const output = await tool!.execute({})
    expect(output.is_error).toBe(false)
    expect(output.content).toContain('Screenshot captured successfully.')
    expect(output.attachments).toHaveLength(1)
    expect(output.attachments?.[0]).toMatchObject({
      kind: 'image',
      mimeType: 'image/jpeg',
      encoding: 'base64',
      dataBase64: 'Zm9v',
      filename: 'page.jpg',
      width: 1440,
      height: 900,
      sourceTool: 'playwright-server__browser_take_screenshot',
    })
  })

  it('maps the connect_required marker to metadata.connect_required on the success path (U5)', async () => {
    const mockManager = {
      getAllTools: () => [
        {
          name: 'monday-server__list_boards',
          description: 'List boards',
          inputSchema: { type: 'object' },
          serverName: 'monday-server',
        },
      ],
      // manager.callTool returns the TYPED marker (never a flattened opaque error)
      // when a live 401 hit an oauth server.
      callTool: vi.fn(async () => ({
        toolName: 'monday-server__list_boards',
        result: { error: 'MCP server monday-server auth failed (401)' },
        isError: true,
        connectRequired: { mcpServerName: 'monday-server', provider: 'monday' },
      })),
    } as any

    const registry = new McpToolRegistryAdapter(mockManager)
    const tool = registry.get('monday-server__list_boards')
    expect(tool).not.toBeNull()

    const output = await tool!.execute({})
    // The consumer observes the typed metadata marker, not an opaque error.
    expect(output.metadata).toEqual({
      connect_required: { mcpServerName: 'monday-server', provider: 'monday' },
    })
    expect(output.is_error).toBe(true)
  })

  it('does not attach connect_required metadata for a plain (non-oauth) error result', async () => {
    const mockManager = {
      getAllTools: () => [
        {
          name: 'airtable-server__list',
          description: 'List',
          inputSchema: { type: 'object' },
          serverName: 'airtable-server',
        },
      ],
      callTool: vi.fn(async () => ({
        toolName: 'airtable-server__list',
        result: { error: 'boom' },
        isError: true,
        // no connectRequired marker
      })),
    } as any

    const registry = new McpToolRegistryAdapter(mockManager)
    const tool = registry.get('airtable-server__list')
    const output = await tool!.execute({})
    expect(output.metadata).toBeUndefined()
  })

  // ─── Principal binding (PR #319 C2/H1) ──────────────────────────────────────
  //
  // The userId the adapter forwards to `manager.callTool` (which becomes the
  // oauth grantScope='user' broker grant subject) MUST be the authenticated task
  // sender baked into the adapter at construction (taskExecutor threads
  // `task.sourceMessage.sender`), NEVER a value the model can choose. These lock
  // that the principal is the constructor identity and cannot be spoofed by a
  // tool argument named `userId`, and that two per-user adapters never cross.
  describe('principal binding — broker userId is the authenticated sender, not a tool arg', () => {
    function capturingManager(): {
      manager: unknown
      calls: Array<{ tool: string; params: Record<string, unknown>; options: unknown }>
    } {
      const calls: Array<{ tool: string; params: Record<string, unknown>; options: unknown }> = []
      const manager = {
        getAllTools: () => [
          {
            name: 'gh__do',
            description: 'demo',
            inputSchema: { type: 'object' },
            serverName: 'gh',
          },
        ],
        callTool: vi.fn(async (tool: string, params: Record<string, unknown>, options: unknown) => {
          calls.push({ tool, params, options })
          return {
            toolName: tool,
            result: { content: [{ type: 'text', text: 'ok' }] },
            isError: false,
          }
        }),
      }
      return { manager, calls }
    }

    it('forwards the constructor userId as options.userId, ignoring a spoofed `userId` arg', async () => {
      const { manager, calls } = capturingManager()
      // Adapter built for the authenticated sender "alice".
      const registry = new McpToolRegistryAdapter(manager as never, 'alice')
      const tool = registry.get('gh__do')!

      // The model supplies its own `userId` arg trying to impersonate "bob".
      await tool.execute({ userId: 'bob', foo: 1 })

      expect(calls).toHaveLength(1)
      // The broker subject is the authenticated identity, never the arg.
      expect(calls[0].options).toEqual({ userId: 'alice' })
      // The arg is still forwarded verbatim as tool params (it is data, not identity).
      expect(calls[0].params).toEqual({ userId: 'bob', foo: 1 })
    })

    it('two per-user adapters never forward each other’s userId', async () => {
      const { manager, calls } = capturingManager()
      const aliceTool = new McpToolRegistryAdapter(manager as never, 'alice').get('gh__do')!
      const bobTool = new McpToolRegistryAdapter(manager as never, 'bob').get('gh__do')!

      await aliceTool.execute({})
      await bobTool.execute({})

      expect(calls.map(c => (c.options as { userId?: string }).userId)).toEqual(['alice', 'bob'])
      // Alice's identity is emitted exactly once, only from her own adapter.
      expect(calls.filter(c => (c.options as { userId?: string }).userId === 'alice')).toHaveLength(
        1
      )
    })

    it('an absent authenticated sender forwards userId=undefined (manager fails closed)', async () => {
      const { manager, calls } = capturingManager()
      // No sender on the task → no userId (never a body/arg fallback).
      const tool = new McpToolRegistryAdapter(manager as never).get('gh__do')!

      await tool.execute({ userId: 'anyone' })

      expect(calls[0].options).toEqual({ userId: undefined })
    })
  })

  // `sourceRef` is the tool-lane guardrail's `server` identity, so a `server=` deny
  // rule matches on it. Slicing it off the display name at the first `__` truncates
  // any server whose own name contains one — the rule then fails to match, and a
  // deny that does not match lets the call through.
  it('takes the MCP server identity from the registry, not the __-sliced name', () => {
    const mockManager = {
      getAllTools: () => [
        {
          name: 'acme__tools__run_query',
          description: 'run a query',
          inputSchema: { type: 'object' },
          serverName: 'acme__tools',
        },
      ],
      callTool: vi.fn(),
    } as any

    const registry = new McpToolRegistryAdapter(mockManager)
    const tool = registry.get('acme__tools__run_query')

    expect(tool!.traceDescriptor?.({}, undefined)).toEqual({
      kind: 'mcp_server_tool',
      sourceRef: 'acme__tools', // not 'acme'
    })
  })

  it('falls back to the name prefix when the registry omits serverName', () => {
    const mockManager = {
      getAllTools: () => [
        {
          name: 'github__create_issue',
          description: 'create an issue',
          inputSchema: { type: 'object' },
        },
      ],
      callTool: vi.fn(),
    } as any

    const registry = new McpToolRegistryAdapter(mockManager)
    const tool = registry.get('github__create_issue')

    expect(tool!.traceDescriptor?.({}, undefined)).toEqual({
      kind: 'mcp_server_tool',
      sourceRef: 'github',
    })
  })

  it('uses a text summary when MCP content contains only images', async () => {
    const mockManager = {
      getAllTools: () => [
        {
          name: 'playwright-server__browser_take_screenshot',
          description: 'Take screenshot',
          inputSchema: { type: 'object' },
          serverName: 'playwright-server',
        },
      ],
      callTool: vi.fn(async () => ({
        toolName: 'playwright-server__browser_take_screenshot',
        result: {
          content: [
            {
              type: 'image',
              mimeType: 'image/jpeg',
              data: 'c2VjcmV0LWJhc2U2NA==',
            },
          ],
        },
        isError: false,
      })),
    } as any

    const registry = new McpToolRegistryAdapter(mockManager)
    const tool = registry.get('playwright-server__browser_take_screenshot')
    expect(tool).not.toBeNull()

    const output = await tool!.execute({})
    expect(output.content).toBe('Generated 1 JPEG attachment(s).')
    expect(output.content).not.toContain('c2VjcmV0LWJhc2U2NA==')
    expect(output.attachments).toHaveLength(1)
    expect(output.attachments?.[0].dataBase64).toBe('c2VjcmV0LWJhc2U2NA==')
  })
})
