// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import type { SessionsListResult } from '../../../../../src/types'
import { MAX_RENAME_SYNC_ATTEMPTS } from '../useChatListController'
import { deferred, localIndex, serverSessions } from './__fixtures__/catalogFixtures'
import { renderController } from './__fixtures__/controllerHarness'
import { ipcHttpError } from './__fixtures__/ipcErrors'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HOST_A = 'stateful-host'
const HOST_B = 'stateless-host'
const HOSTS = [HOST_A, HOST_B]

let clerum: MockClerum

beforeEach(() => {
  clerum = installMockClerum()
  // Keep the real catalog cache's five-second TTL stable across rerenders.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-14T12:00:00.000Z'))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  uninstallMockClerum()
})

describe('per-Host Latest sessions publication', () => {
  it.each([
    [HOST_A, HOST_B],
    [HOST_B, HOST_A],
  ])('publishes %s while %s is pending and preserves its rows on arrival', async (first, last) => {
    const pendingLast = deferred<SessionsListResult>()
    let lastResolved = false
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    clerum.rpc.listSessions.mockImplementation((agentRef: string) =>
      agentRef === last
        ? pendingLast.promise.then(page => {
            lastResolved = true
            return page
          })
        : Promise.resolve(
            serverSessions([{ agent: first, chatId: 'shared-id', title: `${first} chat` }])
          )
    )
    const controller = renderController({ selectedAgent: null, agentNames: HOSTS })

    // Both reads were dispatched; the second Host really is still pending.
    await waitFor(() =>
      expect(clerum.rpc.listSessions).toHaveBeenCalledWith(last, undefined, {
        agent: last,
        limit: 50,
      })
    )
    await waitFor(() =>
      expect(controller.result.current.latestChatSessions.map(chat => chat.agentRef)).toEqual([
        first,
      ])
    )
    expect(lastResolved).toBe(false)
    expect(controller.result.current.latestChatSessionsLoading).toBe(false)
    const firstRow = controller.result.current.latestChatSessions[0]!
    expect(firstRow.remote).toBe(true)
    expect(firstRow.title).toBe(`${first} chat`)

    await act(async () => {
      pendingLast.resolve(
        serverSessions([{ agent: last, chatId: 'shared-id', title: `${last} chat` }])
      )
      await pendingLast.promise
    })

    await waitFor(() => expect(controller.result.current.latestChatSessions).toHaveLength(2))
    expect(lastResolved).toBe(true)
    expect(controller.result.current.latestChatSessions.find(chat => chat.agentRef === first)).toBe(
      firstRow
    )
    expect(
      controller.result.current.latestChatSessions.find(chat => chat.agentRef === last)
    ).toMatchObject({
      id: 'shared-id',
      title: `${last} chat`,
      remote: true,
    })
  })

  it.each([
    [HOST_A, HOST_B],
    [HOST_B, HOST_A],
  ])(
    'interleaves %s and %s rows by last activity whichever Host arrives last',
    async (first, last) => {
      const at = (minute: number) => `2026-10-14T11:0${minute}:00.000Z`
      const pages: Record<string, SessionsListResult> = {
        [HOST_A]: serverSessions([
          { agent: HOST_A, chatId: 'a-3', lastActivityAt: at(3) },
          { agent: HOST_A, chatId: 'a-1', lastActivityAt: at(1) },
        ]),
        [HOST_B]: serverSessions([
          { agent: HOST_B, chatId: 'b-4', lastActivityAt: at(4) },
          { agent: HOST_B, chatId: 'b-2', lastActivityAt: at(2) },
        ]),
      }
      const pendingLast = deferred<SessionsListResult>()
      clerum.chat.getIndex.mockResolvedValue(localIndex([]))
      clerum.rpc.listSessions.mockImplementation((agentRef: string) =>
        agentRef === last ? pendingLast.promise : Promise.resolve(pages[agentRef]!)
      )
      const controller = renderController({ selectedAgent: null, agentNames: HOSTS })
      await waitFor(() =>
        expect(controller.result.current.latestChatSessions.map(chat => chat.agentRef)).toEqual([
          first,
          first,
        ])
      )

      await act(async () => {
        pendingLast.resolve(pages[last]!)
        await pendingLast.promise
      })

      await waitFor(() =>
        expect(controller.result.current.latestChatSessions.map(chat => chat.id)).toEqual([
          'b-4',
          'a-3',
          'b-2',
          'a-1',
        ])
      )
    }
  )

  it('discards a cancelled Host response while retaining the remaining Host rows', async () => {
    const pendingB = deferred<SessionsListResult>()
    let bResolved = false
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    clerum.rpc.listSessions.mockImplementation((agentRef: string) =>
      agentRef === HOST_B
        ? pendingB.promise.then(page => {
            bResolved = true
            return page
          })
        : Promise.resolve(serverSessions([{ agent: HOST_A, chatId: 'remote-a' }]))
    )
    const controller = renderController({ selectedAgent: null, agentNames: HOSTS })
    await waitFor(() =>
      expect(controller.result.current.latestChatSessions.map(chat => chat.id)).toEqual([
        'remote-a',
      ])
    )
    expect(clerum.rpc.listSessions).toHaveBeenCalledWith(HOST_B, undefined, {
      agent: HOST_B,
      limit: 50,
    })

    controller.rerender({ selectedAgent: null, agentNames: [HOST_A] })
    await waitFor(() =>
      expect(controller.result.current.latestChatSessions.map(chat => chat.id)).toEqual([
        'remote-a',
      ])
    )
    await act(async () => {
      pendingB.resolve(serverSessions([{ agent: HOST_B, chatId: 'cancelled-b' }]))
      await pendingB.promise
    })

    expect(bResolved).toBe(true)
    expect(controller.result.current.latestChatSessions.map(chat => chat.id)).toEqual(['remote-a'])
  })

  it('discards an earlier authority scope response while retaining current Host rows', async () => {
    const pendingOldB = deferred<SessionsListResult>()
    const pendingCurrentB = deferred<SessionsListResult>()
    let oldBResolved = false
    let bReads = 0
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    clerum.rpc.listSessions.mockImplementation((agentRef: string) => {
      if (agentRef === HOST_A) {
        return Promise.resolve(serverSessions([{ agent: HOST_A, chatId: 'remote-a' }]))
      }
      bReads += 1
      return bReads === 1
        ? pendingOldB.promise.then(page => {
            oldBResolved = true
            return page
          })
        : pendingCurrentB.promise
    })
    const controller = renderController({ selectedAgent: null, agentNames: HOSTS })
    await waitFor(() =>
      expect(controller.result.current.latestChatSessions.map(chat => chat.id)).toEqual([
        'remote-a',
      ])
    )
    expect(bReads).toBe(1)

    controller.rerender({
      selectedAgent: null,
      agentNames: HOSTS,
      currentTeamId: 'team-2',
      chatAuthorityTeamId: 'team-2',
    })
    await waitFor(() => expect(bReads).toBe(2))
    await waitFor(() =>
      expect(controller.result.current.latestChatSessions.map(chat => chat.id)).toEqual([
        'remote-a',
      ])
    )
    await act(async () => {
      pendingOldB.resolve(serverSessions([{ agent: HOST_B, chatId: 'old-scope-b' }]))
      await pendingOldB.promise
    })
    expect(oldBResolved).toBe(true)
    expect(controller.result.current.latestChatSessions.map(chat => chat.id)).toEqual(['remote-a'])

    await act(async () => {
      pendingCurrentB.resolve(serverSessions([{ agent: HOST_B, chatId: 'current-scope-b' }]))
      await pendingCurrentB.promise
    })
    await waitFor(() =>
      expect(controller.result.current.latestChatSessions.map(chat => chat.id)).toContain(
        'current-scope-b'
      )
    )
    expect(controller.result.current.latestChatSessions.map(chat => chat.id)).not.toContain(
      'old-scope-b'
    )
  })

  it('discards a response after that Host authority epoch advances', async () => {
    const pendingB = deferred<SessionsListResult>()
    let bEpoch = 0
    let bResolved = false
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    clerum.rpc.listSessions.mockImplementation((agentRef: string) =>
      agentRef === HOST_B
        ? pendingB.promise.then(page => {
            bResolved = true
            return page
          })
        : Promise.resolve(serverSessions([{ agent: HOST_A, chatId: 'remote-a' }]))
    )
    const controller = renderController({
      selectedAgent: null,
      agentNames: HOSTS,
      getHostAuthorityEpoch: agentRef => (agentRef === HOST_B ? bEpoch : 0),
    })
    await waitFor(() =>
      expect(controller.result.current.latestChatSessions.map(chat => chat.id)).toEqual([
        'remote-a',
      ])
    )
    expect(clerum.rpc.listSessions).toHaveBeenCalledWith(HOST_B, undefined, {
      agent: HOST_B,
      limit: 50,
    })
    bEpoch += 1
    await act(async () => {
      pendingB.resolve(serverSessions([{ agent: HOST_B, chatId: 'old-epoch-b' }]))
      await pendingB.promise
    })
    expect(bResolved).toBe(true)
    expect(controller.result.current.latestChatSessions.map(chat => chat.id)).toEqual(['remote-a'])
  })

  it('discards a page whose Host authority epoch advances after the publication check, inside its updater', async () => {
    const pendingB = deferred<SessionsListResult>()
    let bResolved = false
    let armed = false
    let bEpochReadsSinceArm = 0
    // After B's response the loader reads B's epoch twice (post-read and
    // pre-publication checks) before its `setLatestChatSessions` updater reads
    // it a third time. From that third read on, B's authority has moved.
    const getHostAuthorityEpoch = (agentRef: string) => {
      if (!armed || agentRef !== HOST_B) return 0
      bEpochReadsSinceArm += 1
      return bEpochReadsSinceArm > 2 ? 1 : 0
    }
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    clerum.rpc.listSessions.mockImplementation((agentRef: string) =>
      agentRef === HOST_B
        ? pendingB.promise.then(page => {
            bResolved = true
            return page
          })
        : Promise.resolve(serverSessions([{ agent: HOST_A, chatId: 'remote-a' }]))
    )
    const controller = renderController({
      selectedAgent: null,
      agentNames: HOSTS,
      getHostAuthorityEpoch,
    })
    await waitFor(() =>
      expect(controller.result.current.latestChatSessions.map(chat => chat.id)).toEqual([
        'remote-a',
      ])
    )
    expect(clerum.rpc.listSessions).toHaveBeenCalledWith(HOST_B, undefined, {
      agent: HOST_B,
      limit: 50,
    })

    await act(async () => {
      armed = true
      pendingB.resolve(serverSessions([{ agent: HOST_B, chatId: 'moved-epoch-b' }]))
      await pendingB.promise
    })

    // Liveness: B's catalog read resolved and the updater-time check ran.
    expect(bResolved).toBe(true)
    expect(bEpochReadsSinceArm).toBeGreaterThan(2)
    expect(controller.result.current.latestChatSessions.map(chat => chat.id)).toEqual(['remote-a'])
  })

  it('flushes only the arriving Host offline renames without spending another Host retry budget', async () => {
    const pendingA = deferred<SessionsListResult>()
    const pendingB = deferred<SessionsListResult>()
    clerum.chat.getIndex.mockImplementation(async (agentRef: string) =>
      localIndex([{ id: `${agentRef}-chat`, title: `${agentRef} original` }])
    )
    clerum.rpc.listSessions.mockImplementation((agentRef: string) =>
      agentRef === HOST_A ? pendingA.promise : pendingB.promise
    )
    clerum.rpc.renameSession.mockRejectedValue(new Error('fetch failed'))
    const controller = renderController({ selectedAgent: null, agentNames: HOSTS })
    await waitFor(() => expect(clerum.rpc.listSessions).toHaveBeenCalledTimes(2))
    const attemptsFor = (agentRef: string) =>
      clerum.rpc.renameSession.mock.calls.filter(call => call[0] === agentRef).length

    await act(async () => {
      await controller.result.current.handleRenameChatForAgent(
        HOST_A,
        `${HOST_A}-chat`,
        'Renamed A'
      )
      await controller.result.current.handleRenameChatForAgent(
        HOST_B,
        `${HOST_B}-chat`,
        'Renamed B'
      )
    })
    expect(attemptsFor(HOST_A)).toBe(1)
    expect(attemptsFor(HOST_B)).toBe(1)

    await act(async () => {
      pendingA.resolve(
        serverSessions([{ agent: HOST_A, chatId: `${HOST_A}-chat`, title: 'Server A' }])
      )
      await pendingA.promise
    })
    // A really flushed and failed again; B remains at its first offline failure.
    await waitFor(() => expect(attemptsFor(HOST_A)).toBe(2))
    expect(attemptsFor(HOST_B)).toBe(1)
    expect(
      controller.result.current.latestChatSessions.find(chat => chat.agentRef === HOST_A)?.title
    ).toBe('Renamed A')

    // Reconnect still retries every offline Host. B retains all four remaining
    // failures before exhausting its budget, proving A did not increment it.
    for (let attempt = 1; attempt < MAX_RENAME_SYNC_ATTEMPTS; attempt += 1) {
      await act(async () => {
        window.dispatchEvent(new Event('online'))
      })
      await waitFor(() => expect(attemptsFor(HOST_B)).toBe(attempt + 1))
    }
    await act(async () => {
      pendingB.resolve(
        serverSessions([{ agent: HOST_B, chatId: `${HOST_B}-chat`, title: 'Server B' }])
      )
      await pendingB.promise
      window.dispatchEvent(new Event('online'))
    })
    expect(attemptsFor(HOST_B)).toBe(MAX_RENAME_SYNC_ATTEMPTS)
    expect(
      controller.result.current.latestChatSessions.find(chat => chat.agentRef === HOST_B)?.title
    ).toBe('Renamed B')
  })

  it("does not spend another Host's rename budget when the selected Host's poll arrives", async () => {
    // Every A read shares one deferred page; B's reads never resolve, so B's own
    // arrival cannot retry B's rename.
    const pendingA = deferred<SessionsListResult>()
    clerum.chat.getIndex.mockImplementation(async (agentRef: string) =>
      localIndex([{ id: `${agentRef}-chat`, title: `${agentRef} original` }])
    )
    clerum.rpc.listSessions.mockImplementation((agentRef: string) =>
      agentRef === HOST_A ? pendingA.promise : new Promise<SessionsListResult>(() => undefined)
    )
    const failed = new Set<string>()
    clerum.rpc.renameSession.mockImplementation(
      async (agentRef: string, _agent: string, _chatId: string, title: string) => {
        if (!failed.has(agentRef)) {
          failed.add(agentRef)
          throw new Error('fetch failed')
        }
        return { title }
      }
    )
    const controller = renderController({ selectedAgent: HOST_A, agentNames: HOSTS })
    await waitFor(() =>
      expect(clerum.rpc.listSessions).toHaveBeenCalledWith(HOST_A, undefined, expect.anything())
    )
    const attemptsFor = (agentRef: string) =>
      clerum.rpc.renameSession.mock.calls.filter(call => call[0] === agentRef).length

    for (const agentRef of HOSTS) {
      await act(async () => {
        await controller.result.current.handleRenameChatForAgent(
          agentRef,
          `${agentRef}-chat`,
          `Renamed ${agentRef}`
        )
      })
    }
    expect(attemptsFor(HOST_A)).toBe(1)
    expect(attemptsFor(HOST_B)).toBe(1)

    await act(async () => {
      pendingA.resolve(serverSessions([{ agent: HOST_A, chatId: 'a-remote', title: 'Server A' }]))
      await pendingA.promise
    })
    // Liveness: the selected Host's poll was applied and retried its own rename.
    await waitFor(() =>
      expect(controller.result.current.chatList.map(chat => chat.id)).toContain('a-remote')
    )
    await waitFor(() => expect(attemptsFor(HOST_A)).toBe(2))
    // B's queued rename kept its budget: A's poll did not PATCH it.
    expect(attemptsFor(HOST_B)).toBe(1)

    // A reconnect retries every Host's offline rename.
    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })
    await waitFor(() => expect(attemptsFor(HOST_B)).toBe(2))
    expect(attemptsFor(HOST_A)).toBe(2)
  })

  it('filters a confirmed tombstone created while that Host response is pending', async () => {
    const pendingB = deferred<SessionsListResult>()
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    clerum.rpc.listSessions.mockImplementation((agentRef: string) =>
      agentRef === HOST_B
        ? pendingB.promise
        : Promise.resolve(serverSessions([{ agent: HOST_A, chatId: 'remote-a' }]))
    )
    const controller = renderController({ selectedAgent: null, agentNames: HOSTS })
    await waitFor(() =>
      expect(controller.result.current.latestChatSessions.map(chat => chat.id)).toEqual([
        'remote-a',
      ])
    )
    expect(clerum.rpc.listSessions).toHaveBeenCalledWith(HOST_B, undefined, {
      agent: HOST_B,
      limit: 50,
    })

    await act(async () => {
      const deletion = await controller.result.current.captureChatDeleteFence(HOST_B)
      await controller.result.current.handleDeleteChatForAgent(HOST_B, 'deleted-b', deletion)
    })
    expect(clerum.chat.delete).toHaveBeenCalledWith(
      HOST_B,
      'deleted-b',
      expect.objectContaining({ version: 1, bindingGeneration: 1 })
    )
    await act(async () => {
      pendingB.resolve(
        serverSessions([
          { agent: HOST_B, chatId: 'deleted-b' },
          { agent: HOST_B, chatId: 'kept-b' },
        ])
      )
      await pendingB.promise
    })
    await waitFor(() =>
      expect(controller.result.current.latestChatSessions.map(chat => chat.id)).toContain('kept-b')
    )
    expect(controller.result.current.latestChatSessions.map(chat => chat.id)).toContain('remote-a')
    expect(controller.result.current.latestChatSessions.map(chat => chat.id)).not.toContain(
      'deleted-b'
    )
  })

  it('keeps cached rows after one Host fails while another Host publishes remote rows', async () => {
    const pendingB = deferred<SessionsListResult>()
    const unavailable = await ipcHttpError('rpc:listSessions', 503, 'Service Unavailable', {
      error: 'upstream unavailable',
    })
    clerum.chat.getIndex.mockImplementation(async (agentRef: string) =>
      agentRef === HOST_B ? localIndex([{ id: 'saved-b', title: 'Saved B' }]) : localIndex([])
    )
    clerum.rpc.listSessions.mockImplementation((agentRef: string) =>
      agentRef === HOST_B
        ? pendingB.promise
        : Promise.resolve(serverSessions([{ agent: HOST_A, chatId: 'remote-a' }]))
    )
    const controller = renderController({ selectedAgent: null, agentNames: HOSTS })
    await waitFor(() =>
      expect(controller.result.current.latestChatSessions.map(chat => chat.id)).toContain(
        'remote-a'
      )
    )
    await act(async () => {
      pendingB.reject(unavailable)
    })
    // The existing outage toast witnesses that B's rejection was handled.
    await waitFor(() =>
      expect(controller.spies.pushToast).toHaveBeenCalledWith(
        `Chat list for ${HOST_B} is offline. Showing saved chats.`,
        'info'
      )
    )
    expect(controller.result.current.latestChatSessions.map(chat => chat.id).sort()).toEqual([
      'remote-a',
      'saved-b',
    ])
  })
})
