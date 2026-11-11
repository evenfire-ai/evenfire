/**
 * Structural contracts of the composed OpenAI driver family that the payload
 * corpus cannot express: the official endpoint speaks only Responses, no
 * third-party or Azure endpoint ever reaches it, the legacy compatible class
 * carries no behavior of its own, and the driver reads its (swappable) client
 * on every call.
 */
import { describe, expect, it, vi } from 'vitest'
import { LlmPortAdapter } from '../../../core/adapters/llmPortAdapter'
import { LlmError, LlmErrorCode } from '../../../core/errors'
import type { ChatMessage, ToolDefinition } from '../../../core/types'
import { openaiApiError } from '../../__tests__/sdkErrorFixtures'
import { createLLMProvider } from '../../index'
import { OpenAIProvider } from '../../openai'
import { OpenAICompatibleProvider } from '../../openaiCompatible'
import { type LlmProvider, descriptorFor } from '../../registryCore'
import type { SingleTurnProvider } from '../../types'
import {
  CHAT_FAMILY,
  FAMILY,
  RECORDED_TEXT_RESPONSE,
  RECORDED_TOOLS_RESPONSE,
  buildFamilyProvider,
} from './familyHarness'
import { recordedResponse } from './responsesFixtures'

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'What is the weather in Paris?' }]
const TOOLS: ToolDefinition[] = [
  {
    name: 'get_weather',
    description: 'Current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
  },
]

function mockClient(baseURL: string) {
  const responsesCreate = vi.fn(() => {
    throw new Error('responses.create must not be reached')
  })
  const chatCreate = vi.fn(async (payload: { tools?: unknown }) =>
    structuredClone(payload.tools ? RECORDED_TOOLS_RESPONSE : RECORDED_TEXT_RESPONSE)
  )
  return {
    client: {
      baseURL,
      chat: { completions: { create: chatCreate } },
      responses: { create: responsesCreate },
    },
    chatCreate,
    responsesCreate,
  }
}

/** The official endpoint's SDK boundary: Responses answers, Chat must stay untouched. */
function responsesMockClient(baseURL = 'https://api.openai.com/v1') {
  const chatCreate = vi.fn(() => {
    throw new Error('chat.completions.create must not be reached')
  })
  const responsesCreate = vi.fn(async (payload: { tools?: unknown }) =>
    recordedResponse(payload.tools ? 'v1-fc-gpt-6.1-terra' : 'v1-text-gpt-4.1')
  )
  return {
    client: {
      baseURL,
      chat: { completions: { create: chatCreate } },
      responses: { create: responsesCreate },
    },
    chatCreate,
    responsesCreate,
  }
}

function swapClient(provider: SingleTurnProvider, client: unknown): void {
  ;(provider as unknown as { client: unknown }).client = client
}

describe('T-C1 the official endpoint speaks only Responses', () => {
  const builders: Array<[string, () => SingleTurnProvider]> = [
    [
      'new OpenAIProvider with the default profile',
      () => new OpenAIProvider('unit-key', 'gpt-6.1-terra'),
    ],
    ['makeProvider', () => buildFamilyProvider('openai', 'gpt-6.1-terra')],
    [
      'createLLMProvider',
      () =>
        createLLMProvider(
          { openai: { 'openai-api-key': 'unit-key' } },
          { provider: 'openai', name: 'gpt-6.1-terra' }
        )!,
    ],
  ]

  it.each(builders)('%s: both operations call responses.create, never chat', async (_l, build) => {
    const provider = build()
    expect(provider).toBeInstanceOf(OpenAIProvider)
    const mock = responsesMockClient()
    swapClient(provider, mock.client)

    const text = await provider.completeSingleTurn(MESSAGES)
    const withTools = await provider.completeSingleTurnWithTools(MESSAGES, TOOLS)

    expect(mock.responsesCreate).toHaveBeenCalledTimes(2)
    expect(mock.chatCreate).not.toHaveBeenCalled()
    expect(text.content).toBe('Hello, my friend!')
    expect(withTools.tool_calls?.map(tc => tc.name)).toEqual(['get_weather'])
  })
})

describe('T-R1 chat-only endpoints never call responses.create', () => {
  const chatOnly = CHAT_FAMILY

  it('covers azure, every pinned compatible and any descriptor added since', () => {
    expect(chatOnly).toContain('azure')
    expect(FAMILY.filter(id => id !== 'openai' && !chatOnly.includes(id))).toEqual([])
  })

  it.each([...chatOnly])('%s sends both operations through chat.completions', async id => {
    const provider = buildFamilyProvider(id as LlmProvider)
    const holder = provider as unknown as { client: { baseURL: string } }
    const mock = mockClient(holder.client.baseURL)
    holder.client = mock.client
    await provider.completeSingleTurn(MESSAGES)
    await provider.completeSingleTurnWithTools(MESSAGES, TOOLS, { tool_choice: 'required' })
    expect(mock.chatCreate).toHaveBeenCalledTimes(2)
    expect(mock.responsesCreate).not.toHaveBeenCalled()
  })
})

describe('OpenAICompatibleProvider is a constructor-only alias', () => {
  it('declares no members besides its constructor', () => {
    expect(Object.getOwnPropertyNames(OpenAICompatibleProvider.prototype)).toEqual(['constructor'])
    expect(Object.getPrototypeOf(OpenAICompatibleProvider.prototype)).toBe(OpenAIProvider.prototype)
  })

  // The prototype alone misses members assigned in the constructor and statics.
  // The reference is the registry's own composition, so the alias may carry
  // exactly the fields the factory output carries and nothing more.
  it('instances carry the same own fields as the registry-built driver and no statics', () => {
    const d = descriptorFor('groq')
    const alias = new OpenAICompatibleProvider(
      { id: d.id, baseURL: d.baseURL!, defaultModel: d.defaultModel! },
      'unit-groq-key'
    )
    const registryBuilt = buildFamilyProvider('groq')
    expect(Object.keys(alias).sort()).toEqual(Object.keys(registryBuilt).sort())
    expect(Object.getOwnPropertySymbols(alias)).toEqual([])
    expect(Object.getOwnPropertyNames(OpenAICompatibleProvider).sort()).toEqual([
      'length',
      'name',
      'prototype',
    ])
    expect(Object.getOwnPropertySymbols(OpenAICompatibleProvider)).toEqual([])
  })
})

describe('the driver reads its client on every call', () => {
  it.each(['azure', 'groq'] as const)(
    '%s: a client swapped after construction receives both operations',
    async id => {
      const provider = buildFamilyProvider(id)
      const holder = provider as unknown as {
        client: { baseURL: string; chat: { completions: { create: unknown } } }
      }
      const original = vi.spyOn(holder.client.chat.completions, 'create' as never)
      const mock = mockClient(holder.client.baseURL)
      holder.client = mock.client as never

      const text = await provider.completeSingleTurn(MESSAGES)
      const withTools = await provider.completeSingleTurnWithTools(MESSAGES, TOOLS)

      expect(mock.chatCreate).toHaveBeenCalledTimes(2)
      expect(original).not.toHaveBeenCalled()
      expect(text.content).toBe('A cat sat on a mat.')
      expect(withTools.tool_calls?.[0]?.name).toBe('get_weather')
    }
  )

  it('openai: a client swapped after construction receives both operations', async () => {
    const provider = buildFamilyProvider('openai')
    const holder = provider as unknown as {
      client: { baseURL: string; responses: { create: unknown } }
    }
    const original = vi.spyOn(holder.client.responses, 'create' as never)
    const mock = responsesMockClient(holder.client.baseURL)
    holder.client = mock.client as never

    const text = await provider.completeSingleTurn(MESSAGES)
    const withTools = await provider.completeSingleTurnWithTools(MESSAGES, TOOLS)

    expect(mock.responsesCreate).toHaveBeenCalledTimes(2)
    expect(original).not.toHaveBeenCalled()
    expect(text.content).toBe('Hello, my friend!')
    expect(withTools.tool_calls?.[0]?.name).toBe('get_weather')
  })

  it('visual limits follow the swapped client base URL', () => {
    const provider = buildFamilyProvider('openai')
    expect(provider.getVisualDeliveryLimits?.('completeWithTools')).not.toBeNull()
    ;(provider as unknown as { client: unknown }).client =
      mockClient('https://unit.invalid/v1').client
    expect(provider.getVisualDeliveryLimits?.('completeWithTools')).toBeNull()
  })
})

describe('T-E1 SDK errors thrown by responses.create classify through the adapter', () => {
  // Both errors are real `OpenAI.APIError`s built by the SDK. The 404 body is
  // the one recorded from the API (`v1-404`); no over-limit tools response was
  // recorded, so the 400 body is a synthetic shape and only fixes how the
  // classifier treats a non-retryable 400 with a provider code. Chat and
  // Responses share the classifier and neither wraps the SDK error, so the
  // outcome is asserted outright instead of compared across protocols.
  const MODEL_NOT_FOUND =
    'The model `gpt-nonexistent-zz9` does not exist or you do not have access to it.'
  const TOO_MANY_TOOLS =
    "Invalid 'tools': array too long. Expected an array with maximum length 128, but got an array with length 129 instead."
  const errors: Array<[string, () => unknown, Partial<LlmError>]> = [
    [
      'model_not_found 404 (recorded body)',
      () =>
        openaiApiError(404, {
          code: 'model_not_found',
          type: 'invalid_request_error',
          message: MODEL_NOT_FOUND,
        }),
      {
        code: LlmErrorCode.ModelNotAvailable,
        retryable: false,
        httpStatus: 404,
        providerCode: 'model_not_found',
        message: MODEL_NOT_FOUND,
      },
    ],
    [
      'too many tools 400 (synthetic body)',
      () =>
        openaiApiError(400, {
          code: 'array_above_max_length',
          type: 'invalid_request_error',
          message: TOO_MANY_TOOLS,
        }),
      {
        code: LlmErrorCode.ApiCallFailed,
        retryable: false,
        httpStatus: 400,
        providerCode: 'array_above_max_length',
        message: TOO_MANY_TOOLS,
      },
    ],
  ]

  it.each(errors)('%s', async (_label, make, expected) => {
    const responsesCreate = vi.fn(async () => {
      throw make()
    })
    const provider = new OpenAIProvider(
      { responses: { create: responsesCreate } } as never,
      'gpt-6.1-terra'
    )
    const adapter = new LlmPortAdapter(provider, 'gpt-6.1-terra', 'openai')

    const err = await adapter.completeWithTools({ messages: MESSAGES, tools: TOOLS }).then(
      () => {
        throw new Error('expected the call to fail')
      },
      (e: unknown) => e
    )

    expect(responsesCreate).toHaveBeenCalledTimes(1)
    expect(err).toBeInstanceOf(LlmError)
    const { code, retryable, httpStatus, providerCode, message } = err as LlmError
    expect({ code, retryable, httpStatus, providerCode, message }).toEqual(expected)
  })
})
