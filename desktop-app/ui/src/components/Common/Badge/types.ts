import type { ReactNode } from 'react'

/** Unified primitive tone scale (§5). Additive: `warning | danger | info`
 * were folded in from Pill's inline union so Badge and Pill share one enum. */
export type PrimitiveTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'

/** D.5 chat-state variants. Each adds a `badge--<variant>` modifier (styled in styles.css). */
export type BadgeStateVariant = 'running' | 'awaiting_approval' | 'completed_unread'

export type BadgeProps = {
  children?: ReactNode
  className?: string
  tone?: PrimitiveTone
  /** Optional chat-state variant (running/awaiting_approval/completed_unread). */
  variant?: BadgeStateVariant
  /** Accessible label, used when the badge is icon/dot-only (no children). */
  label?: string
}
