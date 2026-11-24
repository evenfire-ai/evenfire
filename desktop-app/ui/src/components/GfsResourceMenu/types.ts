import type { GfsResourceAction, GfsResourceActionId } from '@lib/gfsResourceActions'

/** A menu entry's key: an action id, or the Share flyout's own Share entry. */
export type GfsResourceMenuActionKey = GfsResourceActionId | 'share-access'

/**
 * Where the target's permission bits (its own affordances and its parent's)
 * stand. The owner derives the actions from them through
 * `gfsRowActionAvailability`; the menu only keeps every action that depends on
 * them inert until they are `ok`.
 */
export type GfsResourceMenuPermissionStatus = 'pending' | 'ok' | 'error'

export type GfsResourceMenuProps = {
  resourceName: string
  actions?: GfsResourceAction[]
  /**
   * Opens the menu at a viewport point with no trigger button (context menus).
   * The menu is open on mount. The owner unmounts it on `onDismiss`, never on
   * `onOpenChange(false)`, and gives each new opening its own React `key`, so
   * another target never inherits the previous flyout, focus or a late
   * permission result.
   */
  anchor?: { x: number; y: number }
  /**
   * Omitted on a trigger menu means its actions are already final. Omitted on
   * an anchored menu counts as `pending`, so bit-dependent actions stay inert.
   */
  permissionStatus?: GfsResourceMenuPermissionStatus
  /**
   * The user dismissed the menu: Escape, a click outside it, or choosing an
   * action. Anchored menus are unmounted from here.
   */
  onDismiss?: () => void
  onManage?: () => void
  onCopyLink?: () => void
  onCreateFolder?: () => void
  onDelete?: () => void
  onOpen?: () => void
  /**
   * Notified on open-state transitions so callers can lazily load per-row data
   * (e.g. delete affordances) only while a menu is open. Reports state only:
   * StrictMode replays it as open, closed, open on mount, and it reports
   * `false` once the menu unmounts.
   */
  onOpenChange?: (open: boolean) => void
  onPreview?: () => void
  onDownload?: () => void
  /** Recursive folder export as a single zip archive (BUG-175). */
  onDownloadZip?: () => void
  onRename?: () => void
  onReplace?: (file: File) => void
  /** Open the move-to-folder flow. Move authority is parent-relative and
   *  enforced server-side, so callers do NOT gate this on local affordances. */
  onMove?: () => void
}
