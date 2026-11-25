import type { ReactNode, Ref } from 'react'
import type { ToastOptions } from '@components/Toast/types'
import type { HostResource } from '@lib/api'
import type { ApprovalTabState } from '@lib/hostApprovalDisplay'
import type { OffSwitchOutcome } from '@lib/hostApprovalSave'

export interface HostApprovalsTabProps {
  /**
   * The agent (Host) the tab shows. A kept instance given another agent shows
   * that agent from its own first load: nothing of the previous one stays.
   */
  host: string
  /**
   * Called when the admin presses the tab's Retry, alongside the tab's own
   * reload. The host page uses it to retry its own read of the agent if that
   * read failed; the tab reads nothing of the page's state.
   */
  onRetry?: () => void
}

/**
 * What the tab shows for one agent. A new view, with a new display state,
 * starts whenever the tab is given another agent; its `host` and `state` never
 * change after that.
 */
export interface ApprovalsTabView {
  host: string
  /** The agent's display state (spec §6.5): load epochs, write groups. */
  state: ApprovalTabState
  /**
   * `state.snapshot()` as of the last load or write the state applied: null
   * until a load applies.
   */
  snapshot: HostResource | null
  /**
   * Whether the newest load has not settled, applied or failed. It is the Save
   * release the per-tool section waits for (spec §6.4 step 10, C10, A4 L2).
   */
  loadPending: boolean
  /**
   * The failure of the last load that settled, for the tab's banner. It stays
   * while a newer load runs, until that load settles; null once a load
   * applied.
   */
  loadError: string | null
  /**
   * The outcome of the last "Set to Manual now" this tab ran that settled
   * while it showed this agent (spec §6.3 step 7). Null until one does, and
   * from the next press until that run settles.
   */
  switchResult: OffSwitchOutcome | null
}

/** A load's end, as the tab applies it. */
export type LoadResult = { kind: 'answered'; host: unknown } | { kind: 'failed'; error: unknown }

/**
 * A root toast: for an outcome the tab no longer shows (spec §6.5 "After
 * unmount"), or for a failed "Set to Manual now" (spec §6.3 step 7).
 */
export interface ContinuationToast {
  message: string
  options: ToastOptions
}

export interface OffSwitchProps {
  /** The agent the tab shows. */
  host: string
  /** The outcome to show (`ApprovalsTabView.switchResult`). */
  result: OffSwitchOutcome | null
  /** Starts the switch for `host`. Called only while no switch runs for it. */
  onSetManual: () => void
}

/** A run that stored Manual or found it (spec §6.3 step 7). */
export interface SavedResultProps {
  outcome: Extract<OffSwitchOutcome, { kind: 'saved' | 'already' }>
}

/** A run that failed (spec §6.3 step 6). */
export interface FailedResultProps {
  outcome: Extract<OffSwitchOutcome, { kind: 'failed' }>
}

export interface ReadViewProps {
  /** The Host the tab shows. */
  host: HostResource
}

export interface ApprovalModesViewProps extends ReadViewProps {
  /** The view's heading, which the tab focuses after a Retry that loads (Ruling 46). */
  headingRef?: Ref<HTMLHeadingElement>
}

export interface ReadRowProps {
  label: string
  /** The row's value, shown first. */
  value: ReactNode
  /** Notes under the value, each its own paragraph; a note's text is its key. */
  notes?: readonly string[]
  children?: ReactNode
}

export interface LoadErrorBannerProps {
  message: string
  /** A load is running: Retry waits for it to settle. */
  pending: boolean
  onRetry: () => void
}
