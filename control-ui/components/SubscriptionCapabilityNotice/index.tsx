'use client'

import { Button } from '@components/ui'
import type { SubscriptionCapabilityNoticeProps } from './types'

export function SubscriptionCapabilityNotice({ state }: SubscriptionCapabilityNoticeProps) {
  if (!state.capabilities && state.loading) {
    return (
      <p className="cu-muted" role="status">
        Checking available providers…
      </p>
    )
  }
  if (!state.error) return null
  return (
    <div className="cu-banner cu-banner--error" role="alert">
      <span>Provider availability could not be checked. {state.error.message}</span>
      <Button
        type="button"
        className="cu-btn--sm"
        variant="ghost"
        onClick={state.retry}
        disabled={state.loading}
      >
        {state.loading ? 'Retrying…' : 'Retry'}
      </Button>
    </div>
  )
}
