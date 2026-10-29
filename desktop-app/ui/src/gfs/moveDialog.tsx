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
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import type { GfsBrowserChild } from '@hooks/domain/useGfsBrowserController'
import { describeGfsReadError } from '@lib/gfsGrantErrors'
import { isGfsChildrenDenied, purgeDeniedGfsChildren } from './deniedChildren'
import type { GfsMoveDialogProps } from './moveDialog.types'

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
  enabled: boolean
  onResult: (resourceId: string, result: GfsChildrenQuerySnapshot) => void
}

function GfsMoveChildrenQueryObserver({
  folder,
  scope,
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
    queryKey: desktopQueryKeys.gfsChildren(scope, folder.resourceId, GFS_DRIVE_MAIN),
    queryFn: ({ pageParam }) =>
      window.clerum.gfs.listChildren(folder.resourceId, GFS_DRIVE_MAIN, pageParam),
    enabled,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
  })

  useEffect(() => {
    onResult(folder.resourceId, {
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

function childQuerySnapshotKey(scope: string, resourceId: string): string {
  return JSON.stringify([scope, resourceId])
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
  initialCrumbs,
  onMove,
  onClose,
  busy = false,
  onAuthorityFailure,
}: GfsMoveDialogProps) {
  const queryClient = useQueryClient()
  const scope = sessionScope ?? 'anonymous'
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
            destination: {
              resourceId: initialDestination.resourceId,
              name: initialDestination.name,
            },
          }
        : null
  )
  const selectedDestination =
    scopedSelectedDestination?.scope === scope ? scopedSelectedDestination.destination : null
  const [error, setError] = useState<string | null>(null)
  const [childQuerySnapshots, setChildQuerySnapshots] = useState(
    () => new Map<string, GfsChildrenQuerySnapshot>()
  )
  const handleChildQueryResult = useCallback(
    (resourceId: string, result: GfsChildrenQuerySnapshot) => {
      setChildQuerySnapshots(previous => {
        const key = childQuerySnapshotKey(scope, resourceId)
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
    [scope]
  )
  const treeContainerRef = useRef<HTMLDivElement>(null)
  const foldersByIdRef = useRef(new Map<string, GfsBrowserChild>())
  const accessibleQuery = useInfiniteQuery({
    queryKey: desktopQueryKeys.gfsAccessible(scope, GFS_DRIVE_MAIN),
    queryFn: ({ pageParam }) => {
      const listAccessible = window.clerum?.gfs?.listAccessible
      return typeof listAccessible === 'function'
        ? listAccessible(GFS_DRIVE_MAIN, pageParam)
        : Promise.resolve({ items: [], nextCursor: null })
    },
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
      const cached = childQuerySnapshots.get(childQuerySnapshotKey(scope, folder.resourceId))?.data
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
    if (listError) onAuthorityFailure?.(listError)
  }, [listError, onAuthorityFailure])

  const processedChildErrorsRef = useRef(new Map<string, unknown>())
  useEffect(() => {
    directoryFolders.forEach(folder => {
      const result = childQueriesByResourceId.get(childQuerySnapshotKey(scope, folder.resourceId))
      if (!result?.error) {
        processedChildErrorsRef.current.delete(folder.resourceId)
        return
      }
      if (processedChildErrorsRef.current.get(folder.resourceId) === result.error) return
      processedChildErrorsRef.current.set(folder.resourceId, result.error)
      const queryKey = desktopQueryKeys.gfsChildren(scope, folder.resourceId, GFS_DRIVE_MAIN)
      purgeDeniedGfsChildren(queryClient, queryKey, result.error)
      const message = isGfsChildrenDenied(result.error, result.data)
        ? 'This folder is no longer available.'
        : errorMessage(result.error)
      if (message) onAuthorityFailure?.(message)
    })
  }, [childQueriesByResourceId, directoryFolders, onAuthorityFailure, queryClient, scope])

  const selectFolder = useCallback(
    (folder: GfsBrowserChild) => {
      setError(null)
      setScopedSelectedDestination({
        scope,
        destination: { resourceId: folder.resourceId, name: folder.name },
      })
      setExpandedFolderIds(previous => {
        if (previous.has(folder.resourceId)) return previous
        return new Set(previous).add(folder.resourceId)
      })
    },
    [scope]
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
    const childQuery = childQueriesByResourceId.get(childQuerySnapshotKey(scope, folder.resourceId))
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

  const commit = async () => {
    if (!selectedDestination) return
    setError(null)
    try {
      await onMove(selectedDestination.resourceId, selectedDestination.name)
    } catch (moveError) {
      setError(errorMessage(moveError))
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
            <Button onClick={onClose}>Cancel</Button>
            <Button
              aria-label={selectedDestination ? `Move here (${selectedDestination.name})` : 'Move'}
              disabled={!selectedDestination || pathPassesThroughTarget || isNoOpDestination}
              loading={busy}
              onClick={() => void commit()}
              type="primary"
            >
              Move
            </Button>
          </Flex>
        </Flex>
      }
      onCancel={onClose}
      closeIcon={<IconClose aria-hidden="true" width={18} height={18} />}
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
        {error ? <Alert type="error" showIcon title={error} /> : null}
        {listError ? <Alert type="error" showIcon title={listError} /> : null}
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
