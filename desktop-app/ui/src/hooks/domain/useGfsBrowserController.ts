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

export interface GfsUploadSnapshot {
  state:
    | 'initiated'
    | 'uploading'
    | 'paused'
    | 'suspended_auth'
    | 'finalizing'
    | 'canceling'
    | 'completed'
    | 'aborted'
    | 'failed'
  session: {
    uploadId: string
    state: string
    expectedBytes: number
    committedBytes: number
    resultResourceId?: string
    resultVersion?: number
  } | null
  uploadedBytes: number
  totalBytes: number
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
  const [uploadSnapshot, setUploadSnapshot] = useState<GfsUploadSnapshot | null>(null)
  const uploadIdRef = useRef<string | null>(null)
  const previousSessionScopeRef = useRef<string | null>(null)
  const uploadRehydrateGenerationRef = useRef(0)

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
    queryFn: ({ pageParam }) => {
      const listAccessible = window.clerum?.gfs?.listAccessible
      if (typeof listAccessible !== 'function') {
        return Promise.resolve({ items: [], nextCursor: null })
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
    mutationFn: (input: { parentResourceId: string; name: string; filePath: string }) =>
      window.clerum.gfs.createFileFromPath(
        input.parentResourceId,
        input.name,
        input.filePath,
        DRIVE
      ),
    onSuccess: refreshGfs,
  })
  const replaceFileMutation = useMutation({
    mutationFn: (input: { resourceId: string; filePath: string; ifMatch?: number }) =>
      window.clerum.gfs.replaceFileFromPath(input.resourceId, input.filePath, DRIVE, input.ifMatch),
    onSuccess: async receipt => {
      const legacyResource = receipt as unknown as { resourceId?: string; version?: number }
      const resourceId = receipt.resultResourceId ?? legacyResource.resourceId
      const version = receipt.resultVersion ?? legacyResource.version
      if (resourceId && version !== undefined) {
        setCrumbs(prev =>
          prev.map(crumb => (crumb.resourceId === resourceId ? { ...crumb, version } : crumb))
        )
      }
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

  const waitForUpload = useCallback(async (uploadId: string): Promise<GfsUploadSnapshot> => {
    const deadline = Date.now() + 24 * 60 * 60 * 1000
    for (;;) {
      if (Date.now() > deadline)
        throw new Error(
          'GFS upload status polling timed out; the upload can be resumed from the Files page.'
        )
      const snapshot = await window.clerum.gfs.getUploadSnapshot(uploadId, DRIVE)
      if (!snapshot) throw new Error('GFS upload is no longer available in this desktop session')
      setUploadSnapshot(snapshot)
      if (
        snapshot.state === 'paused' ||
        snapshot.state === 'suspended_auth' ||
        snapshot.state === 'completed' ||
        snapshot.state === 'aborted' ||
        snapshot.state === 'failed'
      )
        return snapshot
      await new Promise(resolve => window.setTimeout(resolve, 500))
    }
  }, [])

  // Persisted Desktop sessions are the source of truth after an app restart.
  // Rehydrate one scoped session on mount/scope change so FilesPage can render
  // the same progress and pause/resume/cancel controls it renders for a live
  // upload. The IPC list is already owner/team/environment/drive scoped; the
  // second snapshot read supplies the durable byte counters and state.
  useEffect(() => {
    const generation = uploadRehydrateGenerationRef.current + 1
    uploadRehydrateGenerationRef.current = generation
    if (!sessionScope) {
      uploadIdRef.current = null
      setUploadSnapshot(null)
      return
    }
    const listUploadSessions = window.clerum?.gfs?.listUploadSessions
    if (typeof listUploadSessions !== 'function') return
    let disposed = false
    void (async () => {
      try {
        const sessions = await listUploadSessions(DRIVE)
        if (disposed || uploadRehydrateGenerationRef.current !== generation) return
        const persisted = sessions.find(
          session =>
            session.drive === DRIVE &&
            (session.status === 'active' ||
              session.status === 'paused' ||
              session.status === 'suspended_auth')
        )
        if (!persisted) return
        uploadIdRef.current = persisted.uploadId
        await waitForUpload(persisted.uploadId)
      } catch (error) {
        if (!disposed && uploadRehydrateGenerationRef.current === generation) {
          setOpenError(toMessage(error))
        }
      }
    })()
    return () => {
      disposed = true
    }
  }, [sessionScope, waitForUpload])

  const startFileUpload = useCallback(
    async (input: {
      parentResourceId: string
      name: string
      filePath: string
      resumeUploadId?: string
    }): Promise<GfsUploadSnapshot> => {
      const session = await window.clerum.gfs.startFileUpload(
        input.parentResourceId,
        input.name,
        input.filePath,
        DRIVE,
        input.resumeUploadId
      )
      uploadIdRef.current = session.uploadId
      const initialSnapshot: GfsUploadSnapshot = {
        state: session.state as GfsUploadSnapshot['state'],
        session,
        uploadedBytes: session.committedBytes,
        totalBytes: session.expectedBytes,
      }
      setUploadSnapshot(initialSnapshot)
      // The legacy compatibility path returns a completed resource receipt,
      // not a resumable upload session. There is no v2 snapshot to poll under
      // that resource id; refresh the folder and finish immediately.
      if (session.state === 'completed') {
        await refreshGfs()
        return initialSnapshot
      }
      const snapshot = await waitForUpload(session.uploadId)
      if (snapshot.state === 'completed') await refreshGfs()
      return snapshot
    },
    [refreshGfs, waitForUpload]
  )

  const startFileReplace = useCallback(
    async (input: {
      resourceId: string
      filePath: string
      ifMatch?: number
      resumeUploadId?: string
    }): Promise<GfsUploadSnapshot> => {
      const session = await window.clerum.gfs.startFileReplace(
        input.resourceId,
        input.filePath,
        DRIVE,
        input.ifMatch,
        input.resumeUploadId
      )
      uploadIdRef.current = session.uploadId
      const initialSnapshot: GfsUploadSnapshot = {
        state: session.state as GfsUploadSnapshot['state'],
        session,
        uploadedBytes: session.committedBytes,
        totalBytes: session.expectedBytes,
      }
      setUploadSnapshot(initialSnapshot)
      if (session.state === 'completed') {
        await refreshGfs()
        return initialSnapshot
      }
      const snapshot = await waitForUpload(session.uploadId)
      if (snapshot.state === 'completed') await refreshGfs()
      return snapshot
    },
    [refreshGfs, waitForUpload]
  )

  const pauseUpload = useCallback(async (): Promise<GfsUploadSnapshot> => {
    const uploadId = uploadIdRef.current
    if (!uploadId) throw new Error('No active GFS upload')
    await window.clerum.gfs.pauseUpload(uploadId, DRIVE)
    return waitForUpload(uploadId)
  }, [waitForUpload])

  const resumeUpload = useCallback(async (): Promise<GfsUploadSnapshot> => {
    const uploadId = uploadIdRef.current
    if (!uploadId) throw new Error('No paused GFS upload')
    await window.clerum.gfs.resumeUpload(uploadId, DRIVE)
    const snapshot = await waitForUpload(uploadId)
    if (snapshot.state === 'completed') await refreshGfs()
    return snapshot
  }, [refreshGfs, waitForUpload])

  const cancelUpload = useCallback(async (): Promise<void> => {
    const uploadId = uploadIdRef.current
    if (!uploadId) return
    await window.clerum.gfs.cancelUpload(uploadId, DRIVE)
    setUploadSnapshot(previous => (previous ? { ...previous, state: 'aborted' } : null))
    uploadIdRef.current = null
  }, [])

  const items = useMemo<GfsBrowserChild[]>(
    () => (childrenQuery.data?.pages ?? []).flatMap(page => page.items),
    [childrenQuery.data]
  )
  const accessibleResources = useMemo<GfsAccessibleResource[]>(
    () => (accessibleQuery.data?.pages ?? []).flatMap(page => page.items),
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
    createFile: (parentResourceId: string, name: string, filePath: string) =>
      createFileMutation.mutateAsync({ parentResourceId, name, filePath }),
    replaceFile: (resourceId: string, filePath: string, ifMatch?: number) =>
      replaceFileMutation.mutateAsync({ resourceId, filePath, ifMatch }),
    uploadSnapshot,
    startFileUpload,
    startFileReplace,
    pauseUpload,
    resumeUpload,
    cancelUpload,
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
