'use client'

import { isGrokSubscriptionUiEnabled } from '@lib/grokSubscriptionFeature'
import { useSubscriptionCapabilities } from './useSubscriptionCapabilities'

/**
 * True only once the shared Control API capability response proves the flag on.
 * A transient failure after a confirmed true value does not hide a previously
 * confirmed provider; before confirmation it still fails closed.
 */
export function useGrokSubscriptionEnabled(enabled = true): boolean {
  const { capabilities } = useSubscriptionCapabilities({ enabled })
  return isGrokSubscriptionUiEnabled({
    enabled: capabilities?.providers['grok-subscription']?.enabled ?? false,
  })
}
