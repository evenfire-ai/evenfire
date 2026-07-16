/**
 * P.3 §6.5 — IronClaw identity invariant (P0-005): a session that is not
 * Idle (Processing or AwaitingApproval) MUST retain the same Conversation
 * reference across cache pressure. Without this, ConversationManager's
 * in-place mutations of `pending_approval` would be silently dropped after
 * an LRU eviction.
 *
 * Activated by T2.1 — the `PinnedLRUMap` and `SqliteConversationStore`
 * exist now and the identity contract is the load-bearing invariant for
 * cross-pod-restart resume.
 */
import { describe, expect, it } from 'vitest'
import { ConversationManager } from '../../core/conversation/conversation'
import { makeSqliteStore } from '../../core/conversation/persistence/__tests__/testHelpers'
import { ConversationState } from '../../core/types'

describe('IronClaw identity invariant: pinned sessions survive LRU pressure', () => {
  it('session in AwaitingApproval retains the same reference across cache fills', async () => {
    const handle = makeSqliteStore({ cacheSize: 4 })
    try {
      const manager = new ConversationManager(handle.store)
      const pinnedKey = 'pinned:rpc:agent:default'
      const pinnedConv = await manager.getOrCreate(pinnedKey)
      await manager.startTurn(pinnedConv, 'do dangerous', 'test-task')
      await manager.suspendForApproval(pinnedConv, {
        request_id: 'req-pinned',
        tool_name: 'shell_exec',
        tool_call_id: 'tc-pinned',
        parameters: {},
        description: 'pinned',
        context_snapshot: [],
      })

      // Pump unrelated Idle sessions through the cache. Each one is allowed
      // to evict an older Idle entry but NEVER the pinned one.
      for (let i = 0; i < 32; i++) {
        await manager.getOrCreate(`u-${i}:rpc:agent:default`)
      }

      // Reference identity preserved.
      const reloaded = handle.store.get(pinnedKey)
      expect(reloaded).toBe(pinnedConv)
      expect(reloaded?.state).toBe(ConversationState.AwaitingApproval)
      expect(reloaded?.pending_approval?.request_id).toBe('req-pinned')
    } finally {
      await handle.shutdown()
    }
  })

  it('session in Processing also stays pinned', async () => {
    const handle = makeSqliteStore({ cacheSize: 4 })
    try {
      const manager = new ConversationManager(handle.store)
      const pinnedKey = 'busy:rpc:agent:default'
      const pinnedConv = await manager.getOrCreate(pinnedKey)
      await manager.startTurn(pinnedConv, 'a long task', 'test-task')
      // Processing state — should be pinned by reconcilePinning.
      for (let i = 0; i < 32; i++) {
        await manager.getOrCreate(`u-${i}:rpc:agent:default`)
      }
      expect(handle.store.get(pinnedKey)).toBe(pinnedConv)
      expect(pinnedConv.state).toBe(ConversationState.Processing)
    } finally {
      await handle.shutdown()
    }
  })

  it('Idle session can be evicted (and reload yields a new reference)', async () => {
    const handle = makeSqliteStore({ cacheSize: 2 })
    try {
      const manager = new ConversationManager(handle.store)
      const idleKey = 'idle:rpc:agent:default'
      const initial = await manager.getOrCreate(idleKey)
      // Two more Idle sessions evict `initial`.
      await manager.getOrCreate('other-1:rpc:agent:default')
      await manager.getOrCreate('other-2:rpc:agent:default')
      expect(handle.store.has(idleKey)).toBe(false)

      // Rehydrating yields a new (but equivalent) reference.
      const reloaded = await handle.store.getOrLoad(idleKey)
      expect(reloaded).toBeDefined()
      expect(reloaded).not.toBe(initial)
      expect(reloaded!.id).toBe(initial.id)
    } finally {
      await handle.shutdown()
    }
  })
})
