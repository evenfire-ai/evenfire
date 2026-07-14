import { describe, expect, it, vi } from 'vitest'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import type { ReasoningPort, Tool, ToolRegistry } from '../../interfaces'
import { BasicSafety } from '../../safety/safety'
import type { RespondResult, ToolOutput } from '../../types'
import { SimpleEventEmitter } from '../eventEmitter'
import { buildLoopConfig } from '../loopConfig'
import { runToolUseLoop } from '../toolUseLoop'

function createMockReasoning(result: RespondResult, continuation?: RespondResult): ReasoningPort {
  return {
    respondWithTools: vi.fn(async () => result),
    continueWithToolResults: vi.fn(
      async (): Promise<RespondResult> =>
        continuation ?? {
          type: 'error',
          error: new Error('continueWithToolResults should not be called'),
        }
    ),
  }
}

function createWorkflowTriggerTool(execute: Tool['execute']): Tool {
  return createWorkflowTool('workflow_trigger', execute)
}

function createWorkflowTool(name: string, execute: Tool['execute']): Tool {
  return {
    name: () => name,
    description: () => `Mock ${name}`,
    parametersSchema: () => ({ type: 'object', properties: {} }),
    execute,
    requiresSanitization: () => false,
    requiresApproval: () => false,
  }
}

function createMockRegistry(tools: Tool | Tool[]): ToolRegistry {
  const toolList = Array.isArray(tools) ? tools : [tools]
  const map = new Map(toolList.map(tool => [tool.name(), tool]))
  return {
    get: (name: string) => map.get(name) ?? null,
    listDefinitions: () =>
      toolList.map(tool => ({
        name: tool.name(),
        description: tool.description(),
        parameters: tool.parametersSchema(),
      })),
    register: vi.fn(),
  }
}

describe('runToolUseLoop — workflow_trigger mixed results', () => {
  it('returns safe target clarification when a sibling workflow_trigger fails', async () => {
    const clarification =
      'risk-review is available for multiple targets: Personal, Treasury. Ask the user to choose one of these labels.'
    const execute = vi.fn(async (): Promise<ToolOutput> => {
      throw new Error('unexpected workflow_trigger call')
    })
    execute
      .mockResolvedValueOnce({
        content: 'Tool execution failed: Approval request failed (409)',
        duration_ms: 1,
        is_error: true,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          workflowName: 'risk-review',
          status: 'needs_clarification',
          message: clarification,
          targets: [
            { kind: 'user', label: 'Personal' },
            { kind: 'team', label: 'Treasury' },
          ],
        }),
        duration_ms: 1,
        is_error: false,
      })
    const reasoning = createMockReasoning({
      type: 'tool_calls',
      calls: [
        { id: 'tc_user', name: 'workflow_trigger', arguments: { name: 'risk-review' } },
        {
          id: 'tc_team',
          name: 'workflow_trigger',
          arguments: { name: 'risk-review', targetLabel: 'Treasury' },
        },
      ],
    })
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry(createWorkflowTriggerTool(execute)),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 3,
    })

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'Run risk-review' }])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toBe(clarification)
      expect(result.content).toContain('Personal')
      expect(result.content).toContain('Treasury')
      expect(result.content).not.toContain('No workflow run was confirmed')
    }
    expect(execute).toHaveBeenCalledTimes(2)
    expect(reasoning.continueWithToolResults).not.toHaveBeenCalled()
  })

  it('confirms a successful workflow_trigger when a sibling workflow read fails', async () => {
    const triggerExecute = vi.fn(
      async (): Promise<ToolOutput> => ({
        content: JSON.stringify({
          workflowName: 'risk-review',
          phase: 'Pending',
          message: 'Workflow run created.',
        }),
        duration_ms: 1,
        is_error: false,
      })
    )
    const statusExecute = vi.fn(
      async (): Promise<ToolOutput> => ({
        content: 'Tool execution failed: Workflow broker request failed (503)',
        duration_ms: 1,
        is_error: true,
      })
    )
    const reasoning = createMockReasoning({
      type: 'tool_calls',
      calls: [
        { id: 'tc_trigger', name: 'workflow_trigger', arguments: { name: 'risk-review' } },
        { id: 'tc_status', name: 'workflow_status', arguments: { name: 'risk-review' } },
      ],
    })
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([
        createWorkflowTriggerTool(triggerExecute),
        createWorkflowTool('workflow_status', statusExecute),
      ]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 3,
    })

    const result = await runToolUseLoop(config, [
      { role: 'user', content: 'Run risk-review and check status' },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toContain('Workflow risk-review was approved and triggered')
      expect(result.content).toContain('Workflow run created.')
      expect(result.content).not.toContain('I could not read the workflow state')
      expect(result.content).not.toContain('No workflow run was confirmed')
    }
    expect(triggerExecute).toHaveBeenCalledTimes(1)
    expect(statusExecute).toHaveBeenCalledTimes(1)
    expect(reasoning.continueWithToolResults).not.toHaveBeenCalled()
  })

  it('confirms a successful workflow_trigger when a duplicate sibling trigger fails', async () => {
    const execute = vi.fn(async (): Promise<ToolOutput> => {
      throw new Error('unexpected workflow_trigger call')
    })
    execute
      .mockResolvedValueOnce({
        content: JSON.stringify({
          workflowName: 'risk-review',
          phase: 'Pending',
          message: 'Workflow run created.',
        }),
        duration_ms: 1,
        is_error: false,
      })
      .mockResolvedValueOnce({
        content: 'Tool execution failed: Approval request failed (409)',
        duration_ms: 1,
        is_error: true,
      })
    const reasoning = createMockReasoning({
      type: 'tool_calls',
      calls: [
        { id: 'tc_first', name: 'workflow_trigger', arguments: { name: 'risk-review' } },
        { id: 'tc_second', name: 'workflow_trigger', arguments: { name: 'risk-review' } },
      ],
    })
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry(createWorkflowTriggerTool(execute)),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 3,
    })

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'Run risk-review' }])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toContain('Workflow risk-review was approved and triggered')
      expect(result.content).toContain('Workflow run created.')
      expect(result.content).not.toContain('No workflow run was confirmed')
    }
    expect(execute).toHaveBeenCalledTimes(2)
    expect(reasoning.continueWithToolResults).not.toHaveBeenCalled()
  })

  it('confirms a successful workflow_trigger when a later sibling trigger returns not found', async () => {
    const execute = vi.fn(async (): Promise<ToolOutput> => {
      throw new Error('unexpected workflow_trigger call')
    })
    execute
      .mockResolvedValueOnce({
        content: JSON.stringify({
          workflowName: 'research-summary-workflow',
          phase: 'Pending',
          message: 'Workflow run created.',
        }),
        duration_ms: 1,
        is_error: false,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          workflowName: 'esearch-summary-workflow',
          status: 'workflow_not_found',
          message:
            'Workflow not found: esearch-summary-workflow. Did you mean research-summary-workflow?',
          suggestedWorkflowName: 'research-summary-workflow',
        }),
        duration_ms: 1,
        is_error: false,
      })
    const reasoning = createMockReasoning({
      type: 'tool_calls',
      calls: [
        {
          id: 'tc_success',
          name: 'workflow_trigger',
          arguments: { name: 'research-summary-workflow' },
        },
        {
          id: 'tc_not_found',
          name: 'workflow_trigger',
          arguments: { name: 'esearch-summary-workflow' },
        },
      ],
    })
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry(createWorkflowTriggerTool(execute)),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 3,
    })

    const result = await runToolUseLoop(config, [
      { role: 'user', content: 'Run research-summary-workflow' },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toContain(
        'Workflow research-summary-workflow was approved and triggered'
      )
      expect(result.content).toContain('Workflow run created.')
      expect(result.content).not.toContain('Workflow not found')
    }
    expect(execute).toHaveBeenCalledTimes(2)
    expect(reasoning.continueWithToolResults).not.toHaveBeenCalled()
  })

  it('uses deterministic clarification when LLM text omits workflow_trigger non-run details', async () => {
    const clarification =
      'risk-review is available for multiple targets: Personal, Treasury. Ask the user to choose one of these labels.'
    const execute = vi.fn(
      async (): Promise<ToolOutput> => ({
        content: JSON.stringify({
          workflowName: 'risk-review',
          status: 'needs_clarification',
          message: clarification,
          targets: [
            { kind: 'user', label: 'Personal' },
            { kind: 'team', label: 'Treasury' },
          ],
        }),
        duration_ms: 1,
        is_error: false,
      })
    )
    const reasoning = createMockReasoning(
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_1', name: 'workflow_trigger', arguments: { name: 'risk-review' } }],
      },
      {
        type: 'text',
        content: 'I need more information before I can continue.',
      }
    )
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry(createWorkflowTriggerTool(execute)),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 3,
    })

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'Run risk-review' }])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toBe(clarification)
      expect(result.content).toContain('Personal')
      expect(result.content).toContain('Treasury')
    }
    expect(execute).toHaveBeenCalledTimes(1)
    expect(reasoning.continueWithToolResults).toHaveBeenCalledTimes(1)
  })

  it('returns deterministic not-found response before the LLM can retry workflow_trigger', async () => {
    const notFound =
      'Workflow not found: esearch-summary-workflow. Did you mean research-summary-workflow?'
    const execute = vi.fn(
      async (): Promise<ToolOutput> => ({
        content: JSON.stringify({
          workflowName: 'esearch-summary-workflow',
          status: 'workflow_not_found',
          message: notFound,
          suggestedWorkflowName: 'research-summary-workflow',
        }),
        duration_ms: 1,
        is_error: false,
      })
    )
    const reasoning = createMockReasoning(
      {
        type: 'tool_calls',
        calls: [
          { id: 'tc_1', name: 'workflow_trigger', arguments: { name: 'esearch-summary-workflow' } },
          {
            id: 'tc_same_batch_retry',
            name: 'workflow_trigger',
            arguments: { name: 'research-summary-workflow' },
          },
        ],
      },
      {
        type: 'tool_calls',
        calls: [
          {
            id: 'tc_retry',
            name: 'workflow_trigger',
            arguments: { name: 'esearch-summary-workflow' },
          },
        ],
      }
    )
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry(createWorkflowTriggerTool(execute)),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 3,
    })

    const result = await runToolUseLoop(config, [
      { role: 'user', content: 'Run esearch-summary-workflow' },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toBe(notFound)
      expect(result.content).not.toContain('Processing your request')
    }
    expect(execute).toHaveBeenCalledTimes(1)
    expect(reasoning.continueWithToolResults).not.toHaveBeenCalled()
  })
})
