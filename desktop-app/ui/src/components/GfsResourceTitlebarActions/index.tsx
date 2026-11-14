import { createPortal } from 'react-dom'
import { IconButton } from '@components/Common'
import { IconCopy, IconOpenRoute, IconRefresh } from '@components/SidebarNav/icons'

export type GfsResourceTitlebarActionsProps = {
  target?: HTMLElement | null
  onRefresh?: () => void
  refreshing?: boolean
  refreshDisabled?: boolean
  onCopyLink?: () => void
  onOpenLink?: () => void
}

export function GfsResourceTitlebarActions({
  target,
  onRefresh,
  refreshing = false,
  refreshDisabled = false,
  onCopyLink,
  onOpenLink,
}: GfsResourceTitlebarActionsProps) {
  if (!target) return null

  return createPortal(
    <div className="window-titlebar__leading-actions" role="toolbar" aria-label="EvenDrive actions">
      {onRefresh ? (
        <span
          className={`titlebar-leading-action${refreshing || refreshDisabled ? ' titlebar-leading-action--disabled' : ''}`}
          title={
            refreshDisabled
              ? 'Wait before refreshing'
              : refreshing
                ? 'Refreshing EvenDrive'
                : undefined
          }
        >
          <IconButton
            className="titlebar-leading-action__btn"
            label="Refresh"
            disabled={refreshing || refreshDisabled}
            onClick={onRefresh}
            size="sm"
            variant="ghost"
          >
            <IconRefresh />
          </IconButton>
        </span>
      ) : null}
      <span
        className={`titlebar-leading-action${onCopyLink ? '' : ' titlebar-leading-action--disabled'}`}
        title={onCopyLink ? undefined : 'No link is available for this view'}
      >
        <IconButton
          className="titlebar-leading-action__btn"
          label="Copy link"
          disabled={!onCopyLink}
          onClick={onCopyLink}
          size="sm"
          variant="ghost"
        >
          <IconCopy />
        </IconButton>
      </span>
      {onOpenLink ? (
        <span className="titlebar-leading-action">
          <IconButton
            className="titlebar-leading-action__btn"
            label="Open link"
            onClick={onOpenLink}
            size="sm"
            variant="ghost"
          >
            <IconOpenRoute />
          </IconButton>
        </span>
      ) : null}
    </div>,
    target
  )
}
