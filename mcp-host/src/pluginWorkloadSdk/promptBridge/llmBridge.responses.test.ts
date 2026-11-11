/**
 * The plugin prompt bridge against the official OpenAI endpoint (Responses).
 * Only `responses.create` of the real driver is doubled with recorded
 * responses; the bridge, its breaker and the driver all run.
 */
import { describe, expect, it, vi } from 'vitest'
import { FinishReason } from '../../core/types'
import type { SingleTurnProvider, createLLMProvider } from '../../llm'
import {
  type RecordedResponse,
  recordedResponse,
} from '../../llm/openaiFamily/__tests__/responsesFixtures'
import { makeProvider } from '../../llm/registry'
import type { ApiKeys, ModelConfig } from '../../types'
import { CircuitBreaker } from '../domain/circuitBreaker'
import { PluginWorkloadError } from '../domain/errors'
import type { PromptBridgeTarget } from '../domain/types'
import { LlmBridge, type PromptBridgeCredentialResolver } from './llmBridge'

const primary: PromptBridgeTarget = {
  targetRef: 'primary-openai',
  provider: 'openai',
  model: 'gpt-6.1-terra',
  credentialSlot: 'openai-api-key',
}
const fallback: PromptBridgeTarget = {
  targetRef: 'fallback-zai',
  provider: 'zai',
  model: 'glm-5.1',
  credentialSlot: 'zai-api-key',
}

function officialDriver(answers: Array<() => Promise<unknown>>) {
  const driver = makeProvider('openai', { 'openai-api-key': 'unit-key' }, primary.model)
  const create = vi.fn(async (_payload: unknown) => {
    const next = answers.shift()
    if (!next) throw new Error('no more answers')
    return next()
  })
  ;(driver as unknown as { client: unknown }).client = {
    baseURL: 'https://api.openai.com/v1',
    responses: { create },
    chat: { completions: { create: vi.fn() } },
  }
  return { driver, create }
}

function bridgeOver(providers: Record<string, SingleTurnProvider>) {
  const resolver: PromptBridgeCredentialResolver = {
    resolve: vi.fn(async ({ target }) => ({
      target,
      keys: { [target.provider]: { [target.credentialSlot]: 'unit-key' } } as ApiKeys,
      llmSecretName: `${target.provider}-secret`,
    })),
  }
  const createProvider = ((_keys: ApiKeys, model: ModelConfig) =>
    providers[model.name] ?? null) as typeof createLLMProvider
  const records: Record<string, ReturnType<typeof vi.fn>> = {}
  const bridge = new LlmBridge(resolver, {
    createProvider,
    createBreaker: target => {
      const breaker = new CircuitBreaker()
      records[target.targetRef] = vi.spyOn(breaker, 'record') as never
      return breaker
    },
  })
  return { bridge, records }
}

function request(targets: PromptBridgeTarget[]) {
  return {
    invocationId: 'inv-1',
    attemptGeneration: 1,
    targets: targets.map(target => ({ target })),
    policyRevision: 1,
    policyHash: 'a'.repeat(64),
    credentialTicketIssuer: {
      issue: vi.fn(async ({ target }: { target: PromptBridgeTarget }) => ({
        credentialTicket: `fresh-${target.targetRef}`,
      })),
    },
    messages: [{ role: 'user' as const, content: 'Say hello.' }],
    timeoutMs: 5_000,
  }
}

function outputText(name: string): string {
  const message = recordedResponse(name).output.find(item => item.type === 'message') as {
    content: Array<{ text: string }>
  }
  return message.content.map(part => part.text).join('')
}

const recorded = (name: string) => async () => recordedResponse(name)

describe('T-R2 prompt bridge text completion over Responses', () => {
  it.each([
    ['v1-text-gpt-6.1-terra', 'complete'],
    ['v1-incomplete-gpt-5.4-mini', 'length'],
  ] as const)('%s → content, usage and finish reason %s', async (fixture, finishReason) => {
    const { driver, create } = officialDriver([recorded(fixture)])
    const { bridge } = bridgeOver({ [primary.model]: driver })

    const result = await bridge.complete(request([primary]))

    const usage = recordedResponse(fixture).usage as Record<string, number>
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]![0]).toMatchObject({ model: primary.model, store: false })
    expect(result).toMatchObject({
      model: primary.model,
      content: outputText(fixture),
      usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
      finishReason,
    })
  })
})

describe('T-E4 prompt bridge: a failed 2xx does not fail over', () => {
  it('one driver call, no next target, and a non-retryable PluginWorkloadError', async () => {
    const failed = async () => {
      const raw = structuredClone(recordedResponse('v1-text-gpt-6.1-terra')) as RecordedResponse & {
        status: string
        error: unknown
      }
      // DEC-13: only `status` and `error` change on a recorded response.
      raw.status = 'failed'
      raw.error = { code: 'invalid_prompt', message: 'The response failed.' }
      return raw
    }
    const { driver, create } = officialDriver([failed])
    const next = {
      completeSingleTurn: vi.fn(async () => ({
        content: 'served by the next target',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: FinishReason.Stop,
      })),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'zai' as const,
      classifyError: vi.fn(),
    } as unknown as SingleTurnProvider
    const { bridge, records } = bridgeOver({ [primary.model]: driver, [fallback.model]: next })

    const error = await bridge.complete(request([primary, fallback])).then(
      () => {
        throw new Error('expected the bridge to fail')
      },
      (err: unknown) => err
    )

    expect(create).toHaveBeenCalledTimes(1)
    expect(next.completeSingleTurn).not.toHaveBeenCalled()
    expect(error).toBeInstanceOf(PluginWorkloadError)
    expect(error).toMatchObject({ code: 'provider_unavailable', retryable: false })
    // Regression only: the breaker records before the error is classified.
    expect(records[primary.targetRef]).toHaveBeenCalledWith(false)
  })
})
