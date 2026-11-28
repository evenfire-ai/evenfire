import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { GfsResourceNavigationRequest } from '@lib/gfsResourceNavigationIntent'
import type {
  GfsResourceDeepLinkEnvelope,
  PendingGfsDeepLink,
  SandboxUiSessionInvalidation,
} from '@/App.types'
import type { useAppController } from './useAppController'

type AppController = ReturnType<typeof useAppController>

/**
 * The refs App owns and the GFS deep-link hooks read and write live. Only
 * RefObjects belong here: a callback stored here would stay frozen at its
 * first value.
 */
export interface GfsDeepLinkRefs {
  acknowledgedGfsDeepLinkIdsRef: MutableRefObject<Set<number>>
  pendingGfsDeepLinksRef: MutableRefObject<PendingGfsDeepLink[]>
  activeGfsDeepLinkRef: MutableRefObject<GfsResourceNavigationRequest | null>
  processingGfsDeepLinkIdRef: MutableRefObject<number | null>
  sessionInvalidationRef: MutableRefObject<SandboxUiSessionInvalidation | null>
  sessionInvalidationQueueRevisionRef: MutableRefObject<number>
  gfsDeepLinkAcceptingRef: MutableRefObject<boolean>
  gfsDeepLinkMinimumIdRef: MutableRefObject<number>
  gfsDeepLinkIdentityRef: MutableRefObject<string | null | undefined>
  gfsDeepLinkGenerationRef: MutableRefObject<number>
}

export interface GfsDeepLinkInboxOptions {
  /** The controller object itself, never a copy: its fields are read live after each await. */
  vm: Pick<AppController, 'authenticatedPrincipalIdentity' | 'pushToast'>
  refs: GfsDeepLinkRefs
  setPendingGfsDeepLinkState: (next: PendingGfsDeepLink[]) => void
  setActiveGfsDeepLink: Dispatch<SetStateAction<GfsResourceNavigationRequest | null>>
}

export interface GfsDeepLinkInbox {
  acknowledgeGfsDeepLink: (id: number) => Promise<void>
  enqueueGfsDeepLink: (value: GfsResourceDeepLinkEnvelope) => void
}

export interface GfsDeepLinkActivationOptions {
  /** The controller object itself, never a copy: its fields are read live. */
  vm: Pick<
    AppController,
    | 'activateGfsResourceNavigation'
    | 'authenticatedPrincipalIdentity'
    | 'isAuthenticated'
    | 'isNavigationIntentCurrent'
    | 'navigationIntentSequence'
    | 'pushToast'
  >
  refs: Pick<
    GfsDeepLinkRefs,
    | 'activeGfsDeepLinkRef'
    | 'pendingGfsDeepLinksRef'
    | 'gfsDeepLinkGenerationRef'
    | 'processingGfsDeepLinkIdRef'
  >
  acknowledgeGfsDeepLink: (id: number) => Promise<void>
  bootSplashLoading: boolean
  /** Only a dependency: the effect reads the pending queue through its ref. */
  pendingGfsDeepLinks: readonly PendingGfsDeepLink[]
  setActiveGfsDeepLink: Dispatch<SetStateAction<GfsResourceNavigationRequest | null>>
}
