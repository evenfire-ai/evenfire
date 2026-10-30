import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { reduceEmbedOwnership } from '../../ui/src/lib/embedOwnership'
import type {
  Bounds,
  EmbedEffect,
  EmbedEvent,
  EmbedOwnershipState,
  Launch,
  LaunchId,
  LaunchOutcome,
} from '../../ui/src/lib/embedOwnership.types'
import { createEmbedOwnershipMachine } from '../../ui/src/lib/embedOwnershipMachine'
import type {
  EmbedOwnershipMachine,
  EmbedRefreshErrorEvent,
} from '../../ui/src/lib/embedOwnershipMachine.types'
import { embedFailureMessage, embedViewState } from '../../ui/src/lib/embedOwnershipView'
import {
  activeWorkspaceTab,
  closeWorkspaceTab,
  createWorkspaceTabsState,
  openAppTab,
  selectWorkspaceTab,
} from '../../ui/src/lib/workspaceTabs'
import type { WorkspaceTabsState } from '../../ui/src/lib/workspaceTabs.types'
import type { AppService } from '../appService.js'
import { getActiveSandboxUi } from '../sandboxUiDriver.js'
import { SANDBOX_UI_REFRESH_INTERVAL_MS } from '../sandboxUiSessionRefresh.js'
import type { SandboxUiReleasedEvent } from '../types.js'
import {
  type FakeParentWindow,
  type FakeWebContents,
  type FakeWebContentsView,
  electronMocks,
} from './__fixtures__/sandboxUiElectronFakes.js'
import {
  type FakeMainWebContents,
  type RealMain,
  mintOk,
  resetRealMain,
  sandboxUiMintFetch,
  startRealMain,
} from './__fixtures__/sandboxUiRealMain.js'

// Ownership of the native embed, end to end: the REAL reducer and interpreter
// in the renderer, the REAL `sandboxUi:open`/`sandboxUi:close` IPC handlers of
// ipc.ts, and behind them the REAL AppService lifecycle queue and sandbox-ui
// driver. Only the Electron runtime, rpc-proxy's HTTP answers and the RPC-token
// issuer are fake. Nothing here models main: every `released`, every open
// outcome and every location comes from the code that produces it in the app.
//
// The IPC wire is two FIFO lanes (renderer → main, main → renderer) whose
// deliveries, like slot measurements, mints, document commits/loads and the
// route-handoff script, are tasks of a fast-check scheduler, so each run tries a
// different interleaving of them with the user's gestures and with the
// accidents of the real world (crashes, renderer reloads, session changes, a
// throwing cleanup).

vi.mock(
  'electron',
  async () => (await import('./__fixtures__/sandboxUiElectronFakes.js')).electronModule
)

vi.mock(
  '../config.js',
  async () => (await import('./__fixtures__/sandboxUiMainModuleMocks.js')).configModule
)

vi.mock(
  '../sandboxUiPartitionGc.js',
  async () => (await import('./__fixtures__/sandboxUiMainModuleMocks.js')).partitionGcModule
)

vi.mock(
  '../rpcTokenManager.js',
  async () => (await import('./__fixtures__/sandboxUiMainModuleMocks.js')).rpcTokenManagerModule
)

vi.mock(
  '../authClient.js',
  async () => (await import('./__fixtures__/sandboxUiMainModuleMocks.js')).authClientModule
)

vi.mock(
  '../tokenStore.js',
  async () => (await import('./__fixtures__/sandboxUiMainModuleMocks.js')).tokenStoreModule
)

const RUNS = Number(process.env.EMBED_PROP_RUNS ?? 4000)
const SEED = process.env.EMBED_PROP_SEED ? Number(process.env.EMBED_PROP_SEED) : undefined
const P8_RUNS = Math.max(1, Math.round(RUNS / 2))
// About 60% of P8 runs compare two different interleavings; from 50 runs on, a
// share under 40% is far outside chance and means the two schedulers collapsed.
// Fewer runs (a small EMBED_PROP_RUNS) are too noisy to judge and skip the check.
const P8_GUARD_MIN_RUNS = 50

const BOUNDS: Bounds = { x: 0, y: 40, width: 800, height: 600 }
const RPC_ORIGIN = 'https://rpc.example'
const APPS = {
  alpha: 'sandbox-recipes/alpha',
  beta: 'sandbox-recipes/beta',
  // rpc-proxy refuses every mint for this one.
  gamma: 'sandbox-recipes/gamma',
} as const
type AppName = keyof typeof APPS

const viewBase = (appRef: string) => `${RPC_ORIGIN}/api/v1/sandbox-ui/${appRef}/view`

// ─── Scheduling ────────────────────────────────────────────────────────────

type TaskSink = { schedule<T>(task: Promise<T>, label: string): Promise<T> }

const macrotask = () => new Promise<void>(resolve => setImmediate(resolve))

async function settleAsyncWork(): Promise<void> {
  for (let i = 0; i < 3; i++) await macrotask()
}

async function microtasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** Holds every task until a named case releases it, for exact orderings. */
class ManualSink implements TaskSink {
  private tasks: Array<{ label: string; release: () => void }> = []

  schedule<T>(task: Promise<T>, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.tasks.push({ label, release: () => void task.then(resolve, reject) })
    })
  }

  labels(): string[] {
    return this.tasks.map(task => task.label)
  }

  /** Releases tasks oldest first until only held ones (if any) remain. */
  async runAll(hold: (label: string) => boolean = () => false): Promise<void> {
    for (let step = 0; step < 10_000; step++) {
      await settleAsyncWork()
      const index = this.tasks.findIndex(task => !hold(task.label))
      if (index === -1) {
        await settleAsyncWork()
        if (this.tasks.findIndex(task => !hold(task.label)) === -1) return
        continue
      }
      const [task] = this.tasks.splice(index, 1)
      task!.release()
    }
    throw new Error(`ManualSink did not settle: ${this.labels().join(', ')}`)
  }
}

async function drainScheduler(
  s: fc.Scheduler,
  finished: () => boolean = () => true
): Promise<void> {
  for (let round = 0; round < 1_000; round++) {
    await s.waitIdle()
    await settleAsyncWork()
    if (s.count() === 0 && finished()) return
  }
  throw new Error('the scheduler never went idle')
}

// ─── The real main process behind a fake wire ──────────────────────────────

let userDataDir = ''
const oracleFailures: string[] = []

type ToMain = {
  channel: 'sandboxUi:open' | 'sandboxUi:close'
  payload: unknown
  launchId: LaunchId
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

type ToRenderer =
  | { kind: 'reply'; label: string; settle: () => void }
  | { kind: 'event'; label: string; channel: string; payload: unknown }

type Gesture =
  | { type: 'select'; tab: number }
  | { type: 'reclick' }
  | { type: 'relaunch' }
  | { type: 'backToApps' }
  /** Hands the embed off (a deep link to another team); the link then opens `tab`. */
  | { type: 'handoff'; tab: number }
  | { type: 'closeTab'; tab: number }
  | { type: 'openTab'; app: AppName }
  /** The commit that should have activated this tab did not (K23). */
  | { type: 'staleIntent'; tab: number }

type Reality =
  /** The next view dies (crash, session change) inside its mount, before its open settles. */
  | 'crashDuringMount'
  | 'sessionDuringMount'
  /** The next view mounts, then attaching it to the window throws: its open fails. */
  | 'attachFailsDuringMount'
  | 'crash'
  | 'title'
  | 'navigate'
  | 'reload'
  | 'session'
  | 'cleanupThrows'
  | 'lateMeasurer'
  /** The window holding the embed closes; its renderer goes with it. */
  | 'parentClosed'

type WorldOptions = {
  sink: TaskSink
  launchIds?: readonly string[]
  /** Deliver every queued renderer → main message in one go, as one IPC burst. */
  batch?: boolean
  /** Launches, by the order they are issued, whose slot never becomes measurable. */
  slotFailures?: readonly boolean[]
  lateMeasurer?: boolean
}

function short(id: string): string {
  return id.slice(0, 8)
}

function describeEvent(event: EmbedEvent): string {
  switch (event.type) {
    case 'projected':
      return `projected(${event.activeAppTabId})`
    case 'intent':
    case 'relaunch':
      return `${event.type}(${short(event.launch.launchId)}@${event.launch.tabId})`
    case 'backToApps':
      return 'backToApps'
    case 'handoff':
      return `handoff(${event.requestId})`
    case 'slotMeasured':
      return `slotMeasured(${short(event.launchId)}, ${event.bounds ? 'bounds' : 'null'})`
    case 'openSettled':
      return `openSettled(${short(event.launchId)}, ${JSON.stringify(event.outcome)})`
    case 'closeFailed':
      return `closeFailed(${short(event.launchId)})`
    case 'released':
      return `released(${short(event.launchId)}, ${event.reason}, ${JSON.stringify(event.location)})`
    case 'titleChanged':
      return `titleChanged(${short(event.launchId)})`
  }
}

const UNSOLICITED_REASONS = new Set<SandboxUiReleasedEvent['reason']>([
  'crashed',
  'session',
  'renderer_replaced',
  'parent_closed',
])

const IDEMPOTENT_EVENTS = new Set<EmbedEvent['type']>([
  'projected',
  'slotMeasured',
  'openSettled',
  'closeFailed',
  'released',
])

/**
 * One renderer (machine + tab store) wired to one real main process through the
 * fake IPC wire. Gestures go through the same seam the app uses: commit the tab
 * store, project it, then dispatch the launch.
 */
class World {
  readonly sink: TaskSink
  readonly main: RealMain
  readonly parent: FakeParentWindow
  readonly mainWebContents: FakeMainWebContents
  readonly service: AppService
  readonly failingRecipes = new Set<string>(['gamma'])
  immediateMints = false
  /** The next view's renderer dies the moment its document starts loading. */
  crashNextLoad = false
  /** The session changes the moment the next view starts loading. */
  sessionChangeNextLoad = false
  /** Attaching the next view to the window throws, after main made it the active view. */
  attachFailsNextMount = false
  tabs: WorkspaceTabsState
  machine: EmbedOwnershipMachine
  generation = 0
  measurerRegistered = false

  /** Main-side arrival order of lifecycle IPC. */
  readonly ipcTrace: Array<{ op: 'open' | 'close'; launchId: LaunchId; routePath?: string }> = []
  readonly launches = new Map<LaunchId, { tabId: string; generation: number }>()
  readonly settledCount = new Map<LaunchId, number>()
  readonly outcomes = new Map<LaunchId, LaunchOutcome>()
  readonly viewOf = new Map<LaunchId, FakeWebContentsView>()
  /** Every route a launch's view was asked to show or navigated to. */
  readonly shownRoutes = new Map<LaunchId, Set<string | undefined>>()
  readonly navigated = new Set<LaunchId>()
  readonly releases: SandboxUiReleasedEvent[] = []
  readonly handoffsReady: number[] = []
  readonly refreshErrors: EmbedRefreshErrorEvent[] = []
  readonly violations: string[] = []
  readonly log: string[] = []

  /** The last gesture asked for an owner on the tab still active. */
  expectOwner = false
  /** The owner that gesture left behind: the new launch, or the live one it kept. */
  gestureOwner: LaunchId | null = null
  /**
   * Since that gesture, main reported the death of the owner for a reason the
   * user did not ask for (crash, session, renderer reload).
   */
  killedSinceLaunch = false

  private readonly launchIds: string[]
  private readonly slotFailures: readonly boolean[]
  private readonly batch: boolean
  private readonly failedSlots = new Set<LaunchId>()
  private launchesIssued = 0
  private nextTab = 5
  private nextRequest = 1
  private navigation = 0
  private opensInMain = 0
  private readonly clearedTabs = new Set<string>()
  private readonly settlePromises = new Map<LaunchId, Promise<LaunchOutcome>>()
  private readonly continuations = new Map<
    number,
    { targetTabId: string | undefined; resolve: (value: unknown) => void }
  >()
  private lastLaunch: LaunchId | null = null
  /** The window closed: the renderer is gone and only main is left to check. */
  windowClosed = false
  private toMain: ToMain[] = []
  private toRenderer: ToRenderer[] = []
  private rendererLane: Promise<void> = Promise.resolve()
  private crashWatch: {
    launchId: LaunchId
    activeAppTabId: string | null
    owner: LaunchId | null
  } | null = null

  private constructor(options: WorldOptions, main: RealMain) {
    this.sink = options.sink
    this.main = main
    this.parent = main.parent
    this.mainWebContents = main.mainWebContents
    this.service = main.service
    this.launchIds = [...(options.launchIds ?? [])]
    this.slotFailures = options.slotFailures ?? []
    this.batch = options.batch ?? false
    let tabs = createWorkspaceTabsState('chat-tab-1')
    tabs = openAppTab(tabs, { id: 'ws-tab-2', appRef: APPS.alpha, title: 'Alpha' })
    tabs = openAppTab(tabs, { id: 'ws-tab-3', appRef: APPS.beta, title: 'Beta' })
    tabs = openAppTab(tabs, { id: 'ws-tab-4', appRef: APPS.gamma, title: 'Gamma' })
    this.tabs = selectWorkspaceTab(tabs, 'chat-tab-1')
    this.machine = this.createMachine()
  }

  static async create(options: WorldOptions): Promise<World> {
    await resetRealMain()
    // The callbacks only run once the world exists: nothing reaches main before
    // the first gesture.
    let world!: World
    const main = startRealMain({
      userDataDir,
      mint: recipeName => world.mint(recipeName),
      onSend: (channel, payload) => world.fromMain(channel, payload),
      onLoad: (webContents, url) => world.onLoad(webContents, url),
    })
    world = new World(options, main)
    const attach = main.parent.contentView.addChildView.getMockImplementation() as (
      view: unknown
    ) => void
    main.parent.contentView.addChildView.mockImplementation((view: unknown) => {
      if (world.attachFailsNextMount) {
        world.attachFailsNextMount = false
        world.log.push('reality attach fails inside the mount')
        throw new Error('attach failed')
      }
      attach(view)
    })
    if (!options.lateMeasurer) world.registerMeasurer()
    world.machine.projected(world.activeAppTabId())
    return world
  }

  /** Main is gone (the world was reset); nothing may act on it any more. */
  get dead(): boolean {
    return this.main.dead
  }

  // ── renderer ──

  private createMachine(): EmbedOwnershipMachine {
    const generation = ++this.generation
    return createEmbedOwnershipMachine({
      bridge: {
        open: request => this.sendToMain('sandboxUi:open', request, request.launchId),
        close: request => this.sendToMain('sandboxUi:close', request, request.launchId),
      },
      updateTabs: updater => {
        this.tabs = updater(this.tabs)
      },
      onHandoffReady: requestId => this.continueHandoff(requestId),
      onOwnerRefreshError: event => this.refreshErrors.push(event),
      // The machine swallows whatever onTransition throws (a renderer hook must
      // not wedge it), so a broken check would go silent. Record it on the world
      // for assertClean and on the module for tests that never call it.
      onTransition: transition => {
        try {
          this.checkTransition(transition, generation)
        } catch (error) {
          const detail = `checkTransition threw on ${transition.event.type}: ${String(error)}`
          this.violation('oracle', detail)
          oracleFailures.push(detail)
        }
      },
    })
  }

  registerMeasurer(): void {
    this.measurerRegistered = true
    this.machine.registerMeasurer(launchId =>
      this.sink.schedule(
        Promise.resolve(this.failedSlots.has(launchId) ? null : BOUNDS),
        `measure ${short(launchId)}`
      )
    )
  }

  activeAppTabId(): string | null {
    const tab = activeWorkspaceTab(this.tabs)
    return tab?.kind === 'app' ? tab.id : null
  }

  private tabAt(index: number): string | undefined {
    if (this.tabs.tabs.length === 0) return undefined
    return this.tabs.tabs[index % this.tabs.tabs.length]!.id
  }

  private commit(next: WorkspaceTabsState): void {
    this.tabs = next
    this.machine.projected(this.activeAppTabId())
  }

  private takeLaunchId(): string {
    return this.launchIds.shift() ?? crypto.randomUUID()
  }

  /** Builds a launch for `tabId` as the seam would; `dispatch` decides how it is sent. */
  private newLaunch(tabId: string, kind: 'tab' | 'explicit'): Launch {
    const tab = this.tabs.tabs.find(candidate => candidate.id === tabId)!
    const launchId = this.takeLaunchId()
    if (this.slotFailures[this.launchesIssued]) this.failedSlots.add(launchId)
    this.launchesIssued += 1
    this.launches.set(launchId, { tabId, generation: this.generation })
    const settled = this.machine.registerWhenSettled(launchId)
    this.settlePromises.set(launchId, settled)
    void settled.then(outcome => {
      this.outcomes.set(launchId, outcome)
    })
    // Like the seam, a tab launch asks for the route its tab was left at: after
    // a renderer reload that is all a fresh machine has to go on. A tab never
    // left anywhere asks for a route of its own, so routes name their launch.
    const routePath =
      kind === 'tab' && tab.app?.savedRoutePath !== undefined
        ? tab.app.savedRoutePath
        : `/r/${launchId}`
    return {
      launchId,
      tabId,
      appRef: tab.app!.appRef,
      route: { kind, routePath },
      app: { label: tab.title, defaultPath: '/' },
    }
  }

  launch(tabId: string, kind: 'tab' | 'explicit', replace = false): LaunchId {
    const launch = this.newLaunch(tabId, kind)
    // The owner it leaves is read when the machine reduces this launch: from
    // inside an effect the dispatch is only queued and the snapshot lags.
    this.lastLaunch = launch.launchId
    this.gestureOwner = null
    this.killedSinceLaunch = false
    if (replace) this.machine.relaunch(launch)
    else this.machine.intent(launch)
    this.expectOwner = this.activeAppTabId() === tabId
    return launch.launchId
  }

  selectTab(tabId: string): LaunchId | undefined {
    this.commit(selectWorkspaceTab(this.tabs, tabId))
    if (this.activeAppTabId() === tabId) return this.launch(tabId, 'tab')
    this.expectOwner = false
    return undefined
  }

  /** The tab activates but its app cannot be resolved: no launch follows (K6). */
  commitOnly(tabId: string): void {
    this.commit(selectWorkspaceTab(this.tabs, tabId))
    this.expectOwner = false
  }

  reclick(): LaunchId | undefined {
    const tabId = this.activeAppTabId()
    return tabId ? this.launch(tabId, 'tab') : undefined
  }

  relaunch(): LaunchId | undefined {
    const tabId = this.activeAppTabId()
    return tabId ? this.launch(tabId, 'tab', true) : undefined
  }

  backToApps(): void {
    this.machine.backToApps()
    this.expectOwner = false
  }

  handoff(targetTabId?: string): Promise<unknown> {
    const requestId = this.nextRequest++
    const done = new Promise<unknown>(resolve =>
      this.continuations.set(requestId, { targetTabId, resolve })
    )
    this.machine.handoff(requestId)
    this.expectOwner = false
    return done
  }

  /**
   * The deep link's continuation once the embed is handed off: it activates its
   * target tab and launches it, synchronously, from inside the machine's effect
   * — what the seam does when the continuation runs.
   */
  private continueHandoff(requestId: number): void {
    this.handoffsReady.push(requestId)
    const continuation = this.continuations.get(requestId)
    this.continuations.delete(requestId)
    if (!continuation) return
    const target = continuation.targetTabId
    const exists = target && this.tabs.tabs.some(tab => tab.id === target && tab.kind === 'app')
    if (!exists) return continuation.resolve(undefined)
    this.log.push(`continuation of handoff ${requestId} opens ${target}`)
    const launchId = this.selectTab(target)
    continuation.resolve(launchId ? this.settled(launchId) : undefined)
  }

  /** The single outcome of a launch, whenever it settles. */
  settled(launchId: LaunchId): Promise<LaunchOutcome> {
    return this.settlePromises.get(launchId)!
  }

  openTab(app: AppName): LaunchId {
    const id = `ws-tab-${this.nextTab++}`
    const title = app[0]!.toUpperCase() + app.slice(1)
    this.commit(openAppTab(this.tabs, { id, appRef: APPS[app], title }))
    return this.launch(id, 'explicit')
  }

  /** Closing a tab activates a neighbour; an app neighbour is relaunched by the seam. */
  closeTab(tabId: string): LaunchId | undefined {
    this.commit(closeWorkspaceTab(this.tabs, tabId))
    const active = this.activeAppTabId()
    if (active) return this.launch(active, 'tab')
    this.expectOwner = false
    return undefined
  }

  /** Activates `tabId` with the launch dispatched BEFORE its commit is projected. */
  selectBreakingCommitOrder(tabId: string): LaunchId {
    const launch = this.newLaunch(tabId, 'tab')
    this.machine.intent(launch)
    this.commit(selectWorkspaceTab(this.tabs, tabId))
    return launch.launchId
  }

  staleIntent(tabId: string): LaunchId | undefined {
    if (tabId === this.activeAppTabId()) return undefined
    const tab = this.tabs.tabs.find(candidate => candidate.id === tabId)
    if (tab?.kind !== 'app') return undefined
    const launch = this.newLaunch(tabId, 'tab')
    this.machine.intent(launch)
    return launch.launchId
  }

  gesture(gesture: Gesture): LaunchId | Promise<unknown> | undefined {
    if (this.windowClosed) return undefined
    this.log.push(`gesture ${JSON.stringify(gesture)}`)
    switch (gesture.type) {
      case 'select': {
        const tabId = this.tabAt(gesture.tab)
        return tabId ? this.selectTab(tabId) : undefined
      }
      case 'reclick':
        return this.reclick()
      case 'relaunch':
        return this.relaunch()
      case 'backToApps':
        this.backToApps()
        return undefined
      case 'handoff':
        return this.handoff(this.tabAt(gesture.tab))
      case 'closeTab': {
        const tabId = this.tabAt(gesture.tab)
        return tabId ? this.closeTab(tabId) : undefined
      }
      case 'openTab':
        return this.openTab(gesture.app)
      case 'staleIntent': {
        const tabId = this.tabAt(gesture.tab)
        return tabId ? this.staleIntent(tabId) : undefined
      }
    }
  }

  /**
   * The trusted renderer reloads: main drops the embed it owned, the new
   * document starts with an empty machine, projects the restored store and
   * relaunches the active app tab.
   */
  reloadRenderer(): void {
    if (this.windowClosed) return
    this.log.push('reality reload')
    // What the old document already sent reaches main before its replacement commits.
    while (this.toMain.length > 0) this.invokeMain(this.toMain.shift()!)
    this.machine.dispose()
    this.mainWebContents.emit('did-navigate', {}, 'file:///ui-dist/index.html', 200, 'OK')
    this.machine = this.createMachine()
    this.crashWatch = null
    this.clearedTabs.clear()
    if (this.measurerRegistered) this.registerMeasurer()
    this.machine.projected(this.activeAppTabId())
    const active = this.activeAppTabId()
    if (active) this.launch(active, 'tab')
    else this.expectOwner = false
  }

  /** Returns false when there was nothing for it to act on yet. */
  reality(kind: Reality): boolean {
    if (kind === 'reload') {
      this.reloadRenderer()
      return true
    }
    if (kind === 'parentClosed') {
      if (this.windowClosed) return true
      if (!getActiveSandboxUi() && this.opensInMain === 0) return false
      this.log.push('reality parent window closed')
      this.windowClosed = true
      this.machine.dispose()
      this.parent.destroy()
      this.parent.emit('closed')
      return true
    }
    if (kind === 'lateMeasurer') {
      if (!this.measurerRegistered) this.registerMeasurer()
      return true
    }
    if (kind === 'session') {
      if (!getActiveSandboxUi() && this.opensInMain === 0) return false
      this.log.push('reality session')
      this.invalidateSession()
      return true
    }
    if (kind === 'crashDuringMount') {
      this.crashNextLoad = true
      return true
    }
    if (kind === 'sessionDuringMount') {
      this.sessionChangeNextLoad = true
      return true
    }
    if (kind === 'attachFailsDuringMount') {
      this.attachFailsNextMount = true
      return true
    }
    const active = getActiveSandboxUi()
    const view = active ? this.viewOf.get(active.launchId) : undefined
    if (!active || !view || view.webContents.destroyed) return false
    switch (kind) {
      case 'crash':
        this.log.push(`reality crash on ${short(active.launchId)}`)
        view.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 139 })
        return true
      case 'title':
        this.log.push(`reality title on ${short(active.launchId)}`)
        view.webContents.emit('page-title-updated', {}, `title ${active.launchId}`)
        return true
      case 'navigate': {
        if (!view.webContents.currentUrl) return false
        this.log.push(`reality navigate on ${short(active.launchId)}`)
        const route = `/r/nav-${++this.navigation}`
        this.navigated.add(active.launchId)
        this.shownRoutes.get(active.launchId)?.add(route)
        view.webContents.navigateInPage(`${viewBase(active.appRef)}${route}`)
        return true
      }
      case 'cleanupThrows':
        this.log.push(`reality cleanupThrows on ${short(active.launchId)}`)
        vi.spyOn(view.webContents, 'removeListener').mockImplementation(() => {
          throw new Error('injected unhook failure')
        })
        return true
    }
  }

  /** What a logout or a login over the live session does to the embed. */
  private invalidateSession(): void {
    this.main.invalidateSession()
  }

  /** rpc-proxy's answer to a session mint, delivered when the scheduler says so. */
  mint(recipeName: string): Promise<Response> | Response {
    const response = this.failingRecipes.has(recipeName)
      ? new Response('upstream unavailable', { status: 503 })
      : mintOk(recipeName)
    if (this.immediateMints) return response
    return this.sink.schedule(Promise.resolve(response), `mint ${recipeName}`)
  }

  /** Schedules an accident; one with no view to hit yet tries again later, a few times. */
  scheduleReality(kind: Reality, attempts = 4): void {
    void this.sink.schedule(Promise.resolve(), `reality ${kind}`).then(() => {
      if (this.dead) return
      if (!this.reality(kind) && attempts > 1) this.scheduleReality(kind, attempts - 1)
    })
  }

  // ── wire ──

  private sendToMain(channel: ToMain['channel'], payload: unknown, launchId: LaunchId) {
    return new Promise<unknown>((resolve, reject) => {
      this.toMain.push({ channel, payload, launchId, resolve, reject })
      void this.sink
        .schedule(Promise.resolve(), `ipc→main ${channel} ${short(launchId)}`)
        .then(() => this.deliverToMain())
    })
  }

  private deliverToMain(): void {
    const count = this.batch ? this.toMain.length : 1
    for (let i = 0; i < count; i++) {
      const message = this.toMain.shift()
      if (!message) return
      this.invokeMain(message)
    }
  }

  private invokeMain(message: ToMain): void {
    const op = message.channel === 'sandboxUi:open' ? 'open' : 'close'
    const routePath = (message.payload as { routePath?: string }).routePath
    this.ipcTrace.push({ op, launchId: message.launchId, ...(op === 'open' ? { routePath } : {}) })
    if (op === 'open') {
      this.shownRoutes.set(message.launchId, new Set([routePath]))
      this.opensInMain += 1
    }
    const result = this.main.invoke(message.channel, message.payload)
    const label = `reply ${message.channel} ${short(message.launchId)}`
    if (op === 'open') {
      void result.then(
        () => (this.opensInMain -= 1),
        () => (this.opensInMain -= 1)
      )
    }
    result.then(
      value => this.queueToRenderer({ kind: 'reply', label, settle: () => message.resolve(value) }),
      error => this.queueToRenderer({ kind: 'reply', label, settle: () => message.reject(error) })
    )
  }

  fromMain(channel: string, payload: unknown): void {
    if (channel === 'sandboxUi:released')
      this.checkReleasedLocation(payload as SandboxUiReleasedEvent)
    const launchId = (payload as { launchId?: string } | undefined)?.launchId ?? ''
    this.queueToRenderer({
      kind: 'event',
      label: `${channel} ${short(launchId)}`,
      channel,
      payload,
    })
  }

  // Replies and events share one ordered lane, as they share the IPC pipe; a
  // message is handled, microtasks included, before the next one arrives.
  private queueToRenderer(message: ToRenderer): void {
    this.toRenderer.push(message)
    const released = this.sink.schedule(Promise.resolve(), `ipc→renderer ${message.label}`)
    this.rendererLane = this.rendererLane
      .then(() => released)
      .then(() => this.deliverToRenderer())
      .then(microtasks)
      .catch(error => {
        this.violations.push(`renderer delivery threw: ${String(error)}`)
      })
  }

  private deliverToRenderer(): void {
    const message = this.toRenderer.shift()
    if (!message) return
    if (message.kind === 'reply') {
      message.settle()
      return
    }
    switch (message.channel) {
      case 'sandboxUi:released': {
        const released = message.payload as SandboxUiReleasedEvent
        this.releases.push(released)
        if (
          UNSOLICITED_REASONS.has(released.reason) &&
          this.machine.getSnapshot().owner === released.launchId
        ) {
          this.killedSinceLaunch = true
        }
        this.machine.onReleased(released)
        return
      }
      case 'sandboxUi:titleChanged':
        this.machine.onTitleChanged(message.payload as { launchId: string; title: string })
        return
      case 'sandboxUi:refreshError':
        this.machine.onRefreshError(message.payload as EmbedRefreshErrorEvent)
        return
    }
  }

  onLoad(webContents: FakeWebContents, _url: string): void {
    const active = getActiveSandboxUi()
    const view = electronMocks.views.find(candidate => candidate.webContents === webContents)
    if (!active || !view) return
    const launchId = active.launchId
    this.viewOf.set(launchId, view)
    // Inside the mount: nothing else can run between this and the open's own
    // checks, so these reach the window between mounting and settling.
    if (this.sessionChangeNextLoad) {
      this.sessionChangeNextLoad = false
      this.log.push(`reality session inside the mount of ${short(launchId)}`)
      this.invalidateSession()
    }
    if (this.crashNextLoad) {
      this.crashNextLoad = false
      this.log.push(`reality crash inside the mount of ${short(launchId)}`)
      webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 139 })
      return
    }
    const runScript = webContents.executeJavaScript.getMockImplementation()!
    // The page runs the handoff script when the scheduler says so, and runs it
    // for real: whatever it reads or changes comes from the script itself.
    webContents.executeJavaScript.mockImplementation((code: string) =>
      this.sink.schedule(Promise.resolve(), `exec ${short(launchId)}`).then(() => runScript(code))
    )
    void this.sink.schedule(Promise.resolve(), `commit ${short(launchId)}`).then(() => {
      if (webContents.destroyed || this.dead) return
      webContents.currentUrl = webContents.pendingUrl
      webContents.emit('did-navigate', {}, webContents.currentUrl, 200, '')
      void this.sink.schedule(Promise.resolve(), `loaded ${short(launchId)}`).then(() => {
        if (webContents.destroyed || this.dead) return
        webContents.emit('did-finish-load')
      })
    })
  }

  // ── properties checked on every transition ──

  private violation(property: string, detail: string): void {
    this.violations.push(`${property}: ${detail}`)
  }

  private checkTransition(
    transition: {
      event: EmbedEvent
      previous: EmbedOwnershipState
      next: EmbedOwnershipState
      effects: readonly EmbedEffect[]
    },
    generation: number
  ): void {
    const { event, previous, next, effects } = transition
    const where = `[r${generation}] ${describeEvent(event)}`
    this.log.push(
      `${where} → owner ${next.owner ? short(next.owner) : null}; ` +
        effects.map(e => e.type + ('launchId' in e ? ` ${short(e.launchId)}` : '')).join(', ')
    )
    if (
      (event.type === 'intent' || event.type === 'relaunch') &&
      event.launch.launchId === this.lastLaunch
    ) {
      this.gestureOwner = next.owner
    }

    if (next.owner !== null) {
      const owner = next.views.get(next.owner)
      if (!owner || owner.tabId !== next.activeAppTabId) {
        this.violation('P1', `${where}: owner ${short(next.owner)} is not a view of the active tab`)
      }
    }

    for (const effect of effects) {
      if (effect.type === 'close' && effect.launchId === next.owner) {
        this.violation('P3', `${where}: closes the owner ${short(effect.launchId)}`)
      }
      if (effect.type === 'persistRoute') {
        const record = event.type === 'released' ? previous.views.get(event.launchId) : undefined
        if (!record || record.tabId !== effect.tabId) {
          this.violation('P4', `${where}: persists ${effect.tabId} without a release of its view`)
        } else {
          const route = effect.route.action === 'set' ? effect.route.routePath : undefined
          if (!this.shownRoutes.get(record.launchId)?.has(route)) {
            this.violation(
              'P4',
              `${where}: persists ${route} that ${short(record.launchId)} never showed`
            )
          }
        }
      }
      if (effect.type === 'persistRoute' && effect.route.action === 'clear') {
        this.clearedTabs.add(effect.tabId)
      }
      if (effect.type === 'sendOpen' && effect.launch.route.kind === 'tab') {
        // K19: a tab reopens where the store says it was left, even though the
        // seam built the launch before that route reached the store.
        const tab = this.tabs.tabs.find(candidate => candidate.id === effect.launch.tabId)
        const saved = tab?.app?.savedRoutePath
        const expected =
          saved !== undefined || this.clearedTabs.has(effect.launch.tabId)
            ? saved
            : effect.launch.route.routePath
        if (tab && effect.routePath !== expected) {
          this.violation(
            'K19',
            `${where}: opens ${short(effect.launch.launchId)} at ${effect.routePath}, its tab was left at ${expected}`
          )
        }
      }
      if (effect.type === 'setTitle') {
        const owner = previous.owner === null ? undefined : previous.views.get(previous.owner)
        if (
          event.type !== 'titleChanged' ||
          event.launchId !== previous.owner ||
          owner?.tabId !== effect.tabId ||
          event.title !== effect.title
        ) {
          this.violation('P5', `${where}: setTitle(${effect.tabId}) not from the owner's title`)
        }
      }
      if (effect.type === 'launchSettled') {
        const count = (this.settledCount.get(effect.launchId) ?? 0) + 1
        this.settledCount.set(effect.launchId, count)
        if (count > 1) this.violation('P12', `${where}: ${short(effect.launchId)} settled twice`)
      }
    }

    // P13, renderer side: the route main reports for a dying view reaches its tab.
    if (event.type === 'released' && event.location !== null) {
      const record = previous.views.get(event.launchId)
      if (record) {
        const routePath = event.location.routePath
        const persisted = effects.some(
          effect =>
            effect.type === 'persistRoute' &&
            effect.tabId === record.tabId &&
            (routePath === undefined
              ? effect.route.action === 'clear'
              : effect.route.action === 'set' && effect.route.routePath === routePath)
        )
        if (!persisted) {
          this.violation('P13', `${where}: the released route never reaches ${record.tabId}`)
        }
      }
    }

    if (IDEMPOTENT_EVENTS.has(event.type)) {
      const again = reduceEmbedOwnership(next, event)
      if (again.state !== next || again.effects.length > 0) {
        this.violation('P6', `${where}: repeating it is not a no-op`)
      }
    }

    const mainPhaseByTab = new Map<string, number>()
    for (const view of next.views.values()) {
      if (view.phase === 'opening' || view.phase === 'mounted' || view.phase === 'closeRequested') {
        mainPhaseByTab.set(view.tabId, (mainPhaseByTab.get(view.tabId) ?? 0) + 1)
      }
    }
    for (const [tabId, count] of mainPhaseByTab) {
      if (count > 1) this.violation('P10', `${where}: ${count} records of ${tabId} in main`)
    }

    if (next.owner !== null && next.views.get(next.owner)?.phase === 'mounted') {
      const active = getActiveSandboxUi()
      if (active && active.launchId !== next.owner) {
        this.violation('P14', `${where}: owner mounted but main shows ${short(active.launchId)}`)
      }
    }

    if (
      event.type === 'released' &&
      event.reason === 'crashed' &&
      previous.owner === event.launchId &&
      (previous.views.get(event.launchId)?.phase === 'mounted' ||
        previous.views.get(event.launchId)?.phase === 'opening')
    ) {
      if (next.failure?.launchId !== event.launchId || next.failure.kind !== 'crashed') {
        this.violation('P17', `${where}: the owner's crash left no crash failure`)
      }
      this.crashWatch = {
        launchId: event.launchId,
        activeAppTabId: next.activeAppTabId,
        owner: next.owner,
      }
    } else if (this.crashWatch) {
      if (
        next.activeAppTabId === this.crashWatch.activeAppTabId &&
        next.owner === this.crashWatch.owner
      ) {
        if (next.failure?.launchId !== this.crashWatch.launchId) {
          this.violation('P17', `${where}: the crash failure vanished with nothing changed`)
        }
      } else {
        this.crashWatch = null
      }
    }
  }

  /** P13 (and K17): what main reports for a view that dies is the route it stood for. */
  private checkReleasedLocation(event: SandboxUiReleasedEvent): void {
    const where = `released(${short(event.launchId)}, ${event.reason})`
    if (event.reason === 'crashed') {
      if (event.location !== null) this.violation('P13', `${where}: a crash reports a route`)
      return
    }
    const shown = this.shownRoutes.get(event.launchId)
    const location = event.location
    if (location === null) {
      this.violation('P13', `${where}: no route for a view that did not crash`)
      return
    }
    if (!this.navigated.has(event.launchId)) {
      const requested = this.ipcTrace.find(
        entry => entry.op === 'open' && entry.launchId === event.launchId
      )?.routePath
      if (location.routePath !== requested) {
        this.violation(
          'P13',
          `${where}: reports ${JSON.stringify(location)} instead of the requested ${requested}`
        )
      }
    } else if (!shown?.has(location.routePath)) {
      this.violation('P13', `${where}: reports ${location.routePath}, a route it never showed`)
    }
  }

  // ── properties checked once everything has drained ──

  checkDrained(): void {
    if (this.windowClosed) {
      // Only main is left: no view may outlive the window, alive or registered.
      const active = getActiveSandboxUi()
      if (active) this.violation('I-orphan', `${short(active.launchId)} outlived its window`)
      for (const view of electronMocks.views) {
        if (!view.webContents.destroyed) {
          this.violation('I-orphan', `webContents ${view.webContents.id} outlived its window`)
        }
      }
      // What the renderer sent before the window closed still reached main in order.
      this.checkIpcOrder()
      return
    }
    const state = this.machine.getSnapshot()
    const active = getActiveSandboxUi()
    const activeTab = this.activeAppTabId()
    const ownerId = state.owner

    if (state.activeAppTabId !== activeTab) {
      this.violation(
        'projection',
        `machine projects ${state.activeAppTabId}, store has ${activeTab}`
      )
    }
    if (activeTab === null || ownerId === null) {
      if (active !== null)
        this.violation('P2', `main shows ${short(active.launchId)} with no owner`)
    } else if (active?.launchId !== ownerId) {
      this.violation(
        'P2',
        `owner ${short(ownerId)} but main shows ${active ? short(active.launchId) : null}`
      )
    }

    for (const [launchId, view] of state.views) {
      if (launchId !== ownerId)
        this.violation('P7', `${short(launchId)} (${view.phase}) left in views`)
      else if (view.phase !== 'mounted') {
        this.violation('P11', `owner ${short(launchId)} stuck in ${view.phase}`)
      }
    }
    if (state.handoffs.length > 0)
      this.violation('P7/P11', `${state.handoffs.length} handoffs left`)

    for (const [launchId, record] of this.launches) {
      const count = this.settledCount.get(launchId) ?? 0
      if (record.generation === this.generation && count !== 1) {
        this.violation('P12', `${short(launchId)} settled ${count} times`)
      }
    }
    if (this.machine.pendingWhenSettled() !== 0) {
      this.violation('P12', `${this.machine.pendingWhenSettled()} whenSettled still pending`)
    }

    if (this.expectOwner && !this.killedSinceLaunch && activeTab !== null) {
      // Only the failure of the launch the gesture asked for explains a missing
      // owner; an older failure on the same tab would hide a dropped launch.
      if (ownerId === null && state.failure?.launchId !== this.gestureOwner) {
        this.violation('P15', `active app tab ${activeTab} has neither an owner nor its failure`)
      }
    }

    const children = this.parent.contentView.children as FakeWebContentsView[]
    if (!active) {
      if (children.length > 0)
        this.violation('P16', `${children.length} views attached, none active`)
    } else if (children.length !== 1 || children[0]!.webContents.id !== active.webContentsId) {
      this.violation('P16', `attached views are not exactly the active one (${children.length})`)
    }

    this.checkIpcOrder()
  }

  /** P9: main never receives a close before the open of the same launch. */
  private checkIpcOrder(): void {
    const opened = new Set<LaunchId>()
    for (const entry of this.ipcTrace) {
      if (entry.op === 'open') opened.add(entry.launchId)
      else if (!opened.has(entry.launchId)) {
        this.violation('P9', `close(${short(entry.launchId)}) reached main before its open`)
      }
    }
  }

  /** What the user ends up with; must not depend on how the world interleaved. */
  outcome() {
    const state = this.machine.getSnapshot()
    const active = getActiveSandboxUi()
    return {
      activeAppTabId: state.activeAppTabId,
      hasOwner: state.owner !== null,
      savedRoutes: this.tabs.tabs.map(tab => [tab.id, tab.app?.savedRoutePath] as const),
      liveView: active?.launchId ?? null,
      liveViewOpenedAt: active
        ? this.ipcTrace.find(entry => entry.op === 'open' && entry.launchId === active.launchId)
            ?.routePath
        : null,
      attached: this.parent.contentView.children.length,
    }
  }

  report(): string {
    return [...this.violations, '--- log ---', ...this.log.slice(-60)].join('\n')
  }
}

// ─── Arbitraries ───────────────────────────────────────────────────────────

const tabIndex = fc.nat({ max: 7 })

const gestureArb: fc.Arbitrary<Gesture> = fc.oneof(
  { weight: 5, arbitrary: tabIndex.map(tab => ({ type: 'select', tab }) as const) },
  { weight: 1, arbitrary: fc.constant({ type: 'reclick' } as const) },
  { weight: 2, arbitrary: fc.constant({ type: 'relaunch' } as const) },
  { weight: 1, arbitrary: fc.constant({ type: 'backToApps' } as const) },
  { weight: 1, arbitrary: tabIndex.map(tab => ({ type: 'handoff', tab }) as const) },
  { weight: 1, arbitrary: tabIndex.map(tab => ({ type: 'closeTab', tab }) as const) },
  {
    weight: 2,
    arbitrary: fc
      .constantFrom<AppName>('alpha', 'beta', 'gamma')
      .map(app => ({ type: 'openTab', app }) as const),
  },
  { weight: 1, arbitrary: tabIndex.map(tab => ({ type: 'staleIntent', tab }) as const) }
)

const realityArb = fc.array(
  fc.constantFrom<Reality>(
    'crashDuringMount',
    'sessionDuringMount',
    'attachFailsDuringMount',
    'crash',
    'title',
    'navigate',
    'reload',
    'session',
    'cleanupThrows',
    'lateMeasurer',
    'parentClosed'
  ),
  { maxLength: 6 }
)

const LAUNCH_POOL = 32
const launchIdsArb = fc.uniqueArray(fc.uuid(), { minLength: LAUNCH_POOL, maxLength: LAUNCH_POOL })
const slotFailuresArb = fc.array(
  fc.nat({ max: 9 }).map(n => n === 0),
  { minLength: LAUNCH_POOL, maxLength: LAUNCH_POOL }
)

// ─── Suite ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  userDataDir = await mkdtemp(path.join(tmpdir(), 'clerum-embed-ownership-'))
})

afterAll(async () => {
  await rm(userDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  oracleFailures.length = 0
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('fetch', sandboxUiMintFetch)
  // The driver logs every injected failure; the properties judge them.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  await resetRealMain()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  if (oracleFailures.length > 0) {
    throw new Error(`the transition oracle threw:\n${oracleFailures.slice(0, 5).join('\n')}`)
  }
})

function assertClean(world: World): void {
  if (world.violations.length > 0) throw new Error(world.report())
}

describe('embed ownership against the real main process (properties)', () => {
  it('P1–P7, P9–P17 hold for any gestures under any interleaving with the real world', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(gestureArb, { minLength: 1, maxLength: 10 }),
        realityArb,
        launchIdsArb,
        slotFailuresArb,
        fc.boolean(),
        async (s, gestures, realities, launchIds, slotFailures, batch) => {
          const world = await World.create({
            sink: s,
            launchIds,
            slotFailures,
            batch,
            lateMeasurer: realities.includes('lateMeasurer'),
          })
          for (const reality of realities) world.scheduleReality(reality)
          s.scheduleSequence(
            gestures.map(gesture => ({
              label: `gesture ${gesture.type}`,
              builder: async () => {
                world.gesture(gesture)
              },
            }))
          )
          await drainScheduler(s)
          world.checkDrained()
          assertClean(world)
        }
      ),
      { numRuns: RUNS, ...(SEED === undefined ? {} : { seed: SEED }) }
    )
  })

  it('P8: the same intentions end in the same place under any interleaving', async () => {
    const runIntentions = async (
      s: fc.Scheduler,
      gestures: Gesture[],
      launchIds: string[],
      slotFailures: boolean[]
    ) => {
      const world = await World.create({ sink: s, launchIds, slotFailures })
      // Not `scheduleSequence`: it holds every other task while a step's builder
      // runs, and a step that waits for its launch would wait forever.
      let done = false
      const user = (async () => {
        for (const gesture of gestures) {
          await s.schedule(Promise.resolve(), `gesture ${gesture.type}`)
          const asked = world.gesture(gesture)
          // The user moves on once what they asked for has settled, a deep
          // link once its continuation has.
          if (typeof asked === 'string') await world.settled(asked)
          else if (asked) await asked
        }
      })().finally(() => {
        done = true
      })
      await drainScheduler(s, () => done)
      await user
      world.checkDrained()
      assertClean(world)
      return { outcome: world.outcome(), order: s.report().map(task => task.label) }
    }
    let runs = 0
    let reordered = 0
    await fc.assert(
      // The two schedulers must not sit next to each other: fast-check 4.9 gives
      // adjacent ones the same task order, and P8 then compares a run with itself.
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(gestureArb, { minLength: 1, maxLength: 8 }),
        launchIdsArb,
        slotFailuresArb,
        fc.scheduler(),
        async (first, gestures, launchIds, slotFailures, second) => {
          const a = await runIntentions(first, gestures, launchIds, slotFailures)
          const b = await runIntentions(second, gestures, launchIds, slotFailures)
          runs += 1
          if (a.order.join('\n') !== b.order.join('\n')) reordered += 1
          expect(b.outcome).toEqual(a.outcome)
        }
      ),
      { numRuns: P8_RUNS, ...(SEED === undefined ? {} : { seed: SEED }) }
    )
    // Guards against P8 going vacuous again: most runs must really compare two
    // different interleavings.
    if (runs >= P8_GUARD_MIN_RUNS) expect(reordered / runs).toBeGreaterThan(0.4)
  })
})

// ─── Named cases ───────────────────────────────────────────────────────────
// Exact orderings, through the same real main process. Ported from the
// ownership cases the App suite pinned with a hand-written bridge. Where those
// relaunched the app by re-clicking its live tab, these use `relaunch`: a
// re-click with a live view now changes nothing (K15).

async function manualWorld(options: Partial<WorldOptions> = {}) {
  const sink = new ManualSink()
  const world = await World.create({ sink, ...options })
  return { sink, world }
}

const TAB_ALPHA = 'ws-tab-2'
const TAB_BETA = 'ws-tab-3'

async function liveOn(world: World, sink: ManualSink, tabId: string): Promise<LaunchId> {
  const launchId = world.selectTab(tabId)!
  await sink.runAll()
  expect(getActiveSandboxUi()?.launchId).toBe(launchId)
  return launchId
}

function closesSent(world: World): LaunchId[] {
  return world.ipcTrace.filter(entry => entry.op === 'close').map(entry => entry.launchId)
}

function expectNoView(world: World): void {
  expect(getActiveSandboxUi()).toBeNull()
  expect(world.parent.contentView.children).toEqual([])
}

const isLabel =
  (...parts: string[]) =>
  (label: string) =>
    parts.every(part => label.includes(part))

describe('embed ownership named cases (real main process)', () => {
  it('K5: a relaunch whose open main rejects leaves no view, and leaving has nothing to close', async () => {
    const { sink, world } = await manualWorld()
    const first = await liveOn(world, sink, TAB_ALPHA)

    world.failingRecipes.add('alpha')
    const relaunched = world.relaunch()!
    await sink.runAll()

    expect(world.outcomes.get(relaunched)).toBe('failed')
    expect(world.machine.getSnapshot().failure).toMatchObject({
      launchId: relaunched,
      kind: 'open',
    })
    expectNoView(world)

    world.selectTab('chat-tab-1')
    await sink.runAll()
    expect(closesSent(world)).toEqual([first])
    expectNoView(world)
    world.checkDrained()
    assertClean(world)
  })

  it('K5: a relaunch whose slot never measures closes the old view and sends no open', async () => {
    const { sink, world } = await manualWorld({ slotFailures: [false, true] })
    const first = await liveOn(world, sink, TAB_ALPHA)

    const relaunched = world.relaunch()!
    await sink.runAll()

    expect(world.outcomes.get(relaunched)).toBe('failed')
    expect(world.machine.getSnapshot().failure).toMatchObject({
      launchId: relaunched,
      kind: 'slot',
    })
    expect(world.ipcTrace.some(e => e.op === 'open' && e.launchId === relaunched)).toBe(false)
    expect(closesSent(world)).toEqual([first])
    expectNoView(world)
    world.checkDrained()
    assertClean(world)
  })

  it('K5: an app-to-app switch whose open fails leaves no view behind', async () => {
    const { sink, world } = await manualWorld()
    const first = await liveOn(world, sink, TAB_ALPHA)

    const failing = world.openTab('gamma')
    await sink.runAll()
    expect(world.outcomes.get(failing)).toBe('failed')
    expectNoView(world)

    world.selectTab('chat-tab-1')
    await sink.runAll()
    expect(closesSent(world)).toEqual([first])
    expectNoView(world)
    world.checkDrained()
    assertClean(world)
  })

  it('an app opened from the picker as its own tab owns the view and closes it on leave', async () => {
    const { sink, world } = await manualWorld()
    const opened = world.openTab('alpha')
    await sink.runAll()
    const tab = activeWorkspaceTab(world.tabs)
    expect(tab?.app?.appRef).toBe(APPS.alpha)
    expect(world.machine.getSnapshot().owner).toBe(opened)
    expect(getActiveSandboxUi()?.launchId).toBe(opened)

    world.selectTab('chat-tab-1')
    await sink.runAll()
    expect(closesSent(world)).toEqual([opened])
    expectNoView(world)
    world.checkDrained()
    assertClean(world)
  })

  it('K3: the replaced view crashing while a relaunch waits for it does not cost the relaunch its ownership', async () => {
    const { sink, world } = await manualWorld()
    const first = await liveOn(world, sink, TAB_ALPHA)

    const relaunched = world.relaunch()!
    // The close of the old view is still on its way to main when its renderer dies.
    world.reality('crash')
    await sink.runAll()

    expect(world.releases.map(r => [r.launchId, r.reason])).toEqual([[first, 'crashed']])
    expect(world.machine.getSnapshot().owner).toBe(relaunched)
    expect(world.machine.getSnapshot().failure).toBeNull()
    expect(getActiveSandboxUi()?.launchId).toBe(relaunched)

    world.selectTab('chat-tab-1')
    await sink.runAll()
    expect(closesSent(world)).toEqual([first, relaunched])
    expectNoView(world)
    world.checkDrained()
    assertClean(world)
  })

  it("K3: a refresh failure of the view a relaunch replaced never reaches the page; the live view's does", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { sink, world } = await manualWorld()
    const first = await liveOn(world, sink, TAB_ALPHA)

    // rpc-proxy starts refusing: the first view's session loop gives up and reports it.
    world.failingRecipes.add('alpha')
    world.immediateMints = true
    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(sink.labels().some(isLabel('sandboxUi:refreshError', short(first)))).toBe(true)

    // The report is still on the wire when the user relaunches.
    world.failingRecipes.delete('alpha')
    world.immediateMints = false
    const relaunched = world.relaunch()!
    await sink.runAll()
    expect(world.machine.getSnapshot().owner).toBe(relaunched)
    expect(world.refreshErrors).toEqual([])

    world.failingRecipes.add('alpha')
    world.immediateMints = true
    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
    await vi.advanceTimersByTimeAsync(120_000)
    await sink.runAll()
    expect(world.refreshErrors).toHaveLength(1)
    expect(world.refreshErrors[0]!.launchId).toBe(relaunched)
    expect(world.refreshErrors[0]!.message).toContain('503')
  })

  it('K4: the late release of the app an app-to-app switch replaced keeps the new owner', async () => {
    const { sink, world } = await manualWorld()
    const first = await liveOn(world, sink, TAB_ALPHA)

    const second = world.selectTab(TAB_BETA)!
    // Everything but the release of the first view, which arrives last.
    await sink.runAll(isLabel('sandboxUi:released', short(first)))
    expect(world.machine.getSnapshot().owner).toBe(second)
    await sink.runAll()

    expect(world.machine.getSnapshot().owner).toBe(second)
    expect(getActiveSandboxUi()?.launchId).toBe(second)
    expect(world.tabs.tabs.find(t => t.id === TAB_ALPHA)?.app?.savedRoutePath).toBe(`/r/${first}`)

    world.selectTab('chat-tab-1')
    await sink.runAll()
    expect(closesSent(world)).toEqual([first, second])
    expectNoView(world)
    world.checkDrained()
    assertClean(world)
  })

  it('K4: a superseded open that mounts and then crashes does not take the newer launch its ownership', async () => {
    const { sink, world } = await manualWorld()
    const first = world.selectTab(TAB_ALPHA)!
    // Alpha's open reaches main; its mint is held.
    await sink.runAll(isLabel('mint alpha'))
    expect(world.ipcTrace.map(e => [e.op, e.launchId])).toEqual([['open', first]])

    const second = world.selectTab(TAB_BETA)!
    // Alpha mounts while its close and Beta's open are still on the wire, and dies.
    await sink.runAll(isLabel('ipc→main'))
    expect(getActiveSandboxUi()?.launchId).toBe(first)
    world.reality('crash')
    await sink.runAll()

    expect(world.machine.getSnapshot().owner).toBe(second)
    expect(world.machine.getSnapshot().failure).toBeNull()
    expect(getActiveSandboxUi()?.launchId).toBe(second)
    world.checkDrained()
    assertClean(world)
  })

  it('K7: the owner crashing drops its ownership, shows the crash and leaves nothing to close', async () => {
    const { sink, world } = await manualWorld()
    const live = await liveOn(world, sink, TAB_BETA)

    world.reality('crash')
    await sink.runAll()
    expect(world.machine.getSnapshot().owner).toBeNull()
    expect(world.machine.getSnapshot().failure).toEqual({
      tabId: TAB_BETA,
      launchId: live,
      kind: 'crashed',
    })
    // A crash never hands its route back.
    expect(world.tabs.tabs.find(t => t.id === TAB_BETA)?.app?.savedRoutePath).toBeUndefined()

    world.selectTab('chat-tab-1')
    await sink.runAll()
    expect(closesSent(world)).toEqual([])
    expectNoView(world)
    world.checkDrained()
    assertClean(world)
  })

  it('K15: re-clicking the active tab while its view is alive changes nothing', async () => {
    const { sink, world } = await manualWorld()
    const live = await liveOn(world, sink, TAB_ALPHA)
    const trace = world.ipcTrace.length

    const reclicked = world.reclick()!
    await sink.runAll()

    expect(world.outcomes.get(reclicked)).toBe('abandoned')
    expect(world.ipcTrace).toHaveLength(trace)
    expect(world.machine.getSnapshot().owner).toBe(live)
    expect(getActiveSandboxUi()?.launchId).toBe(live)
    world.checkDrained()
    assertClean(world)
  })

  it('K20/K25: a view whose renderer dies before its open resolves fails with a crash failure', async () => {
    const { sink, world } = await manualWorld()
    world.crashNextLoad = true

    const launchId = world.selectTab(TAB_ALPHA)!
    await sink.runAll()

    // main reports the release first, then rejects the open.
    expect(world.releases).toEqual([{ launchId, reason: 'crashed', location: null }])
    expect(world.outcomes.get(launchId)).toBe('failed')
    expect(world.machine.getSnapshot().failure).toEqual({
      tabId: TAB_ALPHA,
      launchId,
      kind: 'crashed',
    })
    expect(world.machine.getSnapshot().owner).toBeNull()
    expectNoView(world)
  })

  it('K20: a view mounted under a session that ends before its open settles is abandoned', async () => {
    const { sink, world } = await manualWorld()
    world.sessionChangeNextLoad = true

    const launchId = world.selectTab(TAB_ALPHA)!
    await sink.runAll()

    expect(world.releases).toEqual([
      { launchId, reason: 'session', location: { routePath: `/r/${launchId}` } },
    ])
    expect(world.outcomes.get(launchId)).toBe('abandoned')
    expect(world.machine.getSnapshot().failure).toBeNull()
    expectNoView(world)
    world.checkDrained()
    assertClean(world)
  })

  it('K26: an open that mounts and then fails shows its error and fails its launch', async () => {
    const { sink, world } = await manualWorld()
    world.attachFailsNextMount = true

    const launchId = world.selectTab(TAB_ALPHA)!
    await sink.runAll()

    const snapshot = world.machine.getSnapshot()
    const view = embedViewState(snapshot)
    expect(view.kind).toBe('failed')
    expect(view.kind === 'failed' && embedFailureMessage(view.failure)).toBe('attach failed')
    expect(world.outcomes.get(launchId)).toBe('failed')
    // main releases the view it mounted before rejecting the open, and the
    // route it was asked for still reaches the tab.
    expect(world.releases).toEqual([
      { launchId, reason: 'open_failed', location: { routePath: `/r/${launchId}` } },
    ])
    expect(world.tabs.tabs.find(tab => tab.id === TAB_ALPHA)?.app?.savedRoutePath).toBe(
      `/r/${launchId}`
    )
    expect(snapshot.owner).toBeNull()
    expectNoView(world)
    world.checkDrained()
    assertClean(world)
  })

  it('K26: a relaunch between the release and the rejection waits for the failed open, then opens', async () => {
    const { sink, world } = await manualWorld()
    world.attachFailsNextMount = true

    const failed = world.selectTab(TAB_ALPHA)!
    // Main's release of the failed view reaches the renderer; the open's
    // rejection is still on the wire behind it.
    await sink.runAll(isLabel('ipc→renderer reply sandboxUi:open', short(failed)))
    expect(world.releases.map(release => release.reason)).toEqual(['open_failed'])
    expect(world.machine.getSnapshot().views.get(failed)?.phase).toBe('releasedOpening')
    const relaunched = world.relaunch()!
    // Main already let the failed view go: nothing is sent to close it, and the
    // relaunch measures only once the failed open has settled.
    expect(closesSent(world)).toEqual([])
    expect(world.machine.getSnapshot().views.get(relaunched)?.phase).toBe('waiting')
    await sink.runAll()

    expect(world.outcomes.get(failed)).toBe('abandoned')
    expect(world.outcomes.get(relaunched)).toBe('mounted')
    expect(getActiveSandboxUi()?.launchId).toBe(relaunched)
    expect(closesSent(world)).toEqual([])
    world.checkDrained()
    assertClean(world)
  })

  it('K26: coming back to the tab before the failed open rejects launches it again', async () => {
    const { sink, world } = await manualWorld()
    world.attachFailsNextMount = true

    const failed = world.selectTab(TAB_ALPHA)!
    await sink.runAll(isLabel('ipc→renderer reply sandboxUi:open', short(failed)))
    world.selectTab(TAB_BETA)
    const back = world.selectTab(TAB_ALPHA)!
    await sink.runAll()

    expect(world.outcomes.get(failed)).toBe('abandoned')
    expect(world.outcomes.get(back)).toBe('mounted')
    expect(getActiveSandboxUi()?.launchId).toBe(back)
    world.checkDrained()
    assertClean(world)
  })

  it('K6: back to apps closes the view but keeps its tab; a pick from the grid opens its own tab', async () => {
    const { sink, world } = await manualWorld()
    const first = await liveOn(world, sink, TAB_ALPHA)

    world.backToApps()
    await sink.runAll()
    expect(closesSent(world)).toEqual([first])
    expect(world.tabs.activeTabId).toBe(TAB_ALPHA)
    expectNoView(world)

    const picked = world.openTab('beta')
    await sink.runAll()
    expect(world.tabs.activeTabId).not.toBe(TAB_ALPHA)
    expect(world.tabs.tabs.find(t => t.id === TAB_ALPHA)).toMatchObject({
      title: 'Alpha',
      app: { appRef: APPS.alpha, savedRoutePath: `/r/${first}` },
    })
    expect(getActiveSandboxUi()?.launchId).toBe(picked)
    world.checkDrained()
    assertClean(world)
  })

  it("K3: only the owner's titles rename its tab; a relaunch's predecessor cannot", async () => {
    const { sink, world } = await manualWorld()
    const first = await liveOn(world, sink, TAB_ALPHA)
    const alphaTitle = () => world.tabs.tabs.find(t => t.id === TAB_ALPHA)?.title

    world.reality('title')
    await sink.runAll()
    expect(alphaTitle()).toBe(`title ${first}`)

    const relaunched = world.relaunch()!
    // main only forwards titles of its active view, still the first one.
    world.reality('title')
    await sink.runAll()
    expect(alphaTitle()).toBe(`title ${first}`)

    world.reality('title')
    await sink.runAll()
    expect(getActiveSandboxUi()?.launchId).toBe(relaunched)
    expect(alphaTitle()).toBe(`title ${relaunched}`)
    world.checkDrained()
    assertClean(world)
  })

  it('K6: activating an app tab with no launch closes the live view and keeps its route on its own tab', async () => {
    const { sink, world } = await manualWorld()
    const first = await liveOn(world, sink, TAB_BETA)

    // Alpha's app cannot be resolved right now: its tab activates without a launch.
    world.commitOnly(TAB_ALPHA)
    await sink.runAll()
    expect(closesSent(world)).toEqual([first])
    expectNoView(world)
    expect(world.tabs.tabs.find(t => t.id === TAB_BETA)?.app?.savedRoutePath).toBe(`/r/${first}`)
    expect(world.tabs.tabs.find(t => t.id === TAB_ALPHA)?.app?.savedRoutePath).toBeUndefined()
    expect(world.tabs.tabs.find(t => t.id === TAB_ALPHA)?.title).toBe('Alpha')

    // Once the app is back, re-clicking its tab launches it.
    const launched = world.reclick()!
    await sink.runAll()
    expect(getActiveSandboxUi()?.launchId).toBe(launched)
    world.checkDrained()
    assertClean(world)
  })

  it('K6: moving to an app tab with no launch drops the failure of the tab left behind', async () => {
    const { sink, world } = await manualWorld()
    await liveOn(world, sink, TAB_ALPHA)
    world.failingRecipes.add('alpha')
    world.relaunch()
    await sink.runAll()
    expect(world.machine.getSnapshot().failure?.tabId).toBe(TAB_ALPHA)

    world.commitOnly(TAB_BETA)
    await sink.runAll()

    expect(world.machine.getSnapshot().failure).toBeNull()
    expectNoView(world)
  })

  it('K8: closing a tab while its view opens or measures leaves only the neighbour it activates', async () => {
    const { sink, world } = await manualWorld()
    const opening = world.selectTab(TAB_ALPHA)!
    // The open is in main, its mint not answered yet. Closing Alpha activates
    // Beta, its neighbour, which the seam launches.
    await sink.runAll(isLabel('mint alpha'))
    const neighbour = world.closeTab(TAB_ALPHA)!
    await sink.runAll()
    expect(world.outcomes.get(opening)).toBe('abandoned')
    expect(closesSent(world)).toEqual([opening])
    expect(getActiveSandboxUi()?.launchId).toBe(neighbour)

    // Gamma is closed before its slot is measured: main never hears of it.
    const measuring = world.selectTab('ws-tab-4')!
    const next = world.closeTab('ws-tab-4')!
    await sink.runAll()
    expect(world.outcomes.get(measuring)).toBe('abandoned')
    expect(world.ipcTrace.some(e => e.launchId === measuring)).toBe(false)
    expect(getActiveSandboxUi()?.launchId).toBe(next)
    world.checkDrained()
    assertClean(world)
  })

  it('K17: leaving an app while its document loads keeps the route it was asked for', async () => {
    const { sink, world } = await manualWorld()
    const first = await liveOn(world, sink, TAB_ALPHA)
    world.backToApps()
    await sink.runAll()
    const relaunched = world.reclick()!
    // Opened at the first view's route; the document has not committed yet.
    await sink.runAll(isLabel('commit'))
    expect(getActiveSandboxUi()?.launchId).toBe(relaunched)
    expect(world.ipcTrace.at(-1)).toMatchObject({ op: 'open', routePath: `/r/${first}` })

    world.selectTab('chat-tab-1')
    await sink.runAll()

    expect(world.releases.at(-1)).toEqual({
      launchId: relaunched,
      reason: 'closed',
      location: { routePath: `/r/${first}` },
    })
    expect(world.tabs.tabs.find(t => t.id === TAB_ALPHA)?.app?.savedRoutePath).toBe(`/r/${first}`)
    world.checkDrained()
    assertClean(world)
  })

  it('K24: a teardown whose cleanups throw still releases the view and detaches it', async () => {
    const { sink, world } = await manualWorld()
    const first = await liveOn(world, sink, TAB_ALPHA)
    world.reality('cleanupThrows')

    world.selectTab('chat-tab-1')
    await sink.runAll()

    expect(world.releases.map(r => r.launchId)).toEqual([first])
    expect(world.machine.getSnapshot().views.size).toBe(0)
    expectNoView(world)
    world.checkDrained()
    assertClean(world)
  })

  it('I-commit broken on purpose: a launch dispatched before its commit is abandoned and the tab has no owner', async () => {
    const { sink, world } = await manualWorld()
    const launchId = world.selectBreakingCommitOrder(TAB_ALPHA)
    await sink.runAll()

    expect(world.tabs.activeTabId).toBe(TAB_ALPHA)
    expect(world.outcomes.get(launchId)).toBe('abandoned')
    expect(world.machine.getSnapshot().owner).toBeNull()
    expect(world.ipcTrace).toEqual([])
    expectNoView(world)
  })
})
