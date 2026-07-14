'use client'

import { Button } from '../ui'

/** Shared "could not load … Retry" banner used by the Publisher panels. */
export function RetryBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <p className="cu-banner cu-banner--warn">
      {message}{' '}
      <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </p>
  )
}
