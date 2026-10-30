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

it.each(
  (['imperative', 'sidebar', 'effect', 'ownerless'] as const).flatMap(origin =>
    (['success', 'failure', 'superseded'] as const).map(outcome => ({ origin, outcome }))
  )
)('$origin / $outcome obeys execution and feedback ownership', async ({ origin, outcome }) => {
  const clerum = installMockClerum()
  for (const id of ['requested', 'successor']) {
    await clerum.chat.create('agent-x', id)
    await clerum.chat.upsertMessages('agent-x', id, [
      { id: `${id}-history`, role: 'user', content: `${id} real transcript`, timestamp: 1 },
    ])
  }
  const controller = renderController({ loadMenuData: false })
  await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
  const gate = deferred<void>()
  const entered = deferred<void>()
  clerum.chat.setLastActive.mockImplementationOnce(async () => {
    entered.resolve()
    await gate.promise
  })
  let request: Promise<unknown> | undefined
  act(() => {
    if (origin === 'effect') {
      controller.result.current.setPendingChatSelection('agent-x', 'requested', {
        deferSwitch: true,
      })
      controller.rerender({ navItem: DESKTOP_ROUTES.chat })
    } else if (origin === 'sidebar') {
      request = controller.result.current.handleSelectChat('requested')
    } else {
      request = controller.result.current.switchToChat('agent-x', 'requested', {
        ...(origin === 'imperative'
          ? { onCurrentError: cause => controller.spies.pushToast(String(cause), 'error') }
          : {}),
      })
    }
  })
  const observed = request?.catch(cause => cause)
  await entered.promise
  expect(controller.result.current.activeChatId).toBe('requested')
  expect(controller.result.current.chatMessages).toEqual([])
  expect(controller.result.current.chatMessagesLoading).toBe(true)
  if (outcome === 'superseded') {
    await act(async () => controller.result.current.switchToChat('agent-x', 'successor'))
    expect(controller.result.current.chatMessages).toEqual([
      expect.objectContaining({ id: 'successor-history' }),
    ])
  }
  const error = new Error(`${origin} failure`)
  await act(async () => {
    if (outcome === 'success') gate.resolve()
    else gate.reject(error)
    if (observed) {
      expect(await observed).toBe(outcome !== 'success' && origin !== 'sidebar' ? error : undefined)
    }
  })
  await waitFor(() => expect(controller.result.current.chatMessagesLoading).toBe(false))
  expect(clerum.chat.setLastActive).toHaveBeenCalledTimes(outcome === 'superseded' ? 2 : 1)
  expect(controller.spies.pushToast).toHaveBeenCalledTimes(
    outcome === 'failure' && origin !== 'ownerless' ? 1 : 0
  )
  expect(controller.result.current.activeChatId).toBe(
    outcome === 'superseded' ? 'successor' : 'requested'
  )
  expect(controller.result.current.chatMessages).toEqual(
    outcome === 'failure'
      ? []
      : [
          expect.objectContaining({
            id: `${outcome === 'superseded' ? 'successor' : 'requested'}-history`,
          }),
        ]
  )
})

it.each(['imperative', 'sidebar'] as const)(
  'effect cancellation does not revoke a coalesced %s participant',
  async origin => {
    const clerum = installMockClerum()
    await clerum.chat.create('agent-x', 'requested')
    const controller = renderController({ loadMenuData: false })
    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
    const gate = deferred<void>()
    clerum.chat.setLastActive.mockImplementationOnce(() => gate.promise)
    let request!: Promise<void>
    act(() => {
      controller.result.current.setPendingChatSelection('agent-x', 'requested', {
        deferSwitch: true,
      })
      request =
        origin === 'sidebar'
          ? controller.result.current.handleSelectChat('requested')
          : controller.result.current.switchToChat('agent-x', 'requested', {
              onCurrentError: cause => controller.spies.pushToast(String(cause), 'error'),
            })
      controller.rerender({ navItem: DESKTOP_ROUTES.chat })
    })
    const observed = request.catch(cause => cause)
    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
    act(() => controller.rerender({ navItem: DESKTOP_ROUTES.agents }))
    await waitFor(() => expect(controller.result.current.activeChatId).toBeNull())
    const error = new Error('coalesced failure')
    await act(async () => {
      gate.reject(error)
      expect(await observed).toBe(origin === 'sidebar' ? undefined : error)
    })
    expect(clerum.chat.setLastActive).toHaveBeenCalledTimes(1)
    expect(controller.spies.pushToast).toHaveBeenCalledTimes(1)
    expect(controller.result.current.activeChatId).toBeNull()
    expect(controller.result.current.chatMessages).toEqual([])
    expect(controller.result.current.chatMessagesLoading).toBe(false)
  }
)

it('a coalesced sidebar failure without cancellation reports exactly once', async () => {
  const clerum = installMockClerum()
  await clerum.chat.create('agent-x', 'requested')
  await clerum.chat.upsertMessages('agent-x', 'requested', [
    { id: 'requested-history', role: 'user', content: 'requested real history', timestamp: 1 },
  ])
  clerum.chat.getIndex.mockImplementation(clerum.readIndex)
  const controller = renderController({ loadMenuData: false })
  await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
  const gate = deferred<void>()
  clerum.chat.setLastActive.mockImplementationOnce(() => gate.promise)
  let request!: Promise<void>
  act(() => {
    controller.result.current.setPendingChatSelection('agent-x', 'requested', { deferSwitch: true })
    request = controller.result.current.handleSelectChat('requested')
    controller.rerender({ navItem: DESKTOP_ROUTES.chat })
  })
  await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
  expect(controller.result.current.chatMessagesLoading).toBe(true)
  await act(async () => {
    gate.reject(new Error('current sidebar coalesced failure'))
    await expect(request).resolves.toBeUndefined()
  })
  await waitFor(() => expect(controller.result.current.chatMessagesLoading).toBe(false))
  expect(clerum.chat.setLastActive).toHaveBeenCalledTimes(1)
  expect(controller.spies.pushToast).toHaveBeenCalledTimes(1)
  expect(controller.result.current.activeChatId).toBe('requested')
  expect(controller.result.current.chatMessages).toEqual([])
  expect((await clerum.readIndex('agent-x')).chats.map(chat => chat.id)).toEqual(['requested'])
})

it('cancelled coalesced waiter cannot report or settle a superseding imperative load', async () => {
  const clerum = installMockClerum()
  for (const id of ['requested', 'successor']) {
    await clerum.chat.create('agent-x', id)
    await clerum.chat.upsertMessages('agent-x', id, [
      { id: `${id}-history`, role: 'user', content: `${id} real transcript`, timestamp: 1 },
    ])
  }
  clerum.chat.getIndex.mockImplementation(clerum.readIndex)
  const controller = renderController({ loadMenuData: false })
  await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
  const first = deferred<void>()
  const next = deferred<void>()
  const successorEntered = deferred<void>()
  clerum.chat.setLastActive.mockImplementationOnce(() => first.promise)
  let request!: Promise<void>
  act(() => {
    controller.result.current.setPendingChatSelection('agent-x', 'requested', { deferSwitch: true })
    request = controller.result.current.switchToChat('agent-x', 'requested', {
      onCurrentError: error => controller.spies.pushToast(String(error), 'error'),
    })
    controller.rerender({ navItem: DESKTOP_ROUTES.chat })
  })
  const observed = request.catch(error => error)
  await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
  act(() => controller.rerender({ navItem: DESKTOP_ROUTES.agents }))
  await waitFor(() => expect(controller.result.current.activeChatId).toBeNull())
  clerum.chat.setLastActive.mockImplementationOnce(async () => {
    successorEntered.resolve()
    await next.promise
    await clerum.persistLastActive('agent-x', 'successor')
  })
  let successor!: Promise<void>
  act(() => {
    successor = controller.result.current.switchToChat('agent-x', 'successor')
  })
  await successorEntered.promise
  const error = new Error('cancelled waiter and superseded origin')
  await act(async () => {
    first.reject(error)
    expect(await observed).toBe(error)
  })
  expect(controller.spies.pushToast).not.toHaveBeenCalled()
  expect(controller.result.current.activeChatId).toBe('successor')
  expect(controller.result.current.chatMessagesLoading).toBe(true)
  expect(controller.result.current.chatMessages).toEqual([])
  await act(async () => {
    next.resolve()
    await successor
  })
  expect(controller.result.current.chatMessages).toEqual([
    expect.objectContaining({ id: 'successor-history' }),
  ])
  expect(controller.result.current.chatMessagesLoading).toBe(false)
  expect((await clerum.readIndex('agent-x')).lastActiveChatId).toBe('successor')
  expect(clerum.chat.setLastActive).toHaveBeenCalledTimes(2)
})
