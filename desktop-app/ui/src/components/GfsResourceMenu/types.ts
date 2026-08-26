export type GfsResourceMenuProps = {
  createShareDisabled?: boolean
  resourceName: string
  onManage?: () => void
  onCopyLink: () => void
  onCreateShare?: () => void
  onCreateFolder?: () => void
  onDelete?: () => void
  onOpen?: () => void
  /**
   * Notified on open-state transitions so callers can lazily load per-row data
   * (e.g. delete affordances) only while a menu is open.
   */
  onOpenChange?: (open: boolean) => void
  onPreview?: () => void
  onDownload?: () => void
  onRename?: () => void
  /** Open the move-to-folder flow. Move authority is parent-relative and
   *  enforced server-side, so callers do NOT gate this on local affordances. */
  onMove?: () => void
}
