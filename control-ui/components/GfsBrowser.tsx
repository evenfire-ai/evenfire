'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { SingleValueEditDialog } from '@clerum/frontend-components'
import {
  GFS_MOVE_MAX_NETWORK_ATTEMPTS,
  GFS_UPLOAD_NAME_EXHAUSTED_MESSAGE,
  GFS_UPLOAD_NAME_RETRY_LIMIT,
  createGfsUploadNameReservationBook,
  decideDragPathStructure,
  gfsUploadNameRetryDecision,
  isGfsNameConflict,
  nextAvailableGfsResourceName,
  normalizeCanonicalPath,
  normalizeGfsResourceName,
  parentPathOf,
  planMoveConvergence,
} from '@clerum/gfs-interaction-policy'
import { FileUploadModal } from '@components/FileUploadModal'
import { GfsImagePreview } from '@components/GfsImagePreview'
import { GfsMarkdownPreview } from '@components/GfsMarkdownPreview'
import { GfsMoveConfirmDialog } from '@components/GfsMoveConfirmDialog'
import { GfsMoveDialog } from '@components/GfsMoveDialog'
import { GfsOpenLinkModal } from '@components/GfsOpenLinkModal'
import { GfsVideoPreview } from '@components/GfsVideoPreview'
import {
  IconDocumentText,
  IconFolder,
  IconImage,
  IconServer,
  IconVideo,
} from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import {
  IconChevronRight,
  IconHardDrive,
  IconPaperclip,
  IconUpload,
  IconX,
} from '@components/icons'
import { Button, Field, TextInput } from '@components/ui'
import {
  AuthExpiredError,
  apiGet,
  apiSend,
  getGfsResourceByPath,
  gfsDownload,
  handleControlUIUnauthorized,
  isSilentApiError,
} from '@lib/api'
import { createCoalescedRevalidation } from '@lib/coalescedRevalidation'
import {
  ENTITY_CHANGE_MAX_FRAME_CHARS,
  entityChangeStreamUrl,
  parseEntityChangeFrame,
  parseEntityChangeRetryAfterMs,
} from '@lib/entityChangeStream'
import { watchEntityChangeStreamLiveness } from '@lib/entityChangeStreamLiveness'
import { isGfsDocumentFile } from '@lib/gfsDocumentFile'
import {
  GfsMoveRefusalError,
  computeGfsDropHoverVerdict,
  gfsDropHoverAnnouncement,
  gfsDropRefusalMessage,
  gfsDropRefusalTone,
} from '@lib/gfsDragFeedback'
import type {
  GfsDropHoverVerdict,
  GfsDropRefusalReason,
  GfsEndpointRead,
  GfsMoveDestination,
  GfsResolvedEndpointView,
} from '@lib/gfsDragFeedback.types'
import {
  GfsUploadCapabilityError,
  type GfsUploadJob,
  type GfsUploadJobInput,
  type GfsUploadJobSnapshot,
  assertGfsFileUploadSize,
  createGfsUploadJob,
  uploadGfsFileLegacy,
} from '@lib/gfsFileUpload'
import { resolveGfsHierarchy } from '@lib/gfsHierarchyRevalidation'
import { gfsImagePreviewMimeType } from '@lib/gfsImagePreview'
import { GfsLoadArbiter } from '@lib/gfsLoadArbitration'
import { isGfsMarkdownPreviewFile } from '@lib/gfsMarkdownPreview'
import { isGfsVideoFile } from '@lib/gfsVideoFile'
import { gfsVideoPreviewMimeType } from '@lib/gfsVideoPreview'
import { GfsGrantPanel } from './GfsGrantPanel'
import { GfsResourceMenu } from './GfsResourceMenu'
import { NewFolderModal } from './NewFolderModal'
import { TablePanelHeader } from './TablePanelHeader'

/** A child node as returned by /api/v1/gfs/tree and /resources/:id/children. */
interface GfsChild {
  resourceId: string
  rid: string
  gfsUri: string
  name: string
  kind: string
  path: string | null
  bytes: number
  version: number
}

interface TreePage {
  items: GfsChild[]
  nextCursor: string | null
  rootResourceId?: string
  loadedPageCount?: number
}

type OpenPreviewState =
  | {
      kind: 'image'
      gfsUri: string
      byteLength: number
      fileName: string
      mimeType: string
      rid: string
      version: number
      reloadVersion: number
      unavailable: boolean
    }
  | {
      kind: 'markdown'
      gfsUri: string
      byteLength: number
      fileName: string
      rid: string
      version: number
      reloadVersion: number
      unavailable: boolean
    }
  | {
      kind: 'video'
      gfsUri: string
      byteLength: number
      fileName: string
      mimeType: string
      rid: string
      version: number
      reloadVersion: number
      unavailable: boolean
    }

type ResolvedPreviewUpdate =
  | Extract<OpenPreviewState, { kind: 'image' }>
  | Extract<OpenPreviewState, { kind: 'markdown' }>
  | Extract<OpenPreviewState, { kind: 'video' }>

interface Crumb {
  /** True when this is the stable drive-root location, independent of its resource ID. */
  isDriveRoot?: boolean
  /** Null only until /gfs/tree resolves the drive root's resource ID. */
  id: string | null
  rid: string | null
  name: string
  /** Folder crumbs carry the identity their ⋯ menu actions need; the
   *  synthetic root has none and gets no menu. */
  kind?: 'directory'
  gfsUri?: string
  version?: number
}

function isDriveRootCrumb(crumb: Crumb | undefined): boolean {
  return crumb?.isDriveRoot === true || crumb?.id === null
}

function sameCrumbLocation(left: Crumb | undefined, right: Crumb): boolean {
  if (isDriveRootCrumb(left) || isDriveRootCrumb(right)) {
    return isDriveRootCrumb(left) && isDriveRootCrumb(right)
  }
  return left?.id === right.id
}

function createDriveRootCrumb(): Crumb {
  return { id: null, rid: null, name: '/', isDriveRoot: true }
}

interface GfsResolvedLocation {
  resourceId: string
  rid: string
  gfsUri: string
  name: string
  kind: string
  path: string | null
  version: number
}

/** Project every response-backed folder source through one version-preserving
 * breadcrumb adapter. An incomplete runtime payload remains browseable but
 * never gains a fabricated mutation precondition. */
function folderResourceToCrumb(
  resource: Pick<GfsChild, 'resourceId' | 'rid' | 'gfsUri' | 'name' | 'kind'> & {
    version?: number
  }
): Crumb {
  return {
    id: resource.resourceId,
    rid: resource.rid,
    name: resource.name,
    kind: 'directory',
    gfsUri: resource.gfsUri,
    ...(Number.isSafeInteger(resource.version) ? { version: resource.version } : {}),
  }
}

function sameCrumbTrail(left: Crumb[], right: Crumb[]): boolean {
  return (
    left.length === right.length &&
    left.every((crumb, index) => {
      const other = right[index]
      return (
        crumb.id === other?.id &&
        isDriveRootCrumb(crumb) === isDriveRootCrumb(other) &&
        crumb.rid === other.rid &&
        crumb.gfsUri === other.gfsUri &&
        crumb.name === other.name &&
        crumb.version === other.version
      )
    })
  )
}

/** Verdict of a breadcrumb ancestry reconstruction attempt (R7-M1 race).
 *  'superseded' means a newer Move, reconstruction, rename, or navigation
 *  invalidated this attempt while its requests were in flight — callers must
 *  leave the breadcrumb trail AND the recovery notice untouched so the
 *  newer operation's state survives. */
type TrailReconstructionOutcome = 'applied' | 'failed' | 'superseded'

const DRIVE = 'main'
const PENDING_GFS_UPLOAD_KEY = 'evenfire:gfs-upload-v2:pending'
const GFS_RESOURCE_DRAG_TYPE = 'application/x-evenfire-gfs-resource'

interface PendingGfsUpload {
  uploadId?: string
  idempotencyKey?: string
  fileName: string
  fileSize: number
  lastModified: number
  target: {
    operation: 'create' | 'replace'
    parentRid?: string
    resourceRid?: string
    ifMatch?: number
  }
  name: string
}

function readPendingGfsUpload(): PendingGfsUpload | null {
  if (typeof window === 'undefined') return null
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(PENDING_GFS_UPLOAD_KEY) || 'null'
    ) as Partial<PendingGfsUpload> | null
    if (
      !parsed ||
      (typeof parsed.uploadId !== 'string' && typeof parsed.idempotencyKey !== 'string') ||
      typeof parsed.fileName !== 'string' ||
      typeof parsed.fileSize !== 'number' ||
      typeof parsed.lastModified !== 'number' ||
      !parsed.target ||
      typeof parsed.name !== 'string'
    )
      return null
    return parsed as PendingGfsUpload
  } catch {
    return null
  }
}

function persistPendingGfsUpload(record: PendingGfsUpload): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(PENDING_GFS_UPLOAD_KEY, JSON.stringify(record))
}

function clearPendingGfsUpload(uploadId?: string): void {
  if (typeof window === 'undefined') return
  const current = readPendingGfsUpload()
  if (!uploadId || current?.uploadId === uploadId)
    window.localStorage.removeItem(PENDING_GFS_UPLOAD_KEY)
}

function matchingPendingResumeUploadId(
  file: File,
  target: GfsUploadJobInput['target'],
  name: string
): string | undefined {
  const pending = readPendingGfsUpload()
  if (!pending?.uploadId) return undefined
  if (
    pending.fileName !== file.name ||
    pending.fileSize !== file.size ||
    pending.lastModified !== file.lastModified ||
    pending.name !== name ||
    pending.target.operation !== target.operation ||
    pending.target.parentRid !== target.parentRid ||
    pending.target.resourceRid !== target.resourceRid ||
    pending.target.ifMatch !== target.ifMatch
  )
    return undefined
  return pending.uploadId
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = units[0]
  for (let index = 0; value >= 1024 && index < units.length - 1; index += 1) {
    value /= 1024
    unit = units[index + 1]
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`
}

/**
 * Operator browser for the Global File System. It lists the drive tree through
 * control-api and uses the operator-scoped GFS proxy for create, upload,
 * replace, rename, and delete operations while access grants stay on the
 * control-api permission surface.
 */
function ridOfResourceId(resourceId: string): string {
  return resourceId.replace(/-/g, '').toLowerCase()
}

function hasDraggedFiles(event: React.DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types || []).includes('Files')
}

function hasDraggedGfsResource(event: React.DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types || []).includes(GFS_RESOURCE_DRAG_TYPE)
}

function isGfsPreviewFile(fileName: string): boolean {
  return (
    gfsImagePreviewMimeType(fileName) !== null ||
    isGfsMarkdownPreviewFile(fileName) ||
    gfsVideoPreviewMimeType(fileName) !== null
  )
}

function isEventFromNestedInteractive(
  event: React.MouseEvent<HTMLLIElement> | React.KeyboardEvent<HTMLLIElement>
): boolean {
  const target = event.target
  if (!(target instanceof Element)) return false
  return (
    target.closest('button, a, input, select, textarea, [role="button"], [role="menuitem"]') !==
    null
  )
}

function isTransientEntityChangeRefetchError(error: unknown): boolean {
  const status =
    error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined
  if (typeof status === 'number') {
    return status === 408 || status === 425 || status === 429 || status >= 500
  }
  if (error instanceof TypeError) return true
  return (
    error instanceof Error &&
    /network|fetch|timeout|timed out|socket|connection/i.test(error.message)
  )
}

function entityChangeErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

export function GfsBrowser(): React.JSX.Element {
  const { showToast } = useToast()
  const [crumbs, setCrumbs] = useState<Crumb[]>([createDriveRootCrumb()])
  const [items, setItems] = useState<GfsChild[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const loadArbiterRef = useRef(new GfsLoadArbiter())
  const entityChangeRefetchControllerRef = useRef<AbortController | null>(null)
  const loadedPageCountRef = useRef(1)
  const foregroundLoadsInFlightRef = useRef(0)
  const pendingStreamRevalidationRef = useRef(false)
  const requestStreamRevalidationRef = useRef<(cursor?: string) => void>(() => undefined)
  const loadedLocationRef = useRef<string | null | undefined>(undefined)
  // Operator selects a resource to delegate access on (grant panel).
  const [selected, setSelected] = useState<GfsChild | null>(null)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const [renameTarget, setRenameTarget] = useState<GfsChild | null>(null)
  const renameTargetRef = useRef(renameTarget)
  renameTargetRef.current = renameTarget
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState('')
  const [renameValid, setRenameValid] = useState(true)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const deleteOpenRef = useRef(deleteOpen)
  deleteOpenRef.current = deleteOpen
  // "Open EvenDrive link" dialog launched from the folder ⋯ menus.
  const [openLinkOpen, setOpenLinkOpen] = useState(false)
  const [openLinkResolving, setOpenLinkResolving] = useState(false)
  const [openLinkError, setOpenLinkError] = useState<string | null>(null)
  // New-folder dialog (replaces the native window.prompt flow).
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [createFolderError, setCreateFolderError] = useState<string | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploadCandidate, setUploadCandidate] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const uploadJobRef = useRef<GfsUploadJob | null>(null)
  const uploadNameReservationsRef = useRef(createGfsUploadNameReservationBook())
  const [uploadSnapshot, setUploadSnapshot] = useState<GfsUploadJobSnapshot | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [droppedUploadCount, setDroppedUploadCount] = useState(0)
  const [draggingResourceId, setDraggingResourceId] = useState<string | null>(null)
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)
  const [dragOverCrumbIndex, setDragOverCrumbIndex] = useState<number | null>(null)
  const [movingResourceId, setMovingResourceId] = useState<string | null>(null)
  const [moveTarget, setMoveTarget] = useState<GfsChild | null>(null)
  // rev-2 §1 + breadcrumb plan §3.2: a drag DROP stops at ONE confirmation
  // (impact + naming policy) for folders AND for breadcrumb drops of either
  // kind; row file drops keep moving directly; the Move dialog is its own
  // confirmation. The destination is captured IMMUTABLY at drop so a later
  // trail rebuild can never re-anchor the commit (R7-M1).
  const [confirmMoveTarget, setConfirmMoveTarget] = useState<{
    source: GfsChild
    destination: GfsMoveDestination
    suggestedName?: string
    epoch: number
    /** Physical source parent captured at the drop boundary (R7): drives
     *  convergence invalidation when the commit finally runs. */
    oldParentId: string | null
  } | null>(null)
  const moveTargetRef = useRef(moveTarget)
  moveTargetRef.current = moveTarget
  // R5-M1 recovery: the Move PATCH succeeded but the breadcrumb trail could
  // not be reconstructed from the folder's new location. The trail stays
  // as-was — explicitly stale, never shortened and presented as
  // authoritative — with this notice until a retry rebuilds it or the
  // operator navigates away from the moved folder. The snapshot carries
  // IMMUTABLE identity only (R7-M1): name and version are deliberately NOT
  // captured, so a retry can never replay move-time metadata over a crumb
  // that a later rename/mutation has since advanced.
  const [trailRecovery, setTrailRecovery] = useState<{
    resourceId: string
    gfsUri: string
    reason: 'move' | 'hierarchy'
  } | null>(null)
  // Matrix A11: an endpoint read that came back 401 during a drag move.
  // Session loss is TERMINAL for the gesture and must stay visible while the
  // surface is mounted — a transient toast read as a connection hiccup and
  // invited retries that could never succeed.
  const [sessionLost, setSessionLost] = useState(false)
  // Monotonic epoch for breadcrumb-reconstruction attempts (R7-M1 race). A
  // reconstruction (a move's rebuild or a Retry) captures the epoch at start
  // and may apply its result only while it is still the LATEST attempt. Any
  // newer reconstruction, a later Move's rebuild, a rename, or a navigation
  // that replaces/leaves the trail bumps the epoch, so a superseded in-flight
  // response is discarded instead of overwriting the newer ancestry or
  // clearing the newer operation's recovery notice. Appending a DESCENDANT
  // (openDirectory) does not bump: it never invalidates the retry target's
  // ancestors and the functional apply carries the live tail along.
  const trailReconstructionEpochRef = useRef(0)
  const draggingResourceRef = useRef<GfsChild | null>(null)
  const movingResourceRef = useRef<string | null>(null)
  // Monotonic drag-gesture epoch (breadcrumb plan §3.4). A newer dragstart
  // bumps it and thereby supersedes every pending admission read, the open
  // confirmation, and any commit read that has not dispatched its PATCH yet.
  // Dragend does NOT bump it: it only clears presentation, so a drop the
  // browser already accepted keeps its async admission/commit. Unmount bumps
  // it as well, so no stale closure can dispatch after the surface is gone.
  const dragGestureEpochRef = useRef(0)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      dragGestureEpochRef.current += 1
    }
  }, [])
  // The physical source-parent ID observed at dragstart (null = the synthetic
  // drive root). Active-crumb and own-parent drops resolve to same-parent
  // from this observation without any network round-trip.
  const dragSourceParentIdRef = useRef<string | null>(null)
  const isGestureEpochCurrent = useCallback((epoch: number): boolean => {
    return mountedRef.current && epoch === dragGestureEpochRef.current
  }, [])
  const [imagePreview, setImagePreview] = useState<Extract<
    OpenPreviewState,
    { kind: 'image' }
  > | null>(null)
  const [markdownPreview, setMarkdownPreview] = useState<Extract<
    OpenPreviewState,
    { kind: 'markdown' }
  > | null>(null)
  const [videoPreview, setVideoPreview] = useState<Extract<
    OpenPreviewState,
    { kind: 'video' }
  > | null>(null)
  const previewRefreshGenerationRef = useRef(0)
  const openPreviewsRef = useRef<OpenPreviewState[]>([])
  openPreviewsRef.current = [imagePreview, markdownPreview, videoPreview].filter(
    (preview): preview is OpenPreviewState => preview !== null
  )
  // Resource IDs currently streaming a download (disables that row's button).
  const [downloadingIds, setDownloadingIds] = useState<ReadonlySet<string>>(() => new Set())

  /**
   * Keep progress truthful when in-flight part observations arrive out of
   * order. Only stale uploading snapshots are monotonic; direct progress and
   * terminal/paused snapshots are accepted exactly.
   */
  const mergeUploadSnapshot = useCallback((next: GfsUploadJobSnapshot): void => {
    setUploadSnapshot(previous => {
      if (!previous) return next
      const previousUploadId = previous.session?.uploadId
      const nextUploadId = next.session?.uploadId
      if (
        (previousUploadId && nextUploadId && previousUploadId !== nextUploadId) ||
        previous.totalBytes !== next.totalBytes
      )
        return next
      const uploadedBytes =
        previous.state === 'uploading' && next.state === 'uploading'
          ? Math.max(previous.uploadedBytes, next.uploadedBytes)
          : next.uploadedBytes
      return {
        ...next,
        uploadedBytes: Math.min(Math.max(0, uploadedBytes), next.totalBytes),
      }
    })
  }, [])

  const mergeUploadProgress = useCallback((uploadedBytes: number): void => {
    setUploadSnapshot(previous => {
      if (!previous) return previous
      return {
        ...previous,
        uploadedBytes: Math.min(Math.max(0, uploadedBytes), previous.totalBytes),
      }
    })
  }, [])

  const current = crumbs[crumbs.length - 1]
  const currentCrumbRef = useRef(current)
  currentCrumbRef.current = current
  const crumbsRef = useRef(crumbs)
  crumbsRef.current = crumbs
  const currentLabel = current?.name === '/' ? DRIVE : current?.name || DRIVE

  const load = useCallback(
    async (
      crumb: Crumb,
      cursor?: string,
      options?: { background?: boolean; signal?: AbortSignal }
    ): Promise<void> => {
      const appending = Boolean(cursor)
      const background = Boolean(options?.background)
      if (!background) {
        foregroundLoadsInFlightRef.current += 1
        // User navigation or a foreground mutation refresh owns the next
        // visible result. Cancel stream-triggered reads so an older response
        // for the same folder cannot overwrite it.
        const activeStreamRefetch = entityChangeRefetchControllerRef.current
        if (activeStreamRefetch) {
          activeStreamRefetch.abort()
          pendingStreamRevalidationRef.current = true
        }
        entityChangeRefetchControllerRef.current = null
      }
      const loadArbiter = loadArbiterRef.current
      const loadToken = background ? loadArbiter.beginBackground() : loadArbiter.beginForeground()
      const isCurrent = () =>
        !options?.signal?.aborted &&
        loadArbiter.isCurrent(loadToken) &&
        sameCrumbLocation(currentCrumbRef.current, crumb)
      if (!background && !cursor) loadedPageCountRef.current = 1
      if (appending) {
        setLoadingMore(true)
      } else if (!background) {
        setLoading(true)
        setItems([])
        setNextCursor(null)
      }
      if (!background) setError('')
      try {
        const path = isDriveRootCrumb(crumb)
          ? '/api/v1/gfs/tree'
          : `/api/v1/gfs/resources/${encodeURIComponent(crumb.id!)}/children`
        const query: Record<string, string> = { drive: DRIVE }
        if (cursor) query.cursor = cursor
        const fetchPage = (pageQuery: Record<string, string>) =>
          options?.signal
            ? apiGet(path, pageQuery, { signal: options.signal })
            : apiGet(path, pageQuery)
        let page = (await fetchPage(query)) as TreePage
        let allItems = [...page.items]
        let finalCursor = page.nextCursor
        let fetchedPageCount = 1
        if (background) {
          const targetPageCount = loadedPageCountRef.current
          for (let index = 1; index < targetPageCount && finalCursor; index += 1) {
            page = (await fetchPage({ drive: DRIVE, cursor: finalCursor })) as TreePage
            allItems.push(...page.items)
            finalCursor = page.nextCursor
            fetchedPageCount += 1
            if (!isCurrent()) return
          }
        }
        if (!isCurrent()) return
        if (isDriveRootCrumb(crumb) && page.rootResourceId) {
          const rootRid = ridOfResourceId(page.rootResourceId)
          setCrumbs(prev => {
            const root = prev[0]
            if (!isDriveRootCrumb(root)) return prev
            if (root.id === page.rootResourceId && root.rid === rootRid) return prev
            return [{ ...root, id: page.rootResourceId, rid: rootRid }, ...prev.slice(1)]
          })
        }
        const sortedItems = sortChildrenWithDirectoriesFirst(allItems)
        setItems(prev => (cursor ? [...prev, ...sortedItems] : sortedItems))
        setNextCursor(finalCursor)
        if (background) loadedPageCountRef.current = fetchedPageCount
        else if (cursor) loadedPageCountRef.current += 1
        // Keep the folder cache coherent with what the server just returned:
        // navigation, refresh-after-mutation, and pagination all land here, so
        // a later openDirectory() can never serve rows older than this load.
        if (crumb.id !== null) {
          const existing = childCacheRef.current.get(crumb.id)
          childCacheRef.current.set(crumb.id, {
            items: cursor ? [...(existing?.items ?? []), ...allItems] : allItems,
            nextCursor: finalCursor,
            loadedPageCount: cursor
              ? (existing?.loadedPageCount ?? 1) + 1
              : background
                ? fetchedPageCount
                : 1,
          })
        }
      } catch (err) {
        if (!isCurrent()) return
        if (!isSilentApiError(err)) {
          setError(err instanceof Error ? err.message : 'Failed to load EvenDrive')
        }
      } finally {
        if (!background) {
          foregroundLoadsInFlightRef.current = Math.max(0, foregroundLoadsInFlightRef.current - 1)
          if (foregroundLoadsInFlightRef.current === 0 && pendingStreamRevalidationRef.current) {
            pendingStreamRevalidationRef.current = false
            requestStreamRevalidationRef.current()
          }
        }
        if (isCurrent()) {
          if (appending) setLoadingMore(false)
          else if (!background) setLoading(false)
        }
      }
    },
    []
  )

  function sortChildrenWithDirectoriesFirst(children: GfsChild[]): GfsChild[] {
    return [...children].sort((a, b) => {
      if (a.kind === b.kind) return a.name.localeCompare(b.name)
      return a.kind === 'directory' ? -1 : 1
    })
  }

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ GfsBrowser data-path decision table (keep behavior and tests aligned).  │
  // ├─────────────────────────────────────────────────────────────────────────┤
  // │ UPLOAD TRANSPORT (create & replace)                                     │
  // │ • Default: resumable Upload v2 (createGfsUploadJob) for EVERY size;     │
  // │   the writer-advertised maxFileBytes (≤ 1 GiB protocol ceiling) is      │
  // │   enforced before any bytes move. 8 MiB streamed parts.                 │
  // │ • Legacy contentBase64 runs ONLY for fresh (non-resume) uploads after   │
  // │   a capability error with allowLegacyFallback, and is refused above     │
  // │   the legacy 16 MiB raw limit. Persisted resume sessions never          │
  // │   downgrade (see tests: legacy-*.test, persisted-resume, >16 MiB).      │
  // ├─────────────────────────────────────────────────────────────────────────┤
  // │ FOLDER CACHE (childCacheRef) — revalidate vs. invalidate                │
  // │ • Prefetch warms UNcached folder rows (best-effort, non-fatal) and      │
  // │   never overwrites an entry a load() wrote meanwhile.                   │
  // │ • openDirectory serves a cached page instantly and marks the next       │
  // │   effect pass for BACKGROUND revalidation (stale-while-revalidate):     │
  // │   no spinner/row-clear; rows are replaced when the server diverged.     │
  // │ • Every completed load() (navigation, refresh-after-mutation,           │
  // │   pagination) writes the fresh page back into the cache, so uploads,    │
  // │   folder creation, rename, and delete keep cached folders coherent.     │
  // │ • Deleting a directory row drops its cache entry.                        │
  // │ • Loads are sequence-guarded: a response from a superseded navigation   │
  // │   can no longer overwrite the folder on screen (covers the background   │
  // │   path too).                                                            │
  // ├─────────────────────────────────────────────────────────────────────────┤
  // │ AUTHORITATIVE SERVER STATE                                              │
  // │ • Listings, resource versions (ifMatch), grants, and share rows always  │
  // │   come from control-api responses; this cache is never an authority for │
  // │   permissions or versions.                                              │
  // └─────────────────────────────────────────────────────────────────────────┘

  // Cache of prefetched directory children, keyed by the folder's
  // resourceId. Refs over state because we don't want to re-render
  // every time a prefetch resolves — the data is consumed lazily in
  // openDirectory(). Survives across navigation; cleared on unmount.
  const childCacheRef = useRef<Map<string, TreePage>>(new Map())
  // Monotonic load sequence: only the newest load() may apply its results,
  // so a slow response cannot clobber the folder the user navigated to next.
  // True after openDirectory() served cached data; the next useEffect pass
  // runs a BACKGROUND revalidation instead of a clearing reload, so the user
  // keeps the cached rows (no spinner) while the server state re-syncs.
  const revalidateNextLoadRef = useRef(false)
  const streamCursorRef = useRef<string | null>(null)
  const hierarchyRefreshGenerationRef = useRef(0)

  // Warm the cache for every folder row visible in the current view.
  // Re-runs whenever the listing changes (folder navigation, refresh,
  // …) and silently no-ops if a folder was already cached. Failed
  // prefetches are non-fatal; the real navigation surfaces the error.
  useEffect(() => {
    const folders = items.filter(child => child.kind === 'directory')
    if (folders.length === 0) return
    let cancelled = false
    async function prefetchFolder(folder: GfsChild): Promise<void> {
      try {
        const page = (await apiGet(
          `/api/v1/gfs/resources/${encodeURIComponent(folder.resourceId)}/children`,
          { drive: DRIVE }
        )) as TreePage | undefined
        if (cancelled || !page) return
        // A load() may have cached a fresher page while this prefetch was in
        // flight (the user navigated into the folder); never overwrite it.
        if (childCacheRef.current.has(folder.resourceId)) return
        childCacheRef.current.set(folder.resourceId, page)
      } catch {
        /* ignore — openDirectory will surface the real error */
      }
    }

    folders.forEach(folder => {
      if (childCacheRef.current.has(folder.resourceId)) return
      void prefetchFolder(folder)
    })
    return () => {
      cancelled = true
    }
  }, [items])

  const currentLocationKey = isDriveRootCrumb(current) ? '$root' : (current.id ?? '$root')
  useEffect(() => {
    const locationCrumb = currentCrumbRef.current
    if (!locationCrumb) return
    const sameLocation = loadedLocationRef.current === currentLocationKey
    loadedLocationRef.current = currentLocationKey
    if (!sameLocation) setLoadingMore(false)
    if (revalidateNextLoadRef.current) {
      revalidateNextLoadRef.current = false
      // Stale-while-revalidate: cached rows stay on screen (no spinner) while
      // the server state re-syncs; divergence overwrites the rows in place.
      void load(locationCrumb, undefined, { background: true })
      return
    }
    void load(locationCrumb, undefined, sameLocation ? { background: true } : undefined)
    // Reload whenever the current folder changes (navigation).
  }, [currentLocationKey, load])

  // Navigating away from the moved folder retires the recovery notice: the
  // stale trail it labels is no longer on screen.
  useEffect(() => {
    if (!trailRecovery) return
    if (!crumbs.some(crumb => crumb.id === trailRecovery.resourceId)) {
      setTrailRecovery(null)
    }
  }, [crumbs, trailRecovery])

  useEffect(() => {
    const controller = new AbortController()
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let recoveryTimer: ReturnType<typeof setTimeout> | null = null
    let retryDelay = 500
    let recoveryDelay = 500
    let active = true
    let performVisibleStateRevalidation: (cursor?: string) => Promise<void> = async () => undefined
    let invalidateVisibleState: (cursor?: string) => void = () => undefined
    const scheduleRecovery = () => {
      if (!active || recoveryTimer) return
      const delay = recoveryDelay
      recoveryDelay = Math.min(recoveryDelay * 2, 5000)
      recoveryTimer = setTimeout(() => {
        recoveryTimer = null
        invalidateVisibleState()
      }, delay)
    }
    const revalidationScheduler = createCoalescedRevalidation<string>(
      cursor => performVisibleStateRevalidation(cursor),
      error => {
        if (!active) return
        if (!isSilentApiError(error)) {
          setError(error instanceof Error ? error.message : 'Failed to refresh EvenDrive')
        }
        scheduleRecovery()
      },
      100
    )
    invalidateVisibleState = cursor => revalidationScheduler.request(cursor)
    requestStreamRevalidationRef.current = invalidateVisibleState
    const revalidateActionTargets = async (signal: AbortSignal) => {
      const targets = new Map<string, GfsChild>()
      for (const target of [selectedRef.current, renameTargetRef.current, moveTargetRef.current]) {
        if (target) targets.set(target.resourceId, target)
      }
      await Promise.all(
        Array.from(targets.values(), async target => {
          try {
            await apiGet('/api/v1/gfs/resolve', { uri: target.gfsUri }, { signal })
            if (signal.aborted) return
            // This read confirms the dialog's target is still visible; it must
            // not silently advance the version the operator is confirming.
            // Keep the original target snapshot so the existing ifMatch CAS can
            // report a stale write rather than applying to unconfirmed state.
          } catch (error) {
            if (signal.aborted) return
            const status = entityChangeErrorStatus(error)
            if (status === 403 || status === 404) {
              setSelected(value => (value?.resourceId === target.resourceId ? null : value))
              setRenameTarget(value => (value?.resourceId === target.resourceId ? null : value))
              setMoveTarget(value => (value?.resourceId === target.resourceId ? null : value))
              if (selectedRef.current?.resourceId === target.resourceId && deleteOpenRef.current) {
                setDeleteOpen(false)
              }
            } else if (isTransientEntityChangeRefetchError(error)) {
              scheduleRecovery()
            }
          }
        })
      )
    }

    const refreshVisibleDirectory = async (crumb: Crumb, signal: AbortSignal): Promise<void> => {
      const path = isDriveRootCrumb(crumb)
        ? '/api/v1/gfs/tree'
        : `/api/v1/gfs/resources/${encodeURIComponent(crumb.id!)}/children`
      const targetPageCount = Math.max(1, loadedPageCountRef.current)
      try {
        let page = (await apiGet(path, { drive: DRIVE }, { signal })) as TreePage
        const rootResourceId = page.rootResourceId
        const refreshedItems = [...page.items]
        let nextPageCursor = page.nextCursor
        let fetchedPageCount = 1
        for (let index = 1; index < targetPageCount && nextPageCursor; index += 1) {
          page = (await apiGet(
            path,
            { drive: DRIVE, cursor: nextPageCursor },
            { signal }
          )) as TreePage
          refreshedItems.push(...page.items)
          nextPageCursor = page.nextCursor
          fetchedPageCount += 1
          if (signal.aborted) return
        }
        if (signal.aborted || !sameCrumbLocation(currentCrumbRef.current, crumb)) return
        if (isDriveRootCrumb(crumb) && rootResourceId) {
          const rootRid = ridOfResourceId(rootResourceId)
          setCrumbs(previous => {
            const root = previous[0]
            if (!isDriveRootCrumb(root)) return previous
            if (root.id === rootResourceId && root.rid === rootRid) return previous
            return [{ ...root, id: rootResourceId, rid: rootRid }, ...previous.slice(1)]
          })
        }
        setItems(sortChildrenWithDirectoriesFirst(refreshedItems))
        setNextCursor(nextPageCursor)
        loadedPageCountRef.current = fetchedPageCount
        if (crumb.id !== null) {
          childCacheRef.current.set(crumb.id, {
            items: refreshedItems,
            nextCursor: nextPageCursor,
            loadedPageCount: fetchedPageCount,
          })
        }
        setError('')
      } catch (error) {
        if (signal.aborted || !sameCrumbLocation(currentCrumbRef.current, crumb)) return
        if (!isSilentApiError(error)) {
          setError(error instanceof Error ? error.message : 'Failed to refresh EvenDrive')
        }
        const status = entityChangeErrorStatus(error)
        if (status === 403 || status === 404) {
          // A soft invalidation preserves rows until the authoritative read
          // resolves. Once that read proves this folder cannot be listed, its
          // old rows are no longer safe to display or reuse on navigation.
          setItems([])
          setNextCursor(null)
          loadedPageCountRef.current = 1
          if (crumb.id !== null) childCacheRef.current.delete(crumb.id)
        } else if (isTransientEntityChangeRefetchError(error)) {
          scheduleRecovery()
        }
      }
    }

    performVisibleStateRevalidation = async (cursor?: string) => {
      // Foreground navigation and pagination own their results. If a stream
      // invalidation arrives while either is in flight, run one authoritative
      // refresh after the user operation settles rather than superseding it or
      // losing the invalidation.
      if (foregroundLoadsInFlightRef.current > 0) {
        pendingStreamRevalidationRef.current = true
        return
      }
      // Retire an older same-folder focus/cache refresh before publishing the
      // newer stream-authoritative listing. Its late response must not win.
      loadArbiterRef.current.beginStreamRevalidation()
      // A committed remote change supersedes any local move/retry ancestry
      // reconstruction still in flight. Its older response must not replace
      // the hierarchy we are about to refetch from the authoritative API.
      trailReconstructionEpochRef.current += 1
      if (cursor) {
        streamCursorRef.current = cursor
        if (recoveryTimer) clearTimeout(recoveryTimer)
        recoveryTimer = null
        recoveryDelay = 500
      }
      const revalidationController = new AbortController()
      entityChangeRefetchControllerRef.current = revalidationController
      const signal = revalidationController.signal
      childCacheRef.current.clear()
      revalidateNextLoadRef.current = false
      const revalidationTasks: Promise<void>[] = [revalidateActionTargets(signal)]
      const previews = openPreviewsRef.current
      if (previews.length > 0) {
        const generation = ++previewRefreshGenerationRef.current
        const markUnavailable = (preview: OpenPreviewState) => {
          setImagePreview(current =>
            current?.gfsUri === preview.gfsUri && !current.unavailable
              ? { ...current, unavailable: true, reloadVersion: current.reloadVersion + 1 }
              : current
          )
          setMarkdownPreview(current =>
            current?.gfsUri === preview.gfsUri && !current.unavailable
              ? { ...current, unavailable: true, reloadVersion: current.reloadVersion + 1 }
              : current
          )
          setVideoPreview(current =>
            current?.gfsUri === preview.gfsUri && !current.unavailable
              ? { ...current, unavailable: true, reloadVersion: current.reloadVersion + 1 }
              : current
          )
        }
        revalidationTasks.push(
          Promise.all<ResolvedPreviewUpdate | null>(
            previews.map(async preview => {
              try {
                const resolved = (await apiGet(
                  '/api/v1/gfs/resolve',
                  { uri: preview.gfsUri },
                  { signal }
                )) as {
                  kind: string
                  name: string
                  bytes: number
                  version: number
                  rid: string
                  resourceId: string
                  gfsUri: string
                }
                if (signal.aborted || generation !== previewRefreshGenerationRef.current)
                  return null
                if (resolved.kind !== 'file') {
                  markUnavailable(preview)
                  return null
                }
                const imageMimeType = gfsImagePreviewMimeType(resolved.name)
                const videoMimeType = gfsVideoPreviewMimeType(resolved.name)
                let candidate: ResolvedPreviewUpdate | null = null
                if (preview.kind === 'image') {
                  candidate = imageMimeType
                    ? {
                        kind: 'image',
                        gfsUri: resolved.gfsUri,
                        byteLength: resolved.bytes,
                        fileName: resolved.name,
                        rid: resolved.rid,
                        version: resolved.version,
                        mimeType: imageMimeType,
                        reloadVersion: preview.reloadVersion + 1,
                        unavailable: false,
                      }
                    : null
                } else if (preview.kind === 'video') {
                  candidate = videoMimeType
                    ? {
                        kind: 'video',
                        gfsUri: resolved.gfsUri,
                        byteLength: resolved.bytes,
                        fileName: resolved.name,
                        rid: resolved.rid,
                        version: resolved.version,
                        mimeType: videoMimeType,
                        reloadVersion: preview.reloadVersion + 1,
                        unavailable: false,
                      }
                    : null
                } else {
                  candidate = isGfsMarkdownPreviewFile(resolved.name)
                    ? {
                        kind: 'markdown',
                        gfsUri: resolved.gfsUri,
                        byteLength: resolved.bytes,
                        fileName: resolved.name,
                        rid: resolved.rid,
                        version: resolved.version,
                        reloadVersion: preview.reloadVersion + 1,
                        unavailable: false,
                      }
                    : null
                }
                if (!candidate) {
                  markUnavailable(preview)
                  return null
                }
                if (candidate.version < preview.version) return null
                const candidateMimeType = 'mimeType' in candidate ? candidate.mimeType : undefined
                const currentMimeType = 'mimeType' in preview ? preview.mimeType : undefined
                const unchanged =
                  !preview.unavailable &&
                  candidate.kind === preview.kind &&
                  candidate.gfsUri === preview.gfsUri &&
                  candidate.rid === preview.rid &&
                  candidate.fileName === preview.fileName &&
                  candidate.byteLength === preview.byteLength &&
                  candidate.version === preview.version &&
                  candidateMimeType === currentMimeType
                return unchanged ? null : candidate
              } catch (error) {
                if (signal.aborted || generation !== previewRefreshGenerationRef.current)
                  return null
                const status = entityChangeErrorStatus(error)
                if (status === 403 || status === 404) markUnavailable(preview)
                if (isTransientEntityChangeRefetchError(error)) scheduleRecovery()
                return null
              }
            })
          ).then(updates => {
            if (signal.aborted || generation !== previewRefreshGenerationRef.current) return
            for (const update of updates) {
              if (!update) continue
              if (update.kind === 'image') {
                setImagePreview(current => (current?.gfsUri === update.gfsUri ? update : current))
                setMarkdownPreview(current => (current?.gfsUri === update.gfsUri ? null : current))
                setVideoPreview(current => (current?.gfsUri === update.gfsUri ? null : current))
              } else if (update.kind === 'video') {
                setVideoPreview(current => (current?.gfsUri === update.gfsUri ? update : current))
                setImagePreview(current => (current?.gfsUri === update.gfsUri ? null : current))
                setMarkdownPreview(current => (current?.gfsUri === update.gfsUri ? null : current))
              } else {
                setMarkdownPreview(current =>
                  current?.gfsUri === update.gfsUri ? update : current
                )
                setImagePreview(current => (current?.gfsUri === update.gfsUri ? null : current))
                setVideoPreview(current => (current?.gfsUri === update.gfsUri ? null : current))
              }
            }
          })
        )
      }
      const visibleCrumb = currentCrumbRef.current
      if (!visibleCrumb) {
        await Promise.all(revalidationTasks)
        return
      }
      // Stream-triggered reads have their own non-destructive path. They never
      // enter the navigation/paging loader or clear its rows, dialogs, or error.
      revalidationTasks.push(refreshVisibleDirectory(visibleCrumb, signal))
      if (isDriveRootCrumb(visibleCrumb)) {
        await Promise.all(revalidationTasks)
        return
      }

      const visibleResourceId = visibleCrumb.id
      const generation = ++hierarchyRefreshGenerationRef.current
      const trailEpoch = trailReconstructionEpochRef.current
      const hierarchyRefresh = (async () => {
        const rootCrumb = {
          ...(isDriveRootCrumb(crumbsRef.current[0])
            ? crumbsRef.current[0]!
            : createDriveRootCrumb()),
        }
        const hierarchy = await resolveGfsHierarchy({
          readCurrent: () =>
            apiGet(
              '/api/v1/gfs/resolve',
              { uri: `gfs://${DRIVE}/${visibleCrumb.rid ?? ridOfResourceId(visibleResourceId)}` },
              { signal }
            ) as Promise<GfsResolvedLocation>,
          readAncestor: path =>
            apiGet(
              '/api/v1/gfs/by-path',
              { drive: DRIVE, path },
              { signal }
            ) as Promise<GfsResolvedLocation>,
          isTransient: isTransientEntityChangeRefetchError,
        })
        if (
          generation !== hierarchyRefreshGenerationRef.current ||
          signal.aborted ||
          trailEpoch !== trailReconstructionEpochRef.current ||
          currentCrumbRef.current?.id !== visibleResourceId
        ) {
          return
        }
        if (hierarchy.kind === 'missing') {
          // Only denial of the stable-ID current-folder resolve is authority
          // to leave this location. A failed ancestor lookup is not revocation.
          setCrumbs([rootCrumb])
          setTrailRecovery(null)
          return
        }
        if (hierarchy.kind === 'retry' || hierarchy.kind === 'preserve') {
          setTrailRecovery(previous =>
            previous?.resourceId === visibleResourceId && previous.reason === 'hierarchy'
              ? previous
              : {
                  resourceId: visibleResourceId,
                  gfsUri:
                    visibleCrumb.gfsUri ??
                    `gfs://${DRIVE}/${visibleCrumb.rid ?? ridOfResourceId(visibleResourceId)}`,
                  reason: 'hierarchy',
                }
          )
          if (hierarchy.kind === 'retry') scheduleRecovery()
          return
        }
        const refreshed = [rootCrumb, ...hierarchy.ancestors.map(folderResourceToCrumb)]
        if (!sameCrumbTrail(crumbsRef.current, refreshed)) setCrumbs(refreshed)
        setTrailRecovery(null)
      })()
      revalidationTasks.push(hierarchyRefresh)
      await Promise.all(revalidationTasks)
    }

    async function consume(): Promise<void> {
      while (active && !controller.signal.aborted) {
        try {
          const cursor = streamCursorRef.current
          const response = await fetch(entityChangeStreamUrl(cursor), {
            cache: 'no-store',
            credentials: 'include',
            headers: { accept: 'application/x-ndjson' },
            signal: controller.signal,
          })
          if (response.status === 401) {
            active = false
            handleControlUIUnauthorized()
            return
          }
          if (!response.ok || !response.body) {
            const error = new Error(`Entity-change stream returned ${response.status}`) as Error & {
              retryAfterMs?: number
            }
            error.retryAfterMs = parseEntityChangeRetryAfterMs(response.headers.get('retry-after'))
            throw error
          }
          retryDelay = 500
          const reader = response.body.getReader()
          const liveness = watchEntityChangeStreamLiveness(() => {
            void reader.cancel().catch(() => undefined)
          })
          const decoder = new TextDecoder()
          let pending = ''
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              pending += decoder.decode(value, { stream: true })
              let newline = pending.indexOf('\n')
              while (newline >= 0) {
                const line = pending.slice(0, newline).replace(/\r$/, '')
                pending = pending.slice(newline + 1)
                const frame = parseEntityChangeFrame(line)
                if (line.trim()) liveness.receivedFrame()
                if (!frame) {
                  newline = pending.indexOf('\n')
                  continue
                }
                streamCursorRef.current = frame.cursor
                if (frame.type === 'resync_required' || frame.type === 'scope.invalidated') {
                  invalidateVisibleState(frame.cursor)
                } else if (frame.type === 'stream.closing') {
                  await reader.cancel()
                  if (frame.reason === 'session_expired') {
                    active = false
                    handleControlUIUnauthorized()
                    return
                  }
                  break
                }
                newline = pending.indexOf('\n')
              }
              if (pending.length > ENTITY_CHANGE_MAX_FRAME_CHARS) {
                throw new Error('Entity-change frame exceeded its limit')
              }
            }
          } finally {
            liveness.dispose()
            // A malformed or unsupported frame exits through the outer retry
            // path. Releasing the lock alone leaves the HTTP response alive,
            // consuming a server stream slot while the next connection opens.
            await reader.cancel().catch(() => undefined)
            reader.releaseLock()
          }
          if (!controller.signal.aborted) throw new Error('Entity-change stream ended')
        } catch (error) {
          if (!active || controller.signal.aborted) return
          // A transport failure is not evidence that authorization or resource
          // state changed. The feed cursor remains authoritative for recovery;
          // preserve visible state and reconnect with bounded backoff.
          const retryAfterMs =
            error &&
            typeof error === 'object' &&
            typeof (error as { retryAfterMs?: unknown }).retryAfterMs === 'number'
              ? (error as { retryAfterMs: number }).retryAfterMs
              : undefined
          await new Promise<void>(resolve => {
            retryTimer = setTimeout(
              resolve,
              Math.max(retryDelay + Math.random() * retryDelay, retryAfterMs ?? 0)
            )
          })
          retryTimer = null
          retryDelay = Math.min(retryDelay * 2, 15_000)
        }
      }
    }

    void consume()
    return () => {
      active = false
      controller.abort()
      revalidationScheduler.dispose()
      entityChangeRefetchControllerRef.current?.abort()
      entityChangeRefetchControllerRef.current = null
      requestStreamRevalidationRef.current = () => undefined
      if (retryTimer) clearTimeout(retryTimer)
      if (recoveryTimer) clearTimeout(recoveryTimer)
    }
  }, [load])

  useEffect(() => {
    if ((!selected && !renameTarget) || imagePreview || markdownPreview || videoPreview) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      setSelected(null)
      setRenameTarget(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [imagePreview, markdownPreview, renameTarget, selected, videoPreview])

  function openDirectory(child: GfsChild): void {
    if (child.kind !== 'directory') return
    setRenameTarget(null)
    setCrumbs(prev => [...prev, folderResourceToCrumb(child)])
    const cached = childCacheRef.current.get(child.resourceId)
    if (cached) {
      // Render the cached listing instantly; the effect-driven background
      // revalidation refreshes in place if the server state diverged, so the
      // user gets fresh data without a loading spinner (decision table above).
      setItems(sortChildrenWithDirectoriesFirst(cached.items))
      setNextCursor(cached.nextCursor)
      loadedPageCountRef.current = cached.loadedPageCount ?? 1
      setError('')
      setLoading(false)
      revalidateNextLoadRef.current = true
      return
    }
    setLoading(true)
  }

  function openFilePreview(child: GfsChild): boolean {
    if (child.kind === 'directory') return false
    const mimeType = gfsImagePreviewMimeType(child.name)
    if (mimeType) {
      setImagePreview({
        kind: 'image',
        gfsUri: child.gfsUri,
        byteLength: child.bytes,
        fileName: child.name,
        mimeType,
        rid: child.rid,
        version: child.version,
        reloadVersion: 0,
        unavailable: false,
      })
      return true
    }
    if (isGfsMarkdownPreviewFile(child.name)) {
      setMarkdownPreview({
        kind: 'markdown',
        gfsUri: child.gfsUri,
        byteLength: child.bytes,
        fileName: child.name,
        rid: child.rid,
        version: child.version,
        reloadVersion: 0,
        unavailable: false,
      })
      return true
    }
    const videoMimeType = gfsVideoPreviewMimeType(child.name)
    if (videoMimeType) {
      setVideoPreview({
        kind: 'video',
        gfsUri: child.gfsUri,
        byteLength: child.bytes,
        fileName: child.name,
        mimeType: videoMimeType,
        rid: child.rid,
        version: child.version,
        reloadVersion: 0,
        unavailable: false,
      })
      return true
    }
    return false
  }

  function goToCrumb(index: number): void {
    if (index === crumbs.length - 1) return
    // A navigation that leaves the current trail supersedes any in-flight
    // breadcrumb reconstruction (R7-M1): its late response must not re-anchor
    // a trail the operator just navigated away from.
    trailReconstructionEpochRef.current += 1
    setRenameTarget(null)
    setLoading(true)
    setCrumbs(crumbs.slice(0, index + 1))
  }

  async function copyGfsUri(uri: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(uri)
      showToast('EvenDrive link copied.', { tone: 'success' })
    } catch {
      showToast('Could not copy the EvenDrive link.', { tone: 'error' })
    }
  }

  async function refreshCurrent(): Promise<void> {
    if (!current) return
    await load(current)
  }

  /** Refresh whatever folder is LIVE on screen, read at call time. Async
   *  drag work must use this: a render-time `current` can name a folder the
   *  operator navigated away from while the work was in flight, and loading
   *  it would clear-and-discard against the visible listing. */
  async function refreshLiveCurrent(): Promise<void> {
    const liveCrumb = currentCrumbRef.current
    if (!liveCrumb) return
    await load(liveCrumb)
  }

  function handleResourceDragStart(event: React.DragEvent<HTMLLIElement>, child: GfsChild): void {
    // Files AND folders drag (rev-2 D2); an in-flight move freezes sources.
    if (movingResourceRef.current) {
      event.preventDefault()
      return
    }
    // A newer gesture supersedes every pending admission read and any
    // confirmation still open from an older one (plan §3.4).
    dragGestureEpochRef.current += 1
    setConfirmMoveTarget(null)
    dragSourceParentIdRef.current = currentCrumbRef.current?.id ?? null
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(GFS_RESOURCE_DRAG_TYPE, child.resourceId)
    event.dataTransfer.setData('text/plain', child.name)
    draggingResourceRef.current = child
    setDraggingResourceId(child.resourceId)
  }

  function handleResourceDragEnd(): void {
    // Presentation-only: an accepted drop's async admission/commit keeps
    // running under the same gesture epoch (plan §3.4 — dragend must not
    // cancel its own accepted drop).
    draggingResourceRef.current = null
    setDraggingResourceId(null)
    setDragOverFolderId(null)
    setDragOverCrumbIndex(null)
  }

  /** Trail observed ancestors of the SOURCE: the physical parent (the
   *  current folder) plus every crumb above it. */
  function knownSourceAncestorIdsForCurrentTrail(): Set<string> {
    const ids = new Set<string>()
    for (const crumb of crumbsRef.current) {
      if (crumb.id) ids.add(crumb.id)
    }
    return ids
  }

  /** Nearest-first ancestor chain of a breadcrumb target, observed through
   *  the live trail. The trailing null marks the chain walked to the
   *  physical drive root (the trail always starts there, hydrated or not). */
  function crumbTargetAncestorIds(index: number): (string | null)[] {
    const chain: (string | null)[] = []
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const crumb = crumbsRef.current[cursor]
      chain.push(crumb?.id ?? null)
    }
    chain.push(null)
    return chain
  }

  /** Nearest-first ancestor chain of a listing ROW target: its parent (the
   *  current folder) plus the trail above, observed to the physical root. */
  function rowTargetAncestorIds(): (string | null)[] {
    const chain: (string | null)[] = [currentCrumbRef.current?.id ?? null]
    for (let cursor = crumbsRef.current.length - 2; cursor >= 0; cursor -= 1) {
      const crumb = crumbsRef.current[cursor]
      chain.push(crumb?.id ?? null)
    }
    chain.push(null)
    return chain
  }

  function rowHoverVerdict(source: GfsChild, folder: GfsChild): GfsDropHoverVerdict | null {
    if (folder.kind !== 'directory' && folder.resourceId !== source.resourceId) return null
    return computeGfsDropHoverVerdict({
      drive: DRIVE,
      sourceResourceId: source.resourceId,
      sourceKind: source.kind === 'file' ? 'file' : 'directory',
      sourceParentKnown: (currentCrumbRef.current?.id ?? null) !== null,
      sourceParentResourceId: currentCrumbRef.current?.id ?? null,
      targetResourceId: folder.resourceId,
      targetName: folder.name,
      targetIsActiveLocation: false,
      targetIsSourceParent: false,
      targetAncestorIds: rowTargetAncestorIds(),
      knownSourceAncestorIds: knownSourceAncestorIdsForCurrentTrail(),
    })
  }

  function crumbHoverVerdict(source: GfsChild, index: number): GfsDropHoverVerdict | null {
    const crumb = crumbsRef.current[index]
    if (!crumb) return null
    const parentId = dragSourceParentIdRef.current
    return computeGfsDropHoverVerdict({
      drive: DRIVE,
      sourceResourceId: source.resourceId,
      sourceKind: source.kind === 'file' ? 'file' : 'directory',
      sourceParentKnown: parentId !== null,
      sourceParentResourceId: parentId,
      targetResourceId: crumb.id,
      targetName: isDriveRootCrumb(crumb) ? DRIVE : crumb.name,
      targetIsActiveLocation: index === crumbsRef.current.length - 1,
      targetIsSourceParent:
        parentId !== null
          ? crumb.id === parentId
          : isDriveRootCrumb(crumb) && dragSourceParentIdRef.current === null,
      targetAncestorIds: crumbTargetAncestorIds(index),
      knownSourceAncestorIds: knownSourceAncestorIdsForCurrentTrail(),
    })
  }

  /** Internal directory drops stay DELIVERABLE even for an observed refusal,
   *  so release can present the reason (UX matrix §5.3). Admission still
   *  refuses the mutation. */
  function deliverInternalMoveDrag(event: React.DragEvent<HTMLElement>): boolean {
    if (!hasDraggedGfsResource(event)) return false
    if (!draggingResourceRef.current) return false
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    return true
  }

  function handleFolderDragOver(event: React.DragEvent<HTMLLIElement>, folder: GfsChild): void {
    const source = draggingResourceRef.current
    if (!hasDraggedGfsResource(event) || !source) return
    // Self and directory targets stay deliverable and painted; a plain file
    // row is not a move destination and keeps today's pass-through.
    if (folder.kind !== 'directory' && folder.resourceId !== source.resourceId) return
    deliverInternalMoveDrag(event)
    setDragOverFolderId(folder.resourceId)
  }

  function handleFolderDragEnter(event: React.DragEvent<HTMLLIElement>, folder: GfsChild): void {
    handleFolderDragOver(event, folder)
  }

  function handleFolderDragLeave(event: React.DragEvent<HTMLLIElement>): void {
    if (!hasDraggedGfsResource(event)) return
    event.preventDefault()
    event.stopPropagation()
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDragOverFolderId(null)
    }
  }

  function handleCrumbDragOver(event: React.DragEvent<HTMLButtonElement>, index: number): void {
    const source = draggingResourceRef.current
    if (!hasDraggedGfsResource(event) || !source) return
    deliverInternalMoveDrag(event)
    setDragOverCrumbIndex(index)
  }

  function handleCrumbDragEnter(event: React.DragEvent<HTMLButtonElement>, index: number): void {
    handleCrumbDragOver(event, index)
  }

  function handleCrumbDragLeave(event: React.DragEvent<HTMLButtonElement>, index: number): void {
    if (!hasDraggedGfsResource(event)) return
    event.preventDefault()
    event.stopPropagation()
    if (
      dragOverCrumbIndex === index &&
      !event.currentTarget.contains(event.relatedTarget as Node | null)
    ) {
      setDragOverCrumbIndex(null)
    }
  }

  function handleCrumbDrop(
    event: React.DragEvent<HTMLButtonElement>,
    crumb: Crumb,
    index: number
  ): void {
    if (!hasDraggedGfsResource(event)) return
    // Stop propagation/default FIRST so the upload container can never
    // process an internal crumb drop (plan §3.4).
    event.preventDefault()
    event.stopPropagation()
    setDragOverCrumbIndex(null)
    const source = draggingResourceRef.current
    if (!source) return
    const epoch = dragGestureEpochRef.current
    // EVERY same-parent/no-op fact is computed synchronously HERE, against
    // the trail as dropped on (R7): a reconstruction landing while admission
    // awaits must never turn a captured ancestor index into the live active
    // index and falsely refuse same-parent. Nothing after an await may read
    // live trail state for these checks.
    const parentId = dragSourceParentIdRef.current
    const sameParentDrop =
      index === crumbsRef.current.length - 1 ||
      (parentId !== null ? crumb.id === parentId : isDriveRootCrumb(crumb) && parentId === null)
    void admitCrumbDropMove(source, crumb, sameParentDrop, epoch)
  }

  /** Refuse a drop honestly: matrix wording, reason tone, no mutation. */
  function refuseDropMove(
    reason: GfsDropRefusalReason,
    names: { sourceName?: string; targetName?: string }
  ): void {
    showToast(gfsDropRefusalMessage(reason, names), {
      tone: gfsDropRefusalTone(reason),
    })
  }

  /** Matrix A11: a 401 from the drag pipeline's own reads. The API layer's
   *  unauthorized boundary has already run (global auth-error handler); this
   *  surfaces the session loss persistently for this surface instead of a
   *  connection-flavored warning. */
  function raiseSessionLostNotice(): void {
    setSessionLost(true)
  }

  /** True when a read error is an authentication expiry: either the API
   *  layer's AuthExpiredError or a raw 401 status (tests and non-GET paths). */
  function isUnauthorizedRead(error: unknown): boolean {
    return error instanceof AuthExpiredError || entityChangeErrorStatus(error) === 401
  }

  /** One bounded read to (re)hydrate the drive root's resource identity.
   *  A 401 stays session-lost (matrix A11): the persistent sign-in alert is
   *  raised and the caller must NOT report a connection warning. */
  async function hydrateDriveRootIdentity(
    epoch: number
  ): Promise<{ kind: 'hydrated'; rootId: string } | { kind: 'session-lost' } | { kind: 'failed' }> {
    try {
      const page = (await apiGet('/api/v1/gfs/tree', { drive: DRIVE })) as TreePage
      if (!page.rootResourceId || !isGestureEpochCurrent(epoch)) return { kind: 'failed' }
      const rootRid = ridOfResourceId(page.rootResourceId)
      setCrumbs(prev => {
        const root = prev[0]
        if (!isDriveRootCrumb(root)) return prev
        if (root.id === page.rootResourceId && root.rid === rootRid) return prev
        return [{ ...root, id: page.rootResourceId, rid: rootRid }, ...prev.slice(1)]
      })
      return { kind: 'hydrated', rootId: page.rootResourceId }
    } catch (error) {
      if (isUnauthorizedRead(error)) {
        raiseSessionLostNotice()
        return { kind: 'session-lost' }
      }
      return { kind: 'failed' }
    }
  }

  /** Immutable destination capture for a breadcrumb target, synchronously
   *  derivable from the crumb. Null for the not-yet-hydrated root. */
  function crumbToMoveDestination(crumb: Crumb): GfsMoveDestination | null {
    if (isDriveRootCrumb(crumb)) {
      if (!crumb.id || !crumb.rid) return null
      return {
        resourceId: crumb.id,
        rid: crumb.rid,
        name: DRIVE,
        kind: 'directory',
        gfsUri: `gfs://${DRIVE}/${crumb.rid}`,
        path: '/',
        origin: 'crumb',
      }
    }
    if (!crumb.id) return null
    const gfsUri = crumb.gfsUri ?? (crumb.rid ? `gfs://${DRIVE}/${crumb.rid}` : null)
    return {
      resourceId: crumb.id,
      rid: crumb.rid,
      name: crumb.name,
      kind: 'directory',
      gfsUri,
      path: null,
      ...(crumb.version !== undefined ? { version: crumb.version } : {}),
      origin: 'crumb',
    }
  }

  function rowToMoveDestination(folder: GfsChild): GfsMoveDestination {
    return {
      resourceId: folder.resourceId,
      rid: folder.rid,
      name: folder.name,
      kind: 'directory',
      gfsUri: folder.gfsUri,
      path: folder.path,
      ...(folder.version !== undefined ? { version: folder.version } : {}),
      origin: 'row',
    }
  }

  async function admitCrumbDropMove(
    source: GfsChild,
    crumb: Crumb,
    sameParentDrop: boolean,
    epoch: number
  ): Promise<void> {
    // 1. Destination identity. The unhydrated root retries resolution here
    //    (plan §3.1); a failed retry warns honestly and dispatches nothing,
    //    and a session-lost retry raises the sign-in alert instead.
    let destination = crumbToMoveDestination(crumb)
    if (!destination) {
      const hydration = await hydrateDriveRootIdentity(epoch)
      if (!isGestureEpochCurrent(epoch)) return
      if (hydration.kind === 'session-lost') return
      if (hydration.kind === 'failed') {
        refuseDropMove('unavailable', { targetName: DRIVE })
        return
      }
      destination = {
        resourceId: hydration.rootId,
        rid: ridOfResourceId(hydration.rootId),
        name: DRIVE,
        kind: 'directory',
        gfsUri: `gfs://${DRIVE}/${ridOfResourceId(hydration.rootId)}`,
        path: '/',
        origin: 'crumb',
      }
    }
    // 2. Identity/no-op checks from the drop-boundary capture — the boolean
    //    was computed synchronously at drop, never from live trail state.
    if (destination.resourceId === source.resourceId) {
      refuseDropMove('self', { sourceName: source.name, targetName: destination.name })
      return
    }
    if (sameParentDrop) {
      refuseDropMove('same-parent', {
        sourceName: source.name,
        targetName: destination.name,
      })
      return
    }
    // 3. Fresh-path structural admission: both endpoints re-resolved by
    //    immutable URI; failed resolution prevents dispatch with honest
    //    feedback, a missing path defers to the atomic server guard.
    const admitted = await admitMoveEndpoints(source, destination, epoch)
    if (!admitted.ok) {
      if (admitted.sessionLost) return
      if (admitted.refusal) {
        refuseDropMove(admitted.refusal.reason, {
          sourceName: source.name,
          targetName: destination.name,
        })
      }
      return
    }
    // 4. ONE confirmation for both files and folders (plan §3.2).
    openMoveConfirmation(source, destination, epoch, dragSourceParentIdRef.current)
  }

  /** Fresh endpoint resolution + structural check shared by row and crumb
   *  admissions. `refusal` is set for every honest refusal; `sessionLost`
   *  outranks it (the persistent sign-in alert was already raised);
   *  ok=true means the move is structurally admissible (observed or
   *  deferred to the server guard). */
  async function admitMoveEndpoints(
    source: GfsChild,
    destination: GfsMoveDestination,
    epoch: number
  ): Promise<{
    ok: boolean
    refusal?: { reason: GfsDropRefusalReason }
    sessionLost?: boolean
  }> {
    if (!destination.gfsUri) return { ok: false, refusal: { reason: 'unavailable' } }
    const [sourceRead, targetRead] = await Promise.all([
      resolveEndpointView(source.gfsUri, source.resourceId),
      resolveEndpointView(destination.gfsUri, destination.resourceId),
    ])
    if (!isGestureEpochCurrent(epoch)) return { ok: false }
    if (sourceRead.status === 'unauthorized' || targetRead.status === 'unauthorized') {
      raiseSessionLostNotice()
      return { ok: false, sessionLost: true }
    }
    if (sourceRead.status === 'missing' || sourceRead.status === 'mismatched') {
      return { ok: false, refusal: { reason: 'source-location-unknown' } }
    }
    if (sourceRead.status === 'failed') return { ok: false, refusal: { reason: 'unavailable' } }
    if (targetRead.status === 'missing' || targetRead.status === 'mismatched') {
      return { ok: false, refusal: { reason: 'target-unavailable' } }
    }
    if (targetRead.status === 'failed') return { ok: false, refusal: { reason: 'unavailable' } }
    if (targetRead.view.kind !== 'directory') {
      return { ok: false, refusal: { reason: 'target-unavailable' } }
    }
    const targetPath = destination.path === '/' ? '/' : targetRead.view.path
    const structure = decideDragPathStructure({
      sourcePath: sourceRead.view.path,
      targetPath,
    })
    if (structure.kind === 'deny') {
      return { ok: false, refusal: { reason: structure.reason } }
    }
    return { ok: true }
  }

  /** Seed the confirmation dialog exactly like the row path: the same cache
   *  the numbered-name ladder will consult. */
  function openMoveConfirmation(
    source: GfsChild,
    destination: GfsMoveDestination,
    epoch: number,
    oldParentId: string | null
  ): void {
    const occupiedNames = new Set<string>(
      (childCacheRef.current.get(destination.resourceId)?.items ?? []).map(item => item.name)
    )
    const suggested =
      occupiedNames.size > 0 && occupiedNames.has(source.name)
        ? nextAvailableGfsResourceName(source.name, occupiedNames)
        : undefined
    setConfirmMoveTarget({
      source,
      destination,
      ...(suggested !== undefined ? { suggestedName: suggested } : {}),
      epoch,
      oldParentId,
    })
  }

  /** GET /gfs/resolve by immutable URI, classified for admission/commit.
   *  `expectedResourceId` turns an identity drift (the immutable URI now
   *  resolves to a different resource id) into an explicit mismatch, and a
   *  401 stays session-lost (matrix A11) instead of reading as a connection
   *  failure. The API layer's own unauthorized boundary (global auth-error
   *  handler + AuthExpiredError) remains untouched. */
  async function resolveEndpointView(
    uri: string,
    expectedResourceId?: string
  ): Promise<GfsEndpointRead> {
    try {
      const view = (await apiGet('/api/v1/gfs/resolve', { uri })) as GfsResolvedEndpointView
      if (expectedResourceId && view.resourceId !== expectedResourceId) {
        return { status: 'mismatched' }
      }
      return { status: 'resolved', view }
    } catch (error) {
      if (isUnauthorizedRead(error)) return { status: 'unauthorized' }
      if (entityChangeErrorStatus(error) === 404) return { status: 'missing' }
      return { status: 'failed' }
    }
  }

  async function handleFolderDrop(
    event: React.DragEvent<HTMLLIElement>,
    folder: GfsChild
  ): Promise<void> {
    if (!hasDraggedGfsResource(event)) return
    event.preventDefault()
    event.stopPropagation()
    setDragOverFolderId(null)
    const source = draggingResourceRef.current
    if (!source) return
    const epoch = dragGestureEpochRef.current
    if (source.resourceId === folder.resourceId) {
      refuseDropMove('self', { sourceName: source.name, targetName: folder.name })
      return
    }
    const destination = rowToMoveDestination(folder)
    if (source.kind === 'file') {
      // Files cannot be ancestors: no structural risk; move directly — the
      // commit runner still re-resolves both endpoints before dispatch.
      await moveResource(source, destination, {
        revalidate: { epoch, oldParentId: dragSourceParentIdRef.current },
      })
      return
    }
    // Folder drops stop at ONE confirmation (rev-2 §1) after the fresh-path
    // structural guard — the impact dialog also records the naming policy.
    const admitted = await admitMoveEndpoints(source, destination, epoch)
    if (!admitted.ok) {
      if (admitted.sessionLost) return
      if (admitted.refusal) {
        refuseDropMove(admitted.refusal.reason, {
          sourceName: source.name,
          targetName: destination.name,
        })
      }
      return
    }
    openMoveConfirmation(source, destination, epoch, dragSourceParentIdRef.current)
  }

  async function moveResource(
    source: GfsChild,
    destination: Pick<GfsChild, 'resourceId' | 'name' | 'kind'> & {
      gfsUri?: string
      path?: string | null
    },
    options: {
      bubbleError?: boolean
      allowNumberedRename?: boolean
      /**
       * Names the caller already knows the destination holds (the Move
       * dialog loads them while it shows the destination tree). They are
       * merged into the ladder seed, so a destination the browser's children
       * cache never saw does not cost three blind attempts on names that
       * are already taken (RP-003).
       */
      occupiedNames?: readonly string[]
      /**
       * Drag commits re-resolve BOTH endpoints by immutable URI immediately
       * before dispatch (plan §3.4): validate returned identity and
       * destination kind, use the fresh source version, and stop without
       * dispatching when the gesture epoch was superseded. The keyboard Move
       * dialog keeps its established single-read behavior.
       */
      revalidate?: {
        epoch: number
        /**
         * The physical old parent observed at the drag boundary, used for
         * convergence invalidation — never a response-time guess at what
         * folder held the source.
         */
        oldParentId: string | null
      }
    } = {}
  ): Promise<void> {
    const { bubbleError = false, allowNumberedRename = true } = options
    if (
      destination.kind !== 'directory' ||
      source.resourceId === destination.resourceId ||
      movingResourceRef.current
    ) {
      return
    }

    movingResourceRef.current = source.resourceId
    setMovingResourceId(source.resourceId)
    try {
      let ifMatchVersion = source.version
      let verifiedDestinationPath: string | null = null
      if (options.revalidate) {
        const epoch = options.revalidate.epoch
        if (!isGestureEpochCurrent(epoch)) return
        const sourceRead = await resolveEndpointView(source.gfsUri, source.resourceId)
        if (!isGestureEpochCurrent(epoch)) return
        if (sourceRead.status === 'unauthorized') {
          raiseSessionLostNotice()
          return
        }
        if (sourceRead.status === 'missing' || sourceRead.status === 'mismatched') {
          throw new GfsMoveRefusalError(
            'source-location-unknown',
            gfsDropRefusalMessage('source-location-unknown', { sourceName: source.name })
          )
        }
        if (sourceRead.status === 'failed') {
          throw new GfsMoveRefusalError('unavailable', gfsDropRefusalMessage('unavailable'))
        }
        // The captured source kind must still be the resource's kind: a
        // flip means the immutable URI no longer names the captured item.
        if (sourceRead.view.kind !== source.kind) {
          throw new GfsMoveRefusalError(
            'source-location-unknown',
            gfsDropRefusalMessage('source-location-unknown', { sourceName: source.name })
          )
        }
        // Fresh-precondition contract: the dispatched ifMatch must be the
        // version the fresh authorized read just returned. A missing,
        // negative, or non-safe-integer version is NOT downgraded to the
        // stale row version — the move refuses instead.
        const freshVersion = sourceRead.view.version
        if (
          typeof freshVersion !== 'number' ||
          !Number.isSafeInteger(freshVersion) ||
          freshVersion < 0
        ) {
          throw new GfsMoveRefusalError(
            'source-precondition-unavailable',
            gfsDropRefusalMessage('source-precondition-unavailable')
          )
        }
        ifMatchVersion = freshVersion
        // The destination identity is ALWAYS revalidated through its
        // immutable URI; a cached path observation is never a substitute.
        if (!destination.gfsUri) {
          throw new GfsMoveRefusalError('unavailable', gfsDropRefusalMessage('unavailable'))
        }
        const targetRead = await resolveEndpointView(destination.gfsUri, destination.resourceId)
        if (!isGestureEpochCurrent(epoch)) return
        if (targetRead.status === 'unauthorized') {
          raiseSessionLostNotice()
          return
        }
        if (targetRead.status === 'missing' || targetRead.status === 'mismatched') {
          throw new GfsMoveRefusalError(
            'target-unavailable',
            gfsDropRefusalMessage('target-unavailable')
          )
        }
        if (targetRead.status === 'failed') {
          throw new GfsMoveRefusalError('unavailable', gfsDropRefusalMessage('unavailable'))
        }
        if (targetRead.view.kind !== 'directory') {
          throw new GfsMoveRefusalError(
            'target-unavailable',
            gfsDropRefusalMessage('target-unavailable')
          )
        }
        verifiedDestinationPath = destination.path === '/' ? '/' : targetRead.view.path
        const structure = decideDragPathStructure({
          sourcePath: sourceRead.view.path,
          targetPath: verifiedDestinationPath,
        })
        if (structure.kind === 'deny') {
          throw new GfsMoveRefusalError(
            structure.reason,
            gfsDropRefusalMessage(structure.reason, {
              sourceName: source.name,
              targetName: destination.name,
            })
          )
        }
      }
      // Seed the ladder with the destination's known children (the same cache
      // the confirmation suggestion came from, plus whatever the caller
      // observed) so the first 409 skips every already-taken numbered name
      // instead of guessing it blind.
      const occupiedNames = new Set<string>([
        ...(childCacheRef.current.get(destination.resourceId)?.items ?? []).map(item => item.name),
        ...(options.occupiedNames ?? []),
      ])
      let moveName = source.name
      let moved = false
      let moveResult: unknown
      // rev-2 §5: at most three network attempts per gesture under an
      // approved numbered-name policy; a single attempt otherwise.
      const maxAttempts = allowNumberedRename ? GFS_MOVE_MAX_NETWORK_ATTEMPTS : 1
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        // The gesture must still own the dispatch the instant the PATCH
        // leaves (plan §3.4); an already-dispatched request is never recalled.
        if (options.revalidate && !isGestureEpochCurrent(options.revalidate.epoch)) return
        try {
          moveResult = await apiSend(
            'PATCH',
            `/api/v1/gfs/resources/${encodeURIComponent(source.resourceId)}`,
            {
              drive: DRIVE,
              newParentId: destination.resourceId,
              ifMatch: ifMatchVersion,
              ...(moveName === source.name ? {} : { newName: moveName }),
            },
            { drive: DRIVE }
          )
          moved = true
          break
        } catch (error) {
          if (!isGfsNameConflict(error)) {
            // A 401 from the PATCH itself is session loss (A11), not a
            // transient failure: raise the persistent sign-in alert and stop
            // — no ladder retry can succeed against a dead session. The API
            // layer's global unauthorized boundary has already run.
            if (isUnauthorizedRead(error)) {
              if (options.revalidate) {
                raiseSessionLostNotice()
                return
              }
              throw error
            }
            if (
              options.revalidate &&
              entityChangeErrorStatus(error) === undefined &&
              movingResourceRef.current === source.resourceId
            ) {
              // Transport loss with the request possibly dispatched: the
              // outcome is UNKNOWN. Never claim the move failed and never
              // repeat the PATCH — verify once by identity (matrix B7/B8).
              // Anything the single read cannot PROVE stays unknown: the
              // PATCH may still be executing, or another actor may have
              // moved the source, so a differing parent is not a failure
              // verdict.
              const settled = await settleUnknownTransportMove(
                source,
                destination,
                moveName,
                options.revalidate.epoch
              )
              if (!isGestureEpochCurrent(options.revalidate.epoch)) return
              if (settled === 'moved') {
                moved = true
                moveResult = undefined
                break
              }
              throw new GfsMoveRefusalError(
                'unknown-outcome',
                gfsDropRefusalMessage('unknown-outcome')
              )
            }
            throw error
          }
          if (!allowNumberedRename) {
            throw new Error(
              'An item with this name already exists. Choose another folder, or use Move to change its name.'
            )
          }
          occupiedNames.add(moveName)
          if (attempt + 1 >= maxAttempts) break
          moveName = nextAvailableGfsResourceName(source.name, occupiedNames)
        }
      }
      if (!moved) {
        // A concurrent naming storm, not "all numbered names used".
        throw new Error('The destination changed. Refresh it or choose another folder.')
      }
      const movedResource = (
        moveResult as { data?: { resourceId?: string; version?: number } } | undefined
      )?.data
      const nextVersion =
        movedResource?.resourceId && movedResource.resourceId !== source.resourceId
          ? undefined
          : movedResource?.version
      // plan §3.4 convergence: invalidate the observed OLD and NEW parent
      // listings through the shared pure planner. For drag commits the old
      // parent is the PHYSICAL source parent captured at the drag boundary —
      // never a response-time guess, because the operator may have navigated
      // while the commit was in flight. Non-drag callers (the Move dialog)
      // keep the trail-derived observation.
      const movedCrumbIndex = crumbs.findIndex(crumb => crumb.id === source.resourceId)
      const oldParentId =
        options.revalidate?.oldParentId !== undefined
          ? options.revalidate.oldParentId
          : movedCrumbIndex > 0
            ? (crumbs[movedCrumbIndex - 1]?.id ?? null)
            : (currentCrumbRef.current?.id ?? null)
      const childParentByResourceId = new Map<string, string | null>()
      for (const [folderId, page] of childCacheRef.current.entries()) {
        for (const item of page.items) childParentByResourceId.set(item.resourceId, folderId)
      }
      const convergence = planMoveConvergence(
        { resourceId: source.resourceId, oldParentId, newParentId: destination.resourceId },
        { childParentByResourceId }
      )
      for (const staleFolderId of convergence.refetchChildIds) {
        childCacheRef.current.delete(staleFolderId)
      }
      showToast(
        moveName === source.name
          ? `Moved "${source.name}" to "${destination.name}".`
          : `Moved "${source.name}" to "${destination.name}" as "${moveName}".`,
        { tone: 'success' }
      )
      if (source.kind === 'directory') {
        showToast(
          'Moving a folder changes who can access its contents — access now follows the new location.',
          { tone: 'info' }
        )
      }
      // A move changes the moved folder's ANCESTRY. When the moved resource
      // is part of the open breadcrumb trail, patching only its own crumb
      // would leave every crumb above it describing the OLD location (R5-M1):
      // with /org open and /org moved under /archive, the trail must become
      // main / archive / org — not stay main / org. (The old parent's cache
      // entry was already invalidated through the convergence plan above.)
      if (movedCrumbIndex >= 0) {
        // The crumb adopts the receipt metadata FIRST — this is the
        // resource's truthful post-move state. The ancestry rebuild below
        // (and any later retry of it) preserves this metadata from LIVE
        // crumb state, never from a move-time snapshot (R7-M1), so a rename
        // that lands while recovery is pending is never rolled back.
        setCrumbs(prev =>
          prev.map(crumb =>
            crumb.id === source.resourceId
              ? {
                  ...crumb,
                  name: moveName,
                  ...(nextVersion === undefined
                    ? { version: undefined }
                    : { version: nextVersion }),
                }
              : crumb
          )
        )
        const outcome = await rebuildTrailFromNewLocation(source.resourceId, source.gfsUri)
        if (outcome === 'failed') {
          // The MOVE succeeded but the trail could not be reconstructed from
          // the new location. Keep the trail the operator was looking at
          // (explicitly stale — never a shortened path presented as
          // authoritative) and surface a recovery notice with a retry until
          // reconstruction succeeds. ('applied' clears any older notice for
          // this resource inside the rebuild; 'superseded' leaves state to
          // the newer attempt that displaced this one.)
          setTrailRecovery({ resourceId: source.resourceId, gfsUri: source.gfsUri, reason: 'move' })
        }
        return
      }
      // Refresh the LIVE current location — the user stays where they are;
      // a drag move never auto-navigates to the destination (plan §3.4).
      // Reading currentCrumbRef HERE (not a render-time crumb) is what makes
      // the refresh truthful when the operator navigated while the commit
      // was in flight: the folder on screen is the one that reloads.
      await refreshLiveCurrent()
    } catch (err) {
      if (bubbleError) throw err
      if (err instanceof GfsMoveRefusalError) {
        showToast(err.message, { tone: err.tone })
      } else {
        showToast(err instanceof Error ? err.message : 'Could not move resource.', {
          tone: 'error',
        })
      }
    } finally {
      movingResourceRef.current = null
      setMovingResourceId(null)
    }
  }

  /** Resolve the outcome of a transport-lost move PATCH (matrix B7/B8) with
   *  ONE bounded read per endpoint and no repeat dispatch.
   *
   *  'moved' requires POSITIVE proof: the source resolves by immutable URI
   *  under the destination's CURRENT canonical path — re-resolved by URI so
   *  a remotely moved destination still verifies identity-correctly — AND
   *  carries the exact name this PATCH requested (or its unrenamed name).
   *  Everything else stays 'unknown': the PATCH may still be executing, the
   *  source may have been moved by another actor, or the endpoints cannot
   *  be established at all. A differing parent NEVER reads as a failure
   *  verdict, and a source resolved AT the root path ('/' — the drive root
   *  itself) can never prove a move into root landed: a moved item lives at
   *  '/<name>'. */
  async function settleUnknownTransportMove(
    source: GfsChild,
    destination: { resourceId: string; gfsUri?: string | null },
    requestedName: string,
    epoch: number
  ): Promise<'moved' | 'unknown'> {
    if (!destination.gfsUri) return 'unknown'
    const [sourceRead, targetRead] = await Promise.all([
      resolveEndpointView(source.gfsUri, source.resourceId),
      resolveEndpointView(destination.gfsUri, destination.resourceId),
    ])
    if (!isGestureEpochCurrent(epoch)) return 'unknown'
    if (sourceRead.status === 'unauthorized' || targetRead.status === 'unauthorized') {
      // The session died after the PATCH was dispatched: the move outcome
      // stays HONESTLY UNKNOWN (the PATCH may have landed first), and the
      // session loss surfaces alongside it through the persistent alert —
      // never as a connection-flavored warning.
      raiseSessionLostNotice()
      return 'unknown'
    }
    if (sourceRead.status !== 'resolved' || targetRead.status !== 'resolved') return 'unknown'
    if (targetRead.view.kind !== 'directory') return 'unknown'
    if (typeof sourceRead.view.path !== 'string' || typeof targetRead.view.path !== 'string') {
      return 'unknown'
    }
    const sourcePath = normalizeCanonicalPath(sourceRead.view.path)
    const destinationPath = normalizeCanonicalPath(targetRead.view.path)
    if (sourcePath === null || destinationPath === null) return 'unknown'
    // The drive root itself: a completed move into any folder — including
    // the root — lands at '/<name>', never at '/'.
    if (sourcePath === '/') return 'unknown'
    const parent = parentPathOf(sourcePath)
    if (parent !== destinationPath) return 'unknown'
    const leaf = sourcePath.split('/').filter(Boolean).pop()
    if ((leaf ?? '') !== requestedName) return 'unknown'
    return 'moved'
  }

  /** Rebuild the breadcrumb trail ANCESTRY for a moved trail-folder. The
   *  resolve contract answers with the folder's new `path`; every ancestor
   *  prefix is then resolved by-path so the trail reflects the new ancestor
   *  chain rather than the old one.
   *
   *  This touches ancestry ONLY: the moved crumb and every crumb below it
   *  are carried over from the LIVE trail (R7-M1), so a rename or other
   *  mutation that landed while recovery was pending keeps its newer
   *  name/version — no move-time snapshot is ever replayed.
   *
   *  Each attempt is EPOCH-VERSIONED (R7-M1 race): it may apply its result
   *  only while it is still the latest reconstruction attempt. A newer Move,
   *  reconstruction, rename, or trail-replacing navigation that lands while
   *  this attempt's requests are in flight bumps the epoch, and the stale
   *  response is then discarded whole — it can neither overwrite the newer
   *  ancestry nor clear the newer operation's recovery notice.
   *
   *  Reconstruction is ALL-OR-NOTHING: a failed leaf resolve, a null `path`,
   *  or any failed ancestor by-path lookup leaves the current trail
   *  UNTOUCHED (never a partial ancestry presented as authoritative) so the
   *  caller can surface recovery state instead. */
  async function rebuildTrailFromNewLocation(
    resourceId: string,
    gfsUri: string
  ): Promise<TrailReconstructionOutcome> {
    const epoch = ++trailReconstructionEpochRef.current
    // A displaced attempt is 'superseded' no matter how its own requests
    // settle — its verdict must never reach breadcrumb or recovery state.
    const verdict = (outcome: TrailReconstructionOutcome): TrailReconstructionOutcome =>
      epoch === trailReconstructionEpochRef.current ? outcome : 'superseded'
    let view: { path?: string | null }
    try {
      view = (await apiGet('/api/v1/gfs/resolve', { uri: gfsUri })) as {
        path?: string | null
      }
    } catch {
      return verdict('failed')
    }
    // A null path means the server could not name the new location — that is
    // a failed reconstruction, not a root-level folder ('/org' is).
    if (typeof view.path !== 'string' || view.path.length <= 1) {
      return verdict('failed')
    }
    const segments = view.path.split('/').filter(segment => segment.length > 0)
    const ancestors: Crumb[] = []
    for (let depth = 1; depth < segments.length; depth += 1) {
      let ancestor: Awaited<ReturnType<typeof getGfsResourceByPath>>
      try {
        ancestor = await getGfsResourceByPath(DRIVE, '/' + segments.slice(0, depth).join('/'))
      } catch {
        return verdict('failed')
      }
      ancestors.push(folderResourceToCrumb(ancestor))
    }
    if (epoch !== trailReconstructionEpochRef.current) return 'superseded'
    setCrumbs(prev => {
      if (epoch !== trailReconstructionEpochRef.current) return prev
      const index = prev.findIndex(crumb => crumb.id === resourceId)
      // The user navigated while the resolve walk was in flight — never
      // clobber the trail they navigated to.
      if (index < 0) return prev
      return [
        isDriveRootCrumb(prev[0]) ? prev[0]! : createDriveRootCrumb(),
        ...ancestors,
        // Live crumb state (name/version included) — see the doc note above.
        ...prev.slice(index),
      ]
    })
    // The trail is canonical for this resource as of the LATEST attempt —
    // any older recovery notice for it is obsolete.
    setTrailRecovery(null)
    return 'applied'
  }

  /** Retry a failed post-move trail ancestry reconstruction. Runs from the
   *  recovery snapshot's IMMUTABLE identity plus the live trail — never a
   *  captured name/version — so the rebuilt crumb reflects every mutation
   *  that landed since the move. The rebuild owns the notice entirely: an
   *  'applied' retry clears it (the trail is canonical again), a 'failed'
   *  retry keeps it, and a 'superseded' retry touches NOTHING — a newer
   *  Move/reconstruction owns the breadcrumb and its recovery state now. */
  async function retryTrailRecovery(): Promise<void> {
    const recovery = trailRecovery
    if (!recovery) return
    await rebuildTrailFromNewLocation(recovery.resourceId, recovery.gfsUri)
  }

  async function uploadWithCompatibility(
    input: GfsUploadJobInput
  ): Promise<'completed' | 'paused'> {
    setUploadCandidate(input.file)
    setUploadOpen(true)
    setUploading(true)
    const job = createGfsUploadJob({
      ...input,
      onProgress: progress => {
        mergeUploadProgress(progress.uploadedBytes)
        input.onProgress?.(progress)
      },
      onState: snapshot => {
        mergeUploadSnapshot(snapshot)
        input.onState?.(snapshot)
      },
      onPersistPending: record => {
        persistPendingGfsUpload({
          idempotencyKey: record.idempotencyKey,
          fileName: record.fileName,
          fileSize: record.fileSize,
          lastModified: record.lastModified,
          target: record.target,
          name: record.name,
        })
        void input.onPersistPending?.(record)
      },
      onPersist: record => {
        persistPendingGfsUpload({
          uploadId: record.uploadId,
          fileName: record.fileName,
          fileSize: record.fileSize,
          lastModified: record.lastModified,
          target: record.target,
          name: record.name,
        })
        void input.onPersist?.(record)
      },
      onClearPersisted: uploadId => {
        clearPendingGfsUpload(uploadId)
        void input.onClearPersisted?.(uploadId)
      },
    })
    uploadJobRef.current = job
    try {
      const receipt = await job.start()
      if (receipt.state === 'paused') {
        setUploading(false)
        return 'paused'
      }
      setUploadCandidate(null)
      setUploadOpen(false)
      setUploadSnapshot(null)
      uploadJobRef.current = null
      await refreshCurrent()
      return 'completed'
    } catch (error) {
      if (!(error instanceof GfsUploadCapabilityError) || !error.allowLegacyFallback) throw error
      if (input.resumeUploadId) {
        throw new GfsUploadCapabilityError(
          'The persisted resumable session cannot be resumed while EvenDrive Upload v2 is unavailable.',
          { cause: error }
        )
      }
      showToast('Resumable upload is unavailable; using the legacy 16 MiB path.', { tone: 'info' })
      await uploadGfsFileLegacy(input)
      clearPendingGfsUpload()
      setUploadCandidate(null)
      setUploadOpen(false)
      setUploadSnapshot(null)
      uploadJobRef.current = null
      await refreshCurrent()
      return 'completed'
    } finally {
      setUploading(false)
    }
  }

  function openNewFolder(): void {
    if (!current?.id) return
    setCreateFolderError(null)
    setNewFolderOpen(true)
  }

  async function createFolder(requestedName: string): Promise<void> {
    const rid = current?.rid ?? (current?.id ? ridOfResourceId(current.id) : null)
    if (!rid) return
    setCreatingFolder(true)
    setCreateFolderError(null)
    try {
      const name = await normalizeGfsResourceName(requestedName)
      await apiSend('POST', `/api/v1/gfs/proxy/v1/resources/${encodeURIComponent(rid)}/children`, {
        name,
        kind: 'directory',
      })
      showToast('Folder created.', { tone: 'success' })
      setNewFolderOpen(false)
      await refreshCurrent()
    } catch (err) {
      // Keep the modal open so the operator can adjust the name and retry.
      setCreateFolderError(err instanceof Error ? err.message : 'Could not create folder.')
    } finally {
      setCreatingFolder(false)
    }
  }

  async function uploadFile(
    file: File | null | undefined,
    occupiedNames = new Set(items.map(item => item.name))
  ): Promise<void> {
    const rid = current?.rid ?? (current?.id ? ridOfResourceId(current.id) : null)
    if (!rid || !file) return
    setUploading(true)
    let resumeUploadId: string | undefined
    let legacyFallbackAnnounced = false
    try {
      assertGfsFileUploadSize(file.size)
      const normalizedName = await normalizeGfsResourceName(file.name)
      const target = { operation: 'create' as const, parentRid: rid }
      resumeUploadId = matchingPendingResumeUploadId(file, target, normalizedName)
      const nameReservation = uploadNameReservationsRef.current.begin(
        rid,
        normalizedName,
        occupiedNames
      )
      try {
        for (let attempt = 0; attempt < GFS_UPLOAD_NAME_RETRY_LIMIT; attempt += 1) {
          const resumeUploadIdForAttempt = attempt === 0 ? resumeUploadId : undefined
          const name = nameReservation.reserveNext({ exact: Boolean(resumeUploadIdForAttempt) })

          try {
            try {
              const job = createGfsUploadJob({
                file,
                name,
                target,
                resumeUploadId: resumeUploadIdForAttempt,
                onPersistPending: record => {
                  persistPendingGfsUpload({
                    idempotencyKey: record.idempotencyKey,
                    fileName: record.fileName,
                    fileSize: record.fileSize,
                    lastModified: record.lastModified,
                    target: record.target,
                    name: record.name,
                  })
                },
                onProgress: progress => mergeUploadProgress(progress.uploadedBytes),
                onState: snapshot => mergeUploadSnapshot(snapshot),
                onPersist: record => {
                  persistPendingGfsUpload({
                    uploadId: record.uploadId,
                    fileName: record.fileName,
                    fileSize: record.fileSize,
                    lastModified: record.lastModified,
                    target: record.target,
                    name: record.name,
                  })
                },
                onClearPersisted: uploadId => clearPendingGfsUpload(uploadId),
              })
              uploadJobRef.current = job
              const receipt = await job.start()
              if (receipt.state === 'paused') {
                setUploading(false)
                return
              }
            } catch (err) {
              if (!(err instanceof GfsUploadCapabilityError) || !err.allowLegacyFallback) throw err
              if (resumeUploadIdForAttempt) {
                throw new GfsUploadCapabilityError(
                  'The persisted resumable session cannot be resumed while EvenDrive Upload v2 is unavailable.',
                  { cause: err }
                )
              }
              if (!legacyFallbackAnnounced) {
                showToast('Resumable upload is unavailable; using the legacy 16 MiB path.', {
                  tone: 'info',
                })
                legacyFallbackAnnounced = true
              }
              await uploadGfsFileLegacy({ file, name, target })
              clearPendingGfsUpload()
              setUploadCandidate(null)
              setUploadOpen(false)
              setUploadSnapshot(null)
              uploadJobRef.current = null
            }

            nameReservation.markSuccess(name)
            showToast('File uploaded.', { tone: 'success' })
            setUploadCandidate(null)
            setUploadOpen(false)
            setUploadSnapshot(null)
            uploadJobRef.current = null
            await refreshCurrent()
            return
          } catch (err) {
            if (uploadJobRef.current?.snapshot().state === 'aborted') return
            const decision = gfsUploadNameRetryDecision(err, {
              attempt,
              resuming: Boolean(resumeUploadIdForAttempt),
            })
            if (decision === 'terminal') throw err

            nameReservation.markConflict(name)
            clearPendingGfsUpload()
            uploadJobRef.current = null
            setUploadSnapshot(null)
            if (decision === 'exhausted') throw new Error(GFS_UPLOAD_NAME_EXHAUSTED_MESSAGE)
          }
        }

        throw new Error(GFS_UPLOAD_NAME_EXHAUSTED_MESSAGE)
      } finally {
        nameReservation.release()
      }
    } catch (err) {
      if (uploadJobRef.current?.snapshot().state === 'aborted') return
      showToast(err instanceof Error ? err.message : 'Could not upload file.', { tone: 'error' })
    } finally {
      setUploading(false)
    }
  }

  function handleGfsDragEnter(event: React.DragEvent<HTMLElement>): void {
    if (hasDraggedGfsResource(event)) {
      event.preventDefault()
      return
    }
    if (!hasDraggedFiles(event)) return
    event.preventDefault()
    setDragActive(true)
  }

  function handleGfsDragOver(event: React.DragEvent<HTMLElement>): void {
    if (hasDraggedGfsResource(event)) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'none'
      return
    }
    if (!hasDraggedFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = current?.id ? 'copy' : 'none'
    setDragActive(true)
  }

  function handleGfsDragLeave(event: React.DragEvent<HTMLElement>): void {
    if (hasDraggedGfsResource(event)) return
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDragActive(false)
  }

  async function handleGfsDrop(event: React.DragEvent<HTMLElement>): Promise<void> {
    if (hasDraggedGfsResource(event)) {
      event.preventDefault()
      return
    }
    if (!hasDraggedFiles(event)) return
    event.preventDefault()
    setDragActive(false)

    if (!current?.id) {
      showToast('Files cannot be uploaded until a destination folder is available.', {
        tone: 'error',
      })
      return
    }

    const droppedFiles = Array.from(event.dataTransfer.files || [])
    if (!droppedFiles.length) {
      showToast('No files were dropped.', { tone: 'error' })
      return
    }

    setDroppedUploadCount(droppedFiles.length)
    const occupiedNames = new Set(items.map(item => item.name))
    try {
      for (const file of droppedFiles) {
        await uploadFile(file, occupiedNames)
      }
    } finally {
      setDroppedUploadCount(0)
    }
  }

  function closeUploadModal(): void {
    if (uploading) return
    setUploadOpen(false)
    if (!uploadSnapshot || uploadSnapshot.state !== 'paused') {
      setUploadCandidate(null)
      uploadJobRef.current = null
      setUploadSnapshot(null)
    }
  }

  function openManage(child: GfsChild, mode?: 'delete'): void {
    setRenameTarget(null)
    setSelected(child)
    setDeleteOpen(mode === 'delete')
  }

  function openMove(child: GfsChild): void {
    setSelected(null)
    setDeleteOpen(false)
    setMoveTarget(child)
  }

  function openRowRename(child: GfsChild): void {
    setSelected(null)
    setDeleteOpen(false)
    setRenameError('')
    setRenameValid(true)
    setRenameTarget(child)
  }

  /** Adapt a folder crumb for the row-action handlers (share, rename, move,
   *  delete) so a breadcrumb menu acts on exactly the same shape a
   *  parent-view row does. Returns null for the synthetic root. */
  function crumbToChild(crumb: Crumb): GfsChild | null {
    if (!crumb.id || !crumb.rid || crumb.kind !== 'directory' || crumb.version === undefined)
      return null
    return {
      resourceId: crumb.id,
      rid: crumb.rid,
      gfsUri: crumb.gfsUri ?? `gfs://${DRIVE}/${crumb.rid}`,
      name: crumb.name,
      kind: crumb.kind,
      path: null,
      bytes: 0,
      version: crumb.version,
    }
  }

  /** Single construction path for a FOLDER's ⋯ menu. Parent-view rows and
   *  breadcrumb crumb menus both build their props here, so their option
   *  lists cannot drift apart. File-only actions stay on the file rows. */
  function folderMenuProps(folder: GfsChild) {
    return {
      resourceName: folder.name,
      resourceUri: folder.gfsUri,
      onManage: () => openManage(folder),
      onCopyLink: () => void copyGfsUri(folder.gfsUri),
      onOpenLink: () => setOpenLinkOpen(true),
      onRename: () => openRowRename(folder),
      onMove: () => openMove(folder),
      onDelete: () => openManage(folder, 'delete'),
    }
  }

  /** "Open EvenDrive link": resolve a pasted gfs:// URI through control-api
   * and navigate the breadcrumb straight to that folder, mirroring Desktop. */
  async function openEvenDriveLink(uri: string): Promise<void> {
    setOpenLinkError(null)
    setOpenLinkResolving(true)
    try {
      const view = (await apiGet('/api/v1/gfs/resolve', { uri })) as GfsResolvedLocation
      if (view.kind !== 'directory') {
        setOpenLinkError('Only folder links can be opened here.')
        return
      }
      setRenameTarget(null)
      setSelected(null)
      setDeleteOpen(false)
      // Replacing the whole trail supersedes any in-flight breadcrumb
      // reconstruction (R7-M1): its late response must not re-anchor the
      // trail this link-open just replaced.
      trailReconstructionEpochRef.current += 1
      setCrumbs(prev => [
        isDriveRootCrumb(prev[0]) ? prev[0]! : createDriveRootCrumb(),
        folderResourceToCrumb(view),
      ])
      setOpenLinkOpen(false)
    } catch (err) {
      setOpenLinkError(err instanceof Error ? err.message : 'Could not open the EvenDrive link.')
    } finally {
      setOpenLinkResolving(false)
    }
  }

  async function renameResource(child: GfsChild, requestedName: string): Promise<void> {
    if (!requestedName.trim() || renaming) return
    setRenaming(true)
    setRenameError('')
    try {
      const name = await normalizeGfsResourceName(requestedName.trim())
      if (name === child.name) {
        setRenameTarget(null)
        return
      }
      const patchResult = await apiSend(
        'PATCH',
        '/api/v1/gfs/resources/' + encodeURIComponent(child.resourceId),
        { drive: DRIVE, newName: name, ifMatch: child.version },
        { drive: DRIVE }
      )
      const nextVersion = (
        patchResult as { data?: { resourceId?: string; version?: number } } | undefined
      )?.data?.version
      showToast('Resource renamed.', { tone: 'success' })
      // A crumb rename must retitle the breadcrumb segment too, not just the
      // listing rows refreshed below. It also supersedes any in-flight
      // breadcrumb reconstruction (R7-M1): a stale retry response must not
      // land over a trail the rename just advanced.
      trailReconstructionEpochRef.current += 1
      setCrumbs(prev =>
        prev.map(crumb =>
          crumb.id === child.resourceId
            ? { ...crumb, name, ...(nextVersion === undefined ? {} : { version: nextVersion }) }
            : crumb
        )
      )
      setRenameTarget(null)
      setSelected(null)
      await refreshCurrent()
    } catch (err) {
      // The rename dialog stays open with the draft and the failure reason —
      // a toast alone gave the operator no retry path.
      setRenameError(err instanceof Error ? err.message : 'Could not rename resource.')
    } finally {
      setRenaming(false)
    }
  }

  async function replaceFile(child: GfsChild, file: File | null | undefined): Promise<void> {
    if (!file) return
    try {
      const target = {
        operation: 'replace' as const,
        resourceRid: child.rid,
        ifMatch: child.version,
      }
      const state = await uploadWithCompatibility({
        file,
        name: file.name,
        target,
        resumeUploadId: matchingPendingResumeUploadId(file, target, file.name),
      })
      if (state === 'completed') {
        showToast('File replaced.', { tone: 'success' })
        if (selected?.resourceId === child.resourceId) setSelected(null)
      } else {
        showToast('Replace paused. Resume it from the upload panel.', { tone: 'info' })
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not replace file.', { tone: 'error' })
    }
  }

  async function pauseUpload(): Promise<void> {
    const job = uploadJobRef.current
    if (!job) return
    try {
      await job.pause()
      setUploading(false)
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not pause upload.', { tone: 'error' })
    }
  }

  async function resumeUpload(): Promise<void> {
    const job = uploadJobRef.current
    if (!job) return
    setUploading(true)
    try {
      const receipt = await job.resume()
      if (receipt.state === 'completed') {
        showToast('File uploaded.', { tone: 'success' })
        setUploadCandidate(null)
        setUploadOpen(false)
        setUploadSnapshot(null)
        uploadJobRef.current = null
        await refreshCurrent()
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not resume upload.', { tone: 'error' })
    } finally {
      setUploading(false)
    }
  }

  async function cancelUpload(): Promise<void> {
    const job = uploadJobRef.current
    if (!job) {
      closeUploadModal()
      return
    }
    try {
      await job.cancel()
      setUploading(false)
      setUploadSnapshot(null)
      setUploadCandidate(null)
      setUploadOpen(false)
      uploadJobRef.current = null
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not cancel upload.', { tone: 'error' })
      setUploading(false)
    }
  }

  async function downloadFile(child: GfsChild): Promise<void> {
    if (downloadingIds.has(child.resourceId)) return
    setDownloadingIds(prev => new Set(prev).add(child.resourceId))
    try {
      await gfsDownload(child.rid, child.name)
      showToast('File downloaded.', { tone: 'success' })
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not download file.', { tone: 'error' })
    } finally {
      setDownloadingIds(prev => {
        const next = new Set(prev)
        next.delete(child.resourceId)
        return next
      })
    }
  }

  async function deleteResource(child: GfsChild): Promise<void> {
    try {
      await apiSend('DELETE', `/api/v1/gfs/proxy/v1/resources/${encodeURIComponent(child.rid)}`, {
        ifMatch: child.version,
      })
      // A deleted directory's cached children must never be served again.
      if (child.kind === 'directory') childCacheRef.current.delete(child.resourceId)
      showToast('Resource deleted.', { tone: 'success' })
      setSelected(null)
      // Deleting a breadcrumb folder removes the open location with it —
      // navigate up to its parent instead of refreshing a dead trail.
      const crumbIndex = crumbs.findIndex(crumb => crumb.id === child.resourceId)
      if (crumbIndex >= 0) {
        goToCrumb(crumbIndex - 1)
        return
      }
      await refreshCurrent()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not delete resource.', {
        tone: 'error',
      })
    }
  }

  /** Move-dialog navigation context. Rows keep the full trail; a crumb target
   *  ends the trail at ITS parent so the dialog's current-location pill and
   *  no-op guard match the parent-view row semantics. */
  const moveTargetCrumbIndex = moveTarget
    ? crumbs.findIndex(crumb => crumb.id === moveTarget.resourceId)
    : -1
  const moveDialogCrumbs =
    moveTargetCrumbIndex >= 0 ? crumbs.slice(0, moveTargetCrumbIndex) : crumbs

  // Hover verdict announcement (RP-026 shape, plan §3.3): the live region
  // carries the hovered target's verdict sentence. Text CHANGES announce;
  // repeated identical text stays silent, so repeated dragover events never
  // spam. Refused drops additionally use the toast stack, which is itself a
  // live region.
  const draggedSourceNow = draggingResourceId !== null ? draggingResourceRef.current : null
  let dropHoverAnnouncement = ''
  if (sessionLost) {
    // Matrix A11: the session-lost sentence is spoken once through the same
    // live region that carries hover verdicts, alongside the persistent
    // banner for sighted users.
    dropHoverAnnouncement = gfsDropRefusalMessage('session-lost')
  } else if (draggedSourceNow && dragOverCrumbIndex !== null) {
    const hoveredCrumb = crumbs[dragOverCrumbIndex]
    const verdict = crumbHoverVerdict(draggedSourceNow, dragOverCrumbIndex)
    if (verdict && hoveredCrumb) {
      dropHoverAnnouncement = gfsDropHoverAnnouncement(verdict, {
        sourceName: draggedSourceNow.name,
        targetName: isDriveRootCrumb(hoveredCrumb) ? DRIVE : hoveredCrumb.name,
      })
    }
  } else if (draggedSourceNow && dragOverFolderId !== null) {
    const hoveredRow = items.find(item => item.resourceId === dragOverFolderId)
    const verdict = hoveredRow ? rowHoverVerdict(draggedSourceNow, hoveredRow) : null
    if (verdict && hoveredRow) {
      dropHoverAnnouncement = gfsDropHoverAnnouncement(verdict, {
        sourceName: draggedSourceNow.name,
        targetName: hoveredRow.name,
      })
    }
  }

  return (
    <section
      className="cu-gfs"
      aria-label="EvenDrive browser"
      aria-busy={loading || droppedUploadCount > 0 || movingResourceId !== null}
    >
      <div aria-live="polite" className="cu-gfs-drop-announce" data-testid="gfs-drop-announce">
        {dropHoverAnnouncement}
      </div>
      <div
        className="cu-card cu-card--viewport-fill cu-gfs-card"
        onDragEnter={handleGfsDragEnter}
        onDragLeave={handleGfsDragLeave}
        onDragOver={handleGfsDragOver}
        onDrop={event => void handleGfsDrop(event)}
      >
        <TablePanelHeader
          title={
            <>
              <IconHardDrive /> EvenDrive
            </>
          }
          subtitle="Browse and manage drive resources and access grants from the admin plane."
        />

        {dragActive || droppedUploadCount > 0 ? (
          <div className="cu-gfs-drop-overlay" role="status">
            {droppedUploadCount > 0
              ? `Uploading ${droppedUploadCount} ${droppedUploadCount === 1 ? 'file' : 'files'}…`
              : current?.id
                ? `Drop files to upload to ${currentLabel}`
                : 'Files cannot be uploaded until a destination folder is available.'}
          </div>
        ) : null}

        {error ? (
          <div className="cu-banner cu-banner--error" role="alert">
            {error}
          </div>
        ) : null}

        {sessionLost ? (
          <div className="cu-banner cu-banner--error" role="alert">
            {gfsDropRefusalMessage('session-lost')}
          </div>
        ) : null}

        {trailRecovery ? (
          <div className="cu-banner cu-banner--warning cu-banner--dismissible" role="alert">
            {trailRecovery.reason === 'move' ? (
              <span>
                &ldquo;
                {crumbs.find(crumb => crumb.id === trailRecovery.resourceId)?.name ??
                  trailRecovery.resourceId}
                &rdquo; moved, but its folder path could not be refreshed — the breadcrumb may not
                show the real location.
              </span>
            ) : (
              <span>
                The current folder path could not be refreshed. Your current location is still
                shown.
              </span>
            )}
            <Button
              size="sm"
              onClick={() => void retryTrailRecovery()}
              aria-label={trailRecovery.reason === 'hierarchy' ? 'Retry folder path' : undefined}
            >
              Retry
            </Button>
          </div>
        ) : null}

        <div className="cu-gfs-panel">
          <div className="cu-gfs-panel__toolbar">
            <nav aria-label="Breadcrumb" className="cu-gfs-breadcrumb">
              {crumbs.map((crumb, index) => {
                // Only the ACTIVE folder segment carries a ⋯ menu — mounted to
                // the right of its name, mirroring the Desktop Files pattern.
                // The synthetic drive root and ancestor crumbs stay plain.
                const activeFolder = index === crumbs.length - 1 ? crumbToChild(crumb) : null
                // Every crumb is a drop target (plan §3.1): the drop-state
                // verdict is painted token-driven alongside the reason; click
                // and keyboard navigation stay untouched.
                const draggedSource =
                  draggingResourceId !== null ? draggingResourceRef.current : null
                const crumbVerdict =
                  draggedSource && dragOverCrumbIndex === index
                    ? crumbHoverVerdict(draggedSource, index)
                    : null
                return (
                  <span
                    className="cu-gfs-breadcrumb__item"
                    key={`${isDriveRootCrumb(crumb) ? 'root' : crumb.id}-${index}`}
                  >
                    {index > 0 ? <IconChevronRight width={14} height={14} /> : null}
                    <button
                      className={`cu-gfs-breadcrumb__button${
                        crumb.name === '/' ? ' cu-gfs-breadcrumb__button--root' : ''
                      }`}
                      type="button"
                      onClick={() => goToCrumb(index)}
                      onDragEnter={event => handleCrumbDragEnter(event, index)}
                      onDragOver={event => handleCrumbDragOver(event, index)}
                      onDragLeave={event => handleCrumbDragLeave(event, index)}
                      onDrop={event => handleCrumbDrop(event, crumb, index)}
                      aria-current={index === crumbs.length - 1 ? 'page' : undefined}
                      data-drop-state={crumbVerdict ? crumbVerdict.state : undefined}
                      data-drop-reason={
                        crumbVerdict &&
                        crumbVerdict.state !== 'allowed' &&
                        crumbVerdict.state !== 'checking'
                          ? crumbVerdict.reason
                          : undefined
                      }
                    >
                      {crumb.name === '/' ? (
                        <>
                          <span className="cu-gfs-breadcrumb__drive-icon" aria-hidden="true">
                            <IconFolder />
                          </span>
                          <span>{DRIVE}</span>
                        </>
                      ) : (
                        crumb.name
                      )}
                    </button>
                    {activeFolder ? <GfsResourceMenu {...folderMenuProps(activeFolder)} /> : null}
                  </span>
                )
              })}
            </nav>
            <div className="cu-gfs-panel__actions">
              <Button
                className="cu-gfs-create-action"
                disabled={!current?.id}
                onClick={openNewFolder}
                size="sm"
                variant="primary"
              >
                <IconFolder />
                New folder
              </Button>
              <Button
                className="cu-gfs-create-action"
                disabled={!current?.id}
                onClick={() => {
                  setUploadCandidate(null)
                  setUploadOpen(true)
                }}
                size="sm"
              >
                <IconUpload width={16} height={16} />
                Upload file
              </Button>
            </div>
          </div>

          {loading ? (
            <div
              className="cu-gfs-loading"
              role="status"
              aria-label="Loading files"
              aria-live="polite"
            >
              <span className="cu-gfs-loading__dots" aria-hidden="true">
                <span className="cu-gfs-loading__dot" />
                <span className="cu-gfs-loading__dot" />
                <span className="cu-gfs-loading__dot" />
              </span>
              <span>Loading files…</span>
            </div>
          ) : (
            <div className="cu-gfs-list-frame">
              <div className="cu-gfs-list__head" aria-hidden="true">
                <span />
                <span>Name</span>
                <span className="cu-gfs-list__head-size">Size</span>
                <span className="cu-gfs-list__head-actions">Actions</span>
              </div>
              <ul className="cu-gfs-list" aria-label="Current folder resources">
                {items.map(child => {
                  const rowOpenable = child.kind === 'directory' || isGfsPreviewFile(child.name)
                  const isDragging = draggingResourceId === child.resourceId
                  const canDragResource = movingResourceId === null
                  // Directory rows and the dragged row itself stay hoverable
                  // drop zones so a refused drop can explain its reason
                  // (matrix A1/§5.3); plain file rows are not move targets.
                  const rowIsDropZone =
                    canDragResource &&
                    (child.kind === 'directory' ||
                      (isDragging && draggingResourceId === child.resourceId))
                  const draggedSource =
                    draggingResourceId !== null ? draggingResourceRef.current : null
                  const rowVerdict =
                    draggedSource && dragOverFolderId === child.resourceId
                      ? rowHoverVerdict(draggedSource, child)
                      : null
                  const openRow = () => {
                    if (child.kind === 'directory') openDirectory(child)
                    else openFilePreview(child)
                  }
                  return (
                    <li
                      className={`cu-gfs-list__row${rowOpenable ? ' cu-gfs-list__row--clickable' : ''}`}
                      key={child.resourceId}
                      draggable={canDragResource}
                      title={
                        canDragResource
                          ? `Drag ${child.name} into a folder or breadcrumb to move it`
                          : undefined
                      }
                      onDragStart={
                        canDragResource ? event => handleResourceDragStart(event, child) : undefined
                      }
                      onDragEnd={canDragResource ? handleResourceDragEnd : undefined}
                      onDragEnter={
                        rowIsDropZone ? event => handleFolderDragEnter(event, child) : undefined
                      }
                      onDragOver={
                        rowIsDropZone ? event => handleFolderDragOver(event, child) : undefined
                      }
                      onDragLeave={rowIsDropZone ? handleFolderDragLeave : undefined}
                      onDrop={
                        rowIsDropZone ? event => void handleFolderDrop(event, child) : undefined
                      }
                      data-dragging={isDragging ? 'true' : undefined}
                      data-drop-target={rowVerdict?.state === 'allowed' ? 'true' : undefined}
                      data-drop-state={rowVerdict ? rowVerdict.state : undefined}
                      data-drop-reason={
                        rowVerdict &&
                        rowVerdict.state !== 'allowed' &&
                        rowVerdict.state !== 'checking'
                          ? rowVerdict.reason
                          : undefined
                      }
                      role={rowOpenable ? 'button' : undefined}
                      tabIndex={rowOpenable ? 0 : undefined}
                      aria-label={rowOpenable ? `Open ${child.name}` : undefined}
                      onClick={
                        rowOpenable
                          ? event => {
                              if (isEventFromNestedInteractive(event)) return
                              openRow()
                            }
                          : undefined
                      }
                      onKeyDown={
                        rowOpenable
                          ? event => {
                              if (event.key !== 'Enter' && event.key !== ' ') return
                              if (isEventFromNestedInteractive(event)) return
                              event.preventDefault()
                              openRow()
                            }
                          : undefined
                      }
                    >
                      <span className="cu-gfs-list__icon" aria-hidden="true">
                        {child.kind === 'directory' ? (
                          <IconFolder />
                        ) : gfsImagePreviewMimeType(child.name) ? (
                          <IconImage />
                        ) : isGfsVideoFile(child.name) ? (
                          <IconVideo />
                        ) : isGfsDocumentFile(child.name) ? (
                          <IconDocumentText />
                        ) : (
                          <IconServer />
                        )}
                      </span>
                      <span className="cu-gfs-list__identity">
                        <span className="cu-gfs-list__name">
                          {child.kind === 'directory' ? (
                            <button
                              className="cu-gfs-list__name-button"
                              type="button"
                              onClick={() => openDirectory(child)}
                            >
                              {child.name}
                            </button>
                          ) : (
                            <>
                              {isGfsPreviewFile(child.name) ? (
                                <button
                                  className="cu-gfs-list__name-button"
                                  type="button"
                                  onClick={() => openFilePreview(child)}
                                >
                                  {child.name}
                                </button>
                              ) : (
                                <span>{child.name}</span>
                              )}
                            </>
                          )}
                        </span>
                      </span>
                      <span className="cu-gfs-list__value">
                        {child.kind === 'directory' ? '—' : formatBytes(child.bytes)}
                      </span>
                      <span
                        className="cu-gfs-list__actions"
                        onClick={event => {
                          const target = event.target
                          if (target instanceof Element) {
                            const interactive = target.closest(
                              'button, a, input, select, textarea, [tabindex]'
                            )
                            if (interactive && event.currentTarget.contains(interactive)) return
                          }
                          event.preventDefault()
                          event.stopPropagation()
                          event.currentTarget
                            .querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
                            ?.click()
                        }}
                      >
                        <GfsResourceMenu
                          resourceName={child.name}
                          resourceUri={child.gfsUri}
                          downloading={downloadingIds.has(child.resourceId)}
                          onManage={() => openManage(child)}
                          onPreview={
                            isGfsPreviewFile(child.name) ? () => openFilePreview(child) : undefined
                          }
                          onDownload={
                            child.kind !== 'directory' ? () => void downloadFile(child) : undefined
                          }
                          onReplace={
                            child.kind !== 'directory'
                              ? file => void replaceFile(child, file)
                              : undefined
                          }
                          onCopyLink={() => void copyGfsUri(child.gfsUri)}
                          // Folders keep the EvenDrive link flow reachable from
                          // their row menu, matching the breadcrumb crumb menu.
                          onOpenLink={
                            child.kind === 'directory' ? () => setOpenLinkOpen(true) : undefined
                          }
                          onRename={() => openRowRename(child)}
                          onMove={() => openMove(child)}
                          onDelete={() => openManage(child, 'delete')}
                        />
                      </span>
                    </li>
                  )
                })}
                {items.length === 0 && !loading ? (
                  <li className="cu-gfs-list__empty">No resources are visible in this folder.</li>
                ) : null}
              </ul>
            </div>
          )}

          {!loading && items.length > 0 ? (
            <p className="cu-gfs-list-count" aria-live="polite">
              {nextCursor
                ? `Showing the first ${items.length} ${items.length === 1 ? 'item' : 'items'}.`
                : `Showing all ${items.length} ${items.length === 1 ? 'item' : 'items'}.`}
            </p>
          ) : null}

          {nextCursor && !loading ? (
            <p className="cu-gfs-list-count cu-gfs-list-count--truncated">
              The listing is truncated at the page cap — Load more fetches the next page.
            </p>
          ) : null}

          {nextCursor && !loading ? (
            <Button
              className="cu-gfs__load-more"
              size="sm"
              disabled={loadingMore}
              aria-busy={loadingMore}
              onClick={() => void load(current, nextCursor)}
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          ) : null}
        </div>
      </div>

      {selected && !deleteOpen ? (
        <div
          className="cu-modal-backdrop cu-gfs-manage-modal"
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget) setSelected(null)
          }}
        >
          <section
            className="cu-gfs-manage-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`Share ${selected.kind === 'directory' ? 'folder' : 'file'} ${selected.name}`}
          >
            <header className="cu-gfs-manage-dialog__header">
              <span
                className={`cu-gfs-manage-dialog__icon${
                  selected.kind === 'directory' ? ' cu-gfs-manage-dialog__icon--folder' : ''
                }`}
                aria-hidden="true"
              >
                {selected.kind === 'directory' ? (
                  <IconFolder />
                ) : gfsImagePreviewMimeType(selected.name) ? (
                  <IconImage />
                ) : isGfsVideoFile(selected.name) ? (
                  <IconVideo />
                ) : isGfsDocumentFile(selected.name) ? (
                  <IconDocumentText />
                ) : (
                  <IconPaperclip />
                )}
              </span>
              <span className="cu-gfs-manage-dialog__heading">
                <h3>Share “{selected.name}”</h3>
              </span>
              <span className="cu-gfs-manage-dialog__top-actions">
                <Button
                  autoFocus
                  className="cu-gfs-manage-dialog__close"
                  variant="ghost"
                  aria-label="Close share dialog"
                  onClick={() => setSelected(null)}
                >
                  <IconX width={18} height={18} />
                </Button>
              </span>
            </header>

            <div className="cu-gfs-manage-dialog__body">
              <section className="cu-gfs-manage-section cu-gfs-manage-section--access">
                <div className="cu-gfs-manage-section__header">
                  <h4>Add people, teams, agents, or workflows</h4>
                </div>
                <GfsGrantPanel
                  resource={{
                    resourceId: selected.resourceId,
                    name: selected.name,
                    gfsUri: selected.gfsUri,
                    kind: selected.kind,
                    path: selected.path,
                  }}
                />
              </section>
            </div>
          </section>
        </div>
      ) : null}

      {renameTarget ? (
        <SingleValueEditDialog
          open
          initialValue={renameTarget.name}
          title={`Rename ${renameTarget.kind === 'directory' ? 'folder' : 'file'}`}
          description={`Change the name without moving this ${
            renameTarget.kind === 'directory' ? 'folder' : 'file'
          } to another folder.`}
          pending={renaming}
          error={renameError || undefined}
          isValid={renameValid}
          discardLabel="Cancel"
          saveLabel="Rename"
          onDismiss={() => {
            setRenameError('')
            setRenameTarget(null)
          }}
          onSave={value => void renameResource(renameTarget, value)}
          renderEditor={({ value, onChange, disabled }) => (
            <Field label="New name" htmlFor="gfs-resource-name" required>
              <TextInput
                id="gfs-resource-name"
                aria-label="New name"
                value={value}
                disabled={disabled}
                onChange={event => {
                  const next = event.target.value
                  setRenameValid(next.trim().length > 0)
                  onChange(next)
                }}
              />
            </Field>
          )}
        />
      ) : null}

      {selected && deleteOpen ? (
        <div
          className="cu-modal-backdrop cu-gfs-manage-modal"
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget) setSelected(null)
          }}
        >
          <section
            className="cu-gfs-delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-label="Delete resource"
          >
            <div className="cu-gfs-delete-dialog__copy">
              <h3>Delete {selected.name}?</h3>
              <p>This action cannot be undone.</p>
            </div>
            <div className="cu-gfs-delete-dialog__actions">
              <Button
                autoFocus
                variant="ghost"
                onClick={() => {
                  setDeleteOpen(false)
                  setSelected(null)
                }}
              >
                Cancel
              </Button>
              <Button variant="danger" onClick={() => void deleteResource(selected)}>
                Delete
              </Button>
            </div>
          </section>
        </div>
      ) : null}

      {newFolderOpen ? (
        <NewFolderModal
          folderLabel={currentLabel}
          pending={creatingFolder}
          error={createFolderError}
          onCreate={name => void createFolder(name)}
          onCancel={() => setNewFolderOpen(false)}
        />
      ) : null}

      {openLinkOpen ? (
        <GfsOpenLinkModal
          pending={openLinkResolving}
          error={openLinkError}
          onOpen={uri => void openEvenDriveLink(uri)}
          onCancel={() => {
            setOpenLinkOpen(false)
            setOpenLinkError(null)
          }}
        />
      ) : null}

      {moveTarget ? (
        <GfsMoveDialog
          busy={movingResourceId === moveTarget.resourceId}
          initialCrumbs={moveDialogCrumbs}
          onClose={() => setMoveTarget(null)}
          onMove={async destination => {
            await moveResource(
              moveTarget,
              { resourceId: destination.resourceId, name: destination.name, kind: 'directory' },
              { bubbleError: true, occupiedNames: destination.occupiedNames }
            )
            setMoveTarget(null)
          }}
          target={moveTarget}
        />
      ) : null}

      {confirmMoveTarget ? (
        <GfsMoveConfirmDialog
          busy={movingResourceId === confirmMoveTarget.source.resourceId}
          onCancel={() => setConfirmMoveTarget(null)}
          onConfirm={({ allowNumberedRename }) => {
            const pending = confirmMoveTarget
            setConfirmMoveTarget(null)
            if (pending) {
              void moveResource(pending.source, pending.destination, {
                allowNumberedRename,
                revalidate: { epoch: pending.epoch, oldParentId: pending.oldParentId },
              })
            }
          }}
          request={{
            sourceName: confirmMoveTarget.source.name,
            sourceKind: confirmMoveTarget.source.kind === 'directory' ? 'directory' : 'file',
            destinationName: confirmMoveTarget.destination.name,
            canRename: true,
            ...(confirmMoveTarget.suggestedName !== undefined
              ? { suggestedName: confirmMoveTarget.suggestedName }
              : {}),
          }}
        />
      ) : null}

      {uploadOpen ? (
        <FileUploadModal
          busy={uploading}
          file={uploadCandidate}
          fileSummary={
            uploadCandidate ? `${formatBytes(uploadCandidate.size)} selected` : undefined
          }
          progress={
            uploadSnapshot
              ? {
                  uploadedBytes: uploadSnapshot.uploadedBytes,
                  totalBytes: uploadSnapshot.totalBytes,
                  state: uploadSnapshot.state,
                }
              : undefined
          }
          onCancelUpload={() => void cancelUpload()}
          onPauseUpload={() => void pauseUpload()}
          onResumeUpload={() => void resumeUpload()}
          onClose={closeUploadModal}
          onFileChange={setUploadCandidate}
          onUpload={() => void uploadFile(uploadCandidate)}
        />
      ) : null}

      {imagePreview ? (
        <GfsImagePreview
          key={`${imagePreview.gfsUri}:${imagePreview.reloadVersion}`}
          byteLength={imagePreview.byteLength}
          fileName={imagePreview.fileName}
          mimeType={imagePreview.mimeType}
          rid={imagePreview.rid}
          unavailable={imagePreview.unavailable}
          onClose={() => setImagePreview(null)}
        />
      ) : null}

      {markdownPreview ? (
        <GfsMarkdownPreview
          key={`${markdownPreview.gfsUri}:${markdownPreview.reloadVersion}`}
          byteLength={markdownPreview.byteLength}
          fileName={markdownPreview.fileName}
          rid={markdownPreview.rid}
          unavailable={markdownPreview.unavailable}
          onClose={() => setMarkdownPreview(null)}
        />
      ) : null}

      {videoPreview ? (
        <GfsVideoPreview
          key={`${videoPreview.gfsUri}:${videoPreview.reloadVersion}`}
          byteLength={videoPreview.byteLength}
          fileName={videoPreview.fileName}
          mimeType={videoPreview.mimeType}
          rid={videoPreview.rid}
          unavailable={videoPreview.unavailable}
          onClose={() => setVideoPreview(null)}
        />
      ) : null}
    </section>
  )
}
