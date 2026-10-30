import type { SandboxUiReleasedEvent } from '../../../src/types'
import type {
  Bounds,
  EmbedEffect,
  EmbedEvent,
  EmbedOwnershipState,
  Launch,
  LaunchId,
  LaunchOutcome,
} from './embedOwnership.types'
import type { WorkspaceTabsState } from './workspaceTabs.types'

/** The `sandboxUi.open` request, as the preload bridge takes it. */
export type EmbedOpenRequest = {
  launchId: LaunchId
  recipeNs: string
  recipeName: string
  title?: string
  defaultPath?: string
  routePath?: string
  bounds: Bounds
}

/**
 * The two lifecycle calls into main. Each must be invoked by the caller in the
 * order the machine asks for them and without deferring the call itself; only
 * the returned promise is awaited.
 */
export type EmbedOwnershipBridge = {
  open(request: EmbedOpenRequest): Promise<unknown>
  close(request: { launchId: LaunchId }): Promise<unknown>
}

/** Measures the embed slot for a launch; `null` when it never became measurable. */
export type EmbedSlotMeasurer = (launchId: LaunchId) => Promise<Bounds | null>

export type EmbedTabsUpdater = (state: WorkspaceTabsState) => WorkspaceTabsState

export type EmbedRefreshErrorEvent = { launchId: LaunchId; message: string }

export type EmbedRefreshRecoveredEvent = { launchId: LaunchId }

export type EmbedTitleChangedEvent = { launchId: LaunchId; title: string }

export type EmbedOwnershipMachineDeps = {
  bridge: EmbedOwnershipBridge
  /** Writes into the tab store; the updater is a no-op for a tab that no longer exists. */
  updateTabs: (updater: EmbedTabsUpdater) => void
  onHandoffReady?: (requestId: number) => void
  onHandoffFailed?: (requestId: number) => void
  /** Only refresh failures of the launch that owns the embed when they arrive. */
  onOwnerRefreshError?: (event: EmbedRefreshErrorEvent) => void
  /** Only recoveries of the launch that owns the embed when they arrive. */
  onOwnerRefreshRecovered?: (event: EmbedRefreshRecoveredEvent) => void
  /**
   * Every reduced event with the state around it and its effects, before the
   * effects run. It must not dispatch: it observes, it does not decide.
   */
  onTransition?: (transition: {
    event: EmbedEvent
    previous: EmbedOwnershipState
    next: EmbedOwnershipState
    effects: readonly EmbedEffect[]
  }) => void
}

export type EmbedOwnershipMachine = {
  subscribe(listener: () => void): () => void
  /** The reducer state; the same reference until a transition changes it. */
  getSnapshot(): EmbedOwnershipState
  dispatch(event: EmbedEvent): void
  projected(activeAppTabId: string | null): void
  intent(launch: Launch): void
  relaunch(launch: Launch): void
  backToApps(): void
  handoff(requestId: number): void
  /** Inlets for main's per-view events. */
  onReleased(event: SandboxUiReleasedEvent): void
  onTitleChanged(event: EmbedTitleChangedEvent): void
  onRefreshError(event: EmbedRefreshErrorEvent): void
  onRefreshRecovered(event: EmbedRefreshRecoveredEvent): void
  /** The page registers while its slot exists; measures wait until one is registered. */
  registerMeasurer(measurer: EmbedSlotMeasurer): () => void
  /**
   * Called before the launch is dispatched; resolves with its single outcome.
   * Registering again, even after it settled, returns the same promise.
   */
  registerWhenSettled(launchId: LaunchId): Promise<LaunchOutcome>
  /** The promise of a registered launch, settled or not. */
  whenSettled(launchId: LaunchId): Promise<LaunchOutcome> | undefined
  /** Registered launches that have not settled yet. */
  pendingWhenSettled(): number
  dispose(): void
}
