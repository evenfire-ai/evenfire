import {
  type DragEvent as ReactDragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { normalizeGfsResourceUri } from '@clerum/desktop-app-links'
import { createGfsUploadNameReservationBook } from '@clerum/gfs-interaction-policy'
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  PermissionStatusIndicator,
  StatusBanner,
  TextInput,
} from '@components/Common'
import { ConfirmDialog } from '@components/ConfirmDialog'
import { GfsFileIcon } from '@components/GfsFileIcon'
import { GfsReadFailureCard } from '@components/GfsReadFailureCard'
import { GfsResourceMenu } from '@components/GfsResourceMenu'
import { GfsResourceTitlebarActions } from '@components/GfsResourceTitlebarActions'
import {
  IconAttachFile,
  IconCheck,
  IconChevronRight,
  IconClose,
  IconContexts,
  IconDownload,
  IconEdit,
  IconOpenRoute,
  IconShare,
} from '@components/SidebarNav/icons'
import { GFS_DRIVE_MAIN, GFS_RESOURCE_DRAG_TYPE } from '@constants/gfsBrowser'
import {
  desktopQueryKeys,
  isGfsSessionAuthorityCurrent,
  isGfsSessionGeneration,
} from '@hooks/domain/queryKeys'
import {
  GFS_UNAVAILABLE_LOCATION_MESSAGE,
  type GfsCrumb,
  type GfsDiscoveryFailure,
  type GfsUriOpenFailure,
  useGfsBrowserController,
} from '@hooks/domain/useGfsBrowserController'
import { isEventFromNestedInteractive } from '@lib/clickableRowProps'
import { gfsActionOpeningAuthority } from '@lib/gfsActionOpeningAuthority'
import { assertGfsAuthorityRetryAllowed } from '@lib/gfsAuthorityQueryPolicy'
import { saveGfsFileToDisk } from '@lib/gfsDownload'
import { assertGfsFileUploadSize } from '@lib/gfsFileUpload'
import {
  GfsFolderZipEmptyError,
  GfsFolderZipLimitError,
  type GfsFolderZipProgress,
  createGfsFolderZip,
  describeZipSkips,
  isFolderZipAbortError,
} from '@lib/gfsFolderZip'
import { fetchGfsAuthority, requireFreshGfsPermissions } from '@lib/gfsFreshPermissions'
import type { GfsFreshPermissionsContext } from '@lib/gfsFreshPermissions.types'
import {
  describeGfsReadError,
  isRateLimited,
  parseHttpStatus,
  parseRetryAfterSeconds,
} from '@lib/gfsGrantErrors'
import { hasGfsMoveSourcePermissions } from '@lib/gfsMovePermissions'
import { isGfsPreviewFile, resolveGfsPreview } from '@lib/gfsPreview'
import type { GfsPreviewResource } from '@lib/gfsPreview'
import {
  filesCurrentResourceActionOptions,
  filesRowActionOptions,
} from '@lib/gfsResourceActionSurfaces'
import { buildGfsResourceActions, getGfsMenuActions } from '@lib/gfsResourceActions'
import type { GfsResourceActionId } from '@lib/gfsResourceActions'
import { copyGfsDeepLink } from '@lib/gfsResourceClipboard'
import { gfsRowActionAvailability } from '@lib/gfsRowActionAvailability'
import type { GfsRowActionAvailability } from '@lib/gfsRowActionAvailability.types'
import { formatSharedFileSize } from '@lib/sharedFiles'
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
import { GfsFilePicker } from '@/gfs/filePicker'
import { GfsManageAccessDialog } from '@/gfs/manageAccessDialog'
import type { GfsManageAccessDeps } from '@/gfs/manageAccessDialog.types'
import { toastMoveOutcome } from '@/gfs/moveCommit'
import type {
  MoveCommitExpectedSourceSnapshot,
  MoveCommitOutcome,
  MoveToast,
} from '@/gfs/moveCommit'
import { runGfsMoveCommit } from '@/gfs/moveCommitRunner'
import { GfsMoveConfirmDialog } from '@/gfs/moveConfirmDialog'
import { GfsMoveDialog } from '@/gfs/moveDialog'
import { GfsNameDialog } from '@/gfs/nameDialog'
import {
  bindGfsActionGuards,
  runGfsCreateFolder,
  runGfsDelete,
  runGfsRename,
  runGfsUpload,
} from '@/gfs/resourceActionRunners'
import type { GfsActionRunnerDeps } from '@/gfs/resourceActionRunners.types'
import type { FilesPageProps, GfsDriveResource } from './FilesPage.types'

function hasBit(affordances: { held?: string[] } | null | undefined, bit: string): boolean {
  return Boolean(affordances?.held?.includes(bit))
}

function hasDraggedFiles(event: ReactDragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types || []).includes('Files')
}

function hasDraggedGfsResource(event: ReactDragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types || []).includes(GFS_RESOURCE_DRAG_TYPE)
}

/** A drop destination the drag pipeline can move INTO: a grid folder row or a
 *  breadcrumb crumb. Only the identity fields admission and the commit need. */
type GfsFolderDropTarget = Pick<GfsDriveResource, 'resourceId' | 'name'> & {
  kind: 'directory'
}

/** Any row/header action target — a listing row (GfsDriveResource) or the
 * current breadcrumb (GfsCrumb); both carry the identity fields the delete /
 *  rename / move calls need (kind also powers dialog titles + the move cycle
 *  guard). */
type GfsActionTarget = Pick<GfsDriveResource, 'resourceId' | 'name' | 'version'> & {
  kind: 'file' | 'directory'
  /** Present on list rows (GfsBrowserChild) — the move dialog uses it to
   * refuse a no-op move into the folder that already contains the target. */
  parentResourceId?: string | null
}

type GfsInlineRenameProps = {
  value: string
  busy?: boolean
  className?: string
  onChange: (value: string) => void
  onCancel: () => void
  onSubmit: () => void
}

function GfsInlineRename({
  value,
  busy = false,
  className,
  onChange,
  onCancel,
  onSubmit,
}: GfsInlineRenameProps) {
  return (
    <form
      aria-label="Rename resource"
      className={`da-gfs-inline-rename${className ? ` ${className}` : ''}`}
      onClick={event => event.stopPropagation()}
      onSubmit={event => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <TextInput
        aria-label="New name"
        autoFocus
        className="da-gfs-inline-rename__input"
        dense
        value={value}
        onChange={event => onChange(event.currentTarget.value)}
        onFocus={event => event.currentTarget.select()}
      />
      <span className="da-gfs-inline-rename__actions">
        <IconButton
          color="success"
          className="da-gfs-inline-rename__confirm"
          disabled={!value.trim()}
          label="Save name"
          loading={busy}
          size="xs"
          type="submit"
          variant="soft"
        >
          <IconCheck />
        </IconButton>
        <IconButton
          className="da-gfs-inline-rename__cancel"
          disabled={busy}
          label="Cancel rename"
          size="xs"
          type="button"
          variant="ghost"
          onClick={onCancel}
        >
          <IconClose />
        </IconButton>
      </span>
    </form>
  )
}

/**
 * How many uncached subfolders one listing may speculatively warm.
 *
 * The server meters reads per minute per actor, so the cap is a count, not a
 * concurrency limit — sending the same ten requests four at a time spends
 * exactly the same budget as sending them at once.
 */
const PREFETCH_FOLDER_LIMIT = 10

export function FilesPage({
  pushToast,
  titlebarLeadingTarget,
  pendingGfsUri,
  onPendingGfsUriHandled,
  pendingGfsDeepLink,
  workspaceTabId,
  pendingGfsDeepLinkOwnerTabId,
  isPendingGfsDeepLinkCurrent,
  onExplicitNavigationIntent,
  onPendingGfsDeepLinkOutcome,
  registerLocationRefresh,
  onResolvedLocationChange,
  onLocationChange,
  onOpenPreview,
  onOpenPendingGfsPreview,
  routeDialogRequestId = 0,
  onRouteDialogRequestHandled,
}: FilesPageProps) {
  const [createFolderOpen, setCreateFolderOpen] = useState(false)
  const [createFolderParentId, setCreateFolderParentId] = useState<string | null>(null)
  const [createFolderParentName, setCreateFolderParentName] = useState<string | null>(null)
  const [createFolderError, setCreateFolderError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<GfsActionTarget | null>(null)
  const [moveTarget, setMoveTarget] = useState<GfsActionTarget | null>(null)
  const moveDialogGenerationRef = useRef(0)
  const showMoveDialog = (target: GfsActionTarget) => {
    moveDialogGenerationRef.current += 1
    setMoveTarget(target)
  }
  const closeMoveDialog = () => {
    moveDialogGenerationRef.current += 1
    setMoveTarget(null)
  }
  const [movePermissionStatus, setMovePermissionStatus] = useState<'checking' | 'failed' | null>(
    null
  )
  const [renameTarget, setRenameTarget] = useState<GfsActionTarget | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [openLinkOpen, setOpenLinkOpen] = useState(false)
  const [pendingGfsDeepLinkFailure, setPendingGfsDeepLinkFailure] = useState<{
    id: number
    message: string
    retryable: boolean
  } | null>(null)
  const [gfsDeepLinkRetry, setGfsDeepLinkRetry] = useState<{ id: number; request: number } | null>(
    null
  )
  const pendingGfsDeepLinkEffectRef = useRef<{
    id: number
    uri: string
    retryRequest: number
    cleanupVersion: number
  } | null>(null)
  const [refreshingCurrent, setRefreshingCurrent] = useState(false)
  // The resource the Share dialog is about, and the session it was opened
  // under: the open location (titlebar) or a listing row, which is shared in
  // place without navigating to it.
  const [manageTarget, setManageTarget] = useState<{
    resource: 'current' | GfsDriveResource
    sessionScope: string
    sessionGeneration: number | null
  } | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [droppedUploadCount, setDroppedUploadCount] = useState(0)
  // BUG-175 — live folder-zip job for the progress strip; null when idle. One
  // job at a time: the walk holds the shared GFS read budget.
  const [zipJob, setZipJob] = useState<{
    folderName: string
    progress: GfsFolderZipProgress
  } | null>(null)
  // Active job identity (folder name) + its stop handle. A ref, not state, so
  // the prefetch effect can consult it without re-arming when a job starts.
  const zipJobRef = useRef<string | null>(null)
  const zipAbortRef = useRef<AbortController | null>(null)
  // Navigating away must not leave a walk spending the shared GFS read budget
  // with no Stop reachable: unmount aborts it, so the one-job-at-a-time
  // invariant also holds across unmount/remount (a fresh mount starts fresh,
  // never alongside a zombie walk from the previous page instance).
  useEffect(() => {
    return () => {
      zipAbortRef.current?.abort()
    }
  }, [])
  const [draggingResourceId, setDraggingResourceId] = useState<string | null>(null)
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)
  const [movingResourceId, setMovingResourceId] = useState<string | null>(null)
  // The FULL verdict is stored — not just its state — so the deny reason
  // reaches the row (`data-drop-reason`), the tooltip and the announcements
  // (UX matrix §5.1); a same-state reason change must still repaint.
  const [dropStatesById, setDropStatesById] = useState<Record<string, GfsDropVerdict>>({})
  // The drop verdict is painted on the target row; this live region is its
  // spoken form, so a screen reader learns whether the folder under the
  // pointer accepts the move (RP-026).
  const [dropVerdictAnnouncement, setDropVerdictAnnouncement] = useState('')
  // A drop refused by a dead session must stay visible AFTER the revocation
  // has already invalidated the gesture's ownership (UX matrix A11). The
  // revoked surface below carries the sentence unconditionally; this
  // callback-local banner is gated by the captured scope/session identity so
  // a superseded call cannot paint it over a new, healthy session.
  const [dropSessionLost, setDropSessionLost] = useState(false)
  // Display name of the live gesture's source, for reason copy that names it.
  const [dragSourceName, setDragSourceName] = useState<string | null>(null)
  // Folder drops stop at ONE confirmation (impact + naming policy) before the
  // shared dispatch; files commit directly on an allowed admission.
  const [pendingFolderMove, setPendingFolderMove] = useState<{
    source: GfsDragSource
    gestureGeneration: number
    sessionGeneration: number | null
    authoritativeSessionGeneration: number
    destination: { resourceId: string; name: string }
  } | null>(null)
  const draggingResourceRef = useRef<GfsDriveResource | null>(null)
  const draggingSourceRef = useRef<GfsDragSource | null>(null)
  const movingResourceRef = useRef<string | null>(null)
  const pageActiveRef = useRef(true)
  const hoveredFolderRef = useRef<string | null>(null)
  const hoverOwnerRef = useRef<GfsDragSource | null>(null)
  const dragSessionRef = useRef(0)
  const manageReturnCrumbsRef = useRef<GfsCrumb[] | null>(null)
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const uploadTargetRef = useRef<{
    parentResourceId: string
    occupiedNames: Set<string>
    parentName: string
  } | null>(null)
  const uploadNameReservationsRef = useRef(createGfsUploadNameReservationBook())
  const handledRouteDialogRequestIdRef = useRef(0)
  const queryClient = useQueryClient()
  const ctrl = useGfsBrowserController()
  const seedPendingRef = useRef(false)
  const beginExplicitFilesNavigation = useCallback(() => {
    seedPendingRef.current = false
    onExplicitNavigationIntent?.()
  }, [onExplicitNavigationIntent])
  useEffect(() => {
    pageActiveRef.current = true
    return () => {
      pageActiveRef.current = false
    }
  }, [])
  const {
    current,
    crumbs,
    sessionScope,
    accessibleResources,
    items,
    affordances,
    affordancesError,
    loadingAffordances,
    loadingCurrentView,
    accessibleError,
    accessibleNotice,
    error,
    openError,
    resolving,
  } = ctrl
  const accessibleRootResourceIds = useMemo(
    () => new Set(accessibleResources.map(resource => resource.resourceId)),
    [accessibleResources]
  )
  const rowActionContextRef = useRef({
    sessionScope,
    sessionGeneration: ctrl.sessionGeneration,
    currentResourceId: current?.resourceId ?? null,
    resourceVersions: new Map(
      [...items, ...accessibleResources, ...(current ? [current] : [])].map(resource => [
        resource.resourceId,
        resource.version,
      ])
    ),
  })
  rowActionContextRef.current = {
    sessionScope,
    sessionGeneration: ctrl.sessionGeneration,
    currentResourceId: current?.resourceId ?? null,
    resourceVersions: new Map(
      [...items, ...accessibleResources, ...(current ? [current] : [])].map(resource => [
        resource.resourceId,
        resource.version,
      ])
    ),
  }
  const rowPermissionNoticeFor = (resourceId: string, resourceName: string) => {
    if (!currentIsFolder && accessibleRootResourceIds.has(resourceId)) return null
    const status = ctrl.rowPermissionStatusByResourceId?.[resourceId]
    return status?.status === 'error'
      ? `Could not verify permissions for ${resourceName}: ${status.message}`
      : null
  }
  const moveWorkspaceRef = useRef({
    sessionScope,
    sessionGeneration: ctrl.sessionGeneration,
    currentResourceId: current?.resourceId ?? null,
  })
  const cachedCurrentAffordances =
    current && isGfsSessionGeneration(ctrl.sessionGeneration)
      ? queryClient.getQueryData<{ held?: string[]; grantableBits?: string[] }>(
          desktopQueryKeys.gfsAffordances(
            sessionScope,
            current.resourceId,
            GFS_DRIVE_MAIN,
            ctrl.sessionGeneration
          )
        )
      : undefined
  moveWorkspaceRef.current = {
    sessionScope,
    sessionGeneration: ctrl.sessionGeneration,
    currentResourceId: current?.resourceId ?? null,
  }

  // Cross-surface drag coordinator (null outside the provider — e.g. unit
  // tests — where the local per-surface ref drives same-surface drags).
  const dragSession = useGfsDragSession()
  const adjudication = useGfsDragAdjudication({
    scope: sessionScope,
    sessionGeneration: ctrl.sessionGeneration,
    drive: GFS_DRIVE_MAIN,
    resolve: useCallback((uri: string) => window.clerum.gfs.resolve(uri), []),
    // A drag probe that answers 401 is a session failure, not a per-item
    // refusal: the drop is refused AND the session revoked.
    handleAuthorityFailure: useCallback(
      (message: string, scope: string, generation: number) =>
        ctrl.handleAuthorityFailure(message, 'operation', scope, generation),
      [ctrl.handleAuthorityFailure]
    ),
  })

  useEffect(
    () => () => {
      dragSessionRef.current += 1
      hoverOwnerRef.current = null
      adjudication.endDragSession()
    },
    [adjudication.endDragSession]
  )

  const liveDragScope =
    ctrl.accessState === 'revoked' || !isGfsSessionGeneration(ctrl.sessionGeneration)
      ? null
      : (sessionScope ?? 'anonymous')
  const liveDragScopeRef = useRef(liveDragScope)
  liveDragScopeRef.current = liveDragScope
  const previousDragScopeRef = useRef(liveDragScope)
  useEffect(() => {
    if (previousDragScopeRef.current === liveDragScope) return
    previousDragScopeRef.current = liveDragScope
    dragSessionRef.current += 1
    draggingResourceRef.current = null
    draggingSourceRef.current = null
    hoveredFolderRef.current = null
    hoverOwnerRef.current = null
    adjudication.endDragSession()
    setPendingFolderMove(null)
    setDraggingResourceId(null)
    setDragOverFolderId(null)
    setDropStatesById({})
    setDropVerdictAnnouncement('')
    setDragSourceName(null)
    // A NEW live session makes any session-ended refusal stale. A transition
    // TO revoked (scope null) must NOT clear it: that is exactly when the
    // message has to survive (A11), and the revoked surface carries it.
    if (liveDragScope !== null) setDropSessionLost(false)
  }, [adjudication.endDragSession, liveDragScope])

  const ownsDrop = (source: GfsDragSource, epoch: number, sharedGeneration: number | null) =>
    ownsGfsDrop(
      source,
      { epoch, sessionGeneration: sharedGeneration },
      {
        epoch: dragSessionRef.current,
        scope: liveDragScopeRef.current,
        sessionGeneration: dragSession?.currentGeneration() ?? null,
      }
    )

  useEffect(
    () => registerLocationRefresh?.(() => ctrl.refreshCurrentLocation({ background: true })),
    [ctrl.refreshCurrentLocation, registerLocationRefresh]
  )

  // Warm the cache for directory rows in the current view so clicking into a
  // folder is instant. TanStack Query's staleTime:Infinity (set in
  // lib/queryClient.ts) keeps the cached data hot until the user navigates.
  //
  // Bounded on both axes, because this is an optimization spending a shared
  // budget. Opening a folder with 38 subfolders sent 38 speculative listings
  // in one burst — 38 of the 85 requests in wave 1 of the incident behind
  // #681, for folders the user mostly never opened.
  //
  // The cached-key skip is not redundant with the cap, it is what makes the
  // cap advance: the effect re-runs on every `items` change (loadMore pages
  // included), so a bare `slice(0, 10)` would re-select the same first ten
  // forever and never reach the rest.
  useEffect(() => {
    if (!sessionScope || !isGfsSessionGeneration(ctrl.sessionGeneration)) return
    // A running folder-zip walk holds the same per-actor read budget this
    // prefetch spends; a burst here is one more 429 away from killing the
    // job, so the warmer stays idle until the walk finishes (L9).
    if (zipJobRef.current) return
    const folders = items
      .filter(item => item.kind === 'directory')
      .map(folder => ({
        folder,
        key: desktopQueryKeys.gfsChildren(
          sessionScope,
          folder.resourceId,
          GFS_DRIVE_MAIN,
          ctrl.sessionGeneration
        ),
      }))
      .filter(({ key }) => {
        const state = queryClient.getQueryState(key)
        // A FAILED prefetch also leaves `data === undefined`, so testing that
        // alone re-selects the same folders the next time `items` changes: the
        // window never advances past the first ten failures, and the folders
        // behind them are never warmed. Under a rate limit that is the whole
        // burst being re-sent against a budget that just refused it.
        //
        // An in-flight one is skipped for the same reason — `items` changes
        // while the first batch is still open, and without this the effect
        // doubles every request it has already made.
        return (
          state?.data === undefined &&
          state?.status !== 'error' &&
          state?.fetchStatus !== 'fetching'
        )
      })
      .slice(0, PREFETCH_FOLDER_LIMIT)
    if (folders.length === 0) return
    void Promise.all(
      folders.map(({ folder, key }) =>
        queryClient
          .fetchInfiniteQuery({
            queryKey: key,
            queryFn: ({ pageParam }) =>
              window.clerum.gfs.listChildren(folder.resourceId, 'main', pageParam),
            initialPageParam: undefined as string | undefined,
          })
          .catch(() => {
            // Pre-fetch failures (offline, permission) are non-fatal; the
            // real navigation will surface the error normally.
          })
      )
    )
  }, [ctrl.sessionGeneration, items, queryClient, sessionScope])

  const closeManage = useCallback(() => {
    setManageTarget(null)
    const returnCrumbs = manageReturnCrumbsRef.current
    manageReturnCrumbsRef.current = null
    if (returnCrumbs) ctrl.restoreCrumbs(returnCrumbs)
  }, [ctrl.restoreCrumbs])
  const closeCreateFolder = useCallback(() => {
    setCreateFolderOpen(false)
    setCreateFolderError(null)
    setCreateFolderParentId(null)
    setCreateFolderParentName(null)
    const returnCrumbs = manageReturnCrumbsRef.current
    manageReturnCrumbsRef.current = null
    if (returnCrumbs) ctrl.restoreCrumbs(returnCrumbs)
  }, [ctrl.restoreCrumbs])
  const openCreateFolder = useCallback((parentResourceId: string, parentName: string) => {
    setCreateFolderError(null)
    setCreateFolderParentId(parentResourceId)
    setCreateFolderParentName(parentName)
    setManageTarget(null)
    setCreateFolderOpen(true)
  }, [])

  useEffect(() => {
    if (!routeDialogRequestId || handledRouteDialogRequestIdRef.current === routeDialogRequestId) {
      return
    }
    handledRouteDialogRequestIdRef.current = routeDialogRequestId
    setOpenLinkOpen(true)
    onRouteDialogRequestHandled?.(routeDialogRequestId)
  }, [onRouteDialogRequestHandled, routeDialogRequestId])
  const accessRevoked = ctrl.accessState === 'revoked'
  // R4 spec §1: on an authority failure every local surface that could show
  // or act on stale GFS data must close — Manage, Move, rename, delete,
  // open-link, and the inline create-folder form. File previews now live in
  // their own tab (spec 18 §3.B.5), which fails closed independently via its own
  // authority controller, so there is nothing preview-related to reset here.
  useEffect(() => {
    if (!accessRevoked) return
    manageReturnCrumbsRef.current = null
    uploadTargetRef.current = null
    setCreateFolderParentId(null)
    setCreateFolderParentName(null)
    setManageTarget(null)
    closeMoveDialog()
    setRenameTarget(null)
    setDeleteTarget(null)
    setOpenLinkOpen(false)
    setCreateFolderOpen(false)
  }, [accessRevoked])
  /** Central imperative boundary: route any non-query GFS failure through the
   *  controller's authority classifier before toasting. Returns true when the
   *  session failed closed (caller should stop; the revoked state takes over). */
  const failClosedOnAuthorizationError = useCallback(
    (
      error: unknown,
      capturedScope = sessionScope,
      capturedGeneration = ctrl.sessionGeneration
    ): boolean =>
      ctrl.handleAuthorityFailure(
        error instanceof Error ? error.message : String(error),
        'operation',
        capturedScope,
        capturedGeneration
      ),
    [ctrl.handleAuthorityFailure, ctrl.sessionGeneration, sessionScope]
  )
  const freshPermissionsContext = (
    requestedScope: string,
    requestedGeneration: number | null
  ): GfsFreshPermissionsContext => ({
    queryClient,
    handleAuthorityFailure: (error, scope, generation) =>
      failClosedOnAuthorizationError(error, scope ?? requestedScope, generation),
    pushToast,
    // Session currency only, not page liveness: an upload queue or a confirmed
    // dialog action keeps running after the user leaves Files. Each mutation is
    // still cut by `admitEffect`, which asks main for its live generation, and
    // by `readAccessState()` once the session's access was revoked.
    isCurrent: () =>
      isGfsSessionAuthorityCurrent(
        requestedScope,
        requestedGeneration,
        moveWorkspaceRef.current.sessionScope,
        moveWorkspaceRef.current.sessionGeneration
      ) && ctrl.readAccessState() === 'active',
  })
  const fetchRowAuthority = (resourceId: string, resourceName: string, drive: string) =>
    fetchGfsAuthority(
      {
        scope: sessionScope,
        gen: ctrl.sessionGeneration,
        resourceId,
        resourceName,
        drive,
      },
      freshPermissionsContext(sessionScope, ctrl.sessionGeneration)
    )
  const requireFreshRowPermissions = (
    resourceId: string,
    resourceName: string,
    requiredBits: readonly string[],
    drive = GFS_DRIVE_MAIN,
    requiredGrantableBits: readonly string[] = []
  ) => {
    const rowStatus = ctrl.rowPermissionStatusByResourceId?.[resourceId]?.status
    const controllerAuthority =
      ctrl.current?.resourceId === resourceId
        ? ctrl.affordances
        : (ctrl.rowAffordancesByResourceId?.[resourceId] ??
          (ctrl.rowAffordancesResourceId === resourceId ? ctrl.rowAffordances : null))
    return requireFreshGfsPermissions(
      {
        scope: sessionScope,
        gen: ctrl.sessionGeneration,
        resourceId,
        resourceName,
        drive,
        bits: requiredBits,
        grantableBits: requiredGrantableBits,
      },
      {
        ...freshPermissionsContext(sessionScope, ctrl.sessionGeneration),
        // The controller already observes this exact session/resource/drive query.
        // Reuse only an explicitly fresh success. Legacy controller-only test
        // harnesses have no query observer/status map, so their injected fresh
        // authority remains a valid fixture; production always exposes the query.
        fallbackAuthority: queryState =>
          queryState === undefined &&
          rowStatus === undefined &&
          controllerAuthority &&
          (hasBit(controllerAuthority, 'read') ||
            hasBit(controllerAuthority, 'write') ||
            hasBit(controllerAuthority, 'delete') ||
            hasBit(controllerAuthority, 'manage_acl'))
            ? controllerAuthority
            : null,
      }
    )
  }
  /** Session guards for the shared action runners; the location guard stays at dialog open. */
  const actionRunnerDeps = (): GfsActionRunnerDeps => {
    const requestedScope = sessionScope
    const requestedGeneration = ctrl.sessionGeneration
    return {
      ops: ctrl,
      freshPermissions: requireFreshRowPermissions,
      readAccessState: () => ctrl.readAccessState(),
      publishedGeneration: () => moveWorkspaceRef.current.sessionGeneration,
      isCurrent: () =>
        isGfsSessionAuthorityCurrent(
          requestedScope,
          requestedGeneration,
          moveWorkspaceRef.current.sessionScope,
          moveWorkspaceRef.current.sessionGeneration
        ),
    }
  }
  const runWithFreshResourcePermissions = async (
    target: GfsActionTarget,
    authorityResourceId: string,
    authorityName: string,
    requiredBits: string[],
    action: () => void
  ) => {
    const requestContext = rowActionContextRef.current
    const allowed = await requireFreshRowPermissions(
      authorityResourceId,
      authorityName,
      requiredBits
    )
    if (!allowed) return false
    const latest = rowActionContextRef.current
    if (
      !pageActiveRef.current ||
      latest.sessionScope !== requestContext.sessionScope ||
      latest.sessionGeneration !== requestContext.sessionGeneration ||
      latest.currentResourceId !== requestContext.currentResourceId ||
      !latest.resourceVersions.has(target.resourceId) ||
      latest.resourceVersions.get(target.resourceId) !== target.version
    ) {
      return false
    }
    action()
    return true
  }
  const runWithOpeningAuthority = (
    target: GfsActionTarget,
    actionId: GfsResourceActionId,
    action: () => void
  ) => {
    const authority = gfsActionOpeningAuthority(target, actionId)
    if (authority.kind === 'unverifiable') {
      pushToast?.(authority.message, 'error')
      return
    }
    void runWithFreshResourcePermissions(
      target,
      authority.resourceId,
      authority.resourceName,
      [...authority.bits],
      action
    )
  }
  const openDeleteTarget = (resource: GfsActionTarget) => {
    runWithOpeningAuthority(resource, 'delete', () => setDeleteTarget(resource))
  }
  const currentPermissionPresentationAvailable = Boolean(
    (affordances ?? cachedCurrentAffordances) &&
    !accessRevoked &&
    !ctrl.authorityPending &&
    ctrl.affordancesHttpStatus !== 403 &&
    ctrl.affordancesHttpStatus !== 404
  )
  const canWriteCurrent =
    currentPermissionPresentationAvailable &&
    hasBit(affordances ?? cachedCurrentAffordances, 'write')
  const canDeleteCurrent =
    currentPermissionPresentationAvailable &&
    hasBit(affordances ?? cachedCurrentAffordances, 'delete')
  // The Manage modal lists ACL rows, and view-ACL = manage-ACL server-side —
  // a caller without the bit gets the API's 403, so the entry must not show.
  const canManageCurrent =
    currentPermissionPresentationAvailable &&
    hasBit(affordances ?? cachedCurrentAffordances, 'manage_acl')
  const canMoveCurrent = Boolean(
    !accessRevoked &&
    current?.parentResourceId &&
    hasGfsMoveSourcePermissions(
      ctrl.moveSourceParentAffordancesById?.[current.parentResourceId]?.held
    )
  )
  const currentIsFolder = current?.kind === 'directory'
  const currentIsFile = current?.kind === 'file'
  const currentPreviewAvailable = currentIsFile && isGfsPreviewFile(current?.name ?? '')
  const droppedUploadRestriction = useMemo(() => {
    if (!current) {
      return 'Open a folder before uploading files. The shared-files view has no upload destination.'
    }
    if (!currentIsFolder) {
      return `Open a folder before uploading files. ${current.name} is a file, not an upload destination.`
    }
    if (affordancesError) {
      return `Uploads to ${current.name} are unavailable because permissions could not be verified: ${affordancesError}`
    }
    if (loadingAffordances) {
      return `Upload permissions for ${current.name} are still being checked. Try again in a moment.`
    }
    if (!affordances) {
      return `Upload permissions for ${current.name} are still loading. Try again in a moment.`
    }
    if (!canWriteCurrent) {
      return `You can’t upload to ${current.name} because you don’t have write permission for this folder.`
    }
    return null
  }, [affordances, affordancesError, canWriteCurrent, current, currentIsFolder, loadingAffordances])

  // Open (or focus) a preview TAB for a previewable file (spec 18 §3.B.4). The
  // preview no longer renders in a modal here: resolve the kind via the shared
  // helper and hand the descriptor to the tab store. Returns true when the file
  // is previewable (so the caller skips its download fallback), matching the
  // old modal-era contract. When no `onOpenPreview` is wired, it reports
  // "not previewable" so the caller downloads instead of silently doing nothing.
  const openFilePreview = (
    resource: Pick<GfsDriveResource, 'bytes' | 'gfsUri' | 'name' | 'version'>,
    openPreview = onOpenPreview
  ): boolean => {
    const preview = resolveGfsPreview(resource)
    if (!preview || !openPreview) return false
    return openPreview(preview) !== false
  }

  useEffect(() => {
    // The Move dialog owns its Escape: closing it here too would close it twice.
    if (!openLinkOpen && !renameTarget && !pendingFolderMove) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (pendingFolderMove) {
        setPendingFolderMove(null)
        return
      }
      setOpenLinkOpen(false)
      setRenameTarget(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [openLinkOpen, pendingFolderMove, renameTarget])

  const handleDownload = async (uri: string, name: string) => {
    try {
      await saveGfsFileToDisk(uri, name)
      pushToast?.(`Downloaded ${name}`, 'success')
    } catch (downloadError) {
      if (failClosedOnAuthorizationError(downloadError)) return
      pushToast?.(describeGfsReadError(downloadError).message, 'error')
    }
  }

  /**
   * BUG-175 — recursive folder export as one zip archive, assembled in the
   * renderer. The walk is throttled to the shared GFS read budget, refuses
   * over the size/entry ceilings with a clear message, can be stopped from the
   * progress strip, and reports entries it had to skip (no access / permission
   * denied) in a visible notice after the save so the archive's holes are
   * never silent.
   */
  const handleFolderZipDownload = async (folder: GfsDriveResource) => {
    if (zipJobRef.current) {
      pushToast?.(`Already preparing ${zipJobRef.current}.zip`, 'info')
      return
    }
    zipJobRef.current = folder.name
    const abortController = new AbortController()
    zipAbortRef.current = abortController
    const initialProgress: GfsFolderZipProgress = {
      phase: 'listing',
      filesFound: 0,
      filesAdded: 0,
      currentPath: null,
    }
    setZipJob({ folderName: folder.name, progress: initialProgress })
    try {
      const result = await createGfsFolderZip(
        { resourceId: folder.resourceId, drive: folder.drive || GFS_DRIVE_MAIN, name: folder.name },
        {
          onProgress: progress => setZipJob({ folderName: folder.name, progress }),
          signal: abortController.signal,
        }
      )
      if (result.saved) {
        pushToast?.(
          `Downloaded ${result.fileName} (${result.fileCount} ${result.fileCount === 1 ? 'file' : 'files'})`,
          'success'
        )
      } else {
        // The native save dialog was canceled: the temp archive is already
        // deleted by the stream's finish path — nothing was saved, by choice.
        pushToast?.(`${folder.name}.zip was not saved — the save dialog was canceled.`, 'info')
      }
      if (result.skipped.length) {
        pushToast?.(describeZipSkips(result.skipped), 'warn', { durationMs: 10_000 })
      }
    } catch (zipError) {
      if (isFolderZipAbortError(zipError)) {
        pushToast?.(`Stopped preparing ${folder.name}.zip.`, 'info')
      } else if (zipError instanceof GfsFolderZipEmptyError) {
        pushToast?.(zipError.message, 'info')
        if (zipError.skipped.length) {
          pushToast?.(describeZipSkips(zipError.skipped), 'warn', { durationMs: 10_000 })
        }
      } else if (!failClosedOnAuthorizationError(zipError)) {
        const message =
          zipError instanceof GfsFolderZipLimitError
            ? zipError.message
            : describeGfsReadError(zipError).message
        pushToast?.(message, 'error')
      }
    } finally {
      zipJobRef.current = null
      zipAbortRef.current = null
      setZipJob(null)
    }
  }

  const handleCopyLink = (uri: string) => copyGfsDeepLink(uri, pushToast)

  const handleRefreshCurrent = async () => {
    if (!current || refreshingCurrent) return
    beginExplicitFilesNavigation()
    setRefreshingCurrent(true)
    try {
      const refreshed = await ctrl.refreshCurrentLocation()
      if (!refreshed) throw new Error('The resource could not be refreshed')
      pushToast?.('EvenDrive refreshed', 'success')
    } catch (refreshError) {
      pushToast?.(
        refreshError instanceof Error ? refreshError.message : 'Could not refresh EvenDrive',
        'error'
      )
    } finally {
      setRefreshingCurrent(false)
    }
  }

  const handleOpenGfsLink = async (
    uri: string,
    onFailure?: (failure: GfsUriOpenFailure) => void,
    onOpened?: () => void,
    isCurrent?: () => boolean,
    openPendingPreview?: (
      preview: GfsPreviewResource,
      returnLocation: { gfsUri: string | null; name: string | null }
    ) => boolean
  ) => {
    const returnCrumbs = [...crumbs]
    const shouldContinue = () => pageActiveRef.current && (isCurrent?.() ?? true)
    const opened =
      onFailure || isCurrent
        ? await ctrl.openUri(uri, { onFailure, shouldContinue })
        : await ctrl.openUri(uri, { shouldContinue })
    // The resolver may settle after this keyed FilesPage has unmounted or the
    // pending link has changed. Do not let that stale continuation open a
    // preview, start a download, or restore this page's breadcrumbs.
    if (!shouldContinue()) return false
    if (opened === false) return false
    if (typeof opened === 'object' && opened.kind === 'file') {
      const preview = resolveGfsPreview(opened)
      // A valid pending-link preview callback may select its new Preview tab.
      // It already checked that this request still owned the active Files tab.
      // Settle that successful handoff before the resulting unmount invalidates
      // the Files-page ownership predicate.
      if (preview && openPendingPreview) {
        const returnCrumb = returnCrumbs.at(-1)
        const previewOpened = openPendingPreview(preview, {
          gfsUri: returnCrumb?.gfsUri ?? null,
          name: returnCrumb?.name ?? null,
        })
        if (!previewOpened) return false
        onOpened?.()
        return true
      }
      const previewOpened = openFilePreview(opened)
      if (!shouldContinue()) return false
      ctrl.restoreCrumbs(returnCrumbs)
      if (!previewOpened) {
        await handleDownload(opened.gfsUri, opened.name)
      }
      if (!shouldContinue()) return false
    }
    onOpened?.()
    return true
  }

  /**
   * Open a link handed over from the app level (a plugin's `gfs://` click that
   * this page handles better than the overlay). Cleared immediately so a
   * re-render cannot reopen it, and failures surface the browser's own error.
   */
  useEffect(() => {
    if (!pendingGfsUri || pendingGfsDeepLink) return
    // Re-arm on every non-null seed so a deep-link onto an already-mounted page
    // suppresses the pre-open location the same way the initial mount does.
    seedPendingRef.current = true
    onPendingGfsUriHandled?.()
    void handleOpenGfsLink(pendingGfsUri)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingGfsUri])

  const deepLinkRetryRequest =
    pendingGfsDeepLink && gfsDeepLinkRetry?.id === pendingGfsDeepLink.id
      ? gfsDeepLinkRetry.request
      : 0
  useEffect(() => {
    const link = pendingGfsDeepLink
    if (!link) return
    const retryRequest = deepLinkRetryRequest
    const releaseAfterEffectReplay = (
      owner: NonNullable<typeof pendingGfsDeepLinkEffectRef.current>
    ) => {
      const cleanupVersion = ++owner.cleanupVersion
      void Promise.resolve().then(() => {
        if (
          owner.cleanupVersion === cleanupVersion &&
          pendingGfsDeepLinkEffectRef.current === owner
        ) {
          pendingGfsDeepLinkEffectRef.current = null
        }
      })
    }
    const existingOwner = pendingGfsDeepLinkEffectRef.current
    if (
      existingOwner?.id === link.id &&
      existingOwner.uri === link.uri &&
      existingOwner.retryRequest === retryRequest
    ) {
      // React StrictMode replays effect setup after its development cleanup.
      // Retain the first real request so the replay cannot issue a second read.
      existingOwner.cleanupVersion += 1
      return () => releaseAfterEffectReplay(existingOwner)
    }
    const owner = { id: link.id, uri: link.uri, retryRequest, cleanupVersion: 0 }
    pendingGfsDeepLinkEffectRef.current = owner
    const isCurrent = () =>
      pendingGfsDeepLinkEffectRef.current === owner &&
      pageActiveRef.current &&
      (!pendingGfsDeepLinkOwnerTabId || pendingGfsDeepLinkOwnerTabId === workspaceTabId) &&
      (isPendingGfsDeepLinkCurrent?.() ?? true)
    seedPendingRef.current = true
    setPendingGfsDeepLinkFailure(null)

    if (!isCurrent()) {
      onPendingGfsDeepLinkOutcome?.(link.id, 'superseded')
      return () => releaseAfterEffectReplay(owner)
    }

    if (normalizeGfsResourceUri(link.uri) !== link.uri) {
      setPendingGfsDeepLinkFailure({
        id: link.id,
        message: 'This EvenDrive link is invalid or cannot be resolved.',
        retryable: false,
      })
      onPendingGfsDeepLinkOutcome?.(link.id, 'terminal')
      return () => releaseAfterEffectReplay(owner)
    }

    const reportFailure = (failure: GfsUriOpenFailure) => {
      if (!isCurrent()) return
      if (failure.kind === 'superseded') {
        onPendingGfsDeepLinkOutcome?.(link.id, 'superseded')
        return
      }

      const status = parseHttpStatus(
        failure.error instanceof Error ? failure.error.message : String(failure.error)
      )
      const retryable =
        status === null || status === 408 || status === 425 || status === 429 || status >= 500
      const message =
        status === 403
          ? 'You do not have permission to open this resource.'
          : status === 404
            ? 'This resource could not be found.'
            : status === 410
              ? 'This resource was deleted.'
              : status === 401
                ? 'Your session can no longer open this resource. Sign in again and reopen the link.'
                : status !== null && status >= 400 && status < 500 && status !== 401
                  ? 'This EvenDrive link is invalid or cannot be resolved.'
                  : describeGfsReadError(failure.error).message
      setPendingGfsDeepLinkFailure({ id: link.id, message, retryable })
      onPendingGfsDeepLinkOutcome?.(link.id, retryable ? 'retryable' : 'terminal')
    }

    void handleOpenGfsLink(
      link.uri,
      reportFailure,
      () => {
        setPendingGfsDeepLinkFailure(null)
        onPendingGfsDeepLinkOutcome?.(link.id, 'opened')
      },
      isCurrent,
      onOpenPendingGfsPreview
        ? (preview, returnLocation) => onOpenPendingGfsPreview(link.id, preview, returnLocation)
        : undefined
    ).catch(error => reportFailure({ kind: 'error', error }))

    return () => releaseAfterEffectReplay(owner)
    // The callback intentionally follows the active queue item and explicit
    // retry request. The page-level handlers close over the current resource.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingGfsDeepLink?.id, pendingGfsDeepLink?.uri, deepLinkRetryRequest])

  // Report the live location (leaf gfsUri + folder name) so the owning files tab
  // persists it (mini-spec 06 §3). `current` is the top of the breadcrumb stack;
  // `null` is the virtual root. Deps track the primitive fields so a re-render
  // that leaves the location unchanged does not re-emit.
  const currentGfsUri = current?.gfsUri ?? null
  const currentName = current?.name ?? null
  useEffect(() => {
    if (seedPendingRef.current) {
      // Seed still resolving: suppress the pre-seed root (null) that would clobber
      // the tab's persisted path. Once the stack lands (`current` non-null), the
      // seed is consumed — disarm here and report from now on. A failed open keeps
      // `current` null, so this stays armed and the seeded path is preserved (the
      // next successful navigation disarms and reports normally).
      if (currentGfsUri === null) return
      seedPendingRef.current = false
    }
    onLocationChange?.(currentGfsUri, currentName)
  }, [currentGfsUri, currentName, onLocationChange])

  const currentKind = current?.kind ?? null
  useEffect(() => {
    onResolvedLocationChange?.(
      currentGfsUri && currentKind ? { gfsUri: currentGfsUri, kind: currentKind } : null
    )
  }, [currentGfsUri, currentKind, onResolvedLocationChange])
  useEffect(() => () => onResolvedLocationChange?.(null), [onResolvedLocationChange])

  const handleCreateFolder = async (requestedName: string) => {
    const parentResourceId = createFolderParentId
    if (!parentResourceId) return
    const result = await runGfsCreateFolder(
      actionRunnerDeps(),
      { resourceId: parentResourceId, name: createFolderParentName ?? 'folder' },
      requestedName,
      { onPermitted: () => setCreateFolderError(null) }
    )
    if (result.status === 'done') {
      closeCreateFolder()
      pushToast?.(`Folder ${result.value.name} created`, 'success')
    } else if (result.status === 'failed') {
      if (failClosedOnAuthorizationError(result.error)) return
      setCreateFolderError(
        result.error instanceof Error ? result.error.message : String(result.error)
      )
    }
  }

  const handleUploadFile = async (
    file: File | null | undefined,
    parentResourceId = current?.resourceId,
    occupiedNames = new Set(items.map(item => item.name)),
    parentName = current?.name ?? 'folder'
  ) => {
    if (!file || !parentResourceId) return
    const result = await runGfsUpload(
      actionRunnerDeps(),
      { resourceId: parentResourceId, name: parentName },
      file,
      occupiedNames,
      uploadNameReservationsRef.current
    )
    if (result.status === 'done') {
      pushToast?.(`Uploaded ${result.value.name}`, 'success')
    } else if (result.status === 'failed') {
      if (failClosedOnAuthorizationError(result.error)) return
      pushToast?.(
        result.error instanceof Error ? result.error.message : String(result.error),
        'error'
      )
    }
  }

  const requestUploadForFolder = (
    parentResourceId: string,
    occupiedNames: Set<string>,
    parentName: string
  ) => {
    uploadTargetRef.current = { parentResourceId, occupiedNames, parentName }
    uploadInputRef.current?.click()
  }

  const clearResourceDrag = () => {
    // NOTE: deliberately does NOT bump dragSessionRef. The counter marks
    // GESTURES (dragstart); the drop handler compares its captured generation
    // after its async adjudication. The browser fires dragend ~immediately
    // after drop — bumping here invalidated the drop's OWN commit once the
    // adjudication resolved (cache-cold drops lost that race every time and
    // died silently). A new dragstart still invalidates in-flight decisions.
    draggingResourceRef.current = null
    draggingSourceRef.current = null
    hoveredFolderRef.current = null
    hoverOwnerRef.current = null
    dragSession?.endDrag()
    adjudication.endDragSession()
    setDraggingResourceId(null)
    setDragOverFolderId(null)
    setDropStatesById({})
    setDragSourceName(null)
  }

  /** Release only the source and hover work owned by the admitted gesture. */
  const finishDropCleanup = (
    source: GfsDragSource,
    gestureGeneration: number,
    sessionGeneration: number | null
  ) => {
    if (gestureGeneration !== dragSessionRef.current) return
    draggingResourceRef.current = null
    draggingSourceRef.current = null
    setDraggingResourceId(null)
    setDragSourceName(null)
    if (hoverOwnerRef.current === null || hoverOwnerRef.current === source) {
      hoverOwnerRef.current = null
      hoveredFolderRef.current = null
      setDragOverFolderId(null)
      setDropStatesById({})
      adjudication.endDragSession()
    }
    if (dragSession && dragSession.currentGeneration() === sessionGeneration) {
      dragSession.endDrag()
    }
  }

  /** Ancestor chain of rows in the current listing, nearest-first: the open
   * folder and its breadcrumb ancestors (an observation, never a guess). */
  const rowTargetAncestorIds = (): (string | null)[] =>
    currentIsFolder && current ? [...crumbs].map(crumb => crumb.resourceId).reverse() : []

  /** Build the cross-surface drag descriptor for a row of this surface. */
  const dragSourceFrom = (resource: GfsDriveResource): Omit<GfsDragSource, 'generation'> => {
    const parentKnown = currentIsFolder && current ? true : resource.parentResourceId != null
    const parentResourceId =
      currentIsFolder && current ? current.resourceId : (resource.parentResourceId ?? null)
    return {
      resourceId: resource.resourceId,
      gfsUri: resource.gfsUri,
      drive: resource.drive || GFS_DRIVE_MAIN,
      kind: resource.kind === 'directory' ? 'directory' : 'file',
      name: resource.name,
      ...(Number.isSafeInteger(resource.version) ? { version: resource.version } : {}),
      parentKnown,
      parentResourceId,
      knownAncestorIds:
        currentIsFolder && current ? [...crumbs].map(crumb => crumb.resourceId).reverse() : [],
      origin: 'files',
      scope: sessionScope ?? 'anonymous',
    }
  }

  /** A provider owns transport identity; local refs are only a provider-absent fallback. */
  const resolveActiveSource = (): GfsDragSource | null => {
    if (!dragSession) return draggingSourceRef.current
    const source = dragSession.activeSource()
    return source &&
      dragSession.matchesScope(sessionScope ?? 'anonymous') &&
      source.drive === GFS_DRIVE_MAIN
      ? source
      : null
  }

  const applyHoverVerdict = (
    folderId: string,
    verdict: GfsDropVerdict,
    folderName = '',
    sourceName = ''
  ): GfsDropVerdict => {
    // Only observed-allowed paints the blue highlight (UX matrix §5.5).
    if (verdict.state === 'allowed') {
      setDragOverFolderId(folderId)
    } else if (hoveredFolderRef.current === folderId) {
      setDragOverFolderId(null)
    }
    setDropStatesById(previous =>
      sameGfsDropVerdict(previous[folderId], verdict)
        ? previous
        : { ...previous, [folderId]: verdict }
    )
    setDropVerdictAnnouncement(gfsDropVerdictLiveAnnouncement(verdict, folderName, sourceName))
    return verdict
  }

  const handleResourceDragStart = (
    event: ReactDragEvent<HTMLElement>,
    resource: GfsDriveResource
  ) => {
    // Files AND folders drag; unreadable rows, in-flight moves and any pending
    // controller mutation stay frozen.
    if (resource.readable === false || movingResourceRef.current || ctrl.mutating) {
      event.preventDefault()
      return
    }
    dragSessionRef.current += 1
    const source: GfsDragSource = {
      ...dragSourceFrom(resource),
      generation: dragSessionRef.current,
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
    event.dataTransfer.setData(GFS_RESOURCE_DRAG_TYPE, resource.resourceId)
    event.dataTransfer.setData('text/plain', resource.name)
    draggingResourceRef.current = resource
    draggingSourceRef.current = source
    setDraggingResourceId(resource.resourceId)
    setDragSourceName(resource.name)
    // A new gesture clears the previous gesture's persistent surfaces.
    setDropSessionLost(false)
  }

  const handleResourceDragEnd = () => {
    clearResourceDrag()
  }

  const handleFolderDragOver = (event: ReactDragEvent<HTMLElement>, folder: GfsDriveResource) => {
    if (!hasDraggedGfsResource(event)) return
    const source = resolveActiveSource()
    // Self-hover is NO longer skipped: dropping an item onto itself paints the
    // denied verdict with its `self` reason, so the release can explain itself
    // instead of looking dead (UX matrix §5.3). Admission still refuses.
    if (!source || folder.kind !== 'directory') return

    event.preventDefault()
    event.stopPropagation()
    hoveredFolderRef.current = folder.resourceId
    hoverOwnerRef.current = source
    // The gesture may have started on ANOTHER surface (tree ↔ Files): the
    // resolved shared source — not a local dragstart — owns the name the
    // reason copy interpolates.
    setDragSourceName(previous => (previous === source.name ? previous : source.name))
    const target = {
      resourceId: folder.resourceId,
      name: folder.name,
      kind: folder.kind,
      ancestorIds: rowTargetAncestorIds(),
    } as const
    const verdict = applyHoverVerdict(
      folder.resourceId,
      adjudication.hoverVerdict(source, target),
      folder.name,
      source.name
    )
    // An OBSERVED deny must stay DELIVERABLE: dropEffect 'none' makes Chromium
    // cancel the drag at release, so the refused drop event never fires and
    // the reason could never be presented (UX matrix §5.3) — and 'checking'
    // must stay landable so the drop-time priority adjudication (rev-2 §4.1)
    // can decide. The tone-keyed row tint carries the denial; admission still
    // refuses the mutation.
    event.dataTransfer.dropEffect = 'move'
    if (verdict.state === 'checking') {
      adjudication.scheduleColdCheck(
        target,
        source.parentKnown ? source.parentResourceId : null,
        () => {
          if (hoverOwnerRef.current !== source || hoveredFolderRef.current !== folder.resourceId)
            return
          const fresh = adjudication.hoverVerdict(source, target)
          applyHoverVerdict(folder.resourceId, fresh, folder.name, source.name)
        }
      )
    }
  }

  const handleFolderDragLeave = (event: ReactDragEvent<HTMLElement>) => {
    if (!hasDraggedGfsResource(event)) return
    event.preventDefault()
    event.stopPropagation()
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      hoveredFolderRef.current = null
      setDragOverFolderId(null)
      setDropVerdictAnnouncement('')
    }
  }

  /** Nearest-first ancestor chain of a breadcrumb target, observed through the
   *  live trail (the crumbs above the hovered one). Crumbs are ancestors of
   *  the current folder, so a crumb can never be inside a dragged row — the
   *  descendant case is unreachable here and the policy sees an honest chain. */
  const crumbTargetAncestorIds = (index: number): string[] =>
    crumbs
      .slice(0, index)
      .map(trailCrumb => trailCrumb.resourceId)
      .reverse()

  /** Breadcrumb hover (drop-move parity with Control UI): paint the verdict on
   *  the crumb, keep internal drops deliverable even when denied (§5.3), and
   *  cold-check through the same budgeted adjudication the grid rows use. The
   *  dragged source is the shared drag-session source captured at dragstart —
   *  its parent identity is frozen, so the same-parent verdict can never be
   *  flipped by a trail reconstruction landing mid-gesture (Control UI R7). */
  const handleCrumbDragOver = (
    event: ReactDragEvent<HTMLElement>,
    crumb: GfsCrumb,
    index: number
  ) => {
    if (!hasDraggedGfsResource(event)) return
    const source = resolveActiveSource()
    if (!source) return
    event.preventDefault()
    event.stopPropagation()
    hoveredFolderRef.current = crumb.resourceId
    hoverOwnerRef.current = source
    setDragSourceName(previous => (previous === source.name ? previous : source.name))
    const target = {
      resourceId: crumb.resourceId,
      name: crumb.name,
      kind: 'directory',
      ancestorIds: crumbTargetAncestorIds(index),
    } as const
    const verdict = applyHoverVerdict(
      crumb.resourceId,
      adjudication.hoverVerdict(source, target),
      crumb.name,
      source.name
    )
    event.dataTransfer.dropEffect = 'move'
    if (verdict.state === 'checking') {
      adjudication.scheduleColdCheck(
        target,
        source.parentKnown ? source.parentResourceId : null,
        () => {
          if (hoverOwnerRef.current !== source || hoveredFolderRef.current !== crumb.resourceId)
            return
          applyHoverVerdict(
            crumb.resourceId,
            adjudication.hoverVerdict(source, target),
            crumb.name,
            source.name
          )
        }
      )
    }
  }

  /** Cached destination names for the suggested numbered-name candidate. */
  const cachedDestinationNames = (destinationId: string): Set<string> => {
    if (!sessionScope || !isGfsSessionGeneration(ctrl.sessionGeneration)) return new Set()
    const cached = queryClient.getQueryData<{ pages?: Array<{ items?: GfsDriveResource[] }> }>(
      desktopQueryKeys.gfsChildren(
        sessionScope,
        destinationId,
        GFS_DRIVE_MAIN,
        ctrl.sessionGeneration
      )
    )
    return new Set((cached?.pages ?? []).flatMap(page => page.items?.map(item => item.name) ?? []))
  }

  /** Shared move dispatch (rev-2 §5) used by the drag path, the folder
   * confirmation and the Move dialog — one service, one code path.
   *
   * `isCurrent` is the gesture-ownership predicate: the drag path passes the
   * ownership check it already runs at admission, so the commit re-validates
   * it at the dispatch boundary too. The explicit Move dialog passes its exact
   * snapshot and selection/workspace ownership predicate. */
  const runMoveCommit = async (
    source: GfsDragSource,
    destination: { resourceId: string; name: string },
    isCurrent?: () => boolean,
    expectedSourceSnapshot?: MoveCommitExpectedSourceSnapshot,
    reportOutcomes = true,
    authorizeNumberedRename?: (proposedName: string) => Promise<boolean>,
    authoritativeSessionGeneration?: number
  ): Promise<MoveCommitOutcome> => {
    movingResourceRef.current = source.resourceId
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
            ctrl.handleAuthorityFailure(
              message,
              'operation',
              source.scope,
              authoritativeSessionGeneration ?? null
            ),
          ...(authorizeNumberedRename ? { authorizeNumberedRename } : {}),
          convergeCommittedMove: (input, receipt) =>
            ctrl.convergeCommittedMove(input, receipt, source.scope),
          ...(reportOutcomes && pushToast
            ? {
                pushToast: (message, tone) => {
                  if (
                    pageActiveRef.current &&
                    isGfsSessionAuthorityCurrent(
                      source.scope,
                      authoritativeSessionGeneration ?? null,
                      moveWorkspaceRef.current.sessionScope,
                      moveWorkspaceRef.current.sessionGeneration
                    )
                  ) {
                    pushToast(message, tone)
                  }
                },
              }
            : {}),
        },
        {
          source,
          destination,
          ...(expectedSourceSnapshot ? { expectedSourceSnapshot } : {}),
          occupiedDestinationNames: cachedDestinationNames(destination.resourceId),
          ...(authoritativeSessionGeneration !== undefined
            ? { sessionGeneration: authoritativeSessionGeneration }
            : {}),
          ...(isCurrent ? { isCurrent } : {}),
        }
      )
    } finally {
      movingResourceRef.current = null
      setMovingResourceId(null)
    }
  }

  const handleFolderDrop = async (
    event: ReactDragEvent<HTMLElement>,
    destination: GfsFolderDropTarget
  ) => {
    if (!hasDraggedGfsResource(event)) return
    event.preventDefault()
    event.stopPropagation()
    hoveredFolderRef.current = null
    setDragOverFolderId(null)
    setDropStatesById({})
    setDropVerdictAnnouncement('')
    const source = resolveActiveSource()
    if (!source || destination.kind !== 'directory' || movingResourceRef.current) return

    const dragGeneration = dragSessionRef.current
    const sessionGeneration = dragSession?.currentGeneration() ?? null
    const scopeAtDrop = liveDragScopeRef.current
    const publishedGeneration = ctrl.sessionGeneration
    const ownsPublishedAuthority = () =>
      isGfsSessionAuthorityCurrent(
        source.scope,
        publishedGeneration,
        moveWorkspaceRef.current.sessionScope,
        moveWorkspaceRef.current.sessionGeneration
      )
    if (!ownsPublishedAuthority()) return
    try {
      const authoritativeSessionGeneration = await window.clerum.auth.getSessionGeneration()
      if (authoritativeSessionGeneration !== publishedGeneration || !ownsPublishedAuthority())
        return
      const decision = await adjudication.adjudicateDrop(source, {
        resourceId: destination.resourceId,
        name: destination.name,
        kind: destination.kind,
        ancestorIds: rowTargetAncestorIds(),
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
            capturedEpoch: dragGeneration,
            liveEpoch: dragSessionRef.current,
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
      if (!ownsDrop(source, dragGeneration, sessionGeneration)) return
      if (!decision.allowed) {
        const { message, tone } = presentGfsDropRefusal(decision, {
          source: source.name,
          target: destination.name,
        })
        setDropVerdictAnnouncement(message)
        pushToast?.(message, tone)
        return
      }
      if (source.kind === 'directory') {
        // The ONE folder confirmation discloses inherited-access impact. A
        // drag permission probe does not consent to a numbered rename.
        setPendingFolderMove({
          source,
          gestureGeneration: dragGeneration,
          sessionGeneration,
          authoritativeSessionGeneration,
          destination: { resourceId: destination.resourceId, name: destination.name },
        })
        return
      }
      await runMoveCommit(
        source,
        { resourceId: destination.resourceId, name: destination.name },
        () => ownsPublishedAuthority() && ownsDrop(source, dragGeneration, sessionGeneration),
        undefined,
        true,
        undefined,
        authoritativeSessionGeneration
      )
    } finally {
      finishDropCleanup(source, dragGeneration, sessionGeneration)
    }
  }

  const handleGfsDragEnter = (event: ReactDragEvent<HTMLElement>) => {
    if (!hasDraggedFiles(event)) return
    event.preventDefault()
    setDragActive(true)
  }

  const handleGfsDragOver = (event: ReactDragEvent<HTMLElement>) => {
    if (!hasDraggedFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = droppedUploadRestriction ? 'none' : 'copy'
    setDragActive(true)
  }

  const handleGfsDragLeave = (event: ReactDragEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDragActive(false)
  }

  const handleGfsDrop = async (event: ReactDragEvent<HTMLElement>) => {
    if (!hasDraggedFiles(event)) return
    event.preventDefault()
    setDragActive(false)

    if (droppedUploadRestriction) {
      pushToast?.(droppedUploadRestriction, 'error')
      return
    }
    const destinationResourceId = current?.resourceId
    if (!destinationResourceId) {
      pushToast?.('Open a folder before uploading files.', 'error')
      return
    }

    const droppedFiles = Array.from(event.dataTransfer.files || [])
    if (!droppedFiles.length) {
      pushToast?.('No files were dropped.', 'error')
      return
    }

    setDroppedUploadCount(droppedFiles.length)
    const occupiedNames = new Set(items.map(item => item.name))
    try {
      for (const file of droppedFiles) {
        await handleUploadFile(
          file,
          destinationResourceId,
          occupiedNames,
          current?.name ?? 'folder'
        )
      }
    } finally {
      setDroppedUploadCount(0)
    }
  }

  const handleReplaceCurrentFile = async (file: File | null | undefined) => {
    if (!file || !current) return
    const target = {
      resourceId: current.resourceId,
      name: current.name,
      version: current.version,
    }
    const requestContext = rowActionContextRef.current
    try {
      const guards = bindGfsActionGuards(actionRunnerDeps())
      if (!guards) return
      assertGfsFileUploadSize(file.size)
      const filePath = window.clerum.gfs.getPathForFile(file)
      if (!filePath) throw new Error('Could not resolve the selected local file')
      pushToast?.(`Checking write permission for ${target.name}…`, 'info')
      const allowed = await requireFreshRowPermissions(target.resourceId, target.name, ['write'])
      const latest = rowActionContextRef.current
      if (
        !pageActiveRef.current ||
        latest.sessionScope !== requestContext.sessionScope ||
        latest.currentResourceId !== requestContext.currentResourceId ||
        latest.resourceVersions.get(target.resourceId) !== target.version
      ) {
        pushToast?.(
          `Replace was not started for ${target.name} because the workspace changed.`,
          'error'
        )
        return
      }
      if (!allowed || !(await guards.admitEffect())) return
      await ctrl.replaceFileFromPath(target.resourceId, filePath, target.version)
      pushToast?.(`Replaced ${target.name}`, 'success')
    } catch (replaceError) {
      if (failClosedOnAuthorizationError(replaceError)) return
      pushToast?.(
        replaceError instanceof Error ? replaceError.message : String(replaceError),
        'error'
      )
    }
  }

  const handleDeleteResource = async (resource: GfsActionTarget) => {
    try {
      const result = await runGfsDelete(actionRunnerDeps(), resource)
      if (result.status === 'done') {
        pushToast?.(`Deleted ${resource.name}`, 'success')
      } else if (result.status === 'failed' && !failClosedOnAuthorizationError(result.error)) {
        pushToast?.(
          result.error instanceof Error ? result.error.message : String(result.error),
          'error'
        )
      }
    } finally {
      setDeleteTarget(null)
    }
  }

  /**
   * Folder children do not carry permission bits in the listing payload. The
   * controller resolves each visible row independently; retain the selected
   * row fallback for older controller shapes and while an overflow query is
   * transitioning.
   */
  const rowAffordancesFor = (resource: GfsDriveResource) => {
    if (!currentIsFolder) return null
    return (
      ctrl.rowAffordancesByResourceId?.[resource.resourceId] ??
      (ctrl.rowAffordancesResourceId === resource.resourceId ? ctrl.rowAffordances : null)
    )
  }

  /** Row action gates. Shared-with-me rows carry their permission bits
   * directly; child rows use their own server-computed affordances. Move is
   * judged on the exact server-authorized old parent. */
  const rowActionAvailability = (resource: GfsDriveResource) => {
    const sourceParentId = resource.parentResourceId
    const parentIsCurrent = sourceParentId === current?.resourceId
    const parentAffordances =
      !sourceParentId ||
      accessRevoked ||
      (parentIsCurrent && ctrl.affordancesError && ctrl.affordancesHttpStatus !== 429)
        ? null
        : parentIsCurrent
          ? ctrl.affordances
          : ctrl.moveSourceParentAffordancesById?.[sourceParentId]
    return gfsRowActionAvailability({
      resource,
      listing: currentIsFolder ? 'folder' : 'roots',
      rowAffordances: rowAffordancesFor(resource),
      parentAffordances,
    })
  }

  /** Move commits bubble their failure back to the dialog (in-place banner);
   *  success toasts and closes it. An authority rejection instead fails the
   *  session closed and closes the dialog — the revoked state takes over.
   *  ifMatch pins the resource version. */
  const handleMoveTarget = async (
    destinationId: string,
    destinationName: string,
    executeMove = true,
    isDialogCurrent?: () => boolean,
    requestNumberedNameConsent?: (proposedName: string) => Promise<boolean>
  ) => {
    if (!moveTarget) return
    const target = moveTarget
    const dialogGeneration = moveDialogGenerationRef.current
    const ownsDialogGeneration = () => moveDialogGenerationRef.current === dialogGeneration
    const ownsDialog = () => ownsDialogGeneration() && (isDialogCurrent?.() ?? true)
    const closeOwnedDialog = () => {
      if (!ownsDialogGeneration()) return
      closeMoveDialog()
      setMovePermissionStatus(null)
    }
    const sourceParentId =
      target.parentResourceId ??
      (target.resourceId === current?.resourceId ? current.parentResourceId : null)
    const origin = {
      sessionScope,
      sessionGeneration: ctrl.sessionGeneration,
      currentResourceId: current?.resourceId ?? null,
      resourceId: target.resourceId,
      sourceParentId,
      destinationId,
      version: target.version,
    }
    const sessionStillMatches = () =>
      isGfsSessionAuthorityCurrent(
        origin.sessionScope,
        origin.sessionGeneration,
        moveWorkspaceRef.current.sessionScope,
        moveWorkspaceRef.current.sessionGeneration
      )
    const contextStillMatches = () =>
      sessionStillMatches() &&
      moveWorkspaceRef.current.currentResourceId === origin.currentResourceId
    let authoritativeSessionGeneration: number | null = null
    const ownsAuthoritativeSession = async () => {
      if (
        !isGfsSessionGeneration(authoritativeSessionGeneration) ||
        authoritativeSessionGeneration !== origin.sessionGeneration ||
        !sessionStillMatches()
      )
        return false
      try {
        return (await window.clerum.auth.getSessionGeneration()) === authoritativeSessionGeneration
      } catch {
        return false
      }
    }
    let permissionsChecked = false
    if (!ownsDialog()) return
    setMovePermissionStatus('checking')
    try {
      authoritativeSessionGeneration = await window.clerum.auth.getSessionGeneration()
      if (
        !sessionScope ||
        !sourceParentId ||
        !isGfsSessionGeneration(authoritativeSessionGeneration) ||
        authoritativeSessionGeneration !== origin.sessionGeneration ||
        !sessionStillMatches()
      ) {
        throw new Error('Could not verify the source folder for this move.')
      }
      const sourceKey = desktopQueryKeys.gfsAffordances(
        sessionScope,
        sourceParentId,
        GFS_DRIVE_MAIN,
        authoritativeSessionGeneration
      )
      const destinationKey = desktopQueryKeys.gfsAffordances(
        sessionScope,
        destinationId,
        GFS_DRIVE_MAIN,
        authoritativeSessionGeneration
      )
      assertGfsAuthorityRetryAllowed(queryClient, sourceKey)
      assertGfsAuthorityRetryAllowed(queryClient, destinationKey)
      const [source, destination] = await Promise.all([
        queryClient.fetchQuery({
          queryKey: sourceKey,
          queryFn: () => window.clerum.gfs.affordances(sourceParentId, GFS_DRIVE_MAIN),
          staleTime: 0,
          retry: false,
        }),
        queryClient.fetchQuery({
          queryKey: destinationKey,
          queryFn: () => window.clerum.gfs.affordances(destinationId, GFS_DRIVE_MAIN),
          staleTime: 0,
          retry: false,
        }),
      ])
      if (!(await ownsAuthoritativeSession())) {
        closeOwnedDialog()
        return
      }
      if (!pageActiveRef.current || !ownsDialogGeneration()) return
      if (!contextStillMatches()) {
        closeOwnedDialog()
        return
      }
      if (!ownsDialog()) {
        setMovePermissionStatus(null)
        return
      }
      if (!hasGfsMoveSourcePermissions(source.held)) {
        throw new Error('You do not have write and delete access to the source folder.')
      }
      if (!destination.held.includes('write')) {
        throw new Error('You do not have write access to the destination folder.')
      }
      permissionsChecked = true
      if (!ownsDialog()) return
      if (!contextStillMatches()) {
        throw new Error(
          'Move was not started because the workspace changed; review the destination.'
        )
      }
      if (!executeMove) {
        setMovePermissionStatus(null)
        return
      }

      const moveSource: GfsDragSource = {
        resourceId: target.resourceId,
        gfsUri: `gfs://${GFS_DRIVE_MAIN}/${target.resourceId.replace(/-/g, '').toLowerCase()}`,
        drive: GFS_DRIVE_MAIN,
        kind: target.kind,
        name: target.name,
        ...(Number.isSafeInteger(target.version) ? { version: target.version } : {}),
        parentKnown: true,
        parentResourceId: sourceParentId,
        knownAncestorIds: [],
        origin: 'files',
        scope: sessionScope,
        generation: dragSessionRef.current,
      }
      const expectedSourceSnapshot: MoveCommitExpectedSourceSnapshot = {
        resourceId: target.resourceId,
        version: target.version,
        parentResourceId: sourceParentId,
      }
      const authorizeNumberedRename = async (proposedName: string): Promise<boolean> => {
        if (
          !requestNumberedNameConsent ||
          !pageActiveRef.current ||
          !ownsDialog() ||
          !contextStillMatches() ||
          !(await ownsAuthoritativeSession())
        ) {
          return false
        }
        const consented = await requestNumberedNameConsent(proposedName)
        if (
          !consented ||
          !pageActiveRef.current ||
          !ownsDialog() ||
          !contextStillMatches() ||
          !(await ownsAuthoritativeSession())
        ) {
          return false
        }

        // A numbered rename+move needs fresh authority for the entire server
        // operation: resource write, old-parent write+delete, and destination
        // write. Source-resource write by itself is not enough.
        setMovePermissionStatus('checking')
        try {
          const resourceKey = desktopQueryKeys.gfsAffordances(
            origin.sessionScope,
            target.resourceId,
            GFS_DRIVE_MAIN,
            authoritativeSessionGeneration
          )
          const sourceParentKey = desktopQueryKeys.gfsAffordances(
            origin.sessionScope,
            sourceParentId,
            GFS_DRIVE_MAIN,
            authoritativeSessionGeneration
          )
          const destinationKey = desktopQueryKeys.gfsAffordances(
            origin.sessionScope,
            destinationId,
            GFS_DRIVE_MAIN,
            authoritativeSessionGeneration
          )
          for (const key of [resourceKey, sourceParentKey, destinationKey]) {
            assertGfsAuthorityRetryAllowed(queryClient, key)
          }
          const [resourceAuthority, sourceParentAuthority, destinationAuthority] =
            await Promise.all([
              queryClient.fetchQuery({
                queryKey: resourceKey,
                queryFn: () => window.clerum.gfs.affordances(target.resourceId, GFS_DRIVE_MAIN),
                staleTime: 0,
                retry: false,
              }),
              queryClient.fetchQuery({
                queryKey: sourceParentKey,
                queryFn: () => window.clerum.gfs.affordances(sourceParentId, GFS_DRIVE_MAIN),
                staleTime: 0,
                retry: false,
              }),
              queryClient.fetchQuery({
                queryKey: destinationKey,
                queryFn: () => window.clerum.gfs.affordances(destinationId, GFS_DRIVE_MAIN),
                staleTime: 0,
                retry: false,
              }),
            ])
          return (
            (await ownsAuthoritativeSession()) &&
            pageActiveRef.current &&
            ownsDialog() &&
            contextStillMatches() &&
            resourceAuthority.held.includes('write') &&
            hasGfsMoveSourcePermissions(sourceParentAuthority.held) &&
            destinationAuthority.held.includes('write')
          )
        } finally {
          if (ownsDialogGeneration()) setMovePermissionStatus(null)
        }
      }
      if (!pageActiveRef.current || !ownsDialog()) return
      if (!(await ownsAuthoritativeSession())) {
        closeOwnedDialog()
        return
      }
      if (!contextStillMatches()) {
        throw new Error(
          'Move was not started because the workspace changed; review the destination.'
        )
      }
      // The permission-checking state belongs only to the reads above. Let the
      // consent prompt remain actionable after the original PATCH settles.
      setMovePermissionStatus(null)
      const outcome = await runMoveCommit(
        moveSource,
        { resourceId: destinationId, name: destinationName },
        () => pageActiveRef.current && ownsDialog() && contextStillMatches(),
        expectedSourceSnapshot,
        false,
        authorizeNumberedRename,
        authoritativeSessionGeneration ?? undefined
      )
      if (!pageActiveRef.current) return
      if (!sessionStillMatches()) {
        closeOwnedDialog()
        return
      }
      if (!contextStillMatches() || !ownsDialog()) {
        const selectionChangedOnOwnedDialog =
          contextStillMatches() &&
          ownsDialogGeneration() &&
          isDialogCurrent !== undefined &&
          !isDialogCurrent()
        if (selectionChangedOnOwnedDialog && outcome.status !== 'session-lost') {
          toastMoveOutcome(pushToast, outcome, target.name, destinationName, target.kind)
          setMovePermissionStatus(null)
          return
        }
        // After dispatch, the operation owns its captured result. A changed
        // destination selection keeps its dialog; route/session changes and a
        // closed dialog still use the page-owned toast and generation fence.
        toastMoveOutcome(pushToast, outcome, target.name, destinationName, target.kind)
        closeOwnedDialog()
        return
      }
      if (outcome.status === 'session-lost' || outcome.status === 'gesture-lost') {
        if (outcome.status === 'session-lost') closeOwnedDialog()
        else setMovePermissionStatus(null)
        return
      }
      if (outcome.status !== 'committed' && outcome.status !== 'no-op') {
        throw new Error(outcome.message)
      }
      toastMoveOutcome(pushToast, outcome, target.name, destinationName, target.kind)
    } catch (moveError) {
      if (!pageActiveRef.current) return
      if (!ownsDialogGeneration()) return
      if (authoritativeSessionGeneration !== null && !(await ownsAuthoritativeSession())) {
        closeOwnedDialog()
        return
      }
      if (!contextStillMatches()) {
        closeOwnedDialog()
        return
      }
      if (!ownsDialog()) {
        setMovePermissionStatus(null)
        return
      }
      if (
        failClosedOnAuthorizationError(
          moveError,
          origin.sessionScope,
          authoritativeSessionGeneration ?? origin.sessionGeneration
        )
      ) {
        closeOwnedDialog()
        return
      }
      setMovePermissionStatus(permissionsChecked ? null : 'failed')
      throw moveError
    }
    closeOwnedDialog()
  }

  const requestMoveCurrent = () => {
    if (current) showMoveDialog(current)
  }

  /** Rename runs inline for any row or the current resource; failures toast
   *  (a stale version asks the user to retry). */
  const handleRenameTarget = async () => {
    if (!renameTarget) return
    const target = renameTarget
    const result = await runGfsRename(actionRunnerDeps(), target, renameDraft)
    if (result.status === 'unchanged') {
      setRenameTarget(null)
    } else if (result.status === 'done') {
      setRenameTarget(null)
      pushToast?.(`Renamed to ${result.value.name}`, 'success')
    } else if (result.status === 'failed') {
      if (failClosedOnAuthorizationError(result.error)) return
      pushToast?.(
        result.error instanceof Error ? result.error.message : String(result.error),
        'error'
      )
    }
  }

  const openRenameTarget = (target: GfsActionTarget) => {
    runWithOpeningAuthority(target, 'rename', () => {
      setRenameTarget(target)
      setRenameDraft(target.name)
    })
  }

  const openMoveTarget = (target: GfsActionTarget) => {
    const authority = gfsActionOpeningAuthority(target, 'move')
    if (authority.kind === 'unverifiable') {
      pushToast?.(authority.message, 'error')
      return
    }
    // Only an opening that can run supersedes a pending one.
    const openGeneration = moveDialogGenerationRef.current + 1
    moveDialogGenerationRef.current = openGeneration
    void runWithFreshResourcePermissions(
      target,
      authority.resourceId,
      authority.resourceName,
      [...authority.bits],
      () => {
        if (moveDialogGenerationRef.current === openGeneration) setMoveTarget(target)
      }
    )
  }

  // An open folder's breadcrumb carries route identity but not row metadata.
  // Adapt that exact current URI for the shared folder action model.
  const crumbAsResource = (crumb: GfsCrumb): GfsDriveResource => ({
    resourceId: crumb.resourceId,
    rid: crumb.resourceId.replace(/-/g, '').toLowerCase(),
    gfsUri: crumb.gfsUri,
    drive: GFS_DRIVE_MAIN,
    parentResourceId: null,
    name: crumb.name,
    kind: 'directory',
    path: null,
    version: crumb.version,
    bytes: crumb.bytes,
  })

  const visibleResources = useMemo<GfsDriveResource[]>(() => {
    const resources = currentIsFolder ? items : currentIsFile ? [] : accessibleResources
    return [...resources].sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === 'directory' ? -1 : 1
      }
      return (left.name || left.drive).localeCompare(right.name || right.drive)
    })
  }, [accessibleResources, currentIsFile, currentIsFolder, items])
  // The controller owns current-view loading semantics, including the
  // page-wide authority gate and the distinction between initial and
  // background query activity.
  const visibleLoading = loadingCurrentView
  const visibleError = currentIsFolder ? error : !current ? accessibleError : null
  const unavailableLocation = !current && openError === GFS_UNAVAILABLE_LOCATION_MESSAGE
  // Scoped to the root view on purpose: `accessibleError` only reaches
  // `visibleError` when there is no `current`, so the card replaces exactly the
  // banner it suppresses and never hides a folder-listing error behind it.
  //
  // Also scoped to an empty listing. The discovery query is infinite, and
  // TanStack populates `error` on a rejected `fetchNextPage` while `data` still
  // holds every page fetched so far. Without this guard a `Load more` that hit
  // the budget replaced an intact listing with a full-surface card — the rows
  // the user already had vanished to report that the NEXT page failed. With
  // rows on screen the failure stays in the banner `visibleError` renders, so
  // it is still surfaced, just not by destroying the page.
  const blockingDiscoveryFailure =
    !current &&
    visibleResources.length === 0 &&
    ctrl.discoveryFailure &&
    ctrl.discoveryFailure.kind !== 'unsupported'
      ? ctrl.discoveryFailure
      : null
  // The same verdict for the other read plane. A folder listing refused by the
  // budget used to fall through to "This folder is empty", which states as fact
  // the one thing the failed request could not establish — and offered nothing
  // to retry. The classification reuses the exported helpers rather than a
  // second classifier; `unsupported` has no meaning here because listing
  // children is not the endpoint an older server lacks.
  const folderFailure = useMemo<GfsDiscoveryFailure | null>(() => {
    if (!currentIsFolder || !error || visibleResources.length > 0) return null
    const kind = isRateLimited(error) ? 'rate-limited' : 'failed'
    const retryAfterSeconds = parseRetryAfterSeconds(error)
    return {
      kind,
      message: error,
      retryAvailableAt:
        kind === 'rate-limited' && retryAfterSeconds !== null
          ? ctrl.errorUpdatedAt + retryAfterSeconds * 1000
          : null,
    }
  }, [ctrl.errorUpdatedAt, currentIsFolder, error, visibleResources.length])
  // One card, two planes, each retrying the query that actually failed. Root
  // discovery wins when both are set: `folderFailure` needs `currentIsFolder`,
  // and `blockingDiscoveryFailure` needs no `current`, so the two are mutually
  // exclusive by construction — the order below is a formality, not a policy.
  const blockingFailure = blockingDiscoveryFailure
    ? { failure: blockingDiscoveryFailure, retry: ctrl.retryDiscovery }
    : folderFailure
      ? { failure: folderFailure, retry: ctrl.retryChildren }
      : null
  // Scoped to the root for the same reason the card is: `discoveryFailure`
  // describes the root listing and stays set while the user browses a folder.
  // Without `!current`, a genuinely empty directory would be reported as a
  // server that cannot list.
  const rootListingUnsupported = !current && ctrl.discoveryFailure?.kind === 'unsupported'
  // `visibleLoading` starts with `authorityPending`, which a 429 leaves true on
  // purpose — a rate limit does not re-prove the session. The failure card
  // renders ahead of the loader, so without excluding it here a screen reader
  // would call the region busy while it shows a settled error and a Retry button.
  const driveBusy = (visibleLoading && !blockingFailure) || droppedUploadCount > 0
  const hasMoreVisible = currentIsFolder ? ctrl.hasMore : !current && ctrl.hasMoreAccessible
  const loadingMoreVisible = currentIsFolder ? ctrl.isFetchingMore : ctrl.isFetchingMoreAccessible

  // A dialog opened under another session has nothing left to show, and the
  // location it would return to belongs to that session too: it is dropped,
  // never restored into the session that replaced it.
  const manageTargetSessionCurrent =
    manageTarget !== null &&
    manageTarget.sessionScope === sessionScope &&
    manageTarget.sessionGeneration === ctrl.sessionGeneration
  const manageDialogTarget =
    manageTarget && manageTargetSessionCurrent
      ? manageTarget.resource === 'current'
        ? current
        : manageTarget.resource
      : null
  useEffect(() => {
    if (!manageTarget || manageTargetSessionCurrent) return
    manageReturnCrumbsRef.current = null
    setManageTarget(null)
  }, [manageTarget, manageTargetSessionCurrent])
  const manageAccessDeps: GfsManageAccessDeps = {
    gate: ctrl.authorityPending || accessRevoked,
    handleAuthorityFailure: ctrl.handleAuthorityFailure,
    failClosed: error => failClosedOnAuthorizationError(error),
    freshPermissions: (resourceId, resourceName, bits, grantableBits) =>
      requireFreshRowPermissions(resourceId, resourceName, bits, GFS_DRIVE_MAIN, grantableBits),
    fetchAuthority: (resourceId, resourceName) =>
      fetchRowAuthority(resourceId, resourceName, GFS_DRIVE_MAIN),
    readAccessState: () => ctrl.readAccessState(),
    publishedGeneration: () => moveWorkspaceRef.current.sessionGeneration,
    originScope: () => moveWorkspaceRef.current.sessionScope,
  }

  // A folder row is shared in place: the browser keeps its location. A file
  // row still opens the file first, because the open file is the only way
  // into the current-file view (Replace, preview, download from the title).
  const openManage = (resource: GfsDriveResource) => {
    runWithOpeningAuthority(resource, 'share', () => {
      setCreateFolderOpen(false)
      if (resource.kind === 'directory') {
        manageReturnCrumbsRef.current = null
        setManageTarget({ resource, sessionScope, sessionGeneration: ctrl.sessionGeneration })
        return
      }
      if (resource.resourceId !== current?.resourceId) {
        beginExplicitFilesNavigation()
        manageReturnCrumbsRef.current = [...crumbs]
        ctrl.openResource(resource)
      } else {
        manageReturnCrumbsRef.current = crumbs.slice(0, -1)
      }
      setManageTarget({
        resource: 'current',
        sessionScope,
        sessionGeneration: ctrl.sessionGeneration,
      })
    })
  }

  const openManageCurrent = () => {
    if (!current) return
    runWithOpeningAuthority(current, 'share', () => {
      manageReturnCrumbsRef.current = currentIsFile ? crumbs.slice(0, -1) : null
      setCreateFolderOpen(false)
      setManageTarget({
        resource: 'current',
        sessionScope,
        sessionGeneration: ctrl.sessionGeneration,
      })
    })
  }

  const currentResourceActions = current
    ? buildGfsResourceActions(
        filesCurrentResourceActionOptions({
          kind: current.kind,
          uri: current.gfsUri,
          canWrite: canWriteCurrent,
          canManage: canManageCurrent,
          canDelete: canDeleteCurrent,
          canMove: canMoveCurrent,
          previewable: currentPreviewAvailable,
          mutating: ctrl.mutating,
          refreshing: refreshingCurrent,
          handlers: {
            refresh: () => void handleRefreshCurrent(),
            'copy-link': () => void handleCopyLink(current.gfsUri),
            'open-route': () => setOpenLinkOpen(true),
            rename: () => openRenameTarget(current),
            move: () => openMoveTarget(current),
            'new-folder': () => openCreateFolder(current.resourceId, current.name),
            'upload-file': () =>
              requestUploadForFolder(
                current.resourceId,
                new Set(items.map(item => item.name)),
                current.name
              ),
            share: () => openManageCurrent(),
            preview: () => void openFilePreview(current),
            download: () => void handleDownload(current.gfsUri, current.name),
            'download-zip': () => void handleFolderZipDownload(crumbAsResource(current)),
            replace: (file, context) => {
              if (file) void handleReplaceCurrentFile(file)
              else context?.requestFileSelection?.()
            },
            delete: () => void openDeleteTarget(current),
          },
        })
      )
    : []

  const openResource = (resource: GfsDriveResource) => {
    // The children listing marks rows the session cannot read (e.g. a folder
    // grant without inheritance). Surfacing that here keeps the click honest
    // instead of failing later with a bare download 403. Rows without the
    // flag (older servers) keep today's behavior.
    if (resource.readable === false) {
      pushToast?.(`You do not have read access to ${resource.name || resource.drive}`, 'error')
      return
    }
    beginExplicitFilesNavigation()
    if (resource.kind === 'directory') {
      if (currentIsFolder) ctrl.openChild(resource)
      else ctrl.openResource(resource)
      return
    }
    if (openFilePreview(resource)) return
    void handleDownload(resource.gfsUri, resource.name)
  }

  const resourceMenuActionsFor = (
    resource: GfsDriveResource,
    availability: GfsRowActionAvailability
  ) =>
    getGfsMenuActions(
      buildGfsResourceActions(
        filesRowActionOptions({
          kind: resource.kind,
          uri: resource.gfsUri,
          readable: resource.readable,
          previewable: isGfsPreviewFile(resource.name),
          availability,
          mutating: ctrl.mutating,
          handlers: {
            'copy-link': () => void handleCopyLink(resource.gfsUri),
            'open-route': () => setOpenLinkOpen(true),
            'open-folder': () => openResource(resource),
            'new-folder': () => openCreateFolder(resource.resourceId, resource.name),
            'upload-file': () =>
              requestUploadForFolder(resource.resourceId, new Set(), resource.name),
            rename: () => openRenameTarget(resource),
            move: () => openMoveTarget(resource),
            share: () => openManage(resource),
            delete: () => openDeleteTarget(resource),
            preview: () => void openFilePreview(resource),
            download: () => void handleDownload(resource.gfsUri, resource.name),
            'download-zip': () => void handleFolderZipDownload(resource),
          },
        })
      )
    )

  const currentIsBeingRenamed = renameTarget?.resourceId === current?.resourceId
  const currentIsInBreadcrumbs = Boolean(
    current && crumbs.some(crumb => crumb.resourceId === current.resourceId)
  )

  return (
    <section className="page da-gfs-page">
      <GfsResourceTitlebarActions
        target={titlebarLeadingTarget}
        onRefresh={current ? () => void handleRefreshCurrent() : () => void ctrl.retryDiscovery()}
        refreshing={current ? refreshingCurrent : visibleLoading}
        onCopyLink={current ? () => void handleCopyLink(current.gfsUri) : undefined}
        onOpenLink={() => setOpenLinkOpen(true)}
      />
      {/* The drop verdict is painted on the target row; this live region is
          its spoken form, so a screen reader learns whether the folder under
          the pointer accepts the move (RP-026). */}
      <p aria-live="polite" className="visually-hidden">
        {dropVerdictAnnouncement}
      </p>
      <div className="page-header">
        <h2>Files</h2>
        <p className="muted">Browse and manage everything shared with you in one place.</p>
      </div>

      <div className="page-layout da-gfs-layout">
        <section
          className="page-card da-gfs-drive"
          aria-label="EvenDrive browser"
          aria-busy={driveBusy}
          onDragEnter={handleGfsDragEnter}
          onDragLeave={handleGfsDragLeave}
          onDragOver={handleGfsDragOver}
          onDrop={event => void handleGfsDrop(event)}
        >
          <div className="page-card__header da-gfs-drive__header">
            <div className="da-gfs-drive__title-row">
              <nav className="da-gfs-drive__breadcrumbs" aria-label="File location">
                <Button
                  className="da-gfs-drive__breadcrumb"
                  color="neutral"
                  disabled={!current}
                  onClick={() => {
                    beginExplicitFilesNavigation()
                    manageReturnCrumbsRef.current = null
                    setManageTarget(null)
                    ctrl.reset()
                  }}
                  variant="text"
                >
                  Shared with me
                </Button>
                {crumbs.map((crumb, index) => (
                  <span className="da-gfs-drive__crumb-group" key={crumb.resourceId}>
                    <IconChevronRight aria-hidden="true" />
                    {renameTarget?.resourceId === crumb.resourceId ? (
                      <GfsInlineRename
                        className="da-gfs-drive__inline-rename"
                        onCancel={() => setRenameTarget(null)}
                        onChange={setRenameDraft}
                        onSubmit={() => void handleRenameTarget()}
                        value={renameDraft}
                        busy={ctrl.mutating}
                      />
                    ) : (
                      <Button
                        className={`da-gfs-drive__breadcrumb${
                          dragOverFolderId === crumb.resourceId
                            ? ' da-gfs-drive__breadcrumb--allowed'
                            : ''
                        }`}
                        color="neutral"
                        // The active crumb stays a live drop target; only its click is inert.
                        aria-current={index === crumbs.length - 1 ? 'page' : undefined}
                        title={
                          gfsDropVerdictReason(dropStatesById[crumb.resourceId]) !== undefined
                            ? gfsDropVerdictLiveAnnouncement(
                                dropStatesById[crumb.resourceId]!,
                                crumb.name,
                                dragSourceName ?? undefined
                              )
                            : undefined
                        }
                        data-drop-state={dropStatesById[crumb.resourceId]?.state}
                        data-drop-reason={gfsDropVerdictReason(dropStatesById[crumb.resourceId])}
                        onClick={
                          index === crumbs.length - 1
                            ? undefined
                            : () => {
                                beginExplicitFilesNavigation()
                                ctrl.goToCrumb(index)
                              }
                        }
                        onDragEnter={event => handleCrumbDragOver(event, crumb, index)}
                        onDragOver={event => handleCrumbDragOver(event, crumb, index)}
                        onDragLeave={handleFolderDragLeave}
                        onDrop={event =>
                          void handleFolderDrop(event, {
                            resourceId: crumb.resourceId,
                            name: crumb.name,
                            kind: 'directory',
                          })
                        }
                        variant="text"
                      >
                        {crumb.name}
                      </Button>
                    )}
                  </span>
                ))}
              </nav>
              {current && !currentIsFile && currentIsBeingRenamed && !currentIsInBreadcrumbs ? (
                <GfsInlineRename
                  className="da-gfs-drive__inline-rename"
                  onCancel={() => setRenameTarget(null)}
                  onChange={setRenameDraft}
                  onSubmit={() => void handleRenameTarget()}
                  value={renameDraft}
                  busy={ctrl.mutating}
                />
              ) : null}
              {current && !currentIsFile && !currentIsBeingRenamed ? (
                <GfsResourceMenu
                  actions={getGfsMenuActions(currentResourceActions)}
                  resourceName={current.name}
                />
              ) : null}
              {current && !currentIsFile ? (
                <PermissionStatusIndicator
                  active={loadingAffordances}
                  label={`Checking permissions for ${current.name}`}
                />
              ) : null}
            </div>
            <div className="da-gfs-drive__upload-input">
              <input
                aria-label="Upload file"
                aria-hidden="true"
                className="visually-hidden"
                ref={uploadInputRef}
                tabIndex={-1}
                type="file"
                onChange={event => {
                  const file = event.currentTarget.files?.[0]
                  const target = uploadTargetRef.current
                  uploadTargetRef.current = null
                  event.currentTarget.value = ''
                  if (!file || !target) return
                  void handleUploadFile(
                    file,
                    target.parentResourceId,
                    target.occupiedNames,
                    target.parentName
                  )
                }}
              />
            </div>
          </div>

          {dragActive || droppedUploadCount > 0 ? (
            <div className="composer-drop-overlay da-gfs-drop-overlay" role="status">
              {droppedUploadCount > 0
                ? `Uploading ${droppedUploadCount} ${droppedUploadCount === 1 ? 'file' : 'files'}…`
                : droppedUploadRestriction ||
                  `Drop files to upload to ${current?.name || 'this folder'}`}
            </div>
          ) : null}

          {dropSessionLost ? (
            // Persistent (A11): the refusal outlives the dead gesture and the
            // revoked surface below — it is not a one-shot toast.
            <StatusBanner tone="error" text={GFS_DROP_SESSION_LOST_MESSAGE} />
          ) : null}
          {zipJob ? (
            <div className="da-gfs-zip-progress" role="status" data-testid="gfs-zip-progress">
              <span className="da-gfs-zip-progress__label">
                {zipJob.progress.phase === 'listing'
                  ? `Preparing ${zipJob.folderName}.zip — reading folder contents…`
                  : zipJob.progress.phase === 'downloading'
                    ? `Preparing ${zipJob.folderName}.zip — downloading ${zipJob.progress.filesAdded} of ${zipJob.progress.filesFound} ${zipJob.progress.filesFound === 1 ? 'file' : 'files'}…`
                    : `Preparing ${zipJob.folderName}.zip — assembling archive…`}
              </span>
              <button
                type="button"
                className="da-gfs-zip-progress__stop"
                aria-label="Stop preparing zip"
                onClick={() => zipAbortRef.current?.abort()}
              >
                Stop
              </button>
            </div>
          ) : null}

          {accessibleNotice ? <StatusBanner tone="info" text={accessibleNotice} /> : null}
          {current &&
          affordancesError &&
          (ctrl.affordancesHttpStatus === 429 ||
            ctrl.affordancesHttpStatus === 403 ||
            ctrl.affordancesHttpStatus === 404) ? (
            <div role="alert">
              <StatusBanner
                tone="error"
                text={
                  ctrl.affordancesHttpStatus === 429
                    ? 'Too many file requests. Wait before retrying permissions.'
                    : 'Could not verify permissions for ' +
                      current.name +
                      ': access could not be confirmed.'
                }
              />
              {ctrl.affordancesHttpStatus === 429 ? (
                <Button
                  color="secondary"
                  onClick={() =>
                    void fetchRowAuthority(current.resourceId, current.name, GFS_DRIVE_MAIN)
                  }
                >
                  Retry permission check
                </Button>
              ) : null}
            </div>
          ) : null}
          {Object.entries(ctrl.moveSourceParentStatusById ?? {}).map(([resourceId, status]) => {
            if (!status.error || resourceId === current?.resourceId) return null
            const rateLimited = status.rateLimited && status.httpStatus === 429
            return (
              <div key={resourceId} role="alert">
                <StatusBanner tone={rateLimited ? 'warn' : 'error'}>
                  <span>Could not verify Move permissions: {status.error}</span>
                </StatusBanner>
                <Button
                  color="secondary"
                  onClick={() =>
                    void fetchRowAuthority(resourceId, 'the source folder', GFS_DRIVE_MAIN)
                  }
                >
                  Retry permission check
                </Button>
              </div>
            )
          })}
          {pendingGfsDeepLinkFailure ? (
            <div role="alert">
              <StatusBanner tone="error" text={pendingGfsDeepLinkFailure.message} />
              {pendingGfsDeepLinkFailure.retryable ? (
                <Button
                  color="secondary"
                  onClick={() => {
                    setPendingGfsDeepLinkFailure(null)
                    setGfsDeepLinkRetry(current => ({
                      id: pendingGfsDeepLinkFailure.id,
                      request:
                        current?.id === pendingGfsDeepLinkFailure.id ? current.request + 1 : 1,
                    }))
                  }}
                  size="sm"
                  variant="outline"
                >
                  Retry opening link
                </Button>
              ) : null}
            </div>
          ) : null}
          {unavailableLocation ? (
            <StatusBanner tone="error" text={GFS_UNAVAILABLE_LOCATION_MESSAGE} />
          ) : null}
          {visibleError && !accessRevoked && !blockingFailure ? (
            // Presented, not raw. The banner is the non-blocking half of the
            // same read-plane failure the card shows, so it must not be the one
            // surface left leaking `Error invoking remote method '…'` at the
            // user — which is what it did for every failure the card declines
            // to take over, a rate-limited `Load more` among them.
            <StatusBanner tone="error" text={describeGfsReadError(visibleError).message} />
          ) : null}

          {accessRevoked ? (
            <>
              {/* The revoked surface owns the session-ended sentence (A11): it
                  outlives any gesture's ownership, so a drag whose probe died
                  stays explained even after the revocation invalidated it. */}
              <StatusBanner tone="error" text={GFS_DROP_SESSION_LOST_MESSAGE} />
              <EmptyState
                title="File access is not authorized"
                body="Your current Desktop session cannot access this location. Sign in again or contact an administrator."
              />
              <div className="da-gfs-footer-actions">
                <Button onClick={() => ctrl.retryAccess()} size="sm" variant="outline">
                  Retry file access
                </Button>
              </div>
            </>
          ) : blockingFailure ? (
            <GfsReadFailureCard
              failure={blockingFailure.failure}
              onRetry={() => {
                void blockingFailure.retry()
              }}
            />
          ) : visibleLoading ? (
            <div
              className="da-gfs-loading"
              role="status"
              aria-label="Loading files"
              aria-live="polite"
            >
              <span className="da-gfs-loading__dots" aria-hidden="true">
                <span className="da-gfs-loading__dot" />
                <span className="da-gfs-loading__dot" />
                <span className="da-gfs-loading__dot" />
              </span>
              <span>Loading files…</span>
            </div>
          ) : currentIsFile ? (
            <div className="da-gfs-current-file">
              <span className="da-gfs-current-file__icon" aria-hidden="true">
                {currentIsFile ? <GfsFileIcon name={current.name} /> : <IconAttachFile />}
              </span>
              <div className="da-gfs-current-file__copy">
                <div className="da-gfs-current-file__title-row">
                  {currentIsBeingRenamed ? (
                    <GfsInlineRename
                      className="da-gfs-current-file__inline-rename"
                      onCancel={() => setRenameTarget(null)}
                      onChange={setRenameDraft}
                      onSubmit={() => void handleRenameTarget()}
                      value={renameDraft}
                      busy={ctrl.mutating}
                    />
                  ) : (
                    <>
                      <h3>{current.name}</h3>
                      <GfsResourceMenu
                        actions={getGfsMenuActions(currentResourceActions)}
                        resourceName={current.name}
                      />
                    </>
                  )}
                  <PermissionStatusIndicator
                    active={loadingAffordances}
                    label={`Checking permissions for ${current.name}`}
                  />
                </div>
                <p className="muted">
                  {currentPreviewAvailable
                    ? 'Preview this file again or use the menu to download or replace it.'
                    : 'Use the menu to download or replace this file.'}
                </p>
              </div>
            </div>
          ) : pendingGfsDeepLinkFailure ? null : visibleResources.length === 0 ? (
            // `unsupported` earns its own copy because the other two assert
            // something this branch cannot know. An older server that has no
            // listing endpoint never told us the library was empty — it told us
            // it cannot answer — and "No shared files yet" reports the absence
            // of an answer as an answer. No Retry either: the endpoint will not
            // appear because the user pressed a button. The banner above already
            // points at opening a link, so this states the one thing it does
            // not: the list is missing, the files may not be.
            <EmptyState
              title={
                rootListingUnsupported
                  ? 'Files cannot be listed here'
                  : currentIsFolder
                    ? 'This folder is empty'
                    : 'No shared files yet'
              }
              body={
                rootListingUnsupported
                  ? 'This server cannot list shared resources, so Evenfire has no way to tell what you have access to. That does not mean you have none.'
                  : currentIsFolder
                    ? 'Files and folders added here will appear in this list.'
                    : 'Resources shared directly with you or your teams will appear here.'
              }
            />
          ) : (
            <div
              className="da-grid da-gfs-drive__grid"
              style={{
                '--da-grid-cols':
                  'calc(var(--space-5) + var(--space-1)) minmax(0, 1fr) minmax(4.5rem, auto) 9.5rem',
              }}
            >
              <div className="da-grid__head">
                <span className="da-grid__col-header" aria-hidden="true" />
                <span className="da-grid__col-header">Name</span>
                <span className="da-grid__col-header da-gfs-drive__size-column da-grid__col-header--right">
                  Size
                </span>
                <span className="da-grid__col-header da-grid__col-header--right">Actions</span>
              </div>
              <div className="da-grid__body">
                {visibleResources.map(resource => {
                  const resourceName = resource.name || resource.drive
                  const availability = rowActionAvailability(resource)
                  const permissionNotice = rowPermissionNoticeFor(resource.resourceId, resourceName)
                  const isDragging =
                    draggingResourceId === resource.resourceId ||
                    movingResourceId === resource.resourceId
                  const isDropTarget = dragOverFolderId === resource.resourceId
                  const dropState =
                    resource.kind === 'directory' ? dropStatesById[resource.resourceId] : undefined
                  const dropReason = gfsDropVerdictReason(dropState)
                  // The deny/no-op/unknown tint carries no reason of its own;
                  // the tooltip speaks the full sentence (one wording per
                  // reason, every surface).
                  const dropReasonTooltip =
                    dropState && dropReason !== undefined
                      ? gfsDropVerdictLiveAnnouncement(
                          dropState,
                          resource.name,
                          dragSourceName ?? undefined
                        )
                      : undefined
                  const canDragResource =
                    resource.readable !== false && movingResourceId === null && !ctrl.mutating
                  return (
                    <div
                      className="da-grid__row da-grid__row--clickable da-grid__row--compact"
                      key={resource.resourceId}
                      draggable={canDragResource}
                      title={
                        dropReasonTooltip ??
                        (canDragResource
                          ? `Drag ${resource.name} into a folder to move it`
                          : undefined)
                      }
                      data-dragging={isDragging ? 'true' : undefined}
                      data-drop-target={isDropTarget ? 'true' : undefined}
                      data-drop-state={dropState?.state}
                      data-drop-reason={dropReason}
                      role="button"
                      tabIndex={0}
                      aria-label={
                        resource.readable === false
                          ? `${resource.name || resource.drive} (no read access)`
                          : `Open ${resource.name || resource.drive}`
                      }
                      onClick={event => {
                        if (isEventFromNestedInteractive(event)) return
                        openResource(resource)
                      }}
                      onKeyDown={event => {
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        if (isEventFromNestedInteractive(event)) return
                        event.preventDefault()
                        openResource(resource)
                      }}
                      onDragStart={
                        canDragResource
                          ? event => handleResourceDragStart(event, resource)
                          : undefined
                      }
                      onDragEnd={canDragResource ? handleResourceDragEnd : undefined}
                      onDragEnter={
                        resource.kind === 'directory'
                          ? event => handleFolderDragOver(event, resource)
                          : undefined
                      }
                      onDragOver={
                        resource.kind === 'directory'
                          ? event => handleFolderDragOver(event, resource)
                          : undefined
                      }
                      onDragLeave={
                        resource.kind === 'directory' ? handleFolderDragLeave : undefined
                      }
                      onDrop={
                        resource.kind === 'directory'
                          ? event =>
                              void handleFolderDrop(event, {
                                resourceId: resource.resourceId,
                                name: resource.name,
                                kind: 'directory',
                              })
                          : undefined
                      }
                    >
                      <span className="da-gfs-list__icon da-grid__cell" aria-hidden="true">
                        {resource.kind === 'directory' ? (
                          <IconContexts />
                        ) : (
                          <GfsFileIcon name={resource.name} />
                        )}
                      </span>
                      <span className="da-gfs-list__identity da-grid__cell">
                        <span className="da-gfs-list__name">
                          {renameTarget?.resourceId === resource.resourceId ? (
                            <GfsInlineRename
                              onCancel={() => setRenameTarget(null)}
                              onChange={setRenameDraft}
                              onSubmit={() => void handleRenameTarget()}
                              value={renameDraft}
                              busy={ctrl.mutating}
                            />
                          ) : (
                            <Button
                              align="start"
                              block
                              onClick={() => openResource(resource)}
                              variant="text"
                            >
                              {resource.name || resource.drive}
                            </Button>
                          )}
                          {resource.readable === false ? (
                            <Badge tone="neutral">No access</Badge>
                          ) : null}
                        </span>
                        {permissionNotice ? (
                          <span className="muted" role="alert">
                            {permissionNotice}
                          </span>
                        ) : null}
                      </span>
                      <span className="da-gfs-drive__size da-grid__cell da-grid__cell--right">
                        {formatSharedFileSize(resource.bytes)}
                      </span>
                      <span className="da-gfs-list__actions da-grid__cell da-grid__cell--right">
                        {availability.canManage ? (
                          <IconButton
                            label={`Share ${resource.name || resource.drive}`}
                            onClick={() => openManage(resource)}
                            size="sm"
                            variant="ghost"
                          >
                            <IconShare width={16} height={16} />
                          </IconButton>
                        ) : null}
                        {resource.kind === 'file' ? (
                          <IconButton
                            label={`Download ${resource.name}`}
                            onClick={() => void handleDownload(resource.gfsUri, resource.name)}
                            size="sm"
                            variant="ghost"
                            disabled={resource.readable === false}
                          >
                            <IconDownload width={16} height={16} />
                          </IconButton>
                        ) : null}
                        {availability.canRename ? (
                          <IconButton
                            label={`Rename ${resource.name || resource.drive}`}
                            onClick={() => openRenameTarget(resource)}
                            size="sm"
                            variant="ghost"
                          >
                            <IconEdit width={16} height={16} />
                          </IconButton>
                        ) : null}
                        {resource.kind === 'directory' ? (
                          <GfsResourceMenu
                            actions={resourceMenuActionsFor(resource, availability)}
                            resourceName={resource.name}
                            onOpenChange={open => {
                              ctrl.setRowAffordancesResourceId(open ? resource.resourceId : null)
                              ctrl.setMoveSourceParentResourceId?.(
                                open ? resource.parentResourceId : null
                              )
                            }}
                          />
                        ) : (
                          <GfsResourceMenu
                            actions={resourceMenuActionsFor(resource, availability)}
                            resourceName={resource.name}
                            onOpenChange={open => {
                              ctrl.setRowAffordancesResourceId(open ? resource.resourceId : null)
                              ctrl.setMoveSourceParentResourceId?.(
                                open ? resource.parentResourceId : null
                              )
                            }}
                          />
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {hasMoreVisible ? (
            <div className="da-gfs-footer-actions">
              <Button
                loading={loadingMoreVisible}
                onClick={currentIsFolder ? ctrl.loadMore : ctrl.loadMoreAccessible}
                size="sm"
                variant="outline"
              >
                Load more
              </Button>
            </div>
          ) : null}
        </section>
      </div>

      {openLinkOpen ? (
        <div
          className="da-gfs-link-modal"
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget) setOpenLinkOpen(false)
          }}
        >
          <section
            className="da-gfs-link-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="gfs-link-dialog-title"
          >
            <header className="da-gfs-link-dialog__header">
              <span className="da-gfs-link-dialog__icon" aria-hidden="true">
                <IconOpenRoute />
              </span>
              <span className="da-gfs-link-dialog__heading">
                <span className="da-gfs-eyebrow">Direct access</span>
                <h3 id="gfs-link-dialog-title">Open from link</h3>
              </span>
              <IconButton
                label="Close EvenDrive link dialog"
                onClick={() => setOpenLinkOpen(false)}
                size="sm"
                variant="ghost"
              >
                <IconClose />
              </IconButton>
            </header>
            <div className="da-gfs-link-dialog__body">
              <GfsFilePicker
                onOpen={uri => {
                  beginExplicitFilesNavigation()
                  return handleOpenGfsLink(uri)
                }}
                onOpened={() => setOpenLinkOpen(false)}
                busy={resolving}
                error={openError}
              />
            </div>
          </section>
        </div>
      ) : null}

      {manageDialogTarget ? (
        <GfsManageAccessDialog
          key={manageDialogTarget.resourceId}
          target={manageDialogTarget}
          isCurrent={() =>
            pageActiveRef.current &&
            manageTarget !== null &&
            isGfsSessionAuthorityCurrent(
              manageTarget.sessionScope,
              manageTarget.sessionGeneration,
              moveWorkspaceRef.current.sessionScope,
              moveWorkspaceRef.current.sessionGeneration
            )
          }
          deps={manageAccessDeps}
          pushToast={pushToast}
          onClose={closeManage}
        />
      ) : null}

      {createFolderOpen && createFolderParentId && createFolderParentName ? (
        <GfsNameDialog
          busy={ctrl.mutating}
          description={<>Create a new folder in {createFolderParentName}.</>}
          error={createFolderError}
          fieldLabel="Folder name"
          formLabel="Create folder"
          placeholder="e.g. research-notes"
          submitLabel="Create folder"
          title="New folder"
          onCancel={closeCreateFolder}
          onSubmit={value => void handleCreateFolder(value)}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          body={
            deleteTarget.kind === 'directory'
              ? 'The folder and everything inside it will be deleted for everyone with access.'
              : 'The file will be deleted for everyone with access.'
          }
          confirmLabel="Delete"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void handleDeleteResource(deleteTarget)}
          title={`Delete ${deleteTarget.name}?`}
          tone="danger"
        />
      ) : null}

      {moveTarget ? (
        <GfsMoveDialog
          busy={ctrl.mutating || movePermissionStatus === 'checking'}
          initialCrumbs={
            moveTarget.resourceId === current?.resourceId ? crumbs.slice(0, -1) : crumbs
          }
          onClose={() => {
            setMovePermissionStatus(null)
            closeMoveDialog()
          }}
          onMove={(destinationId, destinationName) =>
            handleMoveTarget(destinationId, destinationName)
          }
          onMoveWithOwnership={(destinationId, destinationName, isCurrent, requestConsent) =>
            handleMoveTarget(destinationId, destinationName, true, isCurrent, requestConsent)
          }
          onRetryPermissionCheck={(destinationId, destinationName, isCurrent) =>
            handleMoveTarget(destinationId, destinationName, false, isCurrent)
          }
          onAuthorityFailure={message =>
            ctrl.handleAuthorityFailure(message, 'operation', sessionScope, ctrl.sessionGeneration)
          }
          sessionScope={sessionScope}
          sessionGeneration={ctrl.sessionGeneration}
          target={moveTarget}
          permissionStatus={movePermissionStatus}
        />
      ) : null}

      {pendingFolderMove ? (
        <GfsMoveConfirmDialog
          busy={movingResourceId === pendingFolderMove.source.resourceId}
          request={{
            sourceName: pendingFolderMove.source.name,
            destinationName: pendingFolderMove.destination.name,
          }}
          onCancel={() => setPendingFolderMove(null)}
          onConfirm={() => {
            const pending = pendingFolderMove
            setPendingFolderMove(null)
            if (
              pending &&
              ownsDrop(pending.source, pending.gestureGeneration, pending.sessionGeneration)
            ) {
              void runMoveCommit(
                pending.source,
                pending.destination,
                () =>
                  ownsDrop(pending.source, pending.gestureGeneration, pending.sessionGeneration),
                undefined,
                true,
                undefined,
                pending.authoritativeSessionGeneration
              )
            }
          }}
        />
      ) : null}
    </section>
  )
}
