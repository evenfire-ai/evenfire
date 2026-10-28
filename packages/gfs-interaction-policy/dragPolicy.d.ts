export type GfsDragStructureDenyReason =
  | 'self'
  | 'descendant'
  | 'same-parent'
  | 'root-source'
  | 'cross-drive'

export type GfsDragStructureEvidence = 'file' | 'common-anchor' | 'known-chain' | 'fresh-path'

export type GfsDragStructureVerdict =
  | { kind: 'deny'; reason: GfsDragStructureDenyReason }
  | { kind: 'observed-safe'; evidence: GfsDragStructureEvidence }
  | { kind: 'server-check-required' }

export type GfsDragAuthorityDenyReason = 'source-write' | 'source-delete' | 'destination-write'

export type GfsDragAuthorityUnavailability = 'rate-limit' | 'transport' | 'session'

export type GfsDragAuthorityVerdict =
  | { kind: 'checking' }
  | { kind: 'observed-allowed'; checkedAt: number }
  | { kind: 'deny'; reason: GfsDragAuthorityDenyReason }
  | { kind: 'unavailable'; reason: GfsDragAuthorityUnavailability }

/** Maximum move PATCH attempts per gesture within GFS_UPLOAD_NAME_RETRY_LIMIT. */
export declare const GFS_MOVE_MAX_NETWORK_ATTEMPTS: number

export interface GfsDragStructureSourceFact {
  resourceId: string
  drive: string
  kind: 'file' | 'directory'
  /** True only when the physical parent is observed (listing/breadcrumb). */
  parentKnown: boolean
  parentResourceId: string | null
}

export interface GfsDragStructureTargetFact {
  resourceId: string
  drive: string
}

export interface GfsDragStructureInput {
  source: GfsDragStructureSourceFact
  target: GfsDragStructureTargetFact
  /** Ancestors of the target from a currently loaded chain, nearest-first; a
   * trailing `null` marks a chain observed to the physical root. */
  targetAncestorIds?: readonly (string | null)[]
  /** Currently known ancestors of the source (physical parent and above). */
  knownSourceAncestorIds?: ReadonlySet<string>
}

export declare function decideDragStructure(input: GfsDragStructureInput): GfsDragStructureVerdict

export declare function normalizeCanonicalPath(value: unknown): string | null

/** Parent path of a canonical path; null for root, undefined when unknown. */
export declare function parentPathOf(canonicalPath: string): string | null | undefined

export interface GfsDragPathStructureInput {
  /** Canonical server path of the source from a current authorized view. */
  sourcePath: string | null | undefined
  /** Canonical server path of the target from a current authorized view. */
  targetPath: string | null | undefined
}

export declare function decideDragPathStructure(
  input: GfsDragPathStructureInput
): GfsDragStructureVerdict

export interface GfsDragAuthorityInput {
  /** Held bits on the physical source parent (affordances `held`), or null when unknown. */
  sourceParentHeld?: readonly string[] | ReadonlySet<string> | null
  /** Held bits on the destination folder, or null when unknown. */
  destinationHeld?: readonly string[] | ReadonlySet<string> | null
  /** A probe that could not answer; wins over bit evaluation. */
  unavailable?: GfsDragAuthorityUnavailability | null
  /** Observation time of the supplied bits (epoch ms). */
  checkedAt?: number
}

export declare function decideDragAuthority(input: GfsDragAuthorityInput): GfsDragAuthorityVerdict

export interface GfsMoveReceiptLike {
  resourceId: string
  oldParentId?: string | null
  newParentId?: string | null
}

export interface GfsMoveConvergenceKnown {
  /** Known child→parent links from cached listings. */
  childParentByResourceId?: ReadonlyMap<string, string | null>
}

export interface GfsMoveConvergencePlan {
  refetchChildIds: string[]
  staleResourceIds: string[]
}

export declare function planMoveConvergence(
  receipt: GfsMoveReceiptLike,
  known?: GfsMoveConvergenceKnown
): GfsMoveConvergencePlan
