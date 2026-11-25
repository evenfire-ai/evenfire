import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useAuthContext } from '@contexts/AuthContext'
import type { Query } from '@tanstack/react-query'
import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { GFS_BREADCRUMB_MAX_DEPTH } from '@constants/gfsBrowser'
import {
  GFS_AUTHORITY_STALE_TIME_MS,
  GFS_ROW_PRESENTATION_CACHE_MS,
  gfsAuthorityQueryPolicy,
} from '@lib/gfsAuthorityQueryPolicy'
import {
  describeGfsReadError,
  isGfsSessionAuthorityFailure,
  isRateLimited,
  parseHttpStatus,
  parseRetryAfterSeconds,
} from '@lib/gfsGrantErrors'
import {
  type GfsOpenLocationRegistry,
  nextGfsOpenLocationId,
  publishGfsOpenLocation,
} from '@lib/gfsOpenLocations'
import {
  gfsSessionScope,
  handleGfsAuthorityFailure,
  isGfsSessionGenerationConfirmed,
  readGfsAccessState,
  revokeGfsSessionAccess,
} from '@lib/gfsSessionAuthority'
import type { GfsAccessState } from '@lib/gfsSessionAuthority.types'
import {
  desktopQueryKeys,
  hasGfsSessionGeneration,
  isGfsSessionAuthorityCurrent,
  isGfsSessionGeneration,
} from './queryKeys'
import { useGfsResourceOperations } from './useGfsResourceOperations'
import type {
  GfsCommittedOperation,
  GfsMoveConvergenceInput,
} from './useGfsResourceOperations.types'

/**
 * P4-S07 — Desktop Global File System browser controller (user plane).
 *
 * TanStack Query is the server-state source of truth (desktop-app/ui rule). The
 * browse is access-driven: the user first sees explicit resources granted or
 * shared with them, and can still open a `gfs://` URI manually. There is no
 * full-drive tree on the user plane — listing the whole drive is an operator
 * capability. Children are paginated with `useInfiniteQuery` so a large folder
 * is never silently truncated.
 *
 * Affordances flow through window.clerum.gfs, which reaches control-api
 * `/external/gfs/*` on the existing Session-JWT plane. Sharing (grants,
 * shares, inherited access) is read per explicit resource by
 * `useGfsResourceAccess`, never by browser location.
 * Enforcement (no-escalation) is always server-side; affordances only decide
 * which controls to SHOW.
 */

const DRIVE = 'main'
export const GFS_UNAVAILABLE_LOCATION_MESSAGE = 'This folder or file is no longer available.'

export type GfsUriOpenFailure = { kind: 'superseded' } | { kind: 'error'; error: unknown }

export interface GfsBrowserChild {
  resourceId: string
  rid: string
  gfsUri: string
  drive: string
  parentResourceId: string | null
  name: string
  kind: 'file' | 'directory'
  path: string | null
  version: number
  bytes: number
  /**
   * Server-computed read decision for the listing caller. Absent on older
   * servers (treat as unknown); `false` means the row is visible but cannot
   * be opened or downloaded — a folder grant without inheritance.
   */
  readable?: boolean
}

interface GfsAccessibleResource extends GfsBrowserChild {
  sources: string[]
  permissions: string[]
  coversDescendants: boolean
}

type GfsAccessibleWirePage = Awaited<ReturnType<typeof window.clerum.gfs.listAccessible>>

function normalizeAccessibleResource(
  item: GfsAccessibleWirePage['items'][number]
): GfsAccessibleResource {
  return {
    ...item,
    drive: item.drive ?? 'main',
    parentResourceId: item.parentResourceId ?? null,
    sources: item.sources ?? [],
    permissions: item.permissions ?? [],
    coversDescendants: item.coversDescendants ?? false,
  }
}

type NavigableShareRow = {
  resourceId: string
  kind: 'file' | 'directory'
  path: string | null
  parentResourceId: string | null
}

/**
 * Virtual-root hygiene for the "Shared with me" surface. The server lists
 * EVERY resource carrying a direct grant — including files that live inside
 * folders the caller can already navigate into. Surfacing those twice (a
 * loose root item with no location, plus the real folder child) hides where
 * the file actually lives and invites acting on a different copy than
 * intended. Suppress a file from the virtual root when an accessible folder
 * covers it (path prefix, falling back to a direct parent match when the
 * server omits paths). Orphan shares — files whose location is NOT otherwise
 * reachable — stay listed; that is this surface's purpose. The filter only
 * sees already-loaded pages, so a folder on a later page suppresses its
 * files once that page loads.
 */
export function suppressNavigableShares<T extends NavigableShareRow>(rows: T[]): T[] {
  const folderPathPrefixes = new Set(
    rows
      .filter(
        (row): row is T & { path: string } =>
          row.kind === 'directory' && typeof row.path === 'string' && row.path.length > 1
      )
      .map(row => (row.path.endsWith('/') ? row.path : `${row.path}/`))
  )
  const folderIds = new Set(rows.filter(row => row.kind === 'directory').map(row => row.resourceId))
  return rows.filter(row => {
    if (row.kind !== 'file') return true
    if (typeof row.path === 'string' && row.path.length > 1) {
      for (const prefix of folderPathPrefixes) {
        if (row.path.startsWith(prefix)) return false
      }
    }
    return !(row.parentResourceId && folderIds.has(row.parentResourceId))
  })
}

export interface GfsCrumb {
  resourceId: string
  gfsUri: string
  parentResourceId?: string | null
  name: string
  kind: 'file' | 'directory'
  version: number
  bytes: number
}

export interface GfsBrowserAffordances {
  held: string[]
  canDelegate: boolean
  grantableBits: string[]
  canCreateShare: boolean
}

export interface GfsRowPermissionStatus {
  status: 'checking' | 'stale' | 'error' | 'ready'
  message: string | null
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Present a read-plane failure as the verdict a user can act on.
 *
 * `toMessage` returns the RAW `Error.message`, which still carries Electron's
 * `Error invoking remote method '<channel>': ` wrapper — the name of our own
 * main/renderer split, which means nothing to a user — and spells a 429 as a
 * bare status line rather than as "too many file requests".
 *
 * Only fields that feed a BANNER are presented here. Fields that feed a
 * CLASSIFIER stay raw on purpose: `accessibleError` is read by
 * `classifyDiscoveryFailure`, and `error` by the folder failure card, both of
 * which match status tokens and the `retryAfterSeconds=` suffix that this
 * mapping deliberately replaces with prose.
 */
function toPresentedMessage(error: unknown): string {
  return describeGfsReadError(error).message
}

export type GfsDiscoveryFailureKind = 'unsupported' | 'rate-limited' | 'failed'

export interface GfsDiscoveryFailure {
  kind: GfsDiscoveryFailureKind
  message: string
  /**
   * Absolute epoch (ms) at which the server's own window closes, or null when
   * this failure named no window.
   *
   * An absolute deadline, not a duration, and derived from the query's
   * `errorUpdatedAt` rather than from the message. Two consecutive 429s carry a
   * byte-identical message — the server keeps refusing with the same words —
   * so anything memoized on the message alone returns the SAME object, and
   * every effect keyed on it stays silent for the second failure. The pause
   * would then never re-arm after a retry, which is the hammering this
   * controller exists to prevent. `errorUpdatedAt` advances on every settled
   * error, identical message or not.
   *
   * A deadline also survives a remount and cannot drift: a consumer counting
   * down derives the remainder from the clock instead of decrementing state.
   *
   * The parsed duration itself is deliberately NOT carried alongside. It was,
   * and no consumer ever read it — every surface counts down from this
   * deadline — so the seam published a second, redundant spelling of the same
   * fact that nothing validated against the first. A future consumer reaching
   * for it would have trusted a number no test covered.
   */
  retryAvailableAt: number | null
}

/**
 * Classify a discovery rejection by a signal we actually produce, never by the
 * IPC wording. Electron's `ipcRenderer.invoke` always prefixes a rejection with
 * `Error invoking remote method 'gfs:listAccessible'`, so matching that
 * substring classified EVERY failure of the call — a 429 included — as "this
 * server does not support discovery".
 *
 * `404 Not Found` is our own httpClient format, so it still identifies a server
 * that predates the endpoint. The preload-absent case is not handled here: it
 * has no error to classify and stays on the `canListAccessibleResources` branch.
 *
 * Delimited on both sides for the same reason `isRateLimited` is, and with the
 * same delimiter set: `\b` counts `-` and `/` as boundaries, so a failure whose
 * body merely QUOTED the phrase — a path like `/docs/404 Not Found.md`, which
 * `httpClient` copies verbatim into the message when the JSON carries no
 * top-level `error`/`message` — was classified as a server that has no
 * discovery endpoint. That verdict is the one with no way back: `unsupported`
 * offers no retry, so the user is told their files cannot be listed by a
 * server that would have answered.
 *
 * Every shape the wire produces delimits the status the same way
 * (`404 Not Found: <body>`, and through IPC `…: Error: 404 Not Found: …`), so
 * requiring the delimiter loses no real detection.
 *
 * The vetted status outranks both patterns when the main process supplied one.
 * `unsupported` is the verdict with no way back, and prose is a poor thing to
 * reach it on: a 500 whose body quotes `404 Not Found` from an upstream hop is
 * a server that is failing, not one that lacks the endpoint. `ApiError.status`
 * says which, and it arrives here as `httpStatus=…`.
 */
function classifyDiscoveryFailure(message: string): GfsDiscoveryFailureKind {
  const status = parseHttpStatus(message)
  if (status !== null) {
    if (status === 404) return 'unsupported'
    return isRateLimited(message) ? 'rate-limited' : 'failed'
  }
  if (/(?:^|[\s:])404 Not Found(?=[\s:]|$)/.test(message)) return 'unsupported'
  // Share the predicate with the presentation layer rather than restating it.
  // A third copy of "what counts as rate limited" is a copy that will rot, and
  // the two must agree: the card renders copy chosen by `describeGfsReadError`
  // for a failure this function classified.
  if (isRateLimited(message)) return 'rate-limited'
  return 'failed'
}

/**
 * Focus-refetch pause applied when the server rate limited us without naming a
 * window.
 *
 * The manual Retry button stays enabled — spending the user's own click is
 * their decision, and the card tells them to "try again shortly". What this
 * suppresses is the automatic revalidation on every window focus, which would
 * otherwise keep drawing on a budget the server is still refusing. The case is
 * reachable: an upstream proxy or CDN answers 429 with its own body, which
 * carries no `retryAfterSeconds` for us to parse.
 *
 * One minute is the window of the per-minute limiters behind this endpoint.
 */
const UNKNOWN_RATE_LIMIT_PAUSE_MS = 60_000

export { isGfsSessionAuthorityFailure } from '@lib/gfsGrantErrors'

export function useGfsBrowserController() {
  const queryClient = useQueryClient()
  const {
    isAuthenticated,
    me,
    runtimeConfigState,
    sessionGeneration: publishedGeneration,
  } = useAuthContext()
  const sessionGeneration = isGfsSessionGeneration(publishedGeneration) ? publishedGeneration : null
  const [crumbs, setCrumbsState] = useState<GfsCrumb[]>([])
  const [openError, setOpenError] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const openUriGenerationRef = useRef(0)
  const foregroundOpenUriPendingRef = useRef<number | null>(null)
  const backgroundOpenUriGenerationRef = useRef(0)
  const backgroundOpenErrorRef = useRef(false)
  const pendingDeniedLocationRef = useRef<{
    resourceId: string
    sessionScope: string
    sessionGeneration: number
  } | null>(null)
  const backgroundLocationRetryRef = useRef<(uri: string, sessionGeneration?: number) => void>(
    () => undefined
  )
  const backgroundLocationRetryTimerRef = useRef<number | null>(null)
  const backgroundLocationRetryAttemptRef = useRef(0)
  // Any browser-location update supersedes an in-flight URI resolution. This
  // includes navigation through the tree/crumbs as well as metadata updates,
  // so an older refresh (including a late 403/404) cannot overwrite a newer
  // location or clear its state.
  const setCrumbs = useCallback<Dispatch<SetStateAction<GfsCrumb[]>>>(next => {
    openUriGenerationRef.current += 1
    foregroundOpenUriPendingRef.current = null
    setResolving(false)
    setCrumbsState(next)
  }, [])
  const previousSessionScopeRef = useRef<{
    scope: string | null
    generation: number | null
  } | null>(null)
  // Per controller-mount timestamp: discovery (`refetchOnMount: 'always'`) must
  // land a response newer than this before cached GFS state may render again.
  // Between mount and that fresh response the browser withholds cached rows
  // (authority revalidation window — R4 spec §1).
  const authorityEpochRef = useRef(Date.now())

  const current = crumbs.length ? crumbs[crumbs.length - 1] : null
  const currentCrumbRef = useRef<GfsCrumb | null>(current)
  currentCrumbRef.current = current
  const currentIsDirectory = current?.kind === 'directory'
  // Scope gfs cache/crumbs by environment too (spec §5.2): the same user/team
  // pair addresses different resources across clusters, so an env switch must
  // reset the browser + drop the gfs query subtree.
  const envKey = runtimeConfigState?.envKey ?? ''
  const principalScope = useMemo(
    () => (isAuthenticated && me ? `${envKey}:${me.id}` : null),
    [envKey, isAuthenticated, me]
  )
  const sessionScope = useMemo(
    () => gfsSessionScope({ isAuthenticated, me, runtimeConfigState }),
    [isAuthenticated, me, runtimeConfigState]
  )
  const liveSessionScopeRef = useRef(sessionScope)
  liveSessionScopeRef.current = sessionScope
  const liveSessionGenerationRef = useRef(sessionGeneration)
  liveSessionGenerationRef.current = sessionGeneration
  const ownsPublishedAuthority = useCallback(
    () =>
      isGfsSessionAuthorityCurrent(
        sessionScope,
        sessionGeneration,
        liveSessionScopeRef.current,
        liveSessionGenerationRef.current
      ),
    [sessionScope, sessionGeneration]
  )
  const canListAccessibleResources = typeof window.clerum?.gfs?.listAccessible === 'function'

  // Session-authority access state, SHARED across every controller mount (the
  // sidebar tree, FilesPage, FilePreviewPage each mount their own controller).
  // A server authorization failure must never leave cached GFS metadata visible
  // — production defaults keep data for 30 minutes without revalidation, so the
  // only safe response is to drop it all and gate the queries off. That decision
  // has to be observed by EVERY mount: a 401 in one surface must revoke the
  // others, and a retry in one must re-enable them. It therefore lives in the
  // query cache (a pure subscription here; never fetches — a revocation is
  // written by `revokeGfsSessionAccess`, a retry by `setAccessState`), keyed by
  // sessionScope and OUTSIDE `gfsRoot` so the fail-closed purge does not clear
  // the flag it just set. `gcTime:
  // Infinity` keeps the revoked decision alive across a gap with no mounts, so a
  // later mount still fails closed; only retryAccess (a server round-trip) or a
  // session-scope change returns to 'active'.
  const accessStateQuery = useQuery({
    queryKey: desktopQueryKeys.gfsAccessState(sessionScope ?? 'anonymous', sessionGeneration),
    queryFn: () => 'active' as GfsAccessState,
    enabled: false,
    initialData: 'active' as GfsAccessState,
    gcTime: Infinity,
    staleTime: Infinity,
  })
  const accessState: GfsAccessState =
    sessionGeneration === null ? 'revoked' : (accessStateQuery.data ?? 'active')
  const accessibleQueryEnabled =
    Boolean(sessionScope) &&
    sessionGeneration !== null &&
    canListAccessibleResources &&
    accessState === 'active'
  const setAccessState = useCallback(
    (next: GfsAccessState) => {
      if (!ownsPublishedAuthority()) return
      queryClient.setQueryData(
        desktopQueryKeys.gfsAccessState(sessionScope ?? 'anonymous', sessionGeneration),
        next
      )
    },
    [queryClient, sessionScope, sessionGeneration, ownsPublishedAuthority]
  )

  // The open location is CLIENT state, not server state: it records which
  // resource this mount has open and the ancestry this mount observed. It is
  // published through the query cache so EVERY mount sees it — a move
  // committed by the sidebar must be able to tell that it changes what the
  // Files page's open Share/Manage dialog inherits (RP-005).
  //
  // The subscription exists only to keep the cache entry alive: an
  // unobserved entry is garbage-collected while the app is idle, and the
  // registry would silently empty itself. `notifyOnChangeProps: []` keeps
  // another mount's publish from re-rendering this one — the registry is
  // read imperatively, never rendered.
  useQuery({
    queryKey: desktopQueryKeys.gfsOpenLocations(sessionScope ?? 'anonymous'),
    queryFn: async () => ({}) as GfsOpenLocationRegistry,
    enabled: false,
    initialData: {} as GfsOpenLocationRegistry,
    gcTime: Infinity,
    staleTime: Infinity,
    notifyOnChangeProps: [],
  })
  // One identity per controller mount: the registry holds an entry per
  // mount, and a mount that navigates replaces only its own entry.
  const openLocationIdRef = useRef<string | null>(null)
  if (openLocationIdRef.current === null) openLocationIdRef.current = nextGfsOpenLocationId()
  const openLocationId = openLocationIdRef.current
  useEffect(() => {
    if (!sessionScope) return
    // The ancestry this mount observed is the trail it loaded. Crumbs are
    // ROOT-FIRST, so publishing them reverses them into the registry's
    // NEAREST-FIRST contract — the order the relocation helper slices from
    // the nearest end. A revoked session has no open location to claim.
    const location =
      accessState === 'active' && current
        ? {
            resourceId: current.resourceId,
            ancestorResourceIds: crumbs
              .slice(0, -1)
              .map(crumb => crumb.resourceId)
              .reverse(),
          }
        : null
    publishGfsOpenLocation(queryClient, sessionScope, openLocationId, location)
    return () => {
      publishGfsOpenLocation(queryClient, sessionScope, openLocationId, null)
    }
  }, [accessState, crumbs, current?.resourceId, openLocationId, queryClient, sessionScope])

  useEffect(() => {
    const previous = previousSessionScopeRef.current
    if (previous?.scope === sessionScope && previous.generation === sessionGeneration) return
    previousSessionScopeRef.current = { scope: sessionScope, generation: sessionGeneration }
    if (previous?.scope && previous.scope !== sessionScope) {
      setCrumbs([])
      setOpenError(null)
    }
    if (previous?.scope) {
      queryClient.removeQueries({
        queryKey: desktopQueryKeys.gfsRoot,
        predicate: query =>
          query.queryKey[2] === previous.scope &&
          hasGfsSessionGeneration(query.queryKey, previous.generation),
      })
    }
  }, [queryClient, sessionScope, sessionGeneration, setCrumbs])

  // Epoch (ms) before which a focus-driven revalidation would only burn
  // another slice of the rate-limit budget the server just refused. A ref,
  // not state: the refetch predicates read it when focus fires, and mutating
  // it must not re-render. 0 means "not paused".
  const pausedUntilRef = useRef(0)
  // TanStack 5 accepts `(query) => boolean | 'always'` here. It must return
  // 'always' | false, never a boolean: `true` means "refetch if stale", and
  // under desktopQueryDefaults' staleTime of Infinity a query that HOLDS DATA
  // never is — so `true` would drop the focus revalidation this option exists
  // for, which is picking up grants made from another surface. (It is not that
  // staleness is impossible under Infinity: `isStaleByTime` short-circuits to
  // true when `data === undefined` or the query was invalidated, both
  // reachable here. `'always'` is unconditional, which is what we want when
  // not paused.)
  const refetchOnFocusUnlessPaused = useCallback(
    (): 'always' | false => (Date.now() >= pausedUntilRef.current ? 'always' : false),
    []
  )

  const accessibleQuery = useInfiniteQuery({
    queryKey: desktopQueryKeys.gfsAccessible(sessionScope ?? 'anonymous', DRIVE, sessionGeneration),
    queryFn: async ({ pageParam }): Promise<GfsAccessibleWirePage> => {
      const listAccessible = window.clerum?.gfs?.listAccessible
      if (typeof listAccessible !== 'function') {
        return { items: [], nextCursor: null }
      }
      return listAccessible(DRIVE, pageParam)
    },
    enabled: accessibleQueryEnabled,
    staleTime: GFS_AUTHORITY_STALE_TIME_MS,
    // Accessible resources are permission-derived state. Another session can
    // revoke a grant/share while this user is away from Files, so an
    // Infinity-cached list must not survive a Files remount without a server
    // check — even though the app-level client defaults disable refetching.
    refetchOnMount: 'always',
    notifyOnChangeProps: 'all',
    // Grants are often made from another surface (control-ui, an operator,
    // another user) while this window stays open; focusing the app must
    // surface the new shares without a hard reload — unless the server just
    // rate limited us, in which case focusing again only costs another 429.
    refetchOnWindowFocus: refetchOnFocusUnlessPaused,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
  })

  // Authority revalidation window (R4 spec §1): true from mount/session-return
  // until discovery lands a response NEWER than this mount. While true, every
  // cached GFS surface this controller exposes is withheld so prefetched or
  // 30-minute-cached state cannot render before the session is re-proved. If
  // discovery fails with an authority error, the query-error boundary revokes
  // (which clears the same caches); a policy error stays a local banner. When
  // the runtime has no discovery, there is nothing to revalidate against and
  // per-resource operations still fail closed through handleAuthorityFailure.
  const authorityPending =
    Boolean(sessionScope) &&
    sessionGeneration !== null &&
    canListAccessibleResources &&
    accessState === 'active' &&
    accessibleQuery.dataUpdatedAt < authorityEpochRef.current
  const accessibleInitialRequestPending =
    accessibleQueryEnabled && !accessibleQuery.isError && accessibleQuery.data === undefined
  const childrenQueryEnabled =
    Boolean(sessionScope) &&
    sessionGeneration !== null &&
    Boolean(current) &&
    currentIsDirectory &&
    accessState === 'active'

  const childrenQuery = useInfiniteQuery({
    queryKey: desktopQueryKeys.gfsChildren(
      sessionScope ?? 'anonymous',
      current?.resourceId ?? '',
      DRIVE,
      sessionGeneration
    ),
    queryFn: ({ pageParam }) =>
      window.clerum.gfs.listChildren(current!.resourceId, DRIVE, pageParam),
    enabled: childrenQueryEnabled,
    // Folder contents change out-of-band: agents with host grants, other
    // sessions, and operator writes never pass through this client. Revisit
    // and window focus must revalidate — an Infinity-fresh cached listing
    // otherwise hides new files until a hard app reload.
    refetchOnMount: 'always',
    refetchOnWindowFocus: refetchOnFocusUnlessPaused,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
  })

  const affordancesQuery = useQuery({
    queryKey: desktopQueryKeys.gfsAffordances(
      sessionScope ?? 'anonymous',
      current?.resourceId ?? '',
      DRIVE,
      sessionGeneration
    ),
    queryFn: () => window.clerum.gfs.affordances(current!.resourceId, DRIVE),
    enabled:
      Boolean(sessionScope) &&
      sessionGeneration !== null &&
      Boolean(current) &&
      accessState === 'active',
    ...gfsAuthorityQueryPolicy,
  })

  /**
   * Row-level affordances for the one resource whose ⋯ menu is open. Children
   * listings carry no permission bits, so the Files page lazily resolves the
   * delete gate per menu instead of per row. Shares the affordances cache with
   * the Share dialog's target, which revalidates it once when the dialog opens.
   */
  const [rowAffordancesResourceId, setRowAffordancesResourceId] = useState<string | null>(null)
  const [rowMoveSourceParentResourceId, setRowMoveSourceParentResourceId] = useState<string | null>(
    null
  )
  const rowAffordancesQuery = useQuery({
    queryKey: desktopQueryKeys.gfsAffordances(
      sessionScope ?? 'anonymous',
      rowAffordancesResourceId ?? '',
      DRIVE,
      sessionGeneration
    ),
    queryFn: () => window.clerum.gfs.affordances(rowAffordancesResourceId!, DRIVE),
    enabled:
      Boolean(sessionScope) &&
      sessionGeneration !== null &&
      Boolean(rowAffordancesResourceId) &&
      accessState === 'active',
    ...gfsAuthorityQueryPolicy,
  })
  /**
   * This mount's half of failing closed: the open location's names must not
   * outlive the access that produced them. The shared flag and the session's
   * cached responses are cleared once, by `revokeGfsSessionAccess`; the
   * `accessState` gate keeps the query observers off until an explicit retry
   * re-enters through the server.
   */
  const clearGfsState = useCallback(() => {
    if (!ownsPublishedAuthority()) return
    setCrumbs([])
    setOpenError(null)
  }, [ownsPublishedAuthority, setCrumbs])
  const clearInaccessibleGfsLocation = useCallback(() => {
    const resourceId = currentCrumbRef.current?.resourceId
    pendingDeniedLocationRef.current =
      resourceId && sessionScope && isGfsSessionGeneration(sessionGeneration)
        ? { resourceId, sessionScope, sessionGeneration }
        : null
    // A resource-scoped denial is not loss of the authenticated session.
    // Keep accessible roots and other GFS scopes intact, and avoid the
    // foreground navigation setter so a background denial cannot advance it.
    setCrumbsState([])
    setOpenError(GFS_UNAVAILABLE_LOCATION_MESSAGE)
  }, [sessionScope, sessionGeneration])
  useEffect(() => {
    const deniedLocation = pendingDeniedLocationRef.current
    if (!deniedLocation || current?.resourceId === deniedLocation.resourceId) return
    pendingDeniedLocationRef.current = null
    // Remove the denied query after its observer has left the current folder;
    // removing an active infinite query can transiently expose an empty page.
    queryClient.removeQueries({
      exact: true,
      queryKey: desktopQueryKeys.gfsChildren(
        deniedLocation.sessionScope,
        deniedLocation.resourceId,
        DRIVE,
        deniedLocation.sessionGeneration
      ),
    })
  }, [current?.resourceId, queryClient])
  // Access can be revoked by another mount or by the session-expiry purge,
  // which cannot reach this mount's local state: the open location's names
  // must not outlive the session that was allowed to read them.
  const previousAccessStateRef = useRef(accessState)
  useEffect(() => {
    const previous = previousAccessStateRef.current
    previousAccessStateRef.current = accessState
    if (previous === 'revoked' || accessState !== 'revoked') return
    setCrumbs([])
    setOpenError(null)
  }, [accessState, setCrumbs])
  const revokeAccess = useCallback(() => {
    if (!ownsPublishedAuthority()) return
    revokeGfsSessionAccess(queryClient, sessionScope, sessionGeneration)
    clearGfsState()
  }, [clearGfsState, ownsPublishedAuthority, queryClient, sessionScope, sessionGeneration])
  const retryAccess = useCallback(() => {
    if (!ownsPublishedAuthority()) return
    // This restores no local capability; it only re-enables the queries so a
    // server-side re-grant (or a fresh sign-in) is the sole way back in. Because
    // the flag is shared, a retry here re-activates every mounted controller.
    setAccessState('active')
  }, [setAccessState, ownsPublishedAuthority])
  /** For imperative flows (openUri, revoke mutations): fail closed on a
   * session-authority rejection; returns true when it did. */
  const handleAuthorityFailure = useCallback(
    (
      message: string,
      surface: 'discovery' | 'operation' = 'operation',
      operationScope?: string | null,
      operationGeneration: number | null = sessionGeneration
    ): boolean => {
      const outcome = handleGfsAuthorityFailure(
        queryClient,
        operationScope === undefined ? sessionScope : operationScope,
        operationGeneration,
        message,
        surface,
        { scope: liveSessionScopeRef.current, generation: liveSessionGenerationRef.current }
      )
      // The library already wrote the shared flag; the location this mount
      // shows clears in the same tick instead of waiting for the access effect.
      if (outcome === 'revoked') clearGfsState()
      return outcome !== 'not-authority'
    },
    [clearGfsState, queryClient, sessionScope, sessionGeneration]
  )
  const scheduleBackgroundLocationRetry = useCallback(
    (uri: string, error: unknown, expectedGeneration?: number) => {
      if (!ownsPublishedAuthority()) return
      const message = toMessage(error)
      const status = parseHttpStatus(message)
      if (status !== null && status !== 429 && status < 500) return
      if (backgroundLocationRetryTimerRef.current !== null) return
      const attempt = backgroundLocationRetryAttemptRef.current + 1
      backgroundLocationRetryAttemptRef.current = attempt
      const retryAfterSeconds = parseRetryAfterSeconds(message)
      const delayMs = retryAfterSeconds
        ? Math.min(retryAfterSeconds * 1000, 60_000)
        : Math.min(500 * 2 ** Math.min(attempt - 1, 4), 8_000)
      backgroundLocationRetryTimerRef.current = window.setTimeout(() => {
        backgroundLocationRetryTimerRef.current = null
        if (!ownsPublishedAuthority()) return
        backgroundLocationRetryRef.current(uri, expectedGeneration)
      }, delayMs)
    },
    [sessionGeneration, ownsPublishedAuthority]
  )
  // Cached GFS state is a rendering optimization only (R4 spec §1): while the
  // authority revalidation window is open, nothing cached may be exposed —
  // affordances (and, through the owner's gate, ACL rows) stay withheld until discovery
  // re-proves the session (or an authority failure clears everything).
  //
  // Children are the one surface that clears the gate on its own evidence. The
  // window exists to keep PREFETCHED or 30-minute-cached state from rendering
  // before the session is re-proved, and a page fetched after this mount's
  // epoch is neither: it is a fresh server read the current principal was
  // authorized for. Withholding it renders "This folder is empty", which is
  // the one thing that successful listing disproves — the same false statement
  // this controller stopped making about a refused discovery. Row affordances
  // stay behind `authorityPending` regardless, so the rows arrive without
  // per-row actions until discovery lands.
  const childrenFetchedThisEpoch = childrenQuery.dataUpdatedAt >= authorityEpochRef.current
  const items = useMemo<GfsBrowserChild[]>(
    () =>
      accessState === 'revoked' || (authorityPending && !childrenFetchedThisEpoch)
        ? []
        : (childrenQuery.data?.pages ?? []).flatMap(page => page.items),
    [accessState, authorityPending, childrenFetchedThisEpoch, childrenQuery.data]
  )
  /**
   * Children listings deliberately contain no permission bits. Resolve the
   * caller's affordances for every visible child so row-level Share, Rename,
   * and Delete controls are consistent across files and folders instead of
   * only appearing after that row's overflow menu has been opened.
   *
   * The query keys are shared with the selected-row observer above. That keeps
   * the overflow menu and Manage dialog on the same cache entry while the
   * per-row queries remain fail-closed until their own server verdict arrives.
   */
  const rowAffordancesQueries = useQueries({
    queries: items.map(item => ({
      queryKey: desktopQueryKeys.gfsAffordances(
        sessionScope ?? 'anonymous',
        item.resourceId,
        DRIVE,
        sessionGeneration
      ),
      queryFn: () => window.clerum.gfs.affordances(item.resourceId, DRIVE),
      enabled:
        Boolean(sessionScope) &&
        sessionGeneration !== null &&
        Boolean(current) &&
        currentIsDirectory &&
        !authorityPending &&
        accessState === 'active',
      notifyOnChangeProps: 'all',
      ...gfsAuthorityQueryPolicy,
      // Row data remains stale for authorization after 15 seconds, but a
      // navigation remount only refreshes the presentation cache after 60.
      refetchOnMount: (query: Query) =>
        query.state.isInvalidated ||
        query.state.dataUpdatedAt === 0 ||
        Date.now() - query.state.dataUpdatedAt >= GFS_ROW_PRESENTATION_CACHE_MS,
      // A folder can expose many child actions. The stale-time policy is not a
      // request scheduler. Cache row affordances for presentation through
      // short navigation gaps; exact use-time checks keep the 15-second
      // authority window before opening an editor or mutating.
      refetchOnWindowFocus: false,
    })),
  })
  const moveSourceParentIds = useMemo(() => {
    const ids = new Set<string>()
    if (current?.parentResourceId && current.parentResourceId !== current.resourceId) {
      ids.add(current.parentResourceId)
    }
    if (rowMoveSourceParentResourceId && rowMoveSourceParentResourceId !== current?.resourceId) {
      ids.add(rowMoveSourceParentResourceId)
    }
    return [...ids]
  }, [current?.parentResourceId, current?.resourceId, rowMoveSourceParentResourceId])
  const moveSourceParentQueries = useQueries({
    queries: moveSourceParentIds.map(resourceId => ({
      queryKey: desktopQueryKeys.gfsAffordances(
        sessionScope ?? 'anonymous',
        resourceId,
        DRIVE,
        sessionGeneration
      ),
      queryFn: () => window.clerum.gfs.affordances(resourceId, DRIVE),
      enabled:
        Boolean(sessionScope) &&
        sessionGeneration !== null &&
        !authorityPending &&
        accessState === 'active',
      ...gfsAuthorityQueryPolicy,
    })),
  })
  const moveSourceParentAffordancesById = useMemo(() => {
    const byId: Record<string, GfsBrowserAffordances> = {}
    if (authorityPending || accessState === 'revoked') return byId
    moveSourceParentIds.forEach((resourceId, index) => {
      const query = moveSourceParentQueries[index]
      if (!query?.data) return
      const rawError = query.error ? toMessage(query.error) : ''
      const rateLimited = rawError ? isRateLimited(rawError) : false
      if (query.isError && !rateLimited) return
      byId[resourceId] = query.data as GfsBrowserAffordances
    })
    return byId
  }, [accessState, authorityPending, moveSourceParentIds, moveSourceParentQueries])
  const moveSourceParentStatusById = useMemo(() => {
    const byId: Record<
      string,
      {
        affordances?: GfsBrowserAffordances
        error: string | null
        httpStatus: number | null
        rateLimited: boolean
        retryAfterSeconds: number | null
        isFetching: boolean
      }
    > = {}
    if (authorityPending || accessState === 'revoked') return byId
    moveSourceParentIds.forEach((resourceId, index) => {
      const query = moveSourceParentQueries[index]
      const rawError = query?.error ? toMessage(query.error) : ''
      byId[resourceId] = {
        affordances: query?.data as GfsBrowserAffordances | undefined,
        error: query?.error ? toPresentedMessage(query.error) : null,
        httpStatus: rawError ? parseHttpStatus(rawError) : null,
        rateLimited: rawError ? isRateLimited(rawError) : false,
        retryAfterSeconds: rawError ? parseRetryAfterSeconds(rawError) : null,
        isFetching: Boolean(query?.isFetching),
      }
    })
    return byId
  }, [accessState, authorityPending, moveSourceParentIds, moveSourceParentQueries])
  const rowAffordancesByResourceId = useMemo(() => {
    const byResourceId: Record<string, GfsBrowserAffordances> = {}
    if (authorityPending || accessState === 'revoked') return byResourceId
    items.forEach((item, index) => {
      const query = rowAffordancesQueries[index]
      // These bits may keep an affordance visible while its selected-row
      // observer refreshes. They are presentation only: FilesPage rechecks
      // the exact resource authority before opening a permission-dependent
      // action, and mutations remain server-authorized.
      if (!query?.data) return
      const status = query.isError ? parseHttpStatus(toMessage(query.error)) : null
      if (status === 403 || status === 404) return
      const data = query.data
      if (data) byResourceId[item.resourceId] = data as GfsBrowserAffordances
    })
    return byResourceId
  }, [accessState, authorityPending, items, rowAffordancesQueries])
  // Query-surfaced authorization failures (a refetch after revocation is the
  // normal way the loss is discovered under Infinity staleTime). Discovery is
  // the session/authority boundary; per-resource verdicts stay local.
  const queryAuthorizationError = [
    accessibleQuery.error
      ? { message: toMessage(accessibleQuery.error), surface: 'discovery' as const }
      : null,
    childrenQuery.error
      ? { message: toMessage(childrenQuery.error), surface: 'operation' as const }
      : null,
    affordancesQuery.error
      ? { message: toMessage(affordancesQuery.error), surface: 'operation' as const }
      : null,
    rowAffordancesQuery.error
      ? { message: toMessage(rowAffordancesQuery.error), surface: 'operation' as const }
      : null,
    ...rowAffordancesQueries.map(query =>
      query.error ? { message: toMessage(query.error), surface: 'operation' as const } : null
    ),
    ...moveSourceParentQueries.map(query =>
      query.error ? { message: toMessage(query.error), surface: 'operation' as const } : null
    ),
  ]
    .filter(
      (entry): entry is { message: string; surface: 'discovery' | 'operation' } => entry !== null
    )
    .find(entry => isGfsSessionAuthorityFailure(entry.message, entry.surface))
  useEffect(() => {
    if (!ownsPublishedAuthority() || !queryAuthorizationError || accessState === 'revoked') return
    revokeAccess()
  }, [accessState, queryAuthorizationError, revokeAccess, ownsPublishedAuthority])
  const currentFolderUnavailable =
    currentIsDirectory &&
    childrenQuery.error !== null &&
    [403, 404].includes(parseHttpStatus(toMessage(childrenQuery.error)) ?? 0)
  useEffect(() => {
    if (!ownsPublishedAuthority() || !currentFolderUnavailable) return
    // A soft scope invalidation preserves rows while the authoritative read is
    // pending. Once that read proves this open folder is denied or gone, none
    // of its cached descendants may remain visible in this browser session.
    clearInaccessibleGfsLocation()
  }, [clearInaccessibleGfsLocation, currentFolderUnavailable, ownsPublishedAuthority])
  const accessibleResources = useMemo<GfsAccessibleResource[]>(
    () =>
      authorityPending || accessState === 'revoked'
        ? []
        : suppressNavigableShares(
            (accessibleQuery.data?.pages ?? []).flatMap(page =>
              page.items.map(normalizeAccessibleResource)
            )
          ),
    [accessibleQuery.data, authorityPending, accessState]
  )
  const rowPermissionStatusByResourceId = useMemo(() => {
    const byResourceId: Record<string, GfsRowPermissionStatus> = {}
    const queryStatus = (
      query:
        | {
            data?: unknown
            error?: unknown
            isError?: boolean
            isFetching?: boolean
            isStale?: boolean
          }
        | undefined
    ) => {
      if (query?.isFetching) return { status: 'checking', message: null } as const
      if (query?.isError) {
        return {
          status: 'error',
          message: toPresentedMessage(query.error),
        } as const
      }
      if (!query?.data) return { status: 'checking', message: null } as const
      if (query.isStale) return { status: 'stale', message: null } as const
      return { status: 'ready', message: null } as const
    }
    items.forEach((item, index) => {
      byResourceId[item.resourceId] =
        authorityPending || accessState === 'revoked'
          ? { status: 'checking', message: null }
          : queryStatus(rowAffordancesQueries[index])
    })
    accessibleResources.forEach(resource => {
      byResourceId[resource.resourceId] =
        authorityPending || accessState === 'revoked'
          ? { status: 'checking', message: null }
          : queryStatus(accessibleQuery)
    })
    return byResourceId
  }, [
    accessState,
    accessibleQuery.data,
    accessibleQuery.error,
    accessibleQuery.isError,
    accessibleQuery.isFetching,
    accessibleQuery.isStale,
    accessibleResources,
    authorityPending,
    items,
    rowAffordancesQueries,
  ])
  const accessibleErrorMessage = accessibleQuery.error ? toMessage(accessibleQuery.error) : null
  // The timestamp is a dependency in its own right, not decoration. It is the
  // only thing that distinguishes two consecutive failures carrying the same
  // message, and without it the memo below never recomputes for the second one.
  const accessibleErrorUpdatedAt = accessibleQuery.error ? accessibleQuery.errorUpdatedAt : 0
  const childrenErrorMessage = childrenQuery.error ? toMessage(childrenQuery.error) : null
  const childrenErrorUpdatedAt = childrenQuery.error ? childrenQuery.errorUpdatedAt : 0
  const discoveryFailure = useMemo<GfsDiscoveryFailure | null>(() => {
    // Error presence is the settled verdict. Its message may be empty, so do
    // not let message truthiness turn a failed discovery into a false empty
    // result or leave authority waiting without a Retry path.
    if (accessibleQuery.error == null) return null
    const message = accessibleErrorMessage ?? ''
    const kind = classifyDiscoveryFailure(message)
    const retryAfterSeconds = parseRetryAfterSeconds(message)
    return {
      kind,
      message: message || toPresentedMessage(accessibleQuery.error),
      retryAvailableAt:
        kind === 'rate-limited' && retryAfterSeconds !== null
          ? accessibleErrorUpdatedAt + retryAfterSeconds * 1000
          : null,
    }
  }, [accessibleErrorMessage, accessibleErrorUpdatedAt, accessibleQuery.error])
  const authorityWait = authorityPending && !discoveryFailure
  const childrenInitialRequestPending =
    childrenQueryEnabled && !childrenQuery.isError && childrenQuery.data === undefined
  const loadingAccessible =
    canListAccessibleResources &&
    !accessibleQuery.isError &&
    (authorityWait || accessibleInitialRequestPending)
  const withheldChildrenRefetchPending =
    childrenQueryEnabled &&
    !childrenQuery.isError &&
    childrenQuery.data !== undefined &&
    authorityPending &&
    !childrenFetchedThisEpoch &&
    childrenQuery.isFetching
  const loading =
    childrenInitialRequestPending ||
    withheldChildrenRefetchPending ||
    (authorityWait && items.length === 0)
  const loadingCurrentView =
    authorityWait || (currentIsDirectory ? loading : !current ? loadingAccessible : false)
  // The folder plane's own rate-limit deadline. `listAccessible` and
  // `listChildren` are refused by ONE server budget, so a 429 on either means
  // the next focus-driven refetch of either spends a request the server just
  // turned down. Derived here rather than inside the effect below because the
  // timestamp is what separates two consecutive refusals carrying the same
  // message — without it the second one never recomputes.
  const childrenRateLimitedUntil = useMemo<number | null>(() => {
    if (!childrenErrorMessage || !isRateLimited(childrenErrorMessage)) return null
    const retryAfterSeconds = parseRetryAfterSeconds(childrenErrorMessage)
    return retryAfterSeconds !== null
      ? childrenErrorUpdatedAt + retryAfterSeconds * 1000
      : Date.now() + UNKNOWN_RATE_LIMIT_PAUSE_MS
  }, [childrenErrorMessage, childrenErrorUpdatedAt])
  useEffect(() => {
    // A rate limit with no parseable window is still a rate limit. Leaving the
    // pause open here would let every window focus spend another request
    // against a server that just refused one.
    const discoveryUntil =
      discoveryFailure?.kind === 'rate-limited'
        ? (discoveryFailure.retryAvailableAt ?? Date.now() + UNKNOWN_RATE_LIMIT_PAUSE_MS)
        : 0
    // The later of the two deadlines, never whichever one settled last. A
    // discovery refetch that succeeds does not buy back the budget a refused
    // folder listing is still waiting on, and arming from discovery alone left
    // a folder 429 free to be re-spent on the very next window focus.
    pausedUntilRef.current = Math.max(discoveryUntil, childrenRateLimitedUntil ?? 0)
  }, [childrenRateLimitedUntil, discoveryFailure])
  // The page must not reach into the query object to retry. Clearing the pause
  // here is deliberate: an explicit retry is the user's decision, and the
  // countdown in the UI is what keeps them from spending the request early.
  // It drops back to the folder plane's deadline rather than to zero — the
  // user asked for discovery, not for the next window focus to re-spend a
  // folder listing the same budget is still refusing.
  const retryDiscovery = useCallback(async () => {
    if (!ownsPublishedAuthority()) return
    pausedUntilRef.current = childrenRateLimitedUntil ?? 0
    await accessibleQuery.refetch()
  }, [accessibleQuery, childrenRateLimitedUntil, ownsPublishedAuthority])
  // The same contract for the children query. Nothing to clear here: `refetch`
  // is not gated by the focus predicate, and the pause is shared with
  // discovery — clearing it on a folder retry would hand the next window focus
  // a discovery request the server is still refusing. A folder listing is NOT
  // fetched only on request, though: `refetchOnMount: 'always'` and the window
  // focus bridge both reach it, which is why the pause above now covers it.
  const retryChildren = useCallback(async () => {
    if (!ownsPublishedAuthority()) return
    await childrenQuery.refetch()
  }, [childrenQuery, ownsPublishedAuthority])
  const isMoveSessionGenerationCurrent = useCallback(
    (expected: number) =>
      isGfsSessionGenerationConfirmed(expected, () => liveSessionGenerationRef.current),
    []
  )
  const accessibleNotice =
    sessionScope && !canListAccessibleResources
      ? 'Automatic GFS discovery is not available in this desktop runtime. You can still open any GFS link you have.'
      : discoveryFailure?.kind === 'unsupported'
        ? 'Automatic GFS discovery is not available from this server yet. You can still open any GFS link you have.'
        : null

  const openUri = useCallback(
    async (
      uri: string,
      options?: {
        clearIfUnavailable?: boolean
        background?: boolean
        onFailure?: (failure: GfsUriOpenFailure) => void
        shouldContinue?: () => boolean
        sessionGeneration?: number
      }
    ) => {
      const background = options?.background === true
      // User navigation owns the location until its authoritative resolution
      // settles. A background refresh that starts before React commits that
      // navigation must not read/commit the old location in the meantime.
      if (background && foregroundOpenUriPendingRef.current !== null) return false
      const generation = background ? openUriGenerationRef.current : ++openUriGenerationRef.current
      const backgroundGeneration = background ? ++backgroundOpenUriGenerationRef.current : undefined
      const isCurrent = () =>
        ownsPublishedAuthority() &&
        options?.shouldContinue?.() !== false &&
        openUriGenerationRef.current === generation &&
        (!background ||
          (backgroundOpenUriGenerationRef.current === backgroundGeneration &&
            currentCrumbRef.current?.gfsUri === uri))
      const isSessionGenerationCurrent = async () => {
        if (!ownsPublishedAuthority()) return false
        if (options?.sessionGeneration === undefined) return true
        try {
          return (await window.clerum.auth.getSessionGeneration()) === options.sessionGeneration
        } catch {
          return false
        }
      }
      const reportSuperseded = async () => {
        if (!background && isCurrent() === false && (await isSessionGenerationCurrent())) {
          options?.onFailure?.({ kind: 'superseded' })
        }
      }
      if (!(await isSessionGenerationCurrent())) return false
      if (!background) {
        if (backgroundLocationRetryTimerRef.current !== null) {
          window.clearTimeout(backgroundLocationRetryTimerRef.current)
          backgroundLocationRetryTimerRef.current = null
        }
        backgroundLocationRetryAttemptRef.current = 0
        foregroundOpenUriPendingRef.current = generation
        backgroundOpenErrorRef.current = false
        setOpenError(null)
        setResolving(true)
      }
      try {
        const resource = await window.clerum.gfs.resolve(uri.trim())
        if (!(await isSessionGenerationCurrent()) || !isCurrent()) {
          await reportSuperseded()
          return false
        }
        const crumb: GfsCrumb = {
          resourceId: resource.resourceId,
          gfsUri: resource.gfsUri,
          parentResourceId: resource.parentResourceId ?? null,
          name: resource.name,
          kind: resource.kind === 'directory' ? 'directory' : 'file',
          version: resource.version ?? 0,
          // `resolve` may omit bytes (older servers) — crumbs display 0 then,
          // matching the `version ?? 0` handling above.
          bytes: resource.bytes ?? 0,
        }
        const ancestors: GfsCrumb[] = []
        const seenResourceIds = new Set([resource.resourceId])
        let parentResourceId = resource.parentResourceId

        while (parentResourceId && ancestors.length < GFS_BREADCRUMB_MAX_DEPTH) {
          if (seenResourceIds.has(parentResourceId)) break
          seenResourceIds.add(parentResourceId)
          try {
            const parentRid = parentResourceId.replace(/-/g, '').toLowerCase()
            const parent = await window.clerum.gfs.resolve(`gfs://${resource.drive}/${parentRid}`)
            if (!(await isSessionGenerationCurrent()) || !isCurrent()) {
              await reportSuperseded()
              return false
            }
            if (parent.kind !== 'directory') break
            if (parent.name) {
              ancestors.push({
                resourceId: parent.resourceId,
                gfsUri: parent.gfsUri,
                parentResourceId: parent.parentResourceId ?? null,
                name: parent.name,
                kind: 'directory',
                version: parent.version ?? 0,
                bytes: parent.bytes ?? 0,
              })
            }
            parentResourceId = parent.parentResourceId
          } catch (error) {
            if (!(await isSessionGenerationCurrent()) || !isCurrent()) {
              await reportSuperseded()
              return false
            }
            const status = parseHttpStatus(toMessage(error))
            if (status === 403 || status === 404) {
              // The leaf already resolved authoritatively. A denied or deleted
              // ancestor must disappear from its path without closing a leaf
              // that remains directly readable; a later scope tick can restore
              // the breadcrumb if visibility returns.
              break
            }
            if (background) {
              backgroundOpenErrorRef.current = true
              setOpenError(toPresentedMessage(error))
              scheduleBackgroundLocationRetry(uri, error, options?.sessionGeneration)
              return false
            }
            // A direct file grant can be readable while its parent is not. Keep
            // the file open and show only the ancestors the caller may resolve.
            break
          }
        }

        if (!(await isSessionGenerationCurrent()) || !isCurrent()) {
          await reportSuperseded()
          return false
        }
        // A background resolve may recover its own transient error, but it
        // must not erase a foreground link/navigation error being shown for a
        // separate user action.
        if (!background || backgroundOpenErrorRef.current) {
          backgroundOpenErrorRef.current = false
          setOpenError(null)
        }
        if (background) {
          if (backgroundLocationRetryTimerRef.current !== null) {
            window.clearTimeout(backgroundLocationRetryTimerRef.current)
            backgroundLocationRetryTimerRef.current = null
          }
          backgroundLocationRetryAttemptRef.current = 0
        }
        setCrumbsState([...ancestors.reverse(), crumb])
        return crumb
      } catch (error) {
        if (!(await isSessionGenerationCurrent()) || !isCurrent()) {
          await reportSuperseded()
          return false
        }
        const message = toMessage(error)
        // Opening a URI is an operation on one resource. A generic 403 may be
        // a per-resource policy decision; only a session-authority failure
        // (bare 401 / typed lifecycle code) fails the session closed.
        //
        // The authority check reads the RAW message — it matches status codes
        // and lifecycle tokens — while the banner shows the presented verdict.
        if (!handleAuthorityFailure(message, 'operation')) {
          const status = parseHttpStatus(message)
          if (options?.clearIfUnavailable && (status === 403 || status === 404)) {
            clearInaccessibleGfsLocation()
          } else {
            if (background) backgroundOpenErrorRef.current = true
            setOpenError(toPresentedMessage(error))
            if (background) {
              scheduleBackgroundLocationRetry(uri, error, options?.sessionGeneration)
            }
          }
        }
        options?.onFailure?.({ kind: 'error', error })
        return false
      } finally {
        if (!background && foregroundOpenUriPendingRef.current === generation) {
          foregroundOpenUriPendingRef.current = null
          if (openUriGenerationRef.current === generation) setResolving(false)
        }
      }
    },
    [
      clearInaccessibleGfsLocation,
      handleAuthorityFailure,
      scheduleBackgroundLocationRetry,
      ownsPublishedAuthority,
    ]
  )
  useEffect(() => {
    backgroundLocationRetryRef.current = (uri, sessionGeneration) => {
      void openUri(uri, {
        background: true,
        clearIfUnavailable: true,
        ...(sessionGeneration !== undefined ? { sessionGeneration } : {}),
      })
    }
    return () => {
      backgroundLocationRetryRef.current = () => undefined
      if (backgroundLocationRetryTimerRef.current !== null) {
        window.clearTimeout(backgroundLocationRetryTimerRef.current)
        backgroundLocationRetryTimerRef.current = null
      }
    }
  }, [openUri, sessionScope])

  const refreshCurrentLocation = useCallback(
    async (options?: { background?: boolean }) => {
      const uri = current?.gfsUri
      if (!uri) return false
      return openUri(uri, { clearIfUnavailable: true, background: options?.background })
    },
    [current?.gfsUri, openUri]
  )

  // The owner half of a committed move. The moved resource's id does not
  // change but its version does, and when the OPEN folder (or file) itself
  // moved, its breadcrumb trail belongs to the old location. Consume the
  // returned version immediately and reconcile navigation to the new location
  // (resolve + ancestor walk) so a follow-up Rename/Delete/Move runs with the
  // post-move version, not the pre-move one (which would 409 on ifMatch).
  const convergeOwnedMove = useCallback(
    async (
      input: GfsMoveConvergenceInput & { operationScope: string | null },
      receipt: { version: number }
    ) => {
      if (input.operationScope !== liveSessionScopeRef.current) return
      const movedCrumb = crumbs.find(crumb => crumb.resourceId === input.resourceId)
      setCrumbs(prev => {
        if (
          input.expectedSessionGeneration !== undefined &&
          liveSessionGenerationRef.current !== input.expectedSessionGeneration
        ) {
          return prev
        }
        return prev.map(crumb =>
          crumb.resourceId === input.resourceId
            ? {
                ...crumb,
                version: receipt.version,
                ...(input.newName !== undefined ? { name: input.newName } : {}),
              }
            : crumb
        )
      })
      if (
        movedCrumb &&
        (input.expectedSessionGeneration === undefined ||
          (await isMoveSessionGenerationCurrent(input.expectedSessionGeneration)))
      ) {
        await openUri(movedCrumb.gfsUri, {
          ...(input.expectedSessionGeneration !== undefined
            ? { sessionGeneration: input.expectedSessionGeneration }
            : {}),
        })
      }
    },
    [crumbs, isMoveSessionGenerationCurrent, openUri, setCrumbs]
  )
  // Only a move needs to be awaited; the synchronous crumb patches return
  // nothing so the shared refresh starts in the same tick, as it always has.
  const onOperationCommitted = useCallback(
    (commit: GfsCommittedOperation): Promise<void> | undefined => {
      switch (commit.op) {
        case 'replaceFile': {
          const resource = commit.result
          setCrumbs(prev =>
            prev.map(crumb =>
              crumb.resourceId === resource.resourceId
                ? { ...crumb, name: resource.name, version: resource.version }
                : crumb
            )
          )
          return undefined
        }
        case 'replaceFileFromPath': {
          const { input, result: receipt } = commit
          if (receipt.resultVersion !== undefined) {
            setCrumbs(prev =>
              prev.map(crumb =>
                crumb.resourceId === input.resourceId
                  ? { ...crumb, version: receipt.resultVersion! }
                  : crumb
              )
            )
          }
          return undefined
        }
        case 'renameResource': {
          const { input, result: resource } = commit
          setCrumbs(prev =>
            prev.map(crumb =>
              crumb.resourceId === input.resourceId
                ? { ...crumb, name: input.name, version: resource.version }
                : crumb
            )
          )
          return undefined
        }
        case 'deleteResource': {
          const { input } = commit
          setCrumbs(prev => prev.filter(crumb => crumb.resourceId !== input.resourceId))
          return undefined
        }
        case 'moveResource':
          return convergeOwnedMove(commit.input, commit.result)
        default:
          return undefined
      }
    },
    [convergeOwnedMove, setCrumbs]
  )
  const operations = useGfsResourceOperations({
    handleAuthorityFailure,
    onCommitted: onOperationCommitted,
  })
  const readAccessState = useCallback(
    () =>
      readGfsAccessState(
        queryClient,
        liveSessionScopeRef.current,
        liveSessionGenerationRef.current
      ),
    [queryClient]
  )

  /**
   * Revalidate a folder's children listing as navigation enters it. Folder
   * contents change out-of-band (agents with host grants, other sessions,
   * operator writes) and TanStack does not refetch on a live observer's
   * query-key switch, so revisit would otherwise serve the Infinity-cached
   * page until a hard app reload. `refetchType: 'all'` also refreshes the
   * currently-inactive query so fresh data lands as the crumbs update.
   */
  const revalidateChildren = useCallback(
    (resourceId: string) => {
      if (!sessionScope || !ownsPublishedAuthority()) return
      void queryClient.invalidateQueries({
        exact: true,
        queryKey: desktopQueryKeys.gfsChildren(sessionScope, resourceId, DRIVE, sessionGeneration),
        refetchType: 'all',
      })
    },
    [queryClient, sessionScope, sessionGeneration, ownsPublishedAuthority]
  )

  const openChild = useCallback(
    (child: GfsBrowserChild) => {
      if (child.kind !== 'directory') return
      revalidateChildren(child.resourceId)
      setCrumbs(prev => [
        ...prev,
        {
          resourceId: child.resourceId,
          gfsUri: child.gfsUri,
          parentResourceId: child.parentResourceId,
          name: child.name,
          kind: 'directory',
          version: child.version,
          bytes: child.bytes,
        },
      ])
    },
    [revalidateChildren]
  )

  const openResource = useCallback(
    (resource: GfsBrowserChild) => {
      setOpenError(null)
      if (resource.kind === 'directory') revalidateChildren(resource.resourceId)
      setCrumbs([
        {
          resourceId: resource.resourceId,
          gfsUri: resource.gfsUri,
          parentResourceId: resource.parentResourceId,
          name: resource.name,
          kind: resource.kind === 'directory' ? 'directory' : 'file',
          version: resource.version,
          bytes: resource.bytes,
        },
      ])
    },
    [revalidateChildren]
  )

  const goToCrumb = useCallback(
    (index: number) => {
      setCrumbs(prev => {
        const next = prev.slice(0, index + 1)
        const target = next[index]
        if (target?.kind === 'directory') revalidateChildren(target.resourceId)
        return next
      })
    },
    [revalidateChildren]
  )

  /** Restore an exact browser location after a transient resource selection
   *  (for example, opening a file row to share it from the current-file view). */
  const restoreCrumbs = useCallback((nextCrumbs: GfsCrumb[]) => {
    setCrumbs(nextCrumbs)
    setOpenError(null)
  }, [])

  const reset = useCallback(() => {
    if (!ownsPublishedAuthority()) return
    setCrumbs([])
    setOpenError(null)
    void queryClient.removeQueries({
      queryKey: desktopQueryKeys.gfsRoot,
      predicate: query =>
        query.queryKey[2] === sessionScope &&
        hasGfsSessionGeneration(query.queryKey, sessionGeneration),
    })
  }, [queryClient, sessionScope, sessionGeneration, ownsPublishedAuthority])

  return {
    crumbs,
    current,
    /** Cache-owner scope without team identity, used only to fence captured Move convergence. */
    principalScope,
    /** Cache-scope key (env + user + team) so the move dialog's queries share
     *  the controller's cache and are dropped together on scope change. */
    sessionScope: sessionScope ?? 'anonymous',
    sessionGeneration,
    /** 'revoked' after a session-authority failure — queries are gated off
     *  and cached GFS state is gone until retryAccess re-enters the server. */
    accessState,
    /** Synchronous, fail-closed read of the shared access flag for guards that
     *  run between renders: `accessState` is a render value and lags behind a
     *  revocation another surface just wrote. A missing flag reads as revoked. */
    readAccessState,
    /** True while discovery re-proves the session after mount/session return;
     *  cached GFS state is withheld (R4 spec §1). FilesPage renders loading. */
    authorityPending,
    retryAccess,
    handleAuthorityFailure,
    accessibleResources,
    items,
    affordances:
      authorityPending || accessState === 'revoked'
        ? null
        : ((affordancesQuery.data as GfsBrowserAffordances | undefined) ?? null),
    affordancesError: affordancesQuery.error ? toPresentedMessage(affordancesQuery.error) : null,
    affordancesHttpStatus: affordancesQuery.error
      ? parseHttpStatus(toMessage(affordancesQuery.error))
      : null,
    loadingAffordances: affordancesQuery.isFetching,
    rowAffordancesByResourceId,
    rowPermissionStatusByResourceId,
    moveSourceParentAffordancesById,
    moveSourceParentStatusById,
    rowAffordancesResourceId,
    setRowAffordancesResourceId,
    setMoveSourceParentResourceId: setRowMoveSourceParentResourceId,
    rowAffordances:
      authorityPending ||
      accessState === 'revoked' ||
      rowAffordancesQuery.isFetching ||
      rowAffordancesQuery.isError ||
      rowAffordancesQuery.isStale
        ? null
        : ((rowAffordancesQuery.data as GfsBrowserAffordances | undefined) ?? null),
    rowAffordancesError: rowAffordancesQuery.error
      ? toPresentedMessage(rowAffordancesQuery.error)
      : null,
    // Initial-load flags use query-result presence with enablement and error guards.
    // Authority waiting can also withhold settled cached data; current-view loading
    // includes that wait and an active refetch that must replace an ineligible result.
    loading,
    loadingAccessible,
    // FilesPage has a stricter page-wide authority gate than other controller
    // consumers; keep that precedence in one derived view decision.
    loadingCurrentView,
    error: childrenErrorMessage,
    // The clock the children failure is dated by. A countdown needs the moment
    // the server refused, and only the query knows it; deriving it from render
    // time would restart the wait on every re-render.
    errorUpdatedAt: childrenErrorUpdatedAt,
    accessibleError:
      accessibleNotice || accessibleErrorMessage === null
        ? null
        : accessibleErrorMessage || toPresentedMessage(accessibleQuery.error),
    accessibleNotice,
    discoveryFailure,
    retryDiscovery,
    retryChildren,
    openError,
    resolving,
    hasMore: Boolean(childrenQuery.hasNextPage),
    isFetchingMore: childrenQuery.isFetchingNextPage,
    hasMoreAccessible: canListAccessibleResources && Boolean(accessibleQuery.hasNextPage),
    isFetchingMoreAccessible: canListAccessibleResources && accessibleQuery.isFetchingNextPage,
    loadMore: () => {
      if (!ownsPublishedAuthority()) return
      void childrenQuery.fetchNextPage()
    },
    loadMoreAccessible: () => {
      if (!ownsPublishedAuthority() || !canListAccessibleResources) return
      void accessibleQuery.fetchNextPage()
    },
    openUri,
    refreshCurrentLocation,
    openResource,
    openChild,
    goToCrumb,
    restoreCrumbs,
    reset,
    createFolder: operations.createFolder,
    createFile: operations.createFile,
    createFileFromPath: operations.createFileFromPath,
    replaceFile: operations.replaceFile,
    replaceFileFromPath: operations.replaceFileFromPath,
    renameResource: operations.renameResource,
    moveResource: operations.moveResource,
    deleteResource: operations.deleteResource,
    /**
     * Convergence for a move that landed without a receipt (transport loss):
     * the mutation rejected, so its success path never ran, and the item would
     * otherwise keep rendering in the old folder until the next navigation.
     */
    convergeCommittedMove: operations.convergeCommittedMove,
    mutating: operations.mutating,
  }
}
