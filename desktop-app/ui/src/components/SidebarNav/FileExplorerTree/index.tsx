import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Button, IconButton, StatusBanner } from '@components/Common'
import { GfsFileIcon } from '@components/GfsFileIcon'
import { GFS_DRIVE_MAIN } from '@constants/gfsBrowser'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import {
  type GfsBrowserChild,
  useGfsBrowserController,
} from '@hooks/domain/useGfsBrowserController'
import { saveGfsFileToDisk } from '@lib/gfsDownload'
import { resolveGfsPreview } from '@lib/gfsPreview'
import { sanitizeAppTabTitle } from '@lib/sanitizeAppTabTitle'
import { IconChevronRight, IconContexts } from '../icons'
import type { FileExplorerNodeProps, FileExplorerTreeProps } from './types'

// Single-click must not act before we know a double-click is not coming
// (spec 18 §3.A.4): a single-click's toggle/select is deferred by this window so
// a double-click (open tab / preview) can cancel it first.
const DOUBLE_CLICK_DELAY_MS = 250

function errorMessage(error: unknown): string | null {
  if (!error) return null
  return error instanceof Error ? error.message : String(error)
}

// A GFS name is externally controlled (anyone who can write to a shared drive the
// viewer sees), so it must not reach the sidebar chrome raw: bidi overrides can
// disguise an extension, zero-width code points spoof a trusted file, control
// chars corrupt the tree. Clean it with the same sanitizer the workspace-tab
// titles use, before it lands in a visible label, an accessible name, or a toast.
// The raw name is still used for the real on-disk download and for the icon's
// extension parsing — neither is a display surface.
function displayName(name: string): string {
  return sanitizeAppTabTitle(name) || 'Unnamed'
}

/** Folders first, then files, each alphabetical — the VSCode tree ordering. */
function sortTreeItems(items: GfsBrowserChild[]): GfsBrowserChild[] {
  return [...items].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
    return left.name.localeCompare(right.name)
  })
}

/**
 * One node of the sidebar file explorer. Extracted from `GfsMoveTreeFolder`
 * (recursion, expand `Set`, lazy per-node `gfsChildren` fetch, "Load more",
 * ARIA tree roles) but, unlike the move picker, it lists BOTH folders and files
 * (spec 18 §3.A.1). A single-click toggles a folder / selects a file; opening a
 * tab or a preview is reserved for the double-click / Enter gesture (§3.A.4).
 */
function FileExplorerNode({
  node,
  level,
  scope,
  accessActive,
  expandedIds,
  selectedId,
  onToggle,
  onSelect,
  onActivateFolder,
  onActivateFile,
  onAuthorityFailure,
}: FileExplorerNodeProps) {
  const isDirectory = node.kind === 'directory'
  const isExpanded = isDirectory && expandedIds.has(node.resourceId)
  const isSelected = selectedId === node.resourceId
  const label = displayName(node.name)

  const childQuery = useInfiniteQuery({
    queryKey: desktopQueryKeys.gfsChildren(scope, node.resourceId, GFS_DRIVE_MAIN),
    queryFn: ({ pageParam }) =>
      window.clerum.gfs.listChildren(node.resourceId, GFS_DRIVE_MAIN, pageParam),
    // Gate on live access as the controller's own children query does: a revoked
    // session fetches nothing (the subtree also unmounts as accessibleResources
    // empties, but this keeps the guard robust to future refactors).
    enabled: isExpanded && accessActive,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
  })
  const childError = errorMessage(childQuery.error)
  const childItems = useMemo(
    () => sortTreeItems((childQuery.data?.pages ?? []).flatMap(page => page.items)),
    [childQuery.data]
  )

  useEffect(() => {
    if (childError) onAuthorityFailure(childError)
  }, [childError, onAuthorityFailure])

  // Deferred single-click: cancelled by a double-click within the window.
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearClickTimer = useCallback(() => {
    if (clickTimerRef.current !== null) {
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
  }, [])
  useEffect(() => clearClickTimer, [clearClickTimer])

  const runSingleClick = useCallback(() => {
    if (isDirectory) onToggle(node.resourceId)
    else onSelect(node.resourceId)
  }, [isDirectory, node.resourceId, onSelect, onToggle])

  const runActivate = useCallback(() => {
    if (isDirectory) onActivateFolder(node)
    else onActivateFile(node)
  }, [isDirectory, node, onActivateFile, onActivateFolder])

  const handleRowClick = useCallback(() => {
    clearClickTimer()
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null
      runSingleClick()
    }, DOUBLE_CLICK_DELAY_MS)
  }, [clearClickTimer, runSingleClick])

  const handleRowDoubleClick = useCallback(() => {
    clearClickTimer()
    runActivate()
  }, [clearClickTimer, runActivate])

  const handleRowKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== 'Enter') return
      // Stop the native button click Enter would otherwise fire (which would run
      // the single-click action); Enter activates, matching double-click.
      event.preventDefault()
      clearClickTimer()
      runActivate()
    },
    [clearClickTimer, runActivate]
  )

  const loadingChildren = Boolean(isExpanded && childQuery.isFetching && !childQuery.data)
  const hasMoreChildren = Boolean(childQuery.hasNextPage)

  return (
    <div
      aria-expanded={isDirectory ? isExpanded : undefined}
      aria-level={level}
      aria-selected={isSelected}
      className="da-file-explorer__item"
      role="treeitem"
    >
      <div className="da-file-explorer__row">
        {isDirectory ? (
          <IconButton
            aria-expanded={isExpanded}
            className={`da-file-explorer__toggle${isExpanded ? ' is-expanded' : ''}`}
            label={`${isExpanded ? 'Collapse' : 'Expand'} ${label}`}
            onClick={() => onToggle(node.resourceId)}
            size="sm"
            variant="ghost"
          >
            <IconChevronRight />
          </IconButton>
        ) : (
          <span className="da-file-explorer__toggle-placeholder" aria-hidden="true" />
        )}
        <Button
          align="start"
          block
          className={`da-file-explorer__label${isSelected ? ' is-selected' : ''}`}
          color="neutral"
          onClick={handleRowClick}
          onDoubleClick={handleRowDoubleClick}
          onKeyDown={handleRowKeyDown}
          variant="text"
        >
          <span className="da-file-explorer__icon" aria-hidden="true">
            {isDirectory ? <IconContexts /> : <GfsFileIcon name={node.name} />}
          </span>
          <span className="da-file-explorer__name">{label}</span>
        </Button>
      </div>
      {isExpanded ? (
        <div className="da-file-explorer__group" role="group">
          {loadingChildren ? (
            <p className="da-file-explorer__message muted" role="status">
              Loading…
            </p>
          ) : null}
          {childError ? <StatusBanner tone="error" text={childError} compact /> : null}
          {childItems.map(child => (
            <FileExplorerNode
              accessActive={accessActive}
              expandedIds={expandedIds}
              key={child.resourceId}
              level={level + 1}
              node={child}
              onActivateFile={onActivateFile}
              onActivateFolder={onActivateFolder}
              onAuthorityFailure={onAuthorityFailure}
              onSelect={onSelect}
              onToggle={onToggle}
              scope={scope}
              selectedId={selectedId}
            />
          ))}
          {hasMoreChildren ? (
            <div className="da-file-explorer__more">
              <Button
                loading={childQuery.isFetchingNextPage}
                onClick={() => void childQuery.fetchNextPage()}
                size="xs"
                variant="text"
              >
                Load more
              </Button>
            </div>
          ) : null}
          {!loadingChildren && !childError && childItems.length === 0 && !hasMoreChildren ? (
            <p className="da-file-explorer__message muted">Empty folder.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Sidebar file explorer (spec 18 §3.A). The forest root (level 0) is the
 * "Shared with me" collection — `accessibleResources`, the same source as the
 * Files page's root view — not a single filesystem root (§3.A.2); every
 * container is collapsible at any level. Its own `useGfsBrowserController`
 * instance shares the Files page's TanStack cache by query key, so folders the
 * page already warmed render instantly and the discovery authority/fail-closed
 * boundary is reused.
 */
export function FileExplorerTree({
  onOpenFolder,
  onOpenPreview,
  pushToast,
}: FileExplorerTreeProps) {
  const ctrl = useGfsBrowserController()
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const roots = useMemo(() => sortTreeItems(ctrl.accessibleResources), [ctrl.accessibleResources])

  const handleToggle = useCallback((resourceId: string) => {
    setExpandedIds(previous => {
      const next = new Set(previous)
      if (next.has(resourceId)) next.delete(resourceId)
      else next.add(resourceId)
      return next
    })
  }, [])

  const handleSelect = useCallback((resourceId: string) => {
    setSelectedId(resourceId)
  }, [])

  const handleActivateFolder = useCallback(
    (node: GfsBrowserChild) => {
      onOpenFolder(node.gfsUri)
    },
    [onOpenFolder]
  )

  const authorityFailure = ctrl.handleAuthorityFailure
  const handleAuthorityFailure = useCallback(
    (message: string) => {
      authorityFailure(message, 'operation')
    },
    [authorityFailure]
  )

  const handleActivateFile = useCallback(
    (node: GfsBrowserChild) => {
      setSelectedId(node.resourceId)
      const preview = resolveGfsPreview(node)
      if (preview) {
        onOpenPreview(preview)
        return
      }
      void (async () => {
        try {
          // The raw name is the real on-disk filename; the toast shows the cleaned one.
          await saveGfsFileToDisk(node.gfsUri, node.name)
          pushToast(`Downloaded ${displayName(node.name)}`, 'success')
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (authorityFailure(message, 'operation')) return
          pushToast(message, 'error')
        }
      })()
    },
    [authorityFailure, onOpenPreview, pushToast]
  )

  return (
    <div className="da-file-explorer">
      {ctrl.accessibleNotice ? (
        <p className="da-file-explorer__message muted">{ctrl.accessibleNotice}</p>
      ) : ctrl.accessibleError ? (
        <StatusBanner tone="error" text={ctrl.accessibleError} compact />
      ) : ctrl.loadingAccessible && roots.length === 0 ? (
        <p className="da-file-explorer__message muted" role="status">
          Loading files…
        </p>
      ) : roots.length === 0 && !ctrl.hasMoreAccessible ? (
        <p className="da-file-explorer__message muted">No shared files yet.</p>
      ) : (
        <div className="da-file-explorer__tree" role="tree" aria-label="Shared files">
          {roots.map(node => (
            <FileExplorerNode
              accessActive={ctrl.accessState === 'active'}
              expandedIds={expandedIds}
              key={node.resourceId}
              level={1}
              node={node}
              onActivateFile={handleActivateFile}
              onActivateFolder={handleActivateFolder}
              onAuthorityFailure={handleAuthorityFailure}
              onSelect={handleSelect}
              onToggle={handleToggle}
              scope={ctrl.sessionScope}
              selectedId={selectedId}
            />
          ))}
          {ctrl.hasMoreAccessible ? (
            <div className="da-file-explorer__more">
              <Button
                loading={ctrl.isFetchingMoreAccessible}
                onClick={() => ctrl.loadMoreAccessible()}
                size="xs"
                variant="text"
              >
                Load more
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
