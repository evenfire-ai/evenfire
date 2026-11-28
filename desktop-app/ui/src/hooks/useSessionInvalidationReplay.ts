import { useEffect } from 'react'
import { enqueuePendingSandboxUiDeepLink } from '@lib/sandboxUiDeepLinkState'
import type { DeepLinkAcknowledgmentAuthority } from '../../../src/types'
import type { SessionInvalidationReplayOptions } from './useSessionInvalidation.types'

/**
 * While a session-invalidation barrier is up, re-reads the session and the
 * main-process queues, retires the links that no longer belong to it, and
 * re-queues the ones the replacement session may still open.
 */
export function useSessionInvalidationReplay({
  vm,
  refs,
  sessionInvalidation,
  sessionInvalidationRetryTick,
  setSessionInvalidation,
  setSessionInvalidationReadFailed,
  setSessionInvalidationRetryTick,
  setPendingSandboxUiDeepLinkState,
  enqueueGfsDeepLink,
}: SessionInvalidationReplayOptions): void {
  useEffect(() => {
    const barrier = sessionInvalidation
    if (!barrier || refs.sessionInvalidationRef.current !== barrier) return
    let cancelled = false
    const stillOwnsBarrier = () => !cancelled && refs.sessionInvalidationRef.current === barrier
    const retryAfterQueueChange = () => {
      if (stillOwnsBarrier()) setSessionInvalidationRetryTick(value => value + 1)
    }
    const listHeldQueues = async () => {
      const [appPending, gfsPending] = await Promise.all([
        window.clerum.sandboxUi.listPendingDeepLinks(),
        window.clerum.gfs?.listPendingDeepLinks?.(),
      ])
      return {
        apps: appPending.links
          .filter(link => link.id >= barrier.appDeepLinkMinimumId)
          .sort((left, right) => left.id - right.id),
        resources: (gfsPending?.links ?? [])
          .filter(link => link.id >= barrier.gfsDeepLinkMinimumId)
          .sort((left, right) => left.id - right.id),
      }
    }
    const hasNewQueueIds = (
      queues: Awaited<ReturnType<typeof listHeldQueues>>,
      checkedAppIds: ReadonlySet<number>,
      checkedResourceIds: ReadonlySet<number>
    ) =>
      queues.apps.some(link => !checkedAppIds.has(link.id)) ||
      queues.resources.some(link => !checkedResourceIds.has(link.id))

    const retireHeldQueues = async (
      queues: Awaited<ReturnType<typeof listHeldQueues>>,
      authority: DeepLinkAcknowledgmentAuthority
    ): Promise<boolean> => {
      const acknowledgeResource = window.clerum.gfs?.acknowledgeDeepLink
      if (queues.resources.length && !acknowledgeResource) {
        throw new Error('EvenDrive link acknowledgment is unavailable')
      }
      const results = await Promise.all([
        ...queues.apps.map(link => window.clerum.sandboxUi.acknowledgeDeepLink(link.id, authority)),
        ...queues.resources.map(link => acknowledgeResource!(link.id, authority)),
      ])
      if (!stillOwnsBarrier()) return false
      if (results.some(result => result !== true)) {
        retryAfterQueueChange()
        return false
      }
      return true
    }

    void (async () => {
      try {
        const [session, liveSessionGeneration, runtimeConfig] = await Promise.all([
          window.clerum.auth.getSessionState(),
          window.clerum.auth.getSessionGeneration(),
          window.clerum.auth.getRuntimeConfigState(),
        ])
        if (!stillOwnsBarrier()) return
        if (
          !Number.isSafeInteger(liveSessionGeneration) ||
          session.sessionGeneration !== liveSessionGeneration
        )
          return

        const navigationGeneration = window.clerum.gfs?.getUserNavigationGeneration?.()
        if (!Number.isSafeInteger(navigationGeneration) || navigationGeneration === null) return
        const retirementAuthority = {
          sessionGeneration: liveSessionGeneration,
          userNavigationGeneration: navigationGeneration!,
        }
        const queueRevisionBeforeSnapshot = refs.sessionInvalidationQueueRevisionRef.current
        const heldQueues = await listHeldQueues()
        if (!stillOwnsBarrier()) return
        if (refs.sessionInvalidationQueueRevisionRef.current !== queueRevisionBeforeSnapshot) {
          retryAfterQueueChange()
          return
        }
        const heldApps = heldQueues.apps
        const heldResources = heldQueues.resources
        const checkedAppIds = new Set(heldQueues.apps.map(link => link.id))
        const checkedResourceIds = new Set(heldQueues.resources.map(link => link.id))

        if (!session.authenticated || !session.me) {
          if (
            vm.isAuthenticated ||
            (vm.sessionGeneration !== null && vm.sessionGeneration !== undefined)
          )
            return
          // A confirmed signed-out snapshot retires only the exact IDs that
          // belonged to this barrier. A later invalidation can never be
          // acknowledged by this batch because queue IDs are monotonic.
          if (!(await retireHeldQueues(heldQueues, retirementAuthority))) return
          const queueRevisionBeforeFinalSnapshot = refs.sessionInvalidationQueueRevisionRef.current
          const [finalQueues, finalSession, finalSessionGeneration, finalRuntimeConfig] =
            await Promise.all([
              listHeldQueues(),
              window.clerum.auth.getSessionState(),
              window.clerum.auth.getSessionGeneration(),
              window.clerum.auth.getRuntimeConfigState(),
            ])
          if (!stillOwnsBarrier()) return
          if (
            refs.sessionInvalidationQueueRevisionRef.current !== queueRevisionBeforeFinalSnapshot ||
            hasNewQueueIds(finalQueues, checkedAppIds, checkedResourceIds)
          ) {
            retryAfterQueueChange()
            return
          }
          if (
            finalSession.authenticated ||
            finalSession.me ||
            finalSession.sessionGeneration !== finalSessionGeneration ||
            vm.isAuthenticated ||
            (vm.sessionGeneration !== null && vm.sessionGeneration !== undefined) ||
            finalRuntimeConfig.envKey !== runtimeConfig.envKey
          )
            return
          refs.sessionInvalidationRef.current = null
          setSessionInvalidation(null)
          setSessionInvalidationReadFailed(false)
          refs.sandboxUiDeepLinkMinimumIdRef.current = barrier.appDeepLinkMinimumId
          refs.gfsDeepLinkMinimumIdRef.current = barrier.gfsDeepLinkMinimumId
          refs.gfsDeepLinkAcceptingRef.current = true
          return
        }
        if (vm.sessionGeneration !== liveSessionGeneration) return

        const sessionTeamId = String(session.me.teamId ?? '').trim()
        const publishedIdentity = `${session.me.id}:${String(session.me.email || '')
          .trim()
          .toLowerCase()}:${sessionTeamId}`
        const matchesPublishedSession = (
          candidate: typeof session,
          candidateGeneration: number,
          candidateRuntimeConfig: typeof runtimeConfig
        ) => {
          const controllerIdentity = vm.me
            ? `${vm.me.id}:${String(vm.me.email || '')
                .trim()
                .toLowerCase()}:${String(vm.me.teamId ?? '').trim()}`
            : null
          return (
            candidate.authenticated &&
            !!candidate.me &&
            candidate.sessionGeneration === candidateGeneration &&
            candidateGeneration === vm.sessionGeneration &&
            `${candidate.me.id}:${String(candidate.me.email || '')
              .trim()
              .toLowerCase()}:${String(candidate.me.teamId ?? '').trim()}` === publishedIdentity &&
            vm.isAuthenticated &&
            controllerIdentity === publishedIdentity &&
            vm.currentTeamId === sessionTeamId &&
            !!vm.runtimeConfigState?.envKey &&
            candidateRuntimeConfig.envKey === runtimeConfig.envKey &&
            candidateRuntimeConfig.envKey === vm.runtimeConfigState.envKey
          )
        }
        if (!matchesPublishedSession(session, liveSessionGeneration, runtimeConfig)) return

        const rendererIntentSequence = vm.navigationIntentSequence
        const eligibleApps: typeof heldApps = []
        const staleApps: typeof heldApps = []
        const eligibleResources: typeof heldResources = []
        const staleResources: typeof heldResources = []
        for (const link of heldApps) {
          if (link.userNavigationGenerationAtActivation !== navigationGeneration) {
            staleApps.push(link)
          } else {
            eligibleApps.push(link)
          }
        }
        for (const link of heldResources) {
          if (link.userNavigationGenerationAtActivation !== navigationGeneration) {
            staleResources.push(link)
          } else {
            eligibleResources.push(link)
          }
        }

        // Recheck app visibility and cross-team membership through the
        // replacement session before any held link is offered to the user.
        // Cross-team app visibility is checked again by the normal post-switch
        // authorization path after explicit confirmation.
        const sameTeamApps = eligibleApps.filter(
          link => !link.teamId || link.teamId === sessionTeamId
        )
        const crossTeamApps = eligibleApps.filter(
          link => link.teamId && link.teamId !== sessionTeamId
        )
        const [appListing, teamDirectory] = await Promise.all([
          sameTeamApps.length ? window.clerum.sandboxUi.listApps() : Promise.resolve(null),
          crossTeamApps.length ? window.clerum.team.directory() : Promise.resolve(null),
        ])
        const [latestSession, latestSessionGeneration, latestRuntimeConfig] = await Promise.all([
          window.clerum.auth.getSessionState(),
          window.clerum.auth.getSessionGeneration(),
          window.clerum.auth.getRuntimeConfigState(),
        ])
        if (
          !stillOwnsBarrier() ||
          !vm.isNavigationIntentCurrent(rendererIntentSequence) ||
          window.clerum.gfs?.getUserNavigationGeneration?.() !== navigationGeneration ||
          !matchesPublishedSession(latestSession, latestSessionGeneration, latestRuntimeConfig)
        ) {
          return
        }
        if (refs.sessionInvalidationQueueRevisionRef.current !== queueRevisionBeforeSnapshot) {
          retryAfterQueueChange()
          return
        }
        const queueRevisionBeforeAuthorizationSnapshot =
          refs.sessionInvalidationQueueRevisionRef.current
        const authorizedQueues = await listHeldQueues()
        if (!stillOwnsBarrier()) return
        if (
          refs.sessionInvalidationQueueRevisionRef.current !==
            queueRevisionBeforeAuthorizationSnapshot ||
          hasNewQueueIds(authorizedQueues, checkedAppIds, checkedResourceIds)
        ) {
          retryAfterQueueChange()
          return
        }
        const currentAppIds = new Set(authorizedQueues.apps.map(link => link.id))
        const currentResourceIds = new Set(authorizedQueues.resources.map(link => link.id))

        const authorizedAppRefs = new Set(
          (appListing?.apps ?? []).map(app => app.appRef.toLowerCase())
        )
        const authorizedTeamIds = new Set((teamDirectory?.items ?? []).map(item => item.team.id))
        const finalApps = eligibleApps.filter(
          link =>
            currentAppIds.has(link.id) &&
            (link.teamId && link.teamId !== sessionTeamId
              ? authorizedTeamIds.has(link.teamId)
              : authorizedAppRefs.has(link.appRef.toLowerCase()))
        )
        const discardedApps = [
          ...staleApps.filter(link => currentAppIds.has(link.id)),
          ...eligibleApps.filter(link => currentAppIds.has(link.id) && !finalApps.includes(link)),
        ]
        const discardedResources = staleResources.filter(link => currentResourceIds.has(link.id))
        const finalResources = eligibleResources.filter(link => currentResourceIds.has(link.id))
        if (
          !(await retireHeldQueues(
            { apps: discardedApps, resources: discardedResources },
            retirementAuthority
          ))
        )
          return

        const queueRevisionBeforeFinalSnapshot = refs.sessionInvalidationQueueRevisionRef.current
        const [finalQueues, finalSession, finalSessionGeneration, finalRuntimeConfig] =
          await Promise.all([
            listHeldQueues(),
            window.clerum.auth.getSessionState(),
            window.clerum.auth.getSessionGeneration(),
            window.clerum.auth.getRuntimeConfigState(),
          ])
        if (!stillOwnsBarrier()) return
        if (
          refs.sessionInvalidationQueueRevisionRef.current !== queueRevisionBeforeFinalSnapshot ||
          hasNewQueueIds(finalQueues, checkedAppIds, checkedResourceIds) ||
          !vm.isNavigationIntentCurrent(rendererIntentSequence) ||
          window.clerum.gfs?.getUserNavigationGeneration?.() !== navigationGeneration ||
          !matchesPublishedSession(finalSession, finalSessionGeneration, finalRuntimeConfig)
        ) {
          if (
            refs.sessionInvalidationQueueRevisionRef.current !== queueRevisionBeforeFinalSnapshot ||
            hasNewQueueIds(finalQueues, checkedAppIds, checkedResourceIds)
          )
            retryAfterQueueChange()
          return
        }

        const finalAppIds = new Set(finalQueues.apps.map(link => link.id))
        const finalResourceIds = new Set(finalQueues.resources.map(link => link.id))
        refs.sandboxUiDeepLinkMinimumIdRef.current = barrier.appDeepLinkMinimumId
        refs.gfsDeepLinkMinimumIdRef.current = barrier.gfsDeepLinkMinimumId
        refs.gfsDeepLinkAcceptingRef.current = true
        refs.sessionInvalidationRef.current = null
        setSessionInvalidation(null)
        setSessionInvalidationReadFailed(false)
        for (const link of finalApps.filter(link => finalAppIds.has(link.id))) {
          const next = enqueuePendingSandboxUiDeepLink(
            refs.pendingSandboxUiDeepLinksRef.current,
            link,
            refs.activeConversationOriginRef.current,
            vm.authenticatedPrincipalIdentity
          )
          setPendingSandboxUiDeepLinkState(next)
        }
        finalResources.filter(link => finalResourceIds.has(link.id)).forEach(enqueueGfsDeepLink)
      } catch {
        if (stillOwnsBarrier()) setSessionInvalidationReadFailed(true)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [
    enqueueGfsDeepLink,
    sessionInvalidation,
    setPendingSandboxUiDeepLinkState,
    vm.authenticatedPrincipalIdentity,
    vm.currentTeamId,
    vm.isAuthenticated,
    vm.isNavigationIntentCurrent,
    vm.me,
    vm.navigationIntentSequence,
    vm.runtimeConfigState?.envKey,
    vm.sessionGeneration,
    sessionInvalidationRetryTick,
  ])
}
