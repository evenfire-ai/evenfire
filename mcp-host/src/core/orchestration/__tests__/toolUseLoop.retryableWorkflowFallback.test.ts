import { describe, expect, it } from 'vitest'
import { LlmError, LlmErrorCode } from '../../errors'
import { runToolUseLoop } from '../toolUseLoop'
import {
  buildTestConfig,
  createMockReasoning,
  createMockTool,
} from './toolUseLoopRetryableTestUtils'

function retryableConnectionError(): LlmError {
  return new LlmError('Connection error.', 'zai', LlmErrorCode.ApiCallFailed, true)
}

function exhaustedRetryableConnectionErrors() {
  return [
    { type: 'error' as const, error: retryableConnectionError() },
    { type: 'error' as const, error: retryableConnectionError() },
  ]
}

describe('runToolUseLoop retryable workflow fallback', () => {
  it('returns workflow_result output when final LLM synthesis fails retryably', async () => {
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [
          { id: 'tc_1', name: 'workflow_result', arguments: { name: 'treasury-risk-review' } },
        ],
      },
      ...exhaustedRetryableConnectionErrors(),
    ])
    const workflowResultTool = createMockTool('workflow_result', {
      sanitize: false,
      output: JSON.stringify({
        workflowName: 'treasury-risk-review',
        result: {
          marker: 'telegram-workflow-result-777',
          artifactProof: 'artifact-output-treasury-risk-review-777',
          nestedArtifactOnly: { proof: 'not-for-chat-summary' },
        },
      }),
    })

    const result = await runToolUseLoop(buildTestConfig(reasoning, [workflowResultTool]), [
      { role: 'user', content: 'Show me the workflow result artifact for treasury-risk-review.' },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toContain('Workflow result for treasury-risk-review')
      expect(result.content).toContain('telegram-workflow-result-777')
      expect(result.content).toContain('artifact-output-treasury-risk-review-777')
      expect(result.content).toContain('Nested artifact fields omitted')
      expect(result.content).not.toContain('Connection error')
      expect(result.content).not.toContain('not-for-chat-summary')
    }
  })

  it('returns workflow_trigger output when final LLM synthesis fails retryably', async () => {
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [
          { id: 'tc_1', name: 'workflow_trigger', arguments: { name: 'treasury-risk-review' } },
        ],
      },
      ...exhaustedRetryableConnectionErrors(),
    ])
    const workflowTriggerTool = createMockTool('workflow_trigger', {
      sanitize: false,
      output: JSON.stringify({
        workflowName: 'treasury-risk-review',
        target: { label: 'Treasury' },
        phase: 'Pending',
        runId: '00000000-0000-4000-8000-000000000777',
      }),
    })

    const result = await runToolUseLoop(buildTestConfig(reasoning, [workflowTriggerTool]), [
      { role: 'user', content: 'Run treasury-risk-review.' },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toContain('Workflow treasury-risk-review was approved and triggered')
      expect(result.content).toContain('Treasury')
      expect(result.content).toContain('Current phase: Pending')
      expect(result.content).not.toContain('runId')
      expect(result.content).not.toContain('00000000-0000-4000-8000-000000000777')
    }
  })

  it('prioritizes workflow_trigger over workflow_list in mixed successful batches', async () => {
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [
          { id: 'tc_1', name: 'workflow_list', arguments: {} },
          { id: 'tc_2', name: 'workflow_trigger', arguments: { name: 'treasury-risk-review' } },
        ],
      },
      ...exhaustedRetryableConnectionErrors(),
    ])
    const workflowListTool = createMockTool('workflow_list', {
      sanitize: false,
      output: JSON.stringify({
        items: [{ name: 'treasury-risk-review' }, { name: 'vendor-review' }],
        count: 2,
      }),
    })
    const workflowTriggerTool = createMockTool('workflow_trigger', {
      sanitize: false,
      output: JSON.stringify({
        workflowName: 'treasury-risk-review',
        target: { label: 'Treasury' },
        phase: 'Pending',
      }),
    })

    const result = await runToolUseLoop(
      buildTestConfig(reasoning, [workflowListTool, workflowTriggerTool]),
      [{ role: 'user', content: 'Run treasury-risk-review.' }]
    )

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toContain('Workflow treasury-risk-review was approved and triggered')
      expect(result.content).toContain('Current phase: Pending')
      expect(result.content).not.toContain('Workflow recipes you can trigger')
      expect(result.content).not.toContain('vendor-review')
    }
  })

  it('returns workflow_status output when final LLM synthesis fails retryably', async () => {
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [
          { id: 'tc_1', name: 'workflow_status', arguments: { name: 'treasury-risk-review' } },
        ],
      },
      ...exhaustedRetryableConnectionErrors(),
    ])
    const workflowStatusTool = createMockTool('workflow_status', {
      sanitize: false,
      output: JSON.stringify({
        name: 'treasury-risk-review',
        phase: 'Ready',
        workflowPhase: null,
        latestRun: {
          id: '00000000-0000-4000-8000-000000000999',
          phase: 'Succeeded',
          completedAt: null,
          message: 'Completed with artifact output.',
        },
      }),
    })

    const result = await runToolUseLoop(buildTestConfig(reasoning, [workflowStatusTool]), [
      { role: 'user', content: 'Check workflow status for treasury-risk-review.' },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toContain('Workflow status for treasury-risk-review')
      expect(result.content).toContain('Phase: Ready')
      expect(result.content).toContain('Latest run: phase: Succeeded')
      expect(result.content).toContain('message: Completed with artifact output.')
      expect(result.content).not.toContain('Workflow phase: null')
      expect(result.content).not.toContain('completedAt: null')
      expect(result.content).not.toContain('00000000-0000-4000-8000-000000000999')
      expect(result.content).not.toContain('Connection error')
    }
  })

  it('prioritizes workflow_status over workflow_list in mixed read-only batches', async () => {
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [
          { id: 'tc_1', name: 'workflow_list', arguments: {} },
          { id: 'tc_2', name: 'workflow_status', arguments: { name: 'treasury-risk-review' } },
        ],
      },
      ...exhaustedRetryableConnectionErrors(),
    ])
    const workflowListTool = createMockTool('workflow_list', {
      sanitize: false,
      output: JSON.stringify({
        items: [{ name: 'treasury-risk-review' }, { name: 'vendor-review' }],
        count: 2,
      }),
    })
    const workflowStatusTool = createMockTool('workflow_status', {
      sanitize: false,
      output: JSON.stringify({
        name: 'treasury-risk-review',
        workflowPhase: 'Succeeded',
        latestRun: { phase: 'Succeeded' },
      }),
    })

    const result = await runToolUseLoop(
      buildTestConfig(reasoning, [workflowListTool, workflowStatusTool]),
      [{ role: 'user', content: 'Check workflow status for treasury-risk-review.' }]
    )

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toContain('Workflow status for treasury-risk-review')
      expect(result.content).toContain('Workflow phase: Succeeded')
      expect(result.content).not.toContain('Workflow recipes you can trigger')
      expect(result.content).not.toContain('vendor-review')
    }
  })

  it('returns workflow_health output when final LLM synthesis fails retryably', async () => {
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [
          { id: 'tc_1', name: 'workflow_health', arguments: { name: 'treasury-risk-review' } },
        ],
      },
      ...exhaustedRetryableConnectionErrors(),
    ])
    const workflowHealthTool = createMockTool('workflow_health', {
      sanitize: false,
      output: JSON.stringify({
        name: 'treasury-risk-review',
        phase: 'Ready',
        workflowPhase: 'Succeeded',
        activeRuns: 0,
        lastRun: {
          phase: 'Succeeded',
          message: 'Completed with artifact output.',
        },
      }),
    })

    const result = await runToolUseLoop(buildTestConfig(reasoning, [workflowHealthTool]), [
      { role: 'user', content: 'Check workflow health for treasury-risk-review.' },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toContain('Workflow health for treasury-risk-review')
      expect(result.content).toContain('Active runs: 0')
      expect(result.content).toContain('Last run: phase: Succeeded')
      expect(result.content).not.toContain('Connection error')
    }
  })

  it('does not synthesize a workflow fallback for non-workflow tools', async () => {
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_1', name: 'search', arguments: { q: 'treasury' } }],
      },
      ...exhaustedRetryableConnectionErrors(),
    ])
    const searchTool = createMockTool('search', {
      sanitize: false,
      output: 'Search returned one document.',
    })

    const result = await runToolUseLoop(buildTestConfig(reasoning, [searchTool]), [
      { role: 'user', content: 'Search treasury notes.' },
    ])

    expect(result.type).toBe('error')
    if (result.type === 'error') {
      expect(result.error.message).toContain('Connection error')
    }
  })

  it('does not synthesize a workflow fallback for non-retryable LLM errors', async () => {
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [
          { id: 'tc_1', name: 'workflow_result', arguments: { name: 'treasury-risk-review' } },
        ],
      },
      {
        type: 'error',
        error: new LlmError(
          'Authentication failed.',
          'zai',
          LlmErrorCode.AuthenticationFailed,
          false
        ),
      },
    ])
    const workflowResultTool = createMockTool('workflow_result', {
      sanitize: false,
      output: JSON.stringify({
        workflowName: 'treasury-risk-review',
        result: { artifactProof: 'artifact-output-treasury-risk-review-888' },
      }),
    })

    const result = await runToolUseLoop(buildTestConfig(reasoning, [workflowResultTool]), [
      { role: 'user', content: 'Show me the workflow result artifact for treasury-risk-review.' },
    ])

    expect(result.type).toBe('error')
    if (result.type === 'error') {
      expect(result.error.message).toContain('Authentication failed')
    }
  })
})
