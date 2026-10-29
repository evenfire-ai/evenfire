import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { HolderOutlined } from '@ant-design/icons'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import type { InfiniteData } from '@tanstack/react-query'
import { Alert, Button, Empty, Flex, Spin, Tag, Tree, Typography } from 'antd'
import type { DataNode } from 'antd/es/tree'
import { GfsFileIcon } from '@components/GfsFileIcon'
import { IconChevronRight, IconContexts } from '@components/SidebarNav/icons'
import {
  FOLDER_HOVER_EXPAND_DELAY_MS,
  GFS_DRIVE_MAIN,
  GFS_RESOURCE_DRAG_TYPE,
} from '@constants/gfsBrowser'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import {
  type GfsBrowserChild,
  type GfsCrumb,
  useGfsBrowserController,
} from '@hooks/domain/useGfsBrowserController'
import { saveGfsFileToDisk } from '@lib/gfsDownload'
import { resolveGfsPreview } from '@lib/gfsPreview'
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
import { suggestNumberedMoveName } from '@/gfs/moveCommit'
import { runGfsMoveCommit } from '@/gfs/moveCommitRunner'
import { GfsMoveConfirmDialog } from '@/gfs/moveConfirmDialog'
import { GfsMoveDialog } from '@/gfs/moveDialog'
import type {
  FileExplorerNodeHandlers,
  FileExplorerNodeProps,
  FileExplorerTreeNodeMeta,
  FileExplorerTreeProps,
} from './types'

// A folder's single-click (toggle) must not act before we know a double-click
// (open its files tab) is not coming, so it is deferred by this window to let a
// double-click cancel it first. Files have no such ambiguity — a single-click
// activates them immediately — so this delay applies to folders only.
const DOUBLE_CLICK_DELAY_MS = 250
const FILE_EXPLORER_TREE_STYLES = { root: { background: 'transparent' } }

interface FileExplorerTreeDataNode extends DataNode {
  'aria-label'?: string
  'data-drop-reason'?: string
  'data-drop-state'?: GfsDropVerdict['state']
  resourceNode?: GfsBrowserChild
  dragEnabled?: boolean
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

interface FileExplorerChildrenQueryObserverProps {
  node: GfsBrowserChild
  scope: string
  enabled: boolean
  onResult: (resourceId: string, result: GfsChildrenQuerySnapshot) => void
}

function FileExplorerChildrenQueryObserver({
  node,
  scope,
  enabled,
  onResult,
}: FileExplorerChildrenQueryObserverProps) {
  const query = useInfiniteQuery<
    GfsChildrenPage,
    Error,
    InfiniteData<GfsChildrenPage, string | undefined>,
    ReturnType<typeof desktopQueryKeys.gfsChildren>,
    string | undefined
  >({
    queryKey: desktopQueryKeys.gfsChildren(scope, node.resourceId, GFS_DRIVE_MAIN),
    queryFn: ({ pageParam }) =>
      window.clerum.gfs.listChildren(node.resourceId, GFS_DRIVE_MAIN, pageParam),
    enabled,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
  })

  useEffect(() => {
    onResult(node.resourceId, {
      data: query.data,
      error: query.error,
      isFetching: query.isFetching,
      isFetchingNextPage: query.isFetchingNextPage,
      hasNextPage: query.hasNextPage,
      fetchNextPage: query.fetchNextPage,
    })
  }, [
    node.resourceId,
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

function childQuerySnapshotKey(scope: string, resourceId: string): string {
  return JSON.stringify([scope, resourceId])
}

function treeItemForDragEvent(event: { target: EventTarget | null }): HTMLElement | null {
  const target = event.target
  return target instanceof Element ? target.closest<HTMLElement>('[role="treeitem"]') : null
}

function dropStatus(dropState: GfsDropVerdict | undefined) {
  if (!dropState) return null
  if (dropState.state === 'checking') return { label: 'Checking', color: 'processing' as const }
  if (dropState.state === 'allowed') return { label: 'Allowed', color: 'success' as const }
  if (dropState.state === 'unavailable') return { label: 'Unavailable', color: 'warning' as const }
  if (dropState.reason === 'same-parent')
    return { label: 'Already here', color: 'default' as const }
  if (dropState.reason === 'unavailable' || dropState.reason === 'target-unavailable') {
    return { label: 'Unavailable', color: 'warning' as const }
  }
  return { label: 'Not allowed', color: 'error' as const }
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
function FileExplorerNodeTitle({
  node,
  isExpanded,
  movingResourceId,
  ancestorIds,
  ancestorCrumbs,
  dropState,
  dragSourceName,
  onToggle,
  onActivateFolder,
  onActivateFile,
  onNodeDragStart,
  onNodeDragEnd,
  onNodeDragOver,
  onNodeDragLeave,
  onNodeDrop,
  onRequestMove,
  registerKeyboardHandler,
  registerTreeNode,
}: FileExplorerNodeProps) {
  const isDirectory = node.kind === 'directory'
  const label = displayName(node.name)
  // Server-computed: the row is visible but the session cannot read it (a
  // folder grant without inheritance; a file whose parent does not inherit).
  // Mark it so it does not look actionable, and let the activate handlers
  // refuse it with a toast instead of a later download/preview 403. Absent
  // (older servers) is treated as unknown, not unreadable.
  const isUnreadable = node.readable === false

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
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Enter') {
        // Stop the native button click Enter would otherwise fire (which would run
        // the row's single-click handler — a folder's deferred toggle); Enter
        // activates instead, matching the folder double-click / file single-click.
        event.preventDefault()
        clearClickTimer()
        runActivate()
        return
      }
      if (event.key === ' ') {
        event.preventDefault()
        handleRowClick()
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
    [ancestorCrumbs, clearClickTimer, handleRowClick, node, onRequestMove, runActivate]
  )

  useLayoutEffect(
    () => registerKeyboardHandler(node.resourceId, handleRowKeyDown),
    [handleRowKeyDown, node.resourceId, registerKeyboardHandler]
  )

  const handleDragStart = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      // A drag must not fire the deferred folder toggle after release.
      clearClickTimer()
      onNodeDragStart(node, event, ancestorIds)
    },
    [ancestorIds, clearClickTimer, node, onNodeDragStart]
  )

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
    (event: React.DragEvent<HTMLElement>) => {
      onNodeDragOver(node, event, ancestorIds)
    },
    [ancestorIds, node, onNodeDragOver]
  )

  const handleRowDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      // The drop ends the gesture; the browser does not necessarily fire a
      // dragleave afterwards, so this row's OWN hover-expand timer would still
      // fire and expand a folder the user never asked to open (RP-024).
      clearHoverExpand()
      onNodeDrop(node, event, ancestorIds)
    },
    [ancestorIds, clearHoverExpand, node, onNodeDrop]
  )

  const handleRowDragEnterOrOver = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      handleRowDragOver(event)
      const hoverState = dropState?.state
      if (
        isDirectory &&
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
    [dropState, handleRowDragOver, isDirectory, isExpanded, node.resourceId, onToggle]
  )

  const handleRowDragLeave = useCallback(
    (event: React.DragEvent<HTMLElement>, rowElement: HTMLElement | null) => {
      if (rowElement?.contains(event.relatedTarget as Node | null)) return
      clearHoverExpand()
      onNodeDragLeave(node, event)
    },
    [clearHoverExpand, node, onNodeDragLeave]
  )

  const dropReason = isDirectory ? gfsDropVerdictReason(dropState) : undefined
  // The deny/no-op/unknown tint carries no reason of its own; the tooltip
  // speaks the full sentence for it (one wording per reason, every surface).
  const dropReasonTooltip =
    dropState && dropReason !== undefined
      ? gfsDropVerdictLiveAnnouncement(dropState, node.name, dragSourceName ?? undefined)
      : undefined
  const status = dropStatus(isDirectory ? dropState : undefined)
  const rowHandlers: FileExplorerNodeHandlers = {
    onClick: handleRowClick,
    onDoubleClick: handleRowDoubleClick,
    onDragStart: handleDragStart,
    onDragEnd: onNodeDragEnd,
    onDragEnterOrOver: handleRowDragEnterOrOver,
    onDragLeave: handleRowDragLeave,
    onDrop: handleRowDrop,
    onKeyDown: handleRowKeyDown,
  }

  useLayoutEffect(
    () =>
      registerTreeNode({
        resourceNode: node,
        rowHandlers,
        dragEnabled: isDirectory || canDrag,
      }),
    [canDrag, isDirectory, node, registerTreeNode, rowHandlers]
  )

  return (
    <Flex
      align="center"
      gap="small"
      data-resource-id={node.resourceId}
      data-drop-state={dropState?.state}
      data-drop-reason={dropReason}
      title={dropReasonTooltip ?? (canDrag ? `Drag ${label} into a folder to move it` : undefined)}
    >
      <span className="da-file-explorer__icon" aria-hidden="true">
        {isDirectory ? <IconContexts aria-hidden="true" /> : <GfsFileIcon name={node.name} />}
      </span>
      <Typography.Text>{label}</Typography.Text>
      {isUnreadable ? <Tag>No access</Tag> : null}
      {status ? <Tag color={status.color}>{status.label}</Tag> : null}
    </Flex>
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
  pushToast,
}: FileExplorerTreeProps) {
  const ctrl = useGfsBrowserController()
  const queryScope = ctrl.sessionScope ?? 'anonymous'
  const queryClient = useQueryClient()
  const dragSession = useGfsDragSession()
  const adjudication = useGfsDragAdjudication({
    scope: ctrl.sessionScope,
    drive: GFS_DRIVE_MAIN,
    resolve: (uri: string) => window.clerum.gfs.resolve(uri),
    // A drag probe that answers 401 is a session failure, not a per-item
    // refusal: the drop is refused AND the session revoked.
    handleAuthorityFailure: (message: string) => ctrl.handleAuthorityFailure(message, 'operation'),
  })
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [childQuerySnapshots, setChildQuerySnapshots] = useState(
    () => new Map<string, GfsChildrenQuerySnapshot>()
  )
  const handleChildQueryResult = useCallback(
    (resourceId: string, result: GfsChildrenQuerySnapshot) => {
      setChildQuerySnapshots(previous => {
        const key = childQuerySnapshotKey(queryScope, resourceId)
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
    [queryScope]
  )
  const treeContainerRef = useRef<HTMLDivElement>(null)
  const treeNodeMetadataRef = useRef(new Map<string, FileExplorerTreeNodeMeta>())
  const metadataForTreeEventTarget = useCallback((target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return undefined
    const treeItem = target.closest<HTMLElement>('[role="treeitem"]')
    const title = treeItem?.querySelector<HTMLElement>('[data-resource-id]')
    const resourceId = title?.getAttribute('data-resource-id')
    return resourceId ? treeNodeMetadataRef.current.get(resourceId) : undefined
  }, [])
  const registerTreeNode = useCallback((metadata: FileExplorerTreeNodeMeta) => {
    const resourceId = metadata.resourceNode.resourceId
    treeNodeMetadataRef.current.set(resourceId, metadata)
    return () => {
      if (treeNodeMetadataRef.current.get(resourceId) === metadata) {
        treeNodeMetadataRef.current.delete(resourceId)
      }
    }
  }, [])
  const metadataForTreeNode = useCallback(
    (node: { key: React.Key }) => treeNodeMetadataRef.current.get(String(node.key)),
    []
  )
  const keyboardHandlersRef = useRef(
    new Map<string, (event: React.KeyboardEvent<HTMLElement>) => void>()
  )
  const registerKeyboardHandler = useCallback(
    (resourceId: string, handler: (event: React.KeyboardEvent<HTMLElement>) => void) => {
      keyboardHandlersRef.current.set(resourceId, handler)
      return () => {
        if (keyboardHandlersRef.current.get(resourceId) === handler) {
          keyboardHandlersRef.current.delete(resourceId)
        }
      }
    },
    []
  )
  const handleTreeKeyDownCapture = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ' && !(event.shiftKey && event.key === 'F10')) {
      return
    }
    const target = event.target
    if (target instanceof HTMLElement && target.closest('button,input,textarea,[role="button"]')) {
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
    const handler = resourceId ? keyboardHandlersRef.current.get(resourceId) : undefined
    if (!handler) return
    event.preventDefault()
    event.stopPropagation()
    handler(event)
  }, [])
  const handleTreeRowClickCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      if (
        target.closest('.ant-tree-switcher,button,input,textarea,[role="button"],[role="checkbox"]')
      )
        return
      metadataForTreeEventTarget(target)?.rowHandlers.onClick(event)
    },
    [metadataForTreeEventTarget]
  )
  const handleTreeRowDoubleClickCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      if (
        target.closest('.ant-tree-switcher,button,input,textarea,[role="button"],[role="checkbox"]')
      )
        return
      metadataForTreeEventTarget(target)?.rowHandlers.onDoubleClick(event)
    },
    [metadataForTreeEventTarget]
  )
  const handleTreeDragStartCapture = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const metadata = metadataForTreeEventTarget(event.target)
      if (!metadata) return
      event.stopPropagation()
      metadata.rowHandlers.onDragStart(event)
    },
    [metadataForTreeEventTarget]
  )
  const handleTreeDragEndCapture = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const metadata = metadataForTreeEventTarget(event.target)
      if (!metadata) return
      event.stopPropagation()
      metadata.rowHandlers.onDragEnd()
    },
    [metadataForTreeEventTarget]
  )
  const handleTreeDragEnterCapture = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const metadata = metadataForTreeEventTarget(event.target)
      if (!metadata) return
      event.stopPropagation()
      if (Array.from(event.dataTransfer.types || []).includes(GFS_RESOURCE_DRAG_TYPE)) {
        metadata.rowHandlers.onDragEnterOrOver(event)
      }
    },
    [metadataForTreeEventTarget]
  )
  const handleTreeDragOverCapture = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const metadata = metadataForTreeEventTarget(event.target)
      if (!metadata) return
      event.stopPropagation()
      if (Array.from(event.dataTransfer.types || []).includes(GFS_RESOURCE_DRAG_TYPE)) {
        metadata.rowHandlers.onDragEnterOrOver(event)
      }
    },
    [metadataForTreeEventTarget]
  )
  const handleTreeDragLeaveCapture = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const metadata = metadataForTreeEventTarget(event.target)
      if (!metadata) return
      event.stopPropagation()
      if (Array.from(event.dataTransfer.types || []).includes(GFS_RESOURCE_DRAG_TYPE)) {
        metadata.rowHandlers.onDragLeave(event, treeItemForDragEvent(event))
      }
    },
    [metadataForTreeEventTarget]
  )
  const handleTreeDropCapture = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const metadata = metadataForTreeEventTarget(event.target)
      if (!metadata) return
      event.stopPropagation()
      if (Array.from(event.dataTransfer.types || []).includes(GFS_RESOURCE_DRAG_TYPE)) {
        metadata.rowHandlers.onDrop(event)
      }
    },
    [metadataForTreeEventTarget]
  )
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
    destination: { resourceId: string; name: string }
    allowNumberedRename: boolean
    suggestedName?: string
  } | null>(null)
  const [moveDialogTarget, setMoveDialogTarget] = useState<{
    node: GfsBrowserChild
    initialCrumbs: GfsCrumb[]
  } | null>(null)

  useEffect(
    () => () => {
      dragSessionEpochRef.current += 1
      hoverOwnerRef.current = null
      adjudication.endDragSession()
    },
    [adjudication.endDragSession]
  )

  const liveDragScope = ctrl.accessState === 'revoked' ? null : (ctrl.sessionScope ?? 'anonymous')
  const liveDragScopeRef = useRef(liveDragScope)
  liveDragScopeRef.current = liveDragScope
  const previousDragScopeRef = useRef(liveDragScope)
  useEffect(() => {
    if (previousDragScopeRef.current === liveDragScope) return
    previousDragScopeRef.current = liveDragScope
    dragSessionEpochRef.current += 1
    draggingSourceRef.current = null
    hoverOwnerRef.current = null
    adjudication.endDragSession()
    setPendingFolderMove(null)
    setDropStatesByResourceId({})
    setDragSourceName(null)
    // A NEW live session makes any session-ended refusal stale. A transition
    // TO revoked (scope null) must NOT clear it: that is exactly when the
    // message has to survive (A11), and the revoked surface below carries it.
    if (liveDragScope !== null) setDropSessionLost(false)
  }, [adjudication.endDragSession, liveDragScope])

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

  // Keep one query observer for every directory that is currently present in
  // the visible tree. Descendants are observed only while their parent is
  // expanded, matching the old per-node query mount lifecycle.
  const directoryNodes: GfsBrowserChild[] = []
  const collectDirectoryNodes = (items: readonly GfsBrowserChild[]) => {
    for (const item of items) {
      if (item.kind !== 'directory') continue
      directoryNodes.push(item)
      if (!expandedIds.has(item.resourceId)) continue
      const children =
        childQuerySnapshots
          .get(childQuerySnapshotKey(queryScope, item.resourceId))
          ?.data?.pages.flatMap(page => page.items ?? []) ?? []
      collectDirectoryNodes(sortTreeItems(children))
    }
  }
  collectDirectoryNodes(roots)
  const childQueriesByResourceId = childQuerySnapshots

  /** Cached destination names for the numbered-name ladder and suggestion —
   * the same shared children cache the Files page seeds its commit from. */
  const cachedDestinationNames = useCallback(
    (destinationId: string): Set<string> => {
      const cached = queryClient.getQueryData<{ pages?: Array<{ items?: GfsBrowserChild[] }> }>(
        desktopQueryKeys.gfsChildren(queryScope, destinationId, GFS_DRIVE_MAIN)
      )
      return new Set(
        (cached?.pages ?? []).flatMap(page => page.items?.map(item => item.name) ?? [])
      )
    },
    [queryScope, queryClient]
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
      allowNumberedRename: boolean,
      isCurrent?: () => boolean
    ) => {
      movingResourceIdRef.current = source.resourceId
      setMovingResourceId(source.resourceId)
      try {
        return await runGfsMoveCommit(
          {
            moveResource: (resourceId, destinationId, ifMatch, newName, oldParentId) =>
              ctrl.moveResource(resourceId, destinationId, ifMatch, newName, oldParentId),
            handleAuthorityFailure: message => ctrl.handleAuthorityFailure(message, 'operation'),
            convergeCommittedMove: (input, receipt) => ctrl.convergeCommittedMove(input, receipt),
            pushToast,
          },
          {
            source,
            destination,
            allowNumberedRename,
            occupiedDestinationNames: cachedDestinationNames(destination.resourceId),
            ...(isCurrent ? { isCurrent } : {}),
          }
        )
      } finally {
        movingResourceIdRef.current = null
        setMovingResourceId(null)
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
      try {
        const decision = await adjudication.adjudicateDrop(source, {
          resourceId: node.resourceId,
          name: node.name,
          kind: node.kind,
          ancestorIds,
        })
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
          const occupied = cachedDestinationNames(node.resourceId)
          const suggested = suggestNumberedMoveName(source.name, occupied)
          setPendingFolderMove({
            source,
            gestureGeneration: epoch,
            sessionGeneration,
            destination: { resourceId: node.resourceId, name: node.name },
            allowNumberedRename: decision.allowNumberedRename,
            ...(suggested !== undefined ? { suggestedName: suggested } : {}),
          })
          return
        }
        await commitMove(
          source,
          { resourceId: node.resourceId, name: node.name },
          decision.allowNumberedRename,
          () => ownsDrop(source, epoch, sessionGeneration)
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
      dragSession,
      ownsDrop,
      pushToast,
      resolveActiveSource,
    ]
  )

  const handleRequestMove = useCallback(
    (node: GfsBrowserChild, ancestorCrumbs: readonly GfsCrumb[]) => {
      setMoveDialogTarget({ node, initialCrumbs: [...ancestorCrumbs] })
    },
    []
  )

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
    (message: string) => {
      authorityFailure(message, 'operation')
    },
    [authorityFailure]
  )

  const processedChildErrorsRef = useRef(new Map<string, unknown>())
  useEffect(() => {
    directoryNodes.forEach(node => {
      const result = childQueriesByResourceId.get(
        childQuerySnapshotKey(queryScope, node.resourceId)
      )
      const queryKey = desktopQueryKeys.gfsChildren(queryScope, node.resourceId, GFS_DRIVE_MAIN)
      const cacheKey = JSON.stringify(queryKey)
      if (!result?.error) {
        processedChildErrorsRef.current.delete(cacheKey)
        return
      }
      if (processedChildErrorsRef.current.get(cacheKey) === result.error) return
      processedChildErrorsRef.current.set(cacheKey, result.error)
      purgeDeniedGfsChildren(queryClient, queryKey, result.error)
      const childError = isGfsChildrenDenied(result.error, result.data)
        ? 'This folder is no longer available.'
        : errorMessage(result.error)
      if (childError) handleAuthorityFailure(childError)
    })
  }, [queryScope, childQueriesByResourceId, directoryNodes, handleAuthorityFailure, queryClient])

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
          if (authorityFailure(message, 'operation')) return
          pushToast(message, 'error')
        } finally {
          downloadsInFlight.current.delete(node.gfsUri)
        }
      })()
    },
    [authorityFailure, onOpenPreview, pushToast]
  )

  const buildTreeNode = (
    node: GfsBrowserChild,
    ancestorIds: readonly (string | null)[],
    ancestorCrumbs: readonly GfsCrumb[]
  ): FileExplorerTreeDataNode => {
    const isDirectory = node.kind === 'directory'
    const isExpanded = isDirectory && expandedIds.has(node.resourceId)
    const childQuery = childQueriesByResourceId.get(
      childQuerySnapshotKey(queryScope, node.resourceId)
    )
    const childDenied = isGfsChildrenDenied(childQuery?.error, childQuery?.data)
    const childError = childDenied
      ? 'This folder is no longer available.'
      : errorMessage(childQuery?.error)
    const childItems =
      childDenied || !childQuery?.data
        ? []
        : sortTreeItems(childQuery.data.pages.flatMap(page => page.items))
    const loadingChildren = Boolean(isExpanded && childQuery?.isFetching && !childQuery.data)
    const hasMoreChildren = Boolean(childQuery?.hasNextPage)
    const nextAncestorIds = [node.resourceId, ...ancestorIds]
    const nextAncestorCrumbs: GfsCrumb[] = [
      ...ancestorCrumbs,
      {
        resourceId: node.resourceId,
        gfsUri: node.gfsUri,
        name: node.name,
        kind: 'directory',
        version: node.version,
        bytes: node.bytes,
      },
    ]
    const children: FileExplorerTreeDataNode[] = []

    if (isExpanded) {
      if (loadingChildren) {
        children.push({
          key: `status:${node.resourceId}:loading`,
          selectable: false,
          isLeaf: true,
          title: (
            <Flex align="center" gap="small" role="status" aria-live="polite">
              <Spin size="small" />
              <Typography.Text type="secondary">Loading…</Typography.Text>
            </Flex>
          ),
        })
      }
      if (childError) {
        children.push({
          key: `status:${node.resourceId}:error`,
          selectable: false,
          isLeaf: true,
          title: <Alert type="error" showIcon title={childError} />,
        })
      }
      children.push(
        ...childItems.map(child => buildTreeNode(child, nextAncestorIds, nextAncestorCrumbs))
      )
      if (hasMoreChildren && childQuery) {
        children.push({
          key: `status:${node.resourceId}:more`,
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
      if (!loadingChildren && !childError && childItems.length === 0 && !hasMoreChildren) {
        children.push({
          key: `status:${node.resourceId}:empty`,
          selectable: false,
          isLeaf: true,
          title: <Typography.Text type="secondary">Empty folder.</Typography.Text>,
        })
      }
    }

    return {
      key: node.resourceId,
      'aria-label':
        node.readable === false ? `${displayName(node.name)} No access` : displayName(node.name),
      'data-drop-state': dropStatesByResourceId[node.resourceId]?.state,
      'data-drop-reason':
        dropStatesByResourceId[node.resourceId] === undefined
          ? undefined
          : gfsDropVerdictReason(dropStatesByResourceId[node.resourceId]),
      title: (
        <FileExplorerNodeTitle
          ancestorCrumbs={ancestorCrumbs}
          ancestorIds={ancestorIds}
          dragSourceName={dragSourceName}
          dropState={dropStatesByResourceId[node.resourceId]}
          isExpanded={isExpanded}
          movingResourceId={movingResourceId}
          node={node}
          onActivateFile={handleActivateFile}
          onActivateFolder={handleActivateFolder}
          onNodeDragEnd={clearDragState}
          onNodeDragLeave={handleNodeDragLeave}
          onNodeDragOver={handleNodeDragOver}
          onNodeDragStart={handleNodeDragStart}
          onNodeDrop={handleNodeDrop}
          onRequestMove={handleRequestMove}
          onToggle={handleToggle}
          registerKeyboardHandler={registerKeyboardHandler}
          registerTreeNode={registerTreeNode}
        />
      ),
      isLeaf: !isDirectory,
      resourceNode: node,
      dragEnabled: isDirectory || (node.readable !== false && movingResourceId == null),
      children: children.length ? children : undefined,
    }
  }
  const treeData = roots.map(node =>
    buildTreeNode(node, node.parentResourceId != null ? [node.parentResourceId] : [], [])
  )

  return (
    <Flex
      vertical
      gap="small"
      ref={treeContainerRef}
      onClickCapture={handleTreeRowClickCapture}
      onDoubleClickCapture={handleTreeRowDoubleClickCapture}
      onDragStartCapture={handleTreeDragStartCapture}
      onDragEndCapture={handleTreeDragEndCapture}
      onDragEnterCapture={handleTreeDragEnterCapture}
      onDragOverCapture={handleTreeDragOverCapture}
      onDragLeaveCapture={handleTreeDragLeaveCapture}
      onDropCapture={handleTreeDropCapture}
      onKeyDownCapture={handleTreeKeyDownCapture}
    >
      {/* The live region preserves spoken drop verdicts while Ant Design Tree owns the visible rows. */}
      <Typography.Text aria-live="polite" className="visually-hidden" role="status">
        {dropVerdictAnnouncement}
      </Typography.Text>
      {dropSessionLost ? (
        <Alert type="error" showIcon title={GFS_DROP_SESSION_LOST_MESSAGE} />
      ) : null}
      {ctrl.accessState === 'revoked' ? (
        <Alert
          type="error"
          showIcon
          title="File access is not authorized"
          description={
            <Flex vertical>
              <Typography.Text>{GFS_DROP_SESSION_LOST_MESSAGE}</Typography.Text>
              <Typography.Text>
                Your current session cannot access these files. Sign in again or contact an
                administrator.
              </Typography.Text>
            </Flex>
          }
          action={<Button onClick={() => ctrl.retryAccess()}>Retry file access</Button>}
        />
      ) : ctrl.accessibleNotice ? (
        <Alert type="info" showIcon title={ctrl.accessibleNotice} />
      ) : ctrl.accessibleError ? (
        <Alert type="error" showIcon title={ctrl.accessibleError} />
      ) : ctrl.loadingAccessible && roots.length === 0 ? (
        <Flex align="center" gap="small" role="status" aria-live="polite">
          <Spin size="small" />
          <Typography.Text>Loading files…</Typography.Text>
        </Flex>
      ) : roots.length === 0 && !ctrl.hasMoreAccessible ? (
        <Empty description="No shared files yet." />
      ) : (
        <>
          {directoryNodes.map(node => (
            <FileExplorerChildrenQueryObserver
              enabled={expandedIds.has(node.resourceId) && ctrl.accessState === 'active'}
              key={node.resourceId}
              node={node}
              onResult={handleChildQueryResult}
              scope={queryScope}
            />
          ))}
          <Tree
            aria-label="Shared files"
            blockNode
            treeData={treeData}
            expandedKeys={[...expandedIds]}
            selectedKeys={selectedId ? [selectedId] : []}
            styles={FILE_EXPLORER_TREE_STYLES}
            switcherIcon={<IconChevronRight aria-hidden="true" width={14} height={14} />}
            draggable={{
              icon: <HolderOutlined aria-hidden="true" />,
              nodeDraggable: data => metadataForTreeNode(data)?.dragEnabled === true,
            }}
            allowDrop={({ dropNode, dropPosition }) =>
              dropPosition === 0 && metadataForTreeNode(dropNode)?.resourceNode.kind === 'directory'
            }
            onExpand={keys => setExpandedIds(new Set(keys.map(String)))}
            onSelect={() => undefined}
            onDragStart={({ event, node }) =>
              metadataForTreeNode(node)?.rowHandlers.onDragStart(event)
            }
            onDragEnter={({ event, node }) =>
              metadataForTreeNode(node)?.rowHandlers.onDragEnterOrOver(event)
            }
            onDragOver={({ event, node }) =>
              metadataForTreeNode(node)?.rowHandlers.onDragEnterOrOver(event)
            }
            onDragLeave={({ event, node }) =>
              metadataForTreeNode(node)?.rowHandlers.onDragLeave(event, treeItemForDragEvent(event))
            }
            onDragEnd={({ node }) => metadataForTreeNode(node)?.rowHandlers.onDragEnd()}
            onDrop={({ event, node }) =>
              metadataForTreeNode(node)?.rowHandlers.onDrop(
                event as unknown as React.DragEvent<HTMLElement>
              )
            }
          />
          {ctrl.hasMoreAccessible ? (
            <Button
              loading={ctrl.isFetchingMoreAccessible}
              onClick={() => ctrl.loadMoreAccessible()}
            >
              Load more
            </Button>
          ) : null}
        </>
      )}

      {pendingFolderMove ? (
        <GfsMoveConfirmDialog
          busy={movingResourceId === pendingFolderMove.source.resourceId}
          request={{
            sourceName: displayName(pendingFolderMove.source.name),
            destinationName: displayName(pendingFolderMove.destination.name),
            canRename: pendingFolderMove.allowNumberedRename,
            ...(pendingFolderMove.suggestedName !== undefined
              ? { suggestedName: pendingFolderMove.suggestedName }
              : {}),
          }}
          onCancel={() => setPendingFolderMove(null)}
          onConfirm={({ allowNumberedRename }) => {
            const pending = pendingFolderMove
            setPendingFolderMove(null)
            if (
              pending &&
              ownsDrop(pending.source, pending.gestureGeneration, pending.sessionGeneration)
            ) {
              void commitMove(pending.source, pending.destination, allowNumberedRename, () =>
                ownsDrop(pending.source, pending.gestureGeneration, pending.sessionGeneration)
              )
            }
          }}
        />
      ) : null}

      {moveDialogTarget ? (
        <GfsMoveDialog
          busy={ctrl.mutating}
          initialCrumbs={moveDialogTarget.initialCrumbs}
          onClose={() => setMoveDialogTarget(null)}
          onMove={async (destinationId, destinationName) => {
            const target = moveDialogTarget
            const allowNumberedRename = await adjudication.probeSourceWrite(target.node.resourceId)
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
            const outcome = await commitMove(
              source,
              { resourceId: destinationId, name: destinationName },
              allowNumberedRename
            )
            if (outcome.status === 'session-lost' || outcome.status === 'gesture-lost') {
              setMoveDialogTarget(null)
              return
            }
            if (outcome.status !== 'committed' && outcome.status !== 'no-op') {
              throw new Error(outcome.message)
            }
            setMoveDialogTarget(null)
          }}
          onAuthorityFailure={message => {
            handleAuthorityFailure(message)
            return false
          }}
          sessionScope={ctrl.sessionScope}
          target={{
            resourceId: moveDialogTarget.node.resourceId,
            name: moveDialogTarget.node.name,
            kind: moveDialogTarget.node.kind === 'directory' ? 'directory' : 'file',
            parentResourceId: moveDialogTarget.node.parentResourceId ?? null,
          }}
        />
      ) : null}
    </Flex>
  )
}
