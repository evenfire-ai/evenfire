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
 * shares for that same subject, merged. The server has no share-update
 * surface, so any role change (or revoke) consolidates the subject onto the
 * single grant — the upsert preserves effective permissions (inherit ⊔
 * includeDescendants) and the superseded share rows are deleted.
 */
export type GfsExistingAccessItem = {
  subject: GfsSubjectInput
  permissions: string[]
  inherit: boolean
  grantId: string | null
  shareIds: string[]
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
 * above the target role.
 */
export type GfsInheritedAccessSource = {
  resourceId: string
  /** Folder label as shown in the confirmation dialog (root falls back to the drive name). */
  name: string
  permissions: string[]
  grantId: string | null
  shareIds: string[]
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
