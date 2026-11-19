import type { GfsBrowserChild, GfsCrumb } from '@hooks/domain/useGfsBrowserController'
import type { useGfsResourceOperations } from '@hooks/domain/useGfsResourceOperations'
import type { Tone } from '@/uiTypes'
import type { GfsDragSource } from './dragSession.types'
import type { MoveCommitOutcome } from './moveCommit'

type GfsResourceOperations = ReturnType<typeof useGfsResourceOperations>

/** What one explicit move commit dispatches through, whoever owns it. */
export interface GfsExplicitMoveCommitDeps {
  ops: Pick<GfsResourceOperations, 'moveResource' | 'convergeCommittedMove'>
  /** Fail-closed classifier for a move rejection; true when the session died. */
  handleAuthorityFailure: (message: string, scope: string) => boolean
  /** Names already cached in a destination, for the numbered-name ladder. */
  occupiedDestinationNames: (destinationId: string) => Set<string>
  pushToast: (message: string, tone: Tone) => void
}

export interface GfsExplicitMoveCommitOptions {
  /** Gesture or dialog ownership, re-checked before every dispatch attempt. */
  isCurrent?: () => boolean
  /** Whether the owner may still show this move's outcome toasts. */
  isPresentationCurrent?: () => boolean
  /** False when the owner presents the outcome itself. */
  reportOutcomes?: boolean
  /** Main's session generation, captured before the commit. */
  authoritativeSessionGeneration?: number
}

export type GfsExplicitMoveCommit = (
  source: GfsDragSource,
  destination: { resourceId: string; name: string },
  options: GfsExplicitMoveCommitOptions
) => Promise<MoveCommitOutcome>

/** The resource the Move dialog moves, and the path it opens on. */
export interface GfsExplicitMoveTarget {
  node: GfsBrowserChild
  initialCrumbs: GfsCrumb[]
}

export interface GfsExplicitMoveDialogProps {
  target: GfsExplicitMoveTarget
  sessionScope: string | null
  sessionGeneration: number | null
  /** The shared access flag is active for the live session. */
  accessActive: boolean
  /** The owner's in-flight state (its operations are pending). */
  busy: boolean
  /** The owner still shows this dialog for this target. */
  isOwnerCurrent: () => boolean
  /**
   * Whether the owner may still present this source's outcome. It outlives
   * the dialog: a move closed while its PATCH is in flight still reports.
   */
  isPresentationCurrent: (source: GfsDragSource) => boolean
  /** The owner's drag-gesture epoch the move source is stamped with. */
  sourceGeneration: () => number
  commitMove: GfsExplicitMoveCommit
  /** Fail-closed boundary for the dialog's authority reads. */
  handleAuthorityFailure: (
    message: string,
    scope: string | null,
    sessionGeneration: number | null
  ) => boolean
  /** Presents a finished move's outcome; the owner decides whether it is still its to show. */
  reportOutcome: (
    outcome: MoveCommitOutcome,
    source: GfsDragSource,
    destinationName: string
  ) => void | Promise<void>
  onClose: () => void
}
