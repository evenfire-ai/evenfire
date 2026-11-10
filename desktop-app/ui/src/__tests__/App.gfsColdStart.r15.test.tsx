// @vitest-environment jsdom
import { Fragment, type ReactNode, StrictMode, createElement, useLayoutEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import fc, { type AsyncCommand, type Scheduler } from 'fast-check'
import { buildGfsResourceDeepLink, parseGfsResourceDeepLink } from '@clerum/desktop-app-links'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { useAppController } from '@hooks/useAppController'
import type { GfsResourceNavigationRequest } from '@lib/gfsResourceNavigationIntent'
import { activeWorkspaceTab } from '@lib/workspaceTabs'
import type { FilesPageProps } from '@pages/FilesPage.types'
import { App } from '@/App'
import type { GfsResourceDeepLinkEnvelope } from '@/App.types'
import {
  resolveDeniedMessage,
  resolvedDirectory,
  resolvedFile,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import {
  GfsResourceDeepLinkQueue,
  GfsUserNavigationGeneration,
} from '../../../src/gfsResourceDeepLinkQueue'
import { SandboxUiDeepLinkQueue } from '../../../src/sandboxUiDeepLinkQueue'
import { buildSandboxUiDeepLink, parseSandboxUiDeepLink } from '../../../src/sandboxUiDeepLinks'
import type { DeepLinkAcknowledgmentAuthority } from '../../../src/types'
import { installAppControllerClerum } from '../hooks/domain/__tests__/__fixtures__/appControllerHarness'
import {
  type Model,
  type Observation,
  assertObservation,
  initialModel,
  transition,
} from './__fixtures__/n2-reference-model-r15'
import { type SandboxUiMainFake, createSandboxUiMainFake } from './__fixtures__/sandboxUiMainFake'

const dialogHarness = vi.hoisted(() => ({
  renderActual: false,
  props: null as null | {
    title: string
    body: ReactNode
    cancelLabel?: string
    confirmLabel?: string
    onCancel: () => void
    onConfirm: () => void
  },
}))
const filesHarness = vi.hoisted(() => ({ props: null as null | FilesPageProps }))

vi.mock(
  'electron',
  async () =>
    (await import('../../../src/__tests__/__fixtures__/sandboxUiElectronFakes')).electronModule
)
vi.mock('../../../src/config', async () => ({
  ...(await import('../../../src/__tests__/__fixtures__/sandboxUiMainModuleMocks')).configModule,
  getActiveRuntimeConfigOptionId: () => null,
  hydrateDesktopRuntimeConfig: vi.fn(),
  isDesktopRuntimeConfigured: () => true,
}))
vi.mock('../../../src/chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn().mockResolvedValue(undefined),
  unbindChatStore: vi.fn(),
  __setChatStoreBaseDirForTests: vi.fn(),
}))
vi.mock(
  '../../../src/sandboxUiPartitionGc',
  async () =>
    (await import('../../../src/__tests__/__fixtures__/sandboxUiMainModuleMocks')).partitionGcModule
)
vi.mock(
  '../../../src/rpcTokenManager',
  async () =>
    (await import('../../../src/__tests__/__fixtures__/sandboxUiMainModuleMocks'))
      .rpcTokenManagerModule
)
vi.mock(
  '../../../src/authClient',
  async () =>
    (await import('../../../src/__tests__/__fixtures__/sandboxUiMainModuleMocks')).authClientModule
)
vi.mock(
  '../../../src/tokenStore',
  async () =>
    (await import('../../../src/__tests__/__fixtures__/sandboxUiMainModuleMocks')).tokenStoreModule
)
vi.mock('@hooks/useAppController', () => ({ useAppController: vi.fn() }))
vi.mock('@hooks/useAgentChatActionsValue', () => ({ useAgentChatActionsValue: () => ({}) }))
vi.mock('@components/AppHeader', () => ({ AppHeader: () => null }))
vi.mock('@components/BootSplash', () => ({ BootSplash: () => null }))
vi.mock('@components/ChatDrawer', () => ({ ChatDrawer: () => null }))
vi.mock('@components/ChatLocalSearch', () => ({ ChatLocalSearch: () => null }))
vi.mock('@components/ChatSwitcher', () => ({ ChatSwitcher: () => null }))
vi.mock('@components/ChatViewWorkspace', () => ({
  ChatViewWorkspace: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
}))
vi.mock('@components/CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('@components/Common', async () => ({
  ...(await vi.importActual<typeof import('@components/Common')>('@components/Common')),
  Button: ({
    children,
    disabled,
    onClick,
    type,
  }: {
    children?: ReactNode
    disabled?: boolean
    onClick?: () => void
    type?: 'button' | 'submit' | 'reset'
  }) => createElement('button', { disabled, onClick, type: type ?? 'button' }, children),
  IconButton: ({
    children,
    disabled,
    label,
    onClick,
    type,
  }: {
    children?: ReactNode
    disabled?: boolean
    label: string
    onClick?: () => void
    type?: 'button' | 'submit' | 'reset'
  }) =>
    createElement(
      'button',
      { 'aria-label': label, disabled, onClick, type: type ?? 'button' },
      children
    ),
  StatusBanner: ({ text }: { text: string }) => createElement('div', { role: 'alert' }, text),
  ToastStack: () => null,
}))
vi.mock('@components/ConfirmDialog', async () => {
  const actual = await vi.importActual<typeof import('@components/ConfirmDialog')>(
    '@components/ConfirmDialog'
  )
  return {
    ConfirmDialog: (props: NonNullable<typeof dialogHarness.props>) => {
      dialogHarness.props = props
      if (dialogHarness.renderActual) {
        return createElement(actual.ConfirmDialog, props)
      }
      return createElement(
        'div',
        { role: 'dialog', 'aria-label': props.title },
        createElement('h2', null, props.title),
        props.body,
        createElement(
          'button',
          { onClick: props.onCancel, type: 'button' },
          props.cancelLabel ?? 'Dismiss'
        ),
        createElement(
          'button',
          { onClick: props.onConfirm, type: 'button' },
          props.confirmLabel ?? 'Open'
        )
      )
    },
  }
})
vi.mock('@components/GfsImagePreview', () => ({ GfsImagePreview: () => null }))
vi.mock('@components/PluginConsentModal', () => ({ PluginConsentModal: () => null }))
vi.mock('@components/RightRailShell', () => ({
  RightRailShell: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}))
vi.mock('@components/SidebarNav', () => ({ SidebarNav: () => null }))
vi.mock('@components/WindowTitleBar', () => ({
  TitlebarActionsPortal: () => null,
  WindowTitleBar: () => null,
}))
vi.mock('@components/WorkspaceTabStrip', () => ({
  WorkspaceTabStrip: ({
    tabs,
    activeTabId,
  }: {
    tabs: Array<{ id: string; title: string }>
    activeTabId: string
  }) =>
    createElement(
      'div',
      { role: 'toolbar', 'aria-label': 'Workspace tabs' },
      ...tabs.map(tab =>
        createElement(
          'button',
          {
            key: tab.id,
            'aria-pressed': tab.id === activeTabId,
            type: 'button',
          },
          tab.title
        )
      )
    ),
}))
vi.mock('@pages/AgentsPage', () => ({ AgentsPage: () => null }))
vi.mock('@pages/AuthPage', () => ({ AuthPage: () => null }))
vi.mock('@pages/ChatPage', () => ({ ChatPage: () => null }))
vi.mock('@pages/FilesPage', async () => {
  const actual = await vi.importActual<typeof import('@pages/FilesPage')>('@pages/FilesPage')
  return {
    FilesPage: (props: FilesPageProps) => {
      filesHarness.props = props
      return createElement(Fragment, null, createElement(actual.FilesPage, props))
    },
  }
})
vi.mock('@pages/McpServersPage', () => ({ McpServersPage: () => null }))
vi.mock(
  '@pages/FilePreviewPage',
  async () =>
    await vi.importActual<typeof import('@pages/FilePreviewPage')>('@pages/FilePreviewPage')
)
vi.mock('@pages/OnboardingPage', () => ({ OnboardingPage: () => null }))
vi.mock('@pages/SandboxUiPage', () => ({
  SandboxUiPage: (props: {
    embed: { registerMeasurer: (measure: () => Promise<unknown>) => () => void }
  }) => {
    useLayoutEffect(
      () =>
        props.embed.registerMeasurer(async () => ({
          x: 16,
          y: 12,
          width: 400,
          height: 300,
          dpr: 1,
        })),
      [props.embed]
    )
    return null
  },
}))
vi.mock('@pages/SettingsPage', () => ({ SettingsPage: () => null }))
vi.mock('@pages/UnavailablePage', () => ({ UnavailablePage: () => null }))
vi.mock('@pages/WorkflowsPage', () => ({ WorkflowsPage: () => null }))

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(settle => (resolve = settle)), resolve }
}

type AppController = ReturnType<typeof useAppController>
type ProductionObservation = Observation & {
  actualResolverEntriesById: Map<number, number>
  previewFetchesById: Map<number, number>
}

type Fixture = {
  getController: () => AppController
  handle: ReturnType<typeof installAppControllerClerum>['handle']
  gfsList: ReturnType<typeof vi.fn>
  gfsListEventCounts: number[]
  gfsAck: ReturnType<typeof vi.fn>
  gfsResolve: ReturnType<typeof vi.fn>
  gfsResolveStacks: string[]
  resourceReadIdentities: Array<string | null>
  appList: ReturnType<typeof vi.fn>
  appLinkList: ReturnType<typeof vi.fn>
  beginTrace: Array<{
    id: number
    intent: number
    accepted: boolean
    sessionGeneration: number | null
  }>
  confirmedTrace: GfsResourceNavigationRequest[]
  activationTrace: Array<Record<string, unknown>>
  navTrace: Array<Record<string, unknown>>
  gfsClear: ReturnType<typeof vi.fn>
  sessionStarted: Promise<void>
  releaseSession: () => void
  releaseAppListing: () => void
  releaseGfsListing: () => void
  gfsListingStarted: Promise<void>
  releaseResource: () => void
  resourceReadStarted: Promise<void>
  emitGfsLink: (link: GfsResourceDeepLinkEnvelope) => Promise<void>
  queryClient: QueryClient
  gfsLink: GfsResourceDeepLinkEnvelope | null
  gfsQueue: GfsResourceDeepLinkQueue
  appQueue: SandboxUiDeepLinkQueue
  navigation: GfsUserNavigationGeneration
  main: SandboxUiMainFake
  eventDeliveries: () => number
  dispose: () => Promise<void>
}

describe('Spec 110 r15 cold GFS readiness replay', () => {
  const userA: NonNullable<AppController['me']> = {
    id: 'user-a',
    email: 'a@example.test',
    name: 'User A',
    picture: null,
    teamId: 'team-a',
    teamName: 'Team A',
    role: 'member',
  }
  let main: SandboxUiMainFake | null = null
  let realController: AppController | null = null
  let unmount: (() => void) | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    dialogHarness.renderActual = false
    dialogHarness.props = null
    filesHarness.props = null
    realController = null
    vi.mocked(useAppController).mockImplementation(() => {
      throw new Error('the real App controller fixture was not mounted')
    })
  })

  afterEach(async () => {
    unmount?.()
    unmount = null
    cleanup()
    if (main) await main.dispose()
    main = null
    realController = null
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    dialogHarness.props = null
    filesHarness.props = null
  })

  function produceGfsLink(
    queue: GfsResourceDeepLinkQueue,
    navigation: GfsUserNavigationGeneration,
    uri: string
  ) {
    const target = parseGfsResourceDeepLink(buildGfsResourceDeepLink(uri))
    if (!target) throw new Error('the shared GFS producer rejected the resource fixture')
    return queue.enqueue(target, navigation.current())
  }

  async function mountWithHeldRealSession(
    uri: string | null,
    options: {
      holdAppListing?: boolean
      holdGfsListing?: boolean
      holdGfsListingBeforeSnapshot?: boolean
      holdResourceResolution?: boolean
      authenticated?: boolean
      delayAuthenticatedLoad?: boolean
      strictMode?: boolean
      scheduleGfsProduction?: (
        queue: GfsResourceDeepLinkQueue,
        navigation: GfsUserNavigationGeneration,
        uri: string
      ) => Promise<GfsResourceDeepLinkEnvelope>
    } = {}
  ): Promise<Fixture> {
    main = createSandboxUiMainFake()
    const service = main.service as unknown as {
      sessionGeneration: number
      sessionToken: string | null
      me: typeof userA | null
      getSessionState: () => Promise<unknown>
    }
    service.sessionGeneration = options.authenticated === false ? 0 : 1
    service.sessionToken = options.authenticated === false ? null : 'session-a'
    service.me = options.authenticated === false ? null : userA

    const appQueue = new SandboxUiDeepLinkQueue()
    const gfsQueue = new GfsResourceDeepLinkQueue()
    const navigation = new GfsUserNavigationGeneration()
    main.useDeepLinkQueues(appQueue, gfsQueue, navigation)
    main.setSessionInvalidationCleanup(() => ({
      appDeepLinkMinimumId: appQueue.clear(),
      gfsDeepLinkMinimumId: gfsQueue.clear(),
    }))
    const gfsLink = uri
      ? options.scheduleGfsProduction
        ? await options.scheduleGfsProduction(gfsQueue, navigation, uri)
        : produceGfsLink(gfsQueue, navigation, uri)
      : null
    const appListingGate = deferred<void>()
    const gfsListingGate = deferred<void>()
    const gfsListingStarted = deferred<void>()
    const resourceReadGate = deferred<void>()
    const resourceReadStarted = deferred<void>()
    const gfsResolveStacks: string[] = []
    const resourceReadIdentities: Array<string | null> = []
    const gfsListEventCounts: number[] = []
    let deliveredGfsEvents = 0
    const appList = vi.fn(async () => ({ apps: [] }))
    const appLinkList = vi.fn(async () => {
      if (options.holdAppListing) await appListingGate.promise
      return { links: appQueue.list() }
    })
    const gfsList = vi.fn(async () => {
      gfsListingStarted.resolve()
      if (options.holdGfsListing && options.holdGfsListingBeforeSnapshot) {
        await gfsListingGate.promise
      }
      const { links } = await main!.listPendingGfsDeepLinks()
      gfsListEventCounts.push(deliveredGfsEvents)
      if (options.holdGfsListing) await gfsListingGate.promise
      return { links }
    })
    const gfsAck = vi.fn(async (id: number, authority?: DeepLinkAcknowledgmentAuthority) =>
      main!.acknowledgeHeldResourceDeepLink(
        id,
        authority ?? {
          sessionGeneration: service.sessionGeneration,
          userNavigationGeneration: navigation.current(),
        }
      )
    )
    const gfsClear = vi.fn(async () => gfsQueue.clear())
    const gfsResolve = vi.fn(async (resourceUri: string) => {
      gfsResolveStacks.push(new Error('GFS resolve call site').stack ?? '')
      resourceReadIdentities.push(realController?.authenticatedPrincipalIdentity ?? null)
      resourceReadStarted.resolve()
      if (options.holdResourceResolution) await resourceReadGate.promise
      const resourceId = resourceUri.split('/').at(-1)!
      return resourceUri.endsWith('f'.repeat(32))
        ? resolvedDirectory(resourceId, 'Cold folder', { gfsUri: resourceUri })
        : resolvedFile(resourceId, 'Cold file.md', { gfsUri: resourceUri })
    })
    const onGfsLink = vi.fn((listener: (link: GfsResourceDeepLinkEnvelope) => void) =>
      main!.onGfsDeepLink(link => {
        deliveredGfsEvents += 1
        listener(link)
      })
    )
    const rendererBridge = {
      shortcuts: { onCommand: vi.fn(() => vi.fn()) },
      app: { rendererReady: vi.fn().mockResolvedValue(undefined) },
      sandboxUi: {
        ...main.bridge,
        listApps: appList,
        listPendingDeepLinks: appLinkList,
        clearPendingDeepLinks: vi.fn(async () => appQueue.clear()),
        acknowledgeDeepLink: vi.fn(async (id: number) => appQueue.acknowledge(id)),
        focusActive: vi.fn().mockResolvedValue(true),
        onDeepLink: vi.fn(() => vi.fn()),
      },
      gfs: {
        getUserNavigationGeneration: vi.fn(() => navigation.current()),
        advanceUserNavigationGeneration: vi.fn(() => navigation.advance()),
        acknowledgeDeepLink: gfsAck,
        clearPendingDeepLinks: gfsClear,
        listPendingDeepLinks: gfsList,
        onDeepLink: onGfsLink,
        resolve: gfsResolve,
        listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
        listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
        affordances: vi.fn(async () => ({
          held: [],
          canDelegate: false,
          grantableBits: [],
          canCreateShare: false,
        })),
      },
    }
    Object.defineProperty(window, 'clerum', { configurable: true, value: rendererBridge })
    const { handle } = installAppControllerClerum({
      delayAuthenticatedLoad: options.delayAuthenticatedLoad,
      teamDirectory: {
        items: [
          { team: { id: 'team-a', name: 'Team A' }, members: [] },
          { team: { id: 'team-b', name: 'Team B' }, members: [] },
        ],
        currentTeamId: 'team-a',
      },
      me: {
        id: userA.id,
        email: userA.email ?? 'a@example.test',
        name: userA.name ?? 'User A',
        teamId: userA.teamId ?? 'team-a',
        teamName: userA.teamName ?? 'Team A',
      },
    })
    const controllerBridge = window.clerum
    const sessionStarted = deferred<void>()
    const sessionGate = deferred<void>()
    let holdInitialSession = true
    handle.getSessionState.mockImplementation(async () => {
      if (holdInitialSession) {
        holdInitialSession = false
        sessionStarted.resolve()
        await sessionGate.promise
      }
      return service.getSessionState()
    })
    handle.getSessionGeneration.mockImplementation(async () => service.sessionGeneration)
    Object.assign(window.clerum, {
      shortcuts: rendererBridge.shortcuts,
      app: rendererBridge.app,
      sandboxUi: { ...(controllerBridge.sandboxUi ?? {}), ...rendererBridge.sandboxUi },
      gfs: { ...(controllerBridge.gfs ?? {}), ...rendererBridge.gfs },
    })

    const actual =
      await vi.importActual<typeof import('@hooks/useAppController')>('@hooks/useAppController')
    const beginTrace: Fixture['beginTrace'] = []
    const confirmedTrace: Fixture['confirmedTrace'] = []
    const activationTrace: Fixture['activationTrace'] = []
    const navTrace: Fixture['navTrace'] = []
    vi.mocked(useAppController).mockImplementation(() => {
      realController = actual.useAppController()
      const selectNav = realController.handleNavSelect
      realController.handleNavSelect = (...args) => {
        const intentBefore = realController?.navigationIntentSequence
        const result = selectNav(...args)
        navTrace.push({
          destination: args[0],
          intentBefore,
          intentAfter: realController?.navigationIntentSequence,
        })
        return result
      }
      const begin = realController.beginGfsResourceNavigation
      realController.beginGfsResourceNavigation = (...args) => {
        const request = begin(...args)
        beginTrace.push({
          id: args[0],
          intent: request?.intentSequence ?? -1,
          accepted: request !== null,
          sessionGeneration: realController?.sessionGeneration ?? null,
        })
        return request
      }
      const beginConfirmed = realController.beginConfirmedGfsResourceNavigation
      realController.beginConfirmedGfsResourceNavigation = (...args) => {
        const request = beginConfirmed(...args)
        if (request) confirmedTrace.push(request)
        return request
      }
      const activate = realController.activateGfsResourceNavigation
      realController.activateGfsResourceNavigation = (request, generation) => {
        const activated = activate(request, generation)
        activationTrace.push({
          id: request.id,
          generation,
          requestGeneration: request.principalGeneration,
          userNavigationGeneration: request.userNavigationGenerationAtActivation,
          intent: request.intentSequence,
          currentIntent: realController?.navigationIntentSequence,
          activated,
        })
        return activated
      }
      return realController
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const appTree = (
      <QueryClientProvider client={queryClient}>
        <AgentTaskTrackerProvider>
          <App />
        </AgentTaskTrackerProvider>
      </QueryClientProvider>
    )
    const view = render(options.strictMode ? <StrictMode>{appTree}</StrictMode> : appTree)
    unmount = view.unmount
    return {
      getController: () => {
        if (!realController) throw new Error('the actual App controller did not mount')
        return realController
      },
      handle,
      gfsList,
      gfsListEventCounts,
      gfsAck,
      gfsResolve,
      gfsResolveStacks,
      resourceReadIdentities,
      appList,
      appLinkList,
      beginTrace,
      confirmedTrace,
      activationTrace,
      navTrace,
      gfsClear,
      sessionStarted: sessionStarted.promise,
      releaseSession: () => sessionGate.resolve(),
      releaseAppListing: () => appListingGate.resolve(),
      releaseGfsListing: () => gfsListingGate.resolve(),
      gfsListingStarted: gfsListingStarted.promise,
      releaseResource: () => resourceReadGate.resolve(),
      resourceReadStarted: resourceReadStarted.promise,
      emitGfsLink: async link => {
        await main!.emitGfsDeepLink(link)
      },
      queryClient,
      gfsLink,
      gfsQueue,
      appQueue,
      navigation,
      main: main!,
      eventDeliveries: () => deliveredGfsEvents,
      dispose: async () => {
        unmount?.()
        unmount = null
        cleanup()
        if (main) await main.dispose()
        main = null
        realController = null
      },
    }
  }

  function destination(controller: AppController): string | null {
    const active = activeWorkspaceTab(controller.workspaceTabs)
    if (active?.kind === 'preview') return active.preview?.gfsUri ?? null
    if (active?.kind === 'files') return active.files?.path ?? null
    if (controller.navItem === DESKTOP_ROUTES.settings) return 'user-navigation'
    return null
  }

  async function observe(
    fixture: Fixture,
    link: GfsResourceDeepLinkEnvelope,
    promptId = link.id
  ): Promise<ProductionObservation> {
    const controller = fixture.getController()
    const ackResults = await Promise.all(
      fixture.gfsAck.mock.results.map(async (result, index) => ({
        id: fixture.gfsAck.mock.calls[index]?.[0] as number,
        result: (await result.value) as boolean,
      }))
    )
    return {
      visibleDestination: destination(fixture.getController()),
      visiblePromptIds: screen.queryByRole('dialog', { name: 'Open EvenDrive link?' })
        ? [promptId]
        : [],
      resourceReadCountById: new Map([
        [link.id, fixture.gfsResolveStacks.filter(stack => stack.includes('FilesPage')).length],
      ]),
      actualResolverEntriesById: new Map([[link.id, fixture.gfsResolveStacks.length]]),
      previewFetchesById: new Map([
        [
          link.id,
          fixture.gfsResolveStacks.filter(stack => stack.includes('useFilePreviewResourceActions'))
            .length,
        ],
      ]),
      wrongPrincipalContentObserved:
        (screen.queryAllByText('Cold file.md').length > 0 ||
          (screen.queryByRole('navigation', { name: 'File location' })?.textContent ?? '').includes(
            'Cold folder'
          )) &&
        (!controller.isAuthenticated ||
          !controller.authenticatedPrincipalIdentity ||
          fixture.resourceReadIdentities.at(-1) !== controller.authenticatedPrincipalIdentity),
      mainAckOutcomeById: new Map(
        ackResults.map(({ id, result }) => [id, result ? 'confirmed' : 'unconfirmed'])
      ),
      pendingOwnedWork: fixture.gfsQueue.list().map(item => `native:${item.id}`),
    }
  }

  it('runs scheduled producer, lifecycle, navigation, and outcome commands against the oracle', async () => {
    type CommandReal = {
      fixture: Fixture
      link: GfsResourceDeepLinkEnvelope
      scheduler: Scheduler
      listReleased: boolean
      sessionReleased: boolean
      opened: boolean
      userNavigatedAfterOpen: boolean
      dismissed: boolean
      invalidated: boolean
      resolved: boolean
      outcomeRecorded: boolean
      disposed: boolean
      coverage: Set<string>
    }
    const executedCommandKinds = new Set<string>()
    type CommandModel = Model & { driver: CommandReal }
    const recordMainAck = async (model: CommandModel, real: CommandReal) => {
      const index = real.fixture.gfsAck.mock.calls.findIndex(([id]) => id === real.link.id)
      if (index < 0) return
      const result = await real.fixture.gfsAck.mock.results[index]?.value
      transition(model, { kind: 'ack', id: real.link.id, applied: result === true })
      real.outcomeRecorded = true
      model.driver.outcomeRecorded = true
    }
    const deliverEvent: AsyncCommand<CommandModel, CommandReal> = {
      check: model =>
        !model.driver.disposed &&
        (!model.driver.sessionReleased || model.driver.listReleased) &&
        !model.driver.dismissed &&
        !model.driver.outcomeRecorded,
      async run(model, real) {
        const emit = real.scheduler.scheduleFunction(async () =>
          real.fixture.emitGfsLink(real.link)
        )
        const delivery = emit()
        await real.scheduler.waitAll()
        await delivery
        real.coverage.add('event')
        if (!real.invalidated)
          transition(model, { kind: 'receive', id: real.link.id, uri: real.link.uri })
        assertObservation(model, await observe(real.fixture, real.link))
      },
      toString: () => 'deliver the native event',
    }
    const releaseList: AsyncCommand<CommandModel, CommandReal> = {
      check: model => !model.driver.listReleased && !model.driver.disposed,
      async run(model, real) {
        const release = real.scheduler.scheduleFunction(async () =>
          real.fixture.releaseGfsListing()
        )
        const listing = release()
        await real.scheduler.waitAll()
        await listing
        real.listReleased = true
        model.driver.listReleased = true
        real.coverage.add('list')
        await act(async () => {
          for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
          await new Promise<void>(resolve => setImmediate(resolve))
        })
        if (!real.invalidated)
          transition(model, { kind: 'receive', id: real.link.id, uri: real.link.uri })
        assertObservation(model, await observe(real.fixture, real.link))
      },
      toString: () => 'release the actual initial listing',
    }
    const releaseBootAndAuth: AsyncCommand<CommandModel, CommandReal> = {
      check: model => !model.driver.sessionReleased && !model.driver.disposed,
      async run(model, real) {
        const publish = real.scheduler.scheduleFunction(async () => real.fixture.releaseSession())
        const session = publish()
        await real.scheduler.waitAll()
        await session
        real.sessionReleased = true
        model.driver.sessionReleased = true
        real.coverage.add('boot/auth')
        await waitFor(() => expect(real.fixture.getController().isAuthenticated).toBe(true))
        await waitFor(() => expect(real.fixture.getController().booting).toBe(false))
        await waitFor(() =>
          expect(real.fixture.getController().initialExperienceLoading).toBe(false)
        )
        transition(model, { kind: 'ready', principal: 'user-a:user-a@example.test' })
        assertObservation(model, await observe(real.fixture, real.link))
      },
      toString: () => 'publish authenticated boot readiness',
    }
    const rereadAuth: AsyncCommand<CommandModel, CommandReal> = {
      check: model => model.ready && !model.driver.invalidated && !model.driver.disposed,
      async run(model, real) {
        const refresh = real.scheduler.scheduleFunction(async () =>
          real.fixture.getController().loadSession()
        )
        const reading = refresh()
        await real.scheduler.waitAll()
        await reading
        real.coverage.add('auth')
        await waitFor(() => expect(real.fixture.getController().isAuthenticated).toBe(true))
        transition(model, { kind: 'ready', principal: 'user-a:user-a@example.test' })
        assertObservation(model, await observe(real.fixture, real.link))
      },
      toString: () => 'reread the authenticated session through the controller',
    }
    const navigate: AsyncCommand<CommandModel, CommandReal> = {
      check: model =>
        model.ready &&
        !model.driver.opened &&
        !model.driver.dismissed &&
        !model.driver.invalidated &&
        !model.driver.disposed,
      async run(model, real) {
        const select = real.scheduler.scheduleFunction(async () =>
          real.fixture.getController().handleNavSelect(DESKTOP_ROUTES.settings)
        )
        const navigation = select()
        await real.scheduler.waitAll()
        await navigation
        real.coverage.add('navigate')
        await waitFor(() =>
          expect(real.fixture.getController().navItem).toBe(DESKTOP_ROUTES.settings)
        )
        transition(model, { kind: 'navigate', destination: 'user-navigation' })
        assertObservation(model, await observe(real.fixture, real.link))
      },
      toString: () => 'navigate before Open',
    }
    const confirm: AsyncCommand<CommandModel, CommandReal> = {
      check: model =>
        model.ready &&
        !model.driver.opened &&
        !model.driver.dismissed &&
        !model.driver.invalidated &&
        model.receipts.get(model.driver.link.id)?.phase === 'waiting',
      async run(model, real) {
        const open = real.scheduler.scheduleFunction(async () =>
          fireEvent.click(screen.getByRole('button', { name: 'Open' }))
        )
        const opening = open()
        await real.scheduler.waitAll()
        await opening
        await real.fixture.resourceReadStarted
        real.opened = true
        model.driver.opened = true
        real.coverage.add('confirm')
        transition(model, { kind: 'confirm', id: real.link.id })
      },
      toString: () => 'Open the exact displayed request',
    }
    const navigateAfterOpen: AsyncCommand<CommandModel, CommandReal> = {
      check: model =>
        model.driver.opened &&
        !model.driver.userNavigatedAfterOpen &&
        !model.driver.invalidated &&
        !model.driver.resolved &&
        !model.driver.disposed,
      async run(model, real) {
        const select = real.scheduler.scheduleFunction(async () =>
          real.fixture.getController().handleNavSelect(DESKTOP_ROUTES.settings)
        )
        const navigation = select()
        await real.scheduler.waitAll()
        await navigation
        real.userNavigatedAfterOpen = true
        model.driver.userNavigatedAfterOpen = true
        real.coverage.add('navigate-after-open')
        await waitFor(() =>
          expect(real.fixture.getController().navItem).toBe(DESKTOP_ROUTES.settings)
        )
        transition(model, { kind: 'navigate', destination: 'user-navigation' })
        await waitFor(() => expect(real.fixture.gfsAck).toHaveBeenCalledWith(real.link.id))
        await recordMainAck(model, real)
        assertObservation(model, await observe(real.fixture, real.link))
      },
      toString: () => 'navigate after Open while the resource resolve is held',
    }
    const dismiss: AsyncCommand<CommandModel, CommandReal> = {
      check: model =>
        model.ready &&
        !model.driver.opened &&
        !model.driver.dismissed &&
        !model.driver.invalidated &&
        model.receipts.get(model.driver.link.id)?.phase === 'waiting',
      async run(model, real) {
        const close = real.scheduler.scheduleFunction(async () =>
          fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
        )
        const dismissing = close()
        await real.scheduler.waitAll()
        await dismissing
        real.coverage.add('dismiss')
        await waitFor(() => expect(real.fixture.gfsAck).toHaveBeenCalledWith(real.link.id))
        transition(model, { kind: 'dismiss', id: real.link.id })
        await recordMainAck(model, real)
        real.dismissed = true
        model.driver.dismissed = true
        assertObservation(model, await observe(real.fixture, real.link), true)
      },
      toString: () => 'Dismiss the exact displayed request',
    }
    const invalidate: AsyncCommand<CommandModel, CommandReal> = {
      check: model =>
        model.ready &&
        !model.driver.invalidated &&
        !model.driver.dismissed &&
        !model.driver.resolved &&
        !model.driver.disposed,
      async run(model, real) {
        const invalidateSession = real.scheduler.scheduleFunction(async () =>
          real.fixture.main.endSession(2)
        )
        const invalidation = invalidateSession()
        await real.scheduler.waitAll()
        await invalidation
        real.coverage.add('invalidate')
        await real.fixture.main.settle()
        const service = real.fixture.main.service as unknown as {
          sessionGeneration: number
          sessionToken: string | null
          me: typeof userA | null
        }
        service.sessionGeneration = 2
        service.sessionToken = null
        service.me = null
        real.fixture.handle.getSessionState.mockImplementation(async () => ({
          authenticated: false,
          me: null,
          sessionGeneration: 2,
        }))
        transition(model, { kind: 'invalidate', floor: real.link.id + 1 })
        await act(async () => real.fixture.getController().loadSession())
        await waitFor(() => expect(real.fixture.getController().isAuthenticated).toBe(false))
        await waitFor(() => expect(real.fixture.gfsQueue.list()).toEqual([]))
        await waitFor(() =>
          expect(screen.queryByTestId('sandbox-ui-session-revalidation-pending')).toBeNull()
        )
        transition(model, { kind: 'releaseBarrier', principal: null })
        real.invalidated = true
        model.driver.invalidated = true
        if (real.opened) {
          const release = real.scheduler.scheduleFunction(async () =>
            real.fixture.releaseResource()
          )
          const result = release()
          await real.scheduler.waitAll()
          await result
          await act(async () => {
            for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
            await new Promise<void>(resolve => setImmediate(resolve))
          })
          transition(model, { kind: 'resolve', id: real.link.id, result: 'file' })
          real.resolved = true
          model.driver.resolved = true
        }
        assertObservation(model, await observe(real.fixture, real.link))
      },
      toString: () => 'invalidate through the real main session boundary',
    }
    const resolveResource: AsyncCommand<CommandModel, CommandReal> = {
      check: model =>
        !model.driver.invalidated &&
        !model.driver.disposed &&
        model.receipts.get(model.driver.link.id)?.phase === 'resolving',
      async run(model, real) {
        const release = real.scheduler.scheduleFunction(async () => real.fixture.releaseResource())
        const resolving = release()
        await real.scheduler.waitAll()
        await resolving
        real.coverage.add('resolve')
        await waitFor(() =>
          expect(destination(real.fixture.getController())).toBe(
            real.userNavigatedAfterOpen ? 'user-navigation' : real.link.uri
          )
        )
        transition(model, { kind: 'resolve', id: real.link.id, result: 'file' })
        real.resolved = true
        model.driver.resolved = true
        assertObservation(model, await observe(real.fixture, real.link))
      },
      toString: () => 'resolve through Files and observe its destination',
    }
    const observeOutcome: AsyncCommand<CommandModel, CommandReal> = {
      check: model =>
        !model.driver.disposed &&
        !model.driver.invalidated &&
        model.driver.resolved &&
        !model.ack.has(model.driver.link.id),
      async run(model, real) {
        await waitFor(() => expect(real.fixture.gfsAck).toHaveBeenCalledWith(real.link.id))
        await recordMainAck(model, real)
        real.coverage.add('outcome')
        assertObservation(
          model,
          await observe(real.fixture, real.link),
          real.fixture.gfsQueue.list().length === 0
        )
      },
      toString: () => 'observe the main acknowledgment separately',
    }
    const cleanupCommand: AsyncCommand<CommandModel, CommandReal> = {
      check: model =>
        (model.driver.dismissed || model.driver.invalidated || model.driver.outcomeRecorded) &&
        model.driver.listReleased &&
        model.driver.sessionReleased &&
        (!model.driver.opened || model.driver.resolved || model.driver.invalidated) &&
        model.driver.fixture.gfsQueue.list().length === 0 &&
        !model.driver.disposed,
      async run(model, real) {
        assertObservation(model, await observe(real.fixture, real.link), true)
        const dispose = real.scheduler.scheduleFunction(async () => real.fixture.dispose())
        const cleaned = dispose()
        await real.scheduler.waitAll()
        await cleaned
        real.disposed = true
        model.driver.disposed = true
        real.coverage.add('cleanup')
      },
      toString: () => 'dispose the actual fixture after its owned work settles',
    }
    const generatedCommandSequence = fc.commands(
      [
        fc.constantFrom<AsyncCommand<CommandModel, CommandReal>>(
          deliverEvent,
          releaseList,
          releaseBootAndAuth,
          rereadAuth,
          navigate,
          confirm,
          dismiss,
          invalidate,
          navigateAfterOpen,
          resolveResource,
          observeOutcome,
          cleanupCommand
        ),
      ],
      { maxCommands: 20 }
    )
    // Keep the random prefix, then force the decisive scheduler path through
    // the same real command objects. This guarantees the generated oracle run
    // observes Open → user navigation while resolve is held → destination →
    // native acknowledgment, even when fast-check shrinks its random prefix.
    const commandSequence = generatedCommandSequence.map(commands => [
      ...commands,
      releaseBootAndAuth,
      releaseList,
      confirm,
      navigateAfterOpen,
      resolveResource,
      observeOutcome,
      cleanupCommand,
    ])

    await fc.assert(
      fc.asyncProperty(fc.scheduler(), commandSequence, async (scheduler, commands) => {
        const fixture = await mountWithHeldRealSession(
          'gfs://main/1991c54d6a374d358e2e10f0a086d00a',
          {
            holdGfsListing: true,
            holdGfsListingBeforeSnapshot: true,
            holdResourceResolution: true,
            scheduleGfsProduction: async (queue, navigation, uri) => {
              const produce = scheduler.scheduleFunction(async () =>
                produceGfsLink(queue, navigation, uri)
              )
              const link = produce()
              await scheduler.waitAll()
              return link
            },
          }
        )
        const link = fixture.gfsLink
        if (!link) throw new Error('the actual main queue did not produce the external envelope')
        const real: CommandReal = {
          fixture,
          link,
          scheduler,
          listReleased: false,
          sessionReleased: false,
          opened: false,
          userNavigatedAfterOpen: false,
          dismissed: false,
          invalidated: false,
          resolved: false,
          outcomeRecorded: false,
          disposed: false,
          coverage: executedCommandKinds,
        }
        const model = Object.assign(initialModel(), { driver: real })
        try {
          await fixture.sessionStarted
          await fixture.gfsListingStarted
          assertObservation(model, await observe(fixture, link))
          await fc.asyncModelRun(() => ({ model, real }), commands)
          if (!real.sessionReleased) {
            const publish = scheduler.scheduleFunction(async () => fixture.releaseSession())
            const session = publish()
            await scheduler.waitAll()
            await session
            real.sessionReleased = true
            model.driver.sessionReleased = true
            await waitFor(() => expect(fixture.getController().isAuthenticated).toBe(true))
            await waitFor(() => expect(fixture.getController().booting).toBe(false))
            await waitFor(() =>
              expect(fixture.getController().initialExperienceLoading).toBe(false)
            )
            transition(model, { kind: 'ready', principal: 'user-a:user-a@example.test' })
          }
          if (!real.listReleased) {
            const release = scheduler.scheduleFunction(async () => fixture.releaseGfsListing())
            const listing = release()
            await scheduler.waitAll()
            await listing
            real.listReleased = true
            model.driver.listReleased = true
            await act(async () => {
              for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
              await new Promise<void>(resolve => setImmediate(resolve))
            })
            if (!real.invalidated) {
              transition(model, { kind: 'receive', id: link.id, uri: link.uri })
            }
          }
          if (!real.disposed && real.opened && !real.resolved && !real.invalidated) {
            const release = scheduler.scheduleFunction(async () => fixture.releaseResource())
            const settled = release()
            await scheduler.waitAll()
            await settled
            await waitFor(() =>
              expect(destination(fixture.getController())).toBe(
                real.userNavigatedAfterOpen ? 'user-navigation' : link.uri
              )
            )
            transition(model, { kind: 'resolve', id: link.id, result: 'file' })
            real.resolved = true
            model.driver.resolved = true
            if (!model.ack.has(link.id)) {
              await waitFor(() => expect(fixture.gfsAck).toHaveBeenCalledWith(link.id))
              await recordMainAck(model, real)
            }
          }
          if (!real.disposed) {
            assertObservation(
              model,
              await observe(fixture, link),
              (real.dismissed || real.invalidated || real.outcomeRecorded) &&
                fixture.gfsQueue.list().length === 0
            )
          }
        } finally {
          if (!real.disposed) await fixture.dispose()
        }
      }),
      { numRuns: 500, seed: 1101502, endOnFailure: true }
    )
    expect([...executedCommandKinds].sort()).toEqual([
      'auth',
      'boot/auth',
      'cleanup',
      'confirm',
      'dismiss',
      'event',
      'invalidate',
      'list',
      'navigate',
      'navigate-after-open',
      'outcome',
      'resolve',
    ])
  })

  it.each(['event-before-list', 'list-before-event'] as const)(
    'coalesces the real GFS event/list overlap when $0 arrives',
    async order => {
      const uri = `gfs://main/${'f'.repeat(32)}`
      const fixture = await mountWithHeldRealSession(uri, {
        holdGfsListing: true,
        holdGfsListingBeforeSnapshot: order === 'event-before-list',
        holdResourceResolution: true,
      })
      const link = fixture.gfsLink
      if (!link) throw new Error('the native queue did not produce the folder envelope')
      const model = initialModel()
      transition(model, { kind: 'receive', id: link.id, uri })

      await fixture.sessionStarted
      await fixture.gfsListingStarted
      if (order === 'event-before-list') {
        await fixture.emitGfsLink(link)
        await fixture.main.settle()
        transition(model, { kind: 'receive', id: link.id, uri })
        fixture.releaseGfsListing()
        await Promise.all(
          fixture.gfsList.mock.results.map(
            result => result.value as Promise<{ links: GfsResourceDeepLinkEnvelope[] }>
          )
        )
      } else {
        fixture.releaseGfsListing()
        await act(async () => {
          for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
          await new Promise<void>(resolve => setImmediate(resolve))
        })
        await fixture.emitGfsLink(link)
        await fixture.main.settle()
        transition(model, { kind: 'receive', id: link.id, uri })
      }
      await act(async () => {
        for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
      })
      expect(fixture.eventDeliveries()).toBe(1)
      expect(fixture.gfsListEventCounts).toContain(order === 'event-before-list' ? 1 : 0)
      expect(fixture.gfsQueue.list()).toEqual([link])
      expect(fixture.gfsResolve).not.toHaveBeenCalled()
      expect(fixture.gfsAck).not.toHaveBeenCalled()

      fixture.releaseSession()
      await waitFor(() => expect(fixture.getController().isAuthenticated).toBe(true))
      await waitFor(() => expect(fixture.getController().booting).toBe(false))
      await waitFor(() => expect(fixture.getController().initialExperienceLoading).toBe(false))
      await waitFor(() =>
        expect(screen.getByRole('dialog', { name: 'Open EvenDrive link?' })).toBeTruthy()
      )
      transition(model, { kind: 'ready', principal: 'user-a:user-a@example.test' })
      assertObservation(model, await observe(fixture, link))

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Open' }))
        fireEvent.click(screen.getByRole('button', { name: 'Open' }))
      })
      await fixture.resourceReadStarted
      expect(fixture.confirmedTrace).toHaveLength(1)
      expect(fixture.gfsQueue.list()).toEqual([link])
      transition(model, { kind: 'confirm', id: link.id })
      assertObservation(model, await observe(fixture, link))

      fixture.releaseResource()
      await waitFor(() => expect(destination(fixture.getController())).toBe(uri))
      expect(activeWorkspaceTab(fixture.getController().workspaceTabs)).toMatchObject({
        kind: 'files',
        files: { path: uri },
      })
      expect(screen.getByRole('navigation', { name: 'File location' }).textContent).toContain(
        'Cold folder'
      )
      transition(model, { kind: 'resolve', id: link.id, result: 'folder' })
      await waitFor(() => expect(fixture.gfsAck).toHaveBeenCalledWith(link.id))
      const ackResult = await fixture.gfsAck.mock.results.at(-1)?.value
      transition(model, { kind: 'ack', id: link.id, applied: ackResult === true })
      expect(fixture.gfsQueue.list()).toEqual([])
      assertObservation(model, await observe(fixture, link), true)
    }
  )

  it('keeps raw intake through user navigation, then opens with a fresh confirmed action', async () => {
    const uri = 'gfs://main/1991c54d6a374d358e2e10f0a086d00a'
    const fixture = await mountWithHeldRealSession(uri, { holdResourceResolution: true })
    const link = fixture.gfsLink
    if (!link) throw new Error('the native queue did not produce the file envelope')
    const model = initialModel()
    transition(model, { kind: 'receive', id: link.id, uri })

    await fixture.sessionStarted
    await fixture.gfsListingStarted
    fixture.releaseSession()
    await waitFor(() => expect(fixture.getController().isAuthenticated).toBe(true))
    await waitFor(() => expect(fixture.getController().booting).toBe(false))
    await waitFor(() => expect(fixture.getController().initialExperienceLoading).toBe(false))
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Open EvenDrive link?' })).toBeTruthy()
    )
    transition(model, { kind: 'ready', principal: 'user-a:user-a@example.test' })

    fixture.getController().handleNavSelect(DESKTOP_ROUTES.settings)
    await waitFor(() => expect(fixture.getController().navItem).toBe(DESKTOP_ROUTES.settings))
    transition(model, { kind: 'navigate', destination: 'user-navigation' })
    assertObservation(model, await observe(fixture, link))
    expect(fixture.gfsResolve).not.toHaveBeenCalled()
    expect(fixture.gfsQueue.list()).toEqual([link])

    const userNavigationGenerationBeforeOpen = fixture.navigation.current()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    transition(model, { kind: 'confirm', id: link.id })
    fixture.releaseResource()
    await waitFor(() => expect(destination(fixture.getController())).toBe(uri))
    expect(fixture.confirmedTrace).toHaveLength(1)
    const confirmedRequest = fixture.confirmedTrace[0]
    if (!confirmedRequest) throw new Error('Open did not create its navigation request')
    expect(confirmedRequest.userNavigationGenerationAtActivation).toBeGreaterThan(
      userNavigationGenerationBeforeOpen
    )
    expect(confirmedRequest.userNavigationGenerationAtActivation).toBe(fixture.navigation.current())

    expect(activeWorkspaceTab(fixture.getController().workspaceTabs)).toMatchObject({
      kind: 'preview',
      preview: { gfsUri: uri },
    })
    transition(model, { kind: 'resolve', id: link.id, result: 'file' })
    await waitFor(() => expect(fixture.gfsAck).toHaveBeenCalledWith(link.id))
    const ackResult = await fixture.gfsAck.mock.results.at(-1)?.value
    transition(model, { kind: 'ack', id: link.id, applied: ackResult === true })
    assertObservation(model, await observe(fixture, link), true)
  })

  it('does not let a later settings navigation be stolen by an in-flight GFS resolve', async () => {
    const uri = 'gfs://main/1991c54d6a374d358e2e10f0a086d00a'
    const scheduler = fc.schedulerFor([1, 2])
    const fixture = await mountWithHeldRealSession(uri, { holdResourceResolution: true })
    const link = fixture.gfsLink
    if (!link) throw new Error('the native queue did not produce the file envelope')
    const model = initialModel()
    transition(model, { kind: 'receive', id: link.id, uri })

    await fixture.sessionStarted
    await fixture.gfsListingStarted
    fixture.releaseSession()
    await waitFor(() => expect(fixture.getController().isAuthenticated).toBe(true))
    await waitFor(() => expect(fixture.getController().booting).toBe(false))
    await waitFor(() => expect(fixture.getController().initialExperienceLoading).toBe(false))
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Open EvenDrive link?' })).toBeTruthy()
    )
    transition(model, { kind: 'ready', principal: 'user-a:user-a@example.test' })
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await fixture.resourceReadStarted
    transition(model, { kind: 'confirm', id: link.id })

    const selectSettings = scheduler.scheduleFunction(async () =>
      fixture.getController().handleNavSelect(DESKTOP_ROUTES.settings)
    )()
    await act(async () => scheduler.waitFor(selectSettings))
    await waitFor(() => expect(fixture.getController().navItem).toBe(DESKTOP_ROUTES.settings))
    transition(model, { kind: 'navigate', destination: 'user-navigation' })
    await waitFor(() => expect(fixture.gfsQueue.list()).toEqual([]))
    const ackResult = await fixture.gfsAck.mock.results.at(-1)?.value
    transition(model, { kind: 'ack', id: link.id, applied: ackResult === true })

    const release = scheduler.scheduleFunction(async () => fixture.releaseResource())()
    await act(async () => scheduler.waitFor(release))
    await act(async () => {
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
      await new Promise<void>(resolve => setImmediate(resolve))
    })
    expect(destination(fixture.getController())).toBe('user-navigation')
    expect(activeWorkspaceTab(fixture.getController().workspaceTabs)?.kind).not.toBe('preview')
    transition(model, { kind: 'resolve', id: link.id, result: 'file' })
    assertObservation(model, await observe(fixture, link), true)
  })

  it('keeps a resolved GFS destination superseded by later user navigation', async () => {
    const uri = 'gfs://main/1991c54d6a374d358e2e10f0a086d00a'
    const scheduler = fc.schedulerFor([1, 2])
    const fixture = await mountWithHeldRealSession(uri, { holdResourceResolution: true })
    const link = fixture.gfsLink
    if (!link) throw new Error('the native queue did not produce the file envelope')
    const model = initialModel()
    transition(model, { kind: 'receive', id: link.id, uri })

    await fixture.sessionStarted
    await fixture.gfsListingStarted
    fixture.releaseSession()
    await waitFor(() => expect(fixture.getController().isAuthenticated).toBe(true))
    await waitFor(() => expect(fixture.getController().booting).toBe(false))
    await waitFor(() => expect(fixture.getController().initialExperienceLoading).toBe(false))
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Open EvenDrive link?' })).toBeTruthy()
    )
    transition(model, { kind: 'ready', principal: 'user-a:user-a@example.test' })

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await fixture.resourceReadStarted
    transition(model, { kind: 'confirm', id: link.id })
    const release = scheduler.scheduleFunction(async () => fixture.releaseResource())
    const resolving = release()
    await scheduler.waitAll()
    await resolving
    await waitFor(() => expect(destination(fixture.getController())).toBe(uri))
    transition(model, { kind: 'resolve', id: link.id, result: 'file' })

    const select = scheduler.scheduleFunction(async () =>
      fixture.getController().handleNavSelect(DESKTOP_ROUTES.settings)
    )
    const navigation = select()
    await scheduler.waitAll()
    await navigation
    await waitFor(() => expect(fixture.getController().navItem).toBe(DESKTOP_ROUTES.settings))
    transition(model, { kind: 'navigate', destination: 'user-navigation' })
    expect(destination(fixture.getController())).toBe('user-navigation')

    await waitFor(() => expect(fixture.gfsAck).toHaveBeenCalledWith(link.id))
    const ackResult = await fixture.gfsAck.mock.results.at(-1)?.value
    transition(model, { kind: 'ack', id: link.id, applied: ackResult === true })
    assertObservation(model, await observe(fixture, link), ackResult === true)
  })

  it('records destination success separately from a rejected native acknowledgment', async () => {
    const uri = 'gfs://main/1991c54d6a374d358e2e10f0a086d00a'
    const fixture = await mountWithHeldRealSession(uri, { holdResourceResolution: true })
    const link = fixture.gfsLink
    if (!link) throw new Error('the real native queue did not produce the file envelope')
    const model = initialModel()
    transition(model, { kind: 'receive', id: link.id, uri })

    await fixture.sessionStarted
    await fixture.gfsListingStarted
    fixture.releaseSession()
    await waitFor(() => expect(fixture.getController().isAuthenticated).toBe(true))
    await waitFor(() => expect(fixture.getController().booting).toBe(false))
    await waitFor(() => expect(fixture.getController().initialExperienceLoading).toBe(false))
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Open EvenDrive link?' })).toBeTruthy()
    )
    transition(model, { kind: 'ready', principal: 'user-a:user-a@example.test' })
    fixture.gfsAck.mockImplementation(async () => false)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await fixture.resourceReadStarted
    transition(model, { kind: 'confirm', id: link.id })

    fixture.releaseResource()
    await waitFor(() => expect(destination(fixture.getController())).toBe(uri))
    expect(screen.getAllByText('Cold file.md').length).toBeGreaterThan(0)
    transition(model, { kind: 'resolve', id: link.id, result: 'file' })
    await waitFor(() => expect(fixture.gfsAck).toHaveBeenCalledWith(link.id))
    const ackResult = await fixture.gfsAck.mock.results.at(-1)?.value
    expect(ackResult).toBe(false)
    transition(model, { kind: 'ack', id: link.id, applied: false })

    expect(screen.queryByRole('dialog', { name: 'Open EvenDrive link?' })).toBeNull()
    expect(fixture.gfsQueue.list()).toEqual([link])
    assertObservation(model, await observe(fixture, link))
  })

  it('keeps a delayed older acknowledgment scoped to its exact ID after a later Open', async () => {
    const uriA = 'gfs://main/11111111111111111111111111111111'
    const uriB = 'gfs://main/22222222222222222222222222222222'
    const fixture = await mountWithHeldRealSession(uriA)
    const linkA = fixture.gfsLink
    if (!linkA) throw new Error('the actual native queue did not produce the first link')
    const service = fixture.main.service as unknown as { sessionGeneration: number }
    const mainAcknowledge = deferred<void>()
    const firstAckStarted = deferred<void>()
    const originalAck = fixture.gfsAck.getMockImplementation() as
      | ((id: number, authority?: DeepLinkAcknowledgmentAuthority) => Promise<boolean>)
      | undefined
    if (!originalAck) throw new Error('the registered main acknowledgment bridge is missing')
    fixture.gfsAck.mockImplementation(async (id, authority) => {
      const capturedAuthority = authority ?? {
        sessionGeneration: service.sessionGeneration,
        userNavigationGeneration: fixture.navigation.current(),
      }
      if (id === linkA.id) {
        firstAckStarted.resolve()
        await mainAcknowledge.promise
      }
      return originalAck(id, capturedAuthority)
    })

    await fixture.sessionStarted
    await fixture.gfsListingStarted
    fixture.releaseSession()
    await waitFor(() => expect(fixture.getController().isAuthenticated).toBe(true))
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Open EvenDrive link?' })).toBeTruthy()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(fixture.gfsResolve).toHaveBeenCalledWith(uriA))
    await waitFor(() => expect(destination(fixture.getController())).toBe(uriA))
    await firstAckStarted.promise
    expect(fixture.gfsQueue.list()).toEqual([linkA])
    const firstAckPromise = fixture.gfsAck.mock.results[0]?.value as Promise<boolean>

    const linkB = produceGfsLink(fixture.gfsQueue, fixture.navigation, uriB)
    fixture.emitGfsLink(linkB)
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Open EvenDrive link?' })).toBeTruthy()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(fixture.gfsResolve).toHaveBeenCalledWith(uriB))
    await waitFor(() => expect(destination(fixture.getController())).toBe(uriB))
    const secondAckIndex = fixture.gfsAck.mock.calls.findIndex(([id]) => id === linkB.id)
    expect(secondAckIndex).toBeGreaterThanOrEqual(0)
    const secondAckPromise = fixture.gfsAck.mock.results[secondAckIndex]?.value as Promise<boolean>
    await expect(secondAckPromise).resolves.toBe(true)
    expect(fixture.gfsQueue.list()).toEqual([linkA])

    const scheduler = fc.schedulerFor([1])
    const releaseOldAck = scheduler.scheduleFunction(async () => mainAcknowledge.resolve())()
    await scheduler.waitFor(releaseOldAck)
    await expect(firstAckPromise).resolves.toBe(false)
    expect(fixture.gfsQueue.list()).toEqual([linkA])
    expect(destination(fixture.getController())).toBe(uriB)
    expect(activeWorkspaceTab(fixture.getController().workspaceTabs)).toMatchObject({
      kind: 'preview',
      preview: { gfsUri: uriB },
    })
    expect(screen.getByRole('heading', { name: 'Cold file.md' })).toBeTruthy()
    expect(fixture.gfsAck.mock.calls.map(([id]) => id)).toEqual([linkA.id, linkB.id])
  })

  it.each([
    {
      status: 403,
      code: 'forbidden',
      expected: 'You do not have permission to open this resource.',
    },
    { status: 404, code: 'not_found', expected: 'This resource could not be found.' },
  ])(
    'preserves the existing $status GFS denial behavior after explicit Open',
    async ({ status, code, expected }) => {
      const uri = 'gfs://main/1991c54d6a374d358e2e10f0a086d00a'
      const deniedMessage = await resolveDeniedMessage(
        uri,
        { code, message: 'not authorized to read this resource' },
        status
      )
      const fixture = await mountWithHeldRealSession(uri)
      const link = fixture.gfsLink
      if (!link) throw new Error('the native queue did not produce the denied file envelope')
      fixture.gfsResolve.mockImplementationOnce(async () => {
        throw new Error(deniedMessage)
      })

      await fixture.sessionStarted
      await fixture.gfsListingStarted
      fixture.releaseSession()
      await waitFor(() => expect(fixture.getController().isAuthenticated).toBe(true))
      await waitFor(() => expect(fixture.getController().booting).toBe(false))
      await waitFor(() => expect(fixture.getController().initialExperienceLoading).toBe(false))
      await waitFor(() =>
        expect(screen.getByRole('dialog', { name: 'Open EvenDrive link?' })).toBeTruthy()
      )
      expect(fixture.gfsResolve).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: 'Open' }))
      expect(await screen.findByText(expected)).toBeTruthy()
      expect(fixture.gfsResolve).toHaveBeenCalledTimes(1)
      expect(destination(fixture.getController())).not.toBe(uri)
      expect(activeWorkspaceTab(fixture.getController().workspaceTabs)?.kind).not.toBe('preview')
      expect(screen.queryByText('Cold file.md')).toBeNull()
      await waitFor(() => expect(fixture.gfsAck).toHaveBeenCalledWith(link.id))
      await waitFor(() => expect(fixture.gfsQueue.list()).toEqual([]))
    }
  )

  it('retains a transient GFS failure for the existing explicit retry action', async () => {
    const uri = 'gfs://main/1991c54d6a374d358e2e10f0a086d00a'
    const transientMessage = await resolveDeniedMessage(
      uri,
      { code: 'upstream_unavailable', message: 'try again later' },
      503
    )
    const fixture = await mountWithHeldRealSession(uri)
    const link = fixture.gfsLink
    if (!link) throw new Error('the native queue did not produce the transient file envelope')
    fixture.gfsResolve.mockImplementationOnce(async () => {
      throw new Error(transientMessage)
    })

    await fixture.sessionStarted
    await fixture.gfsListingStarted
    fixture.releaseSession()
    await waitFor(() => expect(fixture.getController().isAuthenticated).toBe(true))
    await waitFor(() => expect(fixture.getController().booting).toBe(false))
    await waitFor(() => expect(fixture.getController().initialExperienceLoading).toBe(false))
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Open EvenDrive link?' })).toBeTruthy()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))

    const retry = await screen.findByRole('button', { name: 'Retry opening link' })
    expect(fixture.gfsResolve).toHaveBeenCalledTimes(1)
    expect(fixture.gfsQueue.list()).toEqual([link])
    expect(destination(fixture.getController())).not.toBe(uri)
    fireEvent.click(retry)

    await waitFor(() => expect(destination(fixture.getController())).toBe(uri))
    expect(fixture.gfsResolve).toHaveBeenCalledTimes(2)
    expect(screen.getAllByText('Cold file.md').length).toBeGreaterThan(0)
    await waitFor(() => expect(fixture.gfsAck).toHaveBeenCalledWith(link.id))
    await waitFor(() => expect(fixture.gfsQueue.list()).toEqual([]))
  })

  it('keeps a later request queued while the first request is retryable', async () => {
    const uriA = 'gfs://main/11111111111111111111111111111111'
    const uriB = 'gfs://main/22222222222222222222222222222222'
    const transientMessage = await resolveDeniedMessage(
      uriA,
      { code: 'upstream_unavailable', message: 'try again later' },
      503
    )
    const fixture = await mountWithHeldRealSession(uriA)
    const linkA = fixture.gfsLink
    if (!linkA) throw new Error('the native queue did not produce the retryable envelope')
    fixture.gfsResolve.mockImplementationOnce(async () => {
      throw new Error(transientMessage)
    })

    await fixture.sessionStarted
    await fixture.gfsListingStarted
    fixture.releaseSession()
    await waitFor(() => expect(fixture.getController().isAuthenticated).toBe(true))
    await waitFor(() => expect(fixture.getController().booting).toBe(false))
    await waitFor(() => expect(fixture.getController().initialExperienceLoading).toBe(false))
    await screen.findByRole('dialog', { name: 'Open EvenDrive link?' })
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    const retry = await screen.findByRole('button', { name: 'Retry opening link' })
    expect(fixture.gfsResolve.mock.calls.map(([uri]) => uri)).toEqual([uriA])

    const linkB = produceGfsLink(fixture.gfsQueue, fixture.navigation, uriB)
    await fixture.emitGfsLink(linkB)
    await act(async () => {
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    })
    expect(fixture.gfsQueue.list()).toEqual([linkA, linkB])
    expect(screen.queryByRole('dialog', { name: 'Open EvenDrive link?' })).toBeNull()
    expect(fixture.gfsResolve.mock.calls.map(([uri]) => uri)).toEqual([uriA])
    expect(fixture.gfsAck).not.toHaveBeenCalled()

    fireEvent.click(retry)
    await waitFor(() => expect(destination(fixture.getController())).toBe(uriA))
    await waitFor(() => expect(fixture.gfsAck).toHaveBeenCalledWith(linkA.id))
    await screen.findByRole('dialog', { name: 'Open EvenDrive link?' })
    expect(fixture.gfsQueue.list()).toEqual([linkB])
    expect(fixture.gfsAck).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(destination(fixture.getController())).toBe(uriB))
    await waitFor(() => expect(fixture.gfsAck).toHaveBeenCalledWith(linkB.id))
    await waitFor(() => expect(fixture.gfsQueue.list()).toEqual([]))
    expect(fixture.gfsResolve.mock.calls.map(([uri]) => uri)).toContain(uriB)
  })

  it('dismisses only its exact activation and still accepts a new ID for the same URI', async () => {
    const uri = 'gfs://main/1991c54d6a374d358e2e10f0a086d00a'
    const fixture = await mountWithHeldRealSession(uri, { holdResourceResolution: true })
    const dismissedLink = fixture.gfsLink
    if (!dismissedLink) throw new Error('the native queue did not produce the first envelope')
    const model = initialModel()
    transition(model, { kind: 'receive', id: dismissedLink.id, uri })

    await fixture.sessionStarted
    await fixture.gfsListingStarted
    fixture.releaseSession()
    await waitFor(() => expect(fixture.getController().isAuthenticated).toBe(true))
    await waitFor(() => expect(fixture.getController().booting).toBe(false))
    await waitFor(() => expect(fixture.getController().initialExperienceLoading).toBe(false))
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Open EvenDrive link?' })).toBeTruthy()
    )
    transition(model, { kind: 'ready', principal: 'user-a:user-a@example.test' })
    const dismissedOpen = dialogHarness.props?.onConfirm
    if (!dismissedOpen) throw new Error('the first request did not expose its Open action')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(fixture.gfsAck).toHaveBeenCalledWith(dismissedLink.id))
    const dismissedAck = await fixture.gfsAck.mock.results.at(-1)?.value
    transition(model, { kind: 'dismiss', id: dismissedLink.id })
    transition(model, { kind: 'ack', id: dismissedLink.id, applied: dismissedAck === true })
    await waitFor(() => expect(fixture.gfsQueue.list()).toEqual([]))
    expect(fixture.gfsResolve).not.toHaveBeenCalled()
    expect(fixture.confirmedTrace).toEqual([])
    expect(destination(fixture.getController())).toBeNull()

    fixture.emitGfsLink(dismissedLink)
    await act(async () => {
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    })
    transition(model, { kind: 'receive', id: dismissedLink.id, uri })
    expect(fixture.gfsAck).toHaveBeenCalledTimes(1)
    assertObservation(model, await observe(fixture, dismissedLink), true)

    const reopenedLink = produceGfsLink(fixture.gfsQueue, fixture.navigation, uri)
    expect(reopenedLink.id).not.toBe(dismissedLink.id)
    fixture.emitGfsLink(reopenedLink)
    transition(model, { kind: 'receive', id: reopenedLink.id, uri })
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Open EvenDrive link?' })).toBeTruthy()
    )
    const secondPromptObservation = await observe(fixture, reopenedLink, reopenedLink.id)
    assertObservation(model, secondPromptObservation)
    await act(async () => {
      dismissedOpen()
      await Promise.resolve()
    })
    expect(fixture.confirmedTrace).toEqual([])
    expect(fixture.gfsResolve).not.toHaveBeenCalled()
    expect(fixture.gfsAck).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog', { name: 'Open EvenDrive link?' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await fixture.resourceReadStarted
    expect(fixture.confirmedTrace).toHaveLength(1)
    expect(fixture.confirmedTrace[0]).toMatchObject({ id: reopenedLink.id, uri })
    transition(model, { kind: 'confirm', id: reopenedLink.id })
    fixture.releaseResource()
    await waitFor(() => expect(destination(fixture.getController())).toBe(uri))
    transition(model, { kind: 'resolve', id: reopenedLink.id, result: 'file' })
    await waitFor(() => expect(fixture.gfsAck).toHaveBeenCalledWith(reopenedLink.id))
    const reopenedAck = await fixture.gfsAck.mock.results.at(-1)?.value
    transition(model, { kind: 'ack', id: reopenedLink.id, applied: reopenedAck === true })
    await waitFor(() => expect(fixture.gfsQueue.list()).toEqual([]))
    assertObservation(model, await observe(fixture, reopenedLink), true)
  })

  it('clears an A activation across a real A-to-B session boundary and accepts a new B ID', async () => {
    const uri = 'gfs://main/1991c54d6a374d358e2e10f0a086d00a'
    const fixture = await mountWithHeldRealSession(uri)
    const oldLink = fixture.gfsLink
    if (!oldLink) throw new Error('the native queue did not produce the pre-clear envelope')
    const model = initialModel()
    transition(model, { kind: 'receive', id: oldLink.id, uri })

    await fixture.sessionStarted
    await fixture.gfsListingStarted
    fixture.releaseSession()
    await waitFor(() => expect(fixture.getController().isAuthenticated).toBe(true))
    await waitFor(() => expect(fixture.getController().booting).toBe(false))
    await waitFor(() => expect(fixture.getController().initialExperienceLoading).toBe(false))
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Open EvenDrive link?' })).toBeTruthy()
    )
    transition(model, { kind: 'ready', principal: 'user-a:user-a@example.test' })
    const staleOpen = dialogHarness.props?.onConfirm
    if (!staleOpen) throw new Error('the raw request did not produce its Open action')

    const userB: typeof userA = {
      ...userA,
      id: 'user-b',
      email: 'user-b@example.test',
      name: 'User B',
      teamId: 'team-b',
      teamName: 'Team B',
    }
    const service = fixture.main.service as unknown as {
      authClient: {
        passwordLogin: (
          email: string,
          password: string
        ) => Promise<{
          token: string
          me: typeof userA
        }>
      }
      passwordLogin: (
        email: string,
        password: string
      ) => Promise<{
        authenticated: boolean
        me: typeof userA | null
        sessionGeneration: number
      }>
      getSessionState: () => Promise<{
        authenticated: boolean
        me: typeof userA | null
        sessionGeneration: number
      }>
    }
    const passwordLogin = vi.fn().mockResolvedValue({ token: 'test-token-session-b', me: userB })
    service.authClient.passwordLogin = passwordLogin
    let replacementSession: Awaited<ReturnType<typeof service.passwordLogin>> | null = null
    await act(async () => {
      replacementSession = await service.passwordLogin('user-b@example.test', 'test-password')
    })
    expect(passwordLogin).toHaveBeenCalledWith('user-b@example.test', 'test-password')
    expect(replacementSession).toMatchObject({
      authenticated: true,
      me: { id: 'user-b', email: 'user-b@example.test' },
    })
    await fixture.main.settle()
    await act(async () => {
      await fixture.getController().loadSession()
    })
    await waitFor(() => expect(fixture.getController().isAuthenticated).toBe(true))
    await waitFor(() =>
      expect(fixture.getController().authenticatedPrincipalIdentity).toBe(
        'user-b:user-b@example.test'
      )
    )
    await waitFor(() => expect(fixture.gfsQueue.list()).toEqual([]))
    await waitFor(() =>
      expect(screen.queryByTestId('sandbox-ui-session-revalidation-pending')).toBeNull()
    )
    transition(model, { kind: 'invalidate', floor: oldLink.id + 1 })
    transition(model, { kind: 'releaseBarrier', principal: 'user-b:user-b@example.test' })
    await act(async () => {
      staleOpen()
      await Promise.resolve()
    })
    expect(fixture.gfsResolve).not.toHaveBeenCalled()
    expect(fixture.gfsAck).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Open EvenDrive link?' })).toBeNull()
    assertObservation(model, await observe(fixture, oldLink))

    const replacementLink = produceGfsLink(fixture.gfsQueue, fixture.navigation, uri)
    expect(replacementLink.id).toBeGreaterThan(oldLink.id)
    fixture.emitGfsLink(replacementLink)
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Open EvenDrive link?' })).toBeTruthy()
    )
    transition(model, { kind: 'receive', id: replacementLink.id, uri })
    await act(async () => {
      staleOpen()
      await Promise.resolve()
    })
    expect(fixture.confirmedTrace).toEqual([])
    expect(fixture.gfsResolve).not.toHaveBeenCalled()
    assertObservation(model, await observe(fixture, replacementLink), false)

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await fixture.resourceReadStarted
    expect(fixture.resourceReadIdentities.at(-1)).toBe('user-b:user-b@example.test')
    transition(model, { kind: 'confirm', id: replacementLink.id })
    fixture.releaseResource()
    await waitFor(() => expect(destination(fixture.getController())).toBe(uri))
    transition(model, { kind: 'resolve', id: replacementLink.id, result: 'file' })
    await waitFor(() => expect(fixture.gfsAck).toHaveBeenCalledWith(replacementLink.id))
    const ackResult = await fixture.gfsAck.mock.results.at(-1)?.value
    transition(model, { kind: 'ack', id: replacementLink.id, applied: ackResult === true })
    await waitFor(() => expect(fixture.gfsQueue.list()).toEqual([]))
    assertObservation(model, await observe(fixture, replacementLink), true)
  })

  it('keeps a signed-out native receipt unprompted until an authenticated session is ready', async () => {
    const fixture = await mountWithHeldRealSession(null)
    await fixture.sessionStarted
    fixture.releaseSession()
    await waitFor(() => expect(fixture.getController().isAuthenticated).toBe(true))
    await waitFor(() => expect(fixture.getController().booting).toBe(false))

    const service = fixture.main.service as unknown as {
      logout: () => Promise<number>
      updateDesktopGfsUploadState: () => Promise<void>
    }
    // Keep this renderer test away from the unrelated persisted upload-state
    // store while exercising the actual AppService logout/session writer.
    vi.spyOn(service, 'updateDesktopGfsUploadState').mockResolvedValue(undefined)
    await act(async () => {
      await service.logout()
    })
    await fixture.main.settle()
    await act(async () => {
      await fixture.getController().loadSession()
    })
    await waitFor(() => expect(fixture.getController().isAuthenticated).toBe(false))
    await waitFor(() =>
      expect(screen.queryByTestId('sandbox-ui-session-revalidation-pending')).toBeNull()
    )

    const uri = 'gfs://main/1991c54d6a374d358e2e10f0a086d00a'
    const link = produceGfsLink(fixture.gfsQueue, fixture.navigation, uri)
    fixture.emitGfsLink(link)
    await waitFor(() => expect(fixture.gfsQueue.list()).toEqual([link]))
    expect(fixture.getController().authenticatedPrincipalIdentity).toBeNull()
    expect(screen.queryByRole('dialog', { name: 'Open EvenDrive link?' })).toBeNull()
    expect(fixture.gfsResolve).not.toHaveBeenCalled()
    expect(fixture.gfsAck).not.toHaveBeenCalled()
  })

  it('waits for authenticated workspace readiness before showing the native GFS confirmation', async () => {
    const uri = 'gfs://main/1991c54d6a374d358e2e10f0a086d00a'
    const fixture = await mountWithHeldRealSession(uri, { delayAuthenticatedLoad: true })
    const link = fixture.gfsLink
    if (!link) throw new Error('the main queue did not produce the readiness envelope')
    await fixture.sessionStarted
    await fixture.gfsListingStarted
    fixture.releaseSession()
    await waitFor(() => expect(fixture.getController().isAuthenticated).toBe(true))
    await waitFor(() => expect(fixture.getController().initialExperienceLoading).toBe(true))
    await waitFor(() => expect(fixture.gfsList).toHaveBeenCalled())

    expect(fixture.gfsQueue.list()).toEqual([link])
    expect(screen.queryByRole('dialog', { name: 'Open EvenDrive link?' })).toBeNull()
    expect(fixture.gfsResolve).not.toHaveBeenCalled()
    expect(fixture.gfsAck).not.toHaveBeenCalled()
    expect(fixture.getController().navigationIntentSequence).toBe(0)

    fixture.handle.resolveAuthenticatedLoad()
    await waitFor(() => expect(fixture.getController().initialExperienceLoading).toBe(false))
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Open EvenDrive link?' })).toBeTruthy()
    )
    expect(fixture.gfsResolve).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(fixture.gfsAck).toHaveBeenCalledWith(link.id))
    await waitFor(() => expect(fixture.gfsQueue.list()).toEqual([]))
  })

  it('uses the real ConfirmDialog Escape action to dismiss without reading or navigating', async () => {
    dialogHarness.renderActual = true
    const uri = `gfs://main/${'f'.repeat(32)}`
    const fixture = await mountWithHeldRealSession(uri)
    const link = fixture.gfsLink
    if (!link) throw new Error('the native queue did not produce the folder envelope')

    await fixture.sessionStarted
    await fixture.gfsListingStarted
    fixture.releaseSession()
    await waitFor(() => expect(fixture.getController().isAuthenticated).toBe(true))
    await waitFor(() => expect(fixture.getController().booting).toBe(false))
    await waitFor(() => expect(fixture.getController().initialExperienceLoading).toBe(false))
    const dialog = await screen.findByRole('dialog', { name: 'Open EvenDrive link?' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(fixture.gfsResolve).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() => expect(fixture.gfsAck).toHaveBeenCalledWith(link.id))
    await waitFor(() => expect(fixture.gfsQueue.list()).toEqual([]))
    expect(await fixture.gfsAck.mock.results[0]?.value).toBe(true)
    expect(fixture.gfsResolve).not.toHaveBeenCalled()
    expect(fixture.confirmedTrace).toEqual([])
    expect(destination(fixture.getController())).toBeNull()
    expect(screen.queryByRole('dialog', { name: 'Open EvenDrive link?' })).toBeNull()
  })

  it('coalesces list-only intake through StrictMode replay and a duplicate after Open', async () => {
    const uri = 'gfs://main/1991c54d6a374d358e2e10f0a086d00a'
    const fixture = await mountWithHeldRealSession(uri, {
      holdResourceResolution: true,
      strictMode: true,
    })
    const link = fixture.gfsLink
    if (!link) throw new Error('the native queue did not produce the file envelope')

    await fixture.sessionStarted
    await fixture.gfsListingStarted
    fixture.releaseSession()
    await waitFor(() => expect(fixture.getController().isAuthenticated).toBe(true))
    await waitFor(() => expect(fixture.getController().booting).toBe(false))
    await waitFor(() => expect(fixture.getController().initialExperienceLoading).toBe(false))
    await screen.findByRole('dialog', { name: 'Open EvenDrive link?' })
    expect(fixture.eventDeliveries()).toBe(0)
    expect(fixture.gfsQueue.list()).toEqual([link])
    expect(fixture.gfsResolve).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await fixture.resourceReadStarted
    expect(fixture.confirmedTrace).toHaveLength(1)
    await fixture.emitGfsLink(link)
    await act(async () => {
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    })
    expect(fixture.confirmedTrace).toHaveLength(1)
    expect(fixture.gfsResolve).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog', { name: 'Open EvenDrive link?' })).toBeNull()

    fixture.releaseResource()
    await waitFor(() => expect(destination(fixture.getController())).toBe(uri))
    await waitFor(() => expect(fixture.gfsAck).toHaveBeenCalledWith(link.id))
    expect(fixture.gfsAck).toHaveBeenCalledTimes(1)
    expect(fixture.gfsQueue.list()).toEqual([])
  })

  it.each([
    { kind: 'file', uri: 'gfs://main/1991c54d6a374d358e2e10f0a086d00a' },
    { kind: 'folder', uri: `gfs://main/${'f'.repeat(32)}` },
  ])('retains a native $kind listing across first real session publication', async ({ uri }) => {
    const fixture = await mountWithHeldRealSession(uri, { holdResourceResolution: true })
    const link = fixture.gfsLink
    if (!link) throw new Error('the main queue did not produce the cold GFS envelope')
    await fixture.sessionStarted
    await fixture.gfsListingStarted
    await waitFor(() => expect(fixture.gfsList).toHaveBeenCalled())
    expect(fixture.gfsQueue.list()).toEqual([link])
    const listSnapshots = await Promise.all(
      fixture.gfsList.mock.results.map(
        result => result.value as Promise<{ links: GfsResourceDeepLinkEnvelope[] }>
      )
    )
    expect(listSnapshots.some(snapshot => snapshot.links.some(item => item.id === link.id))).toBe(
      true
    )
    expect(fixture.gfsResolve).not.toHaveBeenCalled()
    expect(fixture.gfsAck).not.toHaveBeenCalled()
    expect(fixture.eventDeliveries()).toBe(0)
    expect(screen.queryByRole('dialog', { name: 'Open EvenDrive link?' })).toBeNull()
    expect(fixture.getController().navigationIntentSequence).toBe(0)

    const model = initialModel()
    transition(model, { kind: 'receive', id: link.id, uri })
    fixture.releaseSession()
    await waitFor(() => expect(fixture.getController().isAuthenticated).toBe(true))
    await waitFor(() => expect(fixture.getController().booting).toBe(false))
    await waitFor(() => expect(fixture.getController().initialExperienceLoading).toBe(false))
    await act(async () => {
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
      await new Promise<void>(resolve => setImmediate(resolve))
    })

    transition(model, { kind: 'ready', principal: 'user-a:user-a@example.test' })
    const observationBeforeOpen = await observe(fixture, link)
    assertObservation(model, observationBeforeOpen)
    expect(observationBeforeOpen.visiblePromptIds).toEqual([link.id])
    expect(observationBeforeOpen.resourceReadCountById.get(link.id)).toBe(0)
    expect(observationBeforeOpen.actualResolverEntriesById.get(link.id)).toBe(0)
    expect(observationBeforeOpen.previewFetchesById.get(link.id)).toBe(0)
    expect(fixture.beginTrace).toEqual([])
    expect(fixture.confirmedTrace).toEqual([])
    expect(filesHarness.props?.pendingGfsDeepLink ?? null).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await fixture.resourceReadStarted
    expect(fixture.confirmedTrace).toHaveLength(1)
    expect(fixture.confirmedTrace[0]).toMatchObject({
      id: link.id,
      uri,
      userNavigationGenerationAtActivation: fixture.navigation.current(),
    })
    expect(fixture.navigation.current()).toBeGreaterThan(link.userNavigationGenerationAtActivation)
    expect(fixture.gfsQueue.list()).toEqual([link])

    transition(model, { kind: 'confirm', id: link.id })
    assertObservation(model, {
      visibleDestination: destination(fixture.getController()),
      visiblePromptIds: [],
      resourceReadCountById: new Map([[link.id, fixture.gfsResolve.mock.calls.length]]),
      wrongPrincipalContentObserved: false,
      mainAckOutcomeById: new Map(),
      pendingOwnedWork: fixture.gfsQueue.list().map(item => `native:${item.id}`),
    })

    fixture.releaseResource()
    await waitFor(() => expect(destination(fixture.getController())).toBe(uri))
    const active = activeWorkspaceTab(fixture.getController().workspaceTabs)
    if (uri.endsWith('f'.repeat(32))) {
      expect(active).toMatchObject({ kind: 'files', files: { path: uri } })
      expect(screen.getByRole('navigation', { name: 'File location' }).textContent).toContain(
        'Cold folder'
      )
      transition(model, { kind: 'resolve', id: link.id, result: 'folder' })
    } else {
      expect(active).toMatchObject({ kind: 'preview', preview: { gfsUri: uri } })
      expect(screen.getAllByText('Cold file.md').length).toBeGreaterThan(0)
      transition(model, { kind: 'resolve', id: link.id, result: 'file' })
    }
    await waitFor(() => expect(fixture.gfsAck).toHaveBeenCalledWith(link.id))
    const ackResult = await fixture.gfsAck.mock.results.at(-1)?.value
    expect(ackResult).toBe(true)
    expect(fixture.gfsQueue.list()).toEqual([])
    transition(model, { kind: 'ack', id: link.id, applied: true })
    const finalObservation = await observe(fixture, link)
    expect(finalObservation.actualResolverEntriesById.get(link.id)).toBe(
      uri.endsWith('f'.repeat(32)) ? 1 : 2
    )
    expect(finalObservation.previewFetchesById.get(link.id)).toBe(
      uri.endsWith('f'.repeat(32)) ? 0 : 1
    )
    assertObservation(model, finalObservation, true)
    if (!uri.endsWith('f'.repeat(32))) {
      expect(fixture.gfsResolve).toHaveBeenCalledTimes(2)
      expect(fixture.gfsResolveStacks.filter(stack => stack.includes('FilesPage'))).toHaveLength(1)
      expect(
        fixture.gfsResolveStacks.filter(stack => stack.includes('useFilePreviewResourceActions'))
      ).toHaveLength(1)
    }
    fixture.queryClient.clear()
  })

  it('keeps the existing App confirmation through the same held session boundary', async () => {
    const fixture = await mountWithHeldRealSession(null, { holdAppListing: true })
    const target = parseSandboxUiDeepLink(
      buildSandboxUiDeepLink({
        recipeNs: 'ns',
        recipeName: 'cold-start',
        path: '/requested-resource',
        teamId: 'team-a',
      })
    )
    if (!target) throw new Error('the shared App producer rejected the positive control')
    const appLink = fixture.appQueue.enqueue(target, 0)
    await fixture.sessionStarted
    await waitFor(() => expect(fixture.appLinkList).toHaveBeenCalled())
    fixture.releaseSession()
    await waitFor(() => expect(fixture.getController().isAuthenticated).toBe(true))
    await waitFor(() => expect(fixture.getController().booting).toBe(false))
    await waitFor(() => expect(fixture.getController().initialExperienceLoading).toBe(false))
    fixture.releaseAppListing()
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Open app link?' })).toBeTruthy())
    expect(fixture.gfsResolve).not.toHaveBeenCalled()
    expect(appLink.id).toBe(1)
    fixture.queryClient.clear()
  })
})
