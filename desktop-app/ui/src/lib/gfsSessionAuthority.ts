import type { QueryClient } from '@tanstack/react-query'
import {
  desktopQueryKeys,
  hasGfsSessionGeneration,
  isGfsSessionAuthorityCurrent,
  isGfsSessionGeneration,
} from '@hooks/domain/queryKeys'
import { isGfsSessionAuthorityFailure } from './gfsGrantErrors'
import type {
  GfsAccessState,
  GfsAuthorityFailureOutcome,
  GfsAuthoritySurface,
  GfsLiveSessionAuthority,
  GfsSessionScopeSource,
} from './gfsSessionAuthority.types'

/**
 * GFS cache scope for the signed-in session. The environment is part of it
 * because the same user/team pair addresses different resources across
 * clusters, so an environment switch must not reuse another cluster's cache.
 */
export function gfsSessionScope({
  isAuthenticated,
  me,
  runtimeConfigState,
}: GfsSessionScopeSource): string | null {
  if (!isAuthenticated || !me) return null
  return `${runtimeConfigState?.envKey ?? ''}:${me.id}:${me.teamId ?? ''}`
}

/**
 * Synchronous read of the shared access flag. A missing entry reads as revoked:
 * it only goes missing when the cache was cleared (logout) or never belonged to
 * a mounted session, and neither proves the session may act. With no scope the
 * key would be the shared 'anonymous' entry, which every mount seeds as active.
 */
export function readGfsAccessState(
  queryClient: QueryClient,
  scope: string | null,
  generation: number | null
): GfsAccessState {
  if (!scope || !isGfsSessionGeneration(generation)) return 'revoked'
  return (
    queryClient.getQueryData<GfsAccessState>(desktopQueryKeys.gfsAccessState(scope, generation)) ??
    'revoked'
  )
}

/**
 * Revoke one session's GFS access: every mount observes the shared flag and
 * gates its queries off, and the session's cached responses are dropped so no
 * metadata outlives the access that produced it. The flag lives outside
 * `gfsRoot`, so the purge below cannot clear the decision it just recorded.
 * Without a scope there is no session to revoke: `readGfsAccessState` already
 * reads a missing scope as revoked.
 */
export function revokeGfsSessionAccess(
  queryClient: QueryClient,
  scope: string | null,
  generation: number | null
): void {
  if (!scope) return
  queryClient.setQueryData<GfsAccessState>(
    desktopQueryKeys.gfsAccessState(scope, generation),
    'revoked'
  )
  queryClient.removeQueries({
    queryKey: desktopQueryKeys.gfsRoot,
    predicate: query =>
      query.queryKey[2] === scope && hasGfsSessionGeneration(query.queryKey, generation),
  })
}

/**
 * True when main still runs the expected session generation AND the renderer
 * has published it. Main switches first on a team or environment change, so
 * the published value alone can lag behind the session requests are sent with.
 */
export async function isGfsSessionGenerationConfirmed(
  expected: number,
  readPublishedGeneration: () => number | null
): Promise<boolean> {
  try {
    const authoritativeGeneration = await window.clerum.auth.getSessionGeneration()
    return authoritativeGeneration === expected && readPublishedGeneration() === expected
  } catch {
    return false
  }
}

/**
 * Fail closed on a session-authority rejection, judged against the session
 * the failing request was issued under. A late 401 from a session that was
 * already replaced (team or environment switch) must not revoke the session
 * that replaced it. The decision does not depend on the requesting surface
 * still being mounted.
 */
export function handleGfsAuthorityFailure(
  queryClient: QueryClient,
  capturedScope: string | null,
  capturedGeneration: number | null,
  message: string,
  surface: GfsAuthoritySurface,
  live: GfsLiveSessionAuthority
): GfsAuthorityFailureOutcome {
  if (!isGfsSessionAuthorityFailure(message, surface)) return 'not-authority'
  if (
    !isGfsSessionAuthorityCurrent(capturedScope, capturedGeneration, live.scope, live.generation)
  ) {
    return 'stale'
  }
  revokeGfsSessionAccess(queryClient, capturedScope, capturedGeneration)
  return 'revoked'
}
