import type { ReactNode } from 'react'
import { vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import { useAppController } from '../../../useAppController'
import type { MockClerum } from './mockClerum'

/**
 * Mounts the REAL coordinator (`useAppController`) instead of a single domain
 * controller, so tests can drive its cross-domain entry points
 * (`handleSelectChatAgent`, `handleOpenNotification` → `openAgentConversationTarget`)
 * and observe the navigation + chat controllers reacting to each other.
 *
 * `controllerHarness.renderController` stays the right tool when a test only
 * needs `useAgentChatController` — it drives `navItem` as a prop. The guards in
 * `useAppController` read `nav.navItem` from the navigation controller it owns,
 * which no prop can stand in for, hence this second harness.
 *
 * The `window.clerum` surface here EXTENDS `installMockClerum()` (chat + rpc)
 * with the namespaces the coordinator touches on mount. It mirrors
 * `hooks/__tests__/useWorkspaceController.test.tsx`'s `installClerumHarness` —
 * the established way to boot the coordinator in a test — but keeps the chat/rpc
 * mocks from `mockClerum` so chat assertions read the same as in the rest of
 * this folder.
 */

export const HARNESS_ME = {
  id: 'user-1',
  email: 'test@clerum.io',
  name: 'Test User',
  teamId: 'team-1',
  teamName: 'Team 1',
}

function createCatalog(agentNames: string[]) {
  return {
    userId: HARNESS_ME.id,
    teamId: HARNESS_ME.teamId,
    agentNames,
    userAgentNames: agentNames,
    teamAgentNames: [],
    mcpServersByAgent: {},
    agentContextByName: {},
    agentProviderByName: {},
    contextIds: [],
    userContextIds: [],
    teamContextIds: [],
  }
}

/**
 * Adds the auth/team/access/notifications/... namespaces the coordinator needs
 * on top of an installed `MockClerum`. Call it AFTER `installMockClerum()` and
 * BEFORE `renderAppController()`.
 */
export function extendMockClerumForAppController(
  clerum: MockClerum,
  options: { agentNames?: string[] } = {}
): void {
  const agentNames = options.agentNames ?? ['agent-x']
  const bridge = clerum as unknown as Record<string, unknown>

  Object.assign(bridge.rpc as object, {
    listServers: vi.fn(async () => ({ servers: [] })),
    prewarmHost: vi.fn(async () => ({ status: 'ok' })),
    approveToolCall: vi.fn(async () => undefined),
    denyToolCall: vi.fn(async () => undefined),
  })

  const teamDirectory = vi.fn(async () => ({ items: [], currentTeamId: HARNESS_ME.teamId }))

  Object.assign(bridge, {
    auth: {
      getDependenciesHealth: vi.fn(async () => ({
        externalRestApi: { ok: true },
        rpcProxy: { ok: true },
      })),
      getSessionState: vi.fn(async () => ({ authenticated: true, me: HARNESS_ME })),
      getRuntimeConfigState: vi.fn(async () => ({
        activeProfileId: null,
        configured: true,
        isPackaged: false,
        options: [],
      })),
      getDesktopReleaseStatus: vi.fn(async () => ({
        checked: true,
        currentVersion: '0.1.250',
        latestVersion: '0.1.250',
        minimumVersion: '0.1.250',
        updateRequired: false,
        releaseUrl: '',
      })),
      openDesktopRelease: vi.fn(async () => undefined),
      passwordLogin: vi.fn(async () => ({ authenticated: true, me: HARNESS_ME })),
      logout: vi.fn(async () => undefined),
      onDesktopSetupToken: vi.fn(() => () => undefined),
      onDesktopEnvironmentSetup: vi.fn(() => () => undefined),
      onExternalLogout: vi.fn(() => () => undefined),
    },
    team: {
      directory: teamDirectory,
      initialDirectory: teamDirectory,
      switch: vi.fn(async () => ({ authenticated: true, me: HARNESS_ME })),
    },
    access: {
      refreshCatalog: vi.fn(async () => createCatalog(agentNames)),
    },
    approvals: {
      listPending: vi.fn(async () => []),
      decide: vi.fn(async () => ({ ok: true })),
    },
    notifications: {
      ack: vi.fn(async () => undefined),
      subscribe: vi.fn(async (onEvent: (event: unknown) => void) => {
        onEvent({
          type: 'notification.snapshot',
          items: [],
          cursor: null,
          observedAt: new Date().toISOString(),
        })
        return async () => undefined
      }),
      status: vi.fn(async () => ({
        active: 1,
        open: 1,
        connecting: 0,
        error: 0,
        approvalRequested: 0,
        snapshot: 1,
        updated: 0,
      })),
      isSupported: vi.fn(async () => false),
      show: vi.fn(async (payload: { id: string }) => ({ supported: false, id: payload.id })),
      onClick: vi.fn(() => () => undefined),
      onAction: vi.fn(() => () => undefined),
      onFailed: vi.fn(() => () => undefined),
    },
    notificationPreferences: {
      get: vi.fn(async () => ({
        preferredMedium: null,
        channelFallbackEnabled: true,
        verifiedMedia: [],
      })),
      update: vi.fn(async () => ({ verifiedMedia: [] })),
    },
    desktop: {
      getStatus: vi.fn(async () => ({ status: 'inactive' })),
      openWindow: vi.fn(async () => undefined),
      onWindowClosed: vi.fn(() => () => undefined),
    },
    workflows: {
      list: vi.fn(async () => ({ items: [], count: 0 })),
      read: vi.fn(async () => ({})),
      runs: vi.fn(async () => ({ items: [], count: 0 })),
      listRunArtifacts: vi.fn(async () => ({ artifacts: [] })),
      trigger: vi.fn(async () => undefined),
    },
  })
}

export interface RenderAppControllerResult {
  result: ReturnType<typeof renderHook<ReturnType<typeof useAppController>, unknown>>['result']
  unmount: () => void
  queryClient: QueryClient
}

export function renderAppController(): RenderAppControllerResult {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = renderHook(() => useAppController(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AgentTaskTrackerProvider>{children}</AgentTaskTrackerProvider>
      </QueryClientProvider>
    ),
  })
  return { result: utils.result, unmount: utils.unmount, queryClient }
}
