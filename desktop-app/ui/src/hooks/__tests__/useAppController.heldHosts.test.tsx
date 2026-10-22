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
const DISPLAY_A_ONLY = { [HOST_A]: DISPLAY_A }
const VERIFY_A = `Could not verify access to ${DISPLAY_A}.`
const REVOKED_A = `Access to ${DISPLAY_A} was revoked.`
const GONE_A = `${DISPLAY_A} is no longer available.`
const GONE_B = `${DISPLAY_B} is no longer available.`

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

/**
 * A catalog shaped like the producer's: every listed Host has a display name,
 * and the team is the trimmed session team, or null without one.
 */
function producerCatalog(
  names: string[],
  labels: Record<string, string> = DISPLAY_BY_NAME,
  teamId: string | null = 'team-1'
) {
  return {
    ...createCatalog(names, Object.fromEntries(names.map(name => [name, labels[name] ?? name]))),
    teamId,
  }
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
    // Boot ends with the post-paint catalog refresh, so later refresh counts
    // measure only what the test itself triggers.
    await waitFor(() => expect(handle.refreshCatalog).toHaveBeenCalledTimes(2))
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

  it('T-R1L3-1: labels each held Host with its display name', async () => {
    const { clerum, handle } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: DISPLAY_BY_NAME,
    })
    const catalog = installCatalog(clerum)
    catalog.deny(HOST_A, await ipcGenericForbidden('rpc:listSessions'))
    catalog.deny(HOST_B, await ipcGenericForbidden('rpc:listSessions'))
    const { app } = await mount(clerum, handle)

    await act(async () => {
      catalog.openGate()
    })
    // Liveness witness: both Hosts are held and listed.
    await waitFor(() => expect(app.result.current.heldAgentRefs).toEqual([HOST_A, HOST_B]))
    expect(app.result.current.heldHosts).toEqual([
      { agentRef: HOST_A, label: DISPLAY_A },
      { agentRef: HOST_B, label: DISPLAY_B },
    ])
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
    ['a generic 403', () => ipcGenericForbidden('rpc:loadSessionMessages'), VERIFY_A],
    ['host_access_revoked', () => ipcHostAccessRevoked('rpc:loadSessionMessages'), REVOKED_A],
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

      // The toast comes with the deselection, before the hold's catalog refresh.
      expect(toastTexts(app.result.current)).toContain(expectedToast)
    }
  )

  it('T-A9-P1-4: a failed refresh keeps the listed Host and its Retry row', async () => {
    const { clerum, handle } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: DISPLAY_BY_NAME,
    })
    installCatalog(clerum)
    const transcriptError = await ipcGenericForbidden('rpc:loadSessionMessages')
    clerum.rpc.loadSessionMessages.mockImplementation(async (hostRef: string) => {
      if (hostRef === HOST_A) throw transcriptError
      return { agent: hostRef, chatId: '', turns: [] }
    })
    const { app, commits } = await mount(clerum, handle)
    const refreshesBeforeHold = handle.refreshCatalog.mock.calls.length
    handle.refreshCatalog.mockImplementation(async () => {
      throw new Error('catalog unavailable')
    })

    act(() => {
      app.result.current.handleSelectChatAgent(HOST_A, { chatId: 'chat-1', selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.isHostAccessBlocked(HOST_A)).toBe(true))
    await waitFor(() => expect(app.result.current.selectedAgent).toBe(null))
    await waitFor(() =>
      expect(handle.refreshCatalog.mock.calls.length).toBe(refreshesBeforeHold + 1)
    )
    await settle()

    // Liveness witness: the hold's refresh ran and failed.
    expect(app.queryClient.getQueryState(desktopQueryKeys.accessCatalog)?.error?.message).toBe(
      'catalog unavailable'
    )
    // The catalog on screen is still the previous one, so A keeps its Retry row.
    expect(cachedCatalog(app.queryClient)?.agentNames).toEqual([HOST_A, HOST_B])
    expect(app.result.current.heldHosts).toEqual([{ agentRef: HOST_A, label: DISPLAY_A }])
    expect(toastsSeen(commits)).toEqual([VERIFY_A])
  })

  it.each([
    ['a generic 403', () => ipcGenericForbidden('rpc:listSessions')],
    ['host_access_revoked', () => ipcHostAccessRevoked('rpc:listSessions')],
  ])(
    'T-F3-2: losing a Host that is neither selected nor on the chat tab to %s shows no toast',
    async (_label, rejection) => {
      const { clerum, handle } = installAppControllerClerum({ agentNames: [HOST_A, HOST_B] })
      const catalog = installCatalog(clerum)
      catalog.deny(HOST_B, await rejection())
      const { app } = await mount(clerum, handle)

      act(() => {
        app.result.current.handleSelectChatAgent(HOST_A, { selectLatest: false })
      })
      await waitFor(() => expect(app.result.current.selectedAgent).toBe(HOST_A))
      await holdThroughCatalog(app, catalog, HOST_B)
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20))
      })

      // Liveness witness: B is held and exposed; A is still selected and B has no tab.
      expect(app.result.current.heldAgentRefs).toContain(HOST_B)
      expect(app.result.current.selectedAgent).toBe(HOST_A)
      expect(app.result.current.focusedChatAgentRef).not.toBe(HOST_B)
      expect(
        toastTexts(app.result.current).filter(
          text => text.includes(HOST_B) || text.includes('access')
        )
      ).toEqual([])
    }
  )

  it.each([
    ['a generic 403', () => ipcGenericForbidden('rpc:listSessions')],
    ['host_access_revoked', () => ipcHostAccessRevoked('rpc:listSessions')],
  ])(
    'T-R4M1-2: a background Host held by %s that leaves the catalog is announced once',
    async (_label, rejection) => {
      const { clerum, handle } = installAppControllerClerum({
        agentNames: [HOST_A, HOST_B],
        agentDisplayByName: DISPLAY_BY_NAME,
      })
      const catalog = installCatalog(clerum)
      catalog.deny(HOST_B, await rejection())
      const { app, commits } = await mount(clerum, handle)
      act(() => {
        app.result.current.handleSelectChatAgent(HOST_A, { selectLatest: false })
      })
      await waitFor(() => expect(app.result.current.selectedAgent).toBe(HOST_A))
      await holdThroughCatalog(app, catalog, HOST_B)
      await settle()
      // Liveness witness: B is held and listed, with no toast, before the catalog drops it.
      expect(app.result.current.heldAgentRefs).toEqual([HOST_B])
      expect(toastsSeen(commits)).toEqual([])
      handle.refreshCatalog.mockImplementation(async () => createCatalog([HOST_A], DISPLAY_A_ONLY))

      await act(async () => {
        await app.result.current.handleRefreshWorkspaceData(DESKTOP_ROUTES.agents)
      })
      await waitFor(() => expect(cachedCatalog(app.queryClient)?.agentNames).toEqual([HOST_A]))
      await settle()

      // Liveness witness: B is still held and lost its Retry row; A is untouched.
      expect(app.result.current.isHostAccessBlocked(HOST_B)).toBe(true)
      expect(app.result.current.heldAgentRefs).toEqual([])
      expect(app.result.current.selectedAgent).toBe(HOST_A)
      expect(toastsSeen(commits)).toEqual([GONE_B])
    }
  )

  it('T-R4L1-1: a revocation, then the catalog dropping the Host, shows both toasts once, in order', async () => {
    const { clerum, handle } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: DISPLAY_BY_NAME,
    })
    installCatalog(clerum)
    const transcriptError = await ipcHostAccessRevoked('rpc:loadSessionMessages')
    clerum.rpc.loadSessionMessages.mockImplementation(async (hostRef: string) => {
      if (hostRef === HOST_A) throw transcriptError
      return { agent: hostRef, chatId: '', turns: [] }
    })
    const { app, commits } = await mount(clerum, handle)
    const refreshesBeforeHold = handle.refreshCatalog.mock.calls.length

    act(() => {
      app.result.current.handleSelectChatAgent(HOST_A, { chatId: 'chat-1', selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.isHostAccessBlocked(HOST_A)).toBe(true))
    await waitFor(() =>
      expect(handle.refreshCatalog.mock.calls.length).toBe(refreshesBeforeHold + 1)
    )
    await settle()
    // Liveness witness: the revocation was announced while the catalog still lists A.
    expect(cachedCatalog(app.queryClient)?.agentNames).toEqual([HOST_A, HOST_B])
    expect(app.result.current.selectedAgent).toBe(null)
    expect(toastsSeen(commits)).toEqual([REVOKED_A])
    handle.refreshCatalog.mockImplementation(async () => createCatalog([HOST_B], DISPLAY_B_ONLY))

    await act(async () => {
      await app.result.current.handleRefreshWorkspaceData(DESKTOP_ROUTES.agents)
    })
    await waitFor(() => expect(cachedCatalog(app.queryClient)?.agentNames).toEqual([HOST_B]))
    await settle()

    // Two events, two toasts: the revocation, then the loss of the Host.
    expect(app.result.current.isHostAccessBlocked(HOST_A)).toBe(true)
    expect(toastsSeen(commits)).toEqual([REVOKED_A, GONE_A])

    // A navigation re-run with the same catalog adds no third toast.
    act(() => {
      app.result.current.handleNavSelect(DESKTOP_ROUTES.files)
    })
    await settle()
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.files)
    expect(toastsSeen(commits)).toEqual([REVOKED_A, GONE_A])
  })

  it('T-R4L2-1: a failed verification names a Host that left the catalog by its last known name', async () => {
    const { clerum, handle } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: DISPLAY_BY_NAME,
    })
    const catalog = installCatalog(clerum)
    catalog.deny(HOST_A, await ipcGenericForbidden('rpc:listSessions'))
    const { app, commits } = await mount(clerum, handle)
    act(() => {
      app.result.current.handleSelectChatAgent(HOST_B, { selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.selectedAgent).toBe(HOST_B))
    await holdThroughCatalog(app, catalog, HOST_A)
    await settle()
    expect(app.result.current.heldAgentRefs).toEqual([HOST_A])
    handle.refreshCatalog.mockImplementation(async () => createCatalog([HOST_B], DISPLAY_B_ONLY))

    // The catalog drops A, then a second catalog without A lands, then the
    // focus moves away and back: no catalog on screen names A any more.
    for (let refresh = 0; refresh < 2; refresh += 1) {
      await act(async () => {
        await app.result.current.handleRefreshWorkspaceData(DESKTOP_ROUTES.agents)
      })
      await settle()
    }
    act(() => {
      app.result.current.handleNavSelect(DESKTOP_ROUTES.files)
    })
    act(() => {
      app.result.current.handleNavSelect(DESKTOP_ROUTES.chat)
    })
    await settle()
    // Liveness witness: A is held and absent from the catalog on screen.
    expect(cachedCatalog(app.queryClient)?.agentNames).toEqual([HOST_B])
    expect(app.result.current.isHostAccessBlocked(HOST_A)).toBe(true)
    expect(toastsSeen(commits)).toEqual([GONE_A])
    const verificationError = await ipcGenericForbidden('rpc:listSessions')
    catalog.setVerify(async () => {
      throw verificationError
    })

    act(() => {
      app.result.current.handleSelectChatAgent(HOST_A, { selectLatest: false })
    })
    await waitFor(() => expect(catalog.verifyReads(HOST_A)).toBe(1))
    await settle()

    expect(toastsSeen(commits)).toEqual([GONE_A, VERIFY_A])

    // Team 2 lists the same ref without a name. The name team 1 gave it must
    // not follow it: in team 2 it is another Host.
    const toastsBeforeSwitch = toastsSeen(commits).length
    catalog.deny(HOST_A, await ipcGenericForbidden('rpc:listSessions'))
    handle.refreshCatalog.mockImplementation(async () =>
      createCatalog([HOST_A, HOST_B], DISPLAY_B_ONLY, 'team-2')
    )
    await act(async () => {
      await app.result.current.handleEnsureTeamContext({ teamId: 'team-2' })
    })
    await waitFor(() => expect(app.result.current.heldAgentRefs).toEqual([HOST_A]))
    catalog.allow(HOST_A)
    // Liveness witness: the switch completed and team 2 holds its own A.
    expect(handle.switchTeam).toHaveBeenCalledWith('team-2')
    expect(cachedCatalog(app.queryClient)).toMatchObject({
      teamId: 'team-2',
      agentNames: [HOST_A, HOST_B],
    })
    expect(app.result.current.heldHosts).toEqual([{ agentRef: HOST_A, label: HOST_A }])

    handle.refreshCatalog.mockImplementation(async () =>
      createCatalog([HOST_B], DISPLAY_B_ONLY, 'team-2')
    )
    await act(async () => {
      await app.result.current.handleRefreshWorkspaceData(DESKTOP_ROUTES.agents)
    })
    await settle()
    // Liveness witness: team 2's catalog dropped A while A is held.
    expect(cachedCatalog(app.queryClient)).toMatchObject({ teamId: 'team-2', agentNames: [HOST_B] })
    expect(app.result.current.isHostAccessBlocked(HOST_A)).toBe(true)

    act(() => {
      app.result.current.handleSelectChatAgent(HOST_A, { selectLatest: false })
    })
    await waitFor(() => expect(catalog.verifyReads(HOST_A)).toBe(2))
    await settle()

    expect(toastsSeen(commits).slice(toastsBeforeSwitch)).toEqual([
      `${HOST_A} is no longer available.`,
      `Could not verify access to ${HOST_A}.`,
    ])
  })

  it('T-R4L2-2: the previous team catalog, still cached during a team switch, gives no names', async () => {
    const { clerum, handle } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: DISPLAY_BY_NAME,
    })
    const catalog = installCatalog(clerum)
    const { app, commits } = await mount(clerum, handle)
    act(() => {
      app.result.current.handleSelectChatAgent(HOST_B, { selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.selectedAgent).toBe(HOST_B))
    const teamTwoCatalog = deferred<ReturnType<typeof createCatalog>>()
    handle.refreshCatalog.mockImplementation(() => teamTwoCatalog.promise)
    let switchDone!: Promise<boolean>
    await act(async () => {
      switchDone = app.result.current.handleEnsureTeamContext({ teamId: 'team-2' })
      await Promise.resolve()
    })
    await waitFor(() => expect(app.result.current.currentTeamId).toBe('team-2'))
    // Liveness witness: the principal is team 2 while the cache still holds
    // team 1's catalog, which names A.
    expect(cachedCatalog(app.queryClient)?.teamId).toBe('team-1')
    // Navigation re-runs the catalog effect inside that window.
    act(() => {
      app.result.current.handleNavSelect(DESKTOP_ROUTES.agents)
    })
    await waitFor(() => expect(app.result.current.selectedAgent).toBe(null))
    await settle()
    await act(async () => {
      teamTwoCatalog.resolve(createCatalog([HOST_A, HOST_B], DISPLAY_B_ONLY, 'team-2'))
      await switchDone
    })
    await settle()
    expect(cachedCatalog(app.queryClient)?.teamId).toBe('team-2')

    const transcriptError = await ipcGenericForbidden('rpc:loadSessionMessages')
    clerum.rpc.loadSessionMessages.mockImplementation(async (hostRef: string) => {
      if (hostRef === HOST_A) throw transcriptError
      return { agent: hostRef, chatId: '', turns: [] }
    })
    act(() => {
      app.result.current.handleSelectChatAgent(HOST_A, {
        chatId: 'team-2-chat',
        selectLatest: false,
      })
    })
    await waitFor(() => expect(app.result.current.isHostAccessBlocked(HOST_A)).toBe(true))
    await settle()
    expect(app.result.current.heldHosts).toEqual([{ agentRef: HOST_A, label: HOST_A }])
    handle.refreshCatalog.mockImplementation(async () =>
      createCatalog([HOST_B], DISPLAY_B_ONLY, 'team-2')
    )
    await act(async () => {
      await app.result.current.handleRefreshWorkspaceData(DESKTOP_ROUTES.agents)
    })
    await settle()
    // Liveness witness: team 2's catalog dropped A while A is held.
    expect(cachedCatalog(app.queryClient)).toMatchObject({ teamId: 'team-2', agentNames: [HOST_B] })
    expect(app.result.current.isHostAccessBlocked(HOST_A)).toBe(true)
    const toastsBeforeVerify = toastsSeen(commits).length
    const verificationError = await ipcGenericForbidden('rpc:listSessions')
    catalog.setVerify(async () => {
      throw verificationError
    })

    act(() => {
      app.result.current.handleSelectChatAgent(HOST_A, { selectLatest: false })
    })
    await waitFor(() => expect(catalog.verifyReads(HOST_A)).toBe(1))
    await settle()

    expect(toastsSeen(commits).slice(toastsBeforeVerify)).toEqual([
      `Could not verify access to ${HOST_A}.`,
    ])
  })

  it('T-R4L2-3: a verification pending across a rename and a removal uses the new name', async () => {
    const { clerum, handle } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: DISPLAY_BY_NAME,
    })
    const catalog = installCatalog(clerum)
    catalog.deny(HOST_A, await ipcGenericForbidden('rpc:listSessions'))
    const { app, commits } = await mount(clerum, handle)
    act(() => {
      app.result.current.handleSelectChatAgent(HOST_B, { selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.selectedAgent).toBe(HOST_B))
    await holdThroughCatalog(app, catalog, HOST_A)
    await settle()
    const pendingVerification = deferred<SessionsListResult>()
    catalog.setVerify(() => pendingVerification.promise)
    act(() => {
      app.result.current.handleSelectChatAgent(HOST_A, { selectLatest: false })
    })
    await waitFor(() => expect(catalog.verifyReads(HOST_A)).toBe(1))

    const renamed = 'Renamed Research Host'
    handle.refreshCatalog.mockImplementation(async () =>
      createCatalog([HOST_A, HOST_B], { [HOST_A]: renamed, [HOST_B]: DISPLAY_B })
    )
    await act(async () => {
      await app.result.current.handleRefreshWorkspaceData(DESKTOP_ROUTES.agents)
    })
    // Liveness witness: the rename reached the catalog on screen.
    await waitFor(() =>
      expect(app.result.current.heldHosts).toEqual([{ agentRef: HOST_A, label: renamed }])
    )
    handle.refreshCatalog.mockImplementation(async () => createCatalog([HOST_B], DISPLAY_B_ONLY))
    await act(async () => {
      await app.result.current.handleRefreshWorkspaceData(DESKTOP_ROUTES.agents)
    })
    await settle()
    expect(cachedCatalog(app.queryClient)?.agentNames).toEqual([HOST_B])
    expect(toastsSeen(commits)).toEqual([`${renamed} is no longer available.`])

    await act(async () => {
      pendingVerification.reject(await ipcGenericForbidden('rpc:listSessions'))
      await pendingVerification.promise.catch(() => undefined)
    })
    await settle()

    expect(catalog.verifyReads(HOST_A)).toBe(1)
    expect(toastsSeen(commits)).toEqual([
      `${renamed} is no longer available.`,
      `Could not verify access to ${renamed}.`,
    ])
  })

  it.each(['', 'team-1'])(
    'T-R5L1-1: the team directory arriving after paint keeps holds and names (me.teamId=%j)',
    async principalTeam => {
      const { clerum, handle } = installAppControllerClerum({
        me: { teamId: principalTeam },
        agentNames: [HOST_A, HOST_B],
        agentDisplayByName: DISPLAY_BY_NAME,
      })
      const directory = deferred<{ items: never[]; currentTeamId: string }>()
      handle.teamDirectory.mockImplementation(() => directory.promise)
      handle.refreshCatalog.mockImplementation(async () =>
        producerCatalog([HOST_A, HOST_B], DISPLAY_BY_NAME, principalTeam || null)
      )
      const catalog = installCatalog(clerum)
      catalog.deny(HOST_A, await ipcGenericForbidden('rpc:listSessions'))
      const { app, commits } = await mount(clerum, handle)
      await settle()
      const catalogBeforeDirectory = cachedCatalog(app.queryClient)
      expect(catalogBeforeDirectory).toMatchObject({
        agentNames: [HOST_A, HOST_B],
        teamId: principalTeam || null,
      })
      expect(app.result.current.currentTeamId).toBe(principalTeam)

      // The display directory names team-1 after paint; the session team is unchanged.
      await act(async () => {
        directory.resolve({ items: [], currentTeamId: 'team-1' })
      })
      await waitFor(() => expect(app.result.current.currentTeamId).toBe('team-1'))
      await settle()

      // Hold a Host that is not selected, so no selection change rewrites the names.
      await holdThroughCatalog(app, catalog, HOST_A)
      await settle()
      // Liveness witness: A is held, its page read ran, and no new catalog
      // object reached the screen that could have refilled the names.
      expect(catalog.pageReads(HOST_A)).toBeGreaterThan(0)
      expect(cachedCatalog(app.queryClient)).toBe(catalogBeforeDirectory)
      const verificationError = await ipcGenericForbidden('rpc:listSessions')
      catalog.setVerify(async () => {
        throw verificationError
      })

      act(() => {
        app.result.current.handleSelectChatAgent(HOST_A, { selectLatest: false })
      })
      await waitFor(() => expect(catalog.verifyReads(HOST_A)).toBe(1))
      await settle()

      expect(app.result.current.isHostAccessBlocked(HOST_A)).toBe(true)
      expect(toastsSeen(commits)).toEqual([VERIFY_A])
    }
  )

  it("T-R5L3-1: a hold during a team switch never takes the previous team's name", async () => {
    const { clerum, handle } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: DISPLAY_BY_NAME,
    })
    installCatalog(clerum)
    const { app, commits } = await mount(clerum, handle)
    await settle()
    const team2 = deferred<ReturnType<typeof producerCatalog>>()
    handle.refreshCatalog.mockImplementation(() => team2.promise)

    let switching!: Promise<boolean>
    await act(async () => {
      switching = app.result.current.handleEnsureTeamContext({ teamId: 'team-2' })
      await Promise.resolve()
    })
    await waitFor(() => expect(app.result.current.currentTeamId).toBe('team-2'))
    // Liveness witness: the session is on team 2 while the cached catalog is
    // still team 1's, which names B "Billing Host".
    expect(cachedCatalog(app.queryClient)?.teamId).toBe('team-1')

    const transcriptError = await ipcGenericForbidden('rpc:loadSessionMessages')
    clerum.rpc.loadSessionMessages.mockImplementation(async () => {
      throw transcriptError
    })
    act(() => {
      app.result.current.handleSelectChatAgent(HOST_B, {
        chatId: 'team-2-chat',
        selectLatest: false,
      })
    })
    await waitFor(() => expect(app.result.current.isHostAccessBlocked(HOST_B)).toBe(true))
    await waitFor(() => expect(toastsSeen(commits).length).toBeGreaterThan(0))
    expect(
      clerum.rpc.loadSessionMessages.mock.calls.some(
        ([host, , chatId]) => host === HOST_B && chatId === 'team-2-chat'
      )
    ).toBe(true)

    // Inside the switch window: no catalog of team 2 has landed, so B is named by its ref.
    expect(cachedCatalog(app.queryClient)?.teamId).toBe('team-1')
    expect(toastsSeen(commits)).toEqual([`Could not verify access to ${HOST_B}.`])
    expect(app.result.current.heldHosts).toEqual([{ agentRef: HOST_B, label: HOST_B }])

    await act(async () => {
      team2.resolve(
        producerCatalog(
          [HOST_A, HOST_B],
          { ...DISPLAY_BY_NAME, [HOST_B]: 'Team Two Host' },
          'team-2'
        )
      )
      await switching
    })
    await waitFor(() =>
      expect(app.result.current.heldHosts).toEqual([{ agentRef: HOST_B, label: 'Team Two Host' }])
    )
  })

  it('T-R5L1-2: a padded session team still names Hosts from its catalog', async () => {
    const { clerum, handle } = installAppControllerClerum({
      me: { teamId: '  team-1  ' },
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: DISPLAY_BY_NAME,
    })
    const catalog = installCatalog(clerum)
    catalog.deny(HOST_A, await ipcGenericForbidden('rpc:listSessions'))
    const { app, commits } = await mount(clerum, handle)
    await settle()
    // Liveness witness: the catalog carries the trimmed team the producer keys it by.
    expect(cachedCatalog(app.queryClient)?.teamId).toBe('team-1')

    await holdThroughCatalog(app, catalog, HOST_A)
    await settle()
    expect(app.result.current.heldHosts).toEqual([{ agentRef: HOST_A, label: DISPLAY_A }])

    const verificationError = await ipcGenericForbidden('rpc:listSessions')
    catalog.setVerify(async () => {
      throw verificationError
    })
    act(() => {
      app.result.current.handleSelectChatAgent(HOST_A, { selectLatest: false })
    })
    await waitFor(() => expect(catalog.verifyReads(HOST_A)).toBe(1))
    await settle()
    expect(toastsSeen(commits)).toEqual([VERIFY_A])
  })

  it('T-R2L2-1: a new hold after a successful Retry is announced again', async () => {
    const { clerum, handle } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: DISPLAY_BY_NAME,
    })
    const catalog = installCatalog(clerum)
    const transcriptError = await ipcGenericForbidden('rpc:loadSessionMessages')
    let denyTranscript = true
    clerum.rpc.loadSessionMessages.mockImplementation(async (hostRef: string) => {
      if (hostRef === HOST_A && denyTranscript) throw transcriptError
      return { agent: hostRef, chatId: '', turns: [] }
    })
    const { app, commits } = await mount(clerum, handle)

    act(() => {
      app.result.current.handleSelectChatAgent(HOST_A, { chatId: 'chat-1', selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.isHostAccessBlocked(HOST_A)).toBe(true))
    await waitFor(() => expect(app.result.current.selectedAgent).toBe(null))
    await waitFor(() => expect(toastsSeen(commits)).toEqual([VERIFY_A]))

    // Retry: the verification succeeds, releases A and selects it again.
    denyTranscript = false
    act(() => {
      app.result.current.handleSelectChatAgent(HOST_A, { chatId: 'chat-1', selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.selectedAgent).toBe(HOST_A))
    expect(app.result.current.isHostAccessBlocked(HOST_A)).toBe(false)

    denyTranscript = true
    act(() => {
      app.result.current.handleSelectChatAgent(HOST_A, { chatId: 'chat-2', selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.isHostAccessBlocked(HOST_A)).toBe(true))
    await waitFor(() => expect(app.result.current.selectedAgent).toBe(null))
    await settle()

    // Liveness witness: one verification read released the first hold, and the
    // second hold came from a transcript read of chat-2.
    expect(catalog.verifyReads(HOST_A)).toBe(1)
    expect(
      clerum.rpc.loadSessionMessages.mock.calls.some(
        ([hostRef, , chatId]) => hostRef === HOST_A && chatId === 'chat-2'
      )
    ).toBe(true)
    expect(toastsSeen(commits)).toEqual([VERIFY_A, VERIFY_A])
  })

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
    // Boot ends with the post-paint catalog refresh, so later refresh counts
    // measure only what the test itself triggers.
    await waitFor(() =>
      expect(vi.mocked(window.clerum.access.refreshCatalog)).toHaveBeenCalledTimes(2)
    )
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
    expect(toastTexts(getVm())).toContain(VERIFY_A)
    expect(getVm().heldAgentRefs).toEqual([HOST_A])
    // A's chat tab stays focused with nothing selected; B is never opened.
    expect(getVm().selectedAgent).toBe(null)
    expect(trail.slice(trailBeforeHold)).not.toContain(HOST_B)
    expect(hasTabFor(getVm(), HOST_B)).toBe(false)
    expect(getVm().focusedChatAgentRef).toBe(HOST_A)
    expect(getVm().activeWorkspaceTab?.chat?.chatId).toBe('chat-1')
  })

  it('T-A9-P2: a held Host on the chat tab that leaves the catalog says so and selects another Host', async () => {
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
    await waitFor(() => expect(getVm().selectedAgent).toBe(HOST_B))
    await settle()

    // Liveness witness: the hold cleared the selection, A is still held, and its
    // refresh dropped A, so A has no Retry row to come back through.
    expect(trail.slice(trailBeforeHold)).toContain(null)
    expect(getVm().isHostAccessBlocked(HOST_A)).toBe(true)
    expect(getVm().heldAgentRefs).toEqual([])
    // Both messages, in order: the hold, then the Host leaving the catalog.
    expect(toastTexts(getVm())).toEqual([VERIFY_A, GONE_A])
  })

  it('T-R2L1-1: a revocation of the chat tab Host after an uncertain hold is announced', async () => {
    const { clerum } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: DISPLAY_BY_NAME,
    })
    installCatalog(clerum)
    const errorByChat = new Map([
      ['chat-1', await ipcGenericForbidden('rpc:loadSessionMessages')],
      ['chat-2', await ipcHostAccessRevoked('rpc:loadSessionMessages')],
    ])
    const transcripts = new Map<string, ReturnType<typeof deferred<void>>>()
    let denyTranscript = false
    clerum.rpc.loadSessionMessages.mockImplementation(
      async (hostRef: string, _agent: string, chatId: string) => {
        if (hostRef !== HOST_A || !denyTranscript) return { agent: hostRef, chatId: '', turns: [] }
        const pending = deferred<void>()
        transcripts.set(chatId, pending)
        await pending.promise
        throw errorByChat.get(chatId)
      }
    )
    const trail: Array<string | null> = []
    const { getVm } = await mountChat(trail)

    // Two transcript reads of A in flight at once (different chats).
    denyTranscript = true
    await openChat(getVm, HOST_A, 'chat-1')
    await waitFor(() => expect(transcripts.has('chat-1')).toBe(true))
    await openChat(getVm, HOST_A, 'chat-2')
    await waitFor(() => expect(transcripts.has('chat-2')).toBe(true))

    await act(async () => {
      transcripts.get('chat-1')?.resolve()
    })
    await waitFor(() => expect(getVm().isHostAccessBlocked(HOST_A)).toBe(true))
    await waitFor(() => expect(getVm().selectedAgent).toBe(null))
    await waitFor(() => expect(toastTexts(getVm())).toEqual([VERIFY_A]))
    const revisionAfterUncertain = getVm().hostAuthorityRevision

    await act(async () => {
      transcripts.get('chat-2')?.resolve()
    })
    await settle()

    // Liveness witness: the revocation reached the store as a new hold, while
    // A's chat tab stayed focused with nothing selected.
    expect(getVm().hostAuthorityRevision).toBeGreaterThan(revisionAfterUncertain)
    expect(getVm().focusedChatAgentRef).toBe(HOST_A)
    expect(getVm().selectedAgent).toBe(null)
    expect(toastTexts(getVm())).toEqual([VERIFY_A, REVOKED_A])
  })

  it.each([
    ['the Apps picker is open', DESKTOP_ROUTES.apps],
    ['the Files tab is active', DESKTOP_ROUTES.files],
  ] as const)(
    'T-A23-1: a held chat tab Host that leaves the catalog while %s says so at once, not again on return',
    async (_label, awayRoute) => {
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
      const { getVm, queryClient } = await mountChat(trail)
      await openChat(getVm, HOST_A, 'chat-1')
      await openChat(getVm, HOST_A, 'chat-2')
      const refreshesBeforeHold = handle.refreshCatalog.mock.calls.length
      const catalogWithoutA = deferred<void>()
      handle.refreshCatalog.mockImplementation(async () => {
        await catalogWithoutA.promise
        return createCatalog([HOST_B], DISPLAY_B_ONLY)
      })

      denyTranscript = true
      await openChat(getVm, HOST_A, 'chat-1')
      await waitFor(() => expect(getVm().isHostAccessBlocked(HOST_A)).toBe(true))
      await waitFor(() =>
        expect(handle.refreshCatalog.mock.calls.length).toBe(refreshesBeforeHold + 1)
      )
      await waitFor(() => expect(toastTexts(getVm())).toEqual([VERIFY_A]))
      act(() => {
        getVm().handleNavSelect(awayRoute)
      })
      // Liveness witness: the chat is no longer shown.
      expect(getVm().navItem).toBe(awayRoute)
      expect(getVm().focusedChatAgentRef).toBe(null)

      await act(async () => {
        catalogWithoutA.resolve()
      })
      await waitFor(() => expect(cachedCatalog(queryClient)?.agentNames).toEqual([HOST_B]))
      await settle()

      // Liveness witness: the catalog without A landed while A is held, so A
      // lost its Retry row away from the chat.
      expect(getVm().isHostAccessBlocked(HOST_A)).toBe(true)
      expect(getVm().heldAgentRefs).toEqual([])
      expect(toastTexts(getVm())).toEqual([VERIFY_A, GONE_A])

      // Back on Chat the catalog has not changed, so the loss is not announced again.
      act(() => {
        getVm().handleNavSelect(DESKTOP_ROUTES.chat)
      })
      await waitFor(() => expect(getVm().selectedAgent).toBe(HOST_B))
      await settle()
      expect(hasTabFor(getVm(), HOST_A)).toBe(true)
      expect(toastTexts(getVm())).toEqual([VERIFY_A, GONE_A])
    }
  )

  it('T-A23-2: a revocation of the chat tab Host under the Apps picker is announced', async () => {
    const { clerum } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: DISPLAY_BY_NAME,
    })
    installCatalog(clerum)
    const errorByChat = new Map([
      ['chat-1', await ipcGenericForbidden('rpc:loadSessionMessages')],
      ['chat-2', await ipcHostAccessRevoked('rpc:loadSessionMessages')],
    ])
    const transcripts = new Map<string, ReturnType<typeof deferred<void>>>()
    let denyTranscript = false
    clerum.rpc.loadSessionMessages.mockImplementation(
      async (hostRef: string, _agent: string, chatId: string) => {
        if (hostRef !== HOST_A || !denyTranscript) return { agent: hostRef, chatId: '', turns: [] }
        const pending = deferred<void>()
        transcripts.set(chatId, pending)
        await pending.promise
        throw errorByChat.get(chatId)
      }
    )
    const trail: Array<string | null> = []
    const { getVm } = await mountChat(trail)

    denyTranscript = true
    await openChat(getVm, HOST_A, 'chat-1')
    await waitFor(() => expect(transcripts.has('chat-1')).toBe(true))
    await openChat(getVm, HOST_A, 'chat-2')
    await waitFor(() => expect(transcripts.has('chat-2')).toBe(true))
    await act(async () => {
      transcripts.get('chat-1')?.resolve()
    })
    await waitFor(() => expect(getVm().isHostAccessBlocked(HOST_A)).toBe(true))
    await waitFor(() => expect(toastTexts(getVm())).toEqual([VERIFY_A]))
    const revisionAfterUncertain = getVm().hostAuthorityRevision
    act(() => {
      getVm().handleNavSelect(DESKTOP_ROUTES.apps)
    })
    // Liveness witness: the picker is shown instead of the chat.
    expect(getVm().appsPickerActive).toBe(true)
    expect(getVm().navItem).toBe(DESKTOP_ROUTES.apps)

    await act(async () => {
      transcripts.get('chat-2')?.resolve()
    })
    await settle()

    // Liveness witness: the revocation reached the store as a new hold, with
    // nothing selected and the picker still open.
    expect(getVm().hostAuthorityRevision).toBeGreaterThan(revisionAfterUncertain)
    expect(getVm().selectedAgent).toBe(null)
    expect(getVm().appsPickerActive).toBe(true)
    // The stored chat tab is still A's, so the revocation is announced.
    expect(toastTexts(getVm())).toEqual([VERIFY_A, REVOKED_A])
    // The picker shows no chat tab, so none is focused and none is kept.
    expect(getVm().focusedChatAgentRef).toBe(null)
    expect(getVm().keepFocusedChat).toBe(false)
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

  it('T-R1H1-T: a team switch to a team that never listed the chat tab Host selects one of its Hosts', async () => {
    const { clerum, handle } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: DISPLAY_BY_NAME,
    })
    installCatalog(clerum)
    const trail: Array<string | null> = []
    const { getVm } = await mountChat(trail)
    await openChat(getVm, HOST_A, 'chat-1')
    handle.refreshCatalog.mockImplementation(async () =>
      createCatalog([HOST_B], DISPLAY_B_ONLY, 'team-2')
    )

    await act(async () => {
      await getVm().handleEnsureTeamContext({ teamId: 'team-2' })
    })
    await waitFor(() => expect(getVm().selectedAgent).toBe(HOST_B))

    // Liveness witness: the switch landed and A's chat tab survived it.
    expect(getVm().currentTeamId).toBe('team-2')
    expect(hasTabFor(getVm(), HOST_A)).toBe(true)
    expect(getVm().isHostAccessBlocked(HOST_A)).toBe(false)
  })

  it('T-R1H1-O: the selected, not held Host leaving the catalog says so and selects another Host', async () => {
    const { clerum, handle } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: DISPLAY_BY_NAME,
    })
    installCatalog(clerum)
    const trail: Array<string | null> = []
    const { getVm } = await mountChat(trail)
    await openChat(getVm, HOST_A, 'chat-1')
    handle.refreshCatalog.mockImplementation(async () => createCatalog([HOST_B], DISPLAY_B_ONLY))
    const trailBefore = trail.length

    await act(async () => {
      await getVm().handleRefreshWorkspaceData(DESKTOP_ROUTES.agents)
    })
    await waitFor(() => expect(getVm().selectedAgent).toBe(HOST_B))
    await settle()

    // Liveness witness: the refresh dropped A and the deselect effect ran.
    expect(trail.slice(trailBefore)).toContain(null)
    // Nothing holds A, so ChatPage picks the remaining Host.
    expect(getVm().isHostAccessBlocked(HOST_A)).toBe(false)
    expect(toastTexts(getVm())).toEqual([GONE_A])
  })
})
