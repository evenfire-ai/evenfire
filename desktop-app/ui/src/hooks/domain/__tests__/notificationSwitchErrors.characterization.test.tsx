// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import {
  installAppControllerClerum,
  renderAppController,
} from './__fixtures__/appControllerHarness'
import { deferred } from './__fixtures__/catalogFixtures'
import { uninstallMockClerum } from './__fixtures__/mockClerum'

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  uninstallMockClerum()
})

describe('notification switch error ownership', () => {
  it('suppresses a stale awaited notification failure after chat-3 loads', async () => {
    const { clerum } = installAppControllerClerum({ agentNames: ['agent-x'] })
    for (const id of ['chat-1', 'chat-2', 'chat-3']) {
      await clerum.chat.create('agent-x', id)
      await clerum.chat.upsertMessages('agent-x', id, [
        { id: `${id}-history`, role: 'user', content: `${id} actual history`, timestamp: 1 },
      ])
    }
    const app = renderAppController()
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
    act(() => app.result.current.handleSelectChatAgent('agent-x', { chatId: 'chat-1' }))
    await waitFor(() =>
      expect(app.result.current.activeMessages).toEqual([
        expect.objectContaining({ id: 'chat-1-history' }),
      ])
    )
    const gate = deferred<void>()
    const entered = deferred<void>()
    const setLastActive = clerum.chat.setLastActive.getMockImplementation()!
    clerum.chat.setLastActive.mockImplementation(async (agent, chat) => {
      if (chat === 'chat-2') {
        entered.resolve()
        await gate.promise
      }
      return setLastActive(agent, chat)
    })
    let notification!: Promise<void>
    act(() => {
      notification = app.result.current.handleOpenNotification({
        id: 'held-notification',
        kind: 'approval_required',
        agentName: 'agent-x',
        chatId: 'chat-2',
        teamId: 'team-1',
        text: 'Open chat two',
        timestamp: 1,
        read: false,
        approval: { taskId: 't2', requestId: 'r2' },
      } as Parameters<typeof app.result.current.handleOpenNotification>[0])
    })
    try {
      await entered.promise
      act(() => app.result.current.handleSelectChatAgent('agent-x', { chatId: 'chat-3' }))
      await waitFor(() =>
        expect(app.result.current.activeMessages).toEqual([
          expect.objectContaining({ id: 'chat-3-history' }),
        ])
      )
      const status = app.result.current.statusText
      const toasts = app.result.current.toasts
      const activeTabId = app.result.current.workspaceTabs.activeTabId
      expect(
        app.result.current.workspaceTabs.tabs.find(tab => tab.id === activeTabId)?.chat
      ).toEqual({ agentRef: 'agent-x', chatId: 'chat-3' })
      await act(async () => {
        gate.reject(new Error('obsolete notification failed'))
        await notification
      })
      expect(app.result.current.activeChatId).toBe('chat-3')
      expect(app.result.current.activeMessages).toEqual([
        expect.objectContaining({ id: 'chat-3-history' }),
      ])
      expect(app.result.current.chatMessagesLoading).toBe(false)
      expect(app.result.current.workspaceTabs.activeTabId).toBe(activeTabId)
      expect(app.result.current.statusText).toBe(status)
      expect(app.result.current.toasts).toEqual(toasts)
    } finally {
      gate.resolve()
      await notification.catch(() => undefined)
    }
  })
})
