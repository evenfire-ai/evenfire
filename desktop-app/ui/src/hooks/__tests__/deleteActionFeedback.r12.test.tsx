// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAgentChatActionsContext } from '@contexts/AgentChatActionsContext'
import { useNavigationContext } from '@contexts/NavigationContext'
import { useNotificationsContext } from '@contexts/NotificationsContext'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { SidebarNav } from '@components/SidebarNav'
import { ChatThread } from '@components/agents/ChatThread'
import { installAppControllerClerum } from '../domain/__tests__/__fixtures__/appControllerHarness'
import { deferred } from '../domain/__tests__/__fixtures__/catalogFixtures'
import { renderChatActionConsumer } from '../domain/__tests__/__fixtures__/chatActionConsumerHarness'
import { uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
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
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  Reflect.deleteProperty(window, 'matchMedia')
})

function BoundSidebar() {
  const nav = useNavigationContext()
  const { pushToast } = useNotificationsContext()
  const { handleCreateChat } = useAgentChatActionsContext()
  return (
    <SidebarNav
      navItem={nav.navItem}
      collapsed={false}
      activeSandboxUiApp={null}
      availableSandboxUiApps={[]}
      onCollapsedChange={() => undefined}
      onNewChat={() => {
        void handleCreateChat()
      }}
      onOpenSandboxUiApp={() => undefined}
      onSelect={nav.handleNavSelect}
      onOpenFilesSection={() => undefined}
      onOpenPreviewSection={() => undefined}
      pushToast={pushToast}
    />
  )
}

async function mountDelete(origin: 'thread' | 'sidebar', chatIds = ['chat-1', 'chat-2', 'chat-3']) {
  const { clerum } = installAppControllerClerum()
  for (const chat of chatIds) {
    await clerum.chat.create('agent-x', chat)
    await clerum.chat.upsertMessages('agent-x', chat, [
      { id: `${chat}-history`, role: 'user', content: `${chat} real history`, timestamp: 1 },
    ])
  }
  clerum.chat.getIndex.mockImplementation(agent => clerum.readIndex(agent))
  const app = await renderChatActionConsumer(
    <>
      {origin === 'sidebar' && <BoundSidebar />}
      <ChatThread />
    </>
  )
  act(() => app.getVm().handleSelectChatAgent('agent-x', { selectLatest: false }))
  await waitFor(() => expect(app.getVm().chatListLoading).toBe(false))
  await waitFor(() => expect(app.getVm().chatList).toHaveLength(chatIds.length))
  if (origin === 'sidebar')
    await waitFor(() => expect(app.getVm().latestChatSessions).toHaveLength(chatIds.length))
  const chats =
    origin === 'thread'
      ? [...app.getVm().chatList].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      : app.getVm().latestChatSessions
  const row = chats.findIndex(chat => chat.id === 'chat-1')
  const menuName = origin === 'thread' ? 'Session actions for' : 'Session options for'
  fireEvent.click(screen.getAllByRole('button', { name: `${menuName} ${chats[row]!.title}` })[row]!)
  fireEvent.click(
    origin === 'thread'
      ? screen.getByRole('button', { name: 'Delete' })
      : screen.getByRole('menuitem', { name: 'Delete' })
  )
  await screen.findByRole('dialog', { name: 'Delete session?' })
  // The session list is the blank dedicated view. A real navigation while its
  // confirmation is open makes the captured chat active, as an app notification
  // can also do; no private controller state is fabricated.
  act(() => app.getVm().handleSelectChatAgent('agent-x', { chatId: 'chat-1', selectLatest: false }))
  await waitFor(() => expect(screen.getByText('chat-1 real history')).toBeTruthy())
  await waitFor(() => expect(app.getVm().sessionStateByChatId['chat-1']?.syncing).toBe(false))
  return { app, clerum }
}

function confirmDelete() {
  fireEvent.click(
    within(screen.getByRole('dialog', { name: 'Delete session?' })).getByRole('button', {
      name: 'Delete',
    })
  )
}

it.each(['thread', 'sidebar'] as const)(
  '%s delete reports its current successor-open failure exactly once',
  async origin => {
    const { app, clerum } = await mountDelete(origin)
    const error = new Error(`${origin} successor failed`)
    clerum.chat.setLastActive.mockRejectedValueOnce(error)
    confirmDelete()
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1))
    expect(screen.getByRole('alert').textContent).toContain(
      `Could not open conversation: ${error.message}`
    )
    expect(app.getVm().toasts).toHaveLength(1)
    const index = await clerum.readIndex('agent-x')
    expect(index.chats.some(chat => chat.id === 'chat-1')).toBe(false)
    expect(app.getVm().activeChatId).not.toBe('chat-1')
    expect(app.getVm().activeMessages).toEqual([])
    expect(app.getVm().chatMessagesLoading).toBe(false)
  }
)

it.each(['thread', 'sidebar'] as const)(
  '%s observes stale delete successor rejection without stale feedback',
  async origin => {
    const { app, clerum } = await mountDelete(origin)
    const entered = deferred<void>()
    const held = deferred<void>()
    clerum.chat.setLastActive.mockImplementationOnce(async () => {
      entered.resolve()
      return held.promise
    })
    confirmDelete()
    await act(async () => {
      await entered.promise
    })
    // Pick a destination distinct from the delete operation's current successor.
    const destination = app.getVm().activeChatId === 'chat-2' ? 'chat-3' : 'chat-2'
    act(() =>
      app.getVm().handleSelectChatAgent('agent-x', { chatId: destination, selectLatest: false })
    )
    await waitFor(() => expect(screen.getByText(`${destination} real history`)).toBeTruthy())
    await waitFor(() => expect(app.getVm().sessionStateByChatId[destination]?.syncing).toBe(false))
    const status = { text: app.getVm().statusText, tone: app.getVm().statusTone }
    await act(async () => {
      held.reject(new Error('obsolete deleted-chat successor'))
      await held.promise.catch(() => undefined)
    })
    expect(app.getVm().activeChatId).toBe(destination)
    expect(app.getVm().activeMessages.map(message => message.content)).toEqual([
      `${destination} real history`,
    ])
    expect(app.getVm().chatMessagesLoading).toBe(false)
    expect(app.getVm().toasts).toEqual([])
    expect(screen.queryAllByRole('alert')).toEqual([])
    expect({ text: app.getVm().statusText, tone: app.getVm().statusTone }).toEqual(status)
  }
)

it('last-chat deletion observes fallback create failure with creation-owned wording', async () => {
  const { app, clerum } = await mountDelete('sidebar', ['chat-1'])
  clerum.chat.create.mockRejectedValueOnce(new Error('delete replacement creation failed'))
  confirmDelete()
  await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1))
  expect(screen.getByRole('alert').textContent).toContain(
    'Could not create conversation: delete replacement creation failed'
  )
  expect(app.getVm().toasts).toHaveLength(1)
  expect((await clerum.readIndex('agent-x')).chats).toEqual([])
  expect(app.getVm().activeMessages).toEqual([])
  expect(app.getVm().chatMessagesLoading).toBe(false)
})

it('raw awaited deletion preserves the original successor-switch rejection', async () => {
  const { app, clerum } = await mountDelete('sidebar')
  const fence = await app.getVm().captureChatDeleteFence('agent-x')
  const error = new Error('raw successor failure')
  clerum.chat.setLastActive.mockRejectedValueOnce(error)
  await act(async () => {
    await expect(app.getVm().handleDeleteChat('chat-1', fence)).rejects.toBe(error)
  })
  expect((await clerum.readIndex('agent-x')).chats.some(chat => chat.id === 'chat-1')).toBe(false)
  expect(app.getVm().chatMessagesLoading).toBe(false)
})
