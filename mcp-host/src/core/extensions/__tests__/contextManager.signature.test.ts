/**
 * P.5 — smoke tests for the canonical `ContextManager.manage(messages,
 * conversation, options?)` signature.
 *
 * Coverage:
 *  - All three implementations (`PressureContextManager`,
 *    `InLoopContextManager`, `DefaultContextManager`) accept the canonical
 *    signature and respect the IronClaw defensive guard.
 *  - The options bag is plumbed through (no body change in P.5 — T1.1 will
 *    consume `focus`/`forceTier`).
 *
 * These tests guard the contract, not the compaction logic — that's exercised
 * by `contextManager.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import type { ContextManageOptions } from '../../interfaces'
import { DefaultContextManager } from '../../orchestration/loopConfig'
import { ChatMessage, ConversationState, type PendingApproval } from '../../types'
import { InLoopContextManager, PressureContextManager } from '../contextManager'

const sampleMessages: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi' },
]

const pendingApprovalFixture: PendingApproval = {
  request_id: 'req-1',
  tool_name: 'shell_exec',
  parameters: {},
  description: 'pending',
  tool_call_id: 'tc-1',
  context_snapshot: [],
}

describe('ContextManager canonical signature (P.5)', () => {
  it('PressureContextManager accepts (messages, conversation, options?)', async () => {
    const mgr = new PressureContextManager(1_000_000) // huge budget → passthrough
    const opts: ContextManageOptions = { focus: 'auth-rewrite' }
    const result = await mgr.manage(sampleMessages, makeFakeConversation(), opts)
    expect(result).toBe(sampleMessages)
  })

  it('InLoopContextManager accepts (messages, conversation, options?)', () => {
    const mgr = new InLoopContextManager(1_000_000, 5)
    const opts: ContextManageOptions = { forceTier: 'summarize' }
    const result = mgr.manage(sampleMessages, makeFakeConversation(), opts)
    expect(result).toBe(sampleMessages)
  })

  it('DefaultContextManager accepts (messages, conversation, options?) as passthrough', () => {
    const mgr = new DefaultContextManager()
    const result = mgr.manage(sampleMessages, makeFakeConversation(), {
      useMainLlm: true,
    })
    expect(result).toBe(sampleMessages)
  })
})

describe('ContextManager IronClaw defensive guard (P.5 §5.3)', () => {
  it('PressureContextManager passes through silently when pending_approval is set', async () => {
    // Tiny budget would normally truncate aggressively — guard must skip.
    const mgr = new PressureContextManager(50)
    const conv = makeFakeConversation({
      state: ConversationState.AwaitingApproval,
      pending_approval: pendingApprovalFixture,
    })
    const result = await mgr.manage(sampleMessages, conv)
    expect(result).toBe(sampleMessages)
  })

  it('InLoopContextManager passes through silently when pending_approval is set', () => {
    const mgr = new InLoopContextManager(50, 1)
    const conv = makeFakeConversation({
      state: ConversationState.AwaitingApproval,
      pending_approval: pendingApprovalFixture,
    })
    const result = mgr.manage(sampleMessages, conv)
    expect(result).toBe(sampleMessages)
  })
})
