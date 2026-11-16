import type { QueryClient } from '@tanstack/react-query'
import {
  desktopQueryKeys,
  hasGfsSessionGeneration,
  isGfsSessionGeneration,
} from '@hooks/domain/queryKeys'
import { gfsRidOfResourceId } from './gfsWatchKeys'

/** The session a reaction acts for: queries of any other scope or generation are left alone. */
export interface GfsWatchAuthority {
  scope: string | null
  generation: number | null
}

type QueryLike = { queryKey: readonly unknown[] }

const ACCESS_FAMILIES = new Set([
  'accessible',
  'grants',
  'shares',
  'inherited-access',
  'affordances',
])

function sessionFilter(
  authority: GfsWatchAuthority,
  matches: (key: readonly unknown[]) => boolean
) {
  return {
    queryKey: desktopQueryKeys.gfsRoot,
    predicate: (query: QueryLike) =>
      query.queryKey[2] === authority.scope &&
      hasGfsSessionGeneration(query.queryKey, authority.generation) &&
      matches(query.queryKey),
  }
}

function ownsSession(authority: GfsWatchAuthority): boolean {
  return Boolean(authority.scope) && isGfsSessionGeneration(authority.generation)
}

/**
 * Re-reads the active queries `filters` selects. A read already in flight (a
 * navigation, or the page chain of `fetchNextPage`) is joined instead of
 * cancelled — TanStack's default `cancelRefetch: true` would abort it on every
 * change, so a "load more" never lands while changes keep arriving. The joined
 * read may have started before the change, so it is followed by one more pass.
 */
async function refetchActiveJoining(
  queryClient: QueryClient,
  filters: ReturnType<typeof sessionFilter>
): Promise<void> {
  const joinedRead = queryClient.isFetching(filters) > 0
  await queryClient.invalidateQueries(
    { ...filters, refetchType: 'active' },
    { cancelRefetch: false }
  )
  if (joinedRead) {
    await queryClient.invalidateQueries(
      { ...filters, refetchType: 'active' },
      { cancelRefetch: false }
    )
  }
}

/** Re-reads the cached listings of one folder. */
export async function refetchWatchedFolder(
  queryClient: QueryClient,
  authority: GfsWatchAuthority,
  drive: string,
  rid: string
): Promise<void> {
  if (!ownsSession(authority)) return
  await refetchActiveJoining(
    queryClient,
    sessionFilter(
      authority,
      key =>
        key[3] === 'children' &&
        key[4] === drive &&
        typeof key[5] === 'string' &&
        gfsRidOfResourceId(key[5]) === rid
    )
  )
}

/**
 * Access may have changed anywhere: roots and every open sharing dialog re-read.
 * Folder listings are only marked stale: a watched folder is re-read by its own
 * `resync`, and one that is not watched now re-reads when it is shown again
 * instead of serving rows listed under the previous permissions.
 */
export async function refetchGfsAccess(
  queryClient: QueryClient,
  authority: GfsWatchAuthority
): Promise<void> {
  if (!ownsSession(authority)) return
  await Promise.all([
    refetchActiveJoining(
      queryClient,
      sessionFilter(authority, key => ACCESS_FAMILIES.has(String(key[3])))
    ),
    queryClient.invalidateQueries({
      ...sessionFilter(authority, key => key[3] === 'children'),
      refetchType: 'none',
    }),
  ])
}

export async function refetchGfsRoots(
  queryClient: QueryClient,
  authority: GfsWatchAuthority
): Promise<void> {
  if (!ownsSession(authority)) return
  await refetchActiveJoining(
    queryClient,
    sessionFilter(authority, key => key[3] === 'accessible')
  )
}

/**
 * The session is gone: nothing fetched under it may stay visible, whether or
 * not a query or a preview happens to be mounted right now. The shared access
 * flag lives outside the GFS cache, so removing the cache does not clear it,
 * and every browser mount stops reading until a new session generation.
 */
export function purgeGfsSessionCache(queryClient: QueryClient, authority: GfsWatchAuthority): void {
  queryClient.removeQueries({ queryKey: desktopQueryKeys.gfsRoot })
  if (!ownsSession(authority)) return
  queryClient.setQueryData(
    desktopQueryKeys.gfsAccessState(authority.scope!, authority.generation),
    'revoked'
  )
}
