import {
  GFS_MOVE_MAX_NETWORK_ATTEMPTS,
  isGfsNameConflict,
  nextAvailableGfsResourceName,
} from '@clerum/gfs-interaction-policy'
import { parseHttpStatus, parseRetryAfterSeconds } from '@lib/gfsGrantErrors'
import type { GfsDropRejection } from './dragSession.types'

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

export interface MoveCommitPlan {
  source: { resourceId: string; gfsUri: string; kind: 'file' | 'directory'; name: string }
  destination: { resourceId: string; name: string }
  /** Pre-approved numbered-name conflict policy (rev-2 §5). */
  allowNumberedRename: boolean
  /** Names already known to be taken in the destination, when cached. */
  occupiedDestinationNames?: ReadonlySet<string>
}

export type MoveCommitOutcome =
  | { status: 'committed'; version: number; renamedTo?: string }
  | { status: 'no-op'; message: string }
  | { status: 'conflict-stopped'; message: string }
  | { status: 'changed'; message: string }
  | { status: 'source-unavailable'; message: string }
  | { status: 'target-unavailable'; message: string }
  | { status: 'rate-limited'; message: string; retryAfterSeconds?: number }
  | { status: 'unconfirmed'; message: string }
  | { status: 'session-lost' }

export interface MoveCommitDeps {
  /** Resolve by stable URI; throws on 403/404/transport like the read plane. */
  resolveSource: (gfsUri: string) => Promise<MoveCommitSourceSnapshot>
  /** One move PATCH attempt; ifMatch is mandatory client policy. */
  moveResource: (
    resourceId: string,
    destinationId: string,
    ifMatch: number,
    newName?: string
  ) => Promise<{ resourceId: string; version: number }>
  /** Central fail-closed classifier; returns true when the session died. */
  isSessionAuthorityFailure: (error: unknown) => boolean
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
    return { status: 'unconfirmed', message: messageOf(error) }
  }

  // Fresh-parent no-op guard before any request (a concurrent move may have
  // already relocated the item into the chosen destination).
  if (snapshot.parentResourceId === plan.destination.resourceId) {
    return { status: 'no-op', message: 'This item is already in this folder.' }
  }

  const occupied = new Set<string>(plan.occupiedDestinationNames ?? [])
  let moveName = snapshot.name

  for (let attempt = 0; attempt < GFS_MOVE_MAX_NETWORK_ATTEMPTS; attempt += 1) {
    let error: unknown
    try {
      const receipt = await deps.moveResource(
        snapshot.resourceId,
        plan.destination.resourceId,
        snapshot.version,
        moveName === snapshot.name ? undefined : moveName
      )
      return {
        status: 'committed',
        version: receipt.version,
        ...(moveName !== snapshot.name ? { renamedTo: moveName } : {}),
      }
    } catch (attemptError) {
      error = attemptError
    }
    if (deps.isSessionAuthorityFailure(error)) return { status: 'session-lost' }

    const message = messageOf(error)
    const status = parseHttpStatus(message)
    if (status === 412) {
      // No automatic re-PATCH: the item changed; require a new gesture.
      return {
        status: 'changed',
        message: 'This item changed while you were moving it. Review its current location and try again.',
      }
    }
    if (status === 404) {
      return { status: 'target-unavailable', message: 'This folder is no longer available.' }
    }
    if (status === 403) {
      // Generic unless a successful permission recheck proves the missing bit;
      // the pre-commit probes own the exact-reason copy.
      return { status: 'unconfirmed', message }
    }
    if (status === 429 || (!status && /too many/i.test(message))) {
      return {
        status: 'rate-limited',
        message: 'Too many file requests — try again shortly.',
        ...(parseRetryAfterSeconds(message) !== null
          ? { retryAfterSeconds: parseRetryAfterSeconds(message) ?? undefined }
          : {}),
      }
    }
    if (status !== 409 && !isGfsNameConflict(error)) {
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
        message:
          'An item with this name already exists. Choose another folder, or use Move to change its name if you have rename access.',
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
): Promise<MoveCommitOutcome | null> {
  try {
    const resolved = await deps.resolveSource(plan.source.gfsUri)
    if (resolved.parentResourceId === plan.destination.resourceId) {
      return {
        status: 'committed',
        version: resolved.version,
        ...(resolved.name !== before.name ? { renamedTo: resolved.name } : {}),
      }
    }
    return null
  } catch {
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


export type MoveToast = (message: string, tone: 'success' | 'error' | 'info') => void

/** Presented outcome toasts (rev-2 §8 UX matrix) shared by every surface. */
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
      pushToast?.(outcome.message, 'info')
      break
    case 'session-lost':
      break
    default:
      pushToast?.(outcome.message, 'error')
  }
}

/** Exact-reason denial copy (rev-2 §8). Null = stay silent (session-lost). */
export function moveDenialMessage(
  rejection: GfsDropRejection,
  destinationName: string
): string | null {
  switch (rejection.reason) {
    case 'destination-write':
      return `You can’t move files to ${destinationName} because you don’t have write permission for this folder.`
    case 'source-write':
      return 'You cannot move this item out of its current folder without write access there.'
    case 'source-delete':
      return 'You do not have permission to remove this item from its current folder.'
    case 'same-parent':
      return 'This item is already in this folder.'
    case 'self':
    case 'descendant':
      return 'A folder cannot be moved into itself or one of its subfolders.'
    case 'root-source':
      return 'The top-level folder cannot be moved.'
    case 'cross-drive':
      return 'Items can’t be moved between drives.'
    case 'session-lost':
      return null
    default:
      return rejection.message ?? 'This move is not available right now. Try again in a moment.'
  }
}
