/**
 * Tool arguments that are not a JSON object are refused once, at admission,
 * as a validation result. Before, a validator that read a field of `null`
 * threw out of admission and failed the whole task.
 */
import { describe, expect, it } from 'vitest'
import type { AgentEventEmitter, Safety, Tool, ToolRegistry } from '../../interfaces'
import { DefaultToolOutputProcessor } from '../../safety/toolOutputProcessor'
import { JsonTransformTool } from '../../tools/jsonTransform'
import type { AgentEvent, Conversation, ToolCall, ToolDefinition } from '../../types'
import type { LoopConfig } from '../loopConfig'
import { admitToolCall } from '../toolCallPolicy'

const passSafety: Safety = {
  validateInput: () => ({ is_valid: true, errors: [] }),
  // Null-safe, so a non-object reaches the tool's own validator unless
  // admission refuses it first.
  validateToolParams: (_name, params) => {
    const blocked = typeof (params as Record<string, unknown> | null)?.blocked === 'string'
    return { is_valid: !blocked, errors: blocked ? ['blocked'] : [] }
  },
  sanitizeOutput: (_n, output) => ({ content: output, was_modified: false, warnings: [] }),
  wrapForLlm: (_n, content) => content,
}

/** A tool with no validateParams, as system_info. */
const noValidatorTool: Tool = {
  name: () => 'plain_tool',
  description: () => 'no parameters',
  parametersSchema: () => ({ type: 'object', properties: {} }),
  requiresSanitization: () => false,
  requiresApproval: () => false,
  execute: async () => ({ content: 'ran', duration_ms: 0, is_error: false }),
}

function makeConfig(events: AgentEvent[]): LoopConfig {
  const tools: Record<string, Tool> = {
    json_transform: new JsonTransformTool(),
    plain_tool: noValidatorTool,
  }
  const toolRegistry: ToolRegistry = {
    get: name => tools[name] ?? null,
    listDefinitions: (): ToolDefinition[] => [],
    register: () => {},
  }
  const emitter: AgentEventEmitter = { emit: e => events.push(e), on: () => {}, off: () => {} }
  return {
    reasoning: {} as never,
    toolRegistry,
    safety: passSafety,
    events: emitter,
    conversation: {
      pending_approval: undefined,
      auto_approved_tools: new Set<string>(),
    } as unknown as Conversation,
    loopController: {
      shouldAccept: () => true,
      onTextRejected: () => null,
      beforeTool: () => 'proceed',
      onExhaustion: () => '',
      refreshTools: async t => t,
    },
    contextManager: {} as never,
    toolOutputProcessor: new DefaultToolOutputProcessor(passSafety),
    maxIterations: 10,
    toolTimeout: 5000,
    toolProgressInterval: 0,
  }
}

const callWith = (name: string, args: unknown): ToolCall =>
  ({ id: 'c1', name, arguments: args }) as unknown as ToolCall

const REFUSED = {
  kind: 'result',
  toolResult: {
    tool_call_id: 'c1',
    content: 'Parameter validation failed: the tool arguments must be a JSON object',
    is_error: true,
  },
}

describe('admitToolCall with arguments that are not a JSON object', () => {
  it.each([
    ['null', null],
    ['an array', [{ input: '{}', operation: 'parse' }]],
    ['a string', '{"input":"{}","operation":"parse"}'],
    ['a number', 5],
    ['a boolean', true],
  ])('%s is refused as a validation result, for every tool', async (_label, args) => {
    for (const name of ['json_transform', 'plain_tool']) {
      const events: AgentEvent[] = []
      const admission = await admitToolCall(callWith(name, args), makeConfig(events), 0)
      expect(admission).toMatchObject({
        ...REFUSED,
        toolResult: { ...REFUSED.toolResult, name },
      })
      expect(events.map(e => e.type)).toEqual(['safety:input_blocked'])
    }
  })

  it('an object reaches the safety check and the tool’s own validator', async () => {
    const events: AgentEvent[] = []
    const config = makeConfig(events)
    // The tool's own validator ran: its message, not the object check.
    const invalid = await admitToolCall(callWith('json_transform', {}), config, 0)
    expect(invalid).toMatchObject({ kind: 'result', toolResult: { is_error: true } })
    expect((invalid as { toolResult: { content: string } }).toolResult.content).toContain(
      'Provide exactly one of input and file.'
    )
    // The safety check ran: its error.
    const blocked = await admitToolCall(callWith('plain_tool', { blocked: 'x' }), config, 0)
    expect(blocked).toMatchObject({
      kind: 'result',
      toolResult: { content: 'Parameter validation failed: blocked', is_error: true },
    })
    // A valid object is admitted.
    for (const [name, args] of [
      ['json_transform', { input: '{"a":1}', operation: 'keys' }],
      ['plain_tool', {}],
    ] as const) {
      expect((await admitToolCall(callWith(name, args), config, 0)).kind).toBe('execute')
    }
  })
})
