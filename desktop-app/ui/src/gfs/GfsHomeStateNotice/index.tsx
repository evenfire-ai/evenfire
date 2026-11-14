import { StatusBanner } from '@components/Common'
import type { GfsHomeStateNoticeProps } from './types'

/**
 * The home-state notice shared by the sidebar and the Files page "My home"
 * card: one sentence per state. A home being prepared is a polite status; a
 * conflict or a load error is an alert.
 */
export function GfsHomeStateNotice({ notice, variant }: GfsHomeStateNoticeProps) {
  if (notice.kind === 'pending') {
    return variant === 'sidebar' ? (
      <p className="da-file-explorer__message muted" role="status">
        {notice.text}
      </p>
    ) : (
      <div role="status">
        <StatusBanner tone="info" text={notice.text} />
      </div>
    )
  }
  return (
    <div role="alert">
      <StatusBanner compact={variant === 'sidebar'} tone="error" text={notice.text} />
    </div>
  )
}
