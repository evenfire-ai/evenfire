import type { ReactNode } from 'react'
import { vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { renderHook } from '@testing-library/react'
import { useAgentChatController } from '../../useAgentChatController'

type ControllerParams = Parameters<typeof useAgentChatController>[0]

export interface RenderControllerResult {
  result: ReturnType<
    typeof renderHook<ReturnType<typeof useAgentChatController>, ControllerParams>
  >['result']
  rerender: (props?: Partial<ControllerParams>) => void
  unmount: () => void
  params: ControllerParams
  spies: {
    pushToast: ReturnType<typeof vi.fn>
    pushNotification: ReturnType<typeof vi.fn>
    showDesktopNotification: ReturnType<typeof vi.fn>
    openAgentConversationFromNotification: ReturnType<typeof vi.fn>
    decideApprovalFromNotification: ReturnType<typeof vi.fn>
    canDeliverChatResponseNotification: ReturnType<typeof vi.fn>
  }
}

/**
 * Mounts `useAgentChatController` with sensible defaults. Override any param.
 *
 * NOTE on `navItem`: defaults to `'agents'` so the auto-select effect
 * (`useAgentChatController.ts:492`) does NOT auto-switchToChat on mount —
 * tests that exercise `switchToChat` / `sendAgentMessage` control the chat
 * explicitly. Pass `navItem: 'chat'` to exercise the auto-select path.
 */
export function renderController(
  overrides: Partial<ControllerParams> = {}
): RenderControllerResult {
  const spies = {
    pushToast: vi.fn(),
    pushNotification: vi.fn(),
    showDesktopNotification: vi.fn(async () => 'granted' as const),
    openAgentConversationFromNotification: vi.fn(async () => undefined),
    decideApprovalFromNotification: vi.fn(async () => undefined),
    canDeliverChatResponseNotification: vi.fn(() => true),
  }

  const params = {
    selectedAgent: 'agent-x',
    agentNames: ['agent-x'],
    currentTeamId: 'team-1',
    currentTeamName: 'Team 1',
    isAuthenticated: true,
    navItem: 'agents',
    pushToast: spies.pushToast,
    pushNotification: spies.pushNotification,
    canDeliverChatResponseNotification: spies.canDeliverChatResponseNotification,
    showDesktopNotification: spies.showDesktopNotification,
    openAgentConversationFromNotification: spies.openAgentConversationFromNotification,
    decideApprovalFromNotification: spies.decideApprovalFromNotification,
    ...overrides,
  } as ControllerParams

  // Post-D.3 the controller reads the task tracker from context and registers
  // its own onTerminal/onSuspended callbacks, so the provider must wrap it. No
  // callbacks are injected here — the controller owns them (it has pushToast,
  // pushNotification, chatStore and the visibility refs).
  const utils = renderHook((p: ControllerParams) => useAgentChatController(p), {
    initialProps: params,
    wrapper: ({ children }: { children: ReactNode }) => (
      <AgentTaskTrackerProvider>{children}</AgentTaskTrackerProvider>
    ),
  })

  return {
    result: utils.result,
    rerender: (props?: Partial<ControllerParams>) =>
      utils.rerender({ ...params, ...(props ?? {}) }),
    unmount: utils.unmount,
    params,
    spies,
  }
}
