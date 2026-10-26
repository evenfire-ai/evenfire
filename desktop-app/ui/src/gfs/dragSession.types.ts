import type {
  GfsDragAuthorityVerdict,
  GfsDragStructureVerdict,
} from '@clerum/gfs-interaction-policy'

/**
 * The one active in-window drag source, shared by the Files page and the
 * sidebar file explorer (rev-2 §4). `version` is the listing value at
 * dragstart — advisory only; the commit re-resolves before any PATCH. Missing
 * parent facts stay unknown (`parentKnown: false`), never invented root or
 * version-zero facts.
 */
export interface GfsDragSource {
  resourceId: string
  gfsUri: string
  drive: string
  kind: 'file' | 'directory'
  name: string
  /** Listing version at dragstart, when the row carried one. */
  version?: number
  parentKnown: boolean
  parentResourceId: string | null
  /** Loaded-tree ancestors of the source at dragstart (observation only). */
  knownAncestorIds: readonly string[]
  origin: 'files' | 'sidebar'
  /** env:user:team scope the drag started under. */
  scope: string
  /** Monotonic per-provider generation; discards stale async callbacks. */
  generation: number
}

/** Machine-readable denial codes; prose lives in each surface's UX matrix. */
export type GfsDropDenialReason =
  | 'self'
  | 'descendant'
  | 'same-parent'
  | 'root-source'
  | 'cross-drive'
  | 'root-target'
  | 'source-write'
  | 'source-delete'
  | 'destination-write'
  | 'source-location-unknown'
  | 'target-unavailable'
  | 'unavailable'
  | 'session-lost'

export interface GfsDropTargetFact {
  resourceId: string
  name: string
  kind: 'file' | 'directory'
  /** Loaded ancestors of the target, nearest-first; trailing null = observed
   * to the physical root (observation only). */
  ancestorIds: readonly (string | null)[]
}

export type GfsDropVerdict =
  | { state: 'checking' }
  | { state: 'allowed' }
  | { state: 'denied'; reason: GfsDropDenialReason }
  | { state: 'unavailable'; reason: 'rate-limit' | 'transport' | 'session' }

export interface GfsDropAdmission {
  allowed: true
  /** Numbered-name conflict retry is pre-approved (source write proved or the
   * folder confirmation opted in). */
  allowNumberedRename: boolean
  /** Suggested rename candidate when destination names are cached and taken. */
  suggestedName?: string
  structure: GfsDragStructureVerdict
  authority: GfsDragAuthorityVerdict
}

export interface GfsDropRejection {
  allowed: false
  reason: GfsDropDenialReason
  message?: string
}

export type GfsDropDecision = GfsDropAdmission | GfsDropRejection

/** One cold-hover chain's slot; release is idempotent and generation-bound. */
export interface GfsHoverCheckLease {
  complete(): void
}

/** Provider API (rev-2 §4): one ephemeral source per session; no registry,
 * no nonce MIME, no credentials. */
export interface GfsDragSessionApi {
  beginDrag(source: Omit<GfsDragSource, 'generation'>): boolean
  endDrag(): void
  activeSource(): GfsDragSource | null
  /** True while the stored source belongs to the caller's live scope. */
  matchesScope(scope: string | null): boolean
  invalidate(reason: 'authority' | 'scope-change'): void
  /** Monotonic gesture counter; lets a surface release the shared store only
   * when the store still belongs to the gesture that captured it. */
  currentGeneration(): number
  /** Acquire only for a still-active captured gesture; never charge a newer one. */
  beginHoverCheck(expectedGeneration: number): GfsHoverCheckLease | null
}
