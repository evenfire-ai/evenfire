import { useEffect, useMemo, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Button, IconButton, StatusBanner } from '@components/Common'
import { IconCheck, IconChevronRight, IconClose, IconContexts } from '@components/SidebarNav/icons'
import { GFS_DRIVE_MAIN } from '@constants/gfsBrowser'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import type { GfsBrowserChild } from '@hooks/domain/useGfsBrowserController'
import type { GfsMoveDialogProps } from './moveDialog.types'

type SelectedDestination = Pick<GfsBrowserChild, 'resourceId' | 'name'>

function errorMessage(error: unknown): string | null {
  if (!error) return null
  return error instanceof Error ? error.message : String(error)
}

function folderItems(items: GfsBrowserChild[], excludedIds: ReadonlySet<string>) {
  return items
    .filter(item => item.kind === 'directory' && !excludedIds.has(item.resourceId))
    .sort((left, right) => left.name.localeCompare(right.name))
}

type GfsMoveTreeFolderProps = {
  folder: GfsBrowserChild
  level: number
  ancestors: ReadonlySet<string>
  targetResourceId: string
  scope: string
  expandedFolderIds: ReadonlySet<string>
  selectedDestination: SelectedDestination | null
  onToggle: (resourceId: string) => void
  onSelect: (folder: GfsBrowserChild) => void
  onAuthorityFailure?: (message: string) => boolean
}

function GfsMoveTreeFolder({
  folder,
  level,
  ancestors,
  targetResourceId,
  scope,
  expandedFolderIds,
  selectedDestination,
  onToggle,
  onSelect,
  onAuthorityFailure,
}: GfsMoveTreeFolderProps) {
  const isExpanded = expandedFolderIds.has(folder.resourceId)
  const childQuery = useInfiniteQuery({
    queryKey: desktopQueryKeys.gfsChildren(scope, folder.resourceId, GFS_DRIVE_MAIN),
    queryFn: ({ pageParam }) =>
      window.clerum.gfs.listChildren(folder.resourceId, GFS_DRIVE_MAIN, pageParam),
    enabled: isExpanded,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
  })
  const childError = errorMessage(childQuery.error)
  const childFolders = useMemo(
    () =>
      folderItems(
        (childQuery.data?.pages ?? []).flatMap(page => page.items),
        new Set([targetResourceId, ...ancestors])
      ),
    [ancestors, childQuery.data, targetResourceId]
  )

  useEffect(() => {
    if (childError) onAuthorityFailure?.(childError)
  }, [childError, onAuthorityFailure])

  const loadingChildren = Boolean(isExpanded && childQuery.isFetching && !childQuery.data)
  const hasMoreChildren = Boolean(childQuery.hasNextPage)
  const hasLoadedChildren = Boolean(childQuery.data)
  const canExpand =
    !hasLoadedChildren || loadingChildren || hasMoreChildren || childFolders.length > 0
  const nextAncestors = new Set(ancestors)
  nextAncestors.add(folder.resourceId)

  return (
    <div
      aria-expanded={canExpand ? isExpanded : undefined}
      aria-level={level}
      aria-selected={selectedDestination?.resourceId === folder.resourceId}
      className="da-gfs-move-dialog__tree-item"
      role="treeitem"
    >
      <div className="da-gfs-move-dialog__tree-row">
        {canExpand ? (
          <IconButton
            aria-expanded={isExpanded}
            className={`da-gfs-move-dialog__tree-toggle${isExpanded ? ' is-expanded' : ''}`}
            label={`${isExpanded ? 'Collapse' : 'Expand'} ${folder.name}`}
            onClick={() => onToggle(folder.resourceId)}
            size="sm"
            variant="ghost"
          >
            <IconChevronRight />
          </IconButton>
        ) : (
          <span className="da-gfs-move-dialog__tree-toggle-placeholder" aria-hidden="true" />
        )}
        <Button
          align="start"
          aria-selected={selectedDestination?.resourceId === folder.resourceId}
          block
          className="da-gfs-move-dialog__tree-select"
          color="neutral"
          onClick={() => onSelect(folder)}
          variant="text"
        >
          <span className="da-gfs-move-dialog__tree-folder-icon" aria-hidden="true">
            <IconContexts />
          </span>
          <span className="da-gfs-move-dialog__tree-folder-name">{folder.name}</span>
          <span className="da-gfs-move-dialog__tree-selected-icon" aria-hidden="true">
            {selectedDestination?.resourceId === folder.resourceId ? <IconCheck /> : null}
          </span>
        </Button>
      </div>
      {isExpanded ? (
        <div className="da-gfs-move-dialog__tree-group" role="group">
          {loadingChildren ? (
            <p className="muted" role="status">
              Loading subfolders…
            </p>
          ) : null}
          {childError ? <StatusBanner tone="error" text={childError} /> : null}
          {childFolders.map(child => (
            <GfsMoveTreeFolder
              ancestors={nextAncestors}
              expandedFolderIds={expandedFolderIds}
              folder={child}
              key={child.resourceId}
              level={level + 1}
              onAuthorityFailure={onAuthorityFailure}
              onSelect={onSelect}
              onToggle={onToggle}
              scope={scope}
              selectedDestination={selectedDestination}
              targetResourceId={targetResourceId}
            />
          ))}
          {hasMoreChildren ? (
            <div className="da-gfs-move-dialog__tree-more">
              <Button
                loading={childQuery.isFetchingNextPage}
                onClick={() => void childQuery.fetchNextPage()}
                size="sm"
                variant="outline"
              >
                Load more
              </Button>
            </div>
          ) : null}
          {!loadingChildren && !childError && !childFolders.length && !hasMoreChildren ? (
            <p className="muted">No subfolders.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
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
  const initialDestination = initialCrumbs[initialCrumbs.length - 1]
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(
    () => new Set(initialCrumbs.map(crumb => crumb.resourceId))
  )
  const [selectedDestination, setSelectedDestination] = useState<SelectedDestination | null>(() =>
    initialDestination && initialDestination.resourceId !== target.resourceId
      ? { resourceId: initialDestination.resourceId, name: initialDestination.name }
      : null
  )
  const [error, setError] = useState<string | null>(null)
  const scope = sessionScope ?? 'anonymous'

  const accessibleQuery = useInfiniteQuery({
    queryKey: desktopQueryKeys.gfsAccessible(scope, GFS_DRIVE_MAIN),
    queryFn: ({ pageParam }) =>
      window.clerum?.gfs?.listAccessible(GFS_DRIVE_MAIN, pageParam) ??
      Promise.resolve({ items: [], nextCursor: null }),
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
    const accessibleFolderIds = new Set(accessibleFolders.map(folder => folder.resourceId))
    const roots = accessibleFolders.filter(
      folder => !folder.parentResourceId || !accessibleFolderIds.has(folder.parentResourceId)
    )
    return folderItems(roots, new Set([target.resourceId]))
  }, [accessibleQuery.data, target.resourceId])

  const listError = errorMessage(accessibleQuery.error)
  const loadingRoots = accessibleQuery.isFetching && rootFolders.length === 0
  const pathPassesThroughTarget =
    initialCrumbs.some(crumb => crumb.resourceId === target.resourceId) ||
    selectedDestination?.resourceId === target.resourceId

  // Destination listings are session-scoped GFS reads: an authority failure
  // here must reach the same fail-closed boundary as the page's queries (the
  // page then closes this dialog via its revocation effect). Policy errors
  // return false and render as the dialog's in-place banner below.
  useEffect(() => {
    if (listError) onAuthorityFailure?.(listError)
  }, [listError, onAuthorityFailure])

  const toggleFolder = (resourceId: string) => {
    setError(null)
    setExpandedFolderIds(previous => {
      const next = new Set(previous)
      if (next.has(resourceId)) next.delete(resourceId)
      else next.add(resourceId)
      return next
    })
  }

  const selectFolder = (folder: GfsBrowserChild) => {
    setError(null)
    setSelectedDestination({ resourceId: folder.resourceId, name: folder.name })
    setExpandedFolderIds(previous => {
      if (previous.has(folder.resourceId)) return previous
      return new Set(previous).add(folder.resourceId)
    })
  }

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
    <div
      className="da-gfs-manage-modal"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="da-gfs-manage-dialog da-gfs-move-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Move ${target.kind === 'directory' ? 'folder' : 'file'} ${target.name}`}
      >
        <header className="da-gfs-manage-dialog__header">
          <span className="da-gfs-manage-dialog__icon" aria-hidden="true">
            <IconContexts />
          </span>
          <span className="da-gfs-manage-dialog__heading">
            <h3>Move {target.name}</h3>
            <span className="muted">Choose a destination folder.</span>
          </span>
          <span className="da-gfs-manage-dialog__top-actions">
            <IconButton label="Close move dialog" onClick={onClose} size="sm" variant="ghost">
              <IconClose />
            </IconButton>
          </span>
        </header>
        <div className="da-gfs-manage-dialog__body">
          {error ? <StatusBanner tone="error" text={error} /> : null}
          {listError ? <StatusBanner tone="error" text={listError} /> : null}
          <div className="da-gfs-move-dialog__tree-heading">
            <span className="da-gfs-move-dialog__tree-heading-copy">
              <span className="da-gfs-move-dialog__tree-eyebrow">Destination</span>
              <strong>Shared with me</strong>
            </span>
            <span className="muted">Expand folders to browse the full tree.</span>
          </div>
          <div
            className="da-gfs-move-dialog__tree"
            role="tree"
            aria-label="GFS destination folders"
          >
            {loadingRoots ? (
              <p className="muted" role="status">
                Loading folders…
              </p>
            ) : rootFolders.length === 0 && !accessibleQuery.hasNextPage ? (
              <p className="muted">No folders here.</p>
            ) : (
              <div className="da-gfs-move-dialog__tree-root">
                {rootFolders.map(folder => (
                  <GfsMoveTreeFolder
                    ancestors={new Set()}
                    expandedFolderIds={expandedFolderIds}
                    folder={folder}
                    key={folder.resourceId}
                    level={1}
                    onAuthorityFailure={onAuthorityFailure}
                    onSelect={selectFolder}
                    onToggle={toggleFolder}
                    scope={scope}
                    selectedDestination={selectedDestination}
                    targetResourceId={target.resourceId}
                  />
                ))}
                {accessibleQuery.hasNextPage ? (
                  <div className="da-gfs-move-dialog__tree-more">
                    <Button
                      loading={accessibleQuery.isFetchingNextPage}
                      onClick={() => void accessibleQuery.fetchNextPage()}
                      size="sm"
                      variant="outline"
                    >
                      Load more
                    </Button>
                  </div>
                ) : null}
              </div>
            )}
          </div>
          <div className="da-gfs-move-dialog__actions">
            <span className="da-gfs-move-dialog__selection" aria-live="polite">
              {selectedDestination ? (
                <>
                  Move to <strong>{selectedDestination.name}</strong>
                </>
              ) : (
                'Select a destination folder'
              )}
            </span>
            <span className="da-gfs-move-dialog__action-buttons">
              <Button onClick={onClose} type="button" variant="ghost">
                Cancel
              </Button>
              <Button
                disabled={!selectedDestination || pathPassesThroughTarget}
                loading={busy}
                onClick={() => void commit()}
                type="button"
              >
                Move here{selectedDestination ? ` (${selectedDestination.name})` : ''}
              </Button>
            </span>
          </div>
          {pathPassesThroughTarget ? (
            <p className="muted">A folder can’t be moved into its own subtree.</p>
          ) : null}
        </div>
      </section>
    </div>
  )
}
