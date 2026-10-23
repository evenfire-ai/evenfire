import type { GfsDragStructureEvidence } from '@clerum/gfs-interaction-policy'

/**
 * Tone for user-facing move feedback. Deliberately mirrors the Control UI
 * toast tones (including the warning tone this feature adds) without
 * importing component types into a shared lib.
 */
export type GfsFeedbackTone = 'info' | 'error' | 'warning'

/**
 * Every refused/uncertain move outcome this surface can present, with the
 * wording contract owned by docs/design/gfs-move-forbidden-ux-matrix.md.
 *
 * Structure denies (A1–A5) and the operator-plane authority denies (A6–A8,
 * copy-mapped here but never fabricated from local permission bits — the
 * operator plane holds intrinsic authority) come from the shared policy.
 * Resolution/outcome reasons (A10, B4, B5, B7) come from endpoint reads and
 * transport results around the move PATCH.
 */
export type GfsDropRefusalReason =
  | GfsStructureRefusalReason
  | 'destination-write'
  | 'source-write'
  | 'source-delete'
  | 'unavailable'
  | 'target-unavailable'
  | 'source-location-unknown'
  | 'unknown-outcome'
  | 'move-not-completed'

export type GfsStructureRefusalReason =
  | 'self'
  | 'descendant'
  | 'same-parent'
  | 'root-source'
  | 'cross-drive'

/**
 * The hover treatment painted on a drop target through `data-drop-state`.
 * Only `allowed` paints the blue "drop here" affordance; every other state
 * explains itself through `data-drop-reason` plus the tone mapping.
 */
export type GfsDropHoverState = 'allowed' | 'checking' | 'denied' | 'unavailable' | 'same-parent'

export type GfsDropHoverVerdict =
  | { state: 'allowed'; evidence: GfsDragStructureEvidence }
  | { state: 'checking' }
  | { state: 'denied'; reason: Exclude<GfsStructureRefusalReason, 'same-parent'> }
  | { state: 'unavailable' }
  | { state: 'same-parent' }

/** Observed facts one hover verdict is computed from (zero network). */
export interface GfsDropHoverFacts {
  drive: string
  sourceResourceId: string
  sourceKind: 'file' | 'directory'
  /** Physical source parent observation from the dragstart listing. */
  sourceParentKnown: boolean
  sourceParentResourceId: string | null
  /** Null when the target's identity is not available yet (unhydrated root). */
  targetResourceId: string | null
  targetName: string
  /** True when the target IS the folder whose listing is on screen. */
  targetIsActiveLocation: boolean
  /** True when the target is observed to be the source's physical parent. */
  targetIsSourceParent: boolean
  /** Ancestors of the target, nearest-first; trailing null marks an
   * observation walked to the physical root. */
  targetAncestorIds: readonly (string | null)[]
  /** Currently known ancestors of the source (physical parent and above). */
  knownSourceAncestorIds: ReadonlySet<string>
}

/** An immutable, synchronously captured drag-move destination. */
export interface GfsMoveDestination {
  resourceId: string
  rid: string | null
  name: string
  kind: 'directory'
  /** Immutable resolve key for pre-dispatch re-resolution. */
  gfsUri: string | null
  /** Known canonical path ('/' for the drive root); null when unobserved. */
  path: string | null
  version?: number
  origin: 'row' | 'crumb'
}
