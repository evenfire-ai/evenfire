import { describe, expect, it, vi } from 'vitest'
import type {
  ProgressReporter,
  ToolCompleteEvent,
  ToolStartEvent,
} from '../../../progress/types.js'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import { LlmError, LlmErrorCode } from '../../errors'
import type { ReasoningPort, Tool, ToolRegistry } from '../../interfaces'
import { BasicSafety } from '../../safety/safety'
import type { Attachment, RespondResult, ToolOutput } from '../../types'
import { SimpleEventEmitter } from '../eventEmitter'
import { buildLoopConfig } from '../loopConfig'
import {
  buildOutputPreview,
  executeSingleTool,
  extractInputPreview,
  runToolUseLoop,
} from '../toolUseLoop'
import { projectToolCallTokens } from '../toolUseLoopSingleTool'

// ─── Mock Factories ────────────────────────────────────────

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

function createMockTool(
  toolName: string,
  opts: {
    sanitize?: boolean
    approval?: boolean
    output?: string
    error?: boolean
    attachments?: Attachment[]
  } = {}
): Tool {
  return {
    name: () => toolName,
    description: () => `Mock ${toolName}`,
    parametersSchema: () => ({ type: 'object', properties: {} }),
    execute: vi.fn(
      async (): Promise<ToolOutput> => ({
        content: opts.output ?? `${toolName} result`,
        duration_ms: 10,
        is_error: opts.error ?? false,
        attachments: opts.attachments,
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

// ─── Loop Control Tests ────────────────────────────────────

describe('runToolUseLoop — loop control', () => {
  it('should return response when reasoning produces text', async () => {
    const reasoning = createMockReasoning([{ type: 'text', content: 'Hello world' }])
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
    })

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'Hi' }])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toBe('Hello world')
    }
  })

  it('should stop at maxIterations when reasoning always returns tool_calls (Risk 4.5a)', async () => {
    const toolCalls = {
      type: 'tool_calls' as const,
      calls: [{ id: 'tc_1', name: 'search', arguments: {} }],
    }
    const results: RespondResult[] = Array(15).fill(toolCalls)
    const reasoning = createMockReasoning(results)

    const searchTool = createMockTool('search')
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([searchTool]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 3,
    })

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'Search forever' }])

    expect(result.type).toBe('exhaustion')
    if (result.type === 'exhaustion') {
      expect(result.iterations).toBe(3)
    }
  })

  it('should stop immediately on reasoning error (Risk 4.5b)', async () => {
    const reasoning = createMockReasoning([{ type: 'error', error: new Error('LLM down') }])
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
    })

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'Hi' }])

    expect(result.type).toBe('error')
  })

  it('recovers once when the LLM returns an empty response after tool results', async () => {
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_1', name: 'search', arguments: { q: 'workflow recipes' } }],
      },
      {
        type: 'error',
        error: new LlmError(
          'LLM produced empty response (no text, no tool calls)',
          'glm-4.7',
          LlmErrorCode.InvalidResponse,
          false
        ),
      },
      { type: 'text', content: 'Recovered with the workflow list.' },
    ])

    const searchTool = createMockTool('search', { output: 'workflow list result' })
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([searchTool]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 4,
    })

    const result = await runToolUseLoop(config, [
      { role: 'user', content: 'List my workflow recipes' },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toBe('Recovered with the workflow list.')
    }

    const retryContext = (reasoning.respondWithTools as ReturnType<typeof vi.fn>).mock.calls[1][0]
    expect(retryContext.messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('tool result was empty'),
    })
    const nudgeContent = retryContext.messages.at(-1)?.content
    expect(typeof nudgeContent).toBe('string')
    expect(nudgeContent).not.toContain('workflow tool')
  })

  it('recovers once when the LLM returns an empty response before using tools', async () => {
    const emptyResponse = new LlmError(
      'LLM produced empty response (no text, no tool calls)',
      'glm-4.7',
      LlmErrorCode.InvalidResponse,
      false
    )
    const reasoning = createMockReasoning([
      { type: 'error', error: emptyResponse },
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_1', name: 'workflow_list', arguments: {} }],
      },
      { type: 'text', content: 'Recovered with workflow recipes.' },
    ])

    const workflowListTool = createMockTool('workflow_list', {
      sanitize: false,
      output: JSON.stringify({ items: [{ name: 'e2e-telegram-risk-review' }], count: 1 }),
    })
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([workflowListTool]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 4,
    })

    const result = await runToolUseLoop(config, [
      { role: 'user', content: 'List the workflow recipes I can run' },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toContain('e2e-telegram-risk-review')
      expect(result.content).toContain('Required business inputs: none')
    }
    const retryContext = (reasoning.respondWithTools as ReturnType<typeof vi.fn>).mock.calls[1][0]
    expect(
      retryContext.messages.map((message: { content: string }) => message.content)
    ).toContainEqual(expect.stringContaining('previous assistant turn was empty'))
  })

  it('redirects artifact requests away from workflow_trigger before approval is requested', async () => {
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_1', name: 'workflow_trigger', arguments: { name: 'risk-review' } }],
      },
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_2', name: 'workflow_result', arguments: { name: 'risk-review' } }],
      },
      { type: 'text', content: 'Here is the existing artifact.' },
    ])

    const workflowTriggerTool = createMockTool('workflow_trigger', { approval: true })
    const workflowResultTool = createMockTool('workflow_result', {
      sanitize: false,
      output: JSON.stringify({
        workflowName: 'risk-review',
        artifactAvailable: true,
        result: { artifactProof: 'artifact-output-risk-review' },
      }),
    })
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([workflowTriggerTool, workflowResultTool]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 4,
    })

    const result = await runToolUseLoop(config, [
      {
        role: 'user',
        content: 'Show me the workflow result artifact for risk-review.',
      },
    ])

    expect(workflowTriggerTool.execute).not.toHaveBeenCalled()
    expect(workflowResultTool.execute).toHaveBeenCalledTimes(1)
    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toBe('Here is the existing artifact.')
    }
    const retryContext = (reasoning.respondWithTools as ReturnType<typeof vi.fn>).mock.calls[1][0]
    expect(
      retryContext.messages.map((message: { content: string }) => message.content)
    ).toContainEqual(expect.stringContaining('Do not call workflow_trigger'))
  })

  it('synthesizes a safe workflow_list answer when the LLM stays empty after recovery', async () => {
    const emptyResponse = new LlmError(
      'LLM produced empty response (no text, no tool calls)',
      'glm-4.7',
      LlmErrorCode.InvalidResponse,
      false
    )
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_1', name: 'workflow_list', arguments: {} }],
      },
      { type: 'error', error: emptyResponse },
      { type: 'error', error: emptyResponse },
    ])

    const workflowListTool = createMockTool('workflow_list', {
      sanitize: false,
      output: JSON.stringify(
        {
          items: [
            {
              namespace: 'sandbox-recipes',
              name: 'e2e-agent-due-diligence',
              targetUserId: '00000000-0000-4000-8000-000000000001',
              inputContract: {
                type: 'object',
                required: ['company'],
                properties: {
                  company: {
                    type: 'string',
                    description: 'Target company or organization.',
                  },
                  depth: {
                    type: 'string',
                    enum: ['standard', 'full'],
                    default: 'full',
                    description: 'Due diligence depth.',
                  },
                },
              },
            },
            {
              name: 'e2e-agent-layer3a-no-input',
              inputContract: null,
            },
          ],
          count: 2,
        },
        null,
        2
      ),
    })
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([workflowListTool]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 4,
    })

    const result = await runToolUseLoop(config, [
      { role: 'user', content: 'List my granted workflow recipes and inputs' },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toContain('e2e-agent-due-diligence')
      expect(result.content).toContain('Required business inputs: company')
      expect(result.content).toContain('depth')
      expect(result.content).toContain('e2e-agent-layer3a-no-input')
      expect(result.content).toContain('Required business inputs: none')
      expect(result.content).not.toContain('targetUserId')
      expect(result.content).not.toContain('00000000-0000-4000-8000-000000000001')
      expect(result.content).not.toContain('sandbox-recipes')
    }
  })

  it('synthesizes the workflow_list answer from rawContent when the result was spilled (T1.5)', async () => {
    // Regression: dev's read-only workflow fallback parses the tool result
    // `content` for `.items`. T1.5 spillover replaces `content` with a
    // `SpilloverSummary` (no `.items`) for outputs over the threshold, which
    // made the fallback report "no recipes" for users with large lists. The
    // fix parses `rawContent` (the untouched blob) first.
    const emptyResponse = new LlmError(
      'LLM produced empty response (no text, no tool calls)',
      'glm-4.7',
      LlmErrorCode.InvalidResponse,
      false
    )
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_1', name: 'workflow_list', arguments: {} }],
      },
      { type: 'error', error: emptyResponse },
      { type: 'error', error: emptyResponse },
    ])

    const workflowListTool = createMockTool('workflow_list', {
      sanitize: false,
      output: JSON.stringify({
        items: [
          {
            name: 'e2e-agent-due-diligence',
            inputContract: {
              type: 'object',
              required: ['company'],
              properties: { company: { type: 'string' } },
            },
          },
          { name: 'e2e-agent-layer3a-no-input', inputContract: null },
        ],
        count: 2,
      }),
    })

    // Mock storage that always "spills": returns a SpilloverSummary with no
    // `.items`, exactly as the real path would for an oversized output.
    const spilloverStorage = {
      maybePersist: vi.fn(async () => ({
        spillover_ref: 'spillover://task_1/tc_1.json',
        byte_size: 99999,
        line_count: 1,
        content_type: 'application/json',
        fingerprint_sha256: 'deadbeef',
        head: '{"items":[',
        tail: ']}',
        structure_hint: null,
      })),
    } as unknown as NonNullable<ReturnType<typeof buildLoopConfig>['spilloverStorage']>

    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([workflowListTool]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 4,
    })
    config.spilloverStorage = spilloverStorage
    config.taskId = 'task_1'

    const result = await runToolUseLoop(config, [
      { role: 'user', content: 'List my granted workflow recipes' },
    ])

    // Proves the output was actually spilled (content swapped for the summary).
    expect(spilloverStorage.maybePersist).toHaveBeenCalledTimes(1)
    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toContain('e2e-agent-due-diligence')
      expect(result.content).toContain('e2e-agent-layer3a-no-input')
      expect(result.content).not.toContain('I did not find workflow recipes')
    }
  })

  it('synthesizes a safe workflow_trigger answer when the LLM stays empty after approval', async () => {
    const emptyResponse = new LlmError(
      'LLM produced empty response (no text, no tool calls)',
      'glm-4.7',
      LlmErrorCode.InvalidResponse,
      false
    )
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_1', name: 'workflow_trigger', arguments: { name: 'treasury-review' } }],
      },
      { type: 'error', error: emptyResponse },
      { type: 'error', error: emptyResponse },
    ])

    const workflowTriggerTool = createMockTool('workflow_trigger', {
      sanitize: false,
      output: JSON.stringify({
        workflowName: 'treasury-review',
        target: { label: 'Treasury' },
        phase: 'Pending',
        triggeredAt: '2026-05-29T21:02:02.000Z',
        runId: '00000000-0000-4000-8000-000000000123',
        workflowNamespace: 'sandbox-recipes',
      }),
    })
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([workflowTriggerTool]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 4,
    })

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'Run treasury-review' }])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toContain('Workflow treasury-review was approved and triggered')
      expect(result.content).toContain('Treasury')
      expect(result.content).toContain('Current phase: Pending')
      expect(result.content).not.toContain('runId')
      expect(result.content).not.toContain('00000000-0000-4000-8000-000000000123')
      expect(result.content).not.toContain('sandbox-recipes')
    }
  })

  it('retries a workflow trigger request when the LLM replies without using workflow_trigger', async () => {
    const reasoning = createMockReasoning([
      { type: 'text', content: 'I can help with that workflow.' },
      {
        type: 'tool_calls',
        calls: [
          {
            id: 'tc_1',
            name: 'workflow_trigger',
            arguments: { name: 'workflow-agent-chat-due-diligence', targetLabel: 'Palmera Risk' },
          },
        ],
      },
      { type: 'text', content: 'The workflow request is now being handled.' },
    ])

    const workflowTriggerTool = createMockTool('workflow_trigger', {
      sanitize: false,
      output: JSON.stringify({
        workflowName: 'workflow-agent-chat-due-diligence',
        target: { label: 'Palmera Risk' },
        phase: 'Pending',
      }),
    })
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([workflowTriggerTool]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 4,
    })

    const result = await runToolUseLoop(config, [
      {
        role: 'user',
        content: 'Run workflow-agent-chat-due-diligence for team Palmera Risk.',
      },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toBe('The workflow request is now being handled.')
    }
    expect(reasoning.respondWithTools).toHaveBeenCalledTimes(2)
    expect(workflowTriggerTool.execute).toHaveBeenCalledTimes(1)
  })

  it('synthesizes a workflow_list answer when the LLM omits returned recipe names', async () => {
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_1', name: 'workflow_list', arguments: {} }],
      },
      { type: 'text', content: 'You have one workflow recipe available.' },
    ])

    const workflowListTool = createMockTool('workflow_list', {
      sanitize: false,
      output: JSON.stringify(
        {
          items: [
            {
              name: 'e2e-risk-review-belen-personal',
              targets: [{ kind: 'user', label: 'Personal' }],
              requiresInput: false,
              inputs: [],
              targetUserId: '00000000-0000-4000-8000-000000000002',
            },
          ],
          count: 1,
        },
        null,
        2
      ),
    })
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([workflowListTool]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 4,
    })

    const result = await runToolUseLoop(config, [
      { role: 'user', content: 'List the workflow recipes I can run.' },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toContain('e2e-risk-review-belen-personal')
      expect(result.content).toContain('Required business inputs: none')
      expect(result.content).not.toContain('targetUserId')
      expect(result.content).not.toContain('00000000-0000-4000-8000-000000000002')
    }
  })

  it('recovers workflow_list intent when the LLM answers from stale context without using the tool', async () => {
    const reasoning = createMockReasoning([
      { type: 'text', content: 'You can run stale-workflow-from-history.' },
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_1', name: 'workflow_list', arguments: {} }],
      },
      { type: 'text', content: 'You can run e2e-risk-review-fresh.' },
    ])

    const workflowListTool = createMockTool('workflow_list', {
      sanitize: false,
      output: JSON.stringify({
        items: [
          {
            name: 'e2e-risk-review-fresh',
            targets: [{ kind: 'user', label: 'Personal' }],
            requiresInput: false,
            inputs: [],
          },
        ],
        count: 1,
      }),
    })
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([workflowListTool]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 4,
    })

    const result = await runToolUseLoop(config, [
      { role: 'user', content: 'List the workflow recipes I can run.' },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toContain('e2e-risk-review-fresh')
      expect(result.content).not.toContain('stale-workflow-from-history')
    }
    expect(workflowListTool.execute).toHaveBeenCalledTimes(1)
    expect(reasoning.respondWithTools).toHaveBeenCalledTimes(2)
    expect(reasoning.continueWithToolResults).toHaveBeenCalledTimes(1)
  })

  it('fails closed when workflow_list errors instead of letting the LLM invent workflows', async () => {
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_1', name: 'workflow_list', arguments: {} }],
      },
      {
        type: 'text',
        content: 'Invoice-Processing-v2 and Packing-Slip-Generator-v1 are available.',
      },
    ])

    const workflowListTool = createMockTool('workflow_list', {
      sanitize: false,
      error: true,
      output: 'Error: reIssueTokens: unauthorized (401)',
    })
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([workflowListTool]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 4,
    })

    const result = await runToolUseLoop(config, [
      { role: 'user', content: 'What workflow recipes can I run?' },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toContain('could not retrieve the workflow recipes')
      expect(result.content).toContain('will not infer or invent workflow names')
      expect(result.content).not.toContain('Invoice-Processing-v2')
      expect(result.content).not.toContain('Packing-Slip-Generator-v1')
    }
    expect(reasoning.continueWithToolResults).not.toHaveBeenCalled()
  })

  it('does not discard successful non-workflow tool results from a mixed batch with a workflow failure', async () => {
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [
          { id: 'tc_1', name: 'workflow_list', arguments: {} },
          { id: 'tc_2', name: 'mongodb__find', arguments: { filter: { status: 'ready' } } },
        ],
      },
      { type: 'text', content: 'The MongoDB record exists.' },
    ])

    const workflowListTool = createMockTool('workflow_list', {
      sanitize: false,
      error: true,
      output: 'Error: reIssueTokens: unauthorized (401)',
    })
    const mongoFindTool = createMockTool('mongodb__find', {
      sanitize: false,
      output: 'Query returned 1 document.',
    })
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([workflowListTool, mongoFindTool]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 4,
    })

    const result = await runToolUseLoop(config, [
      { role: 'user', content: 'Check the record and workflows' },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toBe('The MongoDB record exists.')
      expect(result.content).not.toContain('could not retrieve the workflow recipes')
    }
    expect(reasoning.continueWithToolResults).toHaveBeenCalled()
  })

  it('keeps the latest successful workflow_list fallback across recovery tool calls', async () => {
    const emptyResponse = new LlmError(
      'LLM produced empty response (no text, no tool calls)',
      'glm-4.7',
      LlmErrorCode.InvalidResponse,
      false
    )
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_1', name: 'workflow_list', arguments: {} }],
      },
      { type: 'error', error: emptyResponse },
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_2', name: 'memory_search', arguments: { query: 'workflows' } }],
      },
      { type: 'error', error: emptyResponse },
    ])

    const workflowListTool = createMockTool('workflow_list', {
      sanitize: false,
      output: JSON.stringify({
        items: [{ name: 'e2e-telegram-risk-review', inputs: [] }],
        count: 1,
      }),
    })
    const memoryTool = createMockTool('memory_search', {
      sanitize: false,
      output: 'No relevant memory found.',
    })
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([workflowListTool, memoryTool]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 5,
    })

    const result = await runToolUseLoop(config, [
      { role: 'user', content: 'List my workflow recipes' },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toContain('e2e-telegram-risk-review')
      expect(result.content).toContain('Required business inputs: none')
    }
  })

  it('does not synthesize a stale workflow_list fallback from an earlier turn', async () => {
    const emptyResponse = new LlmError(
      'LLM produced empty response (no text, no tool calls)',
      'glm-4.7',
      LlmErrorCode.InvalidResponse,
      false
    )
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_2', name: 'search', arguments: { q: 'status' } }],
      },
      { type: 'error', error: emptyResponse },
      { type: 'error', error: emptyResponse },
    ])

    const searchTool = createMockTool('search', { output: 'fresh non-workflow result' })
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([searchTool]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 4,
    })

    const result = await runToolUseLoop(config, [
      { role: 'user', content: 'List workflows' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc_1', name: 'workflow_list', arguments: {} }],
      },
      {
        role: 'tool',
        name: 'workflow_list',
        tool_call_id: 'tc_1',
        content: JSON.stringify({
          items: [{ name: 'stale-workflow', inputs: [] }],
        }),
      },
      { role: 'user', content: 'Search current status' },
    ])

    expect(result.type).toBe('error')
    if (result.type === 'error') {
      expect(result.error.message).toContain('empty response')
    }
  })

  it('synthesizes a safe workflow_result artifact answer when the LLM stays empty', async () => {
    const emptyResponse = new LlmError(
      'LLM produced empty response (no text, no tool calls)',
      'glm-4.7',
      LlmErrorCode.InvalidResponse,
      false
    )
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [
          { id: 'tc_1', name: 'workflow_result', arguments: { name: 'e2e-telegram-risk-review' } },
        ],
      },
      { type: 'error', error: emptyResponse },
      { type: 'error', error: emptyResponse },
    ])

    const workflowResultTool = createMockTool('workflow_result', {
      sanitize: false,
      output: JSON.stringify({
        workflowName: 'e2e-telegram-risk-review',
        artifactAvailable: true,
        result: {
          route: 'third-party-authn-first-party-mcphost',
          marker: 'third-party-authn-first-party-mcphost-123',
          artifactProof: 'artifact-output-third-party-authn-first-party-mcphost-123',
          nested: { value: 'available-only-in-artifact' },
          rows: [{ id: 'row-1' }],
        },
      }),
    })
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([workflowResultTool]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 4,
    })

    const result = await runToolUseLoop(config, [
      { role: 'user', content: 'Show me the workflow result output' },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toContain('Workflow result for e2e-telegram-risk-review')
      expect(result.content).toContain('third-party-authn-first-party-mcphost-123')
      expect(result.content).toContain('third-party-authn-first-party-mcphost')
      expect(result.content).toContain('artifact-output-third-party-authn-first-party-mcphost-123')
      expect(result.content).toContain('Nested artifact fields omitted from this chat summary')
      expect(result.content).toContain('nested, rows')
      expect(result.content).not.toContain('[object]')
      expect(result.content).not.toContain('available-only-in-artifact')
      expect(result.content).not.toContain('artifactAvailable')
    }
  })

  it('synthesizes workflow_list inputs from the authenticated sanitized contract shape', async () => {
    const emptyResponse = new LlmError(
      'LLM produced empty response (no text, no tool calls)',
      'glm-4.7',
      LlmErrorCode.InvalidResponse,
      false
    )
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_1', name: 'workflow_list', arguments: {} }],
      },
      { type: 'error', error: emptyResponse },
      { type: 'error', error: emptyResponse },
    ])

    const workflowListTool = createMockTool('workflow_list', {
      sanitize: false,
      output: JSON.stringify(
        {
          items: [
            {
              name: 'e2e-agent-due-diligence',
              requiresInput: true,
              inputs: [
                {
                  name: 'company',
                  required: true,
                  description: 'Target company or organization.',
                },
                {
                  name: 'depth',
                  required: false,
                  options: ['standard', 'full'],
                  default: 'full',
                  description: 'Due diligence depth.',
                },
              ],
            },
          ],
          count: 1,
        },
        null,
        2
      ),
    })
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([workflowListTool]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 4,
    })

    const result = await runToolUseLoop(config, [
      { role: 'user', content: 'What workflow recipes can I run?' },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toContain('e2e-agent-due-diligence')
      expect(result.content).toContain('Required business inputs: company')
      expect(result.content).toContain('Target company or organization')
      expect(result.content).toContain('depth')
      expect(result.content).not.toContain('inputContract')
      expect(result.content).not.toContain('sandbox-recipes')
    }
  })

  it('should execute tools then return text on next iteration', async () => {
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_1', name: 'search', arguments: { q: 'X' } }],
      },
      { type: 'text', content: 'Found X' },
    ])

    const searchTool = createMockTool('search', { output: 'result for X' })
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([searchTool]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
    })

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'Find X' }])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toBe('Found X')
    }
    expect(searchTool.execute).toHaveBeenCalledWith({ q: 'X' }, undefined)
  })

  it('collects tool attachments without leaking base64 into tool messages', async () => {
    const imageBase64 = 'aW1hZ2UtYnl0ZXM='
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_1', name: 'screenshot', arguments: {} }],
      },
      { type: 'text', content: 'Screenshot delivered' },
    ])

    const screenshotTool = createMockTool('screenshot', {
      output: 'Generated 1 JPEG attachment(s).',
    })
    ;(screenshotTool.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: 'Generated 1 JPEG attachment(s).',
      duration_ms: 8,
      is_error: false,
      attachments: [
        {
          id: 'att_1',
          kind: 'image',
          mimeType: 'image/jpeg',
          encoding: 'base64',
          dataBase64: imageBase64,
        },
      ],
    })

    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([screenshotTool]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
    })

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'Take a screenshot' }])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.attachments).toHaveLength(1)
      expect(result.attachments?.[0].dataBase64).toBe(imageBase64)
    }

    const continueCall = (reasoning.continueWithToolResults as ReturnType<typeof vi.fn>).mock
      .calls[0]
    const toolResults = continueCall[1] as Array<{ content: string }>
    expect(toolResults[0].content).toContain('Generated 1 JPEG attachment(s).')
    expect(toolResults[0].content).not.toContain(imageBase64)
  })
})

// ─── Tool Timeout Tests ────────────────────────────────────

describe('runToolUseLoop — tool timeout', () => {
  it('should timeout slow tools and return error result (Risk 4.1)', async () => {
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_1', name: 'slow', arguments: {} }],
      },
      { type: 'text', content: 'Done' },
    ])

    const baseTool = createMockTool('slow')
    const slowTool: Tool = {
      name: baseTool.name,
      description: baseTool.description,
      parametersSchema: baseTool.parametersSchema,
      requiresSanitization: baseTool.requiresSanitization,
      requiresApproval: baseTool.requiresApproval,
      execute: vi.fn(
        (): Promise<ToolOutput> =>
          new Promise(resolve =>
            setTimeout(
              () =>
                resolve({
                  content: 'late',
                  duration_ms: 5000,
                  is_error: false,
                }),
              5000
            )
          )
      ),
    }

    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([slowTool]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      toolTimeout: 100, // 100ms timeout
    })

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'Do slow thing' }])

    // Loop should have continued after timeout
    expect(result.type).toBe('response')
  })
})

// ─── Missing Tool Tests ────────────────────────────────────

describe('runToolUseLoop — missing tool', () => {
  it('should return error result when tool not found in registry', async () => {
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_1', name: 'nonexistent', arguments: {} }],
      },
      { type: 'text', content: 'OK' },
    ])

    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([]), // empty registry
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
    })

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'Use tool' }])

    // Loop should continue with error tool result, then get text
    expect(result.type).toBe('response')
  })
})

// ─── Approval Tests ────────────────────────────────────────

describe('runToolUseLoop — approval', () => {
  it('should suspend loop when tool requires approval (via UnifiedApprovalGateController)', async () => {
    // Gate 2 (tool.requiresApproval() inside toolUseLoop) was removed.
    // Approval for native tools now goes through Gate 1 via UnifiedApprovalGateController.
    const { UnifiedApprovalGateController } =
      await import('../../extensions/mcpApprovalGateController')

    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_1', name: 'shell_exec', arguments: { command: 'rm' } }],
      },
    ])

    const shellTool = createMockTool('shell_exec', { approval: true })
    const registry = createMockRegistry([shellTool])
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: registry,
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      loopController: new UnifiedApprovalGateController(registry),
    })

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'Delete files' }])

    expect(result.type).toBe('need_approval')
    if (result.type === 'need_approval') {
      expect(result.approval.tool_name).toBe('shell_exec')
      expect(result.approval.tool_call_id).toBe('tc_1')
    }
    // Tool should NOT have been executed
    expect(shellTool.execute).not.toHaveBeenCalled()
  })

  it('should populate context_snapshot and completed_results on suspend', async () => {
    const { UnifiedApprovalGateController } =
      await import('../../extensions/mcpApprovalGateController')

    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [
          { id: 'tc_1', name: 'search', arguments: { q: 'X' } },
          { id: 'tc_2', name: 'shell_exec', arguments: { command: 'rm' } },
          { id: 'tc_3', name: 'cleanup', arguments: {} },
        ],
      },
    ])

    const searchTool = createMockTool('search', { output: 'found X' })
    const shellTool = createMockTool('shell_exec', { approval: true })
    const cleanupTool = createMockTool('cleanup')
    const registry = createMockRegistry([searchTool, shellTool, cleanupTool])
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: registry,
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      loopController: new UnifiedApprovalGateController(registry),
    })

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'Do things' }])

    expect(result.type).toBe('need_approval')
    if (result.type === 'need_approval') {
      // Suspended on shell_exec (tc_2)
      expect(result.approval.tool_name).toBe('shell_exec')
      expect(result.approval.tool_call_id).toBe('tc_2')

      // context_snapshot includes the assistant{tool_calls} message (F1 reorder)
      expect(result.approval.context_snapshot.length).toBeGreaterThan(0)
      const lastSnapshotMsg =
        result.approval.context_snapshot[result.approval.context_snapshot.length - 1]
      expect(lastSnapshotMsg.role).toBe('assistant')
      expect(lastSnapshotMsg.tool_calls).toBeDefined()

      // completed_results: search result + synthetic error for cleanup (F3)
      expect(result.approval.completed_results).toBeDefined()
      expect(result.approval.completed_results!.length).toBe(2)
      // First: search completed successfully
      expect(result.approval.completed_results![0].name).toBe('search')
      expect(result.approval.completed_results![0].is_error).toBe(false)
      // Second: cleanup got synthetic error (F3)
      expect(result.approval.completed_results![1].name).toBe('cleanup')
      expect(result.approval.completed_results![1].is_error).toBe(true)
      expect(result.approval.completed_results![1].content).toContain('required approval')
    }

    // search executed, shell_exec and cleanup did NOT
    expect(searchTool.execute).toHaveBeenCalled()
    expect(shellTool.execute).not.toHaveBeenCalled()
    expect(cleanupTool.execute).not.toHaveBeenCalled()
  })

  it('preserves attachments collected before approval suspension outside the LLM snapshot', async () => {
    const { UnifiedApprovalGateController } =
      await import('../../extensions/mcpApprovalGateController')

    const attachment: Attachment = {
      id: 'workflow-result-research-summary.pdf',
      kind: 'file',
      mimeType: 'application/pdf',
      encoding: 'base64',
      dataBase64: 'JVBERi0x',
      filename: 'research-summary.pdf',
      sourceTool: 'workflow_result',
      lane: 'workflow_result',
      sizeBytes: 14600,
    }
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_workflow', name: 'workflow_result', arguments: {} }],
      },
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_shell', name: 'shell_exec', arguments: { command: 'find /tmp' } }],
      },
    ])

    const workflowResultTool = createMockTool('workflow_result', {
      output: 'artifact available',
      attachments: [attachment],
    })
    const shellTool = createMockTool('shell_exec', { approval: true })
    const registry = createMockRegistry([workflowResultTool, shellTool])
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: registry,
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      loopController: new UnifiedApprovalGateController(registry),
    })

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'Get result' }])

    expect(result.type).toBe('need_approval')
    if (result.type === 'need_approval') {
      expect(result.approval.tool_name).toBe('shell_exec')
      expect(result.approval.attachments).toEqual([attachment])
      expect(result.approval.completed_results ?? []).not.toContainEqual(
        expect.objectContaining({ attachments: [attachment] })
      )
    }
  })
})

// ─── Safety Sandwich Tests ─────────────────────────────────

describe('runToolUseLoop — safety sandwich', () => {
  it('should sanitize and wrap output for tool with requiresSanitization=true (Risk 4.3a)', async () => {
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_1', name: 'search', arguments: {} }],
      },
      { type: 'text', content: 'Done' },
    ])

    const searchTool = createMockTool('search', {
      sanitize: true,
      output: 'search result data',
    })
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([searchTool]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
    })

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'Search' }])

    expect(result.type).toBe('response')
    // Verify the tool result was passed through continueWithToolResults
    const continueCall = (reasoning.continueWithToolResults as ReturnType<typeof vi.fn>).mock
      .calls[0]
    const toolResults = continueCall[1]
    // Content should be wrapped in <tool_output> tags
    expect(toolResults[0].content).toContain('<tool_output')
    expect(toolResults[0].content).toContain('search result data')
  })

  it('should return raw output for tool with requiresSanitization=false (Risk 4.3b)', async () => {
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_1', name: 'system_info', arguments: {} }],
      },
      { type: 'text', content: 'Done' },
    ])

    const sysInfoTool = createMockTool('system_info', {
      sanitize: false,
      output: 'raw system info',
    })
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([sysInfoTool]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
    })

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'System info' }])

    expect(result.type).toBe('response')
    const continueCall = (reasoning.continueWithToolResults as ReturnType<typeof vi.fn>).mock
      .calls[0]
    const toolResults = continueCall[1]
    // Raw content — no wrapping
    expect(toolResults[0].content).toBe('raw system info')
    expect(toolResults[0].content).not.toContain('<tool_output')
  })

  it('should call safety in correct order: pre-validate → validate → execute → sanitize → wrap (Risk 4.3c)', async () => {
    const callOrder: string[] = []

    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_1', name: 'search', arguments: {} }],
      },
      { type: 'text', content: 'Done' },
    ])

    const mockSafety = new BasicSafety()
    const origValidate = mockSafety.validateToolParams.bind(mockSafety)
    const origSanitize = mockSafety.sanitizeOutput.bind(mockSafety)
    const origWrap = mockSafety.wrapForLlm.bind(mockSafety)

    mockSafety.validateToolParams = (...args) => {
      callOrder.push('validate')
      return origValidate(...args)
    }
    mockSafety.sanitizeOutput = (...args) => {
      callOrder.push('sanitize')
      return origSanitize(...args)
    }
    mockSafety.wrapForLlm = (...args) => {
      callOrder.push('wrap')
      return origWrap(...args)
    }

    const searchTool = createMockTool('search', { sanitize: true })
    ;(searchTool.execute as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('execute')
      return { content: 'result', duration_ms: 10, is_error: false }
    })

    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([searchTool]),
      safety: mockSafety,
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
    })

    await runToolUseLoop(config, [{ role: 'user', content: 'Search' }])

    expect(callOrder).toEqual(['validate', 'validate', 'execute', 'sanitize', 'wrap'])
  })
})

// ─── LLM Text Preservation Tests ──────────────────────────

describe('runToolUseLoop — LLM text preservation', () => {
  it('preserves LLM text content in assistant message when tool calls have accompanying text', async () => {
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        content: 'Let me search MongoDB for your orders.',
        calls: [{ id: 'c1', name: 'mongodb__find', arguments: {} }],
      },
      { type: 'text', content: 'Here are your orders.' },
    ])

    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([createMockTool('mongodb__find')]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
    })

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'Show my orders' }])

    // Verify the reasoning port received messages with LLM text preserved
    const continueCall = reasoning.continueWithToolResults as ReturnType<typeof vi.fn>
    const context = continueCall.mock.calls[0][0]
    const assistantMsg = context.messages.find((m: any) => m.role === 'assistant' && m.tool_calls)
    expect(assistantMsg?.content).toBe('Let me search MongoDB for your orders.')
  })
})

// ─── Progress Reporter Tests ───────────────────────────────

describe('runToolUseLoop — progressReporter integration', () => {
  it('calls reportToolStart and reportToolComplete for each tool execution', async () => {
    const startEvents: ToolStartEvent[] = []
    const completeEvents: ToolCompleteEvent[] = []
    const mockReporter: ProgressReporter = {
      reportToolStart: vi.fn(e => startEvents.push(e)),
      reportToolComplete: vi.fn(e => completeEvents.push(e)),
      reportToolProgress: vi.fn(),
      reportThinking: vi.fn(),
      reportLlmInProgress: vi.fn(),
    }

    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        content: 'Let me query MongoDB.',
        calls: [
          { id: 'c1', name: 'mongodb__find', arguments: {} },
          { id: 'c2', name: 'airtable__get', arguments: {} },
        ],
      },
      { type: 'text', content: 'Done.' },
    ])

    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([
        createMockTool('mongodb__find'),
        createMockTool('airtable__get'),
      ]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      progressReporter: mockReporter,
    })

    await runToolUseLoop(config, [{ role: 'user', content: 'Go' }])

    // Two tools -> two start events, two complete events
    expect(mockReporter.reportToolStart).toHaveBeenCalledTimes(2)
    expect(mockReporter.reportToolComplete).toHaveBeenCalledTimes(2)

    // Verify first tool start event structure
    expect(startEvents[0]).toMatchObject({
      toolName: 'mongodb__find',
      displayName: 'Mongodb',
      iteration: 0,
      stepIndex: 0,
      totalSteps: 2,
    })
    expect(startEvents[0].intentSummary).toContain('MongoDB')

    // Verify second tool
    expect(startEvents[1]).toMatchObject({
      toolName: 'airtable__get',
      stepIndex: 1,
      totalSteps: 2,
    })

    // Verify complete events have duration
    expect(completeEvents[0].durationMs).toBeGreaterThanOrEqual(0)
    expect(completeEvents[0].isError).toBe(false)
  })

  it('does not crash when progressReporter is not provided', async () => {
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'c1', name: 'test__tool', arguments: {} }],
      },
      { type: 'text', content: 'Done.' },
    ])

    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([createMockTool('test__tool')]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
    })

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'Go' }])
    expect(result.type).toBe('response')
  })

  it('includes inputPreview in tool_start events', async () => {
    const startEvents: ToolStartEvent[] = []
    const mockReporter: ProgressReporter = {
      reportToolStart: vi.fn(e => startEvents.push(e)),
      reportToolComplete: vi.fn(),
      reportToolProgress: vi.fn(),
      reportThinking: vi.fn(),
      reportLlmInProgress: vi.fn(),
    }

    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'c1', name: 'shell_exec', arguments: { command: 'git status' } }],
      },
      { type: 'text', content: 'Done.' },
    ])

    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([createMockTool('shell_exec', { sanitize: true })]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      progressReporter: mockReporter,
    })

    await runToolUseLoop(config, [{ role: 'user', content: 'Go' }])

    expect(startEvents[0].inputPreview).toBe('git status')
  })

  it('includes outputPreview in tool_complete events using raw content', async () => {
    const completeEvents: ToolCompleteEvent[] = []
    const mockReporter: ProgressReporter = {
      reportToolStart: vi.fn(),
      reportToolComplete: vi.fn(e => completeEvents.push(e)),
      reportToolProgress: vi.fn(),
      reportThinking: vi.fn(),
      reportLlmInProgress: vi.fn(),
    }

    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'c1', name: 'shell_exec', arguments: { command: 'ls' } }],
      },
      { type: 'text', content: 'Done.' },
    ])

    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([
        createMockTool('shell_exec', { sanitize: true, output: 'file1.ts\nfile2.ts\nfile3.ts' }),
      ]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      progressReporter: mockReporter,
    })

    await runToolUseLoop(config, [{ role: 'user', content: 'Go' }])

    const preview = completeEvents[0].outputPreview
    expect(preview).toBeDefined()
    expect(preview!.headLines).toEqual(['file1.ts', 'file2.ts', 'file3.ts'])
    expect(preview!.truncated).toBe(false)
    // Verify it used raw content (no XML wrapper)
    expect(preview!.headLines[0]).not.toContain('<tool_output')
  })

  it('attaches LLM call usage to ONLY the first emitted tool_complete of a batch', async () => {
    const completeEvents: ToolCompleteEvent[] = []
    const mockReporter: ProgressReporter = {
      reportToolStart: vi.fn(),
      reportToolComplete: vi.fn(e => completeEvents.push(e)),
      reportToolProgress: vi.fn(),
      reportThinking: vi.fn(),
      reportLlmInProgress: vi.fn(),
    }

    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [
          { id: 'c1', name: 'tool_a', arguments: {} },
          { id: 'c2', name: 'tool_b', arguments: {} },
          { id: 'c3', name: 'tool_c', arguments: {} },
        ],
        usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
      },
      { type: 'text', content: 'Done.' },
    ])

    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([
        createMockTool('tool_a'),
        createMockTool('tool_b'),
        createMockTool('tool_c'),
      ]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      progressReporter: mockReporter,
    })

    await runToolUseLoop(config, [{ role: 'user', content: 'Go' }])

    expect(completeEvents).toHaveLength(3)
    expect(completeEvents[0].tokens).toEqual({ input: 100, output: 40 })
    expect(completeEvents[1].tokens).toBeUndefined()
    expect(completeEvents[2].tokens).toBeUndefined()
  })

  it('falls through to the next emitted tool_complete when the first call is skipped (crit #2)', async () => {
    const completeEvents: ToolCompleteEvent[] = []
    const mockReporter: ProgressReporter = {
      reportToolStart: vi.fn(),
      reportToolComplete: vi.fn(e => completeEvents.push(e)),
      reportToolProgress: vi.fn(),
      reportThinking: vi.fn(),
      reportLlmInProgress: vi.fn(),
    }

    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [
          { id: 'c1', name: 'tool_skipped', arguments: {} },
          { id: 'c2', name: 'tool_b', arguments: {} },
          { id: 'c3', name: 'tool_c', arguments: {} },
        ],
        usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
      },
      { type: 'text', content: 'Done.' },
    ])

    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([
        createMockTool('tool_skipped'),
        createMockTool('tool_b'),
        createMockTool('tool_c'),
      ]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      progressReporter: mockReporter,
      // The skip gate `continue`s before reportToolComplete — the usage must
      // land on the first tool_complete that IS emitted, not on i === 0.
      loopController: {
        beforeTool: (toolName: string) => (toolName === 'tool_skipped' ? 'skip' : 'proceed'),
      },
    })

    await runToolUseLoop(config, [{ role: 'user', content: 'Go' }])

    // Skipped tool emits no tool_complete; usage lands on the next emitted one.
    expect(completeEvents).toHaveLength(2)
    expect(completeEvents[0].toolName).toBe('tool_b')
    expect(completeEvents[0].tokens).toEqual({ input: 100, output: 40 })
    expect(completeEvents[1].tokens).toBeUndefined()
  })
})

// ─── projectToolCallTokens ─────────────────────────────────

describe('projectToolCallTokens', () => {
  it('projects all 4 fields when the provider reports cache (Anthropic)', () => {
    expect(
      projectToolCallTokens({
        input_tokens: 100,
        output_tokens: 40,
        total_tokens: 140,
        cache_read_tokens: 2000,
        cache_write_tokens: 300,
      })
    ).toEqual({ input: 100, output: 40, cacheRead: 2000, cacheWrite: 300 })
  })

  it('omits cache keys entirely (not even 0) when the provider reports no cache', () => {
    const tokens = projectToolCallTokens({
      input_tokens: 100,
      output_tokens: 40,
      total_tokens: 140,
    })
    expect(tokens).toEqual({ input: 100, output: 40 })
    expect(tokens).not.toHaveProperty('cacheRead')
    expect(tokens).not.toHaveProperty('cacheWrite')
  })

  it('returns undefined when input + output === 0', () => {
    expect(
      projectToolCallTokens({ input_tokens: 0, output_tokens: 0, total_tokens: 0 })
    ).toBeUndefined()
  })

  it('returns undefined when usage is undefined', () => {
    expect(projectToolCallTokens(undefined)).toBeUndefined()
  })

  it('includes BOTH cache fields (?? 0) when only one is defined', () => {
    expect(
      projectToolCallTokens({
        input_tokens: 100,
        output_tokens: 40,
        total_tokens: 140,
        cache_read_tokens: 2000,
      })
    ).toEqual({ input: 100, output: 40, cacheRead: 2000, cacheWrite: 0 })

    expect(
      projectToolCallTokens({
        input_tokens: 100,
        output_tokens: 40,
        total_tokens: 140,
        cache_write_tokens: 300,
      })
    ).toEqual({ input: 100, output: 40, cacheRead: 0, cacheWrite: 300 })
  })
})

describe('runToolUseLoop — llm_in_progress heartbeat', () => {
  it('emits reportLlmInProgress every 10s while reasoning is pending', async () => {
    vi.useFakeTimers()
    try {
      const mockReporter: ProgressReporter = {
        reportToolStart: vi.fn(),
        reportToolComplete: vi.fn(),
        reportToolProgress: vi.fn(),
        reportThinking: vi.fn(),
        reportLlmInProgress: vi.fn(),
      }

      let resolveReasoning: (r: RespondResult) => void = () => {}
      const slowReasoning: ReasoningPort = {
        respondWithTools: vi.fn(
          () =>
            new Promise<RespondResult>(resolve => {
              resolveReasoning = resolve
            })
        ),
        continueWithToolResults: vi.fn(),
      }

      const config = buildLoopConfig({
        reasoning: slowReasoning,
        toolRegistry: createMockRegistry([]),
        safety: new BasicSafety(),
        events: new SimpleEventEmitter(),
        conversation: makeFakeConversation(),
        progressReporter: mockReporter,
      })

      const loopPromise = runToolUseLoop(config, [{ role: 'user', content: 'Go' }])

      // 25s of reasoning time → heartbeats at 10s and 20s
      await vi.advanceTimersByTimeAsync(25_000)
      expect(mockReporter.reportLlmInProgress).toHaveBeenCalledTimes(2)

      resolveReasoning({ type: 'text', content: 'Done.' })
      await loopPromise

      // Timer cleared on resolution — no further heartbeats even if time advances
      await vi.advanceTimersByTimeAsync(30_000)
      expect(mockReporter.reportLlmInProgress).toHaveBeenCalledTimes(2)

      const first = (mockReporter.reportLlmInProgress as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as { iteration: number; elapsedMs: number }
      expect(first.iteration).toBe(0)
      expect(first.elapsedMs).toBeGreaterThanOrEqual(10_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not emit heartbeats when progressReporter is absent', async () => {
    const reasoning = createMockReasoning([{ type: 'text', content: 'Fast.' }])
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
    })

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'Go' }])
    expect(result.type).toBe('response')
  })
})

// ─── extractInputPreview Tests ────────────────────────────

describe('extractInputPreview', () => {
  it('returns command for shell_exec', () => {
    expect(extractInputPreview('shell_exec', { command: 'git status' })).toBe('git status')
  })

  it('returns key for memory_read', () => {
    expect(extractInputPreview('memory_read', { key: 'user_prefs' })).toBe('user_prefs')
  })

  it('truncates at 200 chars', () => {
    const long = 'x'.repeat(250)
    const result = extractInputPreview('shell_exec', { command: long })
    expect(result).toHaveLength(200)
    expect(result!.endsWith('...')).toBe(true)
  })

  it('returns first string arg for MCP tools', () => {
    expect(extractInputPreview('mongodb__find', { collection: 'users', filter: {} })).toBe('users')
  })

  it('returns undefined for MCP tools with no string args', () => {
    expect(extractInputPreview('mongodb__count', { limit: 10 })).toBeUndefined()
  })

  it('returns undefined for unknown native tools', () => {
    expect(extractInputPreview('unknown_tool', { data: 42 })).toBeUndefined()
  })
})

// ─── buildOutputPreview Tests ─────────────────────────────

describe('buildOutputPreview', () => {
  it('returns undefined for empty content', () => {
    expect(buildOutputPreview('')).toBeUndefined()
  })

  it('returns all lines in headLines when <= 13 lines', () => {
    const result = buildOutputPreview('line1\nline2\nline3')
    expect(result).toEqual({
      headLines: ['line1', 'line2', 'line3'],
      tailLines: [],
      totalLines: 3,
      truncated: false,
    })
  })

  it('returns exactly 13 lines without truncation', () => {
    const lines = Array.from({ length: 13 }, (_, i) => `line${i + 1}`)
    const result = buildOutputPreview(lines.join('\n'))
    expect(result!.truncated).toBe(false)
    expect(result!.headLines).toEqual(lines)
    expect(result!.tailLines).toEqual([])
  })

  it('truncates to first 3 + last 10 when > 13 lines', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`)
    const result = buildOutputPreview(lines.join('\n'))
    expect(result).toEqual({
      headLines: ['line1', 'line2', 'line3'],
      tailLines: [
        'line11',
        'line12',
        'line13',
        'line14',
        'line15',
        'line16',
        'line17',
        'line18',
        'line19',
        'line20',
      ],
      totalLines: 20,
      truncated: true,
    })
  })

  it('caps individual lines at 200 chars', () => {
    const longLine = 'x'.repeat(250)
    const result = buildOutputPreview(longLine)
    expect(result!.headLines[0]).toHaveLength(200)
    expect(result!.headLines[0].endsWith('...')).toBe(true)
  })

  it('handles single line content', () => {
    const result = buildOutputPreview('only line')
    expect(result).toEqual({
      headLines: ['only line'],
      tailLines: [],
      totalLines: 1,
      truncated: false,
    })
  })
})

// ─── AbortSignal / Cancellation Tests ─────────────────────

describe('runToolUseLoop — cancellation', () => {
  it('returns cancelled result when signal is aborted before LLM call', async () => {
    const controller = new AbortController()
    controller.abort()

    const reasoning = createMockReasoning([{ type: 'text', content: 'Hello' }])
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 5,
    })
    config.abortSignal = controller.signal

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'hello' }])

    expect(result.type).toBe('cancelled')
    expect(reasoning.respondWithTools).not.toHaveBeenCalled()
  })

  it('returns cancelled when signal aborts mid tool-call batch', async () => {
    const controller = new AbortController()

    let callCount = 0
    const tool1 = createMockTool('echo1')
    ;(tool1.execute as ReturnType<typeof vi.fn>).mockImplementation(
      async (): Promise<ToolOutput> => {
        callCount++
        controller.abort()
        return { content: 'ok', duration_ms: 5, is_error: false }
      }
    )

    const tool2 = createMockTool('echo2')
    ;(tool2.execute as ReturnType<typeof vi.fn>).mockImplementation(
      async (): Promise<ToolOutput> => {
        callCount++
        return { content: 'ok', duration_ms: 5, is_error: false }
      }
    )

    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [
          { id: 't1', name: 'echo1', arguments: {} },
          { id: 't2', name: 'echo2', arguments: {} },
        ],
      },
    ])

    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([tool1, tool2]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
      maxIterations: 5,
    })
    config.abortSignal = controller.signal

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'go' }])

    expect(result.type).toBe('cancelled')
    expect(callCount).toBe(1) // second tool never ran
  })

  it('returns cancelled when signal aborts before final text response (checkpoint c)', async () => {
    const controller = new AbortController()

    const reasoning: ReasoningPort = {
      respondWithTools: vi.fn(async () => {
        controller.abort()
        return { type: 'text' as const, content: 'never returned' }
      }),
      continueWithToolResults: vi.fn(),
    }

    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([]),
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation: makeFakeConversation(),
    })
    config.abortSignal = controller.signal

    const result = await runToolUseLoop(config, [{ role: 'user', content: 'hi' }])

    expect(result.type).toBe('cancelled')
  })
})

// ─── Event Emission Tests ──────────────────────────────────

describe('runToolUseLoop — events', () => {
  it('should emit loop:iteration and loop:completed events', async () => {
    const events = new SimpleEventEmitter()
    const emitted: string[] = []
    events.on('loop:iteration', () => emitted.push('loop:iteration'))
    events.on('loop:completed', () => emitted.push('loop:completed'))

    const reasoning = createMockReasoning([{ type: 'text', content: 'Hi' }])
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: createMockRegistry([]),
      safety: new BasicSafety(),
      events,
      conversation: makeFakeConversation(),
    })

    await runToolUseLoop(config, [{ role: 'user', content: 'Hi' }])

    expect(emitted).toContain('loop:iteration')
    expect(emitted).toContain('loop:completed')
  })
})

describe('executeSingleTool — progress watcher', () => {
  // Minimal loop config for testing executeSingleTool directly.
  function makeConfig(overrides: Partial<any> = {}): any {
    return {
      toolRegistry: {
        get: (_name: string) => overrides.tool ?? null,
      },
      toolOutputProcessor: {
        beforeExecution: () => ({ is_valid: true, errors: [] }),
        afterExecution: (_n: string, out: any) => out.content,
      },
      // executeSingleTool sanitizes preview content via safety.sanitizeOutput
      // before publishing tool_progress / tool_complete previews. Stub it as
      // a passthrough here — security behavior is exercised in safety tests.
      safety: {
        sanitizeOutput: (_n: string, output: string) => ({
          content: output,
          was_modified: false,
          warnings: [],
        }),
      },
      events: { emit: () => {} },
      toolTimeout: 60_000,
      toolProgressInterval: 30_000,
      progressReporter: overrides.progressReporter,
      ...overrides,
    }
  }

  function makeCall(name = 'shell_exec'): any {
    return { id: 'call-1', name, arguments: { command: 'echo hi' } }
  }

  function makeReporterMock() {
    return {
      reportToolStart: vi.fn(),
      reportToolComplete: vi.fn(),
      reportToolProgress: vi.fn(),
      reportThinking: vi.fn(),
      reportLlmInProgress: vi.fn(),
    }
  }

  it('does NOT start a watcher when tool.supportsProgressOutput is undefined', async () => {
    vi.useFakeTimers()
    const reporter = makeReporterMock()
    const tool = {
      execute: vi.fn(async () => ({ content: 'ok', is_error: false, duration_ms: 1 })),
      requiresSanitization: () => false,
      // NO supportsProgressOutput
    }

    const config = makeConfig({ tool, progressReporter: reporter })
    const p = executeSingleTool(makeCall(), config)
    await vi.advanceTimersByTimeAsync(60_000)
    await p

    expect(reporter.reportToolProgress).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('does NOT start a watcher when supportsProgressOutput returns false', async () => {
    vi.useFakeTimers()
    const reporter = makeReporterMock()
    const tool = {
      execute: vi.fn(async () => ({ content: 'ok', is_error: false, duration_ms: 1 })),
      requiresSanitization: () => false,
      supportsProgressOutput: () => false,
    }

    const config = makeConfig({ tool, progressReporter: reporter })
    const p = executeSingleTool(makeCall(), config)
    await vi.advanceTimersByTimeAsync(60_000)
    await p

    expect(reporter.reportToolProgress).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('does NOT start a watcher when toolProgressInterval is 0', async () => {
    vi.useFakeTimers()
    const reporter = makeReporterMock()
    const tool = {
      execute: vi.fn(async () => ({ content: 'ok', is_error: false, duration_ms: 1 })),
      requiresSanitization: () => false,
      supportsProgressOutput: () => true,
    }

    const config = makeConfig({ tool, progressReporter: reporter, toolProgressInterval: 0 })
    const p = executeSingleTool(makeCall(), config)
    await vi.advanceTimersByTimeAsync(60_000)
    await p

    expect(reporter.reportToolProgress).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('starts the watcher and publishes a tool_progress event on interval', async () => {
    vi.useFakeTimers()
    const reporter = makeReporterMock()
    // Tool that calls context.onOutput BEFORE resolving — so watcher has dirty data.
    let resolveTool: (v: any) => void = () => {}
    const tool = {
      execute: vi.fn((_args: any, ctx: any) => {
        return new Promise<any>(r => {
          resolveTool = r
          // Feed some output into the ring buffer so the watcher has something to publish.
          ctx?.onOutput?.('line one\n')
        })
      }),
      requiresSanitization: () => false,
      supportsProgressOutput: () => true,
    }

    const config = makeConfig({
      tool,
      progressReporter: reporter,
      toolProgressInterval: 1000,
    })
    const p = executeSingleTool(makeCall(), config)

    // Advance past one interval — watcher should fire.
    await vi.advanceTimersByTimeAsync(1000)

    expect(reporter.reportToolProgress).toHaveBeenCalledTimes(1)
    const call = reporter.reportToolProgress.mock.calls[0][0]
    expect(call.toolCallId).toBe('call-1')
    expect(call.toolName).toBe('shell_exec')
    expect(call.elapsedMs).toBeGreaterThanOrEqual(1000)
    expect(call.outputPreview).toBeDefined()
    expect(call.outputPreview.headLines).toContain('line one')

    resolveTool({ content: 'done', is_error: false, duration_ms: 1 })
    await p
    vi.useRealTimers()
  })

  it('publishes heartbeat events with elapsedMs even when command is silent (no outputPreview)', async () => {
    vi.useFakeTimers()
    const reporter = makeReporterMock()
    let resolveTool: (v: any) => void = () => {}
    const tool = {
      execute: vi.fn((_args: any, _ctx: any) => {
        // Tool produces NO output — ring buffer stays empty.
        return new Promise<any>(r => {
          resolveTool = r
        })
      }),
      requiresSanitization: () => false,
      supportsProgressOutput: () => true,
    }

    const config = makeConfig({
      tool,
      progressReporter: reporter,
      toolProgressInterval: 1000,
    })
    const p = executeSingleTool(makeCall(), config)
    await vi.advanceTimersByTimeAsync(3000) // 3 ticks

    // Watcher fires every tick, publishing elapsedMs so the UI can tick the
    // "running · Xs" counter — even for silent commands. outputPreview is
    // omitted when no new bytes arrived (avoids spamming stale previews).
    expect(reporter.reportToolProgress).toHaveBeenCalledTimes(3)
    for (const call of reporter.reportToolProgress.mock.calls) {
      const event = call[0]
      expect(event.toolCallId).toBe('call-1')
      expect(event.elapsedMs).toBeGreaterThanOrEqual(0)
      expect(event.outputPreview).toBeUndefined()
    }

    resolveTool({ content: 'done', is_error: false, duration_ms: 1 })
    await p
    vi.useRealTimers()
  })

  it('clears the watcher on normal completion (no leaked intervals)', async () => {
    vi.useFakeTimers()
    const reporter = makeReporterMock()
    const tool = {
      execute: vi.fn(async () => ({ content: 'done', is_error: false, duration_ms: 1 })),
      requiresSanitization: () => false,
      supportsProgressOutput: () => true,
    }

    const config = makeConfig({
      tool,
      progressReporter: reporter,
      toolProgressInterval: 1000,
    })
    await executeSingleTool(makeCall(), config)

    // Advance well past what would have been many intervals — no further publishes.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(reporter.reportToolProgress).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('clears the watcher on timeout path (no leaked intervals)', async () => {
    vi.useFakeTimers()
    const reporter = makeReporterMock()
    // Tool that never resolves — triggers Promise.race timeout.
    const tool = {
      execute: vi.fn(() => new Promise(() => {})),
      requiresSanitization: () => false,
      supportsProgressOutput: () => true,
    }

    const config = makeConfig({
      tool,
      progressReporter: reporter,
      toolTimeout: 500,
      toolProgressInterval: 1000,
    })
    const p = executeSingleTool(makeCall(), config)
    await vi.advanceTimersByTimeAsync(500) // fire timeout
    const result = await p

    expect(result.is_error).toBe(true)
    // Advance more and verify no leaked interval fires.
    const before = reporter.reportToolProgress.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(reporter.reportToolProgress.mock.calls.length).toBe(before)
    vi.useRealTimers()
  })
})
