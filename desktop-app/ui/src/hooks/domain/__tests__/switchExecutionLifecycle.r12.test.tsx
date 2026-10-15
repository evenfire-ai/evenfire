// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { deferred } from './__fixtures__/catalogFixtures'
import { renderController } from './__fixtures__/controllerHarness'
import { installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  uninstallMockClerum()
})

it('preserves a successful same-intent switch while a duplicate effect waits for its catalog', async () => {
  const clerum = installMockClerum()
  clerum.chat.getIndex.mockImplementation(agent => clerum.readIndex(agent))
  clerum.chat.setLastActive.mockImplementation((agent, chat) =>
    clerum.persistLastActive(agent, chat)
  )
  for (const id of ['chat-1', 'chat-2']) {
    await clerum.chat.create('agent-x', id)
    await clerum.chat.upsertMessages('agent-x', id, [
      { id: `${id}-history`, role: 'user', content: `${id} actual history`, timestamp: 1 },
    ])
  }
  const controller = renderController({ loadMenuData: false })
  await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
  await act(async () => controller.result.current.switchToChat('agent-x', 'chat-1'))
  clerum.chat.setLastActive.mockClear()
  await act(async () => {
    controller.result.current.setPendingChatSelection('agent-x', 'chat-2', { deferSwitch: true })
    await controller.result.current.switchToChat('agent-x', 'chat-2', {
      onCurrentError: cause => controller.spies.pushToast(String(cause), 'error'),
    })
  })
  const expectedHistory = [
    expect.objectContaining({ id: 'chat-2-history', content: 'chat-2 actual history' }),
  ]
  expect(controller.result.current.chatMessages).toEqual(expectedHistory)
  expect(controller.result.current.chatMessagesLoading).toBe(false)
  const catalog = deferred<Awaited<ReturnType<typeof clerum.readIndex>>>()
  clerum.chat.getIndex.mockReturnValueOnce(catalog.promise)
  const catalogCalls = clerum.chat.getIndex.mock.calls.length
  act(() => controller.rerender({ navItem: DESKTOP_ROUTES.apps }))
  await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalledTimes(catalogCalls + 1))
  expect(controller.result.current.activeChatId).toBe('chat-2')
  expect(controller.result.current.chatMessages).toEqual(expectedHistory)
  expect(controller.result.current.chatMessagesLoading).toBe(false)
  expect(clerum.chat.setLastActive).toHaveBeenCalledTimes(1)
  await act(async () => catalog.resolve(await clerum.readIndex('agent-x')))
  await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
  expect(controller.result.current.activeChatId).toBe('chat-2')
  expect(controller.result.current.chatMessages).toEqual(expectedHistory)
  expect(controller.result.current.chatMessagesLoading).toBe(false)
  expect(clerum.chat.setLastActive).toHaveBeenCalledTimes(1)
  expect((await clerum.readIndex('agent-x')).lastActiveChatId).toBe('chat-2')
  expect(controller.spies.pushToast).not.toHaveBeenCalled()
})

it('retries an independently launched effect after the imperative execution settled', async () => {
  const clerum = installMockClerum()
  for (const id of ['chat-1', 'chat-2']) {
    await clerum.chat.create('agent-x', id)
    await clerum.chat.upsertMessages('agent-x', id, [
      { id: `${id}-history`, role: 'user', content: `${id} actual history`, timestamp: 1 },
    ])
  }
  const controller = renderController({ loadMenuData: false })
  await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
  await act(async () => controller.result.current.switchToChat('agent-x', 'chat-1'))
  act(() => controller.rerender({ navItem: DESKTOP_ROUTES.chat }))
  await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
  // Re-open after the route's implicit selection settles, exactly as the user
  // starts launch-from-chat with a committed conversation.
  await act(async () => controller.result.current.switchToChat('agent-x', 'chat-1'))
  clerum.chat.setLastActive.mockClear()
  const error = new Error('first opening failed')
  clerum.chat.setLastActive.mockRejectedValueOnce(error)
  let request!: Promise<void>
  const report = controller.spies.pushToast
  await act(async () => {
    controller.result.current.setPendingChatSelection('agent-x', 'chat-2', { deferSwitch: true })
    request = controller.result.current.switchToChat('agent-x', 'chat-2', {
      onCurrentError: cause => report(`Opening failed: ${String(cause)}`, 'error'),
    })
    const observed = request.catch(cause => cause)
    controller.rerender({ navItem: DESKTOP_ROUTES.apps })
    expect(await observed).toBe(error)
  })
  await waitFor(() => {
    expect(controller.result.current.activeChatId).toBe('chat-2')
    expect(controller.result.current.chatMessages).toEqual([
      expect.objectContaining({ id: 'chat-2-history', content: 'chat-2 actual history' }),
    ])
    expect(controller.result.current.chatMessagesLoading).toBe(false)
  })
  expect(clerum.chat.setLastActive.mock.calls.map(([, id]) => id)).toEqual(['chat-2', 'chat-2'])
  expect(report).toHaveBeenCalledTimes(1)
})

it('keeps a captured in-flight duplicate even when it settles before catalog completion', async () => {
  const clerum = installMockClerum()
  await clerum.chat.create('agent-x', 'chat-2')
  await clerum.chat.upsertMessages('agent-x', 'chat-2', [
    { id: 'history-2', role: 'user', content: 'second transcript', timestamp: 1 },
  ])
  const controller = renderController({ loadMenuData: false })
  await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
  const catalog = deferred<Awaited<ReturnType<typeof clerum.readIndex>>>()
  const opening = deferred<void>()
  clerum.chat.getIndex.mockReturnValueOnce(catalog.promise)
  clerum.chat.setLastActive.mockImplementationOnce(() => opening.promise)
  let request!: Promise<void>
  act(() => {
    controller.result.current.setPendingChatSelection('agent-x', 'chat-2', { deferSwitch: true })
    request = controller.result.current.switchToChat('agent-x', 'chat-2', {
      onCurrentError: cause => controller.spies.pushToast(String(cause), 'error'),
    })
    controller.rerender({ navItem: DESKTOP_ROUTES.chat })
  })
  const observed = request.catch(cause => cause)
  await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalledTimes(2))
  const error = new Error('one logical failure')
  await act(async () => {
    opening.reject(error)
    expect(await observed).toBe(error)
    catalog.resolve(await clerum.readIndex('agent-x'))
  })
  await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
  expect(clerum.chat.setLastActive).toHaveBeenCalledTimes(1)
  expect(controller.spies.pushToast).toHaveBeenCalledTimes(1)
  expect(controller.result.current.activeChatId).toBe('chat-2')
  expect(controller.result.current.chatMessages).toEqual([])
  expect(controller.result.current.chatMessagesLoading).toBe(false)
})

it('settles a superseded rejection without settling or duplicating its in-flight successor', async () => {
  const clerum = installMockClerum()
  clerum.chat.getIndex.mockImplementation(agent => clerum.readIndex(agent))
  for (const id of ['chat-1', 'chat-2']) {
    await clerum.chat.create('agent-x', id)
    await clerum.chat.upsertMessages('agent-x', id, [
      { id: `${id}-history`, role: 'user', content: `${id} actual history`, timestamp: 1 },
    ])
  }
  const controller = renderController({ loadMenuData: false })
  await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
  const old = deferred<void>()
  const successor = deferred<void>()
  clerum.chat.setLastActive
    .mockImplementationOnce(() => old.promise)
    .mockImplementationOnce(() => successor.promise)
  let first!: Promise<void>
  let second!: Promise<void>
  act(() => {
    first = controller.result.current.switchToChat('agent-x', 'chat-1', {
      onCurrentError: cause => controller.spies.pushToast(String(cause), 'error'),
    })
    controller.result.current.setPendingChatSelection('agent-x', 'chat-2', { deferSwitch: true })
    second = controller.result.current.switchToChat('agent-x', 'chat-2', {
      onCurrentError: cause => controller.spies.pushToast(String(cause), 'error'),
    })
  })
  const observed = first.catch(cause => cause)
  const error = new Error('superseded first switch failed')
  await act(async () => {
    old.reject(error)
    expect(await observed).toBe(error)
  })
  expect(controller.result.current.activeChatId).toBe('chat-2')
  expect(controller.result.current.chatMessagesLoading).toBe(true)
  const catalog = deferred<Awaited<ReturnType<typeof clerum.readIndex>>>()
  clerum.chat.getIndex.mockReturnValueOnce(catalog.promise)
  act(() => controller.rerender({ navItem: DESKTOP_ROUTES.apps }))
  await act(async () => catalog.resolve(await clerum.readIndex('agent-x')))
  await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
  expect(clerum.chat.setLastActive.mock.calls.map(([, id]) => id)).toEqual(['chat-1', 'chat-2'])
  expect(controller.result.current.chatMessagesLoading).toBe(true)
  expect(controller.result.current.chatMessages).toEqual([])
  await act(async () => {
    successor.resolve()
    expect(await second).toBeUndefined()
  })
  expect(controller.result.current.activeChatId).toBe('chat-2')
  expect(controller.result.current.chatMessages).toEqual([
    expect.objectContaining({ id: 'chat-2-history', content: 'chat-2 actual history' }),
  ])
  expect(controller.result.current.chatMessagesLoading).toBe(false)
  expect(clerum.chat.setLastActive).toHaveBeenCalledTimes(2)
  expect(controller.spies.pushToast).not.toHaveBeenCalled()
})
