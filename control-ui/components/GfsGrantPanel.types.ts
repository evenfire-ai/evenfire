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
 * The ancestor folder a subject's inherited access is edited through: the
 * contributing folder with the strongest role (nearest among equals). Its
 * grant/share ids let the Share dialog route a confirmed change to the
 * folder that actually configures the access.
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
 * An access row derived from an ancestor folder's inheriting grant
 * (inherit=true) or descendant-covering share (includeDescendants=true). The
 * grants/shares GETs expose only direct rows, so inheritance is derived on
 * the client by walking the resource's ancestor folders.
 */
export type GfsInheritedAccessItem = {
  subject: GfsSubjectInput
  permissions: string[]
  /** Contributing ancestor folder labels, nearest first, deduplicated. */
  inheritedFrom: string[]
  /** The folder a confirmed role change or removal is applied to. */
  source: GfsInheritedAccessSource
}
