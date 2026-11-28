import { useCallback, useEffect } from 'react'
import type { SandboxUiSessionInvalidation } from '@/App.types'
import type { SessionInvalidationSubscriptionOptions } from './useSessionInvalidation.types'

/**
 * Applies a main-process session invalidation: raises the deep-link barrier,
 * lifts the queue floors and drops every renderer-held link. The replay hook
 * lowers the barrier again once the replacement session is confirmed.
 */
export function useSessionInvalidationSubscription({
  vm,
  refs,
  setSessionInvalidation,
  setSessionInvalidationReadFailed,
  setActiveGfsDeepLink,
  resetSandboxUiDeepLinkSession,
  setPendingGfsDeepLinkState,
}: SessionInvalidationSubscriptionOptions): void {
  const handleSessionInvalidated = useCallback(
    (event: SandboxUiSessionInvalidation) => {
      // Older component harnesses use a controller stub with no published
      // generation. Keep their existing reset behavior; the production
      // controller always publishes number|null from the main session source.
      if (vm.sessionGeneration === undefined) {
        resetSandboxUiDeepLinkSession()
        return
      }
      const current = refs.sessionInvalidationRef.current
      if (current && event.sessionGeneration < current.sessionGeneration) return
      refs.sessionInvalidationRef.current = event
      setSessionInvalidation(event)
      setSessionInvalidationReadFailed(false)
      refs.sandboxUiDeepLinkMinimumIdRef.current = Math.max(
        refs.sandboxUiDeepLinkMinimumIdRef.current,
        event.appDeepLinkMinimumId
      )
      refs.gfsDeepLinkMinimumIdRef.current = Math.max(
        refs.gfsDeepLinkMinimumIdRef.current,
        event.gfsDeepLinkMinimumId
      )
      resetSandboxUiDeepLinkSession()
      refs.gfsDeepLinkGenerationRef.current += 1
      refs.gfsDeepLinkAcceptingRef.current = false
      refs.pendingGfsDeepLinksRef.current = []
      refs.processingGfsDeepLinkIdRef.current = null
      refs.activeGfsDeepLinkRef.current = null
      setActiveGfsDeepLink(null)
      setPendingGfsDeepLinkState([])
    },
    [resetSandboxUiDeepLinkSession, setPendingGfsDeepLinkState, vm.sessionGeneration]
  )

  useEffect(
    () => window.clerum.sandboxUi.onSessionInvalidated(handleSessionInvalidated),
    [handleSessionInvalidated]
  )
}
