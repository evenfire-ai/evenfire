// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { ChatThread } from '@components/agents/ChatThread'
import { FleetBoard } from '@components/agents/FleetBoard'
import { installAppControllerClerum } from '../domain/__tests__/__fixtures__/appControllerHarness'
import { deferred } from '../domain/__tests__/__fixtures__/catalogFixtures'
import { renderChatActionConsumer } from '../domain/__tests__/__fixtures__/chatActionConsumerHarness'
import { uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  uninstallMockClerum()
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
})

async function mountActions() {
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
      <FleetBoard />
      <ChatThread />
    </>
  )
  act(() => app.getVm().handleSelectChatAgent('agent-x', { chatId: 'chat-1', selectLatest: false }))
  await waitFor(() => expect(screen.getByText('chat-1 real history')).toBeTruthy())
  await waitFor(() => expect(app.getVm().chatListLoading).toBe(false))
  return { app, clerum }
}

function clickFleetCreate() {
  fireEvent.click(screen.getByRole('button', { name: /More actions for/ }))
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
}

it('observes a ChatThread conversation click through the real app action and toast', async () => {
  const { app, clerum } = await mountActions()
  act(() => app.getVm().handleSelectChatAgent('agent-x', { selectLatest: false }))
  await waitFor(() => expect(app.getVm().activeChatId).toBeNull())
  clerum.chat.setLastActive.mockRejectedValueOnce(new Error('sidebar switch failed'))
  const chats = [...app.getVm().chatList].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const buttonIndex = chats.findIndex(chat => chat.id === 'chat-2')
  fireEvent.click(screen.getAllByRole('button', { name: chats[buttonIndex]!.title })[buttonIndex]!)
  await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1))
  expect(screen.getByRole('alert').textContent).toContain(
    'Could not open conversation: sidebar switch failed'
  )
  expect(app.getVm().toasts).toHaveLength(1)
  expect(app.getVm().activeChatId).toBe('chat-2')
  expect(app.getVm().activeMessages).toEqual([])
  expect(app.getVm().chatMessagesLoading).toBe(false)
})

it('reports a FleetBoard create-phase rejection once without misclassifying recovery', async () => {
  const { app, clerum } = await mountActions()
  clerum.chat.create.mockRejectedValueOnce(new Error('fleet create failed'))
  clickFleetCreate()
  await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1))
  expect(screen.getByRole('alert').textContent).toContain(
    'Could not create conversation: fleet create failed'
  )
  expect(app.getVm().toasts).toHaveLength(1)
  expect((await clerum.readIndex('agent-x')).chats).toHaveLength(2)
  expect(app.getVm().activeChatId).toBeNull()
  expect(app.getVm().activeMessages).toEqual([])
  expect(app.getVm().chatMessagesLoading).toBe(false)
})

it('does not present an old create-phase failure after navigation, while the raw awaiter rejects', async () => {
  const { app, clerum } = await mountActions()
  clerum.chat.setLastActive.mockImplementation(clerum.persistLastActive)
  const held = deferred<Awaited<ReturnType<typeof clerum.chat.create>>>()
  clerum.chat.create.mockReturnValueOnce(held.promise)
  let request!: Promise<void>
  act(() => {
    request = app.getVm().handleCreateChat()
  })
  const observed = request.catch(cause => cause)
  act(() => app.getVm().handleSelectChatAgent('agent-x', { chatId: 'chat-2' }))
  await waitFor(() => expect(screen.getByText('chat-2 real history')).toBeTruthy())
  const status = { text: app.getVm().statusText, tone: app.getVm().statusTone }
  const error = new Error('obsolete creation failed before persistence')
  await act(async () => {
    held.reject(error)
    expect(await observed).toBe(error)
  })
  expect(app.getVm().activeChatId).toBe('chat-2')
  expect(app.getVm().activeMessages.map(message => message.content)).toEqual([
    'chat-2 real history',
  ])
  expect(app.getVm().chatMessagesLoading).toBe(false)
  expect(app.getVm().toasts).toEqual([])
  expect(screen.queryAllByRole('alert')).toEqual([])
  expect({ text: app.getVm().statusText, tone: app.getVm().statusTone }).toEqual(status)
  const index = await clerum.readIndex('agent-x')
  expect(index.chats.map(chat => chat.id).sort()).toEqual(['chat-1', 'chat-2'])
  expect(index.lastActiveChatId).toBe('chat-2')
})

it('reports opening a successfully created FleetBoard chat as one open failure', async () => {
  const { app, clerum } = await mountActions()
  clerum.chat.setLastActive.mockRejectedValueOnce(new Error('created chat open failed'))
  clickFleetCreate()
  await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1))
  const index = await clerum.readIndex('agent-x')
  const created = index.chats.find(chat => !['chat-1', 'chat-2'].includes(chat.id))!
  expect(created).toBeTruthy()
  expect(app.getVm().chatList.some(chat => chat.id === created.id)).toBe(true)
  expect(screen.getByRole('alert').textContent).toContain(
    'Could not open conversation: created chat open failed'
  )
  expect(app.getVm().toasts).toHaveLength(1)
  expect(app.getVm().activeChatId).toBe(created.id)
  expect(app.getVm().activeMessages).toEqual([])
  expect(app.getVm().chatMessagesLoading).toBe(false)
})

it('does not report a stale FleetBoard opening failure or disturb newer real history', async () => {
  const { app, clerum } = await mountActions()
  const held = deferred<void>()
  const entered = deferred<void>()
  clerum.chat.setLastActive.mockImplementationOnce(async () => {
    entered.resolve()
    return held.promise
  })
  clickFleetCreate()
  await act(async () => {
    await entered.promise
  })
  act(() => app.getVm().handleSelectChatAgent('agent-x', { chatId: 'chat-2', selectLatest: false }))
  await waitFor(() => expect(screen.getByText('chat-2 real history')).toBeTruthy())
  const status = { text: app.getVm().statusText, tone: app.getVm().statusTone }
  await act(async () => {
    held.reject(new Error('obsolete created chat open failed'))
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
  expect((await clerum.readIndex('agent-x')).chats).toHaveLength(3)
})

it('keeps the raw create API rejection observable after creation succeeds', async () => {
  const { app, clerum } = await mountActions()
  const error = new Error('raw create opening failed')
  clerum.chat.setLastActive.mockRejectedValueOnce(error)
  await act(async () => {
    await expect(app.getVm().handleCreateChat()).rejects.toBe(error)
  })
  expect((await clerum.readIndex('agent-x')).chats).toHaveLength(3)
  expect(app.getVm().chatMessagesLoading).toBe(false)
  expect(app.getVm().toasts.map(toast => toast.text)).toEqual([
    'Could not open conversation: raw create opening failed',
  ])
})

it('raw create awaiters still receive a stale opening rejection without stale feedback', async () => {
  const { app, clerum } = await mountActions()
  const held = deferred<void>()
  const entered = deferred<void>()
  const rejected = deferred<unknown>()
  const error = new Error('raw stale create open failed')
  clerum.chat.setLastActive.mockImplementationOnce(async () => {
    entered.resolve()
    return held.promise
  })
  act(() => {
    void app
      .getVm()
      .handleCreateChat()
      .catch(cause => rejected.resolve(cause))
  })
  await act(async () => {
    await entered.promise
  })
  act(() => app.getVm().handleSelectChatAgent('agent-x', { chatId: 'chat-2', selectLatest: false }))
  await waitFor(() => expect(screen.getByText('chat-2 real history')).toBeTruthy())
  await act(async () => {
    held.reject(error)
    expect(await rejected.promise).toBe(error)
  })
  expect(app.getVm().toasts).toEqual([])
  expect(screen.queryAllByRole('alert')).toEqual([])
  expect(app.getVm().activeChatId).toBe('chat-2')
  expect(app.getVm().activeMessages.map(message => message.content)).toEqual([
    'chat-2 real history',
  ])
  expect(app.getVm().chatMessagesLoading).toBe(false)
})
