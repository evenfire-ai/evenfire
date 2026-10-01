// @vitest-environment jsdom
/**
 * Hook integration: the real AppController, AgentChatController, ChatStore and
 * authority store share one catalog request per scope/Host/query for five seconds.
 * A Host hold invalidates that Host's queries through the coordinator, including
 * when it is selected; the selected-view teardown preserves other Hosts' caches.
 * The IPC bridge and producer-derived rejections are the only mocked boundaries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { SessionsListResult } from '../../../../src/types'
import {
  HARNESS_ME,
  installAppControllerClerum,
  renderAppController,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import {
  CATALOG_NOW,
  deferred,
  localIndex,
  serverSessions,
} from '../domain/__tests__/__fixtures__/catalogFixtures'
import { ipcHostAccessRevoked } from '../domain/__tests__/__fixtures__/ipcErrors'
import { type MockClerum, uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'
import { useChatStore } from '../useChatStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type ListSessionsQuery = { agent?: string; limit?: number; cursor?: string }

const HOST_A = 'agent-x'
const HOST_B = 'agent-y'
const PAGE_CURSOR = 'page-2'
const pageQuery = (agent: string): ListSessionsQuery => ({ agent, limit: 50 })
const cursorQuery = (): ListSessionsQuery => ({ ...pageQuery(HOST_A), cursor: PAGE_CURSOR })
const probeQuery = (agent: string): ListSessionsQuery => ({ agent, limit: 25 })

function callsFor(clerum: MockClerum, hostRef: string, query: ListSessionsQuery): number {
  return clerum.rpc.listSessions.mock.calls.filter(
    ([host, _teamId, actual]) =>
      host === hostRef &&
      actual?.agent === query.agent &&
      actual?.limit === query.limit &&
      actual?.cursor === query.cursor
  ).length
}

function installCatalogs() {
  const { clerum, handle } = installAppControllerClerum({ agentNames: [HOST_A, HOST_B] })
  const chatA = crypto.randomUUID()
  const chatB = crypto.randomUUID()
  clerum.chat.getIndex.mockImplementation(async (agentRef: string) =>
    localIndex([{ id: agentRef === HOST_A ? chatA : chatB, title: 'Known chat' }])
  )
  clerum.rpc.listSessions.mockImplementation(
    async (hostRef: string, _teamId: string | undefined, query?: ListSessionsQuery) =>
      serverSessions(
        [{ agent: hostRef, chatId: hostRef === HOST_A ? chatA : chatB, title: 'Known chat' }],
        query?.limit === 50 && !query.cursor ? PAGE_CURSOR : undefined
      )
  )
  clerum.rpc.loadSessionMessages.mockImplementation(
    async (hostRef: string, _agent: string, chatId: string) => ({
      agent: hostRef,
      chatId,
      state: 'idle',
      turns: [],
    })
  )
  return { clerum, handle, chatA, chatB }
}

describe('useAppController Host hold and the session catalog cache', () => {
  let unmount: (() => void) | null = null

  beforeEach(() => {
    // Fix only the cache clock; first-paint scheduling and promise consumers run.
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(CATALOG_NOW))
  })

  afterEach(() => {
    unmount?.()
    unmount = null
    vi.restoreAllMocks()
    uninstallMockClerum()
  })

  async function mountAppAndProbe() {
    const app = renderAppController()
    const probe = renderHook(() => useChatStore())
    unmount = () => {
      probe.unmount()
      app.unmount()
    }
    await waitFor(() => expect(app.result.current.booting).toBe(false))
    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
    return { app, probe }
  }

  it('R1 selected A revocation clears its view and both queries while retaining B', async () => {
    const { clerum, chatA } = installCatalogs()
    clerum.rpc.invokeHostMessage.mockResolvedValue({ response: 'Known reply' })
    clerum.rpc.renameSession.mockRejectedValue(await ipcHostAccessRevoked('rpc:renameSession'))
    const { app, probe } = await mountAppAndProbe()
    await waitFor(() => expect(app.result.current.latestChatSessions).toHaveLength(2))
    act(() => app.result.current.handleSelectChatAgent(HOST_A, { chatId: chatA }))
    await waitFor(() => expect(app.result.current.activeChatId).toBe(chatA))
    await act(async () => {
      await app.result.current.handleSelectChat(chatA)
      await app.result.current.handleSendAgentMessage('Known message')
    })
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledWith(
      HOST_A,
      expect.objectContaining({ content: 'Known message', threadId: chatA }),
      [HOST_A],
      { async: true }
    )
    expect(app.result.current.chatMessages.some(message => message.content === 'Known reply')).toBe(
      true
    )
    expect(app.result.current.chatList.some(chat => chat.id === chatA)).toBe(true)
    expect(app.result.current.latestChatSessions.some(chat => chat.agentRef === HOST_A)).toBe(true)

    // The successful send legitimately clears catalogs. Prime after it completes.
    const aQueries = [pageQuery(HOST_A), cursorQuery()]
    const bQuery = pageQuery(HOST_B)
    const beforeA = aQueries.map(query => callsFor(clerum, HOST_A, query))
    const beforeB = callsFor(clerum, HOST_B, bQuery)
    const warmA = aQueries.map(query => probe.result.current.listSessions(HOST_A, query))
    const warmB = probe.result.current.listSessions(HOST_B, bQuery)
    await Promise.all([...warmA, warmB])
    aQueries.forEach((query, index) => {
      expect(probe.result.current.listSessions(HOST_A, query)).toBe(warmA[index])
      expect(callsFor(clerum, HOST_A, query)).toBe(beforeA[index] + 1)
    })
    expect(probe.result.current.listSessions(HOST_B, bQuery)).toBe(warmB)
    expect(callsFor(clerum, HOST_B, bQuery)).toBe(beforeB + 1)

    await act(async () => {
      await app.result.current.handleRenameChatForAgent(HOST_A, chatA, 'Renamed chat')
    })
    expect(clerum.rpc.renameSession).toHaveBeenCalledWith(HOST_A, HOST_A, chatA, 'Renamed chat')
    expect(app.result.current.isHostAccessBlocked(HOST_A)).toBe(true)
    expect(app.result.current.isHostAccessBlocked(HOST_B)).toBe(false)
    expect(app.result.current.selectedAgent).toBeNull()
    expect(app.result.current.activeChatId).toBeNull()
    expect(app.result.current.chatMessages).toEqual([])
    expect(app.result.current.chatList).toEqual([])
    expect(app.result.current.latestChatSessions.some(chat => chat.agentRef === HOST_A)).toBe(false)
    expect(app.result.current.latestChatSessions.some(chat => chat.agentRef === HOST_B)).toBe(true)

    const freshA = aQueries.map(query => probe.result.current.listSessions(HOST_A, query))
    await Promise.all(freshA)
    aQueries.forEach((query, index) => {
      expect(freshA[index]).not.toBe(warmA[index])
      expect(callsFor(clerum, HOST_A, query)).toBe(beforeA[index] + 2)
    })
    expect(probe.result.current.listSessions(HOST_B, bQuery)).toBe(warmB)
    expect(callsFor(clerum, HOST_B, bQuery)).toBe(beforeB + 1)
  })

  it.each(
    (['catalog', 'rename', 'transcript', 'task-result'] as const).flatMap(path =>
      (['selected', 'nonselected'] as const).map(selection => ({ path, selection }))
    )
  )('R2 $path revocation targets A while A is $selection', async ({ path, selection }) => {
    const { clerum, chatA, chatB } = installCatalogs()
    const taskId = crypto.randomUUID()
    const fault = deferred<never>()
    const faultIssued = deferred<void>()
    const channel =
      path === 'catalog'
        ? 'rpc:listSessions'
        : path === 'rename'
          ? 'rpc:renameSession'
          : path === 'transcript'
            ? 'rpc:loadSessionMessages'
            : 'rpc:getTaskResult'
    const revoked = await ipcHostAccessRevoked(channel)
    let armed = false
    let faultCalls = 0
    const issueFault = () => {
      faultCalls += 1
      faultIssued.resolve(undefined)
      return fault.promise
    }
    const healthyCatalog = clerum.rpc.listSessions.getMockImplementation()!
    clerum.rpc.listSessions.mockImplementation(
      (hostRef: string, teamId: string | undefined, query?: ListSessionsQuery) => {
        if (armed && path === 'catalog' && hostRef === HOST_A && query?.cursor === PAGE_CURSOR)
          return issueFault()
        return healthyCatalog(hostRef, teamId, query)
      }
    )
    const healthyTranscript = clerum.rpc.loadSessionMessages.getMockImplementation()!
    clerum.rpc.loadSessionMessages.mockImplementation((hostRef: string, ...args: unknown[]) => {
      if (armed && path === 'transcript' && hostRef === HOST_A) return issueFault()
      return healthyTranscript(hostRef, ...args)
    })
    clerum.rpc.renameSession.mockImplementation(
      async (hostRef: string, _agent: string, _chatId: string, title: string) => {
        if (armed && path === 'rename' && hostRef === HOST_A) return issueFault()
        return { title }
      }
    )
    clerum.rpc.getTaskResult.mockImplementation(async (hostRef: string) => {
      if (armed && path === 'task-result' && hostRef === HOST_A) return issueFault()
      return { response: 'Known reply' }
    })
    clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId })
    const { app, probe } = await mountAppAndProbe()
    await waitFor(() => expect(app.result.current.latestChatSessions).toHaveLength(2))
    act(() => app.result.current.handleSelectChatAgent(HOST_A, { chatId: chatA }))
    await waitFor(() => expect(app.result.current.activeChatId).toBe(chatA))
    await act(async () => {
      await app.result.current.handleSelectChat(chatA)
    })
    await waitFor(() => expect(app.result.current.chatListHasMoreRemoteSessions).toBe(true))
    if (path === 'task-result') {
      await act(async () => {
        await app.result.current.handleSendAgentMessage('Recover this task')
      })
      await waitFor(() => expect(clerum.hasProgressHandler(taskId)).toBe(true))
      expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledWith(
        HOST_A,
        expect.objectContaining({ content: 'Recover this task', threadId: chatA }),
        [HOST_A],
        { async: true }
      )
    }

    armed = true
    let consumer!: Promise<void>
    act(() => {
      consumer =
        path === 'catalog'
          ? app.result.current.loadMoreChatSessions()
          : path === 'rename'
            ? app.result.current.handleRenameChatForAgent(HOST_A, chatA, 'Renamed chat')
            : app.result.current.handleSelectChat(chatA)
    })
    await act(async () => {
      await faultIssued.promise
    })
    expect(faultCalls).toBe(1)
    if (path === 'catalog') {
      expect(clerum.rpc.listSessions).toHaveBeenCalledWith(HOST_A, undefined, cursorQuery())
    } else if (path === 'rename') {
      expect(clerum.rpc.renameSession).toHaveBeenCalledWith(HOST_A, HOST_A, chatA, 'Renamed chat')
    } else if (path === 'transcript') {
      expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith(
        HOST_A,
        HOST_A,
        chatA,
        undefined,
        expect.objectContaining({ limit: 40 })
      )
    } else {
      expect(clerum.rpc.getTaskResult).toHaveBeenCalledWith(HOST_A, taskId, [HOST_A])
    }
    if (selection === 'nonselected') {
      act(() => app.result.current.handleSelectChatAgent(HOST_B, { chatId: chatB }))
      await waitFor(() => expect(app.result.current.selectedAgent).toBe(HOST_B))
      await waitFor(() => expect(app.result.current.activeChatId).toBe(chatB))
      await act(async () => {
        await app.result.current.handleSelectChat(chatB)
      })
    }

    // Prime after send setup and selection have finished, while the fault awaits.
    const aQuery = probeQuery(HOST_A)
    const bQuery = probeQuery(HOST_B)
    const warmA = probe.result.current.listSessions(HOST_A, aQuery)
    const warmB = probe.result.current.listSessions(HOST_B, bQuery)
    await Promise.all([warmA, warmB])
    expect(probe.result.current.listSessions(HOST_A, aQuery)).toBe(warmA)
    expect(probe.result.current.listSessions(HOST_B, bQuery)).toBe(warmB)
    expect(callsFor(clerum, HOST_A, aQuery)).toBe(1)
    expect(callsFor(clerum, HOST_B, bQuery)).toBe(1)
    expect(app.result.current.isHostAccessBlocked(HOST_A)).toBe(false)
    expect(app.result.current.isHostAccessBlocked(HOST_B)).toBe(false)

    await act(async () => {
      fault.reject(revoked)
      await consumer
    })
    expect(faultCalls).toBe(1)
    expect(app.result.current.isHostAccessBlocked(HOST_A)).toBe(true)
    expect(app.result.current.isHostAccessBlocked(HOST_B)).toBe(false)
    expect(app.result.current.selectedAgent).toBe(selection === 'selected' ? null : HOST_B)
    const freshA = probe.result.current.listSessions(HOST_A, aQuery)
    await freshA
    expect(freshA).not.toBe(warmA)
    expect(callsFor(clerum, HOST_A, aQuery)).toBe(2)
    expect(probe.result.current.listSessions(HOST_B, bQuery)).toBe(warmB)
    await expect(warmB).resolves.toEqual(
      serverSessions([{ agent: HOST_B, chatId: chatB, title: 'Known chat' }])
    )
    expect(callsFor(clerum, HOST_B, bQuery)).toBe(1)
    if (selection === 'nonselected') {
      expect(app.result.current.activeChatId).toBe(chatB)
      expect(app.result.current.chatList.some(chat => chat.id === chatB)).toBe(true)
    }
  })

  it('R3 B publishes its pending catalog and an old A rejection cannot rehold or evict fresh A', async () => {
    const { clerum, chatA, chatB } = installCatalogs()
    // Hold this AppController's Latest consumer until normal setup has finished.
    // B has no local row: only its own pending server response can publish it.
    const pendingBIndex = deferred<ReturnType<typeof localIndex>>()
    clerum.chat.getIndex.mockImplementation(async (agentRef: string) =>
      agentRef === HOST_A ? localIndex([{ id: chatA, title: 'Known chat' }]) : pendingBIndex.promise
    )
    const pendingA = deferred<SessionsListResult>()
    const pendingB = deferred<SessionsListResult>()
    const healthyCatalog = clerum.rpc.listSessions.getMockImplementation()!
    let aCursorReads = 0
    let bCatalogPending = false
    let pendingBReads = 0
    const setupBRequests: Array<Promise<SessionsListResult>> = []
    clerum.rpc.listSessions.mockImplementation(
      (hostRef: string, teamId: string | undefined, query?: ListSessionsQuery) => {
        if (hostRef === HOST_A && query?.cursor === PAGE_CURSOR) {
          aCursorReads += 1
          if (aCursorReads === 1) return pendingA.promise
        }
        if (hostRef === HOST_B && query?.limit === 50 && !query.cursor) {
          if (bCatalogPending) {
            pendingBReads += 1
            return pendingB.promise
          }
          const setupRequest = healthyCatalog(hostRef, teamId, query)
          setupBRequests.push(setupRequest)
          return setupRequest
        }
        return healthyCatalog(hostRef, teamId, query)
      }
    )
    clerum.rpc.renameSession.mockRejectedValue(await ipcHostAccessRevoked('rpc:renameSession'))
    const staleRevocation = await ipcHostAccessRevoked('rpc:listSessions')
    clerum.rpc.invokeHostMessage.mockResolvedValue({ response: 'R3 setup reply' })
    const { app, probe } = await mountAppAndProbe()
    await waitFor(() => expect(app.result.current.runtimeConfigState).not.toBeNull())
    await waitFor(() => expect(app.result.current.latestChatSessionsLoading).toBe(true))
    act(() => app.result.current.handleSelectChatAgent(HOST_A, { chatId: chatA }))
    await waitFor(() => expect(app.result.current.activeChatId).toBe(chatA))
    await waitFor(() => expect(app.result.current.chatListHasMoreRemoteSessions).toBe(true))
    await act(async () => {
      await app.result.current.handleSelectChat(chatA)
      await app.result.current.handleSendAgentMessage('Complete R3 setup')
    })
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledWith(
      HOST_A,
      expect.objectContaining({ content: 'Complete R3 setup', threadId: chatA }),
      [HOST_A],
      { async: true }
    )
    expect(
      app.result.current.chatMessages.some(message => message.content === 'R3 setup reply')
    ).toBe(true)
    // Earlier bridge reads completed during setup. The successful send above
    // legitimately clears their catalogs before the unchanged-scope experiment.
    await Promise.all(setupBRequests)
    const setupBReads = callsFor(clerum, HOST_B, pageQuery(HOST_B))
    expect(setupBRequests).toHaveLength(setupBReads)
    const readScope = () => ({
      authenticated: app.result.current.isAuthenticated,
      environmentKey: app.result.current.runtimeConfigState?.envKey ?? '',
      userId: app.result.current.me?.id,
      teamId: app.result.current.currentTeamId,
    })
    const catalogScope = readScope()
    expect(catalogScope).toEqual({
      authenticated: true,
      environmentKey: '',
      userId: HARNESS_ME.id,
      teamId: HARNESS_ME.teamId,
    })
    const catalogSource = window.clerum.rpc.listSessions
    await act(async () => {
      bCatalogPending = true
      pendingBIndex.resolve(localIndex([]))
    })
    await waitFor(() => expect(pendingBReads).toBe(1))
    const bReadsAtHold = callsFor(clerum, HOST_B, pageQuery(HOST_B))
    expect(bReadsAtHold).toBe(setupBReads + 1)
    let oldConsumer!: Promise<void>
    act(() => {
      oldConsumer = app.result.current.loadMoreChatSessions()
    })
    await waitFor(() => expect(callsFor(clerum, HOST_A, cursorQuery())).toBe(1))
    const staleA = probe.result.current.listSessions(HOST_A, cursorQuery())
    const staleOutcome = staleA.catch(error => error)
    const warmB = probe.result.current.listSessions(HOST_B, pageQuery(HOST_B))
    expect(probe.result.current.listSessions(HOST_A, cursorQuery())).toBe(staleA)
    expect(probe.result.current.listSessions(HOST_B, pageQuery(HOST_B))).toBe(warmB)
    expect(callsFor(clerum, HOST_A, cursorQuery())).toBe(1)
    expect(callsFor(clerum, HOST_B, pageQuery(HOST_B))).toBe(bReadsAtHold)
    expect(pendingBReads).toBe(1)
    expect(app.result.current.chatListMoreLoading).toBe(true)

    await act(async () => {
      await app.result.current.handleRenameChatForAgent(HOST_A, chatA, 'Renamed chat')
    })
    expect(clerum.rpc.renameSession).toHaveBeenCalledWith(HOST_A, HOST_A, chatA, 'Renamed chat')
    expect(app.result.current.isHostAccessBlocked(HOST_A)).toBe(true)
    expect(app.result.current.isHostAccessBlocked(HOST_B)).toBe(false)
    expect(readScope()).toEqual(catalogScope)
    expect(window.clerum.rpc.listSessions).toBe(catalogSource)
    expect(probe.result.current.listSessions(HOST_B, pageQuery(HOST_B))).toBe(warmB)
    await act(async () => {
      pendingB.resolve(
        serverSessions([{ agent: HOST_B, chatId: chatB, title: 'Pending B result' }])
      )
      await warmB
    })
    await waitFor(() =>
      expect(app.result.current.latestChatSessions).toEqual([
        expect.objectContaining({ agentRef: HOST_B, id: chatB, title: 'Pending B result' }),
      ])
    )
    expect(callsFor(clerum, HOST_B, pageQuery(HOST_B))).toBe(bReadsAtHold)
    expect(pendingBReads).toBe(1)

    act(() => app.result.current.handleSelectChatAgent(HOST_A, { selectLatest: false }))
    await waitFor(() => expect(app.result.current.isHostAccessBlocked(HOST_A)).toBe(false))
    await waitFor(() => expect(app.result.current.selectedAgent).toBe(HOST_A))
    expect(clerum.rpc.listSessions).toHaveBeenCalledWith(HOST_A, undefined, {
      agent: HOST_A,
      limit: 1,
    })
    const freshA = probe.result.current.listSessions(HOST_A, cursorQuery())
    expect(freshA).not.toBe(staleA)
    await freshA
    expect(callsFor(clerum, HOST_A, cursorQuery())).toBe(2)
    expect(probe.result.current.listSessions(HOST_A, cursorQuery())).toBe(freshA)

    await act(async () => {
      pendingA.reject(staleRevocation)
      await oldConsumer
      expect(await staleOutcome).toBe(staleRevocation)
    })
    expect(app.result.current.isHostAccessBlocked(HOST_A)).toBe(false)
    expect(app.result.current.isHostAccessBlocked(HOST_B)).toBe(false)
    expect(readScope()).toEqual(catalogScope)
    expect(window.clerum.rpc.listSessions).toBe(catalogSource)
    expect(probe.result.current.listSessions(HOST_A, cursorQuery())).toBe(freshA)
    expect(callsFor(clerum, HOST_A, cursorQuery())).toBe(2)
    expect(probe.result.current.listSessions(HOST_B, pageQuery(HOST_B))).toBe(warmB)
    expect(callsFor(clerum, HOST_B, pageQuery(HOST_B))).toBe(bReadsAtHold)
    expect(pendingBReads).toBe(1)
  })

  it.each(['environment', 'user', 'team', 'logout'] as const)(
    'R4 coordinator %s boundary refetches both hot Hosts',
    async boundary => {
      const { clerum, handle } = installCatalogs()
      const runtimeState = {
        ...(await window.clerum.auth.getRuntimeConfigState()),
        envKey: 'env-before',
      }
      vi.mocked(window.clerum.auth.getRuntimeConfigState).mockResolvedValue(runtimeState)
      const { app, probe } = await mountAppAndProbe()
      await waitFor(() => expect(app.result.current.runtimeConfigState?.envKey).toBe('env-before'))
      await waitFor(() => expect(app.result.current.latestChatSessions).toHaveLength(2))
      const hosts = [HOST_A, HOST_B]
      const warm = hosts.map(host => probe.result.current.listSessions(host, probeQuery(host)))
      await Promise.all(warm)
      hosts.forEach((host, index) => {
        expect(probe.result.current.listSessions(host, probeQuery(host))).toBe(warm[index])
        expect(callsFor(clerum, host, probeQuery(host))).toBe(1)
      })

      await act(async () => {
        if (boundary === 'environment') {
          vi.mocked(window.clerum.auth.getRuntimeConfigState).mockResolvedValue({
            ...runtimeState,
            envKey: 'env-after',
          })
          await app.result.current.loadSession()
        } else if (boundary === 'user') {
          handle.getSessionState.mockResolvedValue({
            authenticated: true,
            me: { ...HARNESS_ME, id: 'next-user' },
          })
          await app.result.current.loadSession()
        } else if (boundary === 'team') {
          await app.result.current.handleEnsureTeamContext({ teamId: 'next-team' })
        } else {
          handle.getSessionState.mockResolvedValue({ authenticated: false, me: null })
          await app.result.current.handleLogout()
        }
      })
      if (boundary === 'environment') {
        await waitFor(() => expect(app.result.current.runtimeConfigState?.envKey).toBe('env-after'))
      } else if (boundary === 'user') {
        expect(app.result.current.me?.id).toBe('next-user')
      } else if (boundary === 'team') {
        expect(handle.switchTeam).toHaveBeenCalledWith('next-team')
        expect(app.result.current.currentTeamId).toBe('next-team')
      } else {
        expect(window.clerum.auth.logout).toHaveBeenCalledOnce()
        expect(app.result.current.isAuthenticated).toBe(false)
      }
      const fresh = hosts.map(host => probe.result.current.listSessions(host, probeQuery(host)))
      await Promise.all(fresh)
      hosts.forEach((host, index) => {
        expect(fresh[index]).not.toBe(warm[index])
        expect(callsFor(clerum, host, probeQuery(host))).toBe(2)
      })
    }
  )
})
