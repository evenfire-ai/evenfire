import type { QueryClient } from '@tanstack/react-query'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'

/**
 * The resource one controller mount has open, together with the ancestry
 * that mount observed on the way there.
 *
 * Every GFS surface mounts its OWN controller (the sidebar tree, the Files
 * page, the preview page, the composer's file modal), so the ancestry of an
 * open resource exists ONLY in the controller that opened it. A resource
 * opened by URI has ancestors that no children listing ever named, so the
 * shared children cache cannot connect it to the folder that was moved:
 * the observed chain is the only record of it.
 *
 * Publishing the open location makes that chain shared: a move committed by
 * ONE surface can then see that it changes what ANOTHER surface's open
 * Share/Manage dialog inherits.
 */
export type GfsOpenLocation = {
  /** The resource this mount has open. */
  resourceId: string
  /** The ancestors this mount observed, nearest first. */
  ancestorResourceIds: string[]
}

/** One entry per controller mount, keyed by that mount's identity. */
export type GfsOpenLocationRegistry = Record<string, GfsOpenLocation>

let openLocationCounter = 0

/** A stable identity for one controller mount's entry in the registry. */
export function nextGfsOpenLocationId(): string {
  openLocationCounter += 1
  return `gfs-open-location-${openLocationCounter}`
}

/**
 * Publish (or retract) one controller mount's open location.
 *
 * A `null` location retracts the entry: the mount has nothing open, its
 * session was revoked, or it unmounted.
 */
export function publishGfsOpenLocation(
  queryClient: QueryClient,
  sessionScope: string,
  locationId: string,
  location: GfsOpenLocation | null
): void {
  queryClient.setQueryData<GfsOpenLocationRegistry>(
    desktopQueryKeys.gfsOpenLocations(sessionScope),
    previous => {
      const next: GfsOpenLocationRegistry = { ...(previous ?? {}) }
      if (location) next[locationId] = location
      else delete next[locationId]
      return next
    }
  )
}

/** Every open location published in this session scope. */
export function readGfsOpenLocations(
  queryClient: QueryClient,
  sessionScope: string
): GfsOpenLocation[] {
  const registry = queryClient.getQueryData<GfsOpenLocationRegistry>(
    desktopQueryKeys.gfsOpenLocations(sessionScope)
  )
  return registry ? Object.values(registry) : []
}

/**
 * The open resources whose inherited access depends on the moved resource's
 * ancestry: the resource itself, or any resource below it.
 *
 * Only a chain that was OBSERVED counts. A resource whose ancestry no
 * surface observed is not claimed to depend on the move — an unproven link
 * is not evidence, and claiming it would re-read rows that cannot change.
 */
export function ancestryDependentGfsResourceIds(
  locations: readonly GfsOpenLocation[],
  movedResourceId: string
): string[] {
  const dependent = new Set<string>()
  for (const location of locations) {
    if (
      location.resourceId === movedResourceId ||
      location.ancestorResourceIds.includes(movedResourceId)
    ) {
      dependent.add(location.resourceId)
    }
  }
  return [...dependent]
}
