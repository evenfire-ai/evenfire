// @vitest-environment jsdom
/**
 * spec 15 Fase B §2.5 — the pending-rename queue, asserted through the observable
 * sidebar title (pr-discipline T4) and the RPC call count. Covers: 200 confirms,
 * 404 keeps the optimistic title without rollback (retried after the session is
 * reported), a genuine 4xx rolls back + toasts, a network failure queues offline,
 * a pending rename WINS over a server title (case E — protects case C), and the
 * auto-title path (applyLocalTitleOnly) never fires the rename RPC.
 *
 * T3: these fail against the parent commit (no queue, no renameSession — the RPC
 * is never called and there is no rollback/pending behavior to assert).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import type { ChatIndex } from '../../../../../src/types'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let clerum: MockClerum

beforeEach(() => {
  clerum = installMockClerum()
})

afterEach(() => {
  vi.restoreAllMocks()
  uninstallMockClerum()
})

const NOW = '2026-09-12T00:00:00.000Z'

function localIndex(chats: Array<{ id: string; title: string }>): ChatIndex {
  return {
    version: 1,
    lastActiveChatId: null,
    onboardingDismissed: false,
    chats: chats.map(c => ({
      id: c.id,
      title: c.title,
      createdAt: NOW,
      updatedAt: NOW,
      messageCount: 0,
    })),
  }
}

function titleInList(current: { chatList: Array<{ id: string; title: string }> }, id: string) {
  return current.chatList.find(c => c.id === id)?.title
}

function titleInLatest(
  current: { latestChatSessions: Array<{ id: string; title: string }> },
  id: string
) {
  return current.latestChatSessions.find(c => c.id === id)?.title
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

/**
 * Wire getIndex/renameChat as a stateful in-memory index so renameChat writes are
 * visible to a later getIndex — exactly like the real chatStore. A static getIndex
 * mock would hide the very bugs FIX 2 addresses (a re-rename reading back an
 * unconfirmed optimistic title, and the catalog loader resetting the optimistic
 * title from the persisted index on the next poll).
 */
function wireStatefulIndex(c: MockClerum, chats: Array<{ id: string; title: string }>) {
  const idx = localIndex(chats)
  c.chat.getIndex.mockImplementation(async () => ({
    ...idx,
    chats: idx.chats.map(ch => ({ ...ch })),
  }))
  c.chat.rename.mockImplementation(async (_agentRef: string, id: string, title: string) => {
    const found = idx.chats.find(x => x.id === id)
    if (found) found.title = title
  })
}

function reportedSessions(chats: Array<{ chatId: string; title?: string }>) {
  return {
    items: chats.map(c => ({
      agent: 'agent-x',
      chatId: c.chatId,
      turnCount: 1,
      lastActivityAt: NOW,
      ...(c.title !== undefined ? { title: c.title } : {}),
    })),
  }
}

describe('rename pending queue (spec 15 §2.5)', () => {
  it('200: optimistic local title + RPC sync (hostRef===agent===agentRef), no toast', async () => {
    clerum.chat.getIndex.mockResolvedValue(localIndex([{ id: 'c1', title: 'old' }]))
    clerum.rpc.renameSession.mockResolvedValue({ title: 'renamed' })

    const { result, spies } = renderController({
      selectedAgent: 'agent-x',
      agentNames: ['agent-x'],
    })
    await waitFor(() => expect(titleInList(result.current, 'c1')).toBe('old'))

    await act(async () => {
      await result.current.handleRenameChatForAgent('agent-x', 'c1', 'renamed')
    })

    expect(clerum.rpc.renameSession).toHaveBeenCalledWith('agent-x', 'agent-x', 'c1', 'renamed')
    expect(titleInList(result.current, 'c1')).toBe('renamed')
    expect(spies.pushToast).not.toHaveBeenCalledWith(expect.anything(), 'error')
  })

  it('4xx: rolls the optimistic title back to the previous value and toasts an error', async () => {
    clerum.chat.getIndex.mockResolvedValue(localIndex([{ id: 'c1', title: 'old' }]))
    clerum.rpc.renameSession.mockRejectedValue(new Error('Rename session failed (400)'))

    const { result, spies } = renderController({
      selectedAgent: 'agent-x',
      agentNames: ['agent-x'],
    })
    await waitFor(() => expect(titleInList(result.current, 'c1')).toBe('old'))

    await act(async () => {
      await result.current.handleRenameChatForAgent('agent-x', 'c1', 'renamed')
    })

    expect(clerum.rpc.renameSession).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(titleInList(result.current, 'c1')).toBe('old'))
    expect(spies.pushToast).toHaveBeenCalledWith(expect.any(String), 'error')
  })

  it('404: keeps the optimistic title without rollback or toast (pending)', async () => {
    clerum.chat.getIndex.mockResolvedValue(localIndex([{ id: 'c1', title: 'old' }]))
    clerum.rpc.renameSession.mockRejectedValue(new Error('Rename session failed (404)'))

    const { result, spies } = renderController({
      selectedAgent: 'agent-x',
      agentNames: ['agent-x'],
    })
    await waitFor(() => expect(titleInList(result.current, 'c1')).toBe('old'))

    await act(async () => {
      await result.current.handleRenameChatForAgent('agent-x', 'c1', 'renamed')
    })

    // NOT an error: optimistic title stays, no rollback, no toast.
    expect(titleInList(result.current, 'c1')).toBe('renamed')
    expect(spies.pushToast).not.toHaveBeenCalledWith(expect.anything(), 'error')
  })

  it('network failure: keeps the optimistic title, queues offline, no toast', async () => {
    clerum.chat.getIndex.mockResolvedValue(localIndex([{ id: 'c1', title: 'old' }]))
    clerum.rpc.renameSession.mockRejectedValue(new Error('fetch failed'))

    const { result, spies } = renderController({
      selectedAgent: 'agent-x',
      agentNames: ['agent-x'],
    })
    await waitFor(() => expect(titleInList(result.current, 'c1')).toBe('old'))

    await act(async () => {
      await result.current.handleRenameChatForAgent('agent-x', 'c1', 'renamed')
    })

    expect(titleInList(result.current, 'c1')).toBe('renamed')
    expect(spies.pushToast).not.toHaveBeenCalledWith(expect.anything(), 'error')
  })

  it('T5: a pending (404) rename WINS over a server title on the next poll (case E protects C)', async () => {
    clerum.chat.getIndex.mockResolvedValue(localIndex([{ id: 'c1', title: 'old' }]))
    // The server reports a DIFFERENT title for the same session.
    clerum.rpc.listSessions.mockResolvedValue({
      items: [
        { agent: 'agent-x', chatId: 'c1', turnCount: 1, lastActivityAt: NOW, title: 'server' },
      ],
    })
    // First rename 404s (session not materialized yet), retry succeeds.
    clerum.rpc.renameSession
      .mockRejectedValueOnce(new Error('Rename session failed (404)'))
      .mockResolvedValue({ title: 'renamed' })

    const { result, rerender } = renderController({
      selectedAgent: 'agent-x',
      agentNames: ['agent-x'],
    })
    await waitFor(() => expect(titleInList(result.current, 'c1')).toBe('server'))

    await act(async () => {
      await result.current.handleRenameChatForAgent('agent-x', 'c1', 'renamed')
    })

    // Even though the server keeps sending 'server', the pending local rename wins.
    expect(titleInList(result.current, 'c1')).toBe('renamed')
    expect(clerum.rpc.renameSession).toHaveBeenCalledTimes(1)

    // Next poll reports c1 → the queue retries the 404'd rename.
    await act(async () => {
      rerender({ agentNames: ['agent-x'] })
    })
    await waitFor(() => expect(clerum.rpc.renameSession).toHaveBeenCalledTimes(2))
    // Still shows the rename (never clobbered by the server title).
    expect(titleInList(result.current, 'c1')).toBe('renamed')
  })

  it('applyLocalTitleOnly updates the sidebar but never fires the rename RPC', async () => {
    clerum.chat.getIndex.mockResolvedValue(localIndex([{ id: 'c1', title: 'old' }]))

    const { result } = renderController({ selectedAgent: 'agent-x', agentNames: ['agent-x'] })
    await waitFor(() => expect(titleInList(result.current, 'c1')).toBe('old'))

    await act(async () => {
      await result.current.applyLocalTitleOnly('agent-x', 'c1', 'local-auto-title')
    })

    expect(titleInList(result.current, 'c1')).toBe('local-auto-title')
    expect(clerum.rpc.renameSession).not.toHaveBeenCalled()
  })

  it('T5: a rename in device A is seen by a fresh client B with no cache (server-authoritative)', async () => {
    // Fresh client: empty local cache. The server reports the renamed title.
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    clerum.rpc.listSessions.mockResolvedValue({
      items: [
        {
          agent: 'agent-x',
          chatId: 'c1',
          turnCount: 1,
          lastActivityAt: NOW,
          title: 'renamed on A',
        },
      ],
    })

    const { result } = renderController({ selectedAgent: 'agent-x', agentNames: ['agent-x'] })

    await waitFor(() => expect(titleInList(result.current, 'c1')).toBe('renamed on A'))
  })
})

describe('rename pending queue — concurrency (spec 15 §2.5)', () => {
  // FIX 1: a flush (catalog poll) landing while a PATCH is in flight must NOT
  // fire a second renameSession for the same key.
  it('does not fire a duplicate PATCH when a poll lands during an in-flight rename', async () => {
    const inFlight = deferred<{ title: string }>()
    clerum.chat.getIndex.mockResolvedValue(localIndex([{ id: 'c1', title: 'old' }]))
    clerum.rpc.listSessions.mockResolvedValue(reportedSessions([{ chatId: 'c1' }]))
    clerum.rpc.renameSession.mockReturnValue(inFlight.promise)

    const { result, rerender } = renderController({
      selectedAgent: 'agent-x',
      agentNames: ['agent-x'],
    })
    await waitFor(() => expect(titleInList(result.current, 'c1')).toBe('old'))

    let pending: Promise<void> | undefined
    await act(async () => {
      pending = result.current.handleRenameChatForAgent('agent-x', 'c1', 'renamed')
      await flushMicrotasks()
    })
    await waitFor(() => expect(clerum.rpc.renameSession).toHaveBeenCalledTimes(1))

    // A catalog poll lands while the PATCH is still in flight. (The same rerender
    // trick drives a retry in the 404 case — see the T5 test — so it does invoke
    // flushPendingRenames; here the in-flight guard must make it a no-op.)
    await act(async () => {
      rerender({ agentNames: ['agent-x'] })
      await flushMicrotasks()
    })
    await act(async () => {
      rerender({ agentNames: ['agent-x'] })
      await flushMicrotasks()
    })

    // The poll must NOT have spawned a second PATCH.
    expect(clerum.rpc.renameSession).toHaveBeenCalledTimes(1)

    await act(async () => {
      inFlight.resolve({ title: 'renamed' })
      await pending
    })
  })

  // FIX 2: renaming the same chat twice before the first PATCH resolves. The
  // second rename's pending marker must survive the first (stale) 200, so the
  // newer optimistic title keeps its case-E protection and is not clobbered.
  it('a stale 200 from the first rename does not drop the second rename’s protection', async () => {
    const first = deferred<{ title: string }>()
    const second = deferred<{ title: string }>()
    wireStatefulIndex(clerum, [{ id: 'c1', title: 'old' }])
    // The server keeps reporting a DIFFERENT title — it must never win while a
    // rename is pending.
    clerum.rpc.listSessions.mockResolvedValue(reportedSessions([{ chatId: 'c1', title: 'server' }]))
    clerum.rpc.renameSession
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)

    const { result, rerender } = renderController({
      selectedAgent: 'agent-x',
      agentNames: ['agent-x'],
    })
    await waitFor(() => expect(titleInList(result.current, 'c1')).toBe('server'))

    let p1: Promise<void> | undefined
    let p2: Promise<void> | undefined
    await act(async () => {
      p1 = result.current.handleRenameChatForAgent('agent-x', 'c1', 'A')
      await flushMicrotasks()
    })
    await act(async () => {
      p2 = result.current.handleRenameChatForAgent('agent-x', 'c1', 'B')
      await flushMicrotasks()
    })
    await waitFor(() => expect(clerum.rpc.renameSession).toHaveBeenCalledTimes(2))
    // Assert the CROSS-agent "Latest sessions" title: that list is what a poll
    // (agentNames rerender) actually re-merges, so it exercises the precedence
    // merge that a dropped marker would let the server clobber.
    await waitFor(() => expect(titleInLatest(result.current, 'c1')).toBe('B'))

    // The FIRST rename resolves 200 (stale — a newer rename replaced it).
    await act(async () => {
      first.resolve({ title: 'A' })
      await p1
      await flushMicrotasks()
    })

    // A poll lands: the second rename is still pending, so its local title wins
    // over the server title. If the stale 200 had dropped the marker, the merge
    // would clobber it back to 'server'.
    await act(async () => {
      rerender({ agentNames: ['agent-x'] })
      await flushMicrotasks()
    })
    expect(titleInLatest(result.current, 'c1')).toBe('B')

    await act(async () => {
      second.resolve({ title: 'B' })
      await p2
    })
  })

  // FIX 2 (rollback target): the second rename's rollback restores the title from
  // BEFORE the pending chain ('old'), never the first rename's unconfirmed 'A'.
  it('rolls a re-renamed chat back to the pre-pending title, not the prior optimistic one', async () => {
    const first = deferred<{ title: string }>()
    const second = deferred<{ title: string }>()
    wireStatefulIndex(clerum, [{ id: 'c1', title: 'old' }])
    clerum.rpc.renameSession
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)

    const { result, spies } = renderController({
      selectedAgent: 'agent-x',
      agentNames: ['agent-x'],
    })
    await waitFor(() => expect(titleInList(result.current, 'c1')).toBe('old'))

    let p1: Promise<void> | undefined
    let p2: Promise<void> | undefined
    await act(async () => {
      p1 = result.current.handleRenameChatForAgent('agent-x', 'c1', 'A')
      await flushMicrotasks()
    })
    await act(async () => {
      p2 = result.current.handleRenameChatForAgent('agent-x', 'c1', 'B')
      await flushMicrotasks()
    })

    // The second rename is rejected with a genuine 4xx → rollback.
    await act(async () => {
      second.reject(new Error('Rename session failed (400)'))
      await p2
      await flushMicrotasks()
    })

    // Rolled back to the pre-pending title 'old', NOT the first rename's 'A'.
    await waitFor(() => expect(titleInList(result.current, 'c1')).toBe('old'))
    expect(spies.pushToast).toHaveBeenCalledWith(expect.any(String), 'error')

    // Clean up the still-in-flight first attempt (it is now stale → no-op).
    await act(async () => {
      first.resolve({ title: 'A' })
      await p1
    })
  })

  // FIX 3: a 4xx on a chat with no local cache entry (previousTitle === '') must
  // NOT blank the sidebar — no rollback to an empty title.
  it('does not roll back to a blank title when there was no cached previous title', async () => {
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    // Server reports the chat so it lands in the list as a server-only entry.
    clerum.rpc.listSessions.mockResolvedValue(reportedSessions([{ chatId: 'c1', title: 'server' }]))
    clerum.rpc.renameSession.mockRejectedValue(new Error('Rename session failed (400)'))

    const { result, spies } = renderController({
      selectedAgent: 'agent-x',
      agentNames: ['agent-x'],
    })
    await waitFor(() => expect(titleInList(result.current, 'c1')).toBe('server'))

    await act(async () => {
      await result.current.handleRenameChatForAgent('agent-x', 'c1', 'renamed')
    })

    // The optimistic title was applied; on the 4xx we must NOT blank it.
    expect(titleInList(result.current, 'c1')).not.toBe('')
    expect(spies.pushToast).toHaveBeenCalledWith(expect.any(String), 'error')
  })
})
