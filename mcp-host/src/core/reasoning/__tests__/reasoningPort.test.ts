import { describe, expect, it, vi } from 'vitest'
import { LlmError } from '../../errors'
import { LlmPort } from '../../interfaces'
import type { TokenCounter } from '../../tokenizer/tokenCounter'
import {
  type ChatMessage,
  FinishReason,
  type ReasoningContext,
  type ToolDefinition,
  type ToolResult,
} from '../../types'
import { type ContextBreakdownRaw, DefaultReasoningPort } from '../port'
import { DefaultPromptBuilder } from '../promptBuilder'
import type { SystemPromptParts } from '../systemPrompt'

/**
 * Token counter stub for breakdown tests. Counts deterministically so the
 * per-bucket attribution is assertable: each message content char = 1 token,
 * each tool name char = 1 token. `countSync([], tools)` therefore measures
 * ONLY the tool framing, and `countSync(messages)` only the messages.
 */
function createStubTokenCounter(): TokenCounter {
  return {
    providerName: 'openai',
    modelName: 'stub',
    count: vi.fn(async () => 0),
    countSync: (messages: ChatMessage[], tools: ToolDefinition[] = []) => {
      let total = 0
      for (const m of messages) total += (m.content ?? '').length
      for (const t of tools) total += t.name.length
      return total
    },
    warmup: vi.fn(async () => {}),
    recordObservedUsage: vi.fn(),
    lastObservedInputTokens: vi.fn(() => null),
  }
}

const okToolResponse = {
  content: 'done',
  tool_calls: null,
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  finish_reason: FinishReason.Stop,
}

function createMockLlmPort(): LlmPort {
  return {
    complete: vi.fn(),
    completeWithTools: vi.fn(),
    modelName: () => 'test-model',
  }
}

describe('DefaultReasoningPort.respondWithTools', () => {
  it('should classify tool_calls response as RespondResult.ToolCalls', async () => {
    const mockLlm = createMockLlmPort()
    ;(mockLlm.completeWithTools as any).mockResolvedValue({
      content: null,
      tool_calls: [{ id: 'tc_1', name: 'search', arguments: { q: 'test' } }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      finish_reason: FinishReason.ToolUse,
    })

    const port = new DefaultReasoningPort(mockLlm, new DefaultPromptBuilder())
    const result = await port.respondWithTools({
      messages: [{ role: 'user', content: 'Search' }],
      available_tools: [{ name: 'search', description: 'Search', parameters: {} }],
    })

    expect(result.type).toBe('tool_calls')
    if (result.type === 'tool_calls') {
      expect(result.calls).toHaveLength(1)
      expect(result.calls[0].name).toBe('search')
      expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 })
    }
  })

  it('should classify text response as RespondResult.Text with cleaned content', async () => {
    const mockLlm = createMockLlmPort()
    ;(mockLlm.completeWithTools as any).mockResolvedValue({
      content: '<thinking>hmm</thinking>The answer is 42',
      tool_calls: null,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      finish_reason: FinishReason.Stop,
    })

    const port = new DefaultReasoningPort(mockLlm, new DefaultPromptBuilder())
    const result = await port.respondWithTools({
      messages: [{ role: 'user', content: 'What?' }],
      available_tools: [],
    })

    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.content).toBe('The answer is 42')
      expect(result.content).not.toContain('<thinking>')
    }
    expect((result as { usage?: unknown }).usage).toBeUndefined()
  })

  it('should classify ContentFilter finish_reason as error', async () => {
    const mockLlm = createMockLlmPort()
    ;(mockLlm.completeWithTools as any).mockResolvedValue({
      content: null,
      tool_calls: null,
      usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 },
      finish_reason: FinishReason.ContentFilter,
    })

    const port = new DefaultReasoningPort(mockLlm, new DefaultPromptBuilder())
    const result = await port.respondWithTools({
      messages: [{ role: 'user', content: 'Bad request' }],
      available_tools: [],
    })

    expect(result.type).toBe('error')
    if (result.type === 'error') {
      expect(result.error).toBeInstanceOf(LlmError)
    }
    expect((result as { usage?: unknown }).usage).toBeUndefined()
  })

  it('should classify empty response (no content, no tool_calls) as error', async () => {
    const mockLlm = createMockLlmPort()
    ;(mockLlm.completeWithTools as any).mockResolvedValue({
      content: null,
      tool_calls: null,
      usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 },
      finish_reason: FinishReason.Stop,
    })

    const port = new DefaultReasoningPort(mockLlm, new DefaultPromptBuilder())
    const result = await port.respondWithTools({
      messages: [{ role: 'user', content: 'Hi' }],
      available_tools: [],
    })

    expect(result.type).toBe('error')
  })

  it('should prioritize tool_calls over text when both present', async () => {
    const mockLlm = createMockLlmPort()
    ;(mockLlm.completeWithTools as any).mockResolvedValue({
      content: 'Let me search that for you',
      tool_calls: [{ id: 'tc_1', name: 'search', arguments: { q: 'test' } }],
      usage: { input_tokens: 10, output_tokens: 15, total_tokens: 25 },
      finish_reason: FinishReason.ToolUse,
    })

    const port = new DefaultReasoningPort(mockLlm, new DefaultPromptBuilder())
    const result = await port.respondWithTools({
      messages: [{ role: 'user', content: 'Search' }],
      available_tools: [{ name: 'search', description: 'Search', parameters: {} }],
    })

    expect(result.type).toBe('tool_calls')
  })
})

describe('DefaultReasoningPort.continueWithToolResults', () => {
  it('should append tool results after conversation messages (Risk 3.5)', async () => {
    const mockLlm = createMockLlmPort()
    ;(mockLlm.completeWithTools as any).mockResolvedValue({
      content: 'Based on the search results...',
      tool_calls: null,
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
      finish_reason: FinishReason.Stop,
    })

    const port = new DefaultReasoningPort(mockLlm, new DefaultPromptBuilder())
    // Tool results are pre-appended by toolUseLoop before calling continueWithToolResults.
    // The context must already include the tool result message (see port.ts:65-66).
    const context: ReasoningContext = {
      messages: [
        { role: 'user', content: 'Search for X' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'tc_1', name: 'search', arguments: { q: 'X' } }],
        },
        { role: 'tool', tool_call_id: 'tc_1', content: 'Found X' },
      ],
      available_tools: [{ name: 'search', description: 'Search', parameters: {} }],
    }

    const results: ToolResult[] = [
      {
        tool_call_id: 'tc_1',
        name: 'search',
        content: 'Found X',
        is_error: false,
      },
    ]

    await port.continueWithToolResults(context, results)

    const callArgs = (mockLlm.completeWithTools as any).mock.calls[0][0]
    const messages: ChatMessage[] = callArgs.messages

    // Tool message must come AFTER assistant with tool_calls
    const assistantIdx = messages.findIndex(m => m.role === 'assistant' && m.tool_calls)
    const toolIdx = messages.findIndex(m => m.role === 'tool')

    expect(assistantIdx).toBeGreaterThan(-1)
    expect(toolIdx).toBeGreaterThan(assistantIdx)
    expect(messages[toolIdx].tool_call_id).toBe('tc_1')
  })

  it('should wrap LLM errors as RespondResult.error', async () => {
    const mockLlm = createMockLlmPort()
    ;(mockLlm.completeWithTools as any).mockRejectedValue(new Error('API down'))

    const port = new DefaultReasoningPort(mockLlm, new DefaultPromptBuilder())
    const result = await port.continueWithToolResults({ messages: [], available_tools: [] }, [])

    expect(result.type).toBe('error')
    if (result.type === 'error') {
      expect(result.error).toBeInstanceOf(LlmError)
    }
  })
})

describe('DefaultReasoningPort context-breakdown capture (F1.2)', () => {
  const parts: SystemPromptParts = {
    stable: 'STABLE_STABLE', // 13 chars
    context: 'CTX', // 3 chars
    stableHash: 'h1',
    contextHash: 'h2',
  }

  it('emits the 4 buckets on respondWithTools (cache path: stable→systemPrompt, context→metaContext)', async () => {
    const mockLlm = createMockLlmPort()
    ;(mockLlm.completeWithTools as any).mockResolvedValue(okToolResponse)
    const sink = vi.fn((_raw: ContextBreakdownRaw) => {})
    const port = new DefaultReasoningPort(
      mockLlm,
      new DefaultPromptBuilder(),
      undefined,
      undefined,
      parts,
      createStubTokenCounter(),
      sink,
      100000
    )

    await port.respondWithTools({
      messages: [
        { role: 'system', content: 'IGNORE_ME' }, // filtered out of messages bucket
        { role: 'user', content: 'hello' }, // 5
        { role: 'assistant', content: 'hi' }, // 2
      ],
      available_tools: [
        { name: 'search', description: 'd', parameters: {} }, // 6
        { name: 'add', description: 'd', parameters: {} }, // 3
      ],
    })

    expect(sink).toHaveBeenCalledTimes(1)
    const raw = sink.mock.calls[0][0]
    expect(raw.buckets).toEqual({
      messages: 7, // hello(5) + hi(2); system message excluded
      systemTools: 9, // search(6) + add(3)
      systemPrompt: 13, // stable
      metaContext: 3, // context
    })
    expect(raw.maxTokens).toBe(100000)
  })

  it('emits buckets on continueWithToolResults too', async () => {
    const mockLlm = createMockLlmPort()
    ;(mockLlm.completeWithTools as any).mockResolvedValue(okToolResponse)
    const sink = vi.fn((_raw: ContextBreakdownRaw) => {})
    const port = new DefaultReasoningPort(
      mockLlm,
      new DefaultPromptBuilder(),
      undefined,
      undefined,
      parts,
      createStubTokenCounter(),
      sink,
      100000
    )

    await port.continueWithToolResults(
      {
        messages: [{ role: 'user', content: 'abcd' }], // 4
        available_tools: [{ name: 'x', description: 'd', parameters: {} }], // 1
      },
      []
    )

    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0][0].buckets).toMatchObject({ messages: 4, systemTools: 1 })
  })

  it('legacy path (no parts): whole system message → systemPrompt, metaContext = 0', async () => {
    const mockLlm = createMockLlmPort()
    ;(mockLlm.completeWithTools as any).mockResolvedValue(okToolResponse)
    const sink = vi.fn((_raw: ContextBreakdownRaw) => {})
    const port = new DefaultReasoningPort(
      mockLlm,
      new DefaultPromptBuilder(),
      'You are a test agent.',
      undefined,
      undefined, // no parts → legacy path
      createStubTokenCounter(),
      sink,
      100000
    )

    await port.respondWithTools({
      messages: [{ role: 'user', content: 'hey' }],
      available_tools: [],
    })

    expect(sink).toHaveBeenCalledTimes(1)
    const raw = sink.mock.calls[0][0]
    expect(raw.buckets.metaContext).toBe(0)
    // The built system message is non-empty, so systemPrompt > 0.
    expect(raw.buckets.systemPrompt).toBeGreaterThan(0)
    expect(raw.buckets.messages).toBe(3)
  })

  it('a throwing counter never aborts the turn (#5)', async () => {
    const mockLlm = createMockLlmPort()
    ;(mockLlm.completeWithTools as any).mockResolvedValue(okToolResponse)
    const throwing: TokenCounter = {
      ...createStubTokenCounter(),
      countSync: () => {
        throw new Error('tokenizer exploded')
      },
    }
    const sink = vi.fn((_raw: ContextBreakdownRaw) => {})
    const port = new DefaultReasoningPort(
      mockLlm,
      new DefaultPromptBuilder(),
      undefined,
      undefined,
      parts,
      throwing,
      sink,
      100000
    )

    const result = await port.respondWithTools({
      messages: [{ role: 'user', content: 'hi' }],
      available_tools: [],
    })

    expect(result.type).toBe('text') // turn succeeded
    expect(sink).not.toHaveBeenCalled() // breakdown swallowed
  })

  it('is a no-op when tokenCounter / sink are not wired', async () => {
    const mockLlm = createMockLlmPort()
    ;(mockLlm.completeWithTools as any).mockResolvedValue(okToolResponse)
    const port = new DefaultReasoningPort(mockLlm, new DefaultPromptBuilder())
    const result = await port.respondWithTools({
      messages: [{ role: 'user', content: 'hi' }],
      available_tools: [],
    })
    expect(result.type).toBe('text')
  })
})

describe('DefaultPromptBuilder', () => {
  it('should produce system message with identity, tools, and date (Risk 3.3)', () => {
    const builder = new DefaultPromptBuilder()
    const msg = builder.buildSystemPrompt(
      [{ name: 'search', description: 'Search the web', parameters: {} }],
      'You are a research assistant.',
      { channelType: 'telegram', sender: 'user123' }
    )

    expect(msg.role).toBe('system')
    expect(msg.content).toContain('You are a research assistant.')
    expect(msg.content).toContain('search')
    expect(msg.content).toContain('Search the web')
    expect(msg.content).toContain('telegram')
    expect(msg.content).toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it('emits the capability contract when clerum__get_capabilities is registered', () => {
    const builder = new DefaultPromptBuilder()
    const msg = builder.buildSystemPrompt(
      [{ name: 'clerum__get_capabilities', description: 'discover', parameters: {} }],
      undefined,
      undefined
    )

    expect(msg.content).toContain('clerum__get_capabilities')
    expect(msg.content).toContain('$GITHUB_TOKEN')
    expect(msg.content).toContain('Never ask the user for credential values')
    expect(msg.content).toContain('Never include raw credential strings')
  })

  it('does NOT emit the capability contract when the tool is absent', () => {
    const builder = new DefaultPromptBuilder()
    const msg = builder.buildSystemPrompt(
      [{ name: 'search', description: 'Search the web', parameters: {} }],
      undefined,
      undefined
    )

    expect(msg.content).not.toContain('clerum__get_capabilities')
    expect(msg.content).not.toContain('Never ask the user for credential values')
  })

  it('emits the workflow recipe contract when workflow tools are registered', () => {
    const builder = new DefaultPromptBuilder()
    const msg = builder.buildSystemPrompt(
      [
        { name: 'workflow_list', description: 'List workflows', parameters: {} },
        { name: 'workflow_trigger', description: 'Trigger workflow', parameters: {} },
      ],
      undefined,
      undefined
    )

    expect(msg.content).toContain('WORKFLOW RECIPES')
    expect(msg.content).toContain('business inputContract')
    expect(msg.content).toContain('call `workflow_trigger`')
    expect(msg.content).toContain('never call `workflow_result` before `workflow_trigger`')
    expect(msg.content).toContain('use `workflow_result`')
    expect(msg.content).toContain('use `workflow_status` or `workflow_health` for started')
    expect(msg.content).toContain('Do not use `workflow_result` to confirm that a workflow started')
    expect(msg.content).toContain('use the same workflow recipe name from that trigger')
    expect(msg.content).toContain('do not switch to unrelated task-board')
    expect(msg.content).toContain('answer directly in chat text')
    expect(msg.content).toContain('do not call dashboard, document, image')
    expect(msg.content).toContain('Never ask for or include namespace')
    expect(msg.content).toContain('targetUserId')
    expect(msg.content).toContain(
      'Do not call `workflow_result` just because a record was created by a workflow'
    )
    expect(msg.content).toContain('use the relevant read-only MCP tool directly')
    expect(msg.content).toContain('source of truth for existence and current state')
    expect(msg.content).toContain(
      'do not answer record verification questions from `workflow_result` alone'
    )
    expect(msg.content).toContain('Do not reveal workflow namespaces')
    expect(msg.content).toContain('internal record/object IDs')
    expect(msg.content).toContain('database names')
  })

  it('emits exact MCP server selection guidance when MCP tools are registered', () => {
    const builder = new DefaultPromptBuilder()
    const msg = builder.buildSystemPrompt(
      [
        { name: 'mongodb-mcp-stack__find', description: 'Find documents', parameters: {} },
        {
          name: 'recipe-owned-mongo__find',
          description: 'Find recipe documents',
          parameters: {},
        },
      ],
      undefined,
      undefined
    )

    expect(msg.content).toContain('MCP SERVER SELECTION')
    expect(msg.content).toContain('prefix before `__` exactly matches')
    expect(msg.content).toContain('Do not substitute a different MCP server')
    expect(msg.content).toContain('use read-only tools')
    expect(msg.content).toContain('prefer that MCP server read tool over workflow artifact tools')
    expect(msg.content).toContain('prefer targeted reads over broad collection scans')
    expect(msg.content).toContain('do not pass wildcard values such as `*`')
    expect(msg.content).toContain('continue with the next read-only tool needed')
    expect(msg.content).toContain('Do not call mutating tools')
    expect(msg.content).toContain('return only the business fields requested by the user')
    expect(msg.content).toContain('do not add database names')
  })
})
