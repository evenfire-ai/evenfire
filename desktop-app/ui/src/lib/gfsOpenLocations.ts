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
 * The chain a location's ancestry takes after a move relocated part of it.
 *
 * The chain is nearest first: [parent, grandparent, …]. A move of X under Y
 * leaves everything BELOW X where it was and replaces the segment ABOVE it:
 * X's old ancestors are gone, and Y (plus Y's own observed ancestors) takes
 * their place. The moved resource itself stays in the chain — it is still an
 * ancestor of the open resource.
 *
 * Y's own ancestors are only known when a surface has Y open; when none has,
 * the chain stops at Y. An unproven link is not a claim.
 */
export function relocateObservedChain(
  chain: readonly string[],
  movedResourceId: string,
  newParentId: string | null,
  newParentChain: readonly string[] = []
): string[] {
  const index = chain.indexOf(movedResourceId)
  if (index < 0) return [...chain]
  const below = chain.slice(0, index)
  if (!newParentId) return [...below, movedResourceId]
  const above = newParentChain.filter(
    ancestor =>
      ancestor !== newParentId && ancestor !== movedResourceId && !below.includes(ancestor)
  )
  return [...below, movedResourceId, newParentId, ...above]
}

/**
 * Apply a committed move to every published chain.
 *
 * The published chains are OBSERVED chains, so a move makes them stale for
 * every resource below the moved one. Relocating them keeps the shared
 * registry able to answer "is X an ancestor of the open resource?": a LATER
 * move of the moved resource's NEW parent would otherwise miss the surfaces
 * that have a descendant open — the registry and the children cache both
 * still hold the pre-move chain.
 *
 * The surface whose OPEN resource is the moved one relocates too: its whole
 * observed ancestry belonged to the old location, so the new chain starts at
 * the new parent — plus the new parent's own observed ancestors when another
 * surface has it open.
 */
export function relocatePublishedChains(
  locations: GfsOpenLocationRegistry,
  movedResourceId: string,
  newParentId: string | null
): GfsOpenLocationRegistry {
  // The registry is keyed by MOUNT, so the new parent's own chain is found by
  // the resource it has open — not by the key.
  const newParentChain = newParentId
    ? (Object.values(locations).find(location => location.resourceId === newParentId)
        ?.ancestorResourceIds ?? [])
    : []
  const aboveNewParent = newParentChain.filter(
    ancestor => ancestor !== newParentId && ancestor !== movedResourceId
  )
  const next: GfsOpenLocationRegistry = {}
  for (const [id, location] of Object.entries(locations)) {
    const relocated =
      location.resourceId === movedResourceId
        ? newParentId
          ? [newParentId, ...aboveNewParent]
          : []
        : relocateObservedChain(
            location.ancestorResourceIds,
            movedResourceId,
            newParentId,
            newParentChain
          )
    const unchanged =
      relocated.length === location.ancestorResourceIds.length &&
      relocated.every((value, index) => value === location.ancestorResourceIds[index])
    next[id] = unchanged ? location : { ...location, ancestorResourceIds: relocated }
  }
  return next
}

/** Publish the relocation of a committed move into the shared registry. */
export function publishGfsMoveRelocation(
  queryClient: QueryClient,
  sessionScope: string,
  movedResourceId: string,
  newParentId: string | null
): void {
  queryClient.setQueryData<GfsOpenLocationRegistry>(
    desktopQueryKeys.gfsOpenLocations(sessionScope),
    previous => relocatePublishedChains(previous ?? {}, movedResourceId, newParentId)
  )
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
