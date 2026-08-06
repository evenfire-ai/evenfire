/**
 * R6 provider additions — factory + portability coverage.
 *
 * Locks three things the "just add data" change relies on:
 *   1. every R6 OpenAI-compatible provider constructs through the registry's
 *      data-driven baseURL arm (getProviderType + client.baseURL come from the
 *      descriptor);
 *   2. the `azure` light-driver arm: constructs against the per-resource
 *      AZURE_OPENAI_ENDPOINT (v1 GA path + `api-key` header, Bearer neutralized)
 *      and FAILS CLOSED when the endpoint is absent;
 *   3. the param audit — the shared OpenAI-compatible driver sends a portable
 *      param set (temperature clamped to the provider ceiling — [0,2] default,
 *      [0,1] for Moonshot — and tool_choice 'required' downgraded to 'auto' for
 *      MOONSHOT ONLY), while native OpenAI and the other compat providers keep
 *      full fidelity.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '../../core/types'
import { createLLMProvider } from '../index'
import { OpenAIProvider } from '../openai'
import { OpenAICompatibleProvider } from '../openaiCompatible'
import { descriptorFor } from '../registryCore'

const R6_COMPAT = [
  'openrouter',
  'gemini',
  'deepseek',
  'groq',
  'together',
  'fireworks',
  'mistral',
  'xai',
  'cerebras',
  'deepinfra',
  'perplexity',
  'moonshot',
  'nebius',
  'novita',
] as const

function createMockOpenAIClient() {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      },
    },
  }
}

describe('R6 OpenAI-compatible providers — data-driven baseURL arm', () => {
  it.each(R6_COMPAT)('constructs %s from its descriptor (baseURL + type)', provider => {
    const desc = descriptorFor(provider)
    const result = createLLMProvider(
      { [provider]: { [`${provider}-api-key`]: 'sk-test' } },
      { provider, name: desc.defaultModel }
    )
    expect(result, `createLLMProvider returned null for ${provider}`).not.toBeNull()
    expect(result?.getProviderType()).toBe(provider)

    // Private fields on OpenAIProvider (inherited); read for invariant assertion,
    // mirroring registry.test.ts's bailian case.
    const internals = result as unknown as { defaultModel: string; client: { baseURL: string } }
    expect(internals.defaultModel).toBe(desc.defaultModel)
    expect(internals.client.baseURL).toBe(desc.baseURL)
  })
})

describe('azure light-driver arm', () => {
  const OLD = process.env.AZURE_OPENAI_ENDPOINT
  const OLD_VER = process.env.AZURE_OPENAI_API_VERSION

  afterEach(() => {
    if (OLD === undefined) delete process.env.AZURE_OPENAI_ENDPOINT
    else process.env.AZURE_OPENAI_ENDPOINT = OLD
    if (OLD_VER === undefined) delete process.env.AZURE_OPENAI_API_VERSION
    else process.env.AZURE_OPENAI_API_VERSION = OLD_VER
  })

  it('constructs against the per-resource endpoint (v1 GA path)', () => {
    process.env.AZURE_OPENAI_ENDPOINT = 'https://my-resource.openai.azure.com/'
    delete process.env.AZURE_OPENAI_API_VERSION
    const result = createLLMProvider(
      { azure: { 'azure-openai-api-key': 'az-key' } },
      { provider: 'azure', name: 'my-deployment' }
    )
    expect(result).not.toBeNull()
    expect(result?.getProviderType()).toBe('azure')

    const internals = result as unknown as {
      defaultModel: string
      client: { baseURL: string; apiKey: string }
    }
    // Trailing slash on the endpoint is normalized; v1 GA suffix appended.
    expect(internals.client.baseURL).toBe('https://my-resource.openai.azure.com/openai/v1/')
    // The `model` string is the Azure DEPLOYMENT name, passed through as-is.
    expect(internals.defaultModel).toBe('my-deployment')
  })

  it('fails closed (returns null) when AZURE_OPENAI_ENDPOINT is absent', () => {
    delete process.env.AZURE_OPENAI_ENDPOINT
    const result = createLLMProvider(
      { azure: { 'azure-openai-api-key': 'az-key' } },
      { provider: 'azure', name: 'my-deployment' }
    )
    // createLLMProvider catches the fail-closed throw → null (→ R5 degraded path).
    expect(result).toBeNull()
  })

  it('fails closed (returns null) on a non-https endpoint — never sends api-key over cleartext', () => {
    process.env.AZURE_OPENAI_ENDPOINT = 'http://my-resource.openai.azure.com/'
    const result = createLLMProvider(
      { azure: { 'azure-openai-api-key': 'az-key' } },
      { provider: 'azure', name: 'my-deployment' }
    )
    expect(result).toBeNull()
  })
})

describe('param audit — OpenAI-compatible driver sends a portable param set', () => {
  function makeCompat() {
    return new OpenAICompatibleProvider(
      { id: 'moonshot', baseURL: 'https://api.moonshot.ai/v1', defaultModel: 'kimi-k2.6' },
      'fake-key'
    )
  }

  const tools: ToolDefinition[] = [{ name: 'search', description: 'Search', parameters: {} }]

  it('clamps temperature > 1 to 1 and downgrades tool_choice:required to auto (with tools)', async () => {
    const provider = makeCompat()
    const mockClient = createMockOpenAIClient()
    ;(provider as unknown as { client: unknown }).client = mockClient

    await provider.completeSingleTurnWithTools([{ role: 'user', content: 'Hi' }], tools, {
      temperature: 1.7,
      tool_choice: 'required',
    })

    const callArgs = mockClient.chat.completions.create.mock.calls[0][0]
    expect(callArgs.temperature).toBe(1)
    expect(callArgs.tool_choice).toBe('auto')
    // Never emit the params the stricter third parties reject.
    expect(callArgs).not.toHaveProperty('frequency_penalty')
    expect(callArgs).not.toHaveProperty('presence_penalty')
    expect(callArgs).not.toHaveProperty('logprobs')
    expect(callArgs).not.toHaveProperty('logit_bias')
    expect(callArgs).not.toHaveProperty('n')
  })

  it('clamps a negative temperature up to 0 (single-turn, no tools)', async () => {
    const provider = makeCompat()
    const mockClient = createMockOpenAIClient()
    ;(provider as unknown as { client: unknown }).client = mockClient

    await provider.completeSingleTurn([{ role: 'user', content: 'Hi' }], { temperature: -0.5 })

    const callArgs = mockClient.chat.completions.create.mock.calls[0][0]
    expect(callArgs.temperature).toBe(0)
  })

  it('leaves an in-range temperature untouched and passes tool_choice:none through', async () => {
    const provider = makeCompat()
    const mockClient = createMockOpenAIClient()
    ;(provider as unknown as { client: unknown }).client = mockClient

    await provider.completeSingleTurnWithTools([{ role: 'user', content: 'Hi' }], tools, {
      temperature: 0.3,
      tool_choice: 'none',
    })

    const callArgs = mockClient.chat.completions.create.mock.calls[0][0]
    expect(callArgs.temperature).toBe(0.3)
    expect(callArgs.tool_choice).toBe('none')
  })

  it('caps temperature at the [0,2] ceiling for non-Moonshot compat providers', async () => {
    // groq (and the other 12) accept the standard OpenAI-compatible [0,2]; only
    // Moonshot restricts to [0,1]. An in-range 1.7 must pass through untouched;
    // an over-ceiling 2.5 clamps to 2 (not to 1).
    const provider = new OpenAICompatibleProvider(
      { id: 'groq', baseURL: 'https://api.groq.com/openai/v1', defaultModel: 'x' },
      'fake-key'
    )
    const mockClient = createMockOpenAIClient()
    ;(provider as unknown as { client: unknown }).client = mockClient

    await provider.completeSingleTurn([{ role: 'user', content: 'a' }], { temperature: 1.7 })
    await provider.completeSingleTurn([{ role: 'user', content: 'b' }], { temperature: 2.5 })

    expect(mockClient.chat.completions.create.mock.calls[0][0].temperature).toBe(1.7)
    expect(mockClient.chat.completions.create.mock.calls[1][0].temperature).toBe(2)
  })

  it('passes tool_choice:required THROUGH for non-Moonshot compat providers', async () => {
    // Only Moonshot 400s on 'required'; groq (and the other 12, incl. the
    // pre-existing zai/bailian) honor it, so the forced-tool-call guarantee must
    // NOT be silently downgraded — reachable via a workflow step's toolChoice.
    const provider = new OpenAICompatibleProvider(
      { id: 'groq', baseURL: 'https://api.groq.com/openai/v1', defaultModel: 'x' },
      'fake-key'
    )
    const mockClient = createMockOpenAIClient()
    ;(provider as unknown as { client: unknown }).client = mockClient

    await provider.completeSingleTurnWithTools([{ role: 'user', content: 'Hi' }], tools, {
      tool_choice: 'required',
    })

    expect(mockClient.chat.completions.create.mock.calls[0][0].tool_choice).toBe('required')
  })

  it('native OpenAI keeps full fidelity (no clamping/downgrade)', async () => {
    const mockClient = createMockOpenAIClient()
    const provider = new OpenAIProvider(mockClient as never, 'gpt-4o')

    await provider.completeSingleTurnWithTools([{ role: 'user', content: 'Hi' }], tools, {
      temperature: 1.7,
      tool_choice: 'required',
    })

    const callArgs = mockClient.chat.completions.create.mock.calls[0][0]
    expect(callArgs.temperature).toBe(1.7)
    expect(callArgs.tool_choice).toBe('required')
  })

  it('keeps max_tokens for OpenAI-compatible GPT-5 model names', async () => {
    const provider = new OpenAICompatibleProvider(
      { id: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', defaultModel: 'gpt-5.4-mini' },
      'fake-key'
    )
    const mockClient = createMockOpenAIClient()
    ;(provider as unknown as { client: unknown }).client = mockClient

    await provider.completeSingleTurn([{ role: 'user', content: 'Hi' }], { max_tokens: 8 })

    const callArgs = mockClient.chat.completions.create.mock.calls[0][0]
    expect(callArgs.max_tokens).toBe(8)
    expect(callArgs).not.toHaveProperty('max_completion_tokens')
  })
})
