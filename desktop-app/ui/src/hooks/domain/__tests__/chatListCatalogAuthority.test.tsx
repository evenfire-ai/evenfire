// @vitest-environment jsdom
/**
 * Catalog failure handling and per-Host authority in `useChatListController`,
 * driven through the real controller with IPC rejections built from the real
 * producers and the production Host-authority store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import type { SessionsListResult } from '../../../../../src/types'
import { isHostAvailabilityError } from '../../../lib/format'
import { deferred, localIndex, serverSessions } from './__fixtures__/catalogFixtures'
import { renderController } from './__fixtures__/controllerHarness'
import { ipcHttpError } from './__fixtures__/ipcErrors'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let clerum: MockClerum

beforeEach(() => {
  clerum = installMockClerum()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  uninstallMockClerum()
})

type CatalogQuery = { agent: string; limit: number; cursor?: string } | undefined

const catalogToasts = (pushToast: ReturnType<typeof vi.fn>) =>
  pushToast.mock.calls.filter(([message]) => String(message).startsWith('Chat list for'))

const catalogUnavailable = () =>
  ipcHttpError('rpc:listSessions', 503, 'Service Unavailable', { error: 'upstream unavailable' })

/** Let pending promise continuations run without advancing any timer. */
async function flushMicrotasks(until: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !until(); turn += 1) {
    await Promise.resolve()
  }
  if (!until()) throw new Error('condition not reached within 200 microtask turns')
}

describe('load-more rejection for a Host that is no longer shown (NEW-dui-1)', () => {
  it("keeps agent-b's load-more state when agent-a's cursor is rejected late", async () => {
    const pendingA = deferred<SessionsListResult>()
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    clerum.rpc.listSessions.mockImplementation(
      async (agentRef: string, _teamId: string | undefined, query: CatalogQuery) => {
        if (query?.cursor) return pendingA.promise
        return serverSessions(
          [{ agent: agentRef, chatId: `${agentRef}-page-1` }],
          `${agentRef}-cursor`
        )
      }
    )
    const controller = renderController({
      selectedAgent: 'agent-a',
      agentNames: ['agent-a', 'agent-b'],
    })
    await waitFor(() => expect(controller.result.current.chatListHasMoreRemoteSessions).toBe(true))

    let loadMoreA!: Promise<void>
    act(() => {
      loadMoreA = controller.result.current.loadMoreChatSessions()
    })
    await waitFor(() =>
      expect(clerum.rpc.listSessions).toHaveBeenCalledWith('agent-a', undefined, {
        agent: 'agent-a',
        limit: 50,
        cursor: 'agent-a-cursor',
      })
    )

    controller.rerender({ selectedAgent: 'agent-b', agentNames: ['agent-a', 'agent-b'] })
    await waitFor(() =>
      expect(controller.result.current.chatList.map(chat => chat.id)).toContain('agent-b-page-1')
    )
    expect(controller.result.current.chatListHasMoreRemoteSessions).toBe(true)

    await act(async () => {
      pendingA.reject(
        await ipcHttpError('rpc:listSessions', 400, 'Bad Request', {
          error: 'Invalid sessions cursor',
        })
      )
      await loadMoreA
    })

    expect(controller.result.current.chatListHasMoreRemoteSessions).toBe(true)
    // Liveness: the rejection was the terminal kind (no retryable toast).
    expect(controller.spies.pushToast).not.toHaveBeenCalledWith(
      expect.stringContaining("Couldn't load more chats"),
      'info'
    )
  })
})

describe('load-more terminal cursor while the same Host is held (NEW-fa-3)', () => {
  it('leaves hasMore false and forgets the cursor when a cursor 400 arrives during an authority hold', async () => {
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    clerum.rpc.listSessions.mockImplementation(
      async (agentRef: string, _teamId: string | undefined, query: CatalogQuery) => {
        if (query?.cursor) {
          throw await ipcHttpError('rpc:listSessions', 400, 'Bad Request', {
            error: 'Invalid sessions cursor',
          })
        }
        return serverSessions(
          [{ agent: agentRef, chatId: `${agentRef}-page-1` }],
          `${agentRef}-cursor`
        )
      }
    )
    const controller = renderController({ selectedAgent: 'agent-a', agentNames: ['agent-a'] })
    // Liveness: the first page left a valid cursor and a "Load more" button.
    await waitFor(() => expect(controller.result.current.chatListHasMoreRemoteSessions).toBe(true))

    // The Host is held before the load-more starts, so the request snapshots the
    // held epoch and the rejection reaches the blocked-Host branch.
    controller.hostAuthority.hold('agent-a', 'uncertain')

    await act(async () => {
      await controller.result.current.loadMoreChatSessions()
    })

    // Liveness: the cursor request really went out and was rejected.
    expect(clerum.rpc.listSessions).toHaveBeenCalledWith('agent-a', undefined, {
      agent: 'agent-a',
      limit: 50,
      cursor: 'agent-a-cursor',
    })
    expect(controller.result.current.chatListHasMoreRemoteSessions).toBe(false)

    // The cursor was forgotten: another load-more issues no further read.
    const readsAfterFirst = clerum.rpc.listSessions.mock.calls.length
    await act(async () => {
      await controller.result.current.loadMoreChatSessions()
    })
    expect(clerum.rpc.listSessions.mock.calls.length).toBe(readsAfterFirst)
    // The terminal rejection is not a retryable failure: no toast.
    expect(controller.spies.pushToast).not.toHaveBeenCalledWith(
      expect.stringContaining("Couldn't load more chats"),
      'info'
    )
  })
})

describe('catalog offline toast (R2-L4, NEW-tq-5, NEW-dui-5/6)', () => {
  it('does not report a waking Host as offline', async () => {
    const waking = await ipcHttpError('rpc:listSessions', 503, 'Service Unavailable', {
      code: 'host_waking',
      hostRef: 'agent-a',
      retryAfterMs: 2000,
      message: 'Host is waking up',
    })
    // Fixture sanity: the real producer's wrapped 503 carries the waking code.
    expect(isHostAvailabilityError(waking)).toBe(true)
    clerum.chat.getIndex.mockResolvedValue(localIndex([{ id: 'cached-a', title: 'Cached chat' }]))
    clerum.rpc.listSessions.mockRejectedValue(waking)
    const controller = renderController({ selectedAgent: 'agent-a', agentNames: ['agent-a'] })

    await waitFor(() => expect(clerum.rpc.listSessions).toHaveBeenCalled())
    await waitFor(() =>
      expect(controller.result.current.chatList.map(chat => chat.id)).toEqual(['cached-a'])
    )
    // Let the post-paint selected-agent read settle too.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60))
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(catalogToasts(controller.spies.pushToast)).toEqual([])
    expect(controller.hostAuthority.isBlocked('agent-a')).toBe(false)
  })

  it('shows one offline toast for several failing Hosts and none for a later failure', async () => {
    const unavailable = await catalogUnavailable()
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    clerum.rpc.listSessions.mockRejectedValue(unavailable)
    const controller = renderController({
      selectedAgent: null,
      agentNames: ['agent-a', 'agent-b'],
    })

    await waitFor(() => expect(catalogToasts(controller.spies.pushToast)).toHaveLength(1))
    expect(catalogToasts(controller.spies.pushToast)[0]).toEqual([
      'Chat list for agent-a, agent-b is offline. Showing saved chats.',
      'info',
    ])

    // A later failure while the outage is already reported.
    controller.rerender({ selectedAgent: null, agentNames: ['agent-a', 'agent-b', 'agent-c'] })
    await waitFor(() =>
      expect(clerum.rpc.listSessions).toHaveBeenCalledWith('agent-c', undefined, {
        agent: 'agent-c',
        limit: 50,
      })
    )
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(catalogToasts(controller.spies.pushToast)).toHaveLength(1)
  })

  it('drops a queued offline toast when the controller unmounts', async () => {
    const pending = deferred<SessionsListResult>()
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    clerum.rpc.listSessions.mockReturnValue(pending.promise)
    const controller = renderController({ selectedAgent: null, agentNames: ['agent-a'] })
    await waitFor(() => expect(clerum.rpc.listSessions).toHaveBeenCalled())
    const unavailable = await catalogUnavailable()

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    pending.reject(unavailable)
    // Witness: the rejection reached the controller and queued the toast.
    await flushMicrotasks(() => vi.getTimerCount() === 1)

    controller.unmount()
    expect(vi.getTimerCount()).toBe(0)
    vi.runOnlyPendingTimers()
    expect(catalogToasts(controller.spies.pushToast)).toEqual([])
  })

  it('drops the previous scope’s queued offline toast when the scope changes', async () => {
    const pending = deferred<SessionsListResult>()
    const unavailable = await catalogUnavailable()
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    clerum.rpc.listSessions.mockImplementationOnce(() => pending.promise)
    clerum.rpc.listSessions.mockRejectedValue(unavailable)
    const controller = renderController({ selectedAgent: null, agentNames: ['agent-a'] })
    await waitFor(() => expect(clerum.rpc.listSessions).toHaveBeenCalledTimes(1))

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    pending.reject(unavailable)
    // Witness: the old scope's rejection queued its toast.
    await flushMicrotasks(() => vi.getTimerCount() === 1)

    // The new scope is down as well and queues its own toast.
    act(() => {
      controller.rerender({ selectedAgent: null, agentNames: ['agent-a'], currentTeamId: 'team-2' })
    })
    await flushMicrotasks(() => clerum.rpc.listSessions.mock.calls.length === 2)
    for (let turn = 0; turn < 200; turn += 1) await Promise.resolve()
    act(() => {
      vi.runOnlyPendingTimers()
    })

    // One toast for the one outage the user is looking at, never a second
    // one flushed from the scope they left.
    expect(catalogToasts(controller.spies.pushToast)).toEqual([
      ['Chat list for agent-a is offline. Showing saved chats.', 'info'],
    ])
  })

  it('ignores a success from an earlier scope when deduplicating the next outage', async () => {
    const lateOldScopeSuccess = deferred<SessionsListResult>()
    const unavailable = await catalogUnavailable()
    let teamOneReads = 0
    let scope: 'team-1' | 'team-2' = 'team-1'
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    clerum.rpc.listSessions.mockImplementation(async () => {
      // team-1: held until after the scope change, then succeeds late.
      if (scope === 'team-1') {
        teamOneReads += 1
        return lateOldScopeSuccess.promise
      }
      // team-2 is down.
      throw unavailable
    })
    // The selected-agent read reports catalog success before its own scope
    // guard, so it is the path whose stale success must be ignored.
    const controller = renderController({ selectedAgent: 'agent-a', agentNames: ['agent-a'] })
    await waitFor(() => expect(teamOneReads).toBeGreaterThanOrEqual(1))
    await waitFor(() => expect(clerum.chat.getIndex.mock.calls.length).toBeGreaterThanOrEqual(2))
    // Let the post-paint selected-agent read attach to the pending request.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60))
    })

    scope = 'team-2'
    controller.rerender({
      selectedAgent: 'agent-a',
      agentNames: ['agent-a'],
      currentTeamId: 'team-2',
    })
    await waitFor(() => expect(catalogToasts(controller.spies.pushToast)).toHaveLength(1))

    await act(async () => {
      lateOldScopeSuccess.resolve(serverSessions([{ agent: 'agent-a', chatId: 'old-scope' }]))
      await lateOldScopeSuccess.promise
    })

    // Another failure in team-2, via a catalog change that re-reads every Host.
    controller.rerender({
      selectedAgent: 'agent-a',
      agentNames: ['agent-a', 'agent-b'],
      currentTeamId: 'team-2',
    })
    await waitFor(() =>
      expect(clerum.rpc.listSessions).toHaveBeenCalledWith('agent-b', undefined, {
        agent: 'agent-b',
        limit: 50,
      })
    )
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(catalogToasts(controller.spies.pushToast)).toHaveLength(1)
    expect(controller.result.current.chatList.map(chat => chat.id)).not.toContain('old-scope')
  })
})

describe('per-Host authority in the cross-agent list (R2-M5, R1-L11, R1-M10)', () => {
  function pendingCatalogs() {
    const pending = new Map<string, Array<ReturnType<typeof deferred<SessionsListResult>>>>()
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    clerum.rpc.listSessions.mockImplementation((agentRef: string) => {
      const read = deferred<SessionsListResult>()
      pending.set(agentRef, [...(pending.get(agentRef) ?? []), read])
      return read.promise
    })
    const resolveAll = (agentRef: string) => {
      for (const read of pending.get(agentRef) ?? []) {
        read.resolve(serverSessions([{ agent: agentRef, chatId: `${agentRef}-session` }]))
      }
      pending.delete(agentRef)
    }
    return { pending, resolveAll }
  }

  it("keeps Host X's in-flight sessions when Host Y is held", async () => {
    const { pending, resolveAll } = pendingCatalogs()
    const controller = renderController({
      selectedAgent: null,
      agentNames: ['host-x', 'host-y'],
    })
    await waitFor(() => expect(pending.has('host-x') && pending.has('host-y')).toBe(true))
    const readsBeforeHold = clerum.rpc.listSessions.mock.calls.length

    controller.hostAuthority.hold('host-y', 'revoked')
    await act(async () => {
      resolveAll('host-x')
      resolveAll('host-y')
    })

    await waitFor(() =>
      expect(controller.result.current.latestChatSessions.map(chat => chat.id)).toEqual([
        'host-x-session',
      ])
    )
    // A hold reloads nothing: the in-flight read is the one that published.
    expect(clerum.rpc.listSessions.mock.calls.length).toBe(readsBeforeHold)
  })

  it('reloads a Host whose sessions were discarded while it was held', async () => {
    const { pending, resolveAll } = pendingCatalogs()
    const controller = renderController({ selectedAgent: null, agentNames: ['host-y'] })
    await waitFor(() => expect(pending.has('host-y')).toBe(true))

    controller.hostAuthority.hold('host-y', 'uncertain')
    await act(async () => {
      resolveAll('host-y')
    })
    await waitFor(() => expect(controller.result.current.latestChatSessionsLoading).toBe(false))
    expect(controller.result.current.latestChatSessions).toEqual([])

    controller.hostAuthority.release('host-y')
    // The reload may reuse the renderer's short-lived catalog request cache or
    // issue a new read; resolve any new read so either path can publish.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      resolveAll('host-y')
    })
    await waitFor(() =>
      expect(controller.result.current.latestChatSessions.map(chat => chat.id)).toEqual([
        'host-y-session',
      ])
    )
  })

  it('returns the same latestChatSessions reference until its inputs change', async () => {
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    clerum.rpc.listSessions.mockImplementation(async (agentRef: string) =>
      serverSessions([{ agent: agentRef, chatId: `${agentRef}-session` }])
    )
    const controller = renderController({
      selectedAgent: null,
      agentNames: ['host-x', 'host-y'],
    })
    await waitFor(() => expect(controller.result.current.latestChatSessions).toHaveLength(2))
    await waitFor(() => expect(controller.result.current.latestChatSessionsLoading).toBe(false))

    const first = controller.result.current.latestChatSessions
    controller.rerender({ selectedAgent: null, agentNames: ['host-x', 'host-y'] })
    expect(controller.result.current.latestChatSessions).toBe(first)

    controller.hostAuthority.hold('host-y', 'uncertain')
    const afterHold = controller.result.current.latestChatSessions
    expect(afterHold).not.toBe(first)
    expect(afterHold.map(chat => chat.id)).toEqual(['host-x-session'])
  })
})
