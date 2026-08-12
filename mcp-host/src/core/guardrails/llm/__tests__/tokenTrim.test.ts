/**
 * token-trim built-in tests (spec §7.2). Covers the built-in's own gate logic
 * (budget gate, passthrough). The four prune passes themselves are covered by
 * the existing prePrune suite; this just verifies the thin request adapter.
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage, ToolCompletionRequest } from '../../../types'
import { applyTokenTrim } from '../builtins/tokenTrim'

const req = (messages: ChatMessage[] = []): ToolCompletionRequest => ({ messages, tools: [] })

describe('applyTokenTrim', () => {
  it('under budget → request unchanged (same reference)', () => {
    const r = req([{ role: 'user', content: 'hi' } as ChatMessage])
    expect(applyTokenTrim(r, { maxInputTokens: 1_000_000 })).toBe(r)
  })

  it('empty message list → unchanged', () => {
    const r = req([])
    expect(applyTokenTrim(r, {})).toBe(r)
  })

  it('does not mutate the input request', () => {
    const messages = [{ role: 'user', content: 'hi' } as ChatMessage]
    const r = req(messages)
    applyTokenTrim(r, { maxInputTokens: 1_000_000 })
    expect(r.messages).toBe(messages)
  })
})
