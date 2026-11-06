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
import type { LlmProvider } from '../../registryCore'
import type { SingleTurnProvider } from '../../types'
import {
  CHAT_FAMILY,
  FAMILY,
  RECORDED_TEXT_RESPONSE,
  RECORDED_TOOLS_RESPONSE,
  buildFamilyProvider,
  officialChatProfile,
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

describe('T-E1 SDK errors classify the same on Responses as on Chat', () => {
  // `model_not_found` carries the body recorded from the real API (`v1-404`).
  // No over-limit tools response was recorded, so its body is an assumption:
  // the case only proves both transports surface the same SDK error alike, not
  // what Responses actually returns for more than 128 tools.
  const errors: Array<[string, () => unknown]> = [
    [
      'model_not_found 404',
      () =>
        openaiApiError(404, {
          code: 'model_not_found',
          type: 'invalid_request_error',
          message:
            'The model `gpt-nonexistent-zz9` does not exist or you do not have access to it.',
        }),
    ],
    [
      'too many tools 400',
      () =>
        openaiApiError(400, {
          code: 'array_above_max_length',
          type: 'invalid_request_error',
          message:
            "Invalid 'tools': array too long. Expected an array with maximum length 128, but got an array with length 129 instead.",
        }),
    ],
  ]

  async function thrownThrough(provider: OpenAIProvider): Promise<unknown> {
    const adapter = new LlmPortAdapter(provider, 'gpt-6.1-terra', 'openai')
    return adapter.completeWithTools({ messages: MESSAGES, tools: TOOLS }).then(
      () => {
        throw new Error('expected the call to fail')
      },
      (err: unknown) => err
    )
  }

  it.each(errors)('%s', async (_label, make) => {
    const chatCreate = vi.fn(async () => {
      throw make()
    })
    const responsesCreate = vi.fn(async () => {
      throw make()
    })
    const viaChat = new OpenAIProvider(
      { chat: { completions: { create: chatCreate } } } as never,
      'gpt-6.1-terra',
      officialChatProfile()
    )
    const viaResponses = new OpenAIProvider(
      { responses: { create: responsesCreate } } as never,
      'gpt-6.1-terra'
    )

    const fromChat = await thrownThrough(viaChat)
    const fromResponses = await thrownThrough(viaResponses)

    expect(chatCreate).toHaveBeenCalledTimes(1)
    expect(responsesCreate).toHaveBeenCalledTimes(1)
    const shape = (e: unknown) => {
      const { code, retryable, httpStatus, providerCode, message } = e as LlmError
      return { code, retryable, httpStatus, providerCode, message }
    }
    expect(fromResponses).toBeInstanceOf(LlmError)
    expect(shape(fromResponses)).toEqual(shape(fromChat))
  })

  it('model_not_found stays apart from the over-limit tools error', () => {
    const provider = new OpenAIProvider('unit-key', 'gpt-6.1-terra')
    expect(provider.classifyError(errors[0]![1]())).toMatchObject({
      code: LlmErrorCode.ModelNotAvailable,
      retryable: false,
      httpStatus: 404,
    })
    expect(provider.classifyError(errors[1]![1]())).toMatchObject({
      code: LlmErrorCode.ApiCallFailed,
      retryable: false,
      httpStatus: 400,
    })
  })
})
