import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuthContext } from '@contexts/AuthContext'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GFS_BREADCRUMB_MAX_DEPTH } from '@constants/gfsBrowser'
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

function isResourceDiscoveryUnavailable(message: string): boolean {
  return (
    message.includes('listAccessible is not a function') ||
    message.includes('gfs:listAccessible') ||
    message.includes('404 Not Found')
  )
}

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
  // Deliberately session-local. A server authorization failure must never
  // leave cached GFS metadata (listings, affordances, grants, shares)
  // visible: production query defaults keep data for 30 minutes without
  // revalidation, so the only safe response is to drop it all. A later
  // server-backed request (retryAccess) is the only way back in.
  const [accessState, setAccessState] = useState<'active' | 'revoked'>('active')
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
  }, [queryClient, sessionScope])

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
  }, [clearGfsState])
  const retryAccess = useCallback(() => {
    // This restores no local capability; it only re-enables the queries so a
    // server-side re-grant (or a fresh sign-in) is the sole way back in.
    setAccessState('active')
  }, [])
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
  // rows, affordances, grants, and shares all stay withheld until discovery
  // re-proves the session (or an authority failure clears everything).
  const items = useMemo<GfsBrowserChild[]>(
    () => (authorityPending ? [] : (childrenQuery.data?.pages ?? []).flatMap(page => page.items)),
    [authorityPending, childrenQuery.data]
  )
  const accessibleResources = useMemo<GfsAccessibleResource[]>(
    () =>
      authorityPending
        ? []
        : (accessibleQuery.data?.pages ?? []).flatMap(page =>
            page.items.map(normalizeAccessibleResource)
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
  const accessibleNotice =
    sessionScope && !canListAccessibleResources
      ? 'Automatic GFS discovery is not available in this desktop runtime. You can still open any GFS link you have.'
      : accessibleErrorMessage && isResourceDiscoveryUnavailable(accessibleErrorMessage)
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
        if (!handleAuthorityFailure(message, 'operation')) setOpenError(message)
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

  const openChild = useCallback((child: GfsBrowserChild) => {
    if (child.kind !== 'directory') return
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
  }, [])

  const openResource = useCallback((resource: GfsBrowserChild) => {
    setOpenError(null)
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
  }, [])

  const goToCrumb = useCallback((index: number) => {
    setCrumbs(prev => prev.slice(0, index + 1))
  }, [])

  const reset = useCallback(() => {
    setCrumbs([])
    setOpenError(null)
    void queryClient.removeQueries({ queryKey: desktopQueryKeys.gfsRoot })
  }, [queryClient])

  // Delegation actions throw on server rejection (e.g. 403 escalation_rejected);
  // the caller surfaces that — never swallow it. `inherit` is only sent when a
  // caller passes it explicitly (the agent section, directories only); the
  // user/team panel keeps today's inherit:false behavior by omitting it.
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
    affordancesError: affordancesQuery.error ? toMessage(affordancesQuery.error) : null,
    loadingAffordances: affordancesQuery.isFetching,
    rowAffordancesResourceId,
    setRowAffordancesResourceId,
    rowAffordances:
      authorityPending || accessState === 'revoked'
        ? null
        : ((rowAffordancesQuery.data as GfsBrowserAffordances | undefined) ?? null),
    rowAffordancesError: rowAffordancesQuery.error ? toMessage(rowAffordancesQuery.error) : null,
    loading: (authorityPending || childrenQuery.isFetching) && items.length === 0,
    loadingAccessible:
      (authorityPending && canListAccessibleResources) ||
      (canListAccessibleResources &&
        accessibleQuery.isFetching &&
        accessibleResources.length === 0),
    error: childrenQuery.error ? toMessage(childrenQuery.error) : null,
    accessibleError: accessibleNotice ? null : accessibleErrorMessage,
    accessibleNotice,
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
