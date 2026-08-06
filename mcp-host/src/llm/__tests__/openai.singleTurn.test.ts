import { describe, expect, it, vi } from 'vitest'
import { type ChatMessage, FinishReason, type ToolDefinition } from '../../core/types'
import { OpenAIProvider } from '../openai'

function createMockOpenAIClient() {
  return {
    chat: {
      completions: {
        create: vi.fn(),
      },
    },
  }
}

function openAITextResponse(text: string, finishReason: string = 'stop') {
  return {
    choices: [
      {
        message: { role: 'assistant', content: text },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }
}

function openAIToolCallResponse(
  toolCalls: Array<{
    id: string
    name: string
    arguments: string
  }>
) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          })),
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  }
}

describe('OpenAI completeSingleTurnWithTools', () => {
  it('should pass tools as undefined when tool list is empty', async () => {
    const mockClient = createMockOpenAIClient()
    mockClient.chat.completions.create.mockResolvedValue(openAITextResponse('Hello'))
    const provider = new OpenAIProvider(mockClient as any, 'gpt-4o')

    await provider.completeSingleTurnWithTools([{ role: 'user', content: 'Hi' }], [])

    const callArgs = mockClient.chat.completions.create.mock.calls[0][0]
    expect(callArgs.tools).toBeUndefined()
    expect(callArgs.tool_choice).toBeUndefined()
  })

  it('should pass populated tools array when tools are provided', async () => {
    const mockClient = createMockOpenAIClient()
    mockClient.chat.completions.create.mockResolvedValue(openAITextResponse("I'll search that"))
    const provider = new OpenAIProvider(mockClient as any, 'gpt-4o')

    const tools: ToolDefinition[] = [
      {
        name: 'search',
        description: 'Search docs',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ]

    await provider.completeSingleTurnWithTools([{ role: 'user', content: 'Find X' }], tools)

    const callArgs = mockClient.chat.completions.create.mock.calls[0][0]
    expect(callArgs.tools).toHaveLength(1)
    expect(callArgs.tools[0].type).toBe('function')
    expect(callArgs.tools[0].function.name).toBe('search')
  })
})

describe('OpenAI argument parsing', () => {
  it('should parse valid JSON string arguments into object', async () => {
    const mockClient = createMockOpenAIClient()
    mockClient.chat.completions.create.mockResolvedValue(
      openAIToolCallResponse([
        {
          id: 'call_abc',
          name: 'search',
          arguments: '{"query":"hello world","limit":10}',
        },
      ])
    )
    const provider = new OpenAIProvider(mockClient as any, 'gpt-4o')

    const result = await provider.completeSingleTurnWithTools(
      [{ role: 'user', content: 'Search' }],
      [{ name: 'search', description: 'Search', parameters: {} }]
    )

    expect(result.tool_calls).not.toBeNull()
    expect(result.tool_calls![0].arguments).toEqual({
      query: 'hello world',
      limit: 10,
    })
  })

  it('should return { _raw: string } for malformed JSON arguments', async () => {
    const mockClient = createMockOpenAIClient()
    mockClient.chat.completions.create.mockResolvedValue(
      openAIToolCallResponse([
        {
          id: 'call_abc',
          name: 'search',
          arguments: '{query: "missing quotes"}',
        },
      ])
    )
    const provider = new OpenAIProvider(mockClient as any, 'gpt-4o')

    const result = await provider.completeSingleTurnWithTools(
      [{ role: 'user', content: 'Search' }],
      [{ name: 'search', description: 'Search', parameters: {} }]
    )

    expect(result.tool_calls![0].arguments).toEqual({
      _raw: '{query: "missing quotes"}',
    })
  })
})

describe('OpenAI tool_call_id preservation', () => {
  it('should preserve unique tool_call_ids from multiple tool calls', async () => {
    const mockClient = createMockOpenAIClient()
    mockClient.chat.completions.create.mockResolvedValue(
      openAIToolCallResponse([
        { id: 'call_001', name: 'search', arguments: '{"q":"a"}' },
        { id: 'call_002', name: 'read', arguments: '{"path":"/tmp"}' },
      ])
    )
    const provider = new OpenAIProvider(mockClient as any, 'gpt-4o')

    const result = await provider.completeSingleTurnWithTools(
      [{ role: 'user', content: 'Do both' }],
      [
        { name: 'search', description: 'Search', parameters: {} },
        { name: 'read', description: 'Read', parameters: {} },
      ]
    )

    expect(result.tool_calls).toHaveLength(2)
    expect(result.tool_calls![0].id).toBe('call_001')
    expect(result.tool_calls![1].id).toBe('call_002')
    expect(result.tool_calls![0].id).not.toBe(result.tool_calls![1].id)
  })
})

describe('OpenAI message conversion', () => {
  it('should convert tool result messages to OpenAI format', async () => {
    const mockClient = createMockOpenAIClient()
    mockClient.chat.completions.create.mockResolvedValue(openAITextResponse('Got it'))
    const provider = new OpenAIProvider(mockClient as any, 'gpt-4o')

    const messages: ChatMessage[] = [
      { role: 'user', content: 'Search for X' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc_1', name: 'search', arguments: { q: 'X' } }],
      },
      { role: 'tool', content: '{"found": true}', tool_call_id: 'tc_1', name: 'search' },
    ]

    await provider.completeSingleTurnWithTools(messages, [])

    const callArgs = mockClient.chat.completions.create.mock.calls[0][0]
    const toolMsg = callArgs.messages.find((m: any) => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(toolMsg.tool_call_id).toBe('tc_1')
    expect(toolMsg.content).toBe('{"found": true}')
  })

  it('should convert assistant tool_calls back to OpenAI function format', async () => {
    const mockClient = createMockOpenAIClient()
    mockClient.chat.completions.create.mockResolvedValue(openAITextResponse('Done'))
    const provider = new OpenAIProvider(mockClient as any, 'gpt-4o')

    const messages: ChatMessage[] = [
      { role: 'user', content: 'Do X' },
      {
        role: 'assistant',
        content: 'Let me search',
        tool_calls: [{ id: 'tc_1', name: 'search', arguments: { query: 'X' } }],
      },
      { role: 'tool', content: 'result', tool_call_id: 'tc_1' },
    ]

    await provider.completeSingleTurnWithTools(messages, [])

    const callArgs = mockClient.chat.completions.create.mock.calls[0][0]
    const assistantMsg = callArgs.messages.find((m: any) => m.role === 'assistant' && m.tool_calls)
    expect(assistantMsg.tool_calls[0].type).toBe('function')
    expect(assistantMsg.tool_calls[0].function.arguments).toBe('{"query":"X"}')
    expect(typeof assistantMsg.tool_calls[0].function.arguments).toBe('string')
  })
})

describe('OpenAI contentParts in user messages (screenshot images)', () => {
  it('should convert user message with contentParts to array with image_url parts', async () => {
    const mockClient = createMockOpenAIClient()
    mockClient.chat.completions.create.mockResolvedValue(openAITextResponse('I see the screenshot'))
    const provider = new OpenAIProvider(mockClient as any, 'gpt-4o')

    const messages: ChatMessage[] = [
      { role: 'user', content: 'Take a screenshot' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc_1', name: 'screenshot', arguments: {} }],
      },
      {
        role: 'tool',
        content: 'Screenshot captured',
        tool_call_id: 'tc_1',
        name: 'screenshot',
      },
      {
        role: 'user',
        content: 'Here are the screenshots from the tool results above.',
        contentParts: [
          { type: 'text', text: 'Here are the screenshots from the tool results above.' },
          { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
        ],
      },
    ]

    await provider.completeSingleTurnWithTools(messages, [])

    const callArgs = mockClient.chat.completions.create.mock.calls[0][0]
    const userImgMsg = callArgs.messages.find(
      (m: any) => m.role === 'user' && Array.isArray(m.content)
    )
    expect(userImgMsg).toBeDefined()
    expect(userImgMsg.content).toHaveLength(2)
    expect(userImgMsg.content[0]).toEqual({
      type: 'text',
      text: 'Here are the screenshots from the tool results above.',
    })
    expect(userImgMsg.content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
    })
  })
})

describe('OpenAI finish_reason mapping', () => {
  it.each([
    ['stop', FinishReason.Stop],
    ['length', FinishReason.Length],
    ['tool_calls', FinishReason.ToolUse],
    ['content_filter', FinishReason.ContentFilter],
    [null, FinishReason.Unknown],
    ['some_future_value', FinishReason.Unknown],
  ] as const)("should map '%s' to %s", async (apiReason, expected) => {
    const mockClient = createMockOpenAIClient()
    mockClient.chat.completions.create.mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'Hi' }, finish_reason: apiReason }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })
    const provider = new OpenAIProvider(mockClient as any, 'gpt-4o')

    const result = await provider.completeSingleTurn([{ role: 'user', content: 'Hi' }])

    expect(result.finish_reason).toBe(expected)
  })
})

describe('OpenAI token limit parameter compatibility', () => {
  it('uses max_completion_tokens for the GPT-5 family', async () => {
    const mockClient = createMockOpenAIClient()
    mockClient.chat.completions.create.mockResolvedValue(openAITextResponse('OK'))
    const provider = new OpenAIProvider(mockClient as any, 'gpt-5.4-mini')

    await provider.completeSingleTurn([{ role: 'user', content: 'Hi' }], { max_tokens: 8 })

    const callArgs = mockClient.chat.completions.create.mock.calls[0][0]
    expect(callArgs.max_completion_tokens).toBe(8)
    expect(callArgs).not.toHaveProperty('max_tokens')
  })

  it('keeps max_tokens for established native models', async () => {
    const mockClient = createMockOpenAIClient()
    mockClient.chat.completions.create.mockResolvedValue(openAITextResponse('OK'))
    const provider = new OpenAIProvider(mockClient as any, 'gpt-4o')

    await provider.completeSingleTurn([{ role: 'user', content: 'Hi' }], { max_tokens: 8 })

    const callArgs = mockClient.chat.completions.create.mock.calls[0][0]
    expect(callArgs.max_tokens).toBe(8)
    expect(callArgs).not.toHaveProperty('max_completion_tokens')
  })

  it('uses max_completion_tokens for GPT-5 tool calls', async () => {
    const mockClient = createMockOpenAIClient()
    mockClient.chat.completions.create.mockResolvedValue(openAITextResponse('OK'))
    const provider = new OpenAIProvider(mockClient as any, 'gpt-5.4-mini')

    await provider.completeSingleTurnWithTools(
      [{ role: 'user', content: 'Use the tool' }],
      [{ name: 'search', description: 'Search docs', parameters: {} }],
      { max_tokens: 8 }
    )

    const callArgs = mockClient.chat.completions.create.mock.calls[0][0]
    expect(callArgs.max_completion_tokens).toBe(8)
    expect(callArgs).not.toHaveProperty('max_tokens')
  })
})

describe('OpenAI token usage mapping', () => {
  it('should map prompt_tokens/completion_tokens to input_tokens/output_tokens', async () => {
    const mockClient = createMockOpenAIClient()
    mockClient.chat.completions.create.mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 42, completion_tokens: 18, total_tokens: 60 },
    })
    const provider = new OpenAIProvider(mockClient as any, 'gpt-4o')

    const result = await provider.completeSingleTurn([{ role: 'user', content: 'Hi' }])

    expect(result.usage).toEqual({
      input_tokens: 42,
      output_tokens: 18,
      total_tokens: 60,
    })
    expect(result.usage_reported).toBe(true)
  })

  it('marks missing provider usage as non-authoritative instead of exact zero', async () => {
    const mockClient = createMockOpenAIClient()
    mockClient.chat.completions.create.mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
    })
    const provider = new OpenAIProvider(mockClient as any, 'gpt-4o')

    const result = await provider.completeSingleTurn([{ role: 'user', content: 'Hi' }])

    expect(result.usage_reported).toBe(false)
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0, total_tokens: 0 })
  })
})
