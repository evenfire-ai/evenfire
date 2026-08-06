import type { ReactNode } from 'react'
import { vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import { useAppController } from '../../../useAppController'
import { type MockClerum, installMockClerum } from './mockClerum'

/**
 * The single `window.clerum` bridge for tests that boot the REAL coordinator
 * (`useAppController`), plus a `renderHook` mount for the ones that drive it
 * through its return value rather than through rendered UI.
 *
 * Two suites share it — `hooks/domain/__tests__/chatSelectionAcrossRouteChange`
 * and `hooks/__tests__/useWorkspaceController` (whose hook is a deprecated
 * re-export of `useAppController`, so both boot the same thing). It lives in this
 * folder because the repo keeps ONE `__fixtures__` directory for the hooks tests
 * and because it is built on top of `mockClerum` — splitting it away from its own
 * base would cost more than the cross-folder import it saves.
 *
 * `controllerHarness.renderController` stays the right tool when a test only
 * needs `useAgentChatController` — it drives `navItem` as a prop. The guards in
 * `useAppController` read `nav.navItem` from the navigation controller it owns,
 * which no prop can stand in for, hence this second harness.
 *
 * The bridge EXTENDS `installMockClerum()` (chat + rpc) with the namespaces the
 * coordinator touches on mount. Everything that differs between the two suites
 * is an option — never a duplicated bridge.
 */

export const HARNESS_ME = {
  id: 'user-1',
  email: 'test@clerum.io',
  name: 'Test User',
  teamId: 'team-1',
  teamName: 'Team 1',
}

type Fn = ReturnType<typeof vi.fn>

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

function createSessionState(authenticated: boolean, me = HARNESS_ME) {
  return authenticated ? { authenticated: true, me } : { authenticated: false, me: null }
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

function createHealth() {
  return {
    externalRestApi: { ok: true },
    rpcProxy: { ok: true },
  }
}

const DEFAULT_DESKTOP_RELEASE_STATUS = {
  checked: true,
  currentVersion: '0.1.250',
  latestVersion: '0.1.250',
  minimumVersion: '0.1.250',
  updateRequired: false,
  releaseUrl: '',
}

export interface AppControllerClerumOptions {
  /** Access-catalog agents. Empty means "authenticated user with no agents". */
  agentNames?: string[]
  /** Boot already signed in (default). `false` boots at the login screen. */
  startAuthenticated?: boolean
  /**
   * Hold `team.directory`, `access.refreshCatalog` and `approvals.listPending`
   * open once authenticated, until `resolveAuthenticatedLoad()` runs — lets a
   * test observe the window between login and workspace hydration.
   */
  delayAuthenticatedLoad?: boolean
  /** Hold the dependency-health probe open until `resolveHealth()` runs. */
  delayHealth?: boolean
  /** Make the dependency-health probe reject with this value. */
  healthError?: unknown
  /** Make `auth.passwordLogin` reject with this instead of signing in. */
  passwordLoginError?: unknown
  /** Payload for `auth.getDesktopReleaseStatus`. */
  desktopReleaseStatus?: typeof DEFAULT_DESKTOP_RELEASE_STATUS
  /** Payload for `team.directory` / `team.initialDirectory` / `team.list`. */
  teamDirectory?: { items: unknown[]; currentTeamId: string }
  /** Organization identity providers exposed before login. */
  identityProviders?: Array<{ id: string; provider: 'microsoft'; displayName: string }>
}

export interface AppControllerClerumHandle {
  getDependenciesHealth: Fn
  getSessionState: Fn
  passwordLogin: Fn
  getIdentityProviders: Fn
  startMicrosoftIdentityProviderLogin: Fn
  getDesktopReleaseStatus: Fn
  teamDirectory: Fn
  switchTeam: Fn
  refreshCatalog: Fn
  listPending: Fn
  /** Settles a dependency-health probe held by `delayHealth`. */
  resolveHealth: () => void
  /** Settles whatever `delayAuthenticatedLoad` is holding open. */
  resolveAuthenticatedLoad: () => void
}

/**
 * Adds the auth/team/access/notifications/... namespaces the coordinator needs
 * on top of an installed `MockClerum`. Call it AFTER `installMockClerum()` and
 * BEFORE mounting. Use `installAppControllerClerum` when the suite has no
 * `installMockClerum()` of its own.
 */
export function extendMockClerumForAppController(
  clerum: MockClerum,
  options: AppControllerClerumOptions = {}
): AppControllerClerumHandle {
  const agentNames = options.agentNames ?? ['agent-x']
  const bridge = clerum as unknown as Record<string, unknown>

  let authenticated = options.startAuthenticated ?? true
  let sessionMe = { ...HARNESS_ME }
  const teamDirectoryPayload = options.teamDirectory ?? {
    items: [],
    currentTeamId: HARNESS_ME.teamId,
  }
  const teamDirectoryDeferred = createDeferred<typeof teamDirectoryPayload>()
  const catalogDeferred = createDeferred<ReturnType<typeof createCatalog>>()
  const approvalsDeferred = createDeferred<unknown[]>()
  const healthDeferred = createDeferred<ReturnType<typeof createHealth>>()
  const held = () => Boolean(options.delayAuthenticatedLoad) && authenticated

  const getDependenciesHealth = vi.fn(async () => {
    if (options.healthError) throw options.healthError
    return options.delayHealth ? healthDeferred.promise : createHealth()
  })
  const getSessionState = vi.fn(async () => createSessionState(authenticated, sessionMe))
  const passwordLogin = vi.fn(async () => {
    if (options.passwordLoginError) throw options.passwordLoginError
    authenticated = true
    return createSessionState(true, sessionMe)
  })
  const getIdentityProviders = vi.fn(async () => ({ items: options.identityProviders ?? [] }))
  const startMicrosoftIdentityProviderLogin = vi.fn(async () => ({ authorizeUrl: '' }))
  const getDesktopReleaseStatus = vi.fn(
    async () => options.desktopReleaseStatus ?? DEFAULT_DESKTOP_RELEASE_STATUS
  )
  const teamDirectory = vi.fn(async () =>
    held() ? teamDirectoryDeferred.promise : teamDirectoryPayload
  )
  const switchTeam = vi.fn(async (teamId: string) => {
    sessionMe = {
      ...sessionMe,
      teamId,
      teamName: teamId === HARNESS_ME.teamId ? HARNESS_ME.teamName : teamId,
    }
    return createSessionState(true, sessionMe)
  })
  const refreshCatalog = vi.fn(async () =>
    held() ? catalogDeferred.promise : createCatalog(agentNames)
  )
  const listPending = vi.fn(async () => (held() ? approvalsDeferred.promise : []))

  Object.assign(bridge.rpc as object, {
    listServers: vi.fn(async () => ({ servers: [] })),
    prewarmHost: vi.fn(async () => ({ status: 'ok' })),
    approveToolCall: vi.fn(async () => undefined),
    denyToolCall: vi.fn(async () => undefined),
  })

  Object.assign(bridge, {
    auth: {
      getDependenciesHealth,
      getSessionState,
      getRuntimeConfigState: vi.fn(async () => ({
        activeProfileId: null,
        configured: true,
        isPackaged: false,
        options: [],
      })),
      getDesktopReleaseStatus,
      openDesktopRelease: vi.fn(async () => undefined),
      passwordLogin,
      getIdentityProviders,
      startMicrosoftIdentityProviderLogin,
      completeIdentityProviderLogin: vi.fn(async () => createSessionState(false)),
      consumeIdentityProviderLoginCode: vi.fn(async () => null),
      onIdentityProviderLoginCode: vi.fn(() => () => undefined),
      logout: vi.fn(async () => undefined),
      onDesktopSetupToken: vi.fn(() => () => undefined),
      onDesktopEnvironmentSetup: vi.fn(() => () => undefined),
      onExternalLogout: vi.fn(() => () => undefined),
    },
    team: {
      list: vi.fn(async () => teamDirectoryPayload),
      members: vi.fn(async () => []),
      directory: teamDirectory,
      initialDirectory: teamDirectory,
      switch: switchTeam,
    },
    access: {
      refreshCatalog,
    },
    approvals: {
      listPending,
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
      update: vi.fn(async (next: unknown) => ({
        ...(next && typeof next === 'object' ? next : {}),
        verifiedMedia: [],
      })),
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

  return {
    getDependenciesHealth,
    getSessionState,
    passwordLogin,
    getIdentityProviders,
    startMicrosoftIdentityProviderLogin,
    getDesktopReleaseStatus,
    teamDirectory,
    switchTeam,
    refreshCatalog,
    listPending,
    resolveHealth() {
      healthDeferred.resolve(createHealth())
    },
    resolveAuthenticatedLoad() {
      teamDirectoryDeferred.resolve(teamDirectoryPayload)
      catalogDeferred.resolve(createCatalog(agentNames))
      approvalsDeferred.resolve([])
    },
  }
}

/** `installMockClerum()` + `extendMockClerumForAppController()` in one call. */
export function installAppControllerClerum(options: AppControllerClerumOptions = {}): {
  clerum: MockClerum
  handle: AppControllerClerumHandle
} {
  const clerum = installMockClerum()
  return { clerum, handle: extendMockClerumForAppController(clerum, options) }
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
