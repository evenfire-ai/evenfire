import { describe, expect, it } from 'vitest'
import type { PersistedSession } from '../../../../db/worker/protocol'
import { ConversationManager } from '../../conversation'
import { reconstructConversation } from '../reconstruct'
import { makeSqliteStore } from './testHelpers'

const SESSION_KEY = 'u-1:rpc:agent-x:chat-1'

describe('R2 — model_selections persistence', () => {
  it('setModelSelection writes the map and rehydrates on cold-load', async () => {
    const handle = makeSqliteStore()
    try {
      const manager = new ConversationManager(handle.store)
      const conv = await manager.getOrCreate(SESSION_KEY)
      manager.setModelSelection(conv, 'claude', 'claude-haiku-4-5')
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
      manager.setModelSelection(conv, 'claude', 'claude-haiku-4-5')
      manager.setModelSelection(conv, 'claude', 'claude-opus-4-8')
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
