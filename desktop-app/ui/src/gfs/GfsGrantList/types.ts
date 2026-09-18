import type { GfsGrantErrorPresentation } from '@lib/gfsGrantErrors'
import type {
  GfsAgentSubjectOption,
  GfsDelegationSubjectOption,
  GfsGrantListItem,
  GfsInheritedAccessItem,
  GfsShareListItem,
} from '@/gfs/delegation.types'

export type GfsAccessRole = 'read' | 'editor'

/**
 * A FILE dialog's deduped row: one per member across the direct grant, direct
 * shares, and derived ancestor access (the Google Drive model). The effective
 * role is the strongest across sources; a member with an inherited floor is
 * edited through the parent-folder confirmation, never directly on the file.
 */
export interface GfsMergedAccessRow {
  subject: { type: string; id?: string }
  permissions: string[]
  grant: GfsGrantListItem | null
  shares: GfsShareListItem[]
  inherited: GfsInheritedAccessItem | null
}

export interface GfsGrantListProps {
  items: GfsGrantListItem[]
  shares?: GfsShareListItem[]
  /**
   * Client-derived rows inherited from ancestor folders. Ignored unless
   * `mergeInherited` is set (file dialogs): they merge into one normal,
   * toggleable row per member whose edits route through the parent-folder
   * confirmation.
   */
  inheritedItems?: GfsInheritedAccessItem[]
  /** File-dialog mode: dedupe members across direct and inherited access. */
  mergeInherited?: boolean
  loading?: boolean
  /**
   * Quiet inline notice shown when the inherited-access derivation failed
   * entirely (R1-M3): the row list may be incomplete, so the plain empty
   * claim is suppressed while this is set.
   */
  derivationNotice?: string | null
  /**
   * Mapped list-load failure. Severity 'quiet' (manage_acl_required) renders an
   * informational banner instead of the list; 'error' renders an error banner.
   */
  error?: GfsGrantErrorPresentation | null
  shareError?: GfsGrantErrorPresentation | null
  /** Label source for `host` subjects (the caller's own agents). */
  agents: GfsAgentSubjectOption[]
  /** Label source for `user`/`team` subjects (the visible team directory). */
  subjects: GfsDelegationSubjectOption[]
  onRevoke: (item: GfsGrantListItem, label: string) => void | Promise<void>
  onChangeRole?: (
    item: GfsGrantListItem,
    label: string,
    role: GfsAccessRole
  ) => void | Promise<void>
  /** Role change requested on a merged row that carries an inherited floor. */
  onChangeInheritedRole?: (
    row: GfsMergedAccessRow,
    label: string,
    role: GfsAccessRole
  ) => void | Promise<void>
  /** Removal requested on a merged row that carries an inherited floor. */
  onRemoveInherited?: (row: GfsMergedAccessRow, label: string) => void | Promise<void>
  onRevokeShare?: (item: GfsShareListItem, label: string) => void | Promise<void>
  revoking?: boolean
  revokingShare?: boolean
  updatingRole?: boolean
}
