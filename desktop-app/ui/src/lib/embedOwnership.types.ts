import type { SandboxUiReleaseReason, SandboxUiRoute } from '../../../src/types'

export type TabId = string

/** Opaque, unique across renderer lifetimes (main outlives a renderer reload). */
export type LaunchId = string

export type Bounds = { x: number; y: number; width: number; height: number; dpr?: number }

/**
 * `route.kind === 'tab'` reopens wherever the tab was left; `'explicit'` (deep
 * link) always opens at `route.routePath`. `app` is what the interpreter needs to
 * build the open call; the reducer only carries it and never decides on it.
 */
export type Launch = {
  launchId: LaunchId
  tabId: TabId
  appRef: string
  route: { kind: 'tab' | 'explicit'; routePath?: string }
  app: { label?: string; defaultPath?: string }
}

export type ViewPhase =
  /** Owner whose tab still has a predecessor in main; waits for its final location. */
  | 'waiting'
  /** Measuring the slot; nothing sent to main yet. */
  | 'measuring'
  /** `sendOpen` emitted. */
  | 'opening'
  /** Main confirmed the mount. */
  | 'mounted'
  /** CAS close emitted; ends with `released`, a failed `openSettled` or `closeFailed`. */
  | 'closeRequested'
  /**
   * Main released the view of an open that failed after mounting it; the launch
   * still waits for that open's rejection, which carries the failure. Nothing
   * of it is left in main, so it is never closed.
   */
  | 'releasedOpening'

export type ViewRecord = Launch & { phase: ViewPhase }

export type EmbedFailureKind = 'slot' | 'open' | 'crashed'

export type EmbedFailure = {
  tabId: TabId
  launchId: LaunchId
  kind: EmbedFailureKind
  message?: string
}

export type EmbedHandoff = { requestId: number; waitFor: ReadonlySet<LaunchId> }

export type EmbedOwnershipState = {
  /** Projection of the committed tab store; only `projected` writes it. */
  activeAppTabId: TabId | null
  /**
   * Last route this reducer persisted per tab. The tab store lags one commit
   * behind `persistRoute`, so reopening must read it from here.
   */
  lastRoute: ReadonlyMap<TabId, SandboxUiRoute>
  /** When set: a key of `views` whose `tabId === activeAppTabId`. */
  owner: LaunchId | null
  views: ReadonlyMap<LaunchId, ViewRecord>
  handoffs: ReadonlyArray<EmbedHandoff>
  failure: EmbedFailure | null
}

export type EmbedReleaseReason = SandboxUiReleaseReason

export type EmbedEvent =
  | { type: 'projected'; activeAppTabId: TabId | null }
  | { type: 'intent'; launch: Launch }
  | { type: 'relaunch'; launch: Launch }
  | { type: 'backToApps' }
  | { type: 'handoff'; requestId: number }
  | { type: 'slotMeasured'; launchId: LaunchId; bounds: Bounds | null }
  | { type: 'openSettled'; launchId: LaunchId; outcome: 'mounted' | { failed: string } }
  | { type: 'closeFailed'; launchId: LaunchId }
  | {
      type: 'released'
      launchId: LaunchId
      reason: EmbedReleaseReason
      location: SandboxUiRoute | null
    }
  | { type: 'titleChanged'; launchId: LaunchId; title: string }

export type PersistedRoute = { action: 'set'; routePath: string } | { action: 'clear' }

export type LaunchOutcome = 'mounted' | 'failed' | 'abandoned'

export type EmbedEffect =
  | { type: 'measure'; launchId: LaunchId }
  | { type: 'sendOpen'; launch: Launch; bounds: Bounds; routePath?: string }
  /** Always compare-and-swap on `launchId` in main. */
  | { type: 'close'; launchId: LaunchId }
  | { type: 'persistRoute'; tabId: TabId; route: PersistedRoute }
  | { type: 'setTitle'; tabId: TabId; title: string }
  | { type: 'handoffReady'; requestId: number }
  | { type: 'launchSettled'; launchId: LaunchId; outcome: LaunchOutcome }

export type EmbedTransition = {
  state: EmbedOwnershipState
  effects: EmbedEffect[]
}
