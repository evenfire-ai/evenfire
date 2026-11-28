import {
  type ComponentType,
  Fragment,
  type ReactElement,
  type ReactNode,
  StrictMode,
  createElement,
  useReducer,
} from 'react'
import { expect, vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildGfsResourceDeepLink, parseGfsResourceDeepLink } from '@clerum/desktop-app-links'
import { DESKTOP_ROUTES } from '@constants/navigation'
import type { useAppController } from '@hooks/useAppController'
import {
  type GfsResourceNavigationRequest,
  assignGfsResourceNavigationOwner,
  canCompleteGfsResourceNavigation,
  isGfsResourceNavigationOwnerPresent,
} from '@lib/gfsResourceNavigationIntent'
import { desktopQueryDefaults } from '@lib/queryClient'
import {
  activeWorkspaceTab,
  createFilesTab,
  createWorkspaceTabsState,
  newChatTab,
  openChatTab,
  openFilesTab,
  openPreviewTab,
  openSettingsTab,
  selectWorkspaceTab,
} from '@lib/workspaceTabs'
import { mapKindToRoute, settingsSectionForRoute } from '@lib/workspaceTabsRoute'
import type { FilesPageProps } from '@pages/FilesPage.types'
import type { SandboxUiPageProps } from '@pages/SandboxUiPage.types'
import type { GfsResourceDeepLinkEnvelope, SandboxUiDeepLinkEnvelope } from '@/App.types'
import {
  GfsResourceDeepLinkQueue,
  GfsUserNavigationGeneration,
} from '../../../../src/gfsResourceDeepLinkQueue'
import { SandboxUiDeepLinkQueue } from '../../../../src/sandboxUiDeepLinkQueue'
import { buildSandboxUiDeepLink, parseSandboxUiDeepLink } from '../../../../src/sandboxUiDeepLinks'
import type { DeepLinkAcknowledgmentAuthority } from '../../../../src/types'
import { installAppControllerClerum } from '../../hooks/domain/__tests__/__fixtures__/appControllerHarness'
import { type SandboxUiMainFake, createSandboxUiMainFake } from './sandboxUiMainFake'

/**
 * Deterministic trace harness for the deep-link orchestration of `<App/>`.
 *
 * A scenario drives the world (main's queues, its session authority and the
 * navigation generation) and the controller, and every observable effect App
 * has on that world lands in ONE ordered log: each `window.clerum.*` call and
 * the delivery of its response, each listener subscription and removal, each
 * navigation/toast/L1 controller call, and a projection of the deep-link UI at
 * every rest point. The log of a scenario is compared byte for byte with the
 * golden generated on the base, so a refactor that moves any of it is caught.
 *
 * Where each world API comes from (none of them answers with a hand-written
 * shape unless marked):
 *
 * | API | Producer |
 * |---|---|
 * | `gfs.listPendingDeepLinks` | main's real `gfs:listPendingDeepLinks` handler over a real `GfsResourceDeepLinkQueue` |
 * | `gfs.acknowledgeDeepLink(id, authority?)` | main's real `gfs:acknowledgeDeepLink` handler (authority checked against AppService and the real navigation generation) |
 * | `gfs.clearPendingDeepLinks` | the real queue's `clear()`, as `App.deepLinks.test.tsx` wires it |
 * | `gfs.getUserNavigationGeneration` / `advanceUserNavigationGeneration` | a real `GfsUserNavigationGeneration` |
 * | `gfs:deepLink` events | the real queue's envelope, sent through main's FIFO renderer lane |
 * | `sandboxUi.listPendingDeepLinks` / `clearPendingDeepLinks` | a real `SandboxUiDeepLinkQueue` |
 * | `sandboxUi.acknowledgeDeepLink(id, authority?)` | main's real `sandboxUi:acknowledgeDeepLink` handler |
 * | `sandboxUi:deepLink` events | the real queue's envelope, emitted to the live listener (the main fake has no lane for it) |
 * | `sandboxUi:sessionInvalidated` events | AppService's real invalidation, with the queue reset production's `main.ts` does |
 * | `sandboxUi.open/close/...` | `createSandboxUiMainFake().bridge` |
 * | `auth.getSessionState` / `getSessionGeneration` | the real AppService of the main fake |
 * | `auth.getRuntimeConfigState`, `team.directory` | `installAppControllerClerum` |
 * | `sandboxUi.listApps` | **hand-written fixture**: the renderer has no producer of an app catalog |
 *
 * Responses are delivered on a microtask unless the scenario gates the API:
 * a gated call still executes in the world when App makes it (a held clear
 * empties the queue at once, like the real IPC) and only the delivery of its
 * answer waits for `release`.
 */

type AppController = ReturnType<typeof useAppController>
type WorkspaceState = AppController['workspaceTabs']

export type ConfirmDialogRecord = {
  title: string
  body?: ReactNode
  cancelLabel?: string
  confirmLabel?: string
  onCancel: () => void
  onConfirm: () => void
}

/**
 * What the module mocks of the test file forward here. They are created with
 * `vi.hoisted` because a mock factory may not import this module: it imports
 * the modules those factories replace.
 */
export type TraceSinks = {
  dialogs: Map<object, ConfirmDialogRecord>
  filesPages: Map<object, FilesPageProps>
  sandboxUiPage: { props: SandboxUiPageProps | null }
  controller: { use: (() => AppController) | null }
}

export type Principal = {
  id: string
  email: string
  name: string
  teamId: string
  teamName: string
}

export const USER_A: Principal = {
  id: 'user-a',
  email: 'a@example.test',
  name: 'User A',
  teamId: 'team-a',
  teamName: 'Team A',
}
export const USER_B: Principal = {
  id: 'user-b',
  email: 'b@example.test',
  name: 'User B',
  teamId: 'team-a',
  teamName: 'Team A',
}
export const USER_C: Principal = {
  id: 'user-c',
  email: 'c@example.test',
  name: 'User C',
  teamId: 'team-a',
  teamName: 'Team A',
}

// Same derivation as `useAppController` (no exported producer to call).
function principalIdentity(principal: Principal | null): string | null {
  return principal ? `${principal.id}:${principal.email.trim().toLowerCase()}` : null
}

export function gfsUri(n: number): string {
  return `gfs://main/${n.toString(16).padStart(32, '0')}`
}

export type TraceVariant = 'plain' | 'strict'

type HeldResponse = { api: string; index: number; release: () => void }

type Listener = (payload: unknown) => void

const CHANNELS = ['sandboxUi:sessionInvalidated', 'sandboxUi:deepLink', 'gfs:deepLink'] as const
type Channel = (typeof CHANNELS)[number]

// --- serialization ---------------------------------------------------------

function normalize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === undefined) return '<undefined>'
  if (typeof value === 'function') return '<fn>'
  if (value instanceof Error) return { error: value.message }
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '<cycle>'
  seen.add(value)
  if (Array.isArray(value)) return value.map(item => normalize(item, seen))
  if (value instanceof Map) return { map: [...value.entries()].map(e => normalize(e, seen)) }
  if (value instanceof Set) return { set: [...value].map(item => normalize(item, seen)) }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    out[key] = normalize((value as Record<string, unknown>)[key], seen)
  }
  return out
}

export function ser(value: unknown): string {
  return JSON.stringify(normalize(value))
}

// --- the stub controller -------------------------------------------------

type StubState = {
  force: () => void
  liveTeamId: string
}

/**
 * The mutable-in-place controller of `App.deepLinks.test.tsx` (`makeController`
 * + `useReactiveController`): `navItem` derives from its tab store, nav drives
 * the store through the real producers, and a scenario can set booting,
 * authentication, identity, `sessionGeneration` and the intent in place.
 */
function createStubController(stub: StubState, overrides: Partial<AppController>): AppController {
  const noop = vi.fn()
  let controller: AppController
  let tabSequence = 2
  let navigationIntentSequence = 0
  const beginNavigationIntent = () => {
    navigationIntentSequence += 1
    controller.navigationIntentSequence = navigationIntentSequence
    return navigationIntentSequence
  }
  const nextWorkspaceTabId = vi.fn(() => `ws-tab-${tabSequence++}`)
  const setWorkspaceTabs = vi.fn((updater: unknown) => {
    const next =
      typeof updater === 'function'
        ? (updater as (state: WorkspaceState) => WorkspaceState)(controller.workspaceTabs)
        : (updater as WorkspaceState)
    if (next === controller.workspaceTabs) return
    controller.workspaceTabs = next
    stub.force()
  })
  const clearAppsPicker = vi.fn(() => {
    if (!controller.appsPickerActive) return
    controller.appsPickerActive = false
    stub.force()
  })
  const showAppsPicker = vi.fn(() => {
    if (controller.appsPickerActive) return
    if (activeWorkspaceTab(controller.workspaceTabs)?.kind === 'app') return
    controller.appsPickerActive = true
    stub.force()
  })
  const ensureTeamContext = vi.fn(async (target: { teamId?: string }): Promise<boolean> => {
    const targetTeamId = String(target.teamId || '').trim()
    if (!targetTeamId || targetTeamId === stub.liveTeamId) return false
    stub.liveTeamId = targetTeamId
    return true
  })
  const beginConfirmedGfsResourceNavigation = vi.fn(
    (id: number, uri: string, principalGeneration: number): GfsResourceNavigationRequest | null => {
      const intentSequence = beginNavigationIntent()
      const userNavigationGenerationAtActivation =
        window.clerum.gfs.advanceUserNavigationGeneration?.() ?? 0
      const owner = assignGfsResourceNavigationOwner(controller.workspaceTabs, uri)
      return {
        id,
        uri,
        ownerTabId: owner.createDestination ? nextWorkspaceTabId() : owner.ownerTabId,
        createDestination: owner.createDestination,
        intentSequence,
        principalGeneration,
        userNavigationGenerationAtActivation,
      }
    }
  )
  const isGfsResourceNavigationCurrent = vi.fn(
    (request: GfsResourceNavigationRequest, principalGeneration: number) =>
      canCompleteGfsResourceNavigation(request, {
        intentSequence: navigationIntentSequence,
        principalGeneration,
        userNavigationGeneration: window.clerum.gfs.getUserNavigationGeneration?.() ?? 0,
        activeTabId: controller.workspaceTabs.activeTabId,
        tabs: controller.workspaceTabs.tabs,
      })
  )
  const activateGfsResourceNavigation = vi.fn(
    (request: GfsResourceNavigationRequest, principalGeneration: number) => {
      if (
        request.intentSequence !== navigationIntentSequence ||
        request.principalGeneration !== principalGeneration ||
        request.userNavigationGenerationAtActivation !==
          (window.clerum.gfs.getUserNavigationGeneration?.() ?? 0)
      ) {
        return false
      }
      const state = controller.workspaceTabs
      if (request.createDestination) {
        if (state.tabs.some(tab => tab.id === request.ownerTabId)) return false
        setWorkspaceTabs(createFilesTab(state, { id: request.ownerTabId, path: null }))
      } else {
        if (!isGfsResourceNavigationOwnerPresent(request, state.tabs)) return false
        setWorkspaceTabs(selectWorkspaceTab(state, request.ownerTabId))
      }
      return controller.workspaceTabs.activeTabId === request.ownerTabId
    }
  )
  const completeGfsResourceNavigationPreview = vi.fn(
    (
      request: GfsResourceNavigationRequest,
      preview: Parameters<AppController['completeGfsResourceNavigationPreview']>[1],
      principalGeneration: number
    ) => {
      if (!isGfsResourceNavigationCurrent(request, principalGeneration)) return false
      setWorkspaceTabs(
        openPreviewTab(controller.workspaceTabs, {
          id: nextWorkspaceTabId(),
          title: preview.name,
          gfsUri: preview.gfsUri,
          fileKind: preview.kind,
          byteLength: preview.bytes,
          ...(preview.version !== undefined ? { resourceVersion: preview.version } : {}),
          ...('mimeType' in preview ? { mimeType: preview.mimeType } : {}),
        })
      )
      return controller.workspaceTabs.activeTabId !== request.ownerTabId
    }
  )
  const handleNavSelect = vi.fn((item: AppController['navItem']) => {
    beginNavigationIntent()
    if (item === DESKTOP_ROUTES.chat) {
      controller.selectedAgent = null
      clearAppsPicker()
      setWorkspaceTabs((state: WorkspaceState) => {
        const active = activeWorkspaceTab(state)
        if (active?.kind === 'chat') return state
        const lastChat = [...state.tabs].reverse().find(tab => tab.kind === 'chat')
        return lastChat
          ? { ...state, activeTabId: lastChat.id }
          : newChatTab(state, nextWorkspaceTabId(), null)
      })
    } else if (item === DESKTOP_ROUTES.apps) {
      showAppsPicker()
    } else if (item === DESKTOP_ROUTES.files) {
      clearAppsPicker()
      setWorkspaceTabs((state: WorkspaceState) => openFilesTab(state, { id: nextWorkspaceTabId() }))
    } else {
      const section = settingsSectionForRoute(item)
      if (section) {
        if (section === 'agents') controller.selectedAgent = null
        clearAppsPicker()
        setWorkspaceTabs((state: WorkspaceState) =>
          openSettingsTab(state, { id: nextWorkspaceTabId(), section })
        )
      }
    }
    stub.force()
  })
  const handleSelectChatAgent = vi.fn(
    (
      agentName: string,
      options: {
        chatId?: string
        keepNavItem?: boolean
        navigationIntentAlreadyStarted?: boolean
      } = {}
    ) => {
      if (!options.keepNavItem && !options.navigationIntentAlreadyStarted) beginNavigationIntent()
      controller.selectedAgent = agentName
      controller.activeChatId = options.chatId ?? null
      if (!options.keepNavItem) {
        clearAppsPicker()
        setWorkspaceTabs((state: WorkspaceState) => {
          const chatId = options.chatId ?? null
          return chatId
            ? openChatTab(state, { id: nextWorkspaceTabId(), agentRef: agentName, chatId })
            : newChatTab(state, nextWorkspaceTabId(), agentName)
        })
      }
      stub.force()
    }
  )
  controller = {
    booting: false,
    initialExperienceLoading: false,
    busy: false,
    statusText: '',
    statusTone: 'info',
    isAuthenticated: true,
    authenticatedPrincipalIdentity: null,
    availableTeamIds: ['team-a', 'team-b'],
    teamDirectoryHydrated: true,
    me: null,
    currentTeamId: 'team-a',
    sessionGeneration: null,
    runtimeConfigState: null,
    navigationIntentSequence,
    beginUserNavigationIntent: vi.fn(beginNavigationIntent),
    isNavigationIntentCurrent: vi.fn(sequence => sequence === navigationIntentSequence),
    captureWorkspaceNavigation: vi.fn(() => ({
      workspaceTabs: controller.workspaceTabs,
      selectedAgent: controller.selectedAgent,
      selectedAgentRoute: controller.selectedAgentRoute,
      appsPickerActive: controller.appsPickerActive,
      lastActiveChatTabId:
        activeWorkspaceTab(controller.workspaceTabs)?.kind === 'chat'
          ? (activeWorkspaceTab(controller.workspaceTabs)?.id ?? null)
          : null,
    })),
    restoreWorkspaceNavigation: vi.fn((snapshot, expectedIntentSequence) => {
      if (expectedIntentSequence !== navigationIntentSequence) return null
      const restoredIntent = beginNavigationIntent()
      controller.workspaceTabs = snapshot.workspaceTabs
      controller.selectedAgent = snapshot.selectedAgent
      controller.selectedAgentRoute = snapshot.selectedAgentRoute
      controller.appsPickerActive = snapshot.appsPickerActive
      stub.force()
      return restoredIntent
    }),
    navItem: DESKTOP_ROUTES.chat,
    selectedAgent: null,
    selectedAgentRoute: null,
    workspaceTabs: createWorkspaceTabsState('chat-tab-1'),
    setWorkspaceTabs,
    activeWorkspaceTab: undefined,
    nextWorkspaceTabId,
    appsPickerActive: false,
    showAppsPicker,
    clearAppsPicker,
    activateWorkspaceChatTab: noop,
    activeChatId: null,
    chatList: [],
    latestChatSessions: [],
    notifications: [],
    toasts: [],
    pendingApprovals: [],
    composerImageAttachments: [],
    composerReferenceAttachments: [],
    groupedMessages: [],
    activeMessages: [],
    notificationActionById: {},
    sessionStateByChatId: {},
    sessionStateByChatKey: {},
    activityByMessageId: {},
    progressByMessageId: {},
    agentLastActiveByAgent: {},
    dependencyHealth: null,
    hasDependencyOutage: false,
    desktopEnvironmentSetupComplete: false,
    pendingDesktopEnvironmentSetup: null,
    desktopReleaseStatus: null,
    showRuntimeConfigSelector: false,
    runtimeConfigMissing: false,
    authTransitioning: false,
    handleEnsureTeamContext: ensureTeamContext,
    getCurrentTeamId: vi.fn(() => stub.liveTeamId),
    isHostAccessBlocked: vi.fn(() => false),
    handleSelectChatAgent,
    handleNavSelect,
    handleLogout: vi.fn(),
    pushToast: vi.fn(),
    setStatus: noop,
    setBooting: noop,
    setEmail: noop,
    setPassword: noop,
    setDesktopSetupAuthorizationToken: noop,
    setRuntimeConfigSetupName: noop,
    setRuntimeConfigSetupExternalRestApiBaseUrl: noop,
    setRuntimeConfigSetupRpcProxyBaseUrl: noop,
    setPendingDesktopEnvironmentSetup: noop,
    setDesktopEnvironmentSetupComplete: noop,
    beginConfirmedGfsResourceNavigation,
    isGfsResourceNavigationCurrent,
    activateGfsResourceNavigation,
    completeGfsResourceNavigationPreview,
    ...overrides,
  } as unknown as AppController
  return controller
}

// vm.* calls that the log records. Wrapped once per underlying function, so
// a re-render never hands App a new identity.
const TRACED_VM = [
  'beginConfirmedGfsResourceNavigation',
  'activateGfsResourceNavigation',
  'pushToast',
  'handleEnsureTeamContext',
  'restoreWorkspaceNavigation',
  'handleSelectChatAgent',
  'captureWorkspaceNavigation',
  'beginUserNavigationIntent',
  'setWorkspaceTabs',
  'handleNavSelect',
  'completeGfsResourceNavigationPreview',
] as const
type TracedVm = (typeof TRACED_VM)[number]

// --- harness ---------------------------------------------------------------

export type TraceOptions = {
  variant: TraceVariant
  /** Principal signed in at mount, or null for a signed-out mount. */
  principal?: Principal | null
  sessionGeneration?: number
  controller?: Partial<AppController>
  /** Hand-written app catalog for `sandboxUi.listApps` (no renderer producer). */
  apps?: Array<{
    appRef: string
    title: string
    defaultPath: string
    ready: boolean
    phase?: string
  }>
  /** Runs after the world exists and before App mounts. */
  beforeMount?: (h: TraceHarness) => void
  /**
   * H-R: the real `useAppController` (from `vi.importActual`), with main's
   * AppService as its session authority, instead of the in-place stub.
   */
  realController?: () => AppController
}

export type TraceHarness = Awaited<ReturnType<typeof startTrace>>

const FIXED_NOW = Date.UTC(2026, 0, 15, 12, 0, 0)

export async function startTrace(sinks: TraceSinks, App: ComponentType, options: TraceOptions) {
  const log: string[] = []
  const callIndex = new Map<string, number>()
  const gates = new Map<string, { skip: number; count: number }>()
  const overrides = new Map<string, (...args: unknown[]) => unknown>()
  const held: HeldResponse[] = []
  const liveListeners = new Map<Channel, Map<number, Listener>>(
    CHANNELS.map(channel => [channel, new Map()])
  )
  const subscriptionSequence = new Map<Channel, number>(CHANNELS.map(channel => [channel, 0]))
  const appListeners = new Set<Listener>()
  // Identity the controller had at the last delivery of each GFS link id.
  const deliveredIdentityById = new Map<number, string | null>()
  let uuidSequence = 0

  // Clock order: the fake installs its own `Date.now` spy first, then the
  // suite fakes timers and Date over it, so both sides read one frozen clock.
  const main: SandboxUiMainFake = createSandboxUiMainFake()
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
  vi.setSystemTime(FIXED_NOW)
  const uuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
    uuidSequence += 1
    return `00000000-0000-4000-8000-${uuidSequence.toString().padStart(12, '0')}` as ReturnType<
      Crypto['randomUUID']
    >
  })

  const appQueue = new SandboxUiDeepLinkQueue()
  const gfsQueue = new GfsResourceDeepLinkQueue()
  const navigation = new GfsUserNavigationGeneration()
  main.useDeepLinkQueues(appQueue, gfsQueue, navigation)
  // What production's main does on invalidation (`main.ts`): reset both
  // queues and report their floors.
  main.setSessionInvalidationCleanup(() => ({
    appDeepLinkMinimumId: appQueue.clear(),
    gfsDeepLinkMinimumId: gfsQueue.clear(),
  }))
  const service = main.service as unknown as {
    sessionGeneration: number
    sessionToken: string | null
    me: (Principal & { picture: null; role: string }) | null
    getSessionState(): Promise<unknown>
    getSessionGeneration(): number
    savedSessionRestoreAttemptedEnvKey: string | null
    savedSessionRestoreAttemptedAtMs: number
  }

  const { handle } = installAppControllerClerum({
    teamDirectory: {
      items: [
        { team: { id: 'team-a', name: 'Team A' }, members: [] },
        { team: { id: 'team-b', name: 'Team B' }, members: [] },
      ],
      currentTeamId: 'team-a',
    },
  })
  const runtimeConfig = await handle.getRuntimeConfigState()
  let apps = options.apps ?? []

  const record = (entry: string) => {
    log.push(entry)
  }
  const nextIndex = (api: string) => {
    const index = (callIndex.get(api) ?? 0) + 1
    callIndex.set(api, index)
    return index
  }

  const stub: StubState = { force: () => {}, liveTeamId: 'team-a' }
  const controller = createStubController(stub, options.controller ?? {})
  const real = options.realController ?? null
  let latestReal: AppController | null = null
  // The controller App rendered last: the stub, or the real one's latest value.
  const vmNow = (): AppController => latestReal ?? controller

  function ipc<T>(api: string, args: unknown[], compute: () => T | Promise<T>): Promise<T> {
    const index = nextIndex(api)
    record(`call ${api}#${index} ${ser(args)}`)
    let outcome: Promise<T>
    try {
      const override = overrides.get(api)
      outcome = Promise.resolve(
        override ? (override(...args) as T | Promise<T>) : compute()
      ) as Promise<T>
    } catch (error) {
      outcome = Promise.reject(error)
    }
    const respond = (resolve: (value: T) => void, reject: (error: unknown) => void) => {
      outcome.then(
        value => {
          if (api.endsWith('listPendingDeepLinks') && api.startsWith('gfs')) {
            noteGfsDelivery((value as { links?: GfsResourceDeepLinkEnvelope[] })?.links ?? [])
          }
          record(`resp ${api}#${index} ${ser(value)}`)
          resolve(value)
        },
        error => {
          record(`reject ${api}#${index} ${ser(error instanceof Error ? error.message : error)}`)
          reject(error)
        }
      )
    }
    const gate = gates.get(api)
    if (gate && gate.count > 0) {
      if (gate.skip > 0) {
        gate.skip -= 1
      } else {
        gate.count -= 1
        return new Promise<T>((resolve, reject) => {
          held.push({ api, index, release: () => respond(resolve, reject) })
        })
      }
    }
    return new Promise<T>((resolve, reject) => respond(resolve, reject))
  }

  function syncCall<T>(api: string, compute: () => T): T {
    const index = nextIndex(api)
    const value = compute()
    record(`sync ${api}#${index} -> ${ser(value)}`)
    return value
  }

  function noteGfsDelivery(links: GfsResourceDeepLinkEnvelope[]) {
    for (const link of links) {
      if (link && typeof link.id === 'number') {
        deliveredIdentityById.set(link.id, vmNow().authenticatedPrincipalIdentity ?? null)
      }
    }
  }

  function subscribe(
    channel: Channel,
    listener: Listener,
    attach: (listener: Listener) => () => unknown
  ): () => void {
    const id = (subscriptionSequence.get(channel) ?? 0) + 1
    subscriptionSequence.set(channel, id)
    record(`sub ${channel}#${id}`)
    const wrapped: Listener = payload => {
      record(`event ${channel}->#${id} ${ser(payload)}`)
      if (channel === 'gfs:deepLink') noteGfsDelivery([payload as GfsResourceDeepLinkEnvelope])
      listener(payload)
    }
    liveListeners.get(channel)!.set(id, wrapped)
    const detach = attach(wrapped)
    return () => {
      record(`unsub ${channel}#${id}`)
      liveListeners.get(channel)!.delete(id)
      detach()
    }
  }

  const bridge = main.bridge
  const open = (request: unknown) =>
    ipc('sandboxUi.open', [request], () => bridge.open(request as never))
  const close = (request: unknown) =>
    ipc('sandboxUi.close', [request], () => bridge.close(request as never))

  // The real controller also needs the rest of the coordinator bridge that
  // `installAppControllerClerum` put on `window.clerum`.
  const coordinatorBridge = window.clerum as unknown as Record<string, Record<string, unknown>>
  const traceBridge = {
    shortcuts: { onCommand: vi.fn(() => vi.fn()) },
    app: { rendererReady: vi.fn().mockResolvedValue(undefined) },
    sandboxUi: {
      ...bridge,
      open,
      close,
      listApps: () => ipc('sandboxUi.listApps', [], () => ({ apps })),
      listPendingDeepLinks: () =>
        ipc('sandboxUi.listPendingDeepLinks', [], () => ({ links: appQueue.list() })),
      clearPendingDeepLinks: () =>
        ipc('sandboxUi.clearPendingDeepLinks', [], () => appQueue.clear()),
      acknowledgeDeepLink: (id: number, authority?: DeepLinkAcknowledgmentAuthority) =>
        ipc(
          'sandboxUi.acknowledgeDeepLink',
          authority === undefined ? [id] : [id, authority],
          () =>
            authority === undefined
              ? invokeMain('sandboxUi:acknowledgeDeepLink', { id })
              : invokeMain('sandboxUi:acknowledgeDeepLink', { id, authority })
        ),
      focusActive: vi.fn().mockResolvedValue(true),
      onDeepLink: (listener: (link: SandboxUiDeepLinkEnvelope) => void) =>
        subscribe('sandboxUi:deepLink', listener as Listener, wrapped => {
          appListeners.add(wrapped)
          return () => appListeners.delete(wrapped)
        }),
      onSessionInvalidated: (listener: Listener) =>
        subscribe('sandboxUi:sessionInvalidated', listener, wrapped =>
          bridge.onSessionInvalidated(wrapped as never)
        ),
    },
    gfs: {
      getUserNavigationGeneration: () =>
        syncCall('gfs.getUserNavigationGeneration', () => navigation.current()),
      advanceUserNavigationGeneration: () =>
        syncCall('gfs.advanceUserNavigationGeneration', () => navigation.advance()),
      acknowledgeDeepLink: (id: number, authority?: DeepLinkAcknowledgmentAuthority) =>
        ipc('gfs.acknowledgeDeepLink', authority === undefined ? [id] : [id, authority], () =>
          authority === undefined
            ? invokeMain('gfs:acknowledgeDeepLink', { id })
            : invokeMain('gfs:acknowledgeDeepLink', { id, authority })
        ),
      clearPendingDeepLinks: () => ipc('gfs.clearPendingDeepLinks', [], () => gfsQueue.clear()),
      listPendingDeepLinks: () =>
        ipc('gfs.listPendingDeepLinks', [], () => invokeMain('gfs:listPendingDeepLinks', {})),
      onDeepLink: (listener: (link: GfsResourceDeepLinkEnvelope) => void) =>
        subscribe('gfs:deepLink', listener as Listener, wrapped =>
          main.onGfsDeepLink(wrapped as never)
        ),
    },
    auth: {
      getSessionState: () => ipc('auth.getSessionState', [], () => service.getSessionState()),
      getSessionGeneration: () =>
        ipc('auth.getSessionGeneration', [], () => service.getSessionGeneration()),
      getRuntimeConfigState: () =>
        ipc('auth.getRuntimeConfigState', [], () => handle.getRuntimeConfigState()),
    },
    team: {
      directory: () =>
        ipc('team.directory', [], () => (handle.teamDirectory as () => Promise<unknown>)()),
    },
  } as unknown as Record<string, Record<string, unknown>>
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: real
      ? {
          ...coordinatorBridge,
          ...traceBridge,
          sandboxUi: { ...coordinatorBridge.sandboxUi, ...traceBridge.sandboxUi },
          gfs: { ...coordinatorBridge.gfs, ...traceBridge.gfs },
          auth: { ...coordinatorBridge.auth, ...traceBridge.auth },
          team: { ...coordinatorBridge.team, ...traceBridge.team },
        }
      : traceBridge,
  })

  // Main's real ipc.ts handler runs at the moment App calls; only the
  // delivery of its answer goes through this harness's transport.
  function invokeMain(channel: string, payload: unknown): Promise<unknown> {
    return main.invokeNow(channel, payload)
  }

  // --- vm tracing --------------------------------------------------------
  const tracedByFunction = new WeakMap<
    (...args: never[]) => unknown,
    (...args: never[]) => unknown
  >()
  function traced(name: TracedVm, fn: (...args: never[]) => unknown) {
    const cached = tracedByFunction.get(fn)
    if (cached) return cached
    const wrapper = (...args: never[]) => {
      record(`vm.${name} ${ser(projectVmArgs(name, args))}`)
      let result: unknown
      try {
        result = fn(...args)
      } catch (error) {
        record(`vm.${name} threw ${ser(error instanceof Error ? error.message : error)}`)
        throw error
      }
      if (name === 'activateGfsResourceNavigation') assertIdentityOfActivation(args)
      if (
        name === 'beginConfirmedGfsResourceNavigation' ||
        name === 'activateGfsResourceNavigation' ||
        name === 'restoreWorkspaceNavigation' ||
        name === 'beginUserNavigationIntent' ||
        name === 'completeGfsResourceNavigationPreview'
      ) {
        record(`vm.${name} -> ${ser(result)}`)
      }
      return result
    }
    tracedByFunction.set(fn, wrapper)
    return wrapper
  }
  function traceVm(target: AppController) {
    const writable = target as unknown as Record<string, unknown>
    for (const name of TRACED_VM) {
      const fn = writable[name]
      if (typeof fn === 'function') writable[name] = traced(name, fn as never)
    }
  }
  traceVm(controller)

  const igViolations: string[] = []
  function assertIdentityOfActivation(args: unknown[]) {
    const request = args[0] as GfsResourceNavigationRequest | undefined
    if (!request) return
    const received = deliveredIdentityById.get(request.id)
    const current = vmNow().authenticatedPrincipalIdentity ?? null
    if (received !== undefined && received !== null && received !== current) {
      igViolations.push(`activate #${request.id} received as ${received} under ${current}`)
    }
  }

  function projectVmArgs(name: TracedVm, args: unknown[]): unknown {
    switch (name) {
      case 'activateGfsResourceNavigation':
        return [args[0], args[1]]
      case 'restoreWorkspaceNavigation':
        return ['<snapshot>', args[1]]
      case 'captureWorkspaceNavigation':
        return []
      case 'setWorkspaceTabs':
        return [
          typeof args[0] === 'function' ? '<updater>' : projectTabs(args[0] as WorkspaceState),
        ]
      case 'completeGfsResourceNavigationPreview':
        return [args[0], '<preview>', args[2]]
      default:
        return args
    }
  }

  function projectTabs(state: WorkspaceState | undefined) {
    if (!state) return null
    return {
      activeTabId: state.activeTabId,
      tabs: state.tabs.map(tab => `${tab.id}:${tab.kind}`),
    }
  }

  // --- world → controller coherence ------------------------------------
  function publish(principal: Principal | null, generation: number | null) {
    service.me = principal ? { ...principal, picture: null, role: 'member' } : null
    service.sessionToken = principal ? `session-${principal.id}` : null
    if (!principal) {
      // Main already tried the saved-token restore when it showed the window
      // (`createWindow`), so a signed-out read answers from its state.
      service.savedSessionRestoreAttemptedEnvKey = 'test-env'
      service.savedSessionRestoreAttemptedAtMs = Date.now()
    }
    if (generation !== null) service.sessionGeneration = generation
    if (real) {
      if (principal) stub.liveTeamId = principal.teamId
      return
    }
    const target = controller as unknown as Record<string, unknown>
    target.isAuthenticated = principal !== null
    target.me = principal ? { ...principal, picture: null, role: 'member' } : null
    target.authenticatedPrincipalIdentity = principalIdentity(principal)
    target.currentTeamId = principal?.teamId ?? ''
    target.sessionGeneration = principal === null && generation === null ? null : generation
    if (principal) stub.liveTeamId = principal.teamId
  }

  // Identity comes from the world (`principal`, `publish`), never from a
  // controller override that `publish` would silently overwrite.
  for (const field of [
    'isAuthenticated',
    'me',
    'authenticatedPrincipalIdentity',
    'currentTeamId',
  ]) {
    if (options.controller && field in options.controller) {
      throw new Error(`set ${field} through the trace principal, not options.controller`)
    }
  }
  const initialPrincipal = options.principal === undefined ? USER_A : options.principal
  const initialGeneration = options.sessionGeneration ?? 7
  publish(initialPrincipal, initialPrincipal ? initialGeneration : null)
  if (!initialPrincipal) service.sessionGeneration = initialGeneration
  ;(controller as unknown as Record<string, unknown>).runtimeConfigState = runtimeConfig
  if (options.controller && 'sessionGeneration' in options.controller) {
    ;(controller as unknown as Record<string, unknown>).sessionGeneration =
      options.controller.sessionGeneration
  }

  function useStubController(): AppController {
    const [, force] = useReducer((count: number) => count + 1, 0)
    stub.force = force
    const activeTab = activeWorkspaceTab(controller.workspaceTabs)
    ;(controller as { activeWorkspaceTab: unknown }).activeWorkspaceTab = activeTab
    ;(controller as { navItem: unknown }).navItem = controller.appsPickerActive
      ? DESKTOP_ROUTES.apps
      : mapKindToRoute(activeTab)
    return controller
  }
  function useRealController(): AppController {
    const vm = real!()
    traceVm(vm)
    latestReal = vm
    return vm
  }
  sinks.controller.use = real ? useRealController : useStubController

  // --- projections -----------------------------------------------------
  function projectDialogs() {
    return [...sinks.dialogs.values()]
      .map(props => ({
        title: props.title,
        body: renderToStaticMarkup(createElement(Fragment, null, props.body)),
        cancelLabel: props.cancelLabel,
        confirmLabel: props.confirmLabel,
      }))
      .sort((left, right) => left.title.localeCompare(right.title))
  }
  function projectFiles() {
    const pages = [...sinks.filesPages.values()]
    if (pages.length === 0) return null
    return pages.map(props => ({
      pendingGfsDeepLink: props.pendingGfsDeepLink ?? null,
      pendingGfsDeepLinkOwnerTabId: props.pendingGfsDeepLinkOwnerTabId ?? null,
    }))
  }
  function projectBanner() {
    const banner = document.querySelector('[data-testid="sandbox-ui-session-revalidation-pending"]')
    return banner ? (banner.textContent ?? '').replace(/\s+/g, ' ').trim() : null
  }
  function liveCounts() {
    return Object.fromEntries(CHANNELS.map(channel => [channel, liveListeners.get(channel)!.size]))
  }

  // --- rest --------------------------------------------------------------
  async function settle(label = ''): Promise<void> {
    let stableRounds = 0
    let previous = ''
    for (let round = 0; round < 50; round += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
        await main.settle()
      })
      const signature = `${log.length}:${held.length}`
      if (signature === previous) {
        stableRounds += 1
        if (stableRounds >= 2) {
          record(
            `rest${label ? ` ${label}` : ''} ${ser({
              dialogs: projectDialogs(),
              files: projectFiles(),
              banner: projectBanner(),
              workspace: {
                navItem: vmNow().navItem,
                ...projectTabs(vmNow().workspaceTabs),
              },
              listeners: liveCounts(),
              held: held.map(item => `${item.api}#${item.index}`),
            })}`
          )
          return
        }
      } else {
        stableRounds = 0
        previous = signature
      }
    }
    throw new Error('sin reposo: the deep-link trace never reached rest')
  }

  // --- mount -------------------------------------------------------------
  options.beforeMount?.(harness())

  const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
  const tree = (): ReactElement => {
    const app = createElement(
      QueryClientProvider,
      { client: queryClient },
      real ? createElement(AgentTaskTrackerProvider, null, createElement(App)) : createElement(App)
    )
    return options.variant === 'strict' ? createElement(StrictMode, null, app) : app
  }
  let unmount: (() => void) | null = null
  await act(async () => {
    unmount = render(tree()).unmount
  })
  const clockBefore = Date.now()
  await settle('mount')
  // The frozen clock is part of what makes the log reproducible.
  expect(Date.now()).toBe(clockBefore)

  function harness() {
    return {
      log,
      main,
      service,
      controller,
      vmNow,
      appQueue,
      gfsQueue,
      navigation,
      igViolations,
      record,
      settle,
      publish,
      ser,
      setApps(next: typeof apps) {
        apps = next
      },
      mark(label: string) {
        record(`mark ${label}`)
      },
      /** Holds the delivery of the next `count` calls of `api`, after skipping `skip`. */
      gate(api: string, count = 1, skip = 0) {
        gates.set(api, { skip, count })
      },
      ungate(api: string) {
        gates.delete(api)
      },
      heldCount: () => held.length,
      async release(api: string) {
        const at = held.findIndex(item => item.api === api)
        if (at < 0) throw new Error(`nothing held for ${api}`)
        const [item] = held.splice(at, 1)
        record(`release ${api}#${item!.index}`)
        await act(async () => {
          item!.release()
          await Promise.resolve()
        })
      },
      override(api: string, impl: ((...args: unknown[]) => unknown) | null) {
        if (impl) overrides.set(api, impl)
        else overrides.delete(api)
      },
      /** Forces a render of App with the controller as it is now. */
      async render() {
        await act(async () => {
          stub.force()
        })
      },
      /** Mutates the controller and renders once, in one act. */
      async update(mutate: (controller: AppController) => void) {
        await act(async () => {
          mutate(controller)
          stub.force()
        })
      },
      traceVm(fn: TracedVm, impl: (...args: never[]) => unknown) {
        ;(controller as unknown as Record<string, unknown>)[fn] = traced(fn, impl)
      },
      /** Queues a GFS link in main's real queue without delivering it. */
      pushQueued(n: number): GfsResourceDeepLinkEnvelope {
        const target = parseGfsResourceDeepLink(buildGfsResourceDeepLink(gfsUri(n)))
        if (!target) throw new Error('the shared GFS producer rejected the fixture URI')
        const envelope = gfsQueue.enqueue(target, navigation.current())
        record(`world gfs.enqueue ${ser(envelope)}`)
        return envelope
      },
      /** Main sends a queued GFS link to the renderer, through its FIFO lane. */
      async deliver(envelope: GfsResourceDeepLinkEnvelope) {
        record(`world gfs.deliver #${envelope.id}`)
        await act(async () => {
          await main.emitGfsDeepLink(envelope)
        })
      },
      async produceGfs(n: number): Promise<GfsResourceDeepLinkEnvelope> {
        const envelope = this.pushQueued(n)
        await this.deliver(envelope)
        return envelope
      },
      /** Defensive input the real producer never emits: straight to the live listener. */
      async injectGfs(...payloads: unknown[]) {
        await act(async () => {
          for (const payload of payloads) {
            record(`world gfs.inject ${ser(payload)}`)
            for (const listener of [...liveListeners.get('gfs:deepLink')!.values()]) {
              listener(payload)
            }
          }
        })
      },
      /** Defensive: invalidation events straight to the live listener, all in one tick. */
      async injectInvalidation(...payloads: unknown[]) {
        await act(async () => {
          for (const payload of payloads) {
            record(`world sessionInvalidated.inject ${ser(payload)}`)
            for (const listener of [
              ...liveListeners.get('sandboxUi:sessionInvalidated')!.values(),
            ]) {
              listener(payload)
            }
          }
        })
      },
      pushQueuedApp(link: { appName: string; path?: string; teamId?: string }) {
        const target = parseSandboxUiDeepLink(
          buildSandboxUiDeepLink({
            recipeNs: 'ns',
            recipeName: link.appName,
            ...(link.path ? { path: link.path } : {}),
            ...(link.teamId ? { teamId: link.teamId } : {}),
          })
        )
        if (!target) throw new Error('the shared app-link producer rejected the fixture')
        const envelope = appQueue.enqueue(target, navigation.current())
        record(`world sandboxUi.enqueue ${ser(envelope)}`)
        return envelope
      },
      async deliverApp(envelope: SandboxUiDeepLinkEnvelope) {
        record(`world sandboxUi.deliver #${envelope.id}`)
        await act(async () => {
          for (const listener of [...appListeners]) listener(envelope)
        })
      },
      async produceApp(link: { appName: string; path?: string; teamId?: string }) {
        const envelope = this.pushQueuedApp(link)
        await this.deliverApp(envelope)
        return envelope
      },
      /** AppService invalidates the session; main resets its queues and tells the renderer. */
      endSession(generation: number) {
        record(`world endSession ${generation}`)
        main.endSession(generation)
      },
      dialog(title: string): ConfirmDialogRecord {
        const found = [...sinks.dialogs.values()].filter(props => props.title === title)
        if (found.length !== 1)
          throw new Error(`expected one "${title}" dialog, saw ${found.length}`)
        return found[0]!
      },
      hasDialog(title: string): boolean {
        return [...sinks.dialogs.values()].some(props => props.title === title)
      },
      async confirm(title: string) {
        const props = this.dialog(title)
        record(`user confirm "${title}"`)
        await act(async () => {
          props.onConfirm()
        })
      },
      async dismiss(title: string) {
        const props = this.dialog(title)
        record(`user dismiss "${title}"`)
        await act(async () => {
          props.onCancel()
        })
      },
      filesProps(): FilesPageProps {
        const pages = [...sinks.filesPages.values()]
        if (pages.length !== 1) throw new Error(`expected one FilesPage, saw ${pages.length}`)
        return pages[0]!
      },
      async outcome(id: number, outcome: 'opened' | 'terminal' | 'retryable' | 'superseded') {
        record(`files outcome #${id} ${outcome}`)
        const props = this.filesProps()
        await act(async () => {
          props.onPendingGfsDeepLinkOutcome?.(id, outcome)
        })
      },
      async clickRetryVerification() {
        const banner = document.querySelector(
          '[data-testid="sandbox-ui-session-revalidation-pending"]'
        )
        const button = banner?.querySelector('button')
        if (!button) throw new Error('the revalidation banner has no Retry button')
        record('user click "Retry verification"')
        await act(async () => {
          fireEvent.click(button)
        })
      },
      async advance(ms: number) {
        record(`clock +${ms}ms`)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(ms)
        })
      },
      async unmount() {
        record('world unmount')
        await act(async () => {
          unmount?.()
        })
      },
      liveCounts,
      // --- log queries ---------------------------------------------------
      entries(prefix: string, from = 0): string[] {
        return log.slice(from).filter(entry => entry.startsWith(prefix))
      },
      count(prefix: string, from = 0): number {
        return log.slice(from).filter(entry => entry.startsWith(prefix)).length
      },
      indexOf(prefix: string, from = 0): number {
        const at = log.slice(from).findIndex(entry => entry.startsWith(prefix))
        return at < 0 ? -1 : at + from
      },
      lastMark(label: string): number {
        return log.lastIndexOf(`mark ${label}`)
      },
      lastRest() {
        for (let at = log.length - 1; at >= 0; at -= 1) {
          const entry = log[at]!
          if (entry.startsWith('rest')) {
            return JSON.parse(entry.slice(entry.indexOf('{'))) as {
              dialogs: Array<{ title: string; body: string }>
              files: Array<{ pendingGfsDeepLink: { id: number; uri: string } | null }> | null
              banner: string | null
              workspace: { navItem: string; activeTabId: string | null; tabs: string[] }
              listeners: Record<Channel, number>
              held: string[]
            }
          }
        }
        throw new Error('no rest point in the log')
      },
      async dispose() {
        await act(async () => {
          cleanup()
        })
        sinks.dialogs.clear()
        sinks.filesPages.clear()
        sinks.sandboxUiPage.props = null
        sinks.controller.use = null
        queryClient.clear()
        uuidSpy.mockRestore()
        vi.useRealTimers()
        await main.dispose()
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
      },
    }
  }
  return harness()
}
