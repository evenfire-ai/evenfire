import type { GfsGrantErrorPresentation } from '@lib/gfsGrantErrors'
import type {
  GfsAgentSubjectOption,
  GfsDelegationSubjectOption,
  GfsGrantListItem,
  GfsShareListItem,
} from '@/gfs/delegation.types'

export interface GfsGrantListProps {
  items: GfsGrantListItem[]
  shares?: GfsShareListItem[]
  loading?: boolean
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
  onRevokeShare?: (item: GfsShareListItem, label: string) => void | Promise<void>
  revoking?: boolean
  revokingShare?: boolean
}
