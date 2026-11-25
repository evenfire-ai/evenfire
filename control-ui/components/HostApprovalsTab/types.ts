import type { ReactNode } from 'react'
import type { ToastOptions } from '@components/Toast/types'
import type { HostResource } from '@lib/api'
import type { ApprovalTabState } from '@lib/hostApprovalDisplay'

export interface HostApprovalsTabProps {
  /**
   * The agent (Host) the tab shows. A kept instance given another agent shows
   * that agent from its own first load: nothing of the previous one stays.
   */
  host: string
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
}

/** A load's end, as the tab applies it. */
export type LoadResult = { kind: 'answered'; host: unknown } | { kind: 'failed'; error: unknown }

/** A root toast for a save the tab no longer shows (spec §6.5 "After unmount"). */
export interface ContinuationToast {
  message: string
  options: ToastOptions
}

export interface ReadViewProps {
  /** The Host the tab shows. */
  host: HostResource
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
