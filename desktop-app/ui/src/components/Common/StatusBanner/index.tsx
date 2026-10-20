import { joinClasses } from '@lib/classNames'
import type { StatusBannerProps } from './types'

export function StatusBanner({
  text,
  children,
  tone,
  leadingIcon,
  compact,
  title,
}: StatusBannerProps) {
  const icon =
    leadingIcon || (tone === 'success' ? '●' : tone === 'error' ? '!' : tone === 'warn' ? '⚠' : 'i')
  return (
    <div
      title={title}
      className={joinClasses('status-banner', `tone-${tone}`, compact && 'status-banner--compact')}
    >
      <span className="status-dot">{icon}</span>
      {children ?? <span>{text}</span>}
    </div>
  )
}

export type { StatusBannerProps } from './types'
