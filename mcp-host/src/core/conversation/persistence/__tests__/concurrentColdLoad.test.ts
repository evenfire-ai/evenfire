/**
 * Two callers can miss the cache for one stored session at the same time, for
 * example a turn start and an approval-mode PATCH right after a restart or a
 * wake. Both must receive the one cached conversation, so a mode written
 * through one handle is the mode the other handle runs with. The stores are
 * built the way `createConversationStore` builds them for `sqlite` (what the
 * Host ConfigMap and HCC set) and `dual`.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Conversation } from '../../../types'
import { ConversationManager } from '../../conversation'
import { type ConversationStore, InMemoryConversationStore } from '../../conversationStore'
import { DualConversationStore } from '../dualConversationStore'
import { PersistQueue, type WorkerLike } from '../persistQueue'
import { SqliteConversationStore } from '../sqliteConversationStore'
import { createInProcessWorker } from './testHelpers'

const USER = 'u-1'
const KEY = `${USER}:rpc:host-a:chat-1`
const LIVE = { ceiling: 'allow_all', cap: 'allow_all', channelSwitch: 'allow_all' } as const

type StoreMode = 'sqlite' | 'dual'

function setup(mode: StoreMode) {
  const inner = createInProcessWorker(':memory:')
  // 2 ms per message stands in for a worker thread's round trip, so both
  // loads are queued before either answers.
  const worker: WorkerLike = {
    ...inner.worker,
    postMessage: m => void setTimeout(() => inner.worker.postMessage(m), 2),
  }
  const onFailure = vi.fn()
  const queue = new PersistQueue(worker, {
    syncTimeoutMs: 2000,
    asyncTimeoutMs: 5000,
    stallTimeoutMs: 30_000,
    onFailure,
  })
  // A new store over the same database is a Host after a restart: the row is
  // durable and the cache is empty.
  const buildStore = (): ConversationStore => {
    const sqlite = new SqliteConversationStore(queue, { cacheSize: 8 })
    return mode === 'sqlite'
      ? sqlite
      : new DualConversationStore(new InMemoryConversationStore(), sqlite)
  }
  const storedMode = () =>
    (
      inner.db.prepare('SELECT approval_mode FROM sessions WHERE session_key = ?').get(KEY) as {
        approval_mode: string
      }
    ).approval_mode
  return { queue, onFailure, buildStore, storedMode }
}

const ORDERS = ['route load first', 'turn load first'] as const

describe.each(['sqlite', 'dual'] as const)('concurrent cold loads (%s store)', mode => {
  it.each(ORDERS)('a mode written through one handle reaches the other, %s', async order => {
    const { queue, onFailure, buildStore, storedMode } = setup(mode)
    await new ConversationManager(buildStore()).getOrCreate(KEY, {
      userId: USER,
      channelType: 'rpc',
      approvalMode: 'allow_all',
    })
    await queue.drain()
    expect(storedMode()).toBe('allow_all')

    const store = buildStore()
    const manager = new ConversationManager(store)
    expect(store.get(KEY)).toBeUndefined()

    // The route's session read and the turn's getOrCreateDetailed both miss
    // the empty cache. Array order is call order, which is load order.
    const routeLoad = () => manager.getSessionByKeyForUserAsync(KEY, USER)
    const turnLoad = async () =>
      (await manager.getOrCreateDetailed(KEY, { userId: USER })).conversation
    let route: Conversation | undefined
    let turn: Conversation
    if (order === 'route load first') {
      ;[route, turn] = await Promise.all([routeLoad(), turnLoad()])
    } else {
      ;[turn, route] = await Promise.all([turnLoad(), routeLoad()])
    }

    // Witness: both callers ran a cold load of the stored session.
    expect(route?.approval_mode).toBe('allow_all')
    expect(turn.approval_mode).toBe('allow_all')
    expect(route).toBe(turn)
    expect(store.get(KEY)).toBe(turn)

    // The turn's session already holds an auto-only grant from an earlier
    // effective mode.
    turn.last_effective_approval_mode = 'auto'
    turn.auto_shell_grants = { wholeTool: true, commands: new Set(['ls']) }

    await manager.setApprovalMode(route!, 'manual', LIVE, 'route', USER)

    expect(storedMode()).toBe('manual')
    expect(turn.approval_mode).toBe('manual')
    expect(turn.auto_shell_grants).toEqual({ wholeTool: false, commands: new Set() })
    const later = await manager.getOrCreateDetailed(KEY, { userId: USER })
    expect(later.created).toBe(false)
    expect(later.conversation).toBe(turn)
    expect(later.conversation.approval_mode).toBe('manual')
    expect(store.get(KEY)?.approval_mode).toBe('manual')
    expect(onFailure).not.toHaveBeenCalled()
    await queue.close()
  })
})
