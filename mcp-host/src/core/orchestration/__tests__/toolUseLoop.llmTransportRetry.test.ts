import { describe, expect, it } from 'vitest'
import { LlmError, LlmErrorCode } from '../../errors'
import { runToolUseLoop } from '../toolUseLoop'
import {
  buildTestConfig,
  createMockReasoning,
  createMockTool,
} from './toolUseLoopRetryableTestUtils'

function retryableTransportError(): LlmError {
  return new LlmError('Connection error.', 'zai', LlmErrorCode.ApiCallFailed, true)
}

function retryableRateLimitError(): LlmError {
  return new LlmError('rate limited', 'zai', LlmErrorCode.RateLimited, true)
}

describe('runToolUseLoop LLM transport retry', () => {
  it('retries a retryable transport failure once before surfacing a response', async () => {
    const reasoning = createMockReasoning([
      { type: 'error', error: retryableTransportError() },
      { type: 'text', content: 'Here are the workflow recipes you can run.' },
    ])
    const result = await runToolUseLoop(buildTestConfig(reasoning, []), [
      { role: 'user', content: 'What workflow recipes can I run?' },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') expect(result.content).toContain('workflow recipes')
    expect(reasoning.respondWithTools).toHaveBeenCalledTimes(2)
    expect(reasoning.continueWithToolResults).not.toHaveBeenCalled()
  })

  it('does not retry retryable non-transport LLM failures', async () => {
    const reasoning = createMockReasoning([{ type: 'error', error: retryableRateLimitError() }])
    const result = await runToolUseLoop(buildTestConfig(reasoning, []), [
      { role: 'user', content: 'hello' },
    ])

    expect(result.type).toBe('error')
    if (result.type === 'error') expect(result.error.message).toContain('rate limited')
    expect(reasoning.respondWithTools).toHaveBeenCalledTimes(1)
  })

  it('retries a retryable transport failure after tool results without rerunning tools', async () => {
    const tool = createMockTool('lookup', { output: 'lookup result', sanitize: false })
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_1', name: 'lookup', arguments: {} }],
      },
      { type: 'error', error: retryableTransportError() },
      { type: 'text', content: 'lookup result is ready' },
    ])

    const result = await runToolUseLoop(buildTestConfig(reasoning, [tool]), [
      { role: 'user', content: 'lookup data' },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') expect(result.content).toContain('lookup result')
    expect(tool.execute).toHaveBeenCalledTimes(1)
    expect(reasoning.respondWithTools).toHaveBeenCalledTimes(1)
    expect(reasoning.continueWithToolResults).toHaveBeenCalledTimes(2)
  })

  it('uses workflow success fallback only after post-tool transport retry is exhausted', async () => {
    const tool = createMockTool('workflow_trigger', {
      output: JSON.stringify({
        workflowName: 'risk-review',
        phase: 'Pending',
        message: 'Workflow run created.',
      }),
      sanitize: false,
    })
    const reasoning = createMockReasoning([
      {
        type: 'tool_calls',
        calls: [{ id: 'tc_1', name: 'workflow_trigger', arguments: { name: 'risk-review' } }],
      },
      { type: 'error', error: retryableTransportError() },
      { type: 'error', error: retryableTransportError() },
    ])

    const result = await runToolUseLoop(buildTestConfig(reasoning, [tool]), [
      { role: 'user', content: 'Run risk-review' },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') {
      expect(result.content).toContain('Workflow risk-review was approved and triggered')
      expect(result.content).toContain('Workflow run created.')
    }
    expect(tool.execute).toHaveBeenCalledTimes(1)
    expect(reasoning.respondWithTools).toHaveBeenCalledTimes(1)
    expect(reasoning.continueWithToolResults).toHaveBeenCalledTimes(2)
  })
})
