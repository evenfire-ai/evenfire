import { describe, expect, it } from 'vitest'
import { applyAlignedCut } from '../../conversation/compaction'
import type { ChatMessage } from '../../types'
import { validateToolLinkages } from '../toolUseLoop'

describe('validateToolLinkages', () => {
  it('should pass with correct ordering: assistant(tool_calls) → tool results (Risk 4.4a)', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Search' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc_1', name: 'search', arguments: {} }],
      },
      { role: 'tool', content: 'result', tool_call_id: 'tc_1' },
      { role: 'assistant', content: 'Here are the results' },
    ]

    expect(() => validateToolLinkages(messages)).not.toThrow()
  })

  it('should throw when tool result is missing for a tool_call (Risk 4.4b)', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Search' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'tc_1', name: 'search', arguments: {} },
          { id: 'tc_2', name: 'read', arguments: {} },
        ],
      },
      // Only one tool result — tc_2 is missing
      { role: 'tool', content: 'result', tool_call_id: 'tc_1' },
    ]

    expect(() => validateToolLinkages(messages)).toThrow(/tc_2/)
  })

  it('should pass with multiple tool call/result pairs', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Do both' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'tc_1', name: 'search', arguments: {} },
          { id: 'tc_2', name: 'read', arguments: {} },
        ],
      },
      { role: 'tool', content: 'search result', tool_call_id: 'tc_1' },
      { role: 'tool', content: 'read result', tool_call_id: 'tc_2' },
      { role: 'assistant', content: 'Both done' },
    ]

    expect(() => validateToolLinkages(messages)).not.toThrow()
  })

  it('should handle nudge messages between tool rounds without breaking (Risk 4.9)', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Search' },
      { role: 'assistant', content: "I'll describe what I'd do..." }, // nudge-rejected text
      {
        role: 'user',
        content: 'Please proceed and use the available tools.',
      }, // nudge
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc_1', name: 'search', arguments: {} }],
      },
      { role: 'tool', content: 'result', tool_call_id: 'tc_1' },
    ]

    // Should pass — nudge messages don't have tool_calls, so no linkage to check
    expect(() => validateToolLinkages(messages)).not.toThrow()
  })
})

describe('validateToolLinkages — T1.3 regression (post-aligner safety net)', () => {
  it('aligner output does not violate linkages even for a cut that originally split a tool pair', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'first task' },
      { role: 'assistant', content: 'doing it' },
      { role: 'user', content: 'next task' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc_a', name: 'shell', arguments: {} }],
      },
      { role: 'tool', content: 'ok', tool_call_id: 'tc_a' },
      { role: 'assistant', content: 'done' },
    ]

    // Without the aligner, cut=4 would archive the lead and leave the tool
    // orphaned in kept — validateToolLinkages would later trip.
    const { kept } = applyAlignedCut([], messages, 4)
    expect(() => validateToolLinkages(kept)).not.toThrow()
  })

  it('aligner discards a fully-orphan assistant.tool_calls so kept passes validation', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'thinking' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'orphan', name: 'x', arguments: {} }],
      },
      { role: 'user', content: 'never mind' },
      { role: 'assistant', content: 'ok' },
    ]

    // cut=2 would leave the orphan lead in kept; aligner advances to 3.
    const { kept } = applyAlignedCut([], messages, 2)
    expect(() => validateToolLinkages(kept)).not.toThrow()
    // Orphan was dropped:
    expect(kept.some(m => m.tool_calls?.some(tc => tc.id === 'orphan'))).toBe(false)
  })
})
