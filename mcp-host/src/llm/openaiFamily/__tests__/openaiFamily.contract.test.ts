/**
 * Structural contracts of the composed OpenAI driver family that the payload
 * corpus cannot express: no third-party or Azure endpoint ever reaches the
 * Responses API, the legacy compatible class carries no behavior of its own,
 * and the driver reads its (swappable) client on every call.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ToolDefinition } from '../../../core/types'
import { OpenAIProvider } from '../../openai'
import { OpenAICompatibleProvider } from '../../openaiCompatible'
import { type LlmProvider, descriptorFor } from '../../registryCore'
import { azureProfile, compatibleProfile } from '../endpointProfiles'
import {
  AZURE_ENDPOINT,
  CHAT_FAMILY,
  FAMILY,
  RECORDED_TEXT_RESPONSE,
  RECORDED_TOOLS_RESPONSE,
  azureEnv,
  buildFamilyProvider,
} from './familyHarness'

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

describe('OpenAI family — chat-only endpoints never call responses.create', () => {
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

describe('only the official endpoint accepts a ready-built client', () => {
  const ready = mockClient('https://unit.invalid/v1').client as never
  const groq = descriptorFor('groq')

  it.each([
    [
      'azure',
      () => azureProfile(azureEnv({ AZURE_OPENAI_ENDPOINT: AZURE_ENDPOINT })),
      new URL(AZURE_ENDPOINT).host,
    ],
    ['groq', () => compatibleProfile({ id: groq.id, baseURL: groq.baseURL! }), groq.baseURL!],
  ] as const)('%s refuses a client object instead of a key', (id, profile, expectedURL) => {
    expect(() => profile().createClient(ready)).toThrow(TypeError)
    expect(() => profile().createClient(ready)).toThrow(`[LLM] ${id}: expected an API key string`)
    expect(profile().createClient(`unit-${id}-key`).baseURL).toContain(expectedURL)
  })
})

describe('OpenAICompatibleProvider is a constructor-only alias', () => {
  // Reflect.ownKeys also sees non-enumerable and symbol keys, which a member
  // added with Object.defineProperty would use to hide from Object.keys.
  const ownKeys = (target: object) => Reflect.ownKeys(target).map(String).sort()

  function aliasFor(id: LlmProvider, model?: string) {
    const d = descriptorFor(id)
    return new OpenAICompatibleProvider(
      { id: d.id, baseURL: d.baseURL!, defaultModel: d.defaultModel! },
      `unit-${id}-key`,
      model
    )
  }

  it('declares no members besides its constructor', () => {
    expect(ownKeys(OpenAICompatibleProvider.prototype)).toEqual(['constructor'])
    expect(Object.getPrototypeOf(OpenAICompatibleProvider.prototype)).toBe(OpenAIProvider.prototype)
  })

  // The prototype alone misses members assigned in the constructor and statics.
  // The reference is the registry's own composition, so the alias may carry
  // exactly the fields the factory output carries and nothing more.
  it('instances carry the same own fields as the registry-built driver and no statics', () => {
    expect(ownKeys(aliasFor('groq'))).toEqual(ownKeys(buildFamilyProvider('groq')))
    expect(ownKeys(OpenAICompatibleProvider)).toEqual(['length', 'name', 'prototype'])
  })

  // Same fields are not enough: the constructor could still compose them from
  // different arguments. What the alias exposes and sends must match the factory.
  it.each([
    ['groq', undefined],
    ['moonshot', undefined],
    ['zai', 'unit-explicit-model'],
  ] as const)(
    '%s: identity, client and wire payload match the registry-built driver',
    async (id, model) => {
      const built = [aliasFor(id, model), buildFamilyProvider(id, model)].map(provider => {
        const holder = provider as unknown as {
          client: { baseURL: string; apiKey: string }
          defaultModel: string
        }
        return {
          provider,
          observed: {
            type: provider.getProviderType(),
            defaultModel: holder.defaultModel,
            baseURL: holder.client.baseURL,
            apiKey: holder.client.apiKey,
          },
          holder,
        }
      })
      expect(built[0]!.observed).toEqual(built[1]!.observed)

      const payloads = []
      for (const { provider, holder } of built) {
        const mock = mockClient(holder.client.baseURL)
        ;(holder as { client: unknown }).client = mock.client
        await provider.completeSingleTurnWithTools(MESSAGES, TOOLS, {
          temperature: 1.7,
          tool_choice: 'required',
        })
        payloads.push(mock.chatCreate.mock.calls)
      }
      expect(JSON.stringify(payloads[0])).toBe(JSON.stringify(payloads[1]))
    }
  )
})

describe('the driver reads its client on every call', () => {
  it.each(['openai', 'azure', 'groq'] as const)(
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

  it('visual limits follow the swapped client base URL', () => {
    const provider = buildFamilyProvider('openai')
    expect(provider.getVisualDeliveryLimits?.('completeWithTools')).not.toBeNull()
    ;(provider as unknown as { client: unknown }).client =
      mockClient('https://unit.invalid/v1').client
    expect(provider.getVisualDeliveryLimits?.('completeWithTools')).toBeNull()
  })
})
