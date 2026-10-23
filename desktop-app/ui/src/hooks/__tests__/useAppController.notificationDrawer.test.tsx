// @vitest-environment jsdom
import { useCallback, useLayoutEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NavigationContext, useNavigationContext } from '@contexts/NavigationContext'
import { act, cleanup, waitFor } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { ChatPage } from '@pages/ChatPage'
import type { AppNotification } from '../../uiTypes'
import { installAppControllerClerum } from '../domain/__tests__/__fixtures__/appControllerHarness'
import { deferred, serverSessions } from '../domain/__tests__/__fixtures__/catalogFixtures'
import { renderChatActionConsumer } from '../domain/__tests__/__fixtures__/chatActionConsumerHarness'
import { ipcGenericForbidden } from '../domain/__tests__/__fixtures__/ipcErrors'
import { uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@components/agents/AgentWorkspace', () => ({ AgentWorkspace: () => null }))

const HOST_A = 'agent-a'
const HOST_B = 'agent-b'
const NAMES = { [HOST_A]: 'Research Host', [HOST_B]: 'Billing Host' }

async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  uninstallMockClerum()
})

describe('chat opened from a notification', () => {
  // The real controller and ChatPage, with ChatPage mounted as the drawer over Files. A
  // notification opens B's conversation full screen; back on Files the drawer shows B. When B
  // is then held, the drawer must stay on B instead of selecting another Host.
  it('T-A36R2-1: a hold of the Host opened from a notification keeps the drawer on it', async () => {
    const { clerum, handle } = installAppControllerClerum({
      agentNames: [HOST_A, HOST_B],
      agentDisplayByName: NAMES,
    })
    clerum.rpc.listSessions.mockImplementation(async () => serverSessions([]))
    const pendingB = deferred<{ agent: string; chatId: string; turns: never[] }>()
    let readsB = 0
    clerum.rpc.loadSessionMessages.mockImplementation((host: string) => {
      if (host === HOST_B && ++readsB === 1) return pendingB.promise
      return Promise.resolve({ agent: host, chatId: 'c', turns: [] })
    })
    const trail: Array<string | null> = []
    let getController: Awaited<ReturnType<typeof renderChatActionConsumer>>['getVm'] | null = null
    function Drawer() {
      const vm = useNavigationContext()
      const select = useCallback(
        (host: string, opts: Parameters<typeof vm.handleSelectChatAgent>[1] = {}) => {
          if (!getController) throw new Error('controller not rendered')
          getController().handleSelectChatAgent(host, { ...opts, keepNavItem: true })
        },
        []
      )
      useLayoutEffect(() => {
        trail.push(vm.selectedAgent)
      }, [vm.selectedAgent])
      return vm.navItem === DESKTOP_ROUTES.files ? (
        <div data-testid="drawer-chat">
          <NavigationContext.Provider value={{ ...vm, handleSelectChatAgent: select }}>
            <ChatPage scrollContainerRef={{ current: null }} />
          </NavigationContext.Provider>
        </div>
      ) : null
    }
    const { getVm } = await renderChatActionConsumer(<Drawer />)
    getController = getVm
    await waitFor(() => expect(handle.refreshCatalog).toHaveBeenCalledTimes(2))

    // The drawer over Files auto-selects A.
    act(() => getVm().handleNavSelect(DESKTOP_ROUTES.files))
    await waitFor(() => expect(getVm().selectedAgent).toBe(HOST_A))

    // A notification for B opens full screen.
    await act(async () => {
      await getVm().handleOpenNotification({
        id: 'n1',
        kind: 'assistant_reply',
        agentName: HOST_B,
        chatId: 'b-chat',
        text: 'reply',
      } as AppNotification)
    })
    await waitFor(() => expect(getVm().selectedAgent).toBe(HOST_B))
    expect(getVm().navItem).toBe(DESKTOP_ROUTES.chat)
    await settle()

    // Back on Files, the drawer shows B; B's transcript read is still pending.
    act(() => getVm().handleNavSelect(DESKTOP_ROUTES.files))
    await settle()
    expect(getVm().selectedAgent).toBe(HOST_B)
    expect(readsB).toBe(1)
    const start = trail.length

    await act(async () => {
      pendingB.reject(await ipcGenericForbidden('rpc:loadSessionMessages'))
      await pendingB.promise.catch(() => undefined)
    })
    await waitFor(() => expect(getVm().isHostAccessBlocked(HOST_B)).toBe(true))
    await settle()

    expect(getVm().heldHosts.map(host => host.agentRef)).toEqual([HOST_B])
    expect(getVm().keepFocusedChat).toBe(true)
    expect(trail.slice(start)).toEqual([null])
    expect(getVm().selectedAgent).toBe(null)
  })
})
