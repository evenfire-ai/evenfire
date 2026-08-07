// @vitest-environment jsdom
/**
 * Characterization tests for chat CRUD / lifecycle actions not covered by the
 * existing suites: delete (ack-first + session-state cleanup + reselect),
 * cancelTask (200 and 404), resetChat and clearActiveChat.
 *
 * See .specs/refactor-useAgentChatController/plan.md Fase 0.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext/types'
import { act, waitFor } from '@testing-library/react'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

let clerum: MockClerum
let uuidCounter = 0

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  uuidCounter = 0
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
    () => `uuid-${++uuidCounter}` as `${string}-${string}-${string}-${string}-${string}`
  )
  clerum = installMockClerum()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  uninstallMockClerum()
})

async function settleMount() {
  await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
}

/** Start a send that leaves a live task in the tracker for the active chat. */
async function sendLiveTask(
  result: ReturnType<typeof renderController>['result'],
  taskId: string
): Promise<string> {
  clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId })
  const sendPromise = act(async () => {
    await result.current.handleSendAgentMessage('long running')
  })
  await waitFor(() => expect(clerum.hasProgressHandler(taskId)).toBe(true))
  await sendPromise
  return result.current.activeChatId!
}

describe('handleDeleteChat', () => {
  it('acks the live task, cleans session-state, and reselects', async () => {
    const { result } = renderController()
    await settleMount()

    const chatId = await sendLiveTask(result, 'task-del')
    const key = makeTaskKey('agent-x', chatId)
    expect(result.current.sessionStateByChatKey[key]?.state).toBe('processing')

    await act(async () => {
      await result.current.handleDeleteChat(chatId)
    })

    // ack tore down the SSE subscription (no handler left) so a late terminal
    // can't resurrect the deleted chat.
    expect(clerum.hasProgressHandler('task-del')).toBe(false)
    expect(clerum.chat.delete).toHaveBeenCalledWith('agent-x', chatId)
    // D.5 review #5: the deleted chat's session-state entry is dropped.
    expect(result.current.sessionStateByChatKey[key]).toBeUndefined()
    // It was the only/active chat → a fresh chat is created and selected.
    expect(result.current.activeChatId).not.toBe(chatId)
  })
})

describe('cancelTask', () => {
  it('200 → marks the task progress cancelled', async () => {
    const { result } = renderController()
    await settleMount()
    await sendLiveTask(result, 'task-cancel')

    await act(async () => {
      await result.current.cancelTask('task-cancel')
    })

    expect(clerum.rpc.cancelTask).toHaveBeenCalledWith('agent-x', 'task-cancel')
    const progress = result.current.progressByAgentMessage['agent-x'] ?? {}
    const entry = Object.values(progress).find(p => p.taskId === 'task-cancel')
    expect(entry?.status).toBe('cancelled')
  })

  it('404 → treats it as already-finished with an info toast', async () => {
    clerum.rpc.cancelTask.mockRejectedValue(new Error('404 Not Found'))
    const { result, spies } = renderController()
    await settleMount()
    await sendLiveTask(result, 'task-gone')

    await act(async () => {
      await result.current.cancelTask('task-gone')
    })

    expect(spies.pushToast).toHaveBeenCalledWith('That task is no longer active.', 'info')
    const progress = result.current.progressByAgentMessage['agent-x'] ?? {}
    const entry = Object.values(progress).find(p => p.taskId === 'task-gone')
    expect(entry?.status).toBe('cancelled')
  })
})

describe('resetChat / clearActiveChat', () => {
  it('resetChat wipes chat list, active chat, session-state and messages', async () => {
    const { result } = renderController()
    await settleMount()
    await sendLiveTask(result, 'task-reset')
    expect(result.current.chatList.length).toBeGreaterThan(0)
    expect(Object.keys(result.current.sessionStateByChatKey).length).toBeGreaterThan(0)

    await act(async () => {
      result.current.resetChat()
    })

    expect(result.current.chatList).toEqual([])
    expect(result.current.activeChatId).toBeNull()
    expect(result.current.sessionStateByChatKey).toEqual({})
    expect(result.current.chatMessages).toEqual([])
  })

  it('resetChat drops pending selections from the prior session', async () => {
    const { result, rerender } = renderController({ agentNames: ['agent-x', 'agent-y'] })
    await settleMount()

    act(() => {
      result.current.setPendingChatSelection('agent-y', 'prior-user-chat')
      result.current.resetChat()
    })
    rerender({ selectedAgent: 'agent-y', agentNames: ['agent-x', 'agent-y'] })

    await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalledWith('agent-y'))
    expect(result.current.activeChatId).toBeNull()
    expect(clerum.rpc.loadSessionMessages).not.toHaveBeenCalledWith(
      'agent-y',
      'agent-y',
      'prior-user-chat',
      undefined,
      expect.anything()
    )
  })

  it('clearActiveChat deselects and drops the per-chat error/resend banner', async () => {
    clerum.rpc.invokeHostMessage.mockRejectedValue(new Error('network down'))
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.handleSendAgentMessage('doomed')
    })
    expect(result.current.failedAgentSend).not.toBeNull()
    expect(result.current.agentError).toBeTruthy()

    await act(async () => {
      result.current.clearActiveChat()
    })

    expect(result.current.activeChatId).toBeNull()
    expect(result.current.failedAgentSend).toBeNull()
    expect(result.current.agentError).toBeNull()
  })
})
