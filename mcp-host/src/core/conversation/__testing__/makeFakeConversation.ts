/**
 * Test-only fixture for the `Conversation` type.
 *
 * P.5 introduced the canonical `ContextManager.manage(messages, conversation,
 * options?)` signature. Tests that exercise compaction (or any code path
 * downstream of `buildLoopConfig`) need a minimal-but-valid Conversation to
 * pass through. Centralising the shape here means that when later plans add
 * required fields (T1.4 `compactionState`, T2.1 persistence columns, etc.)
 * we update one helper instead of dozens of call sites.
 *
 * NOT FOR PRODUCTION USE — lives under `__testing__/` so production bundles
 * never see it.
 */
import { Conversation, ConversationState } from '../../types'

export function makeFakeConversation(overrides: Partial<Conversation> = {}): Conversation {
  const now = new Date()
  return {
    id: 'fake-conv',
    user_id: 'fake-user',
    state: ConversationState.Idle,
    turns: [],
    auto_approved_tools: new Set<string>(),
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}
