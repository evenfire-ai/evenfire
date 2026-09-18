import { describe, expect, it } from 'vitest'
import { LlmError, LlmErrorCode } from '../../errors'
import { runToolUseLoop } from '../toolUseLoop'
import {
  buildTestConfig,
  createMockReasoning,
  createMockTool,
} from './toolUseLoopRetryableTestUtils'

// A workflow tool result is the one case where a retryable LLM failure is
// turned into a synthesized reply, so it is the setup that could hide the
// tool-call limit behind a fallback response.
function workflowResultTool() {
  return createMockTool('workflow_result', {
    sanitize: false,
    output: JSON.stringify({
      workflowName: 'treasury-risk-review',
      result: { artifactProof: 'artifact-output-treasury-risk-review-680' },
    }),
  })
}

function reasoningFailingAfterToolResults(error: LlmError) {
  return createMockReasoning([
    {
      type: 'tool_calls',
      calls: [{ id: 'tc_1', name: 'workflow_result', arguments: { name: 'treasury-risk-review' } }],
    },
    { type: 'error', error },
    { type: 'text', content: 'a second LLM call must not happen' },
  ])
}

describe('runToolUseLoop tool-call limit', () => {
  it('ends the loop with LLM_TOOL_CALL_LIMIT_EXCEEDED and no workflow fallback', async () => {
    const limit = new LlmError(
      'tool calls exceed 64',
      'codex-subscription',
      LlmErrorCode.ToolCallLimitExceeded,
      false
    )
    const reasoning = reasoningFailingAfterToolResults(limit)
    const tool = workflowResultTool()

    const result = await runToolUseLoop(buildTestConfig(reasoning, [tool]), [
      { role: 'user', content: 'Show me the workflow result artifact for treasury-risk-review.' },
    ])

    // Liveness witness: the tool ran and exactly one LLM call followed its result.
    expect(tool.execute).toHaveBeenCalledTimes(1)
    expect(reasoning.respondWithTools).toHaveBeenCalledTimes(1)
    expect(reasoning.continueWithToolResults).toHaveBeenCalledTimes(1)
    expect(result.type).toBe('error')
    if (result.type !== 'error') throw new Error(`expected an error result, got ${result.type}`)
    expect(result.error).toBe(limit)
    expect((result.error as LlmError).code).toBe('LLM_TOOL_CALL_LIMIT_EXCEEDED')
  })

  it('still synthesizes the workflow fallback for a retryable overload (fallback path witness)', async () => {
    const overload = new LlmError(
      'provider unavailable',
      'codex-subscription',
      LlmErrorCode.ModelOverloaded,
      true
    )
    const reasoning = reasoningFailingAfterToolResults(overload)

    const result = await runToolUseLoop(buildTestConfig(reasoning, [workflowResultTool()]), [
      { role: 'user', content: 'Show me the workflow result artifact for treasury-risk-review.' },
    ])

    expect(reasoning.continueWithToolResults).toHaveBeenCalledTimes(1)
    expect(result.type).toBe('response')
    if (result.type !== 'response') throw new Error(`expected a response, got ${result.type}`)
    expect(result.content).toContain('artifact-output-treasury-risk-review-680')
  })
})
