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
import { ipcHostAccessRevoked } from '../domain/__tests__/__fixtures__/ipcErrors'
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
})
