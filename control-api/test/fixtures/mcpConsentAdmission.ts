import { vi } from 'vitest'
import type { K8sGateway } from '../../src/k8s.js'
import type { CallbackDeps } from '../../src/oauth/callback.js'
import type { ContextMembershipDirectory } from '../../src/services/access/contextMembership.js'
import { authorizeMcpOAuthConsent } from '../../src/services/access/mcpOauthAdmission.js'

/** The callback's consent-admission dependency (`CallbackDeps.consentAdmission`). */
export type ConsentAdmission = NonNullable<CallbackDeps['consentAdmission']>

/**
 * Stand-in admission for callback suites that do not certify admission itself:
 * admits a consent iff the server's authoritative `contextRef` is one of
 * `contextIds`, for either grant scope. The real rule (agent exposure for
 * per-user servers, PR #1004) is certified by `authorizeMcpOAuthConsent`'s own
 * suite and by `realConsentAdmission` below.
 */
export function admitContexts(contextIds: readonly string[]) {
  return vi.fn<ConsentAdmission>(async (_userId, server) =>
    Boolean(server.contextRef && contextIds.includes(server.contextRef))
  )
}

/** The production admission rule over a test gateway + directory. */
export function realConsentAdmission(
  gateway: K8sGateway,
  directory: ContextMembershipDirectory
): ConsentAdmission {
  return (userId, server) => authorizeMcpOAuthConsent(gateway, userId, server, directory)
}
