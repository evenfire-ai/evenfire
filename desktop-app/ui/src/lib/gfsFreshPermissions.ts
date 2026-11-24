import { GFS_DRIVE_MAIN } from '@constants/gfsBrowser'
import { desktopQueryKeys, isGfsSessionGeneration } from '@hooks/domain/queryKeys'
import {
  GFS_AUTHORITY_STALE_TIME_MS,
  assertGfsAuthorityRetryAllowed,
} from './gfsAuthorityQueryPolicy'
import type {
  GfsFreshAuthority,
  GfsFreshAuthorityRequest,
  GfsFreshPermissionsContext,
  GfsFreshPermissionsRequest,
  GfsServerAuthority,
} from './gfsFreshPermissions.types'
import { describeGfsReadError } from './gfsGrantErrors'

function holds(authority: GfsFreshAuthority, bit: string): boolean {
  return Boolean(authority.held?.includes(bit))
}

/**
 * Read one resource's affordances from the server through the shared query.
 * Every verdict is re-judged against the owner's live session after the read:
 * a stale request neither returns nor toasts, so a team switch or a revocation
 * during the read leaves no permission toast in the session that replaced it.
 */
export async function fetchGfsAuthority(
  { scope, gen, resourceId, resourceName, drive = GFS_DRIVE_MAIN }: GfsFreshAuthorityRequest,
  { queryClient, handleAuthorityFailure, pushToast, isCurrent }: GfsFreshPermissionsContext
): Promise<GfsServerAuthority | null> {
  if (!isCurrent()) return null
  if (!scope || !isGfsSessionGeneration(gen)) {
    pushToast?.(`Could not verify permissions for ${resourceName}. Try again.`, 'error')
    return null
  }
  const queryKey = desktopQueryKeys.gfsAffordances(scope, resourceId, drive, gen)
  try {
    assertGfsAuthorityRetryAllowed(queryClient, queryKey)
    const authority = await queryClient.fetchQuery({
      queryKey,
      queryFn: () => window.clerum.gfs.affordances(resourceId, drive),
      staleTime: GFS_AUTHORITY_STALE_TIME_MS,
      retry: false,
    })
    return isCurrent() ? authority : null
  } catch (error) {
    // The fail-closed decision is judged against the session the read was
    // issued under, so it runs even when the requesting owner is gone.
    const handled = handleAuthorityFailure(error, scope, gen)
    if (!handled && isCurrent()) pushToast?.(describeGfsReadError(error).message, 'error')
    return null
  }
}

/**
 * Authority to start an action on one resource: a fresh cached success is
 * reused, otherwise the owner's fallback, otherwise a server read. Returns
 * null, after the toast that explains it, when the bits are missing or no
 * longer grantable; returns null silently when the request is no longer the
 * owner's current one.
 */
export async function requireFreshGfsPermissions(
  request: GfsFreshPermissionsRequest,
  context: GfsFreshPermissionsContext
): Promise<GfsFreshAuthority | null> {
  const { scope, gen, resourceId, resourceName, bits, grantableBits = [] } = request
  const drive = request.drive ?? GFS_DRIVE_MAIN
  if (!scope || !isGfsSessionGeneration(gen)) return null
  const queryKey = desktopQueryKeys.gfsAffordances(scope, resourceId, drive, gen)
  const queryState = context.queryClient.getQueryState(queryKey)
  const stateAuthority = queryState?.data as GfsFreshAuthority | undefined
  const queryDataIsFresh = Boolean(
    queryState?.status === 'success' &&
    stateAuthority &&
    !queryState.isInvalidated &&
    Date.now() - queryState.dataUpdatedAt < GFS_AUTHORITY_STALE_TIME_MS
  )
  const fallback = queryDataIsFresh ? null : (context.fallbackAuthority?.(queryState) ?? null)
  const authority = queryDataIsFresh
    ? stateAuthority
    : (fallback ?? (await fetchGfsAuthority({ ...request, drive }, context)))
  if (!authority || !context.isCurrent()) return null
  const missing = bits.filter(bit => !holds(authority, bit))
  if (missing.length > 0) {
    const labels = missing.map(bit => (bit === 'manage_acl' ? 'manage' : bit))
    const label = labels.length === 1 ? labels[0] : labels.join(' and ')
    context.pushToast?.(`You do not have ${label} access to ${resourceName}.`, 'error')
    return null
  }
  const noLongerGrantable = grantableBits.filter(bit => !authority.grantableBits?.includes(bit))
  if (noLongerGrantable.length > 0) {
    context.pushToast?.(
      `You can no longer grant ${noLongerGrantable.join(' and ')} on ${resourceName}.`,
      'error'
    )
    return null
  }
  return authority
}
