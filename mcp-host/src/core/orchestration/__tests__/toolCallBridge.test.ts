import { describe, expect, it } from 'vitest'
import type {
  AgentEventEmitter,
  LoopController,
  Safety,
  Tool,
  ToolRegistry,
} from '../../interfaces'
import type { PendingApproval, ToolCall, ToolDefinition, ToolOutput } from '../../types'
import type { LoopConfig } from '../loopConfig'
import { executeToolCalls } from '../toolUseLoopToolBatch'

// ── Stubs ──────────────────────────────────────────────────────────────────

class StubTool implements Tool {
  public calls: Record<string, unknown>[] = []
  constructor(
    private readonly _name: string,
    private readonly output: ToolOutput = { content: 'ok', duration_ms: 1, is_error: false }
  ) {}
  name(): string {
    return this._name
  }
  description(): string {
    return `${this._name} desc`
  }
  parametersSchema(): Record<string, unknown> {
    return { type: 'object', properties: {} }
  }
  requiresSanitization(): boolean {
    return false
  }
  requiresApproval(): boolean {
    return false
  }
  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    this.calls.push(params)
    return this.output
  }
}

function registry(tools: Record<string, Tool>): ToolRegistry {
  return {
    get: (name: string) => tools[name] ?? null,
    listDefinitions: (): ToolDefinition[] =>
      Object.values(tools).map(t => ({
        name: t.name(),
        description: t.description(),
        parameters: t.parametersSchema(),
      })),
    register: () => {},
  }
}

const noopEvents: AgentEventEmitter = { emit: () => {}, on: () => {}, off: () => {} }

const noopSafety: Safety = {
  validateInput: () => ({ is_valid: true, errors: [] }),
  validateToolParams: () => ({ is_valid: true, errors: [] }),
  sanitizeOutput: (_n, output) => ({ content: output, was_modified: false, warnings: [] }),
  wrapForLlm: (_n, content) => content,
}

interface BuildConfigOpts {
  tools: Record<string, Tool>
  loopController?: LoopController
  bridge?: LoopConfig['bridge']
  // Validation hook to exercise inner-arg validation against the real schema.
  beforeExecution?: (name: string, params: Record<string, unknown>) => boolean
  invalidNames?: Set<string>
  progressReporter?: LoopConfig['progressReporter']
}

function makeConfig(opts: BuildConfigOpts): LoopConfig {
  const passthrough: LoopController = {
    shouldAccept: () => true,
    onTextRejected: () => null,
    beforeTool: () => 'proceed',
    onExhaustion: () => '',
    refreshTools: async t => t,
  }
  return {
    reasoning: {} as never,
    toolRegistry: registry(opts.tools),
    safety: noopSafety,
    events: noopEvents,
    conversation: {} as never,
    loopController: opts.loopController ?? passthrough,
    contextManager: {} as never,
    toolOutputProcessor: {
      beforeExecution: (name: string, params: Record<string, unknown>) => {
        const ok = opts.beforeExecution ? opts.beforeExecution(name, params) : true
        return ok
          ? { is_valid: true, errors: [] }
          : { is_valid: false, errors: ['invalid for real schema'] }
      },
      afterExecution: (_n, out) => out.content,
    },
    maxIterations: 10,
    toolTimeout: 5000,
    toolProgressInterval: 0,
    bridge: opts.bridge,
    progressReporter: opts.progressReporter,
  }
}

/** Records the ordered stream of tool-card lifecycle events (start/complete). */
function recordingReporter(): {
  reporter: LoopConfig['progressReporter']
  events: Array<{ kind: 'start' | 'complete'; toolCallId: string; isError?: boolean }>
} {
  const events: Array<{ kind: 'start' | 'complete'; toolCallId: string; isError?: boolean }> = []
  const reporter = {
    reportToolStart: (e: { toolCallId: string }) =>
      events.push({ kind: 'start', toolCallId: e.toolCallId }),
    reportToolComplete: (e: { toolCallId: string; isError: boolean }) =>
      events.push({ kind: 'complete', toolCallId: e.toolCallId, isError: e.isError }),
    reportToolProgress: () => {},
    reportThinking: () => {},
    reportLlmInProgress: () => {},
  } as unknown as LoopConfig['progressReporter']
  return { reporter, events }
}

function bridgeContext(nativeNames: string[], deferrable: string[]): LoopConfig['bridge'] {
  return {
    nativeNames: new Set(nativeNames),
    getDeferrableCatalogNames: () => new Set(deferrable),
  }
}

const NATIVE = ['shell_exec', 'clerum__tool_search', 'clerum__tool_describe', 'clerum__tool_call']

function bridgeCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name: 'clerum__tool_call', arguments: { name, arguments: args } }
}

/** A tool whose execute() returns a connect_required marker (as toolRegistryAdapter would). */
class ConnectRequiredTool implements Tool {
  constructor(private readonly _name: string) {}
  name(): string {
    return this._name
  }
  description(): string {
    return `${this._name} desc`
  }
  parametersSchema(): Record<string, unknown> {
    return { type: 'object', properties: {} }
  }
  requiresSanitization(): boolean {
    return false
  }
  requiresApproval(): boolean {
    return false
  }
  async execute(): Promise<ToolOutput> {
    return {
      content: 'MCP server monday auth failed (401)',
      duration_ms: 1,
      is_error: true,
      metadata: { connect_required: { mcpServerName: 'monday' } },
    }
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('U5 — connect_required inline suspension (auto-approved / cron path)', () => {
  it('turns a connect_required tool result into a durable connect suspension', async () => {
    const config = makeConfig({
      tools: { monday__list_boards: new ConnectRequiredTool('monday__list_boards') },
    })
    const { toolResults, pendingApproval } = await executeToolCalls(
      [{ id: 'call-1', name: 'monday__list_boards', arguments: { limit: 5 } }],
      config,
      0,
      [{ role: 'user', content: 'list boards' }]
    )

    // A connect_required suspension is raised (not fed to the LLM as an error).
    expect(pendingApproval).toBeDefined()
    expect(pendingApproval).toMatchObject({
      reason: 'connect_required',
      mcpServerName: 'monday',
      tool_name: 'monday__list_boards',
      tool_call_id: 'call-1',
    })
    // The failed connect result is NOT pushed (the tool re-executes fresh on resume).
    expect(toolResults.find(r => r.tool_call_id === 'call-1')).toBeUndefined()
  })

  it('closes the tool card (start→complete) before suspending — no dangling "running" step', async () => {
    const { reporter, events } = recordingReporter()
    const config = makeConfig({
      tools: { monday__list_boards: new ConnectRequiredTool('monday__list_boards') },
      progressReporter: reporter,
    })
    const { pendingApproval } = await executeToolCalls(
      [{ id: 'call-1', name: 'monday__list_boards', arguments: {} }],
      config,
      0,
      [{ role: 'user', content: 'list boards' }]
    )

    expect(pendingApproval?.reason).toBe('connect_required')
    // Observable event sequence: the start is closed by a matching complete
    // BEFORE the (later) suspended event — no step card left "running". This
    // mirrors the resume path (taskExecutor emits reportToolComplete before its
    // own connect check).
    expect(events).toEqual([
      { kind: 'start', toolCallId: 'call-1' },
      { kind: 'complete', toolCallId: 'call-1', isError: true },
    ])
  })

  it('leaves following batch calls unexecuted with a synthetic not-executed result', async () => {
    const config = makeConfig({
      tools: {
        monday__list_boards: new ConnectRequiredTool('monday__list_boards'),
        server__other: new StubTool('server__other'),
      },
    })
    const { toolResults, pendingApproval } = await executeToolCalls(
      [
        { id: 'call-1', name: 'monday__list_boards', arguments: {} },
        { id: 'call-2', name: 'server__other', arguments: {} },
      ],
      config,
      0,
      [{ role: 'user', content: 'do both' }]
    )
    expect(pendingApproval?.reason).toBe('connect_required')
    const other = toolResults.find(r => r.tool_call_id === 'call-2')
    expect(other?.is_error).toBe(true)
    expect(other?.content).toContain('Not executed')
  })
})

describe('clerum__tool_call bridge intercept', () => {
  it('unwraps to the real tool, preserving call.id on the result', async () => {
    const real = new StubTool('server__do_thing')
    const config = makeConfig({
      tools: { server__do_thing: real },
      bridge: bridgeContext(NATIVE, ['server__do_thing']),
    })
    const { toolResults } = await executeToolCalls(
      [bridgeCall('call-1', 'server__do_thing', { a: 1 })],
      config,
      0
    )
    expect(real.calls).toEqual([{ a: 1 }])
    expect(toolResults).toHaveLength(1)
    // id preserved end-to-end so the provider pairs the result with the
    // model's clerum__tool_call tool_use block.
    expect(toolResults[0].tool_call_id).toBe('call-1')
    expect(toolResults[0].is_error).toBe(false)
  })

  it('runs approval against the REAL name, not clerum__tool_call (auto-approve keyed on real name)', async () => {
    const real = new StubTool('server__mutate')
    const seen: string[] = []
    const controller: LoopController = {
      shouldAccept: () => true,
      onTextRejected: () => null,
      beforeTool: (name: string) => {
        seen.push(name)
        // Suspend unless the REAL tool was auto-approved.
        if (name === 'server__mutate') {
          const approval: PendingApproval = {
            request_id: 'r1',
            tool_name: name,
            parameters: {},
            description: '',
            tool_call_id: '',
            context_snapshot: [],
          }
          return { type: 'suspend', approval }
        }
        return 'proceed'
      },
      onExhaustion: () => '',
      refreshTools: async t => t,
    }
    const config = makeConfig({
      tools: { server__mutate: real },
      loopController: controller,
      bridge: bridgeContext(NATIVE, ['server__mutate']),
    })
    const { pendingApproval } = await executeToolCalls(
      [bridgeCall('call-2', 'server__mutate', {})],
      config,
      0
    )
    // Approval gate received the REAL name, never clerum__tool_call.
    expect(seen).toEqual(['server__mutate'])
    expect(pendingApproval?.tool_name).toBe('server__mutate')
    // Real tool did NOT execute (suspended).
    expect(real.calls).toHaveLength(0)
  })

  it('rejects recursion: target is a native or another bridge tool', async () => {
    const config = makeConfig({
      tools: {},
      bridge: bridgeContext(NATIVE, ['server__x']),
    })
    for (const target of ['shell_exec', 'clerum__tool_call', 'clerum__tool_search']) {
      const { toolResults } = await executeToolCalls([bridgeCall('c', target, {})], config, 0)
      expect(toolResults[0].is_error).toBe(true)
      expect(toolResults[0].tool_call_id).toBe('c')
      expect(toolResults[0].content).toMatch(/cannot target/)
    }
  })

  it('scope gate rejects an out-of-catalog target without executing', async () => {
    const real = new StubTool('server__do_thing')
    const config = makeConfig({
      tools: { server__do_thing: real },
      bridge: bridgeContext(NATIVE, ['server__other']), // target not in catalog
    })
    const { toolResults } = await executeToolCalls(
      [bridgeCall('c', 'server__do_thing', {})],
      config,
      0
    )
    expect(toolResults[0].is_error).toBe(true)
    expect(toolResults[0].content).toMatch(/not in the current tool catalog/)
    expect(real.calls).toHaveLength(0)
  })

  it('malformed args (missing name) → clean error, no execution', async () => {
    const config = makeConfig({
      tools: {},
      bridge: bridgeContext(NATIVE, ['server__x']),
    })
    const call: ToolCall = { id: 'c', name: 'clerum__tool_call', arguments: { arguments: {} } }
    const { toolResults } = await executeToolCalls([call], config, 0)
    expect(toolResults[0].is_error).toBe(true)
    expect(toolResults[0].content).toMatch(/requires a string `name`/)
  })

  it('rejects array inner `arguments` (must be an object), no execution', async () => {
    const real = new StubTool('server__do_thing')
    const config = makeConfig({
      tools: { server__do_thing: real },
      bridge: bridgeContext(NATIVE, ['server__do_thing']),
    })
    const call: ToolCall = {
      id: 'c',
      name: 'clerum__tool_call',
      arguments: { name: 'server__do_thing', arguments: [1, 2] },
    }
    const { toolResults } = await executeToolCalls([call], config, 0)
    expect(toolResults[0].is_error).toBe(true)
    expect(toolResults[0].content).toMatch(/must be an object/)
    expect(real.calls).toHaveLength(0)
  })

  it('validates inner args against the REAL tool schema (Critical #12)', async () => {
    const real = new StubTool('server__strict')
    const config = makeConfig({
      tools: { server__strict: real },
      bridge: bridgeContext(NATIVE, ['server__strict']),
      // Reject any params for the real tool.
      beforeExecution: name => name !== 'server__strict',
    })
    const { toolResults } = await executeToolCalls(
      [bridgeCall('c', 'server__strict', { bad: true })],
      config,
      0
    )
    // beforeExecution fired against the REAL name and blocked it.
    expect(toolResults[0].is_error).toBe(true)
    expect(toolResults[0].content).toMatch(/validation failed/)
    expect(real.calls).toHaveLength(0)
  })
})

describe('auto-recover: direct call to a deferred MCP tool', () => {
  it('executes an un-advertised but in-catalog MCP tool directly through the gate', async () => {
    const real = new StubTool('server__direct')
    const config = makeConfig({
      tools: { server__direct: real },
      bridge: bridgeContext(NATIVE, ['server__direct']),
    })
    const { toolResults } = await executeToolCalls(
      [{ id: 'd', name: 'server__direct', arguments: { x: 1 } }],
      config,
      0
    )
    expect(real.calls).toEqual([{ x: 1 }])
    expect(toolResults[0].is_error).toBe(false)
    expect(toolResults[0].tool_call_id).toBe('d')
  })

  it('nonexistent MCP tool → Tool not found', async () => {
    const config = makeConfig({
      tools: {},
      bridge: bridgeContext(NATIVE, ['server__exists']),
    })
    const { toolResults } = await executeToolCalls(
      [{ id: 'd', name: 'server__ghost', arguments: {} }],
      config,
      0
    )
    expect(toolResults[0].is_error).toBe(true)
    expect(toolResults[0].content).toMatch(/Tool not found/)
  })
})

describe('bridge intercept is inert without bridge context', () => {
  it('clerum__tool_call falls through to the registered tool (safety-net) when no bridge wired', async () => {
    const safetyNet = new StubTool('clerum__tool_call', {
      content: 'safety-net error',
      duration_ms: 1,
      is_error: true,
    })
    const config = makeConfig({ tools: { clerum__tool_call: safetyNet } })
    const { toolResults } = await executeToolCalls(
      [{ id: 'c', name: 'clerum__tool_call', arguments: { name: 'x', arguments: {} } }],
      config,
      0
    )
    // No intercept → the native tool's execute ran (the safety net).
    expect(safetyNet.calls).toHaveLength(1)
    expect(toolResults[0].is_error).toBe(true)
  })
})
