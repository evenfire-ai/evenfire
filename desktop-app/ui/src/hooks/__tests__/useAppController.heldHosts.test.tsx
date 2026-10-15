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
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import type { SessionsListResult } from '../../../../src/types'
import {
  type AppControllerClerumHandle,
  installAppControllerClerum,
  renderAppController,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import { deferred, serverSessions } from '../domain/__tests__/__fixtures__/catalogFixtures'
import {
  ipcGenericForbidden,
  ipcHostAccessRevoked,
} from '../domain/__tests__/__fixtures__/ipcErrors'
import { type MockClerum, uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'
import { desktopQueryKeys } from '../domain/queryKeys'
import type { useAppController } from '../useAppController'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Vm = ReturnType<typeof useAppController>
type ListSessionsQuery = { agent?: string; limit?: number; cursor?: string }

const HOST_A = 'agent-a'
const HOST_B = 'agent-b'
// Visible names distinct from the refs, so a toast that used the ref would fail.
const DISPLAY_A = 'Research Host'
const DISPLAY_B = 'Billing Host'
const DISPLAY_BY_NAME = { [HOST_A]: DISPLAY_A, [HOST_B]: DISPLAY_B }

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

      expect(toastTexts(app.result.current)).toContain(expectedToast)
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
})
