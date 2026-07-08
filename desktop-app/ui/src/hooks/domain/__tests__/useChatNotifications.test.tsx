// @vitest-environment jsdom
/**
 * §4.7.2 reply-notification rule: a reply is notified ONCE per (taskId) on its
 * first materialization — whether it lands via the coordinator's terminal or the
 * reconciler's durable branch. A re-materialization of the same task (a durable
 * recovery after a terminal already appended, or vice-versa) is swallowed so the
 * in-app channel (which has no per-tag dedupe of its own) can't double-toast.
 * Hydration replaces never route through `pushAssistantReplyNotification`, so they
 * never notify — this only guards the double-materialization path.
 */
import { type MutableRefObject } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { AgentChatMessage } from '../../../uiTypes'
import { type ActiveChatVisibility, useChatNotifications } from '../useChatNotifications'

function makeParams(overrides?: Partial<Parameters<typeof useChatNotifications>[0]>) {
  const visibility: ActiveChatVisibility = {
    activeChatId: null,
    currentTeamId: 'team-1',
    navItem: 'chat',
    selectedAgent: null,
  }
  const activeChatVisibilityRef = {
    current: visibility,
  } as MutableRefObject<ActiveChatVisibility>
  const pushNotification = vi.fn()
  const showDesktopNotification = vi.fn(async () => 'granted' as const)
  return {
    activeChatVisibilityRef,
    currentTeamId: 'team-1',
    currentTeamName: 'Team One',
    pushNotification,
    // Deliver to both channels (chat not visible): the dedupe, not the gating, is
    // what suppresses the second call.
    canDeliverChatResponseNotification: vi.fn(() => true),
    showDesktopNotification,
    openAgentConversationFromNotification: vi.fn(async () => undefined),
    decideApprovalFromNotification: vi.fn(async () => undefined),
    ...overrides,
  }
}

function reply(id: string, taskId?: string): AgentChatMessage {
  return {
    id,
    role: 'assistant',
    content: 'here is your report',
    timestamp: Date.now(),
    ...(taskId ? { task_id: taskId } : {}),
  }
}

describe('useChatNotifications — reply first-materialization dedupe (§4.7.2)', () => {
  it('notifies once per taskId even when the reply materializes twice (different message ids)', () => {
    const params = makeParams()
    const { result } = renderHook(() => useChatNotifications(params))

    // First materialization (e.g. the terminal append).
    result.current.pushAssistantReplyNotification('agent-x', reply('msg-A', 'task-1'), 'chat-1')
    // Second materialization of the SAME task (e.g. a durable recovery) — fresh id.
    result.current.pushAssistantReplyNotification('agent-x', reply('msg-B', 'task-1'), 'chat-1')

    expect(params.pushNotification).toHaveBeenCalledTimes(1)
    expect(params.showDesktopNotification).toHaveBeenCalledTimes(1)
    expect(params.pushNotification).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'assistant_reply', agentName: 'agent-x' })
    )
  })

  it('notifies each distinct task once', () => {
    const params = makeParams()
    const { result } = renderHook(() => useChatNotifications(params))

    result.current.pushAssistantReplyNotification('agent-x', reply('msg-A', 'task-1'), 'chat-1')
    result.current.pushAssistantReplyNotification('agent-x', reply('msg-B', 'task-2'), 'chat-1')

    expect(params.pushNotification).toHaveBeenCalledTimes(2)
  })

  it('does not dedupe a reply with no task_id (sync response / error path)', () => {
    const params = makeParams()
    const { result } = renderHook(() => useChatNotifications(params))

    result.current.pushAssistantReplyNotification('agent-x', reply('msg-A'), 'chat-1')
    result.current.pushAssistantReplyNotification('agent-x', reply('msg-B'), 'chat-1')

    expect(params.pushNotification).toHaveBeenCalledTimes(2)
  })
})
