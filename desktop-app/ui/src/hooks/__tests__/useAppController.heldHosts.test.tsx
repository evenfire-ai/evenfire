// @vitest-environment jsdom
/**
 * Held Hosts in the coordinator: auto-selection skips them (H1), they are
 * exposed as `heldAgentRefs` for the sidebar's Retry row (F1), a failed access
 * verification is reported (F2), and losing access to the selected Host says
 * why the selection was cleared (F3).
 *
 * Holds are produced the way production produces them: a catalog or
 * transcript read that the real RPC client rejects with a 403.
 */
import { useLayoutEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useNavigationContext } from '@contexts/NavigationContext'
import type { QueryClient } from '@tanstack/react-query'
import { act, cleanup, waitFor } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { ChatPage } from '@pages/ChatPage'
import type { SessionsListResult } from '../../../../src/types'
import {
  type AppControllerClerumHandle,
  createCatalog,
  installAppControllerClerum,
  renderAppController,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import { deferred, serverSessions } from '../domain/__tests__/__fixtures__/catalogFixtures'
import { renderChatActionConsumer } from '../domain/__tests__/__fixtures__/chatActionConsumerHarness'
import {
  ipcGenericForbidden,
  ipcHostAccessRevoked,
} from '../domain/__tests__/__fixtures__/ipcErrors'
import { type MockClerum, uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'
import { desktopQueryKeys } from '../domain/queryKeys'
import type { useAppController } from '../useAppController'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The ChatPage tests below only need its auto-selection, not the workspace it renders.
vi.mock('@components/agents/AgentWorkspace', () => ({ AgentWorkspace: () => null }))

type Vm = ReturnType<typeof useAppController>
type ListSessionsQuery = { agent?: string; limit?: number; cursor?: string }

const HOST_A = 'agent-a'
const HOST_B = 'agent-b'
// Visible names distinct from the refs, so a toast that used the ref would fail.
const DISPLAY_A = 'Research Host'
const DISPLAY_B = 'Billing Host'
const DISPLAY_BY_NAME = { [HOST_A]: DISPLAY_A, [HOST_B]: DISPLAY_B }
// A catalog that dropped A also drops its name, so a toast can only take it from the previous one.
const DISPLAY_B_ONLY = { [HOST_B]: DISPLAY_B }
const RETRY_A = `Could not verify access to ${DISPLAY_A}. Use Retry in Latest sessions.`
const GONE_A = `${DISPLAY_A} is no longer available.`

/**
 * A `listSessions` double. Page reads (`limit: 50`) of a denied Host reject
 * with its error once `openGate()` ran; every other page read resolves empty.
 * Verification reads (`limit: 1`) answer with `verify`.
 */
function installCatalog(clerum: MockClerum) {
  const denied = new Map<string, Error>()
  const gate = deferred<void>()
  const pageReads = new Map<string, number>()
  const verifyReads = new Map<string, number>()
  let verify: (agentRef: string) => Promise<SessionsListResult> = async () => serverSessions([])
  clerum.rpc.listSessions.mockImplementation(
    async (hostRef: string, _teamId: string | undefined, query?: ListSessionsQuery) => {
      if (query?.limit === 1) {
        verifyReads.set(hostRef, (verifyReads.get(hostRef) ?? 0) + 1)
        return verify(hostRef)
      }
      pageReads.set(hostRef, (pageReads.get(hostRef) ?? 0) + 1)
      const error = denied.get(hostRef)
      if (!error) return serverSessions([])
      await gate.promise
      throw error
    }
  )
  return {
    deny: (agentRef: string, error: Error) => denied.set(agentRef, error),
    allow: (agentRef: string) => denied.delete(agentRef),
    openGate: () => gate.resolve(),
    setVerify: (next: typeof verify) => {
      verify = next
    },
    pageReads: (agentRef: string) => pageReads.get(agentRef) ?? 0,
    verifyReads: (agentRef: string) => verifyReads.get(agentRef) ?? 0,
  }
}

function toastTexts(vm: Vm): string[] {
  return vm.toasts.map(toast => toast.text)
}

/** Every toast any commit showed, once each, in order (the stack keeps only three). */
function toastsSeen(commits: Vm[]): string[] {
  const seen = new Map<number, string>()
  for (const vm of commits) for (const toast of vm.toasts) seen.set(toast.id, toast.text)
  return [...seen.values()]
}

function cachedCatalog(queryClient: QueryClient) {
  return queryClient.getQueryData<{ teamId: string | null; agentNames: string[] }>(
    desktopQueryKeys.accessCatalog
  )
}

async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
  })
}

describe('useAppController held Hosts', () => {
  let unmount: (() => void) | null = null

  afterEach(() => {
    unmount?.()
    unmount = null
    vi.restoreAllMocks()
    uninstallMockClerum()
  })

  async function mount(
    clerum: MockClerum,
    handle: AppControllerClerumHandle
  ): Promise<{ app: ReturnType<typeof renderAppController>; commits: Vm[] }> {
    const commits: Vm[] = []
    const app = renderAppController({ onCommit: vm => commits.push(vm) })
    unmount = app.unmount
    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
    expect(handle.refreshCatalog).toHaveBeenCalled()
    expect(clerum.rpc.listSessions).toHaveBeenCalled()
    return { app, commits }
  }

  /** Hold `agentRef` through a cross-agent catalog read that gets a generic 403. */
  async function holdThroughCatalog(
    app: ReturnType<typeof renderAppController>,
    catalog: ReturnType<typeof installCatalog>,
    agentRef: string
  ) {
    await act(async () => {
      catalog.openGate()
    })
    await waitFor(() => expect(app.result.current.isHostAccessBlocked(agentRef)).toBe(true))
    catalog.allow(agentRef)
  }

  it('T-H1-3: exposes the held Host in every cleared-selection commit and drops it on Retry', async () => {
    const { clerum, handle } = installAppControllerClerum({ agentNames: [HOST_A, HOST_B] })
    const catalog = installCatalog(clerum)
    catalog.deny(HOST_B, await ipcGenericForbidden('rpc:listSessions'))
    const { app, commits } = await mount(clerum, handle)

    act(() => {
      app.result.current.handleSelectChatAgent(HOST_B, { selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.selectedAgent).toBe(HOST_B))
    await waitFor(() => expect(catalog.pageReads(HOST_B)).toBeGreaterThan(0))
    const refreshesBeforeHold = handle.refreshCatalog.mock.calls.length
    const firstCommitAfterRejection = commits.length

    await holdThroughCatalog(app, catalog, HOST_B)
    await waitFor(() => expect(app.result.current.selectedAgent).toBe(null))

    // (1) Liveness witness: B is held and at least one commit cleared the selection.
    const clearedCommits = commits
      .slice(firstCommitAfterRejection)
      .filter(vm => vm.selectedAgent === null)
    expect(clearedCommits.length).toBeGreaterThan(0)
    for (const vm of clearedCommits) expect(vm.heldAgentRefs).toContain(HOST_B)

    // (2) The agent-catalog refresh of that hold settles with stable agent names.
    await waitFor(() =>
      expect(handle.refreshCatalog.mock.calls.length).toBe(refreshesBeforeHold + 1)
    )
    await act(async () => {
      await handle.refreshCatalog.mock.results.at(-1)?.value
    })
    // The controller reads agent names from this query (`useAgentsDataController`).
    expect(
      app.queryClient.getQueryData<{ agentNames: string[] }>(desktopQueryKeys.accessCatalog)
        ?.agentNames
    ).toEqual([HOST_A, HOST_B])

    act(() => {
      app.result.current.handleSelectChatAgent(HOST_B, { selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.selectedAgent).toBe(HOST_B))
    expect(catalog.verifyReads(HOST_B)).toBe(1)
    expect(app.result.current.isHostAccessBlocked(HOST_B)).toBe(false)
    expect(app.result.current.heldAgentRefs).toEqual([])
  })

  it('T-H1-4: Chat with no focused chat skips the held most recent Host', async () => {
    const { clerum, handle } = installAppControllerClerum({ agentNames: [HOST_A, HOST_B] })
    const catalog = installCatalog(clerum)
    catalog.deny(HOST_A, await ipcGenericForbidden('rpc:listSessions'))
    const { app } = await mount(clerum, handle)

    act(() => {
      app.result.current.handleNavSelect(DESKTOP_ROUTES.connectors)
    })
    expect(app.result.current.selectedAgent).toBe(null)
    await holdThroughCatalog(app, catalog, HOST_A)

    act(() => {
      app.result.current.handleNavSelect(DESKTOP_ROUTES.chat)
    })
    // Liveness witness: the auto-selection ran and picked a Host.
    await waitFor(() => expect(app.result.current.selectedAgent).not.toBe(null))
    expect(app.result.current.selectedAgent).toBe(HOST_B)
    expect(catalog.verifyReads(HOST_A)).toBe(0)
  })

  it('T-F2-1: a failed access verification is reported and keeps the Host held', async () => {
    const { clerum, handle } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: DISPLAY_BY_NAME,
    })
    const catalog = installCatalog(clerum)
    catalog.deny(HOST_B, await ipcGenericForbidden('rpc:listSessions'))
    const { app } = await mount(clerum, handle)
    await holdThroughCatalog(app, catalog, HOST_B)
    const verificationError = await ipcGenericForbidden('rpc:listSessions')
    catalog.setVerify(async () => {
      throw verificationError
    })
    const warn = vi.spyOn(console, 'warn')
    const selectedBefore = app.result.current.selectedAgent

    act(() => {
      app.result.current.handleSelectChatAgent(HOST_B, { selectLatest: false })
    })
    await waitFor(() => expect(catalog.verifyReads(HOST_B)).toBe(1))
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })

    expect(toastTexts(app.result.current)).toContain(`Could not verify access to ${DISPLAY_B}.`)
    expect(warn).toHaveBeenCalledWith('[host-authority] access verification failed', {
      agentRef: HOST_B,
      status: 403,
    })
    expect(app.result.current.isHostAccessBlocked(HOST_B)).toBe(true)
    expect(app.result.current.selectedAgent).toBe(selectedBefore)
    expect(app.result.current.selectedAgent).not.toBe(HOST_B)
  })

  it('T-F2-2: a verification that fails after the scope changed warns without a toast', async () => {
    const { clerum, handle } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: DISPLAY_BY_NAME,
    })
    const catalog = installCatalog(clerum)
    catalog.deny(HOST_B, await ipcGenericForbidden('rpc:listSessions'))
    const { app } = await mount(clerum, handle)
    await holdThroughCatalog(app, catalog, HOST_B)
    const pendingVerification = deferred<SessionsListResult>()
    catalog.setVerify(() => pendingVerification.promise)
    const warn = vi.spyOn(console, 'warn')

    act(() => {
      app.result.current.handleSelectChatAgent(HOST_B, { selectLatest: false })
    })
    await waitFor(() => expect(catalog.verifyReads(HOST_B)).toBe(1))

    await act(async () => {
      await app.result.current.handleEnsureTeamContext({ teamId: 'team-2' })
    })
    expect(handle.switchTeam).toHaveBeenCalledWith('team-2')
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    await act(async () => {
      pendingVerification.reject(await ipcGenericForbidden('rpc:listSessions'))
      await pendingVerification.promise.catch(() => undefined)
      await new Promise(resolve => setTimeout(resolve, 20))
    })

    // Liveness witness: the rejection reached the verification's catch.
    expect(warn).toHaveBeenCalledWith('[host-authority] access verification failed', {
      agentRef: HOST_B,
      status: 403,
    })
    expect(toastTexts(app.result.current)).not.toContain(`Could not verify access to ${DISPLAY_B}.`)
  })

  it.each([
    [
      'a generic 403',
      () => ipcGenericForbidden('rpc:loadSessionMessages'),
      `Could not verify access to ${DISPLAY_A}. Use Retry in Latest sessions.`,
    ],
    [
      'host_access_revoked',
      () => ipcHostAccessRevoked('rpc:loadSessionMessages'),
      `Access to ${DISPLAY_A} was revoked.`,
    ],
  ])(
    'T-F3-1: losing the selected Host to %s clears the selection with a toast',
    async (_label, rejection, expectedToast) => {
      const { clerum, handle } = installAppControllerClerum({
        agentNames: [HOST_A, HOST_B],
        agentDisplayByName: DISPLAY_BY_NAME,
      })
      installCatalog(clerum)
      const transcriptError = await rejection()
      clerum.rpc.loadSessionMessages.mockImplementation(async (hostRef: string) => {
        if (hostRef === HOST_A) throw transcriptError
        return { agent: hostRef, chatId: '', turns: [] }
      })
      const { app } = await mount(clerum, handle)

      act(() => {
        app.result.current.handleSelectChatAgent(HOST_A, { chatId: 'chat-1', selectLatest: false })
      })
      await waitFor(() => expect(app.result.current.isHostAccessBlocked(HOST_A)).toBe(true))
      // Liveness witness: the hold cleared the selection.
      await waitFor(() => expect(app.result.current.selectedAgent).toBe(null))
      expect(
        clerum.rpc.loadSessionMessages.mock.calls.some(
          ([hostRef, , chatId]) => hostRef === HOST_A && chatId === 'chat-1'
        )
      ).toBe(true)

      // An uncertain hold names the Retry row only after its own catalog
      // refresh shows the Host is still listed, so the toast can come later.
      await waitFor(() => expect(toastTexts(app.result.current)).toContain(expectedToast))
    }
  )

  it('T-F3-2: losing a Host that is not selected shows no toast', async () => {
    const { clerum, handle } = installAppControllerClerum({ agentNames: [HOST_A, HOST_B] })
    const catalog = installCatalog(clerum)
    catalog.deny(HOST_B, await ipcGenericForbidden('rpc:listSessions'))
    const { app } = await mount(clerum, handle)

    act(() => {
      app.result.current.handleSelectChatAgent(HOST_A, { selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.selectedAgent).toBe(HOST_A))
    await holdThroughCatalog(app, catalog, HOST_B)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })

    // Liveness witness: B is held and exposed; A is still selected.
    expect(app.result.current.heldAgentRefs).toContain(HOST_B)
    expect(app.result.current.selectedAgent).toBe(HOST_A)
    expect(
      toastTexts(app.result.current).filter(
        text => text.includes(HOST_B) || text.includes('access')
      )
    ).toEqual([])
  })

  /** Make every transcript read of `HOST_A` reject with a generic 403. */
  async function denyTranscriptOfA(clerum: MockClerum) {
    const transcriptError = await ipcGenericForbidden('rpc:loadSessionMessages')
    clerum.rpc.loadSessionMessages.mockImplementation(async (hostRef: string) => {
      if (hostRef === HOST_A) throw transcriptError
      return { agent: hostRef, chatId: '', turns: [] }
    })
  }

  /** Open a chat of the selected `HOST_A`; its transcript 403 holds A as uncertain. */
  async function holdSelectedAThroughTranscript(app: ReturnType<typeof renderAppController>) {
    act(() => {
      app.result.current.handleSelectChatAgent(HOST_A, { chatId: 'chat-1', selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.isHostAccessBlocked(HOST_A)).toBe(true))
    await waitFor(() => expect(app.result.current.selectedAgent).toBe(null))
  }

  it('T-A9-P1-1: an uncertain hold whose refresh drops the selected Host says it is no longer available', async () => {
    const { clerum, handle } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: DISPLAY_BY_NAME,
    })
    installCatalog(clerum)
    await denyTranscriptOfA(clerum)
    const { app, commits } = await mount(clerum, handle)
    const refreshesBeforeHold = handle.refreshCatalog.mock.calls.length
    handle.refreshCatalog.mockImplementation(async () => createCatalog([HOST_B], DISPLAY_B_ONLY))

    await holdSelectedAThroughTranscript(app)
    await waitFor(() => expect(toastsSeen(commits)).toContain(GONE_A))
    await settle()

    // Liveness witness: the hold's own refresh ran and its catalog no longer lists A.
    expect(handle.refreshCatalog.mock.calls.length).toBe(refreshesBeforeHold + 1)
    expect(cachedCatalog(app.queryClient)?.agentNames).toEqual([HOST_B])
    expect(app.result.current.isHostAccessBlocked(HOST_A)).toBe(true)
    // No Retry row exists, so the toast must not point at one.
    expect(app.result.current.heldAgentRefs).toEqual([])
    expect(toastsSeen(commits)).toEqual([GONE_A])
  })

  it('T-A9-P1-2: an uncertain hold of a Host that stays listed points at Retry once its refresh settles', async () => {
    const { clerum, handle } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: DISPLAY_BY_NAME,
    })
    installCatalog(clerum)
    await denyTranscriptOfA(clerum)
    const { app, commits } = await mount(clerum, handle)
    const refreshesBeforeHold = handle.refreshCatalog.mock.calls.length
    const pendingCatalog = deferred<ReturnType<typeof createCatalog>>()
    handle.refreshCatalog.mockImplementation(() => pendingCatalog.promise)

    await holdSelectedAThroughTranscript(app)
    await waitFor(() =>
      expect(handle.refreshCatalog.mock.calls.length).toBe(refreshesBeforeHold + 1)
    )
    await settle()
    // Liveness witness above: A is held, deselected and its refresh is in flight.
    // Until that refresh settles there is no catalog to say whether Retry exists.
    expect(toastsSeen(commits)).toEqual([])

    await act(async () => {
      pendingCatalog.resolve(createCatalog([HOST_A, HOST_B], DISPLAY_BY_NAME))
      await pendingCatalog.promise
    })
    await waitFor(() => expect(toastsSeen(commits)).toEqual([RETRY_A]))
    await settle()
    expect(app.result.current.heldAgentRefs).toEqual([HOST_A])
    expect(toastsSeen(commits)).toEqual([RETRY_A])
  })

  it('T-A9-P1-4: a failed refresh keeps the listed Host and its Retry row, so the toast points at Retry', async () => {
    const { clerum, handle } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: DISPLAY_BY_NAME,
    })
    installCatalog(clerum)
    await denyTranscriptOfA(clerum)
    const { app, commits } = await mount(clerum, handle)
    const refreshesBeforeHold = handle.refreshCatalog.mock.calls.length
    handle.refreshCatalog.mockImplementation(async () => {
      throw new Error('catalog unavailable')
    })

    await holdSelectedAThroughTranscript(app)
    await waitFor(() => expect(toastsSeen(commits)).toContain(RETRY_A))
    await settle()

    // Liveness witness: the hold's refresh ran and failed, and the catalog on
    // screen is still the previous one, which lists A with its Retry row.
    expect(handle.refreshCatalog.mock.calls.length).toBe(refreshesBeforeHold + 1)
    expect(app.queryClient.getQueryState(desktopQueryKeys.accessCatalog)?.error?.message).toBe(
      'catalog unavailable'
    )
    expect(cachedCatalog(app.queryClient)?.agentNames).toEqual([HOST_A, HOST_B])
    expect(app.result.current.heldAgentRefs).toEqual([HOST_A])
    expect(toastsSeen(commits)).toEqual([RETRY_A])
  })

  it('T-A9-P1-3: a hold released by Retry before its refresh settles gets no stale toast', async () => {
    const { clerum, handle } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: DISPLAY_BY_NAME,
    })
    const catalog = installCatalog(clerum)
    await denyTranscriptOfA(clerum)
    const { app, commits } = await mount(clerum, handle)
    const refreshesBeforeHold = handle.refreshCatalog.mock.calls.length
    const pendingCatalog = deferred<ReturnType<typeof createCatalog>>()
    handle.refreshCatalog.mockImplementation(() => pendingCatalog.promise)

    await holdSelectedAThroughTranscript(app)
    await waitFor(() =>
      expect(handle.refreshCatalog.mock.calls.length).toBe(refreshesBeforeHold + 1)
    )
    clerum.rpc.loadSessionMessages.mockImplementation(async (hostRef: string) => ({
      agent: hostRef,
      chatId: '',
      turns: [],
    }))
    act(() => {
      app.result.current.handleSelectChatAgent(HOST_A, { selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.selectedAgent).toBe(HOST_A))

    await act(async () => {
      pendingCatalog.resolve(createCatalog([HOST_A, HOST_B], DISPLAY_BY_NAME))
      await pendingCatalog.promise
    })
    await settle()

    // Liveness witness: the Retry verification released A and the refresh settled.
    expect(catalog.verifyReads(HOST_A)).toBe(1)
    expect(app.result.current.isHostAccessBlocked(HOST_A)).toBe(false)
    expect(cachedCatalog(app.queryClient)?.agentNames).toEqual([HOST_A, HOST_B])
    expect(app.result.current.selectedAgent).toBe(HOST_A)
    expect(toastsSeen(commits)).toEqual([])
  })

  it.each([
    {
      id: 'T-A9-F1',
      second: 'generic 403',
      secondError: () => ipcGenericForbidden('rpc:loadSessionMessages'),
      catalogAfter: [HOST_A, HOST_B],
      toast: RETRY_A,
      held: [HOST_A],
    },
    {
      id: 'T-A9-F1b',
      second: 'revocation',
      secondError: () => ipcHostAccessRevoked('rpc:loadSessionMessages'),
      catalogAfter: [HOST_B],
      toast: GONE_A,
      held: [],
    },
  ])(
    '$id: a $second of the held Host before its refresh settles keeps the one toast',
    async ({ secondError, catalogAfter, toast, held }) => {
      const { clerum, handle } = installAppControllerClerum({
        agentNames: [HOST_A, HOST_B],
        agentDisplayByName: DISPLAY_BY_NAME,
      })
      installCatalog(clerum)
      const errorByChat = new Map([
        ['chat-1', await ipcGenericForbidden('rpc:loadSessionMessages')],
        ['chat-2', await secondError()],
      ])
      const transcripts = new Map<string, ReturnType<typeof deferred<void>>>()
      clerum.rpc.loadSessionMessages.mockImplementation(
        async (hostRef: string, _agent: string, chatId: string) => {
          if (hostRef !== HOST_A) return { agent: hostRef, chatId: '', turns: [] }
          const pending = deferred<void>()
          transcripts.set(chatId, pending)
          await pending.promise
          throw errorByChat.get(chatId)
        }
      )
      const { app, commits } = await mount(clerum, handle)
      const refreshesBeforeHold = handle.refreshCatalog.mock.calls.length
      const pendingCatalog = deferred<ReturnType<typeof createCatalog>>()
      handle.refreshCatalog.mockImplementation(() => pendingCatalog.promise)

      // Two transcript reads of A in flight at once (different chats).
      act(() => {
        app.result.current.handleSelectChatAgent(HOST_A, { chatId: 'chat-1', selectLatest: false })
      })
      await waitFor(() => expect(transcripts.has('chat-1')).toBe(true))
      act(() => {
        app.result.current.handleSelectChatAgent(HOST_A, { chatId: 'chat-2', selectLatest: false })
      })
      await waitFor(() => expect(transcripts.has('chat-2')).toBe(true))

      await act(async () => {
        transcripts.get('chat-1')?.resolve()
      })
      await waitFor(() => expect(app.result.current.isHostAccessBlocked(HOST_A)).toBe(true))
      await waitFor(() => expect(app.result.current.selectedAgent).toBe(null))
      await waitFor(() =>
        expect(handle.refreshCatalog.mock.calls.length).toBe(refreshesBeforeHold + 1)
      )
      await act(async () => {
        transcripts.get('chat-2')?.resolve()
      })
      await settle()
      expect(toastsSeen(commits)).toEqual([])

      await act(async () => {
        pendingCatalog.resolve(
          createCatalog(
            catalogAfter,
            catalogAfter.includes(HOST_A) ? DISPLAY_BY_NAME : DISPLAY_B_ONLY
          )
        )
        await pendingCatalog.promise
      })
      await waitFor(() => expect(toastsSeen(commits)).toEqual([toast]))
      await settle()

      // Liveness witness: both transcript reads of A ran and failed, A stays held,
      // and the second denial joined the refresh already in flight.
      expect(
        clerum.rpc.loadSessionMessages.mock.calls.filter(([ref]) => ref === HOST_A)
      ).toHaveLength(2)
      expect(handle.refreshCatalog.mock.calls.length).toBe(refreshesBeforeHold + 1)
      expect(app.result.current.isHostAccessBlocked(HOST_A)).toBe(true)
      expect(app.result.current.heldAgentRefs).toEqual(held)
      expect(toastsSeen(commits)).toEqual([toast])
    }
  )

  it('T-A9-O2: a hold of another Host whose refresh drops the selected Host says so once', async () => {
    const { clerum, handle } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: DISPLAY_BY_NAME,
    })
    const catalog = installCatalog(clerum)
    catalog.deny(HOST_B, await ipcGenericForbidden('rpc:listSessions'))
    const { app, commits } = await mount(clerum, handle)
    act(() => {
      app.result.current.handleSelectChatAgent(HOST_A, { selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.selectedAgent).toBe(HOST_A))
    handle.refreshCatalog.mockImplementation(async () => createCatalog([HOST_B], DISPLAY_B_ONLY))

    await holdThroughCatalog(app, catalog, HOST_B)
    await waitFor(() => expect(app.result.current.selectedAgent).toBe(null))
    await waitFor(() => expect(toastsSeen(commits)).toContain(GONE_A))
    await settle()

    // Liveness witness: B is held and its refresh dropped A from the catalog.
    expect(app.result.current.heldAgentRefs).toEqual([HOST_B])
    expect(cachedCatalog(app.queryClient)?.agentNames).toEqual([HOST_B])
    expect(toastsSeen(commits)).toEqual([GONE_A])
  })

  it('T-A9-O1: a refresh that drops the selected Host, then a 403 on it, gives one toast', async () => {
    const { clerum, handle } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: DISPLAY_BY_NAME,
    })
    const catalog = installCatalog(clerum)
    catalog.deny(HOST_A, await ipcGenericForbidden('rpc:listSessions'))
    const { app, commits } = await mount(clerum, handle)
    act(() => {
      app.result.current.handleSelectChatAgent(HOST_A, { selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.selectedAgent).toBe(HOST_A))
    // A's session page read is now waiting on the gate; it will answer 403.
    await waitFor(() => expect(catalog.pageReads(HOST_A)).toBeGreaterThan(0))
    handle.refreshCatalog.mockImplementation(async () => createCatalog([HOST_B], DISPLAY_B_ONLY))

    await act(async () => {
      await app.result.current.handleRefreshWorkspaceData(DESKTOP_ROUTES.agents)
    })
    await waitFor(() => expect(app.result.current.selectedAgent).toBe(null))
    await waitFor(() => expect(toastsSeen(commits)).toEqual([GONE_A]))

    await act(async () => {
      catalog.openGate()
    })
    await waitFor(() => expect(app.result.current.isHostAccessBlocked(HOST_A)).toBe(true))
    await settle()

    // Liveness witness: the 403 reached the coordinator and held A.
    expect(app.result.current.isHostAccessBlocked(HOST_A)).toBe(true)
    expect(cachedCatalog(app.queryClient)?.agentNames).toEqual([HOST_B])
    expect(toastsSeen(commits)).toEqual([GONE_A])
  })

  it('T-A9-T1: a team switch whose catalog lacks the selected Host deselects it without a toast', async () => {
    const { clerum, handle } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: DISPLAY_BY_NAME,
    })
    installCatalog(clerum)
    const { app, commits } = await mount(clerum, handle)
    act(() => {
      app.result.current.handleSelectChatAgent(HOST_A, { selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.selectedAgent).toBe(HOST_A))
    handle.refreshCatalog.mockImplementation(async () =>
      createCatalog([HOST_B], DISPLAY_BY_NAME, 'team-2')
    )

    await act(async () => {
      await app.result.current.handleEnsureTeamContext({ teamId: 'team-2' })
    })
    await waitFor(() => expect(app.result.current.selectedAgent).toBe(null))
    await settle()

    // Liveness witness: the switch completed and its catalog is team-2's, without A.
    expect(handle.switchTeam).toHaveBeenCalledWith('team-2')
    expect(app.result.current.currentTeamId).toBe('team-2')
    expect(cachedCatalog(app.queryClient)).toMatchObject({
      teamId: 'team-2',
      agentNames: [HOST_B],
    })
    expect(toastsSeen(commits).filter(text => text.includes(DISPLAY_A))).toEqual([])
  })

  it('T-A9-T2: an uncertain hold whose refresh settles after a team switch shows no toast', async () => {
    const { clerum, handle } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: DISPLAY_BY_NAME,
    })
    installCatalog(clerum)
    await denyTranscriptOfA(clerum)
    const { app, commits } = await mount(clerum, handle)
    const refreshesBeforeHold = handle.refreshCatalog.mock.calls.length
    const oldTeamCatalog = deferred<ReturnType<typeof createCatalog>>()
    handle.refreshCatalog.mockImplementationOnce(() => oldTeamCatalog.promise)
    handle.refreshCatalog.mockImplementation(async () =>
      createCatalog([HOST_B], DISPLAY_BY_NAME, 'team-2')
    )

    await holdSelectedAThroughTranscript(app)
    await waitFor(() =>
      expect(handle.refreshCatalog.mock.calls.length).toBe(refreshesBeforeHold + 1)
    )
    let switching: Promise<boolean> | undefined
    act(() => {
      switching = app.result.current.handleEnsureTeamContext({ teamId: 'team-2' })
    })
    await waitFor(() => expect(app.result.current.currentTeamId).toBe('team-2'))

    await act(async () => {
      oldTeamCatalog.resolve(createCatalog([HOST_B], DISPLAY_BY_NAME))
      await oldTeamCatalog.promise
      await switching
    })
    await settle()

    // Liveness witness: the hold happened, the switch completed and the old
    // team's refresh settled into the cache.
    expect(handle.switchTeam).toHaveBeenCalledWith('team-2')
    expect(cachedCatalog(app.queryClient)?.agentNames).toEqual([HOST_B])
    expect(app.result.current.selectedAgent).toBe(null)
    expect(toastsSeen(commits).filter(text => text.includes(DISPLAY_A))).toEqual([])
  })
})

/**
 * The real coordinator and the real ChatPage, wired the way App wires them:
 * NavigationContext is the view model and ChatPage is mounted only on the Chat
 * route. Review 5547292745 (jozer-rami) reproduced both cases on `0a5285724`.
 */
describe('ChatPage with a held Host on the chat tab', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    uninstallMockClerum()
  })

  /** Records every committed selection, in order. */
  function SelectionTrail({ trail }: { trail: Array<string | null> }) {
    const { selectedAgent } = useNavigationContext()
    useLayoutEffect(() => {
      trail.push(selectedAgent)
    }, [selectedAgent, trail])
    return null
  }

  function ChatRoute() {
    const { navItem } = useNavigationContext()
    return navItem === DESKTOP_ROUTES.chat ? (
      <ChatPage scrollContainerRef={{ current: null }} />
    ) : null
  }

  async function mountChat(trail: Array<string | null>) {
    const app = await renderChatActionConsumer(
      <>
        <ChatRoute />
        <SelectionTrail trail={trail} />
      </>
    )
    // Liveness witness: ChatPage's auto-selection runs, and picked a Host at boot.
    await waitFor(() => expect(app.getVm().selectedAgent).not.toBe(null))
    return app
  }

  async function openChat(getVm: () => Vm, agentRef: string, chatId: string) {
    act(() => {
      getVm().handleSelectChatAgent(agentRef, { chatId, selectLatest: false })
    })
    await waitFor(() => expect(getVm().selectedAgent).toBe(agentRef))
    await waitFor(() => expect(getVm().activeWorkspaceTab?.chat?.chatId).toBe(chatId))
  }

  function hasTabFor(vm: Vm, agentRef: string): boolean {
    return vm.workspaceTabs.tabs.some(tab => tab.chat?.agentRef === agentRef)
  }

  it('T-J1-1: losing the selected Host keeps its chat tab instead of opening another Host', async () => {
    const { clerum } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: DISPLAY_BY_NAME,
    })
    installCatalog(clerum)
    const transcriptError = await ipcGenericForbidden('rpc:loadSessionMessages')
    let denyTranscript = false
    clerum.rpc.loadSessionMessages.mockImplementation(async (hostRef: string) => {
      if (hostRef === HOST_A && denyTranscript) throw transcriptError
      return { agent: hostRef, chatId: '', turns: [] }
    })
    const trail: Array<string | null> = []
    const { getVm } = await mountChat(trail)
    await openChat(getVm, HOST_A, 'chat-1')
    await openChat(getVm, HOST_A, 'chat-2')
    expect(hasTabFor(getVm(), HOST_B)).toBe(false)
    const trailBeforeHold = trail.length

    denyTranscript = true
    await openChat(getVm, HOST_A, 'chat-1')
    await waitFor(() => expect(getVm().isHostAccessBlocked(HOST_A)).toBe(true))
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })

    // Liveness witness: the hold cleared the selection and said so.
    expect(trail.slice(trailBeforeHold)).toContain(null)
    await waitFor(() => expect(toastTexts(getVm())).toContain(RETRY_A))
    expect(getVm().heldAgentRefs).toEqual([HOST_A])
    // The page stays on A's chat with nothing selected; B is never opened.
    expect(getVm().selectedAgent).toBe(null)
    expect(trail.slice(trailBeforeHold)).not.toContain(HOST_B)
    expect(hasTabFor(getVm(), HOST_B)).toBe(false)
    expect(getVm().focusedChatAgentRef).toBe(HOST_A)
    expect(getVm().activeWorkspaceTab?.chat?.chatId).toBe('chat-1')
  })

  it('T-A9-P2: a held Host that also leaves the catalog keeps its chat instead of opening another Host', async () => {
    const { clerum, handle } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: DISPLAY_BY_NAME,
    })
    installCatalog(clerum)
    const transcriptError = await ipcGenericForbidden('rpc:loadSessionMessages')
    let denyTranscript = false
    clerum.rpc.loadSessionMessages.mockImplementation(async (hostRef: string) => {
      if (hostRef === HOST_A && denyTranscript) throw transcriptError
      return { agent: hostRef, chatId: '', turns: [] }
    })
    const trail: Array<string | null> = []
    // `mountChat` witnesses that ChatPage's auto-selection is live: it picks a Host at boot.
    const { getVm, queryClient } = await mountChat(trail)
    await openChat(getVm, HOST_A, 'chat-1')
    await openChat(getVm, HOST_A, 'chat-2')
    expect(hasTabFor(getVm(), HOST_B)).toBe(false)
    const refreshesBeforeHold = handle.refreshCatalog.mock.calls.length
    handle.refreshCatalog.mockImplementation(async () => createCatalog([HOST_B], DISPLAY_B_ONLY))
    const trailBeforeHold = trail.length

    denyTranscript = true
    await openChat(getVm, HOST_A, 'chat-1')
    await waitFor(() => expect(getVm().isHostAccessBlocked(HOST_A)).toBe(true))
    await waitFor(() =>
      expect(handle.refreshCatalog.mock.calls.length).toBe(refreshesBeforeHold + 1)
    )
    await waitFor(() => expect(cachedCatalog(queryClient)?.agentNames).toEqual([HOST_B]))
    await settle()

    // Liveness witness: the hold cleared the selection and its refresh dropped A,
    // so ChatPage re-ran its auto-selection with only B as a candidate.
    expect(trail.slice(trailBeforeHold)).toContain(null)
    expect(getVm().heldAgentRefs).toEqual([])
    // The page stays on A's chat with nothing selected; B is never opened.
    expect(trail.slice(trailBeforeHold)).not.toContain(HOST_B)
    expect(getVm().selectedAgent).toBe(null)
    expect(hasTabFor(getVm(), HOST_B)).toBe(false)
    expect(getVm().focusedChatAgentRef).toBe(HOST_A)
    expect(getVm().activeWorkspaceTab?.chat?.chatId).toBe('chat-1')
    expect(toastTexts(getVm())).toEqual([GONE_A])
  })

  it('T-J1-2: a Chat click on a held Host chat opens that chat once access is verified', async () => {
    const { clerum, handle } = installAppControllerClerum({ agentNames: [HOST_A, HOST_B] })
    const catalog = installCatalog(clerum)
    catalog.deny(HOST_A, await ipcGenericForbidden('rpc:listSessions'))
    const trail: Array<string | null> = []
    const { getVm } = await mountChat(trail)
    expect(handle.refreshCatalog).toHaveBeenCalled()
    await openChat(getVm, HOST_A, 'chat-1')

    act(() => {
      getVm().handleNavSelect(DESKTOP_ROUTES.agents)
    })
    expect(getVm().selectedAgent).toBe(null)
    await act(async () => {
      catalog.openGate()
    })
    await waitFor(() => expect(getVm().isHostAccessBlocked(HOST_A)).toBe(true))
    catalog.allow(HOST_A)
    const verification = deferred<SessionsListResult>()
    catalog.setVerify(() => verification.promise)
    const trailBeforeClick = trail.length

    act(() => {
      getVm().handleNavSelect(DESKTOP_ROUTES.chat)
    })
    await waitFor(() => expect(catalog.verifyReads(HOST_A)).toBe(1))
    // Liveness witness: the click focused A's chat on the Chat route, so the
    // auto-selection had its chance to pick another Host while A was verified.
    expect(getVm().navItem).toBe(DESKTOP_ROUTES.chat)
    expect(getVm().focusedChatAgentRef).toBe(HOST_A)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(getVm().selectedAgent).toBe(null)

    // The release and the selection that follows it land in one commit in the
    // app: React renders these updates in a later task, after the microtask
    // chain from the verification to `selectChatAgent`. Wait one task inside
    // act so it does not flush the release on its own.
    await act(async () => {
      verification.resolve(serverSessions([]))
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    await waitFor(() => expect(getVm().selectedAgent).toBe(HOST_A))
    expect(getVm().activeWorkspaceTab?.chat?.chatId).toBe('chat-1')
    expect(getVm().isHostAccessBlocked(HOST_A)).toBe(false)
    expect(trail.slice(trailBeforeClick)).not.toContain(HOST_B)
    expect(hasTabFor(getVm(), HOST_B)).toBe(false)
  })
})
