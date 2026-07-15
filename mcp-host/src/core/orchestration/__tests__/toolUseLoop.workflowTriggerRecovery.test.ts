import { describe, expect, it, vi } from 'vitest'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import { LlmError, LlmErrorCode } from '../../errors'
import type { ReasoningPort, Tool, ToolRegistry } from '../../interfaces'
import { BasicSafety } from '../../safety/safety'
import type { RespondResult, ToolOutput } from '../../types'
import { SimpleEventEmitter } from '../eventEmitter'
import { buildLoopConfig } from '../loopConfig'
import { runToolUseLoop } from '../toolUseLoop'

function createMockReasoning(results: RespondResult[]): ReasoningPort {
  let callIndex = 0
  return {
    respondWithTools: vi.fn(
      async () =>
        results[callIndex++] ?? {
          type: 'error',
          error: new Error('No more results'),
        }
    ),
    continueWithToolResults: vi.fn(
      async () =>
        results[callIndex++] ?? {
          type: 'error',
          error: new Error('No more results'),
        }
    ),
  }
}

function createMockTool(toolName: string, content?: string): Tool {
  return {
    name: () => toolName,
    description: () => `Mock ${toolName}`,
    parametersSchema: () => ({ type: 'object', properties: {} }),
    execute: vi.fn(
      async (): Promise<ToolOutput> => ({
        content: content ?? JSON.stringify({ workflowName: 'workflow-agent-chat-due-diligence' }),
        duration_ms: 10,
        is_error: false,
      })
    ),
    requiresSanitization: () => false,
    requiresApproval: () => false,
  }
}

function createMockRegistry(tools: Tool[]): ToolRegistry {
  const map = new Map(tools.map(t => [t.name(), t]))
  return {
    get: name => map.get(name) ?? null,
    listDefinitions: () =>
      tools.map(t => ({
        name: t.name(),
        description: t.description(),
        parameters: t.parametersSchema(),
      })),
    register: vi.fn(),
  }
}

describe('runToolUseLoop workflow trigger recovery', () => {
  it('does not retry trigger recovery after an approved workflow_trigger result is already in the turn', async () => {
    const reasoning = createMockReasoning([
      { type: 'text', content: 'The workflow request is now being handled.' },
      {
        type: 'tool_calls',
        calls: [
          {
            id: 'tc_2',
            name: 'workflow_trigger',
            arguments: { name: 'workflow-agent-chat-due-diligence' },
          },
        ],
      },
    ])
    const workflowTriggerTool = createMockTool('workflow_trigger')
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([workflowTriggerTool]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 4,
    })

    const result = await runToolUseLoop(config, [
      { role: 'user', content: 'Run workflow-agent-chat-due-diligence now.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'tc_1',
            name: 'workflow_trigger',
            arguments: { name: 'workflow-agent-chat-due-diligence' },
          },
        ],
      },
      {
        role: 'tool',
        name: 'workflow_trigger',
        tool_call_id: 'tc_1',
        content: JSON.stringify({ workflowName: 'workflow-agent-chat-due-diligence' }),
      },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toBe('The workflow request is now being handled.')
    }
    expect(reasoning.respondWithTools).toHaveBeenCalledTimes(1)
    expect(workflowTriggerTool.execute).not.toHaveBeenCalled()
  })

  it('recovers trigger intent when workflow_list is followed by an empty response', async () => {
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_list', name: 'workflow_list', arguments: {} }],
      },
      {
        type: 'error',
        error: new LlmError(
          'LLM produced empty response (no text, no tool calls)',
          'test',
          LlmErrorCode.InvalidResponse,
          true
        ),
      },
      {
        type: 'tool_calls',
        calls: [
          {
            id: 'tc_trigger',
            name: 'workflow_trigger',
            arguments: { name: 'e2e-telegram-risk-review' },
          },
        ],
      },
      { type: 'text', content: 'The workflow request is now being handled.' },
    ])
    const workflowListTool = createMockTool('workflow_list')
    const workflowTriggerTool = createMockTool('workflow_trigger')
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([workflowListTool, workflowTriggerTool]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 5,
    })

    const result = await runToolUseLoop(config, [
      { role: 'user', content: 'Run e2e-telegram-risk-review now.' },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toBe('The workflow request is now being handled.')
    }
    expect(workflowListTool.execute).toHaveBeenCalledTimes(1)
    expect(workflowTriggerTool.execute).toHaveBeenCalledTimes(1)
  })

  it('recovers trigger intent when workflow_list is followed by a non-trigger text response', async () => {
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_list', name: 'workflow_list', arguments: {} }],
      },
      {
        type: 'text',
        content: 'research-summary-workflow is available for this conversation.',
      },
      {
        type: 'tool_calls',
        calls: [
          {
            id: 'tc_trigger',
            name: 'workflow_trigger',
            arguments: {
              name: 'research-summary-workflow',
              inputs: { topic: 'the roman empire' },
            },
          },
        ],
      },
      { type: 'text', content: 'The workflow request is now being handled.' },
    ])
    const workflowListTool = createMockTool(
      'workflow_list',
      JSON.stringify({
        items: [
          {
            name: 'research-summary-workflow',
            inputContract: {
              type: 'object',
              required: ['topic'],
              properties: { topic: { type: 'string' } },
            },
          },
        ],
        count: 1,
      })
    )
    const workflowTriggerTool = createMockTool('workflow_trigger')
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([workflowListTool, workflowTriggerTool]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 5,
    })

    const result = await runToolUseLoop(config, [
      {
        role: 'user',
        content: '@Evenfire Test App run research-summary-workflow topic "the roman empire"',
      },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toBe('The workflow request is now being handled.')
    }
    expect(workflowListTool.execute).toHaveBeenCalledTimes(1)
    expect(workflowTriggerTool.execute).toHaveBeenCalledTimes(1)
    expect(workflowTriggerTool.execute).toHaveBeenCalledWith(
      {
        name: 'research-summary-workflow',
        inputs: { topic: 'the roman empire' },
      },
      undefined
    )
  })

  it('does not recover list intent by triggering a workflow after workflow_list', async () => {
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_list', name: 'workflow_list', arguments: {} }],
      },
      {
        type: 'error',
        error: new LlmError(
          'LLM produced empty response (no text, no tool calls)',
          'test',
          LlmErrorCode.InvalidResponse,
          true
        ),
      },
      {
        type: 'tool_calls',
        calls: [
          {
            id: 'tc_trigger',
            name: 'workflow_trigger',
            arguments: { name: 'e2e-ondemand-approval' },
          },
        ],
      },
    ])
    const workflowListTool = createMockTool(
      'workflow_list',
      JSON.stringify({
        items: [
          {
            name: 'e2e-risk-review-testuser-personal',
            inputs: [],
          },
        ],
        count: 1,
      })
    )
    const workflowTriggerTool = createMockTool('workflow_trigger')
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([workflowListTool, workflowTriggerTool]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 5,
    })

    const result = await runToolUseLoop(config, [
      {
        role: 'user',
        content: 'List the workflow recipes I can run. Include exact workflow recipe names only.',
      },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toContain('e2e-risk-review-testuser-personal')
      expect(result.content).toContain('Required business inputs: none')
      expect(result.content).not.toContain('e2e-ondemand-approval')
    }
    expect(workflowListTool.execute).toHaveBeenCalledTimes(1)
    expect(workflowTriggerTool.execute).not.toHaveBeenCalled()
  })
})
