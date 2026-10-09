import { type ReactNode, useLayoutEffect } from 'react'
import { vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { act, renderHook } from '@testing-library/react'
import type { HostAuthorityHoldKind } from '../../../../lib/hostAuthorityStore'
import { useAgentChatController } from '../../useAgentChatController'
import { type HarnessHostAuthority, useHarnessHostAuthority } from './hostAuthorityHarness'

type ControllerParams = Parameters<typeof useAgentChatController>[0]

export interface RenderControllerResult {
  result: ReturnType<
    typeof renderHook<ReturnType<typeof useAgentChatController>, Partial<ControllerParams>>
  >['result']
  rerender: (props?: Partial<ControllerParams>) => void
  unmount: () => void
  params: Partial<ControllerParams>
  /**
   * The mount's Host authority, from the production store factory. Only
   * meaningful when the test did not override the authority params.
   */
  hostAuthority: {
    hold: (agentRef: string, kind: HostAuthorityHoldKind) => void
    release: (agentRef: string) => void
    getEpoch: (agentRef: string) => number
    isBlocked: (agentRef: string) => boolean
  }
  spies: {
    pushToast: ReturnType<typeof vi.fn>
    pushNotification: ReturnType<typeof vi.fn>
    showDesktopNotification: ReturnType<typeof vi.fn>
    openAgentConversationFromNotification: ReturnType<typeof vi.fn>
    decideApprovalFromNotification: ReturnType<typeof vi.fn>
    canDeliverChatResponseNotification: ReturnType<typeof vi.fn>
  }
}

export interface RenderControllerOptions {
  /** Observe committed controller state before its passive effects synchronize refs. */
  onLayoutCommit?: (controller: ReturnType<typeof useAgentChatController>) => void
}

/**
 * Mounts `useAgentChatController` with sensible defaults. Override any param.
 *
 * NOTE on `navItem`: defaults to `'agents'` so the auto-select effect
 * (`useAgentChatController.ts:492`) does NOT auto-switchToChat on mount —
 * tests that exercise `switchToChat` / `sendAgentMessage` control the chat
 * explicitly. Pass `navItem: 'chat'` to exercise the auto-select path.
 *
 * Host authority defaults to `useHarnessHostAuthority`, the production store
 * factory, so epoch comparisons in the controller are exercised for real.
 */
export function renderController(
  overrides: Partial<ControllerParams> = {},
  options: RenderControllerOptions = {}
): RenderControllerResult {
  const spies = {
    pushToast: vi.fn(),
    pushNotification: vi.fn(),
    showDesktopNotification: vi.fn(async () => 'granted' as const),
    openAgentConversationFromNotification: vi.fn(async () => undefined),
    decideApprovalFromNotification: vi.fn(async () => undefined),
    canDeliverChatResponseNotification: vi.fn(() => true),
  }

  const params: Partial<ControllerParams> = {
    selectedAgent: 'agent-x',
    agentNames: ['agent-x'],
    currentTeamId: 'team-1',
    chatAuthorityTeamId: 'team-1',
    currentEnvironmentKey: 'env-test',
    currentTeamName: 'Team 1',
    isAuthenticated: true,
    loadMenuData: true,
    navItem: 'agents',
    pushToast: spies.pushToast,
    pushNotification: spies.pushNotification,
    // Identity resolver by default (no catalog display layer in the harness).
    agentDisplayName: (agentName: string) => agentName,
    canDeliverChatResponseNotification: spies.canDeliverChatResponseNotification,
    showDesktopNotification: spies.showDesktopNotification,
    openAgentConversationFromNotification: spies.openAgentConversationFromNotification,
    decideApprovalFromNotification: spies.decideApprovalFromNotification,
    ...overrides,
  }

  let authority: HarnessHostAuthority | null = null
  const currentAuthority = (): HarnessHostAuthority => {
    if (!authority) throw new Error('controller is not mounted')
    return authority
  }

  // Post-D.3 the controller reads the task tracker from context and registers
  // its own onTerminal/onSuspended callbacks, so the provider must wrap it. No
  // callbacks are injected here — the controller owns them (it has pushToast,
  // pushNotification, chatStore and the visibility refs).
  const utils = renderHook(
    (p: Partial<ControllerParams>) => {
      const hostAuthority = useHarnessHostAuthority()
      authority = hostAuthority
      const controller = useAgentChatController({
        onHostAccessRevoked: hostAuthority.onHostAccessRevoked,
        onHostAuthorityUncertain: hostAuthority.onHostAuthorityUncertain,
        isHostAccessBlocked: hostAuthority.isHostAccessBlocked,
        getHostAuthorityEpoch: hostAuthority.getHostAuthorityEpoch,
        hostAuthorityRevision: hostAuthority.revision,
        ...p,
      } as ControllerParams)
      useLayoutEffect(() => {
        options.onLayoutCommit?.(controller)
      }, [
        controller.activeChatId,
        controller.chatMessages,
        controller.chatMessagesLoading,
        options.onLayoutCommit,
      ])
      return controller
    },
    {
      initialProps: params,
      wrapper: ({ children }: { children: ReactNode }) => (
        <AgentTaskTrackerProvider>{children}</AgentTaskTrackerProvider>
      ),
    }
  )

  return {
    result: utils.result,
    rerender: (props?: Partial<ControllerParams>) =>
      utils.rerender({ ...params, ...(props ?? {}) }),
    unmount: utils.unmount,
    params,
    hostAuthority: {
      hold: (agentRef, kind) =>
        act(() => {
          const hostAuthority = currentAuthority()
          if (kind === 'revoked') hostAuthority.onHostAccessRevoked(agentRef)
          else hostAuthority.onHostAuthorityUncertain(agentRef)
        }),
      release: agentRef =>
        act(() => {
          currentAuthority().release(agentRef)
        }),
      getEpoch: agentRef => currentAuthority().store.getEpoch(agentRef),
      isBlocked: agentRef => currentAuthority().store.isBlocked(agentRef),
    },
    spies,
  }
}
