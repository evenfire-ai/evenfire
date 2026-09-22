import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuthContext } from '@contexts/AuthContext'
import {
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { GFS_BREADCRUMB_MAX_DEPTH } from '@constants/gfsBrowser'
import {
  describeGfsReadError,
  isRateLimited,
  parseHttpStatus,
  parseRetryAfterSeconds,
} from '@lib/gfsGrantErrors'
import type { GfsGrantListItem, GfsShareListItem } from '@/gfs/delegation.types'
import { desktopQueryKeys } from './queryKeys'

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
 * Delegation (grant/share) and affordances flow through window.clerum.gfs, which
 * reaches control-api `/external/gfs/*` on the existing Session-JWT plane.
 * Enforcement (no-escalation) is always server-side; affordances only decide
 * which controls to SHOW.
 */

const DRIVE = 'main'

type GfsAccessState = 'active' | 'revoked'

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

export interface GfsBrowserControllerOptions {
  /**
   * Enables the grants listing for the current resource. The Manage dialog is
   * the only consumer, so the query runs only while it is open.
   */
  grantsListEnabled?: boolean
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

const SESSION_AUTHORITY_ERROR_CODES = [
  'desktop_user_retired',
  'operator_link_inactive',
  'operator_link_invalid',
  'gfs_operator_link_invalid',
] as const

/**
 * Only a session/authorization failure may invalidate the browser's
 * session-local access state. Per-resource policy verdicts such as
 * `manage_acl_required`, `escalation_rejected`, and `foreign_agent_forbidden`
 * are expected 403s and must remain local to the attempted operation.
 *
 * - `discovery` (listAccessible): the shared-with-me listing is
 *   permission-derived session state, so a 401/403 there is an authority
 *   verdict and fails closed.
 * - `operation` (children/affordances/grants/shares/resolve): a generic 403
 *   is usually a resource-policy denial and must NOT clear the session; only
 *   a bare 401 or a typed lifecycle code does.
 */
export function isGfsSessionAuthorityFailure(
  message: string,
  surface: 'discovery' | 'operation' = 'operation'
): boolean {
  const normalized = message.toLowerCase()
  if (SESSION_AUTHORITY_ERROR_CODES.some(code => normalized.includes(code))) return true
  if (surface !== 'discovery') {
    return (
      /(^|\D)401(\D|$)/.test(normalized) ||
      normalized.includes('not authenticated') ||
      normalized.includes('unauthenticated')
    )
  }
  return (
    /(^|\D)(401|403)(\D|$)/.test(normalized) ||
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden')
  )
}

export function useGfsBrowserController(options: GfsBrowserControllerOptions = {}) {
  const { grantsListEnabled = false } = options
  const queryClient = useQueryClient()
  const { isAuthenticated, me, runtimeConfigState } = useAuthContext()
  const [crumbs, setCrumbs] = useState<GfsCrumb[]>([])
  const [openError, setOpenError] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const previousSessionScopeRef = useRef<string | null>(null)
  // Per controller-mount timestamp: discovery (`refetchOnMount: 'always'`) must
  // land a response newer than this before cached GFS state may render again.
  // Between mount and that fresh response the browser withholds cached rows
  // (authority revalidation window — R4 spec §1).
  const authorityEpochRef = useRef(Date.now())

  const current = crumbs.length ? crumbs[crumbs.length - 1] : null
  const currentIsDirectory = current?.kind === 'directory'
  // Scope gfs cache/crumbs by environment too (spec §5.2): the same user/team
  // pair addresses different resources across clusters, so an env switch must
  // reset the browser + drop the gfs query subtree.
  const envKey = runtimeConfigState?.envKey ?? ''
  const sessionScope = useMemo(
    () => (isAuthenticated && me ? `${envKey}:${me.id}:${me.teamId ?? ''}` : null),
    [envKey, isAuthenticated, me]
  )
  const canListAccessibleResources = typeof window.clerum?.gfs?.listAccessible === 'function'

  // Session-authority access state, SHARED across every controller mount (the
  // sidebar tree, FilesPage, FilePreviewPage each mount their own controller).
  // A server authorization failure must never leave cached GFS metadata visible
  // — production defaults keep data for 30 minutes without revalidation, so the
  // only safe response is to drop it all and gate the queries off. That decision
  // has to be observed by EVERY mount: a 401 in one surface must revoke the
  // others, and a retry in one must re-enable them. It therefore lives in the
  // query cache (a pure subscription here; never fetches — writes go through
  // `setAccessState`), keyed by sessionScope and OUTSIDE `gfsRoot` so the
  // fail-closed purge below does not clear the flag it just set. `gcTime:
  // Infinity` keeps the revoked decision alive across a gap with no mounts, so a
  // later mount still fails closed; only retryAccess (a server round-trip) or a
  // session-scope change returns to 'active'.
  const accessStateQuery = useQuery({
    queryKey: desktopQueryKeys.gfsAccessState(sessionScope ?? 'anonymous'),
    queryFn: () => 'active' as GfsAccessState,
    enabled: false,
    initialData: 'active' as GfsAccessState,
    gcTime: Infinity,
    staleTime: Infinity,
  })
  const accessState: GfsAccessState = accessStateQuery.data ?? 'active'
  const setAccessState = useCallback(
    (next: GfsAccessState) => {
      queryClient.setQueryData(desktopQueryKeys.gfsAccessState(sessionScope ?? 'anonymous'), next)
    },
    [queryClient, sessionScope]
  )

  useEffect(() => {
    const previous = previousSessionScopeRef.current
    if (previous === sessionScope) return
    previousSessionScopeRef.current = sessionScope
    if (previous !== null) {
      setCrumbs([])
      setOpenError(null)
      setAccessState('active')
      void queryClient.removeQueries({ queryKey: desktopQueryKeys.gfsRoot })
    }
  }, [queryClient, sessionScope, setAccessState])

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
    queryKey: desktopQueryKeys.gfsAccessible(sessionScope ?? 'anonymous', DRIVE),
    queryFn: async ({ pageParam }): Promise<GfsAccessibleWirePage> => {
      const listAccessible = window.clerum?.gfs?.listAccessible
      if (typeof listAccessible !== 'function') {
        return { items: [], nextCursor: null }
      }
      return listAccessible(DRIVE, pageParam)
    },
    enabled: Boolean(sessionScope) && canListAccessibleResources && accessState === 'active',
    // Accessible resources are permission-derived state. Another session can
    // revoke a grant/share while this user is away from Files, so an
    // Infinity-cached list must not survive a Files remount without a server
    // check — even though the app-level client defaults disable refetching.
    refetchOnMount: 'always',
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
    canListAccessibleResources &&
    accessState === 'active' &&
    accessibleQuery.dataUpdatedAt < authorityEpochRef.current

  const childrenQuery = useInfiniteQuery({
    queryKey: desktopQueryKeys.gfsChildren(
      sessionScope ?? 'anonymous',
      current?.resourceId ?? '',
      DRIVE
    ),
    queryFn: ({ pageParam }) =>
      window.clerum.gfs.listChildren(current!.resourceId, DRIVE, pageParam),
    enabled:
      Boolean(sessionScope) && Boolean(current) && currentIsDirectory && accessState === 'active',
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
      DRIVE
    ),
    queryFn: () => window.clerum.gfs.affordances(current!.resourceId, DRIVE),
    enabled: Boolean(sessionScope) && Boolean(current) && accessState === 'active',
  })
  const refreshAffordances = useCallback(async () => {
    const resourceId = current?.resourceId
    if (!sessionScope || !resourceId) return
    await queryClient.invalidateQueries({
      exact: true,
      queryKey: desktopQueryKeys.gfsAffordances(sessionScope, resourceId, DRIVE),
      refetchType: 'active',
    })
  }, [current?.resourceId, queryClient, sessionScope])

  /**
   * Row-level affordances for the one resource whose ⋯ menu is open. Children
   * listings carry no permission bits, so the Files page lazily resolves the
   * delete gate per menu instead of per row. Shares the affordances cache with
   * the Manage dialog, so opening Manage for the same resource is free.
   */
  const [rowAffordancesResourceId, setRowAffordancesResourceId] = useState<string | null>(null)
  const rowAffordancesQuery = useQuery({
    queryKey: desktopQueryKeys.gfsAffordances(
      sessionScope ?? 'anonymous',
      rowAffordancesResourceId ?? '',
      DRIVE
    ),
    queryFn: () => window.clerum.gfs.affordances(rowAffordancesResourceId!, DRIVE),
    enabled: Boolean(sessionScope) && Boolean(rowAffordancesResourceId) && accessState === 'active',
  })
  // The grants listing is the revoke-id source (the grant PUT returns no ids),
  // so writes must refetch it. Enabled only while the Manage dialog is open.
  const grantsQuery = useQuery({
    queryKey: desktopQueryKeys.gfsGrants(
      sessionScope ?? 'anonymous',
      current?.resourceId ?? '',
      DRIVE
    ),
    queryFn: () => window.clerum.gfs.listGrants(current!.resourceId, DRIVE),
    enabled:
      Boolean(sessionScope) && Boolean(current) && grantsListEnabled && accessState === 'active',
  })
  // Direct URI shares are a separate server surface ("this route is never
  // inferred from grants"), so the revoke-id source for shares is this list.
  // Shares the Manage-dialog gating with grants.
  const sharesQuery = useQuery({
    queryKey: desktopQueryKeys.gfsShares(
      sessionScope ?? 'anonymous',
      current?.resourceId ?? '',
      DRIVE
    ),
    queryFn: () => window.clerum.gfs.listShares(current!.resourceId, DRIVE),
    enabled:
      Boolean(sessionScope) && Boolean(current) && grantsListEnabled && accessState === 'active',
  })
  const refreshShares = useCallback(async () => {
    const resourceId = current?.resourceId
    if (!resourceId) return
    await queryClient.invalidateQueries({
      exact: true,
      queryKey: desktopQueryKeys.gfsShares(sessionScope ?? 'anonymous', resourceId, DRIVE),
    })
  }, [current?.resourceId, queryClient, sessionScope])
  const refreshGrants = useCallback(async () => {
    const resourceId = current?.resourceId
    if (!resourceId) return
    await queryClient.invalidateQueries({
      exact: true,
      queryKey: desktopQueryKeys.gfsGrants(sessionScope ?? 'anonymous', resourceId, DRIVE),
    })
  }, [current?.resourceId, queryClient, sessionScope])
  const refreshGfs = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: desktopQueryKeys.gfsRoot,
      // Content mutations refresh discovery and folder listings. Permission
      // affordances are refreshed explicitly when Manage opens; coupling them
      // here temporarily removes write controls between consecutive uploads.
      predicate: query => query.queryKey[3] !== 'affordances',
    })
  }, [queryClient])
  /**
   * Fail closed on a session/authorization failure: cached GFS metadata can
   * never outlive the access that produced it. Clears navigation and removes
   * every cached GFS response for this Desktop session (listings, roots,
   * affordances, grants, shares). The `accessState` gate disables the query
   * observers until an explicit retry re-enters through the server.
   */
  const clearGfsState = useCallback(() => {
    setCrumbs([])
    setOpenError(null)
    queryClient.removeQueries({ queryKey: desktopQueryKeys.gfsRoot })
  }, [queryClient])
  const revokeAccess = useCallback(() => {
    setAccessState('revoked')
    clearGfsState()
  }, [clearGfsState, setAccessState])
  const retryAccess = useCallback(() => {
    // This restores no local capability; it only re-enables the queries so a
    // server-side re-grant (or a fresh sign-in) is the sole way back in. Because
    // the flag is shared, a retry here re-activates every mounted controller.
    setAccessState('active')
  }, [setAccessState])
  /** For imperative flows (openUri, revoke mutations): fail closed on a
   * session-authority rejection; returns true when it did. */
  const handleAuthorityFailure = useCallback(
    (message: string, surface: 'discovery' | 'operation' = 'operation'): boolean => {
      if (!isGfsSessionAuthorityFailure(message, surface)) return false
      revokeAccess()
      return true
    },
    [revokeAccess]
  )
  // All GFS mutations share the central fail-closed boundary: an authority
  // rejection (401 / typed lifecycle code) revokes the session even when the
  // caller would only have toasted. Policy verdicts (403/412) stay local.
  const failClosedOnMutationError = useCallback(
    (error: unknown) => {
      handleAuthorityFailure(toMessage(error), 'operation')
    },
    [handleAuthorityFailure]
  )
  const revokeGrantMutation = useMutation({
    mutationFn: (grantId: string) => window.clerum.gfs.revokeGrant(grantId),
    onSuccess: refreshGrants,
    onError: failClosedOnMutationError,
  })
  const revokeShareMutation = useMutation({
    mutationFn: (shareId: string) => window.clerum.gfs.revokeShare(shareId),
    onSuccess: refreshShares,
    onError: failClosedOnMutationError,
  })
  const createFolderMutation = useMutation({
    mutationFn: async (name: string) => {
      if (!current) throw new Error('No folder selected')
      return window.clerum.gfs.createFolder(current.resourceId, name, DRIVE)
    },
    onSuccess: refreshGfs,
    onError: failClosedOnMutationError,
  })
  const createFileMutation = useMutation({
    mutationFn: (input: { parentResourceId: string; name: string; encodedData: string }) =>
      window.clerum.gfs.createFile(input.parentResourceId, input.name, input.encodedData, DRIVE),
    onSuccess: refreshGfs,
    onError: failClosedOnMutationError,
  })
  const createFileFromPathMutation = useMutation({
    mutationFn: (input: { parentResourceId: string; name: string; filePath: string }) =>
      window.clerum.gfs.createFileFromPath(
        input.parentResourceId,
        input.name,
        input.filePath,
        DRIVE
      ),
    onSuccess: refreshGfs,
    onError: failClosedOnMutationError,
  })
  const replaceFileMutation = useMutation({
    mutationFn: (input: { resourceId: string; encodedData: string; ifMatch?: number }) =>
      window.clerum.gfs.replaceFile(input.resourceId, input.encodedData, DRIVE, input.ifMatch),
    onSuccess: async resource => {
      setCrumbs(prev =>
        prev.map(crumb =>
          crumb.resourceId === resource.resourceId
            ? { ...crumb, name: resource.name, version: resource.version }
            : crumb
        )
      )
      await refreshGfs()
    },
    onError: failClosedOnMutationError,
  })
  const replaceFileFromPathMutation = useMutation({
    mutationFn: (input: { resourceId: string; filePath: string; ifMatch?: number }) =>
      window.clerum.gfs.replaceFileFromPath(input.resourceId, input.filePath, DRIVE, input.ifMatch),
    onSuccess: async (receipt, input) => {
      if (receipt.resultVersion !== undefined) {
        setCrumbs(prev =>
          prev.map(crumb =>
            crumb.resourceId === input.resourceId
              ? { ...crumb, version: receipt.resultVersion! }
              : crumb
          )
        )
      }
      await refreshGfs()
    },
    onError: failClosedOnMutationError,
  })
  const renameResourceMutation = useMutation({
    mutationFn: (input: { resourceId: string; name: string; ifMatch?: number }) =>
      window.clerum.gfs.renameResource(input.resourceId, input.name, DRIVE, input.ifMatch),
    onSuccess: async (resource, input) => {
      setCrumbs(prev =>
        prev.map(crumb =>
          crumb.resourceId === input.resourceId
            ? { ...crumb, name: input.name, version: resource.version }
            : crumb
        )
      )
      await refreshGfs()
    },
    onError: failClosedOnMutationError,
  })
  const deleteResourceMutation = useMutation({
    mutationFn: (input: { resourceId: string; ifMatch?: number }) =>
      window.clerum.gfs.deleteResource(input.resourceId, DRIVE, input.ifMatch),
    onSuccess: async (_data, input) => {
      setCrumbs(prev => prev.filter(crumb => crumb.resourceId !== input.resourceId))
      await refreshGfs()
    },
    onError: failClosedOnMutationError,
  })

  // Cached GFS state is a rendering optimization only (R4 spec §1): while the
  // authority revalidation window is open, nothing cached may be exposed —
  // affordances, grants, and shares all stay withheld until discovery
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
      authorityPending && !childrenFetchedThisEpoch
        ? []
        : (childrenQuery.data?.pages ?? []).flatMap(page => page.items),
    [authorityPending, childrenFetchedThisEpoch, childrenQuery.data]
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
        DRIVE
      ),
      queryFn: () => window.clerum.gfs.affordances(item.resourceId, DRIVE),
      enabled:
        Boolean(sessionScope) &&
        Boolean(current) &&
        currentIsDirectory &&
        !authorityPending &&
        accessState === 'active',
      // Permission changes made outside this page must not leave row actions
      // stale when a folder is revisited — but `'always'` paid for that with a
      // refetch per visible child on EVERY mount, against data the project
      // default keeps fresh forever (`staleTime: Infinity`). Re-entering a
      // 45-child folder seconds later spent 40 requests to re-derive bits the
      // cache already held, which was 47% of the affordances traffic in the
      // incident behind #681.
      //
      // A 60s bound keeps the out-of-band case working and makes the re-entry
      // free. The cost is that a row's permission bits may be up to 60s stale
      // after a change made elsewhere; server-side enforcement is unchanged, so
      // a stale row action still gets the 403 this page already handles. The
      // menu-level affordances query above serves Infinity-cached bits today,
      // so this is tighter than the status quo beside it, not looser.
      refetchOnMount: true as const,
      staleTime: 60_000,
    })),
  })
  const rowAffordancesByResourceId = useMemo(() => {
    const byResourceId: Record<string, GfsBrowserAffordances> = {}
    if (authorityPending || accessState === 'revoked') return byResourceId
    items.forEach((item, index) => {
      const data = rowAffordancesQueries[index]?.data
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
    grantsQuery.error
      ? { message: toMessage(grantsQuery.error), surface: 'operation' as const }
      : null,
    sharesQuery.error
      ? { message: toMessage(sharesQuery.error), surface: 'operation' as const }
      : null,
  ]
    .filter(
      (entry): entry is { message: string; surface: 'discovery' | 'operation' } => entry !== null
    )
    .find(entry => isGfsSessionAuthorityFailure(entry.message, entry.surface))
  useEffect(() => {
    if (!queryAuthorizationError || accessState === 'revoked') return
    revokeAccess()
  }, [accessState, queryAuthorizationError, revokeAccess])
  const accessibleResources = useMemo<GfsAccessibleResource[]>(
    () =>
      authorityPending
        ? []
        : suppressNavigableShares(
            (accessibleQuery.data?.pages ?? []).flatMap(page =>
              page.items.map(normalizeAccessibleResource)
            )
          ),
    [accessibleQuery.data, authorityPending]
  )
  const grants = useMemo<GfsGrantListItem[]>(
    () => (authorityPending ? [] : (grantsQuery.data ?? [])),
    [authorityPending, grantsQuery.data]
  )
  const shares = useMemo<GfsShareListItem[]>(
    () => (authorityPending ? [] : (sharesQuery.data ?? [])),
    [authorityPending, sharesQuery.data]
  )
  const accessibleErrorMessage = accessibleQuery.error ? toMessage(accessibleQuery.error) : null
  // The timestamp is a dependency in its own right, not decoration. It is the
  // only thing that distinguishes two consecutive failures carrying the same
  // message, and without it the memo below never recomputes for the second one.
  const accessibleErrorUpdatedAt = accessibleQuery.error ? accessibleQuery.errorUpdatedAt : 0
  const childrenErrorMessage = childrenQuery.error ? toMessage(childrenQuery.error) : null
  const childrenErrorUpdatedAt = childrenQuery.error ? childrenQuery.errorUpdatedAt : 0
  const discoveryFailure = useMemo<GfsDiscoveryFailure | null>(() => {
    if (!accessibleErrorMessage) return null
    const kind = classifyDiscoveryFailure(accessibleErrorMessage)
    const retryAfterSeconds = parseRetryAfterSeconds(accessibleErrorMessage)
    return {
      kind,
      message: accessibleErrorMessage,
      retryAvailableAt:
        kind === 'rate-limited' && retryAfterSeconds !== null
          ? accessibleErrorUpdatedAt + retryAfterSeconds * 1000
          : null,
    }
  }, [accessibleErrorMessage, accessibleErrorUpdatedAt])
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
    pausedUntilRef.current = childrenRateLimitedUntil ?? 0
    await accessibleQuery.refetch()
  }, [accessibleQuery, childrenRateLimitedUntil])
  // The same contract for the children query. Nothing to clear here: `refetch`
  // is not gated by the focus predicate, and the pause is shared with
  // discovery — clearing it on a folder retry would hand the next window focus
  // a discovery request the server is still refusing. A folder listing is NOT
  // fetched only on request, though: `refetchOnMount: 'always'` and the window
  // focus bridge both reach it, which is why the pause above now covers it.
  const retryChildren = useCallback(async () => {
    await childrenQuery.refetch()
  }, [childrenQuery])
  const accessibleNotice =
    sessionScope && !canListAccessibleResources
      ? 'Automatic GFS discovery is not available in this desktop runtime. You can still open any GFS link you have.'
      : discoveryFailure?.kind === 'unsupported'
        ? 'Automatic GFS discovery is not available from this server yet. You can still open any GFS link you have.'
        : null

  const openUri = useCallback(
    async (uri: string) => {
      setOpenError(null)
      setResolving(true)
      try {
        const resource = await window.clerum.gfs.resolve(uri.trim())
        const crumb: GfsCrumb = {
          resourceId: resource.resourceId,
          gfsUri: resource.gfsUri,
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
            if (parent.kind !== 'directory') break
            if (parent.name) {
              ancestors.push({
                resourceId: parent.resourceId,
                gfsUri: parent.gfsUri,
                name: parent.name,
                kind: 'directory',
                version: parent.version ?? 0,
                bytes: parent.bytes ?? 0,
              })
            }
            parentResourceId = parent.parentResourceId
          } catch {
            // A direct file grant can be readable while its parent is not. Keep
            // the file open and show only the ancestors the caller may resolve.
            break
          }
        }

        setCrumbs([...ancestors.reverse(), crumb])
        return crumb
      } catch (error) {
        const message = toMessage(error)
        // Opening a URI is an operation on one resource. A generic 403 may be
        // a per-resource policy decision; only a session-authority failure
        // (bare 401 / typed lifecycle code) fails the session closed.
        //
        // The authority check reads the RAW message — it matches status codes
        // and lifecycle tokens — while the banner shows the presented verdict.
        if (!handleAuthorityFailure(message, 'operation')) setOpenError(toPresentedMessage(error))
        return false
      } finally {
        setResolving(false)
      }
    },
    [handleAuthorityFailure]
  )

  // Move refreshes the old parent's children, the destination's children,
  // and the accessible roots in one shot via refreshGfs. The moved resource's
  // id does not change, but its version does, and when the OPEN folder (or
  // file) itself moved, its breadcrumb trail is stale: the ancestors above it
  // belong to the old location. Consume the returned version immediately and
  // reconcile navigation to the new location (resolve + ancestor walk) so a
  // follow-up Rename/Delete/Move runs with the post-move version, not the
  // pre-move one (which would 409 on ifMatch).
  const moveResourceMutation = useMutation({
    mutationFn: (input: { resourceId: string; destinationId: string; ifMatch?: number }) =>
      window.clerum.gfs.moveResource(input.resourceId, input.destinationId, DRIVE, input.ifMatch),
    onSuccess: async (receipt, input) => {
      const movedCrumb = crumbs.find(crumb => crumb.resourceId === input.resourceId)
      setCrumbs(prev =>
        prev.map(crumb =>
          crumb.resourceId === input.resourceId ? { ...crumb, version: receipt.version } : crumb
        )
      )
      await refreshGfs()
      if (movedCrumb) await openUri(movedCrumb.gfsUri)
    },
    onError: failClosedOnMutationError,
  })

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
      if (!sessionScope) return
      void queryClient.invalidateQueries({
        exact: true,
        queryKey: desktopQueryKeys.gfsChildren(sessionScope, resourceId, DRIVE),
        refetchType: 'all',
      })
    },
    [queryClient, sessionScope]
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
   *  (for example, opening a row's Manage dialog). */
  const restoreCrumbs = useCallback((nextCrumbs: GfsCrumb[]) => {
    setCrumbs(nextCrumbs)
    setOpenError(null)
  }, [])

  const reset = useCallback(() => {
    setCrumbs([])
    setOpenError(null)
    void queryClient.removeQueries({ queryKey: desktopQueryKeys.gfsRoot })
  }, [queryClient])

  // Delegation actions throw on server rejection (e.g. 403 escalation_rejected);
  // the caller surfaces that — never swallow it. `inherit` omitted defaults to
  // `true` on the wire (uriHandler), so user/team panel grants cover folder
  // contents; callers that need a contents-excluding grant pass `false`.
  const grant = useCallback(
    (subjectKeys: string[], bits: string[], inherit?: boolean): Promise<void> => {
      if (!current) return Promise.reject(new Error('No resource selected'))
      return window.clerum.gfs.grant(current.resourceId, subjectKeys, bits, DRIVE, inherit)
    },
    [current]
  )

  const createShare = useCallback(
    (subjectKeys: string[]): Promise<void> => {
      if (!current) return Promise.reject(new Error('No resource selected'))
      return window.clerum.gfs.createShare(current.resourceId, subjectKeys, DRIVE)
    },
    [current]
  )

  return {
    crumbs,
    current,
    /** Cache-scope key (env + user + team) so the move dialog's queries share
     *  the controller's cache and are dropped together on scope change. */
    sessionScope: sessionScope ?? 'anonymous',
    /** 'revoked' after a session-authority failure — queries are gated off
     *  and cached GFS state is gone until retryAccess re-enters the server. */
    accessState,
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
    loadingAffordances: affordancesQuery.isFetching,
    rowAffordancesByResourceId,
    rowAffordancesResourceId,
    setRowAffordancesResourceId,
    rowAffordances:
      authorityPending || accessState === 'revoked'
        ? null
        : ((rowAffordancesQuery.data as GfsBrowserAffordances | undefined) ?? null),
    rowAffordancesError: rowAffordancesQuery.error
      ? toPresentedMessage(rowAffordancesQuery.error)
      : null,
    // Only the `authorityPending` term stands down on a settled discovery
    // error, never the children term: a folder that is genuinely fetching must
    // keep the spinner, or the view flashes "this folder is empty" mid-load.
    // Without the gate a 429 on discovery — which leaves `authorityPending`
    // true by design, because a rate limit does not re-prove the session —
    // pinned every consumer of this field on "Loading files…" with nothing
    // in flight to end it.
    loading:
      ((authorityPending && !discoveryFailure) || childrenQuery.isFetching) && items.length === 0,
    // A settled discovery error is not a pending load. Without this the
    // spinner outlived the failure for every consumer that derives its
    // loading state from here alone (ComposerGlobalFilesModal). The term
    // belongs on this field only: `loading` above reports the INDEPENDENT
    // children query, and gating it on a discovery error hid the spinner while
    // a folder was genuinely loading, flashing "this folder is empty".
    loadingAccessible:
      !accessibleQuery.isError &&
      ((authorityPending && canListAccessibleResources) ||
        (canListAccessibleResources &&
          accessibleQuery.isFetching &&
          accessibleResources.length === 0)),
    error: childrenErrorMessage,
    // The clock the children failure is dated by. A countdown needs the moment
    // the server refused, and only the query knows it; deriving it from render
    // time would restart the wait on every re-render.
    errorUpdatedAt: childrenErrorUpdatedAt,
    accessibleError: accessibleNotice ? null : accessibleErrorMessage,
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
      void childrenQuery.fetchNextPage()
    },
    loadMoreAccessible: () => {
      if (!canListAccessibleResources) return
      void accessibleQuery.fetchNextPage()
    },
    openUri,
    openResource,
    openChild,
    goToCrumb,
    restoreCrumbs,
    reset,
    refreshAffordances,
    grant,
    grants,
    // Raw error (not toMessage) so FilesPage can map server codes — e.g. a
    // manage_acl_required 403 renders as a quiet banner, not an error.
    grantsError: grantsQuery.error,
    loadingGrants: grantsQuery.isFetching,
    refreshGrants,
    revokeGrant: (grantId: string) => revokeGrantMutation.mutateAsync(grantId),
    revoking: revokeGrantMutation.isPending,
    shares,
    // Raw error (not toMessage) so FilesPage maps server codes symmetrically
    // with grantsError.
    sharesError: sharesQuery.error,
    loadingShares: sharesQuery.isFetching,
    refreshShares,
    revokeShare: (shareId: string) => revokeShareMutation.mutateAsync(shareId),
    revokingShare: revokeShareMutation.isPending,
    createShare,
    createFolder: (name: string) => createFolderMutation.mutateAsync(name),
    createFile: (parentResourceId: string, name: string, encodedData: string) =>
      createFileMutation.mutateAsync({ parentResourceId, name, encodedData }),
    createFileFromPath: (parentResourceId: string, name: string, filePath: string) =>
      createFileFromPathMutation.mutateAsync({ parentResourceId, name, filePath }),
    replaceFile: (resourceId: string, encodedData: string, ifMatch?: number) =>
      replaceFileMutation.mutateAsync({ resourceId, encodedData, ifMatch }),
    replaceFileFromPath: (resourceId: string, filePath: string, ifMatch?: number) =>
      replaceFileFromPathMutation.mutateAsync({ resourceId, filePath, ifMatch }),
    renameResource: (resourceId: string, name: string, ifMatch?: number) =>
      renameResourceMutation.mutateAsync({ resourceId, name, ifMatch }),
    moveResource: (resourceId: string, destinationId: string, ifMatch?: number) =>
      moveResourceMutation.mutateAsync({ resourceId, destinationId, ifMatch }),
    deleteResource: (resourceId: string, ifMatch?: number) =>
      deleteResourceMutation.mutateAsync({ resourceId, ifMatch }),
    mutating:
      createFolderMutation.isPending ||
      createFileMutation.isPending ||
      createFileFromPathMutation.isPending ||
      replaceFileMutation.isPending ||
      replaceFileFromPathMutation.isPending ||
      renameResourceMutation.isPending ||
      moveResourceMutation.isPending ||
      deleteResourceMutation.isPending,
  }
}
