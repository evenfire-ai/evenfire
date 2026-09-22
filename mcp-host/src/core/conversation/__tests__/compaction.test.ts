import { describe, expect, it } from 'vitest'
import { validateToolLinkages } from '../../orchestration/toolUseLoop'
import { ChatMessage } from '../../types'
import { compactConversation, estimateTokens } from '../compaction'

describe('estimateTokens', () => {
  it('should estimate within reasonable range for typical messages (Risk 5.6)', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What is the capital of France?' },
      { role: 'assistant', content: 'The capital of France is Paris.' },
      { role: 'user', content: 'Tell me more about it.' },
      {
        role: 'assistant',
        content:
          "Paris is the largest city in France and serves as the country's political, economic, and cultural center.",
      },
    ]

    const estimate = estimateTokens(messages)

    // The estimate should be a positive number in a reasonable range
    expect(estimate).toBeGreaterThan(40)
    expect(estimate).toBeLessThan(200)
  })

  it('should return 0 for empty message array', () => {
    expect(estimateTokens([])).toBe(0)
  })
})

describe('compactConversation', () => {
  it('should keep system message + last N turns (Risk 5.5)', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are an assistant.' },
      { role: 'user', content: 'Turn 1' },
      { role: 'assistant', content: 'Response 1' },
      { role: 'user', content: 'Turn 2' },
      { role: 'assistant', content: 'Response 2' },
      { role: 'user', content: 'Turn 3' },
      { role: 'assistant', content: 'Response 3' },
      { role: 'user', content: 'Turn 4' },
      { role: 'assistant', content: 'Response 4' },
    ]

    // Force compaction by setting threshold to 0
    const compacted = compactConversation(messages, 2, 0)

    // System message preserved
    expect(compacted[0]).toEqual({
      role: 'system',
      content: 'You are an assistant.',
    })

    // Only last 2 turns kept
    expect(compacted).toHaveLength(5) // system + 2*(user+assistant)
    expect(compacted[1].content).toBe('Turn 3')
    expect(compacted[2].content).toBe('Response 3')
    expect(compacted[3].content).toBe('Turn 4')
    expect(compacted[4].content).toBe('Response 4')
  })

  it('should not compact when under threshold', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]

    // Default threshold is 80000 — these messages are tiny
    const result = compactConversation(messages)
    expect(result).toEqual(messages)
  })

  it("T1.3: never archives the last user message ('Active Task' anchor)", () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', content: 'r1' },
      { role: 'user', content: 'turn 2' },
      { role: 'assistant', content: 'r2' },
      { role: 'user', content: 'ACTIVE TASK' },
      { role: 'assistant', content: 'working' },
    ]

    const compacted = compactConversation(messages, 1, 0)
    // Even with maxTurns=1 + threshold=0 (force aggressive compaction), the
    // anchor pulls the cut back so the active user task survives.
    expect(compacted.some(m => m.content === 'ACTIVE TASK')).toBe(true)
  })

  it('T1.3: kept set never violates tool linkages after compaction', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'old r' },
      { role: 'user', content: 'next' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc_a', name: 'shell', arguments: {} }],
      },
      { role: 'tool', content: 'ok', tool_call_id: 'tc_a' },
      { role: 'assistant', content: 'done' },
    ]

    const compacted = compactConversation(messages, 1, 0)
    expect(() => validateToolLinkages(compacted)).not.toThrow()
  })
})

describe('compactConversation — pre-prune is gated at the threshold (#731)', () => {
  // One old turn whose tool result is far over the pre-prune summary threshold
  // (200 tokens), then three short turns the pre-prune protects. Four turns
  // stay under the default `maxTurns` of 5, so only the pre-prune can change it.
  const OLD_RESULT = 'x'.repeat(40_000)
  function prunableHistory(): ChatMessage[] {
    return [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q0' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc0', name: 'fetch', arguments: { url: 'https://example.test' } }],
      },
      { role: 'tool', tool_call_id: 'tc0', name: 'fetch', content: OLD_RESULT },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: 'a3' },
    ]
  }
  const prePruneOn = { enabled: true }

  it('T-R2-4a returns the input untouched below the threshold even with pre-prune on', () => {
    const messages = prunableHistory()
    expect(compactConversation(messages, undefined, 1_000_000, undefined, prePruneOn)).toBe(
      messages
    )
  })

  it('T-R2-4a witness: the same history is pre-pruned above the threshold', () => {
    const messages = prunableHistory()
    const compacted = compactConversation(messages, undefined, 1_000, undefined, prePruneOn)
    const oldResult = compacted.find(m => m.role === 'tool')
    expect(oldResult?.content).not.toBe(OLD_RESULT)
    expect(oldResult!.content.length).toBeLessThan(OLD_RESULT.length / 10)
  })
})
