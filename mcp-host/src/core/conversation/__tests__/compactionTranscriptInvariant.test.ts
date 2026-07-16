import { describe, expect, it } from 'vitest'
import type { Conversation } from '../../types'
import { compactConversation } from '../compaction'
import { ConversationManager } from '../conversation'

/**
 * FU2 — characterization test for the compaction ↔ durable-transcript invariant.
 *
 * Closes the spec §8 open question ("Compaction mid-task: ... previous turns
 * change → trigger re-fetch of /messages"). That premise is false:
 *
 *   - `compactConversation` operates on the ephemeral `ChatMessage[]` context
 *     window the agent loop builds fresh each run via
 *     `buildMessageHistory(conversation)` (taskExecutor.runAgentLoop). It returns
 *     a NEW array; it never writes back to `conversation.turns`.
 *   - The `/messages` (GET sessions/:agent/:chatId/messages) handler reads
 *     `conversation.turns` directly (main.ts handleSessionMessages).
 *
 * Therefore a compaction cannot change what `/messages` returns, and the desktop
 * cache does NOT need to re-fetch on `compaction:executed`. These tests pin that
 * invariant so a future refactor that mutates `turns` from the compaction path
 * fails loudly here.
 */
describe('compaction ↔ durable transcript invariant (FU2, spec §8 "does not apply")', () => {
  // Build a conversation with `count` completed turns through the real manager.
  const buildConversationWithTurns = async (count: number) => {
    const manager = new ConversationManager()
    const conv = await manager.getOrCreate('user-fu2')
    for (let i = 1; i <= count; i++) {
      await manager.startTurn(conv, `User message ${i}`, `task-${i}`)
      await manager.completeTurn(conv, `Assistant response ${i}`)
    }
    return { manager, conv }
  }

  // Structural snapshot of the durable transcript (the bits /messages exposes).
  const transcriptShape = (conv: Conversation) =>
    conv.turns.map(t => ({
      number: t.number,
      user_input: t.user_input,
      response: t.response,
    }))

  it('compaction shrinks the LLM context window but leaves conversation.turns untouched', async () => {
    const { manager, conv } = await buildConversationWithTurns(6)

    const before = transcriptShape(conv)
    expect(before).toHaveLength(6)

    const messages = manager.buildMessageHistory(conv)
    expect(messages).toHaveLength(12) // 6 turns × (user + assistant)

    // Force compaction (threshold 0) keeping only the last 2 turns.
    const compacted = compactConversation(messages, 2, 0)

    // Compaction actually ran on the context window.
    expect(compacted.length).toBeLessThan(messages.length)
    expect(compacted).toHaveLength(4) // 2 turns × (user + assistant); no system msg here

    // The durable transcript that /messages reads is unchanged.
    expect(conv.turns).toHaveLength(6)
    expect(transcriptShape(conv)).toEqual(before)
  })

  it('rebuilding the history after compaction yields the full transcript again', async () => {
    const { manager, conv } = await buildConversationWithTurns(6)

    const fullBefore = manager.buildMessageHistory(conv)
    compactConversation(fullBefore, 2, 0)

    // buildMessageHistory re-derives from conversation.turns each call, so the
    // post-compaction rebuild is identical — proving compaction did not erode
    // the source of truth (and thus /messages would not diverge).
    const fullAfter = manager.buildMessageHistory(conv)
    expect(fullAfter).toEqual(fullBefore)
    expect(fullAfter).toHaveLength(12)
  })

  it('compactConversation returns a new array and never mutates its input', async () => {
    const { manager, conv } = await buildConversationWithTurns(6)
    const messages = manager.buildMessageHistory(conv)
    const inputSnapshot = messages.map(m => ({ ...m }))

    const compacted = compactConversation(messages, 2, 0)

    expect(compacted).not.toBe(messages)
    expect(messages).toEqual(inputSnapshot) // input array left intact
  })
})
