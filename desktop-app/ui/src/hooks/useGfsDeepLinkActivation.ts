import { useEffect } from 'react'
import { classifyGfsDeepLinkActivation } from '@lib/gfsDeepLinkState'
import type { GfsDeepLinkActivationOptions } from './useGfsDeepLink.types'

/** Activates the confirmed GFS link, or acknowledges one that went stale. */
export function useGfsDeepLinkActivation({
  vm,
  refs,
  acknowledgeGfsDeepLink,
  bootSplashLoading,
  pendingGfsDeepLinks,
  setActiveGfsDeepLink,
}: GfsDeepLinkActivationOptions): void {
  useEffect(() => {
    const decision = classifyGfsDeepLinkActivation({
      active: refs.activeGfsDeepLinkRef.current,
      pending: refs.pendingGfsDeepLinksRef.current,
      principalGeneration: refs.gfsDeepLinkGenerationRef.current,
      isNavigationIntentCurrent: sequence => vm.isNavigationIntentCurrent(sequence),
      bootSplashLoading,
      isAuthenticated: vm.isAuthenticated,
      authenticatedPrincipalIdentity: vm.authenticatedPrincipalIdentity,
      processingGfsDeepLinkId: refs.processingGfsDeepLinkIdRef.current,
    })
    if (decision.kind === 'acknowledge') {
      void acknowledgeGfsDeepLink(decision.id)
      return
    }
    if (decision.kind === 'wait') return
    if (decision.kind === 'malformed') {
      void acknowledgeGfsDeepLink(decision.id)
      vm.pushToast('Could not open EvenDrive link: the resource route is malformed.', 'error')
      return
    }
    const pending = decision.request
    refs.processingGfsDeepLinkIdRef.current = pending.id
    refs.activeGfsDeepLinkRef.current = pending
    setActiveGfsDeepLink(pending)
    try {
      if (!vm.activateGfsResourceNavigation(pending, refs.gfsDeepLinkGenerationRef.current)) {
        void acknowledgeGfsDeepLink(pending.id)
      }
    } catch (error) {
      refs.processingGfsDeepLinkIdRef.current = null
      refs.activeGfsDeepLinkRef.current = null
      setActiveGfsDeepLink(null)
      void acknowledgeGfsDeepLink(pending.id)
      vm.pushToast(
        `Could not open EvenDrive link: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      )
    }
  }, [
    acknowledgeGfsDeepLink,
    bootSplashLoading,
    pendingGfsDeepLinks,
    vm.activateGfsResourceNavigation,
    vm.authenticatedPrincipalIdentity,
    vm.isNavigationIntentCurrent,
    vm.isAuthenticated,
    vm.navigationIntentSequence,
    vm.pushToast,
  ])
}
