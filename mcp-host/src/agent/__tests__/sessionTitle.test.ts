import { describe, expect, it, vi } from 'vitest'
import { ConversationManager } from '../../core/conversation/conversation'
import { InMemoryConversationStore } from '../../core/conversation/conversationStore'
import { makeSqliteStore } from '../../core/conversation/persistence/__tests__/testHelpers'
import { serializeSessionKey } from '../../session'
import { applySessionTitle } from '../sessionTitle'

const USER = 'u-1'
const AGENT = 'agent-x'
const CHAT = 'chat-1'

function rpcKey(user = USER, agent = AGENT, chat = CHAT): string {
  return serializeSessionKey({
    userId: user,
    channelType: 'rpc',
    channelId: agent,
    threadId: chat,
  })
}

async function seedRpcSession(manager: ConversationManager, user = USER): Promise<void> {
  await manager.getOrCreate(rpcKey(user), {
    userId: user,
    channelType: 'rpc',
    channelId: AGENT,
    threadId: CHAT,
    source: 'rpc',
  })
}

describe('applySessionTitle — validation + sanitization (spec 15 §5)', () => {
  it('renames an existing owned session and sets the sanitized title in RAM', async () => {
    const manager = new ConversationManager(new InMemoryConversationStore())
    await seedRpcSession(manager)

    const res = await applySessionTitle(
      { convManager: manager },
      USER,
      AGENT,
      CHAT,
      '  Quarterly   plan  '
    )
    expect(res).toEqual({ ok: true, title: 'Quarterly plan' })
    const conv = await manager.getSessionByKeyForUserAsync(rpcKey(), USER)
    expect(conv?.title).toBe('Quarterly plan')
  })

  it('strips bidi/zero-width from the rename (shared sanitizer, D4)', async () => {
    const manager = new ConversationManager(new InMemoryConversationStore())
    await seedRpcSession(manager)

    const res = await applySessionTitle({ convManager: manager }, USER, AGENT, CHAT, 'ab‮cd​e')
    expect(res.ok).toBe(true)
    if (res.ok) expect(/\p{C}/u.test(res.title)).toBe(false)
  })

  it('rejects an empty-after-sanitize title (400/invalid_title)', async () => {
    const manager = new ConversationManager(new InMemoryConversationStore())
    await seedRpcSession(manager)

    for (const raw of ['', '   ', '​‌', '\n\t']) {
      const res = await applySessionTitle({ convManager: manager }, USER, AGENT, CHAT, raw)
      expect(res).toEqual({ ok: false, reason: 'invalid_title' })
    }
  })

  it('rejects a title over the 120 code-point cap', async () => {
    const manager = new ConversationManager(new InMemoryConversationStore())
    await seedRpcSession(manager)

    const res = await applySessionTitle(
      { convManager: manager },
      USER,
      AGENT,
      CHAT,
      'x'.repeat(121)
    )
    expect(res).toEqual({ ok: false, reason: 'invalid_title' })
    // Exactly 120 is allowed.
    const ok = await applySessionTitle({ convManager: manager }, USER, AGENT, CHAT, 'y'.repeat(120))
    expect(ok.ok).toBe(true)
  })

  it('accepts 120 astral (4-byte) code points; the byte cap is a backstop the cp cap makes unreachable', async () => {
    const manager = new ConversationManager(new InMemoryConversationStore())
    await seedRpcSession(manager)
    // 120 astral code points = 480 UTF-8 bytes, within both caps. Since 120 cp
    // can be at most 480 bytes (< 512), the 512-byte cap can never bind before
    // the code-point cap — it is a defensive backstop, not a reachable branch.
    const title = '𝕏'.repeat(120)
    const within = await applySessionTitle({ convManager: manager }, USER, AGENT, CHAT, title)
    expect(within.ok).toBe(true)
    if (within.ok) expect(Buffer.byteLength(within.title, 'utf8')).toBe(480)
  })
})

describe('applySessionTitle — ownership + anti-enumeration (uniform 404)', () => {
  it('returns not_found for a session owned by another user (no oracle)', async () => {
    const manager = new ConversationManager(new InMemoryConversationStore())
    await seedRpcSession(manager, USER)

    const res = await applySessionTitle({ convManager: manager }, 'u-2', AGENT, CHAT, 'Hijack')
    expect(res).toEqual({ ok: false, reason: 'not_found' })
    // Original owner's title untouched.
    const conv = await manager.getSessionByKeyForUserAsync(rpcKey(USER), USER)
    expect(conv?.title).toBeUndefined()
  })

  it('returns the SAME not_found for a session that does not exist', async () => {
    const manager = new ConversationManager(new InMemoryConversationStore())
    const res = await applySessionTitle({ convManager: manager }, USER, AGENT, 'ghost', 'X')
    expect(res).toEqual({ ok: false, reason: 'not_found' })
  })

  it('does not create a row (no getOrCreate) on a missing session', async () => {
    const manager = new ConversationManager(new InMemoryConversationStore())
    await applySessionTitle({ convManager: manager }, USER, AGENT, 'ghost', 'X')
    expect(
      await manager.getSessionByKeyForUserAsync(rpcKey(USER, AGENT, 'ghost'), USER)
    ).toBeUndefined()
  })

  it('does not rename a channel session (not renamable by this route)', async () => {
    const manager = new ConversationManager(new InMemoryConversationStore())
    // A telegram session keyed under channelType 'telegram' — the rpc-shaped key
    // this route builds can never resolve it.
    const chanKey = serializeSessionKey({
      userId: USER,
      channelType: 'telegram',
      channelId: 'tg-chan',
      threadId: CHAT,
    })
    const chan = await manager.getOrCreate(chanKey, {
      userId: USER,
      channelType: 'telegram',
      channelId: 'tg-chan',
      threadId: CHAT,
      source: 'telegram',
    })

    const res = await applySessionTitle(
      { convManager: manager },
      USER,
      'tg-chan',
      CHAT,
      'Rename me'
    )
    expect(res).toEqual({ ok: false, reason: 'not_found' })
    expect(chan.title).toBeUndefined()
  })
})

describe('applySessionTitle — no-op when unchanged (§5, shared persistQueue)', () => {
  it('does not re-persist when the incoming title equals the current one', async () => {
    const manager = new ConversationManager(new InMemoryConversationStore())
    await seedRpcSession(manager)
    await applySessionTitle({ convManager: manager }, USER, AGENT, CHAT, 'Stable Name')

    const setTitle = vi.spyOn(manager, 'setTitle')
    const res = await applySessionTitle(
      { convManager: manager },
      USER,
      AGENT,
      CHAT,
      '  Stable   Name '
    )
    expect(res).toEqual({ ok: true, title: 'Stable Name' })
    expect(setTitle).not.toHaveBeenCalled()
  })
})

describe('applySessionTitle — durable persistence (SQLite, real producer T1)', () => {
  it('overwrites sessions.title and rehydrates on cold-load', async () => {
    const handle = makeSqliteStore()
    try {
      const manager = new ConversationManager(handle.store)
      // Seed with a turn-1 auto-title, then rename overwrites it (unlike COALESCE).
      const conv = await manager.getOrCreate(rpcKey(), {
        userId: USER,
        channelType: 'rpc',
        channelId: AGENT,
        threadId: CHAT,
        source: 'rpc',
      })
      await manager.startTurn(conv, 'first message', 'task-1', null, 'Auto Title')
      await manager.completeTurn(conv, 'ok')

      const res = await applySessionTitle(
        { convManager: manager },
        USER,
        AGENT,
        CHAT,
        'User Renamed'
      )
      expect(res).toEqual({ ok: true, title: 'User Renamed' })
      await handle.persistQueue.drainSessionKey(rpcKey())

      const row = handle.worker.db
        .prepare('SELECT title FROM sessions WHERE id = ?')
        .get(conv.id) as { title: string }
      expect(row.title).toBe('User Renamed')

      // Cold-load rehydrates the renamed title.
      handle.store['cache'].delete(rpcKey())
      handle.store['ordinals'].clear()
      handle.store['sessionKeyById'].clear()
      const reloaded = await handle.store.getOrLoad(rpcKey())
      expect(reloaded?.title).toBe('User Renamed')
    } finally {
      await handle.shutdown()
    }
  })
})
