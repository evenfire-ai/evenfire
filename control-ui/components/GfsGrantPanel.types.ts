import type { GfsBulkGrantSubjectInput, GfsSubjectInput } from '@lib/api'

export type GfsGrantSubjectType =
  | 'user'
  | 'team'
  | 'operator'
  | 'firstPartyAgent'
  | 'workflowPlugin'

export type GfsGrantMode = 'subjects' | 'operator'

export type GfsBulkSubjectInput = GfsBulkGrantSubjectInput

export type GfsGrantSubjectOption = {
  value: string
  id: string
  label: string
  description?: string
  badge: string
  subject: GfsBulkSubjectInput
}

export type GfsGrantResource = {
  resourceId: string
  name: string
  gfsUri: string
  kind?: string
  /** Canonical drive path; powers the inherited-access derivation. */
  path?: string | null
}

export interface GfsGrantPanelProps {
  resource: GfsGrantResource
}

/**
 * One displayed access row per subject: the direct grant plus any legacy URI
 * shares for that same subject, merged. Role changes rewrite only the grant
 * row and preserve its own scope flag; a share-only row is not role-editable
 * and a role change never creates a grant for it (R1-M5). A share row that
 * CONFLICTS with the requested role is revoked together with the grant write
 * (RP-032) — the server has no share-update surface — while a share row that
 * already matches the target role survives.
 */
/**
 * One sharing row on a resource, with its own bits and descendant scope
 * (R1-M5). A role change preserves this per-row provenance; RP-032 revokes
 * only the rows whose bits CONFLICT with the requested role.
 */
export type GfsGrantShareEntry = {
  rowId: string
  permissions: string[]
  includeDescendants: boolean
}

export type GfsExistingAccessItem = {
  subject: GfsSubjectInput
  permissions: string[]
  /** Union display flag (grant inherit ⊔ share includeDescendants) — display only. */
  inherit: boolean
  /** The direct GRANT row's own scope flag, exactly what a role write preserves. */
  grantInherit: boolean
  grantId: string | null
  shareIds: string[]
  /** Every direct share row with its own bits and descendant scope (R1-M5). */
  shareEntries: GfsGrantShareEntry[]
}

/**
 * A FILE's "People with access" row: direct rows and derived ancestor rows
 * deduped to exactly one row per subject (the Google Drive model). The
 * effective role is the strongest across sources; a member with an inherited
 * floor is edited through the parent-folder confirmation dialog, never
 * directly on the file.
 */
export type GfsFileAccessRow = {
  subject: GfsSubjectInput
  permissions: string[]
  direct: GfsExistingAccessItem | null
  inherited: GfsInheritedAccessItem | null
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
export type GfsInheritedAccessSource = {
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
  shareEntries: GfsGrantShareEntry[]
}

/**
 * An access row derived from ancestor folders' inheriting grants/shares. The
 * grants/shares GETs expose only direct rows, so inheritance is derived on
 * the client by walking the resource's ancestor folders.
 */
export type GfsInheritedAccessItem = {
  subject: GfsSubjectInput
  permissions: string[]
  /** Contributing ancestor folder labels, nearest first, deduplicated. */
  inheritedFrom: string[]
  /** Every contributing ancestor folder, nearest first (R1-H1). */
  sources: GfsInheritedAccessSource[]
}

export type GfsInheritedAccessCoverage =
  | 'complete'
  | 'read-boundary'
  | 'acl-limited'
  | 'unavailable'

export interface GfsInheritedAccessResult {
  items: GfsInheritedAccessItem[]
  coverage: GfsInheritedAccessCoverage
}
