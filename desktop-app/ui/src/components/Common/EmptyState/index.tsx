import type { EmptyStateProps } from './types'

export function EmptyState({ title, body }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      <p className="muted">{body}</p>
    </div>
  )
}

export type { EmptyStateProps } from './types'
