import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type Counter, register } from 'prom-client'
import { minifiedMcpResult } from '../../../__tests__/fixtures/minifiedMcpResult'
import type { WorkspaceService } from '../../../workspace/service'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import { estimateTokens, splitTurns } from '../../conversation/compaction'
import type { LlmPort } from '../../interfaces'
import { validateToolLinkages } from '../../orchestration/toolUseLoop'
import { heuristicCountTools } from '../../tokenizer/heuristic'
import type { ChatMessage, ToolDefinition } from '../../types'
import {
  InLoopContextManager,
  PressureContextManager,
  clerumCompactionTotal,
} from '../contextManager'

/**
 * Generate a message array with roughly the specified number of tokens.
 * Each message has ~50 words (about 69 tokens with the 1.3 multiplier + 4 overhead).
 */
function generateMessages(turnCount: number): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: 'system', content: 'You are a helpful assistant.' }]

  for (let i = 0; i < turnCount; i++) {
    msgs.push({
      role: 'user',
      content:
        'This is a test message with enough words to simulate a realistic conversation turn. ' +
        'The user is asking about something relatively complex that requires multiple sentences ' +
        'to properly express. Here are some additional words to pad the message to a realistic ' +
        'length that would be seen in production usage of the system. ' +
        `Turn number ${i + 1}.`,
    })
    msgs.push({
      role: 'assistant',
      content:
        "This is the assistant's response to the user's query. It contains a detailed " +
        'explanation that spans multiple sentences and includes various points. The response ' +
        "should be informative and helpful, covering all aspects of the user's question. " +
        'Here is some additional content to make the response a realistic length. ' +
        `Response for turn ${i + 1}.`,
    })
  }

  return msgs
}

function createMockWorkspace(): WorkspaceService {
  return {
    appendDailyLog: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue(null),
    write: vi.fn().mockResolvedValue(undefined),
    append: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkspaceService
}

function createMockLlmPort(): LlmPort {
  return {
    complete: vi.fn().mockResolvedValue({
      content: '- Key decision: discussed testing\n- Action: implemented tests',
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      finish_reason: 'stop',
    }),
    completeWithTools: vi.fn(),
    modelName: vi.fn().mockReturnValue('test-model'),
  } as unknown as LlmPort
}

describe('PressureContextManager', () => {
  it('should passthrough when under 80% capacity', async () => {
    // With maxTokens=100000, 80% = 80000 tokens
    // 10 turns ~ 1465 tokens (well under 80%)
    const manager = new PressureContextManager(100000)
    const msgs = generateMessages(10)

    const result = await manager.manage(msgs, makeFakeConversation())
    expect(result).toBe(msgs) // Same reference = passthrough
  })

  it('should compact to 3 turns when over 95% capacity (Truncate)', async () => {
    // 20 turns ~ 2930 tokens. maxTokens=2500 -> pressure = 1.17 (> 95%)
    const manager = new PressureContextManager(2500)
    const msgs = generateMessages(20)

    const result = await manager.manage(msgs, makeFakeConversation())

    // Should have system message + 3 turns (6 messages)
    const systemCount = result.filter(m => m.role === 'system').length
    const userCount = result.filter(m => m.role === 'user').length

    expect(systemCount).toBe(1)
    expect(userCount).toBe(3)
    // Verify the kept turns are the LAST 3
    expect(result[result.length - 1].content).toContain('Response for turn 20')
  })

  it('should compact to 5 turns when 85-95% capacity (Summarize tier)', async () => {
    // Calibrate maxTokens to land in the 85-95% range
    const msgs = generateMessages(20)
    const actualTokens = estimateTokens(msgs)

    // Set maxTokens so pressure is ~90% (in the 85-95% tier -> 5 turns)
    const maxTokens = Math.ceil(actualTokens / 0.9)
    const manager = new PressureContextManager(maxTokens)

    const result = await manager.manage(msgs, makeFakeConversation())

    const userCount = result.filter(m => m.role === 'user').length
    expect(userCount).toBe(5)
  })

  it('should compact to 8 turns when 80-85% capacity (MoveToWorkspace tier)', async () => {
    const msgs = generateMessages(20)
    const actualTokens = estimateTokens(msgs)

    // Set maxTokens so pressure is ~82% (in the 80-85% tier -> 8 turns)
    const maxTokens = Math.ceil(actualTokens / 0.82)
    const manager = new PressureContextManager(maxTokens)

    const result = await manager.manage(msgs, makeFakeConversation())

    const userCount = result.filter(m => m.role === 'user').length
    expect(userCount).toBe(8)
  })
})

describe('PressureContextManager - MoveToWorkspace', () => {
  it('should archive dropped turns to daily log when workspace is available', async () => {
    const workspace = createMockWorkspace()
    const msgs = generateMessages(20)
    const actualTokens = estimateTokens(msgs)

    // 80-85% tier -> MoveToWorkspace, keep 8
    const maxTokens = Math.ceil(actualTokens / 0.82)
    const manager = new PressureContextManager(maxTokens, workspace)

    const result = await manager.manage(msgs, makeFakeConversation())

    // Verify workspace.appendDailyLog was called
    expect(workspace.appendDailyLog).toHaveBeenCalledTimes(1)
    const logContent = (workspace.appendDailyLog as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string
    expect(logContent).toContain('Context Compacted')
    expect(logContent).toContain('12 turns archived') // 20 - 8 = 12

    // Verify the result still has 8 turns
    const userCount = result.filter(m => m.role === 'user').length
    expect(userCount).toBe(8)
  })

  it('should still compact without workspace (graceful degradation)', async () => {
    const msgs = generateMessages(20)
    const actualTokens = estimateTokens(msgs)

    // 80-85% tier without workspace
    const maxTokens = Math.ceil(actualTokens / 0.82)
    const manager = new PressureContextManager(maxTokens) // No workspace

    const result = await manager.manage(msgs, makeFakeConversation())

    const userCount = result.filter(m => m.role === 'user').length
    expect(userCount).toBe(8)
  })
})

describe('PressureContextManager - Summarize', () => {
  it('should call LLM to summarize and write to workspace', async () => {
    const workspace = createMockWorkspace()
    const llmPort = createMockLlmPort()
    const msgs = generateMessages(20)
    const actualTokens = estimateTokens(msgs)

    // 85-95% tier -> Summarize, keep 5
    const maxTokens = Math.ceil(actualTokens / 0.9)
    const manager = new PressureContextManager(maxTokens, workspace, llmPort)

    const result = await manager.manage(msgs, makeFakeConversation())

    // LLM should have been called for summarization
    expect(llmPort.complete).toHaveBeenCalledTimes(1)
    const llmCall = (llmPort.complete as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(llmCall.max_tokens).toBe(1024)
    expect(llmCall.temperature).toBe(0.3)
    expect(llmCall.messages[0].content).toContain('Summarize')

    // Workspace should have the summary written
    expect(workspace.appendDailyLog).toHaveBeenCalledTimes(1)
    const logContent = (workspace.appendDailyLog as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string
    expect(logContent).toContain('Context Summary')
    expect(logContent).toContain('15 turns summarized') // 20 - 5 = 15

    // Result has 5 turns
    const userCount = result.filter(m => m.role === 'user').length
    expect(userCount).toBe(5)
  })

  it('should fall back to MoveToWorkspace when LLM call fails', async () => {
    const workspace = createMockWorkspace()
    const llmPort = createMockLlmPort()
    ;(llmPort.complete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('LLM unavailable'))

    const msgs = generateMessages(20)
    const actualTokens = estimateTokens(msgs)
    const maxTokens = Math.ceil(actualTokens / 0.9)
    const manager = new PressureContextManager(maxTokens, workspace, llmPort)

    const result = await manager.manage(msgs, makeFakeConversation())

    // Should still compact (fallback to MoveToWorkspace)
    const userCount = result.filter(m => m.role === 'user').length
    expect(userCount).toBe(5)

    // Workspace should have the archived markdown (not summary)
    expect(workspace.appendDailyLog).toHaveBeenCalledTimes(1)
    const logContent = (workspace.appendDailyLog as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string
    expect(logContent).toContain('Context Compacted')
  })

  it('should fall back to MoveToWorkspace when no LLM port provided', async () => {
    const workspace = createMockWorkspace()
    const msgs = generateMessages(20)
    const actualTokens = estimateTokens(msgs)

    // 85-95% tier but no llmPort
    const maxTokens = Math.ceil(actualTokens / 0.9)
    const manager = new PressureContextManager(maxTokens, workspace) // No llmPort

    const result = await manager.manage(msgs, makeFakeConversation())

    // Should archive via MoveToWorkspace
    expect(workspace.appendDailyLog).toHaveBeenCalledTimes(1)
    const logContent = (workspace.appendDailyLog as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string
    expect(logContent).toContain('Context Compacted')

    const userCount = result.filter(m => m.role === 'user').length
    expect(userCount).toBe(5)
  })
})

describe('PressureContextManager - Truncate (emergency)', () => {
  it('should not call LLM or workspace when truncating at >95%', async () => {
    const workspace = createMockWorkspace()
    const llmPort = createMockLlmPort()

    const manager = new PressureContextManager(2500, workspace, llmPort)
    const msgs = generateMessages(20)

    const result = await manager.manage(msgs, makeFakeConversation())

    // Emergency truncate: no LLM, no workspace
    expect(llmPort.complete).not.toHaveBeenCalled()
    expect(workspace.appendDailyLog).not.toHaveBeenCalled()

    const userCount = result.filter(m => m.role === 'user').length
    expect(userCount).toBe(3)
  })
})

describe('InLoopContextManager', () => {
  it('should passthrough when under threshold', () => {
    const manager = new InLoopContextManager(80000, 5)
    const msgs = generateMessages(5)

    const result = manager.manage(msgs, makeFakeConversation())
    expect(result).toBe(msgs) // Same reference = passthrough
  })

  it('should compact to maxTurns when over threshold', () => {
    // Small threshold so our messages exceed it
    const manager = new InLoopContextManager(500, 3)
    const msgs = generateMessages(20)

    const result = manager.manage(msgs, makeFakeConversation())

    const userCount = result.filter(m => m.role === 'user').length
    expect(userCount).toBe(3)
  })

  it('counts the tool schemas against its threshold, as PressureContextManager does', () => {
    const msgs = generateMessages(10)
    const tools: ToolDefinition[] = [
      {
        name: 'crm_search_contacts',
        description: 'Search CRM contacts',
        parameters: {
          type: 'object',
          properties: { q: { type: 'string', description: 'x'.repeat(4_000) } },
        },
      },
    ]
    // One token above the messages alone: the two outcomes below can only
    // differ by the tools term.
    const manager = new InLoopContextManager(estimateTokens(msgs) + 1, 3)
    expect(heuristicCountTools(tools)).toBeGreaterThan(1)

    expect(manager.manage(msgs, makeFakeConversation())).toBe(msgs)
    const compacted = manager.manage(msgs, makeFakeConversation(), { tools })
    expect(compacted.filter(m => m.role === 'user')).toHaveLength(3)
  })

  it('T-R9-14d counts the system prompt against its threshold (R9-14)', () => {
    const msgs = generateMessages(10)
    const systemPrompt = '## Daily Log (frozen at session start)\n' + 'entry '.repeat(400)
    // One token above the messages alone: the two outcomes below can only
    // differ by the system prompt term.
    const manager = new InLoopContextManager(estimateTokens(msgs) + 1, 3)

    expect(manager.manage(msgs, makeFakeConversation())).toBe(msgs)
    const compacted = manager.manage(msgs, makeFakeConversation(), { systemPrompt })
    expect(compacted.filter(m => m.role === 'user')).toHaveLength(3)
    expect(compacted.at(-1)?.content).toContain('Response for turn 10')
  })
})

describe('splitTurns', () => {
  it('should split messages into turns at user boundaries', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' },
      { role: 'assistant', content: 'A2' },
      { role: 'tool', content: 'T2', tool_call_id: 'tc1', name: 'tool1' },
    ]

    const turns = splitTurns(msgs)
    expect(turns).toHaveLength(2)
    expect(turns[0]).toHaveLength(2) // user + assistant
    expect(turns[1]).toHaveLength(3) // user + assistant + tool
  })
})

describe('PressureContextManager - T1.3 boundary alignment + last-user anchor', () => {
  /**
   * Build a fixture with tool_call pairs intercalated, padded with enough
   * text to push pressure above the tier of interest.
   */
  function buildToolFixture(turnCount: number): ChatMessage[] {
    const pad =
      'lorem ipsum dolor sit amet, consectetur adipiscing elit. ' +
      'sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ' +
      'ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.'
    const msgs: ChatMessage[] = [{ role: 'system', content: 'You are a helpful assistant.' }]
    for (let i = 0; i < turnCount; i++) {
      msgs.push({ role: 'user', content: `${pad} (turn ${i + 1})` })
      msgs.push({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: `tc_${i}`, name: 'shell', arguments: { i } }],
      })
      msgs.push({
        role: 'tool',
        content: `${pad} result ${i + 1}`,
        tool_call_id: `tc_${i}`,
        name: 'shell',
      })
      msgs.push({ role: 'assistant', content: `${pad} (response ${i + 1})` })
    }
    return msgs
  }

  it('Truncate tier: no validateToolLinkages throw, last user preserved', async () => {
    const msgs = buildToolFixture(20)
    // Force >95% pressure → truncate tier.
    const manager = new PressureContextManager(2500)

    const result = await manager.manage(msgs, makeFakeConversation())

    expect(() => validateToolLinkages(result)).not.toThrow()
    // Last user message (turn 20) must be in kept set.
    expect(result.some(m => m.role === 'user' && m.content.includes('(turn 20)'))).toBe(true)
  })

  it('Summarize tier: aligned cut preserves linkages and last user', async () => {
    const msgs = buildToolFixture(20)
    const actualTokens = estimateTokens(msgs)
    // Land in 85-95% tier (summarize, keep 5).
    const maxTokens = Math.ceil(actualTokens / 0.9)
    const llmPort: LlmPort = {
      complete: vi.fn().mockResolvedValue({
        content: 'summary',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      }),
      completeWithTools: vi.fn(),
      modelName: vi.fn().mockReturnValue('test-model'),
    } as unknown as LlmPort
    const manager = new PressureContextManager(maxTokens, undefined, llmPort)

    const result = await manager.manage(msgs, makeFakeConversation())

    expect(() => validateToolLinkages(result)).not.toThrow()
    expect(result.some(m => m.role === 'user' && m.content.includes('(turn 20)'))).toBe(true)
  })

  it('MoveToWorkspace tier: aligned cut preserves linkages and last user', async () => {
    const msgs = buildToolFixture(20)
    const actualTokens = estimateTokens(msgs)
    // Land in 80-85% tier (moveToWorkspace, keep 8).
    const maxTokens = Math.ceil(actualTokens / 0.82)
    const manager = new PressureContextManager(maxTokens)

    const result = await manager.manage(msgs, makeFakeConversation())

    expect(() => validateToolLinkages(result)).not.toThrow()
    expect(result.some(m => m.role === 'user' && m.content.includes('(turn 20)'))).toBe(true)
  })

  it('preserves passthrough identity below 80%', async () => {
    const manager = new PressureContextManager(100000)
    const msgs = buildToolFixture(2)
    const result = await manager.manage(msgs, makeFakeConversation())
    expect(result).toBe(msgs)
  })
})

describe('PressureContextManager - archived markdown', () => {
  it('should format dropped turns as readable markdown', async () => {
    const workspace = createMockWorkspace()
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What is 2+2?' },
      { role: 'assistant', content: '4' },
    ]
    msgs.push(...generateMessages(9).filter(m => m.role !== 'system'))

    const actualTokens = estimateTokens(msgs)
    const manager = new PressureContextManager(Math.ceil(actualTokens / 0.82), workspace)

    await manager.manage(msgs, makeFakeConversation())

    const markdown = (workspace.appendDailyLog as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string
    expect(markdown).toContain('**User:** What is 2+2?')
    expect(markdown).toContain('**Assistant:** 4')
  })

  it('should truncate long tool outputs in archived markdown', async () => {
    const workspace = createMockWorkspace()
    const longContent = 'x'.repeat(300)
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'run tool' },
      { role: 'assistant', content: '' },
      { role: 'tool', content: longContent, tool_call_id: 'tc1', name: 'my_tool' },
    ]
    msgs.push(...generateMessages(9).filter(m => m.role !== 'system'))

    const actualTokens = estimateTokens(msgs)
    const manager = new PressureContextManager(Math.ceil(actualTokens / 0.82), workspace)

    await manager.manage(msgs, makeFakeConversation())

    const markdown = (workspace.appendDailyLog as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string
    expect(markdown).toContain('**Tool (my_tool):**')
    expect(markdown).toContain('…') // truncated
    expect(markdown).not.toContain(longContent) // full content not present
  })
})

/**
 * T-A3 — #731. The deployed decision path for `codex-subscription` and
 * `grok-subscription`: a `PressureContextManager` with NO token counter, so
 * `computeTokenPressure` falls through to `estimateTokens` → `heuristicCount`
 * (`contextManager.ts:521-522`). Both providers map to `FallbackTokenCounter`
 * (`llm/registryCore.ts:215-216`), which counts through the same
 * `heuristicCount`, so this case covers the counter path as well. The
 * heuristic counts escaped UTF-8 bytes / 4, the quantity the contract caps;
 * the word count it replaced undercounted minified JSON and left this history
 * in passthrough.
 * Pre-prune is off here (the constructor default), so the tier is what runs.
 *
 * prom-client metrics are process-global, so this block resets the registry
 * before each case. No other case in this file reads a counter.
 */
describe('PressureContextManager — #731 MCP-heavy history', () => {
  /** Snapshot a counter's labeled value (0 when the series does not exist yet). */
  async function counterValue(
    metric: Counter<string>,
    labels: Record<string, string>
  ): Promise<number> {
    const data = await metric.get()
    for (const v of data.values) {
      if (Object.entries(labels).every(([k, val]) => v.labels[k] === val)) return v.value
    }
    return 0
  }

  /**
   * The shape an agentic MCP session produces: a user request, an assistant
   * message carrying one tool call with small arguments, and a tool result
   * carrying a large minified JSON payload.
   */
  function mcpHeavyHistory(turns: number, bytesPerResult: number): ChatMessage[] {
    const msgs: ChatMessage[] = [{ role: 'system', content: 'You are a helpful assistant.' }]
    for (let turn = 1; turn <= turns; turn++) {
      msgs.push({ role: 'user', content: `Find the contacts that replied in campaign ${turn}.` })
      msgs.push({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: `call_${turn}`,
            name: 'crm_search_contacts',
            arguments: { campaignId: `camp_${turn}`, limit: 60 },
          },
        ],
      })
      msgs.push({
        role: 'tool',
        content: minifiedMcpResult(turn, bytesPerResult),
        tool_call_id: `call_${turn}`,
        name: 'crm_search_contacts',
      })
    }
    return msgs
  }

  beforeEach(() => {
    register.resetMetrics()
  })

  it('T-A3 compacts a realistic MCP-heavy history under the default budget (#731)', async () => {
    const msgs = mcpHeavyHistory(12, 35_000)
    const manager = new PressureContextManager(100000)

    const result = await manager.manage(msgs, makeFakeConversation())

    // Route: a tier ran, and it was the emergency tier.
    expect(result).not.toBe(msgs)
    expect(await counterValue(clerumCompactionTotal, { tier: 'truncate', outcome: 'ok' })).toBe(1)

    // State: the history shrank and the tool linkages survived the cut.
    expect(result.length).toBeLessThan(msgs.length)
    expect(() => validateToolLinkages(result)).not.toThrow()

    // Business signal: the tier removed BYTES, not just array entries. A cut that
    // dropped only the short user turns would satisfy the length assertion above
    // while leaving the request exactly as oversized as before.
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(msgs)) / 2
    )
  })
})

// The provider attempt contracts refuse a request whose `messages` array exceeds
// `LIMITS.maxMessages`, however few tokens it carries. Many small tool turns reach
// that bound at low token pressure, so compaction never ran and every later turn
// was refused the same way (review r2, M3).
describe('PressureContextManager message-count pressure', () => {
  function smallTurns(count: number): ChatMessage[] {
    const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }]
    for (let i = 0; msgs.length < count; i++) {
      msgs.push(
        i % 2 === 0 ? { role: 'user', content: `q${i}` } : { role: 'assistant', content: `a${i}` }
      )
    }
    return msgs
  }

  it('T-R2-3a compacts 1025 small messages below a maxMessages of 1024', async () => {
    const msgs = smallTurns(1_025)
    expect(msgs).toHaveLength(1_025)
    // Token pressure alone is far below 0.8: the same input passes through
    // without the bound, which is the refusal loop this test closes.
    expect(estimateTokens(msgs) / 1_000_000).toBeLessThan(0.8)
    expect(await new PressureContextManager(1_000_000).manage(msgs, makeFakeConversation())).toBe(
      msgs
    )

    const bounded = new PressureContextManager(1_000_000, undefined, undefined, undefined, {
      maxMessages: 1_024,
    })
    const managed = await bounded.manage(msgs, makeFakeConversation())

    expect(managed.length).toBeLessThan(1_024)
    expect(() => validateToolLinkages(managed)).not.toThrow()
  })
})
