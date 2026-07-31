import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationState, type PendingApproval, type TraceContextV1 } from '../../../types'
import { ConversationManager } from '../../conversation'
import { CacheOverflowError } from '../pinnedLruMap'
import { type StoreHandle, makeSqliteStore } from './testHelpers'

const SESSION_KEY = 'u-1:rpc:agent-x:chat-1'

afterEach(async () => {
  // each test cleans up its own handle
})

describe('SqliteConversationStore — basic round-trip', () => {
  it('create → suspend → load_active_session preserves state', async () => {
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conv, 'hello', 'test-task')
      const approval: PendingApproval = {
        request_id: 'req-1',
        tool_name: 'shell_exec',
        tool_call_id: 'tc_1',
        parameters: { cmd: 'ls' },
        description: 'list files',
        context_snapshot: [],
      }
      await manager.suspendForApproval(conv, approval)

      const reloaded = handle.worker.db
        .prepare('SELECT state FROM sessions WHERE id = ?')
        .get(conv.id) as { state: string } | undefined
      expect(reloaded?.state).toBe('awaiting_approval')

      const pending = handle.worker.db
        .prepare('SELECT request_id, tool_name FROM pending_approvals WHERE session_id = ?')
        .get(conv.id) as { request_id: string; tool_name: string } | undefined
      expect(pending?.request_id).toBe('req-1')
      expect(pending?.tool_name).toBe('shell_exec')
    } finally {
      await handle.shutdown()
    }
  })

  it('approve removes the pending_approval row', async () => {
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conv, 'hello', 'test-task')
      await manager.suspendForApproval(conv, {
        request_id: 'req-2',
        tool_name: 'shell_exec',
        tool_call_id: 'tc_2',
        parameters: {},
        description: 'test',
        context_snapshot: [],
      })

      await manager.approve(conv, false)

      const pendingCount = handle.worker.db
        .prepare('SELECT COUNT(*) AS n FROM pending_approvals WHERE session_id = ?')
        .get(conv.id) as { n: number }
      expect(pendingCount.n).toBe(0)
    } finally {
      await handle.shutdown()
    }
  })
})

describe('SqliteConversationStore — session token counters', () => {
  it('persistSessionUsage accumulates into sessions.*_tokens and rehydrates on cold-load', async () => {
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)

      // Two LLM calls: one Anthropic-style (cache defined), one without.
      manager.recordSessionUsage(conv, {
        input_tokens: 100,
        output_tokens: 40,
        cache_read_tokens: 10,
        cache_write_tokens: 5,
      })
      manager.recordSessionUsage(conv, {
        input_tokens: 50,
        output_tokens: 20,
        cache_read_tokens: 3,
        cache_write_tokens: 0,
      })

      // RAM mirror reflects the running totals immediately.
      expect(conv.input_tokens).toBe(150)
      expect(conv.output_tokens).toBe(60)
      expect(conv.cache_read_tokens).toBe(13)
      expect(conv.cache_write_tokens).toBe(5)
      expect(conv.cacheTokensReported).toBe(true)

      await handle.persistQueue.drainSessionKey(SESSION_KEY)

      const row = handle.worker.db
        .prepare(
          'SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, message_count FROM sessions WHERE id = ?'
        )
        .get(conv.id) as Record<string, number>
      expect(row.input_tokens).toBe(150)
      expect(row.output_tokens).toBe(60)
      expect(row.cache_read_tokens).toBe(13)
      expect(row.cache_write_tokens).toBe(5)
      // usage writes must not invent messages
      expect(row.message_count).toBe(0)

      // Cold-load: drop from cache and reload from SQLite.
      handle.store['cache'].delete(SESSION_KEY)
      handle.store['ordinals'].clear()
      handle.store['sessionKeyById'].clear()
      const reloaded = await handle.store.getOrLoad(SESSION_KEY)
      expect(reloaded?.input_tokens).toBe(150)
      expect(reloaded?.output_tokens).toBe(60)
      expect(reloaded?.cache_read_tokens).toBe(13)
      expect(reloaded?.cache_write_tokens).toBe(5)
      expect(reloaded?.cacheTokensReported).toBe(true)
    } finally {
      await handle.shutdown()
    }
  })

  it('per-turn tokens are stamped on the final message and rehydrate on cold-load', async () => {
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conv, 'hello', 'task-1')
      // two LLM calls within the turn (e.g. tool loop)
      manager.recordSessionUsage(conv, {
        input_tokens: 100,
        output_tokens: 40,
        cache_read_tokens: 7,
        cache_write_tokens: 0,
      })
      manager.recordSessionUsage(conv, {
        input_tokens: 30,
        output_tokens: 10,
        cache_read_tokens: 3,
        cache_write_tokens: 0,
      })
      await manager.completeTurn(conv, 'done')

      await handle.persistQueue.drainSessionKey(SESSION_KEY)

      // The final assistant message carries the summed per-turn total.
      const msg = handle.worker.db
        .prepare(
          "SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM messages WHERE session_id = ? AND role = 'assistant' AND finish_reason = 'stop'"
        )
        .get(conv.id) as Record<string, number>
      expect(msg).toMatchObject({
        input_tokens: 130,
        output_tokens: 50,
        cache_read_tokens: 10,
        cache_write_tokens: 0,
      })
      // The user message carries no token columns.
      const userMsg = handle.worker.db
        .prepare("SELECT input_tokens FROM messages WHERE session_id = ? AND role = 'user'")
        .get(conv.id) as { input_tokens: number | null }
      expect(userMsg.input_tokens).toBeNull()

      // Cold-load → reconstruct sums onto Turn.tokens.
      handle.store['cache'].delete(SESSION_KEY)
      handle.store['ordinals'].clear()
      handle.store['sessionKeyById'].clear()
      const reloaded = await handle.store.getOrLoad(SESSION_KEY)
      const turn = reloaded!.turns[reloaded!.turns.length - 1]
      expect(turn.input_tokens).toBe(130)
      expect(turn.output_tokens).toBe(50)
      expect(turn.cache_read_tokens).toBe(10)
      expect(turn.cache_write_tokens).toBe(0)
    } finally {
      await handle.shutdown()
    }
  })

  it('cacheTokensReported survives cold-load for an Anthropic session with zero cache (migration 006)', async () => {
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      // Anthropic reports cache fields even on a miss: defined 0/0. With
      // prompt-cache disabled, lifetime cache totals stay 0 — but the model DID
      // report cache, so the breakdown must stay 4-figure after a restart.
      manager.recordSessionUsage(conv, {
        input_tokens: 50,
        output_tokens: 20,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      })
      expect(conv.cacheTokensReported).toBe(true)

      await handle.persistQueue.drainSessionKey(SESSION_KEY)
      handle.store['cache'].delete(SESSION_KEY)
      handle.store['ordinals'].clear()
      handle.store['sessionKeyById'].clear()
      const reloaded = await handle.store.getOrLoad(SESSION_KEY)
      // Pre-006 this derived false from cache_*_tokens === 0; now it's durable.
      expect(reloaded?.cacheTokensReported).toBe(true)
    } finally {
      await handle.shutdown()
    }
  })

  it('cacheTokensReported is false when no cache tokens were ever recorded (OpenAI-style)', async () => {
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      manager.recordSessionUsage(conv, { input_tokens: 30, output_tokens: 10 })
      expect(conv.cacheTokensReported).toBeUndefined()

      await handle.persistQueue.drainSessionKey(SESSION_KEY)
      handle.store['cache'].delete(SESSION_KEY)
      handle.store['ordinals'].clear()
      handle.store['sessionKeyById'].clear()
      const reloaded = await handle.store.getOrLoad(SESSION_KEY)
      // derived from cache columns being 0 → false
      expect(reloaded?.cacheTokensReported).toBe(false)
      expect(reloaded?.input_tokens).toBe(30)
    } finally {
      await handle.shutdown()
    }
  })
})

describe('SqliteConversationStore — session summary listing', () => {
  it('pages summaries from durable rows without hydrating full transcripts', async () => {
    const handle = await freshStore({ cacheSize: 8 })
    try {
      const manager = new ConversationManager(handle.store)
      const sessions = [
        { key: 'u-1:rpc:agent-x:chat-1', timestamp: 100 },
        { key: 'u-1:rpc:agent-x:chat-2', timestamp: 200 },
        { key: 'u-1:rpc:agent-y:chat-3', timestamp: 300, awaitingApproval: true },
        // Invalid legacy key: it must be removed before LIMIT so it cannot
        // consume the pagination probe row and end the catalog early.
        { key: 'u-1:rpc:malformed', timestamp: 400 },
      ]

      for (const session of sessions) {
        const conv = await manager.getOrCreate(session.key)
        await manager.startTurn(conv, `hello ${session.key}`, `task-${session.timestamp}`)
        if (session.awaitingApproval) {
          await manager.suspendForApproval(conv, {
            request_id: 'req-chat-3',
            tool_name: 'shell_exec',
            tool_call_id: 'tc-chat-3',
            parameters: {},
            description: 'approve test',
            context_snapshot: [],
          })
        } else {
          manager.recordSessionUsage(conv, {
            input_tokens: session.timestamp,
            output_tokens: session.timestamp / 2,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
          })
          await manager.completeTurn(conv, `done ${session.key}`)
        }
        await handle.persistQueue.drainSessionKey(session.key)
        handle.worker.db
          .prepare('UPDATE sessions SET started_at = ?, last_activity_at = ? WHERE id = ?')
          .run(session.timestamp - 1, session.timestamp, conv.id)
        handle.worker.db
          .prepare('UPDATE messages SET timestamp = ? WHERE session_id = ?')
          .run(session.timestamp, conv.id)
      }

      handle.store['cache'].clear()
      handle.store['ordinals'].clear()
      handle.store['sessionKeyById'].clear()

      handle.worker.db
        .prepare(
          `INSERT INTO sessions (id, session_key, source, user_id, started_at, last_activity_at)
           VALUES (?, ?, 'rpc', ?, ?, ?)`
        )
        .run('degenerate-newest', 'u-1:rpc::bad', 'u-1', 399, 400)
      handle.worker.db
        .prepare(
          `INSERT INTO sessions (id, session_key, source, user_id, started_at, last_activity_at)
           VALUES (?, ?, 'rpc', ?, ?, ?)`
        )
        .run('degenerate-empty-chat', 'u-1:rpc:agent-x:', 'u-1', 398, 399)
      handle.worker.db
        .prepare(
          `INSERT INTO sessions (id, session_key, source, user_id, started_at, last_activity_at)
           VALUES (?, ?, 'rpc', ?, ?, NULL)`
        )
        .run('legacy-null-activity', 'u-1:rpc:agent-z:legacy-null', 'u-1', 50)

      const firstPage = await handle.store.listSessionSummariesByPrefix('u-1:rpc:', { limit: 2 })
      expect(firstPage.map(session => session.chatId)).toEqual(['chat-3', 'chat-2'])
      expect(firstPage[0]).toMatchObject({
        agent: 'agent-y',
        state: ConversationState.AwaitingApproval,
        activeTaskId: 'task-300',
        pendingApproval: {
          request_id: 'req-chat-3',
          tool_name: 'shell_exec',
        },
        turnCount: 1,
        messageCount: 1,
      })
      expect(firstPage[1]).toMatchObject({
        agent: 'agent-x',
        state: ConversationState.Idle,
        turnCount: 1,
        messageCount: 2,
        input_tokens: 200,
        output_tokens: 100,
        cacheTokensReported: true,
      })
      expect(handle.store['cache'].size()).toBe(0)

      const agentPage = await handle.store.listSessionSummariesByPrefix('u-1:rpc:agent-x:', {
        agent: 'agent-x',
        limit: 2,
      })
      expect(agentPage.map(session => [session.agent, session.chatId])).toEqual([
        ['agent-x', 'chat-2'],
        ['agent-x', 'chat-1'],
      ])

      const colonKey = 'u-1:rpc:agent-x:chat:with:colons'
      const colonConversation = await manager.getOrCreate(colonKey)
      await manager.startTurn(colonConversation, 'colon chat', 'task-colon')
      await manager.completeTurn(colonConversation, 'done')
      handle.store['cache'].clear()
      handle.store['ordinals'].clear()
      handle.store['sessionKeyById'].clear()
      const colonPage = await handle.store.listSessionSummariesByPrefix('u-1:rpc:agent-x:', {
        agent: 'agent-x',
        limit: 10,
      })
      expect(colonPage.find(session => session.key === colonKey)).toMatchObject({
        agent: 'agent-x',
        chatId: 'chat:with:colons',
      })

      const rpcAgentKey = 'u-1:rpc:rpc:chat-rpc'
      const rpcAgentConversation = await manager.getOrCreate(rpcAgentKey)
      await manager.startTurn(rpcAgentConversation, 'rpc agent chat', 'task-rpc-agent')
      await manager.completeTurn(rpcAgentConversation, 'done')
      handle.store['cache'].clear()
      handle.store['ordinals'].clear()
      handle.store['sessionKeyById'].clear()
      const rpcAgentPage = await handle.store.listSessionSummariesByPrefix('u-1:rpc:rpc:', {
        agent: 'rpc',
        limit: 10,
      })
      expect(rpcAgentPage.find(session => session.key === rpcAgentKey)).toMatchObject({
        agent: 'rpc',
        chatId: 'chat-rpc',
      })

      const secondPage = await handle.store.listSessionSummariesByPrefix('u-1:rpc:', {
        limit: 2,
        cursor: {
          updatedAt: firstPage[1]!.lastActivityAt,
          key: firstPage[1]!.key,
        },
      })
      expect(secondPage.map(session => session.chatId)).toEqual(['chat-1', 'legacy-null'])
      expect(handle.store['cache'].size()).toBe(0)
    } finally {
      await handle.shutdown()
    }
  })

  it('keeps unscoped parsing stable when the user subject contains :rpc:', async () => {
    const handle = await freshStore({ cacheSize: 4 })
    try {
      const manager = new ConversationManager(handle.store)
      const userId = 'subject:rpc:embedded'
      const key = `${userId}:rpc:agent-x:chat-1`
      // Catalog visibility remains keyed by the authenticated prefix even when
      // an older persistence path derived user_id differently.
      const conversation = await manager.getOrCreate(key)
      await manager.startTurn(conversation, 'hello', 'task-1')
      await manager.completeTurn(conversation, 'done')
      await handle.persistQueue.drainSessionKey(key)
      handle.store['cache'].clear()

      const summaries = await handle.store.listSessionSummariesByPrefix(`${userId}:rpc:`)

      expect(summaries.map(session => [session.agent, session.chatId])).toEqual([
        ['agent-x', 'chat-1'],
      ])

      handle.worker.db.prepare('UPDATE sessions SET user_id = NULL WHERE id = ?').run(
        conversation.id
      )
      const legacySummaries = await handle.store.listSessionSummariesByPrefix(`${userId}:rpc:`)
      expect(legacySummaries.map(session => [session.agent, session.chatId])).toEqual([
        ['agent-x', 'chat-1'],
      ])
    } finally {
      await handle.shutdown()
    }
  })

  it('preserves a trailing colon in a chat id under an unscoped prefix', async () => {
    const handle = await freshStore({ cacheSize: 4 })
    try {
      const manager = new ConversationManager(handle.store)
      const key = 'u-1:rpc:agent-x:chat-trailing:'
      const conversation = await manager.getOrCreate(key)
      await manager.startTurn(conversation, 'hello', 'task-1')
      await manager.completeTurn(conversation, 'done')
      await handle.persistQueue.drainSessionKey(key)
      handle.store['cache'].clear()

      const summaries = await handle.store.listSessionSummariesByPrefix('u-1:rpc:')

      expect(summaries.map(session => [session.agent, session.chatId])).toEqual([
        ['agent-x', 'chat-trailing:'],
      ])
    } finally {
      await handle.shutdown()
    }
  })

  it('fails closed instead of treating unsafe limits as unbounded reads', async () => {
    const handle = await freshStore({ cacheSize: 4 })
    try {
      const manager = new ConversationManager(handle.store)
      const conversation = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conversation, 'hello', 'task-1')
      await manager.completeTurn(conversation, 'done')
      await handle.persistQueue.drainSessionKey(SESSION_KEY)
      handle.store['cache'].clear()

      await expect(
        handle.store.listSessionSummariesByPrefix('u-1:rpc:', { limit: -1 })
      ).resolves.toEqual([])
      await expect(
        handle.store.getSessionMessagesByKey(SESSION_KEY, 'u-1:rpc:', { limit: -1 })
      ).resolves.toMatchObject({ turns: [] })
    } finally {
      await handle.shutdown()
    }
  })

  it('loads a bounded message page without hydrating the full conversation cache', async () => {
    const handle = await freshStore({ cacheSize: 4 })
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      for (let turn = 1; turn <= 5; turn += 1) {
        await manager.startTurn(conv, `user ${turn}`, `task-${turn}`)
        await manager.completeTurn(conv, `assistant ${turn}`)
      }
      await handle.persistQueue.drainSessionKey(SESSION_KEY)
      handle.store['cache'].clear()
      handle.store['ordinals'].clear()
      handle.store['sessionKeyById'].clear()

      const page = await handle.store.getSessionMessagesByKey(SESSION_KEY, 'u-1:rpc:', {
        limit: 2,
        beforeTurn: 5,
      })

      expect(page?.totalTurns).toBe(5)
      expect(page?.firstTurnNumber).toBe(1)
      expect(page?.lastTurnNumber).toBe(5)
      expect(page?.turns.map(turn => turn.number)).toEqual([3, 4])
      expect(page?.turns.map(turn => turn.user_input)).toEqual(['user 3', 'user 4'])
      expect(page?.turns.map(turn => turn.response)).toEqual(['assistant 3', 'assistant 4'])
      expect(handle.store['cache'].size()).toBe(0)
    } finally {
      await handle.shutdown()
    }
  })

  it('does not expose legacy NULL turn rows as synthetic turn zero on cold reads', async () => {
    const handle = await freshStore({ cacheSize: 4 })
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      for (let turn = 1; turn <= 3; turn += 1) {
        await manager.startTurn(conv, `user ${turn}`, `task-${turn}`)
        await manager.completeTurn(conv, `assistant ${turn}`)
      }
      await handle.persistQueue.drainSessionKey(SESSION_KEY)
      handle.worker.db
        .prepare(
          `INSERT INTO messages (session_id, ordinal, role, content, timestamp, turn_number)
           VALUES (?, ?, 'user', 'legacy turnless row', ?, NULL)`
        )
        .run(conv.id, 99, 99)
      handle.worker.db
        .prepare(
          `UPDATE sessions
              SET last_activity_at = COALESCE(
                    (SELECT MAX(timestamp) FROM messages WHERE session_id = ?),
                    started_at
                  ),
                  turn_count = (
                    SELECT COUNT(DISTINCT turn_number)
                      FROM messages
                     WHERE session_id = ?
                       AND turn_number IS NOT NULL
                  )
            WHERE id = ?`
        )
        .run(conv.id, conv.id, conv.id)
      handle.store['cache'].clear()
      handle.store['ordinals'].clear()
      handle.store['sessionKeyById'].clear()

      const messages = await handle.store.getSessionMessagesByKey(SESSION_KEY, 'u-1:rpc:', {
        limit: 10,
      })

      expect(messages?.totalTurns).toBe(3)
      expect(messages?.firstTurnNumber).toBe(1)
      expect(messages?.lastTurnNumber).toBe(3)
      expect(messages?.turns.map(turn => turn.number)).toEqual([1, 2, 3])
    } finally {
      await handle.shutdown()
    }
  })
})

describe('SqliteConversationStore — cold-start rehydration', () => {
  it('rehydrates an active session with pending_approval', async () => {
    const handle = await freshStore({ cacheSize: 4 })
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conv, 'hi', 'test-task')
      await manager.suspendForApproval(conv, {
        request_id: 'req-cold',
        tool_name: 'shell_exec',
        tool_call_id: 'tc_cold',
        parameters: {},
        description: 'cold-start probe',
        context_snapshot: [],
      })

      // Drop the cache entry to force a load. Pinned entries normally can't
      // be evicted, so call delete() to skip the pin check.
      handle.store['cache'].delete(SESSION_KEY)
      handle.store['ordinals'].clear()
      handle.store['sessionKeyById'].clear()

      const rehydrated = await handle.store.getOrLoad(SESSION_KEY)
      expect(rehydrated).toBeDefined()
      expect(rehydrated!.state).toBe(ConversationState.AwaitingApproval)
      expect(rehydrated!.pending_approval?.request_id).toBe('req-cold')
      expect(rehydrated!.turns).toHaveLength(1)
      expect(rehydrated!.turns[0].user_input).toBe('hi')
    } finally {
      await handle.shutdown()
    }
  })

  it('loadAllPendingApprovals returns every persisted approval', async () => {
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)
      for (let i = 0; i < 3; i++) {
        const key = `u-${i}:rpc:agent:default`
        const conv = await manager.getOrCreate(key)
        await manager.startTurn(conv, `msg ${i}`, 'test-task')
        await manager.suspendForApproval(conv, {
          request_id: `req-${i}`,
          tool_name: 'shell_exec',
          tool_call_id: `tc-${i}`,
          parameters: {},
          description: `test ${i}`,
          context_snapshot: [],
        })
      }

      const listings = await handle.store.loadAllPendingApprovals()
      expect(listings).toHaveLength(3)
      const reqs = listings.map(l => l.approval.request_id).sort()
      expect(reqs).toEqual(['req-0', 'req-1', 'req-2'])
    } finally {
      await handle.shutdown()
    }
  })
})

describe('SqliteConversationStore — LRU eviction with pinning', () => {
  it('Idle sessions can be evicted', async () => {
    const handle = await freshStore({ cacheSize: 2 })
    try {
      const manager = new ConversationManager(handle.store)
      // Three Idle sessions, cache size 2 → first one evicts.
      await manager.getOrCreate('u-1:rpc:a:default')
      await manager.getOrCreate('u-2:rpc:a:default')
      await manager.getOrCreate('u-3:rpc:a:default')
      expect(handle.store.has('u-1:rpc:a:default')).toBe(false)
      expect(handle.store.has('u-2:rpc:a:default')).toBe(true)
      expect(handle.store.has('u-3:rpc:a:default')).toBe(true)
    } finally {
      await handle.shutdown()
    }
  })

  it('Pinned sessions (with pending_approval) cannot be evicted', async () => {
    const handle = await freshStore({ cacheSize: 2 })
    try {
      const manager = new ConversationManager(handle.store)
      const convA = await manager.getOrCreate('u-1:rpc:a:default')
      await manager.startTurn(convA, 'hi', 'test-task')
      await manager.suspendForApproval(convA, {
        request_id: 'pinned',
        tool_name: 'shell_exec',
        tool_call_id: 'tc',
        parameters: {},
        description: 'pinned approval',
        context_snapshot: [],
      })
      // Adding a second Idle session works.
      await manager.getOrCreate('u-2:rpc:a:default')
      // A third one would evict u-2 (Idle, unpinned) — not u-1 (pinned).
      await manager.getOrCreate('u-3:rpc:a:default')
      expect(handle.store.has('u-1:rpc:a:default')).toBe(true)
      expect(handle.store.has('u-2:rpc:a:default')).toBe(false)
      expect(handle.store.has('u-3:rpc:a:default')).toBe(true)
    } finally {
      await handle.shutdown()
    }
  })

  it('throws CacheOverflowError when every slot is pinned', async () => {
    const handle = await freshStore({ cacheSize: 2 })
    try {
      const manager = new ConversationManager(handle.store)
      // Two pinned sessions exhaust the cache.
      for (let i = 0; i < 2; i++) {
        const conv = await manager.getOrCreate(`u-${i}:rpc:a:default`)
        await manager.startTurn(conv, `hi-${i}`, 'test-task')
        await manager.suspendForApproval(conv, {
          request_id: `req-${i}`,
          tool_name: 'shell_exec',
          tool_call_id: `tc-${i}`,
          parameters: {},
          description: '',
          context_snapshot: [],
        })
      }
      // Adding a third should throw — no unpinned slot to evict.
      await expect(manager.getOrCreate('u-2:rpc:a:default')).rejects.toBeInstanceOf(
        CacheOverflowError
      )
    } finally {
      await handle.shutdown()
    }
  })
})

describe('SqliteConversationStore — onEvict hook', () => {
  it('fires when an Idle session is evicted', async () => {
    const handle = await freshStore({ cacheSize: 2 })
    try {
      const evicted: string[] = []
      handle.store.onEvict(key => evicted.push(key))

      const manager = new ConversationManager(handle.store)
      await manager.getOrCreate('a:rpc:x:default')
      await manager.getOrCreate('b:rpc:x:default')
      await manager.getOrCreate('c:rpc:x:default')
      expect(evicted).toEqual(['a:rpc:x:default'])
    } finally {
      await handle.shutdown()
    }
  })
})

describe('SqliteConversationStore — list/prefix', () => {
  it('listByPrefix only reads from the in-memory cache (sync)', async () => {
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)
      await manager.getOrCreate('u-1:rpc:agent:default')
      await manager.getOrCreate('u-1:rpc:other:default')
      await manager.getOrCreate('u-2:rpc:agent:default')
      const result = handle.store.listByPrefix('u-1:')
      expect(result).toHaveLength(2)
    } finally {
      await handle.shutdown()
    }
  })

  it('prefetchUserSessions warms the cache from durable storage', async () => {
    const handle = await freshStore({ cacheSize: 4 })
    try {
      const manager = new ConversationManager(handle.store)
      await manager.getOrCreate('alice:rpc:agent:default')
      await manager.getOrCreate('alice:rpc:other:default')

      // Drop from cache to simulate a cold load.
      handle.store['cache'].delete('alice:rpc:agent:default')
      handle.store['cache'].delete('alice:rpc:other:default')
      expect(handle.store.listByPrefix('alice:').length).toBe(0)

      await handle.store.prefetchUserSessions('alice:')
      expect(handle.store.listByPrefix('alice:').length).toBe(2)
    } finally {
      await handle.shutdown()
    }
  })
})

describe('SqliteConversationStore — B8 spillover_ref round-trip', () => {
  it('persistToolCall writes spillover_ref and the column is populated', async () => {
    // Pre-B8 fix: persistToolCall hard-coded `spillover_ref: null`, so the
    // dedicated index never had any rows. With the fix, the lateral field
    // on TurnToolCall flows through to the persisted row.
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conv, 'do a thing', 'test-task')

      manager.recordToolCall(conv, {
        name: 'shell_exec',
        parameters: { cmd: 'ls' },
        result: '[spilled]',
        spillover_ref: 'clerum://spillover/t-1/tc-1.json',
      })

      // Allow the async enqueue → worker → SQL chain to drain.
      await new Promise(r => setTimeout(r, 50))

      const row = handle.worker.db
        .prepare(
          "SELECT spillover_ref FROM messages WHERE session_id = ? AND role = 'tool' AND tool_name = ?"
        )
        .get(conv.id, 'shell_exec') as { spillover_ref: string | null } | undefined
      expect(row?.spillover_ref).toBe('clerum://spillover/t-1/tc-1.json')
    } finally {
      await handle.shutdown()
    }
  })
})

describe('SqliteConversationStore — active_task_id (D.1)', () => {
  function readActiveTaskId(handle: StoreHandle, convId: string): string | null | undefined {
    const row = handle.worker.db
      .prepare('SELECT active_task_id FROM sessions WHERE id = ?')
      .get(convId) as { active_task_id: string | null } | undefined
    return row?.active_task_id
  }

  it('persistTurnStart mirrors the in-flight taskId to sessions.active_task_id', async () => {
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conv, 'hola', 'task-abc')
      await handle.persistQueue.drainSessionKey(SESSION_KEY)

      expect(conv.activeTaskId).toBe('task-abc') // RAM
      expect(readActiveTaskId(handle, conv.id)).toBe('task-abc') // durable column
    } finally {
      await handle.shutdown()
    }
  })

  it('completeTurn clears active_task_id (atomic with the idle transition)', async () => {
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conv, 'hola', 'task-abc')
      await manager.completeTurn(conv, 'done')
      await handle.persistQueue.drainSessionKey(SESSION_KEY)

      expect(conv.activeTaskId).toBeUndefined()
      const row = handle.worker.db
        .prepare('SELECT state, active_task_id FROM sessions WHERE id = ?')
        .get(conv.id) as { state: string; active_task_id: string | null } | undefined
      expect(row?.state).toBe('idle')
      expect(row?.active_task_id).toBeNull()
    } finally {
      await handle.shutdown()
    }
  })

  it('cancelTurn and failTurn clear active_task_id', async () => {
    for (const variant of ['cancel', 'fail'] as const) {
      const handle = await freshStore()
      try {
        const manager = new ConversationManager(handle.store)
        const conv = await manager.getOrCreate(SESSION_KEY)
        await manager.startTurn(conv, 'hola', 'task-xyz')
        if (variant === 'cancel') manager.cancelTurn(conv)
        else await manager.failTurn(conv)
        await handle.persistQueue.drainSessionKey(SESSION_KEY)

        expect(conv.activeTaskId).toBeUndefined()
        expect(readActiveTaskId(handle, conv.id)).toBeNull()
      } finally {
        await handle.shutdown()
      }
    }
  })

  it('reserves a distinct durable turn number before an async cancel write completes', async () => {
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)

      await manager.startTurn(conv, 'first', 'task-cancelled')
      manager.cancelTurn(conv)
      // Deliberately do not drain or await the fire-and-forget cancel write.
      await manager.startTurn(conv, 'second', 'task-next')
      await manager.completeTurn(conv, 'second response')
      await handle.persistQueue.drainSessionKey(SESSION_KEY)

      const rows = handle.worker.db
        .prepare(
          'SELECT role, content, turn_number FROM messages WHERE session_id = ? ORDER BY ordinal'
        )
        .all(conv.id) as Array<{ role: string; content: string; turn_number: number }>

      expect(rows.map(row => [row.role, row.content, row.turn_number])).toEqual([
        ['user', 'first', 1],
        ['assistant', '[Task cancelled by user before completion]', 1],
        ['user', 'second', 2],
        ['assistant', 'second response', 2],
      ])

      handle.store['cache'].clear()
      const messages = await handle.store.getSessionMessagesByKey(SESSION_KEY, 'u-1:rpc:')
      expect(messages?.turns.map(turn => [turn.number, turn.user_input, turn.response])).toEqual([
        [1, 'first', '[Task cancelled by user before completion]'],
        [2, 'second', 'second response'],
      ])
    } finally {
      await handle.shutdown()
    }
  })

  it('does not reuse a turn number after completion and failure writes both reject', async () => {
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conv, 'first', 'task-complete')

      const enqueueSpy = vi
        .spyOn(handle.persistQueue, 'enqueueSync')
        .mockRejectedValueOnce(new Error('disk unavailable'))
        .mockRejectedValueOnce(new Error('disk still unavailable'))
      await expect(manager.completeTurn(conv, 'failed write')).rejects.toThrow(/disk unavailable/)
      expect(handle.store['ordinals'].get(conv.id)?.nextTurnNumber).toBe(2)
      await expect(manager.failTurn(conv)).rejects.toThrow(/disk still unavailable/)
      expect(handle.store['ordinals'].get(conv.id)?.nextTurnNumber).toBe(2)

      enqueueSpy.mockRestore()
      await manager.startTurn(conv, 'second', 'task-next')
      await manager.completeTurn(conv, 'durable response')
      expect(handle.store['ordinals'].get(conv.id)?.nextTurnNumber).toBe(3)

      const rows = handle.worker.db
        .prepare(
          'SELECT role, content, turn_number FROM messages WHERE session_id = ? ORDER BY ordinal'
        )
        .all(conv.id) as Array<{ role: string; content: string; turn_number: number }>
      expect(rows.map(row => [row.role, row.content, row.turn_number])).toEqual([
        ['user', 'first', 1],
        ['user', 'second', 2],
        ['assistant', 'durable response', 2],
      ])
    } finally {
      await handle.shutdown()
    }
  })

  it('persistTurnFail is an awaited durability barrier: the failed-turn state is durable when it resolves', async () => {
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conv, 'hola', 'task-fail-barrier')

      // Mirror of the completeTurn barrier assertions: await the ACK, then
      // read the durable row DIRECTLY — deliberately NO drainSessionKey.
      // Under the former fire-and-forget enqueueAsync the write could still
      // be sitting in the persist queue at this point.
      await manager.failTurn(conv)

      const row = handle.worker.db
        .prepare('SELECT state, active_task_id FROM sessions WHERE id = ?')
        .get(conv.id) as { state: string; active_task_id: string | null } | undefined
      expect(row?.state).toBe('idle')
      expect(row?.active_task_id).toBeNull()
      expect(conv.activeTaskId).toBeUndefined()
    } finally {
      await handle.shutdown()
    }
  })

  it('advances durable turn numbering after a failed turn', async () => {
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conv, 'first', 'task-1')
      await manager.completeTurn(conv, 'done')
      await manager.startTurn(conv, 'failed', 'task-2')
      await manager.failTurn(conv)
      await manager.startTurn(conv, 'retry', 'task-3')
      await manager.completeTurn(conv, 'recovered')
      await handle.persistQueue.drainSessionKey(SESSION_KEY)

      const turnNumbers = handle.worker.db
        .prepare(
          'SELECT DISTINCT turn_number FROM messages WHERE session_id = ? ORDER BY turn_number'
        )
        .all(conv.id) as Array<{ turn_number: number }>
      expect(turnNumbers.map(row => row.turn_number)).toEqual([1, 2, 3])

      handle.store['cache'].clear()
      const summaries = await handle.store.listSessionSummariesByPrefix('u-1:rpc:')
      expect(summaries[0]?.turnCount).toBe(3)
      const messages = await handle.store.getSessionMessagesByKey(SESSION_KEY, 'u-1:rpc:')
      expect(messages?.totalTurns).toBe(3)
      expect(messages?.turns.map(turn => turn.number)).toEqual([1, 2, 3])
    } finally {
      await handle.shutdown()
    }
  })

  it('suspendForApproval preserves active_task_id (same task across approval)', async () => {
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conv, 'hola', 'task-1')
      await manager.suspendForApproval(conv, {
        request_id: 'req-1',
        tool_name: 'shell_exec',
        tool_call_id: 'tc-1',
        parameters: {},
        description: 'list',
        context_snapshot: [],
      })
      await handle.persistQueue.drainSessionKey(SESSION_KEY)

      expect(conv.activeTaskId).toBe('task-1') // unchanged across suspend
      const row = handle.worker.db
        .prepare('SELECT state, active_task_id FROM sessions WHERE id = ?')
        .get(conv.id) as { state: string; active_task_id: string | null } | undefined
      expect(row?.state).toBe('awaiting_approval')
      expect(row?.active_task_id).toBe('task-1')
    } finally {
      await handle.shutdown()
    }
  })

  it('deny clears active_task_id (terminal → idle); approve preserves it (resume → processing)', async () => {
    // deny → Idle: must clear.
    const denyHandle = await freshStore()
    try {
      const manager = new ConversationManager(denyHandle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conv, 'do X', 'task-deny')
      await manager.suspendForApproval(conv, {
        request_id: 'req-d',
        tool_name: 'shell_exec',
        tool_call_id: 'tc-d',
        parameters: {},
        description: 'x',
        context_snapshot: [],
      })
      await manager.deny(conv)
      await denyHandle.persistQueue.drainSessionKey(SESSION_KEY)

      expect(conv.state).toBe(ConversationState.Idle)
      expect(conv.activeTaskId).toBeUndefined() // RAM cleared
      const row = denyHandle.worker.db
        .prepare('SELECT state, active_task_id FROM sessions WHERE id = ?')
        .get(conv.id) as { state: string; active_task_id: string | null } | undefined
      expect(row?.state).toBe('idle')
      expect(row?.active_task_id).toBeNull() // durable column cleared
    } finally {
      await denyHandle.shutdown()
    }

    // approve → Processing: must preserve (same task resumes).
    const approveHandle = await freshStore()
    try {
      const manager = new ConversationManager(approveHandle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conv, 'do Y', 'task-approve')
      await manager.suspendForApproval(conv, {
        request_id: 'req-a',
        tool_name: 'shell_exec',
        tool_call_id: 'tc-a',
        parameters: {},
        description: 'y',
        context_snapshot: [],
      })
      await manager.approve(conv, false)
      await approveHandle.persistQueue.drainSessionKey(SESSION_KEY)

      expect(conv.state).toBe(ConversationState.Processing)
      expect(conv.activeTaskId).toBe('task-approve') // preserved across resume
      const row = approveHandle.worker.db
        .prepare('SELECT active_task_id FROM sessions WHERE id = ?')
        .get(conv.id) as { active_task_id: string | null } | undefined
      expect(row?.active_task_id).toBe('task-approve')
    } finally {
      await approveHandle.shutdown()
    }
  })

  it('cold-load round-trips active Task.id and exact trace context from explicit columns', async () => {
    const handle = await freshStore({ cacheSize: 4 })
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      const traceContext = {
        version: 1,
        runId: 'run-reload',
        sessionId: null,
        origin: 'api',
        correlationRefs: ['request:req-reload'],
      } satisfies TraceContextV1
      await manager.startTurn(conv, 'hola', 'task-reload', traceContext)
      await manager.suspendForApproval(conv, {
        request_id: 'req-reload',
        tool_name: 'shell_exec',
        tool_call_id: 'tc-reload',
        parameters: {},
        description: 'keep pinned/persisted',
        context_snapshot: [],
      })
      await handle.persistQueue.drainSessionKey(SESSION_KEY)

      const activeRow = handle.worker.db
        .prepare('SELECT active_task_id, active_trace_context FROM sessions WHERE id = ?')
        .get(conv.id) as { active_task_id: string; active_trace_context: string }
      const approvalRow = handle.worker.db
        .prepare('SELECT task_id, trace_context FROM pending_approvals WHERE request_id = ?')
        .get('req-reload') as { task_id: string; trace_context: string }
      expect(activeRow.active_task_id).toBe('task-reload')
      expect(JSON.parse(activeRow.active_trace_context)).toEqual(traceContext)
      expect(approvalRow.task_id).toBe('task-reload')
      expect(JSON.parse(approvalRow.trace_context)).toEqual(traceContext)

      // Drop the cache entry to force a cold load (same pattern as the
      // cold-start rehydration test above).
      handle.store['cache'].delete(SESSION_KEY)
      handle.store['ordinals'].clear()
      handle.store['sessionKeyById'].clear()

      const reloaded = await handle.store.getOrLoad(SESSION_KEY)
      expect(reloaded?.activeTaskId).toBe('task-reload')
      expect(reloaded?.traceContext).toEqual(traceContext)
      expect(reloaded?.pending_approval?.traceContext).toEqual(traceContext)
    } finally {
      await handle.shutdown()
    }
  })
})

describe('SqliteConversationStore — processing reaper (D.2)', () => {
  it('returns [] when no session is in processing', async () => {
    const handle = await freshStore()
    try {
      const reaped = await handle.store.reapProcessingSessions!(Date.now())
      expect(reaped).toEqual([])
    } finally {
      await handle.shutdown()
    }
  })

  it('reaps a processing session: idle + cleared active_task_id + synthetic message', async () => {
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conv, 'long task', 'task-ghost') // processing, never completed
      await handle.persistQueue.drainSessionKey(SESSION_KEY)

      const now = Date.now()
      const reaped = await handle.store.reapProcessingSessions!(now)

      expect(reaped).toHaveLength(1)
      expect(reaped[0]).toMatchObject({
        sessionId: conv.id,
        sessionKey: SESSION_KEY,
        activeTaskId: 'task-ghost',
        reapedAt: now,
      })

      const sess = handle.worker.db
        .prepare('SELECT state, active_task_id FROM sessions WHERE id = ?')
        .get(conv.id) as { state: string; active_task_id: string | null }
      expect(sess.state).toBe('idle')
      expect(sess.active_task_id).toBeNull()

      const lastMsg = handle.worker.db
        .prepare(
          'SELECT role, content, content_parts, is_error, finish_reason, turn_number FROM messages WHERE session_id = ? ORDER BY ordinal DESC LIMIT 1'
        )
        .get(conv.id) as {
        role: string
        content: string
        content_parts: string | null
        is_error: number
        finish_reason: string | null
        turn_number: number | null
      }
      expect(lastMsg.role).toBe('assistant')
      expect(lastMsg.content).toBe('[Task interrupted by server restart]')
      expect(lastMsg.is_error).toBe(1)
      expect(lastMsg.finish_reason).toBe('error')
      expect(lastMsg.turn_number).toBe(1)
      expect(JSON.parse(lastMsg.content_parts!)).toMatchObject({
        kind: 'system_error',
        error_code: 'POD_RESTART_DURING_EXECUTION',
        synthetic: true,
      })
    } finally {
      await handle.shutdown()
    }
  })

  it('does NOT touch idle or awaiting_approval sessions', async () => {
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)

      // idle session
      const idleConv = await manager.getOrCreate('u-1:rpc:agent-x:idle-chat')
      await manager.startTurn(idleConv, 'hi', 'task-i')
      await manager.completeTurn(idleConv, 'done')
      await handle.persistQueue.drainSessionKey('u-1:rpc:agent-x:idle-chat')

      // awaiting_approval session
      const awaitConv = await manager.getOrCreate('u-1:rpc:agent-x:await-chat')
      await manager.startTurn(awaitConv, 'do X', 'task-a')
      await manager.suspendForApproval(awaitConv, {
        request_id: 'req-1',
        tool_name: 'shell_exec',
        tool_call_id: 'tc-1',
        parameters: {},
        description: 'x',
        context_snapshot: [],
      })
      await handle.persistQueue.drainSessionKey('u-1:rpc:agent-x:await-chat')

      const reaped = await handle.store.reapProcessingSessions!(Date.now())
      expect(reaped).toEqual([])

      const states = handle.worker.db
        .prepare('SELECT state FROM sessions ORDER BY session_key')
        .all() as Array<{ state: string }>
      expect(states.map(s => s.state).sort()).toEqual(['awaiting_approval', 'idle'])
    } finally {
      await handle.shutdown()
    }
  })

  it('reaps multiple processing sessions in one call', async () => {
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)
      for (const key of ['u-1:rpc:agent-x:c1', 'u-1:rpc:agent-x:c2', 'u-1:rpc:agent-x:c3']) {
        const conv = await manager.getOrCreate(key)
        await manager.startTurn(conv, 'task', `task-${key}`)
        await handle.persistQueue.drainSessionKey(key)
      }
      const reaped = await handle.store.reapProcessingSessions!(Date.now())
      expect(reaped).toHaveLength(3)
      const remaining = handle.worker.db
        .prepare("SELECT COUNT(*) AS n FROM sessions WHERE state = 'processing'")
        .get() as { n: number }
      expect(remaining.n).toBe(0)
    } finally {
      await handle.shutdown()
    }
  })

  it('a reaped session accepts a new startTurn (no "conversation is processing" error)', async () => {
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conv, 'ghost task', 'task-ghost')
      await handle.persistQueue.drainSessionKey(SESSION_KEY)
      await handle.store.reapProcessingSessions!(Date.now())

      // The reaper DROPS the cached entry (it can't safely reconcile the RAM
      // ordinal counter in place), so the next access cold-loads the reconciled
      // row from SQLite: idle, cleared active_task_id, correct ordinals.
      const reloaded = await manager.getOrCreate(SESSION_KEY)
      expect(reloaded.state).toBe(ConversationState.Idle)
      expect(reloaded.activeTaskId).toBeUndefined()
      await expect(manager.startTurn(reloaded, 'fresh task', 'task-fresh')).resolves.toBeDefined()
      await handle.persistQueue.drainSessionKey(SESSION_KEY)

      // The fresh user message landed (no ordinal collision with the synthetic).
      const userMsgs = handle.worker.db
        .prepare("SELECT content FROM messages WHERE session_id = ? AND role = 'user'")
        .all(reloaded.id) as Array<{ content: string }>
      expect(userMsgs.map(m => m.content)).toContain('fresh task')
    } finally {
      await handle.shutdown()
    }
  })
})

describe('SqliteConversationStore — awaiting-approval reaper (D.8 / F7)', () => {
  // A `now` far enough past any persisted approval TTL that every pending
  // approval created in these tests reads as expired.
  const FAR_FUTURE = Date.now() + 100 * 24 * 60 * 60 * 1000

  const APPROVAL = {
    request_id: 'req-d8',
    tool_name: 'shell_exec',
    tool_call_id: 'tc-d8',
    parameters: {},
    description: 'dangerous',
    context_snapshot: [],
  }

  it('returns [] when no session is awaiting approval', async () => {
    const handle = await freshStore()
    try {
      expect(await handle.store.reapExpiredAwaitingApprovalSessions!(FAR_FUTURE)).toEqual([])
    } finally {
      await handle.shutdown()
    }
  })

  it('reaps an expired awaiting_approval session: idle + deleted approval + synthetic message', async () => {
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conv, 'do X', 'task-await')
      await manager.suspendForApproval(conv, APPROVAL)
      await handle.persistQueue.drainSessionKey(SESSION_KEY)

      const reaped = await handle.store.reapExpiredAwaitingApprovalSessions!(FAR_FUTURE)
      expect(reaped).toHaveLength(1)
      expect(reaped[0]).toMatchObject({
        sessionId: conv.id,
        sessionKey: SESSION_KEY,
        activeTaskId: 'task-await',
        reapedAt: FAR_FUTURE,
      })

      const sess = handle.worker.db
        .prepare('SELECT state, active_task_id FROM sessions WHERE id = ?')
        .get(conv.id) as { state: string; active_task_id: string | null }
      expect(sess.state).toBe('idle')
      expect(sess.active_task_id).toBeNull()

      // The (expired) approval row was resolved atomically with the state flip.
      const approvals = handle.worker.db
        .prepare('SELECT COUNT(*) AS n FROM pending_approvals WHERE session_id = ?')
        .get(conv.id) as { n: number }
      expect(approvals.n).toBe(0)

      const lastMsg = handle.worker.db
        .prepare(
          'SELECT role, content, content_parts, is_error, finish_reason, turn_number FROM messages WHERE session_id = ? ORDER BY ordinal DESC LIMIT 1'
        )
        .get(conv.id) as {
        role: string
        content: string
        content_parts: string | null
        is_error: number
        finish_reason: string | null
        turn_number: number | null
      }
      expect(lastMsg.role).toBe('assistant')
      expect(lastMsg.content).toBe('[Approval expired during server downtime]')
      expect(lastMsg.is_error).toBe(1)
      expect(lastMsg.finish_reason).toBe('error')
      expect(lastMsg.turn_number).toBe(1)
      expect(JSON.parse(lastMsg.content_parts!)).toMatchObject({
        kind: 'system_error',
        error_code: 'APPROVAL_EXPIRED_DURING_DOWNTIME',
        synthetic: true,
      })
    } finally {
      await handle.shutdown()
    }
  })

  it('does NOT touch an awaiting_approval session whose approval is still live', async () => {
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conv, 'do X', 'task-live')
      await manager.suspendForApproval(conv, APPROVAL)
      await handle.persistQueue.drainSessionKey(SESSION_KEY)

      // `now` = real now → the just-created approval's expires_at is in the future.
      const reaped = await handle.store.reapExpiredAwaitingApprovalSessions!(Date.now())
      expect(reaped).toEqual([])

      const sess = handle.worker.db
        .prepare('SELECT state FROM sessions WHERE id = ?')
        .get(conv.id) as { state: string }
      expect(sess.state).toBe('awaiting_approval')
      const approvals = handle.worker.db
        .prepare('SELECT COUNT(*) AS n FROM pending_approvals WHERE session_id = ?')
        .get(conv.id) as { n: number }
      expect(approvals.n).toBe(1)
    } finally {
      await handle.shutdown()
    }
  })

  it('reaps an orphan awaiting_approval session (approval row already gone)', async () => {
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conv, 'do X', 'task-orphan')
      await manager.suspendForApproval(conv, APPROVAL)
      await handle.persistQueue.drainSessionKey(SESSION_KEY)

      // Simulate the C5 runtime case: a periodic sweep deleted the approval row
      // but left the session in 'awaiting_approval'. now=real now (no TTL elapsed)
      // so this only reaps because the row is GONE (the NOT EXISTS orphan path).
      handle.worker.db.prepare('DELETE FROM pending_approvals WHERE session_id = ?').run(conv.id)

      const reaped = await handle.store.reapExpiredAwaitingApprovalSessions!(Date.now())
      expect(reaped).toHaveLength(1)
      const sess = handle.worker.db
        .prepare('SELECT state FROM sessions WHERE id = ?')
        .get(conv.id) as { state: string }
      expect(sess.state).toBe('idle')
    } finally {
      await handle.shutdown()
    }
  })

  it('does NOT touch processing or idle sessions', async () => {
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)
      const idleConv = await manager.getOrCreate('u-1:rpc:agent-x:idle-chat')
      await manager.startTurn(idleConv, 'hi', 'task-i')
      await manager.completeTurn(idleConv, 'done')
      await handle.persistQueue.drainSessionKey('u-1:rpc:agent-x:idle-chat')

      const procConv = await manager.getOrCreate('u-1:rpc:agent-x:proc-chat')
      await manager.startTurn(procConv, 'long', 'task-p')
      await handle.persistQueue.drainSessionKey('u-1:rpc:agent-x:proc-chat')

      const reaped = await handle.store.reapExpiredAwaitingApprovalSessions!(FAR_FUTURE)
      expect(reaped).toEqual([])
      const states = handle.worker.db
        .prepare('SELECT state FROM sessions ORDER BY session_key')
        .all() as Array<{ state: string }>
      expect(states.map(s => s.state).sort()).toEqual(['idle', 'processing'])
    } finally {
      await handle.shutdown()
    }
  })

  it('a reaped session accepts a new startTurn (no "conversation is awaiting" error)', async () => {
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conv, 'do X', 'task-await')
      await manager.suspendForApproval(conv, APPROVAL)
      await handle.persistQueue.drainSessionKey(SESSION_KEY)
      await handle.store.reapExpiredAwaitingApprovalSessions!(FAR_FUTURE)

      const reloaded = await manager.getOrCreate(SESSION_KEY)
      expect(reloaded.state).toBe(ConversationState.Idle)
      expect(reloaded.activeTaskId).toBeUndefined()
      await expect(manager.startTurn(reloaded, 'fresh task', 'task-fresh')).resolves.toBeDefined()
    } finally {
      await handle.shutdown()
    }
  })
})

describe('SqliteConversationStore — reapAwaitingApprovalSessions (S1, reap-all)', () => {
  const APPROVAL = {
    request_id: 'req-s1',
    tool_name: 'shell_exec',
    tool_call_id: 'tc-s1',
    parameters: {},
    description: 'dangerous',
    context_snapshot: [],
  }

  it('reaps a LIVE (non-expired) awaiting_approval session — the exact S1 restart case', async () => {
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conv, 'do X', 'task-live-s1')
      await manager.suspendForApproval(conv, APPROVAL)
      await handle.persistQueue.drainSessionKey(SESSION_KEY)

      // now = real now → the approval's expires_at is in the FUTURE (still live).
      // The expired-only reaper would skip it; reap-all must reap it.
      const reaped = await handle.store.reapAwaitingApprovalSessions!(Date.now())
      expect(reaped).toHaveLength(1)
      expect(reaped[0]).toMatchObject({
        sessionId: conv.id,
        sessionKey: SESSION_KEY,
        activeTaskId: 'task-live-s1',
      })

      const sess = handle.worker.db
        .prepare('SELECT state, active_task_id FROM sessions WHERE id = ?')
        .get(conv.id) as { state: string; active_task_id: string | null }
      expect(sess.state).toBe('idle')
      expect(sess.active_task_id).toBeNull()

      const approvals = handle.worker.db
        .prepare('SELECT COUNT(*) AS n FROM pending_approvals WHERE session_id = ?')
        .get(conv.id) as { n: number }
      expect(approvals.n).toBe(0)

      // The restart case stamps a DISTINCT synthetic message / error_code.
      const lastMsg = handle.worker.db
        .prepare(
          'SELECT role, content, content_parts, is_error, finish_reason FROM messages WHERE session_id = ? ORDER BY ordinal DESC LIMIT 1'
        )
        .get(conv.id) as {
        role: string
        content: string
        content_parts: string | null
        is_error: number
        finish_reason: string | null
      }
      expect(lastMsg.role).toBe('assistant')
      expect(lastMsg.content).toBe('[Approval interrupted by server restart]')
      expect(lastMsg.is_error).toBe(1)
      expect(lastMsg.finish_reason).toBe('error')
      expect(JSON.parse(lastMsg.content_parts!)).toMatchObject({
        kind: 'system_error',
        error_code: 'APPROVAL_INTERRUPTED_BY_RESTART',
        synthetic: true,
      })
    } finally {
      await handle.shutdown()
    }
  })

  it('chunks across more sessions than the chunk size and reaps them all', async () => {
    const handle = await freshStore({ cacheSize: 8 })
    try {
      const manager = new ConversationManager(handle.store)
      const total = 7
      for (let i = 0; i < total; i++) {
        const key = `u-1:rpc:agent-x:chat-s1-${i}`
        const conv = await manager.getOrCreate(key)
        await manager.startTurn(conv, 'do X', `task-s1-${i}`)
        await manager.suspendForApproval(conv, {
          ...APPROVAL,
          request_id: `req-s1-${i}`,
          tool_call_id: `tc-s1-${i}`,
        })
        await handle.persistQueue.drainSessionKey(key)
      }

      const reaped = await handle.store.reapAwaitingApprovalSessions!(Date.now())
      expect(reaped).toHaveLength(total)

      const remaining = handle.worker.db
        .prepare("SELECT COUNT(*) AS n FROM sessions WHERE state = 'awaiting_approval'")
        .get() as { n: number }
      expect(remaining.n).toBe(0)
      const approvals = handle.worker.db
        .prepare('SELECT COUNT(*) AS n FROM pending_approvals')
        .get() as { n: number }
      expect(approvals.n).toBe(0)
    } finally {
      await handle.shutdown()
    }
  })

  it('the expired-only reaper still uses its own message (no cross-contamination)', async () => {
    const handle = await freshStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.startTurn(conv, 'do X', 'task-expired')
      await manager.suspendForApproval(conv, APPROVAL)
      await handle.persistQueue.drainSessionKey(SESSION_KEY)

      const FAR_FUTURE = Date.now() + 100 * 24 * 60 * 60 * 1000
      const reaped = await handle.store.reapExpiredAwaitingApprovalSessions!(FAR_FUTURE)
      expect(reaped).toHaveLength(1)

      const lastMsg = handle.worker.db
        .prepare(
          'SELECT content, content_parts FROM messages WHERE session_id = ? ORDER BY ordinal DESC LIMIT 1'
        )
        .get(conv.id) as { content: string; content_parts: string | null }
      expect(lastMsg.content).toBe('[Approval expired during server downtime]')
      expect(JSON.parse(lastMsg.content_parts!).error_code).toBe('APPROVAL_EXPIRED_DURING_DOWNTIME')
    } finally {
      await handle.shutdown()
    }
  })
})

async function freshStore(opts?: { cacheSize?: number }): Promise<StoreHandle> {
  return makeSqliteStore({ cacheSize: opts?.cacheSize ?? 8 })
}
