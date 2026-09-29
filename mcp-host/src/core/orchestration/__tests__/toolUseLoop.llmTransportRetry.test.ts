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

// What codexSubscription's classifier builds for a proxy connect-phase failure
// (hop H4) or a gateway's control_plane_unavailable reply (hops H2/H3).
function controlPlaneUnavailableError(retryable: boolean): LlmError {
  return new LlmError(
    'proxy could not be reached (ECONNREFUSED)',
    'codex-subscription',
    LlmErrorCode.ControlPlaneUnavailable,
    retryable,
    undefined,
    undefined,
    'control_plane_unavailable'
  )
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

  // Review round 2 M4 (#720): on dev a refused proxy connect was a retryable
  // ApiCallFailed and took this retry; relabelling it must not drop it.
  it('G1-12a retries a retryable control_plane_unavailable once like a transport failure', async () => {
    const reasoning = createMockReasoning([
      { type: 'error', error: controlPlaneUnavailableError(true) },
      { type: 'text', content: 'Here are the workflow recipes you can run.' },
    ])
    const result = await runToolUseLoop(buildTestConfig(reasoning, []), [
      { role: 'user', content: 'What workflow recipes can I run?' },
    ])

    expect(result.type).toBe('response')
    if (result.type === 'response') expect(result.content).toContain('workflow recipes')
    expect(reasoning.respondWithTools).toHaveBeenCalledTimes(2)
  })

  it('G1-12b does not retry a control_plane_unavailable that is not retryable', async () => {
    const reasoning = createMockReasoning([
      { type: 'error', error: controlPlaneUnavailableError(false) },
      { type: 'text', content: 'never reached' },
    ])
    const result = await runToolUseLoop(buildTestConfig(reasoning, []), [
      { role: 'user', content: 'hello' },
    ])

    expect(result.type).toBe('error')
    if (result.type === 'error') expect(result.error.message).toContain('could not be reached')
    // Witness: the loop did call the model and surfaced this error.
    expect(reasoning.respondWithTools).toHaveBeenCalledTimes(1)
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
