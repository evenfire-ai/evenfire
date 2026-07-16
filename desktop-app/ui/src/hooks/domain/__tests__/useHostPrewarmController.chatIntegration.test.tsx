// @vitest-environment jsdom
/**
 * PREWARM × CHAT-CONTROLLER ANTI-COUPLING INTEGRATION TEST.
 *
 * @claude's #737 re-review confirmed by code inspection that
 * `useHostPrewarmController` (deps [isAuthenticated, agentNames]) and the merged
 * #737 `useAgentChatController` are fully decoupled: prewarm is fired ONLY by
 * the authenticated access catalog, and the wake cooldown / in-flight state lives
 * in the main-process AppService singleton, not in any renderer hook.
 *
 * But that decoupling was proven only by reading the code. This test mounts the
 * REAL `useHostPrewarmController` together with the REAL `useAgentChatController`
 * and pins the invariant behaviorally: a chat-controller remount or a chat
 * action (switchToChat, a nav change the chat controller owns) must NOT fire a
 * prewarm — only gaining an authenticated catalog host may. If someone later
 * wires prewarm to a chat-controller-owned dependency, THIS TEST MUST FAIL.
 *
 * Mutation check: change `useHostPrewarmController`'s effect deps to include a
 * chat-controller-owned value (e.g. `navItem`) and the "chat action / nav change
 * does NOT re-fire prewarm" assertions below break.
 */
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { NavItem } from '../../../uiTypes'
import { useAgentChatController } from '../useAgentChatController'
// React 18/19 needs this flag for act() to flush effects in the test env.
import { useHostPrewarmController } from '../useHostPrewarmController'
import { installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let prewarmHost: ReturnType<typeof vi.fn>

/**
 * Install the full chat-controller `window.clerum` surface (shared fixture) and
 * augment it with the `prewarmHost` spy the prewarm hook calls. Using the real
 * fixture means the chat controller mounts through its real code path, so any
 * future coupling from that path would actually reach prewarm.
 */
function installBridge() {
  installMockClerum()
  prewarmHost = vi.fn(async () => ({ requested: true, status: 'wake-requested' }))
  ;(window as unknown as { clerum: { rpc: Record<string, unknown> } }).clerum.rpc.prewarmHost =
    prewarmHost
}

// Stable callback identities — the chat controller keys effects (chat-list load,
// activity subscribe) on its params, so fresh identities every render would spin
// its effects forever. The shared controllerHarness defines these once for the
// same reason; we mirror that here.
const stableCallbacks = {
  pushToast: vi.fn(),
  pushNotification: vi.fn(),
  canDeliverChatResponseNotification: vi.fn(() => true),
  showDesktopNotification: vi.fn(async () => 'granted' as const),
  openAgentConversationFromNotification: vi.fn(async () => undefined),
  decideApprovalFromNotification: vi.fn(async () => undefined),
}

// One stable array per catalog set so `agentNames` keeps a constant identity
// across re-renders (a fresh array each render would re-trigger loaders).
const agentNamesCache = new Map<string, string[]>()
function stableAgentNames(...agents: string[]): string[] {
  if (!agents.length) return EMPTY_AGENT_NAMES
  const key = agents.join('\u0000')
  let cached = agentNamesCache.get(key)
  if (!cached) {
    cached = [...agents]
    agentNamesCache.set(key, cached)
  }
  return cached
}
const EMPTY_AGENT_NAMES: string[] = []

interface HarnessProps {
  selectedAgent: string | null
  agentNames: string[]
  isAuthenticated: boolean
  navItem: NavItem
}

/** Both real hooks, mounted together under the task-tracker the chat controller needs. */
function useBothControllers({ selectedAgent, agentNames, isAuthenticated, navItem }: HarnessProps) {
  useHostPrewarmController({ agentNames, isAuthenticated })
  return useAgentChatController({
    selectedAgent,
    agentNames,
    currentTeamId: 'team-1',
    currentTeamName: 'Team 1',
    isAuthenticated,
    navItem,
    ...stableCallbacks,
  })
}

function renderBoth(initial: HarnessProps) {
  return renderHook((p: HarnessProps) => useBothControllers(p), {
    initialProps: initial,
    wrapper: ({ children }: { children: ReactNode }) => (
      <AgentTaskTrackerProvider>{children}</AgentTaskTrackerProvider>
    ),
  })
}

beforeEach(() => {
  installBridge()
  // Prewarm and the chat controller both debug-log; keep the suite output clean.
  vi.spyOn(console, 'debug').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  uninstallMockClerum()
})

describe('useHostPrewarmController × useAgentChatController — anti-coupling', () => {
  it('mounting with an authenticated catalog fires one prewarm per catalog host', async () => {
    renderBoth({
      selectedAgent: 'chatllm',
      agentNames: stableAgentNames('chatllm', 'chatllm-stateless'),
      isAuthenticated: true,
      navItem: 'agents',
    })

    await waitFor(() => expect(prewarmHost).toHaveBeenCalledTimes(2))
    expect(prewarmHost).toHaveBeenNthCalledWith(1, 'chatllm', ['chatllm', 'chatllm-stateless'])
    expect(prewarmHost).toHaveBeenNthCalledWith(2, 'chatllm-stateless', [
      'chatllm',
      'chatllm-stateless',
    ])
  })

  it('a chat action (switchToChat) does NOT fire prewarm from the chat-controller lifecycle', async () => {
    const agentNames = stableAgentNames('chatllm')
    const view = renderBoth({
      selectedAgent: 'chatllm',
      agentNames,
      isAuthenticated: true,
      navItem: 'agents',
    })
    await waitFor(() => expect(prewarmHost).toHaveBeenCalledTimes(1))

    // Drive a chat-controller action. This re-runs chat-controller effects
    // (subscribe/reconcile) but must not touch prewarm.
    await act(async () => {
      await view.result.current.switchToChat('chatllm', 'chat-1')
    })

    // A plain re-render with the SAME prewarm inputs must also not re-fire.
    view.rerender({
      selectedAgent: 'chatllm',
      agentNames,
      isAuthenticated: true,
      navItem: 'agents',
    })
    await act(async () => {})

    expect(prewarmHost).toHaveBeenCalledTimes(1)
  })

  it('a chat-controller remount driven by a chat-owned dep (navItem) does NOT re-fire prewarm', async () => {
    const agentNames = stableAgentNames('chatllm')
    const view = renderBoth({
      selectedAgent: 'chatllm',
      agentNames,
      isAuthenticated: true,
      navItem: 'agents',
    })
    await waitFor(() => expect(prewarmHost).toHaveBeenCalledTimes(1))

    // `navItem` is a chat-controller parameter, NOT a prewarm parameter. Toggling
    // it re-runs the chat controller's nav-driven effects (the #737 auto-select
    // path) while leaving the prewarm inputs (agentNames, isAuthenticated)
    // untouched. Prewarm must stay put.
    view.rerender({ selectedAgent: 'chatllm', agentNames, isAuthenticated: true, navItem: 'chat' })
    await act(async () => {})
    view.rerender({
      selectedAgent: 'chatllm',
      agentNames,
      isAuthenticated: true,
      navItem: 'agents',
    })
    await act(async () => {})

    expect(prewarmHost).toHaveBeenCalledTimes(1)
  })

  it('the cooldown/in-flight invariant holds: repeated chat remounts never re-invoke prewarm', async () => {
    const agentNames = stableAgentNames('chatllm')
    const view = renderBoth({
      selectedAgent: 'chatllm',
      agentNames,
      isAuthenticated: true,
      navItem: 'agents',
    })
    await waitFor(() => expect(prewarmHost).toHaveBeenCalledTimes(1))

    // The wake cooldown / in-flight guard lives in the main-process AppService
    // singleton, not in the renderer. The renderer-visible invariant is that no
    // amount of chat-controller churn re-invokes prewarm — so the main process
    // is never asked to re-arm the cooldown from a chat lifecycle event.
    for (let i = 0; i < 3; i++) {
      view.rerender({
        selectedAgent: 'chatllm',
        agentNames,
        isAuthenticated: true,
        navItem: 'chat',
      })
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {})
      view.rerender({
        selectedAgent: 'chatllm',
        agentNames,
        isAuthenticated: true,
        navItem: 'agents',
      })
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {})
    }

    expect(prewarmHost).toHaveBeenCalledTimes(1)
  })

  it('CONTROL: gaining a catalog agent fires a second prewarm (trigger is catalog, not chat lifecycle)', async () => {
    const view = renderBoth({
      selectedAgent: 'agent-a',
      agentNames: stableAgentNames('agent-a'),
      isAuthenticated: true,
      navItem: 'agents',
    })
    await waitFor(() => expect(prewarmHost).toHaveBeenCalledTimes(1))
    expect(prewarmHost).toHaveBeenLastCalledWith('agent-a', ['agent-a'])

    view.rerender({
      selectedAgent: 'agent-b',
      agentNames: stableAgentNames('agent-a', 'agent-b'),
      isAuthenticated: true,
      navItem: 'agents',
    })
    await waitFor(() => expect(prewarmHost).toHaveBeenCalledTimes(2))
    expect(prewarmHost).toHaveBeenLastCalledWith('agent-b', ['agent-a', 'agent-b'])
  })
})
