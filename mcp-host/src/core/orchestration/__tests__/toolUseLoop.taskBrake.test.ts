import { describe, expect, it, vi } from 'vitest'
import { snapshotTaskTokenBaseline } from '../../../budget/taskBrake'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import type { ReasoningPort, Tool, ToolRegistry } from '../../interfaces'
import { BasicSafety } from '../../safety/safety'
import type { Conversation, RespondResult, ToolOutput } from '../../types'
import { SimpleEventEmitter } from '../eventEmitter'
import { type LoopConfig, buildLoopConfig } from '../loopConfig'
import { runToolUseLoop } from '../toolUseLoop'
import { TASK_BUDGET_BRAKE_MESSAGE } from '../toolUseLoopRuntime'

/**
 * Reasoning mock that simulates LLM token spend by mutating the conversation's
 * lifetime counters on each call (mirroring `recordSessionUsage`), then returns
 * the next scripted result. This lets the loop's per-iteration brake observe a
 * growing per-task delta.
 */
function spendingReasoning(
  conversation: Conversation,
  perCallInputTokens: number,
  script: RespondResult[]
): ReasoningPort {
  let i = 0
  const advance = async (): Promise<RespondResult> => {
    conversation.input_tokens = (conversation.input_tokens ?? 0) + perCallInputTokens
    return script[i++] ?? { type: 'text', content: 'done' }
  }
  return {
    respondWithTools: vi.fn(advance),
    continueWithToolResults: vi.fn(advance),
  }
}

function createMockTool(toolName: string): Tool {
  return {
    name: () => toolName,
    description: () => `Mock ${toolName}`,
    parametersSchema: () => ({ type: 'object', properties: {} }),
    execute: vi.fn(
      async (): Promise<ToolOutput> => ({
        content: `${toolName} result`,
        duration_ms: 1,
        is_error: false,
      })
    ),
    requiresSanitization: () => true,
    requiresApproval: () => false,
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

const TOOL_CALL: RespondResult = {
  type: 'tool_calls',
  calls: [{ id: 'tc_1', name: 'search', arguments: {} }],
}

function buildConfig(
  conversation: Conversation,
  reasoning: ReasoningPort,
  taskBrake?: LoopConfig['taskBrake']
): LoopConfig {
  const config = buildLoopConfig({
    reasoning,
    toolRegistry: createMockRegistry([createMockTool('search')]),
    safety: new BasicSafety(),
    events: new SimpleEventEmitter(),
    conversation,
    maxIterations: 10,
  })
  config.taskBrake = taskBrake
  return config
}

describe('runToolUseLoop — P2 per-task budget brake', () => {
  it('is a no-op when no taskBrake is configured (identical to current behavior)', async () => {
    const conversation = makeFakeConversation()
    const reasoning = spendingReasoning(conversation, 10_000, [TOOL_CALL, TOOL_CALL])
    const config = buildConfig(conversation, reasoning) // no taskBrake

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'go' }])

    // Reaches the canned text completion after the scripted tool calls.
    expect(result.type).toBe('response')
  })

  it('does not cut when the per-task delta stays under maxTaskTokens', async () => {
    const conversation = makeFakeConversation({ input_tokens: 0 })
    const baseline = snapshotTaskTokenBaseline(conversation)
    // Each call spends 50; script ends with text on the 2nd call → total 100 < 1000.
    const reasoning = spendingReasoning(conversation, 50, [
      TOOL_CALL,
      { type: 'text', content: 'all good' },
    ])
    const config = buildConfig(conversation, reasoning, { maxTaskTokens: 1000, baseline })

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'go' }])

    expect(result.type).toBe('response')
    if (result.type === 'response') expect(result.content).toBe('all good')
  })

  it('cuts cleanly (exhaustion + brake message) when the delta exceeds maxTaskTokens', async () => {
    const conversation = makeFakeConversation({ input_tokens: 0 })
    const baseline = snapshotTaskTokenBaseline(conversation)
    // First call spends 5000 (> cap 1000); the brake trips at the NEXT iteration.
    const reasoning = spendingReasoning(conversation, 5000, [TOOL_CALL, TOOL_CALL, TOOL_CALL])
    const config = buildConfig(conversation, reasoning, { maxTaskTokens: 1000, baseline })

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'go' }])

    expect(result.type).toBe('exhaustion')
    if (result.type === 'exhaustion') {
      expect(result.message).toBe(TASK_BUDGET_BRAKE_MESSAGE)
    }
  })

  it('cuts BETWEEN iterations: the in-flight call completes, the next one never starts', async () => {
    const conversation = makeFakeConversation({ input_tokens: 0 })
    const baseline = snapshotTaskTokenBaseline(conversation)
    const reasoning = spendingReasoning(conversation, 5000, [TOOL_CALL, TOOL_CALL, TOOL_CALL])
    const config = buildConfig(conversation, reasoning, { maxTaskTokens: 1000, baseline })

    await runToolUseLoop(config, [{ role: 'user', content: 'go' }])

    // iter0: brake delta=0 → call (respondWithTools) spends 5000 → tool runs.
    // iter1: brake delta=5000 > 1000 → trip BEFORE the continue call. So the
    // initial call ran exactly once and the follow-up call never fired (no lost
    // in-flight tokens).
    expect(reasoning.respondWithTools).toHaveBeenCalledTimes(1)
    expect(reasoning.continueWithToolResults).not.toHaveBeenCalled()
  })

  it('the first call always proceeds (iteration 0 delta is 0)', async () => {
    const conversation = makeFakeConversation({ input_tokens: 0 })
    const baseline = snapshotTaskTokenBaseline(conversation)
    // Tiny cap, but the first call must still happen since delta starts at 0.
    const reasoning = spendingReasoning(conversation, 5000, [{ type: 'text', content: 'first' }])
    const config = buildConfig(conversation, reasoning, { maxTaskTokens: 1, baseline })

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'go' }])

    expect(reasoning.respondWithTools).toHaveBeenCalledTimes(1)
    expect(result.type).toBe('response')
    if (result.type === 'response') expect(result.content).toBe('first')
  })

  it('cuts on the cost cap using the verdict price (no network)', async () => {
    const conversation = makeFakeConversation({ input_tokens: 0 })
    const baseline = snapshotTaskTokenBaseline(conversation)
    // input price 3/1e6; 1_000_000 input → $3.0 > cap $1.0.
    const reasoning = spendingReasoning(conversation, 1_000_000, [TOOL_CALL, TOOL_CALL])
    const config = buildConfig(conversation, reasoning, {
      maxTaskCost: 1.0,
      price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, currency: 'USD' },
      baseline,
    })

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'go' }])

    expect(result.type).toBe('exhaustion')
    if (result.type === 'exhaustion') expect(result.message).toBe(TASK_BUDGET_BRAKE_MESSAGE)
    expect(reasoning.respondWithTools).toHaveBeenCalledTimes(1)
    expect(reasoning.continueWithToolResults).not.toHaveBeenCalled()
  })

  it('does not cut when the session baseline is high but this task is small (delta semantics)', async () => {
    // Long-lived session already at 1,000,000 input tokens.
    const conversation = makeFakeConversation({ input_tokens: 1_000_000 })
    const baseline = snapshotTaskTokenBaseline(conversation)
    // This task spends only 50 per call, ending with text → 100 total, well under cap.
    const reasoning = spendingReasoning(conversation, 50, [
      TOOL_CALL,
      { type: 'text', content: 'fine' },
    ])
    const config = buildConfig(conversation, reasoning, { maxTaskTokens: 1000, baseline })

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'go' }])

    expect(result.type).toBe('response')
    if (result.type === 'response') expect(result.content).toBe('fine')
  })
})
