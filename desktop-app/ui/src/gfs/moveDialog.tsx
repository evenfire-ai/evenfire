import { useEffect, useMemo, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Button, IconButton, StatusBanner } from '@components/Common'
import { IconClose, IconContexts } from '@components/SidebarNav/icons'
import { GFS_DRIVE_MAIN } from '@constants/gfsBrowser'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import type { GfsBrowserChild, GfsCrumb } from '@hooks/domain/useGfsBrowserController'
import type { GfsMoveDialogProps } from './moveDialog.types'

/**
 * Folder-picker dialog for moving a gfs resource (PATCH newParentId). Browsing
 * reuses the Files page's TanStack keys (accessible roots + folder children),
 * so already-loaded folders render instantly and stay coherent with the page.
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
  const [crumbs, setCrumbs] = useState<GfsCrumb[]>(initialCrumbs)
  const [error, setError] = useState<string | null>(null)
  const current = crumbs.length ? crumbs[crumbs.length - 1] : null
  const scope = sessionScope ?? 'anonymous'

  const accessibleQuery = useInfiniteQuery({
    queryKey: desktopQueryKeys.gfsAccessible(scope, GFS_DRIVE_MAIN),
    queryFn: ({ pageParam }) =>
      window.clerum?.gfs?.listAccessible(GFS_DRIVE_MAIN, pageParam) ??
      Promise.resolve({ items: [], nextCursor: null }),
    enabled: current === null,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
  })
  const childrenQuery = useInfiniteQuery({
    queryKey: desktopQueryKeys.gfsChildren(scope, current?.resourceId ?? '', GFS_DRIVE_MAIN),
    queryFn: ({ pageParam }) =>
      window.clerum.gfs.listChildren(current!.resourceId, GFS_DRIVE_MAIN, pageParam),
    enabled: current !== null,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
  })
  // Both listings are cursor-paginated; whichever one is active drives the
  // Load-more control so destinations beyond page one stay reachable (R4
  // spec §3). Fetching the next page keeps already-rendered rows in place.
  const activeQuery = current === null ? accessibleQuery : childrenQuery
  const hasMoreDestinations = Boolean(activeQuery.hasNextPage)
  const loadingMoreDestinations = activeQuery.isFetchingNextPage

  const folders = useMemo(() => {
    // Accessible-root items normalize their optional wire fields; children
    // items are already GfsBrowserChild. Both flows converge on the same
    // destination shape before filtering.
    const source: GfsBrowserChild[] =
      current === null
        ? (accessibleQuery.data?.pages ?? [])
            .flatMap(page => page.items)
            .map(item => ({
              ...item,
              drive: item.drive ?? GFS_DRIVE_MAIN,
              parentResourceId: item.parentResourceId ?? null,
            }))
        : (childrenQuery.data?.pages ?? []).flatMap(page => page.items)
    return source.filter(item => item.kind === 'directory' && item.resourceId !== target.resourceId)
  }, [accessibleQuery.data, childrenQuery.data, current, target.resourceId])

  // The dialog path itself must never run through the moved folder.
  const pathPassesThroughTarget = crumbs.some(crumb => crumb.resourceId === target.resourceId)
  const loading = current === null ? accessibleQuery.isFetching : childrenQuery.isFetching
  const listError =
    current === null
      ? (accessibleQuery.error?.message ?? null)
      : (childrenQuery.error?.message ?? null)
  // Destination listings are session-scoped GFS reads: an authority failure
  // here must reach the same fail-closed boundary as the page's queries (the
  // page then closes this dialog via its revocation effect). Policy errors
  // return false and render as the dialog's in-place banner below.
  useEffect(() => {
    if (listError) onAuthorityFailure?.(listError)
  }, [listError, onAuthorityFailure])

  const enterFolder = (folder: GfsBrowserChild) => {
    setError(null)
    setCrumbs(prev => [
      ...prev,
      {
        resourceId: folder.resourceId,
        gfsUri: folder.gfsUri,
        name: folder.name,
        kind: 'directory',
        version: folder.version,
        bytes: folder.bytes,
      },
    ])
  }

  const commit = async () => {
    if (!current) return
    setError(null)
    try {
      await onMove(current.resourceId, current.name)
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : String(moveError))
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
          <nav className="da-gfs-drive__breadcrumbs" aria-label="Move destination">
            <Button
              className="da-gfs-drive__breadcrumb"
              color="neutral"
              disabled={current === null}
              onClick={() => setCrumbs([])}
              variant="text"
            >
              Shared with me
            </Button>
            {crumbs.map((crumb, index) => (
              <span className="da-gfs-drive__crumb-group" key={crumb.resourceId}>
                <Button
                  className="da-gfs-drive__breadcrumb"
                  color="neutral"
                  disabled={index === crumbs.length - 1}
                  onClick={() => setCrumbs(prev => prev.slice(0, index + 1))}
                  variant="text"
                >
                  {crumb.name}
                </Button>
              </span>
            ))}
          </nav>
          {error ? <StatusBanner tone="error" text={error} /> : null}
          {listError ? <StatusBanner tone="error" text={listError} /> : null}
          <div className="da-gfs-move-dialog__list" role="list">
            {loading && folders.length === 0 ? (
              <p className="muted">Loading folders…</p>
            ) : folders.length === 0 && !hasMoreDestinations ? (
              <p className="muted">No folders here.</p>
            ) : (
              <>
                {folders.map(folder => (
                  <div className="da-gfs-move-dialog__row" role="listitem" key={folder.resourceId}>
                    <span className="da-gfs-move-dialog__row-icon" aria-hidden="true">
                      <IconContexts />
                    </span>
                    <Button align="start" block onClick={() => enterFolder(folder)} variant="text">
                      {folder.name}
                    </Button>
                  </div>
                ))}
                {hasMoreDestinations ? (
                  <div className="da-gfs-move-dialog__more">
                    <Button
                      loading={loadingMoreDestinations}
                      onClick={() => void activeQuery.fetchNextPage()}
                      size="sm"
                      variant="outline"
                    >
                      Load more
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </div>
          <div className="da-gfs-move-dialog__actions">
            <Button onClick={onClose} type="button" variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={current === null || pathPassesThroughTarget}
              loading={busy}
              onClick={() => void commit()}
              type="button"
            >
              Move here{current ? ` (${current.name})` : ''}
            </Button>
          </div>
          {pathPassesThroughTarget ? (
            <p className="muted">A folder can’t be moved into its own subtree.</p>
          ) : null}
        </div>
      </section>
    </div>
  )
}
