'use client'

import { useEffect, useState } from 'react'
import {
  isGrokSubscriptionUiEnabled,
  loadGrokSubscriptionCapability,
} from '@lib/grokSubscriptionFeature'

/**
 * True only once the Control API Grok capability probe proves the flag on.
 * Starts false and fails closed: a probe error keeps Grok out of operator
 * pickers exactly like the flag being off (a saved Grok value is still shown by
 * the caller, marked "(disabled)").
 */
export function useGrokSubscriptionEnabled(): boolean {
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    let cancelled = false
    loadGrokSubscriptionCapability().then(
      capability => {
        if (!cancelled) setEnabled(isGrokSubscriptionUiEnabled(capability))
      },
      () => {
        if (!cancelled) setEnabled(false)
      }
    )
    return () => {
      cancelled = true
    }
  }, [])

  return enabled
}
