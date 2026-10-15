// @vitest-environment jsdom
/**
 * F4: the renderer shares one in-flight `listSessions` request per
 * scope/Host/query for five seconds. A request issued before a Host hold is
 * answered with the authority that held before the hold; handing it to a reader
 * that starts after `verifyHostAccess` released the hold would let that stale
 * answer re-hold a Host the user was just cleared for. Holding a Host therefore
 * invalidates its cached catalog requests.
 *
 * The held Host is deliberately not the selected one: a revoked hold of the
 * selected agent already clears the whole cache through the chat controller's
 * teardown, which would hide the defect.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import type { SessionsListResult } from '../../../../src/types'
import {
  installAppControllerClerum,
  renderAppController,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import {
  deferred,
  localIndex,
  serverSessions,
} from '../domain/__tests__/__fixtures__/catalogFixtures'
import {
  ipcGenericForbidden,
  ipcHostAccessRevoked,
} from '../domain/__tests__/__fixtures__/ipcErrors'
import { uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type ListSessionsQuery = { agent?: string; limit?: number; cursor?: string }

describe('useAppController Host hold and the session catalog cache', () => {
  let unmount: (() => void) | null = null

  afterEach(() => {
    unmount?.()
    unmount = null
    vi.restoreAllMocks()
    uninstallMockClerum()
  })

  it('does not hand a pre-hold catalog request to a reader after the hold is released', async () => {
    const { clerum } = installAppControllerClerum({ agentNames: ['agent-x', 'agent-y'] })
    const staleCatalog = deferred<SessionsListResult>()
    let heldHostPageReads = 0
    clerum.chat.getIndex.mockImplementation(async (agentRef: string) =>
      agentRef === 'agent-x' ? localIndex([{ id: 'c1', title: 'old' }]) : localIndex([])
    )
    clerum.rpc.listSessions.mockImplementation(
      async (hostRef: string, _teamId: string | undefined, query?: ListSessionsQuery) => {
        if (query?.limit === 1 || hostRef !== 'agent-x') return serverSessions([])
        heldHostPageReads += 1
        if (heldHostPageReads === 1) return staleCatalog.promise
        return serverSessions([{ agent: 'agent-x', chatId: 'c1', title: 'old' }])
      }
    )
    clerum.rpc.renameSession.mockRejectedValue(await ipcHostAccessRevoked('rpc:renameSession'))

    const app = renderAppController()
    unmount = app.unmount
    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
    act(() => {
      app.result.current.handleSelectChatAgent('agent-y')
    })
    // The cross-agent preview's catalog read for agent-x is in flight and
    // stays so across the hold.
    await waitFor(() => expect(heldHostPageReads).toBe(1))

    await act(async () => {
      await app.result.current.handleRenameChatForAgent('agent-x', 'c1', 'new')
    })
    // Witness: the rename's confirmed revocation held agent-x.
    expect(clerum.rpc.renameSession).toHaveBeenCalledWith('agent-x', 'agent-x', 'c1', 'new')
    expect(app.result.current.isHostAccessBlocked('agent-x')).toBe(true)

    act(() => {
      app.result.current.handleSelectChatAgent('agent-x')
    })
    await waitFor(() => expect(app.result.current.isHostAccessBlocked('agent-x')).toBe(false))
    // The post-release reader issued its own catalog request instead of
    // sharing the pre-hold one.
    await waitFor(() => expect(heldHostPageReads).toBe(2))
    await waitFor(() =>
      expect(app.result.current.chatList.some(chat => chat.id === 'c1')).toBe(true)
    )

    await act(async () => {
      staleCatalog.reject(await ipcHostAccessRevoked('rpc:listSessions'))
      await staleCatalog.promise.catch(() => undefined)
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })

    expect(app.result.current.isHostAccessBlocked('agent-x')).toBe(false)
  })

  // #1130: the cross-agent loader's read of agent-x starts before the hold and
  // fails with a generic 403 after it. `readSessionCatalog` retries it with
  // `force`, so a request made while agent-x is held enters the cache.
  // Releasing the hold must drop it.
  async function holdThenRelease() {
    const { clerum } = installAppControllerClerum({ agentNames: ['agent-x', 'agent-y'] })
    const preHoldCatalog = deferred<SessionsListResult>()
    const heldCatalog = deferred<SessionsListResult>()
    // Whether agent-x was held when each of its catalog page requests went out.
    const pageRequestsHeld: boolean[] = []
    let app: ReturnType<typeof renderAppController> | undefined
    clerum.chat.getIndex.mockImplementation(async (agentRef: string) =>
      agentRef === 'agent-x' ? localIndex([{ id: 'c1', title: 'old' }]) : localIndex([])
    )
    clerum.rpc.listSessions.mockImplementation(
      async (hostRef: string, _teamId: string | undefined, query?: ListSessionsQuery) => {
        if (query?.limit === 1 || hostRef !== 'agent-x') return serverSessions([])
        const held = app?.result.current.isHostAccessBlocked('agent-x') ?? false
        pageRequestsHeld.push(held)
        if (pageRequestsHeld.length === 1) return preHoldCatalog.promise
        if (held) return heldCatalog.promise
        return serverSessions([{ agent: 'agent-x', chatId: 'c1', title: 'old' }])
      }
    )
    clerum.rpc.renameSession.mockRejectedValue(await ipcHostAccessRevoked('rpc:renameSession'))

    app = renderAppController()
    unmount = app.unmount
    const rendered = app
    await waitFor(() => expect(rendered.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(rendered.result.current.initialExperienceLoading).toBe(false))
    act(() => {
      rendered.result.current.handleSelectChatAgent('agent-y')
    })
    await waitFor(() => expect(pageRequestsHeld).toEqual([false]))

    await act(async () => {
      await rendered.result.current.handleRenameChatForAgent('agent-x', 'c1', 'new')
    })
    expect(rendered.result.current.isHostAccessBlocked('agent-x')).toBe(true)
    await act(async () => {
      preHoldCatalog.reject(await ipcGenericForbidden('rpc:listSessions'))
      await preHoldCatalog.promise.catch(() => undefined)
    })
    // Witness: the forced retry went out while agent-x was held, and stays pending.
    await waitFor(() => expect(pageRequestsHeld).toEqual([false, true]))

    act(() => {
      rendered.result.current.handleSelectChatAgent('agent-x')
    })
    await waitFor(() => expect(rendered.result.current.isHostAccessBlocked('agent-x')).toBe(false))
    // Witness: one access verification released the hold.
    expect(
      clerum.rpc.listSessions.mock.calls.filter(
        ([hostRef, , query]) => hostRef === 'agent-x' && query?.limit === 1
      )
    ).toHaveLength(1)
    return { app: rendered, heldCatalog, pageRequestsHeld }
  }

  it('T-1130-1 (a): the first catalog read after the release is a new request', async () => {
    const { pageRequestsHeld } = await holdThenRelease()

    await waitFor(() => expect(pageRequestsHeld).toEqual([false, true, false]))
  })

  it('T-1130-1 (b): a revocation of the request made during the hold does not re-hold the Host', async () => {
    const { app, heldCatalog } = await holdThenRelease()
    // Witness: a post-release cross-agent reader asked for agent-x's catalog.
    // The revocation dropped agent-x's rows, and a loader publishes a Host's
    // local rows in the same synchronous step that issues its catalog read.
    await waitFor(() =>
      expect(
        app.result.current.latestChatSessions.some(
          row => row.agentRef === 'agent-x' && row.id === 'c1'
        )
      ).toBe(true)
    )

    await act(async () => {
      heldCatalog.reject(await ipcHostAccessRevoked('rpc:listSessions'))
      // Witness: the request made during the hold was rejected.
      await expect(heldCatalog.promise).rejects.toBeDefined()
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })

    expect(app.result.current.isHostAccessBlocked('agent-x')).toBe(false)
  })
})
