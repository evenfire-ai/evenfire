import { useCallback, useEffect } from 'react'
import { normalizeGfsResourceUri } from '@clerum/desktop-app-links'
import { isGfsDeepLinkAcceptable } from '@lib/gfsDeepLinkState'
import { shouldPurgeSandboxUiDeepLinks } from '@lib/sandboxUiDeepLinkState'
import type { GfsResourceDeepLinkEnvelope } from '@/App.types'
import type { GfsDeepLinkInbox, GfsDeepLinkInboxOptions } from './useGfsDeepLink.types'

/**
 * Receives GFS deep links from main: purges the queue when the signed-in
 * principal changes, subscribes to new links and drains the pending ones.
 */
export function useGfsDeepLinkInbox({
  vm,
  refs,
  setPendingGfsDeepLinkState,
  setActiveGfsDeepLink,
}: GfsDeepLinkInboxOptions): GfsDeepLinkInbox {
  const acknowledgeGfsDeepLink = useCallback(
    async (id: number) => {
      if (refs.acknowledgedGfsDeepLinkIdsRef.current.has(id)) return
      refs.acknowledgedGfsDeepLinkIdsRef.current.add(id)
      setPendingGfsDeepLinkState(
        refs.pendingGfsDeepLinksRef.current.filter(item => item.envelope.id !== id)
      )
      if (refs.activeGfsDeepLinkRef.current?.id === id) {
        refs.activeGfsDeepLinkRef.current = null
        setActiveGfsDeepLink(null)
      }
      if (refs.processingGfsDeepLinkIdRef.current === id)
        refs.processingGfsDeepLinkIdRef.current = null
      try {
        await window.clerum.gfs?.acknowledgeDeepLink?.(id)
      } catch {
        // Main can replay an unacknowledged entry after renderer restart.
      }
    },
    [setPendingGfsDeepLinkState]
  )

  const enqueueGfsDeepLink = useCallback(
    (value: GfsResourceDeepLinkEnvelope) => {
      if (!Number.isSafeInteger(value?.id) || value.id <= 0) return
      if (refs.sessionInvalidationRef.current) {
        refs.sessionInvalidationQueueRevisionRef.current += 1
        return
      }
      if (
        !isGfsDeepLinkAcceptable(value.id, {
          accepting: refs.gfsDeepLinkAcceptingRef.current,
          minimumId: refs.gfsDeepLinkMinimumIdRef.current,
          acknowledgedIds: refs.acknowledgedGfsDeepLinkIdsRef.current,
          pending: refs.pendingGfsDeepLinksRef.current,
        })
      ) {
        return
      }
      const uri = normalizeGfsResourceUri(value?.uri)
      if (!uri) {
        vm.pushToast('Could not open EvenDrive link: the resource route is malformed.', 'error')
        void acknowledgeGfsDeepLink(value.id)
        return
      }
      setPendingGfsDeepLinkState([
        ...refs.pendingGfsDeepLinksRef.current,
        {
          envelope: value,
          uri,
          receivedIdentity: vm.authenticatedPrincipalIdentity,
          request: null,
        },
      ])
    },
    [
      acknowledgeGfsDeepLink,
      setPendingGfsDeepLinkState,
      vm.authenticatedPrincipalIdentity,
      vm.pushToast,
    ]
  )

  useEffect(() => {
    const identity = vm.authenticatedPrincipalIdentity
    const previousIdentity = refs.gfsDeepLinkIdentityRef.current
    refs.gfsDeepLinkIdentityRef.current = identity
    if (
      refs.sessionInvalidationRef.current ||
      !shouldPurgeSandboxUiDeepLinks(previousIdentity, identity)
    )
      return

    const generation = ++refs.gfsDeepLinkGenerationRef.current
    refs.gfsDeepLinkAcceptingRef.current = false
    setPendingGfsDeepLinkState([])
    refs.processingGfsDeepLinkIdRef.current = null
    refs.activeGfsDeepLinkRef.current = null
    setActiveGfsDeepLink(null)
    void (async () => {
      try {
        const minimumId = await window.clerum.gfs?.clearPendingDeepLinks?.()
        if (generation !== refs.gfsDeepLinkGenerationRef.current) return
        if (!Number.isSafeInteger(minimumId) || minimumId === undefined || minimumId < 1) {
          throw new Error('The EvenDrive deep-link queue did not return a valid reset boundary')
        }
        refs.gfsDeepLinkMinimumIdRef.current = Math.max(
          refs.gfsDeepLinkMinimumIdRef.current,
          minimumId
        )
        refs.gfsDeepLinkAcceptingRef.current = true

        const pending = await window.clerum.gfs?.listPendingDeepLinks?.()
        if (generation !== refs.gfsDeepLinkGenerationRef.current) return
        const currentLinks = pending?.links.filter(
          link => link.id >= refs.gfsDeepLinkMinimumIdRef.current
        )
        currentLinks?.forEach(enqueueGfsDeepLink)
      } catch {
        if (generation === refs.gfsDeepLinkGenerationRef.current) {
          vm.pushToast(
            'Could not safely refresh pending EvenDrive links after the account changed.',
            'error'
          )
        }
      }
    })()
  }, [
    enqueueGfsDeepLink,
    acknowledgeGfsDeepLink,
    setPendingGfsDeepLinkState,
    vm.authenticatedPrincipalIdentity,
    vm.pushToast,
  ])

  useEffect(() => {
    let cancelled = false
    const unsubscribe = window.clerum.gfs?.onDeepLink?.(enqueueGfsDeepLink)
    const listGeneration = refs.gfsDeepLinkGenerationRef.current
    const pendingLinks = refs.gfsDeepLinkAcceptingRef.current
      ? window.clerum.gfs?.listPendingDeepLinks?.()
      : undefined
    void pendingLinks
      ?.then(result => {
        if (
          cancelled ||
          listGeneration !== refs.gfsDeepLinkGenerationRef.current ||
          !refs.gfsDeepLinkAcceptingRef.current
        )
          return
        const currentLinks = result?.links.filter(
          link => link.id >= refs.gfsDeepLinkMinimumIdRef.current
        )
        currentLinks?.forEach(enqueueGfsDeepLink)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [acknowledgeGfsDeepLink, enqueueGfsDeepLink])

  return { acknowledgeGfsDeepLink, enqueueGfsDeepLink }
}
