// @vitest-environment jsdom
/**
 * chat-indicadores — the navbar "Latest sessions" list spans agents, so its
 * Running / Awaiting-approval / Completed-unread badges must be driven by a
 * CROSS-agent session-state map. This locks in that the latest-sessions loader
 * seeds `sessionStateByChatKey` for agents OTHER than the selected one (the
 * selected-agent-only `sessionStateByChatId` map can't cover them).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext/types'
import { act, waitFor } from '@testing-library/react'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let clerum: MockClerum

beforeEach(() => {
  clerum = installMockClerum()
})

afterEach(() => {
  vi.restoreAllMocks()
  uninstallMockClerum()
})

describe('sidebar badges across agents (chat-indicadores)', () => {
  it('seeds sessionStateByChatKey from a NON-selected agent listSessions snapshot', async () => {
    // agent-y is not the selected agent, yet its awaiting-approval session must
    // surface a state entry so the navbar can render its badge.
    clerum.rpc.listSessions.mockResolvedValue({
      items: [
        {
          agent: 'agent-y',
          chatId: 'chat-y',
          state: 'awaiting_approval',
          lastActivityAt: new Date().toISOString(),
          turnCount: 2,
        },
      ],
    })

    const { result } = renderController({
      selectedAgent: 'agent-x',
      agentNames: ['agent-x', 'agent-y'],
    })

    const key = makeTaskKey('agent-y', 'chat-y')
    await waitFor(() =>
      expect(result.current.sessionStateByChatKey[key]?.state).toBe('awaiting_approval')
    )
    // And the cross-agent session shows up in the navbar list itself.
    await waitFor(() =>
      expect(
        result.current.latestChatSessions.some(s => s.agentRef === 'agent-y' && s.id === 'chat-y')
      ).toBe(true)
    )
  })

  it('seeds the selected agent badge state via the mount loadChatList effect', async () => {
    clerum.rpc.listSessions.mockResolvedValue({
      items: [
        {
          agent: 'agent-x',
          chatId: 'chat-x',
          state: 'awaiting_approval',
          lastActivityAt: new Date().toISOString(),
        },
      ],
    })
    // isAuthenticated:false keeps the periodic latest-sessions loader inert, so
    // the seed under test can only come from the mount agent-selection effect's
    // loadChatList → loadChatListOnce (loadChatList is no longer public — B18).
    const { result } = renderController({
      selectedAgent: 'agent-x',
      agentNames: ['agent-x'],
      isAuthenticated: false,
    })

    const key = makeTaskKey('agent-x', 'chat-x')
    await waitFor(() =>
      expect(result.current.sessionStateByChatKey[key]?.state).toBe('awaiting_approval')
    )
  })

  it('does not let a stale server snapshot downgrade a live processing task to idle', async () => {
    // The loader re-runs on agentNames refetch; its snapshot reports idle for a
    // chat whose local send just flipped to processing. The live badge must win.
    clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'task-live' })
    clerum.rpc.getTaskResult.mockResolvedValue({ response: 'done' })
    clerum.rpc.listSessions.mockResolvedValue({ items: [] })

    const { result, rerender } = renderController({
      selectedAgent: 'agent-x',
      agentNames: ['agent-x'],
      navItem: 'chat',
    })
    await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())

    await act(async () => {
      await result.current.handleSendAgentMessage('hi')
    })
    await waitFor(() => expect(clerum.hasProgressHandler('task-live')).toBe(true))
    const chatId = result.current.activeChatId!
    const key = makeTaskKey('agent-x', chatId)
    expect(result.current.sessionStateByChatKey[key]?.state).toBe('processing')

    // listSessions now reports the same chat as idle (stale snapshot). Trigger a
    // loader re-run by changing agentNames, then assert the live state survives.
    clerum.rpc.listSessions.mockResolvedValue({
      items: [
        {
          agent: 'agent-x',
          chatId,
          state: 'idle',
          lastActivityAt: new Date().toISOString(),
        },
      ],
    })
    await act(async () => {
      rerender({ agentNames: ['agent-x', 'agent-z'] })
    })
    await waitFor(() => expect(clerum.rpc.listSessions).toHaveBeenCalled())
    expect(result.current.sessionStateByChatKey[key]?.state).toBe('processing')
  })
})
