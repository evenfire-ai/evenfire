import {
  GFS_MOVE_MAX_NETWORK_ATTEMPTS,
  gfsHttpStatusOf,
  isGfsNameConflict,
  nextAvailableGfsResourceName,
} from '@clerum/gfs-interaction-policy'
import { describeGfsReadError, parseHttpStatus, parseRetryAfterSeconds } from '@lib/gfsGrantErrors'

/** Server truth from a commit-time resolve of the source. */
export interface MoveCommitSourceSnapshot {
  resourceId: string
  gfsUri: string
  kind: 'file' | 'directory'
  /** Server-observed name/version/parent right before dispatch. */
  name: string
  version: number
  parentResourceId: string | null
}

export type MoveCommitExpectedSourceSnapshot = Pick<
  MoveCommitSourceSnapshot,
  'resourceId' | 'version' | 'parentResourceId'
>

export interface MoveCommitPlan {
  source: { resourceId: string; gfsUri: string; kind: 'file' | 'directory'; name: string }
  destination: { resourceId: string; name: string }
  /** Pre-approved numbered-name conflict policy (rev-2 §5). */
  allowNumberedRename: boolean
  /** Explicit Move only: the target shown by the dialog, before its fresh resolve. */
  expectedSourceSnapshot?: MoveCommitExpectedSourceSnapshot
  /** Names already known to be taken in the destination, when cached. */
  occupiedDestinationNames?: ReadonlySet<string>
}

export type MoveCommitOutcome =
  | {
      status: 'committed'
      version: number
      renamedTo?: string
      /**
       * The parent the item lived in at COMMIT time (the fresh resolve's
       * observation, never the drag-start guess). The convergence needs the
       * real old parent to drop the item from that folder's cached listing —
       * including on the transport-loss path, where the mutation that would
       * normally converge it never succeeded.
       */
      previousParentId: string | null
    }
  | { status: 'no-op'; message: string }
  | { status: 'conflict-stopped'; message: string }
  | { status: 'changed'; message: string }
  | { status: 'destination-rejected'; message: string }
  | { status: 'source-unavailable'; message: string }
  | { status: 'target-unavailable'; message: string }
  | { status: 'rate-limited'; message: string; retryAfterSeconds?: number }
  | { status: 'unconfirmed'; message: string; retryPermissionCheck?: true }
  | { status: 'session-lost' }
  /** The gesture that asked for this move is gone; nothing was dispatched. */
  | { status: 'gesture-lost' }

export interface MoveCommitDeps {
  /** Resolve by stable URI; throws on 403/404/transport like the read plane. */
  resolveSource: (gfsUri: string) => Promise<MoveCommitSourceSnapshot>
  /**
   * One move PATCH attempt; ifMatch is mandatory client policy. The
   * `oldParentId` is the parent the COMMIT-TIME resolve observed — never the
   * gesture's drag-start guess — because the convergence has to drop the item
   * from the folder it really left. `null` means the physical root.
   */
  moveResource: (
    resourceId: string,
    destinationId: string,
    ifMatch: number,
    newName?: string,
    oldParentId?: string | null
  ) => Promise<{ resourceId: string; version: number }>
  /** Central fail-closed classifier; returns true when the session died. */
  isSessionAuthorityFailure: (error: unknown) => boolean
  /**
   * Gesture-ownership predicate, absent on paths that own no gesture (the
   * explicit Move dialog). A drag can be superseded WHILE the commit-time
   * resolve is in flight — a newer drag on another surface, a scope change, a
   * revoked session — and the PATCH would then move the item with a session
   * the user no longer owns. Checked immediately before every dispatch
   * attempt (so it also covers the numbered-name retries), never after.
   */
  isCurrent?: () => boolean
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const CONFLICT_STOPPED_MESSAGE =
  'An item with this name already exists. Choose another folder, or use Move to change its name if you have rename access.'

/**
 * A name conflict is a 409 and nothing else.
 *
 * The shared classifier also accepts body PROSE ("already exists"), and a
 * 5xx body can carry that prose while describing something else entirely
 * (an upstream conflict, a replayed error, a message about a different
 * resource). Treating such a response as a collision would skip the outcome
 * verification and re-PATCH the move under a NEW name — renaming an item the
 * server never rejected.
 *
 * The response's own status decides: the vetted `httpStatus=` marker first,
 * then the shared status reader for a response that never carried one. Only
 * when no status can be read at all does the prose classifier apply, because
 * it is then the only evidence available.
 */
function isNameConflictResponse(error: unknown, status: number | null): boolean {
  const effectiveStatus = status ?? gfsHttpStatusOf(error)
  if (effectiveStatus !== null) return effectiveStatus === 409
  return isGfsNameConflict(error)
}

/**
 * Shared move dispatch (rev-2 §5): one service called by the Files page,
 * the sidebar explorer and the Move-dialog adapters. Every attempt is ONE
 * PATCH with newParentId (+ optional newName for the whole-resource rename);
 * never a separate rename-then-move. The source is re-resolved immediately
 * before dispatch — its fresh version is the ifMatch, its fresh parent
 * re-checks the no-op guard, and a missing source stops the gesture.
 */
export async function commitGfsMove(
  deps: MoveCommitDeps,
  plan: MoveCommitPlan
): Promise<MoveCommitOutcome> {
  let snapshot: MoveCommitSourceSnapshot
  try {
    const resolved = await deps.resolveSource(plan.source.gfsUri)
    snapshot = {
      resourceId: resolved.resourceId,
      gfsUri: plan.source.gfsUri,
      kind: resolved.kind === 'directory' ? 'directory' : 'file',
      name: resolved.name,
      version: resolved.version,
      parentResourceId: resolved.parentResourceId,
    }
  } catch (error) {
    if (deps.isSessionAuthorityFailure(error)) return { status: 'session-lost' }
    const status = parseHttpStatus(messageOf(error))
    if (status === 404) {
      return {
        status: 'source-unavailable',
        message: 'EvenDrive cannot verify this item’s current location. Refresh and try again.',
      }
    }
    if (status === 403) {
      return {
        status: 'unconfirmed',
        message: 'EvenDrive could not confirm permission for this move. Refresh and try again.',
      }
    }
    return { status: 'unconfirmed', message: describeGfsReadError(error).message }
  }

  // An explicit Move dialog is consent for the exact resource snapshot it
  // showed. A same-URI resolve may find a newer version or parent; do not let
  // that retarget the user's confirmation. Drag callers omit this guard and
  // keep their commit-time snapshot/convergence behavior.
  const expectedSource = plan.expectedSourceSnapshot
  if (
    expectedSource &&
    (snapshot.resourceId !== expectedSource.resourceId ||
      snapshot.version !== expectedSource.version ||
      snapshot.parentResourceId !== expectedSource.parentResourceId)
  ) {
    return {
      status: 'changed',
      message:
        'This item changed while you were moving it. Review its current location and try again.',
    }
  }

  // Fresh-parent no-op guard before any request (a concurrent move may have
  // already relocated the item into the chosen destination).
  if (snapshot.parentResourceId === plan.destination.resourceId) {
    return { status: 'no-op', message: 'This item is already in this folder.' }
  }

  const occupied = new Set<string>(plan.occupiedDestinationNames ?? [])
  let moveName = snapshot.name

  for (let attempt = 0; attempt < GFS_MOVE_MAX_NETWORK_ATTEMPTS; attempt += 1) {
    // Ownership re-check (rev-2 §4.1): the gesture that asked for this move
    // may have been superseded while the commit-time resolve — or a previous
    // attempt — was in flight. A PATCH dispatched after that would move the
    // item under a session the user no longer owns, so the gesture is
    // re-validated at the dispatch boundary instead of only at admission.
    if (deps.isCurrent?.() === false) {
      // Every later attempt is a numbered retry after a dispatched 409. Keep
      // that server outcome when the owner disappears instead of erasing it
      // as a generic gesture loss; the surface still gates presentation.
      if (attempt > 0) {
        return { status: 'conflict-stopped', message: CONFLICT_STOPPED_MESSAGE }
      }
      return { status: 'gesture-lost' }
    }
    let error: unknown
    try {
      const receipt = await deps.moveResource(
        snapshot.resourceId,
        plan.destination.resourceId,
        snapshot.version,
        moveName === snapshot.name ? undefined : moveName,
        // The commit-time parent, so the convergence drops the item from the
        // folder it really left (the drag-start parent can be stale, or
        // unknown — and an unknown parent is not the physical root).
        snapshot.parentResourceId
      )
      return {
        status: 'committed',
        version: receipt.version,
        previousParentId: snapshot.parentResourceId,
        ...(moveName !== snapshot.name ? { renamedTo: moveName } : {}),
      }
    } catch (attemptError) {
      error = attemptError
    }
    if (deps.isSessionAuthorityFailure(error)) return { status: 'session-lost' }

    const message = messageOf(error)
    const status = parseHttpStatus(message)
    if (status === 400) {
      return {
        status: 'destination-rejected',
        message: 'The server rejected this destination. Refresh and choose a different folder.',
      }
    }
    if (status === 412) {
      // No automatic re-PATCH: the item changed; require a new gesture.
      return {
        status: 'changed',
        message:
          'This item changed while you were moving it. Review its current location and try again.',
      }
    }
    if (status === 404) {
      // The PATCH answers 404 for a vanished SOURCE and for a vanished
      // DESTINATION alike, and the two need different copy: telling a user
      // that "this folder is no longer available" when their item was
      // deleted sends them looking in the wrong place. One read tells them
      // apart — the source still resolves when only the destination is gone
      // (RP-027).
      try {
        const resolvedSource = await deps.resolveSource(plan.source.gfsUri)
        if (resolvedSource.parentResourceId === plan.destination.resourceId) {
          // The move landed after all; the 404 answered about something else.
          return {
            status: 'committed',
            version: resolvedSource.version,
            previousParentId: snapshot.parentResourceId,
            ...(resolvedSource.name !== snapshot.name ? { renamedTo: resolvedSource.name } : {}),
          }
        }
        return {
          status: 'target-unavailable',
          message: 'This folder is no longer available.',
        }
      } catch (resolveError) {
        if (deps.isSessionAuthorityFailure(resolveError)) return { status: 'session-lost' }
        const resolveStatus = parseHttpStatus(messageOf(resolveError))
        if (resolveStatus === 404 || resolveStatus === 410) {
          return {
            status: 'source-unavailable',
            message: 'EvenDrive cannot verify this item’s current location. Refresh and try again.',
          }
        }
        // The side that is gone could not be established: say so instead of
        // naming a side that may still be there.
        return {
          status: 'unconfirmed',
          message: 'Couldn’t confirm the move. Refresh before trying again.',
        }
      }
    }
    if (status === 403) {
      // Generic unless a successful permission recheck proves the missing
      // bit; the pre-commit probes own the exact-reason copy. B6: a 403
      // explains that permission could not be confirmed — never raw HTTP
      // prose, and never a named parent bit without fresh proof.
      return {
        status: 'unconfirmed',
        message: 'EvenDrive could not confirm permission for this move. Refresh and try again.',
        retryPermissionCheck: true,
      }
    }
    if (status === 429 || (!status && /too many/i.test(message))) {
      return {
        status: 'rate-limited',
        message: describeGfsReadError(error).message,
        ...(parseRetryAfterSeconds(message) !== null
          ? { retryAfterSeconds: parseRetryAfterSeconds(message) ?? undefined }
          : {}),
      }
    }
    if (!isNameConflictResponse(error, status)) {
      // Transport loss after dispatch: verify the outcome by identity; never
      // repeat a possibly committed move.
      const verified = await verifyOutcomeByResolve(deps, plan, snapshot)
      if (verified) return verified
      return {
        status: 'unconfirmed',
        message: 'Couldn’t confirm the move. Refresh before trying again.',
      }
    }

    // 409 name conflict.
    if (!plan.allowNumberedRename) {
      return {
        status: 'conflict-stopped',
        message: CONFLICT_STOPPED_MESSAGE,
      }
    }
    occupied.add(moveName)
    if (attempt + 1 >= GFS_MOVE_MAX_NETWORK_ATTEMPTS) break
    moveName = nextAvailableGfsResourceName(snapshot.name, occupied)
  }
  // Bounded attempts exhausted under an approved rename policy: a concurrent
  // naming storm, not "all numbered names used".
  return {
    status: 'conflict-stopped',
    message: 'The destination changed. Refresh it or choose another folder.',
  }
}

/**
 * Post-transport-loss verification (rev-2 §5): resolve the source by its
 * stable URI and compare parent/version — only if that read is authorized.
 * Returns null when the outcome stays unknown.
 */
async function verifyOutcomeByResolve(
  deps: MoveCommitDeps,
  plan: MoveCommitPlan,
  before: MoveCommitSourceSnapshot
): Promise<Extract<MoveCommitOutcome, { status: 'committed' | 'session-lost' }> | null> {
  try {
    const resolved = await deps.resolveSource(plan.source.gfsUri)
    if (resolved.parentResourceId === plan.destination.resourceId) {
      return {
        status: 'committed',
        version: resolved.version,
        // The pre-move parent from the commit-time resolve: the transport-loss
        // path has no mutation receipt to converge with, so the outcome
        // carries the parent the item actually left.
        previousParentId: before.parentResourceId,
        ...(resolved.name !== before.name ? { renamedTo: resolved.name } : {}),
      }
    }
    return null
  } catch (error) {
    if (deps.isSessionAuthorityFailure(error)) return { status: 'session-lost' }
    return null
  }
}

/** Suggested rename candidate for confirmation UI (never dispatched alone). */
export function suggestNumberedMoveName(
  sourceName: string,
  occupiedDestinationNames: ReadonlySet<string>
): string | undefined {
  if (!occupiedDestinationNames.has(sourceName)) return undefined
  return nextAvailableGfsResourceName(sourceName, occupiedDestinationNames)
}

export type MoveToast = (message: string, tone: 'success' | 'error' | 'info' | 'warn') => void

/** Presented outcome toasts (rev-2 §8 UX matrix) shared by every surface.
 *  Unknown-outcome statuses present as WARNINGS, never errors: an
 *  unconfirmed or rate-limited move has not been shown to fail (B7/B8), and
 *  claiming failure would invite a duplicate dispatch. */
export function toastMoveOutcome(
  pushToast: MoveToast | undefined,
  outcome: MoveCommitOutcome,
  sourceName: string,
  destinationName: string,
  sourceKind: 'file' | 'directory'
): void {
  switch (outcome.status) {
    case 'committed':
      pushToast?.(
        outcome.renamedTo
          ? `Moved ${sourceName} to ${destinationName} as ${outcome.renamedTo}`
          : `Moved ${sourceName} to ${destinationName}`,
        'success'
      )
      if (sourceKind === 'directory') {
        pushToast?.(
          'Moving a folder changes who can access its contents — access now follows the new location.',
          'info'
        )
      }
      break
    case 'no-op':
      pushToast?.(`${sourceName} → ${destinationName}: ${outcome.message}`, 'info')
      break
    case 'unconfirmed':
    // The dispatch's outcome is unknown: verify-by-identity already ran and
    // could not settle it. Warn — do not report a failure that was not shown.
    case 'rate-limited':
      // A metered refusal is a "try again" verdict, not a failed move.
      pushToast?.(`${sourceName} → ${destinationName}: ${outcome.message}`, 'warn')
      break
    case 'session-lost':
    // A superseded gesture never reached the server: there is nothing to
    // report and nothing to apologize for.
    case 'gesture-lost':
      break
    default:
      pushToast?.(`${sourceName} → ${destinationName}: ${outcome.message}`, 'error')
  }
}
