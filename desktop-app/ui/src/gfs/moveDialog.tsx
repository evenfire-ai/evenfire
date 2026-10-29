import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { Button, IconButton, StatusBanner } from '@components/Common'
import { IconCheck, IconChevronRight, IconClose, IconContexts } from '@components/SidebarNav/icons'
import { GFS_DRIVE_MAIN } from '@constants/gfsBrowser'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import type { GfsBrowserChild } from '@hooks/domain/useGfsBrowserController'
import { describeGfsReadError } from '@lib/gfsGrantErrors'
import { isGfsChildrenDenied, purgeDeniedGfsChildren } from './deniedChildren'
import type { GfsMoveDialogProps, GfsNumberedNameConsent } from './moveDialog.types'

type SelectedDestination = Pick<GfsBrowserChild, 'resourceId' | 'name'>

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
  const queryClient = useQueryClient()
  const isExpanded = expandedFolderIds.has(folder.resourceId)
  const childQueryKey = desktopQueryKeys.gfsChildren(scope, folder.resourceId, GFS_DRIVE_MAIN)
  const childQuery = useInfiniteQuery({
    queryKey: childQueryKey,
    queryFn: ({ pageParam }) =>
      window.clerum.gfs.listChildren(folder.resourceId, GFS_DRIVE_MAIN, pageParam),
    enabled: isExpanded,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
  })
  const childDenied = isGfsChildrenDenied(childQuery.error, childQuery.data)
  const childError = childDenied
    ? 'This folder is no longer available.'
    : errorMessage(childQuery.error)
  const childFolders = useMemo(
    () =>
      childDenied
        ? []
        : folderItems(
            (childQuery.data?.pages ?? []).flatMap(page => page.items),
            new Set([targetResourceId, ...ancestors])
          ),
    [ancestors, childDenied, childQuery.data, targetResourceId]
  )

  useEffect(() => {
    if (childQuery.error) purgeDeniedGfsChildren(queryClient, childQueryKey, childQuery.error)
    if (childError) onAuthorityFailure?.(childError)
  }, [childError, childQuery.error, childQueryKey, onAuthorityFailure, queryClient])

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
  onMoveWithOwnership,
  onRetryPermissionCheck,
  onClose,
  busy = false,
  permissionStatus = null,
  onAuthorityFailure,
}: GfsMoveDialogProps) {
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
  const scope = sessionScope ?? 'anonymous'
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(
    () => new Set(initialCrumbs.map(crumb => crumb.resourceId))
  )
  const [selectedDestination, setSelectedDestination] = useState<SelectedDestination | null>(
    // Never preselect the target's own folder — in every entry path the last
    // crumb IS the current parent, so the old preselect only ever armed the
    // no-op move described above.
    () =>
      initialDestination &&
      initialDestination.resourceId !== target.resourceId &&
      initialDestination.resourceId !== currentParentId
        ? { resourceId: initialDestination.resourceId, name: initialDestination.name }
        : null
  )
  const [error, setError] = useState<string | null>(null)
  const [permissionCheckSucceeded, setPermissionCheckSucceeded] = useState(false)
  const [numberedNameProposal, setNumberedNameProposal] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const numberedNameConsentRef = useRef<((accepted: boolean) => void) | null>(null)
  const selectedDestinationRef = useRef(selectedDestination)
  selectedDestinationRef.current = selectedDestination
  const dialogIdentity = {
    scope,
    resourceId: target.resourceId,
    name: target.name,
    kind: target.kind,
  }
  const dialogIdentityRef = useRef(dialogIdentity)
  const previousDialogIdentityRef = useRef(dialogIdentity)
  dialogIdentityRef.current = dialogIdentity
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      numberedNameConsentRef.current?.(false)
      numberedNameConsentRef.current = null
    }
  }, [])
  const settleNumberedNameConsent = useCallback((accepted: boolean) => {
    const resolve = numberedNameConsentRef.current
    numberedNameConsentRef.current = null
    setNumberedNameProposal(null)
    resolve?.(accepted)
  }, [])
  const closeDialog = () => {
    settleNumberedNameConsent(false)
    onClose()
  }
  useEffect(() => {
    const previousIdentity = previousDialogIdentityRef.current
    const currentIdentity = dialogIdentityRef.current
    if (
      previousIdentity.scope !== currentIdentity.scope ||
      previousIdentity.resourceId !== currentIdentity.resourceId ||
      previousIdentity.name !== currentIdentity.name ||
      previousIdentity.kind !== currentIdentity.kind
    ) {
      settleNumberedNameConsent(false)
    }
    previousDialogIdentityRef.current = currentIdentity
  }, [scope, target.kind, target.name, target.resourceId, settleNumberedNameConsent])
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
    settleNumberedNameConsent(false)
    setError(null)
    setPermissionCheckSucceeded(false)
    setSelectedDestination({ resourceId: folder.resourceId, name: folder.name })
    setExpandedFolderIds(previous => {
      if (previous.has(folder.resourceId)) return previous
      return new Set(previous).add(folder.resourceId)
    })
  }

  const isCurrentDestination = (destination: SelectedDestination) => {
    const expectedIdentity = dialogIdentityRef.current
    return () => {
      const currentIdentity = dialogIdentityRef.current
      return (
        mountedRef.current &&
        selectedDestinationRef.current?.resourceId === destination.resourceId &&
        selectedDestinationRef.current.name === destination.name &&
        currentIdentity.scope === expectedIdentity.scope &&
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
    <div
      className="da-gfs-manage-modal"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) closeDialog()
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
            <h3>Move “{target.name}”</h3>
          </span>
          <span className="da-gfs-manage-dialog__top-actions">
            <IconButton label="Close move dialog" onClick={closeDialog} size="sm" variant="ghost">
              <IconClose />
            </IconButton>
          </span>
        </header>
        <div className="da-gfs-manage-dialog__body">
          {permissionStatus === 'checking' ? (
            <p className="muted" role="status">
              Checking permissions…
            </p>
          ) : null}
          {error ? <StatusBanner tone="error" text={error} /> : null}
          {permissionCheckSucceeded ? (
            <p className="muted" role="status">
              Permissions verified. Select Move to confirm.
            </p>
          ) : null}
          {permissionStatus === 'failed' ? (
            <Button
              disabled={busy || !selectedDestination}
              onClick={() => void retryPermissionCheck()}
              size="sm"
              variant="outline"
            >
              Retry permission check
            </Button>
          ) : null}
          {numberedNameProposal ? (
            <div
              aria-label="Confirm numbered name for Move"
              className="da-gfs-move-dialog__numbered-name-consent"
              role="group"
            >
              <p role="status">
                This name already exists in {selectedDestination?.name}. Move it as{' '}
                <strong>{numberedNameProposal}</strong>?
              </p>
              <div className="da-gfs-move-dialog__action-buttons">
                <Button onClick={() => settleNumberedNameConsent(true)} type="button">
                  Move as {numberedNameProposal}
                </Button>
                <Button
                  onClick={() => settleNumberedNameConsent(false)}
                  type="button"
                  variant="outline"
                >
                  Keep current name
                </Button>
              </div>
            </div>
          ) : null}
          {listError ? <StatusBanner tone="error" text={listError} /> : null}
          <div className="da-gfs-move-dialog__current-location">
            <span>Current location:</span>
            <span className="da-gfs-move-dialog__location-pill">
              <IconContexts />
              <strong>
                {currentParentName ??
                  (currentParentId ? 'another shared folder' : 'Shared with me')}
              </strong>
            </span>
          </div>
          <div className="da-gfs-move-dialog__tree-heading">
            <span className="da-gfs-move-dialog__tree-heading-copy">
              <strong>Shared with me</strong>
            </span>
          </div>
          <div
            className="da-gfs-move-dialog__tree"
            role="tree"
            aria-label="EvenDrive destination folders"
          >
            {loadingRoots ? (
              <p className="muted" role="status">
                Loading folders…
              </p>
            ) : rootFolders.length === 0 && !accessibleQuery.hasNextPage ? (
              // A refused listing is not an absence of folders. The banner
              // above already states the failure, so this only has to stop
              // contradicting it — asserting "no folders" next to an error the
              // user is reading is how a 429 ends up looking like an empty
              // library.
              <p className="muted">
                {listError ? 'Destinations could not be listed.' : 'No folders here.'}
              </p>
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
              <Button onClick={closeDialog} type="button" variant="ghost">
                Cancel
              </Button>
              <Button
                aria-label={
                  selectedDestination ? `Move here (${selectedDestination.name})` : 'Move'
                }
                disabled={
                  busy ||
                  numberedNameProposal !== null ||
                  !selectedDestination ||
                  pathPassesThroughTarget ||
                  isNoOpDestination
                }
                loading={busy}
                onClick={() => void commit()}
                type="button"
              >
                Move
              </Button>
            </span>
          </div>
          {pathPassesThroughTarget ? (
            <p className="muted">A folder can’t be moved into its own subtree.</p>
          ) : null}
          {isNoOpDestination ? (
            <p className="muted">
              {target.name} is already in {currentParentName ?? 'the folder you selected'} — pick a
              different destination.
            </p>
          ) : null}
        </div>
      </section>
    </div>
  )
}
