// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNavigationContext } from '@contexts/NavigationContext'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { SidebarNav } from '@components/SidebarNav'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { ChatPage } from '@pages/ChatPage'
import { installAppControllerClerum } from '../domain/__tests__/__fixtures__/appControllerHarness'
import { serverSessions } from '../domain/__tests__/__fixtures__/catalogFixtures'
import { renderChatActionConsumer } from '../domain/__tests__/__fixtures__/chatActionConsumerHarness'
import { ipcGenericForbidden } from '../domain/__tests__/__fixtures__/ipcErrors'
import { uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'
import type { useAppController } from '../useAppController'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@components/agents/AgentWorkspace', () => ({ AgentWorkspace: () => null }))
vi.mock('@components/SidebarNav/FileExplorerTree', () => ({ FileExplorerTree: () => null }))

type Vm = ReturnType<typeof useAppController>
const HOST_A = 'agent-a'
const HOST_B = 'agent-b'

function ChatRoute() {
  const { navItem } = useNavigationContext()
  return navItem === DESKTOP_ROUTES.chat ? (
    <ChatPage scrollContainerRef={{ current: null }} />
  ) : null
}

function Sidebar() {
  const { navItem, handleNavSelect } = useNavigationContext()
  return (
    <SidebarNav
      navItem={navItem}
      collapsed={false}
      activeSandboxUiApp={null}
      availableSandboxUiApps={[]}
      onCollapsedChange={() => undefined}
      onNewChat={() => undefined}
      onOpenSandboxUiApp={() => undefined}
      onSelect={handleNavSelect}
      onOpenFilesSection={() => undefined}
      onOpenPreviewSection={() => undefined}
      pushToast={() => undefined}
    />
  )
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  uninstallMockClerum()
  Reflect.deleteProperty(window, 'matchMedia')
})

describe('Retry on a held Host', () => {
  // The real controller, ChatPage and SidebarNav. A's transcript read of its focused chat tab
  // is denied, so A is held while that tab stays on screen; Retry must return to that
  // conversation instead of opening a new blank chat tab for A.
  it('T-A36R1-1: Retry on the Host of the focused chat tab returns to that conversation', async () => {
    const { clerum } = installAppControllerClerum({ agentNames: [HOST_A, HOST_B] })
    const verifyReads: string[] = []
    clerum.rpc.listSessions.mockImplementation(
      async (hostRef: string, _teamId: string | undefined, query?: { limit?: number }) => {
        if (query?.limit === 1) verifyReads.push(hostRef)
        return serverSessions([])
      }
    )
    const transcriptError = await ipcGenericForbidden('rpc:loadSessionMessages')
    let denyTranscript = false
    clerum.rpc.loadSessionMessages.mockImplementation(async (hostRef: string) => {
      if (hostRef === HOST_A && denyTranscript) throw transcriptError
      return { agent: hostRef, chatId: '', turns: [] }
    })
    const { getVm } = await renderChatActionConsumer(
      <>
        <ChatRoute />
        <Sidebar />
      </>
    )
    await waitFor(() => expect(getVm().selectedAgent).not.toBe(null))
    const openChat = async (agentRef: string, chatId: string) => {
      act(() => {
        getVm().handleSelectChatAgent(agentRef, { chatId, selectLatest: false })
      })
      await waitFor(() => expect(getVm().selectedAgent).toBe(agentRef))
      await waitFor(() => expect(getVm().activeWorkspaceTab?.chat?.chatId).toBe(chatId))
    }
    await openChat(HOST_A, 'chat-1')
    await openChat(HOST_A, 'chat-2')
    denyTranscript = true
    await openChat(HOST_A, 'chat-1')
    await waitFor(() => expect(getVm().isHostAccessBlocked(HOST_A)).toBe(true))
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    // Witnesses: A held and deselected, its chat-1 tab still focused, the Retry row rendered.
    expect(getVm().selectedAgent).toBe(null)
    expect(getVm().activeWorkspaceTab?.chat).toMatchObject({ agentRef: HOST_A, chatId: 'chat-1' })
    expect(getVm().heldHosts.map(host => host.agentRef)).toEqual([HOST_A])
    denyTranscript = false
    const tabsBefore = getVm().workspaceTabs.tabs.length
    const readsBefore = verifyReads.filter(ref => ref === HOST_A).length

    fireEvent.click(screen.getByRole('button', { name: `Retry access to ${HOST_A}` }))

    await waitFor(() => expect(getVm().selectedAgent).toBe(HOST_A))
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(verifyReads.filter(ref => ref === HOST_A).length).toBe(readsBefore + 1)
    expect(getVm().isHostAccessBlocked(HOST_A)).toBe(false)
    expect(getVm().activeWorkspaceTab?.chat).toMatchObject({ agentRef: HOST_A, chatId: 'chat-1' })
    expect(getVm().workspaceTabs.tabs.length).toBe(tabsBefore)
  })
})
