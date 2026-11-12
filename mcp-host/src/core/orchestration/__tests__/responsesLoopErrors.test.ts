/**
 * How the official OpenAI endpoint (Responses) fails inside the real tool
 * loop: a cancelled send and a rejected replay. Only `responses.create` is
 * doubled; the driver, adapter, reasoning port and loop all run.
 */
import { describe, expect, it, vi } from 'vitest'
import OpenAI from 'openai'
import { openaiApiError } from '../../../llm/__tests__/sdkErrorFixtures'
import { OpenAIProvider } from '../../../llm/openai'
import {
  RESPONSES_MODEL,
  type RecordedItem,
  recordedResponse,
} from '../../../llm/openaiFamily/__tests__/responsesFixtures'
import { LlmPortAdapter } from '../../adapters/llmPortAdapter'
import { LlmError, LlmErrorCode } from '../../errors'
import type { Tool } from '../../interfaces'
import { registry, runLoop } from './loopHistory'

type Create = (payload: { input: RecordedItem[] }, options?: { signal?: AbortSignal }) => unknown

function officialDriver(create: Create) {
  const spy = vi.fn(create)
  const provider = new OpenAIProvider('unit-key', RESPONSES_MODEL)
  ;(provider as unknown as { client: unknown }).client = {
    baseURL: 'https://api.openai.com/v1',
    responses: { create: spy },
    chat: { completions: { create: vi.fn() } },
  }
  return { port: new LlmPortAdapter(provider, RESPONSES_MODEL, 'openai'), create: spy }
}

function executions(tools: ReturnType<typeof registry>): number {
  return ['get_weather', 'get_time'].reduce(
    (n, name) => n + vi.mocked((tools.get(name) as Tool).execute).mock.calls.length,
    0
  )
}

describe('T-E2 an abort during the Responses send', () => {
  it('makes exactly one responses.create call and executes no tool', async () => {
    const controller = new AbortController()
    const tools = registry()
    const { port, create } = officialDriver(
      (_payload, options) =>
        new Promise((_resolve, reject) => {
          // The SDK rejects an in-flight request with this error when its signal aborts.
          options?.signal?.addEventListener('abort', () => reject(new OpenAI.APIUserAbortError()))
          queueMicrotask(() => controller.abort())
        })
    )

    const result = await runLoop(port, undefined, {
      abortSignal: controller.signal,
      toolRegistry: tools,
    })

    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]![1]?.signal).toBe(controller.signal)
    expect(executions(tools)).toBe(0)
    expect(result.type).toBe('cancelled')
  })
})

describe('T-E3 the provider rejects a replayed continuation', () => {
  it('fails the turn with a classified, non-retryable error after one replay call', async () => {
    const tools = registry()
    // Body as recorded when a tampered blob was replayed (`v7-tampered-blob`).
    const rejected = openaiApiError(400, {
      code: 'invalid_encrypted_content',
      type: 'invalid_request_error',
      message:
        'The encrypted content for item rs_fixture0001 could not be verified. Reason: Encrypted content could not be decrypted or parsed.',
    })
    let calls = 0
    const { port, create } = officialDriver(async () => {
      calls += 1
      if (calls === 1) return recordedResponse('v1-rfc-gpt-6.1-terra')
      throw rejected
    })

    const result = await runLoop(port, undefined, { toolRegistry: tools })

    // One tool turn, then the single replay that the provider rejected.
    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[1]![0].input.some(item => item.type === 'reasoning')).toBe(true)
    expect(executions(tools)).toBe(1)
    expect(result.type).toBe('error')
    const error = (result as { type: 'error'; error: Error }).error
    expect(error).toBeInstanceOf(LlmError)
    // #1433: a provider HTTP 400 is a rejected request, not "Connection Error".
    expect(error).toMatchObject({
      code: LlmErrorCode.UpstreamRejected,
      retryable: false,
      httpStatus: 400,
      providerCode: 'invalid_encrypted_content',
    })
  })
})
