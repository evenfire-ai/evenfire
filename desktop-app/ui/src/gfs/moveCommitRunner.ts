import type { GfsDragSource } from './dragSession.types'
import { commitGfsMove, toastMoveOutcome } from './moveCommit'
import type { MoveCommitOutcome, MoveToast } from './moveCommit'

/**
 * The surface-level operations the shared commit path needs. They are the
 * controller's own operations, passed in so this module stays free of React
 * and of the controller's shape.
 */
export interface GfsMoveCommitRunnerDeps {
  /** One move PATCH attempt; ifMatch is mandatory client policy. */
  moveResource: (
    resourceId: string,
    destinationId: string,
    ifMatch?: number,
    newName?: string,
    oldParentId?: string | null
  ) => Promise<{ resourceId: string; version: number }>
  /** Central fail-closed classifier; returns true when the session died. */
  handleAuthorityFailure: (message: string) => boolean
  /**
   * Convergence for a move that landed WITHOUT a receipt (transport loss):
   * the mutation rejected, so its success path never ran.
   */
  convergeCommittedMove: (
    input: { resourceId: string; destinationId: string; oldParentId: string | null },
    receipt: { version: number }
  ) => Promise<void> | void
  /** Transient outcome toasts; omitted where a surface shows its own. */
  pushToast?: MoveToast
}

/** One move request, independent of the surface that produced it. */
export interface GfsMoveCommitRequest {
  source: GfsDragSource
  destination: { resourceId: string; name: string }
  /** Numbered renaming is pre-approved (source write proved or confirmed). */
  allowNumberedRename: boolean
  /** Names already known to be taken in the destination, when cached. */
  occupiedDestinationNames?: ReadonlySet<string>
  /**
   * Gesture-ownership predicate, absent on paths that own no gesture (the
   * explicit Move dialog). Checked before every dispatch attempt.
   */
  isCurrent?: () => boolean
}

/**
 * The ONE move commit path for every Desktop surface (rev-2 §5): the Files
 * page, the sidebar file explorer and the Move-dialog adapters all dispatch
 * through it. The surfaces used to re-implement the same wrapper — the
 * deps, the plan, the outcome toasts and the transport-loss convergence —
 * and every divergence between them started there.
 *
 * Behavior (unchanged, now stated once):
 * - the source is re-resolved immediately before dispatch: its fresh version
 *   is the ifMatch, its fresh parent is the convergence's old parent;
 * - a transport loss is verified by resolve, never re-PATCHed, and the
 *   verified-committed outcome still converges the cache;
 * - the outcome toasts are the shared UX matrix copy.
 */
export async function runGfsMoveCommit(
  deps: GfsMoveCommitRunnerDeps,
  request: GfsMoveCommitRequest
): Promise<MoveCommitOutcome> {
  const { source, destination, allowNumberedRename } = request
  // A transport loss after dispatch leaves the dispatch unconfirmed even
  // though the PATCH may have landed.
  let dispatchConfirmed = false
  const outcome = await commitGfsMove(
    {
      resolveSource: async gfsUri => {
        const resolved = await window.clerum.gfs.resolve(gfsUri)
        return {
          resourceId: resolved.resourceId,
          gfsUri,
          kind: resolved.kind === 'directory' ? 'directory' : 'file',
          name: resolved.name,
          version: resolved.version,
          parentResourceId: resolved.parentResourceId,
        }
      },
      moveResource: async (resourceId, destinationId, ifMatch, newName, oldParentId) => {
        const receipt = await deps.moveResource(
          resourceId,
          destinationId,
          ifMatch,
          newName,
          oldParentId
        )
        dispatchConfirmed = true
        return receipt
      },
      isSessionAuthorityFailure: error =>
        deps.handleAuthorityFailure(error instanceof Error ? error.message : String(error)),
      ...(request.isCurrent ? { isCurrent: request.isCurrent } : {}),
    },
    {
      source: {
        resourceId: source.resourceId,
        gfsUri: source.gfsUri,
        kind: source.kind,
        name: source.name,
      },
      destination,
      allowNumberedRename,
      ...(request.occupiedDestinationNames
        ? { occupiedDestinationNames: request.occupiedDestinationNames }
        : {}),
    }
  )
  if (outcome.status === 'committed' && !dispatchConfirmed) {
    // The PATCH landed but the response was lost: the dispatch never
    // confirmed, so the convergence it would have run never ran. The item
    // HAS moved — converge the cache now so it stops rendering in the old
    // folder.
    await deps.convergeCommittedMove(
      {
        resourceId: source.resourceId,
        destinationId: destination.resourceId,
        oldParentId: outcome.previousParentId,
      },
      { version: outcome.version }
    )
  }
  toastMoveOutcome(deps.pushToast, outcome, source.name, destination.name, source.kind)
  return outcome
}
