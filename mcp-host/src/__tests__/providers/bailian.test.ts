/**
 * Tests for the Bailian provider (now OpenAICompatibleProvider, id='bailian').
 * Step 4.7 (G-07)
 *
 * Same structure as the ZAI tests but verifying the Alibaba Cloud Model Studio
 * (Bailian) endpoint.
 */
import { describe, expect, it, vi } from 'vitest'
import { OpenAICompatibleProvider } from '../../llm/openaiCompatible'

// ─── Construction helper ─────────────────────────────────────────────────────

function makeBailian(model?: string) {
  return new OpenAICompatibleProvider(
    {
      id: 'bailian',
      baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      defaultModel: 'qwen3-coder-plus',
    },
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

function textResponse(content = 'Hello from Bailian') {
  return {
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
  }
}

function toolCallResponse(toolName = 'db_query') {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'tc2',
              type: 'function',
              function: { name: toolName, arguments: '{"sql":"SELECT 1"}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("BailianProvider (OpenAICompatibleProvider, id='bailian')", () => {
  it("getProviderType returns 'bailian'", () => {
    const provider = makeBailian()
    expect(provider.getProviderType()).toBe('bailian')
  })

  it('uses qwen3-coder-plus as default model', () => {
    const provider = makeBailian()
    expect((provider as never)['defaultModel']).toBe('qwen3-coder-plus')
  })

  it('accepts custom model override', () => {
    const provider = makeBailian('qwen3-max-2026-01-23')
    expect((provider as never)['defaultModel']).toBe('qwen3-max-2026-01-23')
  })

  it('initializes with Alibaba Cloud (dashscope-intl) baseURL', () => {
    const provider = makeBailian()
    const client = (provider as never)['client'] as { baseURL?: string }
    expect(client.baseURL).toContain('dashscope-intl.aliyuncs.com')
  })

  it('baseURL is the full compatible-mode endpoint', () => {
    const provider = makeBailian()
    const client = (provider as never)['client'] as { baseURL?: string }
    expect(client.baseURL).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1')
  })

  it('completeSingleTurn delegates to client and returns content', async () => {
    const provider = makeBailian()
    const mockClient = createMockOpenAIClient()
    mockClient.chat.completions.create.mockResolvedValue(textResponse('Bailian says hi'))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(provider as any)['client'] = mockClient

    const result = await provider.completeSingleTurn([{ role: 'user', content: 'Hi' }])
    expect(result.content).toBe('Bailian says hi')
  })

  it('completeSingleTurnWithTools returns tool_calls', async () => {
    const provider = makeBailian()
    const mockClient = createMockOpenAIClient()
    mockClient.chat.completions.create.mockResolvedValue(toolCallResponse('db_query'))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(provider as any)['client'] = mockClient

    const result = await provider.completeSingleTurnWithTools(
      [{ role: 'user', content: 'Query the DB' }],
      [
        {
          name: 'db_query',
          description: 'Query database',
          parameters: { type: 'object', properties: {} },
        },
      ]
    )
    expect(result.tool_calls).toBeDefined()
    expect(result.tool_calls).not.toBeNull()
    expect(result.tool_calls![0].name).toBe('db_query')
  })

  it('propagates API errors', async () => {
    const provider = makeBailian()
    const mockClient = createMockOpenAIClient()
    mockClient.chat.completions.create.mockRejectedValue(new Error('Bailian quota exceeded'))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(provider as any)['client'] = mockClient

    await expect(provider.completeSingleTurn([{ role: 'user', content: 'Hello' }])).rejects.toThrow(
      'Bailian quota exceeded'
    )
  })

  it('sends the configured model name in API call', async () => {
    const provider = makeBailian('glm-5')
    const mockClient = createMockOpenAIClient()
    mockClient.chat.completions.create.mockResolvedValue(textResponse())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(provider as any)['client'] = mockClient

    await provider.completeSingleTurn([{ role: 'user', content: 'Hi' }])
    const callArgs = mockClient.chat.completions.create.mock.calls[0][0]
    expect(callArgs.model).toBe('glm-5')
  })

  it('returns usage stats in response', async () => {
    const provider = makeBailian()
    const mockClient = createMockOpenAIClient()
    mockClient.chat.completions.create.mockResolvedValue(textResponse())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(provider as any)['client'] = mockClient

    const result = await provider.completeSingleTurn([{ role: 'user', content: 'Hi' }])
    expect(result.usage.total_tokens).toBe(12)
  })
})
