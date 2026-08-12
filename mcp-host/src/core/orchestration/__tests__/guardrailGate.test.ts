/**
 * Tool-lane guardrail gate wiring in executeToolCalls (spec §6). Verifies the
 * loop acts on the guardrail decision: deny → bounded error (no execution), ask
 * → suspension (resume-safe via one-shot approval), allow → execution. When
 * `config.guardrails` is unset the gate is inert (covered by the existing
 * tool-loop suite).
 */
import { describe, expect, it } from 'vitest'
import type { Decision, ToolLaneGuardrail } from '../../guardrails'
import type { AgentEventEmitter, Safety, Tool, ToolRegistry } from '../../interfaces'
import type { Conversation, ToolCall, ToolDefinition, ToolOutput } from '../../types'
import type { LoopConfig } from '../loopConfig'
import { executeToolCalls } from '../toolUseLoopToolBatch'

class StubTool implements Tool {
  public calls: Record<string, unknown>[] = []
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
  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    this.calls.push(params)
    return { content: 'ok', duration_ms: 1, is_error: false }
  }
}

function registry(tools: Record<string, Tool>): ToolRegistry {
  return {
    get: name => tools[name] ?? null,
    listDefinitions: (): ToolDefinition[] => [],
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

function fixedGuardrail(decision: Decision, reasonCode = 'r'): ToolLaneGuardrail {
  return {
    async decide(_id, input) {
      return { decision, reasonCode, effectiveInput: input, source: 'host_rule' }
    },
  }
}

function makeConfig(
  tool: StubTool,
  guardrails: ToolLaneGuardrail | undefined,
  conversation: Partial<Conversation> = {}
): LoopConfig {
  return {
    reasoning: {} as never,
    toolRegistry: registry({ [tool.name()]: tool }),
    safety: noopSafety,
    events: noopEvents,
    conversation: {
      pending_approval: undefined,
      auto_approved_tools: new Set<string>(),
      ...conversation,
    } as Conversation,
    loopController: {
      shouldAccept: () => true,
      onTextRejected: () => null,
      beforeTool: () => 'proceed',
      onExhaustion: () => '',
      refreshTools: async t => t,
    },
    contextManager: {} as never,
    toolOutputProcessor: {
      beforeExecution: () => ({ is_valid: true, errors: [] }),
      afterExecution: (_n, out) => out.content,
    },
    guardrails,
    maxIterations: 10,
    toolTimeout: 5000,
    toolProgressInterval: 0,
  }
}

const call: ToolCall = { id: 'c1', name: 'do_thing', arguments: { a: 1 } }

describe('guardrail gate in executeToolCalls', () => {
  it('deny → bounded error result, tool never executes', async () => {
    const tool = new StubTool('do_thing')
    const { toolResults, pendingApproval } = await executeToolCalls(
      [call],
      makeConfig(tool, fixedGuardrail('deny', 'path_out_of_bounds')),
      0
    )
    expect(pendingApproval).toBeUndefined()
    expect(toolResults[0].is_error).toBe(true)
    expect(toolResults[0].content).toContain('path_out_of_bounds')
    expect(tool.calls).toHaveLength(0)
  })

  it('allow → tool executes', async () => {
    const tool = new StubTool('do_thing')
    const { toolResults } = await executeToolCalls(
      [call],
      makeConfig(tool, fixedGuardrail('allow')),
      0
    )
    expect(toolResults[0].is_error).toBe(false)
    expect(tool.calls).toHaveLength(1)
  })

  it('no_decision → falls through to the existing path and executes', async () => {
    const tool = new StubTool('do_thing')
    const { toolResults } = await executeToolCalls(
      [call],
      makeConfig(tool, fixedGuardrail('no_decision')),
      0
    )
    expect(toolResults[0].is_error).toBe(false)
    expect(tool.calls).toHaveLength(1)
  })

  it('ask (no prior approval) → suspension, tool does not execute', async () => {
    const tool = new StubTool('do_thing')
    const { pendingApproval } = await executeToolCalls(
      [call],
      makeConfig(tool, fixedGuardrail('ask', 'needs_ok')),
      0
    )
    expect(pendingApproval).toBeDefined()
    expect(pendingApproval?.tool_name).toBe('do_thing')
    expect(tool.calls).toHaveLength(0)
  })

  it('ask in unattended mode → fail-safe deny, no suspension (§6.3)', async () => {
    const tool = new StubTool('do_thing')
    const config = makeConfig(tool, fixedGuardrail('ask', 'needs_ok'))
    config.executionMode = 'unattended'
    const { toolResults, pendingApproval } = await executeToolCalls([call], config, 0)
    expect(pendingApproval).toBeUndefined()
    expect(toolResults[0].is_error).toBe(true)
    expect(toolResults[0].content).toContain('no approver is available')
    expect(tool.calls).toHaveLength(0)
  })

  it('doom-loop: 3rd consecutive identical call is denied (§6.4)', async () => {
    const tool = new StubTool('do_thing')
    const config = makeConfig(tool, fixedGuardrail('allow'))
    // Same conversation across calls carries the doom-loop counter.
    const r1 = await executeToolCalls([call], config, 0)
    const r2 = await executeToolCalls([{ ...call, id: 'c2' }], config, 1)
    const r3 = await executeToolCalls([{ ...call, id: 'c3' }], config, 2)
    expect(r1.toolResults[0].is_error).toBe(false)
    expect(r2.toolResults[0].is_error).toBe(false)
    expect(r3.toolResults[0].is_error).toBe(true)
    expect(r3.toolResults[0].content).toContain('doom-loop')
    expect(tool.calls).toHaveLength(2) // 3rd blocked
  })

  it('doom-loop resets when a different call intervenes (§6.4)', async () => {
    const tool = new StubTool('do_thing')
    const config = makeConfig(tool, fixedGuardrail('allow'))
    await executeToolCalls([call], config, 0)
    await executeToolCalls([{ id: 'x', name: 'do_thing', arguments: { a: 2 } }], config, 1) // different args → reset
    const r3 = await executeToolCalls([{ ...call, id: 'c3' }], config, 2)
    expect(r3.toolResults[0].is_error).toBe(false) // counter was reset
  })

  it('ask + matching one-shot approval → proceeds and clears pending', async () => {
    const tool = new StubTool('do_thing')
    const conversation: Partial<Conversation> = {
      pending_approval: { tool_name: 'do_thing' } as Conversation['pending_approval'],
    }
    const config = makeConfig(tool, fixedGuardrail('ask'), conversation)
    const { pendingApproval } = await executeToolCalls([call], config, 0)
    expect(pendingApproval).toBeUndefined()
    expect(tool.calls).toHaveLength(1)
    expect(config.conversation.pending_approval).toBeUndefined()
  })
})
