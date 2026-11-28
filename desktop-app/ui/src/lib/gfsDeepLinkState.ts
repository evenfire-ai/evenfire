import { normalizeGfsResourceUri } from '@clerum/desktop-app-links'
import type {
  GfsDeepLinkAcceptanceInput,
  GfsDeepLinkActivationDecision,
  GfsDeepLinkActivationInput,
  GfsDeepLinkConfirmationInput,
  GfsDeepLinkPendingEntry,
} from './gfsDeepLinkState.types'

/**
 * The GFS link waiting for the user's confirmation dialog, or null. Sandbox app
 * links and startup take precedence: the dialog waits until neither is active.
 */
export function derivePendingGfsDeepLinkConfirmation<T extends GfsDeepLinkPendingEntry>(
  input: GfsDeepLinkConfirmationInput<T>
): T | null {
  const firstPendingGfsDeepLink = input.firstPendingGfsDeepLink
  return !input.pendingSandboxUiConfirmation &&
    !input.failedSandboxUiDeepLink &&
    !input.hasConfirmedSandboxUiDeepLink &&
    input.processingSandboxUiDeepLinkId === null &&
    !input.bootSplashLoading &&
    input.isAuthenticated &&
    !!input.authenticatedPrincipalIdentity &&
    !input.sessionInvalidation &&
    input.gfsDeepLinkAccepting &&
    input.processingGfsDeepLinkId === null &&
    input.activeGfsDeepLink === null &&
    firstPendingGfsDeepLink?.request === null &&
    (firstPendingGfsDeepLink.receivedIdentity === null ||
      firstPendingGfsDeepLink.receivedIdentity === input.authenticatedPrincipalIdentity)
    ? firstPendingGfsDeepLink
    : null
}

/** Whether a delivered link id may enter the renderer's pending queue. */
export function isGfsDeepLinkAcceptable(id: number, input: GfsDeepLinkAcceptanceInput): boolean {
  if (!input.accepting || id < input.minimumId) return false
  if (input.acknowledgedIds.has(id)) return false
  if (input.pending.some(item => item.envelope.id === id)) return false
  return true
}

/**
 * Next step for the activation effect. The caller passes the live ref values,
 * not React state: acknowledgements and the identity purge write the refs
 * synchronously within the same commit, before the state catches up.
 */
export function classifyGfsDeepLinkActivation(
  input: GfsDeepLinkActivationInput
): GfsDeepLinkActivationDecision {
  const active = input.active
  if (
    active &&
    (active.principalGeneration !== input.principalGeneration ||
      !input.isNavigationIntentCurrent(active.intentSequence))
  ) {
    return { kind: 'acknowledge', id: active.id }
  }

  const pending = input.pending.find(item => item.request !== null)?.request
  if (
    pending &&
    (pending.principalGeneration !== input.principalGeneration ||
      !input.isNavigationIntentCurrent(pending.intentSequence))
  ) {
    return { kind: 'acknowledge', id: pending.id }
  }

  if (
    input.bootSplashLoading ||
    !input.isAuthenticated ||
    !input.authenticatedPrincipalIdentity ||
    input.processingGfsDeepLinkId !== null
  ) {
    return { kind: 'wait' }
  }
  if (!pending) return { kind: 'wait' }
  if (!normalizeGfsResourceUri(pending.uri)) return { kind: 'malformed', id: pending.id }
  return { kind: 'activate', request: pending }
}
