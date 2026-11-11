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
    ['azure', () => azureProfile(name => ({ AZURE_OPENAI_ENDPOINT: AZURE_ENDPOINT })[name])],
    ['groq', () => compatibleProfile({ id: groq.id, baseURL: groq.baseURL! })],
  ] as const)('%s refuses a client object instead of a key', (id, profile) => {
    expect(() => profile().createClient(ready)).toThrow(TypeError)
    expect(() => profile().createClient(ready)).toThrow(`[LLM] ${id}: expected an API key string`)
    expect(profile().createClient(`unit-${id}-key`).baseURL).not.toBe('https://unit.invalid/v1')
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
