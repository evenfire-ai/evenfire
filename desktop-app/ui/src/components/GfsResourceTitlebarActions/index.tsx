import { createPortal } from 'react-dom'
import { Button } from 'antd'
import { IconCopy, IconOpenRoute, IconRefresh } from '@components/SidebarNav/icons'

export type GfsResourceTitlebarActionsProps = {
  target?: HTMLElement | null
  onRefresh?: () => void
  refreshing?: boolean
  onCopyLink?: () => void
  onOpenLink?: () => void
}

export function GfsResourceTitlebarActions({
  target,
  onRefresh,
  refreshing = false,
  onCopyLink,
  onOpenLink,
}: GfsResourceTitlebarActionsProps) {
  if (!target) return null

  return createPortal(
    <div className="window-titlebar__leading-actions" role="toolbar" aria-label="EvenDrive actions">
      {onRefresh ? (
        <span
          className={`titlebar-leading-action${refreshing ? ' titlebar-leading-action--disabled' : ''}`}
          title={refreshing ? 'Refreshing EvenDrive' : undefined}
        >
          <Button
            className="titlebar-leading-action__btn"
            aria-label="Refresh"
            title={refreshing ? 'Refreshing EvenDrive' : 'Refresh'}
            disabled={refreshing}
            htmlType="button"
            icon={<IconRefresh aria-hidden="true" />}
            loading={refreshing}
            onClick={onRefresh}
            size="small"
            type="text"
          />
        </span>
      ) : null}
      <span
        className={`titlebar-leading-action${onCopyLink ? '' : ' titlebar-leading-action--disabled'}`}
        title={onCopyLink ? undefined : 'No link is available on Shared with me'}
      >
        <Button
          className="titlebar-leading-action__btn"
          aria-label="Copy link"
          title={onCopyLink ? 'Copy link' : 'No link is available on Shared with me'}
          disabled={!onCopyLink}
          htmlType="button"
          icon={<IconCopy aria-hidden="true" />}
          onClick={onCopyLink}
          size="small"
          type="text"
        />
      </span>
      {onOpenLink ? (
        <span className="titlebar-leading-action">
          <Button
            className="titlebar-leading-action__btn"
            aria-label="Open link"
            title="Open link"
            htmlType="button"
            icon={<IconOpenRoute aria-hidden="true" />}
            onClick={onOpenLink}
            size="small"
            type="text"
          />
        </span>
      ) : null}
    </div>,
    target
  )
}
