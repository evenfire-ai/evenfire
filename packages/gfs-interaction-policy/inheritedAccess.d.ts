export type GfsAclReadFailureClass = 'denied' | 'missing' | 'rate-limited' | 'retryable' | 'error'

export type GfsCoverageClass = GfsAclReadFailureClass | 'depth-cap' | 'complete'

export interface GfsSubjectRef {
  type: string
  id?: string
}

/** One contributing ACL row (grant or share) as observed on an ancestor. */
export interface GfsInheritedContribution {
  subject: GfsSubjectRef
  permissions: string[]
  rowKind: 'grant' | 'share'
  /**
   * Row handle, or null/absent for an OBSERVATION without an editable row:
   * permissions still fold into the subject's folder source, but no row ids
   * or scope flags are created or modified (legacy app-core behavior).
   */
  rowId?: string | null
  inherit?: boolean
  includeDescendants?: boolean
}

export interface GfsInheritedSourceFolder {
  resourceId: string
  name: string
}

export interface GfsInheritedShareEntry {
  rowId: string
  permissions: string[]
  includeDescendants: boolean
}

export interface GfsInheritedAccessSource {
  resourceId: string
  name: string
  /** Union of this folder's contributing rows — display only, never written back. */
  permissions: string[]
  grantId: string | null
  shareIds: string[]
  /** Exact bits of this folder's grant row, when one contributes. */
  grantPermissions: string[] | null
  /** The grant row's own scope flag, preserved by every edit. */
  grantInherit: boolean | null
  shareEntries: GfsInheritedShareEntry[]
}

export interface GfsInheritedAccessItem {
  subject: GfsSubjectRef
  permissions: string[]
  inheritedFrom: string[]
  sources: GfsInheritedAccessSource[]
}

/** Result of `planGfsInheritedRoleChange` — see implementation contract. */
export interface GfsInheritedRoleChangePlan {
  grantSources: GfsInheritedAccessSource[]
  shareOnlySources: GfsInheritedAccessSource[]
}

export declare const GFS_INHERITED_WALK_MAX_DEPTH: number
export declare const GFS_RETRY_AFTER_MAX_SECONDS: number

export declare function gfsSubjectKeyOf(subject: GfsSubjectRef): string
export declare function gfsAncestorPathsOf(path: string): string[]
export declare function gfsHttpStatusOf(error: unknown): number | null
export declare function gfsRetryAfterSecondsOf(error: unknown): number | null
export declare function classifyGfsAclReadFailure(error: unknown): GfsAclReadFailureClass
export declare function isEditorGfsPermissions(permissions: string[]): boolean
export declare function gfsRoleRank(permissions: string[]): number
export declare function strongestGfsInheritedSource(
  sources: GfsInheritedAccessSource[]
): GfsInheritedAccessSource | null
export declare function mergeGfsInheritedAccessItem(
  current: GfsInheritedAccessItem | null,
  contribution: GfsInheritedContribution,
  folder: GfsInheritedSourceFolder
): GfsInheritedAccessItem
export declare function planGfsInheritedRoleChange(
  item: Pick<GfsInheritedAccessItem, 'permissions' | 'sources'>,
  targetRoleIsEditor: boolean
): GfsInheritedRoleChangePlan
export declare function worstGfsCoverageClass(
  classifications: readonly GfsCoverageClass[]
): GfsCoverageClass
