import type { PendingSandboxUiDeepLink, SandboxUiSessionInvalidation } from '@/App.types'
import type { GfsResourceNavigationRequest } from './gfsResourceNavigationIntent'

export interface GfsDeepLinkPendingEntry {
  readonly envelope: { readonly id: number }
  readonly receivedIdentity: string | null
  readonly request: GfsResourceNavigationRequest | null
}

export interface GfsDeepLinkConfirmationInput<T extends GfsDeepLinkPendingEntry> {
  readonly pendingSandboxUiConfirmation: PendingSandboxUiDeepLink | null
  readonly failedSandboxUiDeepLink: PendingSandboxUiDeepLink | null | undefined
  readonly hasConfirmedSandboxUiDeepLink: boolean
  readonly processingSandboxUiDeepLinkId: number | null
  readonly bootSplashLoading: boolean
  readonly isAuthenticated: boolean
  readonly authenticatedPrincipalIdentity: string | null
  readonly sessionInvalidation: SandboxUiSessionInvalidation | null
  readonly gfsDeepLinkAccepting: boolean
  readonly processingGfsDeepLinkId: number | null
  readonly activeGfsDeepLink: GfsResourceNavigationRequest | null
  readonly firstPendingGfsDeepLink: T | undefined
}

export interface GfsDeepLinkAcceptanceInput {
  readonly accepting: boolean
  readonly minimumId: number
  readonly acknowledgedIds: ReadonlySet<number>
  readonly pending: readonly GfsDeepLinkPendingEntry[]
}

export interface GfsDeepLinkActivationInput {
  readonly active: GfsResourceNavigationRequest | null
  readonly pending: readonly GfsDeepLinkPendingEntry[]
  readonly principalGeneration: number
  readonly isNavigationIntentCurrent: (sequence: number) => boolean
  readonly bootSplashLoading: boolean
  readonly isAuthenticated: boolean
  readonly authenticatedPrincipalIdentity: string | null
  readonly processingGfsDeepLinkId: number | null
}

export type GfsDeepLinkActivationDecision =
  | { readonly kind: 'acknowledge'; readonly id: number }
  | { readonly kind: 'wait' }
  | { readonly kind: 'malformed'; readonly id: number }
  | { readonly kind: 'activate'; readonly request: GfsResourceNavigationRequest }
