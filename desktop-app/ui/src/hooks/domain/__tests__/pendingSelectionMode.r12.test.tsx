// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import {
  installAppControllerClerum,
  renderAppController,
} from './__fixtures__/appControllerHarness'
import { deferred } from './__fixtures__/catalogFixtures'
import { uninstallMockClerum } from './__fixtures__/mockClerum'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  uninstallMockClerum()
})

it.each(['notification', 'explicit clear', 'latest'] as const)(
  '%s uses actual app producers, including their explicit clear behavior',
  async producer => {
    const { clerum } = installAppControllerClerum()
    await clerum.chat.create('agent-x', 'before')
    await clerum.chat.upsertMessages('agent-x', 'before', [
      { id: 'before-history', role: 'user', content: 'previous real history', timestamp: 1 },
    ])
    await clerum.chat.create('agent-x', 'visible')
    await clerum.chat.upsertMessages('agent-x', 'visible', [
      { id: 'actual-history', role: 'user', content: 'visible real history', timestamp: 1 },
    ])
    clerum.chat.getIndex.mockImplementation(clerum.readIndex)
    clerum.chat.setLastActive.mockImplementation(clerum.persistLastActive)
    const app = renderAppController()
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
    act(() => app.result.current.handleSelectChatAgent('agent-x', { chatId: 'before' }))
    await waitFor(() => expect(app.result.current.activeMessages[0]?.id).toBe('before-history'))
    const gate = deferred<void>()
    const entered = deferred<void>()
    const persisted = deferred<void>()
    clerum.chat.setLastActive.mockImplementationOnce(async (agent, id) => {
      entered.resolve()
      await gate.promise
      await clerum.persistLastActive(agent, id)
      persisted.resolve()
    })
    act(() => app.result.current.handleSelectChatAgent('agent-x', { chatId: 'visible' }))
    await act(async () => entered.promise)
    expect(app.result.current.chatMessagesLoading).toBe(true)
    await act(async () => {
      if (producer === 'notification') {
        await app.result.current.handleOpenNotification({
          id: 'no-chat-notification',
          kind: 'approval_required',
          agentName: 'agent-x',
          teamId: 'team-1',
          text: 'Open agent',
          timestamp: Date.now(),
          read: false,
          approval: { taskId: 'task', requestId: 'request' },
        })
      } else {
        app.result.current.handleSelectChatAgent('agent-x', {
          selectLatest: producer === 'latest',
        })
      }
    })
    expect(app.result.current.chatMessagesLoading).toBe(producer === 'notification')
    await act(async () => {
      gate.resolve()
      await persisted.promise
    })
    await waitFor(() => expect(app.result.current.chatMessagesLoading).toBe(false))
    expect(app.result.current.activeChatId).toBe(producer === 'notification' ? 'visible' : null)
    expect(app.result.current.activeMessages.map(message => message.content)).toEqual(
      producer === 'notification' ? ['visible real history'] : []
    )
    expect(app.result.current.chatList.map(chat => chat.id).sort()).toEqual(['before', 'visible'])
    expect((await clerum.readIndex('agent-x')).lastActiveChatId).toBe('visible')
    expect(app.result.current.toasts).toEqual([])
    app.queryClient.clear()
  }
)
