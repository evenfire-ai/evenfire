// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { deferred, serverSessions } from './__fixtures__/catalogFixtures'
import { renderController } from './__fixtures__/controllerHarness'
import { installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  uninstallMockClerum()
})

it.each(['effect cleanup', 'ownerless switch'] as const)(
  'suppresses stale effect failure after %s',
  async successor => {
    const clerum = installMockClerum()
    for (const id of ['requested', 'successor']) {
      await clerum.chat.create('agent-x', id)
      await clerum.chat.upsertMessages('agent-x', id, [
        { id: `${id}-history`, role: 'user', content: `${id} history`, timestamp: 1 },
      ])
    }
    const controller = renderController({ loadMenuData: false })
    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
    const entered = deferred<void>()
    const gate = deferred<void>()
    const setLastActive = clerum.chat.setLastActive.getMockImplementation()!
    clerum.chat.setLastActive.mockImplementation(async (agent, id) => {
      if (id === 'requested') {
        entered.resolve()
        await gate.promise
      }
      return setLastActive(agent, id)
    })
    act(() => {
      controller.result.current.setPendingChatSelection('agent-x', 'requested')
      controller.rerender({ navItem: DESKTOP_ROUTES.chat })
    })
    await entered.promise
    if (successor === 'effect cleanup') {
      act(() => controller.rerender({ navItem: DESKTOP_ROUTES.agents }))
      await waitFor(() => expect(controller.result.current.activeChatId).toBeNull())
    } else {
      await act(async () => controller.result.current.switchToChat('agent-x', 'successor'))
    }
    await act(async () => {
      gate.reject(new Error('stale effect rejected'))
    })
    expect(controller.spies.pushToast).not.toHaveBeenCalled()
    expect(controller.result.current.chatMessagesLoading).toBe(false)
    expect(controller.result.current.activeChatId).toBe(
      successor === 'effect cleanup' ? null : 'successor'
    )
    expect(controller.result.current.chatMessages).toEqual(
      successor === 'effect cleanup' ? [] : [expect.objectContaining({ id: 'successor-history' })]
    )
  }
)

it('reports the current catalog auto-selection failure exactly once', async () => {
  const clerum = installMockClerum()
  const catalog = deferred<ReturnType<typeof serverSessions>>()
  clerum.rpc.listSessions.mockReturnValue(catalog.promise)
  const controller = renderController({ navItem: DESKTOP_ROUTES.chat, loadMenuData: false })
  await waitFor(() => expect(clerum.rpc.listSessions).toHaveBeenCalled())
  clerum.chat.setLastActive.mockRejectedValueOnce(new Error('catalog destination failed'))
  await act(async () =>
    catalog.resolve(serverSessions([{ agent: 'agent-x', chatId: 'remote-newest' }]))
  )
  await waitFor(() => expect(controller.spies.pushToast).toHaveBeenCalledTimes(1))
  expect(controller.spies.pushToast).toHaveBeenCalledWith(
    'Could not open conversation: catalog destination failed',
    'error'
  )
  expect(controller.result.current.activeChatId).toBe('remote-newest')
  expect(controller.result.current.chatMessages).toEqual([])
  expect(controller.result.current.chatMessagesLoading).toBe(false)
})

it.each([false, true])(
  'reports restore failure only while its request is current (superseded=%s)',
  async superseded => {
    const clerum = installMockClerum()
    for (const id of ['restore', 'successor']) {
      await clerum.chat.create('agent-x', id)
      await clerum.chat.upsertMessages('agent-x', id, [
        { id: `${id}-history`, role: 'user', content: `${id} history`, timestamp: 1 },
      ])
    }
    const controller = renderController({ loadMenuData: false })
    await waitFor(() => expect(controller.result.current.chatListLoading).toBe(false))
    act(() =>
      controller.result.current.setPendingChatSelection('agent-x', 'restore', { deferSwitch: true })
    )
    const gate = deferred<void>()
    const entered = deferred<void>()
    const setLastActive = clerum.chat.setLastActive.getMockImplementation()!
    clerum.chat.setLastActive.mockImplementation(async (agent, id) => {
      if (id === 'restore') {
        entered.resolve()
        await gate.promise
      }
      return setLastActive(agent, id)
    })
    const createError = new Error('create failed')
    clerum.chat.create.mockRejectedValueOnce(createError)
    await act(async () =>
      expect(controller.result.current.handleCreateChat()).rejects.toBe(createError)
    )
    await entered.promise
    if (superseded)
      await act(async () => controller.result.current.switchToChat('agent-x', 'successor'))
    await act(async () => gate.reject(new Error('restore failed')))
    // Creation failed while current: one create-phase report. Restoration is
    // a separate switch and reports only if its own execution remains current.
    expect(controller.spies.pushToast).toHaveBeenCalledTimes(superseded ? 1 : 2)
    expect(controller.spies.pushToast).toHaveBeenCalledWith(
      'Could not create conversation: create failed',
      'error'
    )
    if (!superseded)
      expect(controller.spies.pushToast).toHaveBeenCalledWith(
        'Could not restore conversation: restore failed',
        'error'
      )
    expect(controller.result.current.activeChatId).toBe(superseded ? 'successor' : 'restore')
    expect(controller.result.current.chatMessages).toEqual(
      superseded ? [expect.objectContaining({ id: 'successor-history' })] : []
    )
    expect(controller.result.current.chatMessagesLoading).toBe(false)
  }
)
