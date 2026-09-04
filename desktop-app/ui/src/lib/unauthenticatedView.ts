export type UnauthenticatedView = 'outage' | 'onboarding' | 'auth'

interface UnauthenticatedViewInput {
  hasDependencyOutage: boolean
  runtimeConfigMissing: boolean
  isAuthenticated: boolean
}

/**
 * Which screen the unauthenticated branch renders.
 *
 * Order matters: an outage wins over everything, because neither signing in
 * nor onboarding can succeed while a dependency is down. Onboarding comes
 * next, so a cold install never lands on a sign-in form for an environment it
 * does not have. `isAuthenticated` is checked even though the caller only
 * renders this branch while signed out — the invariant that onboarding never
 * appears to a signed-in user is worth holding in one place.
 */
export function selectUnauthenticatedView({
  hasDependencyOutage,
  runtimeConfigMissing,
  isAuthenticated,
}: UnauthenticatedViewInput): UnauthenticatedView {
  if (hasDependencyOutage) return 'outage'
  if (runtimeConfigMissing && !isAuthenticated) return 'onboarding'
  return 'auth'
}
