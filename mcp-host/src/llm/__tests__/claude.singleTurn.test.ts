import { describe, expect, it, vi } from 'vitest'
import { type ChatMessage, FinishReason } from '../../core/types'
import { ClaudeProvider } from '../claude'

function createMockClaudeClient() {
  return {
    messages: {
      create: vi.fn(),
    },
  }
}

function claudeToolUseResponse(
  blocks: Array<{
    id: string
    name: string
    input: Record<string, unknown>
  }>
) {
  return {
    content: blocks.map(b => ({
      type: 'tool_use',
      id: b.id,
      name: b.name,
      input: b.input,
    })),
    stop_reason: 'tool_use',
    usage: { input_tokens: 100, output_tokens: 50 },
  }
}

describe('Claude system message handling', () => {
  it('should extract system message to top-level param, not in messages[]', async () => {
    const mockClient = createMockClaudeClient()
    mockClient.messages.create.mockResolvedValue({
      content: [{ type: 'text', text: 'Hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const provider = new ClaudeProvider(mockClient as any, 'claude-3-5-sonnet-20241022')

    await provider.completeSingleTurn([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ])

    const callArgs = mockClient.messages.create.mock.calls[0][0]
    expect(callArgs.system).toBe('You are helpful.')
    const hasSystem = callArgs.messages.some((m: any) => m.role === 'system')
    expect(hasSystem).toBe(false)
  })

  it('should join multiple system messages with double newline', async () => {
    const mockClient = createMockClaudeClient()
    mockClient.messages.create.mockResolvedValue({
      content: [{ type: 'text', text: 'Ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const provider = new ClaudeProvider(mockClient as any, 'claude-3-5-sonnet-20241022')

    await provider.completeSingleTurn([
      { role: 'system', content: 'Part 1' },
      { role: 'system', content: 'Part 2' },
      { role: 'user', content: 'Hi' },
    ])

    const callArgs = mockClient.messages.create.mock.calls[0][0]
    expect(callArgs.system).toBe('Part 1\n\nPart 2')
  })
})

describe('Claude mixed content response', () => {
  it('should preserve text content when response has both text and tool_use', async () => {
    const mockClient = createMockClaudeClient()
    mockClient.messages.create.mockResolvedValue({
      content: [
        { type: 'text', text: 'Let me search for that.' },
        { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'test' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 20, output_tokens: 30 },
    })
    const provider = new ClaudeProvider(mockClient as any, 'claude-3-5-sonnet-20241022')

    const result = await provider.completeSingleTurnWithTools(
      [{ role: 'user', content: 'Find X' }],
      [{ name: 'search', description: 'Search', parameters: {} }]
    )

    expect(result.content).toBe('Let me search for that.')
    expect(result.tool_calls).toHaveLength(1)
    expect(result.tool_calls![0].name).toBe('search')
  })
})

describe('Claude tool_use_id handling', () => {
  it('should extract tool call ID from block.id', async () => {
    const mockClient = createMockClaudeClient()
    mockClient.messages.create.mockResolvedValue(
      claudeToolUseResponse([{ id: 'toolu_01ABC', name: 'search', input: { q: 'test' } }])
    )
    const provider = new ClaudeProvider(mockClient as any, 'claude-3-5-sonnet-20241022')

    const result = await provider.completeSingleTurnWithTools(
      [{ role: 'user', content: 'Search' }],
      [{ name: 'search', description: 'Search', parameters: {} }]
    )

    expect(result.tool_calls![0].id).toBe('toolu_01ABC')
  })
})

describe('Claude tool result message format', () => {
  it('should convert tool messages to user role with tool_result blocks', async () => {
    const mockClient = createMockClaudeClient()
    mockClient.messages.create.mockResolvedValue({
      content: [{ type: 'text', text: 'Got it' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 20, output_tokens: 10 },
    })
    const provider = new ClaudeProvider(mockClient as any, 'claude-3-5-sonnet-20241022')

    const messages: ChatMessage[] = [
      { role: 'user', content: 'Search X' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'toolu_01', name: 'search', arguments: { q: 'X' } }],
      },
      { role: 'tool', content: 'found it', tool_call_id: 'toolu_01', name: 'search' },
    ]

    await provider.completeSingleTurnWithTools(messages, [])

    const callArgs = mockClient.messages.create.mock.calls[0][0]
    const toolResultMsg = callArgs.messages.find(
      (m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'tool_result')
    )
    expect(toolResultMsg).toBeDefined()
    expect(toolResultMsg.role).toBe('user')
    expect(toolResultMsg.content[0].type).toBe('tool_result')
    expect(toolResultMsg.content[0].tool_use_id).toBe('toolu_01')
  })

  it('should group consecutive tool results into one user message', async () => {
    const mockClient = createMockClaudeClient()
    mockClient.messages.create.mockResolvedValue({
      content: [{ type: 'text', text: 'Done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 30, output_tokens: 10 },
    })
    const provider = new ClaudeProvider(mockClient as any, 'claude-3-5-sonnet-20241022')

    const messages: ChatMessage[] = [
      { role: 'user', content: 'Do both' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'toolu_01', name: 'search', arguments: { q: 'A' } },
          { id: 'toolu_02', name: 'read', arguments: { path: '/tmp' } },
        ],
      },
      { role: 'tool', content: 'result A', tool_call_id: 'toolu_01' },
      { role: 'tool', content: 'result B', tool_call_id: 'toolu_02' },
    ]

    await provider.completeSingleTurnWithTools(messages, [])

    const callArgs = mockClient.messages.create.mock.calls[0][0]
    const toolResultMsgs = callArgs.messages.filter(
      (m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'tool_result')
    )
    expect(toolResultMsgs).toHaveLength(1)
    expect(toolResultMsgs[0].content).toHaveLength(2)
  })
})

describe('Claude contentParts in tool messages', () => {
  it('should convert tool message with contentParts to image blocks with base64 source', async () => {
    const mockClient = createMockClaudeClient()
    mockClient.messages.create.mockResolvedValue({
      content: [{ type: 'text', text: 'I see the screenshot' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 50, output_tokens: 20 },
    })
    const provider = new ClaudeProvider(mockClient as any, 'claude-3-5-sonnet-20241022')

    const messages: ChatMessage[] = [
      { role: 'user', content: 'Take a screenshot' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'toolu_01', name: 'screenshot', arguments: {} }],
      },
      {
        role: 'tool',
        content: 'Screenshot captured',
        tool_call_id: 'toolu_01',
        name: 'screenshot',
        contentParts: [
          { type: 'text', text: 'Screenshot captured' },
          { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
        ],
      },
    ]

    await provider.completeSingleTurnWithTools(messages, [])

    const callArgs = mockClient.messages.create.mock.calls[0][0]
    // Claude wraps tool results in a user message with tool_result blocks
    const toolResultMsg = callArgs.messages.find(
      (m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'tool_result')
    )
    expect(toolResultMsg).toBeDefined()
    const toolResult = toolResultMsg.content.find((c: any) => c.type === 'tool_result')
    expect(toolResult.tool_use_id).toBe('toolu_01')
    // content should be an array with text and image blocks
    expect(Array.isArray(toolResult.content)).toBe(true)
    expect(toolResult.content).toHaveLength(2)
    expect(toolResult.content[0]).toEqual({ type: 'text', text: 'Screenshot captured' })
    expect(toolResult.content[1]).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: 'iVBORw0KGgo=',
      },
    })
  })
})

describe('Claude contentParts in user messages (post-tool screenshots)', () => {
  it('should convert user message with contentParts to image blocks (mirrors openai path used by the loop)', async () => {
    const mockClient = createMockClaudeClient()
    mockClient.messages.create.mockResolvedValue({
      content: [{ type: 'text', text: 'Acknowledged the screenshot' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 50, output_tokens: 20 },
    })
    const provider = new ClaudeProvider(mockClient as any, 'claude-3-5-sonnet-20241022')

    // toolUseLoop appends a user-role message after tool results when images are collected.
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Take a screenshot' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'toolu_01', name: 'desktop_screenshot', arguments: {} }],
      },
      {
        role: 'tool',
        content: 'Screenshot captured',
        tool_call_id: 'toolu_01',
        name: 'desktop_screenshot',
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

    const callArgs = mockClient.messages.create.mock.calls[0][0]
    // Find the user message that carries the image block (not the tool_result one)
    const userImgMsg = callArgs.messages.find(
      (m: any) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some((c: any) => c.type === 'image')
    )
    expect(userImgMsg).toBeDefined()
    expect(userImgMsg.content).toHaveLength(2)
    expect(userImgMsg.content[0]).toEqual({
      type: 'text',
      text: 'Here are the screenshots from the tool results above.',
    })
    expect(userImgMsg.content[1]).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: 'iVBORw0KGgo=',
      },
    })
  })
})

describe('Claude argument format', () => {
  it('should pass through already-parsed input objects without double-parsing', async () => {
    const mockClient = createMockClaudeClient()
    const inputObj = { query: 'hello', filters: { limit: 10, offset: 0 } }
    mockClient.messages.create.mockResolvedValue(
      claudeToolUseResponse([{ id: 'toolu_01', name: 'search', input: inputObj }])
    )
    const provider = new ClaudeProvider(mockClient as any, 'claude-3-5-sonnet-20241022')

    const result = await provider.completeSingleTurnWithTools(
      [{ role: 'user', content: 'Search' }],
      [{ name: 'search', description: 'Search', parameters: {} }]
    )

    expect(result.tool_calls![0].arguments).toEqual(inputObj)
    expect(typeof result.tool_calls![0].arguments).toBe('object')
  })
})

describe('Claude stop_reason mapping', () => {
  it.each([
    ['end_turn', FinishReason.Stop],
    ['max_tokens', FinishReason.Length],
    ['tool_use', FinishReason.ToolUse],
    [null, FinishReason.Unknown],
    ['some_future_value', FinishReason.Unknown],
  ] as const)("should map '%s' to %s", async (apiReason, expected) => {
    const mockClient = createMockClaudeClient()
    mockClient.messages.create.mockResolvedValue({
      content: [{ type: 'text', text: 'Hi' }],
      stop_reason: apiReason,
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const provider = new ClaudeProvider(mockClient as any, 'claude-3-5-sonnet-20241022')

    const result = await provider.completeSingleTurn([{ role: 'user', content: 'Hi' }])

    expect(result.finish_reason).toBe(expected)
  })
})

describe('Claude token usage mapping', () => {
  it('should map input_tokens/output_tokens and compute total', async () => {
    const mockClient = createMockClaudeClient()
    mockClient.messages.create.mockResolvedValue({
      content: [{ type: 'text', text: 'Hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 37, output_tokens: 12 },
    })
    const provider = new ClaudeProvider(mockClient as any, 'claude-3-5-sonnet-20241022')

    const result = await provider.completeSingleTurn([{ role: 'user', content: 'Hi' }])

    expect(result.usage).toEqual({
      input_tokens: 37,
      output_tokens: 12,
      total_tokens: 49,
    })
  })
})
