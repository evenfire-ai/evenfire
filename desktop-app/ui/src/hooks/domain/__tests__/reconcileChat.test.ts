import { describe, expect, it, vi } from 'vitest'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext'
import type { SessionMessagesResult } from '../../../../../src/types'
import { type ReconcileChatDeps, createReconcileChat } from '../reconcileChat'
import { createSessionFsmStore } from '../sessionFsm'

const AGENT = 'agent-a'
const CHAT = 'chat-1'
const chatKey = makeTaskKey(AGENT, CHAT)

function idleResp(overrides: Partial<SessionMessagesResult> = {}): SessionMessagesResult {
  return { agent: AGENT, chatId: CHAT, state: 'idle', turns: [], ...overrides }
}

function liveResp(overrides: Partial<SessionMessagesResult> = {}): SessionMessagesResult {
  return {
    agent: AGENT,
    chatId: CHAT,
    state: 'processing',
    activeTaskId: 'task-9',
    turns: [],
    ...overrides,
  }
}

class NetErr extends Error {}
class NotFound extends Error {}

function buildDeps(overrides: Partial<ReconcileChatDeps> = {}): ReconcileChatDeps {
  const fsm = createSessionFsmStore()
  return {
    fsm,
    loadSessionMessages: vi.fn(async () => idleResp()),
    // §4.3: the live branch is async — it materializes the in-flight turns into
    // the view (so a rejoin can anchor to the rendered bubble, P1-A) before attach.
    attachLiveTask: vi.fn(async () => 'reconcile_rejoined' as const),
    settleIdle: vi.fn(async () => 'fell_through_to_resend' as const),
    evictChat: vi.fn(async () => {}),
    isNetworkError: (e): e is NetErr => e instanceof NetErr,
    isHttp404: (e): e is NotFound => e instanceof NotFound,
    telemetry: vi.fn(),
    networkRetryBackoffMs: [0, 0, 0],
    ...overrides,
  }
}

describe('reconcileChat — precedence branches', () => {
  it('server non-idle routes to attachLiveTask and emits reconcile_rejoined', async () => {
    const deps = buildDeps({ loadSessionMessages: vi.fn(async () => liveResp()) })
    const reconcile = createReconcileChat(deps)
    await reconcile(chatKey, { reason: 'stream_lost' })
    expect(deps.attachLiveTask).toHaveBeenCalledTimes(1)
    expect(deps.settleIdle).not.toHaveBeenCalled()
    expect(deps.telemetry).toHaveBeenCalledWith('stream_recovery', {
      reason: 'stream_lost',
      outcome: 'reconcile_rejoined',
    })
    expect(deps.fsm.getState(chatKey)?.syncing).toBe(false) // RECONCILE_FINISHED cleared it
  })

  it('server idle routes to settleIdle with the taskId hint (GAP-H1 durable path)', async () => {
    const settleIdle = vi.fn(async () => 'recovered_from_task_result' as const)
    const deps = buildDeps({ settleIdle })
    const reconcile = createReconcileChat(deps)
    await reconcile(chatKey, { reason: 'approval_decided', taskIdHint: 'task-3' })
    // The 5th arg is the gate's `stillRelevant` predicate (R-F13 post-await
    // teardown guard) that the gate threads into the branch.
    expect(settleIdle).toHaveBeenCalledWith(
      chatKey,
      expect.anything(),
      expect.any(Number),
      'task-3',
      expect.any(Function)
    )
    expect(deps.telemetry).toHaveBeenCalledWith('stream_recovery', {
      reason: 'approval_decided',
      outcome: 'recovered_from_task_result',
    })
  })

  it('404 evicts the chat, dispatches RESET, and does NOT re-finish', async () => {
    const deps = buildDeps({
      loadSessionMessages: vi.fn(async () => {
        throw new NotFound('gone')
      }),
    })
    // Seed an entry so we can observe RESET removing it.
    deps.fsm.dispatch(chatKey, { type: 'SEND_STARTED', taskId: 't1' })
    const reconcile = createReconcileChat(deps)
    await reconcile(chatKey, { reason: 'user_refresh' })
    expect(deps.evictChat).toHaveBeenCalledWith(chatKey)
    expect(deps.fsm.getState(chatKey)).toBeUndefined() // RESET removed it, FINISHED skipped
    expect(deps.telemetry).toHaveBeenCalledWith('stream_recovery', {
      reason: 'user_refresh',
      outcome: '404',
    })
  })

  it('exhausted network retries → WENT_OFFLINE + offline outcome', async () => {
    const load = vi.fn(async () => {
      throw new NetErr('down')
    })
    const deps = buildDeps({ loadSessionMessages: load })
    const reconcile = createReconcileChat(deps)
    await reconcile(chatKey, { reason: 'back_online' })
    expect(load).toHaveBeenCalledTimes(3) // default 3 attempts
    expect(deps.fsm.getState(chatKey)?.phase).toBe('offline')
    expect(deps.telemetry).toHaveBeenCalledWith('stream_recovery', {
      reason: 'back_online',
      outcome: 'offline',
    })
  })

  it('a transient network blip that then succeeds still settles idle', async () => {
    const load = vi
      .fn<() => Promise<SessionMessagesResult>>()
      .mockRejectedValueOnce(new NetErr('blip'))
      .mockResolvedValueOnce(idleResp())
    const deps = buildDeps({
      loadSessionMessages: load as unknown as ReconcileChatDeps['loadSessionMessages'],
    })
    const reconcile = createReconcileChat(deps)
    await reconcile(chatKey, { reason: 'stream_lost' })
    expect(load).toHaveBeenCalledTimes(2)
    expect(deps.settleIdle).toHaveBeenCalledTimes(1)
  })
})

describe('reconcileChat — single-flight', () => {
  it('coalesces a concurrent trigger onto the running promise', async () => {
    let resolveFirst: (v: SessionMessagesResult) => void = () => {}
    const load = vi
      .fn<() => Promise<SessionMessagesResult>>()
      .mockImplementationOnce(
        () => new Promise<SessionMessagesResult>(resolve => (resolveFirst = resolve))
      )
      .mockImplementation(async () => idleResp())
    const deps = buildDeps({
      loadSessionMessages: load as unknown as ReconcileChatDeps['loadSessionMessages'],
    })
    const reconcile = createReconcileChat(deps)
    const p1 = reconcile(chatKey, { reason: 'a' })
    const p2 = reconcile(chatKey, { reason: 'b' })
    expect(p1).toBe(p2) // same promise
    expect(reconcile.isInFlight(chatKey)).toBe(true)
    resolveFirst(idleResp())
    await p1
    expect(load).toHaveBeenCalledTimes(1) // second call coalesced, not re-fetched
    expect(reconcile.isInFlight(chatKey)).toBe(false)
    // A later, separate trigger runs fresh (resolves immediately).
    await reconcile(chatKey, { reason: 'c' })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('reset() aborts an in-flight run before its side-effectful branch', async () => {
    let resolveLoad: (v: SessionMessagesResult) => void = () => {}
    const load = vi.fn(() => new Promise<SessionMessagesResult>(resolve => (resolveLoad = resolve)))
    const deps = buildDeps({
      loadSessionMessages: load as unknown as ReconcileChatDeps['loadSessionMessages'],
    })
    const reconcile = createReconcileChat(deps)
    const p = reconcile(chatKey, { reason: 'stream_lost' })
    expect(reconcile.isInFlight(chatKey)).toBe(true)
    reconcile.reset() // logout / team-switch mid-fetch
    deps.fsm.reset()
    expect(reconcile.isInFlight(chatKey)).toBe(false) // coalescing map cleared
    resolveLoad(liveResp()) // fetch resolves AFTER the reset
    await p
    // The run bailed at the post-fetch relevance check → no attach/settle ran.
    expect(deps.attachLiveTask).not.toHaveBeenCalled()
    expect(deps.settleIdle).not.toHaveBeenCalled()
    expect(deps.fsm.getState(chatKey)).toBeUndefined()
  })

  it('an old post-reset completion does not clear a newer reconcile for the same chat', async () => {
    let resolveOld: (value: SessionMessagesResult) => void = () => {}
    let resolveNew: (value: SessionMessagesResult) => void = () => {}
    const load = vi
      .fn<() => Promise<SessionMessagesResult>>()
      .mockImplementationOnce(
        () => new Promise<SessionMessagesResult>(resolve => (resolveOld = resolve))
      )
      .mockImplementationOnce(
        () => new Promise<SessionMessagesResult>(resolve => (resolveNew = resolve))
      )
    const deps = buildDeps({
      loadSessionMessages: load as unknown as ReconcileChatDeps['loadSessionMessages'],
    })
    const reconcile = createReconcileChat(deps)
    const oldRun = reconcile(chatKey, { reason: 'old-session' })
    reconcile.reset()
    deps.fsm.reset()
    const newRun = reconcile(chatKey, { reason: 'new-session' })

    resolveOld(idleResp())
    await oldRun
    expect(reconcile.isInFlight(chatKey)).toBe(true)

    resolveNew(idleResp())
    await newRun
    expect(reconcile.isInFlight(chatKey)).toBe(false)
  })

  it('supersedes an old same-chat run and permits a fresh authoritative fetch', async () => {
    let resolveOld: (value: SessionMessagesResult) => void = () => {}
    const load = vi
      .fn<() => Promise<SessionMessagesResult>>()
      .mockImplementationOnce(
        () => new Promise<SessionMessagesResult>(resolve => (resolveOld = resolve))
      )
      .mockResolvedValueOnce(idleResp({ totalTurns: 2 }))
    const deps = buildDeps({
      loadSessionMessages: load as unknown as ReconcileChatDeps['loadSessionMessages'],
    })
    const reconcile = createReconcileChat(deps)

    const oldRun = reconcile(chatKey, { reason: 'first-open' })
    expect(deps.fsm.getState(chatKey)?.syncing).toBe(true)
    reconcile.supersede(chatKey)
    expect(deps.fsm.getState(chatKey)?.syncing).toBe(false)
    const freshRun = reconcile(chatKey, { reason: 'second-open' })

    await freshRun
    resolveOld(idleResp({ totalTurns: 1 }))
    await expect(oldRun).resolves.toBe('stale_drop')
    expect(load).toHaveBeenCalledTimes(2)
    expect(deps.settleIdle).toHaveBeenCalledTimes(1)
    expect(deps.settleIdle).toHaveBeenCalledWith(
      chatKey,
      expect.objectContaining({ totalTurns: 2 }),
      expect.any(Number),
      undefined,
      expect.any(Function)
    )
  })

  it('drops a late 404 after reset instead of evicting the next session cache', async () => {
    let rejectLoad: (reason: unknown) => void = () => {}
    const load = vi.fn(
      (_agentRef: string, _chatId: string, _query: unknown, stillRelevant?: () => boolean) => {
        expect(stillRelevant).toEqual(expect.any(Function))
        return new Promise<SessionMessagesResult>((_resolve, reject) => {
          rejectLoad = reject
        })
      }
    )
    const deps = buildDeps({
      loadSessionMessages: load as ReconcileChatDeps['loadSessionMessages'],
    })
    const reconcile = createReconcileChat(deps)
    const pending = reconcile(chatKey, { reason: 'old-session' })

    reconcile.reset()
    deps.fsm.reset()
    rejectLoad(new NotFound('late response'))

    await expect(pending).resolves.toBe('noop')
    expect(deps.evictChat).not.toHaveBeenCalled()
    expect(deps.fsm.getState(chatKey)).toBeUndefined()
  })

  it('a coalesced caller donates its taskIdHint to a hint-less in-flight run (M6)', async () => {
    let resolveFirst: (v: SessionMessagesResult) => void = () => {}
    const load = vi
      .fn<() => Promise<SessionMessagesResult>>()
      .mockImplementationOnce(
        () => new Promise<SessionMessagesResult>(resolve => (resolveFirst = resolve))
      )
      .mockImplementation(async () => idleResp())
    const settleIdle = vi.fn(async () => 'recovered_from_task_result' as const)
    const deps = buildDeps({
      loadSessionMessages: load as unknown as ReconcileChatDeps['loadSessionMessages'],
      settleIdle,
    })
    const reconcile = createReconcileChat(deps)
    // First trigger has NO hint; it's still fetching when the second (hint-bearing)
    // caller coalesces onto it.
    const p1 = reconcile(chatKey, { reason: 'back_online' })
    const p2 = reconcile(chatKey, { reason: 'stream_lost', taskIdHint: 'task-7' })
    expect(p1).toBe(p2)
    resolveFirst(idleResp())
    await p1
    // settleIdle must receive the donated hint (would have been `undefined` before M6).
    expect(settleIdle).toHaveBeenCalledWith(
      chatKey,
      expect.anything(),
      expect.any(Number),
      'task-7',
      expect.any(Function)
    )
  })

  it('different chatKeys run independently', async () => {
    const deps = buildDeps()
    const reconcile = createReconcileChat(deps)
    await Promise.all([
      reconcile(makeTaskKey(AGENT, 'chat-1'), { reason: 'x' }),
      reconcile(makeTaskKey(AGENT, 'chat-2'), { reason: 'x' }),
    ])
    expect(deps.loadSessionMessages).toHaveBeenCalledTimes(2)
  })
})

describe('reconcileChat — relevance guard', () => {
  it('aborts (stale_drop) when the chat is no longer relevant after the fetch', async () => {
    const deps = buildDeps({ isStillRelevant: () => false })
    const reconcile = createReconcileChat(deps)
    await reconcile(chatKey, { reason: 'stream_lost' })
    // Fetch is skipped by the pre-fetch relevance check → noop (never routed).
    expect(deps.attachLiveTask).not.toHaveBeenCalled()
    expect(deps.settleIdle).not.toHaveBeenCalled()
  })
})
