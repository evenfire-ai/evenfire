import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PersistedSession } from '../../../../db/worker/protocol'
import { ConversationManager } from '../../conversation'
import { InMemoryConversationStore } from '../../conversationStore'
import { reconstructConversation } from '../reconstruct'
import { makeSqliteStore } from './testHelpers'

const SESSION_KEY = 'u-1:rpc:agent-x:chat-1'

/** #654 — CAS needs two real writers over ONE database file. */
const tempDirs: string[] = []
function makeSharedDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'model-selection-cas-'))
  tempDirs.push(dir)
  return join(dir, 'state.db')
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function revisionOf(handle: ReturnType<typeof makeSqliteStore>, sessionId: string): number {
  const row = handle.worker.db
    .prepare('SELECT model_selection_revision AS revision FROM sessions WHERE id = ?')
    .get(sessionId) as { revision: number } | undefined
  return row?.revision ?? -1
}

function selectionsOf(
  handle: ReturnType<typeof makeSqliteStore>,
  sessionId: string
): Record<string, string> {
  const row = handle.worker.db
    .prepare('SELECT model_selections AS ms FROM sessions WHERE id = ?')
    .get(sessionId) as { ms: string | null } | undefined
  return row?.ms ? (JSON.parse(row.ms) as Record<string, string>) : {}
}

describe('R2 — model_selections persistence', () => {
  it('setModelSelection writes the map and rehydrates on cold-load', async () => {
    const handle = makeSqliteStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.setModelSelection(conv, 'claude', 'claude-haiku-4-5')
      expect(conv.modelSelections).toEqual({ claude: 'claude-haiku-4-5' })

      await handle.persistQueue.drainSessionKey(SESSION_KEY)

      const row = handle.worker.db
        .prepare('SELECT model_selections AS ms FROM sessions WHERE id = ?')
        .get(conv.id) as { ms: string }
      expect(JSON.parse(row.ms)).toEqual({ claude: 'claude-haiku-4-5' })

      // Cold-load: drop from cache, reload from SQLite.
      handle.store['cache'].delete(SESSION_KEY)
      handle.store['ordinals'].clear()
      handle.store['sessionKeyById'].clear()
      const reloaded = await handle.store.getOrLoad(SESSION_KEY)
      expect(reloaded?.modelSelections).toEqual({ claude: 'claude-haiku-4-5' })
    } finally {
      await handle.shutdown()
    }
  })

  it('a second setModelSelection overwrites the provider entry (upsert)', async () => {
    const handle = makeSqliteStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.setModelSelection(conv, 'claude', 'claude-haiku-4-5')
      await manager.setModelSelection(conv, 'claude', 'claude-opus-4-8')
      await handle.persistQueue.drainSessionKey(SESSION_KEY)

      const row = handle.worker.db
        .prepare('SELECT model_selections AS ms FROM sessions WHERE id = ?')
        .get(conv.id) as { ms: string }
      expect(JSON.parse(row.ms)).toEqual({ claude: 'claude-opus-4-8' })
    } finally {
      await handle.shutdown()
    }
  })
})

/**
 * #654 §4.4 — the durable CAS. These drive the REAL dispatcher over a real
 * SQLite database (no stubbed statements, no mocked worker), because the
 * property under test is exactly "what is on disk after both writers ran".
 */
describe('#654 — model selection CAS (durable revision)', () => {
  it('arbitrates simultaneous memory-mode writes before the manager await yields', async () => {
    const manager = new ConversationManager(new InMemoryConversationStore())
    const conv = await manager.getOrCreate(SESSION_KEY)
    const [first, second] = await Promise.all([
      manager.setModelSelection(conv, 'claude', 'claude-opus-4-8', 0),
      manager.setModelSelection(conv, 'claude', 'claude-haiku-4-5', 0),
    ])
    expect(first.applied).toBe(true)
    expect(second.applied).toBe(false)
    expect(conv.modelSelections).toEqual({ claude: 'claude-opus-4-8' })
    expect(conv.modelSelectionRevision).toBe(1)
  })
  it('legacy writes without expectedRevision still increment the revision', async () => {
    const handle = makeSqliteStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      expect(conv.modelSelectionRevision).toBe(0)

      const first = await manager.setModelSelection(conv, 'claude', 'claude-haiku-4-5')
      expect(first).toEqual({
        modelSelections: expect.any(Object),
        applied: true,
        modelSelectionRevision: 1,
      })

      const second = await manager.setModelSelection(conv, 'claude', 'claude-opus-4-8')
      expect(second).toEqual({
        modelSelections: expect.any(Object),
        applied: true,
        modelSelectionRevision: 2,
      })

      expect(revisionOf(handle, conv.id)).toBe(2)
      expect(selectionsOf(handle, conv.id)).toEqual({ claude: 'claude-opus-4-8' })
      expect(conv.modelSelectionRevision).toBe(2)
    } finally {
      await handle.shutdown()
    }
  })

  it('applies a write whose expectedRevision still matches and rehydrates it cold', async () => {
    const handle = makeSqliteStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)

      const outcome = await manager.setModelSelection(conv, 'claude', 'claude-haiku-4-5', 0)
      expect(outcome).toEqual({
        modelSelections: expect.any(Object),
        applied: true,
        modelSelectionRevision: 1,
      })
      expect(revisionOf(handle, conv.id)).toBe(1)

      handle.store['cache'].delete(SESSION_KEY)
      handle.store['ordinals'].clear()
      handle.store['sessionKeyById'].clear()
      const reloaded = await handle.store.getOrLoad(SESSION_KEY)
      expect(reloaded?.modelSelectionRevision).toBe(1)
      expect(reloaded?.modelSelections).toEqual({ claude: 'claude-haiku-4-5' })
    } finally {
      await handle.shutdown()
    }
  })

  it('rejects a stale write and leaves the winner on disk and in RAM', async () => {
    const handle = makeSqliteStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      await manager.setModelSelection(conv, 'claude', 'claude-opus-4-8', 0)

      // A straggler armed against revision 0 (the value it read before the
      // winner landed) must not overwrite revision 1.
      const stale = await manager.setModelSelection(conv, 'claude', 'claude-haiku-4-5', 0)
      expect(stale).toEqual({
        modelSelections: expect.any(Object),
        applied: false,
        reason: 'model_selection_conflict',
        modelSelectionRevision: 1,
      })

      // Disk keeps the winner; RAM never adopted the rejected value and its
      // revision was realigned to the durable one so the retry can succeed.
      expect(revisionOf(handle, conv.id)).toBe(1)
      expect(selectionsOf(handle, conv.id)).toEqual({ claude: 'claude-opus-4-8' })
      expect(conv.modelSelections).toEqual({ claude: 'claude-opus-4-8' })
      expect(conv.modelSelectionRevision).toBe(1)

      // The retry, armed with the revision that won, is accepted.
      const retry = await manager.setModelSelection(conv, 'claude', 'claude-haiku-4-5', 1)
      expect(retry).toEqual({
        modelSelections: expect.any(Object),
        applied: true,
        modelSelectionRevision: 2,
      })
      expect(selectionsOf(handle, conv.id)).toEqual({ claude: 'claude-haiku-4-5' })
    } finally {
      await handle.shutdown()
    }
  })

  it('orders two replicas on one database: the older write is refused, not queued behind', async () => {
    const dbPath = makeSharedDbPath()
    const replicaA = makeSqliteStore({ dbPath })
    const replicaB = makeSqliteStore({ dbPath })
    try {
      const managerA = new ConversationManager(replicaA.store)
      const managerB = new ConversationManager(replicaB.store)

      // Both replicas observe revision 0 (as two devices on one chat would).
      const convA = await managerA.getOrCreate(SESSION_KEY)
      await replicaA.persistQueue.drainSessionKey(SESSION_KEY)
      const convB = await managerB.getSessionByKeyAsync(SESSION_KEY)
      expect(convB).toBeDefined()
      expect(convB!.id).toBe(convA.id)
      expect(convA.modelSelectionRevision).toBe(0)
      expect(convB!.modelSelectionRevision).toBe(0)

      const winner = await managerA.setModelSelection(convA, 'claude', 'claude-opus-4-8', 0)
      expect(winner).toEqual({
        modelSelections: expect.any(Object),
        applied: true,
        modelSelectionRevision: 1,
      })

      // B's write is a straggler even though B sends it AFTER A resolved: its
      // base is stale, which is the whole point of the revision.
      const loser = await managerB.setModelSelection(convB!, 'claude', 'claude-haiku-4-5', 0)
      expect(loser).toEqual({
        modelSelections: expect.any(Object),
        applied: false,
        reason: 'model_selection_conflict',
        modelSelectionRevision: 1,
      })
      expect(convB!.modelSelectionRevision).toBe(1)
      expect(convB!.modelSelections).toEqual({ claude: 'claude-opus-4-8' })
      expect(loser.modelSelections).toEqual({ claude: 'claude-opus-4-8' })

      expect(revisionOf(replicaA, convA.id)).toBe(1)
      expect(selectionsOf(replicaA, convA.id)).toEqual({ claude: 'claude-opus-4-8' })

      // A legacy (no-CAS) write from B still wins and invalidates the CAS base
      // every client is holding.
      const legacy = await managerB.setModelSelection(convB!, 'claude', 'claude-haiku-4-5')
      expect(legacy).toEqual({
        modelSelections: expect.any(Object),
        applied: true,
        modelSelectionRevision: 2,
      })
      const armedWithOldBase = await managerA.setModelSelection(
        convA,
        'claude',
        'claude-opus-4-8',
        1
      )
      expect(armedWithOldBase).toEqual({
        modelSelections: expect.any(Object),
        applied: false,
        reason: 'model_selection_conflict',
        modelSelectionRevision: 2,
      })
      expect(selectionsOf(replicaA, convA.id)).toEqual({ claude: 'claude-haiku-4-5' })
      expect(convA.modelSelections).toEqual({ claude: 'claude-haiku-4-5' })

      // A stale replica's legacy update of another provider must merge the
      // current durable map, not overwrite it with its old RAM snapshot.
      await managerA.setModelSelection(convA, 'openai', 'gpt-5.4')
      await managerB.setModelSelection(convB!, 'claude', 'claude-opus-4-8')
      expect(selectionsOf(replicaA, convA.id)).toEqual({
        claude: 'claude-opus-4-8',
        openai: 'gpt-5.4',
      })
    } finally {
      await replicaA.shutdown()
      await replicaB.shutdown()
    }
  })

  it('refuses to report success when the session has no durable row', async () => {
    const handle = makeSqliteStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      // Drop the durable row behind the store's back: the cache still holds the
      // Conversation, so the caller would otherwise be told the write landed.
      handle.worker.db.prepare('DELETE FROM sessions WHERE id = ?').run(conv.id)

      await expect(
        manager.setModelSelection(conv, 'claude', 'claude-haiku-4-5', 0)
      ).rejects.toThrow(/no session row/)
      expect(conv.modelSelections).toBeUndefined()
      expect(conv.modelSelectionRevision).toBe(0)
    } finally {
      await handle.shutdown()
    }
  })

  // A corrupt map is the one input the CAS cannot merge into: writing the one
  // requested provider would silently drop every other provider the row claimed
  // to hold. The dispatcher refuses instead, so an operator can still read the
  // original bytes and repair them.
  it.each([
    ['malformed JSON', 'not json at all'],
    ['a JSON array', '[1,2]'],
    ['a non-string value', '{"claude":5}'],
  ])(
    'refuses to write over %s in model_selections and leaves the row untouched',
    async (_label, corrupt) => {
      const handle = makeSqliteStore()
      try {
        const manager = new ConversationManager(handle.store)
        const conv = await manager.getOrCreate(SESSION_KEY)
        await manager.setModelSelection(conv, 'claude', 'claude-haiku-4-5')
        await handle.persistQueue.drainSessionKey(SESSION_KEY)
        const revisionBefore = revisionOf(handle, conv.id)

        // Corrupt the durable map behind the store's back, the way a partial
        // write or a hand-edited database would.
        handle.worker.db
          .prepare('UPDATE sessions SET model_selections = ? WHERE id = ?')
          .run(corrupt, conv.id)

        // Witness: only the dispatcher's own parse of the stored row can raise
        // this, so the refusal below is a decision and not an unreached branch.
        await expect(manager.setModelSelection(conv, 'openai', 'gpt-5.4')).rejects.toThrow(
          /Invalid persisted model selections/
        )

        const rawAfter = handle.worker.db
          .prepare('SELECT model_selections AS ms FROM sessions WHERE id = ?')
          .get(conv.id) as { ms: string }
        expect(rawAfter.ms).toBe(corrupt)
        expect(revisionOf(handle, conv.id)).toBe(revisionBefore)
      } finally {
        await handle.shutdown()
      }
    }
  )
})

describe('R2 — reconstruct.parseModelSelections tolerance', () => {
  function persisted(model_selections: string | null): PersistedSession {
    return {
      session: {
        id: 's',
        session_key: SESSION_KEY,
        source: 'rpc',
        user_id: 'u-1',
        team_id: null,
        channel_type: 'rpc',
        channel_id: 'agent-x',
        thread_id: 'chat-1',
        model: null,
        model_selections,
        system_prompt_stable_hash: null,
        parent_session_id: null,
        started_at: 0,
        ended_at: null,
        end_reason: null,
        message_count: 0,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cache_tokens_reported: 0,
        title: null,
        state: 'idle',
        active_task_id: null,
        active_trace_context: null,
      },
      messages: [],
      pending_approval: null,
    }
  }

  it('parses a valid JSON map', () => {
    const { conversation } = reconstructConversation(persisted(JSON.stringify({ claude: 'm' })))
    expect(conversation.modelSelections).toEqual({ claude: 'm' })
  })

  it('NULL → undefined (no selection)', () => {
    expect(reconstructConversation(persisted(null)).conversation.modelSelections).toBeUndefined()
  })

  it('malformed JSON → undefined (never injects a bad value)', () => {
    expect(
      reconstructConversation(persisted('{not json')).conversation.modelSelections
    ).toBeUndefined()
  })

  it('non-string values are dropped', () => {
    const { conversation } = reconstructConversation(
      persisted(JSON.stringify({ claude: 42, openai: 'gpt' }))
    )
    expect(conversation.modelSelections).toEqual({ openai: 'gpt' })
  })
})

describe('reconstructConversation — activity timestamp', () => {
  it('preserves the materialized activity when retained messages are older', () => {
    const persistedSession: PersistedSession = {
      session: {
        id: 'activity-session',
        session_key: SESSION_KEY,
        source: 'rpc',
        user_id: 'u-1',
        team_id: null,
        channel_type: 'rpc',
        channel_id: 'agent-x',
        thread_id: 'chat-1',
        model: null,
        model_selections: null,
        system_prompt_stable_hash: null,
        parent_session_id: null,
        started_at: 100,
        last_activity_at: 200,
        ended_at: null,
        end_reason: null,
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cache_tokens_reported: 0,
        title: null,
        state: 'idle',
        active_task_id: null,
        active_trace_context: null,
      },
      messages: [
        {
          session_id: 'activity-session',
          ordinal: 0,
          role: 'user',
          content: 'retained',
          content_parts: null,
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          timestamp: 150,
          token_count: null,
          finish_reason: null,
          spillover_ref: null,
          is_error: 0,
          turn_number: 1,
        },
      ],
      pending_approval: null,
    }

    expect(reconstructConversation(persistedSession).conversation.updated_at).toEqual(
      new Date(200_000)
    )
  })
})
