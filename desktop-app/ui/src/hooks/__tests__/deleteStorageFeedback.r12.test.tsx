// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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

function StorageDeleteSidebar() {
  const nav = useNavigationContext()
  const { pushToast } = useNotificationsContext()
  return (
    <SidebarNav
      navItem={nav.navItem}
      collapsed={false}
      activeSandboxUiApp={null}
      availableSandboxUiApps={[]}
      onCollapsedChange={() => undefined}
      onNewChat={() => undefined}
      onOpenSandboxUiApp={() => undefined}
      onSelect={nav.handleNavSelect}
      onOpenFilesSection={() => undefined}
      onOpenPreviewSection={() => undefined}
      pushToast={pushToast}
    />
  )
}

async function mountStorageDelete() {
  const { clerum } = installAppControllerClerum()
  for (const chat of ['chat-1', 'chat-2']) {
    await clerum.chat.create('agent-x', chat)
    await clerum.chat.upsertMessages('agent-x', chat, [
      { id: `${chat}-history`, role: 'user', content: `${chat} real history`, timestamp: 1 },
    ])
  }
  clerum.chat.getIndex.mockImplementation(agent => clerum.readIndex(agent))
  const app = await renderChatActionConsumer(
    <>
      <StorageDeleteSidebar />
      <ChatThread />
    </>
  )
  act(() => app.getVm().handleSelectChatAgent('agent-x', { chatId: 'chat-1', selectLatest: false }))
  await waitFor(() => expect(screen.getByText('chat-1 real history')).toBeTruthy())
  await waitFor(() => expect(app.getVm().sessionStateByChatId['chat-1']?.syncing).toBe(false))
  await waitFor(() => expect(app.getVm().latestChatSessions).toHaveLength(2))
  const row = app.getVm().latestChatSessions.findIndex(chat => chat.id === 'chat-1')
  const title = app.getVm().latestChatSessions[row]!.title
  fireEvent.click(screen.getAllByRole('button', { name: `Session options for ${title}` })[row]!)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
  await screen.findByRole('dialog', { name: 'Delete session?' })
  return { app, clerum }
}

function confirmStorageDelete() {
  fireEvent.click(
    within(screen.getByRole('dialog', { name: 'Delete session?' })).getByRole('button', {
      name: 'Delete',
    })
  )
}

it('reports a current storage deletion failure once and retains the actual conversation', async () => {
  const { app, clerum } = await mountStorageDelete()
  clerum.chat.delete.mockRejectedValueOnce(new Error('storage deletion failed'))
  confirmStorageDelete()
  await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1))
  expect(screen.getByRole('alert').textContent).toContain(
    'Could not delete the chat. Please try again.'
  )
  expect(app.getVm().toasts).toHaveLength(1)
  expect(app.getVm().activeChatId).toBe('chat-1')
  expect(app.getVm().activeMessages.map(message => message.content)).toEqual([
    'chat-1 real history',
  ])
  expect(screen.getByText('chat-1 real history')).toBeTruthy()
  expect(app.getVm().chatMessagesLoading).toBe(false)
  expect((await clerum.readIndex('agent-x')).chats.some(chat => chat.id === 'chat-1')).toBe(true)
})

it('suppresses stale storage deletion feedback after newer navigation owns real history', async () => {
  const { app, clerum } = await mountStorageDelete()
  const entered = deferred<void>()
  const held = deferred<Awaited<ReturnType<typeof clerum.chat.delete>>>()
  clerum.chat.delete.mockImplementationOnce(async () => {
    entered.resolve()
    return held.promise
  })
  confirmStorageDelete()
  await act(async () => {
    await entered.promise
  })
  act(() => app.getVm().handleSelectChatAgent('agent-x', { chatId: 'chat-2', selectLatest: false }))
  await waitFor(() => expect(screen.getByText('chat-2 real history')).toBeTruthy())
  await waitFor(() => expect(app.getVm().sessionStateByChatId['chat-2']?.syncing).toBe(false))
  const status = { text: app.getVm().statusText, tone: app.getVm().statusTone }
  await act(async () => {
    held.reject(new Error('obsolete storage deletion failed'))
    await held.promise.catch(() => undefined)
  })
  expect(app.getVm().activeChatId).toBe('chat-2')
  expect(app.getVm().activeMessages.map(message => message.content)).toEqual([
    'chat-2 real history',
  ])
  expect(screen.getByText('chat-2 real history')).toBeTruthy()
  expect(app.getVm().chatMessagesLoading).toBe(false)
  expect(app.getVm().toasts).toEqual([])
  expect(screen.queryAllByRole('alert')).toEqual([])
  expect({ text: app.getVm().statusText, tone: app.getVm().statusTone }).toEqual(status)
  expect((await clerum.readIndex('agent-x')).chats.some(chat => chat.id === 'chat-1')).toBe(true)
})

it.each([false, true])(
  'delete access confirmation reports only current failure (stale=%s)',
  async stale => {
    const { app, clerum } = await mountStorageDelete()
    const held = deferred<Awaited<ReturnType<typeof clerum.chat.captureDeleteFence>>>()
    clerum.chat.captureDeleteFence.mockReturnValueOnce(held.promise)
    const error = new Error('confirmation failed')
    let request!: Promise<unknown>
    act(() => {
      request = app.getVm().captureChatDeleteFence('agent-x')
    })
    const observed = request.catch(cause => cause)
    if (stale) {
      act(() =>
        app.getVm().handleSelectChatAgent('agent-x', { chatId: 'chat-2', selectLatest: false })
      )
      await waitFor(() => expect(screen.getByText('chat-2 real history')).toBeTruthy())
      await waitFor(() => expect(app.getVm().sessionStateByChatId['chat-2']?.syncing).toBe(false))
    }
    const status = { text: app.getVm().statusText, tone: app.getVm().statusTone }
    await act(async () => {
      held.reject(error)
      expect(await observed).toBe(error)
    })
    expect(app.getVm().toasts).toHaveLength(stale ? 0 : 1)
    expect(screen.queryAllByRole('alert')).toHaveLength(stale ? 0 : 1)
    if (!stale)
      expect(screen.getByRole('alert').textContent).toContain('Could not confirm chat access')
    expect(app.getVm().activeChatId).toBe(stale ? 'chat-2' : 'chat-1')
    expect(app.getVm().activeMessages.map(message => message.content)).toEqual([
      `${stale ? 'chat-2' : 'chat-1'} real history`,
    ])
    expect(app.getVm().chatMessagesLoading).toBe(false)
    if (stale)
      expect({ text: app.getVm().statusText, tone: app.getVm().statusTone }).toEqual(status)
    expect((await clerum.readIndex('agent-x')).chats).toHaveLength(2)
  }
)
