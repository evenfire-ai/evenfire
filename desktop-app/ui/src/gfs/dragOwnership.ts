import type { GfsDragSource } from './dragSession.types'

/**
 * The gesture that owns a drop: the surface's local epoch and the shared
 * session generation captured when the drop was admitted.
 */
export interface GfsDropOwnership {
  /** The surface's local gesture counter value at admission. */
  epoch: number
  /** The shared session generation at admission (null without a session). */
  sessionGeneration: number | null
}

/**
 * The live gesture facts a surface owns right now.
 */
export interface GfsLiveDragState {
  /** The surface's current local gesture counter value. */
  epoch: number
  /** The scope the surface is live under (null while revoked). */
  scope: string | null
  /** The shared session's current generation (null without a session). */
  sessionGeneration: number | null
}

/**
 * Drop ownership (rev-2 §4.1): the gesture that asked for this move must
 * still be the live one. The Files page and the sidebar tree used to
 * re-implement this check — and every divergence between their drop
 * behaviour started there. One check, one contract:
 *
 * - the source must belong to the surface's LIVE scope (a revoked session or
 *   a scope change ends the gesture);
 * - the surface's local gesture counter must still carry the admitted
 *   epoch (a newer drag on this surface ends the gesture);
 * - the shared session must still carry the admitted generation (a drag
 *   taken by another surface ends the gesture).
 */
export function ownsGfsDrop(
  source: GfsDragSource,
  ownership: GfsDropOwnership,
  live: GfsLiveDragState
): boolean {
  return (
    source.scope === live.scope &&
    ownership.epoch === live.epoch &&
    ownership.sessionGeneration === live.sessionGeneration
  )
}
