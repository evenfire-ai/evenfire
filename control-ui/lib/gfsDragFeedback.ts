import { decideDragStructure } from '@clerum/gfs-interaction-policy'
import type {
  GfsDropHoverFacts,
  GfsDropHoverVerdict,
  GfsDropRefusalReason,
  GfsFeedbackTone,
} from './gfsDragFeedback.types'

/**
 * Browser-safe, transport-free feedback mapping for EvenDrive drag moves in
 * Control UI. Wording contract: docs/design/gfs-move-forbidden-ux-matrix.md
 * (§3 Phase-A messages, §4 Phase-B outcomes). Row and breadcrumb handlers
 * share this one mapping so the same reason always reads the same on every
 * surface.
 *
 * Tone rules (matrix §5.2): deny = error, no-op = info, unknown = warning.
 * Operator-plane A6–A8 denies cannot be produced truthfully from local bits;
 * their copy lives here for pure coverage and server-refusal surfacing, and
 * is never fabricated to satisfy a test.
 */
export function gfsDropRefusalTone(reason: GfsDropRefusalReason): GfsFeedbackTone {
  switch (reason) {
    case 'same-parent':
      return 'info'
    case 'unavailable':
    case 'source-precondition-unavailable':
    case 'unknown-outcome':
      return 'warning'
    default:
      return 'error'
  }
}

/** The persistent (toast/banner) message for a refused or uncertain move. */
export function gfsDropRefusalMessage(
  reason: GfsDropRefusalReason,
  names: { sourceName?: string; targetName?: string } = {}
): string {
  const source = names.sourceName?.trim() || 'This item'
  const target = names.targetName?.trim() || 'this folder'
  switch (reason) {
    case 'self':
      return `You dropped ${source} onto itself. Pick a destination folder.`
    case 'cross-drive':
      return 'Moving between drives isn’t supported.'
    case 'root-source':
      return 'This location is the top level — it can’t be moved.'
    case 'same-parent':
      return `${source} is already in ${target}.`
    case 'descendant':
      return `You can't move ${source} into a folder inside itself.`
    case 'destination-write':
      return `You don't have permission to move items into ${target}. You need edit access to the destination folder.`
    case 'source-write':
      return `You can’t move ${source} out of its current folder because you don’t have edit access to the folder that contains it.`
    case 'source-delete':
      return `You can’t move ${source} out of its current folder because you don’t have delete access to the folder that contains it.`
    case 'target-unavailable':
      return 'This folder is no longer available.'
    case 'source-location-unknown':
      return 'EvenDrive cannot verify this item’s current location. Refresh and try again.'
    case 'source-precondition-unavailable':
      return 'EvenDrive couldn’t confirm this item’s current version. Refresh the folder and try again.'
    case 'session-lost':
      return 'Your session ended. Sign in again to continue moving files.'
    case 'unavailable':
      return 'EvenDrive couldn’t verify this move. Check your connection and try again.'
    case 'unknown-outcome':
      return 'Couldn’t confirm the move. Refresh before trying again.'
    default:
      return 'EvenDrive couldn’t verify this move. Check your connection and try again.'
  }
}

/**
 * The spoken form of a hover verdict (RP-026 shape). Denied hover announces
 * the same reason sentence a refused drop would toast — one wording per
 * reason on every surface.
 */
export function gfsDropHoverAnnouncement(
  verdict: GfsDropHoverVerdict,
  names: { sourceName?: string; targetName?: string }
): string {
  const target = names.targetName?.trim() || 'this folder'
  switch (verdict.state) {
    case 'allowed':
      return `You can move into ${target}.`
    case 'checking':
      return `Checking whether you can move into ${target}…`
    case 'unavailable':
      return `EvenDrive could not confirm whether you can move into ${target}.`
    case 'same-parent':
      return gfsDropRefusalMessage('same-parent', { ...names, targetName: target })
    case 'denied':
      return gfsDropRefusalMessage(verdict.reason, { ...names, targetName: target })
    default:
      return `Checking whether you can move into ${target}…`
  }
}

/**
 * Zero-network hover verdict from observed facts (matrix A1–A5, A9, A10 and
 * the unhydrated-root case). Unknown ancestry stays landable (`checking`,
 * never a fake denial); structure itself is delegated to the shared pure
 * policy, whose `server-check-required` keeps the drop admissible for the
 * atomic server guard to adjudicate.
 */
export function computeGfsDropHoverVerdict(facts: GfsDropHoverFacts): GfsDropHoverVerdict {
  if (!facts.targetResourceId) return { state: 'unavailable', reason: 'target-unavailable' }
  if (facts.targetResourceId === facts.sourceResourceId) return { state: 'denied', reason: 'self' }
  if (
    facts.targetIsActiveLocation ||
    (facts.sourceParentKnown && facts.sourceParentResourceId === facts.targetResourceId) ||
    facts.targetIsSourceParent
  ) {
    return { state: 'same-parent', reason: 'same-parent' }
  }
  const structure = decideDragStructure({
    source: {
      resourceId: facts.sourceResourceId,
      drive: facts.drive,
      kind: facts.sourceKind,
      parentKnown: facts.sourceParentKnown,
      parentResourceId: facts.sourceParentResourceId,
    },
    target: { resourceId: facts.targetResourceId, drive: facts.drive },
    targetAncestorIds: facts.targetAncestorIds,
    knownSourceAncestorIds: facts.knownSourceAncestorIds,
  })
  if (structure.kind === 'deny') {
    if (structure.reason === 'same-parent') return { state: 'same-parent', reason: 'same-parent' }
    return { state: 'denied', reason: structure.reason }
  }
  if (structure.kind === 'server-check-required') return { state: 'checking' }
  return { state: 'allowed', evidence: structure.evidence }
}

/**
 * A refused move carrying its reason and tone, so the shared commit runner
 * can present honest feedback (info for no-ops, warning for unknowns,
 * error for real denials) instead of flattening everything to an error.
 */
export class GfsMoveRefusalError extends Error {
  readonly reason: GfsDropRefusalReason

  constructor(reason: GfsDropRefusalReason, message: string) {
    super(message)
    this.name = 'GfsMoveRefusalError'
    this.reason = reason
  }

  get tone(): GfsFeedbackTone {
    return gfsDropRefusalTone(this.reason)
  }
}
