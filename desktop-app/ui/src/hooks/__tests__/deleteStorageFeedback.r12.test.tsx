// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNavigationContext } from '@contexts/NavigationContext'
import { useNotificationsContext } from '@contexts/NotificationsContext'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { promises as fs } from 'node:fs'
import { SidebarNav } from '@components/SidebarNav'
import { ChatThread } from '@components/agents/ChatThread'
import { installAppControllerClerum } from '../domain/__tests__/__fixtures__/appControllerHarness'
import { deferred } from '../domain/__tests__/__fixtures__/catalogFixtures'
import { renderChatActionConsumer } from '../domain/__tests__/__fixtures__/chatActionConsumerHarness'
import { ipcHostAccessRevoked } from '../domain/__tests__/__fixtures__/ipcErrors'
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

async function mountStorageDelete(target = 'chat-2', withOtherAgent = false) {
  const { clerum, handle } = installAppControllerClerum({
    agentNames: withOtherAgent ? ['agent-x', 'agent-y'] : ['agent-x'],
  })
  const runtimeConfig = await window.clerum.auth.getRuntimeConfigState()
  vi.mocked(window.clerum.auth.getRuntimeConfigState).mockResolvedValue({
    ...runtimeConfig,
    envKey: 'delete-feedback-fixture',
  })
  for (const chat of ['chat-1', 'chat-2', 'chat-3']) {
    await clerum.chat.create('agent-x', chat)
    await clerum.chat.upsertMessages('agent-x', chat, [
      { id: `${chat}-history`, role: 'user', content: `${chat} real history`, timestamp: 1 },
    ])
  }
  if (withOtherAgent) {
    await clerum.chat.create('agent-y', 'other-chat')
    await clerum.chat.upsertMessages('agent-y', 'other-chat', [
      { id: 'other-history', role: 'user', content: 'other agent real history', timestamp: 1 },
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
  await waitFor(() => expect(app.getVm().latestChatSessions).toHaveLength(withOtherAgent ? 4 : 3))
  const row = app.getVm().latestChatSessions.findIndex(chat => chat.id === target)
  const title = app.getVm().latestChatSessions[row]!.title
  fireEvent.click(screen.getAllByRole('button', { name: `Session options for ${title}` })[row]!)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
  await screen.findByRole('dialog', { name: 'Delete session?' })
  return { app, clerum, handle }
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
  expect((await clerum.readIndex('agent-x')).chats.some(chat => chat.id === 'chat-2')).toBe(true)
  expect(app.getVm().latestChatSessions.some(chat => chat.id === 'chat-2')).toBe(true)
})

it.each([false, true])(
  'reports a failed explicit deletion after same-scope navigation (otherAgent=%s)',
  async otherAgent => {
    const { app, clerum } = await mountStorageDelete('chat-2', otherAgent)
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
    const agent = otherAgent ? 'agent-y' : 'agent-x'
    const chatId = otherAgent ? 'other-chat' : 'chat-3'
    const history = otherAgent ? 'other agent real history' : 'chat-3 real history'
    act(() => app.getVm().handleSelectChatAgent(agent, { chatId, selectLatest: false }))
    await waitFor(() => expect(screen.getByText(history)).toBeTruthy())
    await waitFor(() => expect(app.getVm().sessionStateByChatId[chatId]?.syncing).toBe(false))
    const status = { text: app.getVm().statusText, tone: app.getVm().statusTone }
    await act(async () => {
      held.reject(new Error('requested storage deletion failed'))
      await held.promise.catch(() => undefined)
    })
    expect(app.getVm().selectedAgent).toBe(agent)
    expect(app.getVm().activeChatId).toBe(chatId)
    expect(app.getVm().activeMessages.map(message => message.content)).toEqual([history])
    expect(screen.getByText(history)).toBeTruthy()
    expect(app.getVm().chatMessagesLoading).toBe(false)
    expect(app.getVm().toasts).toHaveLength(1)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toContain('Could not delete the chat')
    expect({ text: app.getVm().statusText, tone: app.getVm().statusTone }).toEqual(status)
    expect((await clerum.readIndex('agent-x')).chats.some(chat => chat.id === 'chat-2')).toBe(true)
    expect(app.getVm().latestChatSessions.some(chat => chat.id === 'chat-2')).toBe(true)
  }
)

it.each([false, true])(
  'delete access confirmation remains observable across navigation (navigated=%s)',
  async navigated => {
    const { app, clerum } = await mountStorageDelete()
    const held = deferred<Awaited<ReturnType<typeof clerum.chat.captureDeleteFence>>>()
    clerum.chat.captureDeleteFence.mockReturnValueOnce(held.promise)
    const error = new Error('confirmation failed')
    let request!: Promise<unknown>
    act(() => {
      request = app.getVm().captureChatDeleteFence('agent-x')
    })
    const observed = request.catch(cause => cause)
    if (navigated) {
      act(() =>
        app.getVm().handleSelectChatAgent('agent-x', { chatId: 'chat-3', selectLatest: false })
      )
      await waitFor(() => expect(screen.getByText('chat-3 real history')).toBeTruthy())
      await waitFor(() => expect(app.getVm().sessionStateByChatId['chat-3']?.syncing).toBe(false))
    }
    const status = { text: app.getVm().statusText, tone: app.getVm().statusTone }
    await act(async () => {
      held.reject(error)
      expect(await observed).toBe(error)
    })
    expect(app.getVm().toasts).toHaveLength(1)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toContain('Could not confirm chat access')
    expect(app.getVm().activeChatId).toBe(navigated ? 'chat-3' : 'chat-1')
    expect(app.getVm().activeMessages.map(message => message.content)).toEqual([
      `${navigated ? 'chat-3' : 'chat-1'} real history`,
    ])
    expect(app.getVm().chatMessagesLoading).toBe(false)
    expect({ text: app.getVm().statusText, tone: app.getVm().statusTone }).toEqual(status)
    expect((await clerum.readIndex('agent-x')).chats).toHaveLength(3)
  }
)

it.each(['storage', 'confirmation'] as const)(
  'suppresses %s failure only after its originating authority scope is invalidated',
  async phase => {
    const { app, clerum } = await mountStorageDelete()
    const held = deferred<never>()
    let observed: Promise<unknown>
    if (phase === 'storage') {
      const deletion = await app.getVm().captureChatDeleteFence('agent-x')
      clerum.chat.delete.mockReturnValueOnce(held.promise)
      observed = app.getVm().handleDeleteChat('chat-2', deletion)
    } else {
      clerum.chat.captureDeleteFence.mockReturnValueOnce(held.promise)
      observed = app.getVm().captureChatDeleteFence('agent-x')
    }
    const settled = observed.catch(error => error)
    await act(async () => {
      await app.getVm().handleEnsureTeamContext({ teamId: 'team-2' })
    })
    await waitFor(() => expect(app.getVm().currentTeamId).toBe('team-2'))
    act(() =>
      app.getVm().handleSelectChatAgent('agent-x', { chatId: 'chat-3', selectLatest: false })
    )
    await waitFor(() => expect(screen.getByText('chat-3 real history')).toBeTruthy())
    await waitFor(() => expect(app.getVm().chatMessagesLoading).toBe(false))
    await waitFor(() => expect(app.getVm().sessionStateByChatId['chat-3']?.syncing).toBe(false))
    const status = { text: app.getVm().statusText, tone: app.getVm().statusTone }
    const error = new Error(`old-team ${phase} failure`)
    await act(async () => {
      held.reject(error)
      expect(await settled).toBe(phase === 'confirmation' ? error : undefined)
    })
    expect(app.getVm().toasts).toEqual([])
    expect(screen.queryAllByRole('alert')).toEqual([])
    expect(app.getVm().activeChatId).toBe('chat-3')
    expect(app.getVm().activeMessages.map(message => message.content)).toEqual([
      'chat-3 real history',
    ])
    expect(screen.getByText('chat-3 real history')).toBeTruthy()
    expect(app.getVm().chatMessagesLoading).toBe(false)
    expect({ text: app.getVm().statusText, tone: app.getVm().statusTone }).toEqual(status)
    expect((await clerum.readIndex('agent-x')).chats.some(chat => chat.id === 'chat-2')).toBe(true)
  }
)

it('reports cancellation when the real Delete dialog is confirmed after a team change', async () => {
  const { app, clerum } = await mountStorageDelete()
  expect(screen.getByRole('dialog', { name: 'Delete session?' })).toBeTruthy()
  clerum.chat.setLastActive.mockImplementation(clerum.persistLastActive)
  await act(async () => {
    await app.getVm().handleEnsureTeamContext({ teamId: 'team-2' })
  })
  await waitFor(() => expect(app.getVm().currentTeamId).toBe('team-2'))
  act(() => app.getVm().handleSelectChatAgent('agent-x', { chatId: 'chat-3', selectLatest: false }))
  await waitFor(() => expect(screen.getByText('chat-3 real history')).toBeTruthy())
  await waitFor(() => expect(app.getVm().sessionStateByChatId['chat-3']?.syncing).toBe(false))
  expect(screen.getByRole('dialog', { name: 'Delete session?' })).toBeTruthy()
  const beforeDelete = await clerum.readIndex('agent-x')
  expect(beforeDelete.chats.map(chat => chat.id).sort()).toEqual(['chat-1', 'chat-2', 'chat-3'])
  expect(beforeDelete.lastActiveChatId).toBe('chat-3')
  const status = { text: app.getVm().statusText, tone: app.getVm().statusTone }
  confirmStorageDelete()
  await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1))
  expect(
    within(screen.getByRole('alert')).getByText(
      'Delete cancelled because chat access changed. Please try again.'
    )
  ).toBeTruthy()
  expect(clerum.chat.delete).not.toHaveBeenCalled()
  expect(app.getVm().toasts).toHaveLength(1)
  expect(screen.queryByRole('dialog', { name: 'Delete session?' })).toBeNull()
  expect(app.getVm().currentTeamId).toBe('team-2')
  expect(app.getVm().selectedAgent).toBe('agent-x')
  expect(app.getVm().activeChatId).toBe('chat-3')
  expect(app.getVm().activeMessages.map(message => message.content)).toEqual([
    'chat-3 real history',
  ])
  expect(app.getVm().chatMessagesLoading).toBe(false)
  expect({ text: app.getVm().statusText, tone: app.getVm().statusTone }).toEqual(status)
  expect(await clerum.readIndex('agent-x')).toEqual(beforeDelete)
  expect(
    (await clerum.persistedMessages('agent-x', 'chat-2')).map(message => message.content)
  ).toEqual(['chat-2 real history'])
})

it('same-scope Host cancellation reports once while another agent stays visible', async () => {
  const { app, clerum } = await mountStorageDelete('chat-2', true)
  const deletion = await app.getVm().captureChatDeleteFence('agent-x')
  clerum.rpc.loadSessionMessages.mockRejectedValueOnce(
    await ipcHostAccessRevoked('rpc:loadSessionMessages')
  )
  act(() => app.getVm().handleSelectChatAgent('agent-x', { chatId: 'chat-3', selectLatest: false }))
  await waitFor(() => expect(app.getVm().selectedAgent).toBe(null))
  act(() =>
    app.getVm().handleSelectChatAgent('agent-y', { chatId: 'other-chat', selectLatest: false })
  )
  await waitFor(() => expect(screen.getByText('other agent real history')).toBeTruthy())
  await waitFor(() => expect(app.getVm().sessionStateByChatId['other-chat']?.syncing).toBe(false))
  const status = { text: app.getVm().statusText, tone: app.getVm().statusTone }
  await act(async () => {
    await app.getVm().handleDeleteChatForAgent('agent-x', 'chat-2', deletion)
  })
  expect(clerum.chat.delete).not.toHaveBeenCalled()
  expect(app.getVm().toasts).toHaveLength(1)
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  expect(screen.getByRole('alert').textContent).toContain('Delete cancelled')
  expect(app.getVm().selectedAgent).toBe('agent-y')
  expect(app.getVm().activeChatId).toBe('other-chat')
  expect(app.getVm().activeMessages.map(message => message.content)).toEqual([
    'other agent real history',
  ])
  expect(app.getVm().chatMessagesLoading).toBe(false)
  expect({ text: app.getVm().statusText, tone: app.getVm().statusTone }).toEqual(status)
  expect((await clerum.readIndex('agent-x')).chats).toHaveLength(3)
})

it.each([false, true])(
  'successful deferred cleanup reports by operation scope, not navigation (scopeChanged=%s)',
  async scopeChanged => {
    const { app, clerum } = await mountStorageDelete()
    const actualRm = fs.rm
    vi.spyOn(fs, 'rm').mockImplementation((path, options) => {
      if (String(path).endsWith('/agent-x/chat-2.json')) {
        return Promise.reject(Object.assign(new Error('cleanup denied'), { code: 'EACCES' }))
      }
      return actualRm(path, options)
    })
    const deleteFromStore = clerum.chat.delete.getMockImplementation()!
    const produced = deferred<Awaited<ReturnType<typeof clerum.chat.delete>>>()
    const deliver = deferred<void>()
    clerum.chat.delete.mockImplementationOnce(async (...args) => {
      const result = await deleteFromStore(...args)
      produced.resolve(result)
      await deliver.promise
      return result
    })
    confirmStorageDelete()
    await act(async () => {
      expect((await produced.promise).cleanupPending).toBe(true)
    })
    if (scopeChanged) {
      await act(async () => {
        await app.getVm().handleEnsureTeamContext({ teamId: 'team-2' })
      })
      await waitFor(() => expect(app.getVm().currentTeamId).toBe('team-2'))
    }
    act(() =>
      app.getVm().handleSelectChatAgent('agent-x', { chatId: 'chat-3', selectLatest: false })
    )
    await waitFor(() => expect(screen.getByText('chat-3 real history')).toBeTruthy())
    await waitFor(() => expect(app.getVm().sessionStateByChatId['chat-3']?.syncing).toBe(false))
    const status = { text: app.getVm().statusText, tone: app.getVm().statusTone }
    await act(async () => {
      deliver.resolve()
    })
    expect(app.getVm().toasts).toHaveLength(scopeChanged ? 0 : 1)
    expect(screen.queryAllByRole('alert')).toEqual([])
    if (!scopeChanged) {
      expect(app.getVm().toasts[0]?.tone).toBe('info')
      expect(
        screen.getByText(
          'Chat removed. Local transcript cleanup will retry when this team is active.'
        )
      ).toBeTruthy()
      expect(app.getVm().latestChatSessions.some(chat => chat.id === 'chat-2')).toBe(false)
    }
    expect(app.getVm().activeChatId).toBe('chat-3')
    expect(app.getVm().activeMessages.map(message => message.content)).toEqual([
      'chat-3 real history',
    ])
    expect(app.getVm().chatMessagesLoading).toBe(false)
    expect({ text: app.getVm().statusText, tone: app.getVm().statusTone }).toEqual(status)
    const index = await clerum.readIndex('agent-x')
    expect(index.chats.some(chat => chat.id === 'chat-2')).toBe(false)
    expect(index.pendingChatCleanup?.some(entry => entry.chatId === 'chat-2')).toBe(true)
  }
)
