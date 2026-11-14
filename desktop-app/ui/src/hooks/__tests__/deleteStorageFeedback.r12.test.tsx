// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNavigationContext } from '@contexts/NavigationContext'
import { useNotificationsContext } from '@contexts/NotificationsContext'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { promises as fs } from 'node:fs'
import { SidebarNav } from '@components/SidebarNav'
import { ChatThread } from '@components/agents/ChatThread'
import {
  getComposerDraft,
  resetComposerDraftStore,
  setAutomaticComposerDraft,
} from '@lib/composerDraftStore'
import {
  clearLatestGfsConversationContext,
  recordLatestGfsConversationContext,
} from '@lib/gfsConversationPrefill'
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
  clearLatestGfsConversationContext()
  resetComposerDraftStore()
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
      compactMode={false}
      compactMenuOpen={false}
      onCompactMenuOpenChange={() => undefined}
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

it('keeps hidden automatic bytes when the real ChatThread resend action runs in another scope', async () => {
  const { app, clerum } = await mountStorageDelete()
  const deleteDialog = screen.getByRole('dialog', { name: 'Delete session?' })
  fireEvent.click(within(deleteDialog).getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete session?' })).toBeNull())
  expect(clerum.chat.delete).not.toHaveBeenCalled()

  const scopeA = app.getVm().authorityScope
  const originTab = app
    .getVm()
    .workspaceTabs.tabs.find(
      tab => tab.kind === 'chat' && tab.chat?.agentRef === 'agent-x' && tab.chat.chatId === 'chat-1'
    )
  expect(originTab).toBeTruthy()
  const uri = 'gfs://main/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  expect(
    setAutomaticComposerDraft(
      {
        authorityScope: scopeA,
        agentRef: 'agent-x',
        chatId: 'chat-1',
        workspaceChatTabId: originTab!.id,
      },
      uri
    )
  ).toBe(true)

  await act(async () => app.getVm().handleEnsureTeamContext({ teamId: 'team-2' }))
  await waitFor(() => expect(app.getVm().currentTeamId).toBe('team-2'))
  act(() => app.getVm().handleSelectChatAgent('agent-x', { chatId: 'chat-1', selectLatest: false }))
  await waitFor(() => expect(screen.getByText('chat-1 real history')).toBeTruthy())
  await waitFor(() => expect(app.getVm().sessionStateByChatId['chat-1']?.syncing).toBe(false))
  const scopeB = app.getVm().authorityScope
  const destination = app
    .getVm()
    .workspaceTabs.tabs.find(
      tab => tab.kind === 'chat' && tab.chat?.agentRef === 'agent-x' && tab.chat.chatId === 'chat-1'
    )
  expect(destination).toBeTruthy()
  expect(destination!.id).toBe(originTab!.id)
  expect(getComposerDraft('chat-1', 'agent-x', destination!.id, scopeB)).toBe('')
  expect(getComposerDraft('chat-1', 'agent-x', originTab!.id, scopeA)).toBe(uri)

  await clerum.chat.upsertMessages('agent-x', 'chat-1', [
    { id: 'resend-user', role: 'user', content: 'original prompt', timestamp: 2 },
    {
      id: 'resend-error',
      role: 'assistant',
      content: 'previous send failed',
      timestamp: 3,
      isError: true,
    },
  ])
  act(() => app.getVm().handleSelectChatAgent('agent-x', { chatId: 'chat-2', selectLatest: false }))
  await waitFor(() => expect(screen.getByText('chat-2 real history')).toBeTruthy())
  act(() => app.getVm().handleSelectChatAgent('agent-x', { chatId: 'chat-1', selectLatest: false }))
  await screen.findAllByText('previous send failed')

  fireEvent.click(screen.getByRole('button', { name: 'Resend prompt' }))

  await waitFor(() =>
    expect(getComposerDraft('chat-1', 'agent-x', originTab!.id, scopeA)).toBe(uri)
  )
  expect(getComposerDraft('chat-1', 'agent-x', destination!.id, scopeB)).toBe('')
  expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
  await waitFor(() => expect(app.getVm().toasts).toHaveLength(1))
  expect(app.getVm().toasts[0]?.tone).toBe('error')
  expect(app.getVm().toasts[0]?.text).toBe(
    'This composer no longer owns the draft. Select its chat tab and try again.'
  )
  expect(getComposerDraft('chat-1', 'agent-x', destination!.id, scopeB)).toBe('')
  expect(getComposerDraft('chat-1', 'agent-x', originTab!.id, scopeA)).toBe(uri)
  expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
})

it('does not register or dispatch ChatThread deletion until confirmation', async () => {
  const { app, clerum } = await mountStorageDelete()
  const sidebarDialog = screen.getByRole('dialog', { name: 'Delete session?' })
  fireEvent.click(within(sidebarDialog).getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete session?' })).toBeNull())
  expect(clerum.chat.delete).not.toHaveBeenCalled()

  act(() => app.getVm().handleSelectChatAgent('agent-x', { selectLatest: false }))
  await waitFor(() => expect(screen.getAllByTestId('agent-chat-row').length).toBeGreaterThan(0))
  const target = app.getVm().chatList.find(chat => chat.id === 'chat-2')
  expect(target).toBeTruthy()
  const targetMenuName = `Session actions for ${target!.title}`
  const targetRow = document.querySelector<HTMLElement>(
    '[data-testid="agent-chat-row"][data-chat-id="chat-2"]'
  )
  expect(targetRow).toBeTruthy()
  fireEvent.click(within(targetRow!).getByRole('button', { name: targetMenuName }))
  const menu = within(targetRow!).getByRole('group', { name: targetMenuName })
  fireEvent.click(within(menu).getByRole('button', { name: 'Delete' }))
  await screen.findByRole('dialog', { name: 'Delete session?' })

  const pendingRevision = app.getVm().pendingDeleteRevision
  expect(app.getVm().isChatDeletionPending('agent-x', 'chat-2')).toBe(false)
  expect(clerum.chat.delete).not.toHaveBeenCalled()
  expect(clerum.chat.deletionStatus).not.toHaveBeenCalledWith(
    'agent-x',
    'chat-2',
    expect.anything()
  )

  fireEvent.click(
    within(screen.getByRole('dialog', { name: 'Delete session?' })).getByRole('button', {
      name: 'Cancel',
    })
  )
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete session?' })).toBeNull())
  await act(async () => {
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
  })

  expect(app.getVm().pendingDeleteRevision).toBe(pendingRevision)
  expect(app.getVm().isChatDeletionPending('agent-x', 'chat-2')).toBe(false)
  expect(clerum.chat.delete).not.toHaveBeenCalled()
  expect(clerum.chat.deletionStatus).not.toHaveBeenCalledWith(
    'agent-x',
    'chat-2',
    expect.anything()
  )
})

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
    const deletionAgent = 'agent-x'
    const deletionChatId = 'chat-2'
    const agent = otherAgent ? 'agent-y' : 'agent-x'
    const chatId = otherAgent ? 'other-chat' : 'chat-3'
    const history = otherAgent ? 'other agent real history' : 'chat-3 real history'
    const entered = deferred<void>()
    const held = deferred<Awaited<ReturnType<typeof clerum.chat.delete>>>()
    const statusEntered = deferred<void>()
    const statusHeld = deferred<void>()
    const readDeletionStatus = clerum.chat.deletionStatus.getMockImplementation()!
    let observedStatus: Awaited<ReturnType<typeof clerum.chat.deletionStatus>> | undefined
    clerum.chat.delete.mockImplementationOnce(async () => {
      entered.resolve()
      return held.promise
    })
    clerum.chat.deletionStatus.mockImplementation(async (...args) => {
      const status = await readDeletionStatus(...args)
      if (args[0] === deletionAgent && args[1] === deletionChatId) {
        observedStatus = status
        statusEntered.resolve()
        return statusHeld.promise.then(() => status)
      }
      return status
    })
    confirmStorageDelete()
    await act(async () => {
      await entered.promise
    })
    act(() => app.getVm().handleSelectChatAgent(agent, { chatId, selectLatest: false }))
    await waitFor(() => expect(screen.getByText(history)).toBeTruthy())
    await waitFor(() => expect(app.getVm().sessionStateByChatId[chatId]?.syncing).toBe(false))
    const status = { text: app.getVm().statusText, tone: app.getVm().statusTone }
    await act(async () => {
      held.reject(new Error('requested storage deletion failed'))
      await held.promise.catch(() => undefined)
    })
    await act(async () => {
      await statusEntered.promise
    })
    expect(
      clerum.chat.deletionStatus.mock.calls.filter(
        ([requestedAgent, requestedChat]) =>
          requestedAgent === deletionAgent && requestedChat === deletionChatId
      )
    ).toHaveLength(1)
    expect(app.getVm().isChatDeletionPending('agent-x', 'chat-2')).toBe(true)
    expect(app.getVm().toasts).toEqual([])
    expect(screen.queryAllByRole('alert')).toEqual([])
    expect((await clerum.readIndex('agent-x')).chats.some(chat => chat.id === 'chat-2')).toBe(true)
    await act(async () => {
      statusHeld.resolve()
      await statusHeld.promise
    })
    await waitFor(() => expect(app.getVm().toasts).toHaveLength(1))
    expect(observedStatus?.status).toBe('not-deleted')
    expect(app.getVm().isChatDeletionPending('agent-x', 'chat-2')).toBe(false)
    expect(app.getVm().selectedAgent).toBe(agent)
    expect(app.getVm().activeChatId).toBe(chatId)
    expect(app.getVm().activeMessages.map(message => message.content)).toEqual([history])
    expect(screen.getByText(history)).toBeTruthy()
    expect(app.getVm().chatMessagesLoading).toBe(false)
    expect(app.getVm().toasts).toHaveLength(1)
    expect(app.getVm().toasts[0]?.tone).toBe('error')
    expect(screen.getByRole('alert').textContent).toContain(
      'Could not delete the chat. Please try again.'
    )
    expect(screen.queryByText(/deleted successfully/i)).toBeNull()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toContain('Could not delete the chat')
    expect({ text: app.getVm().statusText, tone: app.getVm().statusTone }).toEqual(status)
    expect((await clerum.readIndex('agent-x')).chats.some(chat => chat.id === 'chat-2')).toBe(true)
    expect(app.getVm().latestChatSessions.some(chat => chat.id === 'chat-2')).toBe(true)
  }
)

it('keeps a later ChatThread delete attempt gated when an earlier real status read says not-deleted', async () => {
  resetComposerDraftStore()
  const { app, clerum } = await mountStorageDelete()
  const actualDelete = clerum.chat.delete.getMockImplementation()!
  const actualStatus = clerum.chat.deletionStatus.getMockImplementation()!
  const actualReadFile = fs.readFile.bind(fs)
  const actualWriteFile = fs.writeFile.bind(fs)
  const statusRequested = deferred<void>()
  const statusReadEntered = deferred<void>()
  const releaseStatusRead = deferred<void>()
  const secondIndexWriteEntered = deferred<void>()
  const releaseSecondIndexWrite = deferred<void>()
  let holdStatusRead = false
  let indexWriteCount = 0

  vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
    const result = await actualReadFile(...args)
    if (holdStatusRead && String(args[0]).endsWith('/index.json')) {
      holdStatusRead = false
      statusReadEntered.resolve()
      await releaseStatusRead.promise
    }
    return result
  })
  vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
    if (String(args[0]).endsWith('/index.json.tmp')) {
      indexWriteCount += 1
      if (indexWriteCount === 1) throw new Error('first delete failed before index commit')
      if (indexWriteCount === 2) {
        await actualWriteFile(...args)
        secondIndexWriteEntered.resolve()
        await releaseSecondIndexWrite.promise
        return
      }
    }
    return actualWriteFile(...args)
  })
  clerum.chat.delete.mockImplementationOnce((...args) => actualDelete(...args))
  clerum.chat.deletionStatus.mockImplementationOnce((...args) => {
    statusRequested.resolve()
    holdStatusRead = true
    return actualStatus(...args)
  })

  try {
    confirmStorageDelete()
    await act(async () => statusRequested.promise)
    await act(async () => statusReadEntered.promise)
    expect(app.getVm().isChatDeletionPending('agent-x', 'chat-2')).toBe(true)

    act(() => app.getVm().handleSelectChatAgent('agent-x', { selectLatest: false }))
    await waitFor(() => expect(app.getVm().activeChatId).toBeNull())
    const targetRow = await waitFor(() => {
      const row = screen
        .getAllByTestId('agent-chat-row')
        .find(candidate => candidate.getAttribute('data-chat-id') === 'chat-2')
      expect(row).toBeTruthy()
      return row!
    })
    fireEvent.click(within(targetRow).getByRole('button', { name: /Session actions for/ }))
    fireEvent.click(within(targetRow).getByRole('button', { name: 'Delete' }))
    await screen.findByRole('dialog', { name: 'Delete session?' })
    confirmStorageDelete()
    await waitFor(() => expect(clerum.chat.delete).toHaveBeenCalledTimes(2))

    await act(async () => {
      releaseStatusRead.resolve()
      await releaseStatusRead.promise
    })
    await act(async () => secondIndexWriteEntered.promise)
    await waitFor(() => expect(app.getVm().toasts).toHaveLength(1))
    expect(app.getVm().toasts[0]?.text).toBe('Could not delete the chat. Please try again.')
    expect((await clerum.readIndex('agent-x')).chats.some(chat => chat.id === 'chat-2')).toBe(true)

    act(() =>
      app.getVm().handleSelectChatAgent('agent-x', { chatId: 'chat-2', selectLatest: false })
    )
    await waitFor(() => expect(app.getVm().activeChatId).toBe('chat-2'))
    const destination = app
      .getVm()
      .workspaceTabs.tabs.find(
        tab =>
          tab.kind === 'chat' && tab.chat?.agentRef === 'agent-x' && tab.chat.chatId === 'chat-2'
      )
    expect(destination).toBeTruthy()
    recordLatestGfsConversationContext(
      {
        id: 'files-source',
        kind: 'files',
        title: 'Files',
        files: { path: 'gfs://main/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      },
      false,
      app.getVm().authorityScope
    )
    act(() => app.getVm().handleComposerPrefillEvent('focus', '', destination!.id, true, 812))
    expect(app.getVm().persistedConversationPrefillReceipt).toBeNull()
    expect(getComposerDraft('chat-2', 'agent-x', destination!.id, app.getVm().authorityScope)).toBe(
      ''
    )

    await waitFor(() => expect(app.getVm().isChatDeletionPending('agent-x', 'chat-2')).toBe(true))
  } finally {
    releaseStatusRead.resolve()
    releaseSecondIndexWrite.resolve()
    if (clerum.chat.delete.mock.calls.length > 1) {
      await waitFor(async () =>
        expect((await clerum.readIndex('agent-x')).chats.some(chat => chat.id === 'chat-2')).toBe(
          false
        )
      )
      await waitFor(() => expect(app.getVm().chatMessagesLoading).toBe(false))
      await waitFor(() =>
        expect(app.getVm().sessionStateByChatId['chat-2']?.syncing ?? false).toBe(false)
      )
    }
  }
})

it('reports no failure when the durable ChatStore result is deleted', async () => {
  const { app, clerum } = await mountStorageDelete()
  const deleteFromStore = clerum.chat.delete.getMockImplementation()!
  const readDeletionStatus = clerum.chat.deletionStatus.getMockImplementation()!
  let observedStatus: Awaited<ReturnType<typeof clerum.chat.deletionStatus>> | undefined
  clerum.chat.delete.mockImplementationOnce(async (...args) => {
    await deleteFromStore(...args)
    throw new Error('delete response was lost after durable commit')
  })
  clerum.chat.deletionStatus.mockImplementationOnce(async (...args) => {
    observedStatus = await readDeletionStatus(...args)
    return observedStatus
  })

  confirmStorageDelete()

  await waitFor(() => expect(app.getVm().isChatDeletionPending('agent-x', 'chat-2')).toBe(true))
  await waitFor(() => expect(observedStatus?.status).toBe('deleted'))
  expect(app.getVm().toasts).toEqual([])
  expect((await clerum.readIndex('agent-x')).chats.some(chat => chat.id === 'chat-2')).toBe(false)
})

it('reports uncertainty and keeps the deletion gate when status cannot be read', async () => {
  const { app, clerum } = await mountStorageDelete()
  clerum.chat.delete.mockRejectedValueOnce(new Error('delete response lost'))
  clerum.chat.deletionStatus.mockRejectedValueOnce(new Error('status response lost'))

  confirmStorageDelete()

  await waitFor(() => expect(app.getVm().toasts).toHaveLength(1))
  expect(app.getVm().toasts[0]?.tone).toBe('info')
  expect(app.getVm().toasts[0]?.text).toBe(
    'Could not confirm whether the chat was deleted. Its status is still unknown.'
  )
  expect(screen.queryByText(/deleted successfully/i)).toBeNull()
  expect(app.getVm().isChatDeletionPending('agent-x', 'chat-2')).toBe(true)
  expect((await clerum.readIndex('agent-x')).chats.some(chat => chat.id === 'chat-2')).toBe(true)
})

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
