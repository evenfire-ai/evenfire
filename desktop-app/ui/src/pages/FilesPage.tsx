import {
  type DragEvent as ReactDragEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { normalizeGfsResourceUri } from '@clerum/desktop-app-links'
import {
  GFS_UPLOAD_NAME_EXHAUSTED_MESSAGE,
  GFS_UPLOAD_NAME_RETRY_LIMIT,
  createGfsUploadNameReservationBook,
  gfsUploadNameRetryDecision,
  normalizeGfsResourceName,
} from '@clerum/gfs-interaction-policy'
import { isEditorGfsPermissions, planGfsInheritedRoleChange } from '@clerum/gfs-interaction-policy'
import { Badge, Button, EmptyState, IconButton, StatusBanner, TextInput } from '@components/Common'
import { ConfirmDialog } from '@components/ConfirmDialog'
import { GfsFileIcon } from '@components/GfsFileIcon'
import { GfsReadFailureCard } from '@components/GfsReadFailureCard'
import { GfsRecentFilesCard } from '@components/GfsRecentFilesCard'
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
import {
  GFS_DEFAULT_DISCOVERY_DRIVE,
  GFS_MY_HOME_LABEL,
  GFS_RECENT_FILES_LABEL,
  GFS_RECENT_FILES_LOCATION,
  GFS_RESOURCE_DRAG_TYPE,
  GFS_SHARED_WITH_ME_LABEL,
  GFS_SHARED_WITH_ME_LOCATION,
} from '@constants/gfsBrowser'
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
import {
  GFS_AUTHORITY_STALE_TIME_MS,
  assertGfsAuthorityRetryAllowed,
} from '@lib/gfsAuthorityQueryPolicy'
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
import {
  describeGfsGrantError,
  describeGfsReadError,
  isRateLimited,
  parseHttpStatus,
  parseRetryAfterSeconds,
} from '@lib/gfsGrantErrors'
import { GFS_LISTING_GRID_COLUMNS } from '@lib/gfsListingGrid'
import { hasGfsMoveSourcePermissions } from '@lib/gfsMovePermissions'
import { isGfsPreviewFile, resolveGfsPreview } from '@lib/gfsPreview'
import type { GfsPreviewResource } from '@lib/gfsPreview'
import { buildGfsResourceActions, getGfsMenuActions } from '@lib/gfsResourceActions'
import { formatSharedFileSize } from '@lib/sharedFiles'
import { GfsGrantList } from '@/gfs/GfsGrantList'
import type { GfsAccessRole } from '@/gfs/GfsGrantList'
import type { GfsMergedAccessRow } from '@/gfs/GfsGrantList/types'
import { GfsInheritedAccessDialog } from '@/gfs/GfsInheritedAccessDialog'
import type { GfsInheritedAccessDialogRequest } from '@/gfs/GfsInheritedAccessDialog/types'
import { callerHomeRootNode, isCallerHomeRoot } from '@/gfs/callerHome'
import {
  type GfsAgentSubjectOption,
  GfsDelegationPanel,
  type GfsDelegationSubjectOption,
  type GfsGrantListItem,
  permissionsForRole,
} from '@/gfs/delegation'
import type {
  GfsInheritedAccessSource,
  GfsInheritedCoverageState,
  GfsShareListItem,
} from '@/gfs/delegation.types'
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
import { toastMoveOutcome } from '@/gfs/moveCommit'
import type {
  MoveCommitExpectedSourceSnapshot,
  MoveCommitOutcome,
  MoveToast,
} from '@/gfs/moveCommit'
import { runGfsMoveCommit } from '@/gfs/moveCommitRunner'
import { GfsMoveConfirmDialog } from '@/gfs/moveConfirmDialog'
import { GfsMoveDialog } from '@/gfs/moveDialog'
import type { TeamDirectoryResult } from '../../../src/types'
import type { FilesPageProps, GfsDriveResource, MyAgentEntry } from './FilesPage.types'

/** Folders first, then by name (drive as the fallback name). */
function sortDriveResources(resources: GfsDriveResource[]): GfsDriveResource[] {
  return [...resources].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'directory' ? -1 : 1
    }
    return (left.name || left.drive).localeCompare(right.name || right.drive)
  })
}

function hasBit(affordances: { held?: string[] } | null | undefined, bit: string): boolean {
  return Boolean(affordances?.held?.includes(bit))
}

/** Maps a permission set onto the Share dialog's two roles (Editor > Read). */
function roleForAccessPermissions(permissions: string[]): GfsAccessRole {
  return permissions.some(permission => ['write', 'delete', 'manage_acl'].includes(permission))
    ? 'editor'
    : 'read'
}
/** The permission set a role stands for: hosts cap at read/write. */
function rolePermissionRequest(subjectType: string, role: GfsAccessRole): string[] {
  if (subjectType === 'host') return role === 'editor' ? ['read', 'write'] : ['read']
  return role === 'editor' ? ['read', 'write', 'delete', 'manage_acl', 'share'] : ['read', 'share']
}

/** ["a", "b", "c"] → "a, b and c" — folder names for honest outcome toasts. */
function joinFolderNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
function hasDraggedFiles(event: ReactDragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types || []).includes('Files')
}

function hasDraggedGfsResource(event: ReactDragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types || []).includes(GFS_RESOURCE_DRAG_TYPE)
}

const INHERITED_DERIVATION_NOTICE =
  'Inherited access could not be loaded. Members with access from a parent folder may be missing.'
// R1-H3 coverage notices (permissions.md T1 / inherited-permissions spec §7):
// a privacy boundary and an ACL-limited ancestor are normal states, not load
// failures, so they must not wear the failure notice above — and vice versa.
const INHERITED_READ_BOUNDARY_NOTICE = 'There may be access from parent folders you cannot see.'
const INHERITED_READ_BOUNDARY_HINT =
  'Some folders above this one are not visible to you. People may still have access through them, but we cannot show who.'
const INHERITED_ACL_LIMITED_NOTICE =
  'Sharing details on some parent folders are not visible to you.'

/**
 * A role promise is only as good as the coverage it was made under: when the
 * inherited walk did not complete, an ancestor the user cannot see may still
 * grant a stronger role. The success copy then states what was NOT verified
 * instead of promising an effective role the client never proved.
 *
 * The Desktop's role copy carries no trailing period, so the qualifier
 * brings its own.
 */
function inheritedCoverageCaveat(coverage: GfsInheritedCoverageState | null): string {
  if (coverage === 'complete') return ''
  if (coverage === 'read-boundary') {
    return '. Access through parent folders you cannot see was not verified.'
  }
  if (coverage === 'acl-limited') {
    return '. Access through some parent folders was not verified because their sharing details are not visible to you.'
  }
  return '. Inherited access could not be verified, so access through parent folders you cannot see may still be stronger.'
}

/**
 * Folders whose SHARING entries still grant Editor after a downgrade (R1-M5):
 * a role change rewrites the folder's GRANT row only, so a share row survives
 * it and the member keeps Editor through it. The confirmation discloses these
 * BEFORE the user approves; the post-change toast repeats the disclosure.
 */
function collectResidualEditorFolderNames(
  sources: readonly GfsInheritedAccessSource[],
  directShares: readonly { permissions: string[] }[],
  directName: string
): string[] {
  return [
    ...new Set([
      ...sources
        .filter(source =>
          source.shareEntries.some(entry => isEditorGfsPermissions(entry.permissions))
        )
        .map(source => source.name),
      ...(directShares.some(share => isEditorGfsPermissions(share.permissions))
        ? [directName]
        : []),
    ]),
  ]
}

function delegationSubjectOptions(
  directory: TeamDirectoryResult | undefined
): GfsDelegationSubjectOption[] {
  if (!directory) return []
  const options = new Map<string, GfsDelegationSubjectOption>()
  for (const item of directory.items) {
    options.set(`team:${item.team.id}`, {
      type: 'team',
      id: item.team.id,
      label: item.team.name,
      description: item.team.role,
    })
    for (const member of item.members) {
      options.set(`user:${member.id}`, {
        type: 'user',
        id: member.id,
        label: member.name || member.email,
        description: member.email,
      })
    }
  }
  return [...options.values()].sort((left, right) =>
    `${left.type}:${left.label}`.localeCompare(`${right.type}:${right.label}`)
  )
}

function agentSubjectOptions(agents: MyAgentEntry[] | undefined): GfsAgentSubjectOption[] {
  if (!agents) return []
  const options = new Map<string, GfsAgentSubjectOption>()
  for (const agent of agents) {
    // Only agents with a canonical host gfsSubject are grantable targets.
    if (agent.gfsSubject?.type !== 'host' || !agent.gfsSubject.id) continue
    options.set(agent.gfsSubject.id, { id: agent.gfsSubject.id, name: agent.name })
  }
  return [...options.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function pickErrorMessage(error: unknown): string | null {
  if (!error) return null
  return error instanceof Error ? error.message : String(error)
}

function mergeErrorMessages(...errors: unknown[]): string | null {
  const messages = errors.map(pickErrorMessage).filter((value): value is string => Boolean(value))
  return messages.length > 0 ? messages.join(' · ') : null
}

/** A drop destination the drag pipeline can move INTO: a grid folder row or a
 *  breadcrumb crumb. Carries the destination's own drive, so admission never
 *  compares against the open location (a root drop has no folder open). */
type GfsFolderDropTarget = Pick<GfsDriveResource, 'resourceId' | 'name' | 'drive'> & {
  kind: 'directory'
}

/** Any row/header action target — a listing row (GfsDriveResource) or the
 * current breadcrumb (GfsCrumb); both carry the identity fields the delete /
 *  rename / move calls need (kind also powers dialog titles + the move cycle
 *  guard), and the row's own drive routes the mutation. */
type GfsActionTarget = Pick<GfsDriveResource, 'resourceId' | 'name' | 'drive' | 'version'> & {
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
  remoteGfsChangeEpoch,
  onLocationChange,
  onOpenPreview,
  onOpenPendingGfsPreview,
  routeDialogRequestId = 0,
  onRouteDialogRequestHandled,
}: FilesPageProps) {
  const [createFolderName, setCreateFolderName] = useState('')
  const [createFolderOpen, setCreateFolderOpen] = useState(false)
  const [createFolderParentId, setCreateFolderParentId] = useState<string | null>(null)
  const [createFolderParentName, setCreateFolderParentName] = useState<string | null>(null)
  const [createFolderError, setCreateFolderError] = useState<string | null>(null)
  const [renameName, setRenameName] = useState('')
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
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
  // Client-only views are seeded from the tab location, never resolved as GFS URIs.
  const [rootView, setRootView] = useState<'overview' | 'shared' | 'recent'>(() => {
    if (pendingGfsUri === GFS_SHARED_WITH_ME_LOCATION) return 'shared'
    if (pendingGfsUri === GFS_RECENT_FILES_LOCATION) return 'recent'
    return 'overview'
  })
  const [pendingGfsDeepLinkFailure, setPendingGfsDeepLinkFailure] = useState<{
    id: number
    message: string
    retryable: boolean
  } | null>(null)
  const [gfsDeepLinkRetry, setGfsDeepLinkRetry] = useState<{ id: number; request: number } | null>(
    null
  )
  const [refreshingCurrent, setRefreshingCurrent] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const [shareDetailsOpen, setShareDetailsOpen] = useState(false)
  const [updatingAccessRole, setUpdatingAccessRole] = useState(false)
  // Pending parent-folder confirmation (role change or removal) for a member
  // whose file access is inherited from ancestor folders. change-role carries
  // the split plan's affected grant-backed folders (R1-M5: each rewritten
  // with its OWN scope flag; share rows never touched), each with the bits
  // the pre-flight validated on that folder itself, plus the share-only
  // editor sources (residual access) and any unknown-scope folders skipped
  // rather than written with a defaulted scope.
  const [parentUpdate, setParentUpdate] = useState<
    | {
        row: GfsMergedAccessRow
        label: string
        mode: 'change-role'
        nextRole: GfsAccessRole
        updates: Array<{ source: GfsInheritedAccessSource; bits: string[] }>
        residualSources: GfsInheritedAccessSource[]
        skippedFolderNames: string[]
        /** Folders whose sharing entries still grant Editor after the change. */
        residualEditorFolderNames: string[]
      }
    | { row: GfsMergedAccessRow; label: string; mode: 'remove' }
    | null
  >(null)
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
  const createFolderTitleId = useId()
  const createFolderDescriptionId = useId()
  const createFolderInputId = useId()
  const queryClient = useQueryClient()
  // Only the overview renders the recent card, but the option is stable for the
  // page's lifetime: the card mounts and unmounts with the view, the query does
  // not re-subscribe on every view change.
  const ctrl = useGfsBrowserController({ grantsListEnabled: manageOpen, recentFilesEnabled: true })
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
    refreshAffordances,
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
    // Shared-root rows inherit status from one accessible-list query. A
    // background refresh of that shared query is not a separate permission
    // check for every row, and its page-level feedback must not be repeated
    // in twenty row live regions.
    if (!currentIsFolder && accessibleRootResourceIds.has(resourceId)) return null
    const statuses = ctrl.rowPermissionStatusByResourceId
    if (!statuses) return null
    const status = statuses[resourceId]
    if (status?.status === 'ready' || status?.status === 'stale') return null
    if (status?.status === 'error') {
      return {
        role: 'alert' as const,
        tone: 'error' as const,
        message: `Could not verify permissions for ${resourceName}: ${status.message}`,
      }
    }
    return {
      role: 'status' as const,
      tone: 'info' as const,
      message: `Checking permissions for ${resourceName}…`,
    }
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
            ctrl.drive,
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
    drive: ctrl.drive,
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

  const lastRemoteGfsChangeEpochRef = useRef(remoteGfsChangeEpoch)
  useEffect(() => {
    if (remoteGfsChangeEpoch === undefined) return
    if (lastRemoteGfsChangeEpochRef.current === remoteGfsChangeEpoch) return
    lastRemoteGfsChangeEpochRef.current = remoteGfsChangeEpoch
    void ctrl.refreshCurrentLocation({ background: true })
  }, [ctrl.refreshCurrentLocation, remoteGfsChangeEpoch])

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
          folder.drive,
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
              window.clerum.gfs.listChildren(folder.resourceId, folder.drive, pageParam),
            initialPageParam: undefined as string | undefined,
          })
          .catch(() => {
            // Pre-fetch failures (offline, permission) are non-fatal; the
            // real navigation will surface the error normally.
          })
      )
    )
  }, [ctrl.sessionGeneration, items, queryClient, sessionScope])

  const teamDirectoryQuery = useQuery({
    queryKey: desktopQueryKeys.teamsDirectory,
    queryFn: () => window.clerum.team.directory(),
    enabled: Boolean(affordances?.canDelegate),
  })
  const delegationSubjects = useMemo(
    () => delegationSubjectOptions(teamDirectoryQuery.data),
    [teamDirectoryQuery.data]
  )
  // MY agents (with canonical gfsSubject) load when the Manage dialog opens:
  // they feed both the agent grant section and grant-list label resolution.
  const myAgentsQuery = useQuery({
    queryKey: desktopQueryKeys.myAgents,
    queryFn: () => window.clerum.agents.listMine(),
    enabled: manageOpen,
  })
  const agentSubjects = useMemo(() => agentSubjectOptions(myAgentsQuery.data), [myAgentsQuery.data])
  // Unified grant-subject list: people + teams (team directory) and the caller's
  // own agents (canonical host subjects). Agents are badge-labelled and capped to
  // read/write inside GfsDelegationPanel when present in the selection.
  const grantSubjectOptions = useMemo<GfsDelegationSubjectOption[]>(
    () => [
      ...delegationSubjects,
      ...agentSubjects.map(agent => ({
        type: 'host' as const,
        id: agent.id,
        label: agent.name,
        description: 'Agent',
        badge: 'Agent',
      })),
    ],
    [agentSubjects, delegationSubjects]
  )
  const grantsError = useMemo(
    () => (ctrl.grantsError ? describeGfsGrantError(ctrl.grantsError) : null),
    [ctrl.grantsError]
  )
  const sharesError = useMemo(
    () => (ctrl.sharesError ? describeGfsGrantError(ctrl.sharesError) : null),
    [ctrl.sharesError]
  )
  const closeManage = useCallback(() => {
    setManageOpen(false)
    const returnCrumbs = manageReturnCrumbsRef.current
    manageReturnCrumbsRef.current = null
    if (returnCrumbs) ctrl.restoreCrumbs(returnCrumbs)
  }, [ctrl.restoreCrumbs])
  const closeCreateFolder = useCallback(() => {
    setCreateFolderOpen(false)
    setCreateFolderName('')
    setCreateFolderError(null)
    setCreateFolderParentId(null)
    setCreateFolderParentName(null)
    const returnCrumbs = manageReturnCrumbsRef.current
    manageReturnCrumbsRef.current = null
    if (returnCrumbs) ctrl.restoreCrumbs(returnCrumbs)
  }, [ctrl.restoreCrumbs])
  const openCreateFolder = useCallback((parentResourceId: string, parentName: string) => {
    setCreateFolderName('')
    setCreateFolderError(null)
    setCreateFolderParentId(parentResourceId)
    setCreateFolderParentName(parentName)
    setRenameOpen(false)
    setDeleteOpen(false)
    setShareDetailsOpen(false)
    setManageOpen(false)
    setCreateFolderOpen(true)
  }, [])

  useEffect(() => {
    if (!createFolderOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !ctrl.mutating) closeCreateFolder()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closeCreateFolder, createFolderOpen, ctrl.mutating])

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
    setManageOpen(false)
    closeMoveDialog()
    setRenameTarget(null)
    setDeleteTarget(null)
    setOpenLinkOpen(false)
    setCreateFolderOpen(false)
    setRenameOpen(false)
    setDeleteOpen(false)
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
  const fetchRowAuthority = async (resourceId: string, resourceName: string, drive: string) => {
    const requestedScope = sessionScope
    const requestedGeneration = ctrl.sessionGeneration
    if (!requestedScope || accessRevoked || !isGfsSessionGeneration(requestedGeneration)) {
      pushToast?.(`Could not verify permissions for ${resourceName}. Try again.`, 'error')
      return null
    }
    const queryKey = desktopQueryKeys.gfsAffordances(
      requestedScope,
      resourceId,
      drive,
      requestedGeneration
    )
    try {
      assertGfsAuthorityRetryAllowed(queryClient, queryKey)
      const authority = await queryClient.fetchQuery({
        queryKey,
        queryFn: () => window.clerum.gfs.affordances(resourceId, drive),
        staleTime: GFS_AUTHORITY_STALE_TIME_MS,
        retry: false,
      })
      if (
        !pageActiveRef.current ||
        !isGfsSessionAuthorityCurrent(
          requestedScope,
          requestedGeneration,
          moveWorkspaceRef.current.sessionScope,
          moveWorkspaceRef.current.sessionGeneration
        )
      ) {
        return null
      }
      return authority
    } catch (error) {
      if (
        !isGfsSessionAuthorityCurrent(
          requestedScope,
          requestedGeneration,
          moveWorkspaceRef.current.sessionScope,
          moveWorkspaceRef.current.sessionGeneration
        )
      )
        return null
      if (!failClosedOnAuthorizationError(error, requestedScope, requestedGeneration)) {
        pushToast?.(describeGfsReadError(error).message, 'error')
      }
      return null
    }
  }
  const requireFreshRowPermissions = async (
    resourceId: string,
    resourceName: string,
    requiredBits: string[],
    drive = ctrl.drive || GFS_DEFAULT_DISCOVERY_DRIVE,
    requiredGrantableBits: string[] = []
  ) => {
    const requestedScope = sessionScope
    const requestedGeneration = ctrl.sessionGeneration
    if (!requestedScope || !isGfsSessionGeneration(requestedGeneration)) return false
    const queryKey = desktopQueryKeys.gfsAffordances(
      requestedScope,
      resourceId,
      drive,
      requestedGeneration
    )
    const queryState = queryKey ? queryClient.getQueryState(queryKey) : undefined
    const stateAuthority = queryState?.data as
      | { held?: string[]; grantableBits?: string[] }
      | undefined
    const queryDataIsFresh = Boolean(
      queryState?.status === 'success' &&
      stateAuthority &&
      !queryState.isInvalidated &&
      Date.now() - queryState.dataUpdatedAt < GFS_AUTHORITY_STALE_TIME_MS
    )
    const rowStatus = ctrl.rowPermissionStatusByResourceId?.[resourceId]?.status
    const controllerAuthority =
      ctrl.current?.resourceId === resourceId
        ? ctrl.affordances
        : (ctrl.rowAffordancesByResourceId?.[resourceId] ??
          (ctrl.rowAffordancesResourceId === resourceId ? ctrl.rowAffordances : null))
    // The controller already observes this exact session/resource/drive query.
    // Reuse only an explicitly fresh success. Legacy controller-only test
    // harnesses have no query observer/status map, so their injected fresh
    // authority remains a valid fixture; production always exposes the query.
    const controllerDataIsFresh = Boolean(
      queryState === undefined &&
      rowStatus === undefined &&
      controllerAuthority &&
      (hasBit(controllerAuthority, 'read') ||
        hasBit(controllerAuthority, 'write') ||
        hasBit(controllerAuthority, 'delete') ||
        hasBit(controllerAuthority, 'manage_acl'))
    )
    const authority = queryDataIsFresh
      ? stateAuthority
      : controllerDataIsFresh
        ? controllerAuthority
        : await fetchRowAuthority(resourceId, resourceName, drive)
    if (!authority) return false
    const missing = requiredBits.filter(bit => !hasBit(authority, bit))
    if (missing.length > 0) {
      const labels = missing.map(bit => (bit === 'manage_acl' ? 'manage' : bit))
      const label = labels.length === 1 ? labels[0] : labels.join(' and ')
      pushToast?.(`You do not have ${label} access to ${resourceName}.`, 'error')
      return false
    }
    const noLongerGrantable = requiredGrantableBits.filter(
      bit => !authority.grantableBits?.includes(bit)
    )
    if (noLongerGrantable.length > 0) {
      pushToast?.(
        `You can no longer grant ${noLongerGrantable.join(' and ')} on ${resourceName}.`,
        'error'
      )
      return false
    }
    return true
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
      requiredBits,
      target.drive
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
  const openDeleteTarget = (resource: GfsActionTarget) => {
    void runWithFreshResourcePermissions(
      resource,
      resource.resourceId,
      resource.name,
      ['delete'],
      () => setDeleteTarget(resource)
    )
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
    current?.resourceId !== ctrl.home?.resourceId &&
    current?.parentResourceId &&
    hasGfsMoveSourcePermissions(
      ctrl.moveSourceParentAffordancesById?.[current.parentResourceId]?.held
    )
  )
  const currentIsFolder = current?.kind === 'directory'
  const currentIsFile = current?.kind === 'file'
  // Inside the caller's own home the trail starts at "My home" instead of
  // "Shared with me › <home folder>". The ancestor walk stops at the home, so
  // only the first crumb can be the home root.
  const homeTrail =
    crumbs.length > 0 &&
    isCallerHomeRoot(ctrl.home, { resourceId: crumbs[0]!.resourceId, drive: ctrl.drive })
  // Row-level own-home test for the access list: the home-owner row sits on the
  // home root, so it is the caller's own grant when its resource is the caller's
  // ready home root on this drive. `openManage` resets the crumbs, so a
  // trail-based signal would miss the Share-from-row path (U1).
  const isOwnHomeRoot = useCallback(
    (resourceId: string) => isCallerHomeRoot(ctrl.home, { resourceId, drive: ctrl.drive }),
    [ctrl.home, ctrl.drive]
  )
  const crumbLabel = (crumb: GfsCrumb, index: number) =>
    homeTrail && index === 0 ? GFS_MY_HOME_LABEL : crumb.name
  // An incomplete inherited derivation becomes a quiet notice in the Share
  // dialog: an empty derived list alone would silently read as "no one else
  // has access" (R1-M3). R1-H3: rows folded before a walk stop are still
  // rendered — the notice only discloses what is missing, choosing accurate
  // copy per coverage state (boundary states are not load failures).
  const inheritedAccessNotice = ctrl.inheritedAccessError
    ? INHERITED_DERIVATION_NOTICE
    : ctrl.inheritedCoverage === 'read-boundary'
      ? INHERITED_READ_BOUNDARY_NOTICE
      : ctrl.inheritedCoverage === 'acl-limited'
        ? INHERITED_ACL_LIMITED_NOTICE
        : ctrl.inheritedCoverage === 'unavailable'
          ? INHERITED_DERIVATION_NOTICE
          : null
  const inheritedAccessNoticeHint =
    !ctrl.inheritedAccessError && ctrl.inheritedCoverage === 'read-boundary'
      ? INHERITED_READ_BOUNDARY_HINT
      : null
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

  useEffect(() => {
    if (!manageOpen || !current?.resourceId) return
    void refreshAffordances()
  }, [current?.resourceId, manageOpen, refreshAffordances])

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
    if (!manageOpen && !openLinkOpen && !moveTarget && !renameTarget && !pendingFolderMove) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // The parent-folder confirmation is the top-most dialog: Escape cancels
      // it alone and leaves the Share dialog open.
      if (parentUpdate) {
        setParentUpdate(null)
        return
      }
      if (pendingFolderMove) {
        setPendingFolderMove(null)
        return
      }
      closeManage()
      setOpenLinkOpen(false)
      closeMoveDialog()
      setRenameTarget(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    closeManage,
    manageOpen,
    openLinkOpen,
    moveTarget,
    parentUpdate,
    pendingFolderMove,
    renameTarget,
  ])

  // One atomic bulk grant for every selected subject — the server grants all or
  // none (a `subjects_invalid` rejects the whole request), so there is no
  // partial-success outcome. People, teams, and agents share a single picker;
  // agents are capped to read/write inside the panel. Inherit is honored for
  // directories (default ON) and forced false for files.
  const handleGrant = async (
    subjectKeys: string[],
    bits: string[],
    inherit: boolean,
    isDraftCurrent: () => boolean
  ) => {
    if (
      !current ||
      !(await requireFreshRowPermissions(
        current.resourceId,
        current.name,
        ['manage_acl'],
        ctrl.drive,
        bits
      )) ||
      !isDraftCurrent()
    ) {
      return
    }
    try {
      await ctrl.grant(subjectKeys, bits, inherit)
    } catch (grantError) {
      if (failClosedOnAuthorizationError(grantError)) return
      throw grantError
    }
    if (isDraftCurrent()) {
      pushToast?.(
        `Access granted to ${subjectKeys.length} ${subjectKeys.length === 1 ? 'subject' : 'subjects'}`,
        'success'
      )
    }
    // The grant PUT returns no ids — list-after-write is the revoke-id source.
    await ctrl.refreshGrants()
  }

  const handleRevokeGrant = async (grantId: string, label: string) => {
    if (
      !current ||
      !(await requireFreshRowPermissions(current.resourceId, current.name, ['manage_acl']))
    ) {
      return
    }
    try {
      await ctrl.revokeGrant(grantId)
      pushToast?.(`Access revoked for ${label}`, 'success')
    } catch (revokeError) {
      if (failClosedOnAuthorizationError(revokeError)) return
      pushToast?.(describeGfsGrantError(revokeError).message, 'error')
    }
  }

  const handleRevokeShare = async (shareId: string, label: string) => {
    if (
      !current ||
      !(await requireFreshRowPermissions(current.resourceId, current.name, ['manage_acl']))
    ) {
      return
    }
    try {
      await ctrl.revokeShare(shareId)
      pushToast?.(`Shared access revoked for ${label}`, 'success')
    } catch (revokeError) {
      if (failClosedOnAuthorizationError(revokeError)) return
      pushToast?.(describeGfsGrantError(revokeError).message, 'error')
    }
  }

  const handleLowerShare = async (item: GfsShareListItem) => {
    const subjectKey = item.subject.id
      ? `${item.subject.type}:${item.subject.id}`
      : item.subject.type
    const permissions = permissionsForRole('read', false, item.permissions)
    setUpdatingAccessRole(true)
    try {
      await ctrl.createShare([subjectKey], {
        permissions,
        includeDescendants: item.includeDescendants,
      })
      await Promise.all([ctrl.refreshGrants(), ctrl.refreshShares()])
    } catch (roleError) {
      if (failClosedOnAuthorizationError(roleError)) return
      pushToast?.(describeGfsGrantError(roleError).message, 'error')
    } finally {
      setUpdatingAccessRole(false)
    }
  }

  const handleAccessRoleChange = async (
    item: GfsGrantListItem,
    label: string,
    role: GfsAccessRole
  ) => {
    if (!current) return
    const freshAuthority = await fetchRowAuthority(current.resourceId, current.name, ctrl.drive)
    if (!freshAuthority) return
    if (!hasBit(freshAuthority, 'manage_acl')) {
      pushToast?.(`You do not have manage access to ${current.name}.`, 'error')
      return
    }
    const bits = rolePermissionRequest(item.subject.type, role).filter(bit =>
      freshAuthority.grantableBits.includes(bit)
    )
    const subjectKey = item.subject.id
      ? `${item.subject.type}:${item.subject.id}`
      : item.subject.type
    setUpdatingAccessRole(true)
    try {
      await ctrl.grant([subjectKey], bits, item.inherit)
      pushToast?.(
        `${label} is now ${role === 'editor' ? 'an Editor' : 'Read-only'}${inheritedCoverageCaveat(
          ctrl.inheritedCoverage
        )}`,
        'success'
      )
      await Promise.all([ctrl.refreshGrants(), ctrl.refreshShares()])
    } catch (roleError) {
      if (failClosedOnAuthorizationError(roleError)) return
      pushToast?.(describeGfsGrantError(roleError).message, 'error')
    } finally {
      setUpdatingAccessRole(false)
    }
  }

  // A merged row whose access comes from parent folders: any edit (upgrade,
  // downgrade, or removal — no exceptions) is confirmed against the affected
  // folders before anything is sent. Cancel reverts the dropdown untouched.
  const handleInheritedRoleChange = async (
    row: GfsMergedAccessRow,
    label: string,
    role: GfsAccessRole
  ) => {
    const inherited = row.inherited
    if (!inherited) return
    const subject = inherited.subject
    // N1: the dropdown displays the MERGED effective role (direct ⊔
    // inherited). Re-selecting the already-displayed role is a no-op —
    // comparing it against the inherited-only floor instead would open the
    // parent-update modal and escalate the parent folder for a non-change.
    if (role === roleForAccessPermissions(row.permissions)) return
    // R1-M5 split plan: grant-backed folders are rewritten with their OWN
    // scope flag; share-only sources are never converted into grants or
    // deleted (residual access survives and is disclosed). Folders whose own
    // scope flag is unknown are never written with a defaulted scope.
    const plan = planGfsInheritedRoleChange(inherited, role === 'editor')
    const writable = plan.grantSources.filter(source => typeof source.grantInherit === 'boolean')
    const skippedFolderNames = plan.grantSources
      .filter(source => typeof source.grantInherit !== 'boolean')
      .map(source => source.name)
    if (writable.length === 0) {
      if (row.grant) {
        // Direct-grant-only alignment keeps the existing confirmation path.
        setParentUpdate({
          row,
          label,
          mode: 'change-role',
          nextRole: role,
          updates: [],
          residualSources: plan.shareOnlySources,
          skippedFolderNames,
          residualEditorFolderNames:
            role === 'read'
              ? collectResidualEditorFolderNames(
                  plan.shareOnlySources,
                  row.shares,
                  current?.name ?? 'this file'
                )
              : [],
        })
        return
      }
      if (skippedFolderNames.length > 0) {
        pushToast?.(
          `Sharing details on ${joinFolderNames(skippedFolderNames)} could not be verified; existing access was kept.`,
          'error'
        )
        return
      }
      // Nothing writable anywhere: explain the surviving share access.
      if (plan.shareOnlySources.length > 0 || row.shares.length > 0) {
        pushToast?.(
          `${label} still has ${roleForAccessPermissions(row.permissions) === 'editor' ? 'Editor' : 'Read-only'} access from sharing entries that can't be edited here.`,
          'info'
        )
      }
      return
    }
    // Pre-flight: every affected folder's grant is judged by THAT folder's
    // own grantable bits, never by the open file's affordances (which may be
    // missing or narrower). A role a folder cannot grant fails loudly here —
    // the confirmation never opens with a promise it cannot keep.
    const updates: Array<{ source: GfsInheritedAccessSource; bits: string[] }> = []
    for (const source of writable) {
      let folderAffordances: { canDelegate: boolean; grantableBits: string[] }
      try {
        folderAffordances = await window.clerum.gfs.affordances(source.resourceId, ctrl.drive)
      } catch (affordancesError) {
        if (failClosedOnAuthorizationError(affordancesError)) return
        pushToast?.(describeGfsGrantError(affordancesError).message, 'error')
        return
      }
      const bits = rolePermissionRequest(subject.type, role).filter(bit =>
        folderAffordances.grantableBits.includes(bit)
      )
      const expressesRole =
        role === 'editor' ? bits.includes('read') && bits.includes('write') : bits.includes('read')
      if (!folderAffordances.canDelegate || !expressesRole) {
        pushToast?.(
          `Your access on ${source.name} does not allow making ${label} ${role === 'editor' ? 'an Editor' : 'Read-only'}.`,
          'error'
        )
        return
      }
      updates.push({ source, bits })
    }
    setParentUpdate({
      row,
      label,
      mode: 'change-role',
      nextRole: role,
      updates,
      residualSources: plan.shareOnlySources,
      skippedFolderNames,
      // The surviving Editor shares are disclosed IN the confirmation, before
      // the user approves a role that will not remove them.
      residualEditorFolderNames:
        role === 'read'
          ? collectResidualEditorFolderNames(
              [...plan.shareOnlySources, ...writable],
              row.shares,
              current?.name ?? 'this file'
            )
          : [],
    })
  }

  const handleInheritedRemove = (row: GfsMergedAccessRow, label: string) => {
    setParentUpdate({ row, label, mode: 'remove' })
  }

  const confirmParentUpdate = async () => {
    const request = parentUpdate
    const inherited = request?.row.inherited
    if (!request || !inherited) {
      setParentUpdate(null)
      return
    }
    const sources = inherited.sources
    const [firstSource] = sources
    const subject = inherited.subject
    const subjectKey = subject.id ? `${subject.type}:${subject.id}` : subject.type
    const label = request.label
    setParentUpdate(null)
    setUpdatingAccessRole(true)
    // Partial-failure honesty (R1-H1): the confirm issues several sequential
    // calls; the first failure stops the run, refreshes both lists so the
    // dialog shows the TRUE partial state, and the toast says exactly how far
    // the change got. Full success is never claimed on partial completion.
    const failPartially = async (updateError: unknown, summary: string) => {
      if (failClosedOnAuthorizationError(updateError)) return
      pushToast?.(`${summary} (${describeGfsGrantError(updateError).message})`, 'error')
      await Promise.all([ctrl.refreshGrants(), ctrl.refreshInheritedAccess(), ctrl.refreshShares()])
    }
    try {
      if (request.mode === 'remove') {
        let removed = 0
        for (const source of sources) {
          try {
            if (source.grantId) await ctrl.revokeGrant(source.grantId)
            for (const shareId of source.shareIds) await ctrl.revokeShare(shareId)
            removed += 1
          } catch (updateError) {
            await failPartially(
              updateError,
              `Removed from ${removed} of ${sources.length} folders — ${source.name} still grants access`
            )
            return
          }
        }
        // The file's own direct rows are aligned with the removal.
        if (request.row.grant || request.row.shares.length > 0) {
          try {
            if (request.row.grant) await ctrl.revokeGrant(request.row.grant.id)
            for (const share of request.row.shares) await ctrl.revokeShare(share.id)
          } catch (updateError) {
            await failPartially(
              updateError,
              `Removed from ${sources.length} of ${sources.length} folders — direct access on ${current?.name ?? 'this file'} could not be removed`
            )
            return
          }
        }
        pushToast?.(
          sources.length === 1
            ? `Access removed on ${firstSource?.name ?? current?.name ?? 'this file'} and everything inside it`
            : `Access removed on ${sources.length} folders and everything inside them`,
          'success'
        )
        await Promise.all([
          ctrl.refreshGrants(),
          ctrl.refreshInheritedAccess(),
          ctrl.refreshShares(),
        ])
        return
      }
      const updates = request.updates
      const affectedNames = updates.map(update => update.source.name)
      let updated = 0
      for (const { source, bits } of updates) {
        try {
          // Each affected folder's grant is updated with the bits the
          // pre-flight validated on that folder, preserving the GRANT ROW'S
          // OWN scope flag (R1-M5 — the pre-flight guaranteed a known
          // boolean). The folder's share rows are never touched by a role
          // change; they survive as residual access and are disclosed below.
          await window.clerum.gfs.grant(
            source.resourceId,
            [subjectKey],
            bits,
            ctrl.drive,
            source.grantInherit === true
          )
          await ctrl.refreshPermissionState()
          updated += 1
        } catch (updateError) {
          await failPartially(
            updateError,
            `Updated ${updated} of ${updates.length} folders — ${source.name} still grants access`
          )
          return
        }
      }
      const partialMessages: string[] = []
      if (request.skippedFolderNames.length > 0) {
        partialMessages.push(
          `Updated ${updated} of ${updates.length + request.skippedFolderNames.length} folders. Sharing details on ${joinFolderNames(request.skippedFolderNames)} could not be verified; existing access was kept.`
        )
      }
      // The file's own direct GRANT is aligned so it cannot mask the
      // confirmed role (R1-M5: a share-only direct row never gains a grant,
      // direct shares survive role edits, and unknown/empty direct authority
      // keeps the direct grant with an honest partial copy).
      if (request.row.grant) {
        try {
          const fileBits = rolePermissionRequest(subject.type, request.nextRole).filter(bit =>
            affordances?.grantableBits.includes(bit)
          )
          const expressesRole =
            fileBits.includes('read') && (request.nextRole === 'read' || fileBits.includes('write'))
          if (expressesRole) {
            await ctrl.grant([subjectKey], fileBits, request.row.grant.inherit)
          } else {
            // N2 (R1-M5): an empty bit set means the file's affordances are
            // unavailable (or grant nothing) — keep the direct grant AND its
            // shares and say so; removing rights on an authority guess was
            // the defect.
            partialMessages.push(
              `Updated ${updated} of ${updates.length} folders — direct access on ${current?.name ?? 'this file'} could not be fully aligned`
            )
          }
        } catch (updateError) {
          await failPartially(
            updateError,
            `Updated ${updates.length} of ${updates.length} folders — direct access on ${current?.name ?? 'this file'} could not be fully aligned`
          )
          return
        }
      }
      // Residual honesty (R1-M5): a downgrade never claims effective
      // Read-only while a surviving share entry still grants Editor.
      const residualNames =
        request.nextRole === 'read'
          ? collectResidualEditorFolderNames(
              [...request.residualSources, ...updates.map(update => update.source)],
              request.row.shares,
              current?.name ?? 'this item'
            )
          : []
      const residualMessage =
        residualNames.length > 0
          ? `Sharing entries on ${joinFolderNames(residualNames)} still grant Editor access.`
          : ''
      if (partialMessages.length > 0) {
        pushToast?.([...partialMessages, residualMessage].filter(Boolean).join(' '), 'error')
      } else if (residualMessage) {
        pushToast?.(
          `Changed grant access to ${request.nextRole === 'editor' ? 'Editor' : 'Read-only'} on ${affectedNames.length > 0 ? joinFolderNames(affectedNames) : (current?.name ?? 'this item')}. ${residualMessage}`,
          'info'
        )
      } else {
        pushToast?.(
          affectedNames.length > 0
            ? `${label} is now ${request.nextRole === 'editor' ? 'an Editor' : 'Read-only'} on ${joinFolderNames(affectedNames)} and everything inside ${affectedNames.length > 1 ? 'them' : 'it'}${inheritedCoverageCaveat(ctrl.inheritedCoverage)}`
            : `${label} is now ${request.nextRole === 'editor' ? 'an Editor' : 'Read-only'} on ${current?.name ?? 'this file'}${inheritedCoverageCaveat(ctrl.inheritedCoverage)}`,
          'success'
        )
      }
      await Promise.all([ctrl.refreshGrants(), ctrl.refreshInheritedAccess(), ctrl.refreshShares()])
    } finally {
      setUpdatingAccessRole(false)
    }
  }

  const handleDownload = async (uri: string, name: string) => {
    try {
      await saveGfsFileToDisk(uri, name)
      // A save is the user's activity, and the card may be on screen behind the
      // tab that saved: refresh it rather than waiting for a remount.
      ctrl.refreshRecentFiles()
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
        { resourceId: folder.resourceId, drive: folder.drive, name: folder.name },
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

  const handleCopyLink = async (uri: string) => {
    try {
      const result = await window.clerum.gfs.copyDeepLink?.(uri)
      if (!result?.url) throw new Error('Shareable EvenDrive links are unavailable in this version')
      pushToast?.('Shareable EvenDrive link copied', 'success')
    } catch (clipboardError) {
      pushToast?.(
        clipboardError instanceof Error
          ? clipboardError.message
          : 'Could not copy the EvenDrive link',
        'error'
      )
    }
  }

  const handleCopyRoute = async (uri: string, kind: GfsDriveResource['kind']) => {
    const resourceType = kind === 'directory' ? 'folder' : 'file'
    const resourceTypeTitle = kind === 'directory' ? 'Folder' : 'File'
    try {
      await navigator.clipboard.writeText(uri)
      pushToast?.(`${resourceTypeTitle} ID copied`, 'success')
    } catch (clipboardError) {
      const message =
        clipboardError instanceof Error ? clipboardError.message : 'clipboard is unavailable'
      pushToast?.(`Could not copy the ${resourceType} ID: ${message}`, 'error')
    }
  }

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
    if (!pendingGfsUri) return
    // A view id, not a resource: nothing to resolve. The page is keyed by its
    // tab, so this seed only arrives on mount, where `rootView` already took it.
    if (
      pendingGfsUri === GFS_SHARED_WITH_ME_LOCATION ||
      pendingGfsUri === GFS_RECENT_FILES_LOCATION
    ) {
      onPendingGfsUriHandled?.()
      return
    }
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
    let current = true
    const isCurrent = () =>
      current &&
      pageActiveRef.current &&
      (!pendingGfsDeepLinkOwnerTabId || pendingGfsDeepLinkOwnerTabId === workspaceTabId) &&
      (isPendingGfsDeepLinkCurrent?.() ?? true)
    seedPendingRef.current = true
    setPendingGfsDeepLinkFailure(null)

    if (!isCurrent()) {
      onPendingGfsDeepLinkOutcome?.(link.id, 'superseded')
      return () => {
        current = false
      }
    }

    if (normalizeGfsResourceUri(link.uri) !== link.uri) {
      setPendingGfsDeepLinkFailure({
        id: link.id,
        message: 'This EvenDrive link is invalid or cannot be resolved.',
        retryable: false,
      })
      onPendingGfsDeepLinkOutcome?.(link.id, 'terminal')
      return () => {
        current = false
      }
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

    return () => {
      current = false
    }
    // The callback intentionally follows the active queue item and explicit
    // retry request. The page-level handlers close over the current resource.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingGfsDeepLink?.id, pendingGfsDeepLink?.uri, deepLinkRetryRequest])

  // Report the live location (leaf gfsUri + folder name) so the owning files tab
  // persists it (mini-spec 06 §3). `current` is the top of the breadcrumb stack;
  // `null` is the virtual root. Deps track the primitive fields so a re-render
  // that leaves the location unchanged does not re-emit.
  const currentGfsUri = current?.gfsUri ?? null
  // D-5: at the caller's own ready home root the Files tab reads "My home",
  // not the storage folder name. `current` is the top of the breadcrumb stack;
  // the effect below re-emits when the home becomes ready because the label,
  // not the resource, is the reported name.
  const currentName =
    current && isCallerHomeRoot(ctrl.home, { resourceId: current.resourceId, drive: ctrl.drive })
      ? GFS_MY_HOME_LABEL
      : (current?.name ?? null)
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
    if (currentGfsUri === null && rootView === 'shared') {
      onLocationChange?.(GFS_SHARED_WITH_ME_LOCATION, GFS_SHARED_WITH_ME_LABEL)
      return
    }
    if (currentGfsUri === null && rootView === 'recent') {
      onLocationChange?.(GFS_RECENT_FILES_LOCATION, GFS_RECENT_FILES_LABEL)
      return
    }
    onLocationChange?.(currentGfsUri, currentName)
  }, [currentGfsUri, currentName, onLocationChange, rootView])

  const handleCreateFolder = async () => {
    const requestedName = createFolderName.trim()
    const parentResourceId = createFolderParentId
    if (!requestedName || !parentResourceId) return
    const parentName = createFolderParentName ?? 'folder'
    if (!(await requireFreshRowPermissions(parentResourceId, parentName, ['write']))) return
    setCreateFolderError(null)
    try {
      const name = await normalizeGfsResourceName(requestedName)
      if (!(await requireFreshRowPermissions(parentResourceId, parentName, ['write']))) return
      await ctrl.createFolder(parentResourceId, name)
      closeCreateFolder()
      pushToast?.(`Folder ${name} created`, 'success')
    } catch (createError) {
      if (failClosedOnAuthorizationError(createError)) return
      setCreateFolderError(createError instanceof Error ? createError.message : String(createError))
    }
  }

  const handleUploadFile = async (
    file: File | null | undefined,
    parentResourceId = current?.resourceId,
    occupiedNames = new Set(items.map(item => item.name)),
    parentName = current?.name ?? 'folder'
  ) => {
    if (!file || !parentResourceId) return
    if (!(await requireFreshRowPermissions(parentResourceId, parentName, ['write']))) return
    try {
      assertGfsFileUploadSize(file.size)
      const normalizedName = await normalizeGfsResourceName(file.name)
      const filePath = window.clerum.gfs.getPathForFile(file)
      if (!filePath) throw new Error('Could not resolve the selected local file')
      const nameReservation = uploadNameReservationsRef.current.begin(
        parentResourceId,
        normalizedName,
        occupiedNames
      )
      try {
        for (let attempt = 0; attempt < GFS_UPLOAD_NAME_RETRY_LIMIT; attempt += 1) {
          const name = nameReservation.reserveNext()

          try {
            if (!(await requireFreshRowPermissions(parentResourceId, parentName, ['write']))) return
            await ctrl.createFileFromPath(parentResourceId, name, filePath)
            nameReservation.markSuccess(name)
            pushToast?.(`Uploaded ${name}`, 'success')
            return
          } catch (uploadError) {
            const decision = gfsUploadNameRetryDecision(uploadError, { attempt })
            if (decision === 'terminal') throw uploadError

            nameReservation.markConflict(name)
            if (decision === 'exhausted') throw new Error(GFS_UPLOAD_NAME_EXHAUSTED_MESSAGE)
          }
        }

        throw new Error(GFS_UPLOAD_NAME_EXHAUSTED_MESSAGE)
      } finally {
        nameReservation.release()
      }
    } catch (uploadError) {
      if (failClosedOnAuthorizationError(uploadError)) return
      pushToast?.(uploadError instanceof Error ? uploadError.message : String(uploadError), 'error')
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
      drive: resource.drive,
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
  const resolveActiveSource = (destinationDrive: string): GfsDragSource | null => {
    if (!dragSession) {
      const local = draggingSourceRef.current
      return local && local.drive === destinationDrive ? local : null
    }
    const source = dragSession.activeSource()
    return source &&
      dragSession.matchesScope(sessionScope ?? 'anonymous') &&
      // Admission compares against the DESTINATION's drive, never the open
      // location: a root listing has no folder open, so the controller's
      // current drive is empty while every row still carries its own.
      source.drive === destinationDrive
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
    const source = resolveActiveSource(folder.drive)
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
        folder.drive,
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
    const source = resolveActiveSource(ctrl.drive)
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
        ctrl.drive,
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
  const cachedDestinationNames = (destinationId: string, drive: string): Set<string> => {
    if (!sessionScope || !isGfsSessionGeneration(ctrl.sessionGeneration)) return new Set()
    const cached = queryClient.getQueryData<{ pages?: Array<{ items?: GfsDriveResource[] }> }>(
      desktopQueryKeys.gfsChildren(sessionScope, destinationId, drive, ctrl.sessionGeneration)
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
              source.drive,
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
            ctrl.convergeCommittedMove({ ...input, drive: source.drive }, receipt, source.scope),
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
          occupiedDestinationNames: cachedDestinationNames(destination.resourceId, source.drive),
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
    const source = resolveActiveSource(destination.drive)
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
      if (!allowed) return
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

  const handleRenameCurrent = async () => {
    if (!current) return
    if (!(await requireFreshRowPermissions(current.resourceId, current.name, ['write']))) return
    const requestedName = renameName.trim()
    if (!requestedName) return
    try {
      const name = await normalizeGfsResourceName(requestedName)
      if (name === current.name) {
        setRenameOpen(false)
        return
      }
      await ctrl.renameResource(current.resourceId, name, ctrl.drive, current.version)
      setRenameOpen(false)
      pushToast?.(`Renamed to ${name}`, 'success')
    } catch (renameError) {
      if (failClosedOnAuthorizationError(renameError)) return
      pushToast?.(renameError instanceof Error ? renameError.message : String(renameError), 'error')
    }
  }

  const handleDeleteCurrent = async () => {
    if (!current) return
    if (!(await requireFreshRowPermissions(current.resourceId, current.name, ['delete']))) return
    try {
      await ctrl.deleteResource(current.resourceId, ctrl.drive, current.version)
      setDeleteOpen(false)
      closeManage()
      pushToast?.(`Deleted ${current.name}`, 'success')
    } catch (deleteError) {
      if (failClosedOnAuthorizationError(deleteError)) return
      pushToast?.(deleteError instanceof Error ? deleteError.message : String(deleteError), 'error')
    }
  }

  const handleDeleteResource = async (resource: GfsActionTarget) => {
    if (
      !(await requireFreshRowPermissions(
        resource.resourceId,
        resource.name,
        ['delete'],
        resource.drive
      ))
    ) {
      setDeleteTarget(null)
      return
    }
    try {
      await ctrl.deleteResource(resource.resourceId, resource.drive, resource.version)
      pushToast?.(`Deleted ${resource.name}`, 'success')
    } catch (deleteError) {
      if (!failClosedOnAuthorizationError(deleteError)) {
        pushToast?.(
          deleteError instanceof Error ? deleteError.message : String(deleteError),
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

  /**
   * The home root is managed: the server answers `governed_root_immutable` for
   * a rename, move or delete of it, so the page must not offer those controls.
   */
  const isHomeRoot = (resourceId: string): boolean =>
    ctrl.home?.resourceId != null && resourceId === ctrl.home.resourceId

  /** Delete gate for list rows. Shared-with-me rows carry their permission
   * bits directly; child rows use their own server-computed affordances. */
  const rowCanDelete = (resource: GfsDriveResource): boolean => {
    if (isHomeRoot(resource.resourceId)) return false
    if (currentIsFolder) return hasBit(rowAffordancesFor(resource), 'delete')
    return Boolean(resource.permissions?.includes('delete'))
  }

  /** Rename needs `write` on the resource itself. */
  const rowCanRename = (resource: GfsDriveResource): boolean => {
    if (isHomeRoot(resource.resourceId)) return false
    if (currentIsFolder) return hasBit(rowAffordancesFor(resource), 'write')
    return Boolean(resource.permissions?.includes('write'))
  }

  /** Child folder operations use the server-derived write bit for that row. */
  const rowCanWrite = (resource: GfsDriveResource): boolean => {
    if (currentIsFolder) return hasBit(rowAffordancesFor(resource), 'write')
    return Boolean(resource.permissions?.includes('write'))
  }

  /** Manage gate: the ACL modal needs `manage_acl` (view-ACL = manage-ACL
   *  server-side). A read-only row must not offer a Manage entry that would
   *  only 403 on open. */
  const rowCanManage = (resource: GfsDriveResource): boolean => {
    if (currentIsFolder) return hasBit(rowAffordancesFor(resource), 'manage_acl')
    return Boolean(resource.permissions?.includes('manage_acl'))
  }

  /** Move uses the exact server-authorized old parent, not the row's own bits or virtual root. */
  const rowCanMove = (resource: GfsDriveResource): boolean => {
    const sourceParentId = resource.parentResourceId
    if (!sourceParentId || accessRevoked) return false
    const sourceParent =
      sourceParentId === current?.resourceId
        ? ctrl.affordances
        : ctrl.moveSourceParentAffordancesById?.[sourceParentId]
    if (
      sourceParentId === current?.resourceId &&
      ctrl.affordancesError &&
      ctrl.affordancesHttpStatus !== 429
    ) {
      return false
    }
    return hasGfsMoveSourcePermissions(sourceParent?.held)
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
        target.drive,
        authoritativeSessionGeneration
      )
      const destinationKey = desktopQueryKeys.gfsAffordances(
        sessionScope,
        destinationId,
        target.drive,
        authoritativeSessionGeneration
      )
      assertGfsAuthorityRetryAllowed(queryClient, sourceKey)
      assertGfsAuthorityRetryAllowed(queryClient, destinationKey)
      const [source, destination] = await Promise.all([
        queryClient.fetchQuery({
          queryKey: sourceKey,
          queryFn: () => window.clerum.gfs.affordances(sourceParentId, target.drive),
          staleTime: 0,
          retry: false,
        }),
        queryClient.fetchQuery({
          queryKey: destinationKey,
          queryFn: () => window.clerum.gfs.affordances(destinationId, target.drive),
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
        gfsUri: `gfs://${target.drive}/${target.resourceId.replace(/-/g, '').toLowerCase()}`,
        drive: target.drive,
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
            target.drive,
            authoritativeSessionGeneration
          )
          const sourceParentKey = desktopQueryKeys.gfsAffordances(
            origin.sessionScope,
            sourceParentId,
            target.drive,
            authoritativeSessionGeneration
          )
          const destinationKey = desktopQueryKeys.gfsAffordances(
            origin.sessionScope,
            destinationId,
            target.drive,
            authoritativeSessionGeneration
          )
          for (const key of [resourceKey, sourceParentKey, destinationKey]) {
            assertGfsAuthorityRetryAllowed(queryClient, key)
          }
          const [resourceAuthority, sourceParentAuthority, destinationAuthority] =
            await Promise.all([
              queryClient.fetchQuery({
                queryKey: resourceKey,
                queryFn: () => window.clerum.gfs.affordances(target.resourceId, target.drive),
                staleTime: 0,
                retry: false,
              }),
              queryClient.fetchQuery({
                queryKey: sourceParentKey,
                queryFn: () => window.clerum.gfs.affordances(sourceParentId, target.drive),
                staleTime: 0,
                retry: false,
              }),
              queryClient.fetchQuery({
                queryKey: destinationKey,
                queryFn: () => window.clerum.gfs.affordances(destinationId, target.drive),
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

  /** The open location as a row-action target. A crumb carries no drive of its
   * own — the open location's drive is the controller's current drive. */
  const currentActionTarget = (): GfsActionTarget | null =>
    current ? { ...current, drive: ctrl.drive } : null

  const requestMoveCurrent = () => {
    const target = currentActionTarget()
    if (target) showMoveDialog(target)
  }

  /** Page-level rename works inline for any row or the current resource; the
   *  manage dialog keeps its own inline title-edit flow. Errors toast (stale
   *  version → retry), matching the manage-dialog rename behavior. */
  const handleRenameTarget = async () => {
    if (!renameTarget) return
    const target = renameTarget
    const requestedName = renameDraft.trim()
    if (!requestedName) return
    if (
      !(await requireFreshRowPermissions(target.resourceId, target.name, ['write'], target.drive))
    )
      return
    try {
      const name = await normalizeGfsResourceName(requestedName)
      if (name === target.name) {
        setRenameTarget(null)
        return
      }
      if (
        !(await requireFreshRowPermissions(target.resourceId, target.name, ['write'], target.drive))
      )
        return
      await ctrl.renameResource(target.resourceId, name, target.drive, target.version)
      setRenameTarget(null)
      pushToast?.(`Renamed to ${name}`, 'success')
    } catch (renameError) {
      if (failClosedOnAuthorizationError(renameError)) return
      pushToast?.(renameError instanceof Error ? renameError.message : String(renameError), 'error')
    }
  }

  const openRenameTarget = (target: GfsActionTarget) => {
    void runWithFreshResourcePermissions(target, target.resourceId, target.name, ['write'], () => {
      setRenameTarget(target)
      setRenameDraft(target.name)
    })
  }

  const openMoveTarget = (target: GfsActionTarget) => {
    const sourceParentId = target.parentResourceId
    if (!sourceParentId) {
      pushToast?.('Could not verify the source folder for this move.', 'error')
      return
    }
    const openGeneration = moveDialogGenerationRef.current + 1
    moveDialogGenerationRef.current = openGeneration
    void runWithFreshResourcePermissions(
      target,
      sourceParentId,
      'the source folder',
      ['write', 'delete'],
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
    drive: ctrl.drive,
    parentResourceId: null,
    name: crumb.name,
    kind: 'directory',
    path: null,
    version: crumb.version,
    bytes: crumb.bytes,
  })

  const visibleResources = useMemo<GfsDriveResource[]>(() => {
    if (current) {
      return currentIsFolder ? sortDriveResources(items) : []
    }
    // Root view ("Shared with me"): only what others share with the caller.
    // The caller's own home is not shared with them; it has its own entry.
    return sortDriveResources(
      accessibleResources.filter(resource => !isCallerHomeRoot(ctrl.home, resource))
    )
  }, [accessibleResources, ctrl.home, current, currentIsFolder, items])
  const myHome = useMemo(
    () =>
      current || rootView !== 'overview'
        ? null
        : callerHomeRootNode(ctrl.home, accessibleResources),
    [accessibleResources, ctrl.home, current, rootView]
  )
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

  const openManage = (resource: GfsDriveResource) => {
    void runWithFreshResourcePermissions(
      resource,
      resource.resourceId,
      resource.name,
      ['manage_acl'],
      () => {
        if (resource.resourceId !== current?.resourceId) {
          beginExplicitFilesNavigation()
          manageReturnCrumbsRef.current = [...crumbs]
          ctrl.openResource(resource)
        } else {
          manageReturnCrumbsRef.current = resource.kind === 'file' ? crumbs.slice(0, -1) : null
        }
        setCreateFolderOpen(false)
        setRenameOpen(false)
        setDeleteOpen(false)
        setShareDetailsOpen(false)
        setManageOpen(true)
      }
    )
  }

  const openManageCurrent = () => {
    if (!current) return
    void runWithFreshResourcePermissions(
      currentActionTarget()!,
      current.resourceId,
      current.name,
      ['manage_acl'],
      () => {
        manageReturnCrumbsRef.current = currentIsFile ? crumbs.slice(0, -1) : null
        setCreateFolderOpen(false)
        setRenameOpen(false)
        setDeleteOpen(false)
        setShareDetailsOpen(false)
        setManageOpen(true)
      }
    )
  }

  const currentResourceActions = current
    ? buildGfsResourceActions({
        kind: current.kind,
        uri: current.gfsUri,
        handlers: {
          refresh: () => void handleRefreshCurrent(),
          'copy-link': () => void handleCopyLink(current.gfsUri),
          'copy-route': () => void handleCopyRoute(current.gfsUri, current.kind),
          'open-route': () => setOpenLinkOpen(true),
          rename: () => openRenameTarget(currentActionTarget()!),
          move: () => openMoveTarget(currentActionTarget()!),
          'new-folder': () => openCreateFolder(current.resourceId, current.name),
          'upload-file': () =>
            requestUploadForFolder(
              current.resourceId,
              new Set(items.map(item => item.name)),
              current.name
            ),
          share: () => openManageCurrent(),
          preview:
            currentIsFile && currentPreviewAvailable
              ? () => void openFilePreview(current)
              : undefined,
          download: currentIsFile
            ? () => void handleDownload(current.gfsUri, current.name)
            : undefined,
          'download-zip': currentIsFolder
            ? () => void handleFolderZipDownload(crumbAsResource(current))
            : undefined,
          replace:
            currentIsFile && canWriteCurrent
              ? (file, context) => {
                  if (file) void handleReplaceCurrentFile(file)
                  else context?.requestFileSelection?.()
                }
              : undefined,
          delete: () => void openDeleteTarget(currentActionTarget()!),
        },
        canRename: canWriteCurrent && !isHomeRoot(current.resourceId),
        canMove: canMoveCurrent,
        canCreateFolder: currentIsFolder && canWriteCurrent,
        canUpload: currentIsFolder && canWriteCurrent,
        canShare: canManageCurrent,
        canPreview: currentPreviewAvailable,
        canDownload: currentIsFile,
        canDownloadZip: currentIsFolder,
        canReplace: currentIsFile && canWriteCurrent,
        canDelete: canDeleteCurrent && !isHomeRoot(current.resourceId),
        mutating: ctrl.mutating,
        refreshing: refreshingCurrent,
      })
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

  const recentOnly = !current && rootView === 'recent'
  const showRecentFiles = !current && rootView !== 'shared' && !accessRevoked
  const resourceMenuActionsFor = (resource: GfsDriveResource) => {
    const isDirectory = resource.kind === 'directory'
    const canPreview =
      !isDirectory && resource.readable !== false && isGfsPreviewFile(resource.name)
    const canDownload = !isDirectory && resource.readable !== false
    const canDownloadZip = isDirectory && resource.readable !== false
    const canRename = rowCanRename(resource)
    const canWrite = isDirectory && rowCanWrite(resource)
    const canManage = rowCanManage(resource)
    const canDelete = rowCanDelete(resource)
    return getGfsMenuActions(
      buildGfsResourceActions({
        kind: resource.kind,
        uri: resource.gfsUri,
        handlers: {
          'copy-link': () => void handleCopyLink(resource.gfsUri),
          'copy-route': () => void handleCopyRoute(resource.gfsUri, resource.kind),
          'open-route': () => setOpenLinkOpen(true),
          'open-folder': isDirectory ? () => openResource(resource) : undefined,
          'new-folder': canWrite
            ? () => openCreateFolder(resource.resourceId, resource.name)
            : undefined,
          'upload-file': canWrite
            ? () => requestUploadForFolder(resource.resourceId, new Set(), resource.name)
            : undefined,
          rename: () => openRenameTarget(resource),
          move: () => openMoveTarget(resource),
          share: () => openManage(resource),
          delete: () => openDeleteTarget(resource),
          preview: canPreview ? () => void openFilePreview(resource) : undefined,
          download: canDownload
            ? () => void handleDownload(resource.gfsUri, resource.name)
            : undefined,
          'download-zip': canDownloadZip ? () => void handleFolderZipDownload(resource) : undefined,
        },
        canOpenFolder: isDirectory,
        canRename: canRename && !isHomeRoot(resource.resourceId),
        canMove: rowCanMove(resource) && !isHomeRoot(resource.resourceId),
        canCreateFolder: canWrite,
        canUpload: canWrite,
        canShare: canManage,
        canDelete: canDelete && !isHomeRoot(resource.resourceId),
        canPreview,
        canDownload,
        canDownloadZip,
        mutating: ctrl.mutating,
      })
    )
  }

  const currentIsBeingRenamed = renameTarget?.resourceId === current?.resourceId
  const currentIsInBreadcrumbs = Boolean(
    current && crumbs.some(crumb => crumb.resourceId === current.resourceId)
  )

  return (
    <section className="page da-gfs-page">
      <GfsResourceTitlebarActions
        target={titlebarLeadingTarget}
        onRefresh={
          recentOnly
            ? () => ctrl.refreshRecentFiles()
            : current
              ? () => void handleRefreshCurrent()
              : () => void ctrl.retryDiscovery()
        }
        refreshing={
          recentOnly ? ctrl.fetchingRecentFiles : current ? refreshingCurrent : visibleLoading
        }
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
        <h2>{recentOnly ? GFS_RECENT_FILES_LABEL : 'Files'}</h2>
        <p className="muted">
          {recentOnly
            ? 'Files you or your agents opened or changed, most recent first.'
            : 'Browse and manage everything shared with you in one place.'}
        </p>
      </div>

      <div className="page-layout da-gfs-layout">
        {showRecentFiles ? (
          <GfsRecentFilesCard
            failure={ctrl.recentFilesFailure}
            fetching={ctrl.fetchingRecentFiles}
            files={ctrl.recentFiles}
            loading={ctrl.loadingRecentFiles}
            onOpen={file => {
              if (openFilePreview(file)) return
              void handleDownload(file.gfsUri, file.name)
            }}
            onRetry={ctrl.retryRecentFiles}
          />
        ) : null}
        {myHome ? (
          <section className="page-card da-gfs-my-home" aria-label="My home">
            <Button
              align="start"
              className="da-gfs-my-home__open"
              color="neutral"
              onClick={() => ctrl.openResource(myHome)}
              variant="text"
            >
              <IconContexts aria-hidden="true" width={16} height={16} />
              {myHome.name}
            </Button>
          </section>
        ) : null}
        <section
          className="page-card da-gfs-drive"
          aria-label="EvenDrive browser"
          hidden={recentOnly && !accessRevoked}
          aria-busy={driveBusy}
          onDragEnter={handleGfsDragEnter}
          onDragLeave={handleGfsDragLeave}
          onDragOver={handleGfsDragOver}
          onDrop={event => void handleGfsDrop(event)}
        >
          <div className="page-card__header da-gfs-drive__header">
            <div className="da-gfs-drive__title-row">
              <nav className="da-gfs-drive__breadcrumbs" aria-label="File location">
                {homeTrail ? null : (
                  <Button
                    className="da-gfs-drive__breadcrumb da-gfs-drive__breadcrumb--view-root"
                    color="neutral"
                    // In the Shared with me view this is the active crumb: inert,
                    // and styled as a view root like "My home" at the home root.
                    // A revoked session offers nothing but retry.
                    aria-current={!current && rootView === 'shared' ? 'page' : undefined}
                    disabled={!current && (accessRevoked || rootView === 'shared')}
                    onClick={
                      !current && rootView === 'shared'
                        ? undefined
                        : () => {
                            manageReturnCrumbsRef.current = null
                            setManageOpen(false)
                            beginExplicitFilesNavigation()
                            setRootView('shared')
                            ctrl.reset()
                          }
                    }
                    variant="text"
                  >
                    {GFS_SHARED_WITH_ME_LABEL}
                  </Button>
                )}
                {crumbs.map((crumb, index) => (
                  <span className="da-gfs-drive__crumb-group" key={crumb.resourceId}>
                    {homeTrail && index === 0 ? null : <IconChevronRight aria-hidden="true" />}
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
                          homeTrail && index === 0 ? ' da-gfs-drive__breadcrumb--view-root' : ''
                        }${
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
                                crumbLabel(crumb, index),
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
                            name: crumbLabel(crumb, index),
                            // A crumb is an ancestor of the open location, so it
                            // lives on the open location's own drive.
                            drive: ctrl.drive,
                            kind: 'directory',
                          })
                        }
                        variant="text"
                      >
                        {crumbLabel(crumb, index)}
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
          {current && loadingAffordances ? (
            <div role="status">
              <StatusBanner tone="info" text={`Checking permissions for ${current.name}…`} />
            </div>
          ) : null}
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
                    void fetchRowAuthority(current.resourceId, current.name, ctrl.drive)
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
                    void fetchRowAuthority(
                      resourceId,
                      'the source folder',
                      visibleResources.find(resource => resource.parentResourceId === resourceId)
                        ?.drive ?? ctrl.drive
                    )
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
              style={{ '--da-grid-cols': GFS_LISTING_GRID_COLUMNS }}
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
                  // The governed home root never moves; it stays a drop destination.
                  const canDragResource =
                    resource.readable !== false &&
                    movingResourceId === null &&
                    !ctrl.mutating &&
                    !isHomeRoot(resource.resourceId)
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
                                drive: resource.drive,
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
                          <span className="muted" role={permissionNotice.role}>
                            {permissionNotice.message}
                          </span>
                        ) : null}
                      </span>
                      <span className="da-gfs-drive__size da-grid__cell da-grid__cell--right">
                        {formatSharedFileSize(resource.bytes)}
                      </span>
                      <span className="da-gfs-list__actions da-grid__cell da-grid__cell--right">
                        {rowCanManage(resource) ? (
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
                        {rowCanRename(resource) ? (
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
                            actions={resourceMenuActionsFor(resource)}
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
                            actions={resourceMenuActionsFor(resource)}
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

      {manageOpen && current ? (
        <div
          className="da-gfs-manage-modal"
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget) closeManage()
          }}
        >
          <section
            className="da-gfs-manage-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`Share ${currentIsFolder ? 'folder' : 'file'} ${current.name}`}
          >
            <header className="da-gfs-manage-dialog__header">
              <span
                className={`da-gfs-manage-dialog__icon${currentIsFolder ? ' da-gfs-manage-dialog__icon--folder' : ''}`}
                aria-hidden="true"
              >
                {currentIsFolder ? <IconContexts /> : <GfsFileIcon name={current.name} />}
              </span>
              <span className="da-gfs-manage-dialog__heading">
                {renameOpen ? (
                  <form
                    className="da-gfs-manage-dialog__title-edit"
                    aria-label="Rename resource"
                    onSubmit={event => {
                      event.preventDefault()
                      void handleRenameCurrent()
                    }}
                  >
                    <TextInput
                      aria-label="New name"
                      autoFocus
                      value={renameName}
                      onChange={event => setRenameName(event.currentTarget.value)}
                    />
                    <Button loading={ctrl.mutating} size="sm" type="submit">
                      Save
                    </Button>
                    <Button
                      onClick={() => setRenameOpen(false)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <h3>Share “{current.name}”</h3>
                )}
              </span>
              <span className="da-gfs-manage-dialog__top-actions">
                <IconButton
                  autoFocus
                  label="Close share dialog"
                  onClick={closeManage}
                  size="sm"
                  variant="ghost"
                >
                  <IconClose />
                </IconButton>
              </span>
            </header>

            <div className="da-gfs-manage-dialog__body">
              {canDeleteCurrent && deleteOpen ? (
                <div className="da-gfs-inline-form" role="alertdialog" aria-label="Delete resource">
                  <span className="da-gfs-inline-form__copy">Delete {current.name}?</span>
                  <Button
                    color="danger"
                    loading={ctrl.mutating}
                    onClick={() => void handleDeleteCurrent()}
                    size="sm"
                  >
                    Delete
                  </Button>
                  <Button
                    onClick={() => setDeleteOpen(false)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Cancel
                  </Button>
                </div>
              ) : null}

              <section className="da-gfs-manage-section da-gfs-manage-section--access">
                <div className="da-gfs-manage-section__header">
                  <div>
                    <h4>Add people, teams, agents, or workflows</h4>
                  </div>
                </div>
                {affordancesError ? <StatusBanner tone="error" text={affordancesError} /> : null}
                {affordances ? (
                  <GfsDelegationPanel
                    affordances={affordances}
                    permissionPending={loadingAffordances}
                    permissionCheckPending={loadingAffordances}
                    permissionCheckFailed={Boolean(affordancesError)}
                    subjectOptions={grantSubjectOptions}
                    subjectOptionsLoading={
                      teamDirectoryQuery.isFetching || myAgentsQuery.isFetching
                    }
                    subjectOptionsError={mergeErrorMessages(
                      teamDirectoryQuery.error,
                      myAgentsQuery.error
                    )}
                    isDirectory={currentIsFolder}
                    onGrant={handleGrant}
                    onDetailViewChange={setShareDetailsOpen}
                  />
                ) : loadingAffordances ? (
                  <p className="muted" role="status">
                    Refreshing permissions…
                  </p>
                ) : null}
              </section>

              {!shareDetailsOpen ? (
                <section className="da-gfs-manage-section da-gfs-manage-section--grants">
                  <div className="da-gfs-manage-section__header">
                    <div>
                      <h4>People with access</h4>
                    </div>
                  </div>
                  <GfsGrantList
                    agents={agentSubjects}
                    derivationNotice={inheritedAccessNotice}
                    derivationNoticeHint={inheritedAccessNoticeHint}
                    error={grantsError}
                    inheritedItems={ctrl.inheritedAccess}
                    isOwnHomeRoot={isOwnHomeRoot}
                    items={ctrl.grants}
                    loading={
                      ctrl.loadingGrants || ctrl.loadingShares || ctrl.loadingInheritedAccess
                    }
                    // FILES AND FOLDERS merge inherited rows (the reported
                    // folder bug); the dialog itself only opens with a target.
                    mergeInherited
                    onChangeInheritedRole={handleInheritedRoleChange}
                    onChangeRole={affordances?.canDelegate ? handleAccessRoleChange : undefined}
                    onRemoveInherited={handleInheritedRemove}
                    onRevoke={(item, label) => void handleRevokeGrant(item.id, label)}
                    onRevokeShare={(item, label) => void handleRevokeShare(item.id, label)}
                    onLowerShare={handleLowerShare}
                    revoking={ctrl.revoking}
                    revokingShare={ctrl.revokingShare}
                    shareError={sharesError}
                    shares={ctrl.shares}
                    subjects={delegationSubjects}
                    updatingRole={updatingAccessRole}
                  />
                </section>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      <GfsInheritedAccessDialog
        busy={updatingAccessRole}
        request={
          parentUpdate?.row.inherited
            ? {
                mode: parentUpdate.mode,
                memberLabel: parentUpdate.label,
                fileName: current?.name ?? '',
                // Removal touches every contributing folder; a role change
                // touches only the R1-H1 plan's affected folders.
                folders:
                  parentUpdate.mode === 'remove'
                    ? parentUpdate.row.inherited.sources.map(source => ({
                        resourceId: source.resourceId,
                        name: source.name,
                        currentRole: roleForAccessPermissions(source.permissions),
                      }))
                    : parentUpdate.updates.map(update => ({
                        resourceId: update.source.resourceId,
                        name: update.source.name,
                        currentRole: roleForAccessPermissions(update.source.permissions),
                      })),
                fileCurrentRole: roleForAccessPermissions(parentUpdate.row.permissions),
                nextRole: parentUpdate.mode === 'change-role' ? parentUpdate.nextRole : undefined,
                // The surviving Editor shares are disclosed BEFORE the user
                // approves: the effective role this dialog shows is not the
                // whole truth, and only the post-change toast used to say so.
                ...(parentUpdate.mode === 'change-role' &&
                parentUpdate.residualEditorFolderNames.length > 0
                  ? { residualEditorFolderNames: parentUpdate.residualEditorFolderNames }
                  : {}),
              }
            : null
        }
        onCancel={() => setParentUpdate(null)}
        onConfirm={() => void confirmParentUpdate()}
      />

      {createFolderOpen && createFolderParentId && createFolderParentName ? (
        <div
          className="da-gfs-manage-modal da-gfs-new-folder-modal"
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget && !ctrl.mutating) closeCreateFolder()
          }}
        >
          <section
            aria-describedby={createFolderDescriptionId}
            aria-labelledby={createFolderTitleId}
            aria-modal="true"
            className="da-gfs-new-folder-dialog"
            onMouseDown={event => event.stopPropagation()}
            role="dialog"
          >
            <header className="da-gfs-new-folder-dialog__header">
              <h3 id={createFolderTitleId}>New folder</h3>
            </header>
            <p className="da-gfs-new-folder-dialog__copy" id={createFolderDescriptionId}>
              Create a new folder in {createFolderParentName}.
            </p>
            <form
              aria-label="Create folder"
              className="da-gfs-new-folder-dialog__form"
              onSubmit={event => {
                event.preventDefault()
                void handleCreateFolder()
              }}
            >
              <label className="da-gfs-new-folder-dialog__field" htmlFor={createFolderInputId}>
                <span>Folder name</span>
                <TextInput
                  aria-label="Folder name"
                  autoComplete="off"
                  autoFocus
                  disabled={ctrl.mutating}
                  id={createFolderInputId}
                  placeholder="e.g. research-notes"
                  spellCheck={false}
                  value={createFolderName}
                  onChange={event => setCreateFolderName(event.currentTarget.value)}
                />
              </label>
              {createFolderError ? <StatusBanner tone="error" text={createFolderError} /> : null}
              <footer className="da-gfs-new-folder-dialog__actions">
                <Button
                  disabled={ctrl.mutating}
                  onClick={closeCreateFolder}
                  type="button"
                  variant="ghost"
                >
                  Cancel
                </Button>
                <Button disabled={!createFolderName.trim()} loading={ctrl.mutating} type="submit">
                  Create folder
                </Button>
              </footer>
            </form>
          </section>
        </div>
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
          drive={moveTarget.drive}
          home={ctrl.home}
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
