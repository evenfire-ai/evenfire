import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuthContext } from '@contexts/AuthContext'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GFS_BREADCRUMB_MAX_DEPTH } from '@constants/gfsBrowser'
import type { GfsGrantListItem } from '@/gfs/delegation.types'
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

export function useGfsBrowserController(options: GfsBrowserControllerOptions = {}) {
  const { grantsListEnabled = false } = options
  const queryClient = useQueryClient()
  const { isAuthenticated, me, runtimeConfigState } = useAuthContext()
  const [crumbs, setCrumbs] = useState<GfsCrumb[]>([])
  const [openError, setOpenError] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const previousSessionScopeRef = useRef<string | null>(null)

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
    enabled: Boolean(sessionScope) && canListAccessibleResources,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
  })

  const childrenQuery = useInfiniteQuery({
    queryKey: desktopQueryKeys.gfsChildren(
      sessionScope ?? 'anonymous',
      current?.resourceId ?? '',
      DRIVE
    ),
    queryFn: ({ pageParam }) =>
      window.clerum.gfs.listChildren(current!.resourceId, DRIVE, pageParam),
    enabled: Boolean(sessionScope) && Boolean(current) && currentIsDirectory,
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
    enabled: Boolean(sessionScope) && Boolean(current),
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
    enabled: Boolean(sessionScope) && Boolean(rowAffordancesResourceId),
  })
  // The grants listing is the revoke-id source (the grant PUT returns no ids),
  // so writes must refetch it. Enabled only while the Manage dialog is open.
  const grantsQuery = useQuery({
    queryKey: ['gfs', DRIVE, current?.resourceId ?? '', 'grants'],
    queryFn: () => window.clerum.gfs.listGrants(current!.resourceId, DRIVE),
    enabled: Boolean(sessionScope) && Boolean(current) && grantsListEnabled,
  })
  const refreshGrants = useCallback(async () => {
    const resourceId = current?.resourceId
    if (!resourceId) return
    await queryClient.invalidateQueries({
      exact: true,
      queryKey: ['gfs', DRIVE, resourceId, 'grants'],
    })
  }, [current?.resourceId, queryClient])
  const revokeGrantMutation = useMutation({
    mutationFn: (grantId: string) => window.clerum.gfs.revokeGrant(grantId),
    onSuccess: refreshGrants,
  })
  const refreshGfs = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: desktopQueryKeys.gfsRoot,
      // Content mutations refresh discovery and folder listings. Permission
      // affordances are refreshed explicitly when Manage opens; coupling them
      // here temporarily removes write controls between consecutive uploads.
      predicate: query => query.queryKey[3] !== 'affordances',
    })
  }, [queryClient])
  const createFolderMutation = useMutation({
    mutationFn: async (name: string) => {
      if (!current) throw new Error('No folder selected')
      return window.clerum.gfs.createFolder(current.resourceId, name, DRIVE)
    },
    onSuccess: refreshGfs,
  })
  const createFileMutation = useMutation({
    mutationFn: (input: { parentResourceId: string; name: string; encodedData: string }) =>
      window.clerum.gfs.createFile(input.parentResourceId, input.name, input.encodedData, DRIVE),
    onSuccess: refreshGfs,
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
  })
  const deleteResourceMutation = useMutation({
    mutationFn: (input: { resourceId: string; ifMatch?: number }) =>
      window.clerum.gfs.deleteResource(input.resourceId, DRIVE, input.ifMatch),
    onSuccess: async (_data, input) => {
      setCrumbs(prev => prev.filter(crumb => crumb.resourceId !== input.resourceId))
      await refreshGfs()
    },
  })

  const items = useMemo<GfsBrowserChild[]>(
    () => (childrenQuery.data?.pages ?? []).flatMap(page => page.items),
    [childrenQuery.data]
  )
  const accessibleResources = useMemo<GfsAccessibleResource[]>(
    () =>
      (accessibleQuery.data?.pages ?? []).flatMap(page =>
        page.items.map(normalizeAccessibleResource)
      ),
    [accessibleQuery.data]
  )
  const grants = useMemo<GfsGrantListItem[]>(() => grantsQuery.data ?? [], [grantsQuery.data])
  const accessibleErrorMessage = accessibleQuery.error ? toMessage(accessibleQuery.error) : null
  const accessibleNotice =
    sessionScope && !canListAccessibleResources
      ? 'Automatic GFS discovery is not available in this desktop runtime. You can still open any GFS link you have.'
      : accessibleErrorMessage && isResourceDiscoveryUnavailable(accessibleErrorMessage)
        ? 'Automatic GFS discovery is not available from this server yet. You can still open any GFS link you have.'
        : null

  const openUri = useCallback(async (uri: string) => {
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
      setOpenError(toMessage(error))
      return false
    } finally {
      setResolving(false)
    }
  }, [])

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
    void queryClient.removeQueries({ queryKey: ['desktop-app', 'gfs'] })
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
    accessibleResources,
    items,
    affordances: (affordancesQuery.data as GfsBrowserAffordances | undefined) ?? null,
    affordancesError: affordancesQuery.error ? toMessage(affordancesQuery.error) : null,
    loadingAffordances: affordancesQuery.isFetching,
    rowAffordancesResourceId,
    setRowAffordancesResourceId,
    rowAffordances: (rowAffordancesQuery.data as GfsBrowserAffordances | undefined) ?? null,
    rowAffordancesError: rowAffordancesQuery.error ? toMessage(rowAffordancesQuery.error) : null,
    loading: childrenQuery.isFetching && items.length === 0,
    loadingAccessible:
      canListAccessibleResources && accessibleQuery.isFetching && accessibleResources.length === 0,
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
    createShare,
    createFolder: (name: string) => createFolderMutation.mutateAsync(name),
    createFile: (parentResourceId: string, name: string, encodedData: string) =>
      createFileMutation.mutateAsync({ parentResourceId, name, encodedData }),
    replaceFile: (resourceId: string, encodedData: string, ifMatch?: number) =>
      replaceFileMutation.mutateAsync({ resourceId, encodedData, ifMatch }),
    renameResource: (resourceId: string, name: string, ifMatch?: number) =>
      renameResourceMutation.mutateAsync({ resourceId, name, ifMatch }),
    deleteResource: (resourceId: string, ifMatch?: number) =>
      deleteResourceMutation.mutateAsync({ resourceId, ifMatch }),
    mutating:
      createFolderMutation.isPending ||
      createFileMutation.isPending ||
      replaceFileMutation.isPending ||
      renameResourceMutation.isPending ||
      deleteResourceMutation.isPending,
  }
}
