import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { Badge, Button, IconButton, StatusBanner } from '@components/Common'
import { GfsFileIcon } from '@components/GfsFileIcon'
import { GfsResourceMenu } from '@components/GfsResourceMenu'
import {
  FOLDER_HOVER_EXPAND_DELAY_MS,
  GFS_DRIVE_MAIN,
  GFS_RESOURCE_DRAG_TYPE,
} from '@constants/gfsBrowser'
import {
  desktopQueryKeys,
  isGfsSessionAuthorityCurrent,
  isGfsSessionGeneration,
} from '@hooks/domain/queryKeys'
import {
  type GfsBrowserAffordances,
  type GfsBrowserChild,
  type GfsCrumb,
  useGfsBrowserController,
} from '@hooks/domain/useGfsBrowserController'
import { assertGfsAuthorityRetryAllowed } from '@lib/gfsAuthorityQueryPolicy'
import { saveGfsFileToDisk } from '@lib/gfsDownload'
import { parseHttpStatus } from '@lib/gfsGrantErrors'
import { hasGfsMoveSourcePermissions } from '@lib/gfsMovePermissions'
import { resolveGfsPreview } from '@lib/gfsPreview'
import { buildGfsResourceActions, getGfsMenuActions } from '@lib/gfsResourceActions'
import { sanitizeAppTabTitle } from '@lib/sanitizeAppTabTitle'
import { isGfsChildrenDenied, purgeDeniedGfsChildren } from '@/gfs/deniedChildren'
import { useGfsDragAdjudication } from '@/gfs/dragAdjudication'
import { ownsGfsDrop } from '@/gfs/dragOwnership'
import type { GfsDragSource, GfsDropVerdict } from '@/gfs/dragSession'
import { useGfsDragSession } from '@/gfs/dragSession'
import {
  GFS_DROP_SESSION_LOST_MESSAGE,
  gfsDropVerdictLiveAnnouncement,
  gfsDropVerdictReason,
  mayPaintGfsSessionLostBanner,
  presentGfsDropRefusal,
  sameGfsDropVerdict,
} from '@/gfs/dropVerdict'
import { toastMoveOutcome } from '@/gfs/moveCommit'
import { runGfsMoveCommit } from '@/gfs/moveCommitRunner'
import { GfsMoveConfirmDialog } from '@/gfs/moveConfirmDialog'
import { GfsMoveDialog } from '@/gfs/moveDialog'
import { IconChevronRight, IconContexts } from '../icons'
import type { FileExplorerNodeProps, FileExplorerTreeProps } from './types'

// A folder's single-click (toggle) must not act before we know a double-click
// (open its files tab) is not coming, so it is deferred by this window to let a
// double-click cancel it first. Files have no such ambiguity — a single-click
// activates them immediately — so this delay applies to folders only.
const DOUBLE_CLICK_DELAY_MS = 250

function errorMessage(error: unknown): string | null {
  if (!error) return null
  return error instanceof Error ? error.message : String(error)
}

function hasBit(affordances: GfsBrowserAffordances | undefined, bit: string): boolean {
  return Boolean(affordances?.held.includes(bit))
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
 * ARIA tree roles) but, unlike the move picker, it lists BOTH folders and files.
 * Gestures differ by kind: a file activates on single-click (open its preview,
 * or download when it is not previewable); a folder toggles expand/collapse on
 * single-click and opens its files tab on double-click. Enter activates either.
 * Files AND folders are draggable (rev-2 D1); directory rows are move targets,
 * and a hover-dwelling collapsed folder expands through its existing loader.
 */
function FileExplorerNode({
  node,
  level,
  scope,
  sessionGeneration,
  accessActive,
  expandedIds,
  selectedId,
  movingResourceId,
  ancestorIds,
  ancestorCrumbs,
  dropState,
  dropStatesByResourceId,
  dragSourceName,
  onToggle,
  onActivateFolder,
  onActivateFile,
  onResourceAction,
  onAuthorityFailure,
  onNodeDragStart,
  onNodeDragEnd,
  onNodeDragOver,
  onNodeDragLeave,
  onNodeDrop,
  onRequestMove,
}: FileExplorerNodeProps) {
  const queryClient = useQueryClient()
  const isDirectory = node.kind === 'directory'
  const isExpanded = isDirectory && expandedIds.has(node.resourceId)
  const isSelected = selectedId === node.resourceId
  const label = displayName(node.name)
  const [resourceMenuOpen, setResourceMenuOpen] = useState(false)
  // Server-computed: the row is visible but the session cannot read it (a
  // folder grant without inheritance; a file whose parent does not inherit).
  // Mark it so it does not look actionable, and let the activate handlers
  // refuse it with a toast instead of a later download/preview 403. Absent
  // (older servers) is treated as unknown, not unreadable.
  const isUnreadable = node.readable === false

  const affordancesQuery = useQuery({
    queryKey: desktopQueryKeys.gfsAffordances(
      scope,
      node.resourceId,
      node.drive,
      sessionGeneration
    ),
    queryFn: () => window.clerum.gfs.affordances(node.resourceId, node.drive),
    enabled: resourceMenuOpen && accessActive && isGfsSessionGeneration(sessionGeneration),
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    staleTime: 0,
  })
  // Do not expose permission-gated operations from cached bits while a fresh
  // menu-open/focus revalidation is in flight or after it fails. Move remains
  // available because its authority is parent-relative and enforced by server.
  const affordances =
    affordancesQuery.isFetching || affordancesQuery.error ? undefined : affordancesQuery.data
  useEffect(() => {
    if (!affordancesQuery.error) return
    if (isGfsSessionGeneration(sessionGeneration)) {
      onAuthorityFailure(affordancesQuery.error, scope, sessionGeneration)
    }
  }, [affordancesQuery.error, onAuthorityFailure, scope, sessionGeneration])
  const preview = useMemo(() => resolveGfsPreview(node), [node])
  const canPreview = Boolean(preview && !isUnreadable)
  const canCopyContent = Boolean(
    canPreview && (preview?.kind === 'image' || preview?.kind === 'markdown')
  )
  const resourceActions = useMemo(
    () =>
      getGfsMenuActions(
        buildGfsResourceActions({
          kind: node.kind,
          uri: node.gfsUri,
          handlers: {
            refresh:
              accessActive && !isUnreadable ? () => onResourceAction(node, 'refresh') : undefined,
            'copy-link': () => onResourceAction(node, 'copy-link'),
            'copy-route': () => onResourceAction(node, 'copy-route'),
            'open-route': () => onResourceAction(node, 'open-route'),
            rename: () => onResourceAction(node, 'rename'),
            move: () => onResourceAction(node, 'move'),
            'new-folder': () => onResourceAction(node, 'new-folder'),
            'upload-file': () => onResourceAction(node, 'upload-file'),
            share: () => onResourceAction(node, 'share'),
            'copy-content': canCopyContent
              ? () => onResourceAction(node, 'copy-content')
              : undefined,
            preview: canPreview ? () => onActivateFile(node) : undefined,
            download:
              node.kind === 'file' && !isUnreadable
                ? () => onResourceAction(node, 'download')
                : undefined,
            replace:
              node.kind === 'file' && hasBit(affordances, 'write')
                ? (file, context) => {
                    if (file) onResourceAction(node, 'replace', file)
                    else context?.requestFileSelection?.()
                  }
                : undefined,
            'open-folder': isDirectory && !isUnreadable ? () => onActivateFolder(node) : undefined,
            delete: () => onResourceAction(node, 'delete'),
          },
          canRename: hasBit(affordances, 'write'),
          canMove: accessActive && node.parentResourceId != null,
          canCreateFolder: isDirectory && hasBit(affordances, 'write'),
          canUpload: isDirectory && hasBit(affordances, 'write'),
          canShare: hasBit(affordances, 'manage_acl'),
          canCopyContent,
          canPreview,
          canDownload: node.kind === 'file' && !isUnreadable,
          canReplace: node.kind === 'file' && hasBit(affordances, 'write'),
          canOpenFolder: isDirectory && !isUnreadable,
          canDelete: hasBit(affordances, 'delete'),
        })
      ),
    [
      accessActive,
      affordances,
      canCopyContent,
      canPreview,
      isDirectory,
      isUnreadable,
      node,
      onActivateFile,
      onActivateFolder,
      onResourceAction,
    ]
  )

  const childQueryKey = desktopQueryKeys.gfsChildren(
    scope,
    node.resourceId,
    GFS_DRIVE_MAIN,
    sessionGeneration
  )
  const childQuery = useInfiniteQuery({
    queryKey: childQueryKey,
    queryFn: ({ pageParam }) =>
      window.clerum.gfs.listChildren(node.resourceId, GFS_DRIVE_MAIN, pageParam),
    // Gate on live access as the controller's own children query does: a revoked
    // session fetches nothing (the subtree also unmounts as accessibleResources
    // empties, but this keeps the guard robust to future refactors).
    enabled: isExpanded && accessActive && isGfsSessionGeneration(sessionGeneration),
    // Folder contents change out-of-band: agents with host grants, other
    // sessions, and operator writes never pass through this client. The sidebar
    // is a persistent surface, so under the app's Infinity staleTime an expanded
    // folder would otherwise serve its first page forever — removed files linger
    // and new files never appear until a hard reload. Revalidate on revisit and
    // window focus, matching the controller's own children query.
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
  })
  const childDenied = isGfsChildrenDenied(childQuery.error, childQuery.data)
  const childErrorMessage = errorMessage(childQuery.error)
  const childHttpStatus = childErrorMessage ? parseHttpStatus(childErrorMessage) : null
  const childError = childDenied
    ? 'This folder is no longer available.'
    : childHttpStatus !== null
      ? 'Unable to load folder contents.'
      : childErrorMessage
  const childItems = useMemo(
    () =>
      childDenied ? [] : sortTreeItems((childQuery.data?.pages ?? []).flatMap(page => page.items)),
    [childDenied, childQuery.data]
  )

  useEffect(() => {
    if (!childQuery.error || !isGfsSessionGeneration(sessionGeneration)) return
    purgeDeniedGfsChildren(queryClient, childQueryKey, childQuery.error)
    if (childError) onAuthorityFailure(childQuery.error, scope, sessionGeneration)
  }, [
    childError,
    childQuery.error,
    childQueryKey,
    onAuthorityFailure,
    queryClient,
    scope,
    sessionGeneration,
  ])

  // Deferred folder toggle: cancelled by a double-click within the window.
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearClickTimer = useCallback(() => {
    if (clickTimerRef.current !== null) {
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
  }, [])
  useEffect(() => clearClickTimer, [clearClickTimer])

  const runActivate = useCallback(() => {
    if (isDirectory) onActivateFolder(node)
    else onActivateFile(node)
  }, [isDirectory, node, onActivateFile, onActivateFolder])

  const handleRowClick = useCallback(() => {
    clearClickTimer()
    // A file has no single/double-click ambiguity: single-click activates it
    // (open preview, or download when not previewable) immediately — no delay.
    // A double-click on a file just re-activates it idempotently. onActivateFile
    // also selects the node, so selection still follows a file's single-click.
    if (!isDirectory) {
      runActivate()
      return
    }
    // A folder's single-click toggles expand/collapse, but that is deferred so a
    // double-click (open its files tab) can cancel the toggle first.
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null
      onToggle(node.resourceId)
    }, DOUBLE_CLICK_DELAY_MS)
  }, [clearClickTimer, isDirectory, node.resourceId, onToggle, runActivate])

  const handleRowDoubleClick = useCallback(() => {
    clearClickTimer()
    runActivate()
  }, [clearClickTimer, runActivate])

  const handleRowKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'Enter') {
        // Stop the native button click Enter would otherwise fire (which would run
        // the row's single-click handler — a folder's deferred toggle); Enter
        // activates instead, matching the folder double-click / file single-click.
        event.preventDefault()
        clearClickTimer()
        runActivate()
        return
      }
      // Shift+F10 opens the Move dialog for the focused row — the keyboard
      // path after the visible per-row Move button was rejected as clutter.
      if (event.shiftKey && event.key === 'F10') {
        event.preventDefault()
        clearClickTimer()
        onRequestMove(node, ancestorCrumbs)
      }
    },
    [ancestorCrumbs, clearClickTimer, node, onRequestMove, runActivate]
  )

  const handleDragStart = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      // A drag must not fire the deferred folder toggle after release.
      clearClickTimer()
      onNodeDragStart(node, event, ancestorIds)
    },
    [ancestorIds, clearClickTimer, node, onNodeDragStart]
  )

  const isDirectoryRow = isDirectory
  const canDrag = isUnreadable !== true && movingResourceId == null

  // Hover a collapsed directory for FOLDER_HOVER_EXPAND_DELAY_MS to expand it
  // through its existing loader (rev-2 §4.1). The timer is owned here so a
  // leave/drop/drag-end in this row cancels exactly its own expansion.
  const hoverExpandTimerRef = useRef<number | null>(null)
  const clearHoverExpand = useCallback(() => {
    if (hoverExpandTimerRef.current !== null) {
      clearTimeout(hoverExpandTimerRef.current)
      hoverExpandTimerRef.current = null
    }
  }, [])
  useEffect(() => clearHoverExpand, [clearHoverExpand])

  const handleRowDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      // Nested rows live in the sibling `.da-file-explorer__group`, so a child
      // drop cannot bubble through an ancestor ROW — verify the closest marked
      // row still matches before adjudicating (rev-2 §4.1).
      if (event.target instanceof Element) {
        const closestRow = event.target.closest('.da-file-explorer__row')
        if (closestRow !== null && closestRow !== event.currentTarget) return
      }
      onNodeDragOver(node, event, ancestorIds)
    },
    [ancestorIds, node, onNodeDragOver]
  )

  const handleRowDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (event.target instanceof Element) {
        const closestRow = event.target.closest('.da-file-explorer__row')
        if (closestRow !== null && closestRow !== event.currentTarget) return
      }
      // The drop ends the gesture; the browser does not necessarily fire a
      // dragleave afterwards, so this row's OWN hover-expand timer would still
      // fire and expand a folder the user never asked to open (RP-024).
      clearHoverExpand()
      onNodeDrop(node, event, ancestorIds)
    },
    [ancestorIds, clearHoverExpand, node, onNodeDrop]
  )

  const handleRowDragEnterOrOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      handleRowDragOver(event)
      const hoverState = dropState?.state
      if (
        isDirectoryRow &&
        !isExpanded &&
        (hoverState === undefined || hoverState === 'allowed' || hoverState === 'checking')
      ) {
        if (hoverExpandTimerRef.current === null) {
          hoverExpandTimerRef.current = window.setTimeout(() => {
            hoverExpandTimerRef.current = null
            onToggle(node.resourceId)
          }, FOLDER_HOVER_EXPAND_DELAY_MS)
        }
      }
    },
    [dropState, handleRowDragOver, isDirectoryRow, isExpanded, node.resourceId, onToggle]
  )

  const handleRowDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
      clearHoverExpand()
      onNodeDragLeave(node, event)
    },
    [clearHoverExpand, node, onNodeDragLeave]
  )

  const loadingChildren = Boolean(isExpanded && childQuery.isFetching && !childQuery.data)
  const hasMoreChildren = Boolean(childQuery.hasNextPage)
  const nextAncestorIds = useMemo(
    () => [node.resourceId, ...ancestorIds],
    [ancestorIds, node.resourceId]
  )
  const nextAncestorCrumbs = useMemo<GfsCrumb[]>(
    () => [
      ...ancestorCrumbs,
      {
        resourceId: node.resourceId,
        gfsUri: node.gfsUri,
        name: node.name,
        kind: 'directory',
        version: node.version,
        bytes: node.bytes,
      },
    ],
    [ancestorCrumbs, node]
  )

  const dropStateName = isDirectory ? dropState?.state : undefined
  const dropReason = isDirectory ? gfsDropVerdictReason(dropState) : undefined
  // The deny/no-op/unknown tint carries no reason of its own; the tooltip
  // speaks the full sentence for it (one wording per reason, every surface).
  const dropReasonTooltip =
    dropState && dropReason !== undefined
      ? gfsDropVerdictLiveAnnouncement(dropState, node.name, dragSourceName ?? undefined)
      : undefined

  return (
    <div
      aria-expanded={isDirectory ? isExpanded : undefined}
      aria-level={level}
      aria-selected={isSelected}
      className="da-file-explorer__item"
      role="treeitem"
    >
      <div
        className={`da-file-explorer__row${dropStateName ? ` is-drop-${dropStateName}` : ''}`}
        data-drop-state={dropStateName}
        data-drop-reason={dropReason}
        title={dropReasonTooltip}
        onDragEnter={isDirectory ? handleRowDragEnterOrOver : undefined}
        onDragOver={isDirectory ? handleRowDragEnterOrOver : undefined}
        onDragLeave={isDirectory ? handleRowDragLeave : undefined}
        onDrop={isDirectory ? handleRowDrop : undefined}
      >
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
          className={`da-file-explorer__label${isSelected ? ' is-selected' : ''}${
            isUnreadable ? ' da-file-explorer__label--no-access' : ''
          }`}
          color="neutral"
          draggable={canDrag}
          onClick={handleRowClick}
          onDoubleClick={handleRowDoubleClick}
          onDragStart={canDrag ? handleDragStart : undefined}
          onDragEnd={canDrag ? onNodeDragEnd : undefined}
          onKeyDown={handleRowKeyDown}
          title={canDrag ? `Drag ${label} into a folder to move it` : undefined}
          variant="text"
        >
          <span className="da-file-explorer__icon" aria-hidden="true">
            {isDirectory ? <IconContexts /> : <GfsFileIcon name={node.name} />}
          </span>
          <span className="da-file-explorer__name">{label}</span>
          {/* Rendered inside the label so "No access" joins the row's accessible
              name, matching the Files page's row affordance. */}
          {isUnreadable ? (
            <Badge tone="neutral" className="da-file-explorer__no-access-badge">
              No access
            </Badge>
          ) : null}
        </Button>
        <span className="da-file-explorer__actions">
          <GfsResourceMenu
            actions={resourceActions}
            onOpenChange={setResourceMenuOpen}
            resourceName={label}
          />
        </span>
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
              ancestorCrumbs={nextAncestorCrumbs}
              ancestorIds={nextAncestorIds}
              dragSourceName={dragSourceName}
              dropState={dropStatesByResourceId[child.resourceId]}
              dropStatesByResourceId={dropStatesByResourceId}
              expandedIds={expandedIds}
              key={child.resourceId}
              level={level + 1}
              movingResourceId={movingResourceId}
              node={child}
              onActivateFile={onActivateFile}
              onActivateFolder={onActivateFolder}
              onResourceAction={onResourceAction}
              onAuthorityFailure={onAuthorityFailure}
              onNodeDragEnd={onNodeDragEnd}
              onNodeDragLeave={onNodeDragLeave}
              onNodeDragOver={onNodeDragOver}
              onNodeDragStart={onNodeDragStart}
              onNodeDrop={onNodeDrop}
              onRequestMove={onRequestMove}
              onToggle={onToggle}
              scope={scope}
              sessionGeneration={sessionGeneration}
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
 *
 * Drag-and-drop (rev-2 D1): files AND folders drag from the tree; directory
 * rows are move targets adjudicated by the shared drag session + policy
 * (cross-surface drags from/to the Files page share one active source); a
 * folder drop stops at ONE confirmation; commits run through the same shared
 * move dispatch as the Files page.
 */
export function FileExplorerTree({
  onOpenFolder,
  onOpenPreview,
  onResourceAction,
  pushToast,
}: FileExplorerTreeProps) {
  const ctrl = useGfsBrowserController()
  const queryClient = useQueryClient()
  const dragSession = useGfsDragSession()
  const adjudication = useGfsDragAdjudication({
    scope: ctrl.sessionScope,
    sessionGeneration: ctrl.sessionGeneration,
    drive: GFS_DRIVE_MAIN,
    resolve: (uri: string) => window.clerum.gfs.resolve(uri),
    // A drag probe that answers 401 is a session failure, not a per-item
    // refusal: the drop is refused AND the session revoked.
    handleAuthorityFailure: (message, scope, sessionGeneration) =>
      ctrl.handleAuthorityFailure(message, 'operation', scope, sessionGeneration),
  })
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dropStatesByResourceId, setDropStatesByResourceId] = useState<
    Record<string, GfsDropVerdict>
  >({})
  // The drop verdict is painted on the target row, which assistive technology
  // never announces. The spoken form lives here so the verdict reaches a
  // screen reader as well (RP-026).
  const [dropVerdictAnnouncement, setDropVerdictAnnouncement] = useState('')
  // A drop refused by a dead session must stay visible AFTER the revocation
  // has already invalidated the gesture's ownership (UX matrix A11). The
  // revoked surface below carries the sentence unconditionally; this
  // callback-local banner is gated by the captured scope/session identity so
  // a superseded call cannot paint it over a new, healthy session.
  const [dropSessionLost, setDropSessionLost] = useState(false)
  // Display name of the live gesture's source, for reason copy that names it.
  const [dragSourceName, setDragSourceName] = useState<string | null>(null)
  const [movingResourceId, setMovingResourceId] = useState<string | null>(null)
  const movingResourceIdRef = useRef<string | null>(null)
  const draggingSourceRef = useRef<GfsDragSource | null>(null)
  const hoverOwnerRef = useRef<GfsDragSource | null>(null)
  const dragSessionEpochRef = useRef(0)
  const [pendingFolderMove, setPendingFolderMove] = useState<{
    source: GfsDragSource
    gestureGeneration: number
    sessionGeneration: number | null
    authoritativeSessionGeneration: number
    destination: { resourceId: string; name: string }
  } | null>(null)
  const [moveDialogTarget, setMoveDialogTarget] = useState<{
    node: GfsBrowserChild
    initialCrumbs: GfsCrumb[]
  } | null>(null)
  const moveDialogTargetRef = useRef(moveDialogTarget)
  moveDialogTargetRef.current = moveDialogTarget
  const mountedRef = useRef(false)
  const [movePermissionStatus, setMovePermissionStatus] = useState<'checking' | 'failed' | null>(
    null
  )

  const closeMoveDialog = useCallback(() => {
    moveDialogTargetRef.current = null
    setMovePermissionStatus(null)
    setMoveDialogTarget(null)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      dragSessionEpochRef.current += 1
      hoverOwnerRef.current = null
      adjudication.endDragSession()
    }
  }, [adjudication.endDragSession])

  const liveDragScope = ctrl.accessState === 'revoked' ? null : (ctrl.sessionScope ?? 'anonymous')
  const liveDragScopeRef = useRef(liveDragScope)
  liveDragScopeRef.current = liveDragScope
  const liveAuthorityRef = useRef({ scope: ctrl.sessionScope, generation: ctrl.sessionGeneration })
  liveAuthorityRef.current = { scope: ctrl.sessionScope, generation: ctrl.sessionGeneration }
  const previousDragAuthorityRef = useRef({
    scope: liveDragScope,
    generation: ctrl.sessionGeneration,
  })
  useEffect(() => {
    if (
      previousDragAuthorityRef.current.scope === liveDragScope &&
      previousDragAuthorityRef.current.generation === ctrl.sessionGeneration
    ) {
      return
    }
    previousDragAuthorityRef.current = {
      scope: liveDragScope,
      generation: ctrl.sessionGeneration,
    }
    dragSessionEpochRef.current += 1
    draggingSourceRef.current = null
    hoverOwnerRef.current = null
    adjudication.endDragSession()
    setPendingFolderMove(null)
    setDropStatesByResourceId({})
    setDragSourceName(null)
    moveDialogTargetRef.current = null
    setMoveDialogTarget(null)
    setMovePermissionStatus(null)
    // A NEW live session makes any session-ended refusal stale. A transition
    // TO revoked (scope null) must NOT clear it: that is exactly when the
    // message has to survive (A11), and the revoked surface below carries it.
    if (liveDragScope !== null) setDropSessionLost(false)
  }, [adjudication.endDragSession, ctrl.sessionGeneration, liveDragScope])

  const ownsDrop = useCallback(
    (source: GfsDragSource, epoch: number, sharedGeneration: number | null) =>
      ownsGfsDrop(
        source,
        { epoch, sessionGeneration: sharedGeneration },
        {
          epoch: dragSessionEpochRef.current,
          scope: liveDragScopeRef.current,
          sessionGeneration: dragSession?.currentGeneration() ?? null,
        }
      ),
    [dragSession]
  )

  const roots = useMemo(() => sortTreeItems(ctrl.accessibleResources), [ctrl.accessibleResources])

  /** Cached destination names for the numbered-name ladder and suggestion —
   * the same shared children cache the Files page seeds its commit from. */
  const cachedDestinationNames = useCallback(
    (destinationId: string): Set<string> => {
      if (!ctrl.sessionScope || !isGfsSessionGeneration(ctrl.sessionGeneration)) {
        return new Set()
      }
      const cached = queryClient.getQueryData<{ pages?: Array<{ items?: GfsBrowserChild[] }> }>(
        desktopQueryKeys.gfsChildren(
          ctrl.sessionScope,
          destinationId,
          GFS_DRIVE_MAIN,
          ctrl.sessionGeneration
        )
      )
      return new Set(
        (cached?.pages ?? []).flatMap(page => page.items?.map(item => item.name) ?? [])
      )
    },
    [ctrl.sessionScope, ctrl.sessionGeneration, queryClient]
  )

  const handleToggle = useCallback((resourceId: string) => {
    setExpandedIds(previous => {
      const next = new Set(previous)
      if (next.has(resourceId)) next.delete(resourceId)
      else next.add(resourceId)
      return next
    })
  }, [])

  const clearDragState = useCallback(() => {
    // NOTE: deliberately does NOT bump dragSessionEpochRef. The epoch marks
    // GESTURES (dragstart); the drop handler compares its captured epoch after
    // the async drop adjudication. dragend fires ~immediately after drop —
    // bumping here invalidated the drop's OWN commit once adjudication
    // resolved (cache-cold drops lost that race and died silently, so the
    // folder confirmation never appeared). A new dragstart still invalidates
    // in-flight decisions.
    draggingSourceRef.current = null
    hoverOwnerRef.current = null
    dragSession?.endDrag()
    adjudication.endDragSession()
    setDropStatesByResourceId({})
    setDropVerdictAnnouncement('')
    setDragSourceName(null)
  }, [adjudication, dragSession])

  /** Release only the source and hover work owned by the admitted gesture. */
  const finishNodeDropCleanup = useCallback(
    (source: GfsDragSource, epoch: number, sessionGeneration: number | null) => {
      if (epoch !== dragSessionEpochRef.current) return
      draggingSourceRef.current = null
      if (hoverOwnerRef.current === null || hoverOwnerRef.current === source) {
        hoverOwnerRef.current = null
        setDropStatesByResourceId({})
        adjudication.endDragSession()
      }
      if (dragSession && dragSession.currentGeneration() === sessionGeneration) {
        dragSession.endDrag()
      }
    },
    [adjudication, dragSession]
  )

  const treeDragSourceFrom = useCallback(
    (
      node: GfsBrowserChild,
      ancestorIds: readonly (string | null)[]
    ): Omit<GfsDragSource, 'generation'> => {
      // Nested rows observe their loaded parent (nearest ancestor); forest
      // roots only know the parent the accessible payload carried — unknown is
      // never an invented root fact.
      const parentKnown = ancestorIds.length > 0 || node.parentResourceId != null
      const parentResourceId =
        ancestorIds.length > 0 ? (ancestorIds[0] ?? null) : (node.parentResourceId ?? null)
      return {
        resourceId: node.resourceId,
        gfsUri: node.gfsUri,
        drive: node.drive || GFS_DRIVE_MAIN,
        kind: node.kind === 'directory' ? 'directory' : 'file',
        name: node.name,
        ...(Number.isSafeInteger(node.version) ? { version: node.version } : {}),
        parentKnown,
        parentResourceId,
        knownAncestorIds: ancestorIds.filter((id): id is string => id !== null),
        origin: 'sidebar',
        scope: ctrl.sessionScope ?? 'anonymous',
      }
    },
    [ctrl.sessionScope]
  )

  const handleNodeDragStart = useCallback(
    (
      node: GfsBrowserChild,
      event: React.DragEvent<HTMLElement>,
      ancestorIds: readonly (string | null)[]
    ) => {
      if (node.readable === false || movingResourceIdRef.current) {
        event.preventDefault()
        return
      }
      dragSessionEpochRef.current += 1
      const source: GfsDragSource = {
        ...treeDragSourceFrom(node, ancestorIds),
        generation: dragSessionEpochRef.current,
      }
      const { generation: _generation, ...sourceForStore } = source
      if (dragSession && !dragSession.beginDrag(sourceForStore)) {
        // The session refused the gesture (foreign scope or revoked access):
        // never publish a local payload the shared session did not accept.
        event.preventDefault()
        return
      }
      adjudication.beginDragSession()
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData(GFS_RESOURCE_DRAG_TYPE, node.resourceId)
      event.dataTransfer.setData('text/plain', node.name)
      draggingSourceRef.current = source
      setDragSourceName(node.name)
      // A new gesture clears the previous gesture's persistent surfaces.
      setDropSessionLost(false)
    },
    [adjudication, dragSession, treeDragSourceFrom]
  )

  const resolveActiveSource = useCallback((): GfsDragSource | null => {
    if (!dragSession) return draggingSourceRef.current
    const source = dragSession.activeSource()
    return source &&
      dragSession.matchesScope(ctrl.sessionScope ?? 'anonymous') &&
      source.drive === GFS_DRIVE_MAIN
      ? source
      : null
  }, [ctrl.sessionScope, dragSession])

  const handleNodeDragOver = useCallback(
    (
      node: GfsBrowserChild,
      event: React.DragEvent<HTMLElement>,
      ancestorIds: readonly (string | null)[]
    ) => {
      if (!Array.from(event.dataTransfer.types || []).includes(GFS_RESOURCE_DRAG_TYPE)) return
      const source = resolveActiveSource()
      // Self-hover is NO longer skipped: dropping an item onto itself paints
      // the denied verdict with its `self` reason, so the release can explain
      // itself instead of looking dead (UX matrix §5.3). Admission still
      // refuses the mutation.
      if (!source || node.kind !== 'directory') return
      event.preventDefault()
      event.stopPropagation()
      hoverOwnerRef.current = source
      // The gesture may have started on ANOTHER surface (Files ↔ tree): the
      // resolved shared source — not a local dragstart — owns the name the
      // reason copy interpolates.
      setDragSourceName(previous => (previous === source.name ? previous : source.name))
      const verdict = adjudication.hoverVerdict(source, {
        resourceId: node.resourceId,
        name: node.name,
        kind: node.kind,
        ancestorIds,
      })
      setDropStatesByResourceId(previous =>
        sameGfsDropVerdict(previous[node.resourceId], verdict)
          ? previous
          : { ...previous, [node.resourceId]: verdict }
      )
      setDropVerdictAnnouncement(gfsDropVerdictLiveAnnouncement(verdict, node.name, source.name))
      // An OBSERVED deny must stay DELIVERABLE: dropEffect 'none' makes
      // Chromium cancel the drag at release, so the refused drop event never
      // fires and the reason could never be presented (UX matrix §5.3). The
      // tone-keyed row tint carries the denial; the drop-time adjudication
      // still refuses the mutation.
      event.dataTransfer.dropEffect = 'move'
      if (verdict.state === 'checking') {
        adjudication.scheduleColdCheck(
          { resourceId: node.resourceId, name: node.name, kind: node.kind, ancestorIds },
          source.parentKnown ? source.parentResourceId : null,
          () => {
            if (hoverOwnerRef.current !== source) return
            const fresh = adjudication.hoverVerdict(source, {
              resourceId: node.resourceId,
              name: node.name,
              kind: node.kind,
              ancestorIds,
            })
            setDropStatesByResourceId(previous =>
              sameGfsDropVerdict(previous[node.resourceId], fresh)
                ? previous
                : { ...previous, [node.resourceId]: fresh }
            )
            setDropVerdictAnnouncement(
              gfsDropVerdictLiveAnnouncement(fresh, node.name, source.name)
            )
          }
        )
      }
    },
    [adjudication, resolveActiveSource]
  )

  const handleNodeDragLeave = useCallback(
    (node: GfsBrowserChild, event: React.DragEvent<HTMLElement>) => {
      if (!Array.from(event.dataTransfer.types || []).includes(GFS_RESOURCE_DRAG_TYPE)) return
      event.preventDefault()
      event.stopPropagation()
      setDropStatesByResourceId(previous => {
        if (!(node.resourceId in previous)) return previous
        const next = { ...previous }
        delete next[node.resourceId]
        return next
      })
      setDropVerdictAnnouncement('')
    },
    []
  )

  const commitMove = useCallback(
    async (
      source: GfsDragSource,
      destination: { resourceId: string; name: string },
      isCurrent?: () => boolean,
      isPresentationCurrent?: () => boolean,
      reportOutcomes = true,
      authoritativeSessionGeneration?: number
    ) => {
      movingResourceIdRef.current = source.resourceId
      setMovingResourceId(source.resourceId)
      try {
        return await runGfsMoveCommit(
          {
            moveResource: (
              resourceId,
              destinationId,
              ifMatch,
              newName,
              oldParentId,
              expectedSessionGeneration
            ) =>
              ctrl.moveResource(
                resourceId,
                destinationId,
                ifMatch,
                newName,
                oldParentId,
                source.scope,
                true,
                expectedSessionGeneration
              ),
            handleAuthorityFailure: message =>
              ctrl.handleAuthorityFailure(message, 'operation', source.scope),
            convergeCommittedMove: (input, receipt) =>
              ctrl.convergeCommittedMove(input, receipt, source.scope),
            ...(reportOutcomes
              ? {
                  pushToast: (message, tone) => {
                    if (!isPresentationCurrent || isPresentationCurrent()) {
                      pushToast(message, tone)
                    }
                  },
                }
              : {}),
          },
          {
            source,
            destination,
            occupiedDestinationNames: cachedDestinationNames(destination.resourceId),
            ...(authoritativeSessionGeneration !== undefined
              ? { sessionGeneration: authoritativeSessionGeneration }
              : {}),
            ...(isCurrent ? { isCurrent } : {}),
          }
        )
      } finally {
        movingResourceIdRef.current = null
        if (mountedRef.current) setMovingResourceId(null)
      }
    },
    [cachedDestinationNames, ctrl, pushToast]
  )

  const handleNodeDrop = useCallback(
    async (
      node: GfsBrowserChild,
      event: React.DragEvent<HTMLElement>,
      ancestorIds: readonly (string | null)[]
    ) => {
      if (!Array.from(event.dataTransfer.types || []).includes(GFS_RESOURCE_DRAG_TYPE)) return
      event.preventDefault()
      event.stopPropagation()
      setDropStatesByResourceId({})
      setDropVerdictAnnouncement('')
      const source = resolveActiveSource()
      if (!source || node.kind !== 'directory' || movingResourceIdRef.current) return
      const epoch = dragSessionEpochRef.current
      const sessionGeneration = dragSession?.currentGeneration() ?? null
      const scopeAtDrop = liveDragScopeRef.current
      const publishedGeneration = ctrl.sessionGeneration
      const ownsPublishedAuthority = () =>
        isGfsSessionAuthorityCurrent(
          source.scope,
          publishedGeneration,
          liveAuthorityRef.current.scope,
          liveAuthorityRef.current.generation
        )
      if (!ownsPublishedAuthority()) return
      try {
        const authoritativeSessionGeneration = await window.clerum.auth.getSessionGeneration()
        if (authoritativeSessionGeneration !== publishedGeneration || !ownsPublishedAuthority())
          return
        const decision = await adjudication.adjudicateDrop(source, {
          resourceId: node.resourceId,
          name: node.name,
          kind: node.kind,
          ancestorIds,
        })
        if (
          !ownsPublishedAuthority() ||
          (await window.clerum.auth.getSessionGeneration()) !== authoritativeSessionGeneration
        ) {
          return
        }
        if (!decision.allowed && decision.reason === 'session-lost') {
          // Presented BEFORE the ownership guard: the revocation that caused
          // this refusal has already invalidated the gesture's ownership, so
          // the normal callback path would return silently. The revoked
          // surface below carries the sentence persistently; this local
          // banner/announcement is gated by the captured scope/session
          // identity so a superseded call cannot declare a NEW, healthy
          // session ended (A11).
          if (
            mayPaintGfsSessionLostBanner({
              capturedScope: scopeAtDrop,
              liveScope: liveDragScopeRef.current,
              capturedEpoch: epoch,
              liveEpoch: dragSessionEpochRef.current,
              capturedSessionGeneration: sessionGeneration,
              liveSessionGeneration: dragSession?.currentGeneration() ?? null,
              hasSharedSession: dragSession != null,
            })
          ) {
            setDropSessionLost(true)
            setDropVerdictAnnouncement(GFS_DROP_SESSION_LOST_MESSAGE)
          }
          return
        }
        if (!ownsDrop(source, epoch, sessionGeneration)) return
        if (!decision.allowed) {
          const { message, tone } = presentGfsDropRefusal(decision, {
            source: source.name,
            target: node.name,
          })
          setDropVerdictAnnouncement(message)
          pushToast(message, tone)
          return
        }
        if (source.kind === 'directory') {
          setPendingFolderMove({
            source,
            gestureGeneration: epoch,
            sessionGeneration,
            authoritativeSessionGeneration,
            destination: { resourceId: node.resourceId, name: node.name },
          })
          return
        }
        await commitMove(
          source,
          { resourceId: node.resourceId, name: node.name },
          () => ownsPublishedAuthority() && ownsDrop(source, epoch, sessionGeneration),
          () =>
            ownsPublishedAuthority() &&
            mountedRef.current &&
            liveDragScopeRef.current === source.scope,
          true,
          authoritativeSessionGeneration
        )
      } finally {
        finishNodeDropCleanup(source, epoch, sessionGeneration)
      }
    },
    [
      adjudication,
      cachedDestinationNames,
      finishNodeDropCleanup,
      commitMove,
      ctrl.sessionGeneration,
      ctrl.sessionScope,
      dragSession,
      ownsDrop,
      pushToast,
      resolveActiveSource,
    ]
  )

  const handleRequestMove = useCallback(
    (node: GfsBrowserChild, ancestorCrumbs: readonly GfsCrumb[]) => {
      const target = { node, initialCrumbs: [...ancestorCrumbs] }
      moveDialogTargetRef.current = target
      setMovePermissionStatus(null)
      setMoveDialogTarget(target)
    },
    []
  )

  const handleRetryMovePermission = async (
    destinationId: string,
    _destinationName: string,
    isDialogCurrent: () => boolean
  ) => {
    const target = moveDialogTarget
    if (!target || !isDialogCurrent()) return
    const scope = ctrl.sessionScope
    const expectedScope = scope ?? 'anonymous'
    const expectedGeneration = ctrl.sessionGeneration
    const ownsRetry = () =>
      moveDialogTargetRef.current === target &&
      liveDragScopeRef.current === expectedScope &&
      isGfsSessionAuthorityCurrent(
        scope,
        expectedGeneration,
        liveAuthorityRef.current.scope,
        liveAuthorityRef.current.generation
      ) &&
      isDialogCurrent()
    const drive = target.node.drive || GFS_DRIVE_MAIN
    setMovePermissionStatus('checking')

    try {
      if (!scope || !isGfsSessionGeneration(expectedGeneration)) {
        throw new Error('Could not verify the source folder for this move.')
      }
      const destinationKey = desktopQueryKeys.gfsAffordances(
        scope,
        destinationId,
        drive,
        expectedGeneration
      )
      assertGfsAuthorityRetryAllowed(queryClient, destinationKey)

      if (!ownsRetry()) {
        if (moveDialogTargetRef.current === target) setMovePermissionStatus(null)
        return
      }
      const resolvedSource = await window.clerum.gfs.resolve(target.node.gfsUri)
      if (!ownsRetry()) {
        if (moveDialogTargetRef.current === target) setMovePermissionStatus(null)
        return
      }
      if (resolvedSource.resourceId !== target.node.resourceId) {
        throw new Error('Could not verify the source folder for this move.')
      }
      const sourceParentId = resolvedSource.parentResourceId
      if (!sourceParentId) {
        throw new Error('Could not verify the source folder for this move.')
      }
      const sourceKey = desktopQueryKeys.gfsAffordances(
        scope,
        sourceParentId,
        drive,
        expectedGeneration
      )
      assertGfsAuthorityRetryAllowed(queryClient, sourceKey)
      assertGfsAuthorityRetryAllowed(queryClient, destinationKey)

      const [source, destination] = await Promise.all([
        queryClient.fetchQuery({
          queryKey: sourceKey,
          queryFn: () => window.clerum.gfs.affordances(sourceParentId, drive),
          staleTime: 0,
          retry: false,
        }),
        queryClient.fetchQuery({
          queryKey: destinationKey,
          queryFn: () => window.clerum.gfs.affordances(destinationId, drive),
          staleTime: 0,
          retry: false,
        }),
      ])
      if (!ownsRetry()) {
        if (moveDialogTargetRef.current === target) setMovePermissionStatus(null)
        return
      }
      if (!hasGfsMoveSourcePermissions(source.held)) {
        throw new Error('You do not have write and delete access to the source folder.')
      }
      if (!destination.held.includes('write')) {
        throw new Error('You do not have write access to the destination folder.')
      }
      setMovePermissionStatus(null)
    } catch (retryError) {
      if (moveDialogTargetRef.current !== target) return
      if (!ownsRetry()) {
        setMovePermissionStatus(null)
        return
      }
      const message = errorMessage(retryError) ?? String(retryError)
      if (ctrl.handleAuthorityFailure(message, 'operation', scope, expectedGeneration)) {
        closeMoveDialog()
        return
      }
      setMovePermissionStatus('failed')
      throw retryError
    }
  }

  const handleActivateFolder = useCallback(
    (node: GfsBrowserChild) => {
      // A folder grant without inheritance lists the folder but denies its
      // contents: opening its files tab would 403 on every child. Refuse the
      // activation with the same message the Files page uses on the row click.
      if (node.readable === false) {
        pushToast(`You do not have read access to ${displayName(node.name)}`, 'error')
        return
      }
      onOpenFolder(node.gfsUri)
    },
    [onOpenFolder, pushToast]
  )

  const authorityFailure = ctrl.handleAuthorityFailure
  const handleAuthorityFailure = useCallback(
    (message: unknown, scope: string, sessionGeneration: number) =>
      authorityFailure(message, 'operation', scope, sessionGeneration),
    [authorityFailure]
  )

  // A file now activates on single-click, so a real double-click (or accidental
  // rapid clicks) fires activation more than once. The preview path is naturally
  // idempotent — the host dedupes preview tabs by gfsUri — but a download has no
  // such guard, so repeated activations would save the file and toast N times.
  // Track in-flight downloads by gfsUri and drop any activation for one already
  // running, making a file's double-click idempotent on the download path too.
  const downloadsInFlight = useRef<Set<string>>(new Set())

  const handleActivateFile = useCallback(
    (node: GfsBrowserChild) => {
      // A file whose parent grant does not inherit is listed but unreadable:
      // both the preview and the download fallback would 403. Refuse before
      // either, matching the Files page's openResource guard and toast.
      if (node.readable === false) {
        pushToast(`You do not have read access to ${displayName(node.name)}`, 'error')
        return
      }
      setSelectedId(node.resourceId)
      const preview = resolveGfsPreview(node)
      if (preview) {
        onOpenPreview(preview)
        return
      }
      if (downloadsInFlight.current.has(node.gfsUri)) return
      downloadsInFlight.current.add(node.gfsUri)
      void (async () => {
        try {
          // The raw name is the real on-disk filename; the toast shows the cleaned one.
          await saveGfsFileToDisk(node.gfsUri, node.name)
          pushToast(`Downloaded ${displayName(node.name)}`, 'success')
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (authorityFailure(error, 'operation')) return
          pushToast(message, 'error')
        } finally {
          downloadsInFlight.current.delete(node.gfsUri)
        }
      })()
    },
    [authorityFailure, onOpenPreview, pushToast]
  )

  return (
    <div className="da-file-explorer">
      {/* The drop verdict is painted on the target row; this live region is
          its spoken form, so a screen reader learns whether the folder under
          the pointer accepts the move (RP-026). */}
      <p aria-live="polite" className="visually-hidden">
        {dropVerdictAnnouncement}
      </p>
      {dropSessionLost ? (
        // Persistent (A11): the refusal outlives the dead gesture and the
        // revoked tree surface below — it is not a one-shot toast.
        <StatusBanner tone="error" text={GFS_DROP_SESSION_LOST_MESSAGE} compact />
      ) : null}
      {ctrl.accessState === 'revoked' ? (
        // Mirror the Files page's revoked surface, adapted to the sidebar's
        // compact chrome. Without this branch a revoked drive falls through to
        // "No shared files yet." — the fail-closed purge has already dropped the
        // discovery error and roots, so an unauthorized drive would read empty.
        <div className="da-file-explorer__revoked" role="alert">
          <p className="da-file-explorer__revoked-title">File access is not authorized</p>
          {/* The revoked surface owns the session-ended sentence (A11): it
              outlives any gesture's ownership, so a drag whose probe died
              stays explained even after the revocation invalidated it. */}
          <p className="da-file-explorer__revoked-body">{GFS_DROP_SESSION_LOST_MESSAGE}</p>
          <p className="da-file-explorer__revoked-body">
            Your current session cannot access these files. Sign in again or contact an
            administrator.
          </p>
          <Button onClick={() => ctrl.retryAccess()} size="xs" variant="text">
            Retry file access
          </Button>
        </div>
      ) : ctrl.accessibleNotice ? (
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
              ancestorCrumbs={[]}
              ancestorIds={node.parentResourceId != null ? [node.parentResourceId] : []}
              dragSourceName={dragSourceName}
              // The forest roots are drop targets like any other row: their
              // verdict belongs to them, so the root row receives its own
              // state instead of only the map its children read (RP-019).
              dropState={dropStatesByResourceId[node.resourceId]}
              dropStatesByResourceId={dropStatesByResourceId}
              expandedIds={expandedIds}
              key={node.resourceId}
              level={1}
              movingResourceId={movingResourceId}
              node={node}
              onActivateFile={handleActivateFile}
              onActivateFolder={handleActivateFolder}
              onResourceAction={onResourceAction}
              onAuthorityFailure={handleAuthorityFailure}
              onNodeDragEnd={clearDragState}
              onNodeDragLeave={handleNodeDragLeave}
              onNodeDragOver={handleNodeDragOver}
              onNodeDragStart={handleNodeDragStart}
              onNodeDrop={handleNodeDrop}
              onRequestMove={handleRequestMove}
              onToggle={handleToggle}
              scope={ctrl.sessionScope ?? 'anonymous'}
              sessionGeneration={ctrl.sessionGeneration}
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

      {pendingFolderMove ? (
        <GfsMoveConfirmDialog
          busy={movingResourceId === pendingFolderMove.source.resourceId}
          request={{
            sourceName: displayName(pendingFolderMove.source.name),
            destinationName: displayName(pendingFolderMove.destination.name),
          }}
          onCancel={() => setPendingFolderMove(null)}
          onConfirm={() => {
            const pending = pendingFolderMove
            setPendingFolderMove(null)
            if (
              pending &&
              ownsDrop(pending.source, pending.gestureGeneration, pending.sessionGeneration)
            ) {
              void commitMove(
                pending.source,
                pending.destination,
                () =>
                  ownsDrop(pending.source, pending.gestureGeneration, pending.sessionGeneration),
                () => mountedRef.current && liveDragScopeRef.current === pending.source.scope,
                true,
                pending.authoritativeSessionGeneration
              )
            }
          }}
        />
      ) : null}

      {moveDialogTarget ? (
        <GfsMoveDialog
          busy={ctrl.mutating || movePermissionStatus === 'checking'}
          initialCrumbs={moveDialogTarget.initialCrumbs}
          onClose={closeMoveDialog}
          onMoveWithOwnership={async (destinationId, destinationName, isDialogCurrent) => {
            setMovePermissionStatus(null)
            const target = moveDialogTargetRef.current
            if (!target) return
            const publishedGeneration = ctrl.sessionGeneration
            const publishedScope = ctrl.sessionScope
            const ownsPublishedAuthority = () =>
              isGfsSessionAuthorityCurrent(
                publishedScope,
                publishedGeneration,
                liveAuthorityRef.current.scope,
                liveAuthorityRef.current.generation
              )
            if (!ownsPublishedAuthority()) return
            const source: GfsDragSource = {
              resourceId: target.node.resourceId,
              gfsUri: target.node.gfsUri,
              drive: target.node.drive || GFS_DRIVE_MAIN,
              kind: target.node.kind === 'directory' ? 'directory' : 'file',
              name: target.node.name,
              ...(Number.isSafeInteger(target.node.version)
                ? { version: target.node.version }
                : {}),
              parentKnown: target.node.parentResourceId != null,
              parentResourceId: target.node.parentResourceId ?? null,
              knownAncestorIds: [],
              origin: 'sidebar',
              scope: ctrl.sessionScope ?? 'anonymous',
              generation: dragSessionEpochRef.current,
            }
            const isCurrent = () =>
              ownsPublishedAuthority() &&
              mountedRef.current &&
              moveDialogTargetRef.current === target &&
              liveDragScopeRef.current === source.scope &&
              isDialogCurrent()
            const isPresentationCurrent = () =>
              ownsPublishedAuthority() &&
              mountedRef.current &&
              liveDragScopeRef.current === source.scope
            const authoritativeSessionGeneration = await window.clerum.auth.getSessionGeneration()
            if (authoritativeSessionGeneration !== publishedGeneration || !isCurrent()) return
            const outcome = await commitMove(
              source,
              { resourceId: destinationId, name: destinationName },
              isCurrent,
              isPresentationCurrent,
              false,
              authoritativeSessionGeneration
            )
            if (outcome.status === 'gesture-lost') return
            if (outcome.status === 'session-lost') {
              if (moveDialogTargetRef.current === target) closeMoveDialog()
              return
            }
            if (!isCurrent()) {
              if (isPresentationCurrent()) {
                toastMoveOutcome(pushToast, outcome, source.name, destinationName, source.kind)
              }
              return
            }
            if (outcome.status !== 'committed' && outcome.status !== 'no-op') {
              if (
                moveDialogTargetRef.current === target &&
                outcome.status === 'unconfirmed' &&
                outcome.retryPermissionCheck === true
              ) {
                setMovePermissionStatus('failed')
              }
              throw new Error(outcome.message)
            }
            toastMoveOutcome(pushToast, outcome, source.name, destinationName, source.kind)
            if (moveDialogTargetRef.current === target) closeMoveDialog()
          }}
          onRetryPermissionCheck={handleRetryMovePermission}
          onAuthorityFailure={handleAuthorityFailure}
          sessionScope={ctrl.sessionScope}
          sessionGeneration={ctrl.sessionGeneration}
          target={{
            resourceId: moveDialogTarget.node.resourceId,
            name: moveDialogTarget.node.name,
            kind: moveDialogTarget.node.kind === 'directory' ? 'directory' : 'file',
            parentResourceId: moveDialogTarget.node.parentResourceId ?? null,
          }}
          permissionStatus={movePermissionStatus}
        />
      ) : null}
    </div>
  )
}
