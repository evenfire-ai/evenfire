/**
 * Tool-lane guardrail gate wiring in executeToolCalls (spec §6). Verifies the
 * loop acts on the guardrail decision: deny → bounded error (no execution), ask
 * → suspension (resume-safe via one-shot approval), allow → execution. When
 * `config.guardrails` is unset the gate is inert (covered by the existing
 * tool-loop suite).
 */
import { describe, expect, it, vi } from 'vitest'
import type { Decision, ToolLaneGuardrail } from '../../guardrails'
import type { AgentEventEmitter, Safety, Tool, ToolRegistry } from '../../interfaces'
import type { Conversation, ToolCall, ToolDefinition, ToolOutput } from '../../types'
import type { LoopConfig } from '../loopConfig'
import { admitToolCall } from '../toolCallPolicy'
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

  it('PostToolUse transformResult redacts the executed result content (§6.2)', async () => {
    const tool = new StubTool('do_thing')
    const guardrail: ToolLaneGuardrail = {
      async decide(_id, input) {
        return { decision: 'allow', reasonCode: 'r', effectiveInput: input, source: 'host_rule' }
      },
      async transformResult(_id, _input, result) {
        return { content: `[redacted:${result.content}]`, isError: result.isError }
      },
    }
    const { toolResults } = await executeToolCalls([call], makeConfig(tool, guardrail), 0)
    expect(tool.calls).toHaveLength(1) // executed
    expect(toolResults[0].content).toBe('[redacted:ok]') // model-visible content redacted
    expect(toolResults[0].is_error).toBe(false)
  })

  it('finalizeResult fences the transformed result, after transformResult', async () => {
    const tool = new StubTool('do_thing')
    const finalized: string[] = []
    const fenced = Object.assign(tool, {
      finalizeResult: (result: { content: string }) => {
        finalized.push(result.content)
        return { ...result, content: `[fenced:${result.content}]` }
      },
    })
    const guardrail: ToolLaneGuardrail = {
      async decide(_id, input) {
        return { decision: 'allow', reasonCode: 'r', effectiveInput: input, source: 'host_rule' }
      },
      async transformResult(_id, _input, result) {
        return { content: `[redacted:${result.content}]`, isError: result.isError }
      },
    }
    const config = { ...makeConfig(fenced, guardrail), measureToolMessage: () => 1 }
    const { toolResults } = await executeToolCalls([call], config, 0)
    expect(tool.calls).toHaveLength(1)
    expect(finalized).toEqual(['[redacted:ok]'])
    expect(toolResults[0].content).toBe('[fenced:[redacted:ok]]')
  })

  // Post-result hooks redact error text too (a thrown upstream message can
  // carry a secret) and observe failed calls, so every error result the
  // execution boundary produces must pass through transformResult.
  it.each([
    {
      path: 'a thrown tool error',
      tools: (): Record<string, Tool> => {
        const throwing = new StubTool('do_thing')
        throwing.execute = async params => {
          throwing.calls.push(params)
          throw new Error('upstream said SECRET-TOKEN-123')
        }
        return { do_thing: throwing }
      },
      raw: 'Tool execution failed: upstream said SECRET-TOKEN-123',
    },
    {
      // Admission accepts the call; the execution boundary re-validates the
      // effective parameters and refuses them.
      path: 'an execution-boundary validation failure',
      tools: (): Record<string, Tool> => {
        const strict = new StubTool('do_thing')
        let validations = 0
        Object.assign(strict, {
          validateParams: () =>
            ++validations === 1
              ? { is_valid: true, errors: [] }
              : { is_valid: false, errors: ['bad SECRET-TOKEN-123'] },
        })
        return { do_thing: strict }
      },
      raw: 'Parameter validation failed: bad SECRET-TOKEN-123',
    },
    {
      path: 'a missing tool',
      tools: (): Record<string, Tool> => ({}),
      raw: 'Tool not found: do_thing',
    },
  ])('PostToolUse transformResult also sees $path', async ({ tools, raw }) => {
    const seen: Array<{ content: string; isError: boolean }> = []
    const guardrail: ToolLaneGuardrail = {
      async decide(_id, input) {
        return { decision: 'allow', reasonCode: 'r', effectiveInput: input, source: 'host_rule' }
      },
      async transformResult(_id, _input, result) {
        seen.push(result)
        return { content: '[redacted]', isError: result.isError }
      },
    }
    const config = makeConfig(new StubTool('unused'), guardrail)
    config.toolRegistry = registry(tools())
    const { toolResults } = await executeToolCalls([call], config, 0)
    expect(seen).toEqual([{ content: raw, isError: true }])
    expect(toolResults[0]).toMatchObject({ content: '[redacted]', is_error: true })
  })

  it('ask + matching one-shot approval → proceeds and clears pending', async () => {
    const tool = new StubTool('do_thing')
    const conversation: Partial<Conversation> = {
      pending_approval: {
        tool_name: 'do_thing',
        authorization_scope: 'turn_tools',
      } as Conversation['pending_approval'],
      // Legacy name-only pending rows are intentionally not reusable. This
      // fixture models the producer's durable turn-wide consent classification.
    }
    const config = makeConfig(tool, fixedGuardrail('ask'), conversation)
    const { pendingApproval } = await executeToolCalls([call], config, 0)
    expect(pendingApproval).toBeUndefined()
    expect(tool.calls).toHaveLength(1)
    expect(config.conversation.pending_approval).toBeUndefined()
  })
})

describe('exact guardrail ask one-shot binding', () => {
  const original: ToolCall = { id: 'exact-1', name: 'do_thing', arguments: { command: 'original' } }

  it.each([
    { ...original, id: 'exact-2' },
    { ...original, arguments: { command: 'replaced' } },
  ])('does not consume an exact ask for a changed invocation: %j', async changed => {
    const tool = new StubTool('do_thing')
    const admission = await admitToolCall(
      changed,
      makeConfig(tool, fixedGuardrail('ask'), {
        pending_approval: {
          authorization_scope: 'exact_invocation',
          request_id: 'pending-exact',
          tool_name: original.name,
          parameters: original.arguments,
          description: 'Exact ask',
          tool_call_id: original.id,
          context_snapshot: [],
        },
      }),
      0
    )

    expect(admission.kind).toBe('suspend')
    expect(tool.calls).toHaveLength(0)
  })

  it('requires new exact consent when the current guardrail transforms approved parameters', async () => {
    const tool = new StubTool('do_thing')
    const effectiveInput = { command: 'transformed' }
    const config = makeConfig(
      tool,
      {
        async decide() {
          return {
            decision: 'ask',
            reasonCode: 'updated_input',
            effectiveInput,
            source: 'host_rule',
          }
        },
      },
      {
        pending_approval: {
          authorization_scope: 'exact_invocation',
          request_id: 'pending-exact',
          tool_name: original.name,
          parameters: original.arguments,
          description: 'Exact ask',
          tool_call_id: original.id,
          context_snapshot: [],
        },
      }
    )

    const admission = await admitToolCall(original, config, 0)

    expect(admission).toMatchObject({
      kind: 'suspend',
      approval: { parameters: effectiveInput, authorization_scope: 'exact_invocation' },
    })
    expect(config.conversation.pending_approval?.request_id).toBe('pending-exact')
    expect(tool.calls).toHaveLength(0)
  })

  it('reports transformed consent parameters consistently in the batch approval event', async () => {
    const tool = new StubTool('do_thing')
    const effectiveInput = { command: 'transformed' }
    const config = makeConfig(tool, {
      async decide() {
        return { decision: 'ask', reasonCode: 'updated_input', effectiveInput, source: 'host_rule' }
      },
    })
    const emit = vi.fn()
    config.events = { ...noopEvents, emit }
    const result = await executeToolCalls([original], config, 0)

    expect(result.pendingApproval?.parameters).toEqual(effectiveInput)
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool:approval_needed',
        data: expect.objectContaining({ parameters: effectiveInput }),
      })
    )
    expect(tool.calls).toHaveLength(0)
  })

  it('consumes only an exact invocation match', async () => {
    const tool = new StubTool('do_thing')
    const admission = await admitToolCall(
      original,
      makeConfig(tool, fixedGuardrail('ask'), {
        pending_approval: {
          authorization_scope: 'exact_invocation',
          request_id: 'pending-exact',
          tool_name: original.name,
          parameters: original.arguments,
          description: 'Exact ask',
          tool_call_id: original.id,
          context_snapshot: [],
        },
      }),
      0
    )

    expect(admission.kind).toBe('execute')
    expect(tool.calls).toHaveLength(0)
  })

  it('preserves name-based reuse for proven turn-tools consent', async () => {
    const tool = new StubTool('do_thing')
    const admission = await admitToolCall(
      { id: 'turn-2', name: 'do_thing', arguments: { command: 'different' } },
      makeConfig(tool, fixedGuardrail('ask'), {
        pending_approval: {
          authorization_scope: 'turn_tools',
          request_id: 'pending-turn',
          tool_name: original.name,
          parameters: original.arguments,
          description: 'Turn ask',
          tool_call_id: original.id,
          context_snapshot: [],
        },
      }),
      0
    )

    expect(admission.kind).toBe('execute')
  })
})
