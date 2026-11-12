import type { RefObject } from 'react'
import type { GfsResourceAction } from '@lib/gfsResourceActions'

export type GfsResourceMenuOpenRequest = {
  id: number
  clientX: number | null
  clientY: number | null
}

export type GfsResourceMenuProps = {
  resourceName: string
  /** Reuse the action menu without a visible button, opened by its owning row. */
  triggerMode?: 'button' | 'context'
  contextTargetRef?: RefObject<HTMLElement | null>
  contextOpenRequest?: GfsResourceMenuOpenRequest | null
  onActionStart?: (
    actionId: string,
    keyboardActivated: boolean,
    opener: HTMLElement | null
  ) => import('@lib/gfsResourceActions').GfsResourceActionContext | undefined
  actions?: GfsResourceAction[]
  onManage?: () => void
  onCopyLink?: () => void
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
  /** Recursive folder export as a single zip archive (BUG-175). */
  onDownloadZip?: () => void
  onRename?: () => void
  onReplace?: (file: File) => void
  /** Open the move-to-folder flow. Move authority is parent-relative and
   *  enforced server-side, so callers do NOT gate this on local affordances. */
  onMove?: () => void
}
