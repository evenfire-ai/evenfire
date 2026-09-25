export interface DelegationAffordances {
  canDelegate: boolean
  grantableBits: string[]
  canCreateShare: boolean
}

export type GfsDelegationSubjectType = 'user' | 'team' | 'host'

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
  /** Directories offer the "Include contents" toggle (default ON); files always send inherit=false. */
  isDirectory: boolean
  onGrant: (subjectKeys: string[], bits: string[], inherit: boolean) => Promise<void>
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
  permissions: string[]
  inherit: boolean
}

/** A direct URI-share row from `window.clerum.gfs.listShares()`. */
export interface GfsShareListItem {
  id: string
  drive: string
  resourceId: string
  subject: { type: string; id?: string }
  permissions: string[]
  includeDescendants: boolean
}

/**
 * ONE contributing ancestor folder of a subject's inherited access: its
 * inheriting grant (inherit=true) and/or descendant-covering share
 * (includeDescendants=true), consolidated per folder with the row ids a
 * confirmed edit mutates. Derivation keeps EVERY contributing folder
 * (R1-H1): a removal revokes all of them and a downgrade lowers each one
 * above the target role.
 */
export interface GfsInheritedAccessSource {
  resourceId: string
  /** Folder label as shown in the confirmation dialog (root falls back to the drive name). */
  name: string
  permissions: string[]
  grantId: string | null
  shareIds: string[]
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
  permissions: string[]
  /** Contributing ancestor folder labels, nearest first, deduplicated. */
  inheritedFrom: string[]
  /** Every contributing ancestor folder, nearest first (R1-H1). */
  sources: GfsInheritedAccessSource[]
}
