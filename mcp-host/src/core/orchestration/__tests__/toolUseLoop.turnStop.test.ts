/**
 * A15 U1 — a tool result that carries `stopTurn` ends the turn after its
 * batch: the remaining calls are answered without running, no model call
 * follows, and the loop returns `exhaustion` with reason `turn_stop`.
 */
import { describe, expect, it, vi } from 'vitest'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import type { ReasoningPort, Tool, ToolRegistry } from '../../interfaces'
import { BasicSafety } from '../../safety/safety'
import type { AgentEvent, ChatMessage, RespondResult, ToolCall, ToolOutput } from '../../types'
import { SimpleEventEmitter } from '../eventEmitter'
import { type LoopConfig, buildLoopConfig } from '../loopConfig'
import { runToolUseLoop, validateToolLinkages } from '../toolUseLoop'
import { executeToolCalls } from '../toolUseLoopToolBatch'

const STOP_MESSAGE = 'The reading limit was reached for this turn.'

function mockTool(toolName: string, stops: boolean): Tool {
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
    finalizeResult: vi.fn((result, context) => ({
      ...result,
      emittedMessageCost: context.measureContent(result.content),
      ...(stops ? { stopTurn: { message: STOP_MESSAGE } } : {}),
    })),
  }
}

function registry(tools: Tool[]): ToolRegistry {
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

const CALLS: ToolCall[] = [
  { id: 'tc_stop', name: 'stopper', arguments: {} },
  { id: 'tc_second', name: 'second', arguments: {} },
  { id: 'tc_third', name: 'third', arguments: {} },
]

function setup(firstStops: boolean) {
  const tools = [
    mockTool('stopper', firstStops),
    mockTool('second', false),
    mockTool('third', false),
  ]
  const script: RespondResult[] = [
    { type: 'tool_calls', calls: CALLS },
    { type: 'text', content: 'after the batch' },
  ]
  let i = 0
  const next = async (): Promise<RespondResult> => script[i++]!
  const reasoning: ReasoningPort = {
    respondWithTools: vi.fn(next),
    continueWithToolResults: vi.fn(next),
  }
  const events = new SimpleEventEmitter()
  const completed: AgentEvent[] = []
  events.on('loop:completed', event => completed.push(event))
  const config: LoopConfig = buildLoopConfig({
    reasoning,
    toolRegistry: registry(tools),
    safety: new BasicSafety(),
    events,
    conversation: makeFakeConversation(),
    maxIterations: 10,
  })
  config.measureToolMessage = message => (message.content ?? '').length
  return { tools, reasoning, config, completed }
}

describe('runToolUseLoop — turn stop from a tool result (A15 U1)', () => {
  it('ends the turn after the batch without running the later calls or the model', async () => {
    const { tools, reasoning, config, completed } = setup(true)

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'read it' }])

    // Witness: the model asked once and the stopping tool really ran.
    expect(reasoning.respondWithTools).toHaveBeenCalledTimes(1)
    expect(tools[0]!.execute).toHaveBeenCalledTimes(1)
    expect(tools[0]!.finalizeResult).toHaveBeenCalledTimes(1)
    expect(tools[1]!.execute).not.toHaveBeenCalled()
    expect(tools[2]!.execute).not.toHaveBeenCalled()
    expect(reasoning.continueWithToolResults).not.toHaveBeenCalled()
    expect(result).toEqual({
      type: 'exhaustion',
      reason: 'turn_stop',
      message: STOP_MESSAGE,
      iterations: 1,
    })
    expect(completed.map(event => event.data.resultType)).toEqual(['turn_stop'])
  })

  it('continues to the model when no result stops the turn', async () => {
    const { tools, reasoning, config } = setup(false)

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'read it' }])

    expect(tools.map(tool => vi.mocked(tool.execute).mock.calls.length)).toEqual([1, 1, 1])
    expect(reasoning.continueWithToolResults).toHaveBeenCalledTimes(1)
    expect(result.type).toBe('response')
  })

  it('answers every later call of the batch so the tool linkage holds', async () => {
    const { tools, config } = setup(true)

    const batch = await executeToolCalls(CALLS, config, 0)

    expect(batch.stopTurn).toEqual({ message: STOP_MESSAGE })
    expect(batch.toolResults.map(r => [r.tool_call_id, r.is_error])).toEqual([
      ['tc_stop', false],
      ['tc_second', true],
      ['tc_third', true],
    ])
    for (const skipped of batch.toolResults.slice(1)) {
      expect(skipped.content).toBe('Not executed — the turn stopped. Re-request if needed.')
    }
    expect(tools[1]!.execute).not.toHaveBeenCalled()
    const messages: ChatMessage[] = [
      { role: 'user', content: 'read it' },
      { role: 'assistant', content: '', tool_calls: CALLS },
      ...batch.toolResults.map(r => ({
        role: 'tool' as const,
        content: r.content,
        tool_call_id: r.tool_call_id,
        name: r.name,
      })),
    ]
    expect(() => validateToolLinkages(messages)).not.toThrow()
    // Witness: the same check rejects a batch that drops the later answers.
    expect(() => validateToolLinkages(messages.slice(0, 3))).toThrow(/Tool linkage violated/)
  })
})
