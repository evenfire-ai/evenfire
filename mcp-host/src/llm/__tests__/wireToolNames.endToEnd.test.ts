/**
 * End to end: the catalog comes from a real McpManager over a faked MCP SDK,
 * the provider is the real adapter behind the real LlmPortAdapter, and the
 * returned call runs through the loop's batch executor and registry. The
 * observable result is what the remote MCP server receives.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmPortAdapter } from '../../core/adapters/llmPortAdapter'
import { McpToolRegistryAdapter } from '../../core/adapters/toolRegistryAdapter'
import type { LoopConfig } from '../../core/orchestration/loopConfig'
import { executeToolCalls } from '../../core/orchestration/toolUseLoopToolBatch'
import type { ToolDefinition } from '../../core/types'
import { McpManager } from '../../mcp/manager'
import type { LlmProvider } from '../registryCore'
import { ToolWireNameMap } from '../toolWireNames'
import { NOTION_TOOLS } from './fixtures/remoteMcpToolLists'
import {
  NOTION_SERVER,
  buildCapturingProvider,
  familyOf,
  wireToolDecls,
} from './wireToolNamesHarness'

const remote = vi.hoisted(() => ({
  calls: vi.fn(),
  tools: [] as Array<{ name: string; description: string; inputSchema: object }>,
}))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = vi.fn().mockResolvedValue(undefined)
    close = vi.fn().mockResolvedValue(undefined)
    listTools = vi.fn(async () => ({ tools: remote.tools }))
    callTool = remote.calls
  },
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    close = vi.fn().mockResolvedValue(undefined)
  },
}))

const managers: McpManager[] = []
afterEach(async () => {
  await Promise.all(managers.splice(0).map(m => m.close()))
  remote.calls.mockReset()
})

async function notionManager(extraTools: string[] = []) {
  remote.tools = [...NOTION_TOOLS.map(t => t.name), ...extraTools].map(name => ({
    name,
    description: `Notion ${name}`,
    inputSchema: { type: 'object' },
  }))
  remote.calls.mockImplementation(async (call: { name: string }) => ({
    content: [{ type: 'text', text: `ran ${call.name}` }],
  }))
  const manager = new McpManager()
  managers.push(manager)
  await manager.addServer({
    name: NOTION_SERVER,
    enabled: true,
    transport: { type: 'streamableHttp', url: 'http://notion-remote.test/mcp' },
    status: { deployed: true, ready: true },
  })
  return manager
}

function loopConfig(
  manager: McpManager,
  beforeTool = vi.fn((_name: string, _params: Record<string, unknown>) => 'proceed' as const)
): LoopConfig {
  return {
    reasoning: {} as never,
    conversation: {} as never,
    contextManager: {} as never,
    toolRegistry: new McpToolRegistryAdapter(manager, 'authenticated-user'),
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
      beforeTool,
      onExhaustion: () => '',
      refreshTools: async tools => tools,
    },
    toolOutputProcessor: {
      beforeExecution: () => ({ is_valid: true, errors: [] }),
      afterExecution: (_name, output) => output.content,
    },
    maxIterations: 10,
    toolTimeout: 5000,
    toolProgressInterval: 0,
  }
}

function catalog(manager: McpManager): ToolDefinition[] {
  return manager.getAllTools().map(t => ({
    name: t.name,
    description: t.description ?? '',
    parameters: (t.inputSchema ?? {}) as Record<string, unknown>,
  }))
}

/** One turn through the adapter: learn the wire names, then answer with `pick(names)`. */
async function turn(id: LlmProvider, tools: ToolDefinition[], pick: (names: string[]) => string) {
  const cap = buildCapturingProvider(id)
  const adapter = new LlmPortAdapter(cap.provider, 'unit-model', id)
  cap.respondWith(null)
  await adapter.completeWithTools({ messages: [{ role: 'user', content: 'q' }], tools })
  const names = wireToolDecls(familyOf(id), cap.bodies[0]).map(t => t.name)
  cap.respondWith(pick(names))
  return adapter.completeWithTools({ messages: [{ role: 'user', content: 'q' }], tools })
}

const QUERY_TOOL = 'notion-query-multiple-data-sources'
const QUERY = `${NOTION_SERVER}__${QUERY_TOOL}`

describe('alias returned by the model reaches the MCP server canonical', () => {
  it.each(['openai', 'deepseek', 'gemini', 'bedrock'] as LlmProvider[])('%s', async id => {
    const manager = await notionManager()
    const tools = catalog(manager)
    const index = tools.findIndex(t => t.name === QUERY)
    expect(index).toBeGreaterThanOrEqual(0)

    let sentAlias = ''
    const response = await turn(id, tools, names => (sentAlias = names[index]))
    expect(sentAlias).not.toBe(QUERY)
    expect(response.tool_calls?.[0]?.name).toBe(QUERY)

    const result = await executeToolCalls(response.tool_calls!, loopConfig(manager), 0)
    expect(result.toolResults[0]).toMatchObject({ is_error: false, content: `ran ${QUERY_TOOL}` })
    expect(remote.calls).toHaveBeenCalledTimes(1)
    expect(remote.calls.mock.calls[0][0].name).toBe(QUERY_TOOL)
  })

  // Every captured Notion name fits Vertex's 128, so it needs a tool past it.
  it('vertex: a 129-character tool', async () => {
    const longTool = 'x'.repeat(129 - NOTION_SERVER.length - 2)
    const longCanonical = `${NOTION_SERVER}__${longTool}`
    const manager = await notionManager([longTool])
    const tools = catalog(manager)
    const index = tools.findIndex(t => t.name === longCanonical)
    expect(index).toBeGreaterThanOrEqual(0)

    let sentAlias = ''
    const response = await turn('vertex', tools, names => (sentAlias = names[index]))
    expect(sentAlias).not.toBe(longCanonical)
    expect(response.tool_calls?.[0]?.name).toBe(longCanonical)

    const result = await executeToolCalls(response.tool_calls!, loopConfig(manager), 0)
    expect(result.toolResults[0]).toMatchObject({ is_error: false, content: `ran ${longTool}` })
    expect(remote.calls.mock.calls[0][0].name).toBe(longTool)
  })
})

describe('tool calls coming back, through the loop', () => {
  it('an invented name is not translated and the loop answers Tool not found', async () => {
    const manager = await notionManager()
    const response = await turn('deepseek', catalog(manager), () => 'inventado_xyz')
    expect(response.tool_calls?.[0]?.name).toBe('inventado_xyz')
    const result = await executeToolCalls(response.tool_calls!, loopConfig(manager), 0)
    expect(result.toolResults[0]).toMatchObject({
      is_error: true,
      content: 'Tool not found: inventado_xyz',
    })
    expect(remote.calls).not.toHaveBeenCalled()
  })

  it('a deferred tool equal to an alias resolves to the aliased tool, and approval sees that tool', async () => {
    // c2 is a real tool of the same server whose name equals the alias of c1;
    // it is not in the request, so c1 keeps that alias (accepted by design).
    const c1 = QUERY
    const alias = new ToolWireNameMap([c1], 'W').toWire(c1)
    const c2Tool = alias.slice(NOTION_SERVER.length + 2)
    const manager = await notionManager([c2Tool])
    const c2 = `${NOTION_SERVER}__${c2Tool}`
    expect(c2).toBe(alias)
    const tools = catalog(manager).filter(t => t.name !== c2)

    const response = await turn('deepseek', tools, () => c2)
    expect(response.tool_calls?.[0]?.name).toBe(c1)

    const beforeTool = vi.fn(
      (_name: string, _params: Record<string, unknown>) => 'proceed' as const
    )
    await executeToolCalls(response.tool_calls!, loopConfig(manager, beforeTool), 0)
    expect(beforeTool.mock.calls[0]?.[0]).toBe(c1)
    expect(remote.calls.mock.calls[0][0].name).toBe(QUERY_TOOL)
  })
})
