export interface DelegationAffordances {
  canDelegate: boolean
  grantableBits: string[]
  canCreateShare: boolean
}

export type GfsDelegationSubjectType = 'user' | 'team' | 'host'
export type GfsSubjectProfile = { name: string | null; email?: string }

export interface GfsDelegationSubjectOption {
  type: GfsDelegationSubjectType
  id: string
  label: string
  description?: string
  /** Display label for the subject kind (e.g. "Agent"); falls back to `type`. */
  badge?: string
}

export interface GfsDelegationPanelProps {
  affordances: DelegationAffordances
  subjectOptions: GfsDelegationSubjectOption[]
  subjectOptionsLoading?: boolean
  subjectOptionsError?: string | null
  /** The cached affordance result is being revalidated and cannot authorize a grant. */
  permissionCheckPending?: boolean
  /** The latest affordance check failed; cached bits remain non-actionable. */
  permissionCheckFailed?: boolean
  /** Directories offer the "Include contents" toggle (default ON); files always send inherit=false. */
  isDirectory: boolean
  onGrant: (
    subjectKeys: string[],
    bits: string[],
    inherit: boolean,
    isDraftCurrent: () => boolean
  ) => Promise<void>
  onDetailViewChange?: (open: boolean) => void
}

/**
 * One of MY agents, offered as a delegation target. `id` is the canonical
 * managed-host subject id (`1st:<namespace>/<name>`) from
 * `window.clerum.agents.listMine()`; the grant subject key is `host:` + id.
 */
export interface GfsAgentSubjectOption {
  id: string
  /** Agent identifier (`metadata.name`) — used for keys and stable sorting. */
  name: string
  /** Visible name (Agent CRD `spec.host`); rendered to the user when present. */
  displayName?: string
}

/**
 * A row from `window.clerum.gfs.listGrants()` — the admin-GET item shape
 * surfaced on the user plane. `id` powers revoke (the grant PUT response
 * carries no ids, so this list is the only revoke-id source).
 */
export interface GfsGrantListItem {
  id: string
  drive: string
  resourceId: string
  subject: { type: string; id?: string }
  subjectProfile?: GfsSubjectProfile
  homeOwner?: true
  permissions: string[]
  inherit: boolean
}

/** A direct URI-share row from `window.clerum.gfs.listShares()`. */
export interface GfsShareListItem {
  id: string
  drive: string
  resourceId: string
  subject: { type: string; id?: string }
  subjectProfile?: GfsSubjectProfile
  permissions: string[]
  includeDescendants: boolean
}

/**
 * ONE contributing ancestor folder of a subject's inherited access: its
 * inheriting grant (inherit=true) and/or descendant-covering share
 * (includeDescendants=true), consolidated per folder with the row ids a
 * confirmed edit mutates. Derivation keeps EVERY contributing folder
 * (R1-H1): a removal revokes all of them and a downgrade lowers each one
 * above the target role. Per-row provenance (R1-M5): the grant's own bits and
 * scope flag and every share's own bits/scope are retained — a role change
 * rewrites only grant-backed rows and never deletes or converts shares.
 */
export interface GfsInheritedAccessSource {
  resourceId: string
  /** Folder label as shown in the confirmation dialog (root falls back to the drive name). */
  name: string
  permissions: string[]
  grantId: string | null
  shareIds: string[]
  /** Exact bits of this folder's grant row, when one contributes. */
  grantPermissions: string[] | null
  /** The grant row's own scope flag; null when no grant row exists. */
  grantInherit: boolean | null
  /** Every contributing share row with its own bits and descendant scope. */
  shareEntries: Array<{
    rowId: string
    permissions: string[]
    includeDescendants: boolean
  }>
}

/**
 * An inherited access row: the ancestor folders' inheriting grants
 * (inherit=true) and descendant-covering shares (includeDescendants=true),
 * derived on the client because the grants/shares GETs list only direct rows.
 * Rendered as a normal toggleable row; every edit routes through the
 * parent-folder confirmation.
 */
export interface GfsInheritedAccessItem {
  subject: { type: string; id?: string }
  subjectProfile?: GfsSubjectProfile
  homeOwner?: true
  permissions: string[]
  /** Contributing ancestor folder labels, nearest first, deduplicated. */
  inheritedFrom: string[]
  /** Every contributing ancestor folder, nearest first (R1-H1). */
  sources: GfsInheritedAccessSource[]
}

/**
 * Terminal coverage of one inherited-access walk (R1-H3, permissions.md T1).
 * Every non-`complete` state still carries the rows folded so far — known
 * authorized sources are retained and stay editable; the state only decides
 * which notice the dialog shows.
 */
export type GfsInheritedCoverageState =
  | 'complete'
  /** Resolve 403 above the readable chain: an expected privacy boundary. */
  | 'read-boundary'
  /** A readable ancestor's grants/shares list answered 403 (no manage_acl). */
  | 'acl-limited'
  /** missing / rate-limited / retryable / error / cycle / depth-cap. */
  | 'unavailable'

/** `deriveGfsInheritedAccess` result: retained rows plus honest coverage. */
export interface GfsInheritedAccessResult {
  items: GfsInheritedAccessItem[]
  coverage: GfsInheritedCoverageState
}
