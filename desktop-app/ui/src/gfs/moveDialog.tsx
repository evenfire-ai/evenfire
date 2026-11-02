import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { type InfiniteData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, Empty, Flex, Modal, Spin, Tree, Typography } from 'antd'
import type { DataNode } from 'antd/es/tree'
import { IconCheck, IconChevronRight, IconClose, IconContexts } from '@components/SidebarNav/icons'
import { GFS_DRIVE_MAIN } from '@constants/gfsBrowser'
import {
  desktopQueryKeys,
  isGfsSessionAuthorityCurrent,
  isGfsSessionGeneration,
} from '@hooks/domain/queryKeys'
import type { GfsBrowserChild } from '@hooks/domain/useGfsBrowserController'
import { describeGfsReadError } from '@lib/gfsGrantErrors'
import { isGfsChildrenDenied, purgeDeniedGfsChildren } from './deniedChildren'
import type { GfsMoveDialogProps, GfsNumberedNameConsent } from './moveDialog.types'

type SelectedDestination = Pick<GfsBrowserChild, 'resourceId' | 'name'>

interface GfsMoveTreeDataNode extends DataNode {
  'aria-label'?: string
  folder?: GfsBrowserChild
}

type GfsChildrenPage = Awaited<ReturnType<typeof window.clerum.gfs.listChildren>>

interface GfsChildrenQuerySnapshot {
  data?: InfiniteData<GfsChildrenPage, string | undefined>
  error: unknown
  isFetching: boolean
  isFetchingNextPage: boolean
  hasNextPage: boolean
  fetchNextPage: () => Promise<unknown>
}

interface GfsMoveChildrenQueryObserverProps {
  folder: GfsBrowserChild
  scope: string
  sessionGeneration: number | null
  enabled: boolean
  onResult: (
    scope: string,
    generation: number | null,
    resourceId: string,
    result: GfsChildrenQuerySnapshot
  ) => void
}

function GfsMoveChildrenQueryObserver({
  folder,
  scope,
  sessionGeneration,
  enabled,
  onResult,
}: GfsMoveChildrenQueryObserverProps) {
  const query = useInfiniteQuery<
    GfsChildrenPage,
    Error,
    InfiniteData<GfsChildrenPage, string | undefined>,
    ReturnType<typeof desktopQueryKeys.gfsChildren>,
    string | undefined
  >({
    queryKey: desktopQueryKeys.gfsChildren(
      scope,
      folder.resourceId,
      GFS_DRIVE_MAIN,
      sessionGeneration
    ),
    queryFn: ({ pageParam }) =>
      window.clerum.gfs.listChildren(folder.resourceId, GFS_DRIVE_MAIN, pageParam),
    enabled: enabled && isGfsSessionGeneration(sessionGeneration),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
  })

  useEffect(() => {
    onResult(scope, sessionGeneration, folder.resourceId, {
      data: query.data,
      error: query.error,
      isFetching: query.isFetching,
      isFetchingNextPage: query.isFetchingNextPage,
      hasNextPage: query.hasNextPage,
      fetchNextPage: query.fetchNextPage,
    })
  }, [
    folder.resourceId,
    onResult,
    scope,
    sessionGeneration,
    query.data,
    query.error,
    query.fetchNextPage,
    query.hasNextPage,
    query.isFetching,
    query.isFetchingNextPage,
  ])

  return null
}

/**
 * Both banners in this dialog show server verdicts that crossed Electron IPC,
 * so the raw message opens with `Error invoking remote method 'gfs:…'` — our
 * own process boundary — and renders a 429 as a bare status line. The shared
 * read-plane presenter strips the wrapper and gives a rate limit the same
 * words every other GFS surface uses; everything else passes through, so the
 * server's verdict is never swallowed.
 */
function errorMessage(error: unknown): string | null {
  if (!error) return null
  return describeGfsReadError(error).message
}

function folderItems(items: GfsBrowserChild[], excludedIds: ReadonlySet<string>) {
  return items
    .filter(item => item.kind === 'directory' && !excludedIds.has(item.resourceId))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function childQuerySnapshotKey(
  scope: string,
  resourceId: string,
  sessionGeneration: number | null
): string {
  return JSON.stringify([scope, sessionGeneration, resourceId])
}

/**
 * Folder-picker dialog for moving a gfs resource (PATCH newParentId). The
 * picker keeps accessible roots in view and expands child folders inline,
 * reusing the Files page's TanStack keys so already-loaded folders render
 * instantly and stay coherent with the page.
 *
 * Cycle safety: "Move here" is disabled while the dialog path passes through
 * the target itself (a folder cannot move into its own subtree — the server
 * would reject it with path_invalid). Move AUTHORITY is parent-relative and
 * enforced server-side; a 403/412 from the commit surfaces as an in-dialog
 * banner so the user can pick a different folder without reopening.
 */
export function GfsMoveDialog({
  target,
  sessionScope,
  sessionGeneration,
  initialCrumbs,
  onMove,
  onMoveWithOwnership,
  onRetryPermissionCheck,
  onClose,
  busy = false,
  permissionStatus = null,
  onAuthorityFailure,
}: GfsMoveDialogProps) {
  const queryClient = useQueryClient()
  const scope = sessionScope ?? ''
  const authorityRef = useRef({ scope, generation: sessionGeneration })
  authorityRef.current = { scope, generation: sessionGeneration }
  const isAuthorityCurrent = () =>
    Boolean(sessionScope) &&
    isGfsSessionAuthorityCurrent(
      sessionScope ?? null,
      sessionGeneration,
      authorityRef.current.scope,
      authorityRef.current.generation
    )
  const initialDestination = initialCrumbs[initialCrumbs.length - 1]
  // The folder that already contains the target. Row moves carry the real
  // parent id; for the current resource the sliced crumbs end at its parent.
  // Selecting it as the destination is a no-op the server accepts (it bumps
  // the version and changes nothing), so the dialog must refuse it instead
  // of confirming a "successful" move that visibly changed nothing.
  const currentParentId =
    typeof target.parentResourceId === 'string'
      ? target.parentResourceId
      : initialDestination && initialDestination.resourceId !== target.resourceId
        ? initialDestination.resourceId
        : null
  const currentParentName =
    initialDestination && initialDestination.resourceId === currentParentId
      ? initialDestination.name
      : null
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(
    () => new Set(initialCrumbs.map(crumb => crumb.resourceId))
  )
  const [scopedSelectedDestination, setScopedSelectedDestination] = useState<{
    scope: string
    generation: number | null
    destination: SelectedDestination
  } | null>(
    // Never preselect the target's own folder — in every entry path the last
    // crumb IS the current parent, so the old preselect only ever armed the
    // no-op move described above.
    () =>
      initialDestination &&
      initialDestination.resourceId !== target.resourceId &&
      initialDestination.resourceId !== currentParentId
        ? {
            scope,
            generation: sessionGeneration,
            destination: {
              resourceId: initialDestination.resourceId,
              name: initialDestination.name,
            },
          }
        : null
  )
  const selectedDestination =
    scopedSelectedDestination?.scope === scope &&
    scopedSelectedDestination.generation === sessionGeneration
      ? scopedSelectedDestination.destination
      : null
  const [error, setError] = useState<string | null>(null)
  const [permissionCheckSucceeded, setPermissionCheckSucceeded] = useState(false)
  const [numberedNameProposal, setNumberedNameProposal] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const numberedNameConsentRef = useRef<((accepted: boolean) => void) | null>(null)
  const selectedDestinationRef = useRef(selectedDestination)
  selectedDestinationRef.current = selectedDestination
  const dialogIdentity = {
    scope,
    sessionGeneration,
    resourceId: target.resourceId,
    name: target.name,
    kind: target.kind,
  }
  const dialogIdentityRef = useRef(dialogIdentity)
  const previousDialogIdentityRef = useRef(dialogIdentity)
  dialogIdentityRef.current = dialogIdentity
  const settleNumberedNameConsent = useCallback((accepted: boolean) => {
    const resolve = numberedNameConsentRef.current
    numberedNameConsentRef.current = null
    if (mountedRef.current) setNumberedNameProposal(null)
    resolve?.(accepted)
  }, [])
  const closeDialog = () => {
    settleNumberedNameConsent(false)
    onClose()
  }
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      numberedNameConsentRef.current?.(false)
      numberedNameConsentRef.current = null
    }
  }, [])
  useEffect(() => {
    const previous = previousDialogIdentityRef.current
    const current = dialogIdentityRef.current
    if (
      previous.scope !== current.scope ||
      previous.sessionGeneration !== current.sessionGeneration ||
      previous.resourceId !== current.resourceId ||
      previous.name !== current.name ||
      previous.kind !== current.kind
    ) {
      settleNumberedNameConsent(false)
    }
    previousDialogIdentityRef.current = current
  }, [
    scope,
    sessionGeneration,
    target.kind,
    target.name,
    target.resourceId,
    settleNumberedNameConsent,
  ])
  const [childQuerySnapshots, setChildQuerySnapshots] = useState(
    () => new Map<string, GfsChildrenQuerySnapshot>()
  )
  const handleChildQueryResult = useCallback(
    (
      resultScope: string,
      resultGeneration: number | null,
      resourceId: string,
      result: GfsChildrenQuerySnapshot
    ) => {
      if (
        !isGfsSessionGeneration(resultGeneration) ||
        !isGfsSessionAuthorityCurrent(resultScope, resultGeneration, scope, sessionGeneration)
      ) {
        return
      }
      setChildQuerySnapshots(previous => {
        const key = childQuerySnapshotKey(resultScope, resourceId, resultGeneration)
        const current = previous.get(key)
        if (
          current &&
          current.data === result.data &&
          current.error === result.error &&
          current.isFetching === result.isFetching &&
          current.isFetchingNextPage === result.isFetchingNextPage &&
          current.hasNextPage === result.hasNextPage &&
          current.fetchNextPage === result.fetchNextPage
        ) {
          return previous
        }
        const next = new Map(previous)
        next.set(key, result)
        return next
      })
    },
    [scope, sessionGeneration]
  )
  const treeContainerRef = useRef<HTMLDivElement>(null)
  const foldersByIdRef = useRef(new Map<string, GfsBrowserChild>())
  const accessibleQuery = useInfiniteQuery({
    queryKey: desktopQueryKeys.gfsAccessible(scope, GFS_DRIVE_MAIN, sessionGeneration),
    queryFn: ({ pageParam }) => {
      const listAccessible = window.clerum?.gfs?.listAccessible
      return typeof listAccessible === 'function'
        ? listAccessible(GFS_DRIVE_MAIN, pageParam)
        : Promise.resolve({ items: [], nextCursor: null })
    },
    enabled: Boolean(sessionScope) && isGfsSessionGeneration(sessionGeneration),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
  })
  const rootFolders = useMemo(() => {
    const accessibleFolders = (accessibleQuery.data?.pages ?? [])
      .flatMap(page => page.items)
      .map(item => ({
        ...item,
        drive: item.drive ?? GFS_DRIVE_MAIN,
        parentResourceId: item.parentResourceId ?? null,
      }))
      .filter(item => item.kind === 'directory')
    const currentPathRoot = initialCrumbs[0]
    if (
      currentPathRoot?.kind === 'directory' &&
      !accessibleFolders.some(folder => folder.resourceId === currentPathRoot.resourceId)
    ) {
      accessibleFolders.unshift({
        ...currentPathRoot,
        rid: currentPathRoot.resourceId,
        drive: GFS_DRIVE_MAIN,
        parentResourceId: null,
        path: null,
      })
    }
    const accessibleFolderIds = new Set(accessibleFolders.map(folder => folder.resourceId))
    const roots = accessibleFolders.filter(
      folder => !folder.parentResourceId || !accessibleFolderIds.has(folder.parentResourceId)
    )
    return folderItems(roots, new Set([target.resourceId]))
  }, [accessibleQuery.data, initialCrumbs, target.resourceId])

  const directoryFolders: GfsBrowserChild[] = []
  const collectDirectoryFolders = (
    folders: readonly GfsBrowserChild[],
    ancestors: ReadonlySet<string>
  ) => {
    for (const folder of folders) {
      if (folder.kind !== 'directory') continue
      directoryFolders.push(folder)
      if (!expandedFolderIds.has(folder.resourceId)) continue
      const cached = childQuerySnapshots.get(
        childQuerySnapshotKey(scope, folder.resourceId, sessionGeneration)
      )?.data
      const excluded = new Set([target.resourceId, ...ancestors, folder.resourceId])
      collectDirectoryFolders(
        folderItems(cached?.pages.flatMap(page => page.items ?? []) ?? [], excluded),
        new Set([...ancestors, folder.resourceId])
      )
    }
  }
  collectDirectoryFolders(rootFolders, new Set())
  const childQueriesByResourceId = childQuerySnapshots

  const listError = errorMessage(accessibleQuery.error)
  const loadingRoots = accessibleQuery.isFetching && rootFolders.length === 0
  const pathPassesThroughTarget =
    initialCrumbs.some(crumb => crumb.resourceId === target.resourceId) ||
    selectedDestination?.resourceId === target.resourceId
  const isNoOpDestination = Boolean(
    selectedDestination && selectedDestination.resourceId === currentParentId
  )

  // Destination listings are session-scoped GFS reads: an authority failure
  // here must reach the same fail-closed boundary as the page's queries (the
  // page then closes this dialog via its revocation effect). Policy errors
  // return false and render as the dialog's in-place banner below.
  useEffect(() => {
    if (
      listError &&
      isAuthorityCurrent() &&
      isGfsSessionGeneration(sessionGeneration) &&
      sessionScope
    ) {
      onAuthorityFailure?.(listError, sessionScope, sessionGeneration)
    }
  }, [listError, onAuthorityFailure, sessionGeneration, sessionScope])

  const processedChildErrorsRef = useRef(new Map<string, unknown>())
  useEffect(() => {
    if (!isAuthorityCurrent() || !isGfsSessionGeneration(sessionGeneration) || !sessionScope) return
    directoryFolders.forEach(folder => {
      const result = childQueriesByResourceId.get(
        childQuerySnapshotKey(scope, folder.resourceId, sessionGeneration)
      )
      const errorKey = childQuerySnapshotKey(scope, folder.resourceId, sessionGeneration)
      if (!result?.error) {
        processedChildErrorsRef.current.delete(errorKey)
        return
      }
      if (processedChildErrorsRef.current.get(errorKey) === result.error) return
      processedChildErrorsRef.current.set(errorKey, result.error)
      const queryKey = desktopQueryKeys.gfsChildren(
        scope,
        folder.resourceId,
        GFS_DRIVE_MAIN,
        sessionGeneration
      )
      purgeDeniedGfsChildren(queryClient, queryKey, result.error)
      const message = isGfsChildrenDenied(result.error, result.data)
        ? 'This folder is no longer available.'
        : errorMessage(result.error)
      if (message) onAuthorityFailure?.(message, sessionScope, sessionGeneration)
    })
  }, [
    childQueriesByResourceId,
    directoryFolders,
    onAuthorityFailure,
    queryClient,
    scope,
    sessionGeneration,
    sessionScope,
  ])

  const selectFolder = useCallback(
    (folder: GfsBrowserChild) => {
      settleNumberedNameConsent(false)
      setError(null)
      setPermissionCheckSucceeded(false)
      setScopedSelectedDestination({
        scope,
        generation: sessionGeneration,
        destination: { resourceId: folder.resourceId, name: folder.name },
      })
      setExpandedFolderIds(previous => {
        if (previous.has(folder.resourceId)) return previous
        return new Set(previous).add(folder.resourceId)
      })
    },
    [scope, sessionGeneration, settleNumberedNameConsent]
  )

  const handleTreeKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        target.closest('button,input,textarea,[role="button"]')
      ) {
        return
      }
      const tree = treeContainerRef.current?.querySelector<HTMLElement>(
        '[role="tree"][aria-activedescendant]'
      )
      const activeId = tree?.getAttribute('aria-activedescendant')
      const targetTreeItem =
        target instanceof HTMLElement ? target.closest<HTMLElement>('[role="treeitem"]') : null
      const activeNode = activeId ? document.getElementById(activeId) : null
      const title =
        targetTreeItem?.querySelector<HTMLElement>('[data-resource-id]') ??
        (activeNode?.matches('[data-resource-id]')
          ? activeNode
          : activeNode?.querySelector<HTMLElement>('[data-resource-id]'))
      const resourceId = title?.getAttribute('data-resource-id')
      const folder = resourceId ? foldersByIdRef.current.get(resourceId) : undefined
      if (!folder) return
      event.preventDefault()
      event.stopPropagation()
      selectFolder(folder)
    },
    [selectFolder]
  )
  const handleTreeRowClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      if (target.closest('.ant-tree-switcher,button,input,textarea,[role="button"]')) return
      if (target.closest('.ant-tree-node-content-wrapper')) return
      const treeItem = target.closest<HTMLElement>('[role="treeitem"]')
      const title = treeItem?.querySelector<HTMLElement>('[data-resource-id]')
      const resourceId = title?.getAttribute('data-resource-id')
      const folder = resourceId ? foldersByIdRef.current.get(resourceId) : undefined
      if (folder) selectFolder(folder)
    },
    [selectFolder]
  )

  const foldersById = new Map<string, GfsBrowserChild>()
  const buildFolderNode = (
    folder: GfsBrowserChild,
    ancestors: ReadonlySet<string>
  ): GfsMoveTreeDataNode => {
    foldersById.set(folder.resourceId, folder)
    const isExpanded = expandedFolderIds.has(folder.resourceId)
    const childQuery = childQueriesByResourceId.get(
      childQuerySnapshotKey(scope, folder.resourceId, sessionGeneration)
    )
    const childDenied = isGfsChildrenDenied(childQuery?.error, childQuery?.data)
    const childError = childDenied
      ? 'This folder is no longer available.'
      : errorMessage(childQuery?.error)
    const childFolders =
      childDenied || !childQuery?.data
        ? []
        : folderItems(
            childQuery.data.pages.flatMap(page => page.items),
            new Set([target.resourceId, ...ancestors])
          )
    const loadingChildren = Boolean(isExpanded && childQuery?.isFetching && !childQuery.data)
    const hasMoreChildren = Boolean(childQuery?.hasNextPage)
    const canExpand =
      !childQuery?.data || loadingChildren || hasMoreChildren || childFolders.length > 0
    const nextAncestors = new Set([...ancestors, folder.resourceId])
    const children: GfsMoveTreeDataNode[] = []

    if (isExpanded) {
      if (loadingChildren) {
        children.push({
          key: `status:${folder.resourceId}:loading`,
          selectable: false,
          isLeaf: true,
          title: (
            <Flex align="center" gap="small" role="status" aria-live="polite">
              <Spin size="small" />
              <Typography.Text type="secondary">Loading subfolders…</Typography.Text>
            </Flex>
          ),
        })
      }
      if (childError) {
        children.push({
          key: `status:${folder.resourceId}:error`,
          selectable: false,
          isLeaf: true,
          title: <Alert type="error" showIcon title={childError} />,
        })
      }
      children.push(...childFolders.map(child => buildFolderNode(child, nextAncestors)))
      if (hasMoreChildren && childQuery) {
        children.push({
          key: `status:${folder.resourceId}:more`,
          selectable: false,
          isLeaf: true,
          title: (
            <Button
              loading={childQuery.isFetchingNextPage}
              onClick={event => {
                event.stopPropagation()
                void childQuery.fetchNextPage()
              }}
            >
              Load more
            </Button>
          ),
        })
      }
      if (!loadingChildren && !childError && childFolders.length === 0 && !hasMoreChildren) {
        children.push({
          key: `status:${folder.resourceId}:empty`,
          selectable: false,
          isLeaf: true,
          title: <Typography.Text type="secondary">No subfolders.</Typography.Text>,
        })
      }
    }

    return {
      key: folder.resourceId,
      'aria-label': folder.name,
      folder,
      title: (
        <Flex align="center" gap="small" data-resource-id={folder.resourceId}>
          <span className="da-gfs-move-dialog__tree-folder-icon" aria-hidden="true">
            <IconContexts aria-hidden="true" width={18} height={18} />
          </span>
          <Typography.Text>{folder.name}</Typography.Text>
          {selectedDestination?.resourceId === folder.resourceId ? (
            <IconCheck aria-label="Selected destination" width={16} height={16} />
          ) : null}
        </Flex>
      ),
      isLeaf: !canExpand,
      children: children.length ? children : undefined,
    }
  }
  const treeData = rootFolders.map(folder => buildFolderNode(folder, new Set()))
  foldersByIdRef.current = foldersById

  const isCurrentDestination = (destination: SelectedDestination) => {
    const expectedIdentity = dialogIdentityRef.current
    return () => {
      const currentIdentity = dialogIdentityRef.current
      return (
        mountedRef.current &&
        Boolean(sessionScope) &&
        isGfsSessionGeneration(sessionGeneration) &&
        isAuthorityCurrent() &&
        selectedDestinationRef.current?.resourceId === destination.resourceId &&
        selectedDestinationRef.current.name === destination.name &&
        currentIdentity.scope === expectedIdentity.scope &&
        currentIdentity.sessionGeneration === expectedIdentity.sessionGeneration &&
        currentIdentity.resourceId === expectedIdentity.resourceId &&
        currentIdentity.name === expectedIdentity.name &&
        currentIdentity.kind === expectedIdentity.kind
      )
    }
  }

  const commit = async () => {
    const destination = selectedDestination
    if (!destination) return
    const isCurrent = isCurrentDestination(destination)
    const requestNumberedNameConsent: GfsNumberedNameConsent = proposedName =>
      new Promise(resolve => {
        if (!isCurrent()) {
          resolve(false)
          return
        }
        numberedNameConsentRef.current?.(false)
        numberedNameConsentRef.current = resolve
        setError(null)
        setNumberedNameProposal(proposedName)
      })
    if (!isCurrent()) return
    setError(null)
    setPermissionCheckSucceeded(false)
    try {
      if (onMoveWithOwnership) {
        await onMoveWithOwnership(
          destination.resourceId,
          destination.name,
          isCurrent,
          requestNumberedNameConsent
        )
      } else if (onMove) {
        await onMove(destination.resourceId, destination.name)
      } else {
        throw new Error('Move dialog requires a commit handler')
      }
    } catch (moveError) {
      if (isCurrent()) setError(errorMessage(moveError))
    }
  }

  const retryPermissionCheck = async () => {
    const destination = selectedDestination
    if (!destination) return
    const isCurrent = isCurrentDestination(destination)
    if (!isCurrent()) return
    setError(null)
    setPermissionCheckSucceeded(false)
    try {
      await onRetryPermissionCheck(destination.resourceId, destination.name, isCurrent)
      if (isCurrent()) setPermissionCheckSucceeded(true)
    } catch (retryError) {
      if (isCurrent()) setError(errorMessage(retryError))
    }
  }

  return (
    <Modal
      aria-label={`Move ${target.kind === 'directory' ? 'folder' : 'file'} ${target.name}`}
      footer={
        <Flex align="center" justify="space-between" gap="middle" wrap>
          <Typography.Text role="status" aria-live="polite">
            {selectedDestination
              ? `Move to ${selectedDestination.name}`
              : 'Select a destination folder'}
          </Typography.Text>
          <Flex gap="small">
            <Button htmlType="button" onClick={closeDialog}>
              Cancel
            </Button>
            <Button
              aria-label={selectedDestination ? `Move here (${selectedDestination.name})` : 'Move'}
              disabled={
                busy ||
                !isAuthorityCurrent() ||
                numberedNameProposal !== null ||
                !selectedDestination ||
                pathPassesThroughTarget ||
                isNoOpDestination
              }
              loading={busy}
              htmlType="button"
              onClick={() => void commit()}
              type="primary"
            >
              Move
            </Button>
          </Flex>
        </Flex>
      }
      onCancel={closeDialog}
      closable={{
        'aria-label': 'Close move dialog',
        closeIcon: <IconClose aria-hidden="true" width={18} height={18} />,
      }}
      open
      title={
        <Flex align="center" gap="small">
          <IconContexts aria-hidden="true" width={16} height={16} />
          <Typography.Title
            aria-label={`Move ${target.kind === 'directory' ? 'folder' : 'file'} ${target.name}`}
            level={4}
          >
            Move “{target.name}”
          </Typography.Title>
        </Flex>
      }
    >
      <Flex
        vertical
        gap="middle"
        ref={treeContainerRef}
        onClickCapture={handleTreeRowClickCapture}
        onKeyDownCapture={handleTreeKeyDownCapture}
      >
        {permissionStatus === 'checking' ? (
          <Alert role="status" showIcon type="info" title="Checking permissions…" />
        ) : null}
        {error ? <Alert role="alert" showIcon type="error" title={error} /> : null}
        {permissionCheckSucceeded ? (
          <Alert
            role="status"
            showIcon
            type="success"
            title="Permissions verified. Select Move to confirm."
          />
        ) : null}
        {permissionStatus === 'failed' ? (
          <Button
            htmlType="button"
            disabled={busy || !selectedDestination || !isAuthorityCurrent()}
            onClick={() => void retryPermissionCheck()}
            size="small"
          >
            Retry permission check
          </Button>
        ) : null}
        {numberedNameProposal ? (
          <Alert
            role="group"
            aria-label="Confirm numbered name for Move"
            type="warning"
            showIcon
            title={
              <Flex vertical gap="small">
                <Typography.Text role="status">
                  This name already exists in {selectedDestination?.name}. Move it as{' '}
                  <Typography.Text strong>{numberedNameProposal}</Typography.Text>?
                </Typography.Text>
                <Flex gap="small" wrap>
                  <Button
                    htmlType="button"
                    disabled={busy || !isAuthorityCurrent()}
                    onClick={() => settleNumberedNameConsent(true)}
                    size="small"
                    type="primary"
                  >
                    Move as {numberedNameProposal}
                  </Button>
                  <Button
                    htmlType="button"
                    disabled={busy}
                    onClick={() => settleNumberedNameConsent(false)}
                    size="small"
                  >
                    Keep current name
                  </Button>
                </Flex>
              </Flex>
            }
          />
        ) : null}
        {listError ? <Alert role="alert" type="error" showIcon title={listError} /> : null}
        <Flex align="center" gap="small">
          <Typography.Text>Current location:</Typography.Text>
          <Typography.Text strong>
            <IconContexts aria-hidden="true" width={16} height={16} />{' '}
            {currentParentName ?? (currentParentId ? 'another shared folder' : 'Shared with me')}
          </Typography.Text>
        </Flex>
        <Typography.Text strong>Shared with me</Typography.Text>
        {loadingRoots ? (
          <Flex align="center" gap="small" role="status" aria-live="polite">
            <Spin size="small" />
            <Typography.Text>Loading folders…</Typography.Text>
          </Flex>
        ) : rootFolders.length === 0 && !accessibleQuery.hasNextPage ? (
          <Empty
            description={listError ? 'Destinations could not be listed.' : 'No folders here.'}
          />
        ) : rootFolders.length ? (
          <>
            {directoryFolders.map(folder => (
              <GfsMoveChildrenQueryObserver
                enabled={expandedFolderIds.has(folder.resourceId)}
                sessionGeneration={sessionGeneration}
                folder={folder}
                key={folder.resourceId}
                onResult={handleChildQueryResult}
                scope={scope}
              />
            ))}
            <Tree
              aria-label="EvenDrive destination folders"
              treeData={treeData}
              virtual={false}
              expandedKeys={[...expandedFolderIds]}
              selectedKeys={selectedDestination ? [selectedDestination.resourceId] : []}
              switcherIcon={<IconChevronRight aria-hidden="true" width={14} height={14} />}
              onExpand={keys => setExpandedFolderIds(new Set(keys.map(String)))}
              onSelect={(_keys, info) => {
                const folder = foldersByIdRef.current.get(String(info.node.key))
                if (folder) selectFolder(folder)
              }}
            />
          </>
        ) : null}
        {accessibleQuery.hasNextPage ? (
          <Button
            loading={accessibleQuery.isFetchingNextPage}
            onClick={() => void accessibleQuery.fetchNextPage()}
          >
            Load more
          </Button>
        ) : null}
        {pathPassesThroughTarget ? (
          <Alert type="warning" showIcon title="A folder can’t be moved into its own subtree." />
        ) : null}
        {isNoOpDestination ? (
          <Alert
            type="info"
            showIcon
            title={`${target.name} is already in ${currentParentName ?? 'the folder you selected'} — pick a different destination.`}
          />
        ) : null}
      </Flex>
    </Modal>
  )
}
