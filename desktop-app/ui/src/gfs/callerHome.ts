import { GFS_MY_HOME_LABEL } from '@constants/gfsBrowser'
import type { GfsBrowserChild } from '@hooks/domain/useGfsBrowserController'

type CallerHome = {
  state: string
  drive: string | null
  resourceId: string | null
  path: string | null
} | null

/** True only for the caller's READY home root: same resource AND same drive. */
export function isCallerHomeRoot(
  home: CallerHome,
  resource: { resourceId: string; drive: string }
): boolean {
  return (
    home?.state === 'ready' &&
    home.drive != null &&
    home.resourceId != null &&
    resource.resourceId === home.resourceId &&
    resource.drive === home.drive
  )
}

/**
 * The caller's ready home as a browsable root named "My home", or null when
 * there is none to show. The home's own discovery row is reused when it is
 * listed, so its permissions and read decision drive the menus as for any
 * root; until discovery lists it, the row is built from the home view, which
 * carries no folder name. Every use of `name` for this root is presentation.
 * `version`/`bytes` 0 mean unknown, as for crumbs the server returns without
 * them; no write reads them.
 */
export function callerHomeRootNode<T extends GfsBrowserChild>(
  home: CallerHome,
  accessible: readonly T[] = []
): T | GfsBrowserChild | null {
  if (home?.state !== 'ready' || !home.drive || !home.resourceId) return null
  const listed = accessible.find(resource => isCallerHomeRoot(home, resource))
  if (listed) return { ...listed, name: GFS_MY_HOME_LABEL }
  const rid = home.resourceId.replace(/-/g, '').toLowerCase()
  return {
    resourceId: home.resourceId,
    rid,
    gfsUri: `gfs://${home.drive}/${rid}`,
    drive: home.drive,
    parentResourceId: null,
    name: GFS_MY_HOME_LABEL,
    kind: 'directory',
    path: home.path,
    version: 0,
    bytes: 0,
  }
}
