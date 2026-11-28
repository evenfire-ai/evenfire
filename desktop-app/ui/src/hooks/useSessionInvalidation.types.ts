import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { GfsResourceNavigationRequest } from '@lib/gfsResourceNavigationIntent'
import type { SandboxUiConversationOrigin } from '@pages/SandboxUiPage.types'
import type {
  GfsResourceDeepLinkEnvelope,
  PendingGfsDeepLink,
  PendingSandboxUiDeepLink,
  SandboxUiSessionInvalidation,
} from '@/App.types'
import type { useAppController } from './useAppController'

type AppController = ReturnType<typeof useAppController>

/**
 * The refs App owns and the session-invalidation hooks read and write live.
 * Only RefObjects belong here: a callback stored here would stay frozen at its
 * first value.
 */
export interface SessionInvalidationRefs {
  sessionInvalidationRef: MutableRefObject<SandboxUiSessionInvalidation | null>
  sessionInvalidationQueueRevisionRef: MutableRefObject<number>
  sandboxUiDeepLinkMinimumIdRef: MutableRefObject<number>
  gfsDeepLinkMinimumIdRef: MutableRefObject<number>
  gfsDeepLinkGenerationRef: MutableRefObject<number>
  gfsDeepLinkAcceptingRef: MutableRefObject<boolean>
  pendingGfsDeepLinksRef: MutableRefObject<PendingGfsDeepLink[]>
  processingGfsDeepLinkIdRef: MutableRefObject<number | null>
  activeGfsDeepLinkRef: MutableRefObject<GfsResourceNavigationRequest | null>
  pendingSandboxUiDeepLinksRef: MutableRefObject<PendingSandboxUiDeepLink[]>
  activeConversationOriginRef: MutableRefObject<SandboxUiConversationOrigin | null>
}

export interface SessionInvalidationSubscriptionOptions {
  /** The controller object itself, never a copy: its fields are read live. */
  vm: Pick<AppController, 'sessionGeneration'>
  refs: SessionInvalidationRefs
  setSessionInvalidation: Dispatch<SetStateAction<SandboxUiSessionInvalidation | null>>
  setSessionInvalidationReadFailed: Dispatch<SetStateAction<boolean>>
  setActiveGfsDeepLink: Dispatch<SetStateAction<GfsResourceNavigationRequest | null>>
  resetSandboxUiDeepLinkSession: () => void
  setPendingGfsDeepLinkState: (next: PendingGfsDeepLink[]) => void
}

export interface SessionInvalidationReplayOptions {
  /** The controller object itself, never a copy: its fields are read live after each await. */
  vm: Pick<
    AppController,
    | 'authenticatedPrincipalIdentity'
    | 'currentTeamId'
    | 'isAuthenticated'
    | 'isNavigationIntentCurrent'
    | 'me'
    | 'navigationIntentSequence'
    | 'runtimeConfigState'
    | 'sessionGeneration'
  >
  refs: SessionInvalidationRefs
  sessionInvalidation: SandboxUiSessionInvalidation | null
  sessionInvalidationRetryTick: number
  setSessionInvalidation: Dispatch<SetStateAction<SandboxUiSessionInvalidation | null>>
  setSessionInvalidationReadFailed: Dispatch<SetStateAction<boolean>>
  setSessionInvalidationRetryTick: Dispatch<SetStateAction<number>>
  setPendingSandboxUiDeepLinkState: (next: PendingSandboxUiDeepLink[]) => void
  enqueueGfsDeepLink: (value: GfsResourceDeepLinkEnvelope) => void
}
