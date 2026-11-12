/**
 * Workflow steps against the official OpenAI endpoint (Responses). Only the
 * SDK boundary (`responses.create` of each built driver) is doubled; the
 * driver, the failover provider and the step loop all run.
 */
import { describe, expect, it, vi } from 'vitest'
import { openaiApiError } from '../../llm/__tests__/sdkErrorFixtures'
import {
  type RecordedResponse,
  recordedResponse,
} from '../../llm/openaiFamily/__tests__/responsesFixtures'
import { makeProvider } from '../../llm/registry'
import { descriptorFor, primarySlot } from '../../llm/registryCore'
import type { SingleTurnProvider } from '../../llm/types'
import type { LlmUsageEvent, UsageReporter } from '../../usage/usageReporter'
import type { McpClientFactory } from '../stepRouter'
import type { McpHostRuntimeAuth } from '../userApprovalRequester'
import { WorkflowService } from '../workflowService'

const MODEL = 'gpt-6.1-terra'
const contextVars = {
  workflowExecutionId: '11111111-1111-4111-8111-111111111111:recipe:2026-11-06T00:00:00.000Z',
  workflowTeamId: '22222222-2222-4222-8222-222222222222',
  workflowUserId: '33333333-3333-4333-8333-333333333333',
}

type Answer = () => Promise<unknown>

/**
 * Builds every driver through the real factory and swaps its SDK client for
 * one whose `responses.create` serves the queue registered for that API key.
 */
function sdkByKey(answers: Record<string, Answer[]>) {
  const creates: Record<string, ReturnType<typeof vi.fn>> = {}
  const chatCreates: ReturnType<typeof vi.fn>[] = []
  const built: string[] = []
  const llmFactory = (provider: string, model: string, apiKey: string): SingleTurnProvider => {
    built.push(apiKey)
    const d = descriptorFor(provider as 'openai')
    const driver = makeProvider('openai', { [primarySlot(d).dataKey]: apiKey }, model)
    const queue = answers[apiKey] ?? []
    const create = (creates[apiKey] ??= vi.fn(async (_payload: unknown) => {
      const next = queue.shift()
      if (!next) throw new Error(`no more answers for ${apiKey}`)
      return next()
    }))
    const chatCreate = vi.fn()
    chatCreates.push(chatCreate)
    ;(driver as unknown as { client: unknown }).client = {
      baseURL: 'https://api.openai.com/v1',
      responses: { create },
      chat: { completions: { create: chatCreate } },
    }
    return driver
  }
  return {
    llmFactory,
    calls: (apiKey: string) => creates[apiKey]?.mock.calls.length ?? 0,
    payload: (apiKey: string, n: number) =>
      creates[apiKey]!.mock.calls[n]![0] as Record<string, unknown>,
    chatCalls: () => chatCreates.reduce((n, c) => n + c.mock.calls.length, 0),
    built,
  }
}

const recorded =
  (name: string): Answer =>
  async () =>
    recordedResponse(name)

/**
 * DEC-13: a 2xx with `status: 'failed'` cannot be requested with
 * `store: false`, so it is a recorded response with only `status` and
 * `error` changed (the shape of the SDK `Response` type).
 */
function failedResponse(code: string): Answer {
  return async () => {
    const raw = structuredClone(recordedResponse('v1-text-gpt-6.1-terra')) as RecordedResponse & {
      status: string
      error: unknown
    }
    raw.status = 'failed'
    raw.error = { code, message: 'The response failed.' }
    return raw
  }
}

function outputText(name: string): string {
  const message = recordedResponse(name).output.find(item => item.type === 'message') as {
    content: Array<{ text: string }>
  }
  return message.content.map(part => part.text).join('')
}

function runtimeAuth(): McpHostRuntimeAuth {
  return {
    accessToken: 'a',
    refreshToken: 'r',
    baseUrl: 'http://gw',
    hostRef: 'sandbox-recipes/recipe',
    recipeName: 'recipe',
    recipeNamespace: 'sandbox-recipes',
  }
}

function service(
  llmFactory: (provider: string, model: string, apiKey: string) => SingleTurnProvider,
  withFallback: boolean
) {
  const enqueued: LlmUsageEvent[] = []
  const reporter = {
    enqueue: (e: LlmUsageEvent) => enqueued.push(e),
    drain: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    bufferSize: () => enqueued.length,
  } as unknown as UsageReporter
  const mcpClientFactory: McpClientFactory = () => {
    throw new Error('no MCP server in a text step')
  }
  const svc = new WorkflowService('recipe-12345', {
    llmFactory,
    mcpClientFactory,
    usageReporter: reporter,
    runtimeAuth: runtimeAuth(),
  })
  const configured = svc.configure({
    provider: 'openai',
    model: MODEL,
    apiKey: 'sk-fake-primary-0000',
    llmSecretName: 'chatllm-api-keys',
    ...(withFallback
      ? {
          llmPolicy: {
            fallbacks: [{ provider: 'openai', model: MODEL, apiKey: 'sk-fake-fallback-0000' }],
          },
        }
      : {}),
  })
  expect(configured.configured).toBe(true)
  return { svc, enqueued }
}

const step = (stepId: string) => ({ stepId, instruction: 'Say hello.', contextVars })

describe('T-R2 workflow text step over Responses', () => {
  it('returns the recorded text and meters its usage', async () => {
    const sdk = sdkByKey({ 'sk-fake-primary-0000': [recorded('v1-text-gpt-6.1-terra')] })
    const { svc, enqueued } = service(sdk.llmFactory, false)

    const res = await svc.executeStep(step('s1'))

    const usage = recordedResponse('v1-text-gpt-6.1-terra').usage as Record<string, number>
    expect(sdk.chatCalls()).toBe(0)
    expect(sdk.calls('sk-fake-primary-0000')).toBe(1)
    expect(sdk.payload('sk-fake-primary-0000', 0)).toMatchObject({ model: MODEL, store: false })
    expect(res).toMatchObject({
      status: 'completed',
      output: outputText('v1-text-gpt-6.1-terra'),
      tokensUsed: { input: usage.input_tokens, output: usage.output_tokens },
    })
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]).toMatchObject({
      provider: 'openai',
      model: MODEL,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
    })
  })

  it('reads an incomplete response as a length stop and asks for one continuation', async () => {
    const sdk = sdkByKey({
      'sk-fake-primary-0000': [
        recorded('v1-incomplete-gpt-5.4-mini'),
        recorded('v1-text-gpt-6.1-terra'),
      ],
    })
    const { svc } = service(sdk.llmFactory, false)

    const res = await svc.executeStep(step('s1'))

    expect(sdk.calls('sk-fake-primary-0000')).toBe(2)
    expect(res.status).toBe('completed')
    expect(res.output).toBe(
      `${outputText('v1-incomplete-gpt-5.4-mini')}\n${outputText('v1-text-gpt-6.1-terra')}`
    )
  })
})

describe('T-R2 workflow failover text step over Responses', () => {
  it('a rate-limited primary fails over and the step returns the fallback text and usage', async () => {
    const sdk = sdkByKey({
      'sk-fake-primary-0000': [
        async () => {
          throw openaiApiError(429, {
            code: 'rate_limit_exceeded',
            type: 'requests',
            message: 'Rate limit reached.',
          })
        },
      ],
      'sk-fake-fallback-0000': [recorded('v1-text-gpt-4.1')],
    })
    const { svc, enqueued } = service(sdk.llmFactory, true)

    const res = await svc.executeStep(step('s1'))

    const usage = recordedResponse('v1-text-gpt-4.1').usage as Record<string, number>
    expect(sdk.chatCalls()).toBe(0)
    expect(sdk.calls('sk-fake-primary-0000')).toBe(1)
    expect(sdk.calls('sk-fake-fallback-0000')).toBe(1)
    expect(res).toMatchObject({
      status: 'completed',
      output: outputText('v1-text-gpt-4.1'),
      tokensUsed: { input: usage.input_tokens, output: usage.output_tokens },
    })
    expect(enqueued[0]).toMatchObject({
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
    })
  })
})

describe('T-E4 workflow: a failed 2xx is not retried, failed over or cooled down', () => {
  it('one call to the primary, the fallback is never reached, the next step still uses the primary', async () => {
    const sdk = sdkByKey({
      'sk-fake-primary-0000': [failedResponse('invalid_prompt'), recorded('v1-text-gpt-6.1-terra')],
      'sk-fake-fallback-0000': [recorded('v1-text-gpt-4.1')],
    })
    const { svc } = service(sdk.llmFactory, true)

    const failed = await svc.executeStep(step('s1'))

    expect(failed.status).toBe('failed')
    expect(sdk.calls('sk-fake-primary-0000')).toBe(1)
    expect(sdk.calls('sk-fake-fallback-0000')).toBe(0)

    // Without a cooldown the next step is served by the primary again.
    const next = await svc.executeStep(step('s2'))

    expect(next).toMatchObject({ status: 'completed', output: outputText('v1-text-gpt-6.1-terra') })
    expect(sdk.calls('sk-fake-primary-0000')).toBe(2)
    expect(sdk.calls('sk-fake-fallback-0000')).toBe(0)
  })
})
