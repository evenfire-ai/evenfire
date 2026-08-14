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
 * browse is access-driven for ordinary users: they first see explicit resources
 * granted or shared with them, and can still open a `gfs://` URI manually. A
 * linked operator instead starts at the real drive root returned by discovery.
 * Children are paginated with `useInfiniteQuery` so a large folder is never
 * silently truncated.
 *
 * Delegation (grant/share) and affordances flow through window.clerum.gfs, which
 * reaches the `/api/v1/me/gfs/*` user plane with the existing Session JWT.
 * Enforcement (no-escalation) is always server-side; affordances only decide
 * which controls to SHOW.
 */

const DRIVE = 'main'

export interface GfsBrowserChild {
  resourceId: string
  rid: string
  gfsUri: string
  drive?: string
  parentResourceId?: string | null
  name: string
  kind: 'file' | 'directory'
  path: string | null
  version: number
  bytes: number
}

interface GfsAccessibleResource extends GfsBrowserChild {
  sources?: string[]
  permissions?: string[]
  coversDescendants?: boolean
}

export interface GfsCrumb {
  resourceId: string
  gfsUri: string
  name: string
  kind: 'file' | 'directory'
  version: number
  bytes: number
  /** True only for the real drive root returned to a linked GFS operator. */
  isDriveRoot?: boolean
}

export type GfsBrowserView = 'operator' | 'shared'
export type GfsBrowserAccessState = 'active' | 'revoked'

export interface GfsBrowserFailure {
  kind: 'uninitialized' | 'unauthorized' | 'upstream'
  title: string
  message: string
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
  if (isUninitializedDriveError(message)) return false
  return (
    message.includes('listAccessible is not a function') ||
    message.includes('gfs:listAccessible') ||
    message.includes('404 Not Found')
  )
}

function isUninitializedDriveError(message: string): boolean {
  const normalized = message.toLowerCase()
  // A server authorization verdict wins over the generic wording below. For
  // example, "403 Forbidden: drive not initialized" is still an authorization
  // failure and must not be presented as a provisioning state.
  if (
    /(^|\D)(401|403)(\D|$)/.test(normalized) ||
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden')
  ) {
    return false
  }
  return (
    normalized.includes('operator_root_missing') ||
    normalized.includes('gfs_drive_unseeded') ||
    normalized.includes('drive_not_seeded') ||
    normalized.includes('gfs_root_unseeded') ||
    normalized.includes('gfs_not_initialized') ||
    normalized.includes('not initialized') ||
    normalized.includes('unseeded')
  )
}

const SESSION_AUTHORITY_ERROR_CODES = [
  'desktop_user_retired',
  'operator_link_inactive',
  'operator_link_invalid',
  'gfs_operator_link_invalid',
] as const

/**
 * Only a session/operator authority failure may invalidate the browser's
 * session-local access state. Per-resource policy verdicts such as
 * `manage_acl_required`, `escalation_rejected`, and `foreign_agent_forbidden`
 * are expected 403s and must remain local to the attempted operation.
 */
export function isGfsSessionAuthorityFailure(
  message: string,
  surface: 'discovery' | 'operation' = 'operation'
): boolean {
  const normalized = message.toLowerCase()
  if (SESSION_AUTHORITY_ERROR_CODES.some(code => normalized.includes(code))) return true
  if (surface !== 'discovery') {
    // A bare 401 means the authenticated session is no longer accepted. It is
    // distinct from a generic 403, which may be only a resource-policy denial
    // and must not clear the whole browser session.
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

/** A revoked operator link downgrades an active Desktop session to user scope. */
export function isGfsOperatorLinkRevocation(message: string): boolean {
  return message.toLowerCase().includes('operator_link_inactive')
}

/** Stable user-facing state for root/folder read failures crossing Electron IPC. */
export function describeGfsBrowserFailure(message: string): GfsBrowserFailure {
  if (isUninitializedDriveError(message)) {
    return {
      kind: 'uninitialized',
      title: 'Global File System is not initialized',
      message: 'The drive exists in this environment, but its root is not ready yet.',
    }
  }
  const normalized = message.toLowerCase()
  if (
    /(^|\D)(401|403)(\D|$)/.test(normalized) ||
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden') ||
    normalized.includes('not authenticated') ||
    normalized.includes('operator_link_inactive') ||
    normalized.includes('operator_link_invalid')
  ) {
    return {
      kind: 'unauthorized',
      title: 'File access is not authorized',
      message:
        'Your current Desktop session cannot access this location. Sign in again or contact an administrator.',
    }
  }
  return {
    kind: 'upstream',
    title: 'Global File System is unavailable',
    message:
      'The file service did not return a usable response. Try again when the service is available.',
  }
}

const RESOURCE_ID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function rootCrumb(resourceId: string): GfsCrumb {
  const rid = resourceId.replace(/-/g, '').toLowerCase()
  return {
    resourceId,
    gfsUri: `gfs://${DRIVE}/${rid}`,
    name: 'Global File System',
    kind: 'directory',
    version: 0,
    bytes: 0,
    isDriveRoot: true,
  }
}

export function useGfsBrowserController(options: GfsBrowserControllerOptions = {}) {
  const { grantsListEnabled = false } = options
  const queryClient = useQueryClient()
  const { isAuthenticated, me, runtimeConfigState } = useAuthContext()
  const [crumbs, setCrumbs] = useState<GfsCrumb[]>([])
  const [openError, setOpenError] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  // This is deliberately session-local. A 403 never becomes a persisted client
  // capability decision: a later server-backed request is the only way out.
  const [accessState, setAccessState] = useState<GfsBrowserAccessState>('active')
  const previousSessionScopeRef = useRef<string | null>(null)
  const operatorViewRef = useRef(false)
  const operatorRecoveryAttemptedRef = useRef(false)

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
      operatorViewRef.current = false
      operatorRecoveryAttemptedRef.current = false
      void queryClient.removeQueries({ queryKey: [...desktopQueryKeys.gfsRoot, previous] })
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
    enabled: Boolean(sessionScope) && canListAccessibleResources && accessState === 'active',
    // Accessible resources are permission-derived state. The operator can
    // revoke a grant/share from another Desktop session while this user is
    // away from Files, so an Infinity-cached list must not survive a Files
    // remount without a server check.
    refetchOnMount: 'always',
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
  })

  const firstAccessiblePage = accessibleQuery.data?.pages[0]
  const view: GfsBrowserView = firstAccessiblePage?.view === 'operator' ? 'operator' : 'shared'
  const operatorRootResourceId =
    firstAccessiblePage?.view === 'operator' &&
    typeof firstAccessiblePage.rootResourceId === 'string' &&
    RESOURCE_ID_RE.test(firstAccessiblePage.rootResourceId)
      ? firstAccessiblePage.rootResourceId
      : null
  const operatorRoot = useMemo(
    () => (operatorRootResourceId ? rootCrumb(operatorRootResourceId) : null),
    [operatorRootResourceId]
  )

  useEffect(() => {
    if (view === 'operator') {
      const wasOperator = operatorViewRef.current
      operatorViewRef.current = true
      // A successful operator discovery starts a fresh recovery cycle. Do not
      // reset the guard on every render while stale operator data is still
      // visible after a failed discovery; the next lifecycle denial must then
      // fail closed instead of retrying indefinitely.
      if (!wasOperator && firstAccessiblePage) operatorRecoveryAttemptedRef.current = false
    } else if (view === 'shared' && accessState === 'active' && firstAccessiblePage) {
      operatorViewRef.current = false
      operatorRecoveryAttemptedRef.current = false
    }
  }, [accessState, firstAccessiblePage, view])
  const rootContractError =
    firstAccessiblePage?.view === 'operator' && !operatorRoot
      ? 'operator_root_missing: operator view did not include a valid rootResourceId'
      : null

  useEffect(() => {
    if (!firstAccessiblePage) return
    if (!operatorRoot) {
      setCrumbs(prev => (prev[0]?.isDriveRoot ? [] : prev))
      return
    }
    setCrumbs(prev => {
      const rest = prev[0]?.isDriveRoot ? prev.slice(1) : prev
      const first = prev[0]
      if (
        first?.isDriveRoot &&
        first.resourceId === operatorRoot.resourceId &&
        first.name === operatorRoot.name
      ) {
        return prev
      }
      return [operatorRoot, ...rest]
    })
  }, [firstAccessiblePage, operatorRoot])

  const childrenQuery = useInfiniteQuery({
    queryKey: desktopQueryKeys.gfsChildren(
      sessionScope ?? 'anonymous',
      current?.resourceId ?? '',
      DRIVE
    ),
    queryFn: ({ pageParam }) =>
      window.clerum.gfs.listChildren(current!.resourceId, DRIVE, pageParam),
    enabled:
      Boolean(sessionScope) &&
      Boolean(current) &&
      currentIsDirectory &&
      !current?.isDriveRoot &&
      accessState === 'active',
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
  const refreshGrants = useCallback(async () => {
    const resourceId = current?.resourceId
    if (!resourceId) return
    await queryClient.invalidateQueries({
      exact: true,
      queryKey: desktopQueryKeys.gfsGrants(sessionScope ?? 'anonymous', resourceId, DRIVE),
    })
  }, [current?.resourceId, queryClient, sessionScope])
  const revokeGrantMutation = useMutation({
    mutationFn: (grantId: string) => window.clerum.gfs.revokeGrant(grantId),
    onSuccess: refreshGrants,
  })
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
  const clearGfsState = useCallback(() => {
    setCrumbs([])
    setOpenError(null)
    // Remove every GFS response for this Desktop session. In particular, never
    // leave an operator root, ACL list, or affordance cached after a server
    // revocation response.
    queryClient.removeQueries({ queryKey: desktopQueryKeys.gfsRoot })
  }, [queryClient])
  const revokeAccess = useCallback(() => {
    setAccessState('revoked')
    clearGfsState()
  }, [clearGfsState])
  const downgradeToOrdinaryUser = useCallback(() => {
    // A link revoke removes only operator authority. The authenticated Desktop
    // user remains eligible for explicitly shared GFS resources, so clear the
    // operator cache and let fresh discovery resolve the user view.
    setAccessState('active')
    clearGfsState()
  }, [clearGfsState])
  const handleAuthorityFailure = useCallback(
    (message: string, surface: 'discovery' | 'operation' = 'operation'): boolean => {
      if (!isGfsSessionAuthorityFailure(message, surface)) return false
      if (isGfsOperatorLinkRevocation(message) && !operatorRecoveryAttemptedRef.current) {
        operatorRecoveryAttemptedRef.current = true
        downgradeToOrdinaryUser()
      } else revokeAccess()
      return true
    },
    [downgradeToOrdinaryUser, revokeAccess]
  )
  const retryAccess = useCallback(() => {
    // This does not restore a local capability. It only permits the normal
    // discovery request to run again, so an explicit server-side reactivation
    // remains the sole authority that can restore the operator root.
    setAccessState('active')
  }, [])
  // Root discovery is a session/authority boundary. A resource-scoped 403 is
  // a policy verdict and must remain local, while a 401 still means the
  // authenticated session is no longer accepted and revokes session state.
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
    const genericOperatorDiscoveryFailure =
      queryAuthorizationError.surface === 'discovery' &&
      operatorViewRef.current &&
      !/(^|\D)401(\D|$)/.test(queryAuthorizationError.message.toLowerCase())
    if (
      (genericOperatorDiscoveryFailure ||
        isGfsOperatorLinkRevocation(queryAuthorizationError.message)) &&
      !operatorRecoveryAttemptedRef.current
    ) {
      operatorRecoveryAttemptedRef.current = true
      downgradeToOrdinaryUser()
      return
    }
    revokeAccess()
  }, [accessState, downgradeToOrdinaryUser, queryAuthorizationError, revokeAccess])
  const refreshShares = useCallback(async () => {
    const resourceId = current?.resourceId
    if (!resourceId) return
    await queryClient.invalidateQueries({
      exact: true,
      queryKey: desktopQueryKeys.gfsShares(sessionScope ?? 'anonymous', resourceId, DRIVE),
    })
  }, [current?.resourceId, queryClient, sessionScope])
  const revokeShareMutation = useMutation({
    mutationFn: (shareId: string) => window.clerum.gfs.revokeShare(shareId),
    onSuccess: refreshShares,
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
    () => (accessibleQuery.data?.pages ?? []).flatMap(page => page.items),
    [accessibleQuery.data]
  )
  const grants = useMemo<GfsGrantListItem[]>(() => grantsQuery.data ?? [], [grantsQuery.data])
  const shares = useMemo<GfsShareListItem[]>(() => sharesQuery.data ?? [], [sharesQuery.data])
  const accessibleErrorMessage =
    accessState === 'revoked'
      ? 'operator_link_inactive'
      : (rootContractError ?? (accessibleQuery.error ? toMessage(accessibleQuery.error) : null))
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

        const resolvedCrumbs = [...ancestors.reverse(), crumb]
        setCrumbs(
          operatorRoot
            ? [
                operatorRoot,
                ...resolvedCrumbs.filter(item => item.resourceId !== operatorRoot.resourceId),
              ]
            : resolvedCrumbs
        )
        return crumb
      } catch (error) {
        const message = toMessage(error)
        // Opening a URI is an operation on one resource. A generic 403 may be
        // a per-resource policy decision; only typed lifecycle failures or a
        // bare 401 invalidate the session-wide authority state.
        if (!handleAuthorityFailure(message, 'operation')) setOpenError(message)
        return false
      } finally {
        setResolving(false)
      }
    },
    [handleAuthorityFailure, operatorRoot]
  )

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

  const openResource = useCallback(
    (resource: GfsBrowserChild) => {
      setOpenError(null)
      const crumb: GfsCrumb = {
        resourceId: resource.resourceId,
        gfsUri: resource.gfsUri,
        name: resource.name,
        kind: resource.kind === 'directory' ? 'directory' : 'file',
        version: resource.version,
        bytes: resource.bytes,
      }
      setCrumbs(
        operatorRoot
          ? resource.resourceId === operatorRoot.resourceId
            ? [operatorRoot]
            : [operatorRoot, crumb]
          : [crumb]
      )
    },
    [operatorRoot]
  )

  const goToCrumb = useCallback((index: number) => {
    setCrumbs(prev => prev.slice(0, index + 1))
  }, [])

  const reset = useCallback(() => {
    setCrumbs(operatorRoot ? [operatorRoot] : [])
    setOpenError(null)
    void queryClient.invalidateQueries({ queryKey: desktopQueryKeys.gfsRoot })
  }, [operatorRoot, queryClient])

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
    view,
    accessState,
    isOperatorRoot: Boolean(current?.isDriveRoot),
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
    revokeAccess,
    downgradeToOrdinaryUser,
    handleAuthorityFailure,
    retryAccess,
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
    sharesError: sharesQuery.error,
    loadingShares: sharesQuery.isFetching,
    refreshShares,
    revokeShare: (shareId: string) => revokeShareMutation.mutateAsync(shareId),
    revokingShare: revokeShareMutation.isPending,
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
