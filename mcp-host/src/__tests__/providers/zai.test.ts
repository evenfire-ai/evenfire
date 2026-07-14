/**
 * Tests for the ZAI provider (now OpenAICompatibleProvider, id='zai').
 * Step 4.7 (G-07)
 *
 * ZAI is OpenAI-compatible — we mock the OpenAI client to verify the correct
 * endpoint URL, provider type, and delegated behaviour.
 */
import { describe, expect, it, vi } from 'vitest'
import { OpenAICompatibleProvider } from '../../llm/openaiCompatible'

// ─── Construction helper ─────────────────────────────────────────────────────

function makeZai(model?: string) {
  return new OpenAICompatibleProvider(
    { id: 'zai', baseURL: 'https://api.z.ai/api/coding/paas/v4', defaultModel: 'glm-5.1' },
    'test-api-key',
    model
  )
}

// ─── Mock helpers ────────────────────────────────────────────────────────────

function createMockOpenAIClient() {
  return {
    chat: {
      completions: {
        create: vi.fn(),
      },
    },
  }
}

function textResponse(content = 'Hello from ZAI') {
  return {
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  }
}

function toolCallResponse(toolName = 'search') {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: { name: toolName, arguments: '{"q":"test"}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ZaiProvider (OpenAICompatibleProvider, id='zai')", () => {
  it("getProviderType returns 'zai'", () => {
    const provider = makeZai()
    expect(provider.getProviderType()).toBe('zai')
  })

  it('uses glm-5.1 as default model when none provided', () => {
    // We can verify default model by checking that the API is called with it
    const provider = makeZai()
    // Access the private field via prototype (for testing)
    expect((provider as never)['defaultModel']).toBe('glm-5.1')
  })

  it('accepts custom model override', () => {
    const provider = makeZai('glm-4.7')
    expect((provider as never)['defaultModel']).toBe('glm-4.7')
  })

  it('initializes with z.ai baseURL (https://api.z.ai/api/coding/paas/v4)', () => {
    // Verify baseURL is set on the underlying OpenAI client
    const provider = makeZai()
    const client = (provider as never)['client'] as { baseURL?: string }
    expect(client.baseURL).toContain('api.z.ai')
  })

  it('completeSingleTurn delegates to OpenAI client and returns content', async () => {
    const provider = makeZai()
    const mockClient = createMockOpenAIClient()
    mockClient.chat.completions.create.mockResolvedValue(textResponse('ZAI response'))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(provider as any)['client'] = mockClient

    const result = await provider.completeSingleTurn([{ role: 'user', content: 'Hello' }])
    expect(result.content).toBe('ZAI response')
  })

  it('completeSingleTurnWithTools returns tool_calls when model responds with tool_calls', async () => {
    const provider = makeZai()
    const mockClient = createMockOpenAIClient()
    mockClient.chat.completions.create.mockResolvedValue(toolCallResponse('web_search'))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(provider as any)['client'] = mockClient

    const result = await provider.completeSingleTurnWithTools(
      [{ role: 'user', content: 'Search for X' }],
      [
        {
          name: 'web_search',
          description: 'Search',
          parameters: { type: 'object', properties: {} },
        },
      ]
    )
    expect(result.tool_calls).toBeDefined()
    expect(result.tool_calls).not.toBeNull()
    expect(result.tool_calls!.length).toBeGreaterThan(0)
    expect(result.tool_calls![0].name).toBe('web_search')
  })

  it('propagates API errors from the underlying client', async () => {
    const provider = makeZai()
    const mockClient = createMockOpenAIClient()
    mockClient.chat.completions.create.mockRejectedValue(new Error('API rate limit'))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(provider as any)['client'] = mockClient

    await expect(provider.completeSingleTurn([{ role: 'user', content: 'Hello' }])).rejects.toThrow(
      'API rate limit'
    )
  })

  it('sends model name in the API call', async () => {
    const provider = makeZai('glm-4.7')
    const mockClient = createMockOpenAIClient()
    mockClient.chat.completions.create.mockResolvedValue(textResponse())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(provider as any)['client'] = mockClient

    await provider.completeSingleTurn([{ role: 'user', content: 'Hi' }])
    const callArgs = mockClient.chat.completions.create.mock.calls[0][0]
    expect(callArgs.model).toBe('glm-4.7')
  })

  it('returns usage stats with token counts', async () => {
    const provider = makeZai()
    const mockClient = createMockOpenAIClient()
    mockClient.chat.completions.create.mockResolvedValue(textResponse())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(provider as any)['client'] = mockClient

    const result = await provider.completeSingleTurn([{ role: 'user', content: 'Hi' }])
    expect(result.usage).toBeDefined()
    expect(result.usage.total_tokens).toBe(8)
  })
})
